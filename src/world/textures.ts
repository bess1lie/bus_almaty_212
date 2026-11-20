/**
 * textures.ts — процедурные CanvasTexture (без внешних файлов).
 * Асфальт, фасады 4 типов, крыши, тротуары. Создаются один раз.
 */

import * as THREE from 'three';

export type BuildingTextureKind = 'apartments' | 'house' | 'commercial' | 'industrial';

export interface TextureLibrary {
  asphalt: THREE.CanvasTexture;
  sidewalk: THREE.CanvasTexture;
  roof: THREE.CanvasTexture;
  walls: Record<BuildingTextureKind, THREE.CanvasTexture>;
}

let cached: TextureLibrary | null = null;

function makeCanvas(size = 256): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function grain(ctx: CanvasRenderingContext2D, size: number, amount: number, alpha: number) {
  for (let i = 0; i < amount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const g = Math.floor(Math.random() * 60);
    ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function asphaltTexture(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = '#3a3d40';
  ctx.fillRect(0, 0, 256, 256);
  // крупные пятна
  for (let i = 0; i < 40; i++) {
    const r = 8 + Math.random() * 40;
    ctx.fillStyle = `rgba(30,32,34,${0.05 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // мелкий гравий
  for (let i = 0; i < 900; i++) {
    const g = 70 + Math.floor(Math.random() * 60);
    ctx.fillStyle = `rgba(${g},${g},${g},0.25)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }
  // трещины
  ctx.strokeStyle = 'rgba(15,16,18,0.45)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = Math.random() * 256, y = Math.random() * 256;
    ctx.moveTo(x, y);
    for (let j = 0; j < 6; j++) {
      x += (Math.random() - 0.5) * 40;
      y += (Math.random() - 0.5) * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return toTexture(c, 1);
}

function sidewalkTexture(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = '#9a9891';
  ctx.fillRect(0, 0, 256, 256);
  // плиты 64x64
  ctx.strokeStyle = 'rgba(60,58,55,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
  }
  grain(ctx, 256, 1500, 0.1);
  return toTexture(c, 1);
}

function roofTexture(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(128);
  ctx.fillStyle = '#4e545a';
  ctx.fillRect(0, 0, 128, 128);
  grain(ctx, 128, 1200, 0.2);
  return toTexture(c, 1);
}

function wallTexture(kind: BuildingTextureKind): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256);
  if (kind === 'apartments') {
    // светлая панелька: горизонтальные швы + панели
    ctx.fillStyle = '#d8dad6';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(90,95,95,0.45)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= 256; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
    for (let x = 0; x <= 256; x += 128) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke();
    }
    grain(ctx, 256, 1000, 0.07);
  } else if (kind === 'house') {
    // кирпич/штукатурка
    ctx.fillStyle = '#cbb79d';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(120,95,75,0.35)';
    ctx.lineWidth = 1;
    for (let y = 0; y < 256; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
      const off = (y / 14) % 2 ? 12 : 0;
      for (let x = off; x < 256; x += 24) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 14); ctx.stroke();
      }
    }
    grain(ctx, 256, 800, 0.1);
  } else if (kind === 'commercial') {
    // стекло/алюминий
    ctx.fillStyle = '#9aa8ae';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(40,55,60,0.5)';
    ctx.lineWidth = 3;
    for (let x = 0; x <= 256; x += 52) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, 0, 128, 256);
    grain(ctx, 256, 500, 0.05);
  } else {
    // промышленный бетон
    ctx.fillStyle = '#6d7473';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(35,40,40,0.4)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= 256; y += 85) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
    grain(ctx, 256, 1400, 0.16);
  }
  // общая копоть снизу
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(20,20,20,0.16)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, 3);
}

export function getTextures(): TextureLibrary {
  if (!cached) {
    cached = {
      asphalt: asphaltTexture(),
      sidewalk: sidewalkTexture(),
      roof: roofTexture(),
      walls: {
        apartments: wallTexture('apartments'),
        house: wallTexture('house'),
        commercial: wallTexture('commercial'),
        industrial: wallTexture('industrial'),
      },
    };
  }
  return cached;
}
