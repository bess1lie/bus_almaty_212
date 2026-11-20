/**
 * rapier.ts — обёртка над @dimforge/rapier3d-compat.
 */

import RAPIER from '@dimforge/rapier3d-compat';

let world: RAPIER.World | null = null;
let eventQueue: RAPIER.EventQueue | null = null;
let initialized = false;

const initPromise = (async () => {
  await RAPIER.init();
  world = new RAPIER.World(new RAPIER.Vector3(0, -9.81, 0));
  eventQueue = new RAPIER.EventQueue(true);
  initialized = true;
})();

export async function initPhysics(): Promise<typeof RAPIER> {
  await initPromise;
  return RAPIER;
}

export function getRapier(): typeof RAPIER {
  return RAPIER;
}

export function getPhysicsWorld(): RAPIER.World {
  if (!world) throw new Error('Physics world not created.');
  return world;
}

export function getEventQueue(): RAPIER.EventQueue {
  if (!eventQueue) throw new Error('Event queue not created.');
  return eventQueue;
}

export function stepPhysics(dt: number) {
  if (!world || !eventQueue) return;
  // В Rapier 0.21 dt задаётся через timestep, а не аргументом step().
  world.timestep = dt;
  world.step(eventQueue);
}

/** Статический пол на весь регион (пока без рельефа). */
export function createStaticFloor(halfSize = 2000) {
  const RAPIER = getRapier();
  const world = getPhysicsWorld();
  const desc = RAPIER.ColliderDesc.cuboid(halfSize, 0.5, halfSize);
  desc.setTranslation(0, -0.5, 0);
  desc.setFriction(1.0);
  desc.setRestitution(0.0);
  world.createCollider(desc);
}

export const Physics = {
  init: initPhysics,
  get: getRapier,
  world: getPhysicsWorld,
  eventQueue: getEventQueue,
  step: stepPhysics,
  isReady: () => initialized,
};
