/**
 * tile.worker.ts — загрузка и валидация OSM-тайла вне главного потока.
 * Отдаёт чистые числовые массивы (transferable), без THREE-объектов.
 */

interface WorkerRequest { key: string; url: string; }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { key, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
    const data = await res.json() as {
      buildings?: Array<{ poly: Array<[number, number]>; h: number; type: string; levels?: number }>;
      roads?: Array<{ poly: Array<[number, number]>; w: number; lanes: number; oneWay: boolean; speed: number; t?: string; type?: string }>;
    };

    // Валидация: отбрасываем битые контуры
    const buildings = (data.buildings ?? []).filter((b) =>
      Array.isArray(b.poly) && b.poly.length >= 3 &&
      b.poly.every((p) => Array.isArray(p) && p.length >= 2 &&
        Number.isFinite(p[0]) && Number.isFinite(p[1]))
    ).map((b) => ({
      poly: b.poly,
      h: Number.isFinite(b.h) ? b.h : 10,
      type: b.type ?? 'house',
      levels: Number.isFinite(b.levels) ? b.levels : undefined,
    }));

    const roads = (data.roads ?? []).filter((r) =>
      Array.isArray(r.poly) && r.poly.length >= 2
    ).map((r) => ({
      poly: r.poly,
      w: Number.isFinite(r.w) ? r.w : 9,
      lanes: Number.isFinite(r.lanes) ? r.lanes : 1,
      oneWay: Boolean(r.oneWay),
      speed: Number.isFinite(r.speed) ? r.speed : 50,
      type: r.type ?? r.t ?? '',
    }));

    // Упаковываем в плоские Float32Array — zero-copy transfer
    const bCount = buildings.length;
    const bPolys = new Float32Array(buildings.reduce((s, b) => s + b.poly.length * 2, 0));
    const bOffsets = new Uint32Array(bCount + 1);
    const bMeta = new Float32Array(bCount * 3);
    let off = 0;
    for (let i = 0; i < bCount; i++) {
      const b = buildings[i];
      bOffsets[i] = off;
      for (const p of b.poly) { bPolys[off++] = p[0]; bPolys[off++] = p[1]; }
      bMeta[i * 3] = b.h;
      bMeta[i * 3 + 1] = b.levels ?? 0;
      bMeta[i * 3 + 2] = 0;
    }
    bOffsets[bCount] = off;

    const rCount = roads.length;
    const rPolys = new Float32Array(roads.reduce((s, r) => s + r.poly.length * 2, 0));
    const rOffsets = new Uint32Array(rCount + 1);
    const rMeta = new Float32Array(rCount * 4);
    let roff = 0;
    for (let i = 0; i < rCount; i++) {
      const r = roads[i];
      rOffsets[i] = roff;
      for (const p of r.poly) { rPolys[roff++] = p[0]; rPolys[roff++] = p[1]; }
      rMeta[i * 4] = r.w;
      rMeta[i * 4 + 1] = r.lanes;
      rMeta[i * 4 + 2] = r.oneWay ? 1 : 0;
      rMeta[i * 4 + 3] = r.speed;
    }
    rOffsets[rCount] = roff;

    (self as unknown as Worker).postMessage(
      { ok: true, key, bCount, bPolys, bOffsets, bMeta, rCount, rPolys, rOffsets, rMeta, types: buildings.map(b => b.type), roadTypes: roads.map(r => r.type) },
      [bPolys.buffer, bOffsets.buffer, bMeta.buffer, rPolys.buffer, rOffsets.buffer, rMeta.buffer],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, key, error: String(err) });
  }
};
