/**
 * tileManager.ts — стриминг тайлов карты.
 * Загружает тайлы только около автобуса, кэширует, удаляет distant.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getPhysicsWorld, getRapier } from '../core/rapier';
import { lonLatToMeters, getRegionMeters } from './coords';

const TILE_SIZE = 800; // метров
const RING_NEAR = 300; // м — полная детализация
const RING_MID = 1500; // м — упрощённые здания
const RING_FAR = 6000; // м — только массы и рельеф
const CACHE_LIMIT = 400; // максимум тайлов в памяти

type TileKey = `${number},${number}`;

interface TileData {
  key: TileKey;
  centerX: number;
  centerZ: number;
  buildings: THREE.Group;
  roads: THREE.Group;
  colliders: RAPIER.Collider[];
  loaded: boolean;
  lastAccess: number;
}

const tiles = new Map<TileKey, TileData>();
const tileQueue: TileKey[] = [];

// Временные заглушки: процедурная генерация вместо реальных OSM (пока данные не скачаны)
function generateFakeBuilding(x: number, z: number, size: number): THREE.Group {
  const group = new THREE.Group();
  const width = 8 + Math.random() * 20;
  const depth = 8 + Math.random() * 20;
  const height = 10 + Math.random() * 60;

  const geo = new THREE.BoxGeometry(width, height, depth);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8899aa,
    roughness: 0.8,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, height / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // Крыша
  const roofGeo = new THREE.BoxGeometry(width * 1.1, 1, depth * 1.1);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x556677 });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(x, height + 0.5, z);
  roof.castShadow = true;
  group.add(roof);

  return group;
}

function generateFakeRoad(x: number, z: number, length: number, dir: 'x' | 'z'): THREE.Group {
  const group = new THREE.Group();
  const width = 10;

  const geo = dir === 'x'
    ? new THREE.PlaneGeometry(length, width)
    : new THREE.PlaneGeometry(width, length);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a332a,
    roughness: 0.9,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.02, z);
  mesh.receiveShadow = true;
  group.add(mesh);

  // Разметка
  const lineGeo = dir === 'x'
    ? new THREE.PlaneGeometry(length * 0.8, 0.8)
    : new THREE.PlaneGeometry(0.8, length * 0.8);
  lineGeo.rotateX(-Math.PI / 2 + 0.001);
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x222222,
    emissiveIntensity: 0.4,
  });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.position.set(x, 0.03, z);
  group.add(line);

  return group;
}

export class TileManager {
  private scene: THREE.Scene;
  private playerX = 0;
  private playerZ = 0;
  private activeTiles = new Set<TileKey>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setPlayerPosition(x: number, z: number) {
    this.playerX = x;
    this.playerZ = z;
  }

  update(dt: number) {
    this.loadNearbyTiles();
    this.unloadDistantTiles();
  }

  private loadNearbyTiles() {
    const { minX, maxX, minZ, maxZ } = getRegionMeters();

    // Какие тайлы нужны вокруг игрока
    const tileX = Math.floor(this.playerX / TILE_SIZE);
    const tileZ = Math.floor(this.playerZ / TILE_SIZE);

    const needed = new Set<TileKey>();

    // Загружаем 5x5 тайлов вокруг игрока
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const tx = tileX + dx;
        const tz = tileZ + dz;
        const key = `${tx},${tz}` as TileKey;
        needed.add(key);

        const centerX = tx * TILE_SIZE + TILE_SIZE / 2;
        const centerZ = tz * TILE_SIZE + TILE_SIZE / 2;

        // Проверка границ региона
        if (centerX < minX || centerX > maxX || centerZ < minZ || centerZ > maxZ) {
          continue;
        }

        if (!tiles.has(key)) {
          this.createTile(key, centerX, centerZ);
        }
        this.activeTiles.add(key);
      }
    }

    // Помечаем dernière accès
    for (const key of needed) {
      const tile = tiles.get(key);
      if (tile) tile.lastAccess = Date.now();
    }
  }

  private createTile(key: TileKey, centerX: number, centerZ: number) {
    const world = getPhysicsWorld();

    const buildings = new THREE.Group();
    const roads = new THREE.Group();
    const colliders: RAPIER.Collider[] = [];

    // Генерация заглушки: случайные здания и дороги в тайле
    const buildingCount = 4 + Math.floor(Math.random() * 6);
    for (let i = 0; i < buildingCount; i++) {
      const bx = centerX - TILE_SIZE / 2 + Math.random() * TILE_SIZE;
      const bz = centerZ - TILE_SIZE / 2 + Math.random() * TILE_SIZE;
      const b = generateFakeBuilding(bx, bz, 15);
      buildings.add(b);

      // Коллайдер здания (упрощённый куб)
      const colliderDesc = RAPIER.ColliderDesc.cuboid(6, 20, 6);
      colliderDesc.setTranslation(bx, 20, bz);
      const collider = world.createCollider(colliderDesc);
      colliders.push(collider);
    }

    // Дороги (сетка)
    const roadSpacing = 200;
    const startX = Math.floor((centerX - TILE_SIZE / 2) / roadSpacing) * roadSpacing;
    const startZ = Math.floor((centerZ - TILE_SIZE / 2) / roadSpacing) * roadSpacing;

    for (let x = startX; x <= centerX + TILE_SIZE / 2; x += roadSpacing) {
      const r = generateFakeRoad(x, centerZ, TILE_SIZE, 'z');
      roads.add(r);
    }
    for (let z = startZ; z <= centerZ + TILE_SIZE / 2; z += roadSpacing) {
      const r = generateFakeRoad(centerX, z, TILE_SIZE, 'x');
      roads.add(r);
    }

    const tile: TileData = {
      key,
      centerX,
      centerZ,
      buildings,
      roads,
      colliders,
      loaded: true,
      lastAccess: Date.now(),
    };

    tiles.set(key, tile);
    this.scene.add(buildings);
    this.scene.add(roads);
  }

  private unloadDistantTiles() {
    const now = Date.now();
    const toRemove: TileKey[] = [];

    for (const [key, tile] of tiles) {
      if (this.activeTiles.has(key)) continue;

      const dist = Math.hypot(
        tile.centerX - this.playerX,
        tile.centerZ - this.playerZ
      );

      // Удаляем тайлы дальше 8000 м или если кэш переполнен
      if (dist > 8000 || tiles.size > CACHE_LIMIT) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.removeTile(key);
    }

    this.activeTiles.clear();
  }

  private removeTile(key: TileKey) {
    const tile = tiles.get(key);
    if (!tile) return;

    this.scene.remove(tile.buildings);
    this.scene.remove(tile.roads);

    tile.buildings.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) {
            c.material.forEach((m) => m.dispose());
          } else {
            c.material.dispose();
          }
        }
      }
    });
    tile.roads.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) {
            c.material.forEach((m) => m.dispose());
          } else {
            c.material.dispose();
          }
        }
      }
    });

    const world = getPhysicsWorld();
    for (const collider of tile.colliders) {
      world.removeCollider(collider, true);
    }

    tiles.delete(key);
  }

  getTileCount() {
    return tiles.size;
  }

  dispose() {
    for (const key of [...tiles.keys()]) {
      this.removeTile(key);
    }
  }
}
