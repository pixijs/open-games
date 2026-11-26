import { gsap } from "gsap"
import { clamp } from "math"
import { Container, Graphics, Rectangle } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import type { IntentApi } from "../host/types.ts"
import { ROOM_KINDS, zoneOf } from "../sim/index.ts"
import type { GameView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { formatTime } from "./format.ts"
import { createFullMap } from "./full-map.ts"
import { createCorners } from "./kit/corners.ts"
import type { Drain } from "./kit/drain.ts"
import { blurSprite } from "./kit/glow.ts"
import { createMenu } from "./kit/menu.ts"
import { createPanel } from "./kit/panel.ts"
import { createPlate } from "./kit/plate.ts"
import type { Panel } from "./kit/panel.ts"
import { radialScrim } from "./kit/scrim.ts"
import type { PanelBody } from "./kit/sheet.ts"
import { blockPointer, createSink } from "./kit/sink.ts"
import { baselineOf, inlineWidth, lineBaseline, lineHeightOf, ownedFaces, placeInLine, resize, textIn, tracked } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { drawn, ON_ONES } from "./motion.ts"
import { createControls } from "./panels/controls.ts"
import { createSettings } from "./panels/settings.ts"
import { piece } from "./screen.ts"
import type { StageScreen, Tinted } from "./screen.ts"

/** Where the run is, for pause's footer: the zone, the room's kind and its wave while it fights, or the sandbox. */
const whereOf = (view: GameView) => {
  const zone = `Zone ${zoneOf(view.zone).number}`
  if (view.room === null) return `${zone} · Sandbox`
  const room = ROOM_KINDS[view.room.kind].name
  return view.wave.index > 0 && view.wave.total > 0 && view.wave.phase !== "done" ? `${zone} · ${room} · Wave ${view.wave.index} / ${view.wave.total}` : `${zone} · ${room}`
}

/** The panel's border, its padding inside it, and the gaps between its parts, px. */
const BORDER = 1
const PAD = { top: 28, side: 24, bottom: 20 } as const
const DASH = { width: 28, height: 2, above: 16, below: 20 } as const
const FOOT = { above: 20, rule: 12 } as const
/** The menu reaches this far past the panel's padding on both sides, px. */
const MENU_BLEED = 12
const MENU = { size: 17, tracking: 0.42, row: 42, gap: 2, indent: 20, barX: 0, shift: 12, idle: 0.72 } as const
/** Between the pause panel and a panel it opened, beside it or (narrow) under it, px. */
const SIDE_GAP = { across: 24, down: 16 } as const

interface Side {
  readonly panel: Panel
  readonly body: PanelBody
  /** Its width on a wide screen. */
  readonly width: (viewport: Viewport) => number
}

export interface PauseOptions {
  readonly intents: Pick<IntentApi, "resume" | "restart" | "quit">
  readonly read: () => GameView
  /** Where pause's keyboard sink lives: the DOM overlay's root. */
  readonly overlay: HTMLElement
  /** The scene's grade, shared with the title and the results: pause drains the scene to grey. */
  readonly drain: Drain
}

/**
 * Pause: the world dims and drains of colour behind a framed panel with resume, restart, the map, controls, settings
 * and quit. The map, controls and settings open beside it (under it on a narrow screen), the pair kept centred. The
 * panel holds the keyboard while it is up: Esc closes an open side panel, then resumes; P always resumes. A press
 * anywhere on it never reaches the game.
 */
export const createPause = (options: PauseOptions): StageScreen & Tinted => {
  const { intents, read, overlay, drain } = options
  const node = new Container({ label: "pause" })
  node.visible = false

  const veil = new Container({ label: "pause-veil" })
  /** Ink at .57 over the drained scene: its brightness at .62 under a .3 ink wash. */
  const flat = new Graphics()
  const scrim = radialScrim([[0, PALETTE.ink, 0.2], [1, PALETTE.ink, 0.72]], [0.5, 0.5])
  veil.addChild(flat, scrim.node)
  const row = new Container({ label: "pause-row" })
  node.addChild(veil, row)

  const panel = piece(row, "pause-panel")
  const plate = createPlate()
  const ticks = createCorners({ arm: 12, weight: 1, color: PALETTE.paper, alpha: 0.85 })
  const faces = ownedFaces()
  const titleStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 40, tracking: 0.34 })
  const jpStyle = faces.style({ family: "jp", size: 16, tracking: 0.2 })
  const stageStyle = faces.style({ family: "condensed", weight: "500", size: 10.5, tracking: 0.28 })
  const timeStyle = faces.style({ family: "condensed", weight: "500", size: 10.5, tracking: 0.12 })
  const title = textIn("PAUSED", titleStyle, PALETTE.paper)
  panel.body.addChild(plate.node, ticks.node, title)
  const jp = piece(panel.body, "pause-jp")
  const jpText = textIn("一時停止", jpStyle, PALETTE.concrete300)
  jp.body.addChild(jpText)
  const dash = piece(panel.body, "pause-dash")
  const dashGlow = blurSprite(`<rect width="${DASH.width}" height="${DASH.height}"/>`, { x: -16, y: -16, width: DASH.width + 32, height: DASH.height + 32 }, 5, { width: 2 * (DASH.width + 32), height: 2 * (DASH.height + 32) }, "pause-dash")
  dashGlow.alpha = 0.6
  dash.body.addChild(dashGlow, new Graphics().rect(0, 0, DASH.width, DASH.height).fill(0xffffff))
  const menuSlot = new Container({ label: "pause-menu" })
  const foot = new Container({ label: "pause-foot" })
  const footRule = new Graphics()
  const stage = textIn("", stageStyle, PALETTE.concrete300)
  const time = textIn("", timeStyle, PALETTE.paper)
  foot.addChild(footRule, stage, time)
  panel.body.addChild(menuSlot, foot)

  const sides = new Container({ label: "pause-sides" })
  row.addChild(sides)
  let shown: Side | null = null
  let viewport: Viewport | null = null
  let motion: gsap.core.Timeline | null = null

  /** Where the row rests: shifted left by half the open side panel and its gap, so the pair stays centred; still when stacked. */
  const rowX = () => (shown === null || viewport === null || viewport.narrow ? 0 : -(shown.width(viewport) + SIDE_GAP.across) / 2)
  const centre = () => gsap.to(row, { x: rowX(), duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES), overwrite: true })

  const close = () => {
    if (shown === null) return
    shown.panel.close()
    shown = null
    menu.rest(false)
    place()
    centre()
  }
  const show = (side: Side) => {
    if (shown === side) {
      close()
      return
    }
    shown?.panel.close()
    shown = side
    menu.rest(true)
    side.panel.open()
    place()
    centre()
  }

  const sideOf = (title: string, body: PanelBody, width: Side["width"]): Side => {
    const sidePanel = createPanel({ title, back: close })
    sidePanel.setBody(body)
    sides.addChild(sidePanel.node)
    return { panel: sidePanel, body, width }
  }
  const controlsWidth = (v: Viewport) => clamp(0.32 * v.width, 470, 520)
  const settingsWidth = (v: Viewport) => clamp(0.32 * v.width, 420, 520) + 2 * (BORDER + PAD.side)
  const fullMap = createFullMap(read)
  const settings = createSettings({ compact: true, resized: () => place() })
  // The map's panel is as wide as the widest side panel.
  const map = sideOf("Map", fullMap.body, (v) => Math.max(380, controlsWidth(v), settingsWidth(v)))
  const controls = sideOf("Controls", createControls({ compact: true }), controlsWidth)
  const settingsSide = sideOf("Settings", settings, settingsWidth)
  const all = [map, controls, settingsSide]

  const menu = createMenu([
    { label: "Resume", action: intents.resume },
    { label: "Restart", action: intents.restart },
    { label: "Map", action: () => show(map) },
    { label: "Controls", action: () => show(controls) },
    { label: "Settings", action: () => show(settingsSide) },
    { label: "Quit to title", action: intents.quit }
  ], { weight: "500" })
  menuSlot.addChild(menu.node)

  const sink = createSink(overlay, "Paused", (event) => {
    if (event.code === "KeyP" || (event.code === "Escape" && shown === null)) {
      intents.resume()
      return true
    }
    if (event.code === "Escape") {
      close()
      return true
    }
    return shown === null ? menu.key(event) : shown.body.key(event)
  })
  blockPointer(node)

  /** Lays the pause panel out `width` wide and returns its height. */
  const arrangePanel = (width: number, narrow: boolean) => {
    const inner = width - 2 * (BORDER + PAD.side)
    const left = BORDER + PAD.side
    let y = BORDER + PAD.top
    resize(titleStyle, narrow ? 32 : 40, 0.34)
    // The head sets the title (line-height 1) and the kanji on one baseline.
    const titleLine = Number(titleStyle.fontSize)
    const above = Math.max(lineBaseline(titleStyle, titleLine), lineBaseline(jpStyle))
    const below = Math.max(titleLine - lineBaseline(titleStyle, titleLine), lineHeightOf(jpStyle) - lineBaseline(jpStyle))
    title.position.set(left, Math.round(y + above - baselineOf(titleStyle)))
    jp.slot.position.set(Math.round(left + inner - inlineWidth(jpText)), Math.round(y + above - baselineOf(jpStyle)))
    y += above + below + DASH.above
    dash.slot.position.set(left, Math.round(y))
    y += DASH.height + DASH.below
    menu.layout({ width: inner + 2 * MENU_BLEED, ...MENU })
    menuSlot.position.set(left - MENU_BLEED, Math.round(y))
    const items = menu.items.length
    y += items * MENU.row + (items - 1) * MENU.gap + FOOT.above
    foot.position.set(left, Math.round(y))
    footRule.clear().rect(0, 0, inner, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    placeInLine(stage, 0, 1 + FOOT.rule)
    placeInLine(time, inner - inlineWidth(time), 1 + FOOT.rule)
    const height = Math.round(y + 1 + FOOT.rule + lineHeightOf(stageStyle) + PAD.bottom + BORDER)
    plate.draw(width, height)
    ticks.place(0, 0, width, height)
    panel.body.pivot.set(Math.round(width / 2), Math.round(height / 2))
    return height
  }

  /** Sizes and places the panel and the side panels for the viewport; the row's shift is left to its tween. */
  const place = () => {
    const v = viewport
    if (v === null) return
    const { width: W, height: H, margin: m, narrow } = v
    const width = narrow ? Math.min(380, W - 2 * m) : Math.round(clamp(0.26 * W, 280, 380))
    const height = arrangePanel(width, narrow)
    // Stacked, the side panels take the pause panel's width, or the settings' rows' least width if that is wider.
    const stacked = Math.min(W - 2 * m, Math.max(width, settings.natural() + 2 * (BORDER + PAD.side)))
    const heights = all.map((side) => side.panel.layout(Math.round(narrow ? stacked : side.width(v)), v))
    const x = Math.round((W - width) / 2)
    // Stacked, the column keeps room for the settings panel, or the open one if it is taller.
    const heightOf = (side: Side) => heights[all.indexOf(side)] ?? 0
    const reserved = Math.max(heightOf(settingsSide), shown === null ? 0 : heightOf(shown))
    const y = Math.round(narrow ? Math.max(0, (H - height - SIDE_GAP.down - reserved) / 2) : (H - height) / 2)
    panel.slot.position.set(x + Math.round(width / 2), y + Math.round(height / 2))
    for (const side of all) side.panel.node.position.set(narrow ? x : x + width + SIDE_GAP.across, narrow ? y + height + SIDE_GAP.down : y)
  }

  const tint = (accent: Accent) => {
    dash.body.tint = accent.accent
    menu.tint(accent)
    for (const side of all) side.panel.tint(accent)
    fullMap.tint(accent)
    settings.tint(accent)
  }
  tint(accentOf("courtyard"))

  const moving = () => [veil, panel.body, panel.body.scale, ...ticks.bodies, ...ticks.bodies.map((each) => each.scale), title, jp.body, dash.body.scale, foot, row]

  return {
    node,
    enter: (view) => {
      motion?.kill()
      gsap.killTweensOf(moving())
      stage.text = whereOf(view).toUpperCase()
      time.text = formatTime(view.timer)
      shown = null
      for (const side of all) side.panel.node.visible = false
      fullMap.draw()
      place()
      row.x = 0
      node.visible = true
      node.alpha = 1
      menu.reset()
      sink.focus()
      drain.to({ desaturate: 1 }, 0.3)
      motion = gsap.timeline()
        .fromTo(veil, { alpha: 0 }, { alpha: 1, duration: 0.3, ease: "power2.out" }, 0)
        .fromTo(panel.body, { alpha: 0 }, { alpha: 1, duration: 0.26, ease: drawn(0.26, "expo.out", ON_ONES) }, 0.02)
        .fromTo(panel.body.scale, { x: 1.08, y: 0.04 }, { x: 1, y: 1, duration: 0.26, ease: drawn(0.26, "expo.out", ON_ONES) }, 0.02)
        .add(ticks.pop(2.2, 0.3, drawn(0.3, "power3.out"), 0.03), 0.1)
        .add(tracked(titleStyle, 1.1, 0.34, { duration: 0.5, ease: "expo.out" }), 0.1)
        .fromTo(title, { alpha: 0 }, { alpha: 1, duration: 0.5, ease: "expo.out" }, 0.1)
        .fromTo(jp.body, { alpha: 0, x: 10 }, { alpha: 1, x: 0, duration: 0.4, ease: "power3.out" }, 0.18)
        .fromTo(dash.body.scale, { x: 0 }, { x: 1, duration: 0.25, ease: drawn(0.25, "power3.out") }, 0.2)
        .add(menu.intro(), 0.14)
        .fromTo(foot, { alpha: 0 }, { alpha: 1, duration: 0.3 }, 0.3)
    },
    exit: () => {
      sink.release()
      motion?.kill()
      gsap.killTweensOf([veil, panel.body, panel.body.scale])
      shown?.panel.close()
      shown = null
      motion = gsap.timeline()
        .to(panel.body, { alpha: 0, duration: 0.16, ease: "power3.in" }, 0.06)
        .to(panel.body.scale, { y: 0.04, duration: 0.16, ease: "power3.in" }, 0.06)
        .to(veil, { alpha: 0, duration: 0.24, ease: "power2.in" }, 0.08)
        .add(() => void drain.to({ desaturate: 0 }, 0.24, "power2.in"), 0.08)
        .set(node, { visible: false })
    },
    layout: (next) => {
      viewport = next
      const { width: W, height: H } = next
      flat.clear().rect(0, 0, W, H).fill({ color: PALETTE.ink, alpha: 0.57 })
      scrim.fit(new Rectangle(0, 0, W, H), [(W / 2) * Math.SQRT2, (H / 2) * Math.SQRT2])
      node.hitArea = new Rectangle(0, 0, W, H)
      place()
      gsap.killTweensOf(row)
      row.x = rowX()
    },
    tint,
    dispose: () => {
      motion?.kill()
      gsap.killTweensOf(moving())
      sink.dispose()
      node.destroy({ children: true })
      faces.release()
    }
  }
}
