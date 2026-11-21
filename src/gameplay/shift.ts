/**
 * shift.ts — смена водителя: расписание рейса, опоздание, итоги.
 *
 * Цель: у каждой поездки появляется смысл — выполнить рейс по графику,
 * получить оценку и награду. Прогресс сохраняется в localStorage.
 */

export interface ShiftResult {
  routeId: string;
  score: number;
  grade: string;
  stopsServed: number;
  onTime: boolean;
  delaySec: number;
  reward: number;
  totalDistanceM: number;
  drivingScore: number;
}

export interface ShiftState {
  active: boolean;
  routeId: string;
  elapsedSec: number;
  plannedSec: number;
  delaySec: number;
  stopsServed: number;
  plannedStops: number;
  distanceM: number;
  score: number;
}

const STORAGE_KEY = 'bus212.shift.progress.v1';

interface SavedProgress {
  totalReward: number;
  shiftsDone: number;
  bestScore: number;
  medals: string[];
}

function loadProgress(): SavedProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { totalReward: 0, shiftsDone: 0, bestScore: 0, medals: [], ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { totalReward: 0, shiftsDone: 0, bestScore: 0, medals: [] };
}

export class ShiftManager {
  private active = false;
  private routeId = '';
  private startTime = 0;
  private plannedSec = 0;
  private stopsServed = 0;
  private plannedStops = 0;
  private distanceM = 0;
  private score = 100;
  private smoothSum = 0;
  private smoothSamples = 0;
  private progress = loadProgress();

  get state(): ShiftState {
    const elapsed = this.active ? (performance.now() - this.startTime) / 1000 : 0;
    return {
      active: this.active,
      routeId: this.routeId,
      elapsedSec: elapsed,
      plannedSec: this.plannedSec,
      delaySec: Math.max(0, elapsed - this.plannedSec),
      stopsServed: this.stopsServed,
      plannedStops: this.plannedStops,
      distanceM: this.distanceM,
      score: Math.round(this.score),
    };
  }

  get saved(): SavedProgress { return this.progress; }

  /** Начать смену. plannedStops — число остановок в выбранном направлении. */
  start(routeId: string, stops: number, distanceM: number) {
    this.active = true;
    this.routeId = routeId;
    this.startTime = performance.now();
    this.plannedStops = Math.max(1, stops);
    this.plannedSec = Math.round(distanceM / 7.5); // ~7.5 м/с средняя по городу
    this.stopsServed = 0;
    this.distanceM = 0;
    this.score = 100;
    this.smoothSum = 0;
    this.smoothSamples = 0;
  }

  /** Вызывать каждый кадр. */
  tick(deltaM: number, jerk: number) {
    if (!this.active) return;
    this.distanceM += Math.max(0, deltaM);
    this.smoothSum += Math.max(0, 1 - jerk * 10);
    this.smoothSamples++;
  }

  onStopServed() {
    if (!this.active) return;
    this.stopsServed++;
    this.score = Math.min(100, this.score + 1);
  }

  onViolation(points: number) {
    if (!this.active) return;
    this.score = Math.max(0, this.score - points);
  }

  /** Завершить смену — вернуть итоги и сохранить прогресс. */
  finish(): ShiftResult | null {
    if (!this.active) return null;
    this.active = false;

    const elapsed = (performance.now() - this.startTime) / 1000;
    const delay = Math.max(0, elapsed - this.plannedSec);
    const drivingScore = this.smoothSamples > 0
      ? Math.round((this.smoothSum / this.smoothSamples) * 100)
      : 80;
    const punctuality = Math.max(0, 30 - Math.round(delay / 10));
    const stopPoints = Math.round((this.stopsServed / this.plannedStops) * 25);
    const safety = Math.min(20, Math.round(this.score / 5));
    const total = Math.max(0, Math.min(100,
      Math.round(punctuality + drivingScore * 0.25 + stopPoints + safety)
    ));

    const grade = total >= 90 ? 'Отлично' : total >= 75 ? 'Хорошо' : total >= 55 ? 'Удовлетворительно' : 'Плохо';
    const onTime = delay < 60;
    const reward = Math.round(total * 2.4 + this.stopsServed * 5);
    const medals: string[] = [];
    if (onTime) medals.push('Пунктуальный водитель');
    if (drivingScore >= 90) medals.push('Аккуратный водитель');
    if (this.stopsServed === this.plannedStops) medals.push('Все остановки');

    this.progress.totalReward += reward;
    this.progress.shiftsDone++;
    this.progress.bestScore = Math.max(this.progress.bestScore, total);
    for (const m of medals) if (!this.progress.medals.includes(m)) this.progress.medals.push(m);
    this.save();

    return {
      routeId: this.routeId, score: total, grade, stopsServed: this.stopsServed,
      onTime, delaySec: Math.round(delay), reward,
      totalDistanceM: Math.round(this.distanceM), drivingScore,
    };
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.progress)); } catch { /* ignore */ }
  }
}
