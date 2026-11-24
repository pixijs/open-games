/**
 * A rival's brain: turns where its truck is into stick and throttle, the same input a player gives, so a bot drives
 * the same physics as everyone else. Pure and renderer-free.
 *
 * It drives the way a fast player does: flat out everywhere, chasing a point well ahead on the racing line. That
 * throws the truck sideways into each bend and keeps it sliding down the straight after, so the ultra boost charges
 * and fires over and over. It steers round a truck close in front, lifts or brakes rather than run into one it can't
 * get round, and reverses out when it's stuck. After a spin sends it the wrong way it aims along the middle of the road
 * for a few seconds, which takes it through a corner the racing line would spin it in again.
 *
 * Rubber-banding keeps the race close. Behind the reference it races, a bot gets more top speed, which carries it
 * through the corners faster too: up to {@link RUBBER_STEP} more within {@link RUBBER_STEP_GAP}, rising to
 * {@link RUBBER_UP} from {@link RUBBER_RANGE} back. More than {@link EASE_FROM} ahead of it, a bot eases off over the
 * next {@link EASE_RANGE}, braking for the corners and losing top speed, so a slower player still has trucks to race.
 */

import type { CourseView } from './course';
import type { RacingLine } from './line/RacingLine';
import { LINE_LIMIT, lineAt } from './line/RacingLine';
import type { RacerProgress } from './RaceRules';
import type { Route } from './route';
import type { TruckPose } from './truck';
import { angleDelta } from './truck';

/** How a bot drives. */
export interface BotSkill {
  /** 0 to 1: how close to the truck's top speed it drives. */
  pace: number;
}

/** The input a bot gives, in the shape the vehicle reads. */
export interface BotInput {
  /** Steer, -1 full left to 1 full right. */
  x: number;
  /** Throttle, -1 full reverse to 1 full ahead. */
  z: number;
  /** Always false: bots steer like a keyboard, never camera-relative. */
  readonly touchActive: false;
}

/**
 * The bots by effects slot. A quick race seats its bots in slots 1 to 3 and a party fills the last slots first, so the
 * fastest sits in slot 3, which every race with a bot has. Slot 0 is the player's, for when the bot AI drives for them.
 */
export const BOT_SKILLS: readonly BotSkill[] = [{ pace: 1 }, { pace: 0.85 }, { pace: 0.92 }, { pace: 1 }];

/** How far ahead a bot aims, in metres, and how much further per unit of its speed. */
const LOOK = 3.46;
const LOOK_PER_SPEED = 0.582;
/** Steering gain: stick per radian of heading error. */
const STEER_GAIN = 4.56;
/** Share of a slide's slip angle a bot steers against, so it aims where the truck travels rather than faces. */
const SLIP_GAIN = 0.495;
/** Top speed lost per unit of pace short of 1. */
const PACE_SPREAD = 0.3;
/** Seconds slow before a bot decides it's stuck and backs out. */
const STUCK_AFTER = 0.9;
const REVERSE_FOR = 0.8;
/**
 * A truck ahead within this far along the route, plus this far per m/s the bot closes on it, and this far across it,
 * makes a bot steer round it, up to this far across.
 */
const TRAFFIC_AHEAD = 3.6;
const TRAFFIC_PER_CLOSING = 0.6;
const TRAFFIC_SIDE = 1.3;
const TRAFFIC_SHIFT = 1.6;
/**
 * Closer than this along the route, plus this far per m/s it closes, and this far across, the bot can't get round a
 * truck: it lifts to this throttle, or brakes when it closes faster than this.
 */
const BLOCKED_AHEAD = 2.4;
const BLOCKED_PER_CLOSING = 0.35;
const BLOCKED_SIDE = 0.9;
const BLOCKED_THROTTLE = 0.3;
const BLOCKED_BRAKE = 2.5;
/**
 * Extra top speed behind the reference: a step that's whole this many metres back, so a bot on a player's tail can
 * fight for the place, rising to the most at this far back, enough to catch someone driving flat out.
 */
const RUBBER_STEP = 0.15;
const RUBBER_STEP_GAP = 4;
const RUBBER_UP = 0.28;
const RUBBER_RANGE = 30;
/**
 * Easing off ahead of the reference: from this many metres ahead, over this many more, a bot loses up to this share
 * of its top speed and brakes for the corners, from this ground speed down to this one.
 */
const EASE_FROM = 5;
const EASE_RANGE = 20;
const EASE_TOP = 0.25;
const EASE_CORNER_FAST = 15;
const EASE_CORNER_SLOW = 4.5;
/** How far before a corner a bot easing off starts to brake, per m/s over its corner speed, and at the least. */
const BRAKE_REACH = 1.2;
const BRAKE_MARGIN = 1.5;
/**
 * Seconds a bot aims along the centreline after it was last going the wrong way. A racing line can throw a truck that
 * spun into a corner from low speed straight back into the spin, round and round between the walls; the centreline
 * takes it through, and the line takes over again once it's back up to speed.
 */
const RECOVER_FOR = 3;

const _target = { x: 0, y: 0, z: 0 };

/** One bot's driving brain. */
export class BotDriver {
  public readonly skill: BotSkill;
  /** This frame's input, refilled by {@link BotDriver.update}. */
  public readonly input: BotInput = { x: 0, z: 0, touchActive: false };
  /** Top speed multiplier from its pace and rubber-banding; give it to the vehicle. */
  public speedScale = 1;
  /** Times it has decided it's stuck and backed out, for the line search's scoring and its checks. */
  public backouts = 0;

  private _slowFor = 0;
  private _reverse = 0;
  /** How fast it closes on a truck in front too close to get round, or 0 when the way is clear. */
  private _blocked = 0;
  /** Seconds left aiming along the centreline after going the wrong way. */
  private _recover = 0;
  /**
   * The racing line it aims along, taken from the course at its first move after a reset, so a line found while it
   * drives never swaps in mid-corner.
   */
  private _line: RacingLine | null = null;

  constructor(skill: BotSkill) {
    this.skill = skill;
  }

  /** The racing line it's racing, or null before its first move since a reset. */
  public get line(): RacingLine | null {
    return this._line;
  }

  /** Clear its memory, for a new race or a respawn; it takes the course's line again at its next move. */
  public reset(): void {
    this._slowFor = 0;
    this._reverse = 0;
    this._recover = 0;
    this._line = null;
    this.input.x = 0;
    this.input.z = 0;
  }

  /**
   * Decide this frame's input.
   * @param dt - Seconds since the last update.
   * @param pose - Its truck this frame.
   * @param me - Its standing.
   * @param field - Everyone's standings, itself included, for traffic.
   * @param reference - Route distance it races against for rubber-banding.
   * @param course - The track it races and its racing line.
   * @returns The input, also kept in {@link BotDriver.input}.
   */
  public update(
    dt: number,
    pose: Readonly<TruckPose>,
    me: Readonly<RacerProgress>,
    field: readonly Readonly<RacerProgress>[],
    reference: number,
    course: CourseView,
  ): BotInput {
    const input = this.input;
    const route = course.route;
    const line = (this._line ??= course.line);
    const speed = pose.speed;
    const gap = reference - me.distance;
    const up =
      gap > 0
        ? Math.min(RUBBER_UP, RUBBER_STEP * Math.min(1, gap / RUBBER_STEP_GAP) + (RUBBER_UP * gap) / RUBBER_RANGE)
        : 0;
    const ease = Math.max(0, Math.min(1, (-gap - EASE_FROM) / EASE_RANGE));

    this.speedScale = (1 - PACE_SPREAD * (1 - this.skill.pace)) * (1 + up) * (1 - EASE_TOP * ease);

    // -- Stuck: back out, steering the other way, then try again.
    if (this._reverse > 0) {
      this._reverse -= dt;
      input.z = -1;
      input.x = -this._steerTo(route, pose, me.lapS + 3, 0);

      return input;
    }

    this._slowFor = speed < 1.2 && me.distance > 0 ? this._slowFor + dt : 0;

    if (this._slowFor > STUCK_AFTER) {
      this._slowFor = 0;
      this._reverse = REVERSE_FOR;
      this.backouts++;
    }

    this._recover = me.wrongWay ? RECOVER_FOR : Math.max(0, this._recover - dt);

    const aimS = me.lapS + LOOK + speed * LOOK_PER_SPEED;
    const aim = this._recover > 0 ? 0 : lineAt(line, route, aimS);
    const lateral = aim + this._traffic(me, field, route.lapLength);

    input.x = this._steerTo(route, pose, aimS, Math.max(-LINE_LIMIT, Math.min(LINE_LIMIT, lateral)));
    input.z = this._blocked > BLOCKED_BRAKE ? -1 : this._blocked > 0 ? BLOCKED_THROTTLE : 1;

    if (ease > 0) {
      const over = speed - (EASE_CORNER_FAST + (EASE_CORNER_SLOW - EASE_CORNER_FAST) * ease);
      const brakeAt = over * BRAKE_REACH + BRAKE_MARGIN;

      if (over > 0 && (route.turn(me.lapS) !== 0 || route.distanceToTurn(me.lapS, brakeAt) < brakeAt)) {
        input.z = Math.min(input.z, over > 1.6 ? -1 : over > 0.6 ? 0 : 0.55);
      }
    }

    return input;
  }

  /** Stick toward a point on the route, from the heading error. */
  private _steerTo(route: Route, pose: Readonly<TruckPose>, s: number, lateral: number): number {
    route.point(s, lateral, _target);

    const want = Math.atan2(_target.x - pose.x, _target.z - pose.z);
    const slip = pose.speed > 2 ? angleDelta(pose.yaw, pose.heading) : 0;
    const error = angleDelta(pose.yaw, want) - slip * SLIP_GAIN;

    // A positive stick turns right, which lowers the yaw.
    return Math.max(-1, Math.min(1, -error * STEER_GAIN));
  }

  /**
   * How far to shift the line to get round a truck close in front, toward whichever side has more road, looking
   * further ahead the faster it closes; sets {@link BotDriver._blocked} when one is too close to get round.
   */
  private _traffic(me: Readonly<RacerProgress>, field: readonly Readonly<RacerProgress>[], lap: number): number {
    let shift = 0;

    this._blocked = 0;

    for (let i = 0; i < field.length; i++) {
      const other = field[i];

      if (other === me || other.finished) continue;

      let ahead = other.distance - me.distance;

      // A truck a lap down is still on the road ahead.
      ahead -= Math.round(ahead / lap) * lap;

      const side = Math.abs(other.lateral - me.lateral);
      const closing = Math.max(0, me.speed - other.speed);
      const reach = TRAFFIC_AHEAD + closing * TRAFFIC_PER_CLOSING;

      if (ahead <= 0.2 || ahead > reach || side > TRAFFIC_SIDE) continue;

      shift += (other.lateral > 0 ? -1 : 1) * TRAFFIC_SHIFT * (1 - ahead / reach);

      if (closing > 0.5 && side < BLOCKED_SIDE && ahead < BLOCKED_AHEAD + closing * BLOCKED_PER_CLOSING) {
        this._blocked = Math.max(this._blocked, closing);
      }
    }

    return shift;
  }
}
