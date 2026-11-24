import { angleDelta } from './race/truck';
import type { Vehicle } from './Vehicle';
import { MAX_SPEED } from './Vehicle';

/**
 * Seconds of held slide that charge the ultra boost. Taking a corner slides the truck for half a second to a second;
 * holding the slide through a corner and out along the straight after it reaches this.
 */
export const CHARGE_SECONDS = 1.8;
/** Seconds the ultra boost lasts. */
export const ULTRA_SECONDS = 1.35;
/** The charge's stage on a truck's pose once the ultra is ready: 0 is none, 1 and 2 are building. */
export const CHARGE_READY = 3;
/** Spark colour per charge stage: blue as it builds, hotter past half way, purple when the ultra is ready. */
export const CHARGE_COLORS = [0xffffff, 0x4fc3ff, 0x9fe6ff, 0xe070ff];

/** A slide: the truck turned at least this far, in radians, from the way it's going. */
const SLIP = (15 * Math.PI) / 180;
/** Ground speed a slide needs, world units per second. */
const SLIDE_SPEED = 5;
/** Share of top speed the truck keeps driving at: on the power or just lifting, not braking. */
const POWER = 0.45;
/** Steering held into or against the slide. */
const STEER = 0.2;
/** Seconds a slide can break before it ends, so a wobble or the flick between two bends doesn't end it. */
const GRACE = 0.25;

/**
 * The drift boost: hold a slide on the power for {@link CHARGE_SECONDS} to charge the ultra boost, then straighten up
 * to fire it. A slide that ends sooner charges nothing. It reads the truck's slide from how far its body faces away
 * from the way it's travelling, so weaving down a straight never charges it.
 */
export class DriftBoost {
  /** How far the charge has built, 0 to 1; 1 once the ultra is ready. */
  public charge = 0;

  private _held = 0;
  private _grace = 0;

  /** Whether the ultra is ready to fire as the slide ends. */
  public get ready(): boolean {
    return this.charge >= 1;
  }

  /** The charge as a truck's pose carries it: 0 none, 1 and 2 building, {@link CHARGE_READY} ready. */
  public get stage(): number {
    if (this.charge <= 0) return 0;

    return this.charge >= 1 ? CHARGE_READY : this.charge < 0.5 ? 1 : 2;
  }

  /**
   * Advance the charge.
   * @param dt - Game seconds since the last update.
   * @param vehicle - The truck.
   * @returns Whether the ultra fired this frame.
   */
  public update(dt: number, vehicle: Vehicle): boolean {
    const v = vehicle.sphereVel;
    const ground = Math.hypot(v.x, v.z);
    const sliding =
      ground > SLIDE_SPEED &&
      vehicle.linearSpeed > MAX_SPEED * POWER &&
      Math.abs(vehicle.inputX) > STEER &&
      Math.abs(angleDelta(vehicle.yaw, Math.atan2(v.x, v.z))) > SLIP;

    if (sliding) {
      this._held += dt;
      this._grace = GRACE;
      this.charge = Math.min(1, this._held / CHARGE_SECONDS);

      return false;
    }

    if (this._held === 0) return false;

    this._grace -= dt;
    if (this._grace > 0) return false;

    const fired = this.ready;

    this.reset();

    return fired;
  }

  /** Drop any charge, as after a respawn or at the start of a race. */
  public reset(): void {
    this._held = 0;
    this._grace = 0;
    this.charge = 0;
  }
}
