/**
 * polygon.ts — чистая геометрия контуров зданий без DOM/Worker-зависимостей.
 * Используется osmTileProvider и tool-тестами триангуляции.
 */

import * as THREE from 'three';

export type Point2 = readonly [number, number];
export type PolygonPoint = Point2 | THREE.Vector2;

function coords(p: PolygonPoint): [number, number] {
  return p instanceof THREE.Vector2 ? [p.x, p.y] : [p[0], p[1]];
}

/** Убирает невалидные, повторяющиеся и замыкающие точки контура. */
export function cleanPolygon(points: readonly PolygonPoint[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const p of points) {
    if (!p) continue;
    const [x, y] = coords(p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const v = new THREE.Vector2(x, y);
    const last = out[out.length - 1];
    if (last && last.distanceToSquared(v) < 1e-10) continue;
    out.push(v);
  }
  if (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) < 1e-10) out.pop();
  return out;
}

/** Подписанная площадь контура (положительная — CCW в плоскости XZ). */
export function signedArea(points: readonly THREE.Vector2[]): number {
  return THREE.ShapeUtils.area([...points]);
}

/**
 * Корректная триангуляция вогнутых контуров (уши Three.js/Earcut).
 * Возвращает тройки индексов в очищенном контуре или null для вырожденных случаев.
 */
export function triangulatePolygon(points: readonly PolygonPoint[]): number[][] | null {
  const clean = cleanPolygon(points);
  if (clean.length < 3) return null;
  if (Math.abs(signedArea(clean)) < 1e-6) return null;
  try {
    const faces = THREE.ShapeUtils.triangulateShape(clean, []);
    if (!faces || faces.length !== clean.length - 2) return null;
    return faces;
  } catch {
    return null;
  }
}

const CANONICAL: Record<string, [number, number][]> = {
  rect: [[0, 0], [1, 0], [1, 1], [0, 1]],
  chamfer: [[0.15, 0], [0.85, 0], [1, 0.15], [1, 0.85], [0.85, 1], [0.15, 1], [0, 0.85], [0, 0.15]],
  triangle: [[0, 0], [1, 0], [0.5, 1]],
  lshape: [[0, 0], [1, 0], [1, 0.42], [0.45, 0.42], [0.45, 1], [0, 1]],
  ushape: [[0, 0], [1, 0], [1, 1], [0.68, 1], [0.68, 0.36], [0.32, 0.36], [0.32, 1], [0, 1]],
};

/**
 * Квантует реальный OSM-контур в небольшой набор архитипов. Это сохраняет характер
 * застройки (прямоугольная, скошенная, G/L/U-образная), но ограничивает число
 * уникальных BufferGeometry: иначе каждый дом давал отдельный InstancedMesh
 * и сотни лишних draw calls. Габариты и положение остаются реальными.
 */
export function canonicalFootprint(points: readonly PolygonPoint[]): [number, number][] {
  const clean = cleanPolygon(points);
  if (clean.length < 3) return CANONICAL.rect;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of clean) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const box = (maxX - minX) * (maxY - minY);
  if (box <= 1e-9) return CANONICAL.rect;
  const solidity = Math.abs(signedArea(clean)) / box;
  if (clean.length === 3 || solidity < 0.45) return CANONICAL.triangle;
  if (solidity > 0.93) return clean.length >= 7 ? CANONICAL.chamfer : CANONICAL.rect;
  return clean.length <= 6 ? CANONICAL.lshape : CANONICAL.ushape;
}

/**
 * Гарантирует, что треугольник в плоскости XZ смотрит вверх (+Y).
 * shape-координаты (x,z) и 3D-нормаль имеют противоположную ориентацию,
 * поэтому для CCW-контура вершины меняются местами.
 */
export function upwardFace(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): [number, number, number] {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return cross > 0 ? [0, 2, 1] : [0, 1, 2];
}
