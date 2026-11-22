/**
 * textures.ts — процедурные CanvasTexture как мгновенный fallback и локальные
 * CC0 PBR-карты (Poly Haven), которые подгружаются асинхронно.
 * Текстурный объект один и тот же: подмена .image не требует пересоздания
 * материалов в уже построенных тайлах.
 */

import * as THREE from 'three';

export type BuildingTextureKind = 'apartments' | 'house' | 'commercial' | 'industrial';
export type PbrSurface = 'asphalt' | 'sidewalk' | 'roof' | 'ground' | 'concrete' | 'brick' | 'facade';

export interface PbrMaps {
  nor: THREE.Texture;
  rough: THREE.Texture;
}

export interface TextureLibrary {
  asphalt: THREE.CanvasTexture;
  sidewalk: THREE.CanvasTexture;
  roof: THREE.CanvasTexture;
  ground: THREE.CanvasTexture;
  walls: Record<BuildingTextureKind, THREE.CanvasTexture>;
  pbr: Record<PbrSurface, PbrMaps>;
}

let cached: TextureLibrary | null = null;
let pbrPromise: Promise<void> | null = null;

function dataTexture(bytes: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(bytes, 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function neutralPbr(repeat: number): PbrMaps {
  const nor = dataTexture(new Uint8Array([128, 128, 255, 255]), false);
  const rough = dataTexture(new Uint8Array([255, 255, 255, 255]), false);
  for (const t of [nor, rough]) t.repeat.set(repeat, repeat);
  return { nor, rough };
}

/** Мягкая радиальная alpha-маска для контактных теней. */
export function createRadialShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#c4c4c4');
  g.addColorStop(0.7, '#555555');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

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

/** Панельный фасад в стиле Алматы: окна с рамами, балконы, кондиционеры, вход. */
function drawAlmatyPanelFacade(ctx: CanvasRenderingContext2D, seed = 42) {
  const S = 512;
  const rnd = (n: number) => { const v = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453; return v - Math.floor(v); };
  ctx.fillStyle = '#d4c2a5'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 65; i++) {
    const x = rnd(i * 3) * S, y = rnd(i * 5) * S;
    const w = 15 + rnd(i * 7) * 55, h = 8 + rnd(i * 11) * 30;
    ctx.fillStyle = rnd(i * 13) > 0.5 ? 'rgba(255,245,220,0.10)' : 'rgba(75,65,55,0.08)';
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = 'rgba(86,83,74,0.35)'; ctx.lineWidth = 3;
  for (let y = 0; y <= S; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
  for (let x = 0; x <= S; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke(); }
  for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
    const x = 85 + col * 171, y = 82 + row * 92;
    ctx.fillStyle = '#59676a'; ctx.fillRect(x - 29, y - 27, 58, 58);
    ctx.fillStyle = rnd(row * 17 + col) > 0.75 ? '#b3a58c' : '#587681';
    ctx.fillRect(x - 24, y - 22, 48, 48);
    ctx.fillStyle = 'rgba(220,240,230,0.25)'; ctx.fillRect(x - 20, y - 18, 5, 40);
    ctx.fillStyle = '#9da9a4'; ctx.fillRect(x - 2, y - 22, 3, 48);
    ctx.fillStyle = '#e3d4bd'; ctx.fillRect(x - 32, y + 29, 64, 4);
    if (rnd(row * 31 + col * 7) > 0.45) {
      ctx.fillStyle = '#8b8880'; ctx.fillRect(x - 36, y + 32, 72, 7);
      ctx.strokeStyle = '#566269'; ctx.lineWidth = 3;
      ctx.strokeRect(x - 31, y + 17, 62, 18);
      ctx.beginPath(); ctx.moveTo(x, y + 17); ctx.lineTo(x, y + 35); ctx.stroke();
    }
    if (rnd(row * 43 + col * 13) > 0.7) {
      ctx.fillStyle = '#aab3ad'; ctx.fillRect(x + 34, y - 8, 23, 15);
      ctx.fillStyle = '#354348'; ctx.fillRect(x + 37, y - 5, 17, 8);
    }
  }
  ctx.fillStyle = '#49575a'; ctx.fillRect(218, 416, 78, 96);
  ctx.fillStyle = '#76939a'; ctx.fillRect(226, 424, 62, 72);
  ctx.fillStyle = '#8c806e'; ctx.fillRect(214, 407, 86, 8);
  for (let i = 0; i < 20; i++) {
    const x = rnd(i * 67) * S, y = rnd(i * 91) * S;
    ctx.fillStyle = 'rgba(67,58,48,0.14)';
    ctx.fillRect(x, y, 2 + rnd(i * 5) * 4, 12 + rnd(i * 9) * 35);
  }
  const grime = ctx.createLinearGradient(0, 300, 0, S);
  grime.addColorStop(0, 'rgba(60,50,40,0)');
  grime.addColorStop(1, 'rgba(45,42,38,0.22)');
  ctx.fillStyle = grime; ctx.fillRect(0, 0, S, S);
}

function wallTexture(kind: BuildingTextureKind): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(kind === 'apartments' ? 512 : 256);
  if (kind === 'apartments') {
    drawAlmatyPanelFacade(ctx, 42);
    drawFacadeDetails(ctx, kind);
    return toTexture(c, 1);
  }
  if (kind === 'house') {
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
  // Повтор 3 дублировал нарисованные балконы/окна и ломал масштаб деталей.
  return toTexture(c, 1);
}

function groundTexture(): THREE.CanvasTexture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = '#596052';
  ctx.fillRect(0, 0, 256, 256);
  grain(ctx, 256, 1800, 0.12);
  // Плоскость 60 км: один повтор ≈ 30 м — крупный масштаб без муара.
  return toTexture(c, 60000 / 30);
}

export function getTextures(): TextureLibrary {
  if (!cached) {
    cached = {
      asphalt: asphaltTexture(),
      sidewalk: sidewalkTexture(),
      roof: roofTexture(),
      ground: groundTexture(),
      walls: {
        apartments: wallTexture('apartments'),
        house: wallTexture('house'),
        commercial: wallTexture('commercial'),
        industrial: wallTexture('industrial'),
      },
      pbr: {
        asphalt: neutralPbr(1),
        sidewalk: neutralPbr(1),
        roof: neutralPbr(1),
        ground: neutralPbr(60000 / 30),
        concrete: neutralPbr(1),
        brick: neutralPbr(1),
        facade: neutralPbr(1),
      },
    };
  }
  return cached;
}

/**
 * Асинхронно подменяет процедурные карты реальными PBR (CC0, 512 px WebP).
 * Вызывается один раз при старте; игра продолжает работать на fallback-картах,
 * если сеть/файлы недоступны.
 */
export function loadPbrTextures(): Promise<void> {
  if (pbrPromise) return pbrPromise;
  pbrPromise = (async () => {
    const tex = getTextures();
    const base = `${import.meta.env.BASE_URL}textures/pbr/`;
    const load = async (url: string): Promise<HTMLImageElement> => {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    };
    const applyDiffuse = async (surface: PbrSurface, target: THREE.Texture) => {
      try {
        const img = await load(`${base}${surface}/diff.webp`);
        target.image = img;
        target.needsUpdate = true;
      } catch (err) {
        console.warn(`[textures] ${surface}: diff недоступен`, err);
      }
    };
    const applyMaps = async (surface: PbrSurface) => {
      const maps = tex.pbr[surface];
      try {
        const [nor, rough] = await Promise.all([
          load(`${base}${surface}/nor.webp`),
          load(`${base}${surface}/rough.webp`),
        ]);
        maps.nor.image = nor;
        maps.rough.image = rough;
        maps.nor.needsUpdate = true;
        maps.rough.needsUpdate = true;
      } catch (err) {
        console.warn(`[textures] ${surface}: PBR-карты недоступны`, err);
      }
    };
    await Promise.all([
      applyDiffuse('asphalt', tex.asphalt),
      applyDiffuse('sidewalk', tex.sidewalk),
      applyDiffuse('roof', tex.roof),
      applyDiffuse('ground', tex.ground),
      ...(['asphalt', 'sidewalk', 'roof', 'ground', 'concrete', 'brick', 'facade'] as PbrSurface[]).map(applyMaps),
    ]);
  })();
  return pbrPromise;
}
