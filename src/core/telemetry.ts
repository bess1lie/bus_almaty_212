/**
 * telemetry.ts — замер FPS/draw calls и адаптивное разрешение.
 * По исследованию: на мобильном DPR ≤ 2, цель 30+ FPS, ≤ 150 draw calls.
 */

export class Telemetry {
  private frames = 0;
  private slowFrames = 0;
  private lastReport = 0;
  private currentScale = 1;
  private readonly minScale = 0.6;
  private readonly maxScale = 1.5;
  private cooldown = 0;

  constructor(private readonly isMobile: boolean) {}

  /** Вызывать каждый кадр. Возвращает true, если нужно применить новое разрешение. */
  update(nowMs: number, frameMs: number, rendererInfo: { calls: number; triangles: number }): boolean {
    this.frames++;
    if (frameMs > 34) this.slowFrames++;
    if (this.cooldown > 0) { this.cooldown -= frameMs / 1000; return false; }

    if (nowMs - this.lastReport >= 2000) {
      const avgFps = this.frames / ((nowMs - this.lastReport) / 1000);
      const slowRatio = this.slowFrames / Math.max(1, this.frames);
      this.frames = 0;
      this.slowFrames = 0;
      this.lastReport = nowMs;

      const targetFps = this.isMobile ? 32 : 55;
      let changed = false;
      if (avgFps < targetFps && slowRatio > 0.15 && this.currentScale > this.minScale) {
        this.currentScale = Math.max(this.minScale, this.currentScale - 0.15);
        this.cooldown = 3;
        changed = true;
      } else if (avgFps > targetFps + 12 && this.currentScale < this.maxScale) {
        this.currentScale = Math.min(this.maxScale, this.currentScale + 0.1);
        this.cooldown = 5;
        changed = true;
      }
      if (changed) {
        console.info('[telemetry]', {
          fps: avgFps.toFixed(1),
          calls: rendererInfo.calls,
          tris: rendererInfo.triangles,
          scale: this.currentScale.toFixed(2),
        });
      }
      return changed;
    }
    return false;
  }

  get pixelRatioScale(): number { return this.currentScale; }
}
