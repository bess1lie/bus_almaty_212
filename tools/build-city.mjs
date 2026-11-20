/**
 * build-city.mjs — строит тайлы города из OSM (PBF).
 *
 * Пайплайн:
 *  1. Потоково парсим .osm.pbf (osm-read parsePbf).
 *  2. Фильтруем по bbox Алматы+Карасай: 76.55..77.25 × 43.05..43.42.
 *  3. Проекция в метры (origin 43.2389, 76.8897); X — восток, Z — юг.
 *  4. Экструзия зданий (полигон + высота из height/levels или эвристика).
 *  5. Дороги (centerline + ширина из lanes/width или по классу highway).
 *  6. Вывод: public/map/v1/tiles/{z}_{x}.json + nav2d.json + manifest.json.
 *
 * Запуск: node tools/build-city.mjs [путь-к-pbf] [outdir]
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync as fsUnlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import osmRead from 'osm-read';

const PBF = process.argv[2] ?? '/tmp/opencode/kazakhstan-latest.osm.pbf';
const OUT = process.argv[3] ?? 'public/map/v1';

// ---- Проекция (совпадает с src/world/coords.ts) ----
const ORIGIN_LAT = 43.2389;
const ORIGIN_LON = 76.8897;
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
function lonLatToM(lon, lat) {
  return { x: (lon - ORIGIN_LON) * METERS_PER_DEG_LON, z: -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT };
}

// Режим CENTRE=1 — только центр Алматы (быстрый тест, ~20 тайлов)
const CENTRE = process.env.CENTRE === '1';
const BBOX = CENTRE
  ? { minLon: 76.82, maxLon: 76.98, minLat: 43.19, maxLat: 43.29 }
  : { minLon: 76.55, maxLon: 77.25, minLat: 43.05, maxLat: 43.42 };

function inBBox(lon, lat, pad = 0) {
  return lon >= BBOX.minLon - pad && lon <= BBOX.maxLon + pad &&
         lat >= BBOX.minLat - pad && lat <= BBOX.maxLat + pad;
}
const REGION = {
  minX: lonLatToM(BBOX.minLon, BBOX.maxLat).x, // запад
  maxX: lonLatToM(BBOX.maxLon, BBOX.maxLat).x, // восток
  minZ: lonLatToM(BBOX.minLon, BBOX.maxLat).z, // север (z отрицательный)
  maxZ: lonLatToM(BBOX.maxLon, BBOX.minLat).z, // юг (z положительный)
};

// ---- Геометрия ----
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}
function douglasPeucker(pts, a, b, eps) {
  if (b <= a + 1) return pts;
  const ax = pts[a][0], az = pts[a][1], bx = pts[b][0], bz = pts[b][1];
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1e-12;
  let maxD = -1, idx = -1;
  for (let i = a + 1; i < b; i++) {
    const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (idx !== -1 && maxD > eps) {
    return [...douglasPeucker(pts, a, idx, eps), ...douglasPeucker(pts, idx, b, eps)];
  }
  return [pts[a], pts[b]];
}
function simplifyRing(ring, eps) {
  const uniq = [];
  for (const p of ring) {
    if (uniq.length === 0) { uniq.push(p); continue; }
    const last = uniq[uniq.length - 1];
    if ((p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2 > 1e-10) uniq.push(p);
  }
  if (uniq.length > 1) {
    const f = uniq[0], l = uniq[uniq.length - 1];
    if ((f[0] - l[0]) ** 2 + (f[1] - l[1]) ** 2 <= 1e-10) uniq.pop();
  }
  if (uniq.length >= 3) {
    const dp = douglasPeucker(uniq, 0, uniq.length - 1, eps);
    if (dp.length >= 3) return dp;
  }
  return uniq;
}

// ---- Эвристики высот ----
const TYPE_H = {
  house: { min: 4, max: 8 },
  apartments: { min: 15, max: 60 },
  tertiary: { min: 8, max: 30 },
  industrial: { min: 6, max: 14 },
  commercial: { min: 6, max: 20 },
  almost_none: { min: 2, max: 6 },
  retail: { min: 4, max: 18 },
};
function estimateHeight(tags, area) {
  // 1. Точные теги
  const h = parseFloat(tags.height);
  if (h && h > 0) return h;
  const levels = parseFloat(tags['building:levels']);
  if (levels && levels > 0) return levels * 3.2;

  // 2. Тип
  const type = tags.building;
  const th = TYPE_H[type];
  if (th) return th.min + Math.random() * (th.max - th.min);

  // 3. Площадь
  if (area < 50) return 1 + Math.random() * 3;

  // 4. По умолчанию
  return 3 + Math.random() * 4;
}

// ---- Парсинг OSM ----
const stats = { nodes: 0, nodesInBox: 0, ways: 0, buildings: 0, roads: 0, roadNodes: 0 };
const nodes = new Map(); // id -> [x, z]
const buildings = [];    // { poly, h, t, est }
const roads = [];        // { poly, w, lanes, oneWay, speed, t }

function parseSpeed(v) {
  const n = parseFloat(v);
  if (!n) return 0;
  const unit = String(v).trim().toLowerCase();
  if (unit.includes('mph') && unit.includes('100mph') === false) return n * 1.609;
  return n; // km/h
}
function widthFromTags(tags, fallback) {
  const w = parseFloat(tags.width);
  if (w && w > 0 && w < 20) return w;
  const lanes = parseInt(tags.lanes, 10);
  if (lanes && lanes > 0) return 2.5 + (lanes - 1) * 2.5;
  return fallback;
}

function wayNodePoints(way, nodeMap, n) {
  const pts = [];
  for (const id of way.nodeRefs) {
    const pos = nodeMap.get(id);
    if (pos) pts.push(pos);
  }
  return pts;
}
function inBoxArea(pts, pad) {
  // мин/макс координат
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [x, z] of pts) {
    const p = metersToLonLat(x, z);
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return minLon >= BBOX.minLon - pad && maxLon <= BBOX.maxLon + pad &&
         minLat >= BBOX.minLat - pad && maxLat <= BBOX.maxLat + pad;
}
function metersToLonLat(x, z) {
  return { lon: ORIGIN_LON + x / METERS_PER_DEG_LON, lat: ORIGIN_LAT - z / METERS_PER_DEG_LAT };
}
function centroid(poly) {
  let sx = 0, sz = 0;
  for (const [x, z] of poly) { sx += x; sz += z; }
  return [sx / poly.length, sz / poly.length];
}

osmRead.parsePbf({
  filePath: PBF,
  callback(err, parser) {
    if (err) throw new Error(`PBF open failed: ${err}`);
  },
  node(node) {
    stats.nodes++;
    // Фильтр: только ноды в bbox + буфер (максимум ~3.6M — в рамках лимита V8 Map 2^24)
    if (!inBBox(node.lon, node.lat, 0.5)) return;
    const { x, z } = lonLatToM(node.lon, node.lat);
    nodes.set(node.id, [x, z]);
  },
  way(way) {
    const t = way.tags || {};
    stats.ways++;

    const pts = wayNodePoints(way, nodes, 5);
    if (pts.length < 2) return;

    // --- Здания ---
    if (t.building && t.building !== 'no' && t.building !== 'yes' && t.building !== 'way') {
      const ring = simplifyRing(pts, 0.3);
      const area = polyArea(ring);
      if (area >= 25) {
        const type = t.building === 'yes' ? 'residential' : t.building;
        const est = parseFloat(t.height) <= 0 && (!t['building:levels'] || parseFloat(t['building:levels']) <= 0);
        const h = estimateHeight(t, area);
        const [cx, cz] = centroid(ring);
        if (inBoxArea(ring, 0.5)) {
          buildings.push({ poly: ring, h, type, est, c: [cx, cz] });
          stats.buildings++;
        } else stats.roadNodes++;
      }
      return;
    }

    // --- Дороги ---
    if (t.highway && t.highway !== 'yes') {
      // сначала прореживаем точки по расстоянию (≥6 м), потом упрощаем
      const coarse = [];
      for (const p of pts) {
        const last = coarse[coarse.length - 1];
        if (!last || (p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2 >= 36) coarse.push(p);
      }
      if (coarse.length < 2) coarse.push(pts[pts.length - 1]);
      const poly = simplifyRing(coarse, 2.0);
      if (poly.length < 2) return;
      const w = widthFromTags(t, 10);
      const lanes = parseInt(t.lanes, 10) || (poly.length >= 4 ? 2 : 1);
      const oneWay = t.oneway === 'yes';
      const speed = parseSpeed(t.maxspeed || '50');
      roads.push({ poly, w: Math.min(w, 20), lanes: Math.max(1, Math.min(6, lanes)), oneWay, speed, t: t.highway });
      stats.roads++;
    }
  },
  endDocument() {
    const dt = ((performance.now() - T0) / 1000).toFixed(1);
    console.log(`[build-city] parsed ${PBF} in ${dt}s`);
    console.log(`  nodes: ${stats.nodes} (in bbox: ${nodes.size})`);
    console.log(`  ways: ${stats.ways}`);
    console.log(`  buildings: ${buildings.length}, roads: ${roads.length}`);

    // ---- Нарезка на тайлы 2000 м ----
    const TILE = 2000;
    const outTiles = new Map();

    // Каждый объект попадает ровно в ОДИН тайл — по центроиду.
    // Это убирает дублирование между соседними тайлами (главный источник раздутия).
    const assignToTiles = (poly, putFn, minArea = 0) => {
      const area = polyArea(poly);
      if (area < minArea) return;
      let sx = 0, sz = 0;
      for (const p of poly) { sx += p[0]; sz += p[1]; }
      const cx = sx / poly.length;
      const cz = sz / poly.length;
      if (cx < REGION.minX || cx > REGION.maxX || cz < REGION.minZ || cz > REGION.maxZ) return;
      const key = `${Math.floor(cx / TILE)}_${Math.floor(cz / TILE)}`;
      if (!outTiles.has(key)) outTiles.set(key, { buildings: [], roads: [] });
      putFn(outTiles.get(key));
    };

    for (const b of buildings) assignToTiles(b.poly, (tile) => tile.buildings.push(b), 25);
    for (const r of roads) assignToTiles(r.poly, (tile) => tile.roads.push(r), 0);

    // ---- Навигационный граф (binary-friendly JSON) ----
    // nodes: (x,z) — точки рукавов + вершины дорог; edges: [aIdx,bIdx,lanes,speed,oneWay]
    const roadNodes = [];
    const navNodeMap = new Map(); // [x,z] string -> idx
    const addNavNode = (x, z) => {
      const key = `${x.toFixed(1)},${z.toFixed(1)}`;
      if (navNodeMap.has(key)) return navNodeMap.get(key);
      const idx = roadNodes.length;
      navNodeMap.set(key, idx);
      roadNodes.push([x, z]);
      return idx;
    };

    // nodes из дорог (изbbox-ограниченных полилиний)
    for (const r of roads) {
      const p0 = r.poly[0], p1 = r.poly[r.poly.length - 1];
      addNavNode(p0[0], p0[1]);
      if (r.poly.length > 1) addNavNode(p1[0], p1[1]);
    }

    // ---- Упрощениеgeometry перед записью ----
    const round = (v) => Math.round(v * 10) / 10; // 0.1 м точности
    for (const tile of outTiles.values()) {
      for (const b of tile.buildings) {
        b.poly = b.poly.map(([x, z]) => [round(x), round(z)]);
        b.h = round(b.h);
        delete b.c;
      }
      for (const r of tile.roads) {
        r.poly = r.poly.map(([x, z]) => [round(x), round(z)]);
        r.w = round(r.w);
      }
    }

    // ---- Запись вывода ----
    mkdirSync(`${OUT}/tiles`, { recursive: true });
    // Чистим старые тайлы
    for (const f of readdirSync(`${OUT}/tiles`)) {
      if (f.endsWith('.json')) fsUnlinkSync(`${OUT}/tiles/${f}`);
    }
    const tiles = [];
    for (const [key, tile] of outTiles) {
      const file = `${OUT}/tiles/${key}.json`;
      writeFileSync(file, JSON.stringify(tile));
      tiles.push(key);
    }

    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      region: { minX: REGION.minX.toFixed(0), maxX: REGION.maxX.toFixed(0), minZ: REGION.minZ.toFixed(0), maxZ: REGION.maxZ.toFixed(0) },
      tiles: { count: tiles.length, size: TILE, tiles: tiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) },
    };
    writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
    writeFileSync(`${OUT}/nav2d.json`, JSON.stringify({ nodes: roadNodes, version: 1 }));

    const total = Object.values(outTiles).reduce((s, t) => s + t.buildings.length + t.roads.length, 0);
    console.log(`  tiles: ${tiles.length}, est items: ${total}`);
    console.log(`[build-city] done. out: ${OUT}`);
    process.exit(0);
  },
  error(err) {
    console.error('parse error:', err);
    process.exit(1);
  },
});

const T0 = performance.now();
