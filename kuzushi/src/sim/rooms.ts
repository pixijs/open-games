import type { ArenaLayout } from "./arena.ts"
import type { BEATS } from "./dungeon/rules.ts"
import type { WeaponId } from "./weapons.ts"
import type { ZoneId } from "./zones.ts"

/** The four edges of a room, each with a door at its centre or a closed recess. */
export const sides = ["north", "east", "south", "west"] as const
export type Side = (typeof sides)[number]

export const opposite = { north: "south", east: "west", south: "north", west: "east" } as const satisfies Record<Side, Side>

/** Each side's direction from a room's centre as a unit x/z vector (north is up the screen, -z); also its step on the map's grid (columns grow east, rows south). */
export const SIDE_DIRS = {
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 }
} as const satisfies Record<Side, { readonly x: number; readonly z: number }>

export const roomKinds = ["start", "combat", "elite", "weapon", "spring", "boss"] as const
export type RoomKind = (typeof roomKinds)[number]

export interface RoomKindInfo {
  readonly name: string
  /** Its doors lock until its fight is won. */
  readonly fight: boolean
  /** It has an icon on the map, and on the seal of every door that leads to it once it is seen. */
  readonly marked: boolean
}

export const ROOM_KINDS = {
  start: { name: "Start", fight: false, marked: true },
  combat: { name: "Combat", fight: true, marked: false },
  elite: { name: "Elite", fight: true, marked: true },
  weapon: { name: "Altar", fight: false, marked: true },
  spring: { name: "Spring", fight: false, marked: true },
  boss: { name: "Boss", fight: true, marked: true }
} as const satisfies Record<RoomKind, RoomKindInfo>

/** What a room's clear leaves where its last enemy fell, until picked up: a diamond (one diamond back) or FOCUS. */
export const dropKinds = ["diamond", "focus"] as const
export type DropKind = (typeof dropKinds)[number]

/** What the map knows of a room: hidden; seen from a room next door; entered, its fight not yet won; or cleared. */
export const roomStates = ["hidden", "seen", "visited", "cleared"] as const
export type RoomState = (typeof roomStates)[number]

export interface MapRoomView {
  /** Its index in the zone's rooms: what doors, transitions and moments call it. */
  readonly index: number
  readonly column: number
  readonly row: number
  readonly kind: RoomKind
  readonly state: RoomState
  /** Doors from the start room. */
  readonly depth: number
  /** The sides with a door to another room. */
  readonly exits: ReadonlyArray<Side>
  /** A combat room off the way to the boss: its clear always leaves FOCUS. */
  readonly cache: boolean
}

/** The zone's dungeon as the map draws it. Every room is listed; the map shows only those not hidden. */
export interface MapView {
  readonly zone: ZoneId
  readonly columns: number
  readonly rows: number
  readonly rooms: ReadonlyArray<MapRoomView>
  /** The index of the room the player is in. */
  readonly current: number
}

export type DoorState = "open" | "locked"

export interface DoorView {
  readonly side: Side
  /** The doorway's centre on the floor's edge, in room coordinates, and its opening. */
  readonly x: number
  readonly z: number
  readonly width: number
  readonly state: DoorState
  /** The room behind it, by its index; null for the zone gate. */
  readonly to: number | null
  /**
   * The icon its seal carries once the room behind is seen: a marked room's kind, "cache" for a cache not yet cleared,
   * "gate" for the zone gate, else null.
   */
  readonly mark: DoorMark | null
}

/** What a door's seal and the map show of the room behind it. */
export type DoorMark = RoomKind | "cache" | "gate"

export interface AltarView {
  readonly index: number
  readonly x: number
  readonly z: number
  /** The weapon resting on it, or null once taken with nothing put back. */
  readonly weapon: WeaponId | null
  /** The player stands close enough to take it. */
  readonly near: boolean
}

/** A clear's drop on the floor: picked up by walking over it (a diamond only with one missing, FOCUS only short of full). */
export interface DropView {
  readonly index: number
  readonly kind: DropKind
  readonly x: number
  readonly z: number
  readonly taken: boolean
}

export interface SpringView {
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly spent: boolean
}

/** The room the player is in. */
export interface RoomView {
  readonly index: number
  readonly kind: RoomKind
  /** The template it was built from, as "courtyard.cloister". */
  readonly template: string
  /** Whether the template is mirrored left to right (x) and top to bottom (z). */
  readonly mirror: { readonly x: boolean; readonly z: boolean }
  /** Its ground plan in room coordinates: floor, props and spawn points (src/sim/arena.ts). */
  readonly layout: ArenaLayout
  readonly state: RoomState
  readonly doors: ReadonlyArray<DoorView>
  readonly altars: ReadonlyArray<AltarView>
  readonly spring: SpringView | null
  /** A combat room off the way to the boss: its clear always leaves FOCUS. */
  readonly cache: boolean
  readonly drops: ReadonlyArray<DropView>
}

export type TransitionKind = "door" | "zone"

/** The beats of a transition: a door plays exit, cover, hold, reveal; a zone change plays exit, cover, card, reveal. */
export type TransitionBeat = (typeof BEATS)[TransitionKind][number]

/** A transition while it plays. Gameplay holds; the run clock runs. */
export interface TransitionView {
  readonly kind: TransitionKind
  /** The way the hero travels: out through this side of the old room, in through the opposite side of the new. */
  readonly side: Side
  readonly beat: TransitionBeat
  /** 0 to 1 through the beat. */
  readonly progress: number
  /** 0 to 1 through the whole transition. */
  readonly overall: number
  /** Whether the new room has replaced the old one (it does under full cover). */
  readonly swapped: boolean
  /** Rooms by index; after a zone change, `to` is the new zone's start room. */
  readonly from: number
  readonly to: number
  /** The zone being entered: the current one through a door, the next through the gate. */
  readonly zone: ZoneId
}
