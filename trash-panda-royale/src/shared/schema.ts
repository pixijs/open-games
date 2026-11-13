import { schema, t, type SchemaType } from "@colyseus/schema";

/** `StateView` tag: each client adds its own player with it, and so gets their `.view(OWNER)` fields. */
export const OWNER = 1;

/**
 * One input frame per fixed step (consumed by `Room.defineInput()`). Flat
 * primitives only. Everything the shared step reads comes from here, so the
 * client replays exactly what the server decodes.
 */
export const PlayerInput = schema({
  /** World-space movement direction × 100 (camera-relative on the client). */
  mx: t.int8().default(0),
  mz: t.int8().default(0),
  /** Driving: W/S × 100. */
  throttle: t.int8().default(0),
  /** Driving: A/D × 100 (+ = right). */
  steer: t.int8().default(0),
  /** World yaw the mouse points at. */
  aim: t.float32().default(0),
  /**
   * How far up (1/AIM_Q rad; negative: down) a shot flies: toward what's under the crosshair.
   * Only a step that fires reads it, so the client only writes it on those (unchanged, a field
   * costs nothing on the wire).
   */
  pitch: t.int16().default(0),
  /** …and whether it leaves from the crosshair's line over the raccoon's back, not the gun (`shotHeight`). Written with `pitch`. */
  eye: t.boolean().default(false),
  fire: t.boolean().default(false),
  /**
   * G (or LT on foot), held: winding up a stink bomb, whatever you hold. Letting go throws it.
   * The click winds one up too while the stink bomb is out.
   */
  nade: t.boolean().default(false),
  /** Jump on foot, handbrake while driving. */
  jump: t.boolean().default(false),
  sprint: t.boolean().default(false),
  /** E: enter / steal / exit a car (edge-triggered, buffered on the client). */
  use: t.boolean().default(false),
  /** Desired weapon slot. */
  weapon: t.uint8().default(0),
}, "PlayerInput");
export type PlayerInput = SchemaType<typeof PlayerInput>;

export const Player = schema({
  // ---- simulated by the shared step (mirrored by the client reconciler) ----
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  vx: t.float32().default(0),
  vy: t.float32().default(0),
  vz: t.float32().default(0),
  /** Facing, world yaw (also while riding). Never wrapped, so it lerps. */
  yaw: t.float32().default(0),
  mode: t.uint8().default(0),
  /** Car id (driving / roof) or train slot (train roof); -1 otherwise. */
  veh: t.int16().default(-1),
  /** Local position on the car/train roof. */
  lx: t.float32().default(0),
  ly: t.float32().default(0),
  lz: t.float32().default(0),
  /** Facing relative to the car/train roof while riding (drawn on top of the drawn platform). */
  lyaw: t.float32().default(0),
  steer: t.float32().default(0),
  yawRate: t.float32().default(0),
  grounded: t.boolean().default(false),
  weapon: t.uint8().default(0),
  ammo1: t.uint16().default(0),
  ammo2: t.uint16().default(0),
  ammo3: t.uint16().default(0),
  ammo4: t.uint16().default(0),
  /** Fire cooldown (steps). */
  cd: t.uint8().default(0),
  /** Knock-down countdown (steps). Driving: how long S still holds the car at a halt before it backs up. */
  timer: t.uint16().default(0),
  /** Steps of the zoomies left (a coffee): faster on foot, and galloping. */
  zoomies: t.uint16().default(0),
  /** Steps a stink bomb has been wound up (0: not winding up). Everyone sees the wind-up. */
  charge: t.uint8().default(0),
  /** Steps left in which a jump still works after walking off an edge. Only its owner needs it. */
  coyote: t.uint8().default(0).view(OWNER),
  /** Sewer air breathed (see `PlayerSim.stench`). Only its owner needs it: the rest hear the coughing. */
  stench: t.uint16().default(0).view(OWNER),

  // ---- server-owned / presentation only ----
  aim: t.float32().default(0),
  name: t.string().default(""),
  look: t.uint32().default(0),
  hp: t.uint8().default(100),
  /** Bumped by every server-side teleport (spawns, round starts, parking): the client resets its prediction. */
  life: t.uint16().default(0),
  /**
   * Whose surroundings this player's client is sent: the centre of its `StateView` (their own
   * session id, or whoever they spectate; see `Interest`). Only sent to its owner.
   */
  aoi: t.string().default("").view(OWNER),
}, "Player");
export type Player = SchemaType<typeof Player>;

/**
 * Who's in the room and how they're doing: always sent to everyone (unlike `players`,
 * which only reaches the clients near each player), for the scoreboard, the player
 * counts and the spectator's target list.
 */
export const PlayerInfo = schema({
  name: t.string().default(""),
  look: t.uint32().default(0),
  connected: t.boolean().default(true),
  /** PlayerStatus: in the round, knocked out of it, or waiting for the next one. */
  status: t.uint8().default(0),
  /** Finishing place in the current (or last) round; 0 until then. */
  place: t.uint8().default(0),
  wins: t.uint16().default(0),
  /** Session id credited with knocking this player out of the round. */
  killedBy: t.string().default(""),
  roundKills: t.uint8().default(0),
  kills: t.uint16().default(0),
  deaths: t.uint16().default(0),
  score: t.uint32().default(0),
}, "PlayerInfo");
export type PlayerInfo = SchemaType<typeof PlayerInfo>;

/**
 * The fumes: the circle closing from (x0, z0, r0) to (x1, z1, r1) between `shrinkAt` and
 * `doneAt` (room ms). Only the current and the next circle are ever sent, so nobody can
 * work out where the last one will be. See `zoneAt()`.
 */
export const Zone = schema({
  x0: t.float32().default(0),
  z0: t.float32().default(0),
  r0: t.float32().default(0),
  x1: t.float32().default(0),
  z1: t.float32().default(0),
  r1: t.float32().default(0),
  shrinkAt: t.float64().default(0),
  doneAt: t.float64().default(0),
  stage: t.uint8().default(0),
}, "Zone");
export type Zone = SchemaType<typeof Zone>;

/** The battle-royale round. Times are room ms (`room.clock`). */
export const Round = schema({
  /** RoundPhase */
  phase: t.uint8().default(0),
  number: t.uint16().default(0),
  /** GO! Inputs stamped before this are frozen; 0 when no round is on. */
  goAt: t.float64().default(0),
  /** When the countdown or the victory lap ends. */
  endsAt: t.float64().default(0),
  /** The fumes stop moving at this time (the round was decided); 0 while they run. */
  stopAt: t.float64().default(0),
  /** How fast the fumes close (more players, slower). */
  pace: t.float32().default(1),
  entrants: t.uint8().default(0),
  alive: t.uint8().default(0),
  /** Session id of the last raccoon standing ("" with nobody left: a draw). */
  winner: t.string().default(""),
  winnerName: t.string().default(""),
  zone: t.ref(Zone),
}, "Round");
export type Round = SchemaType<typeof Round>;

/** The scalar fields the shared step reads and writes (reconciler `fields`). */
export const SIM_FIELDS = [
  "x", "y", "z", "vx", "vy", "vz", "yaw", "mode", "veh", "lx", "ly", "lz", "lyaw", "steer", "yawRate",
  "grounded", "weapon", "ammo1", "ammo2", "ammo3", "ammo4", "cd", "timer", "zoomies", "charge", "coyote", "stench",
] as const;

export const Car = schema({
  id: t.uint16().default(0),
  kind: t.uint8().default(0),
  paint: t.uint32().default(0),
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  vx: t.float32().default(0),
  vz: t.float32().default(0),
  yaw: t.float32().default(0),
  steer: t.float32().default(0),
  /** CarLight bits: braking, reversing, handbrake on (from its driver's input). */
  lights: t.uint8().default(0),
  /** sessionId of the player driving, "npc" for traffic AI, "" when empty. */
  driver: t.string().default(""),
  hp: t.uint8().default(100),
  /** 0 ok, 1 burning, 2 wreck. */
  state: t.uint8().default(0),
  siren: t.boolean().default(false),
}, "Car");
export type Car = SchemaType<typeof Car>;

export const Npc = schema({
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  vx: t.float32().default(0),
  vy: t.float32().default(0),
  vz: t.float32().default(0),
  yaw: t.float32().default(0),
  state: t.uint8().default(0),
  look: t.uint32().default(0),
}, "Npc");
export type Npc = SchemaType<typeof Npc>;

/**
 * Loot. Most of it sits in its loot can (keyed by its index into `CITY.pickups`) and comes back a
 * while after it's taken. `loose` loot lies on the street instead, once: what a gull dropped (it
 * snatched it out of its can) and what burst out of the golden dumpster. Loose loot flies in from
 * (ox, oy, oz) and lands at (x, y, z) at room ms `at` (it can be grabbed from then on), and a gull
 * carrying it has it in its feet (`carrier`).
 */
export const Pickup = schema({
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  kind: t.uint8().default(0),
  active: t.boolean().default(true),
  loose: t.boolean().default(false),
  carrier: t.string().default(""),
  ox: t.float32().default(0),
  oy: t.float32().default(0),
  oz: t.float32().default(0),
  at: t.float64().default(0),
}, "Pickup");
export type Pickup = SchemaType<typeof Pickup>;

/**
 * Garbage Day (see `GarbageDay`): the garbage truck (`truck`: its car id) brings the golden dumpster
 * to (x, z), facing `yaw`, and it bursts open with loot. `phase` is a `GarbagePhase`, since room ms
 * `at` (Locked: until `at`). Sent to everyone: the whole town hears the truck coming.
 */
export const Garbage = schema({
  phase: t.uint8().default(0),
  x: t.float32().default(0),
  z: t.float32().default(0),
  yaw: t.float32().default(0),
  at: t.float64().default(0),
  truck: t.uint16().default(0),
}, "Garbage");
export type Garbage = SchemaType<typeof Garbage>;

/**
 * A trash can to hide in (keyed by its index into `CITY.bins`, which has where it stands).
 * Who's inside is never sent: that's the point.
 */
export const Bin = schema({
  /** Its lid was knocked off by a hit: nobody can hide in it until it's back on. */
  lidOff: t.boolean().default(false),
  /** Which way the lid flew (world yaw): it lies on the ground over there. */
  lidYaw: t.float32().default(0),
}, "Bin");
export type Bin = SchemaType<typeof Bin>;

export const Grenade = schema({
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  vx: t.float32().default(0),
  vy: t.float32().default(0),
  vz: t.float32().default(0),
  owner: t.string().default(""),
  /** The thrower's input (its seq) that let go of it: their predicted throw is settled by it. */
  seq: t.uint32().default(0),
  bornMs: t.float64().default(0),
}, "Grenade");
export type Grenade = SchemaType<typeof Grenade>;

/**
 * Moving things (`players`, `cars`, `npcs`, `grenades`) are `.view()` collections: each
 * client only receives the ones near what it's looking at (its own player, or whoever it
 * spectates), managed by the server's `Interest`. The rest is sent to everyone.
 */
export const GameState = schema({
  players: t.map(Player).view(),
  cars: t.map(Car).view(),
  npcs: t.map(Npc).view(),
  pickups: t.map(Pickup),
  bins: t.map(Bin),
  /**
   * The lamp posts cars knocked over (keyed by index into `CITY.poles`), each with which way it
   * fell: one byte, 256ths of a turn (`poleFallYaw`). Standing ones aren't sent at all, so a
   * fallen post costs a few bytes, once; a new round clears the lot in one go.
   */
  poles: t.map("uint8"),
  /**
   * The manholes whose lids are off (keyed by index into `MANHOLES`: someone just climbed out), each
   * with which way the lid fell, in 256ths of a turn. Anyone walking over an open one falls in.
   */
  manholes: t.map("uint8"),
  grenades: t.map(Grenade).view(),
  roster: t.map(PlayerInfo),
  round: t.ref(Round),
  garbage: t.ref(Garbage),
}, "GameState");
export type GameState = SchemaType<typeof GameState>;
