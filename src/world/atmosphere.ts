import * as THREE from 'three';

const HAZE_COLOR = 0xcda28a;
const FOG_DENSITY = 0.00018;
const HAZE_DISTANCES = [170, 360] as const;

interface Vector3Like { x: number; y: number; z: number; }
interface QuaternionLike { x: number; y: number; z: number; w: number; }

export interface AtmosphereController {
  update(dt: number, activeCamera?: THREE.Camera): void;
  dispose(): void;
}

function readVector3(source: unknown, target: THREE.Vector3): boolean {
  if (source instanceof THREE.Vector3) { target.copy(source); return true; }
  if (typeof source !== 'object' || source === null) return false;
  const c = source as Partial<Vector3Like>;
  if (typeof c.x !== 'number' || typeof c.y !== 'number' || typeof c.z !== 'number') return false;
  target.set(c.x, c.y, c.z);
  return true;
}

function readQuaternion(source: unknown, target: THREE.Quaternion): boolean {
  if (source instanceof THREE.Quaternion) { target.copy(source); return true; }
  if (typeof source !== 'object' || source === null) return false;
  const c = source as Partial<QuaternionLike>;
  if (typeof c.x !== 'number' || typeof c.y !== 'number' || typeof c.z !== 'number' || typeof c.w !== 'number') return false;
  target.set(c.x, c.y, c.z, c.w);
  return true;
}

export function createAtmosphere(scene: THREE.Scene, camera: THREE.Camera): AtmosphereController {
  scene.fog = new THREE.FogExp2(0x8a8fa0, FOG_DENSITY);

  const hazeGeometry = new THREE.PlaneGeometry(1, 1);
  const hazeMaterial = new THREE.MeshBasicMaterial({
    color: HAZE_COLOR, transparent: true, opacity: 0.04,
    depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    toneMapped: false, fog: false,
  });
  const hazeCards = HAZE_DISTANCES.map((distance, index) => {
    const card = new THREE.Mesh(hazeGeometry, hazeMaterial);
    card.name = `atmosphere-haze-${index}`;
    card.position.set(0, 0, -distance);
    card.renderOrder = 900 + index;
    card.frustumCulled = false;
    camera.add(card);
    return card;
  });

  const shadowGeometry = new THREE.CircleGeometry(1, 32);
  shadowGeometry.rotateX(-Math.PI / 2);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x171b20, transparent: true, opacity: 0.35,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, toneMapped: false,
  });
  const busShadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  busShadow.name = 'bus-contact-shadow';
  busShadow.position.y = 0.1;
  busShadow.scale.set(1.45, 5.35, 1);
  busShadow.renderOrder = 2;
  busShadow.frustumCulled = false;
  busShadow.visible = false;
  scene.add(busShadow);

  const headlights: THREE.SpotLight[] = [];
  for (let i = 0; i < 2; i++) {
    const light = new THREE.SpotLight(0xffe8ca, 0, 60, 0.4, 0.45, 2);
    light.name = i === 0 ? 'bus-headlight-left' : 'bus-headlight-right';
    light.castShadow = false;
    light.visible = false;
    light.target.name = `${light.name}-target`;
    scene.add(light);
    scene.add(light.target);
    headlights.push(light);
  }

  const busPosition = new THREE.Vector3();
  const busQuaternion = new THREE.Quaternion();
  const localOffset = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  const headlightTarget = new THREE.Vector3();
  const forwardOffset = new THREE.Vector3(0, -2, -60);

  let hazeCamera: THREE.Camera = camera;
  let nightAmount = 0;
  let disposed = false;

  function resizeHazeCards(activeCamera: THREE.Camera): void {
    const p = activeCamera as THREE.PerspectiveCamera;
    const fov = p.isPerspectiveCamera === true ? p.fov : 60;
    const aspect = p.isPerspectiveCamera === true ? p.aspect : 16 / 9;
    const half = Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
    for (let i = 0; i < hazeCards.length; i++) {
      const d = HAZE_DISTANCES[i];
      const height = 2 * d * half;
      hazeCards[i].scale.set(height * Math.max(0.1, aspect), height, 1);
      hazeCards[i].position.set(0, 0, -d);
    }
  }
  resizeHazeCards(camera);

  function update(dt: number, activeCamera: THREE.Camera = camera): void {
    if (disposed) return;
    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.1);

    if (activeCamera !== hazeCamera) {
      for (const card of hazeCards) { hazeCamera.remove(card); activeCamera.add(card); }
      hazeCamera = activeCamera;
      resizeHazeCards(activeCamera);
    }

    const p = activeCamera as THREE.PerspectiveCamera;
    if (p.isPerspectiveCamera === true) {
      const first = hazeCards[0];
      const h = 2 * HAZE_DISTANCES[0] * Math.tan(THREE.MathUtils.degToRad(p.fov) * 0.5);
      const w = h * Math.max(0.1, p.aspect);
      if (Math.abs(first.scale.x - w) > 0.01 || Math.abs(first.scale.y - h) > 0.01) resizeHazeCards(activeCamera);
    }

    const hasBusPosition = readVector3(scene.userData.busPosition, busPosition);
    if (hasBusPosition) {
      const hasQuat = readQuaternion(scene.userData.busQuaternion, busQuaternion);
      if (!hasQuat || busQuaternion.lengthSq() < 1e-8) busQuaternion.identity();
      else busQuaternion.normalize();

      busShadow.position.set(busPosition.x, 0.1, busPosition.z);
      busShadow.quaternion.copy(busQuaternion);
      busShadow.visible = true;

      forwardOffset.set(0, -2, -60).applyQuaternion(busQuaternion);
      headlightTarget.copy(busPosition).add(forwardOffset);
      for (let i = 0; i < headlights.length; i++) {
        const side = i === 0 ? -0.78 : 0.78;
        localOffset.set(side, -0.22, -5.7).applyQuaternion(busQuaternion);
        worldPoint.copy(busPosition).add(localOffset);
        headlights[i].position.copy(worldPoint);
        headlights[i].target.position.copy(headlightTarget);
      }
    } else {
      busShadow.visible = false;
    }

    const nightTarget = scene.userData.isNight === true ? 1 : 0;
    nightAmount += (nightTarget - nightAmount) * (1 - Math.exp(-safeDt * 3.5));
    for (const light of headlights) {
      light.intensity = 115 * nightAmount;
      light.visible = hasBusPosition && nightAmount > 0.005;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const card of hazeCards) card.parent?.remove(card);
    hazeGeometry.dispose();
    hazeMaterial.dispose();
    scene.remove(busShadow);
    shadowGeometry.dispose();
    shadowMaterial.dispose();
    for (const light of headlights) { scene.remove(light); scene.remove(light.target); }
  }

  return { update, dispose };
}
