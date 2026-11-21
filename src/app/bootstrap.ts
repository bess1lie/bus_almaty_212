/**
 * bootstrap.ts — точка входа приложения.
 * Three.js + Rapier + CityWorld(BatchedMesh/LOD/frustum/prefetch) + Bus(GLTF) + UI.
 */

import * as THREE from 'three';
import { initPhysics, stepPhysics, createStaticFloor, getEventQueue } from '../core/rapier';
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
import { createStreetProps } from '../world/streetProps';
import { StreetMetadataProvider } from '../world/streetMetadata';
import { HUD } from '../ui/hud';
import { Telemetry } from '../core/telemetry';

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
let traffic: ReturnType<typeof createTraffic>;
let telemetry: Telemetry;
let basePixelRatio = 1;
let routeTracker: RouteTracker;
let hud: HUD;

let accumulator = 0;
let lastHudTime = 0;
let lastStreetReport = 0;
let currentMode: 'driver' | 'chase' = 'chase';
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
  scene.fog = new THREE.FogExp2(0x0f172a, 0.0012);

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

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(60, 70, 20);
  if (!isMobile) {
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 500;
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
  }
  scene.add(sun);

  createEnvironment(scene);
  atmosphere = createAtmosphere(scene, chaseCam);
  traffic = createTraffic(scene);

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
    }
  );

  // Уличные объекты (деревья, фонари, разметка, остановки)
  streetProps = createStreetProps(scene, streetMetadata.tileKeyProvider);

  // 4. Автобус — стартуем без ожидания GLB
  setLoading('Посадка за руль...', loadingTextEl);
  bus = new Bus(scene, camera);
  bus.setCameraMode('chase');
  const modelUrl = `${import.meta.env.BASE_URL}models/variants/bus_almaty_212_golden_hour.glb`;
  const modelPromise = bus.loadModel(modelUrl, camera);

  // 5. Ввод, звук, UI — сразу
  void initAudio().catch((e) => console.warn('[audio]', e));
  initInput();
  setupTouchZones(container);
  setupLookControl(renderer.domElement);
  hud = new HUD();
  setupMenuButtons();

  // Маршруты: загружаем индекс остановок в фоне
  routeTracker = new RouteTracker();
  void routeTracker.load().then(() => {
    const first = ROUTES[0];
    if (first) {
      routeTracker.selectRoute(first, 0);
      console.info('[routes] загружены:', ROUTES.map((r) => r.id).join(', '));
    }
  }).catch((err) => console.warn('[routes] не загрузились:', err));

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

function setupMenuButtons() {
  // Кнопки выбора линии
  document.querySelectorAll<HTMLElement>('[data-route]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.dataset.route;
      const route = id ? ROUTES.find((r) => r.id === id) : undefined;
      if (route) {
        routeTracker.selectRoute(route, 0);
        hud.setRoute(route.id, route.directions[0]?.to ?? route.name_ru, 0);
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
        case 'horn':
          playHorn();
          break;
        case 'reset':
          window.location.reload();
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

  const frameDt = Math.min(clock.getDelta(), 0.05);
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

  const merged = {
    ...input,
    throttle: Math.max(input.throttle, touchThrottle),
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
  const vel = bus.getLinearVelocity();
  const fwd = bus.getForward();
  cityWorld.update({ position: pos, velocity: vel, forward: fwd, deltaSeconds: frameDt, activeCamera: currentMode === 'driver' ? camera : chaseCam });

  // Камера для уличных объектов (мировая позиция)
  const activeCamTmp = currentMode === 'driver' ? camera : chaseCam;
  activeCamTmp.updateMatrixWorld();
  streetProps.update(activeCamTmp.getWorldPosition(new THREE.Vector3()));
  scene.userData.busPosition = pos;
  scene.userData.busQuaternion = bus.body.rotation();
  scene.userData.isNight = scene.userData.timeOfDay === 'night';
  atmosphere.update(frameDt, activeCamTmp);
  traffic.update(frameDt, pos, bus.getForward(), scene.userData.isNight === true);

  if (time - lastHudTime >= 100) {
    hud.update(bus.getSpeedKmh(), bus.getGear());
    const progress = routeTracker.update(pos.x, pos.z);
    if (progress) {
      hud.setRoute(progress.routeId, progress.nextStop, progress.distanceM);
    }
    lastHudTime = time;
  }
  if (time - lastStreetReport >= 5000) {
    console.info('[streetProps]', streetProps.getStats(), 'city:', cityWorld.getStats());
    lastStreetReport = time;
  }

  const activeCam = currentMode === 'driver' ? camera : chaseCam;
  const renderStart = performance.now();
  renderer.render(scene, activeCam);
  if (telemetry.update(time, performance.now() - renderStart, renderer.info.render)) {
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
