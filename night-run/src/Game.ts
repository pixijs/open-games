import type { View3D } from '@pixi/3d';
import type { Application } from 'pixi.js';

import type { GameAudio } from './Audio';
import type { CameraRig } from './CameraRig';
import type { ControlsState } from './Controls';
import { Controls } from './Controls';
import type { DriftMarks } from './DriftMarks';
import type { NightLook } from './look/NightLook';
import type { NightSet } from './look/NightSet';
import type { Pyro } from './look/Pyro';
import type { TruckLights } from './look/TruckLights';
import type { Weather } from './look/Weather';
import type { CarEffects } from './Particles';
import { Podium } from './Podium';
import type { Race, RaceImpact } from './Race';
import { IMPACT_COOLDOWN } from './Race';
import type { Course } from './race/course';
import type { LineService } from './race/line/LineService';
import type { RacingLine } from './race/line/RacingLine';
import { createTrackSpot, gridSpot } from './race/RaceRules';
import { ARCH_TOP, BASE_ROUTE, Route } from './race/route';
import { MAX_RACERS, TRUCK_COLORS } from './race/truck';
import type { Racer } from './Racer';
import { START_HANDOVER, StageCameras } from './StageCameras';
import type { TrackDef } from './track/code';
import type { Venue } from './Venue';

/**
 * Where the game is:
 *
 * - `attract`: the title's backdrop, bots lapping under the attract camera
 * - `lobby`: the trucks on the grid under the lobby camera, waiting for a race
 * - `countdown`: on the grid, the lights counting down to a start time
 * - `racing`: the race is on
 * - `results`: the podium, the fireworks and the standings
 */
export type GamePhase = 'attract' | 'lobby' | 'countdown' | 'racing' | 'results';

/** A countdown step: 3, 2 and 1 on the lights, then 0 for GO. */
export type CountdownStep = 3 | 2 | 1 | 0;

/** A remote truck's moment, as the room passes it on. */
export type RemoteFx = 'boost' | 'wall' | 'bump';

/** Laps in a race unless told otherwise. */
export const DEFAULT_LAPS = 3;

/** The countdown's steps, by seconds before the green light. */
const COUNTDOWN: readonly CountdownStep[] = [3, 2, 1, 0];
/** Ground speed at top speed, world units per second. */
const TOP_GROUND_SPEED = 12;
/** Laps the attract race runs, so it never ends. */
const ATTRACT_LAPS = 999;
/**
 * The attract race starts strung out along the track, back from the same share of the lap as on Night Run, so its
 * camera never opens in the middle of a parked grid; the trucks start this far apart.
 */
const ATTRACT_SPACING = 6.5;
/** Height of a truck's body above its root, where a remote wall hit's sparks fly from. */
const BODY_HEIGHT = 0.35;
/** A truck joining the lobby drops onto its slot from this high, under this gravity. */
const DROP_HEIGHT = 1.6;
const DROP_GRAVITY = 18;
const DROP_LAND = Math.sqrt((2 * DROP_HEIGHT) / DROP_GRAVITY);
/** How hard a truck hit on another screen is shoved here, in m/s at full strength. */
const BUMP_SHOVE = 4;
/** A full-strength bump from another screen is as strong as a contact closing at this speed here, m/s. */
const BUMP_STRENGTH = 8;
/**
 * A contact with another screen's truck shakes the camera this much less: its stand-in is drawn a little in the past and
 * can't give, so the hits come harder and more often than the trucks' real ones.
 */
const STAND_IN_KICK = 0.45;
/** Headlamp strength on the podium, so the trucks facing the lens don't glare. */
const PODIUM_HEADLAMPS = 0.2;
/**
 * The podium's show centres this far beyond the winner, away from the lens: its shells burst lower in the podium shot,
 * which looks down onto the blocks, and its confetti still rains over the trucks.
 */
const SHOW_BEYOND = 2;
/**
 * Where the finish line's confetti bursts from: over the arch's sign rather than at the top of its opening, so a chase
 * lens riding under the arch, as a tall phone's does, never flies through the burst's middle.
 */
const CONFETTI_SPOT = { x: ARCH_TOP.x, y: ARCH_TOP.y + 1.3, z: ARCH_TOP.z };
/** The chase and the attract camera look down the road: the floodlights light this far ahead of their truck first. */
const LAMP_LEAD = 15;
const IDLE: ControlsState = { x: 0, z: 0, touchActive: false };

const _spot = createTrackSpot();
const _impact: RaceImpact = { racer: null, other: null, x: 0, y: 0, z: 0, nx: 0, nz: 0, strength: 0 };

/** What the game is built from; `racing.example.ts` assembles it. */
export interface GameParts {
  app: Application;
  /**
   * The display's resolution, which bloom and the beams' quality key on. The renderer's own follows the resolution
   * governor; were the tiers to follow it, a step down could switch effects off, the frame would get cheaper, the
   * governor would climb, the effects would come back, and round again.
   */
  resolution: number;
  view: View3D;
  race: Race;
  rig: CameraRig;
  look: NightLook;
  /** The world a track is raced in, built again for each track. */
  venue: Venue;
  set: NightSet;
  weather: Weather;
  pyro: Pyro;
  lights: TruckLights;
  effects: CarEffects;
  marks: DriftMarks;
  audio: GameAudio;
  /** The bots' racing lines, by track. */
  lines: LineService;
}

/**
 * The game's world and its frame: which phase it's in, what the cameras, the look and the sound do in each, and the
 * countdown, finish and results moments. The race itself lives in {@link Race}; the flow between screens and the
 * session drive it through {@link Game.showAttract}, {@link Game.showLobby}, {@link Game.startCountdown},
 * {@link Game.watchRace} and {@link Game.showResults}, the same calls for a quick race and an online one.
 */
export class Game {
  public readonly race: Race;
  /** The track raced, the race's own. */
  public readonly course: Course;
  public readonly rig: CameraRig;
  public readonly stage: StageCameras;
  public readonly controls = new Controls();
  public readonly podium: Podium;
  /** A track is now the one built; the flow redraws the mini-map from it. */
  public onTrackBuilt: ((def: TrackDef) => void) | null = null;
  /** A track's racing line got better; the flow redraws the lap times it shows. */
  public onLineImproved: ((code: string) => void) | null = null;
  /** Each countdown step as it lands: 3, 2, 1 on the lights, 0 for GO. */
  public onCountdown: ((step: CountdownStep) => void) | null = null;
  /** The green light, and whether the player's truck launched with a boost. */
  public onGo: ((launched: boolean) => void) | null = null;
  /** Whether the player's finish plays in slow motion; only where nobody else's clock runs on, a quick race. */
  public slowMotion = false;
  /** Smoothed frames per second. */
  public fps = 60;
  /** Counts of the race's moments since the page loaded, for test harnesses. */
  public readonly counts = { wallHits: 0, truckHits: 0, boosts: 0, laps: 0, respawns: 0 };
  /** The latest driving input, read once a frame. */
  public input: ControlsState = IDLE;
  /** Whether the player's truck ignores the controls, as it does under the race menu: it coasts. */
  public inputHeld = false;
  /** Pins every custom track's random trees, as `?treeSeed=` does for tests; null draws new ones each build. */
  public treeSeed: number | null = null;

  private readonly _parts: GameParts;
  private _phase: GamePhase = 'attract';
  /** Whether any phase has been staged yet; a track built before that waits for the flow to stage the first. */
  private _staged = false;
  /** Whether the world is hidden and still behind the editor. */
  private _editing = false;
  /** `performance.now()` of the green light, during the countdown. */
  private _goAt = 0;
  private _countdownStep = 0;
  private _slowMo = 0;
  private _timeScale = 1;
  private _paused = false;
  /** A better line found while a race was paused, put on the course when the race ends. */
  private _nextLine: RacingLine | null = null;
  /** The racer the race cameras follow when it isn't the player's: spectating, or after the flag. */
  private _spectating: Racer | null = null;
  private _tvShot: string | null = null;
  /** Seconds since each slot's truck started dropping onto the grid, or -1. */
  private readonly _drops = new Float32Array(MAX_RACERS).fill(-1);

  constructor(parts: GameParts) {
    this._parts = parts;
    this.race = parts.race;
    this.course = parts.race.course;
    this.rig = parts.rig;
    this.stage = new StageCameras(parts.rig, parts.race);
    this.podium = new Podium(parts.view.root);

    this.race.onImpact = this._onImpact;
    this.race.onBoost = this._onBoost;
    this.race.onLap = this._onLap;
    this.race.onFinish = this._onFinish;
    this.race.onRespawn = () => this.counts.respawns++;
    // A line found during a quick race's pause waits for the race to end: a bot takes the course's line again each time
    // it's put back on the road, and no bot changes line mid-race.
    parts.lines.onImproved = (code, line) => {
      if (code === this.course.def.code && this._racing) this._nextLine = line;
      else if (code === this.course.def.code) this.course.line = line;
      this.onLineImproved?.(code);
    };

    parts.app.ticker.add(this._tick);
  }

  /** The bots' racing lines: the flow queues the tracks a player is about to race, and reads their lap times. */
  public get lines(): LineService {
    return this._parts.lines;
  }

  /** Where the game is. */
  public get phase(): GamePhase {
    return this._phase;
  }

  /** The truck the cameras, the look and the sound are about this frame. */
  public get subject(): Racer | null {
    if (this.stage.shot !== null) return this.stage.subject;
    if (this._spectating && this.race.racers.includes(this._spectating)) return this._spectating;

    return this.race.local ?? this._leader();
  }

  /** The racer being watched in place of the player's own truck, or null. */
  public get spectating(): Racer | null {
    return this._spectating && this.race.racers.includes(this._spectating) ? this._spectating : null;
  }

  /** Whether a quick race is paused: no physics, no race clock. */
  public get paused(): boolean {
    return this._paused;
  }

  /** `performance.now()` of the green light; the flow keeps it on the room's clock through the countdown. */
  public get goAt(): number {
    return this._goAt;
  }

  public set goAt(value: number) {
    this._goAt = value;
    this._parts.audio.music.goAt = value;
  }

  // -- Phases --

  /**
   * Race on another track: tear the last venue down and build this one in the same tick, then stage the phase again on
   * it. Only while nobody drives: during a countdown or a race it changes nothing, unless `abortRace` says this tab's
   * race is stale, as when the room moved on without it.
   * @param def - A validated track.
   * @param options - What the build may need.
   * @param options.treeSeed - Pins a custom track's random trees; else {@link Game.treeSeed}, else new ones.
   * @param options.abortRace - Stop a race under way here first, with no results.
   * @returns Whether the track is now the one built: false during a race.
   */
  public setTrack(def: TrackDef, options: { treeSeed?: number; abortRace?: boolean } = {}): boolean {
    const racing = this._racing;

    if (racing && !options.abortRace) return false;
    if (racing) this._abortRace();

    const { venue, lines, pyro, effects, marks, weather } = this._parts;
    const route = def.builtIn ? BASE_ROUTE : new Route(def.cells);
    // Night Run's scenery isn't random, so it draws nothing from Math.random.
    const treeSeed = options.treeSeed ?? this.treeSeed ?? (def.builtIn ? 0 : randomSeed());

    this.race.driving = false;
    pyro.stop();
    effects.clear();
    marks.clear();
    weather.reset();
    this.podium.show(0);

    const plan = venue.build(def, route, lines.get(def, route), treeSeed);

    this._nextLine = null;

    weather.setRoad(route.cells);
    this.rig.setTvSpots(plan.tvSpots);

    // Every truck goes back on the new road; the grid is the same on every track, so the lobby's trucks don't move.
    // The results stay on the podium, which stands on the start straight too, and the editor stages its own next phase.
    if (this._staged && !this._editing) {
      if (this._phase === 'attract') {
        this.showAttract();
      } else if (this._phase === 'lobby') {
        const shot = this.stage.shot;

        this.showLobby(shot === 'start' ? 'start' : 'lobby');
        if (shot === 'garage') this.stage.show('garage');
      }
    }

    this.onTrackBuilt?.(def);

    return true;
  }

  /**
   * Hide the world and hold it still while the editor covers the screen, or bring it back. Music plays on; the race's
   * own sounds stop.
   * @param editing - Whether the editor is open.
   */
  public setEditing(editing: boolean): void {
    this._editing = editing;
    this._parts.view.visible = !editing;
    this._parts.audio.setPaused(editing || this._paused);
  }

  /**
   * The title's backdrop: bots lapping the night track under the attract camera.
   * @param bots - How many bots race, 1 to 4.
   */
  public showAttract(bots = MAX_RACERS): void {
    const race = this.race;

    race.clear();

    for (let i = 0; i < Math.min(bots, MAX_RACERS); i++) race.addRacer({ id: `bot-${i}`, kind: 'bot', color: i });

    race.toGrid(ATTRACT_LAPS);
    race.rules.start();

    const route = this.course.route;
    const start = this._parts.venue.plan?.attractStart ?? 0;

    for (let i = 0; i < race.racers.length; i++) {
      const s = start - i * ATTRACT_SPACING;
      const yaw = route.point(s, i % 2 ? 1 : -1, _spot);

      race.resume(race.racers[i].id, _spot.x, _spot.y, _spot.z, yaw, s, 0);
    }

    race.driving = true;
    this._reset();
    this.stage.show('attract');
    this._enter('attract');
    this._parts.audio.music.title();
  }

  /**
   * The grid: whoever is in the race waits in their slot.
   * @param shot - The lobby's shot across the grid, or the start shot behind the player's truck, as a quick race
   * passes straight through to its countdown.
   */
  public showLobby(shot: 'lobby' | 'start' = 'lobby'): void {
    this.race.toGrid();
    this._reset();
    this.stage.show(shot);
    this._enter('lobby');
    this._parts.audio.music.title();
  }

  /**
   * Turn the lobby's camera onto the player's own truck while the truck picker is open, so a new colour lands in view,
   * or back across the grid.
   * @param open - Whether the picker is open.
   */
  public showPicker(open: boolean): void {
    if (this._phase !== 'lobby' || !this.race.local) return;

    this.stage.show(open ? 'garage' : 'lobby');
  }

  /**
   * Line everyone up on the grid and count down to the green light.
   * @param goAt - `performance.now()` time of the green light, so every screen in a networked race starts together.
   * @param laps - Laps to win.
   */
  public startCountdown(goAt: number, laps = DEFAULT_LAPS): void {
    this.race.toGrid(laps);
    this._reset();
    this._goAt = goAt;
    this._countdownStep = 0;
    this.stage.show('start');
    this._enter('countdown');
    this._parts.audio.music.countdown(goAt);
    if (laps === 1) this._parts.audio.music.finalLap();
  }

  /**
   * Join a race already under way, as a late spectator or a guest coming back: no countdown, straight to the race
   * cameras.
   * @param laps - Laps to win.
   * @param elapsed - Seconds since GO.
   */
  public watchRace(laps = DEFAULT_LAPS, elapsed = 0): void {
    this.race.toGrid(laps);
    this._reset();
    this.race.rules.start();
    this.race.rules.time = Math.max(0, elapsed);
    this.race.driving = true;
    this._countdownStep = COUNTDOWN.length;
    this.stage.show(null);
    this._enter('racing');
    this._parts.audio.music.racing(elapsed);
    if (laps === 1) this._parts.audio.music.finalLap();
  }

  /**
   * The results: the top three on the podium, under the fireworks when someone took the flag.
   * @param order - Racer ids in finishing order, as the room placed them; anyone missing is hidden.
   * @param celebrate - Whether to fire the fireworks: not for a race the host closed before anyone finished.
   */
  public showResults(order: readonly string[], celebrate = true): void {
    const race = this.race;

    race.driving = false;

    let podiumPlaces = 0;

    for (let i = 0; i < race.racers.length; i++) {
      const racer = race.racers[i];
      const index = order.indexOf(racer.id);
      const place = index < 0 ? MAX_RACERS + 1 + i : index + 1;

      StageCameras.podiumSpot(this.course.route, place, _spot);
      race.hold(racer.id, _spot.x, _spot.y + Podium.height(place), _spot.z, _spot.yaw);
      racer.model.root.visible = place <= 3;

      if (place <= 3) podiumPlaces = Math.max(podiumPlaces, place);
    }

    this.stage.winner = race.getRacer(order[0] ?? '') ?? null;
    this._paused = false;
    this._slowMo = 0;
    // The podium cuts in where the finish's confetti may still be falling, right by its lens.
    this._parts.effects.clear();
    this.podium.show(podiumPlaces);
    this._parts.lights.setHeadlamps(PODIUM_HEADLAMPS);
    this.stage.show('podium');
    this._enter('results');
    this._parts.audio.music.title();

    if (!celebrate) return;

    // The winner faces the lens, so beyond it is behind the winner.
    StageCameras.podiumSpot(this.course.route, 1, _spot);
    this._parts.pyro.celebrate(
      _spot.x - Math.sin(_spot.yaw) * SHOW_BEYOND,
      _spot.z - Math.cos(_spot.yaw) * SHOW_BEYOND,
    );
    this._parts.set.celebrate();
    this._parts.look.flash(0.35, 0xffe6c0);
  }

  /**
   * Follow another truck with the race cameras, as a spectator does.
   * @param id - Its id, or null to follow the player's own truck again.
   */
  public spectate(id: string | null): void {
    this._spectating = id === null ? null : (this.race.getRacer(id) ?? null);
  }

  /** Follow the next truck in the standings. */
  public cycleSpectate(): void {
    const standings = this.race.rules.standings;

    if (standings.length === 0) return;

    const current = this.subject;
    const index = current ? standings.indexOf(current.progress) : -1;

    this.spectate(standings[(index + 1) % standings.length].id);
  }

  /**
   * Stop a quick race where it is, or let it go again: no physics, no race clock, no sound from the race.
   * @param paused - Whether it's paused.
   */
  public setPaused(paused: boolean): void {
    this._paused = paused;
    this._parts.audio.setPaused(paused);
    this._applyLines();
  }

  /**
   * Another screen's truck had a moment: a boost, a wall hit, or a bump into another truck, played here from where it
   * is.
   * @param id - The racer.
   * @param kind - Which moment.
   * @param power - Its strength, 0 to 1.
   * @param target - The truck it bumped, for a bump.
   * @returns Whether it shook this screen's own truck: a bump into it.
   */
  public remoteFx(id: string, kind: RemoteFx, power: number, target = ''): boolean {
    const racer = this.race.getRacer(id);

    if (!racer) return false;
    if (kind === 'bump') return this._bump(racer, this.race.getRacer(target), power);

    const { audio, effects } = this._parts;
    const pose = racer.pose;
    const distance = this.listenerDistance(pose.x, pose.y, pose.z);
    const pan = this.listenerPan(pose.x, pose.z);

    if (kind === 'boost') {
      audio.whoosh(power, distance, pan);
      if (racer === this.subject) this.rig.boostKick(0.45 + power * 0.6);
    } else {
      const fx = Math.sin(pose.yaw);
      const fz = Math.cos(pose.yaw);

      _impact.x = pose.x + fx * 0.45;
      _impact.y = pose.y + BODY_HEIGHT;
      _impact.z = pose.z + fz * 0.45;
      effects.impactSparks(_impact, -fx, -fz, 2 + power * 6);
      audio.playImpact(power * 6, distance, pan);
    }

    return false;
  }

  /**
   * Drop a truck that just joined onto its grid slot, landing with a thud and a spray of sparks.
   * @param racer - The truck, already on its slot.
   */
  public dropIn(racer: Racer): void {
    gridSpot(this.course.route, racer.grid, _spot);

    if (racer.vehicle) racer.vehicle.place(_spot.x, _spot.y + DROP_HEIGHT, _spot.z, _spot.yaw);

    this._drops[racer.slot] = 0;
  }

  /**
   * A truck took a new paint job in the lobby: a puff of its new colour, and a flash when it's the player's.
   * @param racer - The truck, already repainted.
   * @param mine - Whether it's the player's.
   */
  public repainted(racer: Racer, mine: boolean): void {
    const pose = racer.pose;

    _impact.x = pose.x;
    _impact.y = pose.y + 0.6;
    _impact.z = pose.z;
    this._parts.effects.colorBurst(_impact, TRUCK_COLORS[racer.color].paint);

    if (mine) this._parts.look.flash(0.16, 0xffffff);
  }

  /**
   * How far a point is from the lens, for a sound's gain or a tag's fade.
   * @returns Metres.
   */
  public listenerDistance(x: number, y: number, z: number): number {
    const p = this.rig.klipp.shot.position;

    return Math.hypot(x - p[0], y - p[1], z - p[2]);
  }

  /**
   * Where a point sits left to right of the lens, for a sound's pan.
   * @returns -1 hard left to 1 hard right.
   */
  public listenerPan(x: number, z: number): number {
    const p = this.rig.klipp.shot.position;
    const q = this.rig.klipp.shot.quaternion;
    // The camera's right on the ground, from its rotation: the quaternion turns +x.
    const rx = 1 - 2 * (q[1] * q[1] + q[2] * q[2]);
    const rz = 2 * (q[0] * q[2] - q[3] * q[1]);
    const dx = x - p[0];
    const dz = z - p[2];
    const len = Math.hypot(dx, dz) * (Math.hypot(rx, rz) || 1);

    return len > 0 ? ((dx * rx + dz * rz) / len) * 0.8 : 0;
  }

  public destroy(): void {
    this._parts.app.ticker.remove(this._tick);
    this.controls.destroy();
    this.podium.destroy();
    this.stage.destroy();
    this.race.onImpact = null;
    this.race.onBoost = null;
    this.race.onLap = null;
    this.race.onFinish = null;
    this.race.onRespawn = null;
    this._parts.lines.onImproved = null;
    this.onCountdown = null;
    this.onGo = null;
    this.onTrackBuilt = null;
    this.onLineImproved = null;
  }

  // -- Frame --

  private readonly _tick = (): void => {
    if (this._editing) return;

    const { app, resolution, look, set, weather, pyro, lights, audio } = this._parts;
    const width = app.screen.width;
    const height = app.screen.height;
    const realDt = Math.min(app.ticker.deltaMS / 1000, 1 / 30);
    const race = this.race;

    this.fps += (app.ticker.FPS - this.fps) * 0.05;
    this.rig.resize(width, height);
    look.layout(width, height, resolution);
    lights.layout(width, height, resolution);

    // Slow motion after the player's finish in a quick race; the camera keeps real time so the finish shot glides.
    if (this._slowMo > 0) {
      this._slowMo -= realDt;
      this._timeScale = 0.3;
    } else {
      this._timeScale = Math.min(1, this._timeScale + realDt * 2);
    }

    const dt = this._paused ? 0 : realDt * this._timeScale;

    this.input = this._readInput();

    if (!this._paused) {
      const input = this.inputHeld ? IDLE : this.input;

      if (this._phase === 'countdown' || this._phase === 'racing') this._countdown(input);

      this._drop(dt);
      race.update(dt, this._phase === 'racing' ? input : IDLE);
    }

    this.stage.update(realDt);

    const subject = this.subject;
    const pose = subject?.pose ?? null;
    const pace = pose ? pose.speed / TOP_GROUND_SPEED : 0;
    const racing = this._phase === 'racing';

    if (this.rig.activeCamera === 'tv' && this.rig.tvShot !== this._tvShot) {
      this._tvShot = this.rig.tvShot;
      look.flash(0.15);
    }

    lights.setShadowCaster(subject?.slot ?? -1);
    this.rig.update(realDt, pose, pace, racing && pose ? pose.drift : 0);
    weather.update(realDt, race.poses);
    set.update(realDt, pose?.x ?? 0, pose?.z ?? 0, this._lampFocus(subject));
    pyro.update(realDt);
    look.update(realDt, this.rig.activeCamera, pose);
    audio.update(dt, pace, pose?.throttle ?? 0, pose?.drift ?? 0);
  };

  /**
   * Route distance of the road the camera is about to see, which the floodlights are lit toward: ahead of the truck
   * on the chase, the diorama and the attract shot; the truck itself on a crane cam and the other staging shots, which
   * look at it.
   */
  private _lampFocus(subject: Racer | null): number {
    if (!subject) return 0;

    const shot = this.stage.shot;
    const ahead = shot === 'attract' || (shot === null && this.rig.activeCamera !== 'tv');

    return subject.progress.lapS + (ahead ? LAMP_LEAD : 0);
  }

  private _readInput(): ControlsState {
    // Touch steering is relative to the camera, so read its forward direction off klipp's shot.
    const q = this.rig.klipp.shot.quaternion;
    let camFx = -2 * (q[0] * q[2] + q[3] * q[1]);
    let camFz = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]));
    const camLen = Math.hypot(camFx, camFz) || 1;

    camFx /= camLen;
    camFz /= camLen;

    return this.controls.update(camFx, camFz, this.rig.mode === 'chase');
  }

  /** The lights down to green, then GO: the clock starts and a held throttle earns a launch boost. */
  private _countdown(input: ControlsState): void {
    const left = (this._goAt - performance.now()) / 1000;

    // The start shot turns into the chase's framing before handing over; any other race camera cuts in at GO, so the
    // player steers by the picture they race on from the first metre.
    const handover = this.rig.mode === 'chase' ? START_HANDOVER : 0;

    if (this.stage.shot === 'start') this.stage.sinceGo = -left;
    if (left < -handover && this.stage.shot === 'start') this.stage.show(null);

    while (this._countdownStep < COUNTDOWN.length && left <= COUNTDOWN[this._countdownStep]) {
      const step = COUNTDOWN[this._countdownStep];

      this._countdownStep++;

      if (step > 0) {
        this.onCountdown?.(step);
        continue;
      }

      const race = this.race;
      const local = race.local;
      const launched = !!local?.vehicle && (input.z > 0.5 || race.autodrive);

      race.go(launched);
      this._enter('racing');

      if (launched) this.rig.boostKick(0.8);

      this.onCountdown?.(0);
      this.onGo?.(launched);
    }
  }

  // -- Moments --

  private readonly _onImpact = (impact: Readonly<RaceImpact>): void => {
    const { effects, audio, look } = this._parts;
    const subject = this.subject;
    const strength = impact.strength;

    if (impact.other) this.counts.truckHits++;
    else this.counts.wallHits++;

    effects.impactSparks(impact, impact.nx, impact.nz, strength);

    if (impact.other) effects.impactSparks(impact, -impact.nx, -impact.nz, strength);

    if (impact.racer !== subject && impact.other !== subject) {
      audio.playImpact(
        strength,
        this.listenerDistance(impact.x, impact.y, impact.z),
        this.listenerPan(impact.x, impact.z),
      );

      return;
    }

    const standIn = impact.racer?.kind === 'remote' || impact.other?.kind === 'remote' ? STAND_IN_KICK : 1;

    audio.playImpact(strength);
    this._kick(impact.x, impact.y, impact.z, impact.nx, impact.nz, strength * standIn);
    look.flash(Math.min(strength * 0.03, 0.25) * standIn, impact.other ? 0xffd0a0 : 0xffe0b0);
  };

  /** The camera's kick for a hit of closing speed `strength` at a point, pushed back along the normal. */
  private _kick(x: number, y: number, z: number, nx: number, nz: number, strength: number): void {
    const kick = Math.min(strength * 0.06, 0.6);

    this.rig.impact(x, y, z, -nx * kick, kick * 0.3, -nz * kick, 0.4 + Math.min(strength * 0.03, 0.3));
  }

  /**
   * Another screen's truck bumped `target`: sparks where they met and a thud, and when the target is driven here, a
   * shove away from the hit, with the camera's kick when it's the one the cameras follow.
   */
  private _bump(racer: Racer, target: Racer | undefined, power: number): boolean {
    if (!target || target === racer) return false;

    const { audio, effects, look } = this._parts;
    const a = racer.pose;
    const b = target.pose;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = (b.x - a.x) / len;
    const nz = (b.z - a.z) / len;
    const strength = power * BUMP_STRENGTH;

    _impact.x = (a.x + b.x) / 2;
    _impact.y = BODY_HEIGHT;
    _impact.z = (a.z + b.z) / 2;
    effects.impactSparks(_impact, nx, nz, strength);
    effects.impactSparks(_impact, -nx, -nz, strength);

    // A contact here already played it.
    if (!target.vehicle || target.impactCooldown > 0) {
      audio.playImpact(
        strength,
        this.listenerDistance(_impact.x, 0, _impact.z),
        this.listenerPan(_impact.x, _impact.z),
      );

      return false;
    }

    this.counts.truckHits++;
    target.impactCooldown = IMPACT_COOLDOWN;
    target.vehicle.shove(nx * power * BUMP_SHOVE, nz * power * BUMP_SHOVE);

    if (target !== this.subject) {
      audio.playImpact(
        strength,
        this.listenerDistance(_impact.x, 0, _impact.z),
        this.listenerPan(_impact.x, _impact.z),
      );

      return false;
    }

    audio.playImpact(strength);
    this._kick(_impact.x, _impact.y, _impact.z, -nx, -nz, strength);
    look.flash(Math.min(strength * 0.03, 0.25), 0xffd0a0);

    return target === this.race.local;
  }

  private readonly _onBoost = (racer: Racer): void => {
    const p = racer.pose;

    this.counts.boosts++;

    if (racer === this.subject) this.rig.boostKick(1.05, p);
    else this._parts.audio.whoosh(1, this.listenerDistance(p.x, p.y, p.z), this.listenerPan(p.x, p.z));
  };

  private readonly _onLap = (racer: Racer, lapTime: number): void => {
    this.counts.laps++;

    if (racer === this.subject && this._phase === 'racing' && racer.progress.lap === this.race.rules.laps - 1) {
      this._parts.audio.music.finalLap();
    }

    if (racer !== this.race.local) return;

    const progress = racer.progress;
    const best = progress.bestLap === lapTime;

    this._parts.look.flash(0.3, best ? 0xc8ffd0 : 0xffffff);

    if (best && progress.lap > 1) this._parts.effects.confetti(CONFETTI_SPOT);
  };

  private readonly _onFinish = (racer: Racer): void => {
    const progress = racer.progress;

    if (progress.finishPlace === 1) this._parts.set.celebrate();
    if (racer !== this.race.local) return;

    this._parts.audio.music.finish();
    this.rig.playFinish(racer.pose, 2.2);

    if (this.slowMotion) this._slowMo = 1.4;

    this._parts.look.flash(0.25, progress.finishPlace === 1 ? 0xffe6a0 : 0xffffff);
    this._parts.effects.confetti(CONFETTI_SPOT);
  };

  /** Trucks dropping onto the grid: remote ones fall by hand, driven ones by physics; each lands with a thud. */
  private _drop(dt: number): void {
    const racers = this.race.racers;

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const t = this._drops[racer.slot];

      if (t < 0) continue;

      const next = t + dt;

      this._drops[racer.slot] = next;

      if (!racer.vehicle) {
        gridSpot(this.course.route, racer.grid, _spot);
        racer.pose.y = _spot.y + Math.max(0, DROP_HEIGHT - 0.5 * DROP_GRAVITY * next * next);
      }

      if (next < DROP_LAND) continue;

      const pose = racer.pose;

      this._drops[racer.slot] = -1;
      _impact.x = pose.x;
      _impact.y = pose.y + 0.1;
      _impact.z = pose.z;
      this._parts.effects.impactSparks(_impact, 0, 0, 3);
      this._parts.audio.playImpact(
        3.5,
        this.listenerDistance(pose.x, pose.y, pose.z),
        this.listenerPan(pose.x, pose.z),
      );
      this.rig.impact(pose.x, pose.y, pose.z, 0, -0.12, 0, 0.4);
    }
  }

  /** Whether a race is on, from its countdown to its results. */
  private get _racing(): boolean {
    return this._phase === 'countdown' || this._phase === 'racing';
  }

  /** Into a phase; a line found while the race was paused goes on the course once it's over. */
  private _enter(phase: GamePhase): void {
    this._phase = phase;
    this._staged = true;

    if (!this._racing && this._nextLine) {
      this.course.line = this._nextLine;
      this._nextLine = null;
    }

    this._applyLines();
  }

  /** The line search keeps off the CPU from the countdown to the results, but for a quick race's pause. */
  private _applyLines(): void {
    this._parts.lines.setRacing(this._racing && !this._paused);
  }

  /** Stop this tab's race where it is, with no results and no finish moment, and wait in the lobby. */
  private _abortRace(): void {
    this.race.driving = false;
    this._enter('lobby');
  }

  /** Back to a clean slate between phases: no slow motion, no pause, nobody watched, no podium. */
  private _reset(): void {
    this._parts.lights.setHeadlamps(1);
    this._spectating = null;
    this._slowMo = 0;
    this._paused = false;
    this._drops.fill(-1);
    this._parts.audio.setPaused(false);
    this._parts.pyro.stop();
    this.podium.show(0);
    this.stage.winner = null;
  }

  private _leader(): Racer | null {
    const first = this.race.rules.standings[0];

    return first ? (this.race.getRacer(first.id) ?? null) : null;
  }
}

/** A fresh 32-bit seed for a build's random trees. */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}
