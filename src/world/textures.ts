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

/** Повторный выводFIGURE с учётом краёв тайла (чтобы заплаты не обрывались на шве). */
function drawWrapped(ctx: CanvasRenderingContext2D, size: number, x: number, y: number, radius: number, draw: () => void) {
  const ox = x < radius ? [-size, 0] : x + radius > size ? [0, size] : [0];
  const oy = y < radius ? [-size, 0] : y + radius > size ? [0, size] : [0];
  for (const dx of ox) for (const dy of oy) {
    ctx.save(); ctx.translate(dx, dy);
    ctx.save(); ctx.translate(x, y); draw(); ctx.restore();
    ctx.restore();
  }
}

function drawAsphaltWear(ctx: CanvasRenderingContext2D, size = 256) {
  // заплаты
  for (let i = 0; i < 12; i++) {
    const x = (i * 83 + 31) % size, y = (i * 57 + 21) % size;
    const w = 14 + (i % 4) * 8, h = 8 + (i % 3) * 5;
    drawWrapped(ctx, size, x, y, Math.max(w, h), () => {
      ctx.fillStyle = 'rgba(18,21,23,0.14)';
      ctx.beginPath(); ctx.ellipse(0, 0, w, h, i * 0.27, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(125,125,118,0.10)'; ctx.lineWidth = 2; ctx.stroke();
    });
  }
  // следы шин
  for (const y of [80, 93, 192, 205]) {
    drawWrapped(ctx, size, 128, y, 140, () => {
      ctx.strokeStyle = 'rgba(12,14,16,0.11)'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(-150, -y + 128); ctx.lineTo(150, -y + 128); ctx.stroke();
    });
  }
  // люки
  for (const [x, y] of [[55, 145], [192, 48], [210, 225]]) {
    drawWrapped(ctx, size, x, y, 13, () => {
      ctx.fillStyle = '#303438'; ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(150,155,150,0.4)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
      for (let i = -5; i <= 5; i += 5) { ctx.beginPath(); ctx.moveTo(-5, i); ctx.lineTo(5, i); ctx.stroke(); }
    });
  }
  // масляные пятна
  for (let i = 0; i < 16; i++) {
    const x = (i * 47 + 17) % size, y = (i * 91 + 39) % size;
    ctx.fillStyle = 'rgba(15,18,20,0.08)';
    ctx.beginPath(); ctx.ellipse(x, y, 6 + i % 5, 3 + i % 3, 0.4, 0, Math.PI * 2); ctx.fill();
  }
}

function asphaltTexture(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = '#43484b';
  ctx.fillRect(0, 0, 256, 256);
  // крупные пятна
  for (let i = 0; i < 40; i++) {
    const r = 8 + Math.random() * 40;
    ctx.fillStyle = `rgba(30,32,34,${0.05 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, r, 0, Math.PI * 2);
    ctx.fill();
  }
  drawAsphaltWear(ctx, 256);
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

function drawFacadeDetails(ctx: CanvasRenderingContext2D, kind: BuildingTextureKind) {
  if (kind === 'apartments') {
    // балконы: тень плиты + перила
    for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
      const x = 25 + col * 82, y = 47 + row * 55;
      ctx.fillStyle = 'rgba(65,68,66,0.22)'; ctx.fillRect(x - 5, y + 13, 44, 5);
      ctx.strokeStyle = 'rgba(56,65,65,0.6)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 3, y + 4); ctx.lineTo(x + 39, y + 4); ctx.lineTo(x + 39, y + 14);
      ctx.moveTo(x - 3, y + 4); ctx.lineTo(x - 3, y + 14);
      ctx.moveTo(x + 11, y + 4); ctx.lineTo(x + 11, y + 14);
      ctx.moveTo(x + 25, y + 4); ctx.lineTo(x + 25, y + 14);
      ctx.stroke();
    }
    // кондиционеры
    for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
      if ((row * 7 + col * 3) % 4 !== 0) continue;
      const x = 54 + col * 82, y = 43 + row * 55;
      ctx.fillStyle = '#9da5a4'; ctx.fillRect(x, y, 14, 9);
      ctx.fillStyle = 'rgba(30,36,38,0.5)'; ctx.fillRect(x + 2, y + 2, 10, 5);
    }
  }
  if (kind === 'commercial') {
    // козырьки входов
    for (let col = 0; col < 3; col++) {
      const x = 15 + col * 88;
      ctx.fillStyle = '#536e76'; ctx.fillRect(x, 200, 68, 13);
      ctx.fillStyle = 'rgba(20,25,28,0.3)'; ctx.fillRect(x, 213, 68, 4);
      ctx.fillStyle = '#303b40'; ctx.fillRect(x + 22, 218, 25, 38);
      ctx.strokeStyle = 'rgba(230,225,210,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(x + 22, 218, 25, 38);
    }
  }
  if (kind === 'industrial') {
    // ворота склада
    for (let col = 0; col < 2; col++) {
      const x = 30 + col * 128;
      ctx.fillStyle = '#454c4d'; ctx.fillRect(x, 145, 88, 105);
      ctx.strokeStyle = 'rgba(180,185,180,0.4)'; ctx.lineWidth = 2;
      for (let y = 160; y < 245; y += 13) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 88, y); ctx.stroke();
      }
    }
  }
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
  drawFacadeDetails(ctx, kind);

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
