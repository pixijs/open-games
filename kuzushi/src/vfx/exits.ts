import { Container, Sprite } from "pixi.js"

import { paletteOf } from "../art/palette.ts"
import { svgTexture } from "../art/svg.ts"
import type { FrameTime } from "../host/types.ts"
import type { DoorView, GameView } from "../sim/index.ts"
import { SCREEN_TWOS } from "./cues.ts"
import { INK } from "./draw/pen.ts"
import type { Fx } from "./fx.ts"

/**
 * The way out of a cleared room (docs/DESIGN.md, Look: Doors): a small chevron in the zone's accent on the frame's edge
 * for each open door, and the open zone gate, that the frame doesn't show (or that stands under a corner of the HUD),
 * pointing at it from the middle of the frame. They come in on twos a beat after the seals break (or as a cleared room
 * is entered), keep clear of the HUD's corners, bob toward their door on twos, and each goes as its door comes into
 * the frame.
 */

/** How long after the seals break the chevrons come in, in seconds. */
const DELAY = 0.7
/** How far in from the frame's edge a chevron stands, and how far inside it a door must be to count as shown, in px. */
const EDGE = { pad: 34, shown: 70 } as const
/** The HUD's corners, as px from the frame's edges: the column top right, the hearts, FOCUS and weapon bottom left. */
const CORNERS = { topRight: { width: 300, height: 300 }, bottomLeft: { width: 580, height: 150 } } as const
/** A chevron's size on screen, in px. */
const SIZE = 30

/** Two chevrons pointing right, the near one bolder, paper with an ink rim; tinted, the paper takes the accent. */
const CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <g stroke="${INK}" stroke-width="7" stroke-linejoin="round" fill="${INK}"><path d="M30 10 L54 32 L30 54 L22 46 L38 32 L22 18 Z"/><path d="M12 16 L28 32 L12 48 L7 43 L18 32 L7 21 Z"/></g>
  <g fill="#ffffff"><path d="M30 10 L54 32 L30 54 L22 46 L38 32 L22 18 Z"/><path d="M12 16 L28 32 L12 48 L7 43 L18 32 L7 21 Z" fill-opacity="0.65"/></g>
</svg>`

/** The doors a chevron can point at: open, and leading on to a room or into the next zone. */
const exitsOf = (view: GameView): ReadonlyArray<DoorView> =>
  view.room?.doors.filter((door) => door.state === "open" && (door.to !== null || door.mark === "gate")) ?? []

/** Where on the frame's edge a ray from the middle toward (x, y) leaves the inset frame, kept off the HUD's corners. */
const onEdge = (x: number, y: number, width: number, height: number) => {
  const cx = width / 2
  const cy = height / 2
  const dx = x - cx
  const dy = y - cy
  const reachX = cx - EDGE.pad
  const reachY = cy - EDGE.pad
  const scale = Math.min(Math.abs(dx) > 1e-6 ? reachX / Math.abs(dx) : Number.POSITIVE_INFINITY, Math.abs(dy) > 1e-6 ? reachY / Math.abs(dy) : Number.POSITIVE_INFINITY)
  let px = cx + dx * scale
  let py = cy + dy * scale
  const right = px > width - CORNERS.topRight.width && py < CORNERS.topRight.height
  if (right) {
    if (Math.abs(px - (width - EDGE.pad)) < 1) py = CORNERS.topRight.height
    else px = width - CORNERS.topRight.width
  }
  const left = px < CORNERS.bottomLeft.width && py > height - CORNERS.bottomLeft.height
  if (left) {
    if (Math.abs(px - EDGE.pad) < 1) py = height - CORNERS.bottomLeft.height
    else px = CORNERS.bottomLeft.width
  }
  return { x: px, y: py, angle: Math.atan2(dy, dx) }
}

/** Whether a door at screen point (x, y) shows: inside the frame by a margin, and not under one of the HUD's corners. */
const shownAt = (x: number, y: number, width: number, height: number): boolean =>
  x > EDGE.shown && x < width - EDGE.shown && y > EDGE.shown && y < height - EDGE.shown &&
  !(x > width - CORNERS.topRight.width && y < CORNERS.topRight.height) &&
  !(x < CORNERS.bottomLeft.width && y > height - CORNERS.bottomLeft.height)

export interface Exits {
  update(time: FrameTime): void
  clear(): void
  dispose(): void
}

export const installExits = async (fx: Fx): Promise<Exits> => {
  const { context } = fx
  const texture = await svgTexture(CHEVRON, { width: 96, mipmaps: true, label: "vfx-exit-chevron" })
  const root = new Container({ label: "vfx-exits" })
  context.layers.screen.addChild(root)
  const pool: Array<Sprite> = []
  /** When the chevrons may come in: a beat after the seals break, or at once in a room entered cleared. */
  let showAt = Number.POSITIVE_INFINITY

  const offs = [
    context.moments.on("doorsOpened", () => {
      showAt = context.time.elapsed + DELAY
    }),
    context.moments.on("roomSwapped", () => {
      showAt = Number.NEGATIVE_INFINITY
    }),
    context.moments.on("runStarted", () => {
      showAt = Number.NEGATIVE_INFINITY
    })
  ]

  const sprite = (index: number): Sprite => {
    const existing = pool[index]
    if (existing !== undefined) return existing
    const made = new Sprite({ texture, anchor: 0.5 })
    pool.push(made)
    root.addChild(made)
    return made
  }

  const clear = () => {
    for (const each of pool) each.visible = false
  }

  return {
    update: (time) => {
      const view = context.game.view()
      if (view.room === null || view.flow !== "Playing" || view.transition !== null || view.tempo.frozen || view.room.state !== "cleared" || time.elapsed < showAt) {
        clear()
        return
      }
      const { width, height } = context.app.screen
      const drawing = Math.floor(time.elapsed * SCREEN_TWOS)
      const since = Math.floor((time.elapsed - showAt) * SCREEN_TWOS)
      const grow = since < 1 ? 0.4 : since < 2 ? 1.3 : 1
      const accent = paletteOf(view.zone).danger
      let used = 0
      for (const door of exitsOf(view)) {
        const at = context.view.worldToScreen({ x: door.x, y: 0.6, z: door.z })
        if (at === null) continue
        if (shownAt(at.x, at.y, width, height)) continue
        const place = onEdge(at.x, at.y, width, height)
        const chevron = sprite(used)
        used += 1
        const bob = drawing % 2 === 0 ? 0 : 4
        chevron.visible = true
        chevron.tint = accent
        chevron.rotation = place.angle
        chevron.position.set(place.x + Math.cos(place.angle) * bob, place.y + Math.sin(place.angle) * bob)
        chevron.width = chevron.height = SIZE * grow
        chevron.alpha = door.mark === "gate" ? 1 : 0.92
      }
      for (let index = used; index < pool.length; index += 1) {
        const each = pool[index]
        if (each !== undefined) each.visible = false
      }
    },
    clear,
    dispose: () => {
      for (const off of offs) off()
      root.destroy({ children: true })
      texture.destroy(true)
    }
  }
}
