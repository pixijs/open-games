import type { Container3D, Scene3DSource } from '@pixi/3d';
import type { RigidBody } from 'crashcat';
import { Ticker } from 'pixi.js';

import type { ControlsState } from './Controls';
import { ULTRA_SECONDS } from './DriftBoost';
import type { DriftMarks } from './DriftMarks';
import type { TruckLights } from './look/TruckLights';
import type { CarEffects } from './Particles';
import type { PhysicsWorld } from './Physics';
import { TRUCK_BALL_RADIUS } from './Physics';
import { BOT_SKILLS } from './race/BotDriver';
import type { Course } from './race/course';
import { createTrackSpot, gridSpot, RaceRules } from './race/RaceRules';
import type { RacerProgress } from './race/RaceRules';
import type { TruckPose } from './race/truck';
import { copyTruckPose, MAX_RACERS, TRUCK_COLORS } from './race/truck';
import type { RacerKind } from './Racer';
import { Racer } from './Racer';
import { MODEL_SCALE, TruckModel } from './TruckModel';
import { Vehicle } from './Vehicle';

/** What a racer is made from. */
export interface AddRacerOptions {
  /** Unique id: a session id for a player, anything for a bot. */
  id: string;
  kind: RacerKind;
  /** Colour index into `TRUCK_COLORS`. */
  color: number;
  /** Shown on standings; defaults to the colour's name. */
  name?: string;
  /** Grid slot, 0 to 3; defaults to its effects slot, the first free one. */
  grid?: number;
}

/** A truck hitting a wall or another truck, reported through {@link Race.onImpact}. */
export interface RaceImpact {
  /** The truck that hit. */
  racer: Racer | null;
  /** The truck it hit, or null for a wall. */
  other: Racer | null;
  /** Where. */
  x: number;
  y: number;
  z: number;
  /** Normal pointing back toward `racer`, on the ground. */
  nx: number;
  nz: number;
  /** Closing speed, world units per second. */
  strength: number;
}

const IDLE: ControlsState = { x: 0, z: 0, touchActive: false };
/** Seconds a launch boost lasts: the player's for a throttle held on GO, and each bot's that doesn't fluff its start. */
const LAUNCH_SECONDS = 0.8;
/** Chance a bot fluffs its start and gets no launch boost. */
const LAUNCH_FLUFF = 0.15;
/** A finished truck coasts round at this share of the throttle. */
const COAST = 0.55;
/** Closing speed below which a contact isn't worth a spark. */
const WALL_HIT = 1.5;
const TRUCK_HIT = 1;
/** Seconds between impacts one truck reports. */
export const IMPACT_COOLDOWN = 0.25;
/** Height of the trucks' bodies, where contact sparks fly from. */
const BODY_HEIGHT = 0.35;
/** Two trucks respawned closer than this are moved apart across the road. */
const RESPAWN_CLEARANCE = 1.3;
/**
 * A remote truck's stand-in further than this from where it should be was put there (a respawn, a snap), not driven:
 * it jumps rather than sweeping across the track at the speed the move would take in one step.
 */
const STAND_IN_SNAP = 2;
/** A ghost's stand-in waits this far under the track, where nothing meets it. */
const GHOST_DEPTH = -50;
/** Seconds a ghost takes to fade out, or back in. */
const GHOST_FADE_SECONDS = 0.35;

const _spot = createTrackSpot();
const _point = { x: 0, y: 0, z: 0 };
const _impact: RaceImpact = { racer: null, other: null, x: 0, y: 0, z: 0, nx: 0, nz: 0, strength: 0 };

/**
 * The racing world: up to four trucks on one physics world, with their effects, lamps and the race rules.
 *
 * Add a racer by kind with {@link Race.addRacer}: local and bot trucks are simulated here; remote ones are puppets
 * posed through {@link Race.setRemotePose}. Every frame, {@link Race.update} drives the local and bot trucks, steps
 * the physics, poses every truck, runs the rules and lays every truck's smoke, sparks, flames, marks and lamps through
 * shared pools. It doesn't run the race's flow (countdown, results): whoever owns that sets {@link Race.driving} and
 * calls `rules.start()`.
 */
export class Race {
  /** Every racer, in the order added. */
  public readonly racers: Racer[] = [];
  /** The track raced; the rules, the bots and the grid read it as they need it. */
  public readonly course: Course;
  public readonly rules: RaceRules;
  /** The player's truck at this screen, if there is one. */
  public local: Racer | null = null;
  /** Whether trucks take their input; off before the green light, so they sit on the grid. */
  public driving = false;
  /** Let the bot AI drive the local truck. */
  public autodrive = false;

  /** A truck hit a wall or another truck hard enough to show. */
  public onImpact: ((impact: Readonly<RaceImpact>) => void) | null = null;
  /** A truck fired its ultra boost from a held slide. */
  public onBoost: ((racer: Racer) => void) | null = null;
  /** A truck completed a lap that isn't its last. */
  public onLap: ((racer: Racer, lapTime: number) => void) | null = null;
  /** A truck took the flag. */
  public onFinish: ((racer: Racer) => void) | null = null;
  /** A truck was put back on the track. */
  public onRespawn: ((racer: Racer) => void) | null = null;

  private readonly _parent: Container3D;
  private readonly _sources: Record<string, Scene3DSource>;
  private readonly _physics: PhysicsWorld;
  private readonly _effects: CarEffects;
  private readonly _marks: DriftMarks;
  private readonly _lights: TruckLights;
  /** Each slot's pose for the effects, null while the slot is empty or not yet posed. */
  private readonly _poses: (TruckPose | null)[] = [];
  private readonly _bySlot: (Racer | null)[] = [];
  private readonly _effectsStep = new Ticker();
  /** Route distances the bots race against this frame: the leading person's, and the last person's. */
  private _lead = 0;
  private _last = 0;
  /** In a party, the bot that races the last person rather than the leader; null when there's no call for one. */
  private _minder: Racer | null = null;

  constructor(deps: {
    parent: Container3D;
    sources: Record<string, Scene3DSource>;
    physics: PhysicsWorld;
    effects: CarEffects;
    marks: DriftMarks;
    lights: TruckLights;
    course: Course;
  }) {
    this.course = deps.course;
    this.rules = new RaceRules(deps.course, 3);
    this._parent = deps.parent;
    this._sources = deps.sources;
    this._physics = deps.physics;
    this._effects = deps.effects;
    this._marks = deps.marks;
    this._lights = deps.lights;

    for (let i = 0; i < MAX_RACERS; i++) {
      this._poses.push(null);
      this._bySlot.push(null);
    }

    this._effectsStep.autoStart = false;
    this._effectsStep.stop();

    this.rules.onLap = (entry, lapTime) => {
      const racer = this._byEntry(entry);

      if (racer) this.onLap?.(racer, lapTime);
    };
    this.rules.onFinish = (entry) => {
      const racer = this._byEntry(entry);

      if (racer) this.onFinish?.(racer);
    };

    this._physics.listener = {
      onContactAdded: (bodyA, bodyB, manifold, settings) => {
        const a = racerOf(bodyA);
        const b = racerOf(bodyB);

        if (a && b) {
          settings.combinedFriction = 0;
          settings.combinedRestitution = 0.35;
          this._truckHit(a, b, manifold.worldSpaceNormal);
        } else if (a || b) {
          this._wallHit(a ?? b!, a ? 1 : -1, manifold.worldSpaceNormal);
        }
      },
      onContactPersisted: (bodyA, bodyB, _manifold, settings) => {
        if (racerOf(bodyA) && racerOf(bodyB)) {
          settings.combinedFriction = 0;
          settings.combinedRestitution = 0.35;
        }
      },
    };
  }

  /** Whether another racer fits. */
  public get full(): boolean {
    return this.racers.length >= MAX_RACERS;
  }

  /** Each slot's pose, null for an empty slot; what the weather and the lamps read. */
  public get poses(): readonly (Readonly<TruckPose> | null)[] {
    return this._poses;
  }

  /**
   * Add a truck to the race, on the first free grid slot.
   * @param options - Who it is and how it's driven.
   * @returns The racer, or null when all four slots are taken or the id is in use.
   */
  public addRacer(options: AddRacerOptions): Racer | null {
    if (this.full || this.getRacer(options.id)) return null;

    const slot = this._bySlot.indexOf(null);
    const grid = options.grid ?? slot;
    const color = clampColor(options.color);
    const remote = options.kind === 'remote';

    gridSpot(this.course.route, grid, _spot);

    const model = new TruckModel(this._sources[TRUCK_COLORS[color].asset]);
    const body: RigidBody = this._physics.addTruckBall(_spot.x, _spot.y + TRUCK_BALL_RADIUS, _spot.z, remote, null);
    const vehicle = remote ? null : new Vehicle(this._physics, body);
    const racer = new Racer({
      id: options.id,
      kind: options.kind,
      slot,
      grid,
      name: options.name ?? TRUCK_COLORS[color].name,
      color,
      body,
      vehicle,
      skill: BOT_SKILLS[slot],
      progress: this.rules.add(options.id, grid),
      model,
    });

    body.userData = racer;
    this._parent.addChild(model.root);
    this._lights.attach(slot, color, model.body, MODEL_SCALE);
    this.racers.push(racer);
    this._bySlot[slot] = racer;

    if (options.kind === 'local') this.local = racer;

    this._place(racer, _spot.x, _spot.y, _spot.z, _spot.yaw);

    return racer;
  }

  /**
   * Take a truck out of the race.
   * @param id - Its id.
   */
  public removeRacer(id: string): void {
    const racer = this.getRacer(id);

    if (!racer) return;

    this.racers.splice(this.racers.indexOf(racer), 1);
    this._bySlot[racer.slot] = null;
    this._poses[racer.slot] = null;
    this._lights.detach(racer.slot);
    this._marks.cut(racer.slot);
    this._physics.removeBody(racer.body);
    this.rules.remove(id);
    racer.body.userData = null;
    racer.model.destroy();

    if (this.local === racer) this.local = null;
    if (this._minder === racer) this._minder = null;
  }

  /** Take every truck out. */
  public clear(): void {
    while (this.racers.length > 0) this.removeRacer(this.racers[this.racers.length - 1].id);
  }

  /**
   * A racer by id.
   * @param id - Its id.
   * @returns The racer, or undefined.
   */
  public getRacer(id: string): Racer | undefined {
    for (let i = 0; i < this.racers.length; i++) {
      if (this.racers[i].id === id) return this.racers[i];
    }

    return undefined;
  }

  /**
   * Repaint a truck: a fresh model in the new colour, its lamps moved over.
   * @param id - Its id.
   * @param color - Colour index into `TRUCK_COLORS`.
   */
  public setColor(id: string, color: number): void {
    const racer = this.getRacer(id);

    color = clampColor(color);

    if (!racer || racer.color === color) return;

    const model = new TruckModel(this._sources[TRUCK_COLORS[color].asset]);

    this._lights.detach(racer.slot);
    racer.model.destroy();
    racer.model = model;
    racer.color = color;
    this._parent.addChild(model.root);
    this._lights.attach(racer.slot, color, model.body, MODEL_SCALE);
    model.update(racer.pose, 0);
  }

  /**
   * Move a truck to another grid slot; it lines up there from the next {@link Race.toGrid}, and at once while it waits
   * on the grid.
   * @param id - Its id.
   * @param grid - Grid slot, 0 to 3.
   */
  public setGrid(id: string, grid: number): void {
    const racer = this.getRacer(id);

    if (!racer || racer.grid === grid) return;

    racer.grid = grid;
    racer.progress.slot = grid;

    if (this.driving || racer.held) return;

    gridSpot(this.course.route, grid, _spot);
    this._place(racer, _spot.x, _spot.y, _spot.z, _spot.yaw);
    this.rules.reset();
  }

  /**
   * A remote truck's pose for this frame. Call before {@link Race.update}; the netcode interpolates its snapshots and
   * hands the result here every frame.
   * @param id - Its id.
   * @param pose - Where it is and what it's doing.
   */
  public setRemotePose(id: string, pose: Readonly<TruckPose>): void {
    const racer = this.getRacer(id);

    if (!racer || racer.kind !== 'remote' || racer.held) return;

    copyTruckPose(pose, racer.pose);
    racer.posed = true;
  }

  /**
   * Take a remote truck out of the race for now, as when its player has dropped and may come back: it fades away, its
   * stand-in leaves the track so nobody crashes into a frozen truck, and it shows no lamps or effects. Or put it back.
   * @param id - Its id.
   * @param ghost - Whether it's out.
   */
  public setGhost(id: string, ghost: boolean): void {
    const racer = this.getRacer(id);

    if (!racer || racer.vehicle || racer.ghost === ghost) return;

    const pose = racer.pose;

    racer.ghost = ghost;
    _point.x = pose.x;
    _point.y = pose.y + BODY_HEIGHT;
    _point.z = pose.z;
    this._effects.colorBurst(_point, TRUCK_COLORS[racer.color].paint);

    if (ghost) {
      this._physics.teleport(racer.body, pose.x, GHOST_DEPTH, pose.z);
    } else {
      this._physics.teleport(racer.body, pose.x, pose.y + TRUCK_BALL_RADIUS, pose.z);
      racer.model.root.visible = true;
      this._marks.cut(racer.slot);
      this._lights.cut(racer.slot);
    }
  }

  /**
   * Every truck back on its grid slot, at rest and in view, with the rules reset for a new race.
   * @param laps - Laps to win.
   */
  public toGrid(laps = this.rules.laps): void {
    this.driving = false;
    this.rules.reset(laps);
    this._effects.clear();

    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];

      racer.held = false;
      racer.model.root.visible = true;
      gridSpot(this.course.route, racer.grid, _spot);
      this._place(racer, _spot.x, _spot.y, _spot.z, _spot.yaw);
      racer.boost?.reset();
      racer.brain?.reset();
    }
  }

  /**
   * The green light: the clock starts and the trucks take their input. The player's truck launches with a boost when
   * they held the throttle, and each bot does unless it fluffs its start.
   * @param launched - Whether the player's truck launches.
   */
  public go(launched: boolean): void {
    this.rules.start();
    this.driving = true;

    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      const launch = racer.kind === 'bot' ? Math.random() >= LAUNCH_FLUFF : racer === this.local && launched;

      if (launch) racer.vehicle?.boost(LAUNCH_SECONDS);
    }
  }

  /**
   * Put any truck somewhere and keep it there, at rest, as on the podium. A remote truck ignores its network poses
   * until {@link Race.toGrid} releases it.
   * @param id - Its id.
   * @param x - Root position, x.
   * @param y - Root position, y.
   * @param z - Root position, z.
   * @param yaw - Facing.
   */
  public hold(id: string, x: number, y: number, z: number, yaw: number): void {
    const racer = this.getRacer(id);

    if (!racer) return;

    racer.held = true;
    racer.boost?.reset();
    this._place(racer, x, y, z, yaw);
  }

  /**
   * Put a truck back where it was in a race already under way, with its laps, as a reloaded page takes its seat back.
   * @param id - Its id.
   * @param x - Root position, x.
   * @param y - Root position, y.
   * @param z - Root position, z.
   * @param yaw - Facing.
   * @param distance - Route distance since the start line.
   * @param lap - Laps completed.
   */
  public resume(id: string, x: number, y: number, z: number, yaw: number, distance: number, lap: number): void {
    const racer = this.getRacer(id);

    if (!racer) return;

    this._place(racer, x, y, z, yaw);
    this.rules.restore(id, distance, lap);
  }

  /**
   * Put a truck back on the track where it is, near the middle of the road and facing the right way. Only for trucks
   * driven here; a remote one is respawned by its owner.
   * @param id - Its id.
   */
  public respawn(id: string): void {
    const racer = this.getRacer(id);

    if (!racer?.vehicle || !this.rules.respawnSpot(id, _spot)) return;

    // Keep clear of a truck already there by moving across the road.
    for (let i = 0; i < this.racers.length; i++) {
      const other = this.racers[i];

      if (other === racer) continue;

      if (Math.hypot(other.pose.x - _spot.x, other.pose.z - _spot.z) < RESPAWN_CLEARANCE) {
        const side = other.progress.lateral > 0 ? -1.6 : 1.6;

        racer.progress.lateral = side;
        this.rules.respawnSpot(id, _spot);
      }
    }

    this._place(racer, _spot.x, _spot.y, _spot.z, _spot.yaw);
    racer.boost?.reset();
    racer.brain?.reset();
    this.onRespawn?.(racer);
  }

  /**
   * One frame: drive, step the physics, pose every truck, run the rules and lay the effects.
   * @param dt - Game seconds since the last frame; slow motion shortens it.
   * @param input - The player's input for the local truck.
   */
  public update(dt: number, input: ControlsState): void {
    const racers = this.racers;
    const rules = this.rules;

    this._rubberBand();

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const vehicle = racer.vehicle;

      racer.impactCooldown = Math.max(0, racer.impactCooldown - dt);

      if (!vehicle) {
        if (racer.posed && !racer.ghost) this._moveStandIn(racer, dt);

        continue;
      }

      // A held truck stands where it was put, as on a podium block with nothing under it to the physics.
      if (racer.held) continue;

      vehicle.drive(dt, this._inputFor(racer, input, dt));
    }

    if (dt > 0) this._physics.step(dt);

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const vehicle = racer.vehicle;

      if (vehicle && racer.boost && !racer.held) {
        vehicle.settle(dt);

        if (this.driving && !racer.progress.finished && racer.boost.update(dt, vehicle)) {
          vehicle.boost(ULTRA_SECONDS);
          this.onBoost?.(racer);
        }

        vehicle.writePose(racer.pose, racer.boost.stage);
      }

      if (!racer.posed) continue;

      racer.model.update(racer.pose, dt);
      rules.observe(racer.id, racer.pose.x, racer.pose.y, racer.pose.z, dt);
      this._fadeGhost(racer, dt);
    }

    rules.update(dt);

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const progress = racer.progress;

      if (racer.vehicle && !racer.held && (progress.offTrack || (progress.stuck && racer.kind === 'bot'))) {
        this.respawn(racer.id);
      }
    }

    this._layEffects(dt);
  }

  public destroy(): void {
    this.clear();
    this._physics.listener = undefined;
    this.rules.onLap = null;
    this.rules.onFinish = null;
    this.onImpact = null;
    this.onBoost = null;
    this.onLap = null;
    this.onFinish = null;
    this.onRespawn = null;
    this._effectsStep.destroy();
  }

  /** What a driven truck does this frame: sit, race, or coast after the flag. */
  private _inputFor(racer: Racer, input: ControlsState, dt: number): ControlsState {
    if (!this.driving) return IDLE;

    const brain = racer.brain!;
    const vehicle = racer.vehicle!;
    const progress = racer.progress;
    const ai = racer.kind === 'bot' || this.autodrive || progress.finished;

    if (!ai) {
      vehicle.topSpeedScale = 1;

      return input;
    }

    const reference = racer === this._minder ? this._last : this._lead;
    const out = brain.update(dt, racer.pose, progress, this.rules.entries, reference, this.course);

    vehicle.topSpeedScale = racer.kind === 'bot' ? brain.speedScale : 1;

    if (progress.finished) out.z = Math.min(out.z, COAST);

    return out;
  }

  /**
   * Who the bots race against. Each races the leading person still racing, so a fast player always has a race, and in
   * a party with two bots or more the slowest bot races the last person instead, so they have one too. Once every
   * person has finished, the bots race to the flag, and with nobody in the race, as on the title, they race the pack's
   * average.
   */
  private _rubberBand(): void {
    const racers = this.racers;
    let people = 0;
    let lead = -Infinity;
    let last = Infinity;
    let finished = false;
    let sum = 0;
    let bots = 0;
    let slowest: Racer | null = null;

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const progress = racer.progress;

      sum += progress.distance;

      if (racer.kind === 'bot') {
        bots++;
        if (!slowest || racer.brain!.skill.pace < slowest.brain!.skill.pace) slowest = racer;
      } else if (progress.finished) {
        finished = true;
      } else if (!racer.ghost) {
        people++;
        lead = Math.max(lead, progress.distance);
        last = Math.min(last, progress.distance);
      }
    }

    if (people > 0) {
      this._lead = lead;
      this._last = last;
    } else {
      this._lead = this._last = finished ? this.rules.length : racers.length > 0 ? sum / racers.length : 0;
    }

    this._minder = people > 1 && bots > 1 ? slowest : null;
  }

  /** Moves a remote truck's stand-in to its pose over the next step, or straight there after a jump. */
  private _moveStandIn(racer: Racer, dt: number): void {
    const p = racer.pose;
    const b = racer.body.position;
    const y = p.y + TRUCK_BALL_RADIUS;

    if (Math.hypot(p.x - b[0], y - b[1], p.z - b[2]) > STAND_IN_SNAP) this._physics.teleport(racer.body, p.x, y, p.z);
    else this._physics.moveKinematic(racer.body, p.x, y, p.z, dt);
  }

  /** A ghost shrinks away to nothing over {@link GHOST_FADE_SECONDS}, and grows back when it returns. */
  private _fadeGhost(racer: Racer, dt: number): void {
    const target = racer.ghost ? 1 : 0;

    if (racer.fade === target) return;

    const step = dt / GHOST_FADE_SECONDS;

    racer.fade = racer.ghost ? Math.min(1, racer.fade + step) : Math.max(0, racer.fade - step);

    const size = 1 - racer.fade * racer.fade;

    racer.model.root.scale.set(Math.max(1e-3, size), Math.max(1e-3, size), Math.max(1e-3, size));

    if (racer.fade === 1) racer.model.root.visible = false;
  }

  /** Every truck's smoke, sparks, flames, marks and lamps, through the shared pools. */
  private _layEffects(dt: number): void {
    const racers = this.racers;

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];

      if (!racer.posed) continue;

      if (racer.ghost) {
        this._poses[racer.slot] = null;
        continue;
      }

      this._poses[racer.slot] = racer.pose;
      this._effects.emit(racer.pose);
      this._marks.trackTruck(racer.slot, racer.pose);
    }

    this._marks.flush();
    this._lights.update(dt, this._poses);
    this._effectsStep.deltaMS = dt * 1000;
    this._effects.update(this._effectsStep);
  }

  /**
   * Put a truck somewhere at rest, without trails or marks joining up to where it was. A remote truck is posed there
   * too, so it shows on its spot before its first pose arrives.
   */
  private _place(racer: Racer, x: number, y: number, z: number, yaw: number): void {
    if (racer.vehicle) {
      racer.vehicle.place(x, y, z, yaw);
      racer.vehicle.writePose(racer.pose, 0);
    } else {
      const pose = racer.pose;

      pose.x = x;
      pose.y = y;
      pose.z = z;
      pose.yaw = yaw;
      pose.heading = yaw;
      pose.pitch = pose.roll = pose.speed = pose.steer = pose.throttle = pose.drift = pose.charge = 0;
      pose.boosting = false;
      racer.posed = true;
      this._physics.teleport(racer.body, x, y + TRUCK_BALL_RADIUS, z);
    }

    racer.model.update(racer.pose, 0);
    this._marks.cut(racer.slot);
    this._lights.cut(racer.slot);
    this.rules.forgetMotion(racer.id);
  }

  private _byEntry(entry: RacerProgress): Racer | null {
    for (let i = 0; i < this.racers.length; i++) {
      if (this.racers[i].progress === entry) return this.racers[i];
    }

    return null;
  }

  /** Two trucks met: report it once, from whichever was going faster into the other. */
  private _truckHit(a: Racer, b: Racer, normal: ArrayLike<number>): void {
    if (a.impactCooldown > 0 && b.impactCooldown > 0) return;

    const va = a.body.motionProperties.linearVelocity;
    const vb = b.body.motionProperties.linearVelocity;
    const closing = (va[0] - vb[0]) * normal[0] + (va[2] - vb[2]) * normal[2];

    if (Math.abs(closing) < TRUCK_HIT) return;

    const pa = a.body.position;
    const pb = b.body.position;
    const len = Math.hypot(normal[0], normal[2]) || 1;

    a.impactCooldown = IMPACT_COOLDOWN;
    b.impactCooldown = IMPACT_COOLDOWN;
    _impact.racer = a;
    _impact.other = b;
    _impact.x = (pa[0] + pb[0]) / 2;
    _impact.y = BODY_HEIGHT;
    _impact.z = (pa[2] + pb[2]) / 2;
    // The manifold normal points from A to B; back toward A is its reverse.
    _impact.nx = -normal[0] / len;
    _impact.nz = -normal[2] / len;
    _impact.strength = Math.abs(closing);
    this.onImpact?.(_impact);
  }

  /** A truck met a wall, or the ground, which doesn't count. */
  private _wallHit(racer: Racer, sign: number, normal: ArrayLike<number>): void {
    if (Math.abs(normal[1]) > 0.7 || racer.impactCooldown > 0) return;

    // From the truck into the wall.
    const nx = normal[0] * sign;
    const nz = normal[2] * sign;
    const v = racer.body.motionProperties.linearVelocity;
    const into = v[0] * nx + v[2] * nz;

    if (into < WALL_HIT) return;

    const p = racer.body.position;

    racer.impactCooldown = IMPACT_COOLDOWN;
    _impact.racer = racer;
    _impact.other = null;
    _impact.x = p[0] + nx * TRUCK_BALL_RADIUS;
    _impact.y = p[1];
    _impact.z = p[2] + nz * TRUCK_BALL_RADIUS;
    _impact.nx = -nx;
    _impact.nz = -nz;
    _impact.strength = into;
    this.onImpact?.(_impact);
  }
}

function racerOf(body: RigidBody): Racer | null {
  return body.userData instanceof Racer ? body.userData : null;
}

function clampColor(color: number): number {
  return Math.max(0, Math.min(TRUCK_COLORS.length - 1, Math.round(color)));
}
