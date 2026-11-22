/**
 * passengers.ts — пассажиры и обслуживание остановки.
 *
 * Игровой цикл остановки:
 *  1) автобус в зоне остановки и скорость < 2 км/ч
 *  2) ручник включён
 *  3) двери открыты → идёт посадка/высадка (2–4 сек)
 *  4) двери закрыты → можно ехать
 *
 * Счётчик пассажиров, ожидающие на остановке, оценка точности.
 */

export interface StopServiceState {
  atStop: boolean;
  speedOk: boolean;
  handbrakeOk: boolean;
  doorsOpen: boolean;
  serving: boolean;
  progress: number;     // 0..1
  onboard: number;
  waiting: number;
  capacity: number;
  stopsServed: number;
  score: number;
  lastMessage: string;
}

const CAPACITY = 45;

export class PassengerService {
  private onboard = 0;
  private waiting = 2 + Math.floor(Math.random() * 6); // 2..7 на остановке
  private stopsServed = 0;
  private score = 100;
  private serving = false;
  private serveTimer = 0;
  private doorsWereOpen = false;
  private message = '';

  get state(): StopServiceState {
    return {
      atStop: false, // задаётся снаружи
      speedOk: true,
      handbrakeOk: true,
      doorsOpen: this.doorsWereOpen,
      serving: this.serving,
      progress: this.serveTimer / this.serveDuration,
      onboard: this.onboard,
      waiting: this.waiting,
      capacity: CAPACITY,
      stopsServed: this.stopsServed,
      score: Math.round(this.score),
      lastMessage: this.message,
    };
  }

  private serveDuration = 3.0;

  /** Вызывать каждый кадр. Возвращает true, если остановка обслужена в этом кадре. */
  update(
    dt: number,
    atStop: boolean,
    speedKmh: number,
    handbrake: boolean,
    doorsOpen: boolean,
    nearStopName: string,
  ): boolean {
    // Двери можно открыть только на остановке и почти на месте
    const canOpen = atStop && speedKmh < 2 && handbrake;
    let justServed = false;

    if (doorsOpen && !canOpen) {
      this.message = 'Откройте двери только на остановке при полной остановке и ручнике';
    }

    if (doorsOpen && canOpen) {
      if (!this.doorsWereOpen) {
        this.serving = true;
        this.serveTimer = 0;
        this.serveDuration = 2.2 + Math.min(2, this.waiting * 0.25);
        this.message = `Посадка: ${nearStopName}`;
      }
      this.serveTimer += dt;
      if (this.serveTimer >= this.serveDuration && this.serving) {
        this.serving = false;
        this.stopsServed++;
        const board = Math.min(this.waiting, CAPACITY - this.onboard);
        this.onboard += board;
        this.waiting = 1 + Math.floor(Math.random() * 5);
        // точность остановки: бонус за ручник и скорость
        this.score = Math.min(100, this.score + 2);
        this.message = `Посадка завершена: +${board} пасс. В салоне ${this.onboard}`;
        justServed = true;
      }
    } else if (!doorsOpen && this.doorsWereOpen && this.serving) {
      // закрыли двери раньше времени
      this.serving = false;
      this.message = 'Двери закрыты до конца посадки';
      this.score = Math.max(0, this.score - 3);
    }

    // штраф за резкую езду проверяется снаружи через applyPenalty
    this.doorsWereOpen = doorsOpen;
    return justServed;
  }

  applyPenalty(points: number, reason: string) {
    this.score = Math.max(0, this.score - points);
    this.message = reason;
  }

  /** Высадка на конечной */
  finishRoute(): { passengers: number; score: number } {
    const result = { passengers: this.onboard, score: Math.round(this.score) };
    this.onboard = 0;
    return result;
  }
}
