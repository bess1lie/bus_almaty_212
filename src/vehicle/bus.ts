/**
 * bus.ts — автобус: стабильная аркадная физика + визуальная GLTF-модель.
 * Плавный разгон, инерция руля, визуальный крен, FOV-эффект.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getRapier, getPhysicsWorld } from '../core/rapier';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { InputState } from '../core/input';
import { createBusVisual, type BusVisualLike } from './bus-visual';
import { createModernBusVisual, type ModernBusLivery } from './bus-visual-modern';

const BUS_LENGTH = 12;
const BUS_WIDTH = 2.5;
const BODY_H = 3.05;
const BODY_HALF = BODY_H / 2;

const MAX_SPEED = 25;      // м/с (~90 км/ч)
const REVERSE_MAX = 7;     // м/с (~25 км/ч)
const MAX_STEER = 0.48;    // рад (~27°)

// Тяжёлый автобус (по аудиту симуляторов)
const REVERSE_ACCEL = 1.4;
const HANDBRAKE_DECEL = 6.5;
const COAST_DRAG = 0.35;
const WHEELBASE = 6.2;

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

// Старт: реальная дорога primary (w=13) в 2.3 км юго-западнее центра.
// Точка взята из полилинии OSM road; тангент direction=(+0.1053,-0.9944).
// В конусе 200 м вперёд нет зданий выше 33 м, по бокам — застройка.
const START_X = 188.4;
const START_Z = 0.4;
const START_YAW = -0.1054; // тангенс дороги (+0.1053,-0.9944): forward -Z → yaw=-atan(0.1053)

export type CameraMode = 'driver' | 'chase';
export type DriveMode = 'arcade' | 'sim';

interface DriveTuning {
  accel: number;
  gasTau: number;
  brake: number;
  steerTau: number;
  yawRate: number;
  brakeFade: number;
}

const TUNING: Record<DriveMode, DriveTuning> = {
  arcade: { accel: 3.2, gasTau: 0.16, brake: 4.8, steerTau: 0.13, yawRate: 0.78, brakeFade: 0.05 },
  sim: { accel: 2.2, gasTau: 0.32, brake: 3.4, steerTau: 0.22, yawRate: 0.66, brakeFade: 0.12 },
};

export class Bus {
  readonly body: RigidBody;
  private readonly scene: THREE.Scene;
  private readonly rapi: typeof RAPIER;

  private visual: BusVisualLike | null = null;
  private fallback: THREE.Group | null = null;
  private fallbackWheels: THREE.Mesh[] = [];

  private cameraMode: CameraMode = 'driver';
  private driveMode: DriveMode = 'arcade';
  private camera: THREE.PerspectiveCamera;
  doorsOpen = false;

  private speed = 0;         // м/с, со знаком
  private steer = 0;         // текущий угол руля
  private throttleActual = 0;
  private brakeActual = 0;
  private brakeHeat = 0;
  private yawRate = 0;
  private ridePhase = 0;
  private rideHeave = 0;
  private readonly forwardTmp = new THREE.Vector3();
  private readonly planarVelocity = new THREE.Vector3();
  private readonly lateralVelocity = new THREE.Vector3();
  private visualRoll = 0;    // визуальный крен
  private visualPitch = 0;   // визуальный наклон при торможении
  private lookYaw = 0;
  private lookPitch = 0;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.rapi = getRapier();
    const RAPIER = this.rapi;
    const world = getPhysicsWorld();

    // Физическое тело: только поворот вокруг Y, без крена (стабильно)
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(0.0)
      .setAngularDamping(0.8)
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);

    // GLB вытянут по Z: длина 12 м — ось Z, ширина 2.5 м — ось X.
    const colliderDesc = RAPIER.ColliderDesc.cuboid(BUS_WIDTH / 2, BODY_HALF, BUS_LENGTH / 2);
    colliderDesc.setMass(12000);
    colliderDesc.setFriction(0.5);
    world.createCollider(colliderDesc, this.body);

    // Старт на реальной улице с открытым видом вперёд
    this.body.setTranslation({ x: START_X, y: BODY_HALF + 0.02, z: START_Z }, true);
    this.body.setRotation(
      { x: 0, y: Math.sin(START_YAW / 2), z: 0, w: Math.cos(START_YAW / 2) },
      true,
    );
    this.body.setEnabledTranslations(true, false, true, true); // Y зафиксирован

    this.buildFallback();
  }

  async loadModel(
    modelUrl: string,
    cam: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    fallbackUrl: string,
    livery: ModernBusLivery = 'golden_hour',
  ): Promise<boolean> {
    // Основная модель — CC0 автобус Tevy. Старый GLB остаётся fallback-ом.
    try {
      this.visual = await createModernBusVisual(this.scene, cam, modelUrl, { renderer, livery });
    } catch (err) {
      console.warn('[bus] современный GLB не загружен, пробуем legacy.', err);
      try {
        this.visual = await createBusVisual(this.scene, cam, fallbackUrl, { enableShadows: true });
      } catch (legacyErr) {
        console.warn('[bus] GLB не загружен, fallback на примитивы.', legacyErr);
        this.visual = null;
        return false;
      }
    }
    if (this.fallback) {
      this.scene.remove(this.fallback);
      this.disposeObject(this.fallback);
      this.fallback = null;
    }
    return true;
  }

  private buildFallback() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(BUS_WIDTH, BODY_H, BUS_LENGTH),
      new THREE.MeshStandardMaterial({ color: 0x1a5f7a })
    );
    body.position.y = 0;
    group.add(body);
    const wg = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12);
    wg.rotateZ(Math.PI / 2);
    const wm = new THREE.MeshStandardMaterial({ color: 0x111 });
    const positions: [number, number][] = [
      [-BUS_WIDTH / 2, -4.4], [BUS_WIDTH / 2, -4.4],
      [-BUS_WIDTH / 2, 4.4], [BUS_WIDTH / 2, 4.4],
    ];
    for (const [x, z] of positions) {
      const w = new THREE.Mesh(wg, wm);
      w.position.set(x, -BODY_HALF + 0.55, z);
      group.add(w);
      this.fallbackWheels.push(w);
    }
    this.fallback = group;
    this.scene.add(group);
  }

  setCameraMode(mode: CameraMode) { this.cameraMode = mode; }
  getCameraMode(): CameraMode { return this.cameraMode; }
  setDriveMode(mode: DriveMode) { this.driveMode = mode; }
  getDriveMode(): DriveMode { return this.driveMode; }
  toggleDoors() {
    this.doorsOpen = !this.doorsOpen;
    this.visual?.setDoorsOpen(this.doorsOpen);
  }
  setLook(yaw: number, pitch: number) {
    this.lookYaw = yaw;
    this.lookPitch = pitch;
    this.visual?.setLook(yaw, pitch);
  }

  /** ДО world.step(), фиксированный шаг. Тяжёлая аркадная динамика. */
  update(dt: number, input: Readonly<InputState>) {
    const clamp = THREE.MathUtils.clamp;
    const T = TUNING[this.driveMode];

    // 1. Плавный отклик газа (при открытых дверях тяга заблокирована)
    const gasTarget = this.doorsOpen ? 0 : clamp(input.throttle, -1, 1);
    const gasTau = Math.abs(gasTarget) > Math.abs(this.throttleActual) ? T.gasTau : T.gasTau * 0.6;
    this.throttleActual = THREE.MathUtils.damp(this.throttleActual, gasTarget, 1 / gasTau, dt);

    // 2. Плавное нарастание тормозного усилия
    const brakeTarget = input.handbrake ? 1 : clamp(input.brake, 0, 1);
    this.brakeActual = THREE.MathUtils.damp(this.brakeActual, brakeTarget, 8, dt);
    const speed01 = clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);

    // 3. Нагрев тормозов и brake fade
    this.brakeHeat = clamp(
      this.brakeHeat + this.brakeActual * speed01 * dt * 0.10 - this.brakeHeat * dt * 0.06,
      0, 1
    );
    const brakeFade = 1 - T.brakeFade * clamp((this.brakeHeat - 0.25) / 0.75, 0, 1);

    // 4. Изменение скорости
    if (this.brakeActual > 0.01) {
      const dec = (input.handbrake ? HANDBRAKE_DECEL : T.brake) * this.brakeActual * brakeFade;
      this.speed = moveTowards(this.speed, 0, dec * dt);
    } else if (Math.abs(this.throttleActual) > 0.02) {
      if (this.speed * this.throttleActual < 0 && Math.abs(this.speed) > 0.3) {
        // нельзя мгновенно переключить передний ход на задний
        this.speed = moveTowards(this.speed, 0, 1.4 * dt);
      } else {
        const torqueFactor = clamp(1 - 0.40 * Math.pow(speed01, 1.4), 0.60, 1);
        const peak = this.throttleActual < 0 ? REVERSE_ACCEL : T.accel;
        this.speed += this.throttleActual * peak * torqueFactor * dt;
        this.speed = clamp(this.speed, -REVERSE_MAX, MAX_SPEED);
      }
    } else {
      this.speed = moveTowards(this.speed, 0, (COAST_DRAG + speed01 * 0.12) * dt);
    }

    // 5. Инерция руля
    const speedFactor = Math.max(0.34, 1 - speed01 * 0.65);
    this.steer = THREE.MathUtils.damp(
      this.steer, input.steering * MAX_STEER * speedFactor, 1 / T.steerTau, dt
    );

    // 6. Направление: кинематика поворота с ограничением yaw rate
    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    this.forwardTmp.set(0, 0, -1).applyQuaternion(q);
    this.forwardTmp.y = 0;
    this.forwardTmp.normalize();

    const targetYawRate = clamp(
      -this.speed / WHEELBASE * Math.tan(this.steer), -T.yawRate, T.yawRate
    );
    this.yawRate = THREE.MathUtils.damp(this.yawRate, targetYawRate, 4.5, dt);
    this.body.setAngvel({ x: 0, y: this.yawRate, z: 0 }, true);

    // 7. Частично сохраняем боковую скорость (инерция кузова)
    const vel = this.body.linvel();
    this.planarVelocity.set(vel.x, 0, vel.z);
    const forwardSpeed = this.planarVelocity.dot(this.forwardTmp);
    this.lateralVelocity.copy(this.planarVelocity)
      .addScaledVector(this.forwardTmp, -forwardSpeed)
      .multiplyScalar(Math.exp(-dt * 5.0));
    this.planarVelocity.copy(this.forwardTmp).multiplyScalar(this.speed).add(this.lateralVelocity);
    this.body.setLinvel({ x: this.planarVelocity.x, y: 0, z: this.planarVelocity.z }, true);

    // 8. Реакция тяжёлого кузова
    const lateralAccel = this.speed * this.yawRate;
    const targetRoll = clamp(-Math.atan2(lateralAccel, 9.81) * 0.18, -0.045, 0.045);
    const targetPitch = clamp(
      -this.brakeActual * 0.028 + Math.max(0, this.throttleActual) * 0.012, -0.03, 0.018
    );
    this.visualRoll = THREE.MathUtils.damp(this.visualRoll, targetRoll, 3, dt);
    this.visualPitch = THREE.MathUtils.damp(this.visualPitch, targetPitch, 2.5, dt);

    // 9. Низкочастотная вибрация кузова
    this.ridePhase += dt * (2.2 + speed01 * 4.5);
    this.rideHeave = Math.sin(this.ridePhase) * (0.002 + speed01 * 0.004)
      + Math.sin(this.ridePhase * 2.7) * 0.001;
  }

  /** ПОСЛЕ world.step(). */
  syncVisual(dt: number, steering: number, chaseCam: THREE.PerspectiveCamera) {
    const pos = this.body.translation();
    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);

    // Визуальный наклон поверх физического поворота
    const tilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.visualPitch, 0, this.visualRoll, 'YXZ')
    );
    const visualQ = q.clone().multiply(tilt);

    if (this.visual) {
      this.visual.updateFromPhysics(dt, this.body, this.steer / MAX_STEER);
      this.visual.root.position.y += this.rideHeave;
      // В driver mode крен кузова НЕ применяем — иначе камера внутри получает двойной крен
      if (this.cameraMode !== 'driver') this.visual.root.quaternion.copy(visualQ);
    } else if (this.fallback) {
      this.fallback.position.set(pos.x, pos.y + this.rideHeave, pos.z);
      this.fallback.quaternion.copy(visualQ);
      const spin = (this.speed / 0.55) * dt;
      for (const w of this.fallbackWheels) w.rotation.x += spin;
    }

    // Кабина: фиксированный FOV 65° без искажения приборной панели
    if (this.cameraMode === 'driver' && this.camera.fov !== 65) {
      this.camera.fov = 65;
      this.camera.updateProjectionMatrix();
    }

    if (this.cameraMode === 'chase') {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      forward.y = 0;
      forward.normalize();
      const camPos = new THREE.Vector3(pos.x - forward.x * 18, pos.y + 7, pos.z - forward.z * 18);
      chaseCam.position.lerp(camPos, Math.min(1, dt * 5));
      chaseCam.lookAt(pos.x, pos.y + 1.5, pos.z);
    }
  }

  getPosition(): THREE.Vector3 {
    const p = this.body.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }
  getSpeedKmh(): number { return Math.abs(this.speed) * 3.6; }
  getGear(): string { return this.speed < -0.2 ? 'R' : 'D'; }
  getLinearVelocity(): THREE.Vector3 {
    const v = this.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }
  getForward(): THREE.Vector3 {
    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    f.y = 0;
    return f.normalize();
  }

  dispose() {
    this.visual?.removeFromScene();
    if (this.fallback) {
      this.scene.remove(this.fallback);
      this.disposeObject(this.fallback);
    }
    getPhysicsWorld().removeRigidBody(this.body);
  }

  private disposeObject(obj: THREE.Object3D) {
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
}
