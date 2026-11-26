import { Container, GraphicsContext, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { zoneOf } from "../sim/index.ts"
import type { MapRoomView, RoomKind, ZoneId } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import { enemyShape, shapeMarkup } from "./icons.ts"
import { blurSprite } from "./kit/glow.ts"
import { iconContext } from "./kit/icon.ts"

/** What a map cell or a door's seal can be marked with: a marked room's kind, a cache not yet cleared, or the zone gate. */
export type RoomMark = Exclude<RoomKind, "combat"> | "cache" | "gate"

/**
 * The map's icons in the UI's 1px line style, in a 24-unit box: their lines, and the parts filled solid. The start's
 * is a ring round a doorway; the boss's is its silhouette, solid.
 */
const GLYPHS: Record<Exclude<RoomMark, "boss">, { readonly lines: string; readonly solid?: string }> = {
  start: { lines: `<circle cx="12" cy="12" r="9"/><path d="M8.6 17V11.8Q12 7.6 15.4 11.8V17"/>` },
  elite: { lines: `<path d="M3 19.5 6.6 10.5 10.2 19.5ZM8.4 19.5 12 6 15.6 19.5ZM13.8 19.5 17.4 10.5 21 19.5Z"/>` },
  weapon: { lines: `<path d="M5 14.5h14v6.5H5Z"/><path d="M12 2.5 15.8 6.3 12 10.1 8.2 6.3Z"/>` },
  spring: { lines: `<circle cx="12" cy="12" r="8"/>`, solid: `<circle cx="12" cy="12" r="2.4"/>` },
  cache: { lines: `<path d="M12 2.5 14.2 9.8 21.5 12 14.2 14.2 12 21.5 9.8 14.2 2.5 12 9.8 9.8Z"/>`, solid: `<path d="M12 9.6 14.4 12 12 14.4 9.6 12Z"/>` },
  gate: { lines: `<path d="M5 21V5.5h14V21"/><path d="M9.5 15.5 12 12l2.5 3.5"/>` }
}

/** Solid fills, white with no edge (a glyph's solid parts, a boss's silhouette with its holes), by markup. */
const solids = new Map<string, GraphicsContext>()

const solidContext = (markup: string) => {
  const known = solids.get(markup)
  if (known !== undefined && !known.destroyed) return known
  const context = new GraphicsContext().svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="#fff">${markup}</g></svg>`)
  solids.set(markup, context)
  return context
}

/** The boss icon's glow on screen: its blur's deviation, px. */
const BOSS_GLOW = 3

/**
 * `mark`'s icon drawn `size` px square from its top-left, in paper: its lines 1 px wide whatever its size (the SVG's
 * non-scaling stroke) and its solid parts filled. The boss's is its silhouette filled in `zone`'s accent with no edge,
 * glowing: the node's tint, set again as the accent changes. `ready` hears when its glow, drawn before its texture, gets it.
 */
export const roomIcon = (mark: RoomMark, zone: ZoneId, size: number, ready?: () => void): Container => {
  const node = new Container({ label: `room-icon ${mark}` })
  node.scale.set(size / 24)
  if (mark === "boss") {
    const shape = enemyShape[zoneOf(zone).boss]
    const markup = shapeMarkup(shape)
    const blur = (BOSS_GLOW * 24) / size
    const reach = Math.ceil(3 * blur)
    const box = { x: -reach, y: -reach, width: 24 + 2 * reach, height: 24 + 2 * reach }
    const pixels = Math.ceil((2 * box.width * size) / 24)
    const glow = blurSprite(markup, box, blur, { width: pixels, height: pixels }, `room-boss ${shape} ${size}`, ready)
    glow.alpha = 0.8
    node.addChild(glow, new SmoothGraphics(solidContext(markup)))
    node.tint = accentOf(zone).accent
    return node
  }
  const { lines, solid } = GLYPHS[mark]
  const outline = new SmoothGraphics(iconContext(lines, "outline", 24 / size))
  outline.tint = PALETTE.paper
  node.addChild(outline)
  if (solid !== undefined) {
    const fill = new SmoothGraphics(solidContext(solid))
    fill.tint = PALETTE.paper
    node.addChild(fill)
  }
  return node
}

/** The map's mark for a room: its kind, a cache until it is cleared, or null for a plain combat room. */
export const markOf = (room: Pick<MapRoomView, "kind" | "cache" | "state">): RoomMark | null =>
  room.kind !== "combat" ? room.kind : room.cache && room.state !== "cleared" ? "cache" : null
