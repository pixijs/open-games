import { Keyboard } from "@typeonce/ritmo-browser"
import { gsap } from "gsap"
import { Container } from "pixi.js"

import type { GameView } from "../sim/index.ts"
import { createFullMap } from "./full-map.ts"
import { createPanel } from "./kit/panel.ts"
import type { Viewport } from "./kit/viewport.ts"
import { drawn, ON_ONES } from "./motion.ts"
import type { Staged, Tinted } from "./screen.ts"

/** The map's keys: Tab shows it while held, M turns it on and off. They are the UI's, never the game's. */
const KEYS = {
  hold: [Keyboard.code("Tab")],
  toggle: [Keyboard.code("KeyM")]
} as const

/** The panel's least width, and its border and padding round the map, px. */
const MIN_WIDTH = 420
const FRAME = 2 * (1 + 24)

export interface MapOverlay extends Staged, Tinted {
  /** Whether the map is up over play. */
  readonly open: boolean
  update(view: GameView): void
}

/**
 * The full map over play while Tab is held or after M: the game runs on under it, seen through its translucent ink.
 * It folds open docked on the half of the screen away from the hero (`heroX`, the hero's share of the screen's width
 * from the left): bottom right, or left and centred down the screen. It draws its rooms in, and folds away when let
 * go, on leaving play, or once the zone has no map. It never takes the pointer.
 */
export const createMapOverlay = (read: () => GameView, heroX: () => number | null): MapOverlay => {
  const map = createFullMap(read, { over: true })
  const keyboard = Keyboard.actions(window, KEYS)
  const node = new Container({ label: "map-overlay" })
  node.visible = false
  const slot = new Container()
  const panel = createPanel({ title: "Map", keys: [["Tab", "Hold"], ["M", "Toggle"]], fill: 0.7, plain: true })
  panel.setBody(map.body)
  panel.node.visible = true
  slot.addChild(panel.node)
  node.addChild(slot)

  let toggled = false
  let open = false
  let left = false
  let viewport: Viewport | null = null
  let motion: gsap.core.Timeline | null = null

  /** Sizes the panel to the map and docks it: its bottom-right on the margins, or at the left margin, centred down. */
  const place = () => {
    if (viewport === null) return
    const { width: W, height: H, margin: m } = viewport
    const width = Math.round(Math.max(MIN_WIDTH, Math.min(map.natural() + FRAME, 0.5 * W - m)))
    const height = panel.layout(width, viewport)
    const x = Math.round(left ? m : W - m - width)
    const y = Math.round(left ? (H - height) / 2 : H - m - height)
    const pivot = { x: Math.round(width / 2), y: Math.round(height / 2) }
    slot.position.set(x + pivot.x, y + pivot.y)
    panel.node.pivot.set(pivot.x, pivot.y)
  }

  const show = (on: boolean) => {
    if (on === open) return
    open = on
    motion?.kill()
    if (on) {
      left = (heroX() ?? 0) >= 0.5
      map.body.refresh()
      place()
      node.visible = true
      motion = gsap.timeline()
        .fromTo(panel.node, { alpha: 0 }, { alpha: 1, duration: 0.22, ease: drawn(0.22, "expo.out", ON_ONES) }, 0)
        .fromTo(panel.node.scale, { x: 1.06, y: 0.05 }, { x: 1, y: 1, duration: 0.22, ease: drawn(0.22, "expo.out", ON_ONES) }, 0)
        .add(panel.ticks.pop(2.2, 0.24, drawn(0.24, "power3.out"), 0.03), 0.06)
    } else {
      motion = gsap.timeline()
        .to(panel.node, { alpha: 0, duration: 0.14, ease: "power3.in" }, 0)
        .to(panel.node.scale, { y: 0.05, duration: 0.14, ease: "power3.in" }, 0)
        .set(node, { visible: false })
    }
  }

  return {
    node,
    get open() {
      return open
    },
    update: (view) => {
      const input = keyboard.snapshot().actions
      if (view.flow !== "Playing" || view.map === null) {
        toggled = false
        show(false)
        return
      }
      if (input.toggle.pressed) toggled = !toggled
      if (input.hold.pressed) toggled = false
      show(input.hold.held || toggled)
      if (open && map.draw()) place()
    },
    layout: (next) => {
      viewport = next
      place()
    },
    tint: (accent) => {
      panel.tint(accent)
      map.tint(accent)
    },
    dispose: () => {
      motion?.kill()
      keyboard.dispose()
      node.destroy({ children: true })
    }
  }
}
