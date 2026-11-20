/**
 * cityWorld.ts — потоковая загрузка города (надёжная версия на InstancedMesh).
 * Работает без WEBGL_multi_draw: здания рисуются одним InstancedMesh на тайл.
 * LOD: детальные здания <300м, кубы 300-1500м, скрытие >1500м.
 * Frustum: тайлы вне вида камеры скрываются (но НЕ выгружаются).
 * Prefetch: коридор вперёд по вектору скорости.
 */

import * as THREE from 'three';
import type { World as RapierWorld } from '@dimforge/rapier3d-compat';

export const CITY_TILE_SIZE = 2000;
export const CITY_DETAIL_DISTANCE = 300;
export const CITY_HIDDEN_DISTANCE = 1500;

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
}

export interface CityWorldFrame {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  deltaSeconds: number;
}

export interface CityWorldOptions {
  tileSize?: number;
  onTileError?: (x: number, z: number, error: unknown) => void;
}

interface BuildingRuntime {
  source: BuildingSource;
  center: THREE.Vector3; // world
  visible: boolean;
}

interface TileRuntime {
  x: number;
  z: number;
  key: string;
  root: THREE.Group;
  bounds: THREE.Box3;
  mesh: THREE.InstancedMesh | null;
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

export class CityWorld {
  private readonly tileSize: number;
  private readonly tiles = new Map<string, TileRuntime>();
  private readonly pending = new Set<string>();
  private readonly keep = new Set<string>();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly onError?: CityWorldOptions['onTileError'];
  private readonly geom = new THREE.BoxGeometry(1, 1, 1);
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
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  }

  get loadedTileCount() { return this.tiles.size; }

  update(frame: CityWorldFrame) {
    if (this.disposed) return;
    this.camera.updateMatrixWorld();
    _pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);

    // Frustum: скрываем тайлы вне вида, но не выгружаем
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
    const aheadDist = Math.min(9000, 1500 + speed * 12);
    const ahead = new THREE.Vector3();
    if (speed > 1) {
      ahead.set(frame.velocity.x, 0, frame.velocity.z).normalize();
    } else {
      ahead.copy(frame.forward);
    }

    const want = new Set<string>();
    // 3×3 вокруг
    const tx = Math.floor(px / ts);
    const tz = Math.floor(pz / ts);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) want.add(`${tx + dx}_${tz + dz}`);
    }
    // Коридор вперёд (отдельно от frustum!)
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

    // Загрузка (не более 2 одновременно)
    let inFlight = 0;
    for (const key of want) {
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if (inFlight >= 2) break;
      inFlight++;
      this.pending.add(key);
      const [sx, sz] = key.split('_').map(Number);
      this.provider.loadTile(sx, sz)
        .then((payload) => this.addTile(sx, sz, key, payload, frame.position))
        .catch((err) => {
          this.onError?.(sx, sz, err);
        })
        .finally(() => this.pending.delete(key));
    }

    // Выгрузка далёких (кроме keep)
    for (const [key, tile] of this.tiles) {
      if (this.keep.has(key)) continue;
      const dist = Math.hypot(tile.root.position.x - px, tile.root.position.z - pz);
      if (dist > 12000) this.removeTile(key);
    }

    // LOD зданий по расстоянию до камеры
    this.camera.getWorldPosition(_p);
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) continue;
      const arr = tile.mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < tile.buildings.length; i++) {
        const b = tile.buildings[i];
        const d = Math.hypot(b.center.x - _p.x, b.center.z - _p.z);
        const show = d <= CITY_HIDDEN_DISTANCE;
        if (show === b.visible) continue;
        b.visible = show;
        const base = tile.baseMatrices[i];
        if (show) {
          arr.set(base.elements, i * 16);
        } else {
          // нулевой масштаб = скрыть инстанс
          arr.fill(0, i * 16, i * 16 + 16);
        }
      }
      tile.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private addTile(x: number, z: number, key: string, payload: CityTilePayload, player: THREE.Vector3) {
    const root = new THREE.Group();
    root.name = `tile-${key}`;
    root.position.set(x * this.tileSize, 0, z * this.tileSize);
    if (payload.roads) root.add(payload.roads);

    let mesh: THREE.InstancedMesh | null = null;
    const buildings: BuildingRuntime[] = [];
    const baseMatrices: THREE.Matrix4[] = [];

    if (payload.buildings.length > 0) {
      mesh = new THREE.InstancedMesh(this.geom, this.material, payload.buildings.length);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // LOD и frustum тайла управляем сами

      for (let i = 0; i < payload.buildings.length; i++) {
        const b = payload.buildings[i];
        // position в BuildingSource — локальная для тайла
        _p.set(b.position.x, b.size.y / 2, b.position.z);
        _q.setFromAxisAngle(_up, b.rotationY ?? 0);
        _s.set(Math.max(1, b.size.x), Math.max(2, b.size.y), Math.max(1, b.size.z));
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
        const base = _m.clone();
        baseMatrices.push(base);
        _c.set(b.color ?? 0xc8c6bd);
        mesh.setColorAt(i, _c);
        const worldX = x * this.tileSize + b.position.x;
        const worldZ = z * this.tileSize + b.position.z;
        buildings.push({
          source: b,
          center: new THREE.Vector3(worldX, b.size.y / 2, worldZ),
          visible: true,
        });
        void player;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
    }

    this.scene.add(root);
    const minX = x * this.tileSize;
    const minZ = z * this.tileSize;
    this.tiles.set(key, {
      x, z, key, root, mesh, buildings, baseMatrices,
      bounds: new THREE.Box3(
        new THREE.Vector3(minX, -100, minZ),
        new THREE.Vector3(minX + this.tileSize, 1000, minZ + this.tileSize)
      ),
      inFrustum: true,
    });
  }

  private removeTile(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.scene.remove(tile.root);
    tile.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && mesh.geometry !== this.geom) mesh.geometry.dispose();
      if (mesh.material && Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else if (mesh.material && (mesh.material as THREE.Material).dispose &&
                 (mesh.material as THREE.Material) !== this.material) {
        (mesh.material as THREE.Material).dispose();
      }
    });
    this.tiles.delete(key);
  }

  dispose() {
    this.disposed = true;
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.geom.dispose();
    this.material.dispose();
  }
}
