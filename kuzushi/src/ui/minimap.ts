import { gsap } from "gsap"
import { Color, Container, Graphics, Rectangle } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import type { GameView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { createCorners } from "./kit/corners.ts"
import { createLayer, eraseRamp } from "./kit/layer.ts"
import { centreOf, createMapDrawing, mapKey, MINI } from "./map.ts"
import { drawn, ON_ONES, rattle } from "./motion.ts"

/** The window's size in cells: five across, four down, centred on the room the hero is in. */
const COLUMNS = 5
const ROWS = 4
const WIDTH = COLUMNS * MINI.width + (COLUMNS - 1) * MINI.gap
const HEIGHT = ROWS * MINI.height + (ROWS - 1) * MINI.gap
/** The frame's padding round the window, inside its 1 px border. */
const PAD = 8
/** The framed box, px. */
export const MINIMAP_SIZE = { width: WIDTH + 2 * PAD + 2, height: HEIGHT + 2 * PAD + 2 } as const

/** Each axis fades in over its first 14% and out over its last. */
const FADE = [[0, 1], [0.14, 0], [0.86, 0], [1, 1]] as const

const mix = (from: number, to: number, t: number) => {
  const a = new Color(from).toRgb()
  const b = new Color(to).toRgb()
  return new Color({ r: (a.r + (b.r - a.r) * t) * 255, g: (a.g + (b.g - a.g) * t) * 255, b: (a.b + (b.b - a.b) * t) * 255 }).toNumber()
}

export interface Minimap {
  readonly node: Container
  update(view: GameView): void
  reset(): void
  tint(accent: Accent): void
  dispose(): void
}

/**
 * The HUD's minimap, top right: a framed window of 5 × 4 cells centred on the hero's room, fading out at its edges.
 * A move to another room slides the map under the window and inks the new cell in; rooms that come into view draw
 * in; the doors go to the accent as the room locks and the frame rattles. The map and its fades are drawn into a Layer
 * whose edges are erased, so it is cached again after each draw and while anything in it moves.
 */
export const createMinimap = (): Minimap => {
  const node = new Container({ label: "minimap" })
  node.boundsArea = new Rectangle(0, 0, MINIMAP_SIZE.width, MINIMAP_SIZE.height)
  const body = new Container()
  const box = { width: MINIMAP_SIZE.width, height: MINIMAP_SIZE.height }
  const plate = new Graphics().rect(0, 0, box.width, box.height).fill({ color: PALETTE.ink, alpha: 0.42 })
  const border = new Graphics().rect(0, 0, box.width, box.height).stroke({ width: 1, color: PALETTE.paper, alpha: 0.18, alignment: 1 })
  const sealBorder = new Graphics().rect(0, 0, box.width, box.height).stroke({ width: 1, color: 0xffffff, alpha: 0.5, alignment: 1 })
  sealBorder.alpha = 0
  const ticks = createCorners({ arm: 8, weight: 1, color: PALETTE.paper, alpha: 0.85 })
  ticks.place(0, 0, box.width, box.height)

  const view = new Container({ label: "minimap-window" })
  view.position.set(PAD + 1, PAD + 1)
  const clip = new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(0xffffff)
  const layer = createLayer("minimap-map")
  /** A fade inside the Layer moved, or a glow in it got its texture, since it was last cached. */
  let dirty = false
  const markDirty = () => {
    dirty = true
  }
  const pan = new Container()
  const drawing = createMapDrawing(MINI, markDirty)
  pan.addChild(drawing.node)
  const area = new Rectangle(0, 0, WIDTH, HEIGHT)
  layer.content.addChild(pan, eraseRamp(area, FADE, "x"), eraseRamp(area, FADE, "y"))
  view.addChild(layer.node, clip)
  view.mask = clip
  body.addChild(plate, border, sealBorder, view, ticks.node)
  node.addChild(body)

  const offset = { x: 0, y: 0 }
  let accent = accentOf("courtyard")
  let key = ""
  let current = -1
  let states = new Map<number, string>()
  let sealed = false
  let cells: ReadonlyArray<{ readonly index: number; readonly cell: Container }> = []

  const place = () => {
    pan.position.set(Math.round(offset.x * 10) / 10, Math.round(offset.y * 10) / 10)
    layer.refresh()
  }

  const corners = { t: 1 }
  const paintCorners = () => ticks.tint(mix(accent.accent, PALETTE.paper, corners.t))

  const update = (game: GameView) => {
    if (dirty) {
      dirty = false
      layer.refresh()
    }
    const map = game.map
    node.visible = map !== null
    if (map === null) {
      key = ""
      current = -1
      return
    }
    const next = mapKey(map, game.room)
    if (next === key) return
    const first = key === "" || !key.startsWith(`${map.zone}|`)
    key = next
    gsap.killTweensOf(cells.map((each) => each.cell))
    cells = drawing.draw(map, game.room)
    const here = map.rooms[map.current]
    const centre = here === undefined ? { x: 0, y: 0 } : centreOf(MINI, here)
    const target = { x: WIDTH / 2 - centre.x, y: HEIGHT / 2 - centre.y }
    gsap.killTweensOf(offset)
    if (first || current < 0) {
      offset.x = target.x
      offset.y = target.y
    } else if (map.current !== current) {
      gsap.to(offset, { x: target.x, y: target.y, duration: 0.34, ease: drawn(0.34, "power3.inOut"), onUpdate: place })
    }

    const fresh = cells.filter((each) => !first && (states.get(each.index) ?? "hidden") === "hidden").map((each) => each.cell)
    if (fresh.length > 0) gsap.fromTo(fresh, { alpha: 0 }, { alpha: 1, duration: 0.3, ease: drawn(0.3, "power2.out"), stagger: 0.06, delay: 0.2, onUpdate: markDirty })
    const arrived = cells.find((each) => each.index === map.current)
    if (!first && arrived !== undefined && map.current !== current) {
      gsap.fromTo(arrived.cell, { alpha: 0.2 }, { alpha: 1, duration: 0.3, ease: drawn(0.3, "power2.out", ON_ONES), delay: 0.12, onUpdate: markDirty })
    }

    const locked = game.room?.doors.some((door) => door.state === "locked") ?? false
    const scales = ticks.bodies.map((each) => each.scale)
    if (!first && locked && !sealed) {
      rattle(body, 4, 0.3)
      gsap.killTweensOf([...scales, corners])
      gsap.fromTo(scales, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.5, ease: drawn(0.5, "power3.out") })
      gsap.fromTo(corners, { t: 0 }, { t: 1, duration: 0.5, ease: drawn(0.5, "power3.out"), onUpdate: paintCorners })
    }
    if (!first && !locked && sealed) gsap.fromTo(scales, { x: 1.6, y: 1.6 }, { x: 1, y: 1, duration: 0.4, ease: drawn(0.4, "back.out(3)") })
    if (locked !== sealed) {
      gsap.to(sealBorder, { alpha: locked ? 1 : 0, duration: 0.3, overwrite: true })
      gsap.to(border, { alpha: locked ? 0 : 1, duration: 0.3, overwrite: true })
    }
    sealed = locked
    current = map.current
    states = new Map(map.rooms.map((room) => [room.index, room.state]))
    place()
  }

  return {
    node,
    update,
    reset: () => {
      key = ""
      current = -1
      states = new Map()
      sealed = false
      gsap.killTweensOf([sealBorder, border])
      sealBorder.alpha = 0
      border.alpha = 1
    },
    tint: (next) => {
      accent = next
      drawing.tint(next)
      sealBorder.tint = next.accent
      paintCorners()
      layer.refresh()
    },
    dispose: () => {
      gsap.killTweensOf([body, offset, corners, sealBorder, border, ...ticks.bodies.map((each) => each.scale), ...cells.map((each) => each.cell)])
      node.destroy({ children: true })
    }
  }
}
