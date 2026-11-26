import { Container, Graphics, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { SIDE_DIRS } from "../sim/index.ts"
import type { MapRoomView, MapView, RoomView, Side, ZoneId } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { blurSprite } from "./kit/glow.ts"
import { markOf, roomIcon } from "./room-icons.ts"
import type { RoomMark } from "./room-icons.ts"

/** A map's cell size, the gap between cells, and its icons' size, in px. */
export interface MapGrid {
  readonly width: number
  readonly height: number
  readonly gap: number
  readonly icon: number
}

/** The HUD's minimap and the full map (docs/DESIGN.md, The map). */
export const MINI: MapGrid = { width: 22, height: 14, gap: 4, icon: 9 }
export const FULL: MapGrid = { width: 44, height: 28, gap: 8, icon: 17 }

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type Point = readonly [x: number, y: number]

const cellAt = (grid: MapGrid, column: number, row: number) => ({ x: column * (grid.width + grid.gap), y: row * (grid.height + grid.gap) })

/** A room's centre on the map, in px. */
export const centreOf = (grid: MapGrid, room: Pick<MapRoomView, "column" | "row">): { readonly x: number; readonly y: number } => {
  const cell = cellAt(grid, room.column, room.row)
  return { x: cell.x + grid.width / 2, y: cell.y + grid.height / 2 }
}

const entered = (map: MapView, room: MapRoomView) => room.index === map.current || room.state === "visited" || room.state === "cleared"

/** The rooms the map shows: every one that isn't hidden. */
const shown = (map: MapView) => map.rooms.filter((room) => room.state !== "hidden")

/** The box round every room the map shows, in px. */
export const boundsOf = (map: MapView, grid: MapGrid): Box => {
  const rooms = shown(map)
  const columns = rooms.map((room) => room.column)
  const rows = rooms.map((room) => room.row)
  const from = cellAt(grid, Math.min(...columns), Math.min(...rows))
  const to = cellAt(grid, Math.max(...columns), Math.max(...rows))
  return { x: from.x, y: from.y, width: to.x - from.x + grid.width, height: to.y - from.y + grid.height }
}

/** The side of the current room its zone gate opens on, once open. */
const gateOf = (map: MapView, room: RoomView | null): Side | null =>
  room !== null && room.index === map.current ? room.doors.find((door) => door.mark === "gate")?.side ?? null : null

const sealedOf = (map: MapView, room: RoomView | null) =>
  room !== null && room.index === map.current && room.doors.some((door) => door.state === "locked")

/** Changes whenever the map would draw differently: the zone, where the hero is, what is known of each room, the seals and the gate. */
export const mapKey = (map: MapView, room: RoomView | null): string =>
  `${map.zone}|${map.current}|${map.rooms.map((each) => each.state[0]).join("")}|${sealedOf(map, room) ? 1 : 0}|${gateOf(map, room) ?? "-"}`

/** A door: a line across the gap between two rooms, a short seal across it while locked, and the gate's arrowhead. */
interface DoorShape {
  readonly line: readonly [Point, Point]
  readonly seal: readonly [Point, Point] | null
  readonly arrow: readonly [Point, Point, Point] | null
  readonly gate: boolean
}

export type CellState = "seen" | "visited" | "cleared" | "current"

interface CellShape {
  readonly index: number
  readonly state: CellState
  /** Its top-left, in px. */
  readonly x: number
  readonly y: number
  readonly centre: { readonly x: number; readonly y: number }
  readonly mark: RoomMark | null
}

/** The hero's arrowhead, pointing up, inside a cell centred on (x, y). */
const heroOf = (x: number, y: number, size: number): ReadonlyArray<Point> => {
  const h = size / 2
  return [[x, y - h], [x + h * 0.78, y + h], [x, y + h * 0.5], [x - h * 0.78, y + h]]
}

const heroSize = (grid: MapGrid) => Math.min(grid.height * 0.72, grid.icon * 1.1)

const doorOf = (grid: MapGrid, from: MapRoomView, side: Side, locked: boolean, gate: boolean): DoorShape => {
  const centre = centreOf(grid, from)
  const step = SIDE_DIRS[side]
  const half = { x: grid.width / 2, y: grid.height / 2 }
  const reach = gate ? grid.gap * 2.5 : grid.gap
  const x1 = centre.x + step.x * half.x
  const y1 = centre.y + step.z * half.y
  const x2 = x1 + step.x * reach
  const y2 = y1 + step.z * reach
  const seal = grid.gap * 0.9 + 2
  const mid: Point = [(x1 + x2) / 2, (y1 + y2) / 2]
  return {
    line: [[x1, y1], [x2, y2]],
    seal: locked ? [[mid[0] - step.z * seal, mid[1] - step.x * seal], [mid[0] + step.z * seal, mid[1] + step.x * seal]] : null,
    arrow: gate ? [[x2 - step.x * 3 - step.z * 3, y2 - step.z * 3 - step.x * 3], [x2, y2], [x2 - step.x * 3 + step.z * 3, y2 - step.z * 3 + step.x * 3]] : null,
    gate
  }
}

/** What the map draws, in px from the grid's top-left: the doors between rooms the hero has entered (and an open gate) and every room not hidden. */
const shapesOf = (map: MapView, room: RoomView | null, grid: MapGrid) => {
  const rooms = shown(map)
  const byCell = new Map(map.rooms.map((each) => [`${each.column},${each.row}`, each]))
  const sealed = sealedOf(map, room)
  const gate = gateOf(map, room)
  const current = map.rooms[map.current]
  const doors = rooms.flatMap((from) => from.exits.flatMap((side) => {
    if (side !== "east" && side !== "south") return []
    const step = SIDE_DIRS[side]
    const to = byCell.get(`${from.column + step.x},${from.row + step.z}`)
    if (to === undefined || to.state === "hidden" || (!entered(map, from) && !entered(map, to))) return []
    const locked = sealed && (from.index === map.current || to.index === map.current)
    return [doorOf(grid, from, side, locked, false)]
  }))
  if (gate !== null && current !== undefined) doors.push(doorOf(grid, current, gate, false, true))
  const cells = rooms.map((each): CellShape => ({
    index: each.index,
    state: each.index === map.current ? "current" : each.state === "hidden" ? "seen" : each.state,
    ...cellAt(grid, each.column, each.row),
    centre: centreOf(grid, each),
    mark: markOf(each)
  }))
  return { doors, cells }
}

/** Each state's rect: its fill and its 1 px outline, if any. */
const CELL_LOOK: Record<CellState, { readonly fill: number; readonly fillAlpha: number; readonly line: number }> = {
  seen: { fill: PALETTE.paper, fillAlpha: 0.05, line: 0.42 },
  visited: { fill: PALETTE.ink, fillAlpha: 1, line: 0.4 },
  cleared: { fill: PALETTE.ink, fillAlpha: 1, line: 1 },
  current: { fill: PALETTE.paper, fillAlpha: 1, line: 0 }
}

/** Puts a line `width` px wide on whole pixels, as SVG's crisp edges drew it: an odd width's middle on a pixel's centre. */
const crisp = (value: number, width: number) => (width % 2 === 1 ? Math.floor(value) + 0.5 : Math.round(value))

/** The current cell's glow: its blur's deviation, px, and the room it takes round the rect. */
const GLOW_BLUR = 5
const GLOW = 3 * GLOW_BLUR

/** The current cell's soft paper glow, the SVG's drop-shadow: its rect blurred, drawn from `GLOW` up and left of it. */
const cellGlow = (grid: MapGrid, ready?: () => void) => {
  const box = { x: -GLOW, y: -GLOW, width: grid.width - 1 + 2 * GLOW, height: grid.height - 1 + 2 * GLOW }
  const glow = blurSprite(`<rect width="${grid.width - 1}" height="${grid.height - 1}"/>`, box, GLOW_BLUR, { width: 2 * box.width, height: 2 * box.height }, `map-cell ${grid.width}x${grid.height}`, ready)
  glow.tint = PALETTE.paper
  glow.alpha = 0.55
  return glow
}

/**
 * A room's cell at `grid`'s size with its top-left at (x, y), as the map draws `state`: its rect, and the hero's
 * arrowhead on the current room or `mark`'s icon (`boss` is that icon, for its owner to tint; null without one). The
 * full map's legend draws its swatches with it. `ready` hears when a glow in it that waited for its texture lands.
 */
export const mapCell = (grid: MapGrid, state: CellState, x: number, y: number, mark: RoomMark | null, zone: ZoneId, ready?: () => void): { readonly node: Container; readonly boss: Container | null } => {
  const node = new Container()
  const look = CELL_LOOK[state]
  const rect = new Graphics()
  const centre = { x: x + grid.width / 2, y: y + grid.height / 2 }
  if (state === "current") {
    const glow = cellGlow(grid, ready)
    glow.position.set(x + 1 - GLOW, y + 1 - GLOW)
    rect.rect(x + 1, y + 1, grid.width - 1, grid.height - 1).fill(look.fill)
    const hero = new SmoothGraphics().poly(heroOf(centre.x, centre.y, heroSize(grid)).flat()).fill(PALETTE.ink)
    node.addChild(glow, rect, hero)
    return { node, boss: null }
  }
  rect.rect(x + 0.5, y + 0.5, grid.width - 1, grid.height - 1)
    .fill({ color: look.fill, alpha: look.fillAlpha })
    .stroke({ width: 1, color: PALETTE.paper, alpha: look.line })
  node.addChild(rect)
  if (mark === null) return { node, boss: null }
  const icon = roomIcon(mark, zone, grid.icon, ready)
  icon.position.set(centre.x - grid.icon / 2, centre.y - grid.icon / 2)
  if (state === "seen") icon.alpha = 0.8
  node.addChild(icon)
  return { node, boss: mark === "boss" ? icon : null }
}

/** A room's cell as drawn, for its owner to fade or scale about `centre`. */
export interface DrawnCell {
  readonly index: number
  readonly cell: Container
  readonly centre: { readonly x: number; readonly y: number }
}

export interface MapDrawing {
  readonly node: Container
  /** The doors, seals and gate, under the cells. */
  readonly doors: Container
  /** Draws `map` again from scratch, returning each room's cell so its owner can fade them. */
  draw(map: MapView, room: RoomView | null): ReadonlyArray<DrawnCell>
  tint(accent: Accent): void
}

/**
 * The map in Pixi, at `grid`'s px from its top-left: every room not hidden as the design draws its state (a seen room
 * an outline, a cleared one ink with a paper outline, the current one paper with the hero's arrowhead), marked rooms'
 * icons, and under them the doors between rooms the hero has entered, seals while the room is locked, and an open
 * gate. Each room's cell is a Container (for fades). Rects and door lines are aliased on half pixels, as the SVG's
 * crisp edges; the current cell's glow is its rect blurred. It redraws only when its owner calls `draw`; `ready` hears
 * when a glow drawn without its texture gets it, for an owner that caches the map.
 */
export const createMapDrawing = (grid: MapGrid, ready?: () => void): MapDrawing => {
  const node = new Container({ label: "map" })
  const doorLayer = new Container({ label: "map-doors" })
  const doors = new Graphics()
  doors.alpha = 0.72
  doors.tint = PALETTE.paper
  /** Locked doors, their seals and the gate, drawn white for the accent's tint. */
  const marked = new Container()
  const gateGlow = new SmoothGraphics()
  gateGlow.alpha = 0.35
  const accentLines = new Graphics()
  const gateLines = new SmoothGraphics()
  marked.addChild(gateGlow, accentLines, gateLines)
  doorLayer.addChild(doors, marked)
  const cells = new Container()
  node.addChild(doorLayer, cells)
  let accent = accentOf("courtyard")
  let bosses: Array<Container> = []

  /** A straight line across or down, on whole pixels. */
  const line = (g: Graphics, [[x1, y1], [x2, y2]]: readonly [Point, Point], width: number) => {
    const down = x1 === x2
    g.moveTo(down ? crisp(x1, width) : x1, down ? y1 : crisp(y1, width))
      .lineTo(down ? crisp(x2, width) : x2, down ? y2 : crisp(y2, width))
      .stroke({ width, color: 0xffffff })
  }

  return {
    node,
    doors: doorLayer,
    draw: (map, room) => {
      const shapes = shapesOf(map, room, grid)
      doors.clear()
      accentLines.clear()
      gateLines.clear()
      gateGlow.clear()
      for (const door of shapes.doors) {
        if (door.gate) {
          gateGlow.moveTo(...door.line[0]).lineTo(...door.line[1]).stroke({ width: 4, color: 0xffffff, cap: "round" })
          gateLines.moveTo(...door.line[0]).lineTo(...door.line[1]).stroke({ width: 1.5, color: 0xffffff })
          if (door.arrow !== null) gateLines.poly(door.arrow.flat(), false).stroke({ width: 1.5, color: 0xffffff })
          continue
        }
        if (door.seal === null) {
          line(doors, door.line, 1)
          continue
        }
        line(accentLines, door.line, 1)
        line(accentLines, door.seal, 2)
      }
      marked.tint = accent.accent
      for (const old of cells.removeChildren()) old.destroy({ children: true })
      bosses = []
      return shapes.cells.map((shape) => {
        const { node: cell, boss } = mapCell(grid, shape.state, shape.x, shape.y, shape.mark, map.zone, ready)
        cell.label = `map-cell ${shape.index}`
        if (boss !== null) {
          boss.tint = accent.accent
          bosses.push(boss)
        }
        cells.addChild(cell)
        return { index: shape.index, cell, centre: shape.centre }
      })
    },
    tint: (next) => {
      accent = next
      marked.tint = next.accent
      for (const boss of bosses) boss.tint = next.accent
    }
  }
}
