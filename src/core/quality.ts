/**
 * quality.ts — пресеты графики и динамическое разрешение.
 * Цель: играбельно на обычном ПК и телефоне.
 */

export type QualityPreset = 'low' | 'medium' | 'high';

export interface QualitySettings {
  preset: QualityPreset;
  pixelRatio: number;      // множитель к devicePixelRatio
  shadows: boolean;
  shadowSize: number;
  fog: boolean;
  maxTiles: number;
  mirrorResolution: number;
}

const PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    preset: 'low',
    pixelRatio: 0.7,
    shadows: false,
    shadowSize: 512,
    fog: true,
    maxTiles: 9,
    mirrorResolution: 0,
  },
  medium: {
    preset: 'medium',
    pixelRatio: 1.0,
    shadows: true,
    shadowSize: 1024,
    fog: true,
    maxTiles: 25,
    mirrorResolution: 128,
  },
  high: {
    preset: 'high',
    pixelRatio: 1.5,
    shadows: true,
    shadowSize: 2048,
    fog: true,
    maxTiles: 25,
    mirrorResolution: 256,
  },
};

/** Авто-выбор пресета по "силе" устройства. */
export function detectQuality(): QualitySettings {
  const mobile = 'ontouchstart' in window || /Android|iPhone|iPad/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

  let preset: QualityPreset;
  if (mobile) {
    preset = cores >= 8 && memory >= 6 ? 'medium' : 'low';
  } else {
    preset = cores >= 8 && memory >= 8 ? 'high' : 'medium';
  }

  return { ...PRESETS[preset] };
}

/** Динамическое разрешение: снижает pixelRatio при низком FPS. */
export class DynamicResolution {
  private current: number;
  private readonly min: number;
  private readonly max: number;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;

  constructor(initial: number, min = 0.6, max = 1.5) {
    this.current = initial;
    this.min = min;
    this.max = max;
  }

  get value() { return this.current; }

  update(dt: number) {
    if (this.cooldown > 0) { this.cooldown -= dt; return; }
    const ms = dt * 1000;
    if (ms > 26) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (ms < 17) {
      this.fastFrames++;
      this.slowFrames = 0;
    }

    if (this.slowFrames >= 30 && this.current > this.min) {
      this.current = Math.max(this.min, this.current - 0.1);
      this.slowFrames = 0;
      this.cooldown = 2;
    } else if (this.fastFrames >= 120 && this.current < this.max) {
      this.current = Math.min(this.max, this.current + 0.05);
      this.fastFrames = 0;
      this.cooldown = 3;
    }
  }
}
