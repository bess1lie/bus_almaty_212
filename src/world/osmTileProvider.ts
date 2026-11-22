import * as THREE from 'three';
import type {
  CityTilePayload,
  CityTileProvider,
  BuildingSource,
} from './cityWorld';
import type { CityBuilding, CityRoad } from './tiles';
import { loadTileRaw } from './tiles';
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
  buildingLevels?: number | null;
  'building:levels'?: number;
}
interface TileJson { buildings?: TileBuilding[]; roads?: Array<CityRoad & { t?: string; type?: string }>; }
interface VertexData { positions: number[]; colors: number[]; uvs: number[]; }
interface BuildingStyle {
  rows: number; columns: number; windowHeight: number;
  minHeight: number; maxHeight: number; palette: number[];
}

const STYLES: Record<BuildingKind, BuildingStyle> = {
  apartments: { rows: 4, columns: 3, windowHeight: 0.075, minHeight: 15, maxHeight: 60, palette: [0xd4c2a5, 0xc9b79c, 0xe0d1b9, 0xb9aa98] },
  house: { rows: 2, columns: 2, windowHeight: 0.14, minHeight: 4, maxHeight: 8, palette: [0xb98264, 0xc99878, 0xd1ae8b, 0xa97960] },
  commercial: { rows: 3, columns: 3, windowHeight: 0.085, minHeight: 6, maxHeight: 24, palette: [0x92aab0, 0xa8b9b5, 0x879ea5, 0xb5b7ae] },
  industrial: { rows: 2, columns: 2, windowHeight: 0.075, minHeight: 6, maxHeight: 18, palette: [0x7a807d, 0x656f70, 0x89877d] },
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
  // КЛЮЧЕВОЙ ФИКС: фасадная геометрия была 0..1, а матрица considers center.
  // Сдвигаем в -0.5..+0.5 — теперь и box LOD, и facade LOD стоят на земле одинаково.
  geometry.translate(0, -0.5, 0);
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
  // Пайплайн пишет: h — высота в метрах, levels — ТОЖЕ высота в метрах,
  // buildingLevels — число этажей. НИКОГДА не умножаем levels на 3.1.
  const explicit = positiveNumber(b.h)
    ?? positiveNumber(b.levels)
    ?? positiveNumber(b['building:levels']);
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
/**
 * Склеивает road pieces ОДНОГО OSM-way в непрерывную полилинию.
 * Один проход, без дублирования результата. Склейка только между кусками
 * с одинаковым base id и совпадающими концами (в т.ч. через границы тайлов).
 */
function stitchRoadPieces(roads: Array<CityRoad & { t?: string; type?: string }>): CityRoad[] {
  const key = (p: Point2) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const baseId = (r: CityRoad) => String(r.id ?? '').split(':')[0] || `anon-${Math.round(r.poly[0]?.[0] ?? 0)}-${Math.round(r.poly[0]?.[1] ?? 0)}`;

  // Группируем ТОЛЬКО по OSM id — разные ways на перекрёстке не склеиваем (A04)
  const byId = new Map<string, number[]>();
  for (let i = 0; i < roads.length; i++) {
    if (roads[i].poly.length < 2) continue;
    const id = baseId(roads[i]);
    const arr = byId.get(id) ?? [];
    arr.push(i);
    byId.set(id, arr);
  }

  const result: CityRoad[] = [];
  for (const [id, indices] of byId) {
    // Индексы локальны внутри группы; строим карты концов по ним
    const startMap = new Map<string, number[]>();
    const endMap = new Map<string, number[]>();
    for (const i of indices) {
      const poly = roads[i].poly;
      const s = key(poly[0]);
      const e = key(poly[poly.length - 1]);
      (startMap.get(s) ?? startMap.set(s, []).get(s)!).push(i);
      (endMap.get(e) ?? endMap.set(e, []).get(e)!).push(i);
    }

    const used = new Set<number>();
    for (const i of indices) {
      if (used.has(i)) continue;
      used.add(i);
      let poly = [...roads[i].poly];
      const sample = roads[i];
      let extended = true;
      while (extended) {
        extended = false;
        const ek = key(poly[poly.length - 1]);
        const sk = key(poly[0]);
        for (const j of endMap.get(ek) ?? []) {
          if (j === i || used.has(j)) continue;
          poly = [...poly, ...roads[j].poly.slice(1)];
          used.add(j); extended = true; break;
        }
        if (extended) continue;
        for (const j of startMap.get(ek) ?? []) {
          if (j === i || used.has(j)) continue;
          poly = [...poly, ...roads[j].poly.slice().reverse().slice(1)];
          used.add(j); extended = true; break;
        }
        if (extended) continue;
        for (const j of endMap.get(sk) ?? []) {
          if (j === i || used.has(j)) continue;
          poly = [...roads[j].poly.slice(0, -1), ...poly];
          used.add(j); extended = true; break;
        }
        if (extended) continue;
        for (const j of startMap.get(sk) ?? []) {
          if (j === i || used.has(j)) continue;
          poly = [...roads[j].poly.slice().reverse().slice(0, -1), ...poly];
          used.add(j); extended = true; break;
        }
      }
      if (poly.length >= 2) {
        result.push({
          poly, w: sample.w, lanes: sample.lanes, oneWay: sample.oneWay,
          speed: sample.speed, t: sample.t, type: sample.type ?? sample.t ?? '', id,
        });
      }
    }
  }
  return result;
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
    const rt = roadType(road);
    let minHalf = 2.2, maxHalf = 11;
    if (rt.startsWith('motorway') || rt.startsWith('trunk')) { minHalf = 7; maxHalf = 14; }
    else if (rt.startsWith('primary')) { minHalf = 6; maxHalf = 12; }
    else if (rt.startsWith('secondary')) { minHalf = 5; maxHalf = 10; }
    else if (rt.startsWith('tertiary')) { minHalf = 3.5; maxHalf = 7; }
    else if (rt.startsWith('residential') || rt.startsWith('service')) { minHalf = 2.5; maxHalf = 6; }
    if (road.lanes >= 4) minHalf = Math.max(minHalf, 6);
    if (road.lanes >= 6) minHalf = Math.max(minHalf, 9);
    if (road.lanes === 1) maxHalf = Math.min(maxHalf, 4.5);
    const halfWidth = clamp(road.w / 2, minHalf, maxHalf);
    const curb = 0.35; // чуть шире, чтобы читались обочины
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

/**
 * Экструзия реального полигона здания в геометрию с Questions base Y=0, top Y=1.
 * Стены + крыша. Возвращает normalized geometry для instance matrix (scale = size).
 */
function makeFootprintGeometry(poly: Point2[]): THREE.BufferGeometry | null {
  if (poly.length < 3) return null;
  // Нормализуем контур в [0..1] по X/Z, Y будет 0..1
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const w = maxX - minX || 1, d = maxZ - minZ || 1;
  const norm = poly.map(([x, z]) => [(x - minX) / w - 0.5, (z - minZ) / d - 0.5] as Point2);

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const C = (r: number, g: number, b: number) => { colors.push(r, g, b); };

  // Стены: для каждого ребра quad от Y=0 до Y=1
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i], b = norm[(i + 1) % norm.length];
    const base = positions.length / 3;
    positions.push(a[0], 0, a[1], b[0], 0, b[1], b[0], 1, b[1], a[0], 1, a[1]);
    const shade = 0.82 + (i % 3) * 0.07;
    for (let k = 0; k < 4; k++) { C(shade, shade, shade); }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Крыша: triangle fan по центроиду
  let cx = 0, cz = 0;
  for (const [x, z] of norm) { cx += x; cz += z; }
  cx /= norm.length; cz /= norm.length;
  const roofBase = positions.length / 3;
  positions.push(cx, 1, cz); C(0.55, 0.6, 0.62); uvs.push(0.5, 0.5);
  for (const [x, z] of norm) { positions.push(x, 1, z); C(0.55, 0.6, 0.62); uvs.push(x + 0.5, z + 0.5); }
  for (let i = 0; i < norm.length; i++) {
    indices.push(roofBase, roofBase + 1 + i, roofBase + 1 + ((i + 1) % norm.length));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const DRIVABLE_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential',
  'living_street', 'service', 'road', 'track',
]);

function isValidBuildingPolygon(poly: unknown): poly is Point2[] {
  return Array.isArray(poly)
    && poly.length >= 3
    && poly.every((p) =>
      Array.isArray(p)
      && p.length >= 2
      && Number.isFinite(Number(p[0]))
      && Number.isFinite(Number(p[1]))
    );
}

export class OsmTileProvider implements CityTileProvider {
  private readonly jsonCache = new Map<string, Promise<TileJson>>();
  private readonly facadeCache = new Map<BuildingKind, THREE.BufferGeometry>();
  private readonly footprintCache = new Map<string, THREE.BufferGeometry>();

  private getFacade(kind: BuildingKind): THREE.BufferGeometry {
    let g = this.facadeCache.get(kind);
    if (!g) { g = makeFacadeGeometry(kind); this.facadeCache.set(kind, g); }
    return g;
  }

  private static worker: Worker | null = null;
  private static workerPending = new Map<string, { resolve: (v: TileJson) => void; reject: (e: Error) => void }>();

  private fetchTile(key: string): Promise<TileJson> {
    // Общий кэш JSON ( Turtle: StreetMetadata) + Worker для парсинга/валидации
    if (!OsmTileProvider.worker) {
      OsmTileProvider.worker = new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' });
      OsmTileProvider.worker.onmessage = (e: MessageEvent) => {
        const p = OsmTileProvider.workerPending.get(e.data.key);
        if (!p) return;
        OsmTileProvider.workerPending.delete(e.data.key);
        if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
        // Собираем TileJson из transferable массивов
        const d = e.data;
        const buildings: TileJson['buildings'] = [];
        for (let i = 0; i < d.bCount; i++) {
          const poly: Point2[] = [];
          for (let j = d.bOffsets[i]; j < d.bOffsets[i + 1]; j += 2) poly.push([d.bPolys[j], d.bPolys[j + 1]]);
          buildings.push({ poly, h: d.bMeta[i * 3], levels: d.bMeta[i * 3 + 1] || undefined, type: d.types[i], est: true });
        }
        const roads: NonNullable<TileJson['roads']> = [];
        for (let i = 0; i < d.rCount; i++) {
          const poly: Point2[] = [];
          for (let j = d.rOffsets[i]; j < d.rOffsets[i + 1]; j += 2) poly.push([d.rPolys[j], d.rPolys[j + 1]]);
          roads.push({ poly, w: d.rMeta[i * 4], lanes: d.rMeta[i * 4 + 1], oneWay: d.rMeta[i * 4 + 2] === 1, speed: d.rMeta[i * 4 + 3], t: d.roadTypes[i], type: d.roadTypes[i] });
        }
        p.resolve({ buildings, roads });
      };
    }
    return new Promise<TileJson>((resolve, reject) => {
      OsmTileProvider.workerPending.set(key, { resolve, reject });
      const url = `${import.meta.env.BASE_URL}map/v1/tiles/${key}.json`;
      OsmTileProvider.worker!.postMessage({ key, url });
    });
  }

  async loadTile(tileX: number, tileZ: number): Promise<CityTilePayload> {
    const key = `${tileX}_${tileZ}`;
    const data = await this.fetchTile(key);
    const originX = tileX * TILE_SIZE, originZ = tileZ * TILE_SIZE;
    const candidates: Array<{ source: BuildingSource; score: number }> = [];

    for (let i = 0; i < (data.buildings?.length ?? 0); i++) {
      const b = data.buildings![i];
      if (!isValidBuildingPolygon(b.poly)) {
        console.warn(`[OSM] Invalid building polygon: ${key}#${i}`);
        continue;
      }
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
      const localX = (minX + maxX) * 0.5 - originX;
      const localZ = (minZ + maxZ) * 0.5 - originZ;
      const valid = [minX, maxX, minZ, maxZ, width, depth, localX, localZ, height].every(Number.isFinite)
        && width >= 0.5 && depth >= 0.5
        && width <= TILE_SIZE + 1 && depth <= TILE_SIZE + 1
        && localX >= -1 && localX <= TILE_SIZE + 1
        && localZ >= -1 && localZ <= TILE_SIZE + 1;
      if (!valid) {
        console.warn(`[OSM] Invalid building dimensions: ${key}#${i}`);
        continue;
      }
      const seed = (tileX * 73856093) ^ (tileZ * 19349663) ^ (i * 83492791);
      // P0 batching: ОДНА общая геометрия на тип здания (4 штуки на игру).
      // Индивидуальная форма/размер/цвет задаются instanceMatrix + instanceColor.
      // Уникальные footprint'ы отключаем — они рвали InstancedMesh на сотни батчей.
      const facade = this.getFacade(kind);
      const source: BuildingSource = {
        position: new THREE.Vector3(localX, 0, localZ),
        size: new THREE.Vector3(width, height, depth),
        color: buildingColor(kind, seed),
        rotationY: 0,
        geometry: facade,
        collidable: true,
      };
      candidates.push({ source, score: width * depth * (1 + height / 60) });
    }

    candidates.sort((a, b) => b.score - a.score);
    const buildings = candidates.slice(0, MAX_BUILDINGS).map((x) => x.source);
    const baseTriangles = buildings.length * 12;
    const roadBudget = Math.min(MAX_ROAD_TRIANGLES, Math.max(0, MAX_TILE_TRIANGLES - baseTriangles));
    const stitched = stitchRoadPieces(data.roads ?? []);
    const roads = buildRoads(stitched, tileX, tileZ, roadBudget);
    return {
      buildings,
      roads,
      roadLines: stitched
        .filter((r) => DRIVABLE_ROADS.has(r.type ?? r.t ?? ''))
        .map((r) => ({
          poly: r.poly,
          oneWay: r.oneWay,
          speed: r.speed,
          lanes: r.lanes,
        })),
    };
  }

  dispose(): void {
    this.jsonCache.clear();
    for (const g of this.facadeCache.values()) g.dispose();
    this.facadeCache.clear();
    for (const g of this.footprintCache.values()) g.dispose();
    this.footprintCache.clear();
  }
}
