/**
 * tiles.ts — типы OSM-городских тайлов и lazy-загрузчик из public/map/v1/tiles.
 */

export type CityBuilding = {
  poly: [number, number][];
  h: number;          // высота, м
  type: string;       // building:* или эвристический тип
  est: boolean;       // рост не из OSM
  levels?: number;    // этажность из OSM building:levels
  c?: [number, number];
};

export type CityRoad = {
  id?: string;
  poly: [number, number][];
  w: number;          // ширина, м
  lanes: number;
  oneWay: boolean;
  speed: number;      // км/ч
  type: string;
  t?: string;         // алиас типа из OSM-пайплайна
  sourceLengthM?: number;
  lengthM?: number;
};

export type CityTile = {
  buildings: CityBuilding[];
  roads: CityRoad[];
};

const TILE_SIZE = 2000;

export function tileKeyFromPos(x: number, z: number): string {
  return `${Math.floor(x / TILE_SIZE)}_${Math.floor(z / TILE_SIZE)}`;
}

export function tileCenter(key: string): [number, number] {
  const [tx, tz] = key.split('_').map(Number);
  return [tx * TILE_SIZE + TILE_SIZE / 2, tz * TILE_SIZE + TILE_SIZE / 2];
}

// Один общий raw-JSON кэш на тайл: все потребители (OsmTileProvider,
// StreetMetadataProvider) получают ОДИН и тот же разобранный объект.
const rawCache = new Map<string, Promise<CityTile>>();

export function loadTileRaw(key: string): Promise<CityTile> {
  let p = rawCache.get(key);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}map/v1/tiles/${key}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`tile ${key} -> ${r.status}`);
        return r.json() as Promise<CityTile>;
      })
      .catch((err) => {
        rawCache.delete(key);
        throw err;
      });
    rawCache.set(key, p);
  }
  return p;
}

// Уже разобранный Worker-ом JSON — им пользуется StreetMetadata, чтобы не парсить дважды.
const decodedCache = new Map<string, CityTile>();

export function setDecodedTile(key: string, data: CityTile): void {
  if (decodedCache.size < 32) decodedCache.set(key, data);
}

export function getDecodedTile(key: string): CityTile | undefined {
  return decodedCache.get(key);
}

/** @deprecated используйте loadTileRaw */
export function loadTile(key: string): Promise<CityTile> { return loadTileRaw(key); }

export function clearTileCache() {
  rawCache.clear();
}

export function tileTiles(): string[] {
  // все известные ключи тайлов (для статистики/логики)
  return [...rawCache.keys()];
}
