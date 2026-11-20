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

  constructor() {
    this.speed = document.querySelector('[data-field="speed"]');
    this.gear = document.querySelector('[data-field="gear"]');
    this.route = document.querySelector('[data-field="route"]');
    this.nextStop = document.querySelector('[data-field="next-stop"]');
    this.stopDistance = document.querySelector('[data-field="stop-distance"]');
    this.gameUi = document.getElementById('game-ui');
  }

  /** Убрать главное меню и показать HUD. */
  startGame() {
    this.gameUi?.classList.remove('is-menu-open');
  }

  setRoute(id: string, name: string) {
    if (this.route) this.route.textContent = id;
    if (this.nextStop) this.nextStop.textContent = name;
  }

  update(speedKmh: number, gear: string) {
    if (this.speed) this.speed.textContent = Math.round(speedKmh).toString();
    if (this.gear) this.gear.textContent = gear;
  }
}
