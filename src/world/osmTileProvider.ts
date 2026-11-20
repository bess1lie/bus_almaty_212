import * as THREE from 'three';
import type {
  CityTilePayload,
  CityTileProvider,
  BuildingSource,
} from './cityWorld';
import type { CityBuilding, CityRoad } from './tiles';
import { getTextures, type BuildingTextureKind } from './textures';

const TILE_SIZE = 2000;
const MAX_TILE_TRIANGLES = 30_000;
const MAX_BUILDINGS = 1800;
const MAX_ROAD_TRIANGLES = 3000;

type BuildingKind = 'apartments' | 'house' | 'commercial' | 'industrial';
type Point2 = [number, number];
type Point3 = [number, number, number];

interface TileBuilding extends CityBuilding {
  levels?: number;
  'building:levels'?: number;
}
interface TileJson { buildings?: TileBuilding[]; roads?: Array<CityRoad & { t?: string; type?: string }>; }
interface VertexData { positions: number[]; colors: number[]; uvs: number[]; }
interface BuildingStyle {
  rows: number; columns: number; windowHeight: number;
  minHeight: number; maxHeight: number; palette: number[];
}

const STYLES: Record<BuildingKind, BuildingStyle> = {
  apartments: { rows: 4, columns: 3, windowHeight: 0.045, minHeight: 15, maxHeight: 60, palette: [0xd5d8d4, 0xc7ccc9, 0xe0ded7, 0xbcc5c6] },
  house: { rows: 2, columns: 2, windowHeight: 0.16, minHeight: 4, maxHeight: 8, palette: [0xc5ad8e, 0xd0bfa6, 0xb9aa97, 0xd6c9b3] },
  commercial: { rows: 3, columns: 3, windowHeight: 0.085, minHeight: 6, maxHeight: 24, palette: [0x9cabb0, 0xb4b9b4, 0xa5aba8, 0x899ba1] },
  industrial: { rows: 2, columns: 2, windowHeight: 0.075, minHeight: 6, maxHeight: 18, palette: [0x727a79, 0x626b6b, 0x7e8580] },
};

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function positiveNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function pushQuad(target: VertexData, p0: Point3, p1: Point3, p2: Point3, p3: Point3, hex: number) {
  const c = new THREE.Color(hex);
  const pts = [p0, p1, p2, p0, p2, p3];
  // Определяем плоскость по постоянной координате
  const sameZ = Math.abs(p0[2] - p1[2]) < 1e-6 && Math.abs(p0[2] - p2[2]) < 1e-6;
  const sameX = Math.abs(p0[0] - p1[0]) < 1e-6 && Math.abs(p0[0] - p2[0]) < 1e-6;
  for (const p of pts) {
    target.positions.push(p[0], p[1], p[2]);
    target.colors.push(c.r, c.g, c.b);
    if (sameZ) target.uvs.push(p[0] + 0.5, p[1]);
    else if (sameX) target.uvs.push(p[2] + 0.5, p[1]);
    else target.uvs.push(p[0] + 0.5, p[2] + 0.5);
  }
}

function makeFacadeGeometry(kind: BuildingKind): THREE.BufferGeometry {
  const style = STYLES[kind];
  const body: VertexData = { positions: [], colors: [], uvs: [] };
  const litWindows: VertexData = { positions: [], colors: [], uvs: [] };

  pushQuad(body, [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5], 0xffffff);
  pushQuad(body, [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5], 0xe5e5e1);
  pushQuad(body, [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], 0xe0e2df);
  pushQuad(body, [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5], 0xe9e8e2);
  pushQuad(body, [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], 0x505a5f);
  pushQuad(body, [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], 0x858783);

  type WB = (c: number, y: number, w: number, h: number) => [Point3, Point3, Point3, Point3];
  const faces: WB[] = [
    (c, y, w, h) => [[c - w / 2, y - h / 2, 0.508], [c + w / 2, y - h / 2, 0.508], [c + w / 2, y + h / 2, 0.508], [c - w / 2, y + h / 2, 0.508]],
    (c, y, w, h) => [[c + w / 2, y - h / 2, -0.508], [c - w / 2, y - h / 2, -0.508], [c - w / 2, y + h / 2, -0.508], [c + w / 2, y + h / 2, -0.508]],
    (c, y, w, h) => [[0.508, y - h / 2, c + w / 2], [0.508, y - h / 2, c - w / 2], [0.508, y + h / 2, c - w / 2], [0.508, y + h / 2, c + w / 2]],
    (c, y, w, h) => [[-0.508, y - h / 2, c - w / 2], [-0.508, y - h / 2, c + w / 2], [-0.508, y + h / 2, c + w / 2], [-0.508, y + h / 2, c - w / 2]],
  ];

  const floorStep = 0.76 / style.rows;
  const windowWidth = Math.min(0.16, 0.56 / style.columns);
  const windowHeight = Math.min(style.windowHeight, floorStep * 0.48);

  for (let face = 0; face < 4; face++) {
    const build = faces[face];
    for (let row = 0; row < style.rows; row++) {
      const centerY = 0.12 + (row + 0.5) * floorStep;
      for (let col = 0; col < style.columns; col++) {
        const center = -0.5 + (col + 0.5) / style.columns;
        const outer = build(center, centerY, windowWidth, windowHeight);
        pushQuad(body, outer[0], outer[1], outer[2], outer[3], 0x182a33);
        const isLit = (row * 11 + col * 7 + face * 3 + 1) % 5 === 0;
        if (isLit) {
          const inner = build(center, centerY, windowWidth * 0.68, windowHeight * 0.72);
          pushQuad(litWindows, inner[0], inner[1], inner[2], inner[3], 0xffc578);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const bodyCount = body.positions.length / 3;
  const windowCount = litWindows.positions.length / 3;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...body.positions, ...litWindows.positions], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([...body.colors, ...litWindows.colors], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([...body.uvs, ...litWindows.uvs], 2));
  geometry.addGroup(0, bodyCount, 0);
  if (windowCount > 0) geometry.addGroup(bodyCount, windowCount, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.userData.buildingKind = kind;
  return geometry;
}

function classifyBuilding(rawType: string, estimatedHeight: number): BuildingKind {
  const t = rawType.toLowerCase();
  if (/industrial|warehouse|factory|hangar/.test(t)) return 'industrial';
  if (['commercial', 'retail', 'office', 'supermarket', 'hotel'].includes(t)) return 'commercial';
  if (['house', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'terrace'].includes(t)) return 'house';
  if (['apartments', 'dormitory'].includes(t)) return 'apartments';
  return estimatedHeight >= 15 ? 'apartments' : 'house';
}

function buildingHeight(b: TileBuilding, kind: BuildingKind): number {
  const style = STYLES[kind];
  const levels = positiveNumber(b.levels ?? b['building:levels']);
  const explicit = levels ? levels * 3.1 : positiveNumber(b.h);
  const fallback = { apartments: 27, house: 6, commercial: 12, industrial: 10 }[kind];
  return clamp(explicit ?? fallback, style.minHeight, style.maxHeight);
}

function buildingColor(kind: BuildingKind, seed: number): number {
  const p = STYLES[kind].palette;
  return p[Math.abs(seed) % p.length];
}

function roadColor(type: string): number {
  type = type || '';
  if (type.startsWith('motorway')) return 0x42494d;
  if (type.startsWith('trunk')) return 0x4d5458;
  if (type.startsWith('primary')) return 0x555b5d;
  if (type.startsWith('secondary')) return 0x606566;
  if (type.startsWith('tertiary')) return 0x696c68;
  if (type.startsWith('residential')) return 0x73736e;
  if (type.startsWith('service')) return 0x7b7971;
  return 0x70716c;
}
function roadPriority(type: string): number {
  type = type || '';
  if (type.startsWith('motorway')) return 0;
  if (type.startsWith('trunk')) return 1;
  if (type.startsWith('primary')) return 2;
  if (type.startsWith('secondary')) return 3;
  if (type.startsWith('tertiary')) return 4;
  if (type.startsWith('residential')) return 5;
  if (type.startsWith('service')) return 6;
  return 7;
}
function noise(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}
function samplePolyline(points: Point2[], maxSegments: number): Point2[] {
  if (points.length < 2 || maxSegments < 1) return [];
  if (points.length - 1 <= maxSegments) return points;
  const result: Point2[] = [];
  const total = points.length - 1;
  for (let i = 0; i < maxSegments; i++) result.push(points[Math.floor((i * total) / maxSegments)]);
  result.push(points[points.length - 1]);
  return result;
}
function addRoadVertex(positions: number[], colors: number[], uvs: number[], x: number, y: number, z: number, color: THREE.Color, originX: number, originZ: number) {
  positions.push(x, y, z);
  colors.push(color.r, color.g, color.b);
  // UV в мировых метрах / 8 — текстура асфальта стыкуется между тайлами
  uvs.push((x + originX) / 8, (z + originZ) / 8);
}

function buildRoads(roads: CityRoad[], tileX: number, tileZ: number, triangleBudget: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `roads-${tileX}_${tileZ}`;
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
  const originX = tileX * TILE_SIZE, originZ = tileZ * TILE_SIZE;
  let remaining = Math.floor(triangleBudget / 6);
  const roadType = (r: CityRoad & { t?: string }) => r.type ?? r.t ?? '';
  const sorted = [...roads].sort((a, b) => roadPriority(roadType(a)) - roadPriority(roadType(b)));

  for (const road of sorted) {
    if (remaining <= 0) break;
    if (!road.poly || road.poly.length < 2) continue;
    const points = samplePolyline(road.poly, Math.min(remaining, road.poly.length - 1));
    if (points.length < 2) continue;
    const halfWidth = clamp(road.w / 2, 2.2, 11);
    const curb = 0.24;
    const asphaltBase = new THREE.Color(roadColor(roadType(road)));
    const vs = positions.length / 3;

    for (let i = 0; i < points.length; i++) {
      const [ax, az] = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next[0] - prev[0], dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const x = ax - originX, z = az - originZ;
      const asphalt = asphaltBase.clone().multiplyScalar(0.94 + noise(ax, az) * 0.12);
      const curbC = new THREE.Color(0x96968e).multiplyScalar(0.97 + noise(az, ax) * 0.06);
      addRoadVertex(positions, colors, uvs, x + nx * halfWidth, 0.055, z + nz * halfWidth, asphalt, originX, originZ);
      addRoadVertex(positions, colors, uvs, x - nx * halfWidth, 0.055, z - nz * halfWidth, asphalt, originX, originZ);
      addRoadVertex(positions, colors, uvs, x + nx * (halfWidth + curb), 0.12, z + nz * (halfWidth + curb), curbC, originX, originZ);
      addRoadVertex(positions, colors, uvs, x - nx * (halfWidth + curb), 0.12, z - nz * (halfWidth + curb), curbC, originX, originZ);
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = vs + i * 4, b = a + 4;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
      indices.push(a, b, a + 2, a + 2, b, b + 2);
      indices.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
    }
    remaining -= points.length - 1;
  }

  if (positions.length === 0) { group.userData.triangleCount = 0; return group; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true, map: getTextures().asphalt, roughness: 0.98, metalness: 0, side: THREE.DoubleSide,
  }));
  mesh.name = 'road-surface-and-curbs';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.userData.triangleCount = indices.length / 3;
  return group;
}

export class OsmTileProvider implements CityTileProvider {
  private readonly jsonCache = new Map<string, Promise<TileJson>>();
  private readonly facadeCache = new Map<BuildingKind, THREE.BufferGeometry>();

  private getFacade(kind: BuildingKind): THREE.BufferGeometry {
    let g = this.facadeCache.get(kind);
    if (!g) { g = makeFacadeGeometry(kind); this.facadeCache.set(kind, g); }
    return g;
  }

  private fetchTile(key: string): Promise<TileJson> {
    let r = this.jsonCache.get(key);
    if (!r) {
      const url = `${import.meta.env.BASE_URL}map/v1/tiles/${key}.json`;
      r = fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`[OSM] Tile ${key}: HTTP ${res.status}`);
          return (await res.json()) as TileJson;
        })
        .catch((e) => { this.jsonCache.delete(key); throw e; });
      this.jsonCache.set(key, r);
    }
    return r;
  }

  async loadTile(tileX: number, tileZ: number): Promise<CityTilePayload> {
    const key = `${tileX}_${tileZ}`;
    const data = await this.fetchTile(key);
    const originX = tileX * TILE_SIZE, originZ = tileZ * TILE_SIZE;
    const candidates: Array<{ source: BuildingSource; score: number }> = [];

    for (let i = 0; i < (data.buildings?.length ?? 0); i++) {
      const b = data.buildings![i];
      if (!b.poly || b.poly.length < 3) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of b.poly) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      const width = Math.max(3, maxX - minX);
      const depth = Math.max(3, maxZ - minZ);
      const rawHeight = positiveNumber(b.h) ?? 10;
      const kind = classifyBuilding(b.type, rawHeight);
      const height = buildingHeight(b, kind);
      const seed = (tileX * 73856093) ^ (tileZ * 19349663) ^ (i * 83492791);
      const source: BuildingSource = {
        position: new THREE.Vector3((minX + maxX) * 0.5 - originX, 0, (minZ + maxZ) * 0.5 - originZ),
        size: new THREE.Vector3(width, height, depth),
        color: buildingColor(kind, seed),
        rotationY: 0,
        geometry: this.getFacade(kind),
        collidable: false,
      };
      candidates.push({ source, score: width * depth * (1 + height / 60) });
    }

    candidates.sort((a, b) => b.score - a.score);
    const buildings = candidates.slice(0, MAX_BUILDINGS).map((x) => x.source);
    const baseTriangles = buildings.length * 12;
    const roadBudget = Math.min(MAX_ROAD_TRIANGLES, Math.max(0, MAX_TILE_TRIANGLES - baseTriangles));
    const roads = buildRoads(data.roads ?? [], tileX, tileZ, roadBudget);
    return { buildings, roads };
  }

  dispose(): void {
    this.jsonCache.clear();
    for (const g of this.facadeCache.values()) g.dispose();
    this.facadeCache.clear();
  }
}
