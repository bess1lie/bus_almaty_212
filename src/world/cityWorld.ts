/**
 * cityWorld.ts — потоковая загрузка города.
 * Здания с процедурными фасадами (BuildingSource.geometry), LOD 300/1500м,
 * frustum-отсечение тайлов и prefetch по вектору скорости.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { World as RapierWorld } from '@dimforge/rapier3d-compat';

function getRapierCompat() { return RAPIER; }
import { getTextures, createRadialShadowTexture, type BuildingTextureKind } from './textures';
import { evictTile } from './tiles';

export const CITY_TILE_SIZE = 2000;
export const CITY_DETAIL_DISTANCE = 300;
export const CITY_HIDDEN_DISTANCE = 1500;
export const CITY_MAX_TILE_TRIANGLES = 30_000;
const MAX_LOADED_TILES = 24;      // жёсткий лимит (3×3 + коридор)
const TILE_HYSTERESIS = 1.0;      // порог в тайлах перед выгрузкой
const LOD_MOVE_THRESHOLD_SQ = 6 * 6; // пересчёт LOD только при сдвиге > 6 м
const MAX_SHADOW_INSTANCES = 160;  // тени только ближайших зданий

interface RoadEdge { id: number; a: number; b: number; oneWay: boolean; speed: number; lanes: number; }

/** Граф дорог: стабильные ID рёбер + сантиметровая привязка узлов. */
export class RoadGraph {
  readonly nodes: Array<[number, number]> = [];
  readonly edges: RoadEdge[] = [];
  private readonly idx = new Map<string, number>();
  private nextEdgeId = 1;
  private readonly index = (x: number, z: number): number => {
    // 0.01 м — генератор округляет OSM-координаты до сантиметра.
    const k = `${Math.round(x * 100)},${Math.round(z * 100)}`;
    const e = this.idx.get(k);
    if (e !== undefined) return e;
    const i = this.nodes.length;
    this.nodes.push([x, z]);
    this.idx.set(k, i);
    return i;
  };
  addRoad(poly: Array<[number, number]>, oneWay: boolean, speed: number, lanes: number): number[] {
    const added: number[] = [];
    for (let i = 0; i < poly.length - 1; i++) {
      const a = this.index(poly[i][0], poly[i][1]);
      const b = this.index(poly[i + 1][0], poly[i + 1][1]);
      if (a === b) continue;
      const id = this.nextEdgeId++;
      this.edges.push({ id, a, b, oneWay, speed, lanes });
      added.push(id);
    }
    return added;
  }
  removeEdges(ids: number[]) {
    const remove = new Set(ids);
    for (let i = this.edges.length - 1; i >= 0; i--) {
      if (remove.has(this.edges[i].id)) this.edges.splice(i, 1);
    }
  }
  /** Соседние рёбра по узлу (для непрерывного движения трафика). */
  neighbors(node: number): RoadEdge[] {
    return this.edges.filter((e) => e.a === node || e.b === node);
  }
  nearest(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = (this.nodes[i][0] - x) ** 2 + (this.nodes[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}

export interface BuildingSource {
  position: THREE.Vector3;
  size: THREE.Vector3;
  rotationY?: number;
  color?: THREE.ColorRepresentation;
  geometry?: THREE.BufferGeometry | null;
  collidable?: boolean;
}

export interface CityTilePayload {
  buildings: BuildingSource[];
  roads?: THREE.Object3D | null;
  roadLines?: Array<{ poly: Array<[number, number]>; oneWay: boolean; speed: number; lanes: number }>;
}

export interface CityTileProvider {
  loadTile(tileX: number, tileZ: number): Promise<CityTilePayload>;
  dispose?(): void;
}

export interface CityWorldFrame {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  deltaSeconds: number;
  activeCamera?: THREE.Camera; // реальная камера (кабина/chase) для frustum
}

export interface CityWorldOptions {
  tileSize?: number;
  onTileError?: (x: number, z: number, error: unknown) => void;
  onTileLoaded?: (x: number, z: number) => void;
  onTileUnloaded?: (x: number, z: number) => void;
  onTileEvicted?: (x: number, z: number) => void;
}

interface BuildingRuntime {
  source: BuildingSource;
  center: THREE.Vector3;
  geometry: THREE.BufferGeometry | null;
}

interface TileRuntime {
  x: number;
  z: number;
  key: string;
  root: THREE.Group;
  bounds: THREE.Box3;
  boxMesh: THREE.InstancedMesh | null;
  shadowMesh: THREE.InstancedMesh | null;
  shadowBase: Map<number, THREE.Matrix4>;
  detailMeshes: THREE.InstancedMesh[];
  facadeGeometries: Set<THREE.BufferGeometry>;
  buildings: BuildingRuntime[];
  baseMatrices: THREE.Matrix4[];
  inFrustum: boolean;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _cam = new THREE.Vector3();
const _ahead = new THREE.Vector3();

function countTriangles(object: THREE.Object3D | null): number {
  if (!object) return 0;
  let total = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0;
    total += Math.floor(count / 3);
  });
  return total;
}

export class CityWorld {
  readonly graph = new RoadGraph();
  private readonly tileEdges = new Map<string, number[]>(); // edge indices per tile
  private readonly tileColliders = new Map<string, number[]>(); // Rapier collider handles per tile
  private readonly world: RapierWorld;
  private readonly tileSize: number;
  private readonly tiles = new Map<string, TileRuntime>();
  private readonly pending = new Set<string>();
  private readonly readyTiles: Array<{ x: number; z: number; key: string; payload: CityTilePayload }> = [];
  private readonly keep = new Set<string>();
  private readonly boxMaterial: THREE.MeshStandardMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly wallMaterials: Record<BuildingTextureKind, THREE.MeshStandardMaterial>;
  private readonly windowMaterial: THREE.MeshStandardMaterial;
  private readonly onError?: CityWorldOptions['onTileError'];
  private readonly onLoaded?: CityWorldOptions['onTileLoaded'];
  private readonly onUnloaded?: CityWorldOptions['onTileUnloaded'];
  private readonly onTileEvicted?: CityWorldOptions['onTileEvicted'];
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private streamTimer = 0;
  private disposed = false;
  private readonly lastLodPos = new THREE.Vector3(Infinity, 0, Infinity);
  private readonly lodNear: Array<{ index: number; dist: number }> = [];
  private readonly lodSelected = new Set<number>();
  private lastFocusKey = '';

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly provider: CityTileProvider,
    _rapierWorld: RapierWorld,
    options: CityWorldOptions = {},
  ) {
    this.world = _rapierWorld;
    this.tileSize = options.tileSize ?? CITY_TILE_SIZE;
    this.onError = options.onTileError;
    this.onLoaded = options.onTileLoaded;
    this.onUnloaded = options.onTileUnloaded;
    this.onTileEvicted = options.onTileEvicted;
    const tex = getTextures();
    this.boxMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, vertexColors: true });
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x26313f, alphaMap: createRadialShadowTexture(), transparent: true,
      opacity: 0.28, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1,
    });
    const surfaceFor: Record<BuildingTextureKind, keyof typeof tex.pbr> = {
      apartments: 'facade', house: 'brick', commercial: 'concrete', industrial: 'concrete',
    };
    const mkWall = (kind: BuildingTextureKind) => {
      const maps = tex.pbr[surfaceFor[kind]];
      return new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.9, map: tex.walls[kind],
        normalMap: maps.nor, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: maps.rough,
      });
    };
    this.wallMaterials = {
      apartments: mkWall('apartments'),
      house: mkWall('house'),
      commercial: mkWall('commercial'),
      industrial: mkWall('industrial'),
    };
    this.windowMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.35,
      emissive: 0xffb66e, emissiveIntensity: 0,
    });
  }

  private materialsFor(geometry: THREE.BufferGeometry): THREE.Material[] {
    const kind = (geometry.userData.buildingKind as BuildingTextureKind) ?? 'apartments';
    return [this.wallMaterials[kind] ?? this.wallMaterials.apartments, this.windowMaterial];
  }

  get loadedTileCount() { return this.tiles.size; }
  getStats() {
    let details = 0, boxes = 0;
    for (const t of this.tiles.values()) {
      details += t.detailMeshes.reduce((s, m) => s + m.count, 0);
      boxes += t.boxMesh?.count ?? 0;
    }
    return { tiles: this.tiles.size, details, boxes };
  }
  getLoadedTiles(): Array<[number, number]> {
    return [...this.tiles.values()].map((t) => [t.x, t.z]);
  }

  update(frame: CityWorldFrame) {
    if (this.disposed) return;

    this.windowMaterial.emissiveIntensity = this.scene.userData.isNight === true ? 1.2 : 0;

    // Не более одного тяжёлого addTile за кадр; устаревшие результаты не добавляем.
    // keep обновляется ниже в этом же кадре, поэтому проверяем по distance до игрока.
    let ready = this.readyTiles.shift();
    while (ready) {
      const centerX = ready.x * this.tileSize + this.tileSize / 2;
      const centerZ = ready.z * this.tileSize + this.tileSize / 2;
      const near = Math.abs(centerX - frame.position.x) < this.tileSize * 3 &&
                   Math.abs(centerZ - frame.position.z) < this.tileSize * 3;
      if (near && !this.tiles.has(ready.key)) {
        this.addTile(ready.x, ready.z, ready.key, ready.payload, frame.position);
        break;
      }
      ready = this.readyTiles.shift();
    }

    const frustumCam = (frame.activeCamera as THREE.PerspectiveCamera) ?? this.camera;
    frustumCam.updateMatrixWorld();
    _pv.multiplyMatrices(frustumCam.projectionMatrix, frustumCam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);

    for (const tile of this.tiles.values()) {
      tile.inFrustum = _frustum.intersectsBox(tile.bounds);
      tile.root.visible = tile.inFrustum;
    }

    this.streamTimer += frame.deltaSeconds;
    if (this.streamTimer < 0.3) return;
    this.streamTimer = 0;

    const ts = this.tileSize;
    const px = frame.position.x;
    const pz = frame.position.z;
    const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
    const ahead = _ahead;
    if (speed > 1) ahead.set(frame.velocity.x, 0, frame.velocity.z).normalize();
    else ahead.copy(frame.forward);
    const aheadDist = Math.min(9000, 1500 + speed * 12);

    const want = new Set<string>();
    const tx = Math.floor(px / ts);
    const tz = Math.floor(pz / ts);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) want.add(`${tx + dx}_${tz + dz}`);

    for (let d = 1; d * ts < aheadDist; d++) {
      const cx = Math.floor((px + ahead.x * d * ts) / ts);
      const cz = Math.floor((pz + ahead.z * d * ts) / ts);
      want.add(`${cx}_${cz}`);
      want.add(`${cx + 1}_${cz}`);
      want.add(`${cx - 1}_${cz}`);
      want.add(`${cx}_${cz + 1}`);
      want.add(`${cx}_${cz - 1}`);
    }
    this.keep.clear();
    for (const k of want) this.keep.add(k);

    const MAX_PENDING = 2;
    for (const key of want) {
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if (this.pending.size >= MAX_PENDING) break;
      this.pending.add(key);
      const [sx, sz] = key.split('_').map(Number);
      this.provider.loadTile(sx, sz)
        .then((payload) => {
          if (!this.disposed) this.readyTiles.push({ x: sx, z: sz, key, payload });
        })
        .catch((err) => this.onError?.(sx, sz, err))
        .finally(() => this.pending.delete(key));
    }

    // Жёсткий лимит + hysteresis: выгружаем только вне keep и с запасом в 1 тайл
    const toRemove: string[] = [];
    for (const [key, tile] of this.tiles) {
      if (this.keep.has(key)) continue;
      const dtx = Math.abs(tile.x - tx);
      const dtz = Math.abs(tile.z - tz);
      if (dtx > 1 + TILE_HYSTERESIS || dtz > 1 + TILE_HYSTERESIS) toRemove.push(key);
    }
    for (const key of toRemove) this.removeTile(key);
    if (this.tiles.size > MAX_LOADED_TILES) {
      const extra = [...this.tiles.entries()]
        .filter(([k]) => !this.keep.has(k))
        .sort((a, b) =>
          Math.hypot(b[1].root.position.x - px, b[1].root.position.z - pz) -
          Math.hypot(a[1].root.position.x - px, a[1].root.position.z - pz))
        .slice(0, this.tiles.size - MAX_LOADED_TILES);
      for (const [k] of extra) this.removeTile(k);
    }

    // LOD только при заметном движении камеры и только для видимых тайлов
    frustumCam.getWorldPosition(_cam);
    if (this.lastLodPos.distanceToSquared(_cam) > LOD_MOVE_THRESHOLD_SQ) {
      this.lastLodPos.copy(_cam);
      for (const tile of this.tiles.values()) {
        if (tile.inFrustum) this.updateLod(tile, _cam.x, _cam.z);
      }
    }
  }

  private addTile(x: number, z: number, key: string, payload: CityTilePayload, player: THREE.Vector3) {
    const root = new THREE.Group();
    root.name = `tile-${key}`;
    root.position.set(x * this.tileSize, 0, z * this.tileSize);
    if (payload.roads) root.add(payload.roads);
    const edgeIdx: number[] = [];
    for (const r of payload.roadLines ?? []) edgeIdx.push(...this.graph.addRoad(r.poly, r.oneWay, r.speed, r.lanes));
    this.tileEdges.set(key, edgeIdx);

    const buildings: BuildingRuntime[] = [];
    const baseMatrices: THREE.Matrix4[] = [];
    const facadeGeometries = new Set<THREE.BufferGeometry>();
    const byGeometry = new Map<THREE.BufferGeometry, number[]>();

    for (let i = 0; i < payload.buildings.length; i++) {
      const b = payload.buildings[i];
      _p.set(b.position.x, b.size.y / 2, b.position.z);
      _q.setFromAxisAngle(_up, b.rotationY ?? 0);
      _s.set(Math.max(1, b.size.x), Math.max(2, b.size.y), Math.max(1, b.size.z));
      _m.compose(_p, _q, _s);
      baseMatrices.push(_m.clone());
      buildings.push({
        source: b,
        center: new THREE.Vector3(x * this.tileSize + b.position.x, b.size.y / 2, z * this.tileSize + b.position.z),
        geometry: b.geometry ?? null,
      });
      if (b.geometry) {
        facadeGeometries.add(b.geometry);
        const arr = byGeometry.get(b.geometry) ?? [];
        arr.push(i);
        byGeometry.set(b.geometry, arr);
      }
    }

    // Дальний LOD: простые коробки для всех зданий
    let boxMesh: THREE.InstancedMesh | null = null;
    if (buildings.length > 0) {
      boxMesh = new THREE.InstancedMesh(this.boxGeom, this.boxMaterial, buildings.length);
      boxMesh.frustumCulled = false;
      boxMesh.castShadow = false;
      for (let i = 0; i < buildings.length; i++) {
        boxMesh.setMatrixAt(i, baseMatrices[i]);
        _c.set(buildings[i].source.color ?? 0xc8c6bd);
        boxMesh.setColorAt(i, _c);
      }
      boxMesh.instanceMatrix.needsUpdate = true;
      if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
      root.add(boxMesh);
    }

    // Мягкие контактные тени под зданиями — один draw call на тайл
    let shadowMesh: THREE.InstancedMesh | null = null;
    const shadowBase = new Map<number, THREE.Matrix4>();
    if (buildings.length > 0) {
      const sg = new THREE.PlaneGeometry(1, 1);
      sg.rotateX(-Math.PI / 2);
      shadowMesh = new THREE.InstancedMesh(sg, this.shadowMaterial, buildings.length);
      shadowMesh.frustumCulled = false;
      const dummy = new THREE.Object3D();
      const sunElev = THREE.MathUtils.degToRad(18);
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i].source;
        const len = THREE.MathUtils.clamp(b.size.y / Math.tan(sunElev), 5, 40);
        dummy.position.set(b.position.x + 0.45 * len, 0.065, b.position.z + 0.3 * len);
        dummy.rotation.set(0, 0.35, 0);
        dummy.scale.set(Math.max(b.size.x, b.size.z) * 1.3, len, 1);
        dummy.updateMatrix();
        shadowMesh.setMatrixAt(i, dummy.matrix);
        shadowBase.set(i, dummy.matrix.clone());
      }
      shadowMesh.instanceMatrix.needsUpdate = true;
      root.add(shadowMesh);
    }

    // Упрощённые физические коллайдеры для крупных зданий (≤40 на тайл)
    const R = getRapierCompat();
    const colliderHandles: number[] = [];
    if (R) {
      let made = 0;
      for (const b of buildings) {
        if (made >= 40) break;
        if (b.source.collidable === false) continue;
        if (b.source.size.x < 8 || b.source.size.z < 8 || b.source.size.y < 6) continue;
        const wx = root.position.x + b.source.position.x;
        const wz = root.position.z + b.source.position.z;
        const desc = R.ColliderDesc.cuboid(b.source.size.x / 2, b.source.size.y / 2, b.source.size.z / 2)
          .setTranslation(wx, b.source.size.y / 2, wz)
          .setFriction(0.8);
        const c = this.world.createCollider(desc);
        colliderHandles.push(c.handle);
        made++;
      }
    }
    this.tileColliders.set(key, colliderHandles);

    // Ближний LOD: детализированные фасады, сгруппированные по геометрии.
    // Capacity = ВСЕ здания этого типа — выбор ближайших происходит в updateLod().
    const detailMeshes: THREE.InstancedMesh[] = [];
    const roadTris = countTriangles(payload.roads ?? null);
    let remaining = Math.max(0, CITY_MAX_TILE_TRIANGLES - buildings.length * 12 - roadTris);
    const geoArray = [...byGeometry.entries()];
    // Минимальный бюджет на каждый тип, чтобы ранние типы не съедали всё
    const minPerType = Math.floor(remaining / Math.max(1, geoArray.length));

    for (const [geometry, indices] of geoArray) {
      const tri = Math.max(1, Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3));
      if (remaining < tri) continue; // не превышаем бюджет triangle budget
      const budget = Math.max(minPerType, Math.floor(remaining / Math.max(1, geoArray.length)));
      const capacity = Math.min(indices.length, Math.floor(budget / tri));
      if (capacity <= 0) continue;
      const mesh = new THREE.InstancedMesh(geometry, this.materialsFor(geometry), capacity);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData.allIndices = indices; // полный список — не подвыборка
      detailMeshes.push(mesh);
      root.add(mesh);
      remaining = Math.max(0, remaining - Math.min(remaining, capacity * tri));
    }

    this.scene.add(root);
    const minX = x * this.tileSize, minZ = z * this.tileSize;
    this.tiles.set(key, {
      x, z, key, root,
      bounds: new THREE.Box3(
        new THREE.Vector3(minX, -100, minZ),
        new THREE.Vector3(minX + this.tileSize, 1000, minZ + this.tileSize),
      ),
      boxMesh, shadowMesh, shadowBase, detailMeshes, facadeGeometries, buildings, baseMatrices, inFrustum: true,
    });
    this.updateLod(this.tiles.get(key)!, player.x, player.z);
    this.onLoaded?.(x, z);
  }

  private updateLod(tile: TileRuntime, camX: number, camZ: number) {
    // Переиспользуемые буферы — никаких new Set/массивов в горячем цикле
    const near = this.lodNear;
    near.length = 0;
    const selected = this.lodSelected;
    selected.clear();

    for (let i = 0; i < tile.buildings.length; i++) {
      const b = tile.buildings[i];
      const dx = b.center.x - camX, dz = b.center.z - camZ;
      const distSq = dx * dx + dz * dz;
      if (distSq <= CITY_HIDDEN_DISTANCE * CITY_HIDDEN_DISTANCE) {
        near.push({ index: i, dist: distSq }); // квадрат — sort по тому же порядку
      }
    }
    // Не сортируем полный список: partial selection TOP-N через простой insertion sort
    near.sort((a, b) => a.dist - b.dist);

    for (const mesh of tile.detailMeshes) {
      const all = mesh.userData.allIndices as number[];
      const capacity = mesh.instanceMatrix.count;
      let written = 0;
      for (let k = 0; k < near.length && written < capacity; k++) {
        const idx = near[k].index;
        // all — отсортированный список индексов этого типа; membership через includes
        // здесь допустим: near обычно ≤ 160, all ≤ 1800.
        if (!all.includes(idx)) continue;
        mesh.setMatrixAt(written, tile.baseMatrices[idx]);
        _c.set(tile.buildings[idx].source.color ?? 0xffffff);
        mesh.setColorAt(written, _c);
        selected.add(idx);
        written++;
      }
      mesh.count = written; // реально видимые экземпляры, не нулевые матрицы
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    if (tile.boxMesh) {
      let written = 0;
      for (let k = 0; k < near.length; k++) {
        const idx = near[k].index;
        if (selected.has(idx)) continue; // детальная геометрия уже рисует
        tile.boxMesh.setMatrixAt(written, tile.baseMatrices[idx]);
        written++;
      }
      tile.boxMesh.count = written;
      tile.boxMesh.instanceMatrix.needsUpdate = true;
    }

    // Тени — только ближайшие здания
    if (tile.shadowMesh) {
      let written = 0;
      for (let k = 0; k < near.length && written < MAX_SHADOW_INSTANCES; k++) {
        const idx = near[k].index;
        const m = tile.shadowBase.get(idx);
        if (!m) continue;
        tile.shadowMesh.setMatrixAt(written, m);
        written++;
      }
      tile.shadowMesh.count = written;
      tile.shadowMesh.instanceMatrix.needsUpdate = true;
    }
  }

  private removeTile(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.scene.remove(tile.root);
    tile.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.geometry !== this.boxGeom && !tile.facadeGeometries.has(mesh.geometry)) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (mat !== this.boxMaterial && mat !== this.windowMaterial && mat !== this.shadowMaterial && !Object.values(this.wallMaterials).includes(mat as THREE.MeshStandardMaterial)) mat.dispose();
      }
    });
    // Очищаем кэш разобранных данных — при долгой поездке он не должен расти
    evictTile(key);
    this.onTileEvicted?.(tile.x, tile.z);

    const edges = this.tileEdges.get(key);
    if (edges) { this.graph.removeEdges(edges); this.tileEdges.delete(key); }
    const cols = this.tileColliders.get(key);
    if (cols) {
      for (const h of cols) {
        const c = this.world.getCollider(h);
        if (c) this.world.removeCollider(c, true);
      }
      this.tileColliders.delete(key);
    }
    this.tiles.delete(key);
    this.onUnloaded?.(tile.x, tile.z);
  }

  dispose() {
    this.disposed = true;
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.boxGeom.dispose();
    this.boxMaterial.dispose();
    Object.values(this.wallMaterials).forEach((m) => m.dispose());
    this.windowMaterial.dispose();
    this.provider.dispose?.();
  }
}
