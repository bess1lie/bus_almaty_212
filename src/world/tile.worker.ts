/**
 * tile.worker.ts — единый загрузчик OSM-тайла: fetch + parse + validate + pack.
 * Возвращает ВСЕ категории данных и готовые AABB зданий.
 */

interface WorkerRequest { key: string; url: string; }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const polyOk = (p: unknown): p is Array<[number, number]> =>
  Array.isArray(p) && p.length >= 2 && p.every((q) =>
    Array.isArray(q) && q.length >= 2 && finite(Number(q[0])) && finite(Number(q[1])));

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { key, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;

    const rawBuildings = Array.isArray(data.buildings) ? data.buildings : [];
    const rawRoads = Array.isArray(data.roads) ? data.roads : [];
    const rawStops = Array.isArray(data.stops) ? data.stops : [];
    const rawGreens = Array.isArray(data.greenZones) ? data.greenZones : [];

    // --- Здания: валидация + готовые AABB, исходные контуры сохраняем ---
    const buildings: Array<{ poly: Array<[number, number]>; h: number; type: string; levels?: number; bounds: [number, number, number, number] }> = [];
    for (const raw of rawBuildings) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      if (!polyOk(b.poly) || (b.poly as Array<[number, number]>).length < 3) continue;
      const poly = (b.poly as Array<[number, number]>).map((p) => [Number(p[0]), Number(p[1])] as [number, number]);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of poly) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;
      buildings.push({
        poly,
        h: finite(b.h) ? b.h : (finite(b.levels) ? b.levels : 10),
        type: typeof b.type === 'string' ? b.type : 'house',
        levels: finite(b.levels) ? b.levels : undefined,
        bounds: [minX, maxX, minZ, maxZ],
      });
    }

    // --- Дороги: сохраняем OSM ID и все атрибуты ---
    const roads: Array<{ id?: string; poly: Array<[number, number]>; w: number; lanes: number; oneWay: boolean; speed: number; type: string; t?: string }> = [];
    for (const raw of rawRoads) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (!polyOk(r.poly)) continue;
      const type = typeof r.type === 'string' ? r.type : (typeof r.t === 'string' ? r.t : '');
      roads.push({
        id: typeof r.id === 'string' ? r.id : undefined,
        poly: (r.poly as Array<[number, number]>).map((p) => [Number(p[0]), Number(p[1])] as [number, number]),
        w: finite(r.w) ? r.w : 9,
        lanes: finite(r.lanes) ? r.lanes : 1,
        oneWay: Boolean(r.oneWay),
        speed: finite(r.speed) ? r.speed : 50,
        type, t: type,
      });
    }

    // --- Остановки и зелёные зоны (раньше терялись) ---
    const stops: Array<{ id?: string; position: [number, number]; yaw?: number; model?: string; name?: string; name_ru?: string; name_kz?: string | null }> = [];
    for (const raw of rawStops) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      if (!polyOk(s.position)) continue;
      const pos = (s.position as Array<[number, number]>)[0];
      if (!pos) continue;
      stops.push({
        id: typeof s.id === 'string' ? s.id : undefined,
        position: [Number(pos[0]), Number(pos[1])],
        yaw: finite(s.yaw) ? s.yaw : 0,
        model: typeof s.model === 'string' ? s.model : undefined,
        name: typeof s.name === 'string' ? s.name : undefined,
        name_ru: typeof s.name_ru === 'string' ? s.name_ru : undefined,
        name_kz: typeof s.name_kz === 'string' ? s.name_kz : null,
      });
    }

    const greenZones: Array<{ id?: string; points: Array<[number, number]> }> = [];
    for (const raw of rawGreens) {
      if (!raw || typeof raw !== 'object') continue;
      const g = raw as Record<string, unknown>;
      const pointsRaw = g.points ?? g.poly;
      if (!polyOk(pointsRaw)) continue;
      greenZones.push({
        id: typeof g.id === 'string' ? g.id : undefined,
        points: (pointsRaw as Array<[number, number]>).map((p) => [Number(p[0]), Number(p[1])] as [number, number]),
      });
    }

    // --- Упаковка зданий: контуры + AABB + мета ---
    const bCount = buildings.length;
    const bPolys = new Float32Array(buildings.reduce((s, b) => s + b.poly.length * 2, 0));
    const bOffsets = new Uint32Array(bCount + 1);
    const bMeta = new Float32Array(bCount * 4); // h, levels, minX, maxX... нужен bounds → отдельный массив
    const bBounds = new Float32Array(bCount * 4);
    let off = 0;
    for (let i = 0; i < bCount; i++) {
      const b = buildings[i];
      bOffsets[i] = off;
      for (const [x, z] of b.poly) { bPolys[off++] = x; bPolys[off++] = z; }
      bMeta[i * 2] = b.h;
      bMeta[i * 2 + 1] = b.levels ?? 0;
      bBounds.set(b.bounds, i * 4);
    }
    bOffsets[bCount] = off;

    // --- Упаковка дорог ---
    const rCount = roads.length;
    const rPolys = new Float32Array(roads.reduce((s, r) => s + r.poly.length * 2, 0));
    const rOffsets = new Uint32Array(rCount + 1);
    const rMeta = new Float32Array(rCount * 4);
    let roff = 0;
    for (let i = 0; i < rCount; i++) {
      const r = roads[i];
      rOffsets[i] = roff;
      for (const [x, z] of r.poly) { rPolys[roff++] = x; rPolys[roff++] = z; }
      rMeta[i * 4] = r.w;
      rMeta[i * 4 + 1] = r.lanes;
      rMeta[i * 4 + 2] = r.oneWay ? 1 : 0;
      rMeta[i * 4 + 3] = r.speed;
    }
    rOffsets[rCount] = roff;

    const payload = {
      ok: true as const, key,
      bCount, bPolys, bOffsets, bMeta, bBounds,
      bTypes: buildings.map((b) => b.type),
      rCount, rPolys, rOffsets, rMeta,
      rIds: roads.map((r) => r.id ?? ''),
      rTypes: roads.map((r) => r.type),
      stops,
      greenZones,
    };

    (self as unknown as Worker).postMessage(payload, [
      bPolys.buffer, bOffsets.buffer, bMeta.buffer, bBounds.buffer,
      rPolys.buffer, rOffsets.buffer, rMeta.buffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, key, error: String(err) });
  }
};
