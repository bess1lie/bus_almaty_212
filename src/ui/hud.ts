/**
 * hud.ts — обновляет поля UI Kit (data-field) и обрабатывает кнопки меню.
 */

export class HUD {
  private speed: HTMLElement | null;
  private gear: HTMLElement | null;
  private route: HTMLElement | null;
  private nextStop: HTMLElement | null;
  private stopDistance: HTMLElement | null;
  private gameUi: HTMLElement | null;
  private tripPanel: HTMLElement | null;

  constructor() {
    this.speed = document.querySelector('[data-field="speed"]');
    this.gear = document.querySelector('[data-field="gear"]');
    this.route = document.querySelector('[data-field="route"]');
    this.nextStop = document.querySelector('[data-field="next-stop"]');
    this.stopDistance = document.querySelector('[data-field="stop-distance"]');
    this.gameUi = document.getElementById('game-ui');
    this.tripPanel = document.getElementById('trip-panel');
  }

  /** Панель рейса: пассажиры, оценка, статус, подсказка. */
  updateTrip(o: {
    onboard: number; capacity: number; score: number;
    stops: number; message: string; doors: boolean; serving: boolean; progress: number;
  }) {
    if (!this.tripPanel) return;
    const doorsText = o.serving
      ? `ПОСАДКА ${Math.round(o.progress * 100)}%`
      : o.doors ? 'ДВЕРИ ОТКРЫТЫ' : 'ДВЕРИ ЗАКРЫТЫ';
    this.tripPanel.innerHTML = `
      <div class="trip-row"><span>ПАССАЖИРЫ</span><strong>${o.onboard} / ${o.capacity}</strong></div>
      <div class="trip-row"><span>ОСТАНОВОК</span><strong>${o.stops}</strong></div>
      <div class="trip-row"><span>ОЦЕНКА</span><strong>${o.score}</strong></div>
      <div class="trip-row ${o.serving ? 'trip-serving' : ''}"><span>СТАТУС</span><strong>${doorsText}</strong></div>
      <div class="trip-msg">${o.message || ''}</div>
    `;
  }

  /** Убрать главное меню и показать HUD. */
  startGame() {
    this.gameUi?.classList.remove('is-menu-open');
  }

  setRoute(id: string, name: string, distance?: number) {
    if (this.route) this.route.textContent = id;
    if (this.nextStop) this.nextStop.textContent = name;
    if (distance !== undefined && this.stopDistance) {
      this.stopDistance.textContent = `${distance} м`;
    }
  }

  update(speedKmh: number, gear: string) {
    if (this.speed) this.speed.textContent = Math.round(speedKmh).toString();
    if (this.gear) this.gear.textContent = gear;
  }
}
