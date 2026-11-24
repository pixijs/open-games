import type { View3D } from '@pixi/3d';
import { Point } from 'pixi.js';

import { CAMERA_LABELS } from './CameraRig';
import { CHARGE_READY } from './DriftBoost';
import type { Game } from './Game';
import { MAX_RACERS } from './net/messages';
import type { Seat } from './net/schema';
import type { Session } from './net/session';
import type { Race } from './Race';
import type { Racer } from './Racer';
import type { CarColor, HudFrame, HudRacer } from './ui/contract';

/** Converts ground speed (world units per second) into km/h for the HUD. */
const KMH_PER_UNIT = 9;
/** Name tags hang this far above a truck's root. */
const TAG_HEIGHT = 0.95;
/** A tag this far off the screen's edge, in px, still counts as on screen, so it can slide in. */
const TAG_MARGIN = 48;
/** Closest and furthest a name tag shows, metres from the lens. */
const TAG_NEAR = 1.2;
const TAG_FAR = 80;
/** The timing tower's gaps are measured every this many metres of route. */
const GAP_STEP = 1;

const _screen = new Point();
const _tagPoint = { x: 0, y: 0, z: 0 };

function hudRacer(): HudRacer {
  return {
    active: false,
    id: '',
    name: '',
    car: 0,
    place: 0,
    isYou: false,
    x: 0,
    z: 0,
    yaw: 0,
    screenX: 0,
    screenY: 0,
    tagVisible: false,
    distance: 0,
    gap: 0,
    finished: false,
  };
}

const asCar = (car: number): CarColor => (car & 3) as CarColor;

/**
 * Fills the one {@link HudFrame} the UI reads every frame, in place: the followed truck's readouts, and every racer's
 * place, gap to the leader, mini-map spot and name tag. Places and laps come from the room when there is one, so every
 * screen agrees; the gaps come from when each racer reached each metre of the route.
 */
export class HudFeed {
  public readonly frame: HudFrame;

  private readonly _view: View3D;
  private readonly _game: Game;
  private readonly _race: Race;
  /** Race time each metre of route was first reached, for the timing tower's gaps. */
  private _passed = new Float64Array(0);
  private _reached = -1;
  private readonly _lapSeen = new Int32Array(MAX_RACERS);
  private readonly _lapStart = new Float64Array(MAX_RACERS);

  /**
   * @param view - The 3D view, for placing name tags on screen.
   * @param game - The game, whose followed truck the readouts are about.
   * @param laps - Laps shown before a race says otherwise.
   */
  constructor(view: View3D, game: Game, laps: number) {
    this._view = view;
    this._game = game;
    this._race = game.race;
    this.frame = {
      place: 0,
      racerCount: 0,
      lap: 0,
      laps,
      raceTime: 0,
      lapTime: 0,
      bestLap: 0,
      speedKmh: 0,
      charge: 0,
      boosting: false,
      impact: 0,
      camera: CAMERA_LABELS[game.rig.mode],
      racers: [hudRacer(), hudRacer(), hudRacer(), hudRacer()],
      watching: '',
    };
  }

  /**
   * A new race: the gaps and lap clocks start over.
   * @param laps - Laps in it.
   */
  public reset(laps: number): void {
    const size = Math.ceil((laps * this._game.course.route.lapLength) / GAP_STEP) + 2;

    if (this._passed.length < size) this._passed = new Float64Array(size);

    this._reached = -1;
    this._lapSeen.fill(0);
    this._lapStart.fill(0);
  }

  /**
   * Fill the frame for this frame.
   * @param session - The room's view, or null for the attract race.
   * @param impact - This frame's hit strength, 0 to 1.
   * @param width - Screen width in CSS px, for which tags are on screen.
   * @param height - Screen height in CSS px.
   */
  public fill(session: Session | null, impact: number, width: number, height: number): void {
    const frame = this.frame;
    const game = this._game;
    const race = this._race;
    const state = session?.state;
    const subject = game.subject;
    const raceTime = session ? session.raceTime() : race.rules.time * 1000;
    const racers = race.racers;
    const laps = state ? state.laps : race.rules.laps;
    const rig = game.rig;
    const active = rig.activeCamera;

    frame.laps = laps;
    frame.racerCount = racers.length;
    frame.camera = (active && CAMERA_LABELS[active]) || CAMERA_LABELS[rig.mode];
    frame.impact = impact;
    frame.watching = game.spectating?.name ?? '';

    // The timing tower: the first time anyone reached each metre, so a gap is how long after the leader you got there.
    for (let i = 0; i < racers.length; i++) {
      const at = Math.floor(this._distance(session, racers[i]) / GAP_STEP);

      while (this._reached < at && this._reached + 1 < this._passed.length) this._passed[++this._reached] = raceTime;
    }

    for (let i = 0; i < MAX_RACERS; i++) {
      const out = frame.racers[i];
      const truck = racers[i];

      if (!truck) {
        out.active = false;
        out.tagVisible = false;
        continue;
      }

      const seat = state?.racers.get(truck.id);
      const pose = truck.pose;
      const finished = seat ? seat.finishTime > 0 : truck.progress.finished;

      out.active = true;
      out.id = truck.id;
      out.name = truck.name;
      out.car = asCar(truck.color);
      out.place = seat ? seat.rank : truck.progress.rank;
      out.isYou = truck === race.local;
      out.x = pose.x;
      out.z = pose.z;
      out.yaw = pose.yaw;
      out.finished = finished;
      out.gap = finished ? this._finishGap(session, seat) : this._gap(session, truck, raceTime);
      this._tag(out, truck, width, height);

      if (seat && seat.lap !== this._lapSeen[truck.slot]) {
        this._lapSeen[truck.slot] = seat.lap;
        this._lapStart[truck.slot] = raceTime;
      }
    }

    if (!subject) return;

    const seat = state?.racers.get(subject.id);
    const progress = subject.progress;
    const own = subject.vehicle !== null;
    const pose = subject.pose;
    const done = own ? progress.lap : (seat?.lap ?? progress.lap);
    // The room's times once it has them, so the plate reads what the FINISHED callout and the results say.
    const finishTime =
      seat && seat.finishTime > 0 ? seat.finishTime : own && progress.finished ? progress.finishTime * 1000 : 0;

    frame.place = seat ? seat.rank : progress.rank;
    frame.lap = Math.max(1, Math.min(laps, done + 1));
    frame.raceTime = finishTime > 0 ? finishTime : raceTime;
    frame.lapTime =
      raceTime <= 0 ? 0 : own ? (race.rules.time - progress.lapStart) * 1000 : raceTime - this._lapStart[subject.slot];
    frame.bestLap = seat && seat.bestLap > 0 ? seat.bestLap : own ? Math.max(0, progress.bestLap * 1000) : 0;
    frame.speedKmh = pose.speed * KMH_PER_UNIT;
    frame.charge = subject.boost ? subject.boost.charge : pose.charge / CHARGE_READY;
    frame.boosting = pose.boosting;
  }

  /** Metres round the race a truck has come: the room's laps and progress, as every screen sees them. */
  private _distance(session: Session | null, truck: Racer): number {
    const seat = session?.state.racers.get(truck.id);

    if (!seat) return Math.max(0, truck.progress.distance);

    return (seat.lap + seat.progress) * this._game.course.route.lapLength;
  }

  private _gap(session: Session | null, truck: Racer, raceTime: number): number {
    const at = Math.floor(this._distance(session, truck) / GAP_STEP);

    if (raceTime <= 0 || at < 0 || at > this._reached) return 0;

    return Math.max(0, raceTime - this._passed[at]);
  }

  private _finishGap(session: Session | null, seat: Seat | undefined): number {
    const results = session?.state.results;

    if (!seat || !results || results.length === 0) return 0;

    return Math.max(0, seat.finishTime - results[0].time);
  }

  /** Where a truck's name tag hangs on screen, and whether it shows: never for a dropped player's faded truck. */
  private _tag(out: HudRacer, truck: Racer, width: number, height: number): void {
    const pose = truck.pose;

    _tagPoint.x = pose.x;
    _tagPoint.y = pose.y + TAG_HEIGHT;
    _tagPoint.z = pose.z;

    const point = this._view.worldToScreen(_tagPoint, _screen);
    const distance = this._game.listenerDistance(_tagPoint.x, _tagPoint.y, _tagPoint.z);

    out.distance = distance;

    if (!point) {
      out.tagVisible = false;

      return;
    }

    out.screenX = point.x;
    out.screenY = point.y;
    out.tagVisible =
      truck.model.root.visible &&
      !truck.ghost &&
      distance > TAG_NEAR &&
      distance < TAG_FAR &&
      point.x > -TAG_MARGIN &&
      point.y > -TAG_MARGIN &&
      point.x < width + TAG_MARGIN &&
      point.y < height + TAG_MARGIN;
  }
}
