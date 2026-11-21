/**
 * traffic.ts — дешёвый «живой» трафик и пешеходы вокруг игрока.
 *
 * Никаких OSM-данных, текстур и внешних библиотек. Дороги — виртуальная
 * детерминированная сетка с шагом BLOCK метров, привязанная к мировым
 * координатам (X — восток, Z — юг). Машины едут по двум полосам каждой
 * дороги (правостороннее движение), пешеходы стоят у «остановок» на
 * перекрёстках — всегда вне проезжей части.
 *
 * Бюджет (desktop, 16 машин / 30 пешеходов):
 *   кузов 24 tris × 16 = 384
 *   фары/фонари 8 tris × 16 = 128
 *   пешеход 40 tris × 30 = 1200
 *   ИТОГО ~1712 треугольников, 3 draw call'а (2 днём — фары скрыты).
 * Мобильный (userAgent): 6 машин / 16 пешеходов, ~830 tris, те же 3 вызова.
 *
 * update() не выделяет память: все состояния лежат в типизированных
 * массивах, матрицы собираются одним переиспользуемым Object3D.
 */

import * as THREE from 'three';
import type { RoadGraph } from './cityWorld';

export interface TrafficController {
  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerForward: THREE.Vector3,
    isNight: boolean,
  ): void;
  dispose(): void;
  getStats(): { cars: number; pedestrians: number };
}

// --- Мировая раскладка ---
const BLOCK = 120;             // шаг сетки дорог, м
const LANE_OFFSET = 3.2;       // смещение полосы от оси дороги, м
const ROAD_HALF = 9;           // полуширина проезжей части, м
const CAR_Y = 0.06;            // высота колёс над нулём, м
const PED_Y = 0.07;            // высота подошв (уровень тротуара), м
const CAR_HIDE_SQ = 500 * 500; // дальше — не рисуем
const CAR_RESPAWN_SQ = 620 * 620;
const PED_HIDE_SQ = 300 * 300;
const PED_RESPAWN_SQ = 345 * 345;
const NUDGE_SQ = 10 * 10;      // зона мягкого объезда автобуса

const CAR_COLORS = [0xd4503c, 0x2f6fb8, 0xe8c33a, 0x49976a, 0xd8d8d2] as const;
const PED_COLORS = [0x4a5568, 0x8b5e4b, 0x3f6b62, 0x7a6a8a, 0xa8926f] as const;

type RGB = readonly [number, number, number];

/** Склеивает несколько Box/других геометрий в одну с вершинными цветами. */
function mergeParts(
  parts: ReadonlyArray<{ geometry: THREE.BufferGeometry; color: RGB }>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  for (const part of parts) {
    const source = part.geometry;
    const flat = source.index ? source.toNonIndexed() : source;
    const pos = flat.getAttribute('position') as THREE.BufferAttribute;
    const nor = flat.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      colors.push(part.color[0], part.color[1], part.color[2]);
    }
    if (flat !== source) flat.dispose();
    source.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Кузов + салон с тёмными стёклами: 24 треугольника, 1 геометрия. */
function buildCarBody(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.8, 0.72, 4.2);
  body.translate(0, 0.42, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.56, 2.3);
  cabin.translate(0, 1.02, -0.15);
  return mergeParts([
    { geometry: body, color: [1, 1, 1] },
    { geometry: cabin, color: [0.28, 0.35, 0.42] },
  ]);
}

/** Две фары (тёплый белый) и два фонаря (красный): 8 треугольников. */
function buildCarLights(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  const quad = (cx: number, cy: number, cz: number, w: number, h: number, color: RGB): void => {
    const x0 = cx - w * 0.5;
    const x1 = cx + w * 0.5;
    const y0 = cy - h * 0.5;
    const y1 = cy + h * 0.5;
    positions.push(
      x0, y0, cz, x1, y0, cz, x1, y1, cz,
      x0, y0, cz, x1, y1, cz, x0, y1, cz,
    );
    for (let v = 0; v < 6; v++) colors.push(color[0], color[1], color[2]);
  };

  // Передние фары: z = -2.13 (нос кузова), светят вперёд (-Z).
  quad(-0.58, 0.52, -2.13, 0.34, 0.16, [1.0, 0.93, 0.72]);
  quad(0.58, 0.52, -2.13, 0.34, 0.16, [1.0, 0.93, 0.72]);
  // Задние фонари: z = +2.13.
  quad(-0.58, 0.58, 2.13, 0.30, 0.14, [1.0, 0.14, 0.09]);
  quad(0.58, 0.58, 2.13, 0.30, 0.14, [1.0, 0.14, 0.09]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Тело-цилиндр + голова: 40 треугольников, 1 геометрия. */
function buildPedestrian(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.2, 0.22, 1.35, 5, 1);
  body.translate(0, 0.675, 0);
  const head = new THREE.IcosahedronGeometry(0.2, 0);
  head.translate(0, 1.52, 0);
  return mergeParts([
    { geometry: body, color: [1, 1, 1] },
    { geometry: head, color: [0.86, 0.72, 0.58] },
  ]);
}

export function createTraffic(scene: THREE.Scene, graph?: RoadGraph): TrafficController {
  const isMobile = typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const maxCars = isMobile ? 6 : 16;
  const maxPeds = isMobile ? 16 : 30;

  // Детерминированный xorshift: одинаковая раскладка при одинаковом старте.
  let rngState = 0x9e3779b9 >>> 0;
  const rand = (): number => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 4294967296;
  };

  const carAxis = new Uint8Array(maxCars);   // 0 = вдоль X, 1 = вдоль Z
  const carLane = new Float32Array(maxCars); // координата полосы (перпендикуляр)
  const carAlong = new Float32Array(maxCars);// координата вдоль движения
  const carDir = new Int8Array(maxCars);     // +1 / -1
  const carSpeed = new Float32Array(maxCars);
  const carYaw = new Float32Array(maxCars);
  const graphCars: Array<{ ax: number; az: number; ux: number; uz: number; off: number; t: number } | null> = new Array(maxCars).fill(null);

  const pedStopX = new Float32Array(maxPeds);
  const pedStopZ = new Float32Array(maxPeds);
  const pedPhase = new Float32Array(maxPeds);
  const pedDrift = new Float32Array(maxPeds);
  const pedRadius = new Float32Array(maxPeds);
  const pedYaw = new Float32Array(maxPeds);

  // Направление движения игрока, обновляется один раз за кадр.
  let forwardX = 0;
  let forwardZ = -1;

  const carBodyGeometry = buildCarBody();
  const carLightGeometry = buildCarLights();
  const pedGeometry = buildPedestrian();

  const carMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lightMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    depthWrite: false,
  });
  const pedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

  const carMesh = new THREE.InstancedMesh(carBodyGeometry, carMaterial, maxCars);
  const lightMesh = new THREE.InstancedMesh(carLightGeometry, lightMaterial, maxCars);
  const pedMesh = new THREE.InstancedMesh(pedGeometry, pedMaterial, maxPeds);
  carMesh.name = 'traffic-cars';
  lightMesh.name = 'traffic-lights';
  pedMesh.name = 'traffic-pedestrians';
  for (const mesh of [carMesh, lightMesh, pedMesh]) {
    mesh.count = 0;
    mesh.frustumCulled = false; // матрицы в мировых координатах, индексы компактуются
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
  }
  lightMesh.visible = false; // днём фар нет

  // Цвета задаём один раз: instanceColor живёт в буфере и в update не трогается.
  const carColors = CAR_COLORS.map((hex) => new THREE.Color(hex));
  const pedColors = PED_COLORS.map((hex) => new THREE.Color(hex));
  for (let i = 0; i < maxCars; i++) carMesh.setColorAt(i, carColors[i % carColors.length]);
  for (let i = 0; i < maxPeds; i++) pedMesh.setColorAt(i, pedColors[i % pedColors.length]);
  if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
  if (pedMesh.instanceColor) pedMesh.instanceColor.needsUpdate = true;

  const scratch = new THREE.Object3D();
  let initialized = false;
  let lastNight: boolean | null = null;
  let disposed = false;

  function spawnCar(i: number, initial: boolean, px: number, pz: number): void {
    // Если доступен OSM-граф — спавним машины на РЕАЛЬНЫХ дорогах
    if (graph && graph.edges.length > 0) {
      const edge = graph.edges[Math.floor(rand() * graph.edges.length)];
      const a = graph.nodes[edge.a];
      const b = graph.nodes[edge.b];
      if (a && b) {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        // Для односторонних дорог только направление a→b (dir=+1)
        const dir = edge.oneWay ? 1 : (rand() < 0.5 ? 1 : -1);
        const ux = (dx / len) * dir, uz = (dz / len) * dir;
        // полосы: смещение перпендикуляру
        const off = (i % 2 === 0 ? 1 : -1) * LANE_OFFSET;
        const nx = -uz, nz = ux;
        const t = rand();
        carAxis[i] = dir > 0 ? 0 : 1;
        carDir[i] = dir;
        carLane[i] = a[0] + nx * off; // временно: X
        carAlong[i] = a[1] + nz * off; // временно: Z
        // для простоты движения по прямой равны направлению ребра
        carYaw[i] = Math.atan2(-ux, -uz);
        carSpeed[i] = 8 + rand() * 7;
        void t;
        graphCars[i] = { ax: a[0], az: a[1], ux, uz, off, t };
        return;
      }
    }
    const axis = i & 1;
    const dir = rand() < 0.5 ? 1 : -1;
    carAxis[i] = axis;
    carDir[i] = dir;

    const perp = axis === 0 ? pz : px;
    const along = axis === 0 ? px : pz;
    const line = Math.round(perp / BLOCK) + Math.floor(rand() * 7) - 3;
    // Правостороннее движение:+X — южная полоса, +Z — западная.
    carLane[i] = axis === 0
      ? line * BLOCK + dir * LANE_OFFSET
      : line * BLOCK - dir * LANE_OFFSET;

    const ahead = axis === 0 ? forwardX : forwardZ;
    let a = initial
      ? along + (rand() - 0.5) * 820
      : along + ahead * (260 + rand() * 300) + (rand() - 0.5) * 160;
    // Не спавним машину прямо на автобусе.
    if (Math.abs(a - along) < 16 && Math.abs(carLane[i] - perp) < 8) a += dir * 26;
    carAlong[i] = a;
    carSpeed[i] = 8 + rand() * 7; // 8..15 м/с

    // Местный -Z повёрнут в направление движения.
    if (axis === 0) carYaw[i] = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    else carYaw[i] = dir > 0 ? Math.PI : 0;
  }

  function spawnPed(i: number, initial: boolean, px: number, pz: number): void {
    let gx = Math.round(px / BLOCK) + Math.floor(rand() * 5) - 2;
    let gz = Math.round(pz / BLOCK) + Math.floor(rand() * 5) - 2;
    if (!initial) {
      gx += Math.round(forwardX * 1.5);
      gz += Math.round(forwardZ * 1.5);
    }
    // Остановка — угол перекрёстка: сдвинуты по обеим осям на ROAD_HALF+3 м,
    // блуждание до 2.1 м не выводит пешехода на проезжую часть.
    const offX = ROAD_HALF + 3 + rand() * 1.5;
    const offZ = ROAD_HALF + 3 + rand() * 1.5;
    pedStopX[i] = gx * BLOCK + (rand() < 0.5 ? 1 : -1) * offX;
    pedStopZ[i] = gz * BLOCK + (rand() < 0.5 ? 1 : -1) * offZ;
    pedRadius[i] = rand() < 0.4 ? 0 : 0.8 + rand() * 1.3; // часть просто стоит
    pedDrift[i] = 0.15 + rand() * 0.3;
    pedPhase[i] = rand() * Math.PI * 2;
    pedYaw[i] = rand() * Math.PI * 2;
  }

  function update(
    dt: number,
    playerPos: THREE.Vector3,
    playerForward: THREE.Vector3,
    night: boolean,
  ): void {
    if (disposed) return;

    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    const fx = playerForward.x;
    const fz = playerForward.z;
    const len = Math.sqrt(fx * fx + fz * fz);
    if (len > 1e-5) {
      forwardX = fx / len;
      forwardZ = fz / len;
    }

    if (night !== lastNight) {
      lastNight = night;
      lightMesh.visible = night;
      pedMaterial.color.setHex(night ? 0xbcc3cc : 0xffffff); // ночью чуть темнее
    }

    if (!initialized) {
      for (let i = 0; i < maxCars; i++) spawnCar(i, true, playerPos.x, playerPos.z);
      for (let i = 0; i < maxPeds; i++) spawnPed(i, true, playerPos.x, playerPos.z);
      initialized = true;
    }

    // --- Машины ---
    let carCount = 0;
    for (let i = 0; i < maxCars; i++) {
      const gc = graphCars[i];
      if (gc) {
        gc.t += (carSpeed[i] * step) / Math.max(1, Math.hypot(gc.ux, gc.uz) * 20);
        if (gc.t > 1) spawnCar(i, false, playerPos.x, playerPos.z);
        const nx = -gc.uz, nz = gc.ux;
        const cx = gc.ax + gc.ux * gc.t * 20 + nx * gc.off;
        const cz = gc.az + gc.uz * gc.t * 20 + nz * gc.off;
        carAlong[i] = cx;
        carLane[i] = cz;
        carAxis[i] = 0;
        carYaw[i] = Math.atan2(-gc.ux, -gc.uz);
        // падаем в общий расчёт видимости ниже
      } else {
      carAlong[i] += carSpeed[i] * carDir[i] * step;
      }
      let x = gc ? carAlong[i] : (carAxis[i] === 0 ? carAlong[i] : carLane[i]);
      let z = gc ? carLane[i] : (carAxis[i] === 0 ? carLane[i] : carAlong[i]);
      let dx = x - playerPos.x;
      let dz = z - playerPos.z;
      let d2 = dx * dx + dz * dz;

      if (d2 > CAR_RESPAWN_SQ) {
        spawnCar(i, false, playerPos.x, playerPos.z);
        x = carAxis[i] === 0 ? carAlong[i] : carLane[i];
        z = carAxis[i] === 0 ? carLane[i] : carAlong[i];
        dx = x - playerPos.x;
        dz = z - playerPos.z;
        d2 = dx * dx + dz * dz;
      }
      if (d2 > CAR_HIDE_SQ) continue; // компакция instance-индексов скрывает машину

      // Мягкий визуальный объезд автобуса (физики у трафика нет).
      if (d2 < NUDGE_SQ) {
        let d = Math.sqrt(d2);
        if (d < 1e-3) { dx = 1; dz = 0; d = 1; }
        const push = (10 - d) * 0.35;
        x += (dx / d) * push;
        z += (dz / d) * push;
      }

      scratch.position.set(x, CAR_Y, z);
      scratch.rotation.set(0, carYaw[i], 0);
      scratch.scale.set(1, 1, 1);
      scratch.updateMatrix();
      carMesh.setMatrixAt(carCount, scratch.matrix);
      lightMesh.setMatrixAt(carCount, scratch.matrix); // фары едут с кузовом
      carCount++;
    }
    carMesh.count = carCount;
    lightMesh.count = carCount;
    carMesh.instanceMatrix.needsUpdate = true;
    if (night) lightMesh.instanceMatrix.needsUpdate = true;

    // --- Пешеходы ---
    let pedCount = 0;
    for (let i = 0; i < maxPeds; i++) {
      pedPhase[i] += pedDrift[i] * step;
      let x = pedStopX[i] + Math.sin(pedPhase[i]) * pedRadius[i];
      let z = pedStopZ[i] + Math.cos(pedPhase[i] * 0.8) * pedRadius[i];
      let dx = x - playerPos.x;
      let dz = z - playerPos.z;
      if (dx * dx + dz * dz > PED_RESPAWN_SQ) {
        spawnPed(i, false, playerPos.x, playerPos.z);
        x = pedStopX[i];
        z = pedStopZ[i];
        dx = x - playerPos.x;
        dz = z - playerPos.z;
      }
      if (dx * dx + dz * dz > PED_HIDE_SQ) continue;

      scratch.position.set(x, PED_Y, z);
      scratch.rotation.set(0, pedYaw[i], 0);
      scratch.scale.set(1, 1, 1);
      scratch.updateMatrix();
      pedMesh.setMatrixAt(pedCount, scratch.matrix);
      pedCount++;
    }
    pedMesh.count = pedCount;
    pedMesh.instanceMatrix.needsUpdate = true;
  }

  function getStats(): { cars: number; pedestrians: number } {
    return { cars: carMesh.count, pedestrians: pedMesh.count };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    scene.remove(carMesh);
    scene.remove(lightMesh);
    scene.remove(pedMesh);
    carMesh.dispose();
    lightMesh.dispose();
    pedMesh.dispose();

    carBodyGeometry.dispose();
    carLightGeometry.dispose();
    pedGeometry.dispose();
    carMaterial.dispose();
    lightMaterial.dispose();
    pedMaterial.dispose();
  }

  return { update, dispose, getStats };
}
