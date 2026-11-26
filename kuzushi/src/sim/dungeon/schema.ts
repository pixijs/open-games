import { Descriptor } from "@typeonce/ritmo"
import { z } from "zod"

import { dropKinds, roomKinds, roomStates, sides } from "../rooms.ts"
import { deadline } from "../time.ts"
import { enemyKinds } from "../tuning.ts"
import { weaponIds } from "../weapons.ts"
import { zoneIds } from "../zones.ts"
import { BEATS } from "./rules.ts"
import { isTemplateId } from "./templates.ts"
import type { TemplateId } from "./templates.ts"

const side = z.enum(sides)
const template = z.custom<TemplateId>(isTemplateId)

/** What a boss has changed in its room: the template's pillars it broke (by index) and whether its shift lit the room's boss hazard. */
const changes = { broken: z.array(z.int().min(0)).readonly(), lit: z.boolean() }

/**
 * The room the player stands in, as its terrain needs it: its template mirrored either way, the sides with a door
 * (the boss room's gate once open), whether its seals are shut, and what its boss changed. `CurrentStage.room`; null
 * on a classic arena.
 */
export const roomGround = z.object({
  index: z.int().min(0),
  template,
  mirrorX: z.boolean(),
  mirrorZ: z.boolean(),
  exits: z.array(side).readonly(),
  /** The side the zone gate opens on; it is among `exits` once the boss falls. */
  gate: side.nullable(),
  sealed: z.boolean(),
  ...changes
})
export type RoomGround = z.infer<typeof roomGround>

/** One enemy of a room's wave, in the order they appear. */
const slot = z.object({ kind: z.enum(enemyKinds), elite: z.boolean() })

/** A clear's drop on the floor until picked up. */
const drop = z.object({ kind: z.enum(dropKinds), x: z.number(), z: z.number(), taken: z.boolean() })

/**
 * One room of a zone's dungeon: its cell on the map, kind, depth (doors from the start), template and mirroring, the
 * waves drawn for it, what the player knows of it, the Void slab groups already fallen in it, what its boss changed,
 * its altars' weapons (null until a weapon room is first entered), its spring, whether it is a cache (a combat room
 * off the way from the start to the boss, whose clear always leaves FOCUS) and what its clear left on the floor.
 */
const roomRecord = z.object({
  column: z.int(),
  row: z.int(),
  kind: z.enum(roomKinds),
  depth: z.int().min(0),
  template,
  mirrorX: z.boolean(),
  mirrorZ: z.boolean(),
  waves: z.array(z.array(slot).readonly()).readonly(),
  state: z.enum(roomStates),
  fallen: z.int().min(0),
  ...changes,
  altars: z.array(z.enum(weaponIds).nullable()).readonly().nullable(),
  spring: z.object({ x: z.number(), z: z.number(), spent: z.boolean() }).nullable(),
  cache: z.boolean(),
  drops: z.array(drop).readonly()
})
export type RoomRecord = z.infer<typeof roomRecord>

/**
 * The zone's dungeon, made from `seed` when the zone starts: every room, the one the player is in, whether the map is
 * revealed, and the run-clock step the zone began (for its clear time). `None` on a classic arena (the sandbox).
 */
export const Dungeon = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("None") }),
  z.object({
    _tag: z.literal("Zone"),
    zone: z.enum(zoneIds),
    seed: z.int(),
    rooms: z.array(roomRecord).readonly(),
    current: z.int().min(0),
    revealed: z.boolean(),
    startedAt: z.int()
  })
]))("Game/Dungeon")
export type DungeonValue = Descriptor.Descriptor.Value<typeof Dungeon>
export type ZoneDungeon = Extract<DungeonValue, { readonly _tag: "Zone" }>

/** `dungeon` with room `index` replaced by `change` of it. */
export const updateRoom = (dungeon: ZoneDungeon, index: number, change: (record: RoomRecord) => RoomRecord): ZoneDungeon =>
  ({ ...dungeon, rooms: dungeon.rooms.map((record, at) => (at === index ? change(record) : record)) })

/**
 * A door or zone transition while it plays, on the run clock: the beat and when it ends. Through a door the hero
 * travels out of `side` of room `from` into room `to`; through the gate, into zone `zone`'s start room.
 */
export const Transition = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("None") }),
  z.object({ _tag: z.literal("Door"), side, from: z.int(), to: z.int(), beat: z.enum(BEATS.door), until: deadline }),
  z.object({ _tag: z.literal("Zone"), side, from: z.int(), zone: z.enum(zoneIds), beat: z.enum(BEATS.zone), until: deadline })
]))("Game/Transition")
export type TransitionValue = Descriptor.Descriptor.Value<typeof Transition>
