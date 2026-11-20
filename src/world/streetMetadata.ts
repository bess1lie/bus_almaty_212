/**
 * streetMetadata.ts — дескрипторы тайлов для streetProps.ts из OSM JSON.
 * Грузит те же тайлы, что и OsmTileProvider, и превращает roads в формат streetProps.
 */

import type { StreetTileDescriptor } from './streetProps';
import type { CityRoad } from './tiles';

type TileJson = { roads: CityRoad[] };

const descriptors = new Map<string, StreetTileDescriptor>();
const pending = new Set<string>();

export function getTileDescriptor(tileX: number, tileZ: number): StreetTileDescriptor | null {
  return descriptors.get(`${tileX}:${tileZ}`) ?? null;
}

/** Асинхронно подготовить дескриптор (вызывать при загрузке тайла). */
export function prepareTileMetadata(tileX: number, tileZ: number): void {
  const key = `${tileX}:${tileZ}`;
  if (descriptors.has(key) || pending.has(key)) return;
  pending.add(key);

  const url = `${import.meta.env.BASE_URL}map/v1/tiles/${tileX}_${tileZ}.json`;
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: TileJson | null) => {
      if (!data) return;
      const desc: StreetTileDescriptor = {
        key,
        x: tileX,
        z: tileZ,
        version: 1,
        roads: data.roads.map((road) => ({
          id: `road-${road.poly.length}-${Math.round(road.poly[0]?.[0] ?? 0)}`,
          width: road.w,
          points: road.poly,
          sidewalks: true,
          markings: road.lanes >= 2,
        })),
        greenZones: [],
        stops: [],
      };
      descriptors.set(key, desc);
    })
    .catch(() => {})
    .finally(() => pending.delete(key));
}

/** Провайдер для streetProps.createStreetProps(). */
export function makeStreetTileProvider(
  cityWorld: { getLoadedTiles(): Array<[number, number]> }
): () => StreetTileDescriptor[] {
  return () => {
    const result: StreetTileDescriptor[] = [];
    for (const [x, z] of cityWorld.getLoadedTiles()) {
      prepareTileMetadata(x, z);
      const d = getTileDescriptor(x, z);
      if (d) result.push(d);
    }
    return result;
  };
}
