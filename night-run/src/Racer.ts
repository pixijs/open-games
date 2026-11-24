import type { RigidBody } from 'crashcat';

import { DriftBoost } from './DriftBoost';
import type { BotSkill } from './race/BotDriver';
import { BotDriver } from './race/BotDriver';
import type { RacerProgress } from './race/RaceRules';
import type { TruckPose } from './race/truck';
import { createTruckPose } from './race/truck';
import type { TruckModel } from './TruckModel';
import type { Vehicle } from './Vehicle';

/**
 * How a truck is driven:
 *
 * - `local`: by the player at this screen, through the controls, on this machine's physics
 * - `bot`: by a {@link BotDriver} on this machine's physics, the same physics a player gets
 * - `remote`: somewhere else; posed from snapshots the network delivers, with a kinematic ball so local trucks bump it
 */
export type RacerKind = 'local' | 'bot' | 'remote';

/** One truck in the race and everything that drives and draws it. Made by `Race.addRacer`. */
export class Racer {
  public readonly id: string;
  public readonly kind: RacerKind;
  /** Effects slot, 0 to 3: which lamps, marks and pose slot it uses; unique among the racers. */
  public readonly slot: number;
  /** Grid slot, 0 to 3, where it lines up; the room's seat in a networked race. */
  public grid: number;
  /** Shown on standings. */
  public name: string;
  /** Colour index into `TRUCK_COLORS`. */
  public color: number;
  /** This frame's pose: written from physics for local and bot trucks, from the network for remote ones. */
  public readonly pose: TruckPose = createTruckPose();
  /** Its ball in the physics world: dynamic when driven here, kinematic when remote. */
  public readonly body: RigidBody;
  /** The driving model, for local and bot trucks. */
  public readonly vehicle: Vehicle | null;
  /** Drift charge, for local and bot trucks. */
  public readonly boost: DriftBoost | null;
  /** The AI: a bot's driver, or the player's when the bot AI drives for them. */
  public readonly brain: BotDriver | null;
  /** Its standing in the race. */
  public readonly progress: RacerProgress;
  /** The drawn truck; replaced when the colour changes. */
  public model: TruckModel;
  /** Whether it has a pose to draw: always for driven trucks, after the first snapshot for remote ones. */
  public posed: boolean;
  /** Placed and held by `Race.hold`, as on the podium; remote poses are ignored until it's released. */
  public held = false;
  /** Seconds until another impact can be reported, so a scrape isn't a stream of them. */
  public impactCooldown = 0;
  /** Out of the race for now, as a dropped player's truck is: drawn fading away, with nothing to bump into. */
  public ghost = false;
  /** How far it has faded, 0 (solid) to 1 (gone). */
  public fade = 0;

  constructor(options: {
    id: string;
    kind: RacerKind;
    slot: number;
    grid: number;
    name: string;
    color: number;
    body: RigidBody;
    vehicle: Vehicle | null;
    skill: BotSkill;
    progress: RacerProgress;
    model: TruckModel;
  }) {
    this.id = options.id;
    this.kind = options.kind;
    this.slot = options.slot;
    this.grid = options.grid;
    this.name = options.name;
    this.color = options.color;
    this.body = options.body;
    this.vehicle = options.vehicle;
    this.boost = options.vehicle ? new DriftBoost() : null;
    this.brain = options.vehicle ? new BotDriver(options.skill) : null;
    this.progress = options.progress;
    this.model = options.model;
    this.posed = options.kind !== 'remote';
  }
}
