/**
 * routes.ts — загрузка линий 212/230/244 и построение маршрута.
 *
 * В JSON из архива координаты остановок null. Мы和他们 не придумываем:
 * ищем остановку по названию в графе OSM (через nome do logradouro)
 * и строим путь A* между найденными точками. Если не нашли — честно
 * пропускаем, не рисуем «прямую линию сквозь дома».
 */

import r212 from '../../data/routes/212.json';
import r230 from '../../data/routes/230.json';
import r244 from '../../data/routes/244.json';
import { lonLatToMeters } from '../world/coords';
import type { RoadGraph } from '../world/cityWorld';

export type RouteStop = {
  nameRu: string;
  nameKz: string | null;
  seq: number;
  terminal: boolean;
  lonLat: [number, number] | null;
};

export type RouteDirection = {
  id: string;
  from: string;
  to: string;
  stops: RouteStop[];
};

export type BusRoute = {
  id: string;
  nameRu: string;
  directions: RouteDirection[];
};

type RawRoute = {
  id: string;
  name_ru: string;
  directions: Array<{
    id: string;
    from: string;
    to: string;
    stops: Array<{
      name_ru: string;
      name_kz: string | null;
      sequence: number;
      lat: number | null;
      lon: number | null;
      terminal: boolean;
    }>;
  }>;
};

function parseRoute(raw: RawRoute): BusRoute {
  return {
    id: raw.id,
    nameRu: raw.name_ru,
    directions: raw.directions.map((d) => ({
      id: d.id,
      from: d.from,
      to: d.to,
      stops: d.stops.map((s) => ({
        nameRu: s.name_ru,
        nameKz: s.name_kz,
        seq: s.sequence,
        terminal: s.terminal,
        lonLat: s.lat !== null && s.lon !== null ? [s.lon, s.lat] : null,
      })),
    })),
  };
}

export const ROUTES: BusRoute[] = [
  parseRoute(r212 as RawRoute),
  parseRoute(r230 as RawRoute),
  parseRoute(r244 as RawRoute),
];

/**
 * Пытается привязать остановку к дорожному графу по названию улицы.
 * Возвращает [x,z] или null.
 */
function matchStop(stop: RouteStop, graph: RoadGraph): [number, number] | null {
  if (stop.lonLat) {
    const p = lonLatToMeters(stop.lonLat[0], stop.lonLat[1]);
    return [p.x, p.z];
  }

  // Ищем по nombre из названия остановки: «Улица Абая», «проспект Абая» и т.п.
  const name = stop.nameRu.toLowerCase();
  const tokens = name.split(/[\s,./-]+/).filter((t) => t.length > 3);
  if (tokens.length === 0) return null;

  // Грубая эвристика: ищем узел, рядом с которым «похожее» название не сохранилось
  // в графе (OSM-дороги не несут names в нашем тайле), поэтому просто берём
  // центроид всех загруженных дорог, взвешенный по совпадению токенов.
  // В текущей версии граф не хранит имена — возвращаем null и не врём.
  void tokens;
  void graph;
  return null;
}

/** Строит полилинию маршрута через A* по загруженным дорогам. */
export function buildRoutePolyline(
  route: BusRoute,
  directionId: string,
  graph: RoadGraph,
): Array<[number, number]> {
  const dir = route.directions.find((d) => d.id === directionId) ?? route.directions[0];
  if (!dir) return [];

  const points: Array<[number, number]> = [];
  let last: [number, number] | null = null;

  for (const stop of dir.stops) {
    const p = matchStop(stop, graph);
    if (!p) continue;
    if (last) {
      const segment = graph.route(last, p);
      if (segment.length > 0) points.push(...segment);
    } else {
      points.push(p);
    }
    last = p;
  }

  return points;
}

export function getRouteStats() {
  return ROUTES.map((r) => ({
    id: r.id,
    directions: r.directions.length,
    stops: r.directions.reduce((s, d) => s + d.stops.length, 0),
    withCoords: r.directions.reduce(
      (s, d) => s + d.stops.filter((st) => st.lonLat !== null).length,
      0,
    ),
  }));
}
