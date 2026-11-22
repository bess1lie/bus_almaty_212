/**
 * routes.ts — типы и загрузка линий 212/230/244 из data/routes/*.json.
 */

import r212 from '../../data/routes/212.json';
import r230 from '../../data/routes/230.json';
import r244 from '../../data/routes/244.json';

export type RouteStop = {
  name_ru: string;
  name_kz: string | null;
  sequence: number;
  lat: number | null;
  lon: number | null;
  coordinate_status?: string;
  terminal: boolean;
};

export type RouteDirection = {
  id: string;
  from: string;
  to: string;
  stops: RouteStop[];
};

export type BusRoute = {
  id: string;
  name_ru: string;
  name_kz: string | null;
  directions: RouteDirection[];
};

function parse(raw: unknown): BusRoute {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    name_ru: String(r.name_ru ?? r.id),
    name_kz: (r.name_kz as string | null) ?? null,
    directions: ((r.directions as unknown[]) ?? []).map((d) => {
      const dir = d as Record<string, unknown>;
      return {
        id: String(dir.id),
        from: String(dir.from ?? ''),
        to: String(dir.to ?? ''),
        stops: ((dir.stops as unknown[]) ?? []).map((s) => {
          const st = s as Record<string, unknown>;
          return {
            name_ru: String(st.name_ru ?? ''),
            name_kz: (st.name_kz as string | null) ?? null,
            sequence: Number(st.sequence ?? 0),
            lat: (st.lat as number | null) ?? null,
            lon: (st.lon as number | null) ?? null,
            coordinate_status: st.coordinate_status as string | undefined,
            terminal: Boolean(st.terminal),
          };
        }),
      };
    }),
  };
}

export const ROUTES: BusRoute[] = [parse(r212), parse(r230), parse(r244)];

export function getRoute(id: string): BusRoute | undefined {
  return ROUTES.find((r) => r.id === id);
}
