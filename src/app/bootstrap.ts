/**
 * bootstrap.ts — точка входа приложения.
 * Three.js + Rapier + CityWorld(BatchedMesh/LOD/frustum/prefetch) + Bus(GLTF) + UI.
 */

import * as THREE from 'three';
import { initPhysics, stepPhysics, createStaticFloor } from '../core/rapier';
import { getPhysicsWorld } from '../core/rapier';
import { initInput, getInput, clearFrameFlags } from '../core/input';
import { initAudio, updateEngine, playHorn, playDoors } from '../core/audio';
import { Bus } from '../vehicle/bus';
import { CityWorld } from '../world/cityWorld';
import { OsmTileProvider } from '../world/osmTileProvider';
import { createEnvironment } from '../world/environment';
import { createAtmosphere } from '../world/atmosphere';
import { createTraffic } from '../world/traffic';
import { RouteTracker } from '../gameplay/routeTracker';
import { ROUTES } from '../gameplay/routes';
import { PassengerService } from '../gameplay/passengers';
import { ShiftManager } from '../gameplay/shift';
import { createStreetProps } from '../world/streetProps';
import { StreetMetadataProvider } from '../world/streetMetadata';
import { HUD } from '../ui/hud';
import { Telemetry } from '../core/telemetry';
import { detectQuality } from '../core/quality';

const FIXED_DT = 1 / 60;

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let chaseCam: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let clock: THREE.Clock;
let bus: Bus;
let cityWorld: CityWorld;
let streetProps: ReturnType<typeof createStreetProps>;
let streetMetadata: StreetMetadataProvider;
let atmosphere: ReturnType<typeof createAtmosphere>;
let environment: ReturnType<typeof createEnvironment>;
let traffic: ReturnType<typeof createTraffic>;
let telemetry: Telemetry;
let basePixelRatio = 1;
let routeTracker: RouteTracker;
let passengers: PassengerService;
let shift: ShiftManager;
let hud: HUD;
let lastPos: THREE.Vector3 | null = null;
const _tmpCamPos = new THREE.Vector3();
let lastSpeed = 0;

let accumulator = 0;
let lastHudTime = 0;
let lastStreetReport = 0;
let currentMode: 'driver' | 'chase' = 'chase';
let paused = false;
let lookYaw = 0;
let lookPitch = 0.12; // чуть вверх — видно небо и горы, а не только торпедо

// Тач-зоны
let touchSteer = 0;
let touchThrottle = 0;
let touchBrake = 0;
let steerStartX = 0;
let throttleStartY = 0;
let isSteering = false;
let isThrottling = false;

async function main() {
  const container = document.getElementById('canvas')!;
  const loadingEl = document.getElementById('loading') as HTMLElement;
  const loadingTextEl = document.getElementById('loading-text') as HTMLElement;

  // 1. Three.js
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const aspect = container.clientWidth / container.clientHeight || 16 / 9;
  camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 3000);
  chaseCam = new THREE.PerspectiveCamera(60, aspect, 0.1, 3000);

  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  basePixelRatio = Math.min(window.devicePixelRatio, isMobile ? 1.35 : 1.75);
  renderer.setPixelRatio(basePixelRatio);
  telemetry = new Telemetry(isMobile);
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  createCityGround(scene);

  // Единая система света — только в createEnvironment()
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES слишком гасит тёмные тона low-poly сцены — оставляем прямой вывод
  renderer.toneMapping = THREE.NoToneMapping;

  environment = createEnvironment(scene, chaseCam);
  atmosphere = createAtmosphere(scene, chaseCam);

  // 2. Физика
  setLoading('Инициализация физики...', loadingTextEl);
  await initPhysics();
  createStaticFloor(30000);

  // 3. Город (CityWorld)
  setLoading('Загрузка города Алматы...', loadingTextEl);
  streetMetadata = new StreetMetadataProvider({
    publicBaseUrl: new URL(import.meta.env.BASE_URL, window.location.origin).href,
  });

  cityWorld = new CityWorld(
    scene,
    chaseCam, // frustum считаем по камере (в кабине камера внутри GLB)
    new OsmTileProvider(),
    getPhysicsWorld(),
    {
      onTileError: (x, z, e) => console.error(`[CityWorld] тайл ${x}_${z}:`, e),
      onTileLoaded: (x, z) => { void streetMetadata.notifyTileLoaded(x, z); },
      onTileUnloaded: (x, z) => streetMetadata.removeTile(x, z),
      onTileEvicted: (x, z) => streetMetadata.removeTile(x, z),
    }
  );

  // Уличные объекты (деревья, фонари, разметка, остановки)
  streetProps = createStreetProps(scene, streetMetadata.tileKeyProvider);

  traffic = createTraffic(scene, cityWorld.graph);

  // 4. Автобус — стартуем без ожидания GLB
  setLoading('Посадка за руль...', loadingTextEl);
  bus = new Bus(scene, camera);
  bus.setCameraMode('chase');
  // LOD автобуса: 34.9k / 13.1k / 4.5k треугольников.
  // На слабых устройствах не платим за незаметные детали высокого LOD.
  const qualityPreset = detectQuality().preset;
  const busLod = qualityPreset === 'low' ? '-lod2' : qualityPreset === 'medium' ? '-lod1' : '';
  const modelUrl = `${import.meta.env.BASE_URL}models/vehicles/tevy-non-step-city-bus${busLod}.glb`;
  const fallbackUrl = `${import.meta.env.BASE_URL}models/variants/bus_almaty_212_golden_hour.glb`;
  const modelPromise = bus.loadModel(modelUrl, camera, renderer, fallbackUrl);

  // 5. Ввод, звук, UI — сразу
  void initAudio().catch((e) => console.warn('[audio]', e));
  initInput();
  setupTouchZones(container);
  setupLookControl(renderer.domElement);
  hud = new HUD();
  passengers = new PassengerService();
  shift = new ShiftManager();
  setupMenuButtons();

  // Маршруты: загружаем индекс остановок в фоне
  routeTracker = new RouteTracker();
  void routeTracker.load().then(() => {
    // Не перезаписываем маршрут, если пользователь уже выбрал другой
    if (!routeTracker.currentRoute) {
      const first = ROUTES[0];
      if (first) routeTracker.selectRoute(first, 0);
    }
    console.info('[routes] загружены:', ROUTES.map((r) => r.id).join(', '));
  }).catch((err) => console.warn('[routes] не загрузились:', err));

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __busDebug: { scene, bus, cityWorld, traffic, streetProps, renderer },
    });
  }

  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);

  if (loadingEl) {
    loadingEl.classList.add('hidden');
    setTimeout(() => loadingEl.remove(), 400);
  }

  animate(0);

  // После загрузки модели — включаем кабину
  void modelPromise.then((loaded) => {
    if (loaded) {
      currentMode = 'driver';
      bus.setCameraMode('driver');
      bus.setLook(lookYaw, lookPitch);
      console.info('[bus] Модель загружена, кабина активна');
    } else {
      console.warn('[bus] GLB не загружен — внешняя камера');
    }
  });
}

function createCityGround(scene: THREE.Scene): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(60000, 60000);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x596052, roughness: 1, metalness: 0,
  });
  const ground = new THREE.Mesh(geometry, material);
  ground.name = 'city-ground';
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  scene.add(ground);
  return ground;
}

function setLoading(text: string, el: HTMLElement) {
  el.textContent = text;
}

function onResize() {
  const container = document.getElementById('canvas');
  if (!container) return;
  const aspect = container.clientWidth / container.clientHeight || 16 / 9;
  for (const cam of [camera, chaseCam]) {
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
  renderer.setSize(container.clientWidth, container.clientHeight);
}

function setupLookControl(dom: HTMLElement) {
  dom.addEventListener('pointermove', (e) => {
    if (e.buttons !== 1 || currentMode !== 'driver') return;
    lookYaw -= e.movementX * 0.002;
    lookPitch -= e.movementY * 0.002;
    bus.setLook(lookYaw, lookPitch);
  });
}

function showShiftResult() {
  const r = shift.finish();
  if (!r) return;
  const el = document.getElementById('shift-result')!;
  el.style.display = 'flex';
  document.getElementById('result-grade')!.textContent = `${r.grade} · ${r.score}/100`;
  document.getElementById('result-body')!.innerHTML = `
    <div>Маршрут: <strong>${r.routeId}</strong> · ${r.onTime ? 'вовремя' : `опоздание ${Math.floor(r.delaySec / 60)} мин`}</div>
    <div>Обслужено остановок: <strong>${r.stopsServed}</strong></div>
    <div>Плавность езды: <strong>${r.drivingScore}/100</strong></div>
    <div>Расстояние: <strong>${(r.totalDistanceM / 1000).toFixed(1)} км</strong></div>
    <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.15);">
      Награда: <strong style="color:#f3a35f;">+${r.reward} ₸</strong>
    </div>
    <div style="font-size:12px; color:#91aaa6; margin-top:8px;">
      Всего смен: ${shift.saved.shiftsDone} · Заработано: ${shift.saved.totalReward} ₸ · Лучший результат: ${shift.saved.bestScore}
    </div>
    <div style="font-size:12px; color:#61d0bf; margin-top:6px;">${shift.saved.medals.join(' · ')}</div>
  `;
  console.info('[shift] итоги:', r);
}

function setupMenuButtons() {
  // Кнопки выбора линии
  document.querySelectorAll<HTMLElement>('[data-route]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.dataset.route;
      const route = id ? ROUTES.find((r) => r.id === id) : undefined;
      if (route) {
        routeTracker.selectRoute(route, 0);
        const dir = route.directions[0];
        hud.setRoute(route.id, dir?.to ?? route.name_ru, 0);
        shift.start(route.id, dir?.stops.length ?? 10, (dir?.stops.length ?? 10) * 450);
        lastPos = bus.getPosition();
        hud.startGame();
        console.info('[routes] выбрана линия', route.id, route.name_ru);
      }
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switch (btn.dataset.action) {
        case 'free-ride':
          hud.startGame();
          break;
        case 'lines': {
          const panel = document.getElementById('lines-panel');
          if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          break;
        }
        case 'doors':
          bus.toggleDoors();
          playDoors(bus.doorsOpen);
          break;
        case 'camera':
          currentMode = currentMode === 'chase' ? 'driver' : 'chase';
          bus.setCameraMode(currentMode);
          break;
        case 'finish-shift':
          showShiftResult();
          break;
        case 'new-shift':
          document.getElementById('shift-result')!.style.display = 'none';
          document.querySelector('.game-ui')!.classList.add('is-menu-open');
          break;
        case 'drive-mode': {
          const next = bus.getDriveMode() === 'arcade' ? 'sim' : 'arcade';
          bus.setDriveMode(next);
          btn.querySelector('span')!.textContent = next === 'arcade' ? 'Режим: Аркада' : 'Режим: Симулятор';
          break;
        }
        case 'handbrake':
          (window as unknown as Record<string, unknown>).__mobile_handbrake = true;
          setTimeout(() => { (window as unknown as Record<string, unknown>).__mobile_handbrake = false; }, 250);
          break;
        case 'horn':
          playHorn();
          break;
        case 'reset':
          window.location.reload();
          break;
        case 'pause':
          paused = !paused;
          document.querySelector('.hud')?.classList.toggle('hud-hidden', paused);
          break;
        case 'photo':
          document.querySelector('.hud')?.classList.toggle('hud-hidden');
          break;
      }
    });
  });
}

function setupTouchZones(container: HTMLElement) {
  const isButton = (t: EventTarget | null) => t instanceof HTMLElement && t.tagName === 'BUTTON';

  container.addEventListener('touchstart', (e) => {
    if (isButton(e.target)) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    if (t.clientX < container.clientWidth / 2) {
      isThrottling = true;
      throttleStartY = t.clientY;
    } else {
      isSteering = true;
      steerStartX = t.clientX;
    }
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    if (isButton(e.target)) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (isThrottling) {
        const delta = (throttleStartY - t.clientY) / 180;
        touchThrottle = Math.max(0, Math.min(1, delta));
        touchBrake = Math.max(0, Math.min(1, -delta));
      }
      if (isSteering) {
        const delta = (t.clientX - steerStartX) / 180;
        touchSteer = Math.max(-1, Math.min(1, delta));
      }
    }
  }, { passive: false });

  const reset = () => {
    isThrottling = false;
    isSteering = false;
    touchThrottle = 0;
    touchBrake = 0;
    touchSteer = 0;
  };
  container.addEventListener('touchend', reset);
  container.addEventListener('touchcancel', reset);
}

function animate(time: number) {
  requestAnimationFrame(animate);
  const frameStart = performance.now();

  const frameDt = Math.min(clock.getDelta(), 0.05);
  if (paused) { renderer.render(scene, currentMode === 'driver' ? camera : chaseCam); return; }
  accumulator = Math.min(accumulator + frameDt, 0.1);

  const input = getInput();
  if (input.camera) {
    currentMode = currentMode === 'chase' ? 'driver' : 'chase';
    bus.setCameraMode(currentMode);
  }
  if (input.doors) {
    bus.toggleDoors();
    playDoors(bus.doorsOpen);
  }
  if (input.horn) playHorn();
  if (input.reset) window.location.reload();
  if (input.timeOfDay) {
    scene.userData.timeOfDay = scene.userData.timeOfDay === 'night' ? 'day' : 'night';
    console.info('[time]', scene.userData.timeOfDay);
  }
  updateEngine(Math.min(1, bus.getSpeedKmh() / 90), input.throttle > 0 ? 1 : 0);
  clearFrameFlags();

  // Арбитраж источников: клавиатура/геймпад приоритетнее тача.
  // Math.max ломал задний ход: -1 превращался в 0.
  const hasKbThrottle = Math.abs(input.throttle) > 0.01;
  const merged = {
    ...input,
    throttle: hasKbThrottle ? input.throttle : (Math.abs(touchThrottle) > 0.01 ? touchThrottle : input.throttle),
    brake: Math.max(input.brake, touchBrake),
    steering: input.steering !== 0 ? input.steering : touchSteer,
  };

  // Фиксированный шаг физики
  while (accumulator >= FIXED_DT) {
    bus.update(FIXED_DT, merged);
    stepPhysics(FIXED_DT);
    accumulator -= FIXED_DT;
  }
  bus.syncVisual(frameDt, merged.steering, chaseCam);

  const pos = bus.getPosition();
  if (lastPos && shift.state.active) {
    const dm = pos.distanceTo(lastPos);
    // Ускорение (м/с²), нормированное на deltaTime — оценка не зависит от FPS
    const jerk = Math.abs(bus.getSpeedKmh() - lastSpeed) / 3.6 / Math.max(0.001, frameDt);
    shift.tick(dm, jerk);
  }
  if (lastPos) lastPos.copy(pos); else lastPos = pos.clone();
  lastSpeed = bus.getSpeedKmh();
  const vel = bus.getLinearVelocity();
  const fwd = bus.getForward();
  cityWorld.update({ position: pos, velocity: vel, forward: fwd, deltaSeconds: frameDt, activeCamera: currentMode === 'driver' ? camera : chaseCam });

  // Камера для уличных объектов (мировая позиция)
  const activeCamTmp = currentMode === 'driver' ? camera : chaseCam;
  activeCamTmp.updateMatrixWorld();
  streetProps.update(activeCamTmp.getWorldPosition(_tmpCamPos), frameDt);
  scene.userData.busPosition = pos;
  scene.userData.busQuaternion = bus.body.rotation();
  scene.userData.isNight = scene.userData.timeOfDay === 'night';
  environment.update(frameDt, activeCamTmp);
  atmosphere.update(frameDt, activeCamTmp);
  traffic.update(frameDt, pos, bus.getForward(), scene.userData.isNight === true);

  if (time - lastHudTime >= 100) {
    hud.update(bus.getSpeedKmh(), bus.getGear());
    const progress = routeTracker.update(pos.x, pos.z);
    if (progress) {
      hud.setRoute(progress.routeId, progress.nextStop, progress.distanceM);
      const atStop = progress.distanceM < 30;
      const justServed = passengers.update(0.1, atStop, bus.getSpeedKmh(), input.handbrake, bus.doorsOpen, progress.currentStop);
      if (justServed) shift.onStopServed();
      const st = passengers.state;
      hud.updateTrip({
        onboard: st.onboard, capacity: st.capacity, score: st.score,
        stops: st.stopsServed, message: st.lastMessage,
        doors: bus.doorsOpen, serving: st.serving, progress: st.progress,
      });
    }
    lastHudTime = time;
  }
  if (time - lastStreetReport >= 5000) {
    console.info('[streetProps]', streetProps.getStats(), 'city:', cityWorld.getStats());
    lastStreetReport = time;
  }

  const activeCam = currentMode === 'driver' ? camera : chaseCam;
  renderer.render(scene, activeCam);
  // Замеряем ПОЛНЫЙ кадр (включая OSM/LOD/StreetProps), а не только render()
  if (telemetry.update(time, performance.now() - frameStart, renderer.info.render)) {
    renderer.setPixelRatio(basePixelRatio * telemetry.pixelRatioScale);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error('Ошибка запуска игры:', err);
    const el = document.getElementById('loading-text');
    if (el) el.textContent = 'Ошибка загрузки: см. консоль (F12)';
  });
});
