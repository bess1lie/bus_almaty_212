/**
 * input.ts — обработка ввода: клавиатура, геймпад, мобильные кнопки (HUD).
 *
 * Модель: клавиатура и геймпад независимы, приоритет у клавиатуры,
 * если она активна. Одноразовые флаги (двери/камера/сигнал) живут
 * до следующего clearFrameFlags().
 */

export type InputState = {
  throttle: number;   // -1 .. 1
  brake: number;      // 0 .. 1
  steering: number;   // -1 .. 1
  handbrake: boolean;
  doors: boolean;
  camera: boolean;
  horn: boolean;
  reset: boolean;
  timeOfDay: boolean;
};

// --- Клавиатура ---
const kbd = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
  doors: false,
  camera: false,
  horn: false,
  reset: false,
  timeOfDay: false,
};

// --- Геймпад (только оси и кнопки, без импульсов) ---
const pad = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};

function onKeyDown(e: KeyboardEvent) {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      kbd.throttle = 1;
      break;
    case 'KeyS':
    case 'ArrowDown':
      kbd.brake = 1;
      break;
    case 'KeyQ':
      kbd.throttle = -1;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      kbd.steering = -1;
      break;
    case 'KeyD':
    case 'ArrowRight':
      kbd.steering = 1;
      break;
    case 'Space':
      kbd.handbrake = true;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      kbd.brake = 1;
      break;
    case 'KeyF':
      kbd.doors = true;
      break;
    case 'KeyC':
      kbd.camera = true;
      break;
    case 'KeyH':
      kbd.horn = true;
      break;
    case 'KeyR':
      kbd.reset = true;
      break;
    case 'KeyN':
      kbd.timeOfDay = true;
      break;
  }
}

function onKeyUp(e: KeyboardEvent) {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      if (kbd.throttle > 0) kbd.throttle = 0;
      break;
    case 'KeyS':
    case 'ArrowDown':
      kbd.brake = 0;
      break;
    case 'KeyQ':
      if (kbd.throttle < 0) kbd.throttle = 0;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      if (kbd.steering < 0) kbd.steering = 0;
      break;
    case 'KeyD':
    case 'ArrowRight':
      if (kbd.steering > 0) kbd.steering = 0;
      break;
    case 'Space':
      kbd.handbrake = false;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      kbd.brake = 0;
      break;
  }
}

function pollGamepad() {
  const gp = navigator.getGamepads()[0];
  if (!gp) return;

  const stick = gp.axes[0] ?? 0;
  pad.steering = Math.abs(stick) > 0.15 ? stick : 0;

  // Триггеры Xbox: axis 5 — R2 (газ), axis 2 — L2 (тормоз). Значения от -1 до 1.
  const gasRaw = gp.axes[5] ?? -1;
  // Стандартный mapping: LT = axes[4]; нестандартные рули — axes[2].
  const brakeRaw = gp.mapping === 'standard'
    ? (gp.axes[4] ?? -1)
    : (gp.axes[2] ?? -1);
  pad.throttle = gasRaw > -0.8 ? Math.max(0, (gasRaw + 1) / 2) : 0;
  pad.brake = brakeRaw > -0.8 ? Math.max(0, (brakeRaw + 1) / 2) : 0;

  pad.handbrake = !!gp.buttons[6]?.pressed; // LB
}

function pollMobileButtons() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__mobile_doors) {
    kbd.doors = true;
    w.__mobile_doors = false;
  }
  if (w.__mobile_camera) {
    kbd.camera = true;
    w.__mobile_camera = false;
  }
  if (w.__mobile_horn) {
    kbd.horn = true;
    w.__mobile_horn = false;
  }
  if (w.__mobile_reset) {
    kbd.reset = true;
    w.__mobile_reset = false;
  }
  // Ручник с мобильной кнопки (флаг появляется только после первого тапа).
  if ('__mobile_handbrake' in w) {
    kbd.handbrake = !!w.__mobile_handbrake;
  }
}

export function getInput(): Readonly<InputState> {
  pollGamepad();
  pollMobileButtons();

  // Приоритет: клавиатура > геймпад
  const throttle = kbd.throttle !== 0 ? kbd.throttle : pad.throttle;
  const steering = kbd.steering !== 0 ? kbd.steering : pad.steering;
  const brake = Math.max(pad.brake, kbd.brake);
  const handbrake = kbd.handbrake || pad.handbrake;

  return {
    throttle,
    brake,
    steering,
    handbrake,
    doors: kbd.doors,
    camera: kbd.camera,
    horn: kbd.horn,
    reset: kbd.reset,
    timeOfDay: kbd.timeOfDay,
  };
}

/** Сбрасывает одноразовые флаги после обработки кадра. */
export function clearFrameFlags() {
  kbd.doors = false;
  kbd.camera = false;
  kbd.horn = false;
  kbd.reset = false;
  kbd.timeOfDay = false;
}

export function initInput() {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    kbd.throttle = 0;
    kbd.brake = 0;
    kbd.steering = 0;
    kbd.handbrake = false;
    kbd.doors = false;
    kbd.camera = false;
    kbd.horn = false;
    kbd.timeOfDay = false;
  });
}
