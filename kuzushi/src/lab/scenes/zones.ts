import { hex, paletteOf } from "../../art/palette.ts"
import type { ZonePalette } from "../../art/palette.ts"
import { isBoss, zoneIds, zoneOf } from "../../sim/index.ts"
import type { RoomKind, ZoneId } from "../../sim/index.ts"
import { el } from "../../ui/dom.ts"
import { roomFraming } from "../camera.ts"
import { oneOf } from "../choose.ts"
import type { Scene } from "../scene.ts"
import { NAMES, NORTH, sealed, sealsToggle, zoneKinds } from "./roster.ts"

const SWATCHES: ReadonlyArray<{ readonly key: keyof ZonePalette; readonly label: string }> = [
  { key: "ink", label: "Ink" },
  { key: "groundDark", label: "Ground dark" },
  { key: "ground", label: "Ground" },
  { key: "groundLight", label: "Ground light" },
  { key: "light", label: "Light" },
  { key: "danger", label: "Danger" },
  { key: "dangerDeep", label: "Danger deep" },
  { key: "paper", label: "Hero" }
]

const ROOMS: ReadonlyArray<{ readonly value: RoomKind; readonly label: string }> = [
  { value: "start", label: "Start" },
  { value: "combat", label: "Combat" },
  { value: "boss", label: "Boss" }
]
const ROOM_VALUES = ROOMS.map((room) => room.value)

/** WCAG relative luminance of a colour. */
const luminance = (color: number): number => {
  const channel = (shift: number) => {
    const value = ((color >> shift) & 0xff) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/** WCAG contrast ratio of two colours. */
const ratio = (a: number, b: number): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/** The three ground values' contrast against `color`, dark to light. */
const against = (palette: ZonePalette, color: number) =>
  [palette.groundDark, palette.ground, palette.groundLight].map((ground) => el("b", "", ratio(color, ground).toFixed(1)))

/** One zone's column on the board: its name, its tokens with their values, and how the hero and danger read on its floors. */
const column = (zone: ZoneId): HTMLElement => {
  const palette = paletteOf(zone)
  const info = zoneOf(zone)
  const node = el("div", "k-lab-zone",
    el("div", "k-lab-zone-name", `${info.number} ${info.name.replace(/^The /, "")}`, el("b", "", info.kanji)),
    el("div", "k-lab-swatches", ...SWATCHES.map((swatch) => {
      const chip = el("i", "")
      chip.style.background = hex(palette[swatch.key])
      return el("div", "k-lab-swatch", chip, el("span", "", swatch.label), el("span", "", hex(palette[swatch.key])))
    })),
    el("div", "k-lab-contrast",
      el("span", "is-head", "Contrast on", el("i", "", "dark"), el("i", "", "mid"), el("i", "", "light")),
      el("span", "", "Hero", ...against(palette, palette.paper)),
      el("span", "", "Danger", ...against(palette, palette.danger)),
      el("span", "", "Danger on ink", el("b", "", ""), el("b", "", ""), el("b", "", ratio(palette.danger, palette.ink).toFixed(1)))))
  node.style.setProperty("--zone", hex(palette.danger))
  return node
}

/**
 * The three zones side by side as palettes (each one's tokens, and the hero's and danger's contrast against its three
 * floor values as WCAG ratios), and the chosen zone's start, combat or boss room in play with its four kinds and its
 * boss standing in it, so each zone's floor, light, hero and danger can be judged on screen against its tokens.
 */
export const zonesScene: Scene = {
  id: "zones",
  title: "Zones",
  summary: "Each zone's palette, a room of it, its enemies standing in it.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  start: ({ game, zone }) => game.startZone(zone, 0, { seed: 1 }),
  create: (tools) => {
    const { game, layer } = tools
    const room = tools.option<string>("room", "start")
    const cast = tools.option("cast", true)
    const board = tools.option("board", true)
    const shown = (): RoomKind => oneOf(ROOM_VALUES, room.get(), "start")
    game.clearRooms()
    if (shown() !== "start") game.enterRoom(shown(), { instant: true })
    let castAt: number | null = null

    const columns = zoneIds.map((zone) => ({ zone, node: column(zone) }))
    const element = el("section", "k-panel k-lab-board is-docked", ...columns.map((each) => each.node))
    layer.append(element)

    /** The zone's four kinds in a row across the room's middle, its boss north of them, all idle. */
    const stand = (depth: number) => {
      const kinds = zoneKinds(tools.zone).filter((kind) => kind !== "splitling")
      const regular = kinds.filter((kind) => !isBoss(kind))
      regular.forEach((kind, index) => game.spawn(kind, (index - (regular.length - 1) / 2) * 3.4, -depth * 0.25, { facing: Math.PI / 2, drill: "idle" }))
      const boss = zoneOf(tools.zone).boss
      game.spawn(boss, 0, -depth * 0.62, { facing: Math.PI / 2, drill: "idle" })
    }

    return {
      controls: [
        { kind: "choice", label: "Room", options: ROOMS, get: shown, set: (value) => {
          room.set(value)
          tools.replay()
        } },
        { kind: "toggle", label: "Enemies", get: cast.get, set: (on) => {
          cast.set(on)
          tools.replay()
        } },
        sealsToggle(tools),
        { kind: "toggle", label: "Palettes", get: board.get, set: board.set }
      ],
      update: (view) => {
        if (view.room !== null) tools.frame(roomFraming(view.room.layout))
        element.hidden = !board.get()
        for (const each of columns) each.node.classList.toggle("is-on", each.zone === tools.zone)
        const ready = view.room !== null && view.room.kind === shown() && view.transition === null
        if (!ready || castAt !== null) return
        castAt = view.tempo.playStep
        const depth = view.room?.layout.halfDepth ?? 8
        game.teleport(0, depth * 0.2, NORTH)
        if (cast.get()) stand(depth)
      },
      readouts: (view) => {
        const zone = zoneOf(tools.zone)
        return [
          { label: "Zone", value: `${zone.number} ${zone.name} ${zone.kanji}` },
          { label: "Room", value: view.room === null ? "-" : `${view.room.kind} · ${view.room.template}` },
          { label: "Hazard", value: zone.hazard === "none" ? "none" : `${zone.hazard}${sealed(view) ? " · live" : " · runs while sealed"}` },
          { label: "Enemies", value: `${zone.roster.map((kind) => NAMES[kind]).join(", ")} · ${NAMES[zone.boss]}` }
        ]
      },
      dispose: () => {
        element.remove()
      }
    }
  }
}
