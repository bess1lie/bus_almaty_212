/**
 * cityWorld.ts — потоковая загрузка города.
 * Здания с процедурными фасадами (BuildingSource.geometry), LOD 300/1500м,
 * frustum-отсечение тайлов и prefetch по вектору скорости.
 */

import * as THREE from 'three';
import type { World as RapierWorld } from '@dimforge/rapier3d-compat';
import { getTextures, type BuildingTextureKind } from './textures';

export const CITY_TILE_SIZE = 2000;
export const CITY_DETAIL_DISTANCE = 300;
export const CITY_HIDDEN_DISTANCE = 1500;
export const CITY_MAX_TILE_TRIANGLES = 30_000;

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
  private readonly tileSize: number;
  private readonly tiles = new Map<string, TileRuntime>();
  private readonly pending = new Set<string>();
  private readonly keep = new Set<string>();
  private readonly boxMaterial: THREE.MeshStandardMaterial;
  private readonly wallMaterials: Record<BuildingTextureKind, THREE.MeshStandardMaterial>;
  private readonly windowMaterial: THREE.MeshStandardMaterial;
  private readonly onError?: CityWorldOptions['onTileError'];
  private readonly onLoaded?: CityWorldOptions['onTileLoaded'];
  private readonly onUnloaded?: CityWorldOptions['onTileUnloaded'];
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private streamTimer = 0;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly provider: CityTileProvider,
    _rapierWorld: RapierWorld,
    options: CityWorldOptions = {},
  ) {
    this.tileSize = options.tileSize ?? CITY_TILE_SIZE;
    this.onError = options.onTileError;
    this.onLoaded = options.onTileLoaded;
    this.onUnloaded = options.onTileUnloaded;
    const tex = getTextures();
    this.boxMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, vertexColors: true });
    const mkWall = (kind: BuildingTextureKind) => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.9, map: tex.walls[kind],
    });
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
    const ahead = new THREE.Vector3();
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

    let inFlight = 0;
    for (const key of want) {
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if (inFlight >= 2) break;
      inFlight++;
      this.pending.add(key);
      const [sx, sz] = key.split('_').map(Number);
      this.provider.loadTile(sx, sz)
        .then((payload) => this.addTile(sx, sz, key, payload, frame.position))
        .catch((err) => this.onError?.(sx, sz, err))
        .finally(() => this.pending.delete(key));
    }

    for (const [key, tile] of this.tiles) {
      if (this.keep.has(key)) continue;
      if (Math.hypot(tile.root.position.x - px, tile.root.position.z - pz) > 12000) this.removeTile(key);
    }

    this.camera.getWorldPosition(_cam);
    for (const tile of this.tiles.values()) this.updateLod(tile, _cam.x, _cam.z);
  }

  private addTile(x: number, z: number, key: string, payload: CityTilePayload, player: THREE.Vector3) {
    const root = new THREE.Group();
    root.name = `tile-${key}`;
    root.position.set(x * this.tileSize, 0, z * this.tileSize);
    if (payload.roads) root.add(payload.roads);

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

    // Ближний LOD: детализированные фасады, сгруппированные по геометрии.
    // Capacity = ВСЕ здания этого типа — выбор ближайших происходит в updateLod().
    const detailMeshes: THREE.InstancedMesh[] = [];
    const roadTris = countTriangles(payload.roads ?? null);
    let remaining = Math.max(0, CITY_MAX_TILE_TRIANGLES - buildings.length * 12 - roadTris);
    const geoArray = [...byGeometry.entries()];
    // Минимальный бюджет на каждый тип, чтобы ранние типы не съедали всё
    const minPerType = Math.floor(remaining / Math.max(1, geoArray.length));

    for (const [geometry, indices] of geoArray) {
      const tri = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
      const budget = Math.max(minPerType, Math.floor(remaining / Math.max(1, geoArray.length)));
      const capacity = Math.min(indices.length, Math.max(1, Math.floor(budget / Math.max(1, tri))));
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
      boxMesh, detailMeshes, facadeGeometries, buildings, baseMatrices, inFrustum: true,
    });
    this.updateLod(this.tiles.get(key)!, player.x, player.z);
    this.onLoaded?.(x, z);
  }

  private updateLod(tile: TileRuntime, camX: number, camZ: number) {
    const near: Array<{ index: number; dist: number }> = [];
    for (let i = 0; i < tile.buildings.length; i++) {
      const b = tile.buildings[i];
      const dist = Math.hypot(b.center.x - camX, b.center.z - camZ);
      if (dist <= CITY_DETAIL_DISTANCE && b.geometry) near.push({ index: i, dist });
    }
    near.sort((a, b) => a.dist - b.dist);

    const selected = new Set<number>();
    const nearSet = new Set(near.map((n) => n.index));
    for (const mesh of tile.detailMeshes) {
      const all = mesh.userData.allIndices as number[];
      const list = near.filter((n) => all.includes(n.index)).slice(0, mesh.instanceMatrix.count);
      void nearSet;
      for (let slot = 0; slot < list.length; slot++) {
        const idx = list[slot].index;
        mesh.setMatrixAt(slot, tile.baseMatrices[idx]);
        _c.set(tile.buildings[idx].source.color ?? 0xffffff);
        mesh.setColorAt(slot, _c);
        selected.add(idx);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    if (tile.boxMesh) {
      const arr = tile.boxMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < tile.buildings.length; i++) {
        const dist = Math.hypot(tile.buildings[i].center.x - camX, tile.buildings[i].center.z - camZ);
        const show = dist <= CITY_HIDDEN_DISTANCE && !selected.has(i);
        if (show) arr.set(tile.baseMatrices[i].elements, i * 16);
        else arr.fill(0, i * 16, i * 16 + 16);
      }
      tile.boxMesh.instanceMatrix.needsUpdate = true;
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
        if (mat !== this.boxMaterial && mat !== this.windowMaterial && !Object.values(this.wallMaterials).includes(mat as THREE.MeshStandardMaterial)) mat.dispose();
      }
    });
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
