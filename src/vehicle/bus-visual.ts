import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { RigidBody } from '@dimforge/rapier3d-compat';

const WHEEL_RADIUS = 0.425;
const MAX_FRONT_STEER_RAD = 0.50;
const MAX_STEERING_WHEEL_RAD = 2.45;
const DOOR_TRAVEL = 0.30;
const DOOR_DAMPING = 8.0;

// Камера водителя относительно camera_driver.
// Чуть выше и дальше назад: приборы уходят в нижнюю треть, а лобовое стекло
// открывает больше дороги. Предел по Z — спинка сиденья (z=-3.76).
const CAMERA_MOUNT_Y = -0.42;
const CAMERA_MOUNT_Z = 0.55;

// Положение руля относительно bus_root (приподнят, чтобы оставаться в кадре).
const STEERING_WHEEL_TARGET_Y = -0.05;
const STEERING_WHEEL_SCALE = 0.82;

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
  baseZ: number;
  direction: -1 | 1;
};

function requiredObject(root: THREE.Object3D, name: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (!object) {
    throw new Error(`[bus_almaty_212] В GLB отсутствует объект "${name}"`);
  }
  return object;
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
  const busRoot = requiredObject(gltf.scene, 'bus_root');
  const cameraDriver = requiredObject(busRoot, 'camera_driver');

  const enableShadows = options.enableShadows ?? true;
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = enableShadows;
    object.receiveShadow = enableShadows;

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
  camera.near = 0.04;
  camera.far = options.cameraFar ?? 500;
  camera.updateProjectionMatrix();

  cameraDriver.add(yawRig);
  yawRig.add(pitchRig);
  pitchRig.add(cameraMount);
  cameraMount.add(rollRig);
  rollRig.add(camera);

  scene.add(gltf.scene);

  try {
    const visual = new BusVisual(gltf.scene, busRoot, yawRig, pitchRig, rollRig);
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
  private readonly steeringWheel: THREE.Object3D;
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
    // Координата задаётся непосредственно в локальной системе bus_root.
    this.steeringWheel.position.y = STEERING_WHEEL_TARGET_Y;
    this.steeringWheel.scale.setScalar(STEERING_WHEEL_SCALE);
    this.steeringWheelRestZ = this.steeringWheel.rotation.z;
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

    const doorDefinitions: Array<{ name: string; direction: -1 | 1 }> = [
      { name: 'door_left_front_1', direction: -1 },
      { name: 'door_left_rear_1', direction: 1 },
      { name: 'door_right_front_1', direction: -1 },
      { name: 'door_right_rear_1', direction: 1 },
      { name: 'door_right_front_2', direction: -1 },
      { name: 'door_right_rear_2', direction: 1 },
    ];

    this.doorLeaves = doorDefinitions.map(({ name, direction }) => {
      const object = requiredObject(root, name);
      return { object, baseZ: object.position.z, direction };
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
    this.doorOpenAmount = THREE.MathUtils.damp(
      this.doorOpenAmount,
      this.doorOpenTarget,
      DOOR_DAMPING,
      animationDt,
    );

    for (const leaf of this.doorLeaves) {
      leaf.object.position.z =
        leaf.baseZ + leaf.direction * DOOR_TRAVEL * this.doorOpenAmount;
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
