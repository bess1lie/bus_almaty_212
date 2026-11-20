/**
 * build-city.mjs — строит OSM-тайлы Алматы и Карасая.
 * Roads are clipped to REGION and split at every 2 km grid crossing.
 * Buildings and green polygons are clipped into every tile they intersect.
 * Coordinates in JSON: absolute local metres, X=east, Z=south.
 *
 * Usage:
 *   node --max-old-space-size=12000 tools/build-city.mjs [input.osm.pbf] [public/map/v1]
 *   CENTRE=1 node --max-old-space-size=12000 tools/build-city.mjs [input.osm.pbf] [public/map/v1]
 */
import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import osmRead from 'osm-read';

const PBF = process.argv[2] ?? '/tmp/opencode/kazakhstan-latest.osm.pbf';
const OUT = process.argv[3] ?? 'public/map/v1';
const TILE_SIZE = 2000;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const NODE_MARGIN_DEG = 0.06;
const ROAD_SIMPLIFY_M = 1.25;
const AREA_SIMPLIFY_M = 1.0;
const GREEN_MIN_AREA_M2 = 60;
const STOP_INDEX_CELL_M = 250;
const MAX_STOP_SEARCH_CELLS = 16;
const COORD_DIGITS = 2;
const CENTRE = process.env.CENTRE === '1';

const ORIGIN_LAT = 43.2389;
const ORIGIN_LON = 76.8897;
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const lonLatToMeters = (lon, lat) => ({
  x: (lon - ORIGIN_LON) * METERS_PER_DEG_LON,
  z: -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT,
});
const metersToLonLat = (x, z) => ({
  lon: ORIGIN_LON + x / METERS_PER_DEG_LON,
  lat: ORIGIN_LAT - z / METERS_PER_DEG_LAT,
});
const round = (value, digits = COORD_DIGITS) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const samePoint = (a, b, eps = 1e-7) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

const BBOX = CENTRE
  ? { minLon: 76.82, maxLon: 76.98, minLat: 43.19, maxLat: 43.29 }
  : { minLon: 76.55, maxLon: 77.25, minLat: 43.05, maxLat: 43.42 };
const REGION = {
  minX: lonLatToMeters(BBOX.minLon, BBOX.maxLat).x,
  maxX: lonLatToMeters(BBOX.maxLon, BBOX.maxLat).x,
  minZ: lonLatToMeters(BBOX.minLon, BBOX.maxLat).z,
  maxZ: lonLatToMeters(BBOX.minLon, BBOX.minLat).z,
};
const NODE_BBOX = {
  minLon: BBOX.minLon - NODE_MARGIN_DEG,
  maxLon: BBOX.maxLon + NODE_MARGIN_DEG,
  minLat: BBOX.minLat - NODE_MARGIN_DEG,
  maxLat: BBOX.maxLat + NODE_MARGIN_DEG,
};
const inBBox = (lon, lat, bbox = BBOX) =>
  lon >= bbox.minLon && lon <= bbox.maxLon &&
  lat >= bbox.minLat && lat <= bbox.maxLat;
const inRegion = (x, z) =>
  x >= REGION.minX && x <= REGION.maxX &&
  z >= REGION.minZ && z <= REGION.maxZ;
const tileOf = (x, z) => [Math.floor(x / TILE_SIZE), Math.floor(z / TILE_SIZE)];
const tileKey = (x, z) => `${x}_${z}`;

const TYPE_HEIGHT = {
  house: [4, 8], residential: [5, 12], apartments: [15, 60],
  dormitory: [12, 28], terrace: [5, 12], commercial: [6, 22],
  retail: [4, 18], office: [8, 45], industrial: [6, 16],
  warehouse: [5, 14], school: [7, 18], university: [12, 35],
  hospital: [10, 35], church: [8, 25], garage: [2.5, 5],
};

function stable01(value) {
  const text = String(value ?? '0');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function parsePositive(value) {
  if (value == null) return null;
  const match = String(value).trim().replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getBuildingHeight(tags, area, id) {
  const explicitHeight = parsePositive(tags.height);
  const osmLevels = parsePositive(tags['building:levels']);
  const levelsHeight = osmLevels != null && osmLevels <= 150
    ? osmLevels * 3.1
    : null;

  // h сохраняет приоритет точного height для существующего рендерера.
  // levels — фасадная высота в метрах: этажность * 3.1, иначе height.
  if (explicitHeight != null && explicitHeight <= 500) {
    return {
      h: explicitHeight,
      levels: levelsHeight ?? explicitHeight,
      buildingLevels: osmLevels,
      estimated: false,
      heightSource: 'height',
    };
  }

  if (levelsHeight != null) {
    return {
      h: levelsHeight,
      levels: levelsHeight,
      buildingLevels: osmLevels,
      estimated: true,
      heightSource: 'building:levels',
    };
  }

  const type = tags.building === 'yes' ? 'residential' : tags.building;
  const range = TYPE_HEIGHT[type] ?? (area < 80 ? [3, 6] : area < 500 ? [4, 10] : [6, 16]);
  const h = range[0] + stable01(id) * (range[1] - range[0]);
  return {
    h,
    levels: h,
    buildingLevels: null,
    estimated: true,
    heightSource: 'heuristic',
  };
}

function polyArea(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) * 0.5;
}

function centroid(points) {
  let x = 0;
  let z = 0;
  for (const p of points) { x += p[0]; z += p[1]; }
  return [x / points.length, z / points.length];
}

function boundsOf(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

function simplifyPolyline(points, epsilon) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = points[start];
    const b = points[end];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    let maxDistanceSq = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      let t = lenSq > 1e-12
        ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq
        : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + t * dx;
      const pz = a[1] + t * dz;
      const dSq = (p[0] - px) ** 2 + (p[1] - pz) ** 2;
      if (dSq > maxDistanceSq) { maxDistanceSq = dSq; maxIndex = i; }
    }
    if (maxIndex >= 0 && maxDistanceSq > epsilon * epsilon) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  const result = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
  return result;
}

function simplifyRing(ring, epsilon) {
  const unique = [];
  for (const p of ring) {
    if (!unique.length || distance(unique[unique.length - 1], p) > 0.01) unique.push(p);
  }
  if (unique.length > 2 && samePoint(unique[0], unique[unique.length - 1], 0.01)) unique.pop();
  if (unique.length < 3) return [];
  const closed = [...unique, unique[0]];
  const simplified = simplifyPolyline(closed, epsilon);
  if (simplified.length > 2 && samePoint(simplified[0], simplified[simplified.length - 1], 0.01)) {
    simplified.pop();
  }
  return simplified.length >= 3 ? simplified : unique;
}

// Liang-Barsky: clips a line segment against an axis-aligned rectangle.
function clipSegmentToRect(a, b, rect) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const tests = [
    [-dx, a[0] - rect.minX], [dx, rect.maxX - a[0]],
    [-dz, a[1] - rect.minZ], [dz, rect.maxZ - a[1]],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + dx * t0, a[1] + dz * t0],
    [a[0] + dx * t1, a[1] + dz * t1],
  ];
}

// Clips a simple polygon. Inner rings/multipolygon holes are deliberately skipped.
function clipPolygonEdge(points, inside, intersection) {
  const output = [];
  if (!points.length) return output;
  let previous = points[points.length - 1];
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) output.push(intersection(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersection(previous, current));
    }
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function clipPolygonToRect(polygon, rect) {
  let points = polygon;
  points = clipPolygonEdge(
    points, p => p[0] >= rect.minX,
    (a, b) => { const t = (rect.minX - a[0]) / (b[0] - a[0]); return [rect.minX, a[1] + t * (b[1] - a[1])]; },
  );
  points = clipPolygonEdge(
    points, p => p[0] <= rect.maxX,
    (a, b) => { const t = (rect.maxX - a[0]) / (b[0] - a[0]); return [rect.maxX, a[1] + t * (b[1] - a[1])]; },
  );
  points = clipPolygonEdge(
    points, p => p[1] >= rect.minZ,
    (a, b) => { const t = (rect.minZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rect.minZ]; },
  );
  points = clipPolygonEdge(
    points, p => p[1] <= rect.maxZ,
    (a, b) => { const t = (rect.maxZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rect.maxZ]; },
  );
  const clean = [];
  for (const p of points) if (!clean.length || distance(clean[clean.length - 1], p) > 0.001) clean.push(p);
  if (clean.length > 2 && distance(clean[0], clean[clean.length - 1]) < 0.001) clean.pop();
  return clean.length >= 3 ? clean : [];
}

function widthFromTags(tags) {
  const explicit = parsePositive(tags.width);
  if (explicit && explicit < 30) return explicit;
  const lanes = parsePositive(tags.lanes);
  if (lanes && lanes <= 12) return Math.max(2.5, lanes * 3.25);
  const fallback = {
    motorway: 18, trunk: 15, primary: 13, secondary: 11,
    tertiary: 9, unclassified: 8, residential: 7, living_street: 6,
    service: 5, pedestrian: 4, footway: 2, cycleway: 2,
    path: 2, track: 3,
  };
  return fallback[tags.highway] ?? 8;
}

function parseSpeed(value) {
  const n = parsePositive(value);
  if (!n) return 0;
  return String(value).toLowerCase().includes('mph') ? n * 1.609344 : n;
}

function getWayRuns(way, nodeMap) {
  const runs = [];
  let current = [];
  let complete = true;
  for (const ref of way.nodeRefs ?? []) {
    const point = nodeMap.get(String(ref));
    if (!point) {
      complete = false;
      if (current.length >= 2) runs.push(current);
      current = [];
      continue;
    }
    const last = current[current.length - 1];
    if (!last || distance(last, point) > 0.01) current.push(point);
  }
  if (current.length >= 2) runs.push(current);
  return { runs, complete };
}

function getClosedRing(way, nodeMap) {
  const refs = way.nodeRefs ?? [];
  if (refs.length < 4 || String(refs[0]) !== String(refs[refs.length - 1])) return null;
  const points = [];
  for (const ref of refs) {
    const p = nodeMap.get(String(ref));
    if (!p) return null;
    points.push(p);
  }
  return points;
}

function isGreenArea(tags) {
  return tags.leisure === 'park' || tags.leisure === 'garden' ||
    tags.landuse === 'grass' || tags.landuse === 'forest' || tags.landuse === 'meadow' ||
    tags.natural === 'wood';
}

function stopIsRelevant(tags) {
  return tags.highway === 'bus_stop' ||
    tags.public_transport === 'platform' ||
    tags.public_transport === 'stop_position' && (tags.bus === 'yes' || tags.highway === 'bus_stop');
}

function getStopModel(tags) {
  const material = String(tags['shelter:material'] ?? tags.material ?? '').toLowerCase();
  const structure = String(tags['shelter:structure'] ?? '').toLowerCase();
  if (/(concrete|brick|stone)/.test(`${material} ${structure}`)) return 'soviet';
  if (tags.shelter === 'yes' || tags.covered === 'yes' || /(glass|metal|steel|aluminium|aluminum)/.test(material)) return 'modern';
  return 'modern';
}

function stopName(tags) {
  return {
    ru: tags['name:ru'] ?? tags.name ?? null,
    kz: tags['name:kk'] ?? tags['name:kz'] ?? null,
    default: tags.name ?? null,
  };
}

function normalizedName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,;:()\[\]{}]/g, ' ')
    .replace(/\b(остановка|ост\.?|улица|ул\.?|проспект|пр\.?|микрорайон|мкр\.?|станция)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split every clipped source segment at all vertical/horizontal tile grid crossings.
function splitRoadIntoTiles(polyline, road, outTiles, stats) {
  const sourceLengthM = clippedPolylineLength(polyline);
  stats.sourceLengthM += sourceLengthM;
  let chainKey = null;
  let chain = [];
  const flush = () => {
    if (chainKey && chain.length >= 2) {
      const [tx, tz] = chainKey.split('_').map(Number);
      const tile = ensureTile(outTiles, tx, tz);
      const exactPoints = chain.map(([x, z]) => [x, z]);
      if (exactPoints.length >= 2) {
        const lengthM = lineLength(exactPoints);
        if (lengthM > 0.01) {
          tile.roads.push({
            id: road.id,
            poly: exactPoints,
            w: round(road.w, 2),
            lanes: road.lanes,
            oneWay: road.oneWay,
            speed: road.speed,
            t: road.t,
            type: road.t,
            lengthM: round(lengthM, 3),
            sourceLengthM: round(sourceLengthM, 3),
          });
          stats.tiledLengthM += lengthM;
          stats.roadPieces++;
        }
      }
    }
    chainKey = null;
    chain = [];
  };

  for (let i = 0; i < polyline.length - 1; i++) {
    const clipped = clipSegmentToRect(polyline[i], polyline[i + 1], REGION);
    if (!clipped) { flush(); continue; }
    const [a, b] = clipped;
    if (distance(a, b) < 0.001) continue;

    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const ts = [0, 1];

    if (Math.abs(dx) > 1e-12) {
      const low = Math.min(a[0], b[0]);
      const high = Math.max(a[0], b[0]);
      for (let grid = (Math.floor(low / TILE_SIZE) + 1) * TILE_SIZE; grid < high - 1e-8; grid += TILE_SIZE) {
        const t = (grid - a[0]) / dx;
        if (t > 1e-10 && t < 1 - 1e-10) ts.push(t);
      }
    }
    if (Math.abs(dz) > 1e-12) {
      const low = Math.min(a[1], b[1]);
      const high = Math.max(a[1], b[1]);
      for (let grid = (Math.floor(low / TILE_SIZE) + 1) * TILE_SIZE; grid < high - 1e-8; grid += TILE_SIZE) {
        const t = (grid - a[1]) / dz;
        if (t > 1e-10 && t < 1 - 1e-10) ts.push(t);
      }
    }

    ts.sort((m, n) => m - n);
    const uniqueTs = [];
    for (const t of ts) if (!uniqueTs.length || Math.abs(t - uniqueTs[uniqueTs.length - 1]) > 1e-9) uniqueTs.push(t);

    for (let j = 0; j < uniqueTs.length - 1; j++) {
      const t0 = uniqueTs[j];
      const t1 = uniqueTs[j + 1];
      const p0 = [a[0] + dx * t0, a[1] + dz * t0];
      const p1 = [a[0] + dx * t1, a[1] + dz * t1];
      if (distance(p0, p1) < 0.001) continue;
      const tm = (t0 + t1) * 0.5;
      const tx = Math.floor((a[0] + dx * tm) / TILE_SIZE);
      const tz = Math.floor((a[1] + dz * tm) / TILE_SIZE);
      const key = tileKey(tx, tz);

      if (chainKey !== key || (chain.length && !samePoint(chain[chain.length - 1], p0, 0.02))) {
        flush();
        chainKey = key;
        chain = [p0, p1];
      } else if (!samePoint(chain[chain.length - 1], p1, 0.001)) {
        chain.push(p1);
      }
    }
  }
  flush();
}

function lineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function clippedPolylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegmentToRect(points[i - 1], points[i], REGION);
    if (clipped) total += distance(clipped[0], clipped[1]);
  }
  return total;
}

function ensureTile(tiles, x, z) {
  const key = tileKey(x, z);
  let tile = tiles.get(key);
  if (!tile) {
    tile = { x, z, buildings: [], roads: [], greenZones: [], stops: [] };
    tiles.set(key, tile);
  }
  return tile;
}

function addGreenPolygon(way, ring, tags, outTiles, stats) {
  const simplified = simplifyRing(ring, AREA_SIMPLIFY_M);
  if (simplified.length < 3) return;
  const clippedRegion = clipPolygonToRect(simplified, REGION);
  if (clippedRegion.length < 3) return;
  const area = polyArea(clippedRegion);
  if (area < GREEN_MIN_AREA_M2) return;

  const b = boundsOf(clippedRegion);
  const minTileX = Math.floor(b.minX / TILE_SIZE);
  const maxTileX = Math.floor((b.maxX - 1e-6) / TILE_SIZE);
  const minTileZ = Math.floor(b.minZ / TILE_SIZE);
  const maxTileZ = Math.floor((b.maxZ - 1e-6) / TILE_SIZE);

  let tilesTouched = 0;
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let tz = minTileZ; tz <= maxTileZ; tz++) {
      const tileRect = {
        minX: Math.max(REGION.minX, tx * TILE_SIZE),
        maxX: Math.min(REGION.maxX, (tx + 1) * TILE_SIZE),
        minZ: Math.max(REGION.minZ, tz * TILE_SIZE),
        maxZ: Math.min(REGION.maxZ, (tz + 1) * TILE_SIZE),
      };
      const piece = clipPolygonToRect(clippedRegion, tileRect);
      if (piece.length < 3) continue;
      const pieceArea = polyArea(piece);
      if (pieceArea < 5) continue;
      ensureTile(outTiles, tx, tz).greenZones.push({
        id: String(way.id),
        poly: piece.map(([x, z]) => [round(x), round(z)]),
        areaM2: round(pieceArea, 1),
        tags: {
          leisure: tags.leisure ?? null,
          landuse: tags.landuse ?? null,
          natural: tags.natural ?? null,
        },
      });
      tilesTouched++;
    }
  }
  if (tilesTouched) stats.parks++;
}

function addBuildingPolygon(building, outTiles, stats) {
  const polygon = building.poly;
  const b = boundsOf(polygon);
  const minTileX = Math.floor(b.minX / TILE_SIZE);
  const maxTileX = Math.floor((b.maxX - 1e-7) / TILE_SIZE);
  const minTileZ = Math.floor(b.minZ / TILE_SIZE);
  const maxTileZ = Math.floor((b.maxZ - 1e-7) / TILE_SIZE);
  let pieces = 0;

  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let tz = minTileZ; tz <= maxTileZ; tz++) {
      const rect = {
        minX: Math.max(REGION.minX, tx * TILE_SIZE),
        maxX: Math.min(REGION.maxX, (tx + 1) * TILE_SIZE),
        minZ: Math.max(REGION.minZ, tz * TILE_SIZE),
        maxZ: Math.min(REGION.maxZ, (tz + 1) * TILE_SIZE),
      };
      if (rect.minX >= rect.maxX || rect.minZ >= rect.maxZ) continue;
      const part = clipPolygonToRect(polygon, rect);
      if (part.length < 3 || polyArea(part) < 0.05) continue;

      ensureTile(outTiles, tx, tz).buildings.push({
        ...building,
        part: `${tx}_${tz}`,
        poly: part.map(([x, z]) => [round(x, 3), round(z, 3)]),
      });
      pieces++;
    }
  }

  if (pieces) stats.buildingTilePieces += pieces;
}

function boundsIntersectRegion(points, margin = 0) {
  const b = boundsOf(points);
  return b.maxX >= REGION.minX - margin && b.minX <= REGION.maxX + margin &&
    b.maxZ >= REGION.minZ - margin && b.minZ <= REGION.maxZ + margin;
}

function stitchOuterMemberWays(memberIds, wayGeometryById) {
  const pending = [];
  for (const id of memberIds) {
    const runs = wayGeometryById.get(String(id));
    if (!runs) continue;
    for (const run of runs) {
      if (run.length >= 2) pending.push(run.map((p) => [p[0], p[1]]));
    }
  }

  const rings = [];
  while (pending.length) {
    const ring = pending.pop();
    let changed = true;
    while (changed && !samePoint(ring[0], ring[ring.length - 1], 0.05)) {
      changed = false;
      for (let i = 0; i < pending.length; i++) {
        const part = pending[i];
        const first = part[0];
        const last = part[part.length - 1];
        const ringEnd = ring[ring.length - 1];

        if (samePoint(ringEnd, first, 0.05)) {
          ring.push(...part.slice(1));
        } else if (samePoint(ringEnd, last, 0.05)) {
          part.reverse();
          ring.push(...part.slice(1));
        } else {
          continue;
        }
        pending.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1], 0.05)) {
      ring.pop();
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

function closestPointOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  const t = lenSq > 1e-12
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq))
    : 0;
  const q = [a[0] + dx * t, a[1] + dz * t];
  return { point: q, distance: distance(p, q), dx, dz };
}

function buildRoadSpatialIndex(roadLines) {
  const buckets = new Map();
  const add = (x, z, segment) => {
    const key = `${x}_${z}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(segment);
  };

  for (const road of roadLines) {
    for (let i = 1; i < road.poly.length; i++) {
      const clipped = clipSegmentToRect(road.poly[i - 1], road.poly[i], REGION);
      if (!clipped) continue;
      const [a, b] = clipped;
      const segment = { a, b, roadId: road.sourceWayId ?? road.id };
      const minX = Math.floor(Math.min(a[0], b[0]) / STOP_INDEX_CELL_M);
      const maxX = Math.floor(Math.max(a[0], b[0]) / STOP_INDEX_CELL_M);
      const minZ = Math.floor(Math.min(a[1], b[1]) / STOP_INDEX_CELL_M);
      const maxZ = Math.floor(Math.max(a[1], b[1]) / STOP_INDEX_CELL_M);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) add(x, z, segment);
      }
    }
  }
  return buckets;
}

function findNearestRoad(stop, index, allSegments) {
  const cx = Math.floor(stop.x / STOP_INDEX_CELL_M);
  const cz = Math.floor(stop.z / STOP_INDEX_CELL_M);
  let best = null;
  const visited = new Set();

  for (let radius = 0; radius <= MAX_STOP_SEARCH_CELLS; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
        const list = index.get(`${cx + dx}_${cz + dz}`) ?? [];
        for (const segment of list) {
          if (visited.has(segment)) continue;
          visited.add(segment);
          const candidate = closestPointOnSegment([stop.x, stop.z], segment.a, segment.b);
          if (!best || candidate.distance < best.distance) best = { ...candidate, roadId: segment.roadId };
        }
      }
    }
    if (best && best.distance <= Math.max(0, radius - 1) * STOP_INDEX_CELL_M) break;
  }

  // Rare isolated case: exact global fallback, still only once per stop.
  if (!best && allSegments.length) {
    for (const segment of allSegments) {
      const candidate = closestPointOnSegment([stop.x, stop.z], segment.a, segment.b);
      if (!best || candidate.distance < best.distance) best = { ...candidate, roadId: segment.roadId };
    }
  }

  if (!best) return { yaw: 0, roadId: null, distanceToRoadM: null };
  const yaw = Math.atan2(-best.dx, -best.dz);
  return {
    yaw: round(yaw, 5),
    roadId: best.roadId,
    distanceToRoadM: round(best.distance, 1),
  };
}

function deduplicateStops(rawStops) {
  const sorted = [...rawStops].sort((a, b) => {
    const priority = (s) => s.tags.highway === 'bus_stop' ? 0 : s.source === 'node' ? 1 : 2;
    return priority(a) - priority(b) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
  const buckets = new Map();
  const kept = [];
  for (const stop of sorted) {
    const gx = Math.floor(stop.x / 10);
    const gz = Math.floor(stop.z / 10);
    const name = normalizedName(stop.tags['name:ru'] ?? stop.tags.name ?? stop.tags['name:kk']);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dz = -1; dz <= 1 && !duplicate; dz++) {
        for (const existing of buckets.get(`${gx + dx}_${gz + dz}`) ?? []) {
          const d = Math.hypot(stop.x - existing.x, stop.z - existing.z);
          const otherName = normalizedName(existing.tags['name:ru'] ?? existing.tags.name ?? existing.tags['name:kk']);
          if (d <= 6 && (!name || !otherName || name === otherName)) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) continue;
    kept.push(stop);
    const key = `${gx}_${gz}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(stop);
  }
  return kept;
}

function makeStopRecord(stop, nearest) {
  const names = stopName(stop.tags);
  const geographic = metersToLonLat(stop.x, stop.z);
  return {
    id: String(stop.id),
    position: [round(stop.x), round(stop.z)],
    yaw: nearest.yaw,
    model: getStopModel(stop.tags),
    // streetProps consumes a display string; localized aliases stay available separately.
    name: names.ru ?? names.default ?? names.kz ?? '',
    names: { ru: names.ru, kz: names.kz },
    name_ru: names.ru,
    name_kz: names.kz,
    name_default: names.default,
    lon: round(geographic.lon, 7),
    lat: round(geographic.lat, 7),
    nearestRoadId: nearest.roadId,
    distanceToRoadM: nearest.distanceToRoadM,
    osmType: stop.source,
  };
}

function buildTileJson(tile) {
  return {
    version: 1,
    tileSize: TILE_SIZE,
    x: tile.x,
    z: tile.z,
    buildings: tile.buildings,
    roads: tile.roads,
    greenZones: tile.greenZones,
    stops: tile.stops,
  };
}

function serializeTileWithinLimit(tile) {
  let payload = buildTileJson(tile);
  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json) <= MAX_TILE_BYTES) return json;

  // Keep road vertices unchanged for length accounting. Simplify only area outlines.
  for (const epsilon of [2, 4, 7, 10]) {
    tile.buildings = tile.buildings.map((b) => ({
      ...b,
      poly: simplifyRing(b.poly, epsilon).map(([x, z]) => [round(x), round(z)]),
    }));
    tile.greenZones = tile.greenZones.map((g) => ({
      ...g,
      poly: simplifyRing(g.poly, epsilon).map(([x, z]) => [round(x), round(z)]),
    }));
    payload = buildTileJson(tile);
    json = JSON.stringify(payload);
    if (Buffer.byteLength(json) <= MAX_TILE_BYTES) return json;
  }
  throw new Error(`Tile ${tileKey(tile.x, tile.z)} exceeds 2 MiB after area simplification (${Buffer.byteLength(json)} bytes)`);
}

const T0 = performance.now();
const stats = {
  nodes: 0, nodesInBuffer: 0, ways: 0, buildings: 0, roadWays: 0,
  roadPieces: 0, stopsRaw: 0, stops: 0, parks: 0, buildingTilePieces: 0,
  multipolygonGreenRelations: 0, skippedMultipolygonGreen: 0, skippedIncompleteAreas: 0,
};
const nodes = new Map();
const buildings = [];
const roadLines = [];
const rawStops = [];
const wayGeometryById = new Map();
const outTiles = new Map();

console.log(`[build-city] PBF: ${PBF}`);
console.log(`[build-city] bbox: ${JSON.stringify(BBOX)}, tile=${TILE_SIZE}m`);
console.log(`[build-city] retaining nodes in bbox + ${NODE_MARGIN_DEG}° buffer`);

osmRead.parsePbf({
  filePath: PBF,
  callback(error) {
    if (error) {
      console.error(`[build-city] cannot open PBF: ${error.message ?? error}`);
      process.exitCode = 1;
    }
  },
  node(node) {
    stats.nodes++;
    if (!inBBox(node.lon, node.lat, NODE_BBOX)) return;
    const p = lonLatToMeters(node.lon, node.lat);
    nodes.set(String(node.id), [p.x, p.z]);
    stats.nodesInBuffer++;

    const tags = node.tags ?? {};
    if (inBBox(node.lon, node.lat) && stopIsRelevant(tags)) {
      rawStops.push({ id: node.id, x: p.x, z: p.z, tags, source: 'node' });
      stats.stopsRaw++;
    }
  },
  way(way) {
    stats.ways++;
    const tags = way.tags ?? {};
    const { runs, complete } = getWayRuns(way, nodes);

    // Keep geometry only for ways intersecting the export region. Relations arrive
    // after ways in osm-read and use this compact cache for multipolygon outer rings.
    if (runs.length) {
      const flattened = runs.flat();
      if (flattened.length >= 2 && boundsIntersectRegion(flattened, 1000)) {
        wayGeometryById.set(String(way.id), runs.map((run) => run.map((p) => [p[0], p[1]])));
      }
    }

    // Buildings: accept building=yes, use closed footprints only.
    if (tags.building && tags.building !== 'no') {
      const ring = complete ? getClosedRing(way, nodes) : null;
      if (!ring) { stats.skippedIncompleteAreas++; return; }
      const polygon = simplifyRing(ring, 0.35);
      if (polygon.length < 3) return;
      const area = polyArea(polygon);
      if (area < 25) return;
      const clipped = clipPolygonToRect(polygon, REGION);
      if (clipped.length < 3 || polyArea(clipped) < 25) return;
      const height = getBuildingHeight(tags, area, way.id);
      buildings.push({
        id: String(way.id),
        sourceId: String(way.id),
        poly: clipped.map(([x, z]) => [round(x, 3), round(z, 3)]),
        h: round(height.h, 2),
        // Facade-provider compatibility: levels is a height in metres.
        levels: round(height.levels, 2),
        ...(height.buildingLevels != null ? { buildingLevels: height.buildingLevels } : {}),
        type: tags.building === 'yes' ? 'residential' : tags.building,
        estimated: height.estimated,
        est: height.estimated,
        heightSource: height.heightSource,
      });
      stats.buildings++;
      return;
    }

    // Simple closed OSM ways for parks/green areas. Multipolygon holes are skipped.
    if (isGreenArea(tags)) {
      const ring = complete ? getClosedRing(way, nodes) : null;
      if (ring) addGreenPolygon(way, ring, tags, outTiles, stats);
      else stats.skippedIncompleteAreas++;
      return;
    }

    // Bus platforms mapped as ways. Node platforms are collected in node().
    if (stopIsRelevant(tags) && runs.length) {
      const allPoints = runs.flat();
      const p = tags.area === 'yes' && complete ? centroid(getClosedRing(way, nodes) ?? allPoints) : centroid(allPoints);
      if (inRegion(p[0], p[1])) {
        rawStops.push({ id: way.id, x: p[0], z: p[1], tags, source: 'way' });
        stats.stopsRaw++;
      }
    }

    // Roads are kept as open polylines. Missing refs break a run instead of bridging gaps.
    const excludedHighwayFeatures = new Set(['no', 'bus_stop', 'platform', 'construction', 'proposed', 'abandoned', 'razed']);
    if (tags.highway && !excludedHighwayFeatures.has(tags.highway) && runs.length) {
      const width = widthFromTags(tags);
      const lanes = Math.max(1, Math.min(8, Math.round(parsePositive(tags.lanes) ?? 2)));
      const road = {
        id: String(way.id),
        w: Math.min(width, 30),
        lanes,
        oneWay: tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout',
        speed: parseSpeed(tags.maxspeed),
        t: tags.highway,
      };
      let runIndex = 0;
      for (const run of runs) {
        const simplified = simplifyPolyline(run, ROAD_SIMPLIFY_M);
        if (simplified.length < 2) continue;
        const record = { ...road, id: `${road.id}:${runIndex++}`, sourceWayId: road.id, poly: simplified };
        roadLines.push(record);
        splitRoadIntoTiles(simplified, record, outTiles, roadLengthStats);
      }
      if (runIndex) stats.roadWays++;
    }
  },
  relation(relation) {
    const tags = relation.tags ?? {};
    if (!isGreenArea(tags) || tags.type !== 'multipolygon') return;

    stats.multipolygonGreenRelations++;
    const outerIds = (relation.members ?? [])
      .filter((member) => member.type === 'way' && (!member.role || member.role === 'outer'))
      .map((member) => String(member.ref));
    const rings = stitchOuterMemberWays(outerIds, wayGeometryById);
    if (!rings.length) {
      stats.skippedMultipolygonGreen++;
      return;
    }
    for (let i = 0; i < rings.length; i++) {
      addGreenPolygon({ id: `${relation.id}:${i}` }, rings[i], tags, outTiles, stats);
    }
  },
  endDocument() {
    try {
      // Ways, buildings, green polygons and stops now own the coordinates they need.
      // Release the large OSM node lookup before tile serialization.
      nodes.clear();
      finishBuild();
    } catch (error) {
      console.error('[build-city] failed:', error);
      process.exitCode = 1;
    }
  },
  error(error) {
    console.error('[build-city] parse error:', error);
    process.exitCode = 1;
  },
});

const roadLengthStats = {
  sourceLengthM: 0,
  tiledLengthM: 0,
  roadPieces: 0,
};

function finishBuild() {
  console.log(`[build-city] parsed in ${((performance.now() - T0) / 1000).toFixed(1)}s`);
  console.log(`  nodes retained during parse: ${stats.nodesInBuffer.toLocaleString()}`);
  console.log(`  ways: ${stats.ways.toLocaleString()}, building ways: ${buildings.length.toLocaleString()}`);
  console.log(`  road ways: ${stats.roadWays.toLocaleString()}, road pieces: ${roadLengthStats.roadPieces.toLocaleString()}`);

  // Clip building footprints into every intersected tile, rather than assigning by centroid.
  for (const building of buildings) addBuildingPolygon(building, outTiles, stats);
  // Relation member geometries are no longer needed once green multipolygons are stitched.
  wayGeometryById.clear();

  // Spatial index ensures stop-to-road snapping does not scan every road for each stop.
  const roadIndex = buildRoadSpatialIndex(roadLines);
  const allRoadSegments = [];
  for (const road of roadLines) {
    for (let i = 1; i < road.poly.length; i++) {
      const clipped = clipSegmentToRect(road.poly[i - 1], road.poly[i], REGION);
      if (clipped) allRoadSegments.push({ a: clipped[0], b: clipped[1], roadId: road.sourceWayId });
    }
  }

  const uniqueStops = deduplicateStops(rawStops.filter((s) => inRegion(s.x, s.z)));
  const stopsIndex = [];
  for (const stop of uniqueStops) {
    const nearest = findNearestRoad(stop, roadIndex, allRoadSegments);
    const record = makeStopRecord(stop, nearest);
    const [tx, tz] = tileOf(stop.x, stop.z);
    ensureTile(outTiles, tx, tz).stops.push(record);
    stopsIndex.push(record);
  }
  stats.stops = stopsIndex.length;

  // Sort arrays so output stays deterministic between identical PBF builds.
  for (const tile of outTiles.values()) {
    tile.buildings.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    tile.roads.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    tile.greenZones.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    tile.stops.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }
  stopsIndex.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

  // Preserve the split length measured from rounded output points.
  roadLengthStats.tiledLengthM = 0;
  roadLengthStats.roadPieces = 0;
  for (const tile of outTiles.values()) {
    for (const road of tile.roads) {
      const lengthM = lineLength(road.poly);
      road.lengthM = round(lengthM, 3);
      roadLengthStats.tiledLengthM += lengthM;
      roadLengthStats.roadPieces++;
    }
  }
  const roadDeltaM = Math.abs(roadLengthStats.sourceLengthM - roadLengthStats.tiledLengthM);
  const roadToleranceM = 1.0;
  if (roadDeltaM > roadToleranceM) {
    throw new Error(`Road split length mismatch: source=${roadLengthStats.sourceLengthM.toFixed(3)}m, tiled=${roadLengthStats.tiledLengthM.toFixed(3)}m, delta=${roadDeltaM.toFixed(3)}m, tolerance=${roadToleranceM.toFixed(3)}m`);
  }

  // Serialize and validate every tile before replacing the existing output.
  // A failed oversized tile therefore does not destroy the previous dataset.
  const serializedTiles = [];
  const tileNames = [];
  const tileBytes = {};
  let totalBuildings = 0;
  let totalRoadPieces = 0;
  let totalGreenZones = 0;
  let totalStops = 0;
  for (const [key, tile] of [...outTiles.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const json = serializeTileWithinLimit(tile);
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_TILE_BYTES) throw new Error(`Tile ${key} is ${bytes} bytes (> 2 MiB)`);
    serializedTiles.push({ key, json });
    tileNames.push(key);
    tileBytes[key] = bytes;
    totalBuildings += tile.buildings.length;
    totalRoadPieces += tile.roads.length;
    totalGreenZones += tile.greenZones.length;
    totalStops += tile.stops.length;
  }

  mkdirSync(`${OUT}/tiles`, { recursive: true });
  for (const filename of readdirSync(`${OUT}/tiles`)) {
    if (filename.endsWith('.json')) unlinkSync(`${OUT}/tiles/${filename}`);
  }
  for (const { key, json } of serializedTiles) {
    writeFileSync(`${OUT}/tiles/${key}.json`, json);
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: basename(PBF),
    coordinateSystem: {
      projection: 'local-equirectangular',
      origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
      axes: { x: 'east', z: 'south', y: 'up' },
      unit: 'metre',
    },
    region: {
      bbox: BBOX,
      minX: round(REGION.minX, 1), maxX: round(REGION.maxX, 1),
      minZ: round(REGION.minZ, 1), maxZ: round(REGION.maxZ, 1),
    },
    tiles: {
      count: tileNames.length,
      size: TILE_SIZE,
      maxBytes: Math.max(0, ...Object.values(tileBytes)),
      tiles: tileNames,
    },
    buildings: totalBuildings,
    roads: totalRoadPieces,
    stops: totalStops,
    parks: stats.parks,
    stats: {
      nodesParsed: stats.nodes,
      nodesRetained: stats.nodesInBuffer,
      waysParsed: stats.ways,
      buildingWays: stats.buildings,
      buildingTilePieces: totalBuildings,
      roadWays: stats.roadWays,
      roadPieces: totalRoadPieces,
      stopsRaw: stats.stopsRaw,
      stops: totalStops,
      parks: stats.parks,
      greenZoneTilePieces: totalGreenZones,
      greenMultipolygonRelations: stats.multipolygonGreenRelations,
      greenMultipolygonRelationsSkipped: stats.skippedMultipolygonGreen,
      incompleteAreaWaysSkipped: stats.skippedIncompleteAreas,
    },
    roadLength: {
      sourceLengthM: round(roadLengthStats.sourceLengthM, 3),
      tiledLengthM: round(roadLengthStats.tiledLengthM, 3),
      deltaM: round(roadDeltaM, 4),
      toleranceM: round(roadToleranceM, 3),
      definition: 'Length after road simplification and clipping to the export bbox; all tile pieces must sum to this value.',
    },
    limits: {
      maxTileBytes: MAX_TILE_BYTES,
      nodeBufferDegrees: NODE_MARGIN_DEG,
      roadSimplifyM: ROAD_SIMPLIFY_M,
    },
  };

  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  writeFileSync(`${OUT}/stops-index.json`, JSON.stringify({ version: 1, coordinateSystem: 'WGS84+local-metres', stops: stopsIndex }, null, 2));

  // nav2d compatibility: nodes are road piece endpoints in absolute metres.
  const navNodes = [];
  const navNodeMap = new Map();
  const addNavNode = (point) => {
    const key = `${round(point[0], 1)},${round(point[1], 1)}`;
    if (navNodeMap.has(key)) return navNodeMap.get(key);
    const index = navNodes.length;
    navNodeMap.set(key, index);
    navNodes.push([round(point[0], 1), round(point[1], 1)]);
    return index;
  };
  const navEdges = [];
  for (const tile of outTiles.values()) {
    for (const road of tile.roads) {
      if (road.poly.length < 2) continue;
      const a = addNavNode(road.poly[0]);
      const b = addNavNode(road.poly[road.poly.length - 1]);
      navEdges.push([a, b, road.lanes, road.speed, road.oneWay ? 1 : 0]);
    }
  }
  writeFileSync(`${OUT}/nav2d.json`, JSON.stringify({ version: 1, nodes: navNodes, edges: navEdges }));

  console.log(`[build-city] tiles=${tileNames.length}, buildingPieces=${totalBuildings}, roadPieces=${totalRoadPieces}, stops=${totalStops}, parks=${stats.parks} (${totalGreenZones} tile pieces)`);
  console.log(`[build-city] road length source=${roadLengthStats.sourceLengthM.toFixed(2)}m tiled=${roadLengthStats.tiledLengthM.toFixed(2)}m delta=${roadDeltaM.toFixed(4)}m`);
  console.log(`[build-city] largest tile=${manifest.tiles.maxBytes} bytes (limit ${MAX_TILE_BYTES})`);
  console.log(`[build-city] output: ${OUT}`);
}
