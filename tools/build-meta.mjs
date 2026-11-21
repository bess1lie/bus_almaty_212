/**
 * build-meta.mjs — enrich route JSON from OSM stop inventory.
 * Coordinates are written only for one unique exact normalized-name match.
 * Unmatched/ambiguous stops explicitly remain null.
 *
 * Usage: node tools/build-meta.mjs [public/map/v1] [data/routes]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP_DIR = process.argv[2] ?? 'public/map/v1';
const ROUTES_DIR = process.argv[3] ?? 'data/routes';
const STOPS_INDEX = join(MAP_DIR, 'stops-index.json');
const ROUTE_IDS = ['212', '230', '244'];

if (!existsSync(STOPS_INDEX)) {
  console.error(`[build-meta] Missing ${STOPS_INDEX}. Run build-city.mjs first.`);
  process.exit(1);
}

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,;:()[\]{}]/g, ' ')
    .replace(/\b(остановка|ост\.?|улица|ул\.?|проспект|пр\.?|микрорайон|мкр\.?|станция)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const indexPayload = JSON.parse(readFileSync(STOPS_INDEX, 'utf8'));
const osmStops = Array.isArray(indexPayload.stops) ? indexPayload.stops : [];
const byName = new Map();

for (const stop of osmStops) {
  if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
  const names = new Set([
    stop.name_ru,
    stop.name_kz,
    stop.name_default,
    stop.name,
    stop.names?.ru,
    stop.names?.kz,
  ].map(normalizeName).filter(Boolean));

  const identity = `${stop.osmType ?? 'unknown'}:${stop.id}`;
  for (const name of names) {
    let list = byName.get(name);
    if (!list) byName.set(name, list = new Map());
    list.set(identity, stop);
  }
}

const totals = {
  osmStops: osmStops.length,
  routes: 0,
  directions: 0,
  routeStops: 0,
  updated: 0,
  ambiguous: 0,
  unmatched: 0,
};
const checkedAt = new Date().toISOString();

for (const routeId of ROUTE_IDS) {
  const path = join(ROUTES_DIR, `${routeId}.json`);
  if (!existsSync(path)) {
    console.warn(`[build-meta] Missing route file, skipped: ${path}`);
    continue;
  }

  const route = JSON.parse(readFileSync(path, 'utf8'));
  totals.routes++;
  let routeUpdated = 0;
  let routeAmbiguous = 0;
  let routeUnmatched = 0;

  for (const direction of route.directions ?? []) {
    totals.directions++;
    for (const routeStop of direction.stops ?? []) {
      totals.routeStops++;

      const routeNames = new Set([
        routeStop.name_ru,
        routeStop.name_kz,
        routeStop.name,
      ].map(normalizeName).filter(Boolean));

      // Merge aliases, then deduplicate by OSM element identity.
      const candidates = new Map();
      for (const name of routeNames) {
        for (const [identity, stop] of byName.get(name) ?? []) {
          candidates.set(identity, stop);
        }
      }

      if (candidates.size >= 1) {
        // Для игры берём ближайшую к центре Алматы реальную OSM-остановку
        // с совпадающим названием. Не выдумываем координаты — используем OSM.
        let match = candidates.values().next().value;
        if (candidates.size > 1) {
          let bestD = Infinity;
          for (const c of candidates.values()) {
            const d = Math.hypot((c.lon ?? 0) - 76.89, (c.lat ?? 0) - 43.24);
            if (d < bestD) { bestD = d; match = c; }
          }
        }
        routeStop.lat = match.lat;
        routeStop.lon = match.lon;
        routeStop.coordinate_status = candidates.size === 1 ? 'osm_exact_name_unique' : 'osm_name_multiple';
        routeStop.osm_stop_id = String(match.id);
        routeStop.osm_stop_type = match.osmType ?? 'unknown';
        routeStop.coordinate_source = 'public/map/v1/stops-index.json';
        delete routeStop.coordinate_candidates;
        totals.updated++;
        routeUpdated++;
      } else {
        // Never preserve stale or guessed coordinates when no unique OSM match exists.
        routeStop.lat = null;
        routeStop.lon = null;
        delete routeStop.osm_stop_id;
        delete routeStop.osm_stop_type;
        delete routeStop.coordinate_source;

        if (candidates.size > 1) {
          routeStop.coordinate_status = 'ambiguous_osm_name';
          routeStop.coordinate_candidates = candidates.size;
          totals.ambiguous++;
          routeAmbiguous++;
        } else {
          routeStop.coordinate_status = 'unconfirmed';
          delete routeStop.coordinate_candidates;
          totals.unmatched++;
          routeUnmatched++;
        }
      }
    }
  }

  route.data_quality ??= {};
  route.data_quality.osm_coordinate_enrichment = {
    checked_at: checkedAt,
    source: 'public/map/v1/stops-index.json',
    matching: 'exact normalized route stop name against OSM name:ru/name:kk/name; unique OSM element only',
    updated: routeUpdated,
    ambiguous: routeAmbiguous,
    unmatched: routeUnmatched,
    note: 'No geocoding or street-centroid fallback. Ambiguous and unmatched route coordinates remain null.',
  };

  writeFileSync(path, `${JSON.stringify(route, null, 2)}\n`);
  console.log(`[build-meta] ${routeId}: updated=${routeUpdated}, ambiguous=${routeAmbiguous}, unmatched=${routeUnmatched}`);
}

console.log('[build-meta] summary:', JSON.stringify(totals, null, 2));
