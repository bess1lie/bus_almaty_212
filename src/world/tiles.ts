/**
 * tiles.ts — типы OSM-городских тайлов и lazy-загрузчик из public/map/v1/tiles.
 */

export type CityBuilding = {
  poly: [number, number][];
  h: number;          // высота, м
  type: string;       // building:* или эвристический тип
  est: boolean;       // рост не из OSM
  c?: [number, number];
};

export type CityRoad = {
  poly: [number, number][];
  w: number;          // ширина, м
  lanes: number;
  oneWay: boolean;
  speed: number;      // км/ч
  type: string;
};

export type CityTile = {
  buildings: CityBuilding[];
  roads: CityRoad[];
};

const TILE_SIZE = 2000;

export function tileKeyFromPos(x: number, z: number): string {
  return `${Math.floor(x / TILE_SIZE)},${Math.floor(z / TILE_SIZE)}`;
}

export function tileCenter(key: string): [number, number] {
  const [tx, tz] = key.split(',').map(Number);
  return [tx * TILE_SIZE + TILE_SIZE / 2, tz * TILE_SIZE + TILE_SIZE / 2];
}

const tileCache = new Map<string, Promise<CityTile>>();

export function loadTile(key: string): Promise<CityTile> {
  let p = tileCache.get(key);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}map/v1/tiles/${key}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`tile ${key} -> ${r.status}`);
        return r.json() as Promise<CityTile>;
      })
      .catch((err) => {
        tileCache.delete(key); // не ретеним падающие запросы
        throw err;
      });
    tileCache.set(key, p);
  }
  return p;
}

export function clearTileCache() {
  tileCache.clear();
}

export function tileTiles(): string[] {
  // все известные ключи тайлов (для статистики/логики)
  return [...tileCache.keys()];
}
