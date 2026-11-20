// src/world/streetMetadata.ts

import type {
  StreetTileDescriptor,
  StreetTileKeyProvider,
  StreetPoint,
} from './streetProps';

const TILE_SIZE = 2000;
const VERSION = 1;

type PointLike =
  | readonly [number, number]
  | {
      x: number;
      y?: number;
      z?: number;
    };

interface CityRoad {
  id?: string | number;
  poly: readonly PointLike[];
  w: number;
}

interface CityGreenZone {
  id?: string | number;
  poly?: readonly PointLike[];
  points?: readonly PointLike[];
}

interface CityTilePayload {
  roads?: readonly CityRoad[];
  greenZones?: readonly CityGreenZone[] | readonly PointLike[][];
  greens?: readonly CityGreenZone[] | readonly PointLike[][];
  parks?: readonly CityGreenZone[] | readonly PointLike[][];
}

export interface StreetMetadataOptions {
  publicBaseUrl?: string;
  fetcher?: typeof fetch;
  logErrors?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function tileKey(x: number, z: number): string {
  return `${x}:${z}`;
}

function parsePoint(value: unknown): StreetPoint | null {
  if (Array.isArray(value)) {
    if (value.length < 2) return null;
    const x = Number(value[0]);
    const z = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return [x, z];
  }
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const z = Number(value.z ?? value.y);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return [x, z];
}

function parsePolygon(value: unknown): StreetPoint[] | null {
  if (!Array.isArray(value)) return null;
  const points: StreetPoint[] = [];
  for (const rawPoint of value) {
    const point = parsePoint(rawPoint);
    if (point) points.push(point);
  }
  return points.length >= 3 ? points : null;
}

function normalizeGreenZones(
  payload: CityTilePayload,
): StreetTileDescriptor['greenZones'] {
  const rawZones = payload.greenZones ?? payload.greens ?? payload.parks;
  if (!Array.isArray(rawZones)) return [];
  const result: NonNullable<StreetTileDescriptor['greenZones']>[number][] = [];
  for (let i = 0; i < rawZones.length; i++) {
    const raw = rawZones[i];
    let polygon: StreetPoint[] | null = null;
    let id: string | undefined;
    if (Array.isArray(raw)) {
      polygon = parsePolygon(raw);
    } else if (isRecord(raw)) {
      id = String(raw.id ?? `green-${i}`);
      polygon = parsePolygon(raw.poly ?? raw.points);
    }
    if (!polygon) continue;
    result.push({ id, points: polygon, coordinateSpace: 'tile' });
  }
  return result;
}

function normalizePayload(raw: unknown): CityTilePayload {
  if (!isRecord(raw)) throw new Error('Invalid city tile JSON: expected object');
  const container = isRecord(raw.tile) ? raw.tile : isRecord(raw.payload) ? raw.payload : raw;
  return container as unknown as CityTilePayload;
}

export class StreetMetadataProvider {
  private readonly descriptors = new Map<string, StreetTileDescriptor>();
  private readonly pending = new Map<string, Promise<StreetTileDescriptor | undefined>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly logErrors: boolean;
  private disposed = false;

  readonly tileKeyProvider: StreetTileKeyProvider;

  constructor(options: StreetMetadataOptions = {}) {
    const defaultBase = typeof document !== 'undefined'
      ? new URL('./', document.baseURI).href
      : '/';
    this.baseUrl = (options.publicBaseUrl ?? defaultBase).replace(/\/?$/, '/');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.logErrors = options.logErrors ?? true;

    const provider = (() => this.getTileKeys()) as StreetTileKeyProvider;
    provider.getTileData = (key: string) => this.getTileData(key);
    this.tileKeyProvider = provider;
  }

  notifyTileLoaded(x: number, z: number): Promise<StreetTileDescriptor | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (!Number.isInteger(x) || !Number.isInteger(z)) {
      return Promise.reject(new Error(`Invalid tile coordinates: ${x}, ${z}`));
    }
    const key = tileKey(x, z);
    const existing = this.descriptors.get(key);
    if (existing) return Promise.resolve(existing);
    const existingRequest = this.pending.get(key);
    if (existingRequest) return existingRequest;

    const controller = new AbortController();
    this.controllers.set(key, controller);

    const url = new URL(`map/v1/tiles/${x}_${z}.json`, this.baseUrl).toString();
    const request = this.fetcher(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'force-cache',
      headers: { Accept: 'application/json' },
    })
      .then(async (response): Promise<StreetTileDescriptor> => {
        if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
        const json: unknown = await response.json();
        const payload = normalizePayload(json);
        const descriptor = this.buildDescriptor(x, z, payload);
        if (!this.disposed) this.descriptors.set(key, descriptor);
        return descriptor;
      })
      .catch((error: unknown) => {
        if (!this.disposed && !(error instanceof DOMException && error.name === 'AbortError') && this.logErrors) {
          console.warn(`[StreetMetadata] Failed to load tile ${key}:`, error);
        }
        return undefined;
      })
      .finally(() => {
        this.pending.delete(key);
        this.controllers.delete(key);
      });

    this.pending.set(key, request);
    return request;
  }

  setTilePayload(x: number, z: number, rawPayload: unknown): StreetTileDescriptor {
    if (this.disposed) throw new Error('StreetMetadataProvider is disposed');
    const payload = normalizePayload(rawPayload);
    const descriptor = this.buildDescriptor(x, z, payload);
    this.descriptors.set(tileKey(x, z), descriptor);
    return descriptor;
  }

  getTileKeys(): StreetTileDescriptor[] {
    return Array.from(this.descriptors.values()).sort((a, b) => a.x - b.x || a.z - b.z);
  }

  getTileData(key: string): StreetTileDescriptor | undefined {
    return this.descriptors.get(key);
  }

  getStreetTileKeyProvider(): StreetTileKeyProvider {
    return this.tileKeyProvider;
  }

  removeTile(x: number, z: number): void {
    const key = tileKey(x, z);
    this.descriptors.delete(key);
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.pending.delete(key);
  }

  private buildDescriptor(x: number, z: number, payload: CityTilePayload): StreetTileDescriptor {
    const roads: NonNullable<StreetTileDescriptor['roads']>[number][] = [];
    for (let i = 0; i < (payload.roads?.length ?? 0); i++) {
      const road = payload.roads![i];
      if (!Array.isArray(road.poly) || road.poly.length < 2) continue;
      const points: StreetPoint[] = [];
      for (const rawPoint of road.poly) {
        const point = parsePoint(rawPoint);
        if (point) points.push(point);
      }
      if (points.length < 2) continue;
      const width = Number(road.w);
      roads.push({
        id: String(road.id ?? `${x}:${z}:road:${i}`),
        points,
        width: Number.isFinite(width) && width > 0 ? width : 9,
        coordinateSpace: 'world', // OSM-координаты в тайле уже абсолютные (метры от origin)
        markings: true,
        sidewalks: true,
      });
    }
    return {
      key: tileKey(x, z),
      x,
      z,
      roads,
      greenZones: normalizeGreenZones(payload),
      stops: [],
      version: VERSION,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.pending.clear();
    this.descriptors.clear();
  }
}
