/**
 * coords.ts — географические преобразования.
 * Переводит широту/долготу в локальные метры (origin — центр Алматы).
 */

// Origin: район Абая / Достык, центр Алматы
export const ORIGIN_LAT = 43.2389;
export const ORIGIN_LON = 76.8897;

// Константы для проекции (примерно для широты Алматы ~43.2°)
const METERS_PER_DEGREE_LAT = 110540;
const METERS_PER_DEGREE_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

/**
 * Перевод lon/lat в локальные метры относительно ORIGIN.
 * X — восток, Z — юг (север = -Z).
 */
export function lonLatToMeters(lon: number, lat: number): { x: number; z: number } {
  const x = (lon - ORIGIN_LON) * METERS_PER_DEGREE_LON;
  const z = -(lat - ORIGIN_LAT) * METERS_PER_DEGREE_LAT;
  return { x, z };
}

/**
 * Перевод локальных метров в lon/lat.
 */
export function metersToLonLat(x: number, z: number): { lon: number; lat: number } {
  const lon = ORIGIN_LON + x / METERS_PER_DEGREE_LON;
  const lat = ORIGIN_LAT - z / METERS_PER_DEGREE_LAT;
  return { lon, lat };
}

/**
 * Размер региона в метрах (примерно).
 * Алматы + Каскелен ~ 57 × 41 км.
 */
export const REGION = {
  minLon: 76.55,
  maxLon: 77.25,
  minLat: 43.05,
  maxLat: 43.42,
} as const;

export function getRegionMeters(): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const { x: minX, z: maxZ } = lonLatToMeters(REGION.minLon, REGION.maxLat); // север-запад
  const { x: maxX, z: minZ } = lonLatToMeters(REGION.maxLon, REGION.minLat); // юг-восток
  return { minX, maxX, minZ, maxZ };
}
