/**
 * tiles.ts — единый pipeline загрузки OSM-тайлов.
 * Один запрос на ключ, один разбор Worker-ом, один общий LRU-кэш
 * для OsmTileProvider и StreetMetadataProvider.
 */

export type Point2 = [number, number];

export type CityBuilding = {
  poly: Point2[];
  h: number;
  type: string;
  est: boolean;
  levels?: number;
  c?: Point2;
  bounds?: [number, number, number, number]; // minX, maxX, minZ, maxX — из Worker
};

export type CityRoad = {
  id?: string;
  poly: Point2[];
  w: number;
  lanes: number;
  oneWay: boolean;
  speed: number;
  type: string;
  t?: string;
  sourceLengthM?: number;
  lengthM?: number;
};

export type CityStop = {
  id?: string;
  position: Point2;
  yaw?: number;
  model?: string;
  name?: string;
  name_ru?: string;
  name_kz?: string | null;
};

export type CityGreenZone = {
  id?: string;
  points: Point2[];
};

export type CityTile = {
  buildings: CityBuilding[];
  roads: CityRoad[];
  stops: CityStop[];
  greenZones: CityGreenZone[];
};

const TILE_SIZE = 2000;
const MAX_CACHE = 32;

export function tileKeyFromPos(x: number, z: number): string {
  return `${Math.floor(x / TILE_SIZE)}_${Math.floor(z / TILE_SIZE)}`;
}

export function tileCenter(key: string): [number, number] {
  const [tx, tz] = key.split('_').map(Number);
  return [tx * TILE_SIZE + TILE_SIZE / 2, tz * TILE_SIZE + TILE_SIZE / 2];
}

// Единый LRU-кэш: Promise на ключ. Нет второго独立 кэша, нет 32-элементного порога.
const cache = new Map<string, Promise<CityTile>>();

export function hasTile(key: string): boolean {
  return cache.has(key);
}

export function getCachedTile(key: string): Promise<CityTile> | undefined {
  // LRU: при обращении поднимаем запись в конец
  const p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); }
  return p;
}

export function putTile(key: string, promise: Promise<CityTile>): void {
  cache.delete(key);
  cache.set(key, promise);
  evict();
}

function evict() {
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Вызвать при выгрузке тайла из сцены — убрать данные из кэша. */
export function evictTile(key: string): void {
  cache.delete(key);
}

export function clearTileCache(): void {
  cache.clear();
}

export function tileTiles(): string[] {
  return [...cache.keys()];
}
