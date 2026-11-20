/**
 * cityWorld.ts — граф дорог, A* маршрутизация и рендер тайлов города.
 *
 * Загружает тайлы из public/map/v1/tiles/, строит общий граф дорог,
 * умеет прокладывать маршрут между двумя точками (для линий 212/230/244),
 * рендерит здания (InstancedMesh) и дороги (ribbons) с LOD.
 */

import * as THREE from 'three';
import type { CityTile, CityBuilding, CityRoad } from './tiles';
import { loadTile, tileKeyFromPos, tileCenter } from './tiles';

// ---- Граф дорог ----
type Vec2 = [number, number];

interface RoadNode {
  x: number;
  z: number;
  edges: number[]; // индексы рёбер
}

interface RoadEdge {
  a: number;
  b: number;
  length: number;
  oneWay: boolean;
  speed: number;
  lanes: number;
}

export class RoadGraph {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];

  private readonly nodeIndex = new Map<string, number>();

  clear() {
    this.nodes.length = 0;
    this.edges.length = 0;
    this.nodeIndex.clear();
  }

  private getNode(x: number, z: number): number {
    // квантовка 2 м — чтобы концы дорог совпадали
    const key = `${Math.round(x / 2)},${Math.round(z / 2)}`;
    const existing = this.nodeIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = this.nodes.length;
    this.nodes.push({ x, z, edges: [] });
    this.nodeIndex.set(key, idx);
    return idx;
  }

  addRoad(road: CityRoad) {
    if (road.poly.length < 2) return;
    for (let i = 0; i < road.poly.length - 1; i++) {
      const [ax, az] = road.poly[i];
      const [bx, bz] = road.poly[i + 1];
      const a = this.getNode(ax, az);
      const b = this.getNode(bx, bz);
      if (a === b) continue;
      const length = Math.hypot(bx - ax, bz - az);
      const edgeIdx = this.edges.length;
      this.edges.push({
        a, b,
        length,
        oneWay: road.oneWay,
        speed: road.speed || 50,
        lanes: road.lanes,
      });
      this.nodes[a].edges.push(edgeIdx);
      if (!road.oneWay) this.nodes[b].edges.push(edgeIdx);
    }
  }

  /** Ближайший узел графа к точке (x,z). */
  nearest(x: number, z: number, maxDist = 100): number {
    let best = -1;
    let bestDist = maxDist * maxDist;
    for (let i = 0; i < this.nodes.length; i++) {
      const dx = this.nodes[i].x - x;
      const dz = this.nodes[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /** A* между узлами. Возвращает массив точек [x,z] или пустой. */
  findPath(startIdx: number, endIdx: number): Vec2[] {
    if (startIdx < 0 || endIdx < 0 || startIdx === endIdx) {
      return startIdx >= 0 ? [[this.nodes[startIdx].x, this.nodes[startIdx].z]] : [];
    }

    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open: number[] = [startIdx];

    const h = (i: number) => Math.hypot(this.nodes[i].x - this.nodes[endIdx].x, this.nodes[i].z - this.nodes[endIdx].z);

    g[startIdx] = 0;
    f[startIdx] = h(startIdx);

    while (open.length > 0) {
      // узел с минимальным f (линейный поиск — для нашего размера хватит)
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        if (f[open[i]] < f[open[bi]]) bi = i;
      }
      const current = open.splice(bi, 1)[0];

      if (current === endIdx) {
        const path: Vec2[] = [];
        let c = current;
        while (c !== -1) {
          path.push([this.nodes[c].x, this.nodes[c].z]);
          c = cameFrom[c];
        }
        return path.reverse();
      }

      closed[current] = 1;
      for (const edgeIdx of this.nodes[current].edges) {
        const e = this.edges[edgeIdx];
        const next = e.a === current ? e.b : e.a;
        if (closed[next]) continue;
        const speedFactor = Math.max(0.2, e.speed / 60);
        const tentative = g[current] + e.length / speedFactor;
        if (tentative < g[next]) {
          cameFrom[next] = current;
          g[next] = tentative;
          f[next] = tentative + h(next);
          if (!open.includes(next)) open.push(next);
        }
      }
    }
    return [];
  }

  /** Маршрут между координатами. */
  route(from: Vec2, to: Vec2): Vec2[] {
    const a = this.nearest(from[0], from[1]);
    const b = this.nearest(to[0], to[1]);
    if (a < 0 || b < 0) return [];
    return this.findPath(a, b);
  }
}

// ---- Рендер зданий ----
const BUILDING_COLORS = [
  0x7d8a96, 0x9aa6b0, 0x6b7885, 0xb0a99b, 0x8d9a8b, 0xa89c91, 0x778b96,
];

function buildBuildings(buildings: CityBuilding[]): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'buildings';
  if (buildings.length === 0) return group;

  // Инстансированные коробки: position/scale из bbox здания, цвет по типу
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.85, metalness: 0.12 });
  const mesh = new THREE.InstancedMesh(geo, mat, buildings.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of b.poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const w = Math.max(2, maxX - minX);
    const d = Math.max(2, maxZ - minZ);
    const h = Math.max(2, b.h);
    dummy.position.set((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
    dummy.scale.set(w, h, d);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    let hue = BUILDING_COLORS[(i + b.type.length) % BUILDING_COLORS.length];
    if (b.type === 'apartments') hue = 0x8e9aa5;
    if (b.type === 'industrial') hue = 0x7f8078;
    color.setHex(hue);
    if (b.est) color.multiplyScalar(0.92);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return group;
}

// ---- Рендер дорог ----
function buildRoads(roads: CityRoad[]): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'roads';
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const asphalt = new THREE.Color(0x2b3336);
  const paint = new THREE.Color(0xd8d8cc);

  let vertexCount = 0;
  for (const road of roads) {
    if (road.poly.length < 2) continue;
    // для каждой точки — две вершины (левый/правый край), Width по дороге
    for (let i = 0; i < road.poly.length; i++) {
      const [cx, cz] = road.poly[i];
      const prev = road.poly[Math.max(0, i - 1)];
      const next = road.poly[Math.min(road.poly.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const hw = Math.min(road.w / 2, 12);

      positions.push(cx + nx * hw, 0.03, cz + nz * hw);
      positions.push(cx - nx * hw, 0.03, cz - nz * hw);
      colors.push(asphalt.r, asphalt.g, asphalt.b, asphalt.r, asphalt.g, asphalt.b);

      if (i > 0) {
        const p = vertexCount - 2;
        const c = vertexCount;
        indices.push(p, p + 1, c, p + 1, c + 1, c);
      }
      vertexCount += 2;
    }
  }

  if (vertexCount > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Разметка: центральная пунктирная линия — отдельная линия поверх асфальта
  const linePoints: number[] = [];
  for (const road of roads) {
    if (road.lanes < 2 || road.poly.length < 2) continue;
    for (let i = 0; i < road.poly.length; i++) {
      linePoints.push(road.poly[i][0], 0.05, road.poly[i][1]);
    }
  }
  if (linePoints.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
    const mat = new THREE.LineBasicMaterial({ color: paint, transparent: true, opacity: 0.5 });
    const lines = new THREE.LineSegments(geo, mat);
    group.add(lines);
  }

  return group;
}

// ---- Город ----
interface LoadedTile {
  key: string;
  center: Vec2;
  group: THREE.Group;
  lastAccess: number;
}

export class CityWorld {
  readonly graph = new RoadGraph();
  private readonly scene: THREE.Scene;
  private readonly tiles = new Map<string, LoadedTile>();
  private readonly loading = new Set<string>();
  private urbanCenter: Vec2 = [0, 0];
  private lastReport = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setPlayerPosition(x: number, z: number) {
    this.urbanCenter = [x, z];
  }

  update(dt: number) {
    void dt;
    // Вокруг игрока: 3×3 тайлов (по 2 км = 6×6 км视野)
    const [px, pz] = this.urbanCenter;
    const tx = Math.floor(px / 2000);
    const tz = Math.floor(pz / 2000);
    const needed = new Set<string>();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${tx + dx}_${tz + dz}`;
        needed.add(key);
        if (!this.tiles.has(key) && !this.loading.has(key)) {
          this.loadTile(key);
        }
      }
    }

    for (const [key, tile] of this.tiles) {
      tile.lastAccess = Date.now();
      const dist = Math.hypot(tile.center[0] - px, tile.center[1] - pz);
      if (!needed.has(key) && dist > 7000) {
        this.unloadTile(key);
      }
    }
  }

  private async loadTile(key: string) {
    this.loading.add(key);
    try {
      const data: CityTile = await loadTile(key);
      if (this.loading.has(key) === false) return; // выгрузили пока грузилось

      // Добавляем дороги в граф (только один раз за тайл)
      for (const road of data.roads) this.graph.addRoad(road);

      const group = new THREE.Group();
      group.name = `tile-${key}`;
      group.add(buildRoads(data.roads));
      group.add(buildBuildings(data.buildings));
      const [cx, cz] = tileCenter(key);
      group.position.set(0, 0, 0); // координаты уже абсолютные

      this.scene.add(group);
      this.tiles.set(key, {
        key,
        center: [cx, cz],
        group,
        lastAccess: Date.now(),
      });
    } catch {
      // Тайла нет — город заканчивается, это нормально
    } finally {
      this.loading.delete(key);
    }
  }

  private unloadTile(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.scene.remove(tile.group);
    tile.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.tiles.delete(key);
  }

  getStats() {
    return {
      tiles: this.tiles.size,
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
    };
  }
}
