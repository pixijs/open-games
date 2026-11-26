import type { BossPattern } from "./bosses.ts"
import type { DropKind, RoomKind, Side, TransitionKind } from "./rooms.ts"
import type { TellValue } from "./schema.ts"
import type { StageId } from "./stages.ts"
import type { BossId, EnemyKind } from "./tuning.ts"
import type { WeaponId, WeaponMove } from "./weapons.ts"
import type { ZoneId } from "./zones.ts"

/** Which press of a weapon's chain, from 1: the blade's 1 and 2 are crescents that alternate sides, 3 is the wide spin. */
export type ComboStep = 1 | 2 | 3

/**
 * What dealt a hit, or (for kills) that the enemy fell off the floor: the blade's cuts (`slash`) and spin, another
 * weapon's move, a reflected orb, the special, or a ring-out.
 */
export type HitSource = "slash" | "spin" | "cleave" | "slam" | "dart" | "pierce" | "sigil" | "seal" | "reflect" | "special" | "ringOut"

/** What hurt the player: an enemy's attack or orb, the Spiral's beam, or a Void slab falling from under them. */
export type HurtCause = "attack" | "beam" | "fall"

/** A player verb: what the input buffer holds and the debug hooks can press. */
export const playerActions = ["slash", "dash", "parry", "special"] as const
export type PlayerAction = (typeof playerActions)[number]

/** How a debug-spawned enemy behaves: `idle` has its AI off; a `dummy` also never dies and is never moved. */
export const drillModes = ["dummy", "idle"] as const
export type DrillMode = (typeof drillModes)[number]

/** The player's movement numbers the debug hooks can override; dash time in seconds. */
export interface PlayerMoves {
  readonly speed: number
  readonly acceleration: number
  readonly deceleration: number
  readonly dashDistance: number
  readonly dashTime: number
}

/**
 * A telegraph's drawn shape: a line along the attack, a ring around the attacker, an arc (a sector round the attacker,
 * `halfAngle` either side of the direction, swept the way `turn` says), or a spot (a ring of radius `size` on the
 * ground away from the attacker, at `spotX`, `spotZ`).
 */
export type TelegraphShape = TellValue["shape"]

/** A player attack's hit shape on the ground while it is live. */
export type HitShape =
  | {
    readonly kind: "arc"
    readonly x: number
    readonly z: number
    /** The arc's centre direction. */
    readonly facing: number
    readonly range: number
    /** Half the arc's angle; π for a full circle. */
    readonly halfAngle: number
    /** 1 sweeps right to left across the facing, -1 left to right, 0 all at once. */
    readonly sweep: 1 | -1 | 0
  }
  | { readonly kind: "circle"; readonly x: number; readonly z: number; readonly radius: number }
  | { readonly kind: "line"; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly length: number; readonly halfWidth: number }

/** What healed the player: a cleared room's chance, an elite room's clear, a spring, or the debug hooks. */
export type HealSource = "room" | "elite" | "spring" | "debug"

/** A target struck by one beat of the special. */
export interface SpecialTarget {
  readonly id: number
  readonly kind: EnemyKind
  readonly x: number
  readonly z: number
  readonly killed: boolean
}

/**
 * Everything the simulation tells the host, one value per moment, in the order it happened.
 * Positions are world x/z on the ground plane; directions are unit x/z vectors; angles are radians
 * in the simulation's convention (0 points +x, π/2 points +z); durations are seconds of game time.
 */
export type Moment =
  /** A run began in `zone`: its dungeon's start room (or the room the debug hooks named), or its classic arena when `sandbox`. */
  | { readonly type: "runStarted"; readonly zone: ZoneId; readonly seed: number; readonly sandbox: boolean }
  | { readonly type: "paused" }
  | { readonly type: "resumed" }
  | { readonly type: "quit" }
  | { readonly type: "waveStarted"; readonly wave: number; readonly total: number; readonly enemies: number }
  | { readonly type: "waveCleared"; readonly wave: number; readonly total: number; readonly x: number; readonly z: number }
  /** The last diamond is gone: the run ended in `zone`, in room `room` (null in the sandbox), after `rooms` rooms cleared. */
  | { readonly type: "gameOver"; readonly zone: ZoneId; readonly room: number | null; readonly time: number; readonly kills: number; readonly rooms: number }
  | {
    readonly type: "slash"
    readonly step: ComboStep
    readonly x: number
    readonly z: number
    /** The arc's centre direction. */
    readonly facing: number
    readonly range: number
    /** Half the arc's angle; π for the spin. */
    readonly halfAngle: number
    /** 1 sweeps right to left across the facing, -1 left to right, 0 is the spin. */
    readonly sweep: 1 | -1 | 0
    /** Seconds the hitbox stays live. */
    readonly duration: number
  }
  | {
    readonly type: "hit"
    readonly id: number
    readonly kind: EnemyKind
    readonly x: number
    readonly z: number
    readonly dirX: number
    readonly dirZ: number
    readonly damage: number
    readonly source: HitSource
    readonly step: ComboStep | 0
    readonly killed: boolean
  }
  | {
    readonly type: "enemyKilled"
    readonly id: number
    readonly kind: EnemyKind
    readonly x: number
    readonly z: number
    readonly dirX: number
    readonly dirZ: number
    readonly source: HitSource
    readonly lastOfWave: boolean
  }
  | { readonly type: "parry"; readonly x: number; readonly z: number; readonly against: "melee" | "projectile"; readonly dirX: number; readonly dirZ: number }
  | { readonly type: "parryStarted"; readonly x: number; readonly z: number; readonly facing: number }
  | { readonly type: "reflect"; readonly id: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number }
  | { readonly type: "dashStarted"; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number }
  | { readonly type: "dashEnded"; readonly x: number; readonly z: number }
  | { readonly type: "nearMiss"; readonly x: number; readonly z: number }
  | { readonly type: "playerHurt"; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly lives: number; readonly cause: HurtCause }
  | { readonly type: "playerDown"; readonly x: number; readonly z: number }
  | {
    readonly type: "telegraph"
    readonly id: number
    readonly kind: EnemyKind
    readonly shape: TelegraphShape
    readonly x: number
    readonly z: number
    readonly dirX: number
    readonly dirZ: number
    /** A line's length or a ring's radius. */
    readonly size: number
    readonly duration: number
    /** A trickster's fake windup: no attack follows it. */
    readonly feint: boolean
    /** An arc's half angle, radians. */
    readonly halfAngle?: number
    /** The way an arc sweeps: 1 clockwise on screen, -1 counter-clockwise. */
    readonly turn?: 1 | -1
    /** A spot's centre on the ground. */
    readonly spotX?: number
    readonly spotZ?: number
  }
  | { readonly type: "enemyAttack"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number }
  | { readonly type: "slam"; readonly id: number; readonly x: number; readonly z: number; readonly radius: number }
  | { readonly type: "enemySpawned"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly duration: number }
  | { readonly type: "blink"; readonly id: number; readonly fromX: number; readonly fromZ: number; readonly toX: number; readonly toZ: number; readonly duration: number }
  | { readonly type: "projectileFired"; readonly id: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly speed: number }
  | { readonly type: "projectileGone"; readonly id: number; readonly x: number; readonly z: number; readonly reason: "wall" | "expired" | "hit" }
  | { readonly type: "specialStarted"; readonly x: number; readonly z: number; readonly facing: number; readonly radius: number; readonly freeze: number }
  | { readonly type: "specialHit"; readonly index: number; readonly count: number; readonly final: boolean; readonly x: number; readonly z: number; readonly targets: ReadonlyArray<SpecialTarget> }
  | { readonly type: "specialEnded"; readonly x: number; readonly z: number; readonly kills: number }
  /** A warden's spiral volley begins: `shots` shots `interval` seconds apart, each `arms` orbs evenly round, turning `turn` radians a shot. */
  | { readonly type: "volley"; readonly id: number; readonly x: number; readonly z: number; readonly arms: number; readonly shots: number; readonly interval: number; readonly turn: number }
  /** A warden's volley ended: its shell is down for `duration` seconds. */
  | { readonly type: "wardenOpen"; readonly id: number; readonly x: number; readonly z: number; readonly duration: number }
  /** A blow glanced off a warden's shell: no damage. */
  | { readonly type: "clank"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number }
  /** A splitter broke into splitlings, thrown out along each piece's direction. */
  | {
    readonly type: "split"
    readonly id: number
    readonly x: number
    readonly z: number
    readonly pieces: ReadonlyArray<{ readonly id: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number }>
  }
  /** An enemy left the floor: it falls for `duration` seconds, already dead (an `enemyKilled` with source `ringOut` follows). */
  | { readonly type: "ringOut"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly duration: number }
  /** The Spiral's beam will start sweeping from `angle` in `lead` seconds; its telegraph line shows there. */
  | { readonly type: "beamWarned"; readonly x: number; readonly z: number; readonly angle: number; readonly lead: number }
  /** The beam starts sweeping from `angle` at `speed` radians a second (positive turns clockwise on screen) for `duration` seconds. */
  | { readonly type: "beamStarted"; readonly x: number; readonly z: number; readonly angle: number; readonly speed: number; readonly duration: number }
  | { readonly type: "beamEnded"; readonly x: number; readonly z: number; readonly angle: number }
  /** Void slabs (indices into the layout's slabs) start to crack; they fall in `duration` seconds. */
  | { readonly type: "slabsCracking"; readonly slabs: ReadonlyArray<number>; readonly duration: number }
  | { readonly type: "slabsFell"; readonly slabs: ReadonlyArray<number> }
  /** A slab fell from under the player, who is set down on the nearest standing floor. */
  | { readonly type: "playerCaught"; readonly fromX: number; readonly fromZ: number; readonly x: number; readonly z: number }
  | { readonly type: "focusFull" }
  | { readonly type: "hitStop"; readonly seconds: number }
  | { readonly type: "slowMotion"; readonly seconds: number; readonly scale: number }
  /** A zone's dungeon is made and its start room entered: at the run's start, and under a zone change's card. */
  | { readonly type: "zoneStarted"; readonly zone: ZoneId; readonly number: number; readonly rooms: number; readonly seed: number }
  /** The player is in room `room`, having come through its `from` side (null for a zone's first room). */
  | { readonly type: "roomEntered"; readonly zone: ZoneId; readonly room: number; readonly kind: RoomKind; readonly from: Side | null; readonly cleared: boolean; readonly waves: number }
  /** The room's doors sealed shut behind the player: its fight begins. */
  | { readonly type: "doorsLocked"; readonly room: number; readonly sides: ReadonlyArray<Side> }
  /** The room's seals broke: its doors are open. */
  | { readonly type: "doorsOpened"; readonly room: number; readonly sides: ReadonlyArray<Side> }
  /** The last enemy of the room's last wave fell, at (x, z), leaving `drops` on the floor near it. */
  | { readonly type: "roomCleared"; readonly room: number; readonly kind: RoomKind; readonly x: number; readonly z: number; readonly drops: ReadonlyArray<DropKind> }
  /** The player picked up a clear's drop at (x, z): a diamond healed one, or FOCUS filled `amount`. */
  | { readonly type: "dropTaken"; readonly kind: DropKind; readonly x: number; readonly z: number; readonly amount: number }
  /** The player walked into an open door (or the zone gate): the transition plays for `duration` seconds; the room swaps `swapAt` seconds in. */
  | { readonly type: "transitionStarted"; readonly kind: TransitionKind; readonly side: Side; readonly from: number; readonly to: number; readonly x: number; readonly z: number; readonly duration: number; readonly swapAt: number }
  /** Under full cover: the new room (or the new zone's start room) replaced the old; the player now stands at (x, z). */
  | { readonly type: "roomSwapped"; readonly kind: TransitionKind; readonly zone: ZoneId; readonly room: number; readonly side: Side; readonly x: number; readonly z: number }
  /** Control is back. */
  | { readonly type: "transitionEnded"; readonly kind: TransitionKind; readonly zone: ZoneId; readonly room: number }
  /** The player gained `amount` diamonds, now holding `lives`. */
  | { readonly type: "healed"; readonly amount: number; readonly lives: number; readonly x: number; readonly z: number; readonly source: HealSource }
  /** The player took `weapon` from altar `altar` and left `left` on it. */
  | { readonly type: "weaponTaken"; readonly weapon: WeaponId; readonly left: WeaponId; readonly altar: number; readonly x: number; readonly z: number }
  /** A player attack's hit shape went live: every weapon's every move (the blade also sends `slash`). `step` counts the chain from 1. */
  | { readonly type: "attack"; readonly weapon: WeaponId; readonly move: WeaponMove; readonly step: number; readonly shape: HitShape; readonly duration: number; readonly charged: boolean }
  /** A mark that lands `delay` seconds later: the breaker's slam ring, a sigil. */
  | { readonly type: "marked"; readonly weapon: WeaponId; readonly move: WeaponMove; readonly mark: number; readonly x: number; readonly z: number; readonly radius: number; readonly delay: number }
  /** A mark landed, striking `hits` enemies. */
  | { readonly type: "burst"; readonly weapon: WeaponId; readonly move: WeaponMove; readonly mark: number; readonly x: number; readonly z: number; readonly radius: number; readonly hits: number }
  /** A dart left the player (`id` is its entity): `pierce` for a charged shot, `perfect` for one released on the beat. */
  | { readonly type: "shot"; readonly id: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly speed: number; readonly pierce: boolean; readonly perfect: boolean }
  /** Darts loaded: one by one while not firing, or all at once by a dash. */
  | { readonly type: "reloaded"; readonly loaded: number; readonly size: number; readonly dash: boolean }
  /** A held attack finished charging. */
  | { readonly type: "charged"; readonly x: number; readonly z: number; readonly facing: number }
  /** A boss's name card: it waits `duration` seconds, invulnerable, before it fights. */
  | { readonly type: "bossIntro"; readonly id: number; readonly boss: BossId; readonly x: number; readonly z: number; readonly duration: number }
  /** A boss starts a pattern. Its telegraphs follow as `telegraph` moments. */
  | { readonly type: "bossPattern"; readonly id: number; readonly boss: BossId; readonly pattern: BossPattern; readonly x: number; readonly z: number }
  /** A boss crossed a threshold: `duration` seconds invulnerable (roar, summons, the arena changes), then phase `phase`. */
  | { readonly type: "bossPhase"; readonly id: number; readonly boss: BossId; readonly phase: number; readonly x: number; readonly z: number; readonly duration: number }
  /** A boss's balance broke: staggered open for `duration` seconds. */
  | { readonly type: "bossBroken"; readonly id: number; readonly boss: BossId; readonly x: number; readonly z: number; readonly duration: number }
  | { readonly type: "bossRecovered"; readonly id: number; readonly boss: BossId }
  | { readonly type: "bossDefeated"; readonly id: number; readonly boss: BossId; readonly x: number; readonly z: number }
  /**
   * A zone's boss fell; `next` is the zone its gate leads to, null after the last. `time` is the zone's clear time (from
   * entering its start room), `run` the run's time so far, both in seconds.
   */
  | { readonly type: "zoneCleared"; readonly zone: ZoneId; readonly next: ZoneId | null; readonly time: number; readonly run: number; readonly kills: number }
  /** The last boss fell: the run is won. `from` is the zone the run started in. */
  | { readonly type: "runCleared"; readonly time: number; readonly kills: number; readonly rooms: number; readonly from: ZoneId }
  /** An arm starts sweeping round (x, z) from angle `from` through `span` the way `turn` says (1 clockwise on screen), `radius` long, over `duration` seconds; the Orrery's hands are two arms opposite. */
  | { readonly type: "sweep"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly from: number; readonly span: number; readonly turn: 1 | -1; readonly radius: number; readonly arms: number; readonly duration: number }
  /** A ring wave leaves (x, z): its front runs from `from` out to `reach` at `speed`, `halfWidth` thick, broken by a gap of `gap` radians centred on `gapAngle`. */
  | { readonly type: "wave"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly from: number; readonly reach: number; readonly speed: number; readonly halfWidth: number; readonly gapAngle: number; readonly gap: number }
  /** A leap leaves (fromX, fromZ) for the spot under the player, which follows them for `follow` seconds; it lands `duration` seconds later. */
  | { readonly type: "leap"; readonly id: number; readonly kind: EnemyKind; readonly fromX: number; readonly fromZ: number; readonly spotX: number; readonly spotZ: number; readonly radius: number; readonly follow: number; readonly duration: number }
  /** A leap came down at (x, z), striking inside `radius`. */
  | { readonly type: "landed"; readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly radius: number }
  /** A seam (`id` is its own) starts running from (x, z) along its direction: `length` long in `grow` seconds, then burning for `live`. */
  | { readonly type: "seamDrawn"; readonly id: number; readonly owner: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly length: number; readonly halfWidth: number; readonly grow: number; readonly live: number }
  | { readonly type: "seamHealed"; readonly id: number }
  /** One of the Orrery's moons (0 to 2) cuts from (x, z) along its line, `length` long. */
  | { readonly type: "moonCut"; readonly id: number; readonly moon: number; readonly x: number; readonly z: number; readonly dirX: number; readonly dirZ: number; readonly length: number }
  /** A boss's charge met a wall or pillar (`pillar`: its index in the layout, null for a wall): stunned for `duration`; `breaks` when the pillar breaks. */
  | { readonly type: "bossStunned"; readonly id: number; readonly boss: BossId; readonly x: number; readonly z: number; readonly duration: number; readonly pillar: number | null; readonly breaks: boolean }
  /** Sunder split in two (its second half is `twin`), or the halves came back together at (x, z). */
  | { readonly type: "bossSplit"; readonly id: number; readonly twin: number; readonly x: number; readonly z: number }
  | { readonly type: "bossRejoined"; readonly id: number; readonly x: number; readonly z: number }
  /**
   * The killing blow on a boss: it breaks apart in slow motion for `duration` seconds, then `bossDefeated`. `fallen` are its
   * summons, struck down with it.
   */
  | {
    readonly type: "bossFelled"
    readonly id: number
    readonly boss: BossId
    readonly x: number
    readonly z: number
    readonly dirX: number
    readonly dirZ: number
    readonly duration: number
    readonly fallen: ReadonlyArray<{ readonly id: number; readonly kind: EnemyKind; readonly x: number; readonly z: number }>
  }

export type MomentType = Moment["type"]
export type MomentOf<T extends MomentType> = Extract<Moment, { readonly type: T }>

/** What the host asks of the simulation. Systems validate each one; the UI, tests and the debug API send the same values. */
export type Intent =
  | { readonly type: "aim"; readonly x: number; readonly z: number }
  | { readonly type: "aimFree" }
  /** Starts a run of The Courtyard: wave 0 is its sandbox (its classic arena, no fights), any other its dungeon. */
  | { readonly type: "start"; readonly wave: number; readonly seed: number }
  /** Starts a run in `stage`'s zone: wave 0 is its sandbox (its classic arena, no fights), any other its dungeon. */
  | { readonly type: "startStage"; readonly stage: StageId; readonly wave: number; readonly seed: number }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "restart" }
  | { readonly type: "quit" }
  | { readonly type: "grantFocus" }
  | { readonly type: "special" }
  /** Spawns an enemy at (x, z) or a spawn point, facing `facing` or the player, normal or as a drill, as an elite when `elite`. */
  | {
    readonly type: "spawn"
    readonly kind: EnemyKind
    readonly x: number | null
    readonly z: number | null
    readonly facing?: number | null
    readonly drill?: DrillMode | null
    readonly elite?: boolean | null
  }
  /** Removes every enemy and orb without a kill: a debug shortcut through the waves. */
  | { readonly type: "clearWave" }
  /** Makes an enemy (by id) or every enemy standing in Move start its attack now. */
  | { readonly type: "attack"; readonly id: number | null }
  | { readonly type: "invulnerable"; readonly on: boolean }
  /** Puts the player, or the enemy `id`, at (x, z) and facing `facing` (as before when null), at rest. */
  | { readonly type: "teleport"; readonly x: number; readonly z: number; readonly facing: number | null; readonly id?: number | null }
  /** Presses a player action once, as a key press would; an attack (`slash`) with `step` plays that press of the weapon's chain. */
  | { readonly type: "press"; readonly action: PlayerAction; readonly step?: ComboStep | null }
  /** Presses attack and keeps it held down for `seconds` of gameplay time, as a finger would: the darts' charge. */
  | { readonly type: "hold"; readonly seconds: number }
  /** Removes one enemy without a kill. */
  | { readonly type: "remove"; readonly id: number }
  /** Lands a blow of `damage` on an enemy as slash `step` would: knockback, stagger, death. Through a warden's shell. */
  | { readonly type: "blow"; readonly id: number; readonly damage: number; readonly step: ComboStep }
  /** Refills the player's lives. */
  | { readonly type: "heal" }
  /** Swaps the stage's floor for the open floor (The Courtyard's size and walls, no props) until the run ends, or back. */
  | { readonly type: "floor"; readonly open: boolean }
  /** Holds a move direction (x, z) as the stick would; (0, 0) releases it. */
  | { readonly type: "steer"; readonly x: number; readonly z: number }
  /** Overrides some of the player's movement numbers; null puts back tuning.ts. */
  | { readonly type: "tune"; readonly moves: Partial<PlayerMoves> | null }
  | { readonly type: "hazard"; readonly on: boolean }
  /** Starts the beam's telegraph now (The Spiral). */
  | { readonly type: "sweep" }
  /** Cracks the next slab group now (The Void). */
  | { readonly type: "collapse" }
  /**
   * Starts a run in `zone`: its dungeon from `seed`, in its start room, or (for the lab and the debug API) in room
   * `room`, by index or the first of a kind. `weapon` replaces the blade in hand.
   */
  | { readonly type: "startZone"; readonly zone: ZoneId; readonly room: number | RoomKind | null; readonly seed: number; readonly weapon: WeaponId | null }
  /** The interact key: takes the weapon on the altar the player stands by. */
  | { readonly type: "interact" }
  /** Puts `weapon` in the player's hand. */
  | { readonly type: "setWeapon"; readonly weapon: WeaponId }
  /** Sets the player's diamonds, 1 to the most. */
  | { readonly type: "lives"; readonly lives: number }
  /**
   * Goes through to room `room` of the zone (by index, or the first room of a kind) now, as a door's transition would,
   * or with `instant` at once, without one.
   */
  | { readonly type: "enterRoom"; readonly room: number | RoomKind; readonly instant?: boolean | null }
  /** Ends the room's fight: its enemies go without kills, it counts as cleared, and its seals break (a boss room's gate opens). */
  | { readonly type: "openDoors" }
  /** Shuts the room's seals, or breaks them, without touching its fight. */
  | { readonly type: "lockDoors"; readonly locked: boolean }
  /** Shows every room of the zone on the map. */
  | { readonly type: "revealMap" }
  /** Marks every other room of the zone cleared (the one the player is in stays as it is): none locks, the boss room's gate stands open. */
  | { readonly type: "clearRooms" }
  /** Takes the room's boss to the start of phase `phase`. */
  | { readonly type: "bossPhase"; readonly phase: number }
  /** Fills the room's boss's balance: it breaks open. */
  | { readonly type: "breakBoss" }
  /** Makes the room's boss play `pattern` next, whatever its phase. */
  | { readonly type: "bossPattern"; readonly pattern: BossPattern }
  /** Sets the room's boss's health; it shifts phase when that crosses a threshold. */
  | { readonly type: "bossHealth"; readonly hp: number }
