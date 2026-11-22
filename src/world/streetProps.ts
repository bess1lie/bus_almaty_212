import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRadialShadowTexture, getTextures } from './textures';

/** A point is [X, Z]. X=east, Z=south, Y=up. */
export type StreetPoint = readonly [number, number];
export type StreetStopModel = 'soviet' | 'modern';

/** OSM road centreline. Points are tile-local by default. */
export interface StreetRoadInput {
  id?: string;
  points: readonly StreetPoint[];
  width?: number;
  coordinateSpace?: 'tile' | 'world';
  sidewalks?: boolean;
  markings?: boolean;
}

/** Green polygon. Points are tile-local by default. */
export interface StreetGreenZoneInput {
  id?: string;
  points: readonly StreetPoint[];
  coordinateSpace?: 'tile' | 'world';
}

export interface StreetStopInput {
  position: StreetPoint;
  yaw?: number;
  model?: StreetStopModel;
  coordinateSpace?: 'tile' | 'world';
}

/**
 * Optional spatial metadata for a loaded 2000 m tile.
 * Tile x/z are integer grid coordinates, matching CityWorld's "x:z" keys.
 */
export interface StreetTileDescriptor {
  key?: string;
  x: number;
  z: number;
  roads?: readonly StreetRoadInput[];
  greenZones?: readonly StreetGreenZoneInput[];
  stops?: readonly StreetStopInput[];
  /** Реальные контуры зданий из OSM — нужны, чтобы не ставить деревья в стены. */
  buildings?: ReadonlyArray<{ points: readonly StreetPoint[] }>;
  version?: string | number;
}

export type StreetTileKey = string | StreetTileDescriptor;

/**
 * Existing getTileKeys() functions returning string[] work unchanged.
 * For accurate OSM placement, return descriptors or expose getTileData(key).
 */
export interface StreetTileKeyProvider {
  (): Iterable<StreetTileKey>;
  getTileData?: (key: string) => StreetTileDescriptor | undefined;
}

export interface StreetPropsOptions {
  /** На слабых устройствах CC0-модели не загружаются — остаются примитивы. */
  detailedModels?: boolean;
}

export interface StreetPropsController {
  update(cameraPos: THREE.Vector3, dt?: number): void;
  dispose(): void;
  getStats(): {
    tiles: number; trees: number; lamps: number; sidewalks: number;
    lines: number; stops: number; modelTrees: number; modelLamps: number;
  };
}

const TILE_SIZE = 2000;
const VIEW_DISTANCE = 600;
const VIEW_DISTANCE_SQ = VIEW_DISTANCE * VIEW_DISTANCE;
const MAX_TREES = 1500;
const MAX_LAMPS = 400;
const MAX_POINT_LIGHTS = 5;
const MAX_TRIANGLES = 30_000;
const MAX_STOPS_VISIBLE = 12;
// CC0-модели только для ближних объектов: остальные остаются дешёвыми примитивами.
const DETAIL_TREE_CAPACITY = 18;
const DETAIL_LAMP_CAPACITY = 8;
const DETAIL_TREE_TRIANGLE_BUDGET = 36_000;
const DETAIL_LAMP_TRIANGLE_BUDGET = 8_000;
const MAX_STOP_INSTANCES = 128;
const MAX_SIDEWALK_INSTANCES = 12_000;
const MAX_LINE_SEGMENTS = 24_000;
const ROAD_Y = 0.085;
const SIDEWALK_Y = 0.06;
const EPSILON = 1e-5;

const TREE_GREEN = ['#477D50', '#568D59', '#6A9B61'];
const TREE_GREEN_COLORS = TREE_GREEN.map((color) => new THREE.Color(color));
const TREE_TRUNK = '#72513B';
const LAMP_METAL = '#414B50';
const LAMP_WARM = '#F3C77B';
const ROAD_LINE_COLOR = '#F1EEE5';

interface WorldRoad {
  id: string;
  points: THREE.Vector2[];
  width: number;
  sidewalks: boolean;
  markings: boolean;
}

interface CityModelBatch {
  mesh: THREE.InstancedMesh;
  triangles: number;
}

interface TreeCandidate {
  x: number;
  z: number;
  height: number;
  crownRadius: number;
  shade: number;
  seed: number;
}

interface LampCandidate {
  x: number;
  z: number;
  height: number;
  yaw: number;
  seed: number;
}

interface SidewalkCandidate {
  x: number;
  z: number;
  length: number;
  yaw: number;
}

interface LineCandidate {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

interface StopCandidate {
  x: number;
  z: number;
  yaw: number;
  model: StreetStopModel;
  seed: number;
}

interface RuntimeTileData {
  key: string;
  x: number;
  z: number;
  roads: WorldRoad[];
  greenZones: THREE.Vector2[][];
  stops: StopCandidate[];
  buildingBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
}

interface FlattenedModel {
  geometry: THREE.BufferGeometry;
  triangles: number;
  hasAlpha: boolean;
}

function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

function random01(seed: number, salt = 0): number {
  let x = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function parseTileKey(key: string): { x: number; z: number } | null {
  // CityWorld uses `${tileX}:${tileZ}`. Commas are accepted for convenience.
  const match = /^\s*(-?\d+)\s*[:,]\s*(-?\d+)\s*$/.exec(key);
  if (!match) return null;
  return { x: Number(match[1]), z: Number(match[2]) };
}

function getGridOrigin(scene: THREE.Scene): THREE.Vector2 {
  const raw = scene.userData.cityGridOrigin as
    | THREE.Vector3
    | { x?: number; z?: number }
    | undefined;
  return new THREE.Vector2(Number(raw?.x ?? 0), Number(raw?.z ?? 0));
}

function lookupTileData(scene: THREE.Scene, key: string): StreetTileDescriptor | undefined {
  const source = scene.userData.streetTileData as
    | Map<string, StreetTileDescriptor>
    | Record<string, StreetTileDescriptor>
    | undefined;
  if (!source) return undefined;
  if (source instanceof Map) return source.get(key);
  return source[key];
}

function pointInPolygon(x: number, z: number, polygon: readonly THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > z) !== (b.y > z)
      && x < ((b.x - a.x) * (z - a.y)) / ((b.y - a.y) || EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distancePointToSegmentSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < EPSILON) {
    const ox = px - ax;
    const oz = pz - az;
    return ox * ox + oz * oz;
  }
  const t = THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1);
  const ox = px - (ax + dx * t);
  const oz = pz - (az + dz * t);
  return ox * ox + oz * oz;
}

function roadDistanceSq(x: number, z: number, roads: readonly WorldRoad[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const road of roads) {
    const exclusion = road.width * 0.5 + 2.5;
    const exclusionSq = exclusion * exclusion;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const d = distancePointToSegmentSq(x, z, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
      if (best <= exclusionSq) return best;
    }
  }
  return best;
}

function makeWorldPoint(
  point: StreetPoint,
  isWorld: boolean,
  tileX: number,
  tileZ: number,
  gridOrigin: THREE.Vector2,
): THREE.Vector2 {
  if (isWorld) return new THREE.Vector2(point[0], point[1]);
  return new THREE.Vector2(
    gridOrigin.x + tileX * TILE_SIZE + point[0],
    gridOrigin.y + tileZ * TILE_SIZE + point[1],
  );
}

function disposeObjectAssets(root: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || disposedMaterials.has(material)) continue;
      disposedMaterials.add(material);
      for (const value of Object.values(material)) {
        if (value && (value as THREE.Texture).isTexture) {
          const texture = value as THREE.Texture;
          if (!disposedTextures.has(texture)) {
            disposedTextures.add(texture);
            const image = texture.source?.data as { close?: () => void } | undefined;
            if (typeof image?.close === 'function') image.close();
            texture.dispose();
          }
        }
      }
      material.dispose();
    }
  });
}

/** Flatten a GLB scene into one geometry with vertex colors and no material groups. */
function flattenGLTFScene(root: THREE.Object3D): FlattenedModel {
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const normalMatrix = new THREE.Matrix3();
  let hasAlpha = false;
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const white = new THREE.Color(0xffffff);

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const source = mesh.geometry.toNonIndexed();
    const pos = source.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    if (!source.getAttribute('normal')) source.computeVertexNormals();
    const normalAttr = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const colorAttr = source.getAttribute('color') as THREE.BufferAttribute | undefined;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const vertexMaterial = new Int32Array(pos.count);
    if (source.groups.length > 0) {
      for (const group of source.groups) {
        const start = Math.max(0, group.start);
        const end = Math.min(pos.count, group.start + group.count);
        for (let i = start; i < end; i++) vertexMaterial[i] = group.materialIndex ?? 0;
      }
    }

    const transform = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
    normalMatrix.getNormalMatrix(transform);

    for (let i = 0; i < pos.count; i++) {
      point.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(transform);
      positions.push(point.x, point.y, point.z);

      if (normalAttr) {
        normal.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
        normal.applyMatrix3(normalMatrix).normalize();
      } else {
        normal.set(0, 1, 0);
      }
      normals.push(normal.x, normal.y, normal.z);

      const material = materials[vertexMaterial[i]] as
        | (THREE.Material & { color?: THREE.Color; opacity?: number; transparent?: boolean })
        | undefined;
      const baseColor = material?.color ?? white;
      const color = baseColor.clone();
      if (colorAttr) {
        // glTFLoader exposes vertex colors in Linear-sRGB already.
        color.multiply(new THREE.Color().setRGB(
          colorAttr.getX(i),
          colorAttr.getY(i),
          colorAttr.getZ(i),
        ));
      }
      const materialAlpha = material?.opacity ?? 1;
      const vertexAlpha = colorAttr && colorAttr.itemSize >= 4 ? colorAttr.getW(i) : 1;
      const alpha = THREE.MathUtils.clamp(materialAlpha * vertexAlpha, 0, 1);
      if (alpha < 0.999 || material?.transparent) hasAlpha = true;
      colors.push(color.r, color.g, color.b, alpha);
    }

    // Dispose a temporary non-indexed clone. The original GLB geometry is disposed
    // after the full flattening pass in loadStopModels().
    if (source !== mesh.geometry) source.dispose();
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, triangles: Math.floor(positions.length / 9), hasAlpha };
}

function updateInstancedMesh(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.visible = count > 0;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
}

function urlForPublicAsset(path: string): string {
  const base = document.querySelector('base')?.href ?? document.baseURI;
  return new URL(path, base).toString();
}

/**
 * Creates city street props. Draw-call budget: 8 render meshes total
 * (tree trunk/crown, lamp pole/head, sidewalk, one LineSegments, two stop batches).
 * At most five dynamic PointLights are ever created.
 */
export function createStreetProps(
  scene: THREE.Scene,
  getTileKeys: StreetTileKeyProvider,
  options: StreetPropsOptions = {},
): StreetPropsController {
  const gridOrigin = getGridOrigin(scene);
  const loader = new GLTFLoader();
  const scratchObject = new THREE.Object3D();
  const allTrees: TreeCandidate[] = [];
  const allLamps: LampCandidate[] = [];
  const allSidewalks: SidewalkCandidate[] = [];
  const allLines: LineCandidate[] = [];
  const allStops: StopCandidate[] = [];
  const pointLights: THREE.PointLight[] = [];

  let trunkGeometry: THREE.BufferGeometry;
  let crownGeometry: THREE.BufferGeometry;
  let lampPoleGeometry: THREE.BufferGeometry;
  let lampHeadGeometry: THREE.BufferGeometry;
  let sidewalkGeometry: THREE.BufferGeometry;
  let trunkMaterial: THREE.MeshStandardMaterial;
  let crownMaterial: THREE.MeshStandardMaterial;
  let lampPoleMaterial: THREE.MeshStandardMaterial;
  let lampHeadMaterial: THREE.MeshStandardMaterial;
  let sidewalkMaterial: THREE.MeshStandardMaterial;
  let lineMaterial: THREE.LineBasicMaterial;
  let treeTrunks: THREE.InstancedMesh;
  let treeCrowns: THREE.InstancedMesh;
  let lampPoles: THREE.InstancedMesh;
  let lampHeads: THREE.InstancedMesh;
  let lampPools: THREE.InstancedMesh;
  let sidewalks: THREE.InstancedMesh;
  let roadLines: THREE.LineSegments;
  let linePositionAttribute: THREE.BufferAttribute;
  let sovietStopMesh: THREE.InstancedMesh | undefined;
  let modernStopMesh: THREE.InstancedMesh | undefined;
  let sovietStopTriangles = 0;
  let modernStopTriangles = 0;
  let disposed = false;
  let tileSignature = '';
  const lastCamera = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  let refreshElapsed = Number.POSITIVE_INFINITY;
  let sourceStopReady = false;
  const modelTrees: CityModelBatch[] = [];
  let modelLamp: CityModelBatch | null = null;
  let modelMaterial: THREE.MeshStandardMaterial | null = null;

  // Low-poly geometries are deliberately tiny to keep the full module under 30k tris.
  trunkGeometry = new THREE.CylinderGeometry(0.14, 0.18, 1, 3, 1, true); // 6 tris
  crownGeometry = new THREE.ConeGeometry(1, 1, 3, 1, true); // 6 side tris, open base
  lampPoleGeometry = new THREE.CylinderGeometry(0.055, 0.075, 1, 3, 1, true); // 6 tris
  lampHeadGeometry = new THREE.ConeGeometry(0.19, 0.32, 3, 1, true); // 6 side tris
  lampHeadGeometry.rotateX(Math.PI); // Cone points down from the lamp head.
  sidewalkGeometry = new THREE.PlaneGeometry(1, 1);
  sidewalkGeometry.rotateX(-Math.PI / 2);

  trunkMaterial = new THREE.MeshStandardMaterial({ color: TREE_TRUNK, roughness: 1, metalness: 0 });
  crownMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  lampPoleMaterial = new THREE.MeshStandardMaterial({ color: LAMP_METAL, roughness: 0.9, metalness: 0.25 });
  lampHeadMaterial = new THREE.MeshStandardMaterial({
    color: LAMP_WARM,
    emissive: 0x000000,
    emissiveIntensity: 0,
    roughness: 0.65,
    metalness: 0.05,
  });
  const sidewalkTex = getTextures();
  sidewalkMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    map: sidewalkTex.sidewalk,
    normalMap: sidewalkTex.pbr.sidewalk.nor,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: sidewalkTex.pbr.sidewalk.rough,
  });
  lineMaterial = new THREE.LineBasicMaterial({ color: ROAD_LINE_COLOR, transparent: true, opacity: 0.9 });

  function makeInstanced(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false; // Matrices are compacted to the 600 m active radius each update.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  treeTrunks = makeInstanced(trunkGeometry, trunkMaterial, MAX_TREES, 'street-tree-trunks');
  treeCrowns = makeInstanced(crownGeometry, crownMaterial, MAX_TREES, 'street-tree-crowns');
  lampPoles = makeInstanced(lampPoleGeometry, lampPoleMaterial, MAX_LAMPS, 'street-lamp-poles');
  lampHeads = makeInstanced(lampHeadGeometry, lampHeadMaterial, MAX_LAMPS, 'street-lamp-heads');
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({
    color: 0xf0a35f, alphaMap: createRadialShadowTexture(), transparent: true,
    opacity: 0.22, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1,
  });
  lampPools = makeInstanced(poolGeo, poolMat, MAX_LAMPS, 'street-lamp-pools');
  sidewalks = makeInstanced(sidewalkGeometry, sidewalkMaterial, 1, 'street-sidewalks');
  sidewalks.frustumCulled = false;

  const lineGeometry = new THREE.BufferGeometry();
  linePositionAttribute = new THREE.BufferAttribute(new Float32Array(MAX_LINE_SEGMENTS * 2 * 3), 3);
  linePositionAttribute.setUsage(THREE.DynamicDrawUsage);
  lineGeometry.setAttribute('position', linePositionAttribute);
  lineGeometry.setDrawRange(0, 0);
  roadLines = new THREE.LineSegments(lineGeometry, lineMaterial);
  roadLines.name = 'street-road-markings';
  roadLines.frustumCulled = false;

  scene.add(treeTrunks, treeCrowns, lampPoles, lampHeads, lampPools, sidewalks, roadLines);

  for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
    const light = new THREE.PointLight(0xffd18a, 6, 34, 2);
    light.name = `street-lamp-point-${i + 1}`;
    light.castShadow = false;
    light.visible = false;
    pointLights.push(light);
    scene.add(light);
  }

  function normalizeTile(raw: StreetTileKey): RuntimeTileData | null {
    let descriptor: StreetTileDescriptor | undefined;
    let key: string;
    let x: number;
    let z: number;

    if (typeof raw === 'string') {
      key = raw;
      descriptor = getTileKeys.getTileData?.(key) ?? lookupTileData(scene, key);
      const parsed = parseTileKey(key);
      if (descriptor) {
        x = descriptor.x;
        z = descriptor.z;
      } else if (parsed) {
        x = parsed.x;
        z = parsed.z;
      } else {
        return null;
      }
    } else {
      descriptor = raw;
      x = raw.x;
      z = raw.z;
      key = raw.key ?? `${x}:${z}`;
    }

    const roads: WorldRoad[] = [];
    for (let roadIndex = 0; roadIndex < (descriptor?.roads?.length ?? 0); roadIndex++) {
      const input = descriptor!.roads![roadIndex];
      if (!input.points || input.points.length < 2) continue;
      const points = input.points.map((p) => makeWorldPoint(
        p,
        input.coordinateSpace === 'world',
        x,
        z,
        gridOrigin,
      ));
      roads.push({
        id: input.id ?? `${key}:road:${roadIndex}`,
        points,
        width: THREE.MathUtils.clamp(input.width ?? 9, 3, 40),
        sidewalks: input.sidewalks !== false,
        markings: input.markings !== false,
      });
    }

    const greenZones: THREE.Vector2[][] = [];
    for (const zone of descriptor?.greenZones ?? []) {
      if (zone.points.length < 3) continue;
      greenZones.push(zone.points.map((p) => makeWorldPoint(
        p,
        zone.coordinateSpace === 'world',
        x,
        z,
        gridOrigin,
      )));
    }

    const stops: StopCandidate[] = [];
    for (let i = 0; i < (descriptor?.stops?.length ?? 0); i++) {
      const stop = descriptor!.stops![i];
      const p = makeWorldPoint(
        stop.position,
        stop.coordinateSpace === 'world',
        x,
        z,
        gridOrigin,
      );
      const seed = hash32(`${key}:stop:${i}`);
      stops.push({
        x: p.x,
        z: p.y,
        yaw: stop.yaw ?? 0,
        model: stop.model ?? (random01(seed) < 0.5 ? 'soviet' : 'modern'),
        seed,
      });
    }

    // Стоп-линия перед остановкой (перпендикулярно дороге)
    for (const stop of stops) {
      const nx = -Math.sin(stop.yaw), nz = Math.cos(stop.yaw);
      const hw = 4.5;
      addLine(
        stop.x - nx * hw + Math.cos(stop.yaw) * 3, stop.z - nz * hw + Math.sin(stop.yaw) * 3,
        stop.x + nx * hw + Math.cos(stop.yaw) * 3, stop.z + nz * hw + Math.sin(stop.yaw) * 3,
      );
    }

    // A tile contains at most two explicitly supplied stop placements.
    if (stops.length > 2) stops.length = 2;

    // If stop points were not supplied, put 1-2 stops on long road segments, outside the carriageway.
    if (stops.length === 0 && roads.length > 0) {
      const roadLengths = roads.map((road) => {
        let length = 0;
        for (let i = 0; i < road.points.length - 1; i++) length += road.points[i].distanceTo(road.points[i + 1]);
        return { road, length };
      }).filter((item) => item.length >= 120).sort((a, b) => b.length - a.length);
      const stopCount = Math.min(2, roadLengths.length);
      for (let i = 0; i < stopCount; i++) {
        const { road } = roadLengths[i];
        const segment = road.points[Math.floor((road.points.length - 2) * 0.5)];
        const next = road.points[Math.min(road.points.length - 1, Math.floor((road.points.length - 2) * 0.5) + 1)];
        const direction = next.clone().sub(segment).normalize();
        const side = random01(hash32(`${key}:stop-side:${i}`)) < 0.5 ? -1 : 1;
        const offset = road.width * 0.5 + 3.0;
        const p = new THREE.Vector2(
          (segment.x + next.x) * 0.5 - direction.y * offset * side,
          (segment.y + next.y) * 0.5 + direction.x * offset * side,
        );
        const seed = hash32(`${key}:auto-stop:${i}`);
        stops.push({
          x: p.x,
          z: p.y,
          yaw: Math.atan2(direction.x, direction.y),
          model: random01(seed) < 0.5 ? 'soviet' : 'modern',
          seed,
        });
      }
    }

    const buildingBoxes = (descriptor?.buildings ?? []).map((b) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of b.points) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      }
      return { minX, maxX, minZ, maxZ };
    }).filter((b) => Number.isFinite(b.minX) && b.maxX > b.minX && b.maxZ > b.minZ);
    return { key, x, z, roads, greenZones, stops, buildingBoxes };
  }

  function addLine(ax: number, az: number, bx: number, bz: number): void {
    allLines.push({ ax, az, bx, bz });
  }

  function addRoadProps(tile: RuntimeTileData): void {
    const insideBuilding = (x: number, z: number, margin: number): boolean => {
      for (const b of tile.buildingBoxes) {
        if (x > b.minX - margin && x < b.maxX + margin &&
            z > b.minZ - margin && z < b.maxZ + margin) return true;
      }
      return false;
    };
    for (const road of tile.roads) {
      let cumulative = 0;
      for (let segmentIndex = 0; segmentIndex < road.points.length - 1; segmentIndex++) {
        const a = road.points[segmentIndex];
        const b = road.points[segmentIndex + 1];
        const dx = b.x - a.x;
        const dz = b.y - a.y;
        const length = Math.hypot(dx, dz);
        if (length < 2) continue;
        const dirX = dx / length;
        const dirZ = dz / length;
        const normalX = -dirZ;
        const normalZ = dirX;
        const halfRoad = road.width * 0.5;

        // Sidewalks are single PlaneGeometry instances, 2 m wide and 0.06 m above asphalt.
        if (road.sidewalks) {
          for (const side of [-1, 1]) {
            if (allSidewalks.length < MAX_SIDEWALK_INSTANCES) allSidewalks.push({
              x: (a.x + b.x) * 0.5 + normalX * side * (halfRoad + 1),
              z: (a.y + b.y) * 0.5 + normalZ * side * (halfRoad + 1),
              length,
              yaw: -Math.atan2(dirZ, dirX),
                    });
          }
        }

        // Solid white edge lines and a 4 m / 8 m dashed centre line.
        if (road.markings) {
          const edge = Math.max(0.5, halfRoad - 0.28);
          for (const side of [-1, 1]) {
            if (allLines.length < MAX_LINE_SEGMENTS) addLine(
              a.x + normalX * side * edge,
              a.y + normalZ * side * edge,
              b.x + normalX * side * edge,
              b.y + normalZ * side * edge,
            );
          }
          for (let d = 0; d < length; d += 12) {
            const dashEnd = Math.min(length, d + 4);
            if (dashEnd - d < 0.5) continue;
            if (allLines.length < MAX_LINE_SEGMENTS) addLine(
              a.x + dirX * d,
              a.y + dirZ * d,
              a.x + dirX * dashEnd,
              a.y + dirZ * dashEnd,
            );
          }
        }

        // Lamps, one side at a time, approximately every 42-48 m.
        const lampSpacing = 44 + random01(hash32(`${road.id}:lamp-spacing:${segmentIndex}`)) * 5;
        const firstLamp = Math.max(18, lampSpacing * 0.5 - cumulative % lampSpacing);
        for (let d = firstLamp, lampIndex = 0; d < length - 8; d += lampSpacing, lampIndex++) {
          const side = ((lampIndex + segmentIndex + hash32(road.id)) & 1) === 0 ? 1 : -1;
          const pX = a.x + dirX * d + normalX * side * (halfRoad + 3.2);
          const pZ = a.y + dirZ * d + normalZ * side * (halfRoad + 3.2);
          if (insideBuilding(pX, pZ, 1.0)) continue;
          const seed = hash32(`${road.id}:lamp:${segmentIndex}:${lampIndex}`);
          allLamps.push({
            x: pX,
            z: pZ,
            height: 5.8 + random01(seed, 1) * 1.1,
            yaw: Math.atan2(-dirX, -dirZ),
            seed,
          });
        }

        // Trees stand outside the road edge. If OSM green polygons exist, they are mandatory.
        const treeSpacing = 18 + random01(hash32(`${road.id}:tree-spacing:${segmentIndex}`)) * 5;
        for (let d = 8, treeIndex = 0; d < length - 5; d += treeSpacing, treeIndex++) {
          const side = ((treeIndex + segmentIndex + hash32(road.id)) & 1) === 0 ? 1 : -1;
          const seed = hash32(`${tile.key}:${road.id}:tree:${segmentIndex}:${treeIndex}`);
          const offset = halfRoad + 4.5 + random01(seed, 2) * 4.0;
          const x = a.x + dirX * d + normalX * side * offset;
          const z = a.y + dirZ * d + normalZ * side * offset;
          if (tile.greenZones.length > 0 && !tile.greenZones.some((polygon) => pointInPolygon(x, z, polygon))) continue;
          if (insideBuilding(x, z, 2.0)) continue;
          allTrees.push({
            x,
            z,
            height: 6 + random01(seed, 3) * 4,
            crownRadius: 1.15 + random01(seed, 4) * 0.75,
            shade: Math.floor(random01(seed, 5) * TREE_GREEN.length),
            seed,
          });
        }
        cumulative += length;
      }
    }

    // Add low-density trees inside OSM green polygons, excluding carriageways/sidewalks.
    for (let zoneIndex = 0; zoneIndex < tile.greenZones.length; zoneIndex++) {
      const polygon = tile.greenZones[zoneIndex];
      let minX = Number.POSITIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (const p of polygon) {
        minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.y);
        maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.y);
      }
      const spacing = 17;
      const startX = Math.floor(minX / spacing) * spacing + 5;
      const startZ = Math.floor(minZ / spacing) * spacing + 5;
      for (let x = startX; x <= maxX; x += spacing) {
        for (let z = startZ; z <= maxZ; z += spacing) {
          const seed = hash32(`${tile.key}:green:${zoneIndex}:${x}:${z}`);
          const px = x + (random01(seed, 1) - 0.5) * 5;
          const pz = z + (random01(seed, 2) - 0.5) * 5;
          if (!pointInPolygon(px, pz, polygon)) continue;
          if (roadDistanceSq(px, pz, tile.roads) < 12 * 12) continue;
          if (insideBuilding(px, pz, 2.0)) continue;
          allTrees.push({
            x: px,
            z: pz,
            height: 6 + random01(seed, 3) * 4,
            crownRadius: 1.15 + random01(seed, 4) * 0.75,
            shade: Math.floor(random01(seed, 5) * TREE_GREEN.length),
            seed,
          });
        }
      }
    }
  }

  function rebuildTileCandidates(): void {
    allTrees.length = 0;
    allLamps.length = 0;
    allSidewalks.length = 0;
    allLines.length = 0;
    allStops.length = 0;

    const rawKeys = Array.from(getTileKeys());
    const tiles: RuntimeTileData[] = [];
    for (const raw of rawKeys) {
      const tile = normalizeTile(raw);
      if (tile) tiles.push(tile);
    }
    tiles.sort((a, b) => a.x - b.x || a.z - b.z || a.key.localeCompare(b.key));

    for (const tile of tiles) {
      addRoadProps(tile);
      allStops.push(...tile.stops);
    }

    // Keep deterministic, spatially distributed global caps.
    allTrees.sort((a, b) => a.seed - b.seed);
    if (allTrees.length > MAX_TREES) allTrees.length = MAX_TREES;
    allLamps.sort((a, b) => a.seed - b.seed);
    if (allLamps.length > MAX_LAMPS) allLamps.length = MAX_LAMPS;
    allStops.sort((a, b) => a.seed - b.seed);

    // Reallocate the sidewalk instance buffer only when the loaded tile set changes.
    const oldSidewalks = sidewalks;
    sidewalks = makeInstanced(sidewalkGeometry, sidewalkMaterial, Math.max(1, allSidewalks.length), 'street-sidewalks');
    scene.remove(oldSidewalks);
    oldSidewalks.dispose();
    scene.add(sidewalks);

    // The single dynamic LineSegments keeps a fixed-size GPU buffer across tile changes.
    lineGeometry.setDrawRange(0, 0);

    tileSignature = rawKeys.map((raw) => {
      if (typeof raw === 'string') {
        const data = getTileKeys.getTileData?.(raw) ?? lookupTileData(scene, raw);
        return `${raw}@${data?.version ?? `${data?.roads?.length ?? 0}/${data?.greenZones?.length ?? 0}/${data?.stops?.length ?? 0}`}`;
      }
      return `${raw.key ?? `${raw.x}:${raw.z}`}@${raw.version ?? `${raw.roads?.length ?? 0}/${raw.greenZones?.length ?? 0}/${raw.stops?.length ?? 0}`}`;
    }).sort().join('|');
  }

  function createStopBatch(
    flattened: FlattenedModel,
    kind: StreetStopModel,
  ): THREE.InstancedMesh {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: flattened.hasAlpha,
      depthWrite: !flattened.hasAlpha,
      roughness: 0.92,
      metalness: 0.02,
    });
    const mesh = makeInstanced(flattened.geometry, material, MAX_STOP_INSTANCES, `street-stop-${kind}`);
    mesh.frustumCulled = false;
    scene.add(mesh);
    if (kind === 'soviet') {
      sovietStopTriangles = flattened.triangles;
      sovietStopMesh = mesh;
    } else {
      modernStopTriangles = flattened.triangles;
      modernStopMesh = mesh;
    }
    return mesh;
  }

  /** Приводит CC0-модель к 1 м высоты, основанию в y=0 и вертикальной оси. */
  function normalizeCityModel(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    // Некоторые модели (фонарь) автором повёрнуты: длинная ось — Z.
    if (size.z > size.y && size.z > size.x) geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    const h = Math.max(0.01, b.max.y - b.min.y);
    const center = b.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -b.min.y, -center.z);
    geometry.scale(1 / h, 1 / h, 1 / h);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  async function loadCityModels(): Promise<void> {
    modelMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.02,
    });
    const loadOne = async (file: string, capacity: number): Promise<CityModelBatch | null> => {
      const gltf = await loader.loadAsync(urlForPublicAsset(`models/city/${file}`));
      if (disposed) { disposeObjectAssets(gltf.scene); return null; }
      const flattened = flattenGLTFScene(gltf.scene);
      disposeObjectAssets(gltf.scene);
      normalizeCityModel(flattened.geometry);
      const mesh = makeInstanced(flattened.geometry, modelMaterial!, capacity, `street-city-${file}`);
      scene.add(mesh);
      return { mesh, triangles: flattened.triangles };
    };
    try {
      const [oak, broad, pine, lamp] = await Promise.all([
        loadOne('tree-oak.glb', DETAIL_TREE_CAPACITY),
        loadOne('tree-broad.glb', DETAIL_TREE_CAPACITY),
        loadOne('tree-pine.glb', DETAIL_TREE_CAPACITY),
        loadOne('street-light.glb', DETAIL_LAMP_CAPACITY),
      ]);
      for (const batch of [oak, broad, pine]) if (batch) modelTrees.push(batch);
      modelLamp = lamp;
      console.info('[streetProps] CC0 city models loaded:', modelTrees.length, 'trees, lamp:', !!modelLamp);
    } catch (error) {
      if (!disposed) console.warn('[streetProps] CC0 models unavailable, primitives only:', error);
    }
  }

  async function loadStopModels(): Promise<void> {
    const loadOne = async (path: string, kind: StreetStopModel): Promise<void> => {
      const gltf = await loader.loadAsync(urlForPublicAsset(path));
      if (disposed) {
        disposeObjectAssets(gltf.scene);
        return;
      }
      const flattened = flattenGLTFScene(gltf.scene);
      disposeObjectAssets(gltf.scene);
      createStopBatch(flattened, kind);
    };

    await Promise.all([
      loadOne('stops/bus_stop_soviet_concrete.glb', 'soviet'),
      loadOne('stops/bus_stop_modern_glass_metal.glb', 'modern'),
    ]);
    sourceStopReady = true;
  }

  function cameraDistanceSq(x: number, z: number, cameraPos: THREE.Vector3): number {
    const dx = x - cameraPos.x;
    const dz = z - cameraPos.z;
    return dx * dx + dz * dz;
  }

  function writeMatrix(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    scratchObject.position.set(x, y, z);
    scratchObject.rotation.set(0, yaw, 0);
    scratchObject.scale.set(sx, sy, sz);
    scratchObject.updateMatrix();
    mesh.setMatrixAt(index, scratchObject.matrix);
  }

  let visibleRefreshElapsed = 0;

  function update(cameraPos: THREE.Vector3, dt = 1 / 60): void {
    if (disposed) return;

    // Пересчёт видимых инстансов не чаще 6-7 раз в секунду,
    // но сразу при сдвиге камеры > 4 м.
    visibleRefreshElapsed += dt;
    const vdx = cameraPos.x - lastCamera.x;
    const vdz = cameraPos.z - lastCamera.z;
    if (visibleRefreshElapsed < 0.15 && vdx * vdx + vdz * vdz < 16) return;
    visibleRefreshElapsed = 0;

    refreshElapsed += dt;
    const dxCam = vdx;
    const dzCam = vdz;
    if (refreshElapsed >= 0.75 || dxCam * dxCam + dzCam * dzCam > 2500) {
      refreshElapsed = 0;
      const previous = tileSignature;
      // getTileKeys may yield fresh descriptor objects each call. Signature comparison
      // avoids rebuilding geometry unless tile keys or descriptor version/count changes.
      const signature = Array.from(getTileKeys()).map((raw) => {
        if (typeof raw === 'string') {
          const data = getTileKeys.getTileData?.(raw) ?? lookupTileData(scene, raw);
          return `${raw}@${data?.version ?? `${data?.roads?.length ?? 0}/${data?.greenZones?.length ?? 0}/${data?.stops?.length ?? 0}`}`;
        }
        return `${raw.key ?? `${raw.x}:${raw.z}`}@${raw.version ?? `${raw.roads?.length ?? 0}/${raw.greenZones?.length ?? 0}/${raw.stops?.length ?? 0}`}`;
      }).sort().join('|');
      if (signature !== previous) rebuildTileCandidates();
    }
    lastCamera.copy(cameraPos);

    const nearbyTrees: Array<{ item: TreeCandidate; d2: number }> = [];
    for (const item of allTrees) {
      const d2 = cameraDistanceSq(item.x, item.z, cameraPos);
      if (d2 <= VIEW_DISTANCE_SQ) nearbyTrees.push({ item, d2 });
    }
    nearbyTrees.sort((a, b) => a.d2 - b.d2);

    const nearbyLamps: Array<{ item: LampCandidate; d2: number }> = [];
    for (const item of allLamps) {
      const d2 = cameraDistanceSq(item.x, item.z, cameraPos);
      if (d2 <= VIEW_DISTANCE_SQ) nearbyLamps.push({ item, d2 });
    }
    nearbyLamps.sort((a, b) => a.d2 - b.d2);

    const nearbySidewalks: Array<{ item: SidewalkCandidate; d2: number }> = [];
    for (const item of allSidewalks) {
      const d2 = cameraDistanceSq(item.x, item.z, cameraPos);
      if (d2 <= VIEW_DISTANCE_SQ) nearbySidewalks.push({ item, d2 });
    }

    const nearbyStops: Array<{ item: StopCandidate; d2: number }> = [];
    for (const item of allStops) {
      const d2 = cameraDistanceSq(item.x, item.z, cameraPos);
      if (d2 <= VIEW_DISTANCE_SQ) nearbyStops.push({ item, d2 });
    }
    nearbyStops.sort((a, b) => a.d2 - b.d2);

    // Runtime triangle budget includes only instances within 600 m.
    let remainingTriangles = MAX_TRIANGLES;

    // Stop models are visually important. Render nearest stops first, with a strict cap.
    const selectedStops: StopCandidate[] = [];
    if (sourceStopReady) {
      for (const entry of nearbyStops) {
        if (selectedStops.length >= MAX_STOPS_VISIBLE) break;
        const triCount = entry.item.model === 'soviet' ? sovietStopTriangles : modernStopTriangles;
        if (triCount <= 0 || triCount > remainingTriangles) continue;
        remainingTriangles -= triCount;
        selectedStops.push(entry.item);
      }
    }

    // CC0-модели идут только ближайшим объектам; остальные — дешёвые примитивы.
    const modelTri = modelTrees.length > 0 ? modelTrees[0].triangles : 0;
    const detailTreeTotal = modelTrees.length === 0 ? 0 : Math.min(
      nearbyTrees.length,
      DETAIL_TREE_CAPACITY * modelTrees.length,
      Math.floor(DETAIL_TREE_TRIANGLE_BUDGET / Math.max(1, modelTri)),
    );
    const detailLampTotal = modelLamp
      ? Math.min(nearbyLamps.length, DETAIL_LAMP_CAPACITY,
        Math.floor(DETAIL_LAMP_TRIANGLE_BUDGET / Math.max(1, modelLamp.triangles)))
      : 0;

    const treeTriangles = 12;
    const treeCount = Math.min(
      nearbyTrees.length - detailTreeTotal, MAX_TREES,
      Math.floor(remainingTriangles / treeTriangles),
    );
    remainingTriangles -= treeCount * treeTriangles;

    const lampTriangles = 12;
    const lampCount = Math.min(
      nearbyLamps.length - detailLampTotal, MAX_LAMPS,
      Math.floor(remainingTriangles / lampTriangles),
    );
    remainingTriangles -= lampCount * lampTriangles;

    // Sidewalks are 2 triangles per visible road-side segment. Sort only when the
    // triangle cap forces truncation; normal frames avoid sorting up to 12k strips.
    const sidewalkCapacity = Math.floor(remainingTriangles / 2);
    if (nearbySidewalks.length > sidewalkCapacity) {
      nearbySidewalks.sort((a, b) => a.d2 - b.d2);
    }
    const sidewalkCount = Math.min(nearbySidewalks.length, sidewalkCapacity);
    remainingTriangles -= sidewalkCount * 2;

    for (let i = 0; i < treeCount; i++) {
      const tree = nearbyTrees[detailTreeTotal + i].item;
      const trunkHeight = tree.height * 0.48;
      const crownHeight = tree.height * 0.56;
      writeMatrix(treeTrunks, i, tree.x, trunkHeight * 0.5, tree.z, 0,
        1, trunkHeight, 1);
      writeMatrix(treeCrowns, i, tree.x, trunkHeight + crownHeight * 0.5 - 0.15, tree.z, 0,
        tree.crownRadius, crownHeight, tree.crownRadius);
      treeCrowns.setColorAt(i, TREE_GREEN_COLORS[tree.shade]);
    }
    updateInstancedMesh(treeTrunks, treeCount);
    updateInstancedMesh(treeCrowns, treeCount);

    for (let i = 0; i < lampCount; i++) {
      const lamp = nearbyLamps[detailLampTotal + i].item;
      writeMatrix(lampPoles, i, lamp.x, lamp.height * 0.5, lamp.z, 0,
        1, lamp.height, 1);
      writeMatrix(lampHeads, i, lamp.x, lamp.height - 0.08, lamp.z, lamp.yaw,
        1, 1, 1);
      writeMatrix(lampPools, i, lamp.x, 0.07, lamp.z, lamp.yaw, 5, 8, 1);
    }
    updateInstancedMesh(lampPoles, lampCount);
    updateInstancedMesh(lampHeads, lampCount);
    updateInstancedMesh(lampPools, lampCount);

    if (modelTrees.length > 0) {
      const perVariant = new Array<number>(modelTrees.length).fill(0);
      for (let i = 0; i < detailTreeTotal; i++) {
        const tree = nearbyTrees[i].item;
        const variant = tree.seed % modelTrees.length;
        const batch = modelTrees[variant];
        const index = perVariant[variant]++;
        writeMatrix(batch.mesh, index, tree.x, 0, tree.z,
          ((tree.seed >>> 0) % 628) / 100, tree.height, tree.height, tree.height);
      }
      for (let v = 0; v < modelTrees.length; v++) {
        updateInstancedMesh(modelTrees[v].mesh, perVariant[v]);
      }
    }
    if (modelLamp) {
      for (let i = 0; i < detailLampTotal; i++) {
        const lamp = nearbyLamps[i].item;
        writeMatrix(modelLamp.mesh, i, lamp.x, 0, lamp.z, lamp.yaw,
          lamp.height, lamp.height, lamp.height);
      }
      updateInstancedMesh(modelLamp.mesh, detailLampTotal);
    }

    for (let i = 0; i < sidewalkCount; i++) {
      const sidewalk = nearbySidewalks[i].item;
      writeMatrix(
        sidewalks, i, sidewalk.x, SIDEWALK_Y, sidewalk.z, sidewalk.yaw,
        sidewalk.length, 2, 1,
      );
    }
    updateInstancedMesh(sidewalks, sidewalkCount);

    // Compact the road marking segments to those within 600 m into the same LineSegments.
    let lineVertexCount = 0;
    const positions = linePositionAttribute.array as Float32Array;
    for (const line of allLines) {
      const midX = (line.ax + line.bx) * 0.5;
      const midZ = (line.az + line.bz) * 0.5;
      if (cameraDistanceSq(midX, midZ, cameraPos) > VIEW_DISTANCE_SQ) continue;
      if (lineVertexCount + 2 > linePositionAttribute.count) break;
      let offset = lineVertexCount * 3;
      positions[offset++] = line.ax; positions[offset++] = ROAD_Y; positions[offset++] = line.az;
      positions[offset++] = line.bx; positions[offset++] = ROAD_Y; positions[offset++] = line.bz;
      lineVertexCount += 2;
    }
    linePositionAttribute.clearUpdateRanges();
    if (lineVertexCount > 0) linePositionAttribute.addUpdateRange(0, lineVertexCount * 3);
    linePositionAttribute.needsUpdate = true;
    roadLines.geometry.setDrawRange(0, lineVertexCount);
    roadLines.visible = lineVertexCount > 0;

    // Stop batches use world matrices and the same 600 m cutoff.
    let sovietCount = 0;
    let modernCount = 0;
    if (sourceStopReady) {
      for (const stop of selectedStops) {
        if (stop.model === 'soviet' && sovietStopMesh && sovietCount < sovietStopMesh.instanceMatrix.count) {
          writeMatrix(sovietStopMesh, sovietCount++, stop.x, 0, stop.z, stop.yaw, 1, 1, 1);
        } else if (stop.model === 'modern' && modernStopMesh && modernCount < modernStopMesh.instanceMatrix.count) {
          writeMatrix(modernStopMesh, modernCount++, stop.x, 0, stop.z, stop.yaw, 1, 1, 1);
        }
      }
    }
    if (sovietStopMesh) updateInstancedMesh(sovietStopMesh, sovietCount);
    if (modernStopMesh) updateInstancedMesh(modernStopMesh, modernCount);

    // Night flag is supplied by the existing day/night controller.
    const isNight = scene.userData.isNight === true || scene.userData.timeOfDay === 'night';
    lampHeadMaterial.emissive.setHex(isNight ? 0xffb75e : 0x000000);
    lampHeadMaterial.emissiveIntensity = isNight ? 1.8 : 0;
    lampPools.visible = isNight;
    for (let i = 0; i < pointLights.length; i++) {
      const light = pointLights[i];
      const lamp = isNight && i < lampCount ? nearbyLamps[i]?.item : undefined;
      if (!lamp || i >= MAX_POINT_LIGHTS) {
        light.visible = false;
        continue;
      }
      light.position.set(lamp.x, lamp.height - 0.1, lamp.z);
      light.visible = true;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    const renderObjects: THREE.Object3D[] = [treeTrunks, treeCrowns, lampPoles, lampHeads, lampPools, sidewalks, roadLines];
    if (sovietStopMesh) renderObjects.push(sovietStopMesh);
    if (modernStopMesh) renderObjects.push(modernStopMesh);
    for (const batch of modelTrees) renderObjects.push(batch.mesh);
    if (modelLamp) renderObjects.push(modelLamp.mesh);
    for (const object of renderObjects) {
      scene.remove(object);
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    }

    for (const light of pointLights) {
      light.visible = false;
      scene.remove(light);
    }

    // Instanced meshes share module-owned geometries/materials. Dispose each once.
    trunkGeometry.dispose();
    crownGeometry.dispose();
    lampPoleGeometry.dispose();
    lampHeadGeometry.dispose();
    sidewalkGeometry.dispose();
    trunkMaterial.dispose();
    crownMaterial.dispose();
    lampPoleMaterial.dispose();
    lampHeadMaterial.dispose();
    sidewalkMaterial.dispose();
    lineMaterial.dispose();
    modelMaterial?.dispose();

    // Stop geometries/materials are disposed with their InstancedMesh above.
    allTrees.length = 0;
    allLamps.length = 0;
    allSidewalks.length = 0;
    allLines.length = 0;
    allStops.length = 0;
  }

  rebuildTileCandidates();
  void loadStopModels().catch((error: unknown) => {
    if (!disposed) console.error('[streetProps] Failed to load bus stop GLB models:', error);
  });
  if (options.detailedModels !== false) void loadCityModels();

  function getStats() {
    return {
      tiles: Array.from(getTileKeys()).length,
      trees: treeTrunks?.count ?? 0,
      lamps: lampPoles?.count ?? 0,
      sidewalks: sidewalks?.count ?? 0,
      lines: roadLines?.geometry?.getAttribute('position')?.count ?? 0,
      stops: allStops.length,
      modelTrees: modelTrees.reduce((sum, b) => sum + b.mesh.count, 0),
      modelLamps: modelLamp?.mesh.count ?? 0,
    };
  }

  return { update, dispose, getStats };
}
