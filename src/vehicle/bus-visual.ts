import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { RigidBody } from '@dimforge/rapier3d-compat';

const WHEEL_RADIUS = 0.425;
const MAX_FRONT_STEER_RAD = 0.50;
const MAX_STEERING_WHEEL_RAD = 1.35; // ~77° в каждую сторону, реалистичный упор руля
const DOOR_TRAVEL = 0.30;
const DOOR_DAMPING = 8.0;

// Камера водителя относительно camera_driver.
// Чуть выше и дальше назад: приборы уходят в нижнюю треть, а лобовое стекло
// открывает больше дороги. Предел по Z — спинка сиденья (z=-3.76).
const CAMERA_MOUNT_Y = -0.32; // чуть выше — козырёк/потолок меньше забирает верх кадра
const CAMERA_MOUNT_Z = 0.55;

// Положение руля относительно bus_root (приподнят, чтобы оставаться в кадре).

// Лёгкий наклон камеры при поворотах.
const MAX_CAMERA_ROLL = THREE.MathUtils.degToRad(2);
const CAMERA_ROLL_DAMPING = 7.5;

export type BusVisualOptions = {
  /** Включает тени на всех Mesh. Для мобильной версии отключайте при необходимости. */
  enableShadows?: boolean;
  /** Радиус отсечения камеры после её установки в кабину. */
  cameraFar?: number;
};

type WheelBinding = {
  pivot: THREE.Object3D;
  spin: THREE.Object3D;
  steerable: boolean;
};

type DoorLeafBinding = {
  object: THREE.Object3D;
  restPosition: THREE.Vector3;
  restQuaternion: THREE.Quaternion;
  direction: -1 | 1;
};

function requiredObject(root: THREE.Object3D, name: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (!object) {
    throw new Error(`[bus_almaty_212] В GLB отсутствует объект "${name}"`);
  }
  return object;
}

/** Per-material tuning of the GLB bus (according to the art audit palette). */
function tuneBusMaterials(root: THREE.Object3D): void {
  const seen = new Set<THREE.Material>();
  const paint = (m: THREE.MeshStandardMaterial, color: string, r: number, metal: number) => {
    m.color.set(color); m.roughness = r; m.metalness = metal;
  };
  const glow = (m: THREE.MeshStandardMaterial, color: string, intensity: number) => {
    m.emissive.set(color); m.emissiveIntensity = intensity;
  };
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const src of mats) {
      if (seen.has(src)) continue;
      seen.add(src);
      if (!(src instanceof THREE.MeshStandardMaterial)) continue;
      const m = src;
      switch (m.name) {
        case 'mat_body': paint(m, '#EFEBDD', 0.48, 0.05); break;
        case 'mat_livery_lower':
        case 'mat_livery_skirt': paint(m, '#267B73', 0.38, 0.08); break;
        case 'mat_livery_stripe': paint(m, '#55C4B6', 0.4, 0.05); break;
        case 'mat_glass': paint(m, '#527783', 0.16, 0.08); m.opacity = 0.4; m.transparent = true; m.depthWrite = false; break;
        case 'mat_trim': paint(m, '#405961', 0.4, 0.2); break;
        case 'mat_dark': paint(m, '#20282D', 0.8, 0.02); break;
        case 'mat_light': paint(m, '#FFF0C9', 0.22, 0); glow(m, '#FFE3A8', 1.3); break;
        case 'mat_amber': paint(m, '#F39B42', 0.3, 0); glow(m, '#FF9B43', 0.8); break;
        case 'mat_red': paint(m, '#D84740', 0.3, 0); glow(m, '#FF332B', 0.6); break;
        case 'mat_wheel': paint(m, '#171B20', 0.97, 0); break;
        case 'mat_rim': paint(m, '#8B9996', 0.32, 0.3); break;
        case 'mat_mirror': paint(m, '#AABFC0', 0.25, 0.25); break;
        case 'mat_display': paint(m, '#55C4B6', 0.25, 0); glow(m, '#36CBB3', 1.0); break;
        case 'mat_interior': paint(m, '#303C3A', 0.85, 0); break;
        case 'mat_seat': paint(m, '#24665D', 0.9, 0); break;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * Загружает автобус, устанавливает камеру на camera_driver и подготавливает
 * pivots колёс и дверей. Оси GLB: Y вверх, перед автобуса направлен по -Z.
 */
export async function createBusVisual(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  modelUrl: string,
  options: BusVisualOptions = {},
): Promise<BusVisual> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelUrl);
  tuneBusMaterials(gltf.scene);
  const busRoot = requiredObject(gltf.scene, 'bus_root');
  const cameraDriver = requiredObject(busRoot, 'camera_driver');

  const dashboardMaterials: THREE.Material[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // Реальные shadow map в сцене не используются (castShadow=false у солнца,
    // тени — дешёвые transparent-плоскости). Лишние shadow pass только добавляют
    // draw calls. Оставляем visibile/frustum culling.
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = true;

    // Приборная панель и валидатор подсвечиваются ночью
    if (/speedometer|tachometer|validator|instrument|route_display/i.test(object.name)) {
      const mats = Array.isArray(object.material) ? object.material : [object.material];
      for (const m of mats) {
        if (!dashboardMaterials.includes(m)) dashboardMaterials.push(m);
      }
    }

    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    for (const material of materials) {
      if (material.transparent) {
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
      }
    }
  });

  const yawRig = new THREE.Group();
  yawRig.name = 'camera_yaw_rig';
  const pitchRig = new THREE.Group();
  pitchRig.name = 'camera_pitch_rig';
  const cameraMount = new THREE.Group();
  cameraMount.name = 'camera_mount';
  cameraMount.position.set(0, CAMERA_MOUNT_Y, CAMERA_MOUNT_Z);
  const rollRig = new THREE.Group();
  rollRig.name = 'camera_roll_rig';

  camera.removeFromParent();
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  camera.near = 0.05;
  camera.far = options.cameraFar ?? 3500; // горы на ~2600 м, небо на 2500 м
  camera.updateProjectionMatrix();

  cameraDriver.add(yawRig);
  yawRig.add(pitchRig);
  pitchRig.add(cameraMount);
  cameraMount.add(rollRig);
  rollRig.add(camera);

  scene.add(gltf.scene);

  try {
    const visual = new BusVisual(gltf.scene, busRoot, yawRig, pitchRig, rollRig);
    visual.setDashboardMaterials(dashboardMaterials);
    scene.userData.busRoot = busRoot;
    scene.userData.busPosition = busRoot.position;
    scene.userData.busQuaternion = busRoot.quaternion;
    return visual;
  } catch (error) {
    gltf.scene.removeFromParent();
    camera.removeFromParent();
    throw error;
  }
}

export class BusVisual {
  readonly sceneObject: THREE.Group;
  readonly root: THREE.Object3D;
  readonly mirrorCamLeft: THREE.Object3D;
  readonly mirrorCamRight: THREE.Object3D;
  readonly doorHingeLeft: THREE.Object3D;
  readonly doorHingeRight: THREE.Object3D;

  private readonly yawRig: THREE.Group;
  private readonly pitchRig: THREE.Group;
  private readonly rollRig: THREE.Group;
  private cameraRoll = 0;
  private dashboardMaterials: THREE.Material[] = [];
  private readonly steeringWheel: THREE.Object3D;
  private readonly speedNeedle: THREE.Object3D | null;
  private readonly tachNeedle: THREE.Object3D | null;
  private speedNeedleRest = 0;
  private tachNeedleRest = 0;
  private speedNeedleAngle = 0;
  private tachNeedleAngle = 0;
  private dashboardGlow = 0;
  private readonly wheels: WheelBinding[];
  private readonly doorLeaves: DoorLeafBinding[];
  private doorOpenAmount = 0;
  private doorOpenTarget = 0;
  private readonly steeringWheelRestZ: number;
  private readonly forward = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();

  constructor(
    sceneObject: THREE.Group,
    root: THREE.Object3D,
    yawRig: THREE.Group,
    pitchRig: THREE.Group,
    rollRig: THREE.Group,
  ) {
    this.sceneObject = sceneObject;
    this.root = root;
    this.yawRig = yawRig;
    this.pitchRig = pitchRig;
    this.rollRig = rollRig;

    this.steeringWheel = requiredObject(root, 'steering_wheel');
    // Сохраняем авторский трансформ GLB без принудительного смещения.
    // MAP: исходно руль на (-0.62, -0.39, -4.82) и это правильно для посадки.
    this.steeringWheelRestZ = this.steeringWheel.rotation.z;
    // Стрелки приборов (опционально — если модель их содержит)
    this.speedNeedle = root.getObjectByName('speedometer_needle') ?? null;
    this.tachNeedle = root.getObjectByName('tachometer_needle') ?? null;
    this.speedNeedleRest = this.speedNeedle?.rotation.z ?? 0;
    this.tachNeedleRest = this.tachNeedle?.rotation.z ?? 0;
    this.speedNeedleAngle = this.speedNeedleRest;
    this.tachNeedleAngle = this.tachNeedleRest;
    this.mirrorCamLeft = requiredObject(root, 'mirror_cam_left');
    this.mirrorCamRight = requiredObject(root, 'mirror_cam_right');
    this.doorHingeLeft = requiredObject(root, 'door_hinge_left');
    this.doorHingeRight = requiredObject(root, 'door_hinge_right');

    this.wheels = [
      {
        pivot: requiredObject(root, 'wheel_fl'),
        spin: requiredObject(root, 'wheel_spin_front_left'),
        steerable: true,
      },
      {
        pivot: requiredObject(root, 'wheel_fr'),
        spin: requiredObject(root, 'wheel_spin_front_right'),
        steerable: true,
      },
      {
        pivot: requiredObject(root, 'wheel_rl'),
        spin: requiredObject(root, 'wheel_spin_rear_left'),
        steerable: false,
      },
      {
        pivot: requiredObject(root, 'wheel_rr'),
        spin: requiredObject(root, 'wheel_spin_rear_right'),
        steerable: false,
      },
    ];

    // Пассажирские двери — только справа (со стороны тротуара, Алматы).
    // Левые створки удалены из GLB: на их месте цельная боковина с окном.
    const doorDefinitions: Array<{ name: string; direction: -1 | 1 }> = [
      { name: 'door_right_front_1', direction: -1 },
      { name: 'door_right_rear_1', direction: 1 },
      { name: 'door_right_front_2', direction: -1 },
      { name: 'door_right_rear_2', direction: 1 },
    ];

    this.doorLeaves = doorDefinitions.map(({ name, direction }) => {
      const object = requiredObject(root, name);
      return {
        object,
        restPosition: object.position.clone(),
        restQuaternion: object.quaternion.clone(),
        direction,
      };
    });

    // Проверка групп при загрузке. Ошибки структуры обнаруживаются сразу,
    // а не после начала игровой сессии.
    const requiredGroups = [
      'body', 'windows',
      'wheels_front_left', 'wheels_front_right',
      'wheels_rear_left', 'wheels_rear_right',
      'mirrors_left', 'mirrors_right',
      'doors_left', 'doors_right', 'interior',
      'dashboard', 'driver_seat', 'validators', 'sunvisor', 'handrails',
    ];
    for (const name of requiredGroups) requiredObject(root, name);
  }

  /** yaw и pitch в радианах. Нулевое направление взгляда — вперёд, по -Z. */
  setDashboardMaterials(materials: THREE.Material[]): void {
    this.dashboardMaterials = materials;
  }

  setLook(yaw: number, pitch: number): void {
    this.yawRig.rotation.y = Number.isFinite(yaw) ? yaw : 0;
    this.pitchRig.rotation.x = THREE.MathUtils.clamp(
      Number.isFinite(pitch) ? pitch : 0,
      THREE.MathUtils.degToRad(-75),
      THREE.MathUtils.degToRad(75),
    );
  }

  /** true открывает все три пары створок, false закрывает. */
  setDoorsOpen(open: boolean): void {
    this.doorOpenTarget = open ? 1 : 0;
  }

  /** Текущее значение открытия дверей от 0 до 1. */
  get doorsOpenAmount(): number {
    return this.doorOpenAmount;
  }

  /**
   * Вызывать один раз за render-frame после выполнения всех world.step().
   * steeringInput: -1 = влево, 0 = прямо, +1 = вправо.
   * dt: render delta в секундах, не фиксированный Rapier timestep.
   */
  updateFromPhysics(
    dt: number,
    rigidBody: RigidBody,
    steeringInput: number,
  ): void {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const translation = rigidBody.translation();
    const rotation = rigidBody.rotation();

    // bus_root находится в центре масс. Масштаб визуальной модели всегда 1.
    this.root.position.set(translation.x, translation.y, translation.z);
    this.root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    const steer = THREE.MathUtils.clamp(
      Number.isFinite(steeringInput) ? steeringInput : 0,
      -1,
      1,
    );

    // Локальный forward = -Z. Положительный input означает поворот направо,
    // поэтому угол поворота вокруг +Y должен быть отрицательным.
    const frontSteerAngle = -steer * MAX_FRONT_STEER_RAD;
    for (const wheel of this.wheels) {
      if (wheel.steerable) wheel.pivot.rotation.y = frontSteerAngle;
    }

    // Знак минус нужен из-за направления оси колёс +X и движения автобуса -Z.
    const linearVelocity = rigidBody.linvel();
    this.velocity.set(linearVelocity.x, linearVelocity.y, linearVelocity.z);
    this.forward
      .set(0, 0, -1)
      .applyQuaternion(this.root.quaternion)
      .normalize();

    const signedForwardSpeed = this.velocity.dot(this.forward);

    // Наклон камеры зависит от скорости и поворота.
    const rollSpeedFactor = THREE.MathUtils.clamp(this.velocity.length() / 10, 0, 1);
    const targetRoll = -steer * MAX_CAMERA_ROLL * rollSpeedFactor;
    this.cameraRoll = THREE.MathUtils.damp(
      this.cameraRoll, targetRoll, CAMERA_ROLL_DAMPING, Math.min(dt, 0.1)
    );
    this.rollRig.rotation.z = this.cameraRoll;

    const wheelDelta = -(signedForwardSpeed * dt) / WHEEL_RADIUS;
    for (const wheel of this.wheels) {
      wheel.spin.rotation.x += wheelDelta;
    }

    this.steeringWheel.rotation.z =
      this.steeringWheelRestZ - steer * MAX_STEERING_WHEEL_RAD;

    const animationDt = Math.min(dt, 0.1);

    // Анимация стрелок по аудиту: шкала 0..120 км/ч, плавный damp
    const kmh = Math.abs(this.velocity.length()) * 3.6;
    const speedRatio = THREE.MathUtils.clamp(kmh / 120, 0, 1);
    const speedTarget = this.speedNeedleRest - speedRatio * 4.1;
    this.speedNeedleAngle = THREE.MathUtils.damp(this.speedNeedleAngle, speedTarget, 10, animationDt);
    if (this.speedNeedle) this.speedNeedle.rotation.z = this.speedNeedleAngle;

    const rpm = 700 + THREE.MathUtils.clamp(kmh / 80, 0, 1) * 1900 + Math.abs(steer) * 200;
    const rpmRatio = THREE.MathUtils.clamp(rpm / 4000, 0, 1);
    const tachTarget = this.tachNeedleRest - rpmRatio * 4.1;
    this.tachNeedleAngle = THREE.MathUtils.damp(this.tachNeedleAngle, tachTarget, 10, animationDt);
    if (this.tachNeedle) this.tachNeedle.rotation.z = this.tachNeedleAngle;

    // Ночью подсвечиваем приборы тёплым светом (плавно)
    const night = this.sceneObject.parent?.userData.isNight === true ? 1 : 0;
    this.dashboardGlow = THREE.MathUtils.damp(this.dashboardGlow, night, 4, animationDt);
    for (const m of this.dashboardMaterials) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.emissive) {
        sm.emissive.setHex(0x9c352c);
        sm.emissiveIntensity = this.dashboardGlow * 0.32;
      }
    }

    this.doorOpenAmount = THREE.MathUtils.damp(
      this.doorOpenAmount,
      this.doorOpenTarget,
      DOOR_DAMPING,
      animationDt,
    );

    for (const leaf of this.doorLeaves) {
      leaf.object.position.copy(leaf.restPosition);
      leaf.object.quaternion.copy(leaf.restQuaternion);
      leaf.object.position.z += leaf.direction * DOOR_TRAVEL * this.doorOpenAmount;
    }
  }

  /** Удаляет модель из сцены. Геометрию/материалы освобождайте при полном закрытии игры. */
  removeFromScene(): void {
    const parent = this.sceneObject.parent;
    if (parent && parent.userData.busRoot === this.root) {
      delete parent.userData.busRoot;
      delete parent.userData.busPosition;
      delete parent.userData.busQuaternion;
    }
    this.sceneObject.removeFromParent();
  }
}

/**
 * Создаёт камеры для зеркал. RenderTarget и вывод текстур на поверхности
 * зеркал подключаются в основном рендерере игры.
 */
export function createMirrorCameras(
  busVisual: BusVisual,
  aspect = 16 / 9,
): { left: THREE.PerspectiveCamera; right: THREE.PerspectiveCamera } {
  const left = new THREE.PerspectiveCamera(58, aspect, 0.05, 100);
  const right = new THREE.PerspectiveCamera(58, aspect, 0.05, 100);

  busVisual.mirrorCamLeft.add(left);
  busVisual.mirrorCamRight.add(right);

  // Левая камера смотрит назад-влево, правая — назад-вправо.
  left.rotation.y = THREE.MathUtils.degToRad(150);
  right.rotation.y = THREE.MathUtils.degToRad(-150);

  return { left, right };
}
