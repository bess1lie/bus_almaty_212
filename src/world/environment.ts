/**
 * environment.ts — закатное небо, горы, солнце и облака.
 * Всё дешёвое: вершинные цвета, без текстур и тяжёлых шейдеров.
 */

import * as THREE from 'three';

function createLowPolyClouds(): THREE.Mesh {
  const specs = [
    { x: -900, y: 370, z: -1450, w: 190, h: 18 },
    { x: -650, y: 465, z: -1750, w: 270, h: 26 },
    { x: -290, y: 405, z: -1530, w: 220, h: 20 },
    { x: 90, y: 510, z: -1800, w: 320, h: 28 },
    { x: 500, y: 440, z: -1650, w: 250, h: 22 },
    { x: 820, y: 520, z: -1850, w: 280, h: 26 },
    { x: 1110, y: 390, z: -1600, w: 190, h: 18 },
  ];
  const profile: Array<[number, number]> = [
    [-0.5, 0], [-0.34, -0.25], [-0.08, -0.19], [0.1, -0.31],
    [0.38, -0.2], [0.5, 0.02], [0.29, 0.23], [-0.31, 0.2],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const cloud of specs) {
    const center = positions.length / 3;
    positions.push(cloud.x, cloud.y, cloud.z);
    for (const [px, py] of profile) {
      positions.push(cloud.x + px * cloud.w, cloud.y + py * cloud.h, cloud.z);
    }
    for (let i = 0; i < profile.length; i++) {
      indices.push(center, center + 1 + i, center + 1 + ((i + 1) % profile.length));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({
    color: 0xf3d5c2, transparent: true, opacity: 0.26,
    depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  const clouds = new THREE.Mesh(geometry, material);
  clouds.name = 'low-poly-sunset-clouds';
  clouds.frustumCulled = false;
  clouds.renderOrder = 2;
  return clouds;
}

export function createEnvironment(scene: THREE.Scene) {
  // --- Небо: градиентный купол ---
  const SKY_R = 2500;
  const skyGeo = new THREE.SphereGeometry(SKY_R, 32, 16);
  const colors: number[] = [];
  const pos = skyGeo.getAttribute('position');
  const top = new THREE.Color(0x1b2a4a);
  const mid = new THREE.Color(0x8a6a72);
  const horizon = new THREE.Color(0xf3a35f);
  const bottom = new THREE.Color(0x5a4a4a);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / SKY_R;
    let c: THREE.Color;
    if (y > 0.25) c = mid.clone().lerp(top, Math.min(1, (y - 0.25) * 1.8));
    else if (y > 0) c = horizon.clone().lerp(mid, y / 0.25);
    else c = horizon.clone().lerp(bottom, Math.min(1, -y * 2));
    colors.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    skyGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false })
  );
  sky.name = 'sky';
  scene.add(sky);

  // Солнце перед автобусом, в направлении движения -Z.
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(82, 40),
    new THREE.MeshBasicMaterial({
      color: 0xf3a35f, side: THREE.DoubleSide, depthWrite: false,
      fog: false, toneMapped: false,
    })
  );
  sunDisc.name = 'sunset-disc';
  sunDisc.position.set(-360, 250, -1600);
  sunDisc.renderOrder = 1;
  sunDisc.frustumCulled = false;

  const clouds = createLowPolyClouds();
  scene.add(sunDisc);
  scene.add(clouds);

  // --- Горы на юге ---
  const ridge = new THREE.Group();
  ridge.name = 'mountains';
  const segments = 50;
  const width = 5000;
  const step = width / segments;
  const ridgeZ = 2800;
  const positions: number[] = [];
  const indices: number[] = [];
  const peakColors: number[] = [];
  const heightAt = (i: number) => {
    const t = i / segments;
    return 260 + Math.sin(t * 7.3) * 110 + Math.sin(t * 17.7) * 60 + (t > 0.3 && t < 0.7 ? 140 : 0);
  };
  const rock = new THREE.Color(0x3c404f);
  const rock2 = new THREE.Color(0x4c4f5e);
  const snow = new THREE.Color(0xece8e2);
  for (let i = 0; i <= segments; i++) {
    const x = -width / 2 + i * step;
    const h = heightAt(i);
    positions.push(x, -30, ridgeZ + 400);
    positions.push(x, h, ridgeZ);
    peakColors.push(rock.r, rock.g, rock.b);
    const c = h > 430 ? snow : (i % 2 ? rock : rock2);
    peakColors.push(c.r, c.g, c.b);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(peakColors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  ridge.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
  scene.add(ridge);

  // --- Свет ---
  const sun = new THREE.DirectionalLight(0xffc48a, 1.5);
  sun.position.set(-120, 90, -160);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x9fb4c8, 0.7));

  // Лёгкая синяя дымка
  scene.fog = new THREE.FogExp2(0x8a8fa0, 0.00012);

  return { sky, ridge, sun, sunDisc, clouds };
}
