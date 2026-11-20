/**
 * routeTracker.ts — отслеживание маршрута 212/230/244.
 * Ищет ближайшую OSM-остановку, показывает следующую по названию,
 * считает прогресс и distance до следующей точки.
 */

import type { BusRoute } from './routes';
import { lonLatToMeters } from '../world/coords';

export interface StopIndexEntry {
  id: string;
  position: [number, number]; // локальные метры [x, z]
  name?: string;
  name_ru?: string;
  name_kz?: string;
}

interface StopIndex {
  stops: StopIndexEntry[];
}

export interface RouteProgress {
  routeId: string;
  directionId: string;
  currentStop: string;
  nextStop: string;
  distanceM: number;
  passed: number;
  total: number;
}

export class RouteTracker {
  private index: StopIndexEntry[] = [];
  private route: BusRoute | null = null;
  private directionIndex = 0;
  private passed = 0;
  private lastStopId: string | null = null;

  async load(): Promise<void> {
    const url = `${import.meta.env.BASE_URL}map/v1/stops-index.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stops-index: ${res.status}`);
    const data = (await res.json()) as StopIndex;
    this.index = data.stops ?? [];
  }

  selectRoute(route: BusRoute, directionIndex = 0) {
    this.route = route;
    this.directionIndex = directionIndex;
    this.passed = 0;
    this.lastStopId = null;
  }

  get currentRoute(): BusRoute | null { return this.route; }

  private nearestStop(x: number, z: number): { stop: StopIndexEntry; dist: number } | null {
    let best: StopIndexEntry | null = null;
    let bestD = Infinity;
    for (const stop of this.index) {
      const dx = stop.position[0] - x;
      const dz = stop.position[1] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = stop; }
    }
    return best ? { stop: best, dist: Math.sqrt(bestD) } : null;
  }

  update(playerX: number, playerZ: number): RouteProgress | null {
    if (!this.route) return null;
    const dir = this.route.directions[this.directionIndex];
    if (!dir) return null;

    const near = this.nearestStop(playerX, playerZ);
    let currentName = '—';
    let nextName = '—';
    let distance = 0;

    if (near) {
      currentName = near.stop.name_ru ?? near.stop.name ?? 'Остановка';
      if (near.stop.id !== this.lastStopId && near.dist < 30) {
        this.lastStopId = near.stop.id;
        this.passed++;
      }
    }

    // Следующая остановка маршрута: ищем по названию в JSON строки
    const stops = dir.stops;
    const afterPassed = stops.slice(Math.min(this.passed, stops.length - 1));
    const nextRaw = afterPassed[0];
    if (nextRaw) {
      nextName = nextRaw.name_ru || nextRaw.name_kz || '—';
      if (nextRaw.lat != null && nextRaw.lon != null) {
        const p = lonLatToMeters(nextRaw.lon, nextRaw.lat);
        distance = Math.hypot(p.x - playerX, p.z - playerZ);
      } else if (near) {
        distance = Math.max(0, near.dist - 30);
      }
    }

    return {
      routeId: this.route.id,
      directionId: dir.id,
      currentStop: currentName,
      nextStop: nextName,
      distanceM: Math.round(distance),
      passed: this.passed,
      total: stops.length,
    };
  }
}
