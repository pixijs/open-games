import type { BaseMaterial3D, Container3D } from "@pixi/3d"
import type { Texture } from "pixi.js"

import type { FrameTime } from "../../host/types.ts"
import { opposite, ZONES } from "../../sim/index.ts"
import type { ArenaLayout, GameView, RoomTemplate, RoomView, Side, TemplateId, ZoneId } from "../../sim/index.ts"
import type { Occluders } from "../occlusion.ts"
import type { Parts } from "../parts.ts"
import type { InkFade, InkOptions } from "../shaders/ink.ts"
import type { LookTextures } from "../textures.ts"
import type { RoomArt } from "./art.ts"
import type { RoomKit } from "./kit.ts"

/** Everything a zone's room builder, its doors and its shrines draw with, for one room. */
export interface RoomBuild {
  readonly zone: ZoneId
  readonly room: RoomView
  readonly id: TemplateId
  readonly template: RoomTemplate
  /** The room's plan as placed: mirrored, its doorways open, locked or closed. */
  readonly layout: ArenaLayout
  readonly parts: Parts
  readonly kit: RoomKit
  readonly art: RoomArt
  readonly textures: LookTextures
  readonly node: Container3D
  /** Where this room's surfaces fade into the dark. */
  readonly fade: InkFade
  /** The room's stone: the ink material in `color`, faded into the dark round this room. */
  ink(color: number, options?: Partial<Omit<InkOptions, "grain" | "color">>): BaseMaterial3D
  /** The side the zone gate opens on in a boss room with a zone after it, open or not yet. */
  readonly gate: Side | null
  /** Whether the room is still on screen (false once disposed), for work that lands late. */
  alive(): boolean
}

/** What a zone's room builder hands back: the solids that hide actors, whether its floor is pale, its life per frame. */
export interface ZoneLook {
  readonly occluders: Occluders
  readonly pale: boolean
  update(view: GameView, frame: FrameTime): void
}

/**
 * The side a boss room's zone gate opens on: opposite the one door it has to another room. Null in any other room and
 * in the last zone's boss room, which has no gate.
 */
export const gateSide = (zone: ZoneId, room: RoomView): Side | null => {
  if (room.kind !== "boss" || ZONES[zone].next === null) return null
  const entry = room.doors.find((door) => door.to !== null)
  return entry === undefined ? null : opposite[entry.side]
}

/** The sides whose wall a doorway breaks: a door to another room, or the zone gate. A side with nothing behind it stays wall. */
export const doorwaysOf = (build: Pick<RoomBuild, "layout" | "gate">): ReadonlySet<Side> =>
  new Set(build.layout.doors.filter((door) => door.state !== "closed" || door.side === build.gate).map((door) => door.side))

/**
 * The rectangle a floor drawing covers, mirrored as the room is: a negative size flips the drawing, so a template's
 * drawing serves both of its mirror images.
 */
export const mirroredSurface = (texture: Texture, x: number, z: number, width: number, depth: number, mirror: RoomView["mirror"]) => ({
  texture,
  x: mirror.x ? x + width : x,
  z: mirror.z ? z + depth : z,
  width: mirror.x ? -width : width,
  depth: mirror.z ? -depth : depth
})

/**
 * Hands the room's floor drawing to `apply` once it lands, when it (or anything else the room draws with) was still
 * being drawn as the room was built (`waiting`), unless the room has gone by then.
 */
export const whenDrawn = (build: Pick<RoomBuild, "art" | "id" | "alive">, waiting: boolean, apply: (floor: Texture) => void): void => {
  if (!waiting) return
  void build.art.ready(build.id).then(() => {
    const floor = build.art.floor(build.id)
    if (build.alive() && floor !== null) apply(floor)
  })
}
