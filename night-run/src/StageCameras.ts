import type { CameraState, VirtualCamera } from '@kvvasuu/klipp';
import { BlendCurves, createCameraState, updateHardLookAt } from '@kvvasuu/klipp';

import type { CameraRig } from './CameraRig';
import type { ChaseFraming } from './ChaseBody';
import { ChaseBody } from './ChaseBody';
import { Dolly } from './Dolly';
import { inFrame, keepInFrame, lookToFrame } from './framing';
import { clamp, lerp, smoothstep } from './MathUtils';
import type { Race } from './Race';
import type { TrackSpot } from './race/RaceRules';
import type { Route } from './race/route';
import type { TruckPose } from './race/truck';
import { createTruckPose } from './race/truck';
import type { Racer } from './Racer';
import { Spring } from './Spring';

/**
 * The staging shots: the title's attract race, the lobby's grid, the player's own truck behind the truck picker, the
 * countdown's start and the results' podium.
 */
export type StageShot = 'attract' | 'lobby' | 'garage' | 'start' | 'podium';

/** Outranks every race camera, the photo finish included. */
const STAGE_PRIORITY = 60;
/**
 * The point the attract camera follows moving this much further in a frame than its truck's speed takes it was put back
 * on the track, not driven there.
 */
const RESPAWN_JUMP = 1;

/** Route distance of the grid's middle, between its two rows. */
const GRID_MIDDLE = -2.55;
/**
 * The podium's layout: the winner's block centre this far down the straight past the line, clear of the next corner's
 * kerb; second and third this far either side and this far further on; and how far second and third turn in toward the
 * winner, in radians. Each truck stands square on its block, both turned the same way.
 */
const PODIUM_S = 8.8;
const PODIUM_SPREAD = 1.8;
const PODIUM_SET_BACK = 0.15;
const PODIUM_TURN = 0.45;
/** Where the podium shot's lens stands: just past the arch's face, so the arch stays behind it on every screen. */
const PODIUM_LENS_S = 1.3;
/**
 * The podium shot on a landscape screen and on a tall phone, blended by {@link CameraRig.portrait}: how high the lens
 * stands, how far it sways, its lens, and where the podium's middle sits on screen, `down` (0 top, 1 bottom) and
 * `across` (0 left, 1 right). It looks down onto the blocks so their tops show, with the sky above for the fireworks,
 * and the podium sits in the band 55 to 80 % down the screen that the results leave clear for it: left of the results
 * table and buttons on a landscape screen, under the table on a tall phone, whose narrow frame needs the wide lens to
 * fit second and third and their tags in.
 */
const PODIUM_WIDE = { height: 2.8, sway: 0.3, fov: 46, down: 0.66, across: 0.29 } as const;
const PODIUM_TALL = { height: 2.1, sway: 0.2, fov: 84, down: 0.62, across: 0.5 } as const;
/** The point on the podium the shot frames, above the track: the middle of the trucks on their blocks. */
const PODIUM_FOCUS_Y = 0.9;
/** A landscape screen squarer than 16:9 sets the podium nearer the middle, all the way there at this aspect. */
const PODIUM_CENTRED_ASPECT = 1.3;
/**
 * The podium and start shots open away from where they settle and move in over this many seconds: the cut to them
 * lands on a move rather than a still.
 */
const PUSH_SECONDS = 2.2;
/** How much higher the podium shot opens before it cranes down: the arch stands right behind it, so it can't back up. */
const PODIUM_CRANE = 0.6;
/**
 * The start shot over the player's truck on a landscape screen and on a tall phone: how far back and up the lens sits,
 * where the truck's middle sits down the screen (0 top, 1 bottom), and the lens. The countdown's lamps and numerals
 * own the top half of the screen, so the truck's top stays below 58 % of the way down. The arch's sign hangs right over
 * the front row, so the lens stays under it, looking down far enough that the sign stays above the top of the screen
 * from either row rather than showing as a fragment. The shot opens a little higher and off to one side, and swings
 * down and round onto the truck as the lights count down; a tall phone's narrow frame swings less, or a corner of the
 * sign would show.
 */
const START_WIDE = { back: 3, height: 3.6, rise: 0.15, side: 1.3, middle: 0.75, fov: 58 } as const;
const START_TALL = { back: 2.5, height: 3.6, rise: 0.15, side: 0.5, middle: 0.75, fov: 66 } as const;
/** How far the start shot sways to either side once settled. */
const START_SWAY = 0.25;
/** The point on the truck the start shot frames, above its root. */
const START_FOCUS_Y = 0.45;
/**
 * Seconds after GO the start shot takes to turn into the chase camera's own framing as the truck pulls away, then
 * cuts to it: klipp blends from a still picture of the outgoing shot, which a launching truck would leave behind.
 */
export const START_HANDOVER = 0.9;
/**
 * The lobby's grid shot on a tall phone stands above the arch's sign and tilts up a little, so the sign sits a third of
 * the way down and the screen's title reads over the sky and the treeline.
 */
const LOBBY_PORTRAIT_RISE = 2.9;
const LOBBY_PORTRAIT_LOOK_RISE = 0.77;
/**
 * The garage shot, the player's own truck behind the truck picker, on a landscape screen and on a tall phone: a
 * three-quarter view from in front and to the truck's outer side, the lens this far off and this high, and where the
 * truck sits on screen, clear of the picker's panel: left of it on a landscape screen (further left on a wide phone,
 * whose panel is wider), above it on a tall phone. It opens {@link GARAGE_PUSH} further out and pushes in.
 */
const GARAGE_WIDE = { distance: 3, height: 1.25, fov: 40, across: 0.3, down: 0.6, angle: 0.6 } as const;
const GARAGE_TALL = { distance: 3.9, height: 1.7, fov: 52, across: 0.5, down: 0.27, angle: 0.3 } as const;
/**
 * How far the garage lens sways either side of where it stands, in radians round the truck. It stands `angle` round from
 * straight ahead of the truck toward its outer side: less on a tall phone, whose lens stands further off and would
 * otherwise reach the arch's leg.
 */
const GARAGE_SWAY = 0.2;
const GARAGE_PUSH = 0.8;
/** A landscape screen wider than 16:9 puts the truck this much further left per unit of aspect, to no less than {@link GARAGE_ACROSS_MIN}. */
const GARAGE_ACROSS_PER_ASPECT = 0.25;
const GARAGE_ACROSS_MIN = 0.18;
/** The point on the truck the garage shot frames, above its root. */
const GARAGE_FOCUS_Y = 0.4;
/** How far past the garage shot's lens its sight line has to be clear of scenery. */
const GARAGE_CLEARANCE = 0.25;

const _point = { x: 0, y: 0, z: 0 };
const _look: [number, number, number] = [0, 0, 0];
const _spot = { s: 0, lateral: 0, heading: 0 };
const _chase = createCameraState();

/**
 * The attract camera is a chase, the race's own body with a longer lens and lazier springs, on a landscape screen and
 * on a tall phone, whose truck sits in the band between the title and the menu: a little further back and higher than
 * the race's, so the view runs on down the road past its truck. Its bearing is the attract's own, the road's averaged
 * ({@link ATTRACT_LEAD}), eased over about a third of a second rather than a sixth, and it swings and pulls in round the
 * scenery slowly enough to read as one move. Its lens is this many degrees tall.
 */
const ATTRACT_CHASE: ChaseFraming = {
  wide: { back: 4.8, height: 2.4, middle: 0.6 },
  tall: { back: 5, height: 3.3, middle: 0.42 },
  shortMiddle: 0.6,
  speedRise: 0,
  routeFollow: 0,
  maxShift: 0.2,
  bearingHalfLife: 0.12,
  yawTime: 0.35,
  leanTime: 0.8,
  elevationTime: 0.45,
  armInTime: 0.4,
  armOutTime: 1.6,
};
const ATTRACT_FOV = { wide: 46, tall: 60 } as const;
/**
 * The attract chase stands behind its truck along the road, looking from no further than this either side of the
 * centreline, so it keeps over the tarmac clear of the trees and tents beside it. Its bearing is the way the road runs
 * from there to the truck, averaged over the road the truck covers from {@link ATTRACT_LEAD} seconds before to as long
 * after, so a corner turns the lens as smoothly as a spring would. The average takes this many steps either side.
 */
const ATTRACT_LATERAL = 1.5;
const ATTRACT_LEAD = 0.6;
const ATTRACT_LEAD_STEPS = 4;
/**
 * The chase's springs swing the lens round its truck about this many seconds late, so the average is taken round the
 * point the truck reaches that much later. Without it the lens comes out of a corner still pointing the way the truck
 * went in, and cuts across the corner's inside, where the posts, trees and tents fill the open side of the screen.
 */
const ATTRACT_LAG = 0.3;
/** The attract chase drifts round its truck this many radians either side, this many radians a second. */
const ATTRACT_SWAY = 0.12;
const ATTRACT_SWAY_RATE = 0.23;
/**
 * The attract camera moves up to the truck ahead only when it sees it well inside the open part of the screen, clear of
 * this share of the box's width and height at each side, and within this many metres ahead of the one it follows along
 * the road, on a landscape screen and on a tall phone, whose narrow frame loses a truck further off as the lens moves; and
 * no more often than every {@link SWITCH_EVERY} seconds. The point it follows eases over from one truck to the other in
 * {@link SWITCH_SECONDS}, quicker on a tall phone for the same reason, and to where a truck put back on the track lands
 * the same way.
 */
const SWITCH_INSET = 0.2;
const SWITCH_RANGE = { wide: 12, tall: 6 } as const;
const SWITCH_EVERY = 15;
const SWITCH_SECONDS = { wide: 4, tall: 3 } as const;
/**
 * The sight line to a truck the attract camera moves on to stays this far from the scenery, and the truck is at least
 * this share of its distance along the road away in a straight line, so the point never eases over across a hairpin.
 */
const SWITCH_SIGHT_PAD = 0.15;
const SWITCH_STRAIGHT = 0.75;
/**
 * The truck the attract camera moves up to is at least this far ahead of its own, and should it drop this far behind
 * the one it's leaving while the point eases over, as when it crashes, the point eases back to that one. A truck slower
 * than this many metres a second, crashed or stuck, may be left for one ahead sooner than {@link SWITCH_EVERY}.
 */
const SWITCH_AHEAD = 1.5;
const SWITCH_SLOW = 3;
/**
 * The point the attract camera follows rides along at its truck's velocity smoothed over {@link FOCUS_CARRY} seconds
 * and catches up with the truck itself over {@link FOCUS_PULL}, so two trucks bumping don't jolt the lens; its height
 * eases over {@link FOCUS_RISE}.
 */
const FOCUS_CARRY = 0.2;
const FOCUS_PULL = 0.2;
const FOCUS_RISE = 0.2;
/**
 * Seconds the view takes, once the followed point sets off for a truck, to go from keeping what it kept in the open
 * part of the screen to keeping the truck there.
 */
const KEEP_EASE = 0.5;
/**
 * Where scenery comes between the garage shot and its truck, the lens pulls in toward the truck, to no nearer than
 * {@link GARAGE_KEEP} of the way, its sight line kept {@link GARAGE_PAD} from the scenery; it pulls in and eases back
 * out at these shares of the way per second.
 */
const GARAGE_KEEP = 0.4;
const GARAGE_PAD = 0.3;
const KEEP_IN_SPEED = 3;
const KEEP_OUT_SPEED = 0.6;
/**
 * The title's menu fills the left of a landscape screen and the bottom half of a tall phone, so the attract camera
 * frames its truck in the open part: this far across a landscape screen, and inside this box on each, 0 to 1 from the
 * left and from the top. Where the smoothed point it follows runs wide of the truck, and while it eases over to
 * another, the view turns to keep the truck in the box; the truck it moves on to has to show well inside it.
 */
const ATTRACT_ACROSS = 0.66;
const ATTRACT_BOX = {
  wide: { left: 0.42, right: 0.95, top: 0.12, bottom: 0.88 },
  tall: { left: 0.12, right: 0.88, top: 0.3, bottom: 0.5 },
} as const;
/** The point on the attract camera's truck it keeps in sight and in frame, above the truck's root. */
const ATTRACT_FOCUS_Y = 0.45;

/**
 * The staging cameras, all klipp virtual cameras on the race rig's {@link CameraRig.klipp}, so they blend with the race
 * cameras and each other:
 *
 * - **attract**: the title's backdrop, one unbroken take with no cuts: a chase low behind one truck, looking down the
 *   road ahead of it, the race chase's own {@link ChaseBody} with a longer lens and lazier springs, drifting gently
 *   round its truck. It always looks along the road, so a truck that spins or is put back on the track never swings it
 *   round. It moves on to another truck it sees just ahead, and past a truck put back on the track, by easing the point
 *   it follows over, smoothed so bumps between trucks never jolt the lens.
 * - **lobby**: a slow dolly across the front of the grid, looking back under the arch at the trucks in their slots.
 * - **podium**: the top three placed on the straight past the line, the lens drifting in an arc in front of them.
 *
 * Show one with {@link StageCameras.show}; `null` hands the screen back to the race cameras.
 */
export class StageCameras {
  /** The shot showing, or null while the race cameras run. */
  public shot: StageShot | null = null;
  /** The podium's winner, the truck the podium shot is about. */
  public winner: Racer | null = null;
  /** Seconds since GO, negative through the countdown; the game keeps it while the start shot shows. */
  public sinceGo = -Infinity;

  private readonly _rig: CameraRig;
  private readonly _attract: VirtualCamera;
  private readonly _lobby: VirtualCamera;
  private readonly _garage: VirtualCamera;
  private readonly _start: VirtualCamera;
  private readonly _podium: VirtualCamera;
  /** One smoothed rig per camera. */
  private readonly _dollies: Record<'lobby' | 'garage' | 'start' | 'podium', Dolly> = {
    lobby: new Dolly(),
    garage: new Dolly(),
    start: new Dolly(),
    podium: new Dolly(),
  };
  /** The truck the start shot looks over, the player's. */
  private _startSubject: Racer | null = null;
  private readonly _race: Race;
  private _time = 0;
  /** The truck the attract camera is about, and the one it's easing over from, if any. */
  private _subject: Racer | null = null;
  private _leaving: Racer | null = null;
  /**
   * The point the attract camera follows, on its truck's root, and how far from its truck it set off on its way over,
   * the ease this many seconds in.
   */
  private readonly _focus: [number, number, number] = [0, 0, 0];
  private _shiftX = 0;
  private _shiftZ = 0;
  private _shiftTime = Infinity;
  /**
   * The point the view keeps in the open part of the screen, and where it eases over from when the followed point sets
   * off: this far from the followed point.
   */
  private readonly _kept: [number, number, number] = [0, 0, 0];
  private readonly _keptFrom: [number, number, number] = [0, 0, 0];
  /** Where the followed point's truck, or the way over to it, was last frame, and the point's smoothed velocity. */
  private _rawX = 0;
  private _rawZ = 0;
  private readonly _carryX = new Spring();
  private readonly _carryZ = new Spring();
  private readonly _focusY = new Spring();
  /** Seconds since the attract camera last moved on to another truck. */
  private _sinceSwitch = 0;
  /**
   * The attract camera's chase, and what it chases: the followed point, facing along the road and going the way the
   * point goes.
   */
  private readonly _chase: ChaseBody;
  private readonly _chased = createTruckPose();
  /** How much of the way out to where it wants to be the garage shot stands its lens: 1 all the way. */
  private _garageKeep = 1;
  /** Seconds since the garage, start and podium shots came on, for their push-in. */
  private _garageTime = 0;
  private _startTime = 0;
  private _podiumTime = 0;

  /**
   * @param rig - The race cameras; the staging shots join its klipp.
   * @param race - The race the shots look at.
   */
  constructor(rig: CameraRig, race: Race) {
    this._rig = rig;
    this._race = race;
    this._chase = new ChaseBody(rig.occluders, race.course, ATTRACT_CHASE);
    this._chase.subject = this._chased;

    const klipp = rig.klipp;
    const add = (name: string, body: (out: CameraState, dt: number, justActivated: boolean) => void) => {
      const camera = klipp.addCamera(name, { priority: STAGE_PRIORITY, active: false });

      camera.body = { update: body };

      return camera;
    };

    this._attract = add('attract', (out, dt, snap) => this._attractShot(out, dt, snap));
    this._lobby = add('lobby', (out, dt, snap) => this._grid(out, dt, snap));
    this._garage = add('garage', (out, dt, snap) => this._garageShot(out, dt, snap));
    this._start = add('start', (out, dt, snap) => this._startShot(out, dt, snap));
    this._podium = add('podium', (out, dt, snap) => this._podiumShot(out, dt, snap));

    const cut = { curve: BlendCurves.cut, time: 0 };

    // The start and podium shots cut in behind the screen's own wipe and push in from there: a blend from wherever the
    // last camera was would fly through the arch or over the trees on its way. The title's attract race cuts to the
    // lobby, and anything cuts back to it, for the same reason; the attract camera eases between its own moves itself.
    rig.addCustomBlends([
      { to: 'attract', blend: cut },
      { to: 'lobby', blend: { curve: BlendCurves.easeInOut, time: 2 } },
      { to: 'garage', blend: { curve: BlendCurves.easeInOut, time: 1.1 } },
      { from: 'garage', to: 'lobby', blend: { curve: BlendCurves.easeInOut, time: 1.1 } },
      { from: 'attract', to: 'lobby', blend: cut },
      { to: 'start', blend: cut },
      { from: 'start', blend: { curve: BlendCurves.easeInOut, time: 1.6 } },
      { from: 'start', to: 'chase', blend: cut },
      { to: 'podium', blend: cut },
    ]);
  }

  /** Takes the staging cameras off the rig's klipp. */
  public destroy(): void {
    const klipp = this._rig.klipp;

    klipp.remove(this._attract);
    klipp.remove(this._lobby);
    klipp.remove(this._garage);
    klipp.remove(this._start);
    klipp.remove(this._podium);
    this.shot = null;
    this.winner = null;
    this._startSubject = null;
    this._subject = null;
    this._leaving = null;
    this._chase.subject = null;
  }

  /**
   * Put a staging shot on screen, or hand back to the race cameras.
   * @param shot - Which, or null for the race cameras.
   */
  public show(shot: StageShot | null): void {
    if (shot === this.shot) return;

    this.shot = shot;
    this.sinceGo = -Infinity;
    this._startSubject = this._race.local ?? this._racerAt(0);
    this._rig.setGameActive(shot === null);
    this._lobby.active = shot === 'lobby';
    this._garage.active = shot === 'garage';
    this._start.active = shot === 'start';
    this._podium.active = shot === 'podium';

    this._attract.active = shot === 'attract';

    // A new truck each time the title comes back.
    if (shot === 'attract') {
      this._subject = this._nextSubject();
      this._leaving = null;
      this._shiftTime = Infinity;
      this._sinceSwitch = 0;
    }
  }

  /** The truck the shot is about, for the look's focus and streaks: the attract camera's subject, or the winner. */
  public get subject(): Racer | null {
    if (this.shot === 'attract') return this._subject;
    if (this.shot === 'podium') return this.winner ?? this._racerAt(0);
    if (this.shot === 'start' || this.shot === 'garage') return this._startSubject;

    return null;
  }

  /**
   * Advance the shots' clocks, and move the attract camera off a truck that has left the race. Call every frame before
   * klipp updates.
   * @param dt - Real seconds since the last frame.
   */
  public update(dt: number): void {
    this._time += dt;

    this._garageTime += dt;
    this._startTime += dt;
    this._podiumTime += dt;

    if (this.shot !== 'attract') return;

    this._sinceSwitch += dt;
    this._shiftTime += dt;

    const subject = this._subject;

    if (subject && !this._race.racers.includes(subject)) this._switchTo(this._nextSubject());
  }

  /**
   * Where the podium puts a place and which way it faces: the winner on the straight past the line, facing back down it
   * toward the lens, second and third a step back either side, turned in toward the winner; anyone further back waits
   * out of shot behind the grid. The place's block and its truck share the spot. The top three stand on the straight
   * after the line, which is the same on every track.
   * @param route - The track's route.
   * @param place - 1 for the winner.
   * @param out - Receives the spot.
   * @returns `out`.
   */
  public static podiumSpot(route: Route, place: number, out: TrackSpot): TrackSpot {
    const flank = place === 2 ? -1 : place === 3 ? 1 : 0;
    const s = place <= 3 ? PODIUM_S + Math.abs(flank) * PODIUM_SET_BACK : -14 - place * 2;

    // Lateral counts to the driver's right, and a larger yaw turns to their left: second, on the lens's left, stands to
    // the left of the line and turns to its own left, toward the winner.
    out.yaw = route.point(s, flank * PODIUM_SPREAD, out) + Math.PI - flank * PODIUM_TURN;

    return out;
  }

  /**
   * Move the attract camera on to another truck, easing the point it follows over from wherever it is now: it rides
   * along with the new truck from the start, the gap closing, so a truck left behind crashed never holds it back.
   */
  private _switchTo(next: Racer | null): void {
    this._leaving = this._subject && this._race.racers.includes(this._subject) ? this._subject : null;
    this._subject = next;
    this._shiftX = this._rawX - (next?.pose.x ?? 0);
    this._shiftZ = this._rawZ - (next?.pose.z ?? 0);
    this._sinceSwitch = 0;
    this._setOff();
  }

  /** Start the followed point's ease over, the point the view keeps in frame easing on from where it is. */
  private _setOff(): void {
    const focus = this._focus;
    const kept = this._kept;
    const from = this._keptFrom;

    from[0] = kept[0] - focus[0];
    from[1] = kept[1] - focus[1];
    from[2] = kept[2] - focus[2];
    this._shiftTime = 0;
  }

  /** The truck the attract camera moves on to: the nearest other one, in the same stretch of race. */
  private _nextSubject(): Racer | null {
    const racers = this._race.racers;
    const current = this._subject;
    let best: Racer | null = racers[0] ?? null;
    let nearest = Infinity;

    for (const racer of racers) {
      if (racer === current || !current) continue;

      const d = Math.hypot(racer.pose.x - current.pose.x, racer.pose.z - current.pose.z);

      if (d < nearest) {
        nearest = d;
        best = racer;
      }
    }

    return best;
  }

  private _racerAt(rank: number): Racer | null {
    const entry = this._race.rules.standings[rank];

    return entry ? (this._race.getRacer(entry.id) ?? null) : null;
  }

  /**
   * The attract camera: a chase behind the point it follows, looking down the road, with the truck kept in the open
   * part of the frame.
   */
  private _attractShot(out: CameraState, dt: number, snap: boolean): void {
    const subject = this._subject;

    if (!subject) return;

    this._follow(subject, dt, snap);

    const portrait = this._rig.portrait;
    const focus = this._focus;
    const chased = this._chased;
    const chase = this._chase;
    const fov = lerp(ATTRACT_FOV.wide, ATTRACT_FOV.tall, portrait);

    // Facing and going the way the road runs, whichever way the truck faces: a truck sliding, spinning or put back on the
    // track never swings the lens round it.
    chased.x = focus[0];
    chased.y = focus[1] - ATTRACT_FOCUS_Y;
    chased.z = focus[2];
    chased.yaw = this._attractBearing(subject.pose.speed, portrait);
    chased.heading = chased.yaw;
    chase.portrait = portrait;
    chase.aspect = this._aspect();
    chase.fov = fov;
    chase.across = lerp(ATTRACT_ACROSS, 0.5, portrait);
    chase.swing = Math.sin(this._time * ATTRACT_SWAY_RATE) * ATTRACT_SWAY;
    chase.update(out, snap ? 0 : dt);
    out.fov = fov;

    // The view turns just enough to keep the truck in the open part of the screen, where the smoothed point it follows
    // runs wide of it, and on the way over to another truck. Each time the point sets off for a truck the view eases
    // from keeping what it kept to keeping the truck, so it never jumps to it.
    const p = out.position;
    const pose = subject.pose;
    const keep = snap ? 1 : smoothstep(Math.min(1, this._shiftTime / KEEP_EASE));
    const kept = this._kept;
    const from = this._keptFrom;
    const wide = ATTRACT_BOX.wide;
    const tall = ATTRACT_BOX.tall;

    _look[0] = out.lookAtTarget[0];
    _look[1] = out.lookAtTarget[1];
    _look[2] = out.lookAtTarget[2];
    kept[0] = lerp(focus[0] + from[0], pose.x, keep);
    kept[1] = lerp(focus[1] + from[1], pose.y + ATTRACT_FOCUS_Y, keep);
    kept[2] = lerp(focus[2] + from[2], pose.z, keep);
    keepInFrame(
      _look,
      p[0],
      p[1],
      p[2],
      kept[0],
      kept[1],
      kept[2],
      fov,
      this._aspect(),
      lerp(wide.left, tall.left, portrait),
      lerp(wide.right, tall.right, portrait),
      lerp(wide.top, tall.top, portrait),
      lerp(wide.bottom, tall.bottom, portrait),
    );
    updateHardLookAt(out, _look);

    const leaving = this._leaving;

    if (leaving && this._ahead(subject.pose, leaving.pose) < -SWITCH_AHEAD) this._switchTo(leaving);
    else if (!leaving && (this._sinceSwitch > SWITCH_EVERY || pose.speed < SWITCH_SLOW)) this._findNext(out, subject);
  }

  /**
   * The way the attract chase looks along the road at the point it follows: from behind it, near the centreline, to the
   * point, averaged over the road a moment either side of where the point will be once the lens catches up.
   */
  private _attractBearing(speed: number, portrait: number): number {
    const focus = this._focus;
    const route = this._race.course.route;
    const spot = route.project(focus[0], focus[2], _spot);
    const pace = Math.max(speed, 4);
    const s = spot.s + pace * ATTRACT_LAG;
    const lateral = spot.lateral;
    const back = lerp(ATTRACT_CHASE.wide.back, ATTRACT_CHASE.tall.back, portrait);
    const from = clamp(lateral, -ATTRACT_LATERAL, ATTRACT_LATERAL);
    const step = (pace * ATTRACT_LEAD) / ATTRACT_LEAD_STEPS;
    let x = 0;
    let z = 0;

    for (let k = -ATTRACT_LEAD_STEPS; k <= ATTRACT_LEAD_STEPS; k++) {
      route.point(s + k * step - back, from, _point);

      const bx = _point.x;
      const bz = _point.z;

      route.point(s + k * step, lateral, _point);

      const length = Math.hypot(_point.x - bx, _point.z - bz) || 1;

      x += (_point.x - bx) / length;
      z += (_point.z - bz) / length;
    }

    return Math.atan2(x, z);
  }

  /**
   * Put {@link _focus} on the attract camera's truck, or on the way over to it from the truck it's leaving. A truck put
   * back on the track jumps, so the point eases over to where it landed instead.
   */
  private _follow(subject: Racer, dt: number, snap: boolean): void {
    const pose = subject.pose;
    const focus = this._focus;
    const ease = lerp(SWITCH_SECONDS.wide, SWITCH_SECONDS.tall, this._rig.portrait);
    const w = snap ? 1 : smoothstep(Math.min(1, this._shiftTime / ease));
    let x = pose.x + this._shiftX * (1 - w);
    let z = pose.z + this._shiftZ * (1 - w);
    const y = pose.y + ATTRACT_FOCUS_Y;

    if (w >= 1) this._leaving = null;

    if (snap) {
      this._carryX.reset(Math.sin(pose.heading) * pose.speed);
      this._carryZ.reset(Math.cos(pose.heading) * pose.speed);
      this._focusY.reset(y);
      focus[0] = x;
      focus[2] = z;
    } else {
      if (Math.hypot(x - this._rawX, z - this._rawZ) > RESPAWN_JUMP + pose.speed * dt) {
        this._leaving = null;
        this._shiftX = this._rawX - pose.x;
        this._shiftZ = this._rawZ - pose.z;
        this._setOff();
        x = this._rawX;
        z = this._rawZ;
      }

      this._carryX.update((x - this._rawX) / Math.max(dt, 1e-3), FOCUS_CARRY, dt);
      this._carryZ.update((z - this._rawZ) / Math.max(dt, 1e-3), FOCUS_CARRY, dt);
      this._focusY.update(y, FOCUS_RISE, dt);

      const pull = 1 - Math.exp(-dt / FOCUS_PULL);

      focus[0] += this._carryX.value * dt;
      focus[2] += this._carryZ.value * dt;
      focus[0] += (x - focus[0]) * pull;
      focus[2] += (z - focus[2]) * pull;
    }

    focus[1] = this._focusY.value;
    this._rawX = x;
    this._rawZ = z;
  }

  /**
   * Move the attract camera up to a truck it sees just ahead: well inside the open part of the screen, within
   * {@link SWITCH_RANGE} ahead of its own along the road, on the same stretch of it, and in clear view.
   */
  private _findNext(out: CameraState, subject: Racer): void {
    const racers = this._race.racers;
    const portrait = this._rig.portrait;
    const wide = ATTRACT_BOX.wide;
    const tall = ATTRACT_BOX.tall;
    const p = out.position;
    const range = lerp(SWITCH_RANGE.wide, SWITCH_RANGE.tall, portrait);
    const left = lerp(wide.left, tall.left, portrait);
    const right = lerp(wide.right, tall.right, portrait);
    const top = lerp(wide.top, tall.top, portrait);
    const bottom = lerp(wide.bottom, tall.bottom, portrait);
    const across = (right - left) * SWITCH_INSET;
    const down = (bottom - top) * SWITCH_INSET;

    for (let i = 0; i < racers.length; i++) {
      const pose = racers[i].pose;
      const y = pose.y + ATTRACT_FOCUS_Y;
      const ahead = this._ahead(pose, subject.pose);

      if (
        racers[i] !== subject &&
        ahead > SWITCH_AHEAD &&
        ahead < range &&
        Math.hypot(pose.x - subject.pose.x, pose.z - subject.pose.z) > ahead * SWITCH_STRAIGHT &&
        inFrame(
          _look,
          p[0],
          p[1],
          p[2],
          pose.x,
          y,
          pose.z,
          out.fov ?? 45,
          this._aspect(),
          left + across,
          right - across,
          top + down,
          bottom - down,
        ) &&
        this._rig.occluders.segmentHit(pose.x, y, pose.z, p[0], p[1], p[2], SWITCH_SIGHT_PAD) >= 1
      ) {
        this._switchTo(racers[i]);

        return;
      }
    }
  }

  /** How far one truck is ahead of another along the road, negative when it's behind. */
  private _ahead(pose: Readonly<TruckPose>, of: Readonly<TruckPose>): number {
    const route = this._race.course.route;
    const own = route.project(of.x, of.z, _spot).s;
    const half = route.lapLength / 2;

    return route.wrap(route.project(pose.x, pose.z, _spot).s - own + half) - half;
  }

  private _aspect(): number {
    const klipp = this._rig.klipp;

    return klipp.height > 0 ? klipp.width / klipp.height : 16 / 9;
  }

  /**
   * Pulls the garage shot's lens in along its sight line to the truck while a tent, pole or the arch stands between
   * them, to no nearer than {@link GARAGE_KEEP} of the way, and eases it back out once the way is clear.
   */
  private _keepClear(
    out: CameraState,
    pose: Readonly<TruckPose>,
    look: [number, number, number],
    dt: number,
    snap: boolean,
  ): void {
    const p = out.position;
    const fy = pose.y + 0.45;
    const dx = p[0] - pose.x;
    const dy = p[1] - fy;
    const dz = p[2] - pose.z;
    const length = Math.hypot(dx, dy, dz);
    let want = 1;

    if (length > 0.01) {
      const reach = (length + GARAGE_CLEARANCE) / length;
      const t = this._rig.occluders.segmentHit(
        pose.x,
        fy,
        pose.z,
        pose.x + dx * reach,
        fy + dy * reach,
        pose.z + dz * reach,
        GARAGE_PAD,
      );

      if (t < 1) want = Math.max(GARAGE_KEEP, t * reach - (reach - 1));
    }

    const was = this._garageKeep;
    const keep = snap
      ? want
      : want < was
        ? Math.max(want, was - dt * KEEP_IN_SPEED)
        : Math.min(want, was + dt * KEEP_OUT_SPEED);

    this._garageKeep = keep;

    if (keep >= 1) return;

    p[0] = pose.x + dx * keep;
    p[1] = fy + dy * keep;
    p[2] = pose.z + dz * keep;
    updateHardLookAt(out, look);
  }

  /** In front of the grid, dollying slowly across it and looking back under the arch at the trucks. */
  private _grid(out: CameraState, dt: number, snap: boolean): void {
    const t = this._time;
    const portrait = this._rig.portrait;
    const route = this._race.course.route;

    route.point(GRID_MIDDLE + 6.4 + portrait * 4, Math.sin(t * 0.17) * 2.4, _point);

    const x = _point.x;
    const z = _point.z;

    route.point(GRID_MIDDLE, 0, _point);
    this._dollies.lobby.fov = 40 + portrait * 16;
    this._dollies.lobby.write(
      out,
      x,
      1.6 + portrait * LOBBY_PORTRAIT_RISE + Math.sin(t * 0.11) * 0.25,
      z,
      _point.x,
      0.35 + portrait * LOBBY_PORTRAIT_LOOK_RISE,
      _point.z,
      0,
      0,
      false,
      dt,
      snap,
      0.6,
    );
  }

  /**
   * The player's own truck in its slot on the grid, three-quarter on from in front and to its outer side, pushing in and
   * swaying gently, placed beside or above the truck picker's panel.
   */
  private _garageShot(out: CameraState, dt: number, snap: boolean): void {
    const pose = this._startSubject?.pose;

    if (!pose) return;

    if (snap) this._garageTime = 0;

    const rig = this._rig;
    const portrait = rig.portrait;
    const wide = GARAGE_WIDE;
    const tall = GARAGE_TALL;
    const aspect = rig.klipp.height > 0 ? rig.klipp.width / rig.klipp.height : 16 / 9;
    const fov = lerp(wide.fov, tall.fov, portrait);
    const distance =
      lerp(wide.distance, tall.distance, portrait) + GARAGE_PUSH * (1 - smoothstep(this._garageTime / PUSH_SECONDS));
    // Round to the truck's outer side, away from the middle of the road where the other trucks are. Lateral counts to
    // the driver's right, and a larger yaw turns to their left.
    this._race.course.route.project(pose.x, pose.z, _spot);

    const outward = _spot.lateral >= 0 ? -1 : 1;
    const angle =
      pose.yaw + outward * (lerp(wide.angle, tall.angle, portrait) + Math.sin(this._time * 0.25) * GARAGE_SWAY);
    const x = pose.x + Math.sin(angle) * distance;
    const y = pose.y + lerp(wide.height, tall.height, portrait);
    const z = pose.z + Math.cos(angle) * distance;
    const across = lerp(
      clamp(wide.across - (aspect - 16 / 9) * GARAGE_ACROSS_PER_ASPECT, GARAGE_ACROSS_MIN, wide.across),
      tall.across,
      portrait,
    );
    // Turning the view toward a smaller yaw, to the right, moves the truck left across the screen.
    const lean = Math.atan((2 * across - 1) * aspect * Math.tan((fov * Math.PI) / 360));

    lookToFrame(
      _look,
      x,
      y,
      z,
      pose.x,
      pose.y + GARAGE_FOCUS_Y,
      pose.z,
      lerp(wide.down, tall.down, portrait),
      fov,
      lean,
    );
    this._dollies.garage.fov = fov;
    this._dollies.garage.write(out, x, y, z, _look[0], _look[1], _look[2], pose.x, pose.z, false, dt, snap, 0.5);
    this._keepClear(out, pose, this._dollies.garage.look, dt, snap);
  }

  /** Above and behind the player's truck on the grid, craning down onto it as the countdown runs. */
  private _startShot(out: CameraState, dt: number, snap: boolean): void {
    const pose = this._startSubject?.pose;

    if (!pose) return;

    if (snap) this._startTime = 0;

    const wide = START_WIDE;
    const tall = START_TALL;
    const portrait = this._rig.portrait;
    const push = 1 - smoothstep(this._startTime / PUSH_SECONDS);
    const back = lerp(wide.back, tall.back, portrait);
    const fov = lerp(wide.fov, tall.fov, portrait);
    const fx = Math.sin(pose.yaw);
    const fz = Math.cos(pose.yaw);
    const side = push * lerp(wide.side, tall.side, portrait) + Math.sin(this._time * 0.3) * START_SWAY;
    const x = pose.x - fx * back + fz * side;
    const y = pose.y + lerp(wide.height, tall.height, portrait) + push * lerp(wide.rise, tall.rise, portrait);
    const z = pose.z - fz * back - fx * side;

    lookToFrame(_look, x, y, z, pose.x, pose.y + START_FOCUS_Y, pose.z, lerp(wide.middle, tall.middle, portrait), fov);
    this._dollies.start.fov = fov;
    this._dollies.start.write(out, x, y, z, _look[0], _look[1], _look[2], pose.x, pose.z, true, dt, snap, 0.5);

    const handover = this._rig.mode === 'chase' ? smoothstep(this.sinceGo / START_HANDOVER) : 0;

    if (handover <= 0) return;

    // Turn into the chase's framing, running the chase itself, so the cut to it lands on the same picture.
    this._rig.chaseInto(_chase, dt);

    const p = out.position;
    const look = this._dollies.start.look;
    const target = _chase.lookAtTarget;

    p[0] = lerp(p[0], _chase.position[0], handover);
    p[1] = lerp(p[1], _chase.position[1], handover);
    p[2] = lerp(p[2], _chase.position[2], handover);
    _look[0] = lerp(look[0], target[0], handover);
    _look[1] = lerp(look[1], target[1], handover);
    _look[2] = lerp(look[2], target[2], handover);
    out.fov = lerp(fov, this._rig.chaseFov, handover);
    updateHardLookAt(out, _look);
  }

  /**
   * Facing the podium from just past the arch, looking down onto the blocks, drifting gently side to side, craning down
   * as the results arrive. On a landscape screen it frames the podium left of the results table and buttons.
   */
  private _podiumShot(out: CameraState, dt: number, snap: boolean): void {
    if (snap) this._podiumTime = 0;

    const t = this._time;
    const rig = this._rig;
    const portrait = rig.portrait;
    const wide = PODIUM_WIDE;
    const tall = PODIUM_TALL;
    const aspect = rig.klipp.height > 0 ? rig.klipp.width / rig.klipp.height : 16 / 9;
    const crane = 1 - smoothstep(this._podiumTime / PUSH_SECONDS);
    const fov = lerp(wide.fov, tall.fov, portrait);
    const landscape = clamp((aspect - PODIUM_CENTRED_ASPECT) / (16 / 9 - PODIUM_CENTRED_ASPECT), 0, 1);
    const across = lerp(lerp(0.5, wide.across, landscape), tall.across, portrait);
    // Turning the view toward a smaller yaw, to the right, moves the podium left across the screen.
    const lean = Math.atan((2 * across - 1) * aspect * Math.tan((fov * Math.PI) / 360));

    const route = this._race.course.route;

    route.point(PODIUM_LENS_S, Math.sin(t * 0.21) * lerp(wide.sway, tall.sway, portrait), _point);

    const x = _point.x;
    const y = _point.y + lerp(wide.height, tall.height, portrait) + crane * PODIUM_CRANE + Math.sin(t * 0.13) * 0.06;
    const z = _point.z;

    route.point(PODIUM_S + PODIUM_SET_BACK / 2, 0, _point);
    lookToFrame(
      _look,
      x,
      y,
      z,
      _point.x,
      _point.y + PODIUM_FOCUS_Y,
      _point.z,
      lerp(wide.down, tall.down, portrait),
      fov,
      lean,
    );
    this._dollies.podium.fov = fov;
    this._dollies.podium.write(out, x, y, z, _look[0], _look[1], _look[2], 0, 0, false, dt, snap, 0.6);
  }
}
