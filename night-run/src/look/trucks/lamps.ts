/** Where each truck's lamps sit, and how hard it's braking. */

/**
 * One truck's lamps in its lamp frame: world units from the body node's origin, +x to the truck's left, +z forward.
 * Positions are the left lamp's lens centre; the right lamp mirrors it in x.
 */
export interface LampLayout {
  readonly head: readonly [number, number, number];
  /** Half width and half height of the headlamp lens. */
  readonly headSize: readonly [number, number];
  /** Whether the headlamp is a round roundel rather than a panel. */
  readonly headRound: boolean;
  readonly tail: readonly [number, number, number];
  readonly tailSize: readonly [number, number];
}

/** Round lamps on the grille, square tail lamps: the yellow and purple trucks. */
const GRILLE_LAMPS: LampLayout = {
  head: [0.2, 0.15, 0.704],
  headSize: [0.056, 0.056],
  headRound: true,
  tail: [0.2, 0.2, -0.654],
  tailSize: [0.05, 0.05],
};

/** Read off each Kenney truck's body mesh, in `TRUCK_COLORS` order. */
export const LAMP_LAYOUTS: readonly LampLayout[] = [
  GRILLE_LAMPS,
  // Green: round lamps on the bull bar, ahead of the grille.
  {
    head: [0.15, 0.1, 0.754],
    headSize: [0.056, 0.056],
    headRound: true,
    tail: [0.2, 0.2, -0.654],
    tailSize: [0.05, 0.05],
  },
  GRILLE_LAMPS,
  // Red: white panels either side of the grille; small tail lamps low on the tailgate.
  {
    head: [0.225, 0.15, 0.654],
    headSize: [0.075, 0.05],
    headRound: false,
    tail: [0.225, 0.125, -0.654],
    tailSize: [0.045, 0.035],
  },
];

/** Deceleration, world units per second squared, at which the brake lamps are fully on. */
const BRAKE_FULL = 7;
/** Deceleration below which the brake lamps stay off; lifting off the throttle isn't braking. */
const BRAKE_START = 1.5;

/**
 * How hard a truck brakes, from how fast its speed falls.
 * @param before - Ground speed a moment earlier.
 * @param now - Ground speed now.
 * @param dt - Seconds between the two.
 * @returns 0 to 1.
 */
export function brakeAmount(before: number, now: number, dt: number): number {
  const decel = (before - now) / dt;

  return Math.min(1, Math.max(0, (decel - BRAKE_START) / (BRAKE_FULL - BRAKE_START)));
}
