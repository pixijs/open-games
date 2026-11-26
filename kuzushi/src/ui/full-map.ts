import { gsap } from "gsap"
import { Container, Graphics, Rectangle } from "pixi.js"
import type { Text } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { bossOf, zoneOf } from "../sim/index.ts"
import type { GameView, ZoneId } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import type { PanelBody } from "./kit/sheet.ts"
import { inlineWidth, lineHeightOf, onBaseline, ownedFaces, placeInLine, textIn } from "./kit/type.ts"
import { boundsOf, createMapDrawing, FULL, mapCell, mapKey, MINI } from "./map.ts"
import type { Box, CellState, DrawnCell } from "./map.ts"
import { drawn } from "./motion.ts"
import type { RoomMark } from "./room-icons.ts"

/** Space round the rooms inside the map's frame, in px. */
const PAD = 14
/** The frame round the rooms: its least height, its padding inside its 1 px border, and the gaps above and below it, px. */
const FRAME = { min: 180, pad: 4, above: 12, below: 14 } as const
/** The legend's rule to its rows, a swatch to its name, and the gaps between columns and rows, px. */
const LEGEND = { top: 12, swatch: 10, column: 16, row: 8 } as const

interface LegendRow {
  readonly state: CellState
  readonly mark: RoomMark | null
  readonly label: string
}

/** The legend's rows for `zone`: the hero, the rooms' states, and the marks its dungeon has. */
const legendOf = (zone: ZoneId): ReadonlyArray<LegendRow> => {
  const info = zoneOf(zone)
  const marks: ReadonlyArray<readonly [RoomMark, string]> = [
    ["start", "Start"],
    ["weapon", "Altar"],
    ["spring", "Spring"],
    ["cache", "Cache"],
    ...(info.number > 1 ? [["elite", "Elite"] as const] : []),
    ["boss", bossOf(info.boss).name],
    ...(info.next === null ? [] : [["gate", "Gate"] as const])
  ]
  return [
    { state: "current", mark: null, label: "You" },
    { state: "cleared", mark: null, label: "Cleared" },
    { state: "seen", mark: null, label: "Seen" },
    ...marks.map(([mark, label]) => ({ state: "seen" as const, mark, label }))
  ]
}

export interface FullMap {
  readonly body: PanelBody
  /** Draws what changed since the last draw; true when it did, so its owner lays the body out again. */
  draw(): boolean
  /** How wide the body would be with room to spare: the widest of its zone row, its map in its frame and its legend. */
  natural(): number
  tint(accent: Accent): void
}

/**
 * The whole zone's map: its number, name and kanji over every room found so far at twice the minimap's size in a
 * frame, and a legend of the icons with their names in three columns (a minimap-sized swatch each). Pause's Map shows
 * it in a panel; Tab (held) or M (toggled) shows it over play (`over`, in a lighter frame). A map too wide for its
 * frame shrinks to fit. Its layout reports its height through the node's `boundsArea`.
 */
export const createFullMap = (read: () => GameView, options: { readonly over?: boolean } = {}): FullMap => {
  const node = new Container({ label: "full-map" })
  const faces = ownedFaces()
  const numberStyle = faces.style({ family: "condensed", weight: "600", size: 13, tracking: 0.12 })
  const nameStyle = faces.style({ family: "condensed", weight: "500", size: 13, tracking: 0.36 })
  const kanjiStyle = faces.style({ family: "jp", size: 20, tracking: 0.04 })
  const legendStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.3 })
  const noneStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.34 })

  let accent = accentOf("courtyard")
  const number = textIn("", numberStyle, accent.accent)
  const name = textIn("", nameStyle, PALETTE.paper)
  const kanji = textIn("", kanjiStyle, accent.accent)
  const frame = new Graphics()
  const mapSlot = new Container()
  const drawing = createMapDrawing(FULL)
  mapSlot.addChild(drawing.node)
  const rule = new Graphics()
  const legend = new Container({ label: "legend" })
  const none = textIn("SANDBOX: NO ROOMS TO MAP", noneStyle, PALETTE.concrete300)
  const filled = [number, name, kanji, frame, mapSlot, rule, legend]
  node.addChild(...filled, none)

  let key = ""
  let zone: ZoneId | null = null
  let empty = true
  let box: Box = { x: 0, y: 0, width: 0, height: 0 }
  let cells: ReadonlyArray<DrawnCell> = []
  let entries: ReadonlyArray<{ readonly swatch: Container; readonly label: Text }> = []
  let legendBosses: ReadonlyArray<Container> = []

  const buildLegend = (next: ZoneId) => {
    for (const old of legend.removeChildren()) old.destroy({ children: true })
    const bosses: Array<Container> = []
    entries = legendOf(next).map((row) => {
      const swatch = mapCell(MINI, row.state, 0, 0, row.mark, next)
      if (swatch.boss !== null) {
        swatch.boss.tint = accent.accent
        bosses.push(swatch.boss)
      }
      const label = textIn(row.label.toUpperCase(), legendStyle, PALETTE.concrete300)
      legend.addChild(swatch.node, label)
      return { swatch: swatch.node, label }
    })
    legendBosses = bosses
  }

  const draw = () => {
    const view = read()
    const map = view.map
    if (map === null) {
      if (empty) return false
      empty = true
      key = ""
      return true
    }
    let changed = empty
    empty = false
    if (map.zone !== zone) {
      zone = map.zone
      const info = zoneOf(map.zone)
      number.text = `ZONE ${info.number}`
      name.text = info.name.toUpperCase()
      kanji.text = info.kanji
      buildLegend(map.zone)
      changed = true
    }
    const next = mapKey(map, view.room)
    if (next === key) return changed
    key = next
    box = boundsOf(map, FULL)
    gsap.killTweensOf([drawing.doors, ...cells.map((each) => each.cell), ...cells.map((each) => each.cell.scale)])
    cells = drawing.draw(map, view.room)
    for (const { cell, centre } of cells) {
      cell.pivot.set(centre.x, centre.y)
      cell.position.set(centre.x, centre.y)
    }
    drawing.doors.alpha = 1
    return true
  }

  const intro = () => {
    const bodies = cells.map((each) => each.cell)
    return gsap.timeline()
      .fromTo(bodies, { alpha: 0 }, { alpha: 1, duration: 0.2, ease: drawn(0.2, "back.out(2)"), stagger: 0.025 }, 0)
      .fromTo(bodies.map((each) => each.scale), { x: 0.6, y: 0.6 }, { x: 1, y: 1, duration: 0.2, ease: drawn(0.2, "back.out(2)"), stagger: 0.025 }, 0)
      .fromTo(drawing.doors, { alpha: 0 }, { alpha: 1, duration: 0.2 }, 0.1)
  }

  const swatchRun = (label: Text) => MINI.width + LEGEND.swatch + inlineWidth(label)

  const body: PanelBody = {
    node,
    refresh: () => {
      key = ""
      draw()
      intro()
    },
    key: () => false,
    layout: (width) => {
      for (const each of filled) each.visible = !empty
      none.visible = empty
      if (empty) {
        placeInLine(none, 0, 0)
        node.boundsArea = new Rectangle(0, 0, width, lineHeightOf(noneStyle))
        return
      }
      number.x = 0
      name.x = Math.round(inlineWidth(number) + 12)
      kanji.x = Math.round(width - inlineWidth(kanji))
      const gridTop = Math.round(onBaseline(0, [number, name, kanji]) + FRAME.above)

      const inset = 1 + FRAME.pad
      const mapWidth = box.width + 2 * PAD
      const mapHeight = box.height + 2 * PAD
      const fit = Math.min(1, (width - 2 * inset) / Math.max(1, mapWidth))
      const gridHeight = Math.round(Math.max(FRAME.min, mapHeight * fit + 2 * inset))
      frame.clear().rect(0, gridTop, width, gridHeight)
        .fill({ color: PALETTE.ink, alpha: options.over === true ? 0.3 : 0.45 })
        .stroke({ width: 1, color: PALETTE.paper, alpha: 0.1, alignment: 1 })
      mapSlot.scale.set(fit)
      mapSlot.position.set(Math.round((width - mapWidth * fit) / 2), Math.round(gridTop + (gridHeight - mapHeight * fit) / 2))
      drawing.node.position.set(PAD - box.x, PAD - box.y)

      const ruleY = gridTop + gridHeight + FRAME.below
      rule.clear().rect(0, ruleY, width, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
      const rowsTop = ruleY + 1 + LEGEND.top
      const column = (width - 2 * LEGEND.column) / 3
      entries.forEach(({ swatch, label }, index) => {
        const x = Math.round((index % 3) * (column + LEGEND.column))
        const y = rowsTop + Math.floor(index / 3) * (MINI.height + LEGEND.row)
        swatch.position.set(x, y)
        placeInLine(label, x + MINI.width + LEGEND.swatch, y + (MINI.height - lineHeightOf(legendStyle)) / 2)
      })
      const rows = Math.ceil(entries.length / 3)
      node.boundsArea = new Rectangle(0, 0, width, rowsTop + rows * MINI.height + (rows - 1) * LEGEND.row)
    }
  }

  node.once("destroyed", () => {
    gsap.killTweensOf([drawing.doors, ...cells.map((each) => each.cell), ...cells.map((each) => each.cell.scale)])
    faces.release()
  })

  return {
    body,
    draw,
    natural: () => {
      if (empty) return Math.ceil(inlineWidth(none))
      const row = inlineWidth(number) + 12 + inlineWidth(name) + 12 + inlineWidth(kanji)
      const map = box.width + 2 * PAD + 2 * (1 + FRAME.pad)
      const columns = 3 * Math.max(...entries.map((each) => swatchRun(each.label))) + 2 * LEGEND.column
      return Math.ceil(Math.max(row, map, columns))
    },
    tint: (next) => {
      accent = next
      number.tint = next.accent
      kanji.tint = next.accent
      drawing.tint(next)
      for (const boss of legendBosses) boss.tint = next.accent
    }
  }
}
