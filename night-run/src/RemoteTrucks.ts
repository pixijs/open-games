import type { Ticker } from 'pixi.js';

import { MAX_RACERS } from './net/messages';
import type { Session } from './net/session';
import type { Race } from './Race';
import { createTruckPose } from './race/truck';

/**
 * A remote truck's drawn path absorbs a jump this sudden (a change of speed over one frame, in m/s²) and eases it out
 * over {@link CORRECTION_SECONDS}: what a late pose does when the truck had run on past its newest one. Bumps and
 * slides change speed far more gently. A jump of more than {@link CORRECTION_MAX} metres is a respawn and stays a jump.
 */
const CORRECTION_ACCEL = 300;
const CORRECTION_SECONDS = 0.08;
const CORRECTION_MAX = 2;
/** Fields of one remote truck's row in `RemoteTrucks._rows`. */
const LAST_X = 0;
const LAST_Z = 1;
const VELOCITY_X = 2;
const VELOCITY_Z = 3;
const OFFSET_X = 4;
const OFFSET_Z = 5;
/** The race the row belongs to; a row from another race starts afresh. */
const SEEN = 6;
const FIELDS = 7;

const _sample = createTruckPose();

/**
 * Poses the trucks driven on other screens each frame: where the session says each was, a little in the past, with any
 * sudden jump in its path eased out so a late update never shows as a hitch.
 */
export class RemoteTrucks {
  private readonly _race: Race;
  private readonly _ticker: Ticker;
  /** Each slot's remote truck: its last sampled position and velocity, and the correction still being eased out. */
  private readonly _rows = new Float64Array(MAX_RACERS * FIELDS);

  /**
   * @param race - The race whose remote trucks it poses.
   * @param ticker - The app's ticker, whose frame times the trucks move by.
   */
  constructor(race: Race, ticker: Ticker) {
    this._race = race;
    this._ticker = ticker;
  }

  /**
   * Pose every remote truck for this frame. Call before the race updates.
   * @param session - The session the poses come from.
   * @param raceId - The room's race counter; a truck's smoothing starts afresh in a new race.
   */
  public update(session: Session, raceId: number): void {
    const racers = this._race.racers;
    // The room time of this frame's vsync, so remote trucks advance by exactly the time the display does. The ticker
    // moves `lastTime` on only after its listeners run, so this frame's is the last one plus the time since.
    const ticker = this._ticker;
    const now = session.serverNow() - (performance.now() - (ticker.lastTime + ticker.elapsedMS));

    for (let i = 0; i < racers.length; i++) {
      const truck = racers[i];

      if (truck.kind !== 'remote' || truck.held || !session.sample(truck.id, _sample, now)) continue;

      const last = truck.pose;
      const dx = _sample.x - last.x;
      const dz = _sample.z - last.z;
      const reversing = _sample.speed < 0;

      // The direction of travel, which differs from the body's in a drift.
      _sample.heading = dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : _sample.yaw;
      _sample.speed = Math.abs(_sample.speed);
      _sample.throttle = reversing ? -1 : _sample.speed > 0.3 ? 1 : 0;
      this._smooth(truck.slot, ticker.elapsedMS / 1000, raceId);
      this._race.setRemotePose(truck.id, _sample);
    }
  }

  /**
   * Eases out a sudden jump in a remote truck's sampled path: the jump goes into an offset the drawn truck carries,
   * which shrinks to nothing over {@link CORRECTION_SECONDS}.
   */
  private _smooth(slot: number, dt: number, raceId: number): void {
    const r = this._rows;
    const at = slot * FIELDS;

    if (!(dt > 0)) return;

    const vx = (_sample.x - r[at + LAST_X]) / dt;
    const vz = (_sample.z - r[at + LAST_Z]) / dt;
    // The jump in speed this frame, as the distance it puts the truck off its last speed's line.
    const jumpX = (vx - r[at + VELOCITY_X]) * dt;
    const jumpZ = (vz - r[at + VELOCITY_Z]) * dt;
    const jump = Math.hypot(jumpX, jumpZ);
    const snapped = r[at + SEEN] !== raceId || jump >= CORRECTION_MAX;

    if (snapped) {
      r[at + OFFSET_X] = 0;
      r[at + OFFSET_Z] = 0;
    } else if (jump > CORRECTION_ACCEL * dt * dt) {
      // Keep the truck going at its last speed for now; the offset eases it onto the sampled path.
      r[at + OFFSET_X] -= jumpX;
      r[at + OFFSET_Z] -= jumpZ;
    }

    r[at + SEEN] = raceId;
    r[at + LAST_X] = _sample.x;
    r[at + LAST_Z] = _sample.z;
    r[at + VELOCITY_X] = snapped ? 0 : vx;
    r[at + VELOCITY_Z] = snapped ? 0 : vz;

    const keep = Math.exp(-dt / CORRECTION_SECONDS);

    r[at + OFFSET_X] *= keep;
    r[at + OFFSET_Z] *= keep;
    _sample.x += r[at + OFFSET_X];
    _sample.z += r[at + OFFSET_Z];
  }
}
