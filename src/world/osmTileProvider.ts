/**
 * osmTileProvider.ts — адаптер JSON-тайлов OSM к CityWorld (BatchedMesh/LOD/frustum).
 * Загружает public/map/v1/tiles/{x}_{z}.json и строит BuildingSource + roads.
 */

import * as THREE from 'three';
import type { CityTilePayload, CityTileProvider, BuildingSource } from './cityWorld';
import type { CityBuilding, CityRoad } from './tiles';

const TILE = 2000;

type TileJson = { buildings: CityBuilding[]; roads: CityRoad[] };

/** Детальная геометрия здания: коробка + «крыша» (два объёма) для LOD<300м. */
function makeBuildingGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0); // база на Y=0, как ожидает CityWorld
  return g;
}

function buildRoads(roads: CityRoad[], tileX: number, tileZ: number): THREE.Group {
  const group = new THREE.Group();
  const positions: number[] = [];
  const indices: number[] = [];
  const originX = tileX * TILE;
  const originZ = tileZ * TILE;
  let vc = 0;

  for (const road of roads) {
    if (road.poly.length < 2) continue;
    for (let i = 0; i < road.poly.length; i++) {
      const [ax, az] = road.poly[i];
      const prev = road.poly[Math.max(0, i - 1)];
      const next = road.poly[Math.min(road.poly.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const hw = Math.min(Math.max(road.w / 2, 3), 12);
      const x = ax - originX;
      const z = az - originZ;

      positions.push(x + nx * hw, 0.04, z + nz * hw);
      positions.push(x - nx * hw, 0.04, z - nz * hw);
      if (i > 0) {
        const p = vc - 2;
        const c = vc;
        indices.push(p, p + 1, c, p + 1, c + 1, c);
      }
      vc += 2;
    }
  }

  if (vc > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x2b3336, roughness: 0.95, side: THREE.DoubleSide })
    );
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

const COLORS = [0x8d9aa5, 0xa8a093, 0x7d8b96, 0x9aa6a0, 0xb0a99b, 0x83918c];

export class OsmTileProvider implements CityTileProvider {
  private readonly cache = new Map<string, Promise<CityTilePayload>>();

  async loadTile(tileX: number, tileZ: number): Promise<CityTilePayload> {
    const key = `${tileX}_${tileZ}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetchTile(tileX, tileZ, key);
      this.cache.set(key, p);
    }
    return p;
  }

  private async fetchTile(tileX: number, tileZ: number, key: string): Promise<CityTilePayload> {
    const url = `${import.meta.env.BASE_URL}map/v1/tiles/${key}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tile ${key}: ${res.status}`);
    const data = (await res.json()) as TileJson;

    const originX = tileX * TILE;
    const originZ = tileZ * TILE;
    const buildings: BuildingSource[] = [];

    for (let i = 0; i < data.buildings.length; i++) {
      const b = data.buildings[i];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of b.poly) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const w = Math.max(3, maxX - minX);
      const d = Math.max(3, maxZ - minZ);
      const h = Math.max(4, b.h);

      buildings.push({
        position: new THREE.Vector3(
          (minX + maxX) / 2 - originX,
          0,
          (minZ + maxZ) / 2 - originZ
        ),
        size: new THREE.Vector3(w, h, d),
        color: COLORS[(i + b.type.length) % COLORS.length],
        geometry: makeBuildingGeometry(),
        collidable: false, // коллайдеры зданий пока не нужны
      });
    }

    return { buildings, roads: buildRoads(data.roads, tileX, tileZ) };
  }
}
