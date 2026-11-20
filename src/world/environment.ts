/**
 * environment.ts — горы Заилийского Алатау на горизонте + закатное небо.
 * Дешёво: один меш хребта, градиент неба, туман.
 */

import * as THREE from 'three';

export function createEnvironment(scene: THREE.Scene) {
  // Небо — градиент через большой купол с вершинными цветами
  const SKY_R = 2500;
  const skyGeo = new THREE.SphereGeometry(SKY_R, 32, 16);
  const colors: number[] = [];
  const pos = skyGeo.getAttribute('position');
  const top = new THREE.Color(0x1f2e52);
  const horizon = new THREE.Color(0xf0a866); // тёплый закат
  const bottom = new THREE.Color(0x6b5a52);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / SKY_R;
    let c: THREE.Color;
    if (y > 0) c = horizon.clone().lerp(top, Math.min(1, y * 1.5));
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

  // Горный хребет: низкополигональная гряда с юга (в Алматы горы на юге)
  const ridge = new THREE.Group();
  ridge.name = 'mountains';
  const segments = 60;
  const width = 4000;
  const step = width / segments;
  const positions: number[] = [];
  const indices: number[] = [];
  const peakColors: number[] = [];

  // детерминированный «шум» для profile
  const heightAt = (i: number) => {
    const t = i / segments;
    const base = 250 + Math.sin(t * 7.3) * 90 + Math.sin(t * 17.7) * 50;
    const snow = Math.max(300, base + 120 * Math.sin(t * 3.1 + 1));
    return t > 0.3 && t < 0.7 ? snow : base;
  };

  const z = -2600; // юг (север = -Z, значит юг = +Z? в coords z = -(lat-lat0): юг = +Z)
  const ridgeZ = 2600;

  for (let i = 0; i <= segments; i++) {
    const x = -width / 2 + i * step;
    const h = heightAt(i);
    positions.push(x, -20, ridgeZ + 300);
    positions.push(x, h, ridgeZ);
    // цвет: снизу серо-коричневый, вершины белые
    const rock = new THREE.Color(0x5f5f6a);
    const snow = new THREE.Color(0xe8e8ea);
    peakColors.push(rock.r, rock.g, rock.b);
    peakColors.push(h > 360 ? snow.r : rock.r, h > 360 ? snow.g : rock.g, h > 360 ? snow.b : rock.b);
    if (i < segments) {
      const a = (i * 2);
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(peakColors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mountains = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })
  );
  mountains.name = 'mountain-ridge';
  ridge.add(mountains);
  scene.add(ridge);

  // Тёплый солнечный свет (закат) с юго-запада
  const sun = new THREE.DirectionalLight(0xffc48a, 1.5);
  sun.position.set(-120, 90, 160);
  scene.add(sun);

  const ambient = new THREE.AmbientLight(0x9fb4c8, 0.55);
  scene.add(ambient);

  scene.fog = new THREE.FogExp2(0xc9a184, 0.0007);

  return { sky, ridge, sun };
}
