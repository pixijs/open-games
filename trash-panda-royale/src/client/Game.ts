import { Callbacks, Client, Predict, type InputHandle, type PredictedSpawns, type Reconciler, type Room, type SpawnHandle } from "@colyseus/sdk";
import type { PredictedEventChannel } from "@colyseus/sdk/predict";
import { Container3D, DirectionalLight, Frustum, Mesh3D, Vector3, View3D } from "@pixi/3d";
import { BloomEffect, TiltShiftEffect } from "@pixi/3d/extras";
import { Point, UPDATE_PRIORITY, type Application, type GlProgram, type Ticker } from "pixi.js";
import type { server } from "../app.config.js";
import {
  AI_TRAFFIC, AOI_IN, AOI_OUT, BIN_REACH, CAR_GARBAGE, CAR_TYPES, CarLight, GarbagePhase, GRENADE_CHARGE_STEPS, GRENADE_FUSE_MS, GULL_HATCH_MS, GULL_SNATCH_R, INTERP_DELAY_MS,
  MANHOLE_REACH, Mode, NPC_COUNT, NPC_HIT_R, NpcState, PARKED_CARS, PICKUP_FOOD, PICKUP_ZOOMIES, PLAYER_MAX_HP, PLAYER_RADIUS, PlayerStatus, POLE_R, RoundPhase,
  SEWER_AIR_MIN_S, SEWER_COUGH_S, SEWER_SPEED, TAUNT_MS, TICK_RATE, TRAIN_CARS, TRAIN_ROOF, Weapon, WEAPONS,
} from "../shared/constants.js";
import { crateOf } from "../shared/garbage.js";
import { MANHOLES, nearestManhole, sewerFlooded } from "../shared/sewer.js";
import { BIN_R, binOnRay, CITY, circleObb, groundHeight, nearestBin, polesNear, rayCylinder, rayPrism, rayStatic, segmentClear, type Obb } from "../shared/map.js";
import {
  AIM_Q, autoPitch, DRIVE_EYE_Y, EYE_Y, gullTarget, newPellet, pelletDamage, pelletDir, RACCOON_TOP, shotHeight, shotYaw, tracePellet, TOWNSFOLK_TOP, type ShotTarget,
} from "../shared/hitscan.js";
import { packOutfit } from "../shared/outfit.js";
import { PlayerInput, SIM_FIELDS, type Car, type GameState, type Grenade, type Npc, type Player, type PlayerInfo } from "../shared/schema.js";
import { newZoneState, zoneAt, zoneDepth, type ZoneState } from "../shared/zone.js";
import {
  carLights, EV_ARRIVE, EV_CLIMB, EV_COUPLE, EV_CRASH, EV_DAZE, EV_DROP, EV_ENTER, EV_EXIT, EV_FALL_OFF, EV_FIRE, EV_HIDE, EV_JUMP, EV_LAND, EV_PICKUP, EV_POOP, EV_PUNCH,
  EV_ROOF_LAND, EV_SEWER, EV_SNATCH, EV_UNSEWER, EV_WALL, airLeft, canDive, inSnatchReach,
  EV_TRAIN_HIT, EV_UNHIDE, GRENADE_FUSE_SUBSTEPS, GRENADE_SUBSTEP, getAmmo, grenadeLaunch, grenadePath, inPickupReach, localToWorld, newGrenadePath,
  stepGrenade, stepNpcReckon, stepPlayer, wrapAngle,
  type GrenadeLike, type GrenadePath, type PlayerSim, type PoleKnock, type RunOver, type SeenCar, type SeenNpc, type SimCtx, type WorldView,
} from "../shared/sim.js";
import { TRAIN_SLOTS, trainCarPose, trainPointWorld, type CarPose } from "../shared/train.js";
import { find, instance } from "./assets.js";
import { CameraRig, type CamMode } from "./CameraRig.js";
import { Controls } from "./Controls.js";
import { Fx } from "./Fx.js";
import { Hud } from "./Hud.js";
import { CAR_ICONS, ICON_NAMES, WEAPON_ICONS, type IconName, type Part } from "./icons.js";
import { paintSky } from "./gfx/Sky.js";
import { HeldTimeline } from "./net/HeldTimeline.js";
import { setPadGlyphStyle, type PadButton } from "./padGlyphs.js";
import { sfx } from "./Sfx.js";
import { CarView, WHEEL_TRACK } from "./views/CarView.js";
import { CharacterView, type CharState } from "./views/CharacterView.js";
import { GullView } from "./views/GullView.js";
import { humanLook, raccoonLook } from "./views/looks.js";
import { BinsView } from "./world/BinsView.js";
import { CityView } from "./world/CityView.js";
import { DropsView } from "./world/DropsView.js";
import { GarbageView } from "./world/GarbageView.js";
import { KnockView, type DrawnCar } from "./world/KnockView.js";
import { BushesView, type Walker } from "./world/BushesView.js";
import { PolesView, type CarAtPole } from "./world/PolesView.js";
import { GrenadesView, type GrenadeDraw } from "./world/GrenadesView.js";
import { SewerView } from "./world/SewerView.js";
import { SkidMarks } from "./world/SkidMarks.js";
import { ThrowView } from "./world/ThrowView.js";
import { TrainView } from "./world/TrainView.js";
import { ZoneView } from "./world/ZoneView.js";

type GameRoom = Room<typeof server, GameState>;

interface CarEntry {
  car: Car;
  view: CarView;
  /** Render-source blend when switching between my prediction and the network stream. */
  ox: number; oz: number; oyaw: number;
  mine: boolean;
  /**
   * The car I just stepped out of is drawn at stream + velocity × `leadS` (the stream's
   * lag behind my prediction, measured at the exit), so it keeps rolling forward from
   * where I left it instead of sliding back to where the stream still has it. `lead`
   * fades that projection in and out (0..1).
   */
  lead: number;
  leadS: number;
  leading: boolean;
  /** Low-passed stream velocity the projection uses (raw per-patch velocity is jittery). */
  lvx: number; lvz: number;
  pose: { x: number; y: number; z: number; yaw: number; vx: number; vz: number };
  key: string;
  /** Who sits at the wheel, on the interpolation timeline. */
  driver: HeldTimeline<string>;
  /** In this client's view (interest management); out of view, the entry is kept, hidden. */
  active: boolean;
  off: (() => void)[];
  /** Low-passed acceleration of the drawn car (roof surfers sway with it). */
  ax: number; az: number; pvx: number; pvz: number;
}

interface Discrete { mode: number; veh: number; grounded: boolean }
/** A damage number we predict: raccoon `k` takes `d`, said over (x, y, z). */
interface DamageNum { k: string; d: number; x: number; y: number; z: number }
interface PlayerEntry {
  p: Player; view: CharacterView; lastHp: number; drawn: CharState | null; tl: HeldTimeline<Discrete>;
  active: boolean; off: (() => void)[];
  /** When (ms) we first drew this player out of the round and dead; their body becomes a tombstone. */
  outAt: number;
  tomb: Container3D | null;
  /** The mode they were last drawn in (-1: not yet): a change to Hidden is their dive into a can. */
  drawnMode: number;
  /** How far their last stink bomb was wound up (0..1), for the size of their throw. */
  windup: number;
  /** Where the cork of the stink bomb in their paw was last seen (their next throw leaves from there). */
  cork: { x: number; y: number; z: number } | null;
  /**
   * Just got up onto a roof or a ledge: how far below and beside it they were drawn the frame
   * before (in the platform's frame, so it rides along; for a ledge, the world's), glided away
   * from `at` (render ms) over `ms`. `plat`: it's a car's or a train's roof.
   */
  lift: { x: number; y: number; z: number; at: number; ms: number; plat: boolean } | null;
  /** The drawn state `lift` was measured from (it's measured once per climb, however often we draw). */
  liftFrom: CharState | null;
  /** Out of the round and flying about as a seagull: its view (made the first time). */
  gull: GullView | null;
  /** Someone else a train got to on our screen: their knock, as we run it (see `remoteTrainHit`). */
  trainHit: TrainHit | null;
  /** Handing them back to the stream after that: how far apart the two were, easing out. */
  trainBlend: { x: number; y: number; z: number; age: number } | null;
  /** This frame's name tag, placed once the camera has moved (see `placeLabels`). */
  tag: TagAt;
}
/**
 * A name tag to place: over (x, y, z) by `lift`, seen if a sight line reaches `top` up
 * (a raccoon in car `car`, -1: none), or `gull`'s one at y + `top`.
 */
interface TagAt { due: boolean; hidden: boolean; gull: boolean; x: number; y: number; z: number; lift: number; top: number; car: number }
/**
 * A remote raccoon run over by a train, from the frame the train (drawn at renderNow) reaches
 * them as drawn: our own copy of their body, stepped by the shared step from there. `time`: the
 * render ms it's stepped to, `prev`: where it was a step before (drawn between the two), `at`: when
 * it was hit, `seen`: the stream has shown the knock since.
 */
interface TrainHit { sim: PlayerSim; prev: { x: number; y: number; z: number }; time: number; at: number; seen: boolean }
/** Nobody's input: a knocked body's step reads none. */
const NO_INPUT = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, pitch: 0, fire: false, nade: false, jump: false, sprint: false, use: false, weapon: 0 };
/** What a remote body's knock collides with: the town itself (cars, loot and the rest stay the server's word). */
const BARE_WORLD: WorldView = {
  cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [],
  npcs: () => [], manhole: () => null, snatch: () => null,
};
/** A train hit the server never confirms is let go of this long (ms) past the interpolation delay and a round trip. */
const TRAIN_HIT_GRACE = 250;
/** Handing a body back to the stream takes this long (s). */
const TRAIN_BLEND_S = 0.3;
interface NpcEntry {
  npc: Npc; view: CharacterView; yaw: number; lastState: number; drawn: { x: number; y: number; z: number }; active: boolean;
  /** A car ran them over: flying our way, in step with that car as drawn here (see `NpcFlight`). */
  flight: NpcFlight | null;
  /** Drawn at the server's reckon plus this offset, easing out (see `handOver`). */
  blend: NpcBlend | null;
}
/**
 * A townsperson a car ran over, flying our way until the server's flight takes over: launched
 * at `t0` (server ms) from (x, y, z), and stepped (to `t`) the way `Predict` reckons the server's.
 * - Our own car's (`ranOver`, `mine`): `t` is when in the input's step our car reached them
 *   (`RunOver.at`), and the server starts its flight just as far in (`Pedestrians.launchFrom`),
 *   so the two run together.
 * - Anyone else's (`splat`): `wait` holds them until that car, drawn here a moment in the past,
 *   gets to them; the flight then plays from its start, `lag` ms behind, and catches up.
 * `off`: it has taken off (until then they stay as they were: `pose0`). `born`: local ms, to
 * give up on it.
 */
interface NpcFlight {
  x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; t: number;
  off: boolean; lag: number; wait: { car: number; until: number } | null; pose0: CharState["pose"]; mine: boolean; born: number;
}
interface NpcBlend { x: number; y: number; z: number; age: number }
/** Our flights step like `Predict` reckons (its default sub-step, ms). */
const FLIGHT_SUBSTEP = 16;
/** A flight the server never settled lands back where it has them after this long (ms). */
const FLIGHT_GIVE_UP = 1200;
/** Someone else's run-over waits at most this long (ms) for their car, as drawn here, to get there. */
const FLIGHT_WAIT = 250;
/** A flight drawn behind the present catches up by this much of its own pace (it plays 1.6x). */
const FLIGHT_CATCH_UP = 0.6;
const NPC_XYZ = ["x", "y", "z"] as const;
interface PickupEntry {
  /** The trash can stays put; its lid flips open while it's empty. Loose loot has none. */
  can: Container3D | null; item: Container3D; key: string;
  lid: Container3D | null; open: number;
  /** Loose loot: when (server ms) we saw it set off on the flight that lands at its `at`, and from where (a gull's feet, as drawn, or its `ox, oy, oz`). */
  fly: { t0: number; x: number; y: number; z: number } | null;
}

/**
 * A stink bomb our own predicted step let go of: a sim-born predicted event (`throws`), keyed
 * by the input that let go of it (the server stamps its grenade with the same `seq`).
 */
interface Throw {
  tick: number;
  launch: GrenadeLike;
  /** How wound up it was (0..1). */
  power: number;
  /** Its predicted flight, until the server's grenade takes over (or it fizzles). */
  handle?: SpawnHandle<Ghost, GrenadeData>;
}

/**
 * A predicted stink bomb in flight, before the server's arrives. It's stepped in the server's
 * own sub-steps (friction is per sub-step: frame-sized steps would stop it short; `acc` is the
 * time not stepped yet), so it's where it would fizzle out. It's drawn from its exact path.
 */
interface Ghost extends GrenadeLike {
  seq: number;
  acc: number;
}

/** Each stink bomb's own render state (the spawn store's per-entry `data`). */
interface GrenadeData {
  /** Its path (bounces, where it goes off), and the flight time (s) its first point is at. */
  path: GrenadePath | null;
  t0: number;
  /** serverNow() when we threw it (ours): its flight time runs on our own timeline. 0: not ours. */
  at: number;
  /** Drawn yet: a remote raccoon's arm comes over the moment theirs appears. */
  shown: boolean;
  /**
   * Ours, once the server's has arrived: is the server's still on our path (checked against
   * every new snapshot, and when the snapshot was)? Then we keep drawing our exact path.
   */
  onPath: boolean;
  checkedAt: number;
  /** The paw it left (the cork, cocked behind the head): it's drawn easing out of it at first. */
  from: { x: number; y: number; z: number } | null;
}

/** A stink bomb's first this-many seconds are drawn easing from the paw onto its path. */
const RELEASE_S = 0.12;
/** A climb puts you straight onto the roof; it's drawn as a scramble up over this long (ms). */
const CLIMB_GLIDE_MS = 230;

/**
 * Is a stink bomb at (g.x, g.y, g.z) where `path` has it about `t` s into its flight (a few
 * sub-steps either way, for when exactly the snapshot was taken)?
 */
function onPathAt(g: GrenadeLike, path: GrenadePath, t: number): boolean {
  const c = Math.round(t / GRENADE_SUBSTEP), xyz = path.xyz;
  for (let i = Math.max(0, c - 6); i <= Math.min(path.n - 1, c + 6); i++) {
    if (Math.abs(xyz[i * 3] - g.x) + Math.abs(xyz[i * 3 + 1] - g.y) + Math.abs(xyz[i * 3 + 2] - g.z) < 0.02) return true;
  }
  return false;
}

/** Where `path` puts it `t` s into its flight (between sub-steps), into `out`. */
function pathAt(path: GrenadePath, t: number, out: { x: number; y: number; z: number }) {
  const s = Math.max(0, Math.min(path.n - 1, t / GRENADE_SUBSTEP));
  const i = Math.min(path.n - 2, Math.floor(s)), f = s - i, a = i * 3, xyz = path.xyz;
  out.x = xyz[a] + (xyz[a + 3] - xyz[a]) * f;
  out.y = xyz[a + 1] + (xyz[a + 4] - xyz[a + 1]) * f;
  out.z = xyz[a + 2] + (xyz[a + 5] - xyz[a + 2]) * f;
  return out;
}

/**
 * Steps a stink bomb on by `dt` s. A predicted one goes in fixed sub-steps (a hitch just means
 * more of them); a server one being reckoned (no `acc`) is already handed sub-steps.
 */
function stepThrown(g: Ghost | Grenade, dt: number) {
  if (!("acc" in g)) { stepGrenade(g, dt); return; }
  g.acc += Math.min(dt, GRENADE_FUSE_MS / 1000);
  while (g.acc >= GRENADE_SUBSTEP) {
    stepGrenade(g, GRENADE_SUBSTEP);
    g.acc -= GRENADE_SUBSTEP;
  }
}

/** Kill-feed icon for a death cause (`carKind` for "Bumper"). */
function causeIcon(cause: string, carKind?: number): IconName {
  const w = WEAPONS.findIndex((d) => d.name === cause);
  if (w >= 0) return WEAPON_ICONS[w];
  if (cause === "Bumper") return CAR_ICONS[carKind ?? 0] ?? "car_hatch";
  if (cause === "train") return "train_loco";
  if (cause === "zone") return "fumes";
  return "boom";
}

/** How the kill feed words a death nobody gets credit for, by cause. */
const KILL_VERBS: Record<string, string> = {
  zone: "got fumigated",
  train: "got choo-chooed",
  Bumper: "got flattened",
  "Car bomb": "went kaboom",
};

/** The behind-the-back camera: radians turned per pixel of mouse, and per second at full stick. */
const LOOK_SENS = 0.0024;
const PAD_LOOK_YAW = 3.2, PAD_LOOK_PITCH = 1.8;
/** How far out (m) the crosshair's ray looks for something to aim at; past it (the sky), the aim is that far along it. */
const AIM_REACH = 200;
/**
 * Where the camera picked with C is kept. (It was `ttm:camera` while overhead was the default;
 * a new name, so a choice made then doesn't hold anyone in the old default.)
 */
const CAMERA_KEY = "ttm:cam";
/** The minimap's outline of what's on screen reaches this far out from the camera at most (m). */
const SEEN_MAX = 120;
/** Fog (m) and tilt-shift overhead, and behind the back (where it's only a hint of distance blur). */
const TOP_FOG = { near: 140, far: 360 }, BEHIND_FOG = { near: 45, far: 210 };
/** The fog's colour, which the sky also pales to at the horizon (so far streets melt into it). */
const FOG_COLOR = 0xd6efff;
/** Which way the sunlight travels (the sky paints the sun the other way, over the shadows). */
const SUN_RAY = { x: -0.45, y: -1, z: -0.6 };
/** Tilt-shift blur at full strength, in CSS px (the effect takes physical pixels). */
const TOP_TILT_BLUR = 3.5;
const BEHIND_TILT = { near: 45, far: 140, blur: 1.5 };

/** What townsfolk yell when a raccoon causes trouble nearby. */
const BARKS = ["RACCOON!", "MY SANDWICH!", "call pest control!", "EEK!", "not the bins!", "TRASH BANDIT!", "it has a GUN?!", "my LUNCH!"];

/** Model floating over a pickup, by kind (weapons; snacks are one of `FOODS`, the zoomies a coffee). */
const PICKUP_MODELS = ["wpn_pistol", "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade"];
/** How big each pickup floats (the models are hand-sized), and how much higher than a snack (clear of the lid). */
const PICKUP_SCALES = [2.6, 2.6, 2.6, 2, 2];
const PICKUP_LIFT = [0.08, 0.08, 0.08, 0.08, 0.13];
const FOODS = ["food_pizza", "food_donut"];


export class Game {
  private view3d: View3D;
  private rig: CameraRig;
  /** Keys, mouse and pad (the menu reads them too: PLAY! on a pad, and its hints). */
  readonly controls: Controls;
  private hud = new Hud();
  private fx = new Fx();
  private city = new CityView();
  private trains: TrainView;
  /** The trash cans to hide in. */
  private bins: BinsView;
  /** The lamp posts cars knock over. */
  private poles: PolesView;
  /** Hydrants, benches, trash bags and cans cars knock flying (on this screen alone). */
  private knock: KnockView;
  private drawnCars: DrawnCar[] = [];
  /** The bushes everyone goes through. */
  private bushes: BushesView;
  private walkers: Walker[] = [];
  /** The manholes (and the sewer's map, while you're down it). */
  private sewer: SewerView;
  /** Garbage Day's golden dumpster. */
  private garbageView: GarbageView;
  /** Gulls' droppings, and their splats. */
  private drops: DropsView;
  private sun: DirectionalLight;
  private tilt: TiltShiftEffect;

  private room!: GameRoom;
  /** What you SEE: remote entities interpolated (with a small output spring). */
  private predict!: Predict<GameState>;
  /** What the step and hit checks READ: the exact interpolation the server rewinds to. */
  private phys!: Predict<GameState>;
  private input!: InputHandle<PlayerInput>;
  private me!: Reconciler<Player, PlayerInput>;
  private self!: Player;
  private hits!: ReturnType<Predict["defineEvent"]>;
  private pickupEvents!: ReturnType<Predict["defineEvent"]>;
  /** Lamp posts our predicted car knocked over, settled by the server's `poles` entry. */
  private poleKnocks!: PredictedEventChannel<PoleKnock>;
  /** Townsfolk our predicted car ran over (with the input's stamp), settled by the server's `splat`. */
  private runOvers!: PredictedEventChannel<RunOver & { t: number }>;
  private npcRead = { x: 0, y: 0, z: 0 };
  /** Stink bombs: ours predicted the moment we let go, handed over to the server's (see `throws`). */
  private grenadeSpawns!: PredictedSpawns<Grenade, Ghost, GrenadeData>;
  /** Our own throws, predicted by the step and settled by the server's grenade (by input seq). */
  private throws!: PredictedEventChannel<Throw>;
  /** Throws still waiting for the server (a reconnect drops them: input seqs start over). */
  private pendingThrows = new Set<Throw>();

  private players = new Map<string, PlayerEntry>();
  private cars = new Map<number, CarEntry>();
  private npcs = new Map<string, NpcEntry>();
  private pickups = new Map<string, PickupEntry>();
  /** Stink bombs in the air (ours and everyone's), and where ours would go while it's wound up. */
  private grenadesView: GrenadesView;
  private throwView = new ThrowView();
  /** Rubber on the road. */
  private skidMarks = new SkidMarks();
  private grenadeList: GrenadeDraw[] = [];
  private aimPath = newGrenadePath();
  private aimLaunch: GrenadeLike | null = null;
  /** The wind-up drawn last frame (0..1; 0: none), for the "ready" ping at full power. */
  private lastWindup = 0;
  /** This frame's wind-up meter (k 0: none), over (x, y, z); see `placeLabels`. */
  private meterAt = { k: 0, x: 0, y: 0, z: 0 };

  private aimYaw = 0;
  /** How far up (rad; negative: down) our shots fly (`updateAim`)… */
  private aimPitch = 0;
  /** …and whether from the crosshair's line over our head (over our back) rather than the gun (`shotHeight`). */
  private aimEye = false;
  private desiredWeapon: number = Weapon.Pistol;
  private lastSeenWeapon = -1;
  private jumpUntil = 0;
  /** Input seq of the live step that changed our mode (drawn raw until the next step). */
  private modeSeq = -1;
  private renderNow = 0;
  /** Server time remote entities are drawn at (the lerp target). */
  private remoteTime = 0;
  private hudKey = "";
  /** Connection banner: dropped (reconnecting) or gone for good. */
  private link: "ok" | "drop" | "left" = "ok";
  private stats = {
    confirmed: 0, rejected: 0, shots: 0, thrown: 0, kept: 0, fizzled: 0,
    // run-overs: predicted, confirmed, rejected, and how far apart our flight and the server's
    // were at the handover (m)
    ranOver: 0, ranOverOk: 0, ranOverNo: 0, handover: [] as number[],
  };
  private pickPoint = new Vector3();
  /** The height the overhead camera frames (see the camera in `render`). */
  private standY = 0;
  private tmp = new Vector3();
  /** The screen's footprint on the street (x, z of its four corners), for the minimap. */
  private seenQuad = [0, 0, 0, 0, 0, 0, 0, 0];
  private screen = new Point();
  private screen2 = new Point();
  private ringDir = { yaw: 0, pitch: 0 };
  private trainPose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
  private elapsed = 0;
  private lastDrawn = { x: 0, y: 0, z: 0 };

  // ---- battle royale
  private zoneView = new ZoneView();
  private zone: ZoneState = newZoneState();
  /** The fumes are on screen this frame (live round or its victory lap). */
  private zoneOn = false;
  /** `self.life` we last predicted from: a change means the server teleported us. */
  private lastLife = -1;
  /** Whom we watch while out of the round ("" = nobody yet). */
  private watching = "";
  private sentWatching = "";
  /** Our own elimination: when (ms), our place, and who did it. */
  private outAt = 0;
  private myPlace = 0;
  private killerName = "";
  private lastPhase = -1;
  /** "SCAVENGE!" stays up a moment after GO. */
  private goUntil = 0;
  private lastCount = -1;
  private puffAcc = 0;
  /** The fumes were closing in last frame (a new shrink sounds the siren). */
  private wasClosing = false;
  /** Next time (ms) a townsperson may shout something (others just "!"). */
  private barkAt = 0;
  /** Our own taunts are rate-limited like the server's. */
  private tauntAt = 0;
  /** Who won the last round: they wear the crown until the next winner. */
  private champion = "";
  /** Garbage Day's phase as last drawn (a change is news: the banner, the jingle), and how long its banner stays up. */
  private garbagePhase = 0;
  private garbageBanner = 0;
  /** V: out of the round, we'd rather watch someone than fly about as a gull (the server keeps the same choice), and when V may switch again. */
  private wantsWatch = false;
  private toggleAt = 0;
  /** We just hatched as a gull: its banner stays up till then (ms), once a round (the round we last showed it in). */
  private gullBanner = 0;
  private gullRound = -1;
  /** Next time (ms) a gull's wings may whump nearby. */
  private flapAt = 0;

  constructor(private app: Application) {
    const sky = { skyColor: 0xbfe0ff, groundColor: 0x9fc77a, intensity: 0.7 };
    this.tilt = new TiltShiftEffect({ focalDepth: 30, focalNear: 7, focalFar: 16, maxBlur: TOP_TILT_BLUR * app.renderer.resolution });
    const bloom = new BloomEffect({ threshold: 1.1, intensity: 0.55, radius: 0.55 });
    const quality = new URLSearchParams(location.search).get("fx") !== "low";
    this.view3d = new View3D({
      autoResize: true,
      shadowQuality: quality ? "high" : "medium",
      // 9-tap PCF: softer, steadier edges on the toy-scale shadows
      shadowFilter: quality ? "pcf-high" : "pcf",
      toneMapping: "aces",
      exposure: 0.92,
      environment: sky,
      background: paintSky(FOG_COLOR, { x: -SUN_RAY.x, y: -SUN_RAY.y, z: -SUN_RAY.z }, quality ? 1024 : 512),
      fog: { type: "linear", color: FOG_COLOR, ...TOP_FOG },
      passes: quality ? [this.tilt, bloom] : [],
    });
    app.stage.addChild(this.view3d);
    app.stage.addChild(this.hud.root);

    // Cascades fitted to this camera: it hovers 20-45 m from the action, so the first
    // split starts at the camera's near plane (6 m) and the reach stops at ~90 m, the far
    // corner of the zoomed-out driving view. The normal-offset bias is left to the engine,
    // which scales it to 3 texels of EACH cascade (a fixed world value is too small for the
    // coarse far cascade and makes acne that crawls as the camera moves).
    this.sun = new DirectionalLight({
      color: 0xffe9c7, intensity: 2.9, castShadow: true,
      shadow: { cascades: 3, maxDistance: 90, lambda: 0.6, bias: 0.0006 },
    });
    this.sun.position.set(0, 0, 0);
    this.sun.lookAt(SUN_RAY);
    this.view3d.root.addChild(this.sun);

    this.view3d.root.addChild(this.city.root);
    this.trains = new TrainView(this.fx);
    this.view3d.root.addChild(this.trains.root);
    this.bins = new BinsView(this.fx);
    this.view3d.root.addChild(this.bins.root);
    this.poles = new PolesView(this.city.lampPosts, this.fx);
    this.knock = new KnockView(this.city.props, this.bins.carriers, this.fx);
    this.bins.standUp = (i) => this.knock.standBin(i);
    this.bushes = new BushesView(this.city.props, this.fx);
    this.sewer = new SewerView(this.fx);
    this.garbageView = new GarbageView(this.fx);
    this.drops = new DropsView(this.fx);
    this.view3d.root.addChild(this.sewer.root, this.garbageView.root, this.drops.root);
    this.view3d.root.addChild(this.zoneView.root);
    this.grenadesView = new GrenadesView(this.fx);
    this.view3d.root.addChild(this.grenadesView.root, this.throwView.root, this.skidMarks.mesh);
    this.view3d.root.addChild(this.fx.root);

    this.rig = new CameraRig(this.view3d, this.view3d.camera);
    this.controls = new Controls(app.canvas);
    this.controls.onKey = (code) => this.onKey(code);
    // pads are read once a frame, before the frame's steps (on the menu too: it shows their buttons)
    app.ticker.add(() => this.controls.poll(), undefined, UPDATE_PRIORITY.HIGH);
    this.controls.onDeviceChange(() => {
      setPadGlyphStyle(this.controls.padStyle);
      this.hud.setDevice(this.controls.device === "pad");
    });
    this.hud.layout(app.screen.width, app.screen.height, app.renderer.resolution);
    app.renderer.on("resize", (w: number, h: number) => this.hud.layout(w, h, app.renderer.resolution));
  }

  /**
   * Compile every shader the game will need while the loading screen is up.
   *
   * WebGL programs are compiled on the frame that first draws them, synchronously: a
   * material variant that first appears mid-game freezes that frame (the first tracer
   * cost ~0.3-0.4 s, the cars and characters seen right after joining ~1 s). Nothing in
   * the scene before joining uses those variants (cars, players, loot cans arrive with the
   * state; tracers and dizzy stars are hidden), and the camera culls whatever it doesn't
   * see. So: one frame with one of each of those in the scene and culling switched off.
   * Programs are cached by their source, so these throwaway copies warm the real ones.
   *
   * Compiling them one by one on the main thread would freeze the page for seconds
   * (no typing in the name box), so they are first compiled in parallel on the driver's
   * own threads (`precompile`); the warm-up frame then finds them in the browser's
   * program cache.
   */
  async prewarm(): Promise<{ ms: number; parallel: number }> {
    const t0 = performance.now();
    const room = new Container3D({ label: "prewarm" });
    const views: { destroy(): void }[] = [];
    CAR_TYPES.forEach((type, kind) => {
      const car = new CarView(kind, type.paint[0]);
      car.setDriver("prewarm", kind % 2 ? humanLook(7, kind === 2 ? "pest" : undefined) : raccoonLook(7));
      // (with its brake lights on)
      car.update(0, { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, steer: 0, state: 0, hp: 100, siren: false, lights: CarLight.Brake });
      room.addChild(car.root);
      views.push(car);
    });
    // a player (its own flashable materials, every accessory material showing) and a
    // townsperson, knocked out with dizzy stars
    const dressed = packOutfit({ fur: 0, belly: 0, head: 1, face: 1, neck: 2, back: 1, acc: 0 });
    for (const unique of [true, false]) {
      const who = new CharacterView(unique ? raccoonLook(dressed) : humanLook(2), { unique });
      who.setWeapon(Weapon.Pistol);
      // the champion's crown is gold
      if (unique) who.setCrown(true);
      who.update(0, { x: 0, y: 0, z: 0, yaw: 0, speed: 0, vy: 0, pose: "lying", aiming: false });
      room.addChild(who.root);
      views.push(who);
    }
    // a seagull (an out raccoon), carrying a pizza
    const gull = new GullView();
    gull.update(0, { x: 0, y: 2, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, dazed: false, carry: PICKUP_FOOD });
    room.addChild(gull.root);
    views.push(gull);
    // loot floats without shadows over its can; thrown stink bombs cast one; tombstones mark the fallen
    for (const name of ["loot_can", "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade", ...FOODS, "coffee"]) room.addChild(instance(name, { castShadow: name === "loot_can" }));
    room.addChild(instance("wpn_grenade", { castShadow: true }));
    room.addChild(instance("tombstone"));
    this.view3d.root.addChild(room);
    const undoFx = this.fx.prewarm();
    const undoCity = this.city.prewarm();
    const undoZone = this.zoneView.prewarm();
    const undoBins = this.bins.prewarm();
    const undoGrenades = this.grenadesView.prewarm();
    const undoThrow = this.throwView.prewarm();
    const undoSkids = this.skidMarks.prewarm();
    const undoSewer = this.sewer.prewarm();
    const undoGarbage = this.garbageView.prewarm();
    const undoDrops = this.drops.prewarm();

    let t = performance.now();
    const parallel = await this.precompile();
    performance.measure("ttm parallel shader compile", { start: t });

    // draw everything, wherever the camera points
    t = performance.now();
    const camera = this.view3d.camera;
    const all = new Frustum();
    for (let i = 3; i < 24; i += 4) all.planesData[i] = 1e9;
    camera.cullFrustum = all;
    this.app.renderer.render(this.app.stage);
    this.app.renderer.render(this.app.stage);
    camera.cullFrustum = camera.frustum;
    performance.measure("ttm warm-up frame", { start: t });

    undoDrops();
    undoGarbage();
    undoSewer();
    undoSkids();
    undoThrow();
    undoGrenades();
    undoBins();
    undoZone();
    undoCity();
    undoFx();
    for (const v of views) v.destroy();
    room.destroy({ children: true });
    return { ms: performance.now() - t0, parallel };
  }

  /**
   * Compile the programs the scene's meshes will need on the GPU driver's worker threads
   * (`KHR_parallel_shader_compile`), waiting without blocking the page. The programs are
   * thrown away afterwards: the point is the browser's program cache, which then serves
   * pixi's own (synchronous) link of the very same sources in a millisecond or two.
   * WebGL only; anything it misses is simply compiled by the warm-up frame as before.
   */
  private async precompile(): Promise<number> {
    type Gl = WebGL2RenderingContext;
    const renderer = this.app.renderer as unknown as {
      gl?: Gl;
      material3d?: { ensureMaterial?(mesh: Mesh3D, batch: unknown, view: View3D): { glProgram?: GlProgram } | null };
      shader?: { _programDataHash?: Record<string, unknown> };
    };
    const gl = renderer.gl;
    const ext = gl?.getExtension("KHR_parallel_shader_compile");
    const materials = renderer.material3d;
    const view = this.view3d as unknown as { _sceneBatch?: unknown; _syncShadowSampling?(): void };
    if (!gl || !ext) return 0;
    // @pixi/3d internals: when they move, this must say so, or the warm-up just quietly gets slower
    const ensureMaterial = materials?.ensureMaterial?.bind(materials);
    if (!ensureMaterial || !view._sceneBatch || typeof view._syncShadowSampling !== "function") {
      console.warn("shader warm-up: @pixi/3d internals changed, nothing precompiled");
      return 0;
    }

    // pick the shadow-sampling variant now, as the first frame would
    view._syncShadowSampling();
    const programs = new Map<number, GlProgram>();
    let meshes = 0, failures = 0, firstError: unknown;
    const visit = (node: Container3D) => {
      if (node instanceof Mesh3D) {
        meshes++;
        try {
          // (plain meshes all sit in the view's own batch)
          const program = ensureMaterial(node, view._sceneBatch, this.view3d)?.glProgram;
          if (program && !renderer.shader?._programDataHash?.[program._key]) programs.set(program._key, program);
        } catch (e) {
          // left to the warm-up frame
          failures++;
          firstError ??= e;
        }
      }
      for (const child of node.children) visit(child as Container3D);
    };
    visit(this.view3d.root);
    if (meshes && failures === meshes) console.warn("shader warm-up: ensureMaterial() threw for every mesh (@pixi/3d internals changed?), nothing precompiled", firstError);

    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const pending = [...programs.values()].map((p) => {
      const vs = compile(gl.VERTEX_SHADER, p.vertex), fs = compile(gl.FRAGMENT_SHADER, p.fragment);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      return { program, vs, fs };
    });
    // a status query is a round trip to the GPU process: ask about one program at a time, gently
    for (const { program } of pending) {
      while (!gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR)) await new Promise((r) => setTimeout(r, 50));
    }
    for (const { program, vs, fs } of pending) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
    }
    return pending.length;
  }

  // ------------------------------------------------------------------ network
  /** Join with the name and outfit (`look`, see `shared/outfit.ts`) picked on the start screen. */
  async connect(name: string, look: number) {
    // `?netdebug=1`: the SDK's debug panel (per-reconciler drift, latency/jitter
    // simulator; `__net(rtt, jitter)` in the console). It hooks the client, so load it first.
    if (new URLSearchParams(location.search).get("netdebug") === "1") await import("@colyseus/sdk/debug");

    const client = new Client<typeof server>(
      import.meta.env.VITE_SERVER_URL || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
    );
    this.room = (await client.joinOrCreate("town", { name, look })) as unknown as GameRoom;
    const room = this.room;

    // Remote players and cars are interpolated 100 ms in the past: the SAME number the
    // server rewinds by for lag compensation. Positions and facings get a short output
    // spring (display only), so uneven per-patch motion doesn't show as stutter. `snap`
    // and `angle` apply to every field of an attach, so they're grouped by kind:
    // velocities never snap, platform-local offsets never spring (they jump on mount).
    const lerp = { mode: "lerp" as const };
    this.predict = Predict.get(room, { mode: "lerp", delay: INTERP_DELAY_MS }) as Predict<GameState>;
    this.predict.attachAll("players", { ...lerp, fields: ["x", "y", "z"], snap: 8, smoothMs: 30 });
    this.predict.attachAll("players", { ...lerp, fields: ["lx", "ly", "lz"], snap: 8 });
    this.predict.attachAll("players", { ...lerp, fields: ["yaw", "aim"], angle: true, smoothMs: 30 });
    this.predict.attachAll("players", { ...lerp, fields: ["lyaw"], angle: true });
    // (vy too: a jump's pose is keyed on it, so it has to be on the same timeline as y)
    this.predict.attachAll("players", { ...lerp, fields: ["vx", "vy", "vz"] });
    // a stink bomb's wind-up, on the same timeline as the arm winding it (ours: the reconciler's)
    this.predict.attachAll("players", { ...lerp, fields: ["charge"] });
    this.predict.attachAll("cars", { ...lerp, fields: ["x", "y", "z"], snap: 12, smoothMs: 25 });
    this.predict.attachAll("cars", { ...lerp, fields: ["vx", "vz", "steer"], smoothMs: 25 });
    this.predict.attachAll("cars", { ...lerp, fields: ["yaw"], angle: true, smoothMs: 25 });
    // Pedestrians are server AI: dead-reckoned forward to "now" (the server rewinds
    // them on the matching reckon timeline).
    this.predict.attachAll("npcs", { mode: "reckon", fields: ["x", "y", "z"], step: stepNpcReckon, snap: 6 });

    // The springs above are display-only: the server's rewind reconstructs the plain
    // interpolation. A second Predict without them is what the shared step collides
    // against and what local hit checks aim at, so both sides read the same poses.
    this.phys = Predict.get(room, { mode: "lerp", delay: INTERP_DELAY_MS, name: "phys" }) as Predict<GameState>;
    this.phys.attachAll("players", { ...lerp, fields: ["x", "y", "z", "lx", "lz"], snap: 8 });
    this.phys.attachAll("cars", { ...lerp, fields: ["x", "z"], snap: 12 });
    this.phys.attachAll("cars", { ...lerp, fields: ["vx", "vz"] });
    this.phys.attachAll("cars", { ...lerp, fields: ["yaw"], angle: true });
    // Other raccoons' stink bombs, on the same 100 ms-behind timeline as the raccoon who threw
    // them, so they leave its paw as its arm comes over. (Here, not on `predict`: there the
    // spawn store below reckons the same fields for our own.)
    this.phys.attachAll("grenades", { ...lerp, fields: ["x", "y", "z"] });

    this.input = room.input({ type: PlayerInput }) as unknown as InputHandle<PlayerInput>;
    if (this.input.tickRate === undefined) throw new Error("server did not advertise a fixed tick rate");

    await new Promise<void>((resolve) => {
      if (room.state.players?.get(room.sessionId)) return resolve();
      room.onStateChange.once(() => resolve());
    });
    this.self = room.state.players.get(room.sessionId)!;
    this.lastLife = this.self.life;

    // Optimistic hit markers: predicted from what we see, settled by the server's
    // lag-compensated verdict ("hit" message), auto-rejected otherwise.
    // A raccoon hit gets its damage number at once (taken back if the server didn't count the hit).
    this.hits = this.predict.defineEvent<{ tick: number; x: number; y: number; z: number; nums?: DamageNum[] }>({
      label: "hits",
      uniqueBy: (h) => h.tick,
      onPredict: (h) => {
        this.hud.hitMarker();
        sfx.hitMarker();
        this.fx.hitPuff(h.x, h.y, h.z);
        this.damageNumbers(h.nums, 1);
      },
      onConfirm: () => { this.stats.confirmed++; },
      onReject: (h) => { this.stats.rejected++; this.damageNumbers(h.nums, -1); },
    });
    room.onMessage("hit", (m: { t: number }) => this.hits.confirm(m.t));

    // Crates vanish the instant our predicted step grabs one; the server's `active=false` settles it.
    this.pickupEvents = this.predict.defineEvent<string>({
      label: "pickups",
      uniqueBy: (id) => id,
      confirmOn: { collection: "pickups", field: "active", equals: false },
      onPredict: (id) => {
        const pk = room.state.pickups.get(id);
        // a gull's snatch: a squawk of glee, the loot's in its feet now
        if (this.me?.state.mode === Mode.Gull) {
          sfx.squawk(undefined, undefined, 1);
          sfx.flap(undefined, undefined, 3, 1);
          if (pk) this.fx.featherBurst(pk.x, pk.y + 0.8, pk.z, 6);
          return;
        }
        if (pk?.kind === PICKUP_FOOD) sfx.munch();
        else if (pk?.kind === PICKUP_ZOOMIES) {
          sfx.slurp();
          const s = this.view3d.worldToScreen(this.tmp.set(this.lastDrawn.x, this.lastDrawn.y + 2, this.lastDrawn.z), this.screen);
          if (s) this.hud.popup([{ icon: "coffee" }, "ZOOMIES!"], s.x, s.y, 0xff9f43);
        } else { sfx.rummage(); if (pk) this.fx.rummage(pk.x, pk.y, pk.z); }
        if (pk) this.fx.sparkle(pk.x, pk.y, pk.z);
      },
      onUnpredicted: (id) => {
        const pk = room.state.pickups.get(String(id));
        if (pk) this.fx.sparkle(pk.x, pk.y, pk.z, 0xb7e3ff);
      },
    });

    // Lamp posts: ours fall the instant our predicted car hits one, the way it hit it; the
    // server's `poles` entry settles it (and turns the fall its way, should that differ). One
    // the server never knocked over stands back up.
    this.poleKnocks = this.predict.defineEvent<PoleKnock>({
      label: "poles",
      uniqueBy: (k) => k.i,
      graceTicks: 5,
      onPredict: (k) => { this.poles.fall(k.i, k.fall, "now"); this.shake(0.2); },
      onReject: (k) => { if (!room.state.poles.has(String(k.i))) this.poles.stand(k.i); },
    });

    // Townsfolk our car runs over fly the instant our predicted step hits them, the way it hit
    // them: the server makes the same call against what we saw, and launches them along the
    // same path. Its `splat` settles it; one it never ran over lands back where it has them.
    this.runOvers = this.predict.defineEvent<RunOver & { t: number }>({
      label: "runovers",
      uniqueBy: (h) => h.key,
      graceTicks: 5,
      onPredict: (h) => this.ranOver(h),
      onConfirm: () => { this.stats.ranOverOk++; },
      onReject: (h) => {
        this.stats.ranOverNo++;
        const ne = this.npcs.get(h.key);
        if (ne?.flight) this.handOver(ne, this.npcTime(), false);
      },
    });

    // Stink bombs. Ours is in the air the moment our predicted step lets go of it, then handed
    // over to the server's grenade: paired by the input that let go of it, and reckoned ahead
    // by the measured input lead, so it carries on along our own timeline without a jump. Both
    // are stepped in the server's 1/60 s sub-steps. The fuse-long TTL only backs up `throws`,
    // which settles each throw by server progress.
    this.grenadeSpawns = this.predict.spawns<"grenades", Ghost, GrenadeData>("grenades", {
      owned: (g) => g.owner === room.sessionId,
      correlate: (local, g) => local.seq === g.seq,
      spawnTime: (g) => g.bornMs,
      step: (g, dt) => stepThrown(g, dt),
      fields: ["x", "y", "z"],
      substep: GRENADE_SUBSTEP * 1000,
      smoothMs: 40,
      ttl: () => GRENADE_FUSE_MS,
      onReject: (g) => this.fizzle(g),
      data: () => ({ path: null, t0: 0, at: 0, shown: false, onPath: false, checkedAt: -1, from: null }),
    });

    // Our throws: predicted by the step that let go (live steps only), with the throw's juice
    // right away; confirmed when the server's grenade with that input's seq arrives (the ack
    // rides the same frame, so a real throw always confirms first), auto-rejected once the
    // server has processed past it without one: the ghost fizzles.
    this.throws = this.predict.defineEvent<Throw>({
      label: "throws",
      uniqueBy: (t) => t.tick,
      graceTicks: 5,
      onPredict: (t) => this.onThrow(t),
      onConfirm: (t) => { this.pendingThrows.delete(t); this.stats.kept++; },
      onReject: (t) => {
        this.pendingThrows.delete(t);
        this.stats.fizzled++;
        if (t.handle) { this.fizzle(t.handle.local); t.handle.cancel(); }
      },
    });
    Callbacks.get(room).onAdd("grenades", (g: Grenade) => {
      if (g.owner === room.sessionId) this.throws.confirm(g.seq);
    });

    // Our own entity: predicted with the SAME step the server runs. No `snap`: it is
    // compared against the largest correction of ANY field (ammo, timers, velocities),
    // so it would pop ordinary corrections; respawns call `reset()` instead.
    const world = this.clientWorld();
    this.me = this.predict.reconciler<Player, PlayerInput>(this.self, {
      input: this.input,
      fields: SIM_FIELDS as unknown as (keyof Player & string)[],
      step: (ctx, s, cmd) => {
        // Frozen before GO, by the server's own rule (`BattleRoyale.frozen`) on the same stamp.
        // Read live, not memoised: a replay then picks up a `goAt` that arrived since, and
        // converges on the server's verdict.
        const goAt = room.state.round?.goAt ?? 0;
        const sim: SimCtx = { dt: ctx.dt, time: ctx.reckonTime, memo: (k, f) => ctx.memo(k, f), frozen: goAt > 0 && ctx.reckonTime < goAt };
        const prevMode = s.mode, prevVeh = s.veh, charge = s.charge;
        const ev = stepPlayer(sim, s as PlayerSim, cmd as PlayerInput, world);
        if (ctx.isReplay) return;
        this.onLocalStep(ev, s as PlayerSim, cmd as PlayerInput, ctx, sim, prevMode, prevVeh);
        // a gull's snatch: the loot's gone from under it at once, like a raccoon's grab (settled the same way)
        if (sim.snatched) ctx.predict(this.pickupEvents, sim.snatched);
        // a stink bomb let go of: a predicted event keyed by this input (replays never re-fire it)
        if (sim.thrown) ctx.predict(this.throws, { tick: ctx.tick, launch: { ...sim.thrown }, power: charge / GRENADE_CHARGE_STEPS });
        // lamp posts our car knocked over (keyed by post: a replay never knocks one twice)
        if (sim.knocked) for (const k of sim.knocked) ctx.predict(this.poleKnocks, k);
        // townsfolk it ran over, launched at this input's stamp (keyed by who: never twice)
        if (sim.runOver) for (const h of sim.runOver) ctx.predict(this.runOvers, { ...h, t: ctx.reckonTime });
      },
      smoothMs: 60,
      // also keeps the drift telemetry the N panel shows running
      warnOnDivergence: 1.5,
    }) as unknown as Reconciler<Player, PlayerInput>;

    this.bindState();
    this.bindMessages();
  }

  /** What the predicted step reads about the world: the exact interpolation the server rewinds to. */
  private clientWorld(): WorldView {
    const phys = (c: Car, f: "x" | "z" | "yaw" | "vx" | "vz") => this.phys.value(c, f);
    const seen = (c: Car): SeenCar => {
      const t = CAR_TYPES[c.kind];
      return {
        id: c.id, kind: c.kind, driven: c.driver !== "", wreck: c.state === 2,
        x: phys(c, "x"), z: phys(c, "z"), yaw: phys(c, "yaw"), vx: phys(c, "vx"), vz: phys(c, "vz"),
        halfL: t.halfL, halfW: t.halfW, roof: t.roof,
      };
    };
    return {
      cars: (x, z, r) => {
        const out: SeenCar[] = [];
        for (const e of this.cars.values()) {
          if (!e.active) continue;
          const c = seen(e.car);
          if ((c.x - x) ** 2 + (c.z - z) ** 2 <= (r + 3) ** 2) out.push(c);
        }
        // the golden dumpster, once it's down: solid, as the server has it
        const g = this.room.state.garbage;
        if (g && (g.phase === GarbagePhase.Locked || g.phase === GarbagePhase.Open)) {
          const c = crateOf(g);
          if ((c.x - x) ** 2 + (c.z - z) ** 2 <= (r + 3) ** 2) out.push(c);
        }
        return out;
      },
      car: (id) => {
        const e = this.cars.get(id);
        return e && e.active && e.car.state !== 2 ? seen(e.car) : null;
      },
      carKind: (id) => this.cars.get(id)?.car.kind ?? this.room.state.cars.get(String(id))?.kind ?? 0,
      pickup: (x, y, z) => {
        // snacks are only grabbed when hurt (the server decides on the same hp, a patch later)
        const full = this.self.hp >= PLAYER_MAX_HP;
        for (const [id, pk] of this.room.state.pickups) {
          // a can we already looted (pending server confirmation) can't be grabbed again
          if (!pk.active || this.pickupEvents.has(id) || (pk.kind === PICKUP_FOOD && full)) continue;
          if (inPickupReach({ x, y, z }, pk.x, pk.y, pk.z)) return { id, kind: pk.kind };
        }
        return null;
      },
      bin: (x, y, z) => {
        // its lid on, and nobody we can see in it (anyone else in there, the server bounces us)
        const i = nearestBin(x, y, z, BIN_REACH);
        if (i < 0 || this.room.state.bins.get(String(i))?.lidOff) return -1;
        for (const [sid, pe] of this.players) {
          if (sid !== this.room.sessionId && pe.active && pe.p.mode === Mode.Hidden && pe.p.veh === i) return -1;
        }
        return i;
      },
      // standing: neither down on the server, nor knocked over by our own (predicted) car
      poles: (x, z, r) => polesNear(x, z, r).filter((i) => !this.room.state.poles.has(String(i)) && !this.poleKnocks.has(i)),
      // the nearest manhole, and whether its lid is off (the server's word: lids are its); none while flooded
      manhole: (x, z, r) => {
        if (sewerFlooded(this.room.state.round)) return null;
        const i = nearestManhole(x, z, r);
        return i < 0 ? null : { i, open: this.room.state.manholes.has(String(i)) };
      },
      // loot under a gull's feet: active, in nobody's feet, and not one we just took
      snatch: (x, y, z) => {
        let best: { id: string; kind: number } | null = null, bestD = Infinity;
        for (const [id, pk] of this.room.state.pickups) {
          if (!pk.active || pk.carrier || this.pickupEvents.has(id) || !inSnatchReach(x, y, z, pk.x, pk.y, pk.z, GULL_SNATCH_R)) continue;
          const d = (pk.x - x) ** 2 + (pk.z - z) ** 2;
          if (d < bestD) { bestD = d; best = { id, kind: pk.kind }; }
        }
        return best;
      },
      // on their feet or lying KO, reckoned to the input's stamp (where the server rewinds them
      // to); not one our car already sent flying, whatever the server still says
      npcs: (x, z, r, time) => {
        const out: SeenNpc[] = [];
        for (const [key, ne] of this.npcs) {
          const n = ne.npc;
          if (!ne.active || ne.flight || (n.state > NpcState.Flee && n.state !== NpcState.KO)) continue;
          if ((n.x - x) ** 2 + (n.z - z) ** 2 > (r + 8) ** 2) continue;
          const p = this.predict.readAt(n, NPC_XYZ, time, this.npcRead);
          if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r * r) out.push({ key, x: p.x, y: p.y, z: p.z });
        }
        return out;
      },
    };
  }

  /** The instant townsfolk are drawn at: `Predict` reckons them to the clock's render timeline. */
  private npcTime(): number {
    const c = this.room.clock;
    return c.renderNow?.() ?? c.serverNow();
  }

  /**
   * Our car ran someone over (predicted): they take off, with the bang, the moment our car is
   * drawn getting to them (`renderNpcs`), along the very flight the server gives them.
   */
  private ranOver(h: RunOver & { t: number }) {
    this.stats.ranOver++;
    const ne = this.npcs.get(h.key);
    // (lifted off the ground, as `Pedestrians.launch` does)
    const t0 = h.t + (h.at * 1000) / TICK_RATE;
    const f: NpcFlight = {
      x: h.x, y: Math.max(h.y, 0.05), z: h.z, vx: h.vx, vy: h.vy, vz: h.vz, t0, t: t0,
      off: false, lag: 0, wait: null, pose0: ne?.npc.state === NpcState.KO ? "lying" : "move", mine: true, born: performance.now(),
    };
    if (!ne) return this.bang(f, true);
    ne.flight = f;
    ne.blend = null;
  }

  /** The car hits them: the thump, and they're off. */
  private takeOff(ne: NpcEntry, f: NpcFlight) {
    f.off = true;
    ne.view.event("flatten");
    this.bang(f, f.mine);
  }

  private bang(at: { x: number; y: number; z: number }, mine: boolean) {
    this.fx.hitPuff(at.x, at.y + 0.6, at.z);
    this.fx.pancake(at.x, at.y + 0.6, at.z);
    sfx.punch(at.x, at.z);
    sfx.boing(at.x, at.z);
    if (mine) this.shake(0.25);
  }

  /** Is car `id`, as drawn here, touching someone at (x, z)? One not drawn here at all is. */
  private carAt(id: number, x: number, z: number): boolean {
    const e = this.cars.get(id);
    if (!e?.active) return true;
    const t = CAR_TYPES[e.car.kind];
    return circleObb(x, z, NPC_HIT_R + 0.1, e.pose.x, e.pose.z, e.pose.yaw, t.halfW, t.halfL);
  }

  /** Our flight `f`, stepped on to `time` (server ms). */
  private stepFlight(f: NpcFlight, time: number): NpcFlight {
    while (f.t < time) {
      const ms = Math.min(FLIGHT_SUBSTEP, time - f.t);
      stepNpcReckon(f, ms / 1000);
      f.t += ms;
    }
    return f;
  }

  /**
   * Our flight hands over to the server's reckon of them (flying there too now, or never
   * launched at all: `hit` false, and no bang if they hadn't taken off yet): drawn from where
   * ours got to, easing onto theirs.
   */
  private handOver(ne: NpcEntry, time: number, hit = true) {
    if (hit && !ne.flight!.off) this.takeOff(ne, ne.flight!);
    const f = this.stepFlight(ne.flight!, time - ne.flight!.lag);
    const p = this.predict.readAt(ne.npc, NPC_XYZ, time, this.npcRead);
    ne.blend = { x: f.x - p.x, y: f.y - p.y, z: f.z - p.z, age: 0 };
    ne.flight = null;
    if (this.stats.handover.length >= 64) this.stats.handover.shift();
    this.stats.handover.push(Math.hypot(ne.blend.x, ne.blend.y, ne.blend.z));
  }

  private bindState() {
    const room = this.room;
    const cb = Callbacks.get(room);
    const serverTime = () => room.clock.lastServerTime();

    // Players, cars and townsfolk come and go as they enter and leave our view (the server's
    // interest management). Their views are pooled by key: leaving hides one, coming back
    // re-binds it to the (possibly new) synced instance, with fresh listeners and history.
    cb.onAdd("players", (p: Player, sid: string) => {
      let pe = this.players.get(sid);
      if (!pe) {
        const view = new CharacterView(raccoonLook(p.look), { unique: true });
        this.view3d.root.addChild(view.root);
        pe = { p, view, lastHp: p.hp, drawn: null, tl: new HeldTimeline<Discrete>(), active: true, off: [], outAt: 0, tomb: null, drawnMode: -1, windup: 0, cork: null, lift: null, liftFrom: null, gull: null, trainHit: null, trainBlend: null,
          tag: { due: false, hidden: false, gull: false, x: 0, y: 0, z: 0, lift: 0, top: 0, car: -1 } };
        this.players.set(sid, pe);
      }
      const e = pe;
      e.p = p;
      e.active = true;
      e.lastHp = p.hp;
      e.drawn = null;
      e.drawnMode = -1;
      e.tl = new HeldTimeline<Discrete>();
      const record = () => e.tl.push(serverTime(), { mode: p.mode, veh: p.veh, grounded: p.grounded });
      record();
      e.off.push(cb.listen(p, "mode", record), cb.listen(p, "veh", record), cb.listen(p, "grounded", record));
      if (sid === room.sessionId) {
        e.off.push(cb.listen(p, "hp", (hp: number, prev: number) => {
          if (prev === undefined) return;
          if (hp < prev) {
            this.hud.hurt();
            sfx.hurt();
            this.shake(0.25);
            e.view.flash();
          } else if (hp > prev && p.mode !== Mode.Dead && p.life === this.lastLife) {
            // a snack (or a kill) healed us (not a respawn: that comes with a new life)
            const s = this.view3d.worldToScreen(this.tmp.set(this.lastDrawn.x, this.lastDrawn.y + 2, this.lastDrawn.z), this.screen);
            if (s) this.hud.popup([{ icon: "food" }, `+${hp - prev}`], s.x, s.y, 0x7cff6b);
          }
        }));
      }
    });
    cb.onRemove("players", (_p: Player, sid: string) => {
      const e = this.players.get(sid);
      if (!e) return;
      e.active = false;
      for (const off of e.off.splice(0)) off();
      e.view.root.visible = false;
      if (e.gull) e.gull.root.visible = false;
    });
    // gone from the room for good
    cb.onRemove("roster", (_info: PlayerInfo, sid: string) => {
      const e = this.players.get(sid);
      if (!e) return;
      for (const off of e.off.splice(0)) off();
      e.view.destroy();
      e.gull?.destroy();
      e.tomb?.destroy({ children: true });
      this.players.delete(sid);
    });

    cb.onAdd("cars", (car: Car, key: string) => {
      const old = this.cars.get(car.id);
      if (old) {
        // back in view: possibly repaired and repainted since
        for (const off of old.off.splice(0)) off();
        old.view.destroy();
      }
      const view = new CarView(car.kind, car.paint);
      this.view3d.root.addChild(view.root);
      const driver = new HeldTimeline<string>();
      driver.push(serverTime(), car.driver);
      const e: CarEntry = {
        car, view, ox: 0, oz: 0, oyaw: 0, mine: false, lead: 0, leadS: 0, leading: false, lvx: 0, lvz: 0, key, driver,
        pose: { x: car.x, y: car.y, z: car.z, yaw: car.yaw, vx: 0, vz: 0 }, active: true, off: [],
        ax: 0, az: 0, pvx: 0, pvz: 0,
      };
      this.cars.set(car.id, e);
      e.off.push(cb.listen(car, "driver", (d: string) => driver.push(serverTime(), d)));
      e.off.push(cb.listen(car, "state", (st: number, prev: number) => {
        if (prev === 2 && st === 0) {
          // a respawned wreck: brand-new paint job
          e.view.destroy();
          e.view = new CarView(car.kind, car.paint);
          this.view3d.root.addChild(e.view.root);
        }
      }));
    });
    cb.onRemove("cars", (car: Car) => {
      const e = this.cars.get(car.id);
      if (!e) return;
      e.active = false;
      for (const off of e.off.splice(0)) off();
      e.view.root.visible = false;
    });

    cb.onAdd("npcs", (npc: Npc, key: string) => {
      const ne = this.npcs.get(key);
      if (ne) {
        ne.npc = npc;
        ne.active = true;
        ne.yaw = npc.yaw;
        ne.lastState = npc.state;
        ne.drawn.x = npc.x; ne.drawn.y = npc.y; ne.drawn.z = npc.z;
        ne.flight = null; ne.blend = null;
        return;
      }
      const view = new CharacterView(humanLook(npc.look));
      this.view3d.root.addChild(view.root);
      this.npcs.set(key, { npc, view, yaw: npc.yaw, lastState: npc.state, drawn: { x: npc.x, y: npc.y, z: npc.z }, active: true, flight: null, blend: null });
    });
    cb.onRemove("npcs", (_npc: Npc, key: string) => {
      const ne = this.npcs.get(key);
      if (!ne) return;
      ne.active = false;
      ne.flight = null; ne.blend = null;
      ne.view.root.visible = false;
    });

    cb.onAdd("pickups", (pk, key: string) => {
      // each can turned its own way, the same for everyone (loose loot, lying about, has no can)
      const spin = Math.abs(pk.x * 7.3 + pk.z * 3.1);
      const can = pk.loose ? null : instance("loot_can");
      if (can) {
        can.position.set(pk.x, pk.y, pk.z);
        can.rotation.set(0, spin % 6.28, 0);
        this.view3d.root.addChild(can);
      }
      const food = pk.kind === PICKUP_FOOD, coffee = pk.kind === PICKUP_ZOOMIES;
      const item = instance(food ? FOODS[Math.floor(spin) % FOODS.length] : coffee ? "coffee" : PICKUP_MODELS[pk.kind], { castShadow: !!pk.loose });
      item.scale.set(food || coffee ? 1.6 : PICKUP_SCALES[pk.kind]);
      this.view3d.root.addChild(item);
      this.pickups.set(key, { can, item, key, lid: can ? find(can, "lid") : null, open: 0, fly: null });
    });
    // loose loot is had once (or goes): gone for good
    cb.onRemove("pickups", (_pk, key: string) => {
      const e = this.pickups.get(key);
      if (!e) return;
      e.item.destroy({ children: true });
      e.can?.destroy({ children: true });
      this.pickups.delete(key);
    });

    // Manhole lids off (someone climbed out): one off when we came just lies there; another flies off.
    // Back on, it slides back over the hole.
    let arriving = true;
    cb.onAdd("manholes", (fall: number, key: string) => {
      this.sewer.open(Number(key), (fall / 256) * Math.PI * 2, !arriving);
      if (!arriving) {
        const m = MANHOLES[Number(key)];
        if (m) sfx.manholeClank(m.x, m.z, 1);
      }
    });
    arriving = false;
    cb.onRemove("manholes", (_fall: number, key: string) => {
      this.sewer.close(Number(key));
      const m = MANHOLES[Number(key)];
      if (m) sfx.manholeClank(m.x, m.z, 0.4);
    });

    // Lamp posts down: one already down when we came just lies there; another falls once the car
    // that hit it gets there, as we draw it (ours already fell: this settles it). A new round
    // stands them all back up.
    let joining = true;
    cb.onAdd("poles", (fall: number, key: string) => {
      const i = Number(key);
      this.poleKnocks.confirm(i);
      this.poles.fall(i, fall, joining ? "lying" : "seen");
    });
    joining = false;
    cb.onRemove("poles", (_fall: number, key: string) => this.poles.stand(Number(key)));
  }

  private bindMessages() {
    const room = this.room;
    // someone else's shot: only its aim comes (origin in cm, yaw and pitch in 1/AIM_Q rad), and
    // its pellets are traced here, the same pattern the server traced, against the town and
    // everyone as we see them (what they hit is the server's say, and arrives as state)
    const shotDir = { yaw: 0, pitch: 0 }, shotPel = newPellet();
    room.onMessage("shot", (m: [string, number, number, number, number, number, number]) => {
      const [s, w, cx, cy, cz, qy, qp] = m;
      const x = cx / 100, y = cy / 100, z = cz / 100, yaw = qy / AIM_Q, pitch = qp / AIM_Q;
      const pe = this.players.get(s);
      let mx = x, my = y, mz = z;
      if (pe && pe.drawn) {
        const at = pe.view.muzzle(pe.drawn);
        mx = at.x; my = at.y; mz = at.z;
        pe.view.recoil();
      }
      const targets = this.drawnTargets(s, pe?.p.mode === Mode.Driving ? pe.p.veh : -1);
      for (let k = 0; k < WEAPONS[w].pellets; k++) {
        pelletDir(yaw, pitch, w, k, shotDir);
        const p = tracePellet(x, y, z, shotDir.yaw, shotDir.pitch, WEAPONS[w].range, targets, shotPel);
        // (from the drawn muzzle)
        this.pelletFx({ x: mx, y: my, z: mz }, p.x, p.y, p.z, w, p.target >= 0 || p.bin >= 0 || p.t < WEAPONS[w].range - 1e-3);
      }
      this.fx.muzzle(mx, my, mz, Math.sin(yaw), Math.cos(yaw), w);
      sfx.shot(w, x, z);
    });
    room.onMessage("punch", (m: { s: string }) => {
      const pe = this.players.get(m.s);
      if (pe) { pe.view.punch(); sfx.punch(pe.p.x, pe.p.z); }
    });
    room.onMessage("boom", (m: { x: number; y: number; z: number; r: number; c?: number }) => {
      // a car going up is a fireball; a stink bomb is a big green cloud
      if (m.c) { this.fx.explosion(m.x, m.y, m.z, m.r); sfx.boom(m.x, m.z); }
      else { this.fx.stink(m.x, m.y, m.z, m.r); sfx.stinkBoom(m.x, m.z); }
      const d = Math.hypot(m.x - this.rig.focus.x, m.z - this.rig.focus.z);
      this.shake(Math.max(0, 1 - d / 45) * 0.9);
    });
    room.onMessage("splat", (m: { x: number; y: number; z: number; s?: string; n?: string; c?: number; t?: number; l?: number[] }) => {
      // our own car's: the bang went off when our step predicted it
      if (m.n && this.runOvers.confirm(m.n) > 0) return;
      // anyone else's car: they take off, with the bang, as that car (drawn a moment in the past
      // here) gets to them, and their flight catches up with the present (see `NpcFlight`)
      const ne = m.n ? this.npcs.get(m.n) : undefined;
      if (ne?.active && !ne.flight && m.l?.length === 6 && m.t !== undefined) {
        const [x, y, z, vx, vy, vz] = m.l;
        ne.flight = {
          x, y, z, vx, vy, vz, t0: m.t, t: m.t, off: false, lag: 0, mine: false, born: performance.now(),
          wait: m.c !== undefined ? { car: m.c, until: performance.now() + FLIGHT_WAIT } : null,
          pose0: ne.npc.state === NpcState.KO ? "lying" : "move",
        };
        ne.blend = null;
        return;
      }
      this.fx.hitPuff(m.x, m.y, m.z);
      this.fx.pancake(m.x, m.y, m.z);
      sfx.boing(m.x, m.z);
      // flat as a pancake (then boing back)
      if (m.s) this.players.get(m.s)?.view.event("flatten");
      if (m.n) this.npcs.get(m.n)?.view.event("flatten");
    });
    room.onMessage("crash", (m: { x: number; z: number; big: number }) => {
      this.fx.impact(m.x, 0.8, m.z, m.big ? 30 : 12);
      sfx.crash(m.x, m.z, !!m.big);
    });
    room.onMessage("honk", (m: { id: number }) => {
      const e = this.cars.get(m.id);
      if (e) { sfx.honk(e.pose.x, e.pose.z, e.car.kind === CAR_GARBAGE); e.view.honk(); }
    });
    room.onMessage("kill", (m: { k: string; ks?: string; v: string; vs?: string; w: string; c?: number }) => {
      const icon = { icon: causeIcon(m.w, m.c) };
      const how = KILL_VERBS[m.w] ?? "got wrecked";
      this.hud.addFeed(m.k ? [m.k, icon, m.v] : [icon, `${m.v} ${how}`]);
      if (m.vs === room.sessionId) this.killerName = m.k;
    });
    // someone is out of the round, finishing `p`-th with `n` left
    room.onMessage("out", (m: { s: string; p: number; n: number }) => {
      if (m.s === room.sessionId) {
        this.myPlace = m.p;
        this.outAt = performance.now();
        sfx.sadTrombone();
      } else {
        const name = room.state.roster.get(m.s)?.name ?? "someone";
        this.hud.addFeed([{ icon: "tombstone" }, `${name} is out · #${m.p} · ${m.n} left`]);
      }
    });
    room.onMessage("round", (m: { e: string; s?: string; n?: string }) => {
      if (m.e === "countdown") sfx.nextTune(); // every round gets the other tune
      if (m.e === "victory") {
        if (m.s) this.champion = m.s;
        sfx.fanfare();
        const pe = m.s ? this.players.get(m.s) : undefined;
        const at = pe?.drawn ?? this.lastDrawn;
        this.fx.confettiCannon(at.x, at.y, at.z);
        for (let k = 0; k < 4; k++) this.fx.poof(at.x + (Math.random() - 0.5) * 3, at.y + 0.5, at.z + (Math.random() - 0.5) * 3);
        if (pe) { pe.view.event("taunt"); sfx.chitter(at.x, at.z); }
      }
    });
    room.onMessage("taunt", (m: { s: string; c?: number; m?: number }) => {
      // from inside a trash can: the can rattles and chitters
      if (m.c !== undefined && CITY.bins[m.c]) {
        const b = CITY.bins[m.c];
        this.bins.rattle(m.c);
        sfx.chitter(b.x, b.z);
        return;
      }
      // from down the sewer: the manhole over them rattles, and a chitter echoes up
      if (m.m !== undefined && MANHOLES[m.m]) {
        const h = MANHOLES[m.m];
        this.sewer.rattle(m.m);
        sfx.manholeRattle(h.x, h.z);
        sfx.chitter(h.x, h.z);
        return;
      }
      const pe = this.players.get(m.s);
      if (!pe?.active || !pe.drawn) return;
      // a gull: MINE!
      if (pe.p.mode === Mode.Gull) { this.gullTaunt(pe); return; }
      pe.view.event("taunt");
      sfx.chitter(pe.drawn.x, pe.drawn.z);
    });
    // a trash can was hit (`b`: by whom): its lid flies off (that's the synced state's job), and
    // whoever hid in it (`s`) pops out
    room.onMessage("bin", (m: { c: number; s: string; b: string; x: number; z: number }) => {
      const b = CITY.bins[m.c];
      if (!b) return;
      // our own shot or slap already clanged it
      if (m.b !== room.sessionId) {
        this.bins.hit(m.c, m.x, m.z);
        sfx.clang(b.x, b.z);
        this.fx.impact(b.x - m.x * 0.4, b.top - 0.3, b.z - m.z * 0.4, 8);
      }
      if (!m.s) return;
      sfx.boing(b.x, b.z);
      this.fx.poof(b.x, b.top - 0.4, b.z);
      const mine = m.s === room.sessionId;
      if (mine) this.shake(0.5);
      const at = this.view3d.worldToScreen(this.tmp.set(b.x, b.top + 1.2, b.z), this.screen);
      if (at) this.hud.popup([{ icon: "bin" }, mine ? "FOUND YOU!" : "FOUND!"], at.x, at.y, 0xff5d8f);
    });
    // someone hopped out of a can (`y`: which way)
    room.onMessage("unhide", (m: { s: string; c: number; y: number }) => {
      if (CITY.bins[m.c]) this.bins.hop(m.c, m.y);
    });
    // a manhole: someone went down it (`in`), climbed out (`out`: the lid's flight is the state's),
    // scurried under it, or is down there out of breath (`cough`: coming up soon)
    room.onMessage("manhole", (m: { m: number; s?: string; e: string }) => {
      const h = MANHOLES[m.m];
      if (!h) return;
      if (m.e === "in") { this.sewer.slide(m.m); sfx.sewerIn(h.x, h.z); }
      else if (m.e === "out") { sfx.sewerOut(h.x, h.z); this.fx.dustPuff(h.x, 0.1, h.z, 10); }
      else if (m.e === "cough") { this.sewer.rattle(m.m); sfx.cough(h.x, h.z); this.fx.dustPuff(h.x, 0.1, h.z, 3); }
      else { this.sewer.rattle(m.m); sfx.manholeRattle(h.x, h.z); }
    });
    // a gull let go of a dropping: we fall it ourselves, from where it was let go of
    room.onMessage("poop", (m: [string, number, number, number, number, number, number]) => {
      const [s, x, y, z, vx, vy, vz] = m;
      const pe = this.players.get(s);
      pe?.gull?.event("poop");
      // it falls the server's very path (so it lands where it does for everyone), drawn easing out
      // of the gull as drawn here (a moment behind, a metre or so off)
      const d = pe?.drawn;
      const from = d && Math.hypot(d.x - x / 100, d.z - z / 100) < 4 ? { x: d.x, y: d.y - 0.25, z: d.z } : null;
      this.drops.add({ x: x / 100, y: y / 100, z: z / 100, vx: vx / 100, vy: vy / 100, vz: vz / 100 }, s, from);
      sfx.plop(x / 100, z / 100);
    });
    // a dropping got someone (`h`: it counts; or it slid off a fresh one)
    room.onMessage("pooped", (m: { v: string; b: string; x: number; y: number; z: number; h: number }) => {
      this.drops.hit(m.b, m.x, m.y, m.z);
      this.drops.stick(m.v);
      this.fx.goo(m.x, m.y, m.z);
      sfx.splat(m.x, m.z);
      const me = room.sessionId;
      if (m.v === me && m.h) {
        this.hud.goo();
        sfx.squawk(undefined, undefined, 2);
        this.shake(0.15);
      }
      const at = this.view3d.worldToScreen(this.tmp.set(m.x, m.y + 0.8, m.z), this.screen);
      if (at) {
        if (m.b === me) this.hud.popup([{ icon: "splat" }, m.h ? "BULLSEYE!" : "SPLAT!"], at.x, at.y, 0xffffff);
        else if (m.v !== me) this.hud.popup(["SPLAT!"], at.x, at.y, 0xf6f6ee);
      }
    });
    // a gull shooed (`b`: by whom): feathers everywhere
    room.onMessage("shoo", (m: { s: string; b: string }) => {
      const pe = this.players.get(m.s);
      const d = pe?.drawn;
      if (!d) return;
      pe!.gull?.event("shoo");
      this.fx.featherBurst(d.x, d.y, d.z, 24);
      sfx.squawk(d.x, d.z, 3, true);
      const at = this.view3d.worldToScreen(this.tmp.set(d.x, d.y + 0.6, d.z), this.screen);
      if (at) this.hud.popup([m.b === room.sessionId ? "SHOO!" : m.s === room.sessionId ? "HEY!" : "SHOO!"], at.x, at.y, 0xffffff);
      if (m.b === room.sessionId) sfx.hitMarker();
    });
    // someone out of the round hatched as a gull (out of their tombstone)
    room.onMessage("gull", (m: { s: string; x: number; y: number; z: number }) => {
      this.fx.featherBurst(m.x, m.y, m.z, 18);
      this.fx.poof(m.x, Math.max(0, m.y - 1.2), m.z);
      sfx.squawk(m.x, m.z, 2);
      this.players.get(m.s)?.gull?.event("hatch");
      // that's us: the first time each round, say what a gull can do
      if (m.s === room.sessionId && this.gullRound !== room.state.round.number) {
        this.gullRound = room.state.round.number;
        this.gullBanner = performance.now() + 3200;
      }
    });
    // Garbage Day: the truck beeping as it lines up (the rest is `state.garbage`)
    room.onMessage("garbage", (m: { e: string }) => {
      if (m.e === "beep") {
        const e = this.cars.get(room.state.garbage.truck);
        if (e?.active) sfx.hydraulics(e.pose.x, e.pose.z);
      }
    });
    // we tried a can someone already hides in / someone tried ours
    room.onMessage("taken", (m: { c: number }) => this.knockKnock(m.c, "occupied!"));
    room.onMessage("knock", (m: { c: number }) => this.knockKnock(m.c, "knock knock!"));
    room.onMessage("ko", (m: { x: number; z: number; pts: number }) => {
      sfx.coin();
      const s = this.view3d.worldToScreen(this.tmp.set(m.x, 1.6, m.z), this.screen);
      if (s) this.hud.popup([{ icon: "star" }, `+${m.pts}`], s.x, s.y);
    });
    room.onMessage("feed", (m: { text: string; i?: string }) => {
      const icon = (ICON_NAMES as readonly string[]).includes(m.i ?? "") ? (m.i as IconName) : null;
      this.hud.addFeed(icon ? [{ icon }, m.text] : [m.text]);
    });

    room.onDrop(() => { this.link = "drop"; });
    room.onReconnect(() => {
      this.link = "ok";
      // input seqs start over after a reconnect: throws still waiting can never be settled now
      for (const t of this.pendingThrows) t.handle?.cancel();
      this.pendingThrows.clear();
      this.throws.clear();
    });
    room.onLeave(() => { this.link = "left"; });
  }

  /** A knock on trash can `i` (taken, or someone knocking on ours): it rattles, and says so. */
  private knockKnock(i: number, text: string) {
    const b = CITY.bins[i];
    if (!b) return;
    this.bins.rattle(i);
    sfx.knock(b.x, b.z);
    const at = this.view3d.worldToScreen(this.tmp.set(b.x, b.top + 1, b.z), this.screen);
    if (at) this.hud.popup([text], at.x, at.y, 0xb8f2e6);
  }

  // ------------------------------------------------------------------ local events
  /** Fire-and-forget presentation for our own predicted step (live steps only). */
  /** A gull's taunt: MINE! */
  private gullTaunt(pe: PlayerEntry) {
    const d = pe.drawn;
    if (!d) return;
    pe.gull?.event("squawk");
    sfx.squawk(d.x, d.z, 2);
    const at = this.view3d.worldToScreen(this.tmp.set(d.x, d.y + 0.8, d.z), this.screen);
    if (at) this.hud.popup(["MINE!"], at.x, at.y, 0xffffff);
  }

  private onLocalStep(ev: number, s: PlayerSim, cmd: PlayerInput, ctx: any, sim: SimCtx, prevMode: number, prevVeh: number) {
    const picked = sim.picked ?? "";
    // (on to a wall and off it again it's world coordinates throughout: those interpolate)
    const wall = (s.mode === Mode.Wall && prevMode === Mode.Foot) || (s.mode === Mode.Foot && prevMode === Mode.Wall);
    if (s.mode !== prevMode && !wall) this.modeSeq = ctx.tick;
    else if (ev & EV_COUPLE) {
      // onto the next train car: U carries on smoothly, but in a curve lx (and lyaw) are now
      // relative to a car turned another way, so don't interpolate this one step across it
      const a = trainCarPose(prevVeh, ctx.reckonTime, this.trainPose).yaw;
      if (Math.abs(wrapAngle(a - trainCarPose(s.veh, ctx.reckonTime, this.trainPose).yaw)) > 0.05) this.modeSeq = ctx.tick;
    }
    const view = this.players.get(this.room.sessionId)?.view;
    if (ev & EV_JUMP) { sfx.jump(); view?.event("jump"); }
    if (ev & (EV_LAND | EV_ROOF_LAND)) { sfx.land(); this.fx.dustPuff(s.x, s.y, s.z, 8); }
    if (ev & (EV_ENTER | EV_EXIT)) { sfx.door(); view?.event("hop"); }
    if (ev & EV_PICKUP) view?.event("pickup");
    if (ev & EV_CLIMB) { sfx.climb(); view?.event("hop"); }
    if (ev & EV_WALL) { sfx.claws(); view?.event("hop"); }
    if (ev & EV_FALL_OFF) sfx.whoosh();
    if (ev & EV_HIDE) this.bins.dive(s.veh);
    if (ev & EV_UNHIDE && prevMode === Mode.Hidden) this.bins.hop(prevVeh, Math.atan2(s.vx, s.vz));
    if (ev & EV_CRASH) { sfx.crash(s.x, s.z); this.shake(0.35); this.fx.impact(s.x + Math.sin(s.yaw) * 2, 0.6, s.z + Math.cos(s.yaw) * 2, 14); }
    if (ev & EV_TRAIN_HIT) { sfx.crash(s.x, s.z, true); sfx.boing(); this.shake(1); this.fx.impact(s.x, 1, s.z, 40); }
    // a fall from too high: splat, seeing stars for a moment
    if (ev & EV_DAZE) { sfx.land(); sfx.boing(); this.shake(0.45); this.fx.dustPuff(s.x, s.y, s.z, 16); view?.event("flatten"); }
    // down a manhole (the lid slides over us), up out of one (it flies off: the state's), stopping under one
    if (ev & EV_SEWER && sim.hole! >= 0) { this.sewer.slide(sim.hole!); sfx.sewerIn(); this.shake(0.12); }
    if (ev & EV_UNSEWER && sim.hole! >= 0) { sfx.sewerOut(); this.shake(0.15); }
    if (ev & EV_ARRIVE) sfx.manholeClank(undefined, undefined, 0.15);
    // the manholes we just scurried under rattle over us
    if (sim.rattled) for (const i of sim.rattled) { this.sewer.rattle(i); sfx.manholeRattle(); }
    // a gull: a dropping (it falls the same way on every screen), a snatch, letting go
    const gull = this.players.get(this.room.sessionId)?.gull;
    if (ev & EV_POOP && sim.poop) { gull?.event("poop"); this.drops.add(sim.poop, this.room.sessionId); sfx.plop(); }
    if (ev & EV_SNATCH) gull?.event("snatch");
    if (ev & EV_DROP) { gull?.event("drop"); sfx.flap(undefined, undefined, 2, 0.6); sfx.whoosh(); }

    if (ev & EV_FIRE) {
      this.stats.shots++;
      const verdict = this.localShot(s, cmd.aim, cmd.pitch / AIM_Q, cmd.eye, ctx.tick, ctx.reckonTime);
      if (verdict.hit) ctx.predict(this.hits, { tick: ctx.tick, ...verdict.hit });
      // trash cans in the way clang right now (the server knocks their lids off)
      for (const i of verdict.bins) { const b = CITY.bins[i]; this.bins.hit(i, b.x - s.x, b.z - s.z); sfx.clang(b.x, b.z); }
      const drawn = this.players.get(this.room.sessionId)?.drawn;
      const base = drawn ?? { x: s.x, y: s.y, z: s.z, yaw: cmd.aim, speed: 0, vy: 0, pose: "move" as const, aiming: true };
      const mz = view ? view.muzzle({ ...base, yaw: cmd.aim }) : { x: s.x, y: s.y + 1, z: s.z };
      // (from the gun as drawn, to where each pellet really ends)
      for (let k = 0; k < verdict.landed.length; k++) {
        this.pelletFx(mz, verdict.ends[k * 3], verdict.ends[k * 3 + 1], verdict.ends[k * 3 + 2], s.weapon, verdict.landed[k]);
      }
      this.fx.muzzle(mz.x, mz.y, mz.z, Math.sin(cmd.aim), Math.cos(cmd.aim), s.weapon);
      sfx.shot(s.weapon);
      view?.recoil();
      this.shake(s.weapon === Weapon.Shotgun ? 0.28 : 0.1);
    }
    if (ev & EV_PUNCH) {
      view?.punch();
      sfx.whoosh();
      const hit = this.localPunch(s, cmd.aim, ctx.reckonTime);
      if (hit) { ctx.predict(this.hits, { tick: ctx.tick, ...hit }); sfx.punch(); }
      for (const i of this.binsInReach(s, cmd.aim)) { const b = CITY.bins[i]; this.bins.hit(i, Math.sin(cmd.aim), Math.cos(cmd.aim)); sfx.clang(b.x, b.z); }
    }
    // (a stink bomb let go of is the `throws` channel's: see `onThrow`)
    // the step looted a can (and already holds its ammo): the loot vanishes now
    if (picked) ctx.predict(this.pickupEvents, picked);
  }

  /**
   * Our step let go of a stink bomb (a live step; `throws`' optimistic feedback): it's in the
   * air at once, on its exact path, and the arm comes over with a whoosh. The server's grenade
   * takes over when it arrives; if it doesn't, the ghost fizzles (`throws`' onReject).
   */
  private onThrow(t: Throw) {
    this.stats.thrown++;
    this.pendingThrows.add(t);
    const l = t.launch;
    const handle = this.grenadeSpawns.spawn({ ...l, seq: t.tick, acc: 0 });
    handle.data.at = this.room.clock.serverNow();
    handle.data.path = grenadePath(l);
    handle.data.t0 = 0;
    handle.data.shown = true;
    t.handle = handle;
    const pe = this.players.get(this.room.sessionId);
    const paw = pe?.view.corkAt({ x: 0, y: 0, z: 0 }) ?? pe?.cork;
    if (paw) handle.data.from = { ...paw };
    pe?.view.event("throw", t.power);
    sfx.toss(t.power);
    this.hud.windupEnded("throw");
    this.shake(0.06 + 0.12 * t.power);
    for (let i = 0; i < 3; i++) this.fx.stinkWisp(l.x, l.y, l.z, 1);
  }

  /** A predicted stink bomb the server never threw: it fizzles out where it had got to. */
  private fizzle(g: GrenadeLike) {
    this.fx.fizzle(g.x, g.y, g.z);
    sfx.fizzle();
  }

  /** Where a remote player stands in the physics view (what the server's rewind sees). */
  private physPlayer(pe: PlayerEntry, reckonTime: number): { x: number; y: number; z: number } | null {
    const d = pe.tl.at(this.remoteTime) ?? pe.p;
    const p = pe.p;
    // in a car or a trash can: that's what gets hit; down the sewer, nothing can
    if (d.mode === Mode.Driving || d.mode === Mode.Hidden || d.mode === Mode.Sewer) return null;
    if (d.mode === Mode.Train) {
      // train riders: (lx, U) on the timetable train, at the instant the server rewinds to
      const w = trainPointWorld(d.veh, reckonTime, this.phys.value(p, "lx"), this.phys.value(p, "lz"), { x: 0, z: 0 });
      return { x: w.x, y: this.phys.value(p, "y"), z: w.z };
    }
    if (d.mode === Mode.Roof) {
      const ce = this.cars.get(d.veh);
      if (!ce) return null;
      const pl = { x: this.phys.value(ce.car, "x"), z: this.phys.value(ce.car, "z"), yaw: this.phys.value(ce.car, "yaw") };
      const w = localToWorld(pl, this.phys.value(p, "lx"), this.phys.value(p, "lz"), { x: 0, z: 0 });
      return { x: w.x, y: this.phys.value(p, "y"), z: w.z };
    }
    return { x: this.phys.value(p, "x"), y: this.phys.value(p, "y"), z: this.phys.value(p, "z") };
  }

  /**
   * Client-side verdict for our shot, against the world as the server will rewind it (the same
   * `tracePellet` the server runs). `ends` holds each pellet's end as x, y, z, and `landed`
   * whether it hit anything (or just ran out of range). `hit.nums`: what each raccoon hit takes
   * (summed the way the server sums it), and where over it to say so.
   */
  private localShot(s: PlayerSim, aim: number, pitch: number, eye: boolean, tick: number, reckonTime: number) {
    const w = WEAPONS[s.weapon];
    const ox = s.x, oz = s.z, oy = shotHeight(s.x, s.y, s.z, s.mode === Mode.Driving, eye);
    const ends: number[] = [];
    /** Trash cans the pellets hit (each once). */
    const bins: number[] = [];
    let hit: { x: number; y: number; z: number } | null = null;
    const targets: ShotTarget[] = [];
    /** The raccoons' session ids (they come first among the targets). */
    const keys: string[] = [];
    const npcPos = { x: 0, y: 0, z: 0 };
    const gulls: { x: number; y: number; z: number }[] = [];
    for (const [sid, pe] of this.players) {
      if (!pe.active || sid === this.room.sessionId || pe.p.mode === Mode.Dead) continue;
      const st = this.physPlayer(pe, reckonTime);
      if (!st) continue;
      if ((pe.tl.at(this.remoteTime) ?? pe.p).mode === Mode.Gull) { gulls.push(st); continue; }
      targets.push({ x: st.x, z: st.z, y0: st.y, y1: st.y + RACCOON_TOP, y: st.y + 0.9, r: PLAYER_RADIUS + 0.2 }); keys.push(sid);
    }
    const raccoons = keys.length;
    for (const q of gulls) targets.push(gullTarget(q.x, q.y, q.z));
    for (const ne of this.npcs.values()) {
      if (!ne.active || ne.npc.state > NpcState.Flying) continue;
      const n = this.predict.readAt(ne.npc, ["x", "y", "z"], reckonTime, npcPos);
      targets.push({ x: n.x, z: n.z, y0: n.y, y1: n.y + TOWNSFOLK_TOP, y: n.y + 0.8, r: 0.5 });
    }
    for (const ce of this.cars.values()) {
      if (!ce.active || ce.car.state === 2 || (s.mode === Mode.Driving && ce.car.id === s.veh)) continue;
      const t0 = CAR_TYPES[ce.car.kind];
      const c = ce.car;
      targets.push({
        x: this.phys.value(c, "x"), z: this.phys.value(c, "z"), y0: c.y, y1: c.y + t0.roof, y: c.y + t0.roof * 0.55, r: 0,
        yaw: this.phys.value(c, "yaw"), hw: t0.halfW, hl: t0.halfL,
      });
    }
    const pel = newPellet(), dir = { yaw: 0, pitch: 0 };
    const landed: boolean[] = [], dmg = new Array<number>(raccoons).fill(0);
    // (the yaw rounded as the server rounds it for everyone watching)
    const yaw = Math.round(shotYaw(aim, s.weapon, tick) * AIM_Q) / AIM_Q;
    for (let k = 0; k < w.pellets; k++) {
      pelletDir(yaw, pitch, s.weapon, k, dir);
      tracePellet(ox, oy, oz, dir.yaw, dir.pitch, w.range, targets, pel);
      if (pel.bin >= 0 && !bins.includes(pel.bin)) bins.push(pel.bin);
      ends.push(pel.x, pel.y, pel.z);
      landed.push(pel.target >= 0 || pel.bin >= 0 || pel.t < w.range - 1e-3);
      if (pel.target >= 0 && !hit) hit = { x: pel.x, y: pel.y, z: pel.z };
      if (pel.target >= 0 && pel.target < raccoons) dmg[pel.target] += pelletDamage(s.weapon, pel.t);
    }
    const nums: DamageNum[] = [];
    for (let i = 0; i < raccoons; i++) {
      if (dmg[i] > 0) nums.push({ k: keys[i], d: Math.round(dmg[i]), x: targets[i].x, y: targets[i].y1 + 0.35, z: targets[i].z });
    }
    return { ends, landed, hit: hit ? { ...hit, nums } : null, bins };
  }

  /**
   * One pellet's look, from the gun as drawn at `from` to where it ended: its streak (thinning out
   * over its last stretch if it hit nothing), the bits where it landed, and the Blunderbuss's junk
   * flying out along it. All drawn from what this client already knows: none of it is sent.
   */
  private pelletFx(from: { x: number; y: number; z: number }, x: number, y: number, z: number, weapon: number, landed: boolean) {
    this.fx.tracer(from.x, from.y, from.z, x, y, z, weapon, !landed);
    if (landed) this.fx.impact(x, y, z, 4, weapon);
    if (weapon === Weapon.Shotgun) this.fx.junk(from.x, from.y, from.z, x, y, z);
  }

  /** Our hits' damage numbers, over the raccoons they hit (`sign` -1: take them back). */
  private damageNumbers(nums: DamageNum[] | undefined, sign: number) {
    for (const n of nums ?? []) {
      const at = this.view3d.worldToScreen(this.tmp.set(n.x, n.y, n.z), this.screen);
      if (at) this.hud.damageNumber(n.k, n.d * sign, at.x, at.y);
    }
  }

  /** Trash cans a slap at `aim` reaches (as the server judges it in `Combat.melee`). */
  private binsInReach(s: PlayerSim, aim: number): number[] {
    const dx = Math.sin(aim), dz = Math.cos(aim);
    const out: number[] = [];
    CITY.bins.forEach((b, i) => {
      const rx = b.x - s.x, rz = b.z - s.z;
      const along = rx * dx + rz * dz;
      if (Math.abs(b.y - s.y) < 1.2 && along > -0.2 && along - BIN_R < WEAPONS[0].range && Math.abs(rx * dz - rz * dx) < 0.9 + BIN_R * 0.5) out.push(i);
    });
    return out;
  }

  private localPunch(s: PlayerSim, aim: number, reckonTime: number) {
    const dx = Math.sin(aim), dz = Math.cos(aim);
    const reach = (x: number, z: number) => {
      const rx = x - s.x, rz = z - s.z;
      const along = rx * dx + rz * dz;
      return along > -0.2 && along < WEAPONS[0].range && Math.abs(rx * dz - rz * dx) < 0.9;
    };
    for (const [sid, pe] of this.players) {
      if (!pe.active || sid === this.room.sessionId || pe.p.mode === Mode.Dead) continue;
      const st = this.physPlayer(pe, reckonTime);
      if (st && reach(st.x, st.z) && Math.abs(st.y - s.y) <= 1.2) {
        return { x: st.x, y: st.y + 0.9, z: st.z, nums: [{ k: sid, d: WEAPONS[Weapon.Fists].damage, x: st.x, y: st.y + RACCOON_TOP + 0.35, z: st.z }] };
      }
    }
    const npcPos = { x: 0, y: 0, z: 0 };
    for (const ne of this.npcs.values()) {
      if (!ne.active || ne.npc.state > NpcState.Flee) continue;
      const { x, y, z } = this.predict.readAt(ne.npc, ["x", "y", "z"], reckonTime, npcPos);
      if (reach(x, z) && Math.abs(y - s.y) <= 1.2) return { x, y: y + 0.9, z };
    }
    return null;
  }

  // ------------------------------------------------------------------ keys
  /**
   * Over the raccoon's back, or overhead. Behind it, the mouse is captured to turn the camera
   * (the click on PLAY! or a key press may capture it; otherwise the next click does).
   */
  private setCamera(mode: CamMode, instant = false) {
    this.rig.setMode(mode, instant);
    this.controls.wantLock = mode === "behind";
    if (mode === "behind" && this.controls.device === "keys") this.controls.lockPointer();
    if (mode === "top") this.controls.unlockPointer();
  }

  /** The camera shakes, and a pad in use rumbles with it. */
  private shake(k: number) {
    this.rig.shake(k);
    this.controls.rumble(k);
  }

  /** A key went down, or a pad button that isn't a step's business ("PadL3", "PadLT"…). */
  private onKey(code: string) {
    if (code === "KeyM") { sfx.toggleMute(); this.hud.setMuted(sfx.muted); }
    if (code === "KeyB") sfx.nextTune();
    if (code === "KeyN") this.hud.showNet = !this.hud.showNet;
    if (code === "F1") this.hud.showHelp = !this.hud.showHelp;
    // C (R3): the camera, over the raccoon's back or overhead (the choice is kept for the next game)
    if ((code === "KeyC" || code === "PadR3") && this.me) {
      const next = this.rig.mode === "behind" ? "top" : "behind";
      this.setCamera(next);
      try { localStorage.setItem(CAMERA_KEY, next); } catch { /* private window */ }
    }
    // V (the d-pad's up): out of the round, fly about as a gull, or watch someone instead
    if ((code === "KeyV" || code === "PadUp") && this.me) {
      const me = this.myInfo(), r = this.room.state.round;
      // (as often as the server heeds it)
      const now = performance.now();
      if (me && me.status !== PlayerStatus.Playing && r.phase === RoundPhase.Live && now > this.toggleAt) {
        this.toggleAt = now + 1500;
        this.wantsWatch = !this.wantsWatch;
        this.room.send("gull", { on: !this.wantsWatch });
        sfx.squawk(undefined, undefined, 1);
      }
    }
    // L3: a honk in a car, a taunt on foot (and so is B)
    if ((code === "KeyH" || code === "PadL3") && this.me?.state.mode === Mode.Driving) {
      this.room.send("honk");
      sfx.honk();
    }
    // T: taunt (a butt-wiggle and a chitter; the server tells whoever is near)
    if ((code === "KeyT" || code === "PadB" || code === "PadL3") && !this.spectating && this.me) {
      const mode = this.me.state.mode;
      const now = performance.now();
      if (mode !== Mode.Dead && mode !== Mode.Knocked && mode !== Mode.Driving && now > this.tauntAt) {
        this.tauntAt = now + TAUNT_MS;
        this.room.send("taunt");
        const pe = this.players.get(this.room.sessionId);
        if (mode === Mode.Gull) { if (pe) this.gullTaunt(pe); }
        else {
          pe?.view.event("taunt");
          if (mode === Mode.Hidden) this.bins.rattle(this.me.state.veh);
          if (mode === Mode.Sewer) { this.sewer.rattle(this.me.state.lz); sfx.manholeRattle(); }
          sfx.chitter();
        }
      }
    }
    // G (LT on foot) with no stink bombs: an empty click (winding one up is the step's business: sendInput)
    if ((code === "KeyG" || code === "PadLT") && !this.spectating && this.me) {
      const s = this.me.state;
      if (s.ammo4 <= 0 && s.mode !== Mode.Dead && s.mode !== Mode.Knocked && !(code === "PadLT" && s.mode === Mode.Driving)) {
        sfx.dud();
        const at = this.view3d.worldToScreen(this.tmp.set(this.lastDrawn.x, this.lastDrawn.y + 2, this.lastDrawn.z), this.screen);
        if (at) this.hud.popup([{ icon: "wpn_grenade" }, "no stink bombs!"], at.x, at.y, 0xb8b0d0);
      }
    }
    // spectating: switch whom we watch (a gull's A and D fly it)
    if (this.spectating) {
      if (code === "KeyD" || code === "ArrowRight" || code === "PadRB") this.cycle++;
      if (code === "KeyA" || code === "ArrowLeft" || code === "PadLB") this.cycle--;
    }
  }

  // ------------------------------------------------------------------ battle royale
  private myInfo(): PlayerInfo | undefined {
    return this.room.state.roster.get(this.room.sessionId);
  }

  /** Out of the round (or waiting for the next one): we watch someone else. */
  private get spectating(): boolean {
    const r = this.room.state.round;
    const me = this.myInfo();
    if (!me || r.phase === RoundPhase.Warmup || me.status === PlayerStatus.Playing) return false;
    // flying about as a gull, we're in the game (only the victory lap is everyone's to watch); and
    // knocked out with a gull to come, we stay with our tumble and tombstone till it hatches
    if (this.me?.state.mode === Mode.Gull && r.phase !== RoundPhase.Victory) return false;
    if (r.phase === RoundPhase.Live && me.status === PlayerStatus.Out && !this.wantsWatch && performance.now() - this.outAt < GULL_HATCH_MS + 1500) return false;
    // knocked out just now: watch our own tumble (and the banner) for a moment first
    return me.status === PlayerStatus.Waiting || r.phase === RoundPhase.Victory || performance.now() - this.outAt > 2500;
  }

  private cycle = 0;

  /** Pick (and tell the server) whom we watch: the winner, our killer, the leader… or our pick. */
  private updateSpectate() {
    const clicks = this.controls.consumeClicks();
    if (!this.spectating) {
      this.cycle = 0;
      if (this.watching) { this.watching = ""; this.rig.cut(); }
      return;
    }
    const me = this.room.sessionId;
    const roster = this.room.state.roster;
    const r = this.room.state.round;
    const live = [...roster.entries()]
      .filter(([sid, i]) => sid !== me && i.status === PlayerStatus.Playing)
      .sort((a, b) => a[1].name.localeCompare(b[1].name));
    const ids = live.map(([sid]) => sid);
    let next = this.watching;
    if (r.phase === RoundPhase.Victory && r.winner && r.winner !== me) next = r.winner;
    else if (!ids.includes(next)) {
      const killer = this.myInfo()?.killedBy ?? "";
      const leader = live.slice().sort((a, b) => b[1].roundKills - a[1].roundKills)[0]?.[0];
      next = ids.includes(killer) ? killer : leader ?? "";
    }
    const turn = clicks + this.cycle;
    this.cycle = 0;
    if (turn && ids.length && r.phase !== RoundPhase.Victory) {
      const i = Math.max(0, ids.indexOf(next));
      next = ids[(((i + turn) % ids.length) + ids.length) % ids.length];
    }
    if (next !== this.watching) {
      this.watching = next;
      this.rig.cut();
    }
    if (this.watching && this.watching !== this.sentWatching) {
      this.sentWatching = this.watching;
      this.room.send("spectate", { s: this.watching });
    }
  }

  // ------------------------------------------------------------------ render helpers
  /** Our own state is drawn raw for the step that changed our mode (nothing to interpolate from). */
  private get rawSelf() { return this.input.sentCount === this.modeSeq; }

  /** Render pose of a car: our prediction when we drive it, the interpolated stream otherwise. */
  private updateCarPose(e: CarEntry, dt: number) {
    const st = this.me.state;
    // decided by the prediction alone: the server's `driver` field is a round trip late
    const mine = st.mode === Mode.Driving && st.veh === e.car.id;
    let x: number, y: number, z: number, yaw: number, vx: number, vz: number;
    if (mine) {
      const raw = this.rawSelf;
      const v = (f: "x" | "y" | "z" | "yaw" | "vx" | "vz") => (raw ? st[f] : this.predict.value(this.self, f));
      x = v("x"); y = v("y"); z = v("z"); yaw = v("yaw"); vx = v("vx"); vz = v("vz");
    } else {
      const c = e.car;
      x = this.predict.value(c, "x"); y = this.predict.value(c, "y"); z = this.predict.value(c, "z");
      yaw = this.predict.value(c, "yaw");
      vx = this.predict.value(c, "vx"); vz = this.predict.value(c, "vz");
      if (e.mine) {
        // just stepped out: the stream still trails our prediction by its whole lag
        // (interp delay + round trip + input queueing). Measure it along the motion.
        const v2 = vx * vx + vz * vz;
        const lag = v2 > 1 ? ((e.pose.x - x) * vx + (e.pose.z - z) * vz) / v2 : 0;
        e.leadS = Math.max(0, Math.min(0.5, lag));
        e.leading = e.leadS > 0;
        e.lead = 1;
        e.lvx = e.pose.vx; e.lvz = e.pose.vz;
      }
      // the car we just left keeps rolling from where we left it: project the lag away
      // until someone else takes it or it stops (the server coasts it with the same physics)
      const sp = Math.hypot(vx, vz);
      if (e.leading && ((c.driver !== "" && c.driver !== this.room.sessionId) || c.state !== 0 || sp < 0.05)) e.leading = false;
      e.lead += ((e.leading ? 1 : 0) - e.lead) * (1 - Math.exp(-dt / 0.15));
      if (e.lead > 0.001) {
        const f = 1 - Math.exp(-dt / 0.2);
        e.lvx += (vx - e.lvx) * f; e.lvz += (vz - e.lvz) * f;
        const k = e.lead * e.leadS * Math.min(1, sp / 2);
        x += e.lvx * k; z += e.lvz * k;
      }
    }
    if (mine !== e.mine) {
      // switching render source: glide from where the car was drawn
      e.ox = e.pose.x - x; e.oz = e.pose.z - z; e.oyaw = wrapAngle(e.pose.yaw - yaw);
      if (Math.hypot(e.ox, e.oz) > 15) { e.ox = 0; e.oz = 0; e.oyaw = 0; }
      e.mine = mine;
    }
    const k = Math.exp(-dt / 0.12);
    e.ox *= k; e.oz *= k; e.oyaw *= k;
    e.pose.x = x + e.ox; e.pose.y = y; e.pose.z = z + e.oz; e.pose.yaw = yaw + e.oyaw;
    e.pose.vx = vx; e.pose.vz = vz;
    // its acceleration, smoothed (per-patch velocities are jittery)
    const lp = 1 - Math.exp(-dt / 0.12);
    e.ax += ((vx - e.pvx) / Math.max(dt, 1e-3) - e.ax) * lp;
    e.az += ((vz - e.pvz) / Math.max(dt, 1e-3) - e.az) * lp;
    e.pvx = vx; e.pvz = vz;
  }

  /** Where a player is drawn: riders are rebuilt from their platform's drawn pose. */
  private renderState(sid: string, pe: PlayerEntry): CharState {
    const p = pe.p;
    const isMe = sid === this.room.sessionId;
    const st = this.me.state;
    // discrete state on the same timeline as the body: our prediction, or the remote's history
    const d: Discrete = isMe ? st : (pe.tl.at(this.remoteTime) ?? p);
    const mode = d.mode;
    const raw = isMe && this.rawSelf;
    const v = (f: "x" | "y" | "z" | "lx" | "ly" | "lz" | "yaw" | "lyaw" | "vx" | "vz") => (raw ? (st as any)[f] as number : this.predict.value(p, f));
    let x = v("x"), y = v("y"), z = v("z"), yaw = v("yaw");
    const speed = Math.hypot(v("vx"), v("vz"));
    /** The yaw of the roof they're on, as drawn (null: not on one). */
    let platYaw: number | null = null;
    if (mode === Mode.Train) {
      // On the train drawn at renderNow, at the rider's (lx, U): U runs on continuously from
      // car to car, so a rider crossing a coupling interpolates straight across it.
      const w = trainPointWorld(d.veh, this.renderNow, v("lx"), v("lz"), { x: 0, z: 0 });
      x = w.x; z = w.z; y = v("ly");
      platYaw = trainCarPose(d.veh, this.renderNow, this.trainPose).yaw;
      // Facing: the world yaw (lyaw jumps when the car changes). A remote rider's is sampled
      // at remoteTime while the train is drawn at renderNow: add the turn the car made since.
      if (!isMe) {
        const then = trainCarPose(d.veh, this.remoteTime, this.trainPose).yaw;
        yaw += wrapAngle(platYaw - then);
      }
    } else if (mode === Mode.Roof) {
      const ce = this.cars.get(d.veh);
      if (ce) {
        const pl = ce.pose;
        const w = localToWorld(pl, v("lx"), v("lz"), { x: 0, z: 0 });
        x = w.x; z = w.z; y = pl.y + v("ly");
        yaw = pl.yaw + v("lyaw");
        platYaw = pl.yaw;
      }
    }
    // Just got up there (a climb puts you straight onto a car's or a train's roof, or up onto a
    // ledge): measure, once, how far below and beside it we drew them last frame, in the roof's
    // frame so it rides along (a ledge's is the world's)...
    const was = pe.drawn;
    const plat = platYaw !== null;
    const fy = platYaw ?? 0;
    const c = Math.cos(fy), s = Math.sin(fy);
    const ontoRoof = plat && pe.drawnMode !== Mode.Roof && pe.drawnMode !== Mode.Train;
    // (a ledge: on foot, airborne last frame and standing now, well above where we were drawn;
    // or on a wall last frame, and climbed over its top)
    const ontoLedge = !plat && !pe.lift && mode === Mode.Foot && d.grounded && !!was
      && ((was.pose === "air" && y - was.y > 0.5) || (was.pose === "wall" && y - was.y > 0.3));
    if (was && pe.liftFrom !== was && (ontoRoof || ontoLedge)) {
      pe.liftFrom = was;
      const dx = was.x - x, dy = was.y - y, dz = was.z - z;
      // (not from far away: a teleport, or back in the round)
      pe.lift = dx * dx + dy * dy + dz * dz < 16
        ? { x: dx * c - dz * s, y: dy, z: dx * s + dz * c, at: this.renderNow, ms: CLIMB_GLIDE_MS + Math.max(0, -dy - 1) * 40, plat }
        : null;
    }
    // (off the roof mid-scramble, or onto one from a ledge's: drop it)
    if (pe.lift && pe.lift.plat !== plat) pe.lift = null;
    // ...and scramble up from there: up first (carrying on from the jump, slowing as we top
    // out), then in over the rim
    if (pe.lift) {
      const t = Math.max(0, (this.renderNow - pe.lift.at) / pe.lift.ms);
      if (t >= 1) pe.lift = null;
      else {
        const h = Math.max(0, (t - 0.25) / 0.75);
        const up = (1 - t) ** 2, over = 1 - h * h * (3 - 2 * h);
        const lx = pe.lift.x * over, lz = pe.lift.z * over;
        x += lx * c + lz * s; z += -lx * s + lz * c;
        y += pe.lift.y * up;
      }
    }
    let pose: CharState["pose"] = "move";
    // on a wall: how fast up it and along it (to the right, facing it), for the crawl
    let wallUp = 0, wallSide = 0;
    if (mode === Mode.Wall) {
      pose = "wall";
      const ly = v("lyaw");
      wallUp = isMe ? st.vy : this.predict.value(p, "vy");
      wallSide = v("vx") * Math.cos(ly) - v("vz") * Math.sin(ly);
    } else if (mode === Mode.Driving || mode === Mode.Hidden || mode === Mode.Sewer || mode === Mode.Gull) pose = "hidden";
    else if (mode === Mode.Knocked || mode === Mode.Dead) pose = d.grounded && speed < 2 ? "lying" : "ragdoll";
    else if (!d.grounded) pose = "air";
    const weapon = isMe ? st.weapon : p.weapon;
    // the zoomies (a coffee): galloping on all fours, the gun tucked away until a shot
    const zoomies = (isMe ? st.zoomies : p.zoomies) > 0;
    // winding up a stink bomb: ours as predicted, theirs on the timeline their body is drawn at
    const charge = raw ? st.charge : this.predict.value(p, "charge");
    const windup = pose === "move" || pose === "air" ? Math.max(0, Math.min(1, charge / GRENADE_CHARGE_STEPS)) : 0;
    // (on a wall the paws are busy holding on: no gun out)
    const aiming = mode !== Mode.Wall && ((weapon !== Weapon.Fists && !zoomies) || (isMe && this.controls.fire(mode === Mode.Driving)) || windup > 0);
    if (isMe && aiming && mode !== Mode.Driving) yaw = this.aimYaw;
    // riding: what the platform under us is doing (for the surf sway)
    const ride = mode === Mode.Roof || mode === Mode.Train;
    let platAx = 0, platAz = 0, platSpeed = 0;
    if (mode === Mode.Train) {
      const a = this.trains.accel(d.veh, this.renderNow, this.accTmp);
      platAx = a.x; platAz = a.z;
      const tp = trainCarPose(d.veh, this.renderNow, this.trainPose);
      platSpeed = Math.hypot(tp.vx, tp.vz);
    } else if (mode === Mode.Roof) {
      const ce = this.cars.get(d.veh);
      if (ce) { platAx = ce.ax; platAz = ce.az; platSpeed = Math.hypot(ce.pose.vx, ce.pose.vz); }
    }
    const round = this.room.state.round;
    return {
      x, y, z, yaw, speed, vy: isMe ? st.vy : this.predict.value(p, "vy"), pose, aiming,
      vx: v("vx"), vz: v("vz"), ride, platAx, platAz, platSpeed, zoomies, windup, wallUp, wallSide,
      dance: round.phase === RoundPhase.Victory && round.winner === sid,
    };
  }

  /**
   * Someone else run over by a train, the moment the train gets to them here. They're drawn
   * ~100 ms in the past and the train at the present, so the stream's knock would only show once
   * the train had gone through them. The hit is the shared step's own test, and a knocked body's
   * step reads no input, so we run their body ourselves from where we drew them (at renderNow, the
   * train's clock) until the stream has them back on their feet, or never knocks them: then we let go.
   */
  private remoteTrainHit(pe: PlayerEntry, st: CharState, mode: number, dt: number) {
    const DT = 1 / TICK_RATE;
    const ctx = (time: number): SimCtx => ({ dt: DT, time, memo: (_k, f) => f(), frozen: false });
    let h = pe.trainHit;
    if (!h) {
      const b = pe.trainBlend;
      if (b) {
        b.age += dt;
        const k = 1 - Math.min(1, b.age / TRAIN_BLEND_S);
        const e = k * k * (3 - 2 * k);
        st.x += b.x * e; st.y += b.y * e; st.z += b.z * e;
        if (b.age >= TRAIN_BLEND_S) pe.trainBlend = null;
      }
      if (mode !== Mode.Foot || st.y > TRAIN_ROOF - 0.3 || !pe.active) return;
      let near = false;
      for (let slot = 0; slot < TRAIN_SLOTS && !near; slot++) {
        const t = trainCarPose(slot, this.renderNow, this.trainPose);
        near = (t.x - st.x) ** 2 + (t.z - st.z) ** 2 < 100;
      }
      if (!near) return;
      // one step of their body as drawn, against the trains where they're drawn
      const s = {} as PlayerSim;
      for (const f of SIM_FIELDS) (s as any)[f] = (pe.p as any)[f];
      Object.assign(s, { x: st.x, y: st.y, z: st.z, vx: st.vx ?? 0, vy: st.vy, vz: st.vz ?? 0, yaw: st.yaw, mode: Mode.Foot, veh: -1, grounded: st.pose !== "air", timer: 0, charge: 0 });
      if (!(stepPlayer(ctx(this.renderNow), s, NO_INPUT, BARE_WORLD) & EV_TRAIN_HIT)) return;
      h = pe.trainHit = { sim: s, prev: { x: st.x, y: st.y, z: st.z }, time: this.renderNow, at: this.renderNow, seen: false };
      pe.trainBlend = null;
      sfx.crash(st.x, st.z, true);
      sfx.boing(st.x, st.z);
      this.fx.impact(st.x, 1, st.z, 40);
    }
    if (mode === Mode.Knocked || mode === Mode.Dead) h.seen = true;
    // knocked out by it: no getting up
    if (mode === Mode.Dead) h.sim.mode = Mode.Dead;
    const lost = !h.seen && this.renderNow - h.at > INTERP_DELAY_MS + this.room.clock.smoothedRtt() + TRAIN_HIT_GRACE;
    const up = h.seen && mode !== Mode.Knocked && mode !== Mode.Dead;
    // our body, stepped just past the present (the train's clock), drawn between its last two steps
    let steps = 0;
    while (h.time < this.renderNow && steps++ < 10) {
      const s = h.sim;
      h.prev.x = s.x; h.prev.y = s.y; h.prev.z = s.z;
      h.time += DT * 1000;
      stepPlayer(ctx(h.time), s, NO_INPUT, BARE_WORLD);
    }
    const a = Math.max(0, Math.min(1, 1 - (h.time - this.renderNow) / (DT * 1000)));
    const s = h.sim;
    const x = h.prev.x + (s.x - h.prev.x) * a, y = h.prev.y + (s.y - h.prev.y) * a, z = h.prev.z + (s.z - h.prev.z) * a;
    if (lost || up || !pe.active) {
      // back to the stream, from here (a jump of more than a few metres is a teleport: no glide)
      const dx = x - st.x, dy = y - st.y, dz = z - st.z;
      pe.trainBlend = dx * dx + dy * dy + dz * dz < 16 ? { x: dx, y: dy, z: dz, age: 0 } : null;
      pe.trainHit = null;
      if (pe.trainBlend) { st.x = x; st.y = y; st.z = z; }
      return;
    }
    const speed = Math.hypot(s.vx, s.vz);
    st.x = x; st.y = y; st.z = z; st.yaw = s.yaw;
    st.vx = s.vx; st.vz = s.vz; st.vy = s.vy; st.speed = speed;
    st.pose = s.mode === Mode.Knocked || s.mode === Mode.Dead ? (s.grounded && speed < 2 ? "lying" : "ragdoll") : s.grounded ? "move" : "air";
    st.aiming = false; st.windup = 0; st.ride = false;
  }

  private accTmp = { x: 0, z: 0 };
  private cork = { x: 0, y: 0, z: 0 };
  private pathPos = { x: 0, y: 0, z: 0 };

  /** How much animation a character gets: full near the camera, less further out. */
  private lodAt(x: number, z: number) {
    const d2 = (x - this.rig.focus.x) ** 2 + (z - this.rig.focus.z) ** 2;
    return d2 < 35 * 35 ? 0 : d2 < 70 * 70 ? 1 : 2;
  }

  // ------------------------------------------------------------------ frame
  frame(ticker: Ticker) {
    if (!this.me) return;
    const dt = Math.min(0.1, ticker.deltaMS / 1000);
    this.elapsed += dt;
    // this frame's rAF timestamp (pixi only moves `lastTime` forward after its listeners ran)
    const now = ticker.lastTime + ticker.elapsedMS;
    (window as any).__fps = ticker.FPS;
    const st = this.me.state;

    // 0. a server-side teleport (respawn, round start): a new life somewhere else. Predict
    //    from it, don't glide there. (Polled, not listened: survives dev-mode restores.)
    if (this.self.life !== this.lastLife) {
      this.lastLife = this.self.life;
      this.me.reset();
      this.rig.cut();
      this.outAt = 0;
      this.myPlace = 0;
      this.killerName = "";
    }

    // 1. advance the clock: how many fixed steps are due this frame
    const n = this.predict.tick(now);
    this.phys.tick(now);

    // 2. stage + send exactly that many inputs (the reconciler predicts each one).
    //    Aim from where we were drawn last frame: no predicted reads before the sends.
    this.updateSpectate();
    const watching = this.spectating;
    // over the raccoon's back, the captured mouse or the right stick turns the camera (before
    // the aim: it's where the camera looks)
    const look = this.controls.consumeLook();
    if (this.rig.mode === "behind") {
      const pl = this.controls.padLook();
      this.rig.look(-(look.x * LOOK_SENS + pl.x * PAD_LOOK_YAW * dt), look.y * LOOK_SENS - pl.y * PAD_LOOK_PITCH * dt);
    }
    // (a gull or a raccoon down the sewer has nothing to aim: it faces where the camera looks)
    const flying = !watching && st.mode === Mode.Gull, under = !watching && st.mode === Mode.Sewer;
    if (flying || under) { if (this.rig.mode === "behind") this.aimYaw = this.rig.lookYaw; }
    else if (!watching) this.updateAim(this.lastDrawn.x, this.lastDrawn.y, this.lastDrawn.z);
    for (let i = 0; i < n; i++) this.sendInput(now, watching);

    // 3. read & render
    const clock = this.room.clock;
    this.renderNow = clock.renderNow();
    this.remoteTime = clock.serverNow() - INTERP_DELAY_MS - clock.smoothedRtt() / 2;

    // the fumes, at the same clock as the trains
    const round = this.room.state.round;
    this.zoneOn = round.phase === RoundPhase.Live || round.phase === RoundPhase.Victory;
    if (this.zoneOn) zoneAt(round.zone, this.renderNow, round.stopAt, this.zone);
    this.zoneView.update(dt, this.zoneOn ? this.zone : null);
    const closing = this.zoneOn && round.phase === RoundPhase.Live && this.zone.closing;
    if (closing && !this.wasClosing) sfx.fumeSiren();
    this.wasClosing = closing;

    for (const e of this.cars.values()) if (e.active) this.updateCarPose(e, dt);

    // trains & city furniture from the shared timetable
    this.trains.update(dt, this.renderNow);
    const mePe = this.players.get(this.room.sessionId);
    const meState = mePe ? this.renderState(this.room.sessionId, mePe) : null;
    if (meState) { this.lastDrawn.x = meState.x; this.lastDrawn.y = meState.y; this.lastDrawn.z = meState.z; }
    const meX = meState?.x ?? st.x, meY = meState?.y ?? st.y, meZ = meState?.z ?? st.z;

    this.renderCars(dt);
    this.renderPlayers(dt);
    this.renderNpcs(dt);
    this.renderPickups(dt);
    this.renderGrenades(dt);
    const hiding = this.renderBins(dt, watching);
    this.renderPoles(dt);
    this.renderKnocks(dt, hiding, meState);
    this.renderBushes(dt);
    this.renderSewer(dt, watching);
    this.renderGarbage(dt);
    this.drops.update(dt, (key) => {
      const pe = this.players.get(key);
      const d = pe?.active && pe.view.root.visible ? pe.drawn : null;
      return d ? { x: d.x, y: d.y + (d.pose === "lying" ? 0.45 : 1.38), z: d.z } : null;
    });
    const peek = this.renderWindup(dt, meState, watching);

    // camera (look-ahead from the interpolated, not the step-quantized, velocity): on us, or
    // on whoever we're watching
    let driving = st.mode === Mode.Driving;
    let cvx = driving ? this.predict.value(this.self, "vx") : 0, cvz = driving ? this.predict.value(this.self, "vz") : 0;
    let focusX = meX, focusY = meY, focusZ = meZ;
    // (which way they face, and how fast they go on foot: the behind-the-back camera starts out
    // behind them, and swings back behind a car, or behind whoever we watch)
    let heading = meState?.yaw ?? st.yaw, footSpeed = 0;
    /** On a wall (they face it): the behind camera looks up it (and turns to face it, our stick let go). */
    let onWall = meState?.pose === "wall";
    const m = this.controls.moveAxes(), stickFree = Math.hypot(m.x, m.y) < 0.2;
    /** In the air (the camera holds the height they jumped from), or null: hold where it is. */
    let airborne: boolean | null = meState ? meState.pose === "air" || meState.pose === "ragdoll" : false;
    if (driving) { const ce = this.cars.get(st.veh); if (ce) { focusX = ce.pose.x; focusZ = ce.pose.z; heading = ce.pose.yaw; } airborne = false; }
    // a gull: the camera flies with it (framing it, not the street under it); down the sewer, it
    // follows us along the street over our heads, swinging round behind us as we scurry
    let scurrying = false;
    let gullCam = st.mode === Mode.Gull;
    if (st.mode === Mode.Gull) airborne = false;
    if (st.mode === Mode.Sewer) { focusY = 0.2; airborne = false; scurrying = Math.abs(st.vx) > 1; }
    if (watching) {
      const tp = this.players.get(this.watching);
      const drawn = tp?.active ? tp.drawn : null;
      const tveh = tp && tp.p.mode === Mode.Driving ? this.cars.get(tp.p.veh) : undefined;
      driving = !!tveh?.active;
      if (tveh?.active) { focusX = tveh.pose.x; focusY = tveh.pose.y; focusZ = tveh.pose.z; cvx = tveh.pose.vx; cvz = tveh.pose.vz; heading = tveh.pose.yaw; airborne = false; }
      else if (drawn) { focusX = drawn.x; focusY = drawn.y; focusZ = drawn.z; cvx = 0; cvz = 0; heading = drawn.yaw; footSpeed = drawn.speed; airborne = drawn.pose === "air" || drawn.pose === "ragdoll"; }
      // (watching someone down the sewer: over their heads, on the street; a gull, from behind it, looking down)
      if (tp?.p.mode === Mode.Sewer) { focusY = 0.2; airborne = false; }
      gullCam = tp?.p.mode === Mode.Gull;
      if (gullCam) airborne = false;
      else { focusX = this.rig.focus.x; focusY = this.rig.focus.y; focusZ = this.rig.focus.z; cvx = 0; cvz = 0; airborne = null; } // hold until they're in view
      onWall = !tveh?.active && drawn?.pose === "wall";
    }
    // The height the overhead camera frames: where they stand (a roof, the street), held through
    // a jump (a hop doesn't bob the whole town) and following a fall once it's more than a hop.
    if (airborne === false) this.standY = focusY;
    else if (airborne) this.standY = Math.min(this.standY, focusY + 1);
    const frameY = airborne === null ? focusY : this.standY + 0.35 * (focusY - this.standY);
    // (and from high up it pulls back a little, so the street around stays in the picture)
    const heightZoom = Math.min(1, Math.max(0, (this.standY - 5) / 21)) * 0.35;
    const speed = Math.hypot(cvx, cvz);
    this.city.update(dt, this.renderNow, focusX, focusZ);
    // (winding up a stink bomb, it leans toward where it'll land and pulls back: 26 m and the
    // blast's ring fit on screen, whichever way, at full power)
    const windupZoom = watching ? 0 : (meState?.windup ?? 0) * (1 + 0.3 * peek.pull);
    this.rig.update(dt, focusX, frameY, focusZ, cvx * 0.8, cvz * 0.8, (driving ? Math.min(1, speed / 24) : 0) + windupZoom + heightZoom, peek.x, peek.z, windupZoom > 0 ? 3.5 : 1.5,
      { y: focusY, heading, car: driving, swing: driving || watching || (onWall && stickFree) || scurrying, speed: driving ? speed : scurrying ? SEWER_SPEED * 0.6 : footSpeed, wall: onWall, gull: gullCam });
    this.placeLabels();
    const cam = this.view3d.camera.position;
    // In focus: what the camera looks at. Winding up a stink bomb (it leans away and pulls
    // back), both the raccoon and where it'll land: the sharp band stretches over the two. On a
    // roof, the sharp band reaches down to the street below.
    let focal = this.rig.distance, near = 7, far = 16 + 0.5 * Math.max(0, this.standY);
    if (peek.rest) {
      const f = this.rig.focus, l = Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z) || 1;
      const depth = (x: number, y: number, z: number) => ((x - cam.x) * (f.x - cam.x) + (y - cam.y) * (f.y - cam.y) + (z - cam.z) * (f.z - cam.z)) / l;
      const a = depth(meX, meY, meZ), b = depth(peek.rest.x, peek.rest.y, peek.rest.z), w = Math.min(1, windupZoom * 3);
      focal += ((a + b) / 2 - focal) * w;
      near += (Math.abs(a - b) / 2) * w;
      far += (Math.abs(a - b) / 2) * w;
    }
    // Over the raccoon's back there's no miniature to sell: sharp out to the middle distance,
    // a little soft toward the horizon. The fog comes in too, so the far edge of what the
    // server sends us (64-80 m) isn't a hard line.
    const bs = this.rig.behindness;
    if (bs > 0) {
      const toFocus = Math.hypot(cam.x - focusX, cam.y - focusY, cam.z - focusZ);
      focal += (toFocus - focal) * bs;
      near += (BEHIND_TILT.near - near) * bs;
      far += (BEHIND_TILT.far - far) * bs;
    }
    this.tilt.focalDepth = focal;
    this.tilt.focalNear = near;
    this.tilt.focalFar = far;
    this.tilt.maxBlur = (TOP_TILT_BLUR + (BEHIND_TILT.blur - TOP_TILT_BLUR) * bs) * this.app.renderer.resolution;
    const fog = this.view3d.fog;
    if (fog) {
      fog.near = TOP_FOG.near + (BEHIND_FOG.near - TOP_FOG.near) * bs;
      fog.far = TOP_FOG.far + (BEHIND_FOG.far - TOP_FOG.far) * bs;
    }
    this.city.updateOcclusion(dt, cam.x, cam.y, cam.z, focusX, focusY, focusZ);
    sfx.listener.x = focusX;
    sfx.listener.z = focusZ;

    // fume puffs drifting along the edge of the circle, near the camera
    if (this.zoneOn && this.zone.r > 1 && this.zone.r < 200) {
      this.puffAcc += dt * 24;
      const toward = Math.atan2(focusZ - this.zone.z, focusX - this.zone.x);
      const spread = Math.min(Math.PI, 45 / this.zone.r);
      while (this.puffAcc >= 1) {
        this.puffAcc -= 1;
        const a = toward + (Math.random() * 2 - 1) * spread;
        this.fx.fumes(this.zone.x + Math.cos(a) * this.zone.r, this.zone.z + Math.sin(a) * this.zone.r);
      }
    }

    this.fx.update(ticker);
    this.skidMarks.update(dt);
    this.updateHud(dt, meState);
  }

  /** Where the pad's aim got helped onto (a raccoon or a townsperson, as drawn), for the crosshair. */
  private padLock: { x: number; y: number; z: number } | null = null;
  private assistTmp = new Vector3();
  private assistAt = new Point();

  /**
   * Where our shots go: `aimYaw` and `aimPitch`, from where the server will shoot them from
   * over (mx, mz) (`shotHeight`), at whatever is under the crosshair.
   */
  private updateAim(mx: number, my: number, mz: number) {
    const c = this.controls;
    const st = this.me.state;
    this.aimEye = this.rig.mode === "behind";
    const oy = shotHeight(mx, my, mz, st.mode === Mode.Driving, this.aimEye);
    this.padLock = null;
    if (this.aimEye) {
      // over the raccoon's back: the crosshair is the middle of the screen, and its ray (from
      // over us on: not at anything behind us) finds what you aim at; shots leave from that
      // line too, so they land right there. On a pad it helps onto whoever is close to it.
      const r = this.rig.rayAt(this.app.screen.width / 2, this.app.screen.height / 2);
      const o = r.origin, d = r.direction;
      const from = Math.max(0, (mx - o.x) * d.x + (oy - o.y) * d.y + (mz - o.z) * d.z);
      const t = this.aimRay(o, d, from, from + AIM_REACH);
      this.aimToward(mx, oy, mz, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t, this.rig.lookYaw);
      if (c.device === "pad") {
        this.aimYaw = this.aimAssist(this.aimYaw, mx, mz);
        const l = this.padLock as { x: number; y: number; z: number } | null;
        if (l) this.aimToward(mx, oy, mz, l.x, l.y + 0.9, l.z, this.aimYaw);
      }
      return;
    }
    if (c.device === "pad") {
      // the right stick aims; let go of it and you aim where you're heading (in a car, ahead)
      const r = this.rig.right, u = this.rig.up;
      const toYaw = (v: { x: number; y: number }) => Math.atan2(r.x * v.x + u.x * v.y, r.z * v.x + u.z * v.y);
      let yaw: number | null = null;
      if (c.padAim) yaw = toYaw(c.padAim);
      else if (st.mode === Mode.Driving) yaw = st.yaw;
      else {
        const m = c.moveAxes();
        if (Math.hypot(m.x, m.y) > 0.3) yaw = toYaw(m);
      }
      if (yaw !== null) this.aimYaw = this.aimAssist(yaw, mx, mz);
      // a stick points across the ground only: up or down onto whoever it helped onto, else
      // the first one along it you can see, else level
      const l = this.padLock as { x: number; y: number; z: number } | null;
      if (l) this.aimToward(mx, oy, mz, l.x, l.y + 0.9, l.z, this.aimYaw);
      else this.aimPitch = this.autoAimPitch(mx, oy, mz) ?? 0;
      return;
    }
    // overhead, the mouse: what's under the cursor, at its own height (someone on the street
    // below a roof, a roof across the street), or failing that the plane at gun height
    const r = this.rig.rayAt(c.mouseX, c.mouseY);
    const o = r.origin, d = r.direction;
    const t = this.aimRay(o, d, 0, AIM_REACH);
    const onTarget = this.aimOnTarget;
    const hit = t < AIM_REACH ? this.pickPoint.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) : this.rig.pick(c.mouseX, c.mouseY, oy, this.pickPoint);
    if (!hit) return;
    const dx = hit.x - mx, dz = hit.z - mz;
    if (dx * dx + dz * dz > 0.04) this.aimYaw = Math.atan2(dx, dz);
    // from up here, up and down are hard to point at, and what the gun can see from where we
    // stand is hard to tell: at whoever is under the cursor if the gun can see them, else the
    // first one along the aim it can see, else at the cursor when it's on another level than
    // ours and in sight (down to the street from a roof's edge), else level (over the street,
    // not into it, nor into the roof we stand on)
    const sees = (onTarget || Math.abs(hit.y - my) > 0.75) && this.gunSees(mx, oy, mz, hit);
    const auto = onTarget && sees ? null : this.autoAimPitch(mx, oy, mz);
    if (auto !== null) this.aimPitch = auto;
    else if (sees) this.aimToward(mx, oy, mz, hit.x, hit.y, hit.z, this.aimYaw);
    else this.aimPitch = 0;
  }

  /** Is there a clear line from the gun at (ox, oy, oz) to the point `p` on a surface? */
  private gunSees(ox: number, oy: number, oz: number, p: Vector3): boolean {
    // (up to just short of it: the point itself is on the wall or the street it's in)
    const dx = p.x - ox, dy = p.y - oy, dz = p.z - oz, l = Math.hypot(dx, dy, dz);
    if (l < 0.2) return true;
    const k = 1 - 0.1 / l;
    return segmentClear(ox, oy, oz, ox + dx * k, oy + dy * k, oz + dz * k);
  }

  /** Aim from the muzzle (ox, oy, oz) at the point (px, py, pz); straight over or under it, along `yaw`. */
  private aimToward(ox: number, oy: number, oz: number, px: number, py: number, pz: number, yaw: number) {
    const dx = px - ox, dz = pz - oz, flat = Math.hypot(dx, dz);
    this.aimYaw = flat > 0.2 ? Math.atan2(dx, dz) : yaw;
    this.aimPitch = Math.atan2(py - oy, flat);
    this.aimDist = Math.hypot(flat, py - oy);
  }

  /** How far the point we aim at is from where the shot leaves (m): the Blunderbuss's ring is drawn as wide as its pellets spread by there. */
  private aimDist = 20;

  /** Whether `aimRay` last stopped at someone or something a shot can hit (not the town itself, nor nothing). */
  private aimOnTarget = false;
  private aimObb: Obb = { cx: 0, cz: 0, hx: 0, hz: 0, c: 1, s: 0 };
  private aimTargets: ShotTarget[] = [];

  /**
   * How far along the ray from `o` (unit `d`), from `from` up to `maxT`, the first thing in it
   * is: a raccoon, a townsperson, a car or a trash can as drawn, or the town as shots see it
   * (`rayStatic`). `maxT`: nothing (the sky). Never us, nor the car we drive.
   */
  private aimRay(o: Vector3, d: Vector3, from: number, maxT: number): number {
    const ox = o.x + d.x * from, oy = o.y + d.y * from, oz = o.z + d.z * from;
    const dx = d.x, dy = d.y, dz = d.z;
    let best = rayStatic(ox, oy, oz, dx, dy, dz, maxT - from);
    let onTarget = false;
    const take = (t: number) => { if (t >= 0 && t < best) { best = t; onTarget = true; } };
    for (const [sid, pe] of this.players) {
      const dr = pe.drawn;
      if (!pe.active || !dr || sid === this.room.sessionId || dr.pose === "hidden" || pe.p.mode === Mode.Dead) continue;
      if (pe.gull?.root.visible) { const q = gullTarget(dr.x, dr.y, dr.z); take(rayCylinder(ox, oy, oz, dx, dy, dz, best, q.x, q.z, q.r, q.y0, q.y1)); continue; }
      take(rayCylinder(ox, oy, oz, dx, dy, dz, best, dr.x, dr.z, PLAYER_RADIUS + 0.2, dr.y, dr.y + RACCOON_TOP));
    }
    for (const ne of this.npcs.values()) {
      if (!ne.active || ne.npc.state > NpcState.Flying) continue;
      take(rayCylinder(ox, oy, oz, dx, dy, dz, best, ne.drawn.x, ne.drawn.z, 0.5, ne.drawn.y, ne.drawn.y + TOWNSFOLK_TOP));
    }
    const st = this.me.state, b = this.aimObb;
    for (const e of this.cars.values()) {
      if (!e.active || e.car.state === 2 || (st.mode === Mode.Driving && e.car.id === st.veh)) continue;
      const type = CAR_TYPES[e.car.kind], p = e.pose;
      b.cx = p.x; b.cz = p.z; b.hx = type.halfW; b.hz = type.halfL; b.c = Math.cos(p.yaw); b.s = Math.sin(p.yaw);
      take(rayPrism(ox, oy, oz, dx, dy, dz, best, b, p.y, p.y + type.roof));
    }
    const bin = binOnRay(ox, oy, oz, dx, dy, dz, best);
    if (bin.i >= 0) { best = bin.t; onTarget = true; }
    this.aimOnTarget = onTarget;
    return from + best;
  }

  /** `autoPitch` along our aim, against everyone as drawn (null: nobody to pitch onto, or no gun out). */
  private autoAimPitch(mx: number, oy: number, mz: number): number | null {
    const st = this.me.state;
    if (st.weapon === Weapon.Fists || st.weapon === Weapon.Grenade) return null;
    const ts = this.drawnTargets(this.room.sessionId, st.mode === Mode.Driving ? st.veh : -1);
    return autoPitch(mx, oy, mz, this.aimYaw, WEAPONS[st.weapon].range, ts);
  }

  /**
   * Everyone and everything a shot can hit, as drawn (shared: read it before the next call),
   * but the shooter `skipSid` and the car they drive (`skipCar`). Us included, when it's
   * someone else's shot.
   */
  private drawnTargets(skipSid: string, skipCar: number): ShotTarget[] {
    const ts = this.aimTargets;
    ts.length = 0;
    for (const [sid, pe] of this.players) {
      const dr = pe.drawn;
      if (!pe.active || !dr || sid === skipSid || dr.pose === "hidden" || pe.p.mode === Mode.Dead) continue;
      ts.push(pe.gull?.root.visible ? gullTarget(dr.x, dr.y, dr.z) : { x: dr.x, z: dr.z, y0: dr.y, y1: dr.y + RACCOON_TOP, y: dr.y + 0.9, r: PLAYER_RADIUS + 0.2 });
    }
    for (const ne of this.npcs.values()) {
      if (!ne.active || ne.npc.state > NpcState.Flying) continue;
      ts.push({ x: ne.drawn.x, z: ne.drawn.z, y0: ne.drawn.y, y1: ne.drawn.y + TOWNSFOLK_TOP, y: ne.drawn.y + 0.8, r: 0.5 });
    }
    for (const e of this.cars.values()) {
      if (!e.active || e.car.state === 2 || e.car.id === skipCar) continue;
      const type = CAR_TYPES[e.car.kind], p = e.pose;
      ts.push({ x: p.x, z: p.z, y0: p.y, y1: p.y + type.roof, y: p.y + type.roof * 0.55, r: 0, yaw: p.yaw, hw: type.halfW, hl: type.halfL });
    }
    return ts;
  }

  /**
   * A stick can't point as finely as a mouse: on a pad, an aim close to a raccoon or a
   * townsperson in range turns onto them. The cone narrows with distance (about 2 m either
   * side, 3.5°..12°). Not for a stink bomb, whose arc shows exactly where it'll land, and never
   * onto anyone in a trash can (or a car), or off screen: only those you can see standing.
   */
  private aimAssist(yaw: number, mx: number, mz: number): number {
    const st = this.me.state;
    if (st.weapon === Weapon.Grenade || st.charge > 0) return yaw;
    const range = st.weapon === Weapon.Fists && st.mode !== Mode.Driving ? 2.6 : WEAPONS[st.weapon].range;
    let best = 1, bestYaw = yaw;
    let lock: { x: number; y: number; z: number } | null = null;
    const consider = (x: number, y: number, z: number, weight: number) => {
      const dx = x - mx, dz = z - mz, d = Math.hypot(dx, dz);
      if (d < 0.4 || d > range) return;
      const to = Math.atan2(dx, dz);
      const cone = Math.min(0.21, Math.max(0.06, Math.atan2(2, d)));
      const score = (Math.abs(wrapAngle(to - yaw)) / cone) * weight;
      if (score >= best) return;
      // only someone on screen (a mouse can't point past its edge either)
      const at = this.view3d.worldToScreen(this.assistTmp.set(x, y + 0.9, z), this.assistAt);
      if (!at || at.x < 0 || at.y < 0 || at.x > this.app.screen.width || at.y > this.app.screen.height) return;
      best = score; bestYaw = to; lock = { x, y, z };
    };
    for (const [sid, pe] of this.players) {
      const dr = pe.drawn;
      // (raccoons, not gulls: their own view isn't the raccoon's)
      if (!pe.active || sid === this.room.sessionId || !dr || !pe.view.root.visible || (dr.pose !== "move" && dr.pose !== "air")) continue;
      // raccoons first
      consider(dr.x, dr.y, dr.z, 0.8);
    }
    for (const ne of this.npcs.values()) {
      if (!ne.active || ne.npc.state > NpcState.Flee || !ne.view.root.visible) continue;
      consider(ne.drawn.x, ne.drawn.y, ne.drawn.z, 1);
    }
    this.padLock = lock;
    return bestYaw;
  }

  /**
   * One input per due step, always (the server counts on it), even while spectating: then
   * a neutral one (the body is out of the game; the keys switch whom we watch).
   */
  private sendInput(now: number, spectating = false) {
    const c = this.controls;
    const st = this.me.state;
    const driving = st.mode === Mode.Driving;
    const taps = c.consumeTaps(driving);
    if (spectating) {
      const d = this.input.data;
      d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0;
      d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
      this.input.send();
      return;
    }

    // weapon choice: keys, wheel, and follow the step when it switches for us (loot)
    if (st.weapon !== this.lastSeenWeapon) { this.desiredWeapon = st.weapon; this.lastSeenWeapon = st.weapon; }
    if (taps.weapon !== null && (taps.weapon === 0 || getAmmo(st as PlayerSim, taps.weapon) > 0)) this.desiredWeapon = taps.weapon;
    if (taps.wheel) {
      const owned = [0, 1, 2, 3, 4].filter((w) => w === 0 || getAmmo(st as PlayerSim, w) > 0);
      const i = owned.indexOf(this.desiredWeapon);
      this.desiredWeapon = owned[(i + (taps.wheel > 0 ? 1 : owned.length - 1)) % owned.length];
    }

    const mv = c.moveAxes();
    const r = this.rig.right, u = this.rig.up;
    let wx = r.x * mv.x + u.x * mv.y, wz = r.z * mv.x + u.z * mv.y;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const drive = c.driveAxes();
    if (taps.jump) this.jumpUntil = now + 150;

    const d = this.input.data;
    d.mx = Math.round(wx * 100);
    d.mz = Math.round(wz * 100);
    d.throttle = Math.round(drive.throttle * 100);
    d.steer = Math.round(drive.steer * 100);
    d.aim = wrapAngle(this.aimYaw);
    d.fire = c.fire(driving);
    // only a step that fires reads these: left alone otherwise, they cost nothing on the wire
    if (d.fire) {
      d.pitch = Math.round(this.aimPitch * AIM_Q);
      d.eye = this.aimEye;
    }
    // G (or LT): winding up a stink bomb, held; let go, the step throws it
    d.nade = c.nade(now, st.charge > 0, driving);
    d.jump = driving ? c.handbrakeHeld() : st.mode === Mode.Gull ? c.jumpHeld() : now < this.jumpUntil;
    d.sprint = c.sprint();
    d.use = taps.use;
    d.weapon = this.desiredWeapon;
    this.input.send();
    if (this.me.state.vy > 4 && !this.me.state.grounded) this.jumpUntil = 0;
  }

  private renderCars(dt: number) {
    let screech = 0;
    for (const e of this.cars.values()) {
      if (!e.active) continue;
      e.view.root.visible = true;
      const c = e.car;
      // who sits at the wheel: us (predicted), or whoever the stream says at the drawn time
      const driver = e.mine ? this.room.sessionId : c.state === 2 ? "" : (e.driver.at(this.remoteTime) ?? c.driver);
      if (c.state === 2 || !driver) e.view.setDriver("", null);
      else if (driver === "npc") e.view.setDriver(`npc${c.id}`, humanLook(c.id * 7919, c.kind === 2 ? "pest" : c.kind === CAR_GARBAGE ? "binman" : undefined));
      else {
        const pe = this.players.get(driver);
        e.view.setDriver(driver, pe ? raccoonLook(pe.p.look) : null);
      }

      // the car we drive: its lights from our own feet (the stream's are a round trip late)
      const lights = e.mine ? carLights(this.me.state as PlayerSim, this.input.data) : c.lights;
      e.view.update(dt, {
        x: e.pose.x, y: e.pose.y, z: e.pose.z, yaw: e.pose.yaw, vx: e.pose.vx, vz: e.pose.vz,
        steer: e.mine ? this.predict.value(this.self, "steer") : this.predict.value(c, "steer"),
        state: c.state, hp: c.hp, siren: c.siren,
        lights,
        yawRate: e.mine ? this.predict.value(this.self, "yawRate") : undefined,
        kinematic: !e.mine && c.driver === "npc",
      });
      // its engine, if a raccoon drives it (AI traffic keeps quiet). The gas: ours from the
      // pedals, as the step reads them; someone else's from how their car picks up speed (it
      // coasts down at 3.5 m/s², and flat out near top speed still gains about 1)
      if (c.state !== 2 && driver && (driver !== "npc" || c.kind === CAR_GARBAGE)) {
        const vF = e.pose.vx * Math.sin(e.pose.yaw) + e.pose.vz * Math.cos(e.pose.yaw);
        const braking = !!(lights & CarLight.Brake), handbrake = !!(lights & CarLight.Handbrake);
        const drive = e.mine ? (braking ? 0 : this.input.data.throttle / 100)
          : lights & CarLight.Reverse ? -1
          : braking ? 0 : Math.max(0, Math.min(1, (e.view.accF + 1.5 * Math.min(1, Math.abs(vF) / 5)) / 3));
        sfx.engine(c.id, c.kind, e.mine, {
          vF, drive, brake: braking ? 1 : 0, handbrake, spin: handbrake ? 0 : e.view.skid[0], air: e.pose.y > 0.05,
        }, e.pose.x, e.pose.z);
      }
      const near = (e.pose.x - this.rig.focus.x) ** 2 + (e.pose.z - this.rig.focus.z) ** 2 < 90 * 90;
      if (!near) continue;
      if (e.view.thud > 3) {
        // a hard landing kicks up dust off both ends
        const fx = Math.sin(e.pose.yaw) * e.view.halfL * 0.6, fz = Math.cos(e.pose.yaw) * e.view.halfL * 0.6, n = Math.round(e.view.thud);
        this.fx.dustPuff(e.pose.x + fx, e.pose.y, e.pose.z + fz, n);
        this.fx.dustPuff(e.pose.x - fx, e.pose.y, e.pose.z - fz, n);
      }
      if (c.state === 1) this.fx.burn(e.pose.x, e.pose.y + 1.2, e.pose.z, dt);
      else if (c.state === 2) this.fx.smokeTrail(e.pose.x, e.pose.y + 1, e.pose.z, dt, 6, 0x3a3b40);
      else if (c.hp < 45) {
        const fx = Math.sin(e.pose.yaw), fz = Math.cos(e.pose.yaw);
        this.fx.smokeTrail(e.pose.x + fx * e.view.halfL * 0.7, e.pose.y + 1.1, e.pose.z + fz * e.view.halfL * 0.7, dt, c.hp < 25 ? 18 : 7, c.hp < 25 ? 0x55575e : 0xb0b3ba);
      }
      screech = Math.max(screech, this.skid(e, dt));
    }
    sfx.setSkid(screech);
    sfx.endEngines(dt);
  }

  /**
   * A car's skidding wheels: marks on the road, smoke off the rear tyres. Returns how loud its
   * tyres screech where we listen (0..1).
   */
  private skid(e: CarEntry, dt: number): number {
    const sk = e.view.skid, type = CAR_TYPES[e.car.kind];
    const fx = Math.sin(e.pose.yaw), fz = Math.cos(e.pose.yaw), lx = Math.cos(e.pose.yaw), lz = -Math.sin(e.pose.yaw);
    const track = type.halfW * WHEEL_TRACK;
    let loud = 0;
    for (let w = 0; w < 4; w++) {
      const key = `${e.car.id}:${w}`;
      const heat = sk[w];
      if (heat < 0.04) { this.skidMarks.lift(key); continue; }
      const along = w < 2 ? -type.axle : type.axle, side = w % 2 ? -track : track;
      const x = e.pose.x + fx * along + lx * side, z = e.pose.z + fz * along + lz * side;
      this.skidMarks.lay(key, x, groundHeight(x, z, e.pose.y + 0.3), z, heat);
      if (w < 2 && heat > 0.3 && Math.random() < heat * dt * 28) this.fx.driftSmoke(x, z);
      loud = Math.max(loud, heat);
    }
    return loud * sfx.att(e.pose.x, e.pose.z, 60);
  }

  private sightObb: Obb = { cx: 0, cz: 0, hx: 0, hz: 0, c: 1, s: 0 };
  private sightTrains: CarPose[] = Array.from({ length: TRAIN_SLOTS }, () => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 }));

  /**
   * Is the camera's line to (x, y, z) clear: of the town (a wall, a roof, but not a building
   * drawn see-through), the cars (wrecks too) and the trains (`sightTrains`), as drawn? Not of
   * `car` (the one they're in), nor the one we drive.
   */
  private lineOfSight(x: number, y: number, z: number, car: number): boolean {
    const c = this.view3d.camera.position;
    if (!segmentClear(c.x, c.y, c.z, x, y, z, this.city.seeThrough)) return false;
    const len = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (len < 1e-3) return true;
    const dx = (x - c.x) / len, dy = (y - c.y) / len, dz = (z - c.z) / len, b = this.sightObb;
    const st = this.me.state, ours = st.mode === Mode.Driving ? st.veh : -1;
    for (const e of this.cars.values()) {
      if (!e.active || e.car.id === car || e.car.id === ours) continue;
      const type = CAR_TYPES[e.car.kind], p = e.pose;
      b.cx = p.x; b.cz = p.z; b.hx = type.halfW; b.hz = type.halfL; b.c = Math.cos(p.yaw); b.s = Math.sin(p.yaw);
      if (rayPrism(c.x, c.y, c.z, dx, dy, dz, len, b, p.y, p.y + type.roof) >= 0) return false;
    }
    for (const p of this.sightTrains) {
      b.cx = p.x; b.cz = p.z; b.hx = p.halfW; b.hz = p.halfL; b.c = Math.cos(p.yaw); b.s = Math.sin(p.yaw);
      if (rayPrism(c.x, c.y, c.z, dx, dy, dz, len, b, 0, p.roof) >= 0) return false;
    }
    return true;
  }

  /**
   * Can we see someone standing at (x, y, z), `top` m tall: the top of their head or their
   * middle (`lineOfSight`)? Their name tag shows only then: one floating over a wall would
   * give away who's hiding behind it.
   */
  private inSight(x: number, y: number, z: number, top: number, car: number): boolean {
    return this.lineOfSight(x, y + top - 0.1, z, car) || this.lineOfSight(x, y + top * 0.5, z, car);
  }

  private renderPlayers(dt: number) {
    const now = performance.now();
    for (let slot = 0; slot < TRAIN_SLOTS; slot++) trainCarPose(slot, this.renderNow, this.sightTrains[slot]);
    for (const [sid, pe] of this.players) {
      const status = this.room.state.roster.get(sid)?.status ?? PlayerStatus.Playing;
      // back in a round: the tombstone goes
      if (status === PlayerStatus.Playing && pe.tomb) {
        this.fx.poof(pe.tomb.position.x, 0, pe.tomb.position.z);
        pe.tomb.destroy({ children: true });
        pe.tomb = null;
        pe.outAt = 0;
      }
      if (!pe.active) continue;
      const isMe = sid === this.room.sessionId;
      // out of the round, flying about as a gull (its tombstone stays where its raccoon fell)
      const disc = isMe ? this.me.state : (pe.tl.at(this.remoteTime) ?? pe.p);
      if (disc.mode === Mode.Gull) { this.renderGull(sid, pe, isMe, disc.veh, dt); continue; }
      if (pe.gull) pe.gull.root.visible = false;
      // waiting for the next round: not in the game at all
      if (status === PlayerStatus.Waiting) { pe.view.root.visible = false; pe.drawn = null; continue; }
      const st = this.renderState(sid, pe);
      if (!isMe) this.remoteTrainHit(pe, st, disc.mode, dt);
      // knocked out of the round: a moment to tumble, then *poof*, a tombstone
      if (status === PlayerStatus.Out) {
        const d = isMe ? this.me.state : (pe.tl.at(this.remoteTime) ?? pe.p);
        if (d.mode === Mode.Dead && !pe.outAt) pe.outAt = now;
        if (pe.outAt && now - pe.outAt > 2000) {
          if (!pe.tomb) {
            pe.tomb = instance("tombstone");
            // on the ground under them (a train or a car they fell from has moved on), RIP to the camera
            pe.tomb.position.set(st.x, groundHeight(st.x, st.z, st.y + 0.3), st.z);
            pe.tomb.rotation.set(0, (Math.random() - 0.5) * 0.5, 0);
            this.view3d.root.addChild(pe.tomb);
            this.fx.poof(st.x, st.y, st.z);
          }
          pe.view.root.visible = false;
          pe.drawn = st;
          continue;
        }
      }
      // someone else diving into a trash can, the moment it happens on our screen (ours is our own step's)
      const drawnMode = isMe ? this.me.state.mode : (pe.tl.at(this.remoteTime) ?? pe.p).mode;
      if (!isMe && drawnMode === Mode.Hidden && pe.drawnMode >= 0 && pe.drawnMode !== Mode.Hidden) {
        const veh = (pe.tl.at(this.remoteTime) ?? pe.p).veh;
        if (CITY.bins[veh]) this.bins.dive(veh);
      }
      // someone else landing dazed from a long fall: knocked down without being flung (on the
      // ground already), the moment it happens on our screen (ours is our own step's EV_DAZE)
      if (!isMe && drawnMode === Mode.Knocked && pe.drawnMode === Mode.Foot && st.pose === "lying" && !pe.trainHit) {
        pe.view.event("flatten");
        sfx.boing(st.x, st.z);
      }
      // someone else running up onto a wall (ours is our own step's EV_WALL)
      if (!isMe && drawnMode === Mode.Wall && pe.drawnMode === Mode.Foot) {
        pe.view.event("hop");
        sfx.claws(st.x, st.z);
      }
      pe.drawnMode = drawnMode;
      // winding up, it's the stink bomb in the paw (even with a gun out: G)
      const windup = st.windup ?? 0;
      pe.view.setWeapon(windup > 0 ? Weapon.Grenade : isMe ? this.me.state.weapon : pe.p.weapon);
      pe.view.setLod(isMe ? 0 : this.lodAt(st.x, st.z));
      pe.view.setCrown(sid === this.champion);
      pe.view.update(dt, st);
      pe.drawn = st;
      if (windup > 0.05) pe.windup = windup;
      const c = windup > 0 ? pe.view.corkAt(this.cork) : null;
      if (c) {
        pe.cork = { x: c.x, y: c.y, z: c.z };
        // stink wisping off its cork, more the further it's wound up
        if (Math.random() < dt * (4 + 10 * windup)) this.fx.stinkWisp(c.x, c.y, c.z, windup);
      }
      // dust kicked up by sprinting feet (and lots more by a gallop with the zoomies)
      if (st.pose === "move" && st.speed > 6.5 && Math.random() < dt * (st.zoomies ? 22 : 10)) this.fx.dustPuff(st.x, st.y, st.z, st.zoomies ? 3 : 2);
      if (!isMe) {
        if (pe.p.hp < pe.lastHp) pe.view.flash();
        const t = pe.tag, lying = st.pose === "lying";
        t.due = true; t.hidden = st.pose === "hidden"; t.gull = false;
        t.x = st.x; t.y = st.y; t.z = st.z; t.lift = lying ? 0.8 : 1.75; t.top = lying ? 0.5 : RACCOON_TOP;
        t.car = drawnMode === Mode.Driving ? (pe.tl.at(this.remoteTime) ?? pe.p).veh : -1;
      }
      pe.lastHp = pe.p.hp;
    }
  }

  /** A raccoon out of the round, as a gull: where its step has it, flapping, with what it carries. */
  /**
   * Name tags and the wind-up meter, once the camera has moved this frame: projected through
   * the last frame's camera, they'd trail what they label.
   */
  private placeLabels() {
    const w = this.app.screen.width, h = this.app.screen.height;
    for (const [sid, pe] of this.players) {
      const t = pe.tag;
      if (!t.due) continue;
      t.due = false;
      const s = t.hidden ? null : this.view3d.worldToScreen(this.tmp.set(t.x, t.y + t.lift, t.z), this.screen);
      const onScreen = !!s && s.x > -100 && s.y > -100 && s.x < w + 100 && s.y < h + 100;
      const seen = onScreen && (t.gull ? this.lineOfSight(t.x, t.y + t.top, t.z, -1) : this.inSight(t.x, t.y, t.z, t.top, t.car));
      // (no hearts on a gull: nothing hurts it)
      this.hud.tag(sid, pe.p.name, t.gull ? PLAYER_MAX_HP : pe.p.hp, s ? { x: s.x, y: s.y } : null, seen);
    }
    const m = this.meterAt;
    if (m.k > 0) {
      const at = this.view3d.worldToScreen(this.tmp.set(m.x, m.y, m.z), this.screen);
      if (at) this.hud.windup(m.k, at.x, at.y);
    } else this.hud.windup(null);
  }

  private renderGull(sid: string, pe: PlayerEntry, isMe: boolean, carry: number, dt: number) {
    pe.view.root.visible = false;
    const gv = (pe.gull ??= this.newGull());
    gv.root.visible = true;
    const st = this.renderState(sid, pe);
    const p = pe.p;
    const dazed = (isMe ? this.me.state.timer : p.timer) > 0;
    gv.update(dt, { x: st.x, y: st.y, z: st.z, yaw: st.yaw, vx: st.vx ?? 0, vy: st.vy, vz: st.vz ?? 0, dazed, carry });
    st.pose = "air";
    pe.drawn = st;
    pe.drawnMode = Mode.Gull;
    // its wings whump past you
    const near = Math.hypot(st.x - this.rig.focus.x, st.z - this.rig.focus.z) < 14;
    if ((isMe || near) && performance.now() > this.flapAt && (st.vy > 2 || Math.hypot(st.vx ?? 0, st.vz ?? 0) < 3)) {
      this.flapAt = performance.now() + 380;
      sfx.flap(st.x, st.z, 2, Math.min(1, Math.max(0.3, st.vy / 6)));
    }
    if (!isMe) {
      const t = pe.tag;
      t.due = true; t.hidden = false; t.gull = true;
      t.x = st.x; t.y = st.y; t.z = st.z; t.lift = 0.75; t.top = 0.2; t.car = -1;
    }
  }

  private newGull(): GullView {
    const gv = new GullView();
    this.view3d.root.addChild(gv.root);
    return gv;
  }

  /** The manholes, and the sewer's map round us (or whoever we watch) while down there. */
  private renderSewer(dt: number, watching: boolean) {
    let under: { x: number; z: number; edge: number } | null = null;
    const st = this.me.state;
    if (!watching && st.mode === Mode.Sewer) {
      const d = this.players.get(this.room.sessionId)?.drawn;
      under = { x: d?.x ?? st.x, z: d?.z ?? st.z, edge: st.veh };
      sfx.setSewer(true, Math.min(1, Math.abs(st.vx) / SEWER_SPEED));
    } else {
      sfx.setSewer(false);
      const tp = watching ? this.players.get(this.watching) : undefined;
      if (tp?.active && tp.p.mode === Mode.Sewer) under = { x: this.predict.value(tp.p, "x"), z: this.predict.value(tp.p, "z"), edge: tp.p.veh };
    }
    const fx = this.rig.focus.x, fz = this.rig.focus.z;
    this.sewer.update(dt, under, (x, z) => (x - fx) ** 2 + (z - fz) ** 2 < 80 * 80);
  }

  /** Garbage Day: the golden dumpster (on the truck, coming down, padlocked, burst open), the truck's lift with it. */
  private renderGarbage(dt: number) {
    const g = this.room.state.garbage;
    if (!g) return;
    const truck = this.cars.get(g.truck);
    const socket = truck?.active && truck.view.root.visible ? truck.view.socket() : null;
    const lift = this.garbageView.update(dt, g, this.room.clock.serverNow(), socket);
    if (truck?.active) truck.view.setLift(lift);
    if (g.phase !== this.garbagePhase) {
      const was = this.garbagePhase;
      this.garbagePhase = g.phase;
      if (g.phase === GarbagePhase.Coming && was === GarbagePhase.None) { sfx.garbageDay(); this.garbageBanner = performance.now() + 3200; }
    }
  }

  private renderNpcs(dt: number) {
    const time = this.npcTime();
    for (const ne of this.npcs.values()) {
      if (!ne.active) continue;
      const n = ne.npc;
      const fl = ne.flight;
      if (fl && !fl.off) {
        // someone else's car: once it's drawn getting to them, their flight starts from the top
        if (fl.wait && (performance.now() > fl.wait.until || this.carAt(fl.wait.car, fl.x, fl.z))) {
          fl.lag = Math.max(0, time - fl.t);
          fl.wait = null;
        }
        // (ours as our car is drawn getting to them: the step that hit them ran ahead of it)
        if (!fl.wait && time - fl.lag >= fl.t) this.takeOff(ne, fl);
      } else if (fl && fl.lag > 0) fl.lag = Math.max(0, fl.lag - dt * 1000 * FLIGHT_CATCH_UP);
      // the server's flight takes over once ours is in the present and they fly there too: in
      // a word from it since the launch, which we draw past (`Predict` can't reckon back). A
      // rejected one hands back from `runOvers`; the give-up backs up a verdict that never came.
      const ours = fl !== null || ne.blend !== null;
      const last = this.room.clock.lastServerTime();
      const theirs = n.state === NpcState.Flying && fl !== null && last >= fl.t0 && time >= last;
      if (fl && ((fl.off && fl.lag === 0 && theirs) || performance.now() - fl.born > FLIGHT_GIVE_UP)) this.handOver(ne, time);
      if (n.state !== ne.lastState) {
        if (n.state === NpcState.Hidden || ne.lastState === NpcState.Hidden) {
          this.fx.poof(this.predict.value(n, "x"), 0, this.predict.value(n, "z"));
        }
        if (n.state === NpcState.Flying && ne.lastState <= NpcState.Flee && !ours) sfx.boing(n.x, n.z);
        if (n.state === NpcState.Flee && ne.lastState === NpcState.Walk) {
          // a yelp and a panicked shout over their head (one at a time: a fleeing crowd isn't a wall of text)
          const s = this.view3d.worldToScreen(this.tmp.set(ne.drawn.x, 2.3, ne.drawn.z), this.screen);
          if (s && s.x > 0 && s.y > 0 && s.x < this.app.screen.width && s.y < this.app.screen.height) {
            sfx.eek(ne.drawn.x, ne.drawn.z);
            const now = performance.now();
            if (now > this.barkAt) {
              this.barkAt = now + 650;
              this.hud.popup([BARKS[(Math.random() * BARKS.length) | 0]], s.x, s.y, 0xff5d8f);
            } else this.hud.popup(["!"], s.x, s.y, 0xff5d8f);
          }
        }
        ne.lastState = n.state;
      }
      let x: number, y: number, z: number;
      const cur = ne.flight;
      const f = cur?.off ? this.stepFlight(cur, time - cur.lag) : null;
      // (not off yet: as they were, where they were hit)
      const held = cur && !cur.off ? cur : null;
      if (f) {
        x = f.x; y = f.y; z = f.z;
      } else if (held) {
        x = held.x; y = ne.drawn.y; z = held.z;
      } else if (ne.blend) {
        const p = this.predict.readAt(n, NPC_XYZ, time, this.npcRead);
        const b = ne.blend;
        x = p.x + b.x; y = p.y + b.y; z = p.z + b.z;
        // eased out quickly; dropped once it's gone, and `Predict`'s own easing of the same jump too
        const k = Math.exp(-dt / 0.07);
        b.x *= k; b.y *= k; b.z *= k; b.age += dt;
        if (b.age > 0.4 && Math.abs(b.x) + Math.abs(b.y) + Math.abs(b.z) < 0.01) ne.blend = null;
      } else {
        x = this.predict.value(n, "x"); y = this.predict.value(n, "y"); z = this.predict.value(n, "z");
      }
      ne.drawn.x = x; ne.drawn.y = y; ne.drawn.z = z;
      const far = (x - this.rig.focus.x) ** 2 + (z - this.rig.focus.z) ** 2 > 110 * 110;
      // (ours spins as the server's does)
      if (f) ne.yaw += 9 * dt;
      else if (!held) ne.yaw += wrapAngle(n.yaw - ne.yaw) * Math.min(1, dt * 10);
      const vx = f ? f.vx : held ? 0 : n.vx, vy = f ? f.vy : held ? 0 : n.vy, vz = f ? f.vz : held ? 0 : n.vz;
      const pose: CharState["pose"] = n.state === NpcState.Hidden || far ? "hidden"
        : f ? "ragdoll" : held ? held.pose0 : n.state === NpcState.Flying ? "ragdoll" : n.state === NpcState.KO ? "lying" : "move";
      ne.view.setLod(this.lodAt(x, z));
      ne.view.update(dt, { x, y, z, yaw: ne.yaw, speed: Math.hypot(vx, vz), vy, pose, aiming: false, vx, vz, panic: n.state === NpcState.Flee });
    }
  }

  private renderPickups(dt: number) {
    const t = this.elapsed;
    const now = this.room.clock.serverNow();
    for (const [key, pe] of this.pickups) {
      const pk = this.room.state.pickups.get(key);
      if (!pk) continue;
      if (pk.loose) { this.renderLoose(pe, pk, now, t, dt); continue; }
      const hidden = !pk.active || this.pickupEvents.has(key);
      // a looted can stays, lid flung open, until it refills
      pe.item.visible = !hidden;
      if (pe.lid) {
        const want = hidden ? 1 : 0;
        if (pe.open !== want) {
          pe.open = want > pe.open ? Math.min(1, pe.open + dt * 6) : Math.max(0, pe.open - dt * 2);
          // flips open with a bounce, closes gently
          const k = pe.open, bounce = want ? Math.sin(k * Math.PI) * 0.25 : 0;
          pe.lid.rotation.set(-1.9 * k - bounce, 0, 0);
        }
      }
      if (hidden) continue;
      pe.item.position.set(pk.x, pk.y + 1.05 + (PICKUP_LIFT[pk.kind] ?? 0) + Math.sin(t * 3 + pk.x) * 0.12, pk.z);
      pe.item.rotation.set(0, t * 2, 0);
      if (Math.random() < dt * 1.5) this.fx.sparkle(pk.x, pk.y + 0.4, pk.z);
    }
  }

  /**
   * Loose loot: in a gull's feet (it carries it, drawn by the gull: hidden here), flying (from where
   * we saw it set off, to where it lands at its `at`: a fountain out of the golden dumpster arcs up,
   * a gull's drop just falls), or lying on the street, bobbing like loot does, till it's taken.
   */
  private renderLoose(pe: PickupEntry, pk: { x: number; y: number; z: number; ox: number; oy: number; oz: number; at: number; carrier: string; active: boolean; kind: number }, now: number, t: number, dt: number) {
    const item = pe.item;
    if (pk.carrier || this.pickupEvents.has(pe.key)) { item.visible = false; pe.fly = null; return; }
    item.visible = true;
    if (now < pk.at) {
      // setting off: from the gull's feet as drawn (if it was a gull's), else where the server says
      if (!pe.fly) {
        let from = { x: pk.ox, y: pk.oy, z: pk.oz };
        for (const q of this.players.values()) {
          if (q.gull?.root.visible && q.drawn && Math.hypot(q.drawn.x - pk.ox, q.drawn.z - pk.oz) < 3) { from = { x: q.drawn.x, y: q.drawn.y - 0.4, z: q.drawn.z }; break; }
        }
        pe.fly = { t0: now, ...from };
      }
      const f = pe.fly, k = Math.max(0, Math.min(1, (now - f.t0) / Math.max(1, pk.at - f.t0)));
      // (an arc as high as the fountain needs; a drop from a gull falls, faster and faster)
      const arc = Math.max(0, 2.6 - (f.y - pk.y));
      const y = f.y + (pk.y - f.y) * (arc > 0 ? k : k * k) + arc * 4 * k * (1 - k);
      item.position.set(f.x + (pk.x - f.x) * k, y + 0.3, f.z + (pk.z - f.z) * k);
      item.rotation.set(t * 7, t * 5, 0);
      return;
    }
    if (pe.fly) {
      pe.fly = null;
      this.fx.dustPuff(pk.x, pk.y, pk.z, 4);
      sfx.clink(pk.x, pk.z, 0.6);
    }
    item.position.set(pk.x, pk.y + 0.45 + Math.sin(t * 3 + pk.x) * 0.1, pk.z);
    item.rotation.set(0, t * 2, 0);
    if (pk.active && Math.random() < dt * 2.5) this.fx.sparkle(pk.x, pk.y + 0.1, pk.z, 0xffe066);
  }

  /** Lamp posts falling over: someone else's knock waits for their car, as we draw it, to get to the post. */
  private renderPoles(dt: number) {
    this.poles.update(dt, (x, z) => {
      let at: CarAtPole = null;
      for (const e of this.cars.values()) {
        if (!e.active) continue;
        const t = CAR_TYPES[e.car.kind], p = e.pose;
        if (circleObb(x, z, POLE_R + 0.2, p.x, p.z, p.yaw, t.halfW, t.halfL)) return "touching";
        // within 12 m and closing on it at over 1 m/s
        const dx = x - p.x, dz = z - p.z, d2 = dx * dx + dz * dz;
        if (d2 < 144 && p.vx * dx + p.vz * dz > Math.sqrt(d2)) at = "closing";
      }
      return at;
    });
  }

  /**
   * Street furniture the cars we draw go through: knocked flying here, back on its spot later.
   * `hiding`: the can we (or whoever we watch) hide in; `me`: our raccoon as drawn.
   */
  private renderKnocks(dt: number, hiding: number, me: { x: number; y: number; z: number } | null) {
    const cars = this.drawnCars;
    cars.length = 0;
    for (const e of this.cars.values()) {
      if (e.active) cars.push({ kind: e.car.kind, x: e.pose.x, y: e.pose.y, z: e.pose.z, yaw: e.pose.yaw, vx: e.pose.vx, vz: e.pose.vz, mine: e.mine });
    }
    this.knock.update(dt, cars, this.me.state.mode === Mode.Foot ? me : null, hiding, this.rig.focus);
    if (this.knock.bumped > 0) this.shake(this.knock.bumped);
  }

  /** The bushes, shaken by whoever's drawn in them on foot and the cars (posed by `renderKnocks`). */
  private renderBushes(dt: number) {
    const ws = this.walkers;
    ws.length = 0;
    for (const pe of this.players.values()) {
      const d = pe.drawn;
      if (!pe.active || !d || !pe.view.root.visible || d.pose === "sit" || d.pose === "hidden" || d.pose === "wall") continue;
      ws.push({ x: d.x, y: d.y, z: d.z, vx: d.vx ?? Math.sin(d.yaw) * d.speed, vz: d.vz ?? Math.cos(d.yaw) * d.speed });
    }
    for (const ne of this.npcs.values()) {
      if (ne.active && ne.view.root.visible) ws.push({ x: ne.drawn.x, y: ne.drawn.y, z: ne.drawn.z, vx: 0, vz: 0 });
    }
    this.bushes.update(dt, ws, this.drawnCars, this.rig.focus);
  }

  /**
   * The trash cans: lids from the synced state, and a hider peeking out of ours (or our
   * target's). Returns the can that is (-1 for none).
   */
  private renderBins(dt: number, watching: boolean): number {
    let peek: { i: number; yaw: number } | null = null;
    if (!watching && this.me.state.mode === Mode.Hidden) peek = { i: this.me.state.veh, yaw: this.aimYaw };
    else if (watching) {
      const tp = this.players.get(this.watching);
      if (tp?.active && tp.p.mode === Mode.Hidden) peek = { i: tp.p.veh, yaw: this.predict.value(tp.p, "aim") };
    }
    const fx = this.rig.focus.x, fz = this.rig.focus.z;
    const cam = this.view3d.camera.position;
    this.bins.update(dt, this.room.state.bins ?? null, peek, { x: cam.x, z: cam.z }, (x, z) => (x - fx) ** 2 + (z - fz) ** 2 < 90 * 90);
    return peek?.i ?? -1;
  }

  /**
   * Every stink bomb, on the timeline it belongs to:
   * - ours, predicted: between the ghost's last two sub-steps;
   * - ours, the server's: reckoned ahead by our measured input lead (`spawnTime`), so it carries
   *   on from the ghost without a jump;
   * - everyone else's: interpolated on the same 100 ms-behind timeline their thrower is drawn
   *   at, and only from the moment it was thrown on it, so it leaves their paw as their arm comes
   *   over (which is when we swing that arm).
   */
  private renderGrenades(dt: number) {
    const list = this.grenadeList;
    list.length = 0;
    const clock = this.room.clock;
    const now = clock.serverNow();
    const me = this.room.sessionId;
    for (const e of this.grenadeSpawns.entries()) {
      const d = e.data, g = e.server;
      let x: number, y: number, z: number, t: number;
      if (g && g.owner !== me) {
        t = (this.remoteTime - g.bornMs) / 1000;
        if (t < 0) continue;
        x = this.phys.value(g, "x"); y = this.phys.value(g, "y"); z = this.phys.value(g, "z");
        if (!d.shown) {
          d.shown = true;
          const pe = this.players.get(g.owner);
          if (t < 0.15 && pe?.active && pe.drawn) {
            pe.view.event("throw", pe.windup || 0.6);
            sfx.toss(pe.windup || 0.6, pe.drawn.x, pe.drawn.z);
            pe.windup = 0;
            if (pe.cork) d.from = pe.cork;
          }
        }
      } else if (e.state === "pending" && d.path) {
        // ours, only predicted so far: on its exact path, at its flight time
        t = (now - d.at) / 1000;
        ({ x, y, z } = pathAt(d.path, t, this.pathPos));
      } else if (g) {
        // ours, the server's now. It's on our path, bit for bit, unless we mispredicted the
        // throw: then while every snapshot of it agrees, we keep drawing our exact path;
        // otherwise the SDK's reckon of the server's, ahead by our measured input lead.
        // (Thrown by us without our predicting it, it's reckoned to server-present: no lead.)
        t = (now - (d.at || g.bornMs)) / 1000;
        const snap = clock.lastServerTime();
        if (d.checkedAt !== snap) {
          d.checkedAt = snap;
          d.onPath = !!d.path && d.at > 0 && onPathAt(g, d.path, (snap - g.bornMs) / 1000);
        }
        if (d.onPath) ({ x, y, z } = pathAt(d.path!, t, this.pathPos));
        else { x = this.grenadeSpawns.value(e, "x"); y = this.grenadeSpawns.value(e, "y"); z = this.grenadeSpawns.value(e, "z"); }
      } else continue;
      if (!d.path && g) {
        // seen without a throw of ours to go by: where it'll go off, from the first state we have
        d.t0 = Math.max(0, (clock.lastServerTime() - g.bornMs) / 1000);
        d.path = grenadePath(g, newGrenadePath(), GRENADE_FUSE_SUBSTEPS - Math.round(d.t0 / GRENADE_SUBSTEP));
      }
      // out of the paw that threw it (cocked behind the head) as the arm comes over
      if (d.from && t < RELEASE_S) {
        const k = Math.max(0, t) / RELEASE_S, s = k * k * (3 - 2 * k), f = d.from;
        x = f.x + (x - f.x) * s; y = f.y + (y - f.y) * s; z = f.z + (z - f.z) * s;
      }
      list.push({ id: e.id, x, y, z, t, path: d.path, t0: d.t0 });
    }
    const fx = this.rig.focus.x, fz = this.rig.focus.z;
    this.grenadesView.update(dt, list, (x, z) => (x - fx) ** 2 + (z - fz) ** 2 < 60 * 60);
  }

  /**
   * Winding up a stink bomb (ours, or the watched raccoon's): the meter over their head, and
   * for ours the aim arc and ring, the stretching sound, and the camera leaning toward where
   * it'll land. Returns that lean (m).
   */
  private renderWindup(dt: number, meS: CharState | null, watching: boolean): { x: number; z: number; pull: number; rest: { x: number; y: number; z: number } | null } {
    const st = this.me.state;
    const pe = watching ? this.players.get(this.watching) : this.players.get(this.room.sessionId);
    const drawn = watching ? (pe?.active ? pe.drawn : null) : meS;
    const k = drawn?.windup ?? 0;
    // the meter, over the head (over the roof, driving): placed once the camera has moved
    const m = this.meterAt;
    m.k = drawn ? k : 0;
    if (drawn && k > 0) { m.x = drawn.x; m.y = drawn.y + (!watching && st.mode === Mode.Driving ? 2.7 : 2.2); m.z = drawn.z; }
    const full = k >= 1;
    if (!watching && full && this.lastWindup < 1) sfx.ready();
    this.lastWindup = watching ? 0 : k;
    sfx.setWindup(!watching && k > 0, k, full);

    // ours: where it'd go if we let go now (the power the next step would let go with)
    const peek: { x: number; z: number; pull: number; rest: { x: number; y: number; z: number } | null } = { x: 0, z: 0, pull: 0, rest: null };
    const winding = !watching && st.charge > 0 && meS && st.mode !== Mode.Hidden && st.mode !== Mode.Dead && st.mode !== Mode.Knocked;
    if (winding && meS) {
      const launch = grenadeLaunch({ x: meS.x, y: meS.y, z: meS.z, vx: st.vx, vz: st.vz, mode: st.mode }, this.aimYaw, st.charge / GRENADE_CHARGE_STEPS);
      // (the path is only worked out again when the throw would be a different one)
      const a = this.aimLaunch;
      if (!a || a.x !== launch.x || a.y !== launch.y || a.z !== launch.z || a.vx !== launch.vx || a.vy !== launch.vy || a.vz !== launch.vz) {
        grenadePath(launch, this.aimPath);
        this.aimLaunch = launch;
      }
      const path = this.aimPath;
      this.throwView.update(dt, path, k, full);
      // Lean toward where it lands, so we and the ring are both on screen (with the pull-back as
      // it's wound up). The camera looks down toward the top of the screen, so the ground below
      // the middle shows less: half way across the screen, more of the way down it, less up it.
      const e = (path.n - 1) * 3;
      const vx = path.xyz[e] - meS.x, vz = path.xyz[e + 2] - meS.z, len = Math.hypot(vx, vz) || 1;
      const up = this.rig.up, u = (vx * up.x + vz * up.z) / len, lean = 0.5 - 0.1 * u;
      peek.x = vx * lean;
      peek.z = vz * lean;
      // (up or down the screen there's less room than across it)
      peek.pull = Math.abs(u) * Math.min(1, len / 26);
      peek.rest = { x: path.xyz[e], y: path.xyz[e + 1], z: path.xyz[e + 2] };
    } else this.throwView.update(dt, null);
    return peek;
  }

  private updateHud(dt: number, meS: CharState | null) {
    const st = this.me.state;
    const p = this.self;
    const roster = this.room.state.roster;
    const round = this.room.state.round;
    const myInfo = this.myInfo();
    const spectating = this.spectating;
    const target = spectating ? this.players.get(this.watching) : undefined;
    const targetInfo = spectating ? roster.get(this.watching) : undefined;

    // the player panel: ours, or whoever we're watching (their gun and ammo are synced too), or as a gull, its droppings
    if (!spectating && st.mode === Mode.Gull) {
      const ready = st.cd === 0;
      const key = `g|${p.name}|${ready}|${st.veh}`;
      if (key !== this.hudKey) {
        this.hudKey = key;
        this.hud.setGull(p.name, ready, st.veh);
      }
    } else if (target?.active && targetInfo) {
      const q = target.p;
      const key = `w|${targetInfo.name}|${q.hp}|${q.weapon}|${q.ammo1}|${q.ammo2}|${q.ammo3}|${q.ammo4}|${targetInfo.score}|${targetInfo.kills}`;
      if (key !== this.hudKey) {
        this.hudKey = key;
        this.hud.setPlayer(targetInfo.name, q.hp, q.weapon, [q.ammo1, q.ammo2, q.ammo3, q.ammo4], targetInfo.score, targetInfo.kills);
      }
    } else {
      const score = myInfo?.score ?? 0, kills = myInfo?.kills ?? 0;
      const key = `${p.name}|${p.hp}|${st.weapon}|${st.ammo1}|${st.ammo2}|${st.ammo3}|${st.ammo4}|${score}|${kills}`;
      if (key !== this.hudKey) {
        this.hudKey = key;
        this.hud.setPlayer(p.name, p.hp, st.weapon, [st.ammo1, st.ammo2, st.ammo3, st.ammo4], score, kills);
      }
    }
    // the zoomies' countdown beside the health bar, and the breath left for the sewer while it isn't full
    this.hud.setZoomies(Math.ceil((target?.active && targetInfo ? target.p.zoomies : st.zoomies) / TICK_RATE));
    const air = airLeft(st), airLow = !spectating && st.mode === Mode.Sewer && air <= SEWER_COUGH_S;
    this.hud.setAir(!spectating && st.stench > 0 && st.mode !== Mode.Dead && st.mode !== Mode.Gull ? Math.ceil(air) : null, airLow);
    this.hud.setPing(this.room.clock.rtt(), roster.size);
    const meX = meS?.x ?? st.x, meZ = meS?.z ?? st.z;

    // ---- the round
    const now = performance.now();
    const serverNow = this.room.clock.serverNow();
    if (round.phase !== this.lastPhase) {
      if (round.phase === RoundPhase.Live && this.lastPhase === RoundPhase.Countdown) { this.goUntil = now + 1400; sfx.go(); }
      this.lastPhase = round.phase;
    }
    const secs = (ms: number) => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    let line: Part[] = [];
    switch (round.phase) {
      case RoundPhase.Warmup:
        line = roster.size < 2 ? [{ icon: "raccoon" }, "warm-up · waiting for another raccoon"] : [{ icon: "raccoon" }, "warm-up"];
        break;
      case RoundPhase.Countdown:
        line = [{ icon: "raccoon" }, `round ${round.number} · ${round.entrants} raccoons · GO in ${secs(round.goAt - serverNow)}`];
        break;
      case RoundPhase.Live: {
        const fumes = this.zone.final ? "SUDDEN DEATH" : this.zone.closing ? `fumes closing ${secs(this.zone.left * 1000)}` : `fumes move in ${secs(this.zone.left * 1000)}`;
        line = [{ icon: "raccoon" }, `${round.alive} left`, { icon: "skull" }, String(myInfo?.roundKills ?? 0), " ", fumes];
        break;
      }
      case RoundPhase.Victory:
        line = [{ icon: "crown" }, round.winner ? `${round.winnerName} wins round ${round.number}!` : `round ${round.number}: a draw`];
        break;
    }
    this.hud.setRound(line);

    // in the fumes: the screen edges glow purple, and you cough
    const playing = !myInfo || myInfo.status === PlayerStatus.Playing;
    const depth = this.zoneOn && playing && st.mode !== Mode.Dead ? zoneDepth(this.zone, meX, meZ) : -1;
    this.hud.setFog(depth > 0 ? Math.min(1, 0.45 + depth / 40) : 0);
    // in a trash can: the screen's edges go dark; down the sewer, dark and damp
    this.hud.setHiding(!spectating && st.mode === Mode.Hidden);
    this.hud.setSewer(!spectating && st.mode === Mode.Sewer);
    if ((depth > 0 || airLow) && Math.random() < dt * 0.9) sfx.cough();

    // big banner: connection trouble first, then the round, then being bonked
    const count = round.phase === RoundPhase.Countdown ? Math.ceil((round.goAt - serverNow) / 1000) : -1;
    if (count !== this.lastCount) {
      if (count >= 1 && count <= 3) sfx.countdown(count);
      this.lastCount = count;
    }
    const outRecently = myInfo?.status === PlayerStatus.Out && this.outAt > 0 && now - this.outAt < 4000;
    if (this.link === "left") this.hud.setBig("DISCONNECTED", "refresh the page to rejoin", "signal");
    else if (this.link === "drop") this.hud.setBig("RECONNECTING…", "hang tight", "signal");
    else if (round.phase === RoundPhase.Victory) {
      const mine = round.winner === this.room.sessionId;
      // low: the scoreboard has the top half during the victory lap
      if (!round.winner) this.hud.setBig("DRAW!", "the fumes got everyone", null, true);
      else this.hud.setBig(mine ? "YOU WIN!" : `${round.winnerName} WINS!`, "WINNER WINNER, TRASH DINNER!", null, true);
    } else if (outRecently && st.mode !== Mode.Gull) {
      const by = this.killerName ? ` · by ${this.killerName}` : "";
      this.hud.setBig(this.killerName ? "BONKED!" : "FUMIGATED!", `#${this.myPlace || myInfo?.place || "?"} of ${round.entrants}${by}`, "tombstone");
    } else if (now < this.gullBanner) {
      this.hud.setBig("YOU'RE A SEAGULL!", "poop on the living · snatch their loot · MINE!", "gull");
    } else if (now < this.garbageBanner) {
      this.hud.setBig("GARBAGE DAY!", "the truck's bringing the golden dumpster: follow the gold", "dumpster_gold");
    } else if (count >= 1 && count <= 3) this.hud.setBig(String(count), "get ready…", null);
    else if (round.phase === RoundPhase.Countdown) this.hud.setBig("GET READY", `round ${round.number} · last raccoon standing wins`, null);
    else if (now < this.goUntil) this.hud.setBig("SCAVENGE!", "last raccoon standing wins", "star");
    else if (!spectating && st.mode === Mode.Dead && round.phase === RoundPhase.Warmup) this.hud.setBig("BONKED!", "respawning in a sec…", "raccoon_dizzy");
    else this.hud.setBig("");

    // contextual hints, in the keys or the pad buttons of whichever was touched last
    const pad = this.controls.device === "pad";
    /** A key, or on a pad its button. */
    const K = (key: string, button: PadButton): Part => (pad ? { pad: button } : { key });
    /** The mouse (aim and click), or on a pad a button. */
    const M = (button: PadButton): Part => (pad ? { pad: button } : { icon: "mouse" });
    let hint: Part[] = [];
    const fly: Part = pad ? { pad: "dup" } : { key: "V" };
    if (spectating) {
      const who = targetInfo?.name;
      const sw: Part[] = pad ? [{ pad: "lb" }, { pad: "rb" }] : [{ icon: "mouse" }, { key: "A" }, { key: "D" }];
      hint = who
        ? [{ icon: "eye" }, `spectating ${who}`, ...sw, "switch"]
        : [{ icon: "eye" }, "waiting for the next round"];
      if (myInfo?.status === PlayerStatus.Waiting && who) hint.push("· you're in the next round");
      // (watching instead of flying: V goes back to it)
      if (round.phase === RoundPhase.Live && myInfo && myInfo.status !== PlayerStatus.Playing && st.mode === Mode.Dead && who) hint.push(fly, "fly as a gull", { icon: "gull" });
    } else if (st.mode === Mode.Gull) {
      hint = st.veh >= 0
        ? [{ icon: "gull" }, "got it!", K("E", "y"), "let go of it", M("rt"), "poop", fly, "watch instead"]
        : [{ icon: "gull" }, M("rt"), "poop", K("E", "y"), "snatch loot", K("Space", "x"), K("Shift", "a"), "up · down", K("T", "b"), "MINE!", fly, "watch"];
    } else if (st.mode === Mode.Sewer) {
      hint = st.vx === 0
        ? [{ icon: "manhole" }, "in the sewer", ...(pad ? [{ pad: "ls" } as Part] : [{ key: "W" }, { key: "A" }, { key: "S" }, { key: "D" }] as Part[]), "scurry along a pipe", K("Space", "x"), "climb out here"]
        : st.ly === 1 ? [{ icon: "manhole" }, "climbing out at the next manhole…"]
        : [{ icon: "manhole" }, "scurrying · steer at junctions · let go: stop at the next manhole", K("Space", "x"), "out there"];
    } else if (st.mode === Mode.Driving) {
      const police = this.cars.get(st.veh)?.car.kind === 2;
      hint = pad
        ? [{ pad: "rt" }, "gas", { pad: "lt" }, "brake", { pad: "rb" }, "drift", { pad: "y" }, "exit", { pad: "l3" }, police ? "siren" : "honk", { pad: "lb" }, "drive-by"]
        : [{ key: "E" }, "exit", { key: "S" }, "brake", { key: "Space" }, "handbrake · drift", { key: "H" }, police ? "siren" : "honk", { icon: "mouse" }, "drive-by"];
    } else if (st.mode === Mode.Roof || st.mode === Mode.Train) {
      hint = [{ icon: "ride" }, "riding the roof!", K("Space", "x"), "jump", K("E", "y"), "hop off"];
    } else if (st.mode === Mode.Wall) {
      hint = [{ icon: "coffee" }, "on the wall!", ...(pad ? [{ pad: "ls" } as Part] : [{ key: "W" }, { key: "A" }, { key: "S" }, { key: "D" }] as Part[]), "crawl", K("Space", "x"), "kick off"];
    } else if (st.mode === Mode.Hidden) {
      hint = [{ icon: "bin" }, "hiding in a trash can", K("E", "y"), "hop out", M("rt"), "ambush!", K("T", "b"), "rattle"];
    } else if (st.mode === Mode.Foot) {
      let nearCar: CarEntry | null = null;
      for (const e of this.cars.values()) {
        if (!e.active || e.car.state === 2) continue;
        const t = CAR_TYPES[e.car.kind];
        if (circleObb(meX, meZ, PLAYER_RADIUS + 1.4, e.pose.x, e.pose.z, e.pose.yaw, t.halfW, t.halfL)) { nearCar = e; break; }
      }
      // a trash can within reach (and nearer than any car): E dives in, like the step decides
      const bi = nearestBin(st.x, st.y, st.z, BIN_REACH);
      const bin = bi >= 0 ? CITY.bins[bi] : null;
      const lidOff = bi >= 0 && !!this.room.state.bins.get(String(bi))?.lidOff;
      // …or a manhole underfoot (nearer than either)
      const mi = st.y < 0.6 ? nearestManhole(st.x, st.z, MANHOLE_REACH) : -1;
      const mh = mi >= 0 ? MANHOLES[mi] : null;
      const mhGap = mh ? Math.hypot(st.x - mh.x, st.z - mh.z) : Infinity;
      if (mh && (!bin || mhGap < Math.hypot(st.x - bin.x, st.z - bin.z) - BIN_R) && (!nearCar || mhGap < Math.hypot(st.x - nearCar.pose.x, st.z - nearCar.pose.z) - CAR_TYPES[nearCar.car.kind].halfW)) {
        // (no way down while it's flooded, or without the breath for it: the step won't dive)
        hint = sewerFlooded(round) ? [{ icon: "manhole" }, "the sewer's flooded: fight it out up here!"]
          : !canDive(st) ? [{ icon: "manhole" }, `catching your breath: the sewer needs AIR ${SEWER_AIR_MIN_S}`]
          : [K("E", "y"), "down the manhole", { icon: "manhole" }, "· into the sewer"];
      } else if (bin && !lidOff && (!nearCar || Math.hypot(st.x - bin.x, st.z - bin.z) - BIN_R < Math.hypot(st.x - nearCar.pose.x, st.z - nearCar.pose.z) - CAR_TYPES[nearCar.car.kind].halfW)) {
        hint = [K("E", "y"), "hide in the trash can", { icon: "bin" }];
      } else if (nearCar) {
        const car = { icon: CAR_ICONS[nearCar.car.kind] ?? "car_hatch" };
        const d = nearCar.car.driver;
        hint = [K("E", "y"), d && d !== "npc" ? "carjack!" : d === "npc" ? "steal this" : "get in", car, K("Space", "x"), "jump onto the roof"];
      } else if (bin && lidOff) {
        hint = [{ icon: "bin" }, "its lid got knocked off: no hiding in there for now"];
      } else {
        for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
          const tp = trainCarPose(slot, this.renderNow, this.trainPose);
          if (circleObb(meX, meZ, PLAYER_RADIUS + 1.6, tp.x, tp.z, tp.yaw, tp.halfW, tp.halfL)) {
            hint = [K("Space", "x"), "jump onto the train!", { icon: "train_loco" }];
            break;
          }
        }
      }
    }
    // the stink bomb out, and nothing nearer to say: how it's thrown
    if (!hint.length && !spectating && st.mode === Mode.Foot && st.weapon === Weapon.Grenade && st.ammo4 > 0 && st.charge === 0) {
      hint = [M("rt"), "or", K("G", "lt"), "hold to wind up · let go to throw", { icon: "wpn_grenade" }];
    }
    // over the raccoon's back with the mouse not captured (not yet, or let go with Esc): a click captures it
    if (this.rig.mode === "behind" && !pad && !this.controls.locked && !spectating) {
      hint = [{ icon: "mouse" }, "click to look around", { key: "C" }, "overhead view"];
    }
    this.hud.setHint(hint);

    // minimap (everyone where they're drawn; gulls as white dots)
    const others: { x: number; z: number }[] = [];
    const gullDots: { x: number; z: number }[] = [];
    for (const [sid, pe] of this.players) {
      if (!pe.active || sid === this.room.sessionId || !pe.drawn) continue;
      if (pe.gull?.root.visible) gullDots.push({ x: pe.drawn.x, z: pe.drawn.z });
      else if (pe.view.root.visible) others.push({ x: pe.drawn.x, z: pe.drawn.z });
    }
    const cars: { x: number; z: number; wreck: boolean }[] = [];
    for (const e of this.cars.values()) if (e.active) cars.push({ x: e.pose.x, z: e.pose.z, wreck: e.car.state === 2 });
    const trains: { x: number; z: number; loco: boolean }[] = [];
    for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
      const tp = trainCarPose(slot, this.renderNow, this.trainPose);
      trains.push({ x: tp.x, z: tp.z, loco: slot % TRAIN_CARS === 0 });
    }
    const pks: { x: number; z: number; kind: number }[] = [];
    for (const [k, pk] of this.room.state.pickups) if (pk.active && !this.pickupEvents.has(k)) pks.push({ x: pk.x, z: pk.z, kind: pk.kind });
    // the arrow is us, or whoever we're watching
    const arrow = spectating
      ? (target?.active && target.drawn ? { x: target.drawn.x, z: target.drawn.z, yaw: target.drawn.yaw } : null)
      : { x: meX, z: meZ, yaw: st.mode === Mode.Driving ? st.yaw : (meS?.yaw ?? st.yaw) };
    // what's on screen: where the rays through its four corners meet the street (over the
    // raccoon's back the top two run over the horizon: there, as far as the fog lets you see)
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const seen = this.seenQuad;
    for (let i = 0; i < 4; i++) {
      const hit = this.rig.reach(i === 1 || i === 2 ? sw : 0, i >= 2 ? sh : 0, SEEN_MAX, this.tmp);
      seen[i * 2] = hit.x;
      seen[i * 2 + 1] = hit.z;
    }
    // what the server sends us: its StateView, around whoever it says (us, or whom we watch)
    const aoi = this.aoiSid();
    const ape = aoi === this.room.sessionId ? null : this.players.get(aoi);
    const view = !ape ? { x: meX, z: meZ } : ape.active && ape.drawn ? { x: ape.drawn.x, z: ape.drawn.z } : null;
    // Garbage Day: the truck (while it's on its rounds), and where the dumpster is (or is headed)
    const gd = this.room.state.garbage;
    const truckE = gd ? this.cars.get(gd.truck) : undefined;
    const onRounds = !!gd && gd.phase !== GarbagePhase.None && !!truckE?.active && (gd.phase <= GarbagePhase.Lowering);
    const dumpster = gd && gd.phase !== GarbagePhase.None ? { x: gd.x, z: gd.z, coming: gd.phase === GarbagePhase.Coming, open: gd.phase === GarbagePhase.Open } : null;
    const sewerMap = !spectating && st.mode === Mode.Sewer ? { edge: st.veh } : null;
    this.hud.drawMap(arrow, others, cars, trains, pks, this.zoneOn ? this.zone : null, seen, view, {
      gulls: gullDots, sewer: sewerMap, truck: onRounds ? { x: truckE!.pose.x, z: truckE!.pose.z } : null, dumpster,
    });
    this.updateGarbageMarker(gd, spectating ? this.rig.focus.x : meX, spectating ? this.rig.focus.z : meZ);

    // netcode panel
    if (this.hud.showNet) {
      const clock = this.room.clock;
      const drift = this.me.drift;
      this.hud.setNet([
        "COLYSEUS 0.18 NETCODE",
        `tick ${this.input.tickRate} Hz · patch ${this.input.patchRate} ms · interp ${INTERP_DELAY_MS} ms`,
        `rtt ${clock.rtt().toFixed(0)} ms (smoothed ${clock.smoothedRtt().toFixed(0)}) · jitter ${clock.jitter().toFixed(1)}`,
        `inputs sent ${this.input.sentCount} · acked ${this.input.lastProcessed} · in flight ${this.input.pendingCount}`,
        `reconcile drift ema ${drift.ema.toFixed(3)} · peak ${drift.peak.toFixed(3)} · last ${this.me.lastCorrectionMag.toFixed(3)}`,
        `predicted hits: confirmed ${this.stats.confirmed} · rejected ${this.stats.rejected} · shots ${this.stats.shots}`,
        `predicted stink bombs: thrown ${this.stats.thrown} · kept ${this.stats.kept} · fizzled ${this.stats.fizzled} · in the air ${this.grenadeSpawns.size} · wind-up ${this.me.state.charge}/${GRENADE_CHARGE_STEPS}`,
        `mode ${["foot", "driving", "car roof", "train roof", "knocked", "dead", "in a trash can", "on a wall", "down the sewer", "a seagull"][st.mode]} · server time ${(clock.serverNow() / 1000).toFixed(1)} s`,
        `in view (StateView): players ${this.countActive(this.players.values())}/${roster.size} · cars ${this.countActive(this.cars.values())}/${AI_TRAFFIC + PARKED_CARS} · townsfolk ${this.countActive(this.npcs.values())}/${NPC_COUNT}`,
        `view around ${roster.get(this.aoiSid())?.name ?? "?"} · in within ${AOI_IN} m, out past ${AOI_OUT} m (the minimap's blue rings)`,
      ].join("\n"));
    } else this.hud.setNet(null);

    // scoreboard (hold Tab, and during the victory lap)
    if (this.controls.scores() || round.phase === RoundPhase.Victory) {
      const rows = [...roster.entries()]
        .sort(([, a], [, b]) => b.wins - a.wins || b.roundKills - a.roundKills || b.score - a.score)
        .map(([sid, q]) => ({
          name: q.name, wins: q.wins, score: q.score, kills: q.kills, deaths: q.deaths, me: sid === this.room.sessionId,
          state: q.status === PlayerStatus.Out ? `out · #${q.place}` : q.status === PlayerStatus.Waiting ? "next round" : !q.connected ? "away" : "",
        }));
      this.hud.setBoard(rows, round.number ? `ROUND ${round.number}` : "SCOREBOARD");
    } else this.hud.setBoard(null);

    // the crosshair: the mouse, or on a pad a little way along the aim (on whoever it helped onto)
    let aimX = this.controls.mouseX, aimY = this.controls.mouseY;
    let reticle: "mouse" | "pad" | "lock" | "off" = "mouse";
    /** The Blunderbuss's ring round the crosshair (px; 0: none). */
    let spread = 0;
    if (this.rig.mode === "behind") {
      // over the back: the middle of the screen (the aim runs straight up it), or whoever a pad's aim helped onto
      aimX = sw / 2;
      aimY = sh / 2;
      reticle = spectating || st.mode === Mode.Dead || st.mode === Mode.Knocked ? "off" : pad ? "pad" : "mouse";
      const lock = reticle !== "off" ? this.padLock : null;
      const at = lock && this.view3d.worldToScreen(this.tmp.set(lock.x, lock.y + 0.9, lock.z), this.screen);
      if (at) { aimX = at.x; aimY = at.y; reticle = "lock"; }
      // the Blunderbuss: where its ring of pellets lands round the crosshair (one of them, as far
      // out as what we aim at, or its range, seen from the camera)
      if (reticle !== "off" && st.weapon === Weapon.Shotgun) {
        const d = pelletDir(this.aimYaw, this.aimPitch, Weapon.Shotgun, 1, this.ringDir);
        const r = Math.min(this.aimDist, WEAPONS[Weapon.Shotgun].range);
        const ey = (meS?.y ?? st.y) + (st.mode === Mode.Driving ? DRIVE_EYE_Y : EYE_Y);
        const at = (yaw: number, pitch: number, out: Point) =>
          this.view3d.worldToScreen(this.tmp.set(meX + Math.sin(yaw) * Math.cos(pitch) * r, ey + Math.sin(pitch) * r, meZ + Math.cos(yaw) * Math.cos(pitch) * r), out);
        const ring = at(d.yaw, d.pitch, this.screen), mid = at(this.aimYaw, this.aimPitch, this.screen2);
        if (ring && mid) spread = Math.hypot(ring.x - mid.x, ring.y - mid.y);
      }
    } else if (pad) {
      reticle = "off";
      if (!spectating && st.mode !== Mode.Dead && st.mode !== Mode.Knocked) {
        const lock = this.padLock;
        const reach = st.mode === Mode.Driving ? 9 : st.weapon === Weapon.Fists ? 2.4 : 6;
        const at = lock
          ? this.view3d.worldToScreen(this.tmp.set(lock.x, lock.y + 0.9, lock.z), this.screen)
          : this.view3d.worldToScreen(this.tmp.set(meX + Math.sin(this.aimYaw) * reach, (meS?.y ?? st.y) + 1, meZ + Math.cos(this.aimYaw) * reach), this.screen);
        if (at) { aimX = at.x; aimY = at.y; reticle = lock ? "lock" : "pad"; }
      }
    }
    this.hud.update(dt, aimX, aimY, reticle, spread);
  }

  /**
   * The golden dumpster's marker over it (or at the screen's edge, pointing the way): how far, and
   * what it's doing. Shown from the moment the truck sets off until a little after it bursts.
   */
  private updateGarbageMarker(g: GameState["garbage"] | undefined, meX: number, meZ: number) {
    const now = this.room.clock.serverNow();
    if (!g || g.phase === GarbagePhase.None || (g.phase === GarbagePhase.Open && now - g.at > 6000)) { this.hud.setMarker(null); return; }
    const spot = this.garbageView.spot;
    const x = spot?.x ?? g.x, y = (spot?.y ?? 1.4) + 1.2, z = spot?.z ?? g.z;
    const dist = Math.round(Math.hypot(x - meX, z - meZ));
    const left = Math.max(0, Math.ceil((g.at - now) / 1000));
    const parts: Part[] = g.phase === GarbagePhase.Coming ? [{ icon: "dumpster_gold" }, "golden dumpster", `${dist} m`]
      : g.phase === GarbagePhase.Lowering ? [{ icon: "dumpster_gold" }, "coming down!", `${dist} m`]
      : g.phase === GarbagePhase.Locked ? [{ icon: "dumpster_gold" }, `opens in ${left}`, `${dist} m`]
      : [{ icon: "dumpster_gold" }, "LOOT!"];
    // behind the camera worldToScreen has nothing: its mirror image through the camera, which setMarker flips back
    const ray = this.rig.rayAt(this.app.screen.width / 2, this.app.screen.height / 2), o = ray.origin, f = ray.direction;
    const ahead = (x - o.x) * f.x + (y - o.y) * f.y + (z - o.z) * f.z > 0;
    const s = this.view3d.worldToScreen(ahead ? this.tmp.set(x, y, z) : this.tmp.set(2 * o.x - x, 2 * o.y - y, 2 * o.z - z), this.screen);
    if (!s) { this.hud.setMarker(null); return; }
    this.hud.setMarker(parts, s.x, s.y, ahead);
  }

  /** Whose surroundings the server sends us (our `aoi`; us until it says). */
  private aoiSid(): string {
    return this.room.state.players.get(this.room.sessionId)?.aoi || this.room.sessionId;
  }

  private countActive(entries: Iterable<{ active: boolean }>) {
    let n = 0;
    for (const e of entries) if (e.active) n++;
    return n;
  }

  start() {
    this.controls.active = true;
    // over the raccoon's back, unless C last switched to overhead
    let cam: string | null = null;
    try { cam = localStorage.getItem(CAMERA_KEY); } catch { /* private window */ }
    this.setCamera(cam === "top" ? "top" : "behind", true);
    setTimeout(() => { this.hud.showHelp = false; }, 25000);
    this.app.ticker.add((t) => this.frame(t));
  }

  /** WebGL programs pixi has linked so far (`?debug=shaders` reports any linked mid-game). */
  shaderCount(): number {
    const hash = (this.app.renderer as unknown as { shader?: { _programDataHash?: Record<string, unknown> } }).shader?._programDataHash;
    return hash ? Object.keys(hash).length : 0;
  }

  /** The scene's parts, for the start screen's preview and the dev gallery (`?gallery=1`), before or instead of a game. */
  devScene() {
    return { app: this.app, view3d: this.view3d, rig: this.rig, tilt: this.tilt, city: this.city, trains: this.trains, bins: this.bins, fx: this.fx, zoneView: this.zoneView, hud: this.hud };
  }
}
