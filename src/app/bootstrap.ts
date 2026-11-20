/**
 * bootstrap.ts — точка входа приложения.
 * Three.js + Rapier + TileManager + Bus(GLTF) + ввод + HUD + игровой цикл.
 */

import * as THREE from 'three';
import { initPhysics, stepPhysics, createStaticFloor } from '../core/rapier';
import { initInput, getInput, clearFrameFlags } from '../core/input';
import { initAudio, updateEngine, playHorn, playDoors } from '../core/audio';
import { Bus } from '../vehicle/bus';
import { CityWorld } from '../world/cityWorld';
import { createEnvironment } from '../world/environment';
import { HUD } from '../ui/hud';

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;   // камера кабины (уходит в GLB)
let chaseCam: THREE.PerspectiveCamera; // камера третьего лица
let renderer: THREE.WebGLRenderer;
let clock: THREE.Clock;
let bus: Bus;
let cityWorld: CityWorld;
let hud: HUD;

let frameCount = 0;
let lastFpsTime = 0;
let currentMode: 'driver' | 'chase' = 'chase';

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
  camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 2000);
  chaseCam = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(60, 70, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 500;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  scene.add(sun);

  // Окружение: горы, закатное небо, тёплый свет
  createEnvironment(scene);

  // 2. Физика
  setLoading('Инициализация физики...', loadingTextEl);
  await initPhysics();
  createStaticFloor(2000);
  stepPhysics(0);

  // 3. Карта
  setLoading('Загрузка города Алматы...', loadingTextEl);
  cityWorld = new CityWorld(scene);

  // 4. Автобус + модель
  setLoading('Загрузка автобуса...', loadingTextEl);
  bus = new Bus(scene);
  const modelUrl = `${import.meta.env.BASE_URL}models/variants/bus_almaty_212_golden_hour.glb`;
  const loaded = await bus.loadModel(modelUrl, camera);
  if (!loaded) console.warn('[bootstrap] GLB не загружен, fallback активен.');

  // 5. Звук, ввод и HUD
  try {
    await initAudio();
  } catch (err) {
    console.warn('[audio] звук недоступен:', err);
  }
  initInput();
  setupTouchZones(container);
  hud = new HUD();
  setupMenuButtons();

  if (loadingEl) {
    loadingEl.classList.add('hidden');
    setTimeout(() => loadingEl.remove(), 400);
  }

  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
  animate(0);
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

function setupMenuButtons() {
  document.querySelectorAll<HTMLElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      switch (action) {
        case 'free-ride':
          hud.startGame();
          break;
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
        case 'photo':
        case 'pause':
        case 'map':
        case 'lines':
        case 'settings':
        case 'handbrake':
          // заглушки — логика позже
          break;
      }
    });
  });
}

function setupTouchZones(container: HTMLElement) {
  const isButton = (t: EventTarget | null) =>
    t instanceof HTMLElement && t.tagName === 'BUTTON';

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

  const dt = Math.min(clock.getDelta(), 0.1);
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
  updateEngine(Math.min(1, bus.getSpeedKmh() / 90), input.throttle > 0 ? 1 : 0);
  clearFrameFlags();

  const merged = {
    ...input,
    throttle: Math.max(input.throttle, touchThrottle),
    brake: Math.max(input.brake, touchBrake),
    steering: input.steering !== 0 ? input.steering : touchSteer,
  };

  const pos = bus.getPosition();
  cityWorld.setPlayerPosition(pos.x, pos.z);
  cityWorld.update(dt);

  bus.update(dt, merged, chaseCam);

  frameCount++;
  if (time - lastFpsTime >= 1000) {
    hud.update(bus.getSpeedKmh(), currentMode === 'driver' ? 'D' : 'D');
    frameCount = 0;
    lastFpsTime = time;
  }

  stepPhysics(dt);

  const activeCam = currentMode === 'driver' ? camera : chaseCam;
  renderer.render(scene, activeCam);
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error('Ошибка запуска игры:', err);
    const el = document.getElementById('loading-text');
    if (el) el.textContent = 'Ошибка загрузки: см. консоль (F12)';
  });
});
