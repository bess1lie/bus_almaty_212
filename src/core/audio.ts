/**
 * audio.ts — WebAudio: синтез двигателя автобуса, сигнала, дверей, дождя.
 * Без внешних файлов: всё генерируется в браузере.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

// Двигатель
let engineOsc1: OscillatorNode | null = null;
let engineOsc2: OscillatorNode | null = null;
let engineNoise: AudioBufferSourceNode | null = null;
let engineFilter: BiquadFilterNode | null = null;
let engineGain: GainNode | null = null;

// Эмбиент
let rainGain: GainNode | null = null;

function noiseBuffer(context: AudioContext, seconds = 2): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export async function initAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  // --- Двигатель: два осциллятора + шум через фильтр ---
  engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.frequency.value = 400;
  engineFilter.Q.value = 1.2;
  engineFilter.connect(engineGain);
  engineGain.connect(master);

  engineOsc1 = ctx.createOscillator();
  engineOsc1.type = 'sawtooth';
  engineOsc1.frequency.value = 40;
  const g1 = ctx.createGain();
  g1.gain.value = 0.5;
  engineOsc1.connect(g1);
  g1.connect(engineFilter);
  engineOsc1.start();

  engineOsc2 = ctx.createOscillator();
  engineOsc2.type = 'square';
  engineOsc2.frequency.value = 20;
  const g2 = ctx.createGain();
  g2.gain.value = 0.18;
  engineOsc2.connect(g2);
  g2.connect(engineFilter);
  engineOsc2.start();

  engineNoise = ctx.createBufferSource();
  engineNoise.buffer = noiseBuffer(ctx, 2);
  engineNoise.loop = true;
  const ng = ctx.createGain();
  ng.gain.value = 0.08;
  engineNoise.connect(ng);
  ng.connect(engineFilter);
  engineNoise.start();

  // --- Дождь (по умолчанию выключен) ---
  const rain = ctx.createBufferSource();
  rain.buffer = noiseBuffer(ctx, 3);
  rain.loop = true;
  const rainFilter = ctx.createBiquadFilter();
  rainFilter.type = 'bandpass';
  rainFilter.frequency.value = 1200;
  rainFilter.Q.value = 0.6;
  rainGain = ctx.createGain();
  rainGain.gain.value = 0;
  rain.connect(rainFilter);
  rainFilter.connect(rainGain);
  rainGain.connect(master);
  rain.start();

  // НЕ ждём resume: браузер разблокирует звук после первого клика пользователя.
  // Ожидание здесь заблокировало бы всю загрузку игры.
  void ctx.resume().catch(() => {});
}

/** Обновить звук двигателя: rpm 0..1, нагрузка 0..1. */
export function updateEngine(rpm: number, load: number) {
  if (!ctx || !engineOsc1 || !engineOsc2 || !engineFilter || !engineGain) return;
  const t = ctx.currentTime;
  const base = 38 + rpm * 110;
  engineOsc1.frequency.setTargetAtTime(base, t, 0.08);
  engineOsc2.frequency.setTargetAtTime(base * 0.5, t, 0.08);
  engineFilter.frequency.setTargetAtTime(300 + rpm * 1400 + load * 400, t, 0.1);
  engineGain.gain.setTargetAtTime(0.06 + rpm * 0.12 + load * 0.04, t, 0.1);
}

/** Короткий звук: клаксон. */
export function playHorn() {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 320;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 500;
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 0.02);
  gain.gain.setValueAtTime(0.4, ctx.currentTime + 0.3);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
  osc.start();
  osc.stop(ctx.currentTime + 0.5);
}

/** Шипение дверей. */
export function playDoors(open: boolean) {
  if (!ctx || !master) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.6);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = open ? 1800 : 1200;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  src.start();
  src.stop(ctx.currentTime + 0.6);
}

/** Включить/выключить дождь. */
export function setRain(enabled: boolean) {
  if (!ctx || !rainGain) return;
  rainGain.gain.setTargetAtTime(enabled ? 0.12 : 0, ctx.currentTime, 0.5);
}

export function muteAudio(muted: boolean) {
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(muted ? 0 : 0.35, ctx.currentTime, 0.1);
}
