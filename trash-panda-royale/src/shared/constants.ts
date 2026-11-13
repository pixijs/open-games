/**
 * Gameplay constants shared by the server simulation and the client predictor.
 * Anything the deterministic step reads lives here (or in map.ts / train.ts), so
 * both sides integrate with exactly the same numbers.
 */

/** Simulation rate in Hz. One input advances exactly one step at this rate. */
export const TICK_RATE = 30;
/** State patch interval (ms): one patch per simulation step. */
export const PATCH_RATE_MS = 33;
/** Remote entities render this far in the past (ms); also the lag-comp stamp. */
export const INTERP_DELAY_MS = 100;
/** Server keeps this much position history for rewinds (ms). */
export const MAX_REWIND_MS = 600;

export const MAX_PLAYERS = 16;

// ---------------------------------------------------------------- world
export const MAP_HALF = 165;
/** A street's usual half width of asphalt (layout.ts gives each street its own). */
export const ROAD_HALF = 5;
/** A street's usual half width with its sidewalks. */
export const CORRIDOR_HALF = 7.5;
/** Lane centre offset from the road centre line. */
export const LANE_OFFSET = 2.5;

// ---------------------------------------------------------------- physics
export const GRAVITY = 24;
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.3;
export const WALK_SPEED = 5;
export const RUN_SPEED = 8;
export const JUMP_VELOCITY = 9.3; // apex ≈ 1.8 m
/** Highest ledge a player walks up without jumping. */
export const STEP_UP = 0.45;
/**
 * Jumping into the side of a car or a train, a raccoon grabs its roof and climbs up when the
 * roof is at most this far above its feet (paws stretched up): any car from a standing jump,
 * a train's 3 m roof near the top of one (stepped at 30 Hz, a jump peaks at 1.65 m: that's
 * 0.2 s of reach).
 */
export const CLIMB_REACH = 1.45;
/** …and only while the stick pushes into that side at least this much (0..1): not when jumping past it. */
export const CLIMB_PUSH = 0.35;
/** Seconds after a climb that the stick doesn't move you: still held into the side you came up, it would walk you off the far one. */
export const CLIMB_SETTLE = 0.25;
/**
 * Climbing a ledge (a wall, a roof's edge) puts you this far in from its edge: room for your
 * whole circle on top. A ledge shallower than that (a wall's top) can't be climbed.
 */
export const LEDGE_IN = PLAYER_RADIUS + 0.05;
/**
 * A static ledge (a wall, a roof's edge, an awning) is grabbed when its top is at most this far
 * over the feet: a little more than a car's or a train's roof (CLIMB_REACH), so a ledge within
 * reach of the top of a jump (about 3.35 m from the street) catches a running jump over more of
 * its arc than just the apex.
 */
export const LEDGE_REACH = 1.7;
/** Steps after walking off an edge that a jump still works (~0.1 s at 30 Hz: see `stepFoot`). */
export const COYOTE_STEPS = 4;
/**
 * A fall from higher than this (m) lands you dazed. A running jump off a shop roof (4.95 m) falls
 * about 6.6 m from its top: that one's free.
 */
export const FALL_DAZE_H = 7;
/** How long a hard landing leaves you dazed (s). */
export const FALL_DAZE = 1;
/** E only gets you into a car from about street level (not from a roof's edge above it). */
export const CAR_ENTER_Y = 1.2;
/** Anything floating higher than this (awnings, landings, planks) passes over a car. */
export const CAR_CLEAR = 2.4;

// ---------------------------------------------------------------- player modes
export const Mode = {
  Foot: 0,
  Driving: 1,
  /** Standing on the roof of a car (local coordinates on the car). */
  Roof: 2,
  /** Standing on the roof of a train car (local coordinates on the wagon). */
  Train: 3,
  /** Flung by a car / explosion / train: no control until the timer ends. */
  Knocked: 4,
  Dead: 5,
  /** Hiding in a trash can (`veh` = which one, an index into `CITY.bins`): out of sight until it's hit. */
  Hidden: 6,
  /**
   * Crawling on a wall, with the zoomies: `lyaw` is the way out of it (its normal's angle), `yaw`
   * faces into it, `vy` is the climb (no gravity: the claws hold). See `stepWall`.
   */
  Wall: 7,
  /**
   * Down a manhole, in the sewer under the streets (see `stepSewer`): `veh` = the street (index into
   * `CITY.roads.edges`) whose pipe we're in, `lx` = how far along it from its `a` end (m), `vx` = how
   * fast along it (+ toward its `b` end; 0 stopped under a manhole), `lz` = the manhole we're under or
   * last passed (index into `CITY.manholes`). x/z are the point on the street over us.
   */
  Sewer: 8,
  /**
   * Knocked out of the round (or waiting for the next one), and flying over the town as a seagull
   * (see `stepGull`): `veh` = the kind of loot carried in its feet (-1: none), `cd` steps until it can
   * poop again, `timer` steps left tumbling after being shooed (a shot, a slap, a blast).
   */
  Gull: 9,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

// ---------------------------------------------------------------- manholes (the sewer)
/** A raccoon on foot dives down a manhole whose centre is this close to theirs (E). */
export const MANHOLE_REACH = 1.2;
/** Walking over an open manhole (its lid knocked off) drops you in: within this of its middle. */
export const MANHOLE_FALL_R = 0.4;
/** Down there you scurry along the pipes this fast (m/s), getting up to speed at this (m/s²). */
export const SEWER_SPEED = 12;
export const SEWER_ACCEL = 40;
/** How far under the street a raccoon in the sewer is (m): out of every ray and blast. */
export const SEWER_Y = -1.2;
/** Climbing out: this fast up, and this fast along the stick (or the way we face). */
export const SEWER_POP_UP = 9.5;
export const SEWER_POP_SPEED = 3;
/** After a dive (or arriving under a manhole) the stick doesn't move us for this long (s): a tap doesn't overshoot. */
export const SEWER_SETTLE = 0.3;
/** A lid popped off stays off this long (ms): anyone walking over the hole meanwhile falls in. */
export const MANHOLE_OPEN_MS = 8000;
/** A stink bomb going off within this of a manhole (m) gasses out whoever is under it. */
export const MANHOLE_BLAST_R = 3;
/**
 * Breath, down there: a full one lasts SEWER_AIR_S, then you come up the next manhole gasping
 * (dazed SEWER_GASP_DAZE s). Up top it comes back SEWER_AIR_REFILL times slower, and a dive needs
 * SEWER_AIR_MIN_S of it: nobody camps the sewer all round. See `PlayerSim.stench`.
 */
export const SEWER_AIR_S = 15;
export const SEWER_AIR_REFILL = 3;
export const SEWER_AIR_MIN_S = 4;
export const SEWER_GASP_DAZE = 1.2;
/** With this little breath left (s), the manhole over you coughs for whoever is near, every SEWER_COUGH_MS. */
export const SEWER_COUGH_S = 4;
export const SEWER_COUGH_MS = 700;

// ---------------------------------------------------------------- seagulls (out of the round)
/** Cruising speed (m/s), how fast it gets there, and how fast Space climbs and Shift dives. */
export const GULL_SPEED = 13;
export const GULL_ACCEL = 3.5;
export const GULL_CLIMB = 7;
export const GULL_DIVE = 10;
/** It never flies lower than this over whatever is under it (m), nor higher than GULL_CEIL over the street. */
export const GULL_CLEAR = 1;
export const GULL_CEIL = 42;
/** Its body, for the walls it flies into and the shots that shoo it (m). */
export const GULL_R = 0.45;
/** It hatches out of its tombstone this long after the knockout (ms). */
export const GULL_HATCH_MS = 3200;
/** Seconds between two droppings. */
export const GULL_POOP_S = 2;
/** A raccoon hit by a dropping can't be hit by another for this long (ms): no pile-ons. */
export const POOP_IMMUNE_MS = 4000;
/** A dropping's radius, as it hits a raccoon (m, on top of theirs). */
export const POOP_R = 0.3;
/** Shooed (a shot, a slap, a blast): it tumbles this long (s), dropping whatever it carried. */
export const GULL_SHOO_S = 1.2;
/** It snatches loot within this of its feet (m across, and up to this far below it). */
export const GULL_SNATCH_R = 1.6;
export const GULL_SNATCH_DOWN = 2.6;

// ---------------------------------------------------------------- trash cans (hiding)
/** A raccoon dives into a trash can whose centre is this close to theirs (E). */
export const BIN_REACH = 1.3;
/** Hopping out (E, Space or click): this fast along the stick (or the aim), and this fast up. */
export const BIN_HOP_SPEED = 3.6;
export const BIN_HOP_UP = 8;
/** Popped out by a hit: flung this fast away from it, this fast up, dazed this long (s). */
export const BIN_POP_SPEED = 3.5;
export const BIN_POP_UP = 10;
export const BIN_POP_DAZE = 0.4;
/** A hit knocks the lid off: nobody can hide in that can until it's back on (ms). */
export const BIN_LID_MS = 15000;
/**
 * Someone who just dove in stays in the views of those around for this long (ms), so they
 * see the dive; after that they're out of everyone's StateView until they come back out.
 */
export const BIN_REVEAL_MS = 700;

// ---------------------------------------------------------------- vehicles
export interface CarType {
  /** What the kill feed calls it ("X stole a …"). */
  name: string;
  /** Its model (and kill-feed icon). */
  model: string;
  halfW: number;
  halfL: number;
  roof: number;
  maxSpeed: number;
  accel: number;
  /** How far the axles are ahead of and behind the middle (m): where the model's wheels are. */
  axle: number;
  /** Tyre grip, × the usual. */
  grip: number;
  /** Paint colour for random cars of this type (index into CAR_COLORS or fixed). */
  paint: number[];
}

export const CAR_COLORS = [0xff6b6b, 0x4ecdc4, 0xffd166, 0x9b7bff, 0x06d6a0, 0xff9f68, 0x5aa9ff, 0xff7eb6];

export const CAR_TYPES: CarType[] = [
  { name: "hatchback", model: "car_hatch", halfW: 1.0, halfL: 1.9, roof: 1.45, maxSpeed: 25, accel: 14, axle: 1.22, grip: 1, paint: CAR_COLORS },
  { name: "taxi", model: "car_taxi", halfW: 1.0, halfL: 2.1, roof: 1.5, maxSpeed: 26, accel: 14, axle: 1.38, grip: 1, paint: [0xffd23f] },
  { name: "pest control car", model: "car_pest", halfW: 1.0, halfL: 2.1, roof: 1.5, maxSpeed: 30, accel: 17, axle: 1.38, grip: 1.06, paint: [0xf6f3ee] },
  { name: "ice-cream van", model: "car_van", halfW: 1.1, halfL: 2.4, roof: 2.2, maxSpeed: 20, accel: 10, axle: 1.55, grip: 0.92, paint: [0xff8fb1] },
  // only ever the one, on Garbage Day (see `GarbageDay`): never in traffic or parked
  { name: "garbage truck", model: "car_garbage", halfW: 1.25, halfL: 3.3, roof: 2.8, maxSpeed: 19, accel: 8, axle: 2.0, grip: 0.95, paint: [0x3fae5a] },
];
/** The garbage truck's kind (index into CAR_TYPES). */
export const CAR_GARBAGE = 4;

export const CAR_REVERSE_SPEED = 9;
export const CAR_MAX_HP = 100;
/** A car burns this long (ms) at 0 hp before it blows. */
export const CAR_FUSE_MS = 2600;

/** `Car.lights` bits: what its driver's feet and hand are doing (brake and reversing lights, skids). */
export const CarLight = {
  Brake: 1,
  Reverse: 2,
  Handbrake: 4,
} as const;

/*
 * Handling (`stepDriving`): a car is two axles, each with a tyre that grips up to a limit and
 * slides past it (the tyre curve of ../gta's vehicle step, flattened to 2D). The front one
 * steers and the rear one drives; braking, accelerating and cornering share each tyre's grip.
 */
/** Sub-steps per fixed step: the tyres are stiff. */
export const CAR_SUBSTEPS = 4;
/** Grip of the front and rear tyres, × their share of the weight (× GRAVITY): the most they push (m/s²). */
export const CAR_MU_FRONT = 1.45;
export const CAR_MU_REAR = 1.35;
/** A tyre grips hardest when it slides sideways at this fraction of its rolling speed (tan of the slip angle)… */
export const CAR_SLIP_PEAK = 0.15;
/** …and past that, sliding further, it keeps this much of that grip. */
export const CAR_TYRE_TAIL = 0.8;
/** Slip is measured against at least this rolling speed (m/s): parked tyres aren't infinitely stiff. */
export const CAR_SLIP_REF = 2;
/** Pushing along a tyre counts this much against its grip, next to pushing across it. */
export const CAR_LONG_SHARE = 0.5;
/** How far the weight moves to the front per m/s² of braking (and to the back, accelerating), × GRAVITY: CG height / wheelbase. */
export const CAR_LOAD_SHIFT = 0.13;
/** S (and W, rolling backwards): the brakes (m/s², if the tyres have it), this much of it on the front. */
export const CAR_BRAKE = 25;
export const CAR_BRAKE_FRONT = 0.62;
/** Braked to a halt, S holds the car this long before it backs up (steps). */
export const CAR_REVERSE_HOLD = 6;
/** Off the pedals: the engine and the road slow you down this much (m/s²). */
export const CAR_COAST = 3.5;
/** Space: the rear wheels lock and slide, with this much of their grip across them, and along them. */
export const CAR_HANDBRAKE_GRIP = 0.4;
export const CAR_HANDBRAKE_DRAG = 0.55;
/**
 * Power on a rear tyre that's already sliding spins it up, and it loses up to this much of its grip
 * across (at full throttle, from twice its peak slip on): the throttle keeps a drift going.
 */
export const CAR_SPIN_GRIP = 0.25;
/** The wheels turn up to this much (rad), less the faster you go, down to the minimum. */
export const CAR_STEER_MAX = 0.72;
export const CAR_STEER_MIN = 0.17;
/** Speed (m/s) at which the steering lock has halved (it falls with the square of the speed). */
export const CAR_STEER_FALL = 11;
/** How fast the steering winds toward full lock, and back to the middle (full locks per second). */
export const CAR_STEER_WIND = 6;
export const CAR_STEER_RETURN = 10;
/**
 * The front wheels also turn this much toward where the tail slides (× its slip angle past
 * CAR_COUNTER_FROM rad): some of the counter-steer a drift needs, done for you.
 */
export const CAR_COUNTER = 0.75;
export const CAR_COUNTER_FROM = 0.08;
/** Yaw damping on the ground (1/s). */
export const CAR_YAW_DAMP = 1.0;
/** A hit off the centre of the car spins it, this much of what it would for a rigid box. */
export const CAR_HIT_SPIN = 0.45;

/*
 * Lamp posts break away. A car closing on one at POLE_KNOCK_SPEED or more knocks it over and
 * loses up to POLE_KNOCK_LOSS of that speed; slower than that, the post stops it like a wall.
 */
export const POLE_KNOCK_SPEED = 4;
export const POLE_KNOCK_LOSS = 2.5;
/** A post's radius, as a car hits it (m). */
export const POLE_R = 0.18;

// ---------------------------------------------------------------- trains
export const TRAIN_COUNT = 2;
/** Locomotive + wagons per train. */
export const TRAIN_CARS = 4;
export const TRAIN_SPEED = 11;
export const TRAIN_HALF_W = 1.3;
export const TRAIN_ROOF = 3.0;
export const LOCO_LENGTH = 7.5;
export const WAGON_LENGTH = 8;
export const TRAIN_GAP = 0.6;
/** How far past a roof edge a rider's centre may stand before dropping off (and the landing reach). */
export const TRAIN_EDGE = 0.15;
/** A rider changes car this far past the middle of a coupling, ×2 (no flip-flopping on the seam). */
export const TRAIN_COUPLE_HYST = 0.2;
/** Coupled car ends are walkable this far out: bridges the gap, and the wedge between cars in a curve. */
export const TRAIN_BRIDGE = TRAIN_GAP / 2 + 0.7;
/** A jumping rider stays in the car's frame until this far off its roof. */
export const TRAIN_AIR_REACH = 2;
/** Outward speed (m/s) given to a rider walking off, so they clear the train instead of scraping its side. */
export const TRAIN_DISMOUNT_PUSH = 3;
/** A train only runs you over when it moves into you at least this fast (m/s); slower, it shoves. */
export const TRAIN_HIT_SPEED = 3;
/** A rider's centre must be this close to a car roof's edge to land on it (inside the 0.15 m drop-off). */
export const ROOF_LAND_EDGE = 0.1;

// ---------------------------------------------------------------- weapons
export const Weapon = {
  Fists: 0,
  Pistol: 1,
  Smg: 2,
  Shotgun: 3,
  Grenade: 4,
} as const;
export type Weapon = (typeof Weapon)[keyof typeof Weapon];

export interface WeaponDef {
  name: string;
  /** Fixed steps between shots. */
  cooldown: number;
  damage: number;
  range: number;
  pellets: number;
  spread: number;
  /** Ammo granted by one pickup. */
  pickupAmmo: number;
  knockback: number;
}

export const WEAPONS: WeaponDef[] = [
  { name: "Paw Slap", cooldown: 12, damage: 18, range: 1.6, pellets: 1, spread: 0, pickupAmmo: 0, knockback: 7 },
  { name: "Pop-Gun", cooldown: 8, damage: 22, range: 45, pellets: 1, spread: 0, pickupAmmo: 36, knockback: 2 },
  { name: "Cap Blaster", cooldown: 3, damage: 10, range: 34, pellets: 1, spread: 0.04, pickupAmmo: 120, knockback: 1 },
  { name: "Trash Blunderbuss", cooldown: 24, damage: 11, range: 18, pellets: 7, spread: 0.07, pickupAmmo: 18, knockback: 6 },
  { name: "Stink Bomb", cooldown: 20, damage: 95, range: 6.5, pellets: 1, spread: 0, pickupAmmo: 4, knockback: 14 },
];

export const GRENADE_FUSE_MS = 1900;
/** A throw's upward speed (m/s) at half power: a tap lobs lower, full power higher. */
export const GRENADE_THROW_UP = 7.5;
export const GRENADE_RADIUS = 0.12;
/**
 * A stink bomb is wound up, not fired: holding G (or the click, with it out) winds it up one
 * step at a time, and letting go throws it. This many steps (1 s) is full power.
 */
export const GRENADE_CHARGE_STEPS = TICK_RATE;
/** How far a stink bomb comes to rest on open ground (m): the shortest throw (a tap), and full power. */
export const GRENADE_MIN_DIST = 3;
export const GRENADE_MAX_DIST = 26;

export const PLAYER_MAX_HP = 100;
export const RESPAWN_MS = 3500;
export const PICKUP_RESPAWN_MS = 14000;

/** Pickup kind for a snack (pizza, donut) that heals instead of arming you. Kinds below are weapons. */
export const PICKUP_FOOD = 5;
export const FOOD_HP = 40;
export const FOOD_RESPAWN_MS = 25000;

/**
 * Pickup kind for a coffee to go: the zoomies. For a while you're faster on foot and gallop on
 * all fours (the only time a raccoon does). You can still shoot: it rears up to.
 */
export const PICKUP_ZOOMIES = 6;
export const ZOOMIES_MS = 15000;
/** Top speed on foot with the zoomies (m/s), Shift or not. */
export const ZOOMIES_SPEED = 11;
export const ZOOMIES_RESPAWN_MS = 30000;
/**
 * With the zoomies, running into a wall sticks you to it: you crawl up, down and along it at
 * this speed (m/s), and over its top onto the roof. They wear off and you fall.
 */
export const WALL_SPEED = 5;
/** …but only running at it squarely: the stick pushing into it at least this much (0..1, ~45°), not along a street's frontage. */
export const WALL_PUSH = 0.7;
/** Pressed this far (m) into the wall every step on it: it keeps touching it, and goes round its outer corners. */
export const WALL_STICK = 0.1;
/** Pushing up within this (m) of a wall's top, you climb over onto it. */
export const WALL_TOP_REACH = 1;
/** Space on a wall kicks off it: out (m/s) and up (m/s), and the stick doesn't steer for a moment (s): no straight back on. */
export const WALL_KICK_OUT = 5;
export const WALL_KICK_UP = 7;
export const WALL_KICK_SETTLE = 0.25;

// ---------------------------------------------------------------- battle royale
export const RoundPhase = {
  /** Fewer than ROUND_MIN_PLAYERS: a free-for-all with respawns. */
  Warmup: 0,
  /** Everyone respawned and frozen until GO. */
  Countdown: 1,
  /** No respawns; the fumes close in. */
  Live: 2,
  /** The last raccoon standing takes a bow. */
  Victory: 3,
} as const;
export type RoundPhase = (typeof RoundPhase)[keyof typeof RoundPhase];

export const PlayerStatus = {
  /** In the round (or free-roaming in warmup). */
  Playing: 0,
  /** Knocked out of this round: spectating. */
  Out: 1,
  /** Joined mid-round: spectating until the next one. */
  Waiting: 2,
} as const;
export type PlayerStatus = (typeof PlayerStatus)[keyof typeof PlayerStatus];

export const ROUND_MIN_PLAYERS = 2;
export const ROUND_COUNTDOWN_MS = 5000;
export const ROUND_VICTORY_MS = 5000;
/** A kill heals the killer this much during a round. */
export const KILL_HEAL = 20;
/** Fumes, trains and falls credit whoever last hurt you within this long. */
export const KILL_CREDIT_MS = 10000;
/** Where spectators' bodies wait (off the map, out of everyone's view). */
export const PARK_X = -162;
export const PARK_Z = -162;

// ---------------------------------------------------------------- Garbage Day
/** Once a round, this long after GO (s, at the fumes' pace), the garbage truck comes to town. */
export const GARBAGE_AT_S = 10;
/** It drives this fast (m/s; slower round corners), and stops this long behind the drop (s) before lowering it. */
export const GARBAGE_SPEED = 12;
export const GARBAGE_BEEP_S = 2.2;
/** The golden dumpster takes this long to come down off the truck (ms), and stays padlocked this long after (ms). */
export const GARBAGE_LOWER_MS = 1600;
export const GARBAGE_LOCK_MS = 8000;
/** The golden dumpster: half its width and depth, and its height (m). Solid, and you can stand on it. */
export const DUMPSTER_HW = 1.0;
export const DUMPSTER_HD = 0.65;
export const DUMPSTER_H = 1.4;
/** What bursts out of it (pickup kinds), and how far out it lands (m). */
export const GARBAGE_LOOT = [3, 3, 2, 4, 4, 5, 5, 6, 1];
export const GARBAGE_LOOT_R = [2.6, 5.8] as const;
/** Loose loot (out of the golden dumpster, or dropped by a gull) flies this long before it can be grabbed (ms). */
export const LOOSE_FLIGHT_MS = 700;
/** Loose loot nobody picks up is gone after this long (ms). */
export const LOOSE_TTL_MS = 90000;

/** Garbage Day, as `GameState.garbage.phase`. */
export const GarbagePhase = {
  /** Not today (yet). */
  None: 0,
  /** The truck is on its way (the dumpster rides on its back). */
  Coming: 1,
  /** Stopped, beeping, lowering it (from `at`). */
  Lowering: 2,
  /** On the street, padlocked until `at`. */
  Locked: 3,
  /** Burst open at `at`: the loot is out. */
  Open: 4,
} as const;

// ---------------------------------------------------------------- interest management
/** An entity enters a client's view within this distance of what it's looking at… */
export const AOI_IN = 64;
/** …and leaves it beyond this one (hysteresis: nothing flickers at the edge). */
export const AOI_OUT = 80;
/** Views are updated every this many steps. */
export const AOI_EVERY = 3;
/** Positional events (shots, crashes, honks…) reach clients looking within this distance. */
export const NEAR_EVENTS = 90;
export const NEAR_BOOMS = 160;

/** At most one taunt (T) per this many ms per player. */
export const TAUNT_MS = 1500;

// ---------------------------------------------------------------- NPCs
export const NPC_COUNT = 34;
export const NPC_WALK_SPEED = 1.6;
export const NPC_RUN_SPEED = 5.5;
/** A townsperson's radius, as a car hits them (m). */
export const NPC_HIT_R = 0.4;

/*
 * Run over: a car going RUN_OVER_SPEED or more that closes on someone at RUN_OVER_CLOSING or
 * more sends them flying. A driver's car loses up to RUN_OVER_LOSS of that closing speed per
 * townsperson (decided in the shared step, so the driver feels the thud right away).
 */
export const RUN_OVER_SPEED = 4.5;
export const RUN_OVER_CLOSING = 2;
export const RUN_OVER_LOSS = 1.5;

/**
 * Street furniture (`Box.loose`): cars drive through it. Slower than this (m/s), a car only
 * nudges it aside on screen; faster, it knocks it flying, and a trash can's lid off (out pops
 * whoever hides in it).
 */
export const LOOSE_KNOCK_SPEED = 2;

export const NpcState = {
  Walk: 0,
  Flee: 1,
  Flying: 2,
  KO: 3,
  Hidden: 4,
} as const;
export type NpcState = (typeof NpcState)[keyof typeof NpcState];

export const AI_TRAFFIC = 16;
export const PARKED_CARS = 14;

/** Seconds → fixed steps. */
export const ticks = (seconds: number) => Math.round(seconds * TICK_RATE);
