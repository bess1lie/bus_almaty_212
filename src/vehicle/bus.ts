/**
 * bus.ts — автобус: физика Rapier + визуальная GLTF-модель (bus-visual.ts).
 * Если GLB не загрузился — процедурный fallback.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getRapier, getPhysicsWorld } from '../core/rapier';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { InputState } from '../core/input';
import { createBusVisual, BusVisual } from './bus-visual';

const BUS_LENGTH = 12;
const BUS_WIDTH = 2.5;
const BODY_HALF_HEIGHT = 1.525; // центр масс, чтобы шины касались Y=0

const MAX_SPEED = 25; // м/с (~90 км/ч)
const MAX_STEER = 0.35;

export type CameraMode = 'driver' | 'chase';

export class Bus {
  /** Физическое тело Rapier. */
  readonly body: RigidBody;

  private readonly scene: THREE.Scene;
  private readonly rapi: typeof RAPIER;

  private visual: BusVisual | null = null;
  private fallback: THREE.Group | null = null;

  private cameraMode: CameraMode = 'driver';
  doorsOpen = false;
  private speed = 0;
  private steerAngle = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.rapi = getRapier();

    const world = getPhysicsWorld();
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(0.3)
      .setAngularDamping(2.0)
      // автобус не должен кувыркаться — только поворот вокруг вертикальной оси
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);

    // Центр масс = центр кузова. Пол пола на Y=0, поэтому ставим тело на BODY_HALF_HEIGHT.
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      BUS_LENGTH / 2,
      BODY_HALF_HEIGHT,
      BUS_WIDTH / 2
    );
    colliderDesc.setMass(13000); // 13 тонн
    colliderDesc.setFriction(1.2);
    world.createCollider(colliderDesc, this.body);

    this.body.setTranslation({ x: 0, y: BODY_HALF_HEIGHT + 0.1, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    this.buildFallback();
  }

  /** Загружает GLTF-модель. Возвращает true при успехе. */
  async loadModel(modelUrl: string, camera: THREE.PerspectiveCamera): Promise<boolean> {
    try {
      this.visual = await createBusVisual(this.scene, camera, modelUrl, { enableShadows: true });
      if (this.fallback) {
        this.scene.remove(this.fallback);
        this.disposeObject(this.fallback);
        this.fallback = null;
      }
      return true;
    } catch (err) {
      console.warn('[bus] Не удалось загрузить GLB, использую процедурную модель.', err);
      this.visual = null;
      return false;
    }
  }

  // ---------- Fallback (если GLB недоступен) ----------
  private buildFallback() {
    const group = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(BUS_LENGTH, 3.05, BUS_WIDTH);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a5f7a,
      roughness: 0.5,
      metalness: 0.3,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0;
    body.castShadow = true;
    group.add(body);

    const wheelGeo = new THREE.CylinderGeometry(0.425, 0.425, 0.8, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const positions: [number, number][] = [
      [-BUS_WIDTH / 2, -BUS_LENGTH / 2 + 1.4],
      [BUS_WIDTH / 2, -BUS_LENGTH / 2 + 1.4],
      [-BUS_WIDTH / 2, BUS_LENGTH / 2 - 1.4],
      [BUS_WIDTH / 2, BUS_LENGTH / 2 - 1.4],
    ];
    for (const [x, z] of positions) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, -BODY_HALF_HEIGHT + 0.425, z);
      w.castShadow = true;
      group.add(w);
    }

    this.fallback = group;
    this.scene.add(group);
  }

  // ---------- Управление состоянием ----------
  setCameraMode(mode: CameraMode) {
    this.cameraMode = mode;
  }
  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  toggleDoors() {
    this.doorsOpen = !this.doorsOpen;
    this.visual?.setDoorsOpen(this.doorsOpen);
  }

  setDoors(open: boolean) {
    if (this.doorsOpen === open) return;
    this.doorsOpen = open;
    this.visual?.setDoorsOpen(open);
  }

  /** Камера кабины: взгляд мышью/тачем. */
  setLook(yaw: number, pitch: number) {
    this.visual?.setLook(yaw, pitch);
  }

  // ---------- Кадр ----------
  update(dt: number, input: Readonly<InputState>, chaseCam: THREE.PerspectiveCamera) {
    const accel = 8;
    const brakeDecel = 15;
    const drag = 1.2;

    if (input.throttle > 0 && this.speed < MAX_SPEED) this.speed += accel * dt * input.throttle;
    if (input.throttle < 0 && this.speed > -MAX_SPEED * 0.4) this.speed -= accel * dt * Math.abs(input.throttle);
    if (input.brake > 0 || input.handbrake) {
      const decel = input.handbrake ? brakeDecel * 2 : brakeDecel;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - decel * dt);
      if (this.speed < 0) this.speed = Math.min(0, this.speed + decel * dt);
    }
    if (Math.abs(input.throttle) < 0.01 && input.brake === 0 && !input.handbrake) {
      const sign = Math.sign(this.speed) || 1;
      this.speed -= sign * drag * dt;
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    }

    const speedFactor = Math.max(0.3, 1 - Math.abs(this.speed) / MAX_SPEED);
    const targetSteer = input.steering * MAX_STEER * speedFactor;
    this.steerAngle += (targetSteer - this.steerAngle) * dt * 5;

    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    // Жёсткая стабилизация: автобус всегда стоит на земле, без крена/полёта.
    const pos = this.body.translation();
    this.body.setTranslation({ x: pos.x, y: BODY_HALF_HEIGHT, z: pos.z }, true);
    this.body.setLinvel(
      { x: forward.x * this.speed, y: 0, z: forward.z * this.speed },
      true
    );

    // Поворот вокруг Y — напрямую через угловую скорость.
    // Скорость поворота зависит от скорости движения.
    const turnRate = this.steerAngle * Math.min(1, Math.abs(this.speed) / 4) * 1.8;
    this.body.setAngvel({ x: 0, y: turnRate, z: 0 }, true);

    // Визуал
    if (this.visual) {
      this.visual.updateFromPhysics(dt, this.body, input.steering);
    } else if (this.fallback) {
      const pos = this.body.translation();
      this.fallback.position.set(pos.x, pos.y, pos.z);
      this.fallback.quaternion.copy(q);
    }

    // Камеры
    if (this.cameraMode === 'chase') {
      const pos = this.body.translation();
      const camPos = new THREE.Vector3(
        pos.x - forward.x * 9,
        pos.y + 3.2,
        pos.z - forward.z * 9
      );
      chaseCam.position.lerp(camPos, dt * 8);
      chaseCam.lookAt(pos.x + forward.x * 15, pos.y + 1, pos.z + forward.z * 15);
    }
  }

  getPosition(): THREE.Vector3 {
    const pos = this.body.translation();
    return new THREE.Vector3(pos.x, pos.y, pos.z);
  }

  getSpeedKmh(): number {
    return Math.abs(this.speed) * 3.6;
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
