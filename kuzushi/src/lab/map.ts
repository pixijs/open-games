import { hex, paletteOf } from "../art/palette.ts"
import { ROOM_KINDS, zoneOf } from "../sim/index.ts"
import type { RoomState } from "../sim/index.ts"
import { el } from "../ui/dom.ts"
import { ticks } from "../ui/panel.ts"
import { neighbour, templateName } from "./dungeons.ts"
import type { Plan } from "./dungeons.ts"

/** A cell's size and the gap between cells (where the door links sit), in pixels. */
const CELL = { width: 74, height: 44, gap: 14 } as const

export interface MapMarks {
  /** The room the player is in, or null when the run is elsewhere. */
  readonly current: number | null
  /** The room the panel acts on. */
  readonly selected: number
  /** What the run's map knows of each room (fog), by index; every room shows when left out. */
  readonly states?: ReadonlyArray<RoomState>
}

export interface LabMap {
  readonly element: HTMLElement
  /** Draws `plan` (rebuilt only when the plan changes) with the current and selected rooms and the fog marked. */
  show(plan: Plan, marks: MapMarks): void
  hide(): void
}

/**
 * A dungeon's whole plan as the lab's map, framed like the game's panels in the corner left of the dock: each room a
 * cell with its kind, depth, waves and template, a link across each door, the way from the start to the boss in the
 * zone's accent, the player's room in paper and the picked room bracketed. Clicking a room picks it.
 */
export const createLabMap = (pick: (index: number) => void): LabMap => {
  const title = el("span", "k-lab-map-title")
  const seed = el("span", "k-lab-map-seed")
  const grid = el("div", "k-lab-map-grid")
  const legend = el("footer", "k-lab-map-foot",
    el("span", "k-lab-map-key is-path", "Path to boss"),
    el("span", "k-lab-map-key is-current", "Player"),
    el("span", "k-lab-map-key is-selected", "Picked"))
  const element = el("section", "k-panel k-lab-map", el("header", "k-lab-map-head", el("i", "k-panel-mark"), title, el("span", "k-panel-rule"), seed), grid, legend)
  element.insertAdjacentHTML("afterbegin", ticks)
  element.hidden = true
  let shown: Plan | null = null
  let cells: ReadonlyArray<HTMLElement> = []

  const build = (plan: Plan) => {
    const columns = plan.rooms.map((room) => room.column)
    const rows = plan.rooms.map((room) => room.row)
    const left = Math.min(...columns)
    const top = Math.min(...rows)
    const at = (column: number, row: number) => ({ x: (column - left) * (CELL.width + CELL.gap), y: (row - top) * (CELL.height + CELL.gap) })
    grid.style.width = `${(Math.max(...columns) - left + 1) * (CELL.width + CELL.gap) - CELL.gap}px`
    grid.style.height = `${(Math.max(...rows) - top + 1) * (CELL.height + CELL.gap) - CELL.gap}px`
    const onPath = new Set(plan.path)
    const links = plan.rooms.flatMap((room, index) => (plan.exits[index] ?? []).flatMap((side) => {
      if (side !== "east" && side !== "south") return []
      const from = at(room.column, room.row)
      const link = el("i", `k-lab-map-link is-${side}`)
      const next = plan.path.indexOf(index)
      const other = neighbour(plan.rooms, index, side)
      if (next >= 0 && other !== undefined && onPath.has(other) && Math.abs(plan.path.indexOf(other) - next) === 1) link.classList.add("is-path")
      link.style.left = `${side === "east" ? from.x + CELL.width : from.x + CELL.width / 2 - 1}px`
      link.style.top = `${side === "east" ? from.y + CELL.height / 2 - 1 : from.y + CELL.height}px`
      return [link]
    }))
    cells = plan.rooms.map((room, index) => {
      const spot = at(room.column, room.row)
      const waves = room.waves.length
      const cell = el("button", `k-lab-map-cell is-${room.kind}`,
        el("span", "k-lab-map-kind", room.cache ? "Cache" : ROOM_KINDS[room.kind].name),
        el("span", "k-lab-map-meta", `${index} · d${room.depth}${waves > 0 ? ` · ${waves}w` : ""}`),
        el("span", "k-lab-map-tpl", templateName(room.template)))
      cell.type = "button"
      cell.classList.toggle("is-path", onPath.has(index))
      cell.style.left = `${spot.x}px`
      cell.style.top = `${spot.y}px`
      cell.addEventListener("click", () => {
        pick(index)
        cell.blur()
      })
      return cell
    })
    grid.replaceChildren(...links, ...cells)
    const zone = zoneOf(plan.zone)
    title.textContent = `Zone ${zone.number} · ${zone.name} ${zone.kanji}`
    seed.textContent = `Seed ${plan.seed}`
    element.style.setProperty("--accent", hex(paletteOf(plan.zone).danger))
  }

  return {
    element,
    show: (plan, marks) => {
      if (shown !== plan) {
        shown = plan
        build(plan)
      }
      element.hidden = false
      cells.forEach((cell, index) => {
        cell.classList.toggle("is-current", marks.current === index)
        cell.classList.toggle("is-selected", marks.selected === index)
        const state = marks.states?.[index]
        cell.classList.toggle("is-fog", state === "hidden")
        cell.classList.toggle("is-seen", state === "seen")
      })
    },
    hide: () => {
      element.hidden = true
    }
  }
}
