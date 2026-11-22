import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { BusVisualLike } from './bus-visual';

const WHEEL_RADIUS = 0.42;
const MAX_FRONT_STEER_RAD = 0.42;
const MAX_STEERING_WHEEL_RAD = 1.25;
const DOOR_TRAVEL = 0.42;
const DOOR_DAMPING = 8;
const MAX_CAMERA_ROLL = THREE.MathUtils.degToRad(2);
const CAMERA_ROLL_DAMPING = 7.5;

const LIVERY_COLORS = {
  golden_hour: { body: '#EFEBDD', lower: '#267B73', stripe: '#55C4B6' },
  sand: { body: '#E4D2AE', lower: '#8A6A44', stripe: '#C8A46C' },
  turquoise: { body: '#EAF4F1', lower: '#178C83', stripe: '#5CD2C0' },
} as const;

export type ModernBusLivery = keyof typeof LIVERY_COLORS;

export type ModernBusOptions = {
  renderer: THREE.WebGLRenderer;
  livery?: ModernBusLivery;
};

type Pivot = {
  node: THREE.Object3D;
  rest: THREE.Vector3;
};

function required(root: THREE.Object3D, name: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (!object) throw new Error(`[bus-modern] В GLB отсутствует узел "${name}"`);
  return object;
}

function tuneMaterials(root: THREE.Object3D, livery: ModernBusLivery): void {
  const palette = LIVERY_COLORS[livery] ?? LIVERY_COLORS.golden_hour;
  const seen = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.frustumCulled = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      const m = mat;
      switch (m.name) {
        case 'paint_body': m.color.set(palette.body); m.roughness = 0.42; m.metalness = 0.08; break;
        case 'roof_paint_body':
        case 'roof_paint': m.color.set('#E8ECE7'); m.roughness = 0.5; break;
        case 'skirt_body':
        case 'skirt': m.color.set(palette.lower); m.roughness = 0.5; break;
        case 'accent_body':
        case 'dest_body':
        case 'dest': m.color.set(palette.stripe); m.roughness = 0.35; break;
        case 'trim_matte_body': m.color.set('#38525B'); m.roughness = 0.55; break;
        case 'trim_gloss_body':
        case 'trim_gloss': m.color.set('#45616A'); m.roughness = 0.28; m.metalness = 0.25; break;
        case 'panel_gap_body': m.color.set('#263238'); m.roughness = 0.8; break;
        case 'glass':
          m.color.set('#6E9AA8'); m.roughness = 0.14; m.metalness = 0.12;
          m.opacity = 0.44; m.transparent = true; m.depthWrite = false;
          m.side = THREE.DoubleSide; break;
        case 'mirror_glass': m.color.set('#C2D6D8'); m.metalness = 0.75; m.roughness = 0.12; break;
        case 'light_front_body':
        case 'light_rear_body': m.emissive.set('#FFE1A6'); m.emissiveIntensity = 1.1; break;
        case 'lamp_amber_body': m.emissive.set('#FF9B43'); m.emissiveIntensity = 0.8; break;
        case 'lamp_red_body': m.emissive.set('#FF332B'); m.emissiveIntensity = 0.7; break;
        case 'tire': m.roughness = 0.95; break;
        case 'rim_paint': m.color.set('#9DA9A5'); m.roughness = 0.35; m.metalness = 0.4; break;
        case 'rim_machined': m.roughness = 0.25; m.metalness = 0.7; break;
        case 'seat': m.color.set('#24665D'); m.roughness = 0.9; break;
        case 'driver_seat': m.color.set('#2B3D42'); m.roughness = 0.9; break;
        case 'interior': m.color.set('#303C3A'); m.roughness = 0.9; break;
        case 'floor': m.color.set('#59615E'); m.roughness = 0.95; break;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * Загружает CC0-модель Tevy Non-step City Bus (девять дверей/салон) и
 * подгоняет её под Алматы:
 *  - Guidance: левый руль, пассажирские двери справа (у тротуара);
 *  - модель authored forward=+Z, в игре forward=-Z.
 *
 * Отражение X + поворот на 180° даёт чистое преобразование (x,y,z)→(x,y,-z):
 * водитель остаётся слева, двери — справа, нос смотрит в -Z.
 */
export async function createModernBusVisual(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  modelUrl: string,
  options: ModernBusOptions,
): Promise<BusVisualLike> {
  await MeshoptDecoder.ready;

  const ktx2 = new KTX2Loader()
    .setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)
    .detectSupport(options.renderer);
  const loader = new GLTFLoader();
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);

  let gltf;
  try {
    gltf = await loader.loadAsync(modelUrl);
  } finally {
    ktx2.dispose();
  }

  const model = required(gltf.scene, 'non-step-city-bus');
  tuneMaterials(gltf.scene, options.livery ?? 'golden_hour');

  const root = new THREE.Group();
  root.name = 'bus_root';
  const mirrorRig = new THREE.Group();
  mirrorRig.name = 'bus_model_orientation';
  mirrorRig.scale.x = -1;
  mirrorRig.rotation.y = Math.PI;
  mirrorRig.add(model);
  root.add(mirrorRig);
  scene.add(root);
  root.updateWorldMatrix(true, true);

  // Кабина водителя: чуть выше и позади руля.
  const steeringNode = required(model, 'steering_wheel');
  const steeringWorld = steeringNode.getWorldPosition(new THREE.Vector3());
  const cabinAnchor = new THREE.Group();
  cabinAnchor.name = 'camera_driver';
  cabinAnchor.position.copy(root.worldToLocal(steeringWorld.clone()));
  cabinAnchor.position.x -= 0.02;
  cabinAnchor.position.y += 0.18;
  cabinAnchor.position.z += 0.55;
  root.add(cabinAnchor);

  const yawRig = new THREE.Group();
  const pitchRig = new THREE.Group();
  const cameraMount = new THREE.Group();
  cameraMount.rotation.x = -0.08; // чуть вниз — дорога и приборы остаются в кадре
  const rollRig = new THREE.Group();
  cabinAnchor.add(yawRig);
  yawRig.add(pitchRig);
  pitchRig.add(cameraMount);
  cameraMount.add(rollRig);
  camera.removeFromParent();
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  camera.near = 0.05;
  camera.far = 3500;
  camera.updateProjectionMatrix();
  rollRig.add(camera);

  // Переносим анимируемые узлы в отдельные pivot'ы, чтобы не трогать
  // исходные масштабы/повороты модели.
  function makePivot(name: string): Pivot {
    const node = required(model, name);
    const pivot = new THREE.Group();
    pivot.name = `pivot_${name}`;
    root.add(pivot);
    const world = node.getWorldPosition(new THREE.Vector3());
    pivot.position.copy(root.worldToLocal(world));
    pivot.attach(node);
    return { node: pivot, rest: pivot.position.clone() };
  }

  const wheelFl = makePivot('wheel_FL');
  const wheelFr = makePivot('wheel_FR');
  const wheelRl = makePivot('wheel_RL');
  const wheelRr = makePivot('wheel_RR');
  const steerPivot = makePivot('steering_wheel');
  const doorFrontA = makePivot('door_front_a');
  const doorFrontB = makePivot('door_front_b');
  const doorMid = makePivot('door_mid');
  const doorRear = makePivot('door_rear');

  // Приборная панель: у CC0-модели есть руль и кресло, но почти нет приборов.
  // Собираем компактный щиток с двумя стрелками, не затрагивая геометрию салона.
  const dashboard = new THREE.Group();
  dashboard.name = 'dashboard_retrofit';
  dashboard.position.set(-0.74, 1.03, -4.95);
  root.add(dashboard);
  const dashMat = new THREE.MeshStandardMaterial({ color: '#1C262B', roughness: 0.7, metalness: 0.15 });
  const faceMat = new THREE.MeshStandardMaterial({ color: '#DCE4DF', roughness: 0.45 });
  const needleMat = new THREE.MeshStandardMaterial({ color: '#D84740', roughness: 0.5, emissive: '#8C1F18', emissiveIntensity: 0.2 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.34, 0.28), dashMat);
  dashboard.add(panel);
  const speedNeedle = new THREE.Group();
  const rpmNeedle = new THREE.Group();
  speedNeedle.position.set(-0.23, 0.04, 0.15);
  rpmNeedle.position.set(0.23, 0.04, 0.15);
  dashboard.add(speedNeedle, rpmNeedle);
  for (const group of [speedNeedle, rpmNeedle]) {
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.012, 24), faceMat);
    face.rotation.x = Math.PI / 2;
    group.add(face);
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.105, 0.008), needleMat);
    needle.position.y = 0.04;
    group.add(needle);
  }

  const mirrorLeft = new THREE.Object3D();
  const mirrorRight = new THREE.Object3D();
  mirrorLeft.position.copy(root.worldToLocal(required(model, 'mirror_L').getWorldPosition(new THREE.Vector3())));
  mirrorRight.position.copy(root.worldToLocal(required(model, 'mirror_R').getWorldPosition(new THREE.Vector3())));
  root.add(mirrorLeft, mirrorRight);

  return new ModernBusVisual(
    scene, root, yawRig, pitchRig, rollRig,
    [wheelFl, wheelFr, wheelRl, wheelRr], steerPivot,
    [doorFrontA, doorFrontB, doorMid, doorRear],
    mirrorLeft, mirrorRight,
    [speedNeedle, rpmNeedle], needleMat,
  );
}

class ModernBusVisual implements BusVisualLike {
  readonly root: THREE.Object3D;
  readonly mirrorCamLeft: THREE.Object3D;
  readonly mirrorCamRight: THREE.Object3D;

  private readonly sceneObject: THREE.Object3D;
  private readonly yawRig: THREE.Group;
  private readonly pitchRig: THREE.Group;
  private readonly rollRig: THREE.Group;
  private readonly wheels: Pivot[];
  private readonly steerPivot: Pivot;
  private readonly doors: Pivot[];
  private readonly steerRestZ: number;
  private cameraRoll = 0;
  private doorAmount = 0;
  private doorTarget = 0;
  private readonly forward = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly needles: THREE.Object3D[];
  private readonly needleMat: THREE.MeshStandardMaterial;
  private speedNeedleAngle = 0;
  private rpmNeedleAngle = 0;
  private dashGlow = 0;

  constructor(
    sceneObject: THREE.Object3D,
    root: THREE.Object3D,
    yawRig: THREE.Group,
    pitchRig: THREE.Group,
    rollRig: THREE.Group,
    wheels: Pivot[],
    steerPivot: Pivot,
    doors: Pivot[],
    mirrorLeft: THREE.Object3D,
    mirrorRight: THREE.Object3D,
    needles: THREE.Object3D[],
    needleMat: THREE.MeshStandardMaterial,
  ) {
    this.sceneObject = sceneObject;
    this.root = root;
    this.yawRig = yawRig;
    this.pitchRig = pitchRig;
    this.rollRig = rollRig;
    this.wheels = wheels;
    this.steerPivot = steerPivot;
    this.doors = doors;
    this.mirrorCamLeft = mirrorLeft;
    this.mirrorCamRight = mirrorRight;
    this.needles = needles;
    this.needleMat = needleMat;
    this.steerRestZ = steerPivot.node.rotation.z;
  }

  get doorsOpenAmount(): number { return this.doorAmount; }

  setDoorsOpen(open: boolean): void { this.doorTarget = open ? 1 : 0; }

  setLook(yaw: number, pitch: number): void {
    this.yawRig.rotation.y = Number.isFinite(yaw) ? yaw : 0;
    this.pitchRig.rotation.x = THREE.MathUtils.clamp(
      Number.isFinite(pitch) ? pitch : 0,
      THREE.MathUtils.degToRad(-75),
      THREE.MathUtils.degToRad(75),
    );
  }

  updateFromPhysics(dt: number, rigidBody: RigidBody, steeringInput: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const t = rigidBody.translation(), q = rigidBody.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);

    const steer = THREE.MathUtils.clamp(Number.isFinite(steeringInput) ? steeringInput : 0, -1, 1);
    const steerAngle = -steer * MAX_FRONT_STEER_RAD;
    // Только передние колёса поворачиваются; руль и двери — отдельные pivot'ы.
    this.wheels[0].node.rotation.y = steerAngle;
    this.wheels[1].node.rotation.y = steerAngle;
    this.steerPivot.node.rotation.z = this.steerRestZ - steer * MAX_STEERING_WHEEL_RAD;

    const lv = rigidBody.linvel();
    this.velocity.set(lv.x, lv.y, lv.z);
    this.forward.set(0, 0, -1).applyQuaternion(this.root.quaternion).normalize();
    const signedSpeed = this.velocity.dot(this.forward);

    // Касание колеса должно быть неподвижно: при движении в -Z вращение
    // вокруг +X убывает (та же формула, что и в legacy-визуале).
    const delta = -(signedSpeed * dt) / WHEEL_RADIUS;
    for (const wheel of this.wheels) wheel.node.rotation.x += delta;

    const rollSpeed = THREE.MathUtils.clamp(this.velocity.length() / 10, 0, 1);
    this.cameraRoll = THREE.MathUtils.damp(
      this.cameraRoll, -steer * MAX_CAMERA_ROLL * rollSpeed,
      CAMERA_ROLL_DAMPING, Math.min(dt, 0.1),
    );
    this.rollRig.rotation.z = this.cameraRoll;

    // Стрелки: шкала 0..120 км/ч и 0..4000 об/мин.
    const kmh = Math.abs(this.velocity.length()) * 3.6;
    const speedTarget = -THREE.MathUtils.clamp(kmh / 120, 0, 1) * 4.1;
    const rpm = 700 + THREE.MathUtils.clamp(kmh / 80, 0, 1) * 1900 + Math.abs(steer) * 200;
    const rpmTarget = -THREE.MathUtils.clamp(rpm / 4000, 0, 1) * 4.1;
    const animDt = Math.min(dt, 0.1);
    this.speedNeedleAngle = THREE.MathUtils.damp(this.speedNeedleAngle, speedTarget, 10, animDt);
    this.rpmNeedleAngle = THREE.MathUtils.damp(this.rpmNeedleAngle, rpmTarget, 10, animDt);
    this.needles[0].rotation.z = this.speedNeedleAngle;
    this.needles[1].rotation.z = this.rpmNeedleAngle;
    const night = this.root.parent?.userData.isNight === true ? 1 : 0;
    this.dashGlow = THREE.MathUtils.damp(this.dashGlow, night, 4, animDt);
    this.needleMat.emissiveIntensity = 0.2 + this.dashGlow * 0.7;

    this.doorAmount = THREE.MathUtils.damp(this.doorAmount, this.doorTarget, DOOR_DAMPING, Math.min(dt, 0.1));
    // Двери: передняя двойная расходится, средняя/задняя уезжают в карман.
    const d = this.doorAmount;
    this.doors[0].node.position.z = this.doors[0].rest.z - DOOR_TRAVEL * d;
    this.doors[1].node.position.z = this.doors[1].rest.z + DOOR_TRAVEL * d;
    this.doors[2].node.position.z = this.doors[2].rest.z + DOOR_TRAVEL * d;
    this.doors[3].node.position.z = this.doors[3].rest.z - DOOR_TRAVEL * d;
  }

  removeFromScene(): void {
    this.sceneObject.removeFromParent();
  }
}
