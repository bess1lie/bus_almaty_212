import * as THREE from 'three';
import RAPIER, {
  type Collider,
  type World as RapierWorld,
} from '@dimforge/rapier3d-compat';

/**
 * City world streaming for a Three.js r187 + Rapier city.
 *
 * Coordinate convention:
 * - world X/Z are the OSM projected ground plane (meters)
 * - world Y is up
 * - every tile is 2000 x 2000 meters
 * - BuildingSource.position is TILE-LOCAL ground position
 * - BuildingSource.geometry is TILE-LOCAL independent geometry whose base is
 *   near Y=0. It is normalized to a unit footprint/height before batching.
 *
 * The provider transfers ownership of BuildingSource.geometry and `roads`
 * to CityWorld. Do not reuse/dispose those geometries elsewhere.
 */

export const CITY_TILE_SIZE = 2_000;
export const CITY_DETAIL_DISTANCE = 300;
export const CITY_HIDDEN_DISTANCE = 1_500;

export interface BuildingSource {
  /** Tile-local position of the building footprint center, in meters. */
  position: THREE.Vector3;
  /** Full building dimensions in meters. */
  size: THREE.Vector3;
  /** Rotation around world/tile Y axis, radians. */
  rotationY?: number;
  /** Optional per-building tint. All buildings still share one material. */
  color?: THREE.ColorRepresentation;
  /** Detailed facade/roof geometry. Null means cube-only at every LOD. */
  geometry?: THREE.BufferGeometry | null;
  /** Set false to skip the local Rapier cuboid collider. Defaults to true. */
  collidable?: boolean;
}

export interface CityTilePayload {
  buildings: BuildingSource[];
  /** Existing road-ribbon group, in tile-local coordinates. */
  roads?: THREE.Object3D | null;
}

export interface CityTileProvider {
  loadTile(tileX: number, tileZ: number): Promise<CityTilePayload>;
}

export interface CityWorldOptions {
  tileSize?: number;
  maxConcurrentLoads?: number;
  streamUpdateInterval?: number;
  lodUpdateInterval?: number;
  colliderUpdateInterval?: number;
  colliderRadius?: number;
  /** Additional forward distance beyond the speed * prefetchSeconds term. */
  prefetchBaseDistance?: number;
  prefetchSeconds?: number;
  maxPrefetchDistance?: number;
  /** Half-width of the forward prefetch corridor. */
  prefetchHalfWidth?: number;
  /** Keep one tile behind the vehicle to avoid unload/reload churn. */
  rearRetentionTiles?: number;
  buildingMaterial?: THREE.MeshStandardMaterial;
  onTileError?: (tileX: number, tileZ: number, error: unknown) => void;
}

export interface CityWorldFrame {
  /** Player/vehicle world position in meters. */
  position: THREE.Vector3;
  /** Rapier linear velocity in world meters per second. */
  velocity: THREE.Vector3;
  /** Vehicle forward direction. Used while nearly stationary. */
  forward: THREE.Vector3;
  deltaSeconds: number;
}

interface TileCandidate {
  x: number;
  z: number;
  key: string;
  priority: number;
}

type BuildingLod = 'detail' | 'box' | 'hidden';

interface BuildingRuntime {
  source: BuildingSource;
  instanceId: number;
  detailGeometryId: number | null;
  lod: BuildingLod;
  worldCenter: THREE.Vector3;
  collider: Collider | null;
}

interface TileRuntime {
  x: number;
  z: number;
  key: string;
  root: THREE.Group;
  bounds: THREE.Box3;
  batch: THREE.BatchedMesh | null;
  buildings: BuildingRuntime[];
  inFrustum: boolean;
}

const _worldUp = new THREE.Vector3(0, 1, 0);
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _cameraWorldPosition = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _projectionView = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _color = new THREE.Color();

function tileKey(x: number, z: number): string {
  return `${x}:${z}`;
}

function tileBounds(x: number, z: number, tileSize: number): THREE.Box3 {
  const minX = x * tileSize;
  const minZ = z * tileSize;
  // The vertical range is intentionally generous for Almaty terrain/buildings.
  return new THREE.Box3(
    new THREE.Vector3(minX, -250, minZ),
    new THREE.Vector3(minX + tileSize, 1_000, minZ + tileSize),
  );
}

function disposeObjectGeometries(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

/**
 * Convert each building geometry to one identical BatchedMesh vertex layout:
 * indexed position/normal/uv, all Float32 attributes. The geometry is
 * normalized to X/Z [-0.5..0.5], Y [0..1], so the same instance matrix works
 * for both detailed geometry and the unit cube LOD.
 */
function makeUnitBatchGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const expanded = source.index ? source.toNonIndexed() : source.clone();
  const sourcePosition = expanded.getAttribute('position');
  if (!sourcePosition || sourcePosition.itemSize < 3) {
    expanded.dispose();
    throw new Error('Building geometry has no valid position attribute');
  }

  expanded.computeBoundingBox();
  const bounds = expanded.boundingBox ?? new THREE.Box3();
  const min = bounds.min;
  const size = bounds.getSize(new THREE.Vector3());
  const count = sourcePosition.count;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices = new Uint32Array(count);
  const sourceUv = expanded.getAttribute('uv');

  for (let i = 0; i < count; i++) {
    const x = sourcePosition.getX(i);
    const y = sourcePosition.getY(i);
    const z = sourcePosition.getZ(i);

    positions[i * 3] = size.x > 1e-5 ? (x - min.x) / size.x - 0.5 : 0;
    positions[i * 3 + 1] = size.y > 1e-5 ? (y - min.y) / size.y : 0;
    positions[i * 3 + 2] = size.z > 1e-5 ? (z - min.z) / size.z - 0.5 : 0;

    if (sourceUv) {
      uvs[i * 2] = sourceUv.getX(i);
      uvs[i * 2 + 1] = sourceUv.getY(i);
    }
    indices[i] = i;
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // Sequential indices keep every geometry indexed with the same attributes.
  result.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  expanded.dispose();
  return result;
}

function makeUnitBoxGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0); // base at Y=0, top at Y=1
  const unit = makeUnitBatchGeometry(box);
  box.dispose();
  return unit;
}

/** Pool of fixed Rapier cuboids. Colliders are disabled/reconfigured/re-enabled
 * on tile/radius changes. They are removed from Rapier only on final dispose. */
class BuildingColliderPool {
  private readonly free: Collider[] = [];
  private readonly all = new Set<Collider>();
  private readonly active = new Set<Collider>();

  constructor(private readonly world: RapierWorld) {}

  acquire(): Collider {
    let collider = this.free.pop();
    if (!collider) {
      collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setEnabled(false)
          .setFriction(0.85),
      );
      this.all.add(collider);
    }
    this.active.add(collider);
    return collider;
  }

  configure(
    collider: Collider,
    center: THREE.Vector3,
    halfExtents: THREE.Vector3,
    yaw: number,
  ): void {
    collider.setHalfExtents({
      x: Math.max(0.1, halfExtents.x),
      y: Math.max(0.1, halfExtents.y),
      z: Math.max(0.1, halfExtents.z),
    });
    collider.setTranslation({ x: center.x, y: center.y, z: center.z });
    collider.setRotation({
      x: 0,
      y: Math.sin(yaw * 0.5),
      z: 0,
      w: Math.cos(yaw * 0.5),
    });
    collider.setEnabled(true);
  }

  release(collider: Collider | null): void {
    if (!collider || !this.active.delete(collider)) return;
    collider.setEnabled(false);
    this.free.push(collider);
  }

  dispose(): void {
    for (const collider of this.all) {
      this.world.removeCollider(collider, true);
    }
    this.all.clear();
    this.active.clear();
    this.free.length = 0;
  }

  get allocatedCount(): number {
    return this.all.size;
  }
}

export class CityWorld {
  private readonly tileSize: number;
  private readonly maxConcurrentLoads: number;
  private readonly streamInterval: number;
  private readonly lodInterval: number;
  private readonly colliderInterval: number;
  private readonly colliderRadius: number;
  private readonly prefetchBase: number;
  private readonly prefetchSeconds: number;
  private readonly maxPrefetchDistance: number;
  private readonly prefetchHalfWidth: number;
  private readonly rearRetentionTiles: number;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly ownsMaterial: boolean;
  private readonly onTileError?: CityWorldOptions['onTileError'];

  private readonly tiles = new Map<string, TileRuntime>();
  private readonly queue = new Map<string, TileCandidate>();
  private readonly pending = new Set<string>();
  private readonly keepKeys = new Set<string>();
  private readonly colliderPool: BuildingColliderPool;

  private readonly frustum = new THREE.Frustum();
  private readonly projectionView = new THREE.Matrix4();
  private streamTimer = 0;
  private lodTimer = 0;
  private colliderTimer = 0;
  private inFlight = 0;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly provider: CityTileProvider,
    rapierWorld: RapierWorld,
    options: CityWorldOptions = {},
  ) {
    this.tileSize = options.tileSize ?? CITY_TILE_SIZE;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 2;
    this.streamInterval = options.streamUpdateInterval ?? 0.25;
    this.lodInterval = options.lodUpdateInterval ?? 0.2;
    this.colliderInterval = options.colliderUpdateInterval ?? 0.4;
    this.colliderRadius = options.colliderRadius ?? 450;
    this.prefetchBase = options.prefetchBaseDistance ?? this.tileSize * 1.5;
    this.prefetchSeconds = options.prefetchSeconds ?? 18;
    this.maxPrefetchDistance = options.maxPrefetchDistance ?? 12_000;
    this.prefetchHalfWidth = options.prefetchHalfWidth ?? this.tileSize * 0.65;
    this.rearRetentionTiles = options.rearRetentionTiles ?? 1;
    this.ownsMaterial = options.buildingMaterial === undefined;
    this.material = options.buildingMaterial ?? new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
    });
    this.onTileError = options.onTileError;
    this.colliderPool = new BuildingColliderPool(rapierWorld);
  }

  /** Call once per rendered frame after updating the player/camera transforms. */
  update(frame: CityWorldFrame): void {
    if (this.disposed) return;

    this.updateFrustum();
    this.updateTileVisibility();

    this.streamTimer += frame.deltaSeconds;
    if (this.streamTimer >= this.streamInterval) {
      this.streamTimer = 0;
      this.updateStreaming(frame);
      this.pumpLoadQueue();
    }

    this.lodTimer += frame.deltaSeconds;
    if (this.lodTimer >= this.lodInterval) {
      this.lodTimer = 0;
      this.camera.getWorldPosition(_cameraWorldPosition);
      this.updateBuildingLods(_cameraWorldPosition);
    }

    this.colliderTimer += frame.deltaSeconds;
    if (this.colliderTimer >= this.colliderInterval) {
      this.colliderTimer = 0;
      this.updateBuildingColliders(frame.position);
    }
  }

  /** Number of loaded 2 km tiles, useful for a debug HUD. */
  get loadedTileCount(): number {
    return this.tiles.size;
  }

  /** Number of Rapier colliders allocated by the pool (active + reusable). */
  get pooledColliderCount(): number {
    return this.colliderPool.allocatedCount;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.clear();
    this.keepKeys.clear();

    for (const tile of this.tiles.values()) this.unmountTile(tile);
    this.tiles.clear();
    this.colliderPool.dispose();

    if (this.ownsMaterial) this.material.dispose();
  }

  private updateFrustum(): void {
    this.camera.updateMatrixWorld(true);
    this.projectionView.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(
      this.projectionView,
      this.camera.coordinateSystem,
      this.camera.reversedDepth,
    );
  }

  private updateTileVisibility(): void {
    for (const tile of this.tiles.values()) {
      tile.inFrustum = this.frustum.intersectsBox(tile.bounds);
      tile.root.visible = tile.inFrustum;
    }
  }

  private updateStreaming(frame: CityWorldFrame): void {
    _forward.copy(frame.velocity).setY(0);
    const speed = _forward.length();
    if (speed > 1.5) {
      _forward.multiplyScalar(1 / speed);
    } else {
      _forward.copy(frame.forward).setY(0);
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
      _forward.normalize();
    }

    const lookAhead = THREE.MathUtils.clamp(
      this.prefetchBase + speed * this.prefetchSeconds,
      this.tileSize * 1.5,
      this.maxPrefetchDistance,
    );
    const corridorWidth = this.prefetchHalfWidth;
    const tileRadius = Math.SQRT2 * this.tileSize * 0.5;
    const endX = frame.position.x + _forward.x * lookAhead;
    const endZ = frame.position.z + _forward.z * lookAhead;
    this.camera.getWorldPosition(_cameraWorldPosition);

    // Scan the union of the forward velocity corridor and the camera's
    // useful view area. Frustum tests below reject cells behind the camera.
    const viewRadius = Math.min(this.maxPrefetchDistance, this.tileSize * 6);
    const minX = Math.min(frame.position.x, endX, _cameraWorldPosition.x - viewRadius);
    const maxX = Math.max(frame.position.x, endX, _cameraWorldPosition.x + viewRadius);
    const minZ = Math.min(frame.position.z, endZ, _cameraWorldPosition.z - viewRadius);
    const maxZ = Math.max(frame.position.z, endZ, _cameraWorldPosition.z + viewRadius);

    const minTileX = Math.floor((minX - corridorWidth - tileRadius) / this.tileSize);
    const maxTileX = Math.floor((maxX + corridorWidth + tileRadius) / this.tileSize);
    const minTileZ = Math.floor((minZ - corridorWidth - tileRadius) / this.tileSize);
    const maxTileZ = Math.floor((maxZ + corridorWidth + tileRadius) / this.tileSize);

    this.keepKeys.clear();
    this.queue.clear();

    const candidates: TileCandidate[] = [];
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let tz = minTileZ; tz <= maxTileZ; tz++) {
        const key = tileKey(tx, tz);
        const centerX = (tx + 0.5) * this.tileSize;
        const centerZ = (tz + 0.5) * this.tileSize;
        const dx = centerX - frame.position.x;
        const dz = centerZ - frame.position.z;
        const along = dx * _forward.x + dz * _forward.z;
        const lateral = Math.abs(dx * _forward.z - dz * _forward.x);

        // Forward corridor plus one tile-radius tolerance for tile corners.
        const inForwardCorridor =
          along >= -tileRadius &&
          along <= lookAhead + tileRadius &&
          lateral <= corridorWidth + tileRadius;

        const bounds = tileBounds(tx, tz, this.tileSize);
        const inView = this.frustum.intersectsBox(bounds);
        const isCurrent = tx === Math.floor(frame.position.x / this.tileSize) &&
          tz === Math.floor(frame.position.z / this.tileSize);

        // Load if visible OR inside the movement corridor. A tile behind the
        // camera is not loaded unless the bus is physically travelling there.
        if (!inView && !inForwardCorridor && !isCurrent) continue;

        this.keepKeys.add(key);
        const priority = (inView ? 0 : 10_000) +
          Math.max(0, along) * 0.001 + lateral * 0.0001;
        candidates.push({ x: tx, z: tz, key, priority });
      }
    }

    // Always retain the tile containing the vehicle.
    const currentX = Math.floor(frame.position.x / this.tileSize);
    const currentZ = Math.floor(frame.position.z / this.tileSize);
    const currentKey = tileKey(currentX, currentZ);
    this.keepKeys.add(currentKey);
    if (!this.tiles.has(currentKey) && !this.pending.has(currentKey)) {
      candidates.push({ x: currentX, z: currentZ, key: currentKey, priority: -1 });
    }

    candidates.sort((a, b) => a.priority - b.priority);
    for (const candidate of candidates) {
      if (!this.tiles.has(candidate.key) && !this.pending.has(candidate.key)) {
        this.queue.set(candidate.key, candidate);
      }
    }

    // Keep loaded tiles briefly behind the vehicle. This avoids thrashing when
    // crossing a tile boundary or braking/reversing near the border.
    const retainDistance = lookAhead + this.tileSize * (1 + this.rearRetentionTiles);
    for (const [key, tile] of this.tiles) {
      if (this.keepKeys.has(key) || tile.inFrustum) continue;
      const cx = (tile.x + 0.5) * this.tileSize;
      const cz = (tile.z + 0.5) * this.tileSize;
      const dx = cx - frame.position.x;
      const dz = cz - frame.position.z;
      const along = dx * _forward.x + dz * _forward.z;
      const lateral = Math.abs(dx * _forward.z - dz * _forward.x);
      const retainedBehind = along >= -this.tileSize * this.rearRetentionTiles - tileRadius &&
        along <= retainDistance &&
        lateral <= this.prefetchHalfWidth + tileRadius;
      if (retainedBehind) this.keepKeys.add(key);
      else this.unmountTile(tile);
      if (!retainedBehind) this.tiles.delete(key);
    }
  }

  private pumpLoadQueue(): void {
    if (this.disposed) return;
    while (this.inFlight < this.maxConcurrentLoads && this.queue.size > 0) {
      let next: TileCandidate | undefined;
      for (const candidate of this.queue.values()) {
        if (!next || candidate.priority < next.priority) next = candidate;
      }
      if (!next) return;
      this.queue.delete(next.key);
      if (this.tiles.has(next.key) || this.pending.has(next.key)) continue;

      this.pending.add(next.key);
      this.inFlight++;
      void this.provider.loadTile(next.x, next.z)
        .then((payload) => {
          if (this.disposed || !this.keepKeys.has(next!.key)) {
            this.disposePayload(payload);
            return;
          }
          try {
            const tile = this.mountTile(next!, payload);
            this.tiles.set(tile.key, tile);
          } catch (error) {
            this.disposePayload(payload);
            this.onTileError?.(next!.x, next!.z, error);
          }
        })
        .catch((error: unknown) => {
          this.onTileError?.(next!.x, next!.z, error);
        })
        .finally(() => {
          this.pending.delete(next!.key);
          this.inFlight--;
          this.pumpLoadQueue();
        });
    }
  }

  private mountTile(candidate: TileCandidate, payload: CityTilePayload): TileRuntime {
    const root = new THREE.Group();
    root.name = `city-tile-${candidate.key}`;
    root.position.set(candidate.x * this.tileSize, 0, candidate.z * this.tileSize);

    if (payload.roads) root.add(payload.roads);

    const batchResult = this.buildBuildingBatch(payload.buildings);
    if (batchResult.batch) root.add(batchResult.batch);

    this.scene.add(root);
    const tile: TileRuntime = {
      x: candidate.x,
      z: candidate.z,
      key: candidate.key,
      root,
      bounds: tileBounds(candidate.x, candidate.z, this.tileSize),
      batch: batchResult.batch,
      buildings: batchResult.buildings,
      inFrustum: false,
    };
    tile.inFrustum = this.frustum.intersectsBox(tile.bounds);
    tile.root.visible = tile.inFrustum;
    return tile;
  }

  private buildBuildingBatch(sources: BuildingSource[]): {
    batch: THREE.BatchedMesh | null;
    buildings: BuildingRuntime[];
  } {
    if (sources.length === 0) return { batch: null, buildings: [] };

    const unitBox = makeUnitBoxGeometry();
    const normalizedDetails: Array<THREE.BufferGeometry | null> = [];
    let maxVertices = unitBox.getAttribute('position').count;
    let maxIndices = unitBox.index?.count ?? 0;

    try {
      for (const source of sources) {
        if (source.geometry) {
          const normalized = makeUnitBatchGeometry(source.geometry);
          normalizedDetails.push(normalized);
          maxVertices += normalized.getAttribute('position').count;
          maxIndices += normalized.index?.count ?? 0;
          // The tile provider transfers geometry ownership to this module.
          source.geometry.dispose();
        } else {
          normalizedDetails.push(null);
        }
      }

      const batch = new THREE.BatchedMesh(
        sources.length,
        maxVertices,
        maxIndices,
        this.material,
      );
      batch.name = 'city-buildings-batched';
      batch.frustumCulled = true;
      batch.perObjectFrustumCulled = true;
      batch.sortObjects = false;

      const boxGeometryId = batch.addGeometry(unitBox);
      const runtimes: BuildingRuntime[] = [];

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const detailGeometry = normalizedDetails[i];
        const detailGeometryId = detailGeometry ? batch.addGeometry(detailGeometry) : null;
        const initialGeometryId = detailGeometryId ?? boxGeometryId;
        const instanceId = batch.addInstance(initialGeometryId);

        const width = Math.max(1, source.size.x);
        const height = Math.max(2, source.size.y);
        const depth = Math.max(1, source.size.z);
        const yaw = source.rotationY ?? 0;

        _position.set(source.position.x, source.position.y, source.position.z);
        _quaternion.setFromAxisAngle(_worldUp, yaw);
        _scale.set(width, height, depth);
        _matrix.compose(_position, _quaternion, _scale);
        batch.setMatrixAt(instanceId, _matrix);

        _color.set(source.color ?? 0xc8c6bd);
        batch.setColorAt(instanceId, _color);

        runtimes.push({
          source,
          instanceId,
          detailGeometryId,
          lod: detailGeometryId === null ? 'box' : 'detail',
          worldCenter: new THREE.Vector3(
            source.position.x,
            source.position.y + height * 0.5,
            source.position.z,
          ),
          collider: null,
        });
      }

      batch.computeBoundingBox();
      batch.computeBoundingSphere();
      return { batch, buildings: runtimes };
    } finally {
      unitBox.dispose();
      for (const geometry of normalizedDetails) geometry?.dispose();
    }
  }

  private updateBuildingLods(cameraWorldPosition: THREE.Vector3): void {
    for (const tile of this.tiles.values()) {
      if (!tile.batch) continue;

      const batch = tile.batch;
      for (const building of tile.buildings) {
        _center.set(
          tile.root.position.x + building.worldCenter.x,
          tile.root.position.y + building.worldCenter.y,
          tile.root.position.z + building.worldCenter.z,
        );
        const distanceSq = _center.distanceToSquared(cameraWorldPosition);
        const distance = Math.sqrt(distanceSq);

        let nextLod: BuildingLod;
        if (distance > CITY_HIDDEN_DISTANCE) {
          nextLod = 'hidden';
        } else if (distance > CITY_DETAIL_DISTANCE) {
          nextLod = 'box';
        } else {
          nextLod = building.detailGeometryId === null ? 'box' : 'detail';
        }

        if (nextLod === building.lod) continue;
        if (nextLod === 'hidden') {
          batch.setVisibleAt(building.instanceId, false);
        } else {
          const geometryId = nextLod === 'detail'
            ? building.detailGeometryId!
            : this.getUnitBoxGeometryId(batch);
          batch.setGeometryIdAt(building.instanceId, geometryId);
          batch.setVisibleAt(building.instanceId, true);
        }
        building.lod = nextLod;
      }
    }
  }

  /** The first geometry registered in every tile batch is always the unit box. */
  private getUnitBoxGeometryId(_batch: THREE.BatchedMesh): number {
    return 0;
  }

  private updateBuildingColliders(playerPosition: THREE.Vector3): void {
    const radiusSq = this.colliderRadius * this.colliderRadius;

    for (const tile of this.tiles.values()) {
      for (const building of tile.buildings) {
        const source = building.source;
        if (source.collidable === false) {
          if (building.collider) {
            this.colliderPool.release(building.collider);
            building.collider = null;
          }
          continue;
        }

        const width = Math.max(1, source.size.x);
        const height = Math.max(2, source.size.y);
        const depth = Math.max(1, source.size.z);
        const worldX = tile.root.position.x + source.position.x;
        const worldZ = tile.root.position.z + source.position.z;
        const centerY = tile.root.position.y + source.position.y + height * 0.5;
        const dx = worldX - playerPosition.x;
        const dy = centerY - playerPosition.y;
        const dz = worldZ - playerPosition.z;
        const near = dx * dx + dy * dy + dz * dz <= radiusSq;

        if (near && !building.collider) {
          building.collider = this.colliderPool.acquire();
          this.colliderPool.configure(
            building.collider,
            new THREE.Vector3(worldX, centerY, worldZ),
            new THREE.Vector3(width * 0.5, height * 0.5, depth * 0.5),
            source.rotationY ?? 0,
          );
        } else if (!near && building.collider) {
          this.colliderPool.release(building.collider);
          building.collider = null;
        }
      }
    }
  }

  private unmountTile(tile: TileRuntime): void {
    for (const building of tile.buildings) {
      this.colliderPool.release(building.collider);
      building.collider = null;
    }
    this.scene.remove(tile.root);
    if (tile.batch) tile.batch.dispose();
    tile.root.traverse((object) => {
      if (object !== tile.batch) {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      }
    });
  }

  private disposePayload(payload: CityTilePayload): void {
    for (const building of payload.buildings) building.geometry?.dispose();
    if (payload.roads) disposeObjectGeometries(payload.roads);
  }
}
