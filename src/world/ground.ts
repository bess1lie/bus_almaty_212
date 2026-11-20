/**
 * ground.ts — простая дорога / земля для первых тестов.
 * Позже заменится на стриминг тайлов из OSM.
 */

import * as THREE from 'three';
import { getRapier, getPhysicsWorld } from '../core/rapier';

const GROUND_SIZE = 2000;

let mesh: THREE.Mesh;

export function createGround(scene: THREE.Scene): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x334033,
    roughness: 0.9,
    metalness: 0.1,
  });
  mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Разметка дорог (белая линия по центру)
  const lineGeo = new THREE.PlaneGeometry(8000, 1.2);
  lineGeo.rotateX(-Math.PI / 2 + 0.001);
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x222222,
    emissiveIntensity: 0.3,
  });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.position.z = 0;
  scene.add(line);

  // Физика: статический коллайдер земли
  const RAPIER = getRapier();
  const world = getPhysicsWorld();
  const colliderDesc = RAPIER.ColliderDesc.cuboid(GROUND_SIZE / 2, 0.5, GROUND_SIZE / 2);
  world.createCollider(colliderDesc);

  return mesh;
}

export function disposeGround() {
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.geometry.dispose();
  if ((mesh.material as THREE.Material).dispose) {
    (mesh.material as THREE.Material).dispose();
  }
}
