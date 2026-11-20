/**
 * bus.ts — автобус: стабильная аркадная физика + визуальная GLTF-модель.
 * Плавный разгон, инерция руля, визуальный крен, FOV-эффект.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getRapier, getPhysicsWorld } from '../core/rapier';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { InputState } from '../core/input';
import { createBusVisual, BusVisual } from './bus-visual';

const BUS_LENGTH = 12;
const BUS_WIDTH = 2.5;
const BODY_H = 3.05;
const BODY_HALF = BODY_H / 2;

const MAX_SPEED = 22;      // м/с (~80 км/ч)
const ACCEL = 4.5;         // м/с² — плавный разгон
const BRAKE = 9;           // м/с²
const REVERSE_MAX = 6;     // м/с (~22 км/ч)
const DRAG = 1.4;          // сопротивление
const MAX_STEER = 0.42;    // рад (~24°)

export type CameraMode = 'driver' | 'chase';

export class Bus {
  readonly body: RigidBody;
  private readonly scene: THREE.Scene;
  private readonly rapi: typeof RAPIER;

  private visual: BusVisual | null = null;
  private fallback: THREE.Group | null = null;
  private fallbackWheels: THREE.Mesh[] = [];

  private cameraMode: CameraMode = 'driver';
  private camera: THREE.PerspectiveCamera;
  doorsOpen = false;

  private speed = 0;         // м/с, со знаком
  private steer = 0;         // текущий угол руля
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
      .setAngularDamping(4.0)
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(BUS_LENGTH / 2, BODY_HALF, BUS_WIDTH / 2);
    colliderDesc.setMass(12000);
    colliderDesc.setFriction(0.5);
    world.createCollider(colliderDesc, this.body);

    this.body.setTranslation({ x: 0, y: BODY_HALF + 0.02, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setEnabledTranslations(true, false, true, true); // Y зафиксирован

    this.buildFallback();
  }

  async loadModel(modelUrl: string, cam: THREE.PerspectiveCamera): Promise<boolean> {
    try {
      this.visual = await createBusVisual(this.scene, cam, modelUrl, { enableShadows: true });
      if (this.fallback) {
        this.scene.remove(this.fallback);
        this.disposeObject(this.fallback);
        this.fallback = null;
      }
      return true;
    } catch (err) {
      console.warn('[bus] GLB не загружен, fallback.', err);
      this.visual = null;
      return false;
    }
  }

  private buildFallback() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(BUS_LENGTH, BODY_H, BUS_WIDTH),
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
  toggleDoors() {
    this.doorsOpen = !this.doorsOpen;
    this.visual?.setDoorsOpen(this.doorsOpen);
  }
  setLook(yaw: number, pitch: number) {
    this.lookYaw = yaw;
    this.lookPitch = pitch;
    this.visual?.setLook(yaw, pitch);
  }

  /** ДО world.step(), фиксированный шаг. */
  update(dt: number, input: Readonly<InputState>) {
    // --- Скорость с плавной инерцией ---
    const braking = input.brake > 0 || input.handbrake;
    if (braking) {
      const dec = input.handbrake ? BRAKE * 1.8 : BRAKE;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - dec * dt);
      if (this.speed < 0) this.speed = Math.min(0, this.speed + dec * dt);
    } else if (input.throttle > 0) {
      this.speed = Math.min(MAX_SPEED, this.speed + ACCEL * dt);
    } else if (input.throttle < 0) {
      this.speed = Math.max(-REVERSE_MAX, this.speed - ACCEL * 0.7 * dt);
    } else {
      // выбег
      const sign = Math.sign(this.speed);
      this.speed -= sign * DRAG * dt;
      if (Math.abs(this.speed) < 0.08) this.speed = 0;
    }

    // --- Руль: плавный, чувствительность падает с скоростью ---
    const speedFactor = Math.max(0.3, 1 - Math.abs(this.speed) / MAX_SPEED);
    const targetSteer = input.steering * MAX_STEER * speedFactor;
    this.steer += (targetSteer - this.steer) * Math.min(1, dt * 4);

    // --- Применяем к телу ---
    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    this.body.setLinvel(
      { x: forward.x * this.speed, y: 0, z: forward.z * this.speed },
      true
    );
    // Поворот: минус, т.к. перед по -Z; знак скорости для заднего хода
    const turn = -this.steer * Math.sign(this.speed || 1) *
      Math.min(1, Math.abs(this.speed) / 3) * 1.6;
    this.body.setAngvel({ x: 0, y: turn, z: 0 }, true);

    // Визуальный крен/наклон (только меш, не физика)
    const targetRoll = -this.steer * Math.min(1, Math.abs(this.speed) / 8) * 0.05;
    const targetPitch = braking ? 0.025 : (input.throttle > 0 ? -0.015 : 0);
    this.visualRoll += (targetRoll - this.visualRoll) * Math.min(1, dt * 3);
    this.visualPitch += (targetPitch - this.visualPitch) * Math.min(1, dt * 3);
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
      this.visual.updateFromPhysics(dt, this.body, steering);
      // Наклон применяем к корню модели
      this.visual.root.quaternion.copy(visualQ);
    } else if (this.fallback) {
      this.fallback.position.set(pos.x, pos.y, pos.z);
      this.fallback.quaternion.copy(visualQ);
      const spin = (this.speed / 0.55) * dt;
      for (const w of this.fallbackWheels) w.rotation.x += spin;
    }

    // FOV при разгоне (эффект скорости)
    const targetFov = 70 + Math.min(14, Math.abs(this.speed) * 0.6);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();

    if (this.cameraMode === 'chase') {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      forward.y = 0;
      forward.normalize();
      const camPos = new THREE.Vector3(pos.x - forward.x * 10, pos.y + 3.5, pos.z - forward.z * 10);
      chaseCam.position.lerp(camPos, Math.min(1, dt * 8));
      chaseCam.lookAt(pos.x + forward.x * 15, pos.y + 1.2, pos.z + forward.z * 15);
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
