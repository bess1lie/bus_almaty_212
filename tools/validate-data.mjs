/**
 * validate-data.mjs — строгая проверка OSM-тайлов и manifest.
 * Node.js 22, без дополнительных зависимостей.
 *
 * Usage: node tools/validate-data.mjs [public/map/v1] [data/routes]
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

const MAP_DIR = process.argv[2] ?? 'public/map/v1';
const ROUTES_DIR = process.argv[3] ?? 'data/routes';
const TILE_DIR = join(MAP_DIR, 'tiles');
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const ROAD_LENGTH_TOLERANCE_M = 1.0;
const errors = [];
const warnings = [];

const summary = {
  tiles: 0,
  totalBytes: 0,
  maxTileBytes: 0,
  buildings: 0,
  roads: 0,
  greenZoneTilePieces: 0,
  stops: 0,
  measuredRoadLengthM: 0,
  sourceRoadLengthM: 0,
  routeStops: 0,
  routeStopsWithCoordinates: 0,
  routeStopsUnresolved: 0,
};

function fail(message) {
  errors.push(message);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2 &&
    finiteNumber(point[0]) && finiteNumber(point[1]);
}

function lineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
  }
  return length;
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label}: invalid JSON: ${error.message}`);
    return null;
  }
}

const manifestPath = join(MAP_DIR, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`[validate-data] FAIL: missing ${manifestPath}`);
  process.exit(1);
}
if (!existsSync(TILE_DIR)) {
  console.error(`[validate-data] FAIL: missing ${TILE_DIR}`);
  process.exit(1);
}

const manifest = loadJson(manifestPath, 'manifest');
if (!manifest) process.exit(1);

const tileNames = manifest.tiles?.tiles;
if (!Array.isArray(tileNames)) {
  console.error('[validate-data] FAIL: manifest.tiles.tiles must be an array');
  process.exit(1);
}

const roadById = new Map();
const actualTileFiles = new Set(
  readdirSync(TILE_DIR).filter((name) => name.endsWith('.json')),
);
const expectedTileFiles = new Set(tileNames.map((key) => `${key}.json`));

for (const filename of actualTileFiles) {
  if (!expectedTileFiles.has(filename)) {
    warnings.push(`Unlisted tile file: ${filename}`);
  }
}

for (const tileKey of tileNames) {
  const filename = `${tileKey}.json`;
  const path = join(TILE_DIR, filename);
  if (!existsSync(path)) {
    fail(`Missing tile listed in manifest: ${path}`);
    continue;
  }

  const bytes = statSync(path).size;
  summary.tiles++;
  summary.totalBytes += bytes;
  summary.maxTileBytes = Math.max(summary.maxTileBytes, bytes);
  if (bytes > MAX_TILE_BYTES) {
    fail(`${filename}: ${bytes} bytes exceeds 2 MiB (${MAX_TILE_BYTES})`);
  }

  const tile = loadJson(path, filename);
  if (!tile) continue;

  if (tile.version !== 1) fail(`${filename}: expected version=1`);
  if (!Array.isArray(tile.buildings)) fail(`${filename}: buildings must be an array`);
  if (!Array.isArray(tile.roads)) fail(`${filename}: roads must be an array`);
  if (!Array.isArray(tile.greenZones)) fail(`${filename}: greenZones must be an array`);
  if (!Array.isArray(tile.stops)) fail(`${filename}: stops must be an array`);

  for (const building of tile.buildings ?? []) {
    summary.buildings++;
    if (!finiteNumber(building.h) || building.h <= 0) {
      fail(`${filename}: building ${building.id} has invalid h`);
    }
    if (!finiteNumber(building.levels) || building.levels <= 0) {
      fail(`${filename}: building ${building.id} has invalid/non-positive levels`);
    }
    if (typeof building.estimated !== 'boolean') {
      fail(`${filename}: building ${building.id} has no boolean estimated flag`);
    }
    if (!Array.isArray(building.poly) || building.poly.length < 3 ||
        building.poly.some((point) => !finitePoint(point))) {
      fail(`${filename}: building ${building.id} has invalid polygon`);
    }
  }

  for (const road of tile.roads ?? []) {
    summary.roads++;
    if (typeof road.t !== 'string' || !road.t) {
      fail(`${filename}: road ${road.id} missing string t`);
    }
    if (typeof road.type !== 'string' || !road.type) {
      fail(`${filename}: road ${road.id} missing string type`);
    }
    if (road.t !== road.type) {
      fail(`${filename}: road ${road.id} has t=${road.t} but type=${road.type}`);
    }
    if (!finiteNumber(road.w) || road.w <= 0) {
      fail(`${filename}: road ${road.id} has invalid width w`);
    }
    if (!Array.isArray(road.poly) || road.poly.length < 2 ||
        road.poly.some((point) => !finitePoint(point))) {
      fail(`${filename}: road ${road.id} has invalid polyline`);
      continue;
    }

    const measuredLength = lineLength(road.poly);
    summary.measuredRoadLengthM += measuredLength;

    if (!finiteNumber(road.sourceLengthM) || typeof road.id !== 'string') {
      fail(`${filename}: road missing string id or finite sourceLengthM`);
      continue;
    }

    let entry = roadById.get(road.id);
    if (!entry) {
      entry = { sourceLengthM: road.sourceLengthM, tiledLengthM: 0, pieces: 0 };
      roadById.set(road.id, entry);
    } else if (Math.abs(entry.sourceLengthM - road.sourceLengthM) > 0.002) {
      fail(`${filename}: road ${road.id} has inconsistent sourceLengthM between tile pieces`);
    }
    entry.tiledLengthM += measuredLength;
    entry.pieces++;

    if (!finiteNumber(road.lengthM) || Math.abs(road.lengthM - measuredLength) > 0.02) {
      fail(`${filename}: road ${road.id} lengthM does not match polyline`);
    }
  }

  for (const zone of tile.greenZones ?? []) {
    summary.greenZoneTilePieces++;
    if (!Array.isArray(zone.poly) || zone.poly.length < 3 ||
        zone.poly.some((point) => !finitePoint(point))) {
      fail(`${filename}: green zone ${zone.id} has invalid polygon`);
    }
  }

  for (const stop of tile.stops ?? []) {
    summary.stops++;
    if (!finitePoint(stop.position)) {
      fail(`${filename}: stop ${stop.id} has non-finite position`);
    }
    if (!finiteNumber(stop.yaw)) fail(`${filename}: stop ${stop.id} has invalid yaw`);
    if (stop.model !== 'soviet' && stop.model !== 'modern') {
      fail(`${filename}: stop ${stop.id} has invalid model`);
    }
    if (typeof stop.name !== 'string') {
      fail(`${filename}: stop ${stop.id} name must be a string`);
    }
    if (!finiteNumber(stop.lat) || !finiteNumber(stop.lon)) {
      fail(`${filename}: stop ${stop.id} has non-finite WGS84 lat/lon`);
    }
    if (stop.lat < -90 || stop.lat > 90 || stop.lon < -180 || stop.lon > 180) {
      fail(`${filename}: stop ${stop.id} has out-of-range WGS84 coordinates`);
    }
  }
}

// Every road run stores its own pre-split length in each tile fragment.
for (const [roadId, road] of roadById) {
  summary.sourceRoadLengthM += road.sourceLengthM;
  const delta = Math.abs(road.sourceLengthM - road.tiledLengthM);
  if (delta > ROAD_LENGTH_TOLERANCE_M) {
    fail(`Road ${roadId}: source=${road.sourceLengthM.toFixed(3)}m, pieces=${road.tiledLengthM.toFixed(3)}m, delta=${delta.toFixed(3)}m (> 1m)`);
  }
}

const manifestChecks = [
  ['buildings', summary.buildings],
  ['roads', summary.roads],
  ['stops', summary.stops],
  ['stats.greenZoneTilePieces', summary.greenZoneTilePieces],
  ['tiles.maxBytes', summary.maxTileBytes],
];
for (const [field, measured] of manifestChecks) {
  const parts = field.split('.');
  let value = manifest;
  for (const part of parts) value = value?.[part];
  if (!Number.isFinite(value)) fail(`manifest.${field} must be a finite number`);
  else if (value !== measured) fail(`manifest.${field}=${value}, measured=${measured}`);
}

if (manifest.tiles?.size !== 2000) fail(`manifest.tiles.size must be 2000, got ${manifest.tiles?.size}`);
if (manifest.parks !== manifest.stats?.parks) {
  fail(`manifest.parks=${manifest.parks}, manifest.stats.parks=${manifest.stats?.parks}`);
}
if (manifest.tiles?.count !== tileNames.length) {
  fail(`manifest.tiles.count=${manifest.tiles?.count}, listed=${tileNames.length}`);
}
if (manifest.maxTileBytes != null && manifest.maxTileBytes !== summary.maxTileBytes) {
  fail(`manifest.maxTileBytes=${manifest.maxTileBytes}, measured=${summary.maxTileBytes}`);
}

const sourceLength = manifest.roadLength?.sourceLengthM;
const tiledLength = manifest.roadLength?.tiledLengthM;
const manifestDelta = manifest.roadLength?.deltaM;
if (!finiteNumber(sourceLength) || !finiteNumber(tiledLength) || !finiteNumber(manifestDelta)) {
  fail('manifest.roadLength.sourceLengthM/tiledLengthM/deltaM must be finite numbers');
} else {
  const measuredDelta = Math.abs(sourceLength - summary.measuredRoadLengthM);
  const groupedSourceDelta = Math.abs(sourceLength - summary.sourceRoadLengthM);
  if (groupedSourceDelta > 0.5) {
    fail(`Sum of per-road sourceLengthM values differs from manifest by ${groupedSourceDelta.toFixed(3)}m`);
  }
  if (manifestDelta > ROAD_LENGTH_TOLERANCE_M) {
    fail(`manifest roadLength.deltaM=${manifestDelta} exceeds 1m`);
  }
  if (Math.abs(tiledLength - summary.measuredRoadLengthM) > 0.03) {
    fail(`manifest tiled road length=${tiledLength}, measured=${summary.measuredRoadLengthM.toFixed(3)}m`);
  }
  if (Math.abs(manifestDelta - Math.abs(sourceLength - tiledLength)) > 0.03) {
    fail(`manifest roadLength.deltaM=${manifestDelta} inconsistent with source/tiled values`);
  }
  if (measuredDelta > ROAD_LENGTH_TOLERANCE_M) {
    fail(`Global road length delta=${measuredDelta.toFixed(3)}m (> 1m)`);
  }
  summary.roadLengthDeltaM = Number(measuredDelta.toFixed(4));
}

const stopsIndexPath = join(MAP_DIR, 'stops-index.json');
if (existsSync(stopsIndexPath)) {
  const index = loadJson(stopsIndexPath, 'stops-index');
  for (const stop of index?.stops ?? []) {
    if (!finitePoint(stop.position) || !finiteNumber(stop.lat) || !finiteNumber(stop.lon)) {
      fail(`stops-index: stop ${stop.id} has non-finite coordinates`);
    }
  }
}

// Route stops are deliberately allowed to remain null unless build-meta found
// one unique exact OSM-name match. Partial/non-finite coordinate pairs fail.
if (existsSync(ROUTES_DIR)) {
  const routeFiles = readdirSync(ROUTES_DIR).filter((name) => /^(212|230|244)\.json$/.test(name));
  for (const filename of routeFiles) {
    const route = loadJson(join(ROUTES_DIR, filename), filename);
    for (const direction of route?.directions ?? []) {
      for (const stop of direction.stops ?? []) {
        summary.routeStops++;
        const latNull = stop.lat == null;
        const lonNull = stop.lon == null;
        if (latNull && lonNull) {
          summary.routeStopsUnresolved++;
          continue;
        }
        if (latNull !== lonNull || !finiteNumber(stop.lat) || !finiteNumber(stop.lon)) {
          fail(`${filename}: stop ${stop.name_ru ?? stop.sequence} has invalid coordinate pair`);
          continue;
        }
        if (stop.lat < -90 || stop.lat > 90 || stop.lon < -180 || stop.lon > 180) {
          fail(`${filename}: stop ${stop.name_ru ?? stop.sequence} has out-of-range WGS84 coordinates`);
          continue;
        }
        summary.routeStopsWithCoordinates++;
        if (stop.coordinate_status && stop.coordinate_status !== 'osm_exact_name_unique') {
          fail(`${filename}: stop ${stop.name_ru ?? stop.sequence} has coordinates but status=${stop.coordinate_status}`);
        }
      }
    }
  }
}

console.log('[validate-data] summary:', JSON.stringify(summary, null, 2));
if (warnings.length) for (const warning of warnings) console.warn(`[WARN] ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`[FAIL] ${error}`);
  console.error(`[validate-data] FAIL: ${errors.length} error(s)`);
  process.exit(1);
}
console.log('[validate-data] PASS');
