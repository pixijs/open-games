import { Container, Graphics, Sprite } from "pixi.js"
import type { Texture } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { settings } from "../art/settings.ts"
import type { FlashLevel } from "../art/settings.ts"
import type { PaletteName } from "../art/palette.ts"
import type { Rng } from "./draw/pen.ts"

/** How much of a full-screen strobe each impact-flash setting lets through. */
const STROBE_SCALE: Readonly<Record<FlashLevel, number>> = { full: 1, reduced: 0.25, off: 0 }

/**
 * The effects drawn flat over the 3D view: a strobe, a vignette pulse, cinema bars, radial focus lines round a
 * point and brush slashes across the frame. Everything is driven per drawing by the special and the impacts.
 */
export class Screen {
  readonly root = new Container({ label: "vfx-screen" })
  private readonly strobe = new Graphics()
  private readonly pulse: Sprite
  private readonly bars = new Graphics()
  private readonly focus: Sprite
  private readonly slashes: Array<Sprite>
  private width = 1
  private height = 1
  private barAmount = 0
  private inked = false
  private focusColor: PaletteName = "paper"
  /** The zone's own colours for the Courtyard's red and ink: this layer is drawn after the grade, so it takes them here. */
  private zone: { readonly red: number; readonly ink: number } = { red: PALETTE.red, ink: PALETTE.ink }

  constructor(private readonly focusTextures: ReadonlyArray<Texture>, slashTextures: ReadonlyArray<Texture>, vignette: Texture) {
    this.focus = new Sprite({ texture: focusTextures[0], anchor: 0.5, visible: false })
    this.slashes = slashTextures.map((texture) => new Sprite({ texture, anchor: { x: 0, y: 0.5 }, visible: false }))
    this.pulse = new Sprite({ texture: vignette, visible: false })
    this.strobe.visible = false
    this.root.addChild(this.focus, ...this.slashes, this.pulse, this.strobe, this.bars)
  }

  /** Draws what asks for red in the zone's accent and its ink in the zone's ink, the way the grade repaints the frame. */
  setZoneColors(red: number, ink: number): void {
    if (red === this.zone.red && ink === this.zone.ink) return
    this.zone = { red, ink }
    this.drawBars()
  }

  private colorOf(name: PaletteName): number {
    if (name === "red" || name === "redDeep") return this.zone.red
    if (name === "ink") return this.zone.ink
    return PALETTE[name]
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.strobe.clear().rect(0, 0, width, height).fill(0xffffff)
    this.pulse.setSize(width, height)
    this.drawBars()
  }

  /** A flat colour over everything at `alpha`, softened or dropped by the impact-flash setting; 0 hides it. */
  setStrobe(color: PaletteName, alpha: number): void {
    const shown = alpha * STROBE_SCALE[settings.get().flashes]
    this.strobe.visible = shown > 0
    this.strobe.tint = this.colorOf(color)
    this.strobe.alpha = shown
  }

  /** A vignette closing round the frame's edge at `alpha`, darkest at the edge; 0 hides it. */
  setPulse(color: PaletteName, alpha: number): void {
    this.pulse.visible = alpha > 0
    this.pulse.tint = this.colorOf(color)
    this.pulse.alpha = alpha
  }

  /** Cinema bars, 0 (gone) to 1 (a tenth of the height each). */
  setBars(amount: number): void {
    if (amount === this.barAmount) return
    this.barAmount = amount
    this.drawBars()
  }

  /** One drawing of the focus lines round screen point (x, y), or hidden at alpha 0. */
  setFocus(drawing: number, x: number, y: number, color: PaletteName, alpha: number, spread: number, rng: Rng): void {
    this.focus.visible = alpha > 0
    if (!this.focus.visible) return
    const texture = this.focusTextures[drawing % this.focusTextures.length]
    if (texture !== undefined) this.focus.texture = texture
    this.focus.position.set(x, y)
    this.focus.rotation = rng() * Math.PI * 2
    const reach = Math.hypot(Math.max(x, this.width - x), Math.max(y, this.height - y))
    this.focus.width = this.focus.height = reach * 2 * spread
    this.focusColor = color
    this.focus.tint = this.colorOf(this.inked ? "ink" : color)
    this.focus.alpha = alpha
  }

  hideFocus(): void {
    this.focus.visible = false
  }

  /** Brush slash `index` across the frame through (x, y) at `angle`, revealed to `reveal` (0 to 1) of its length. */
  setSlash(index: number, x: number, y: number, angle: number, reveal: number): void {
    const slash = this.slashes[index]
    if (slash === undefined) return
    slash.visible = reveal > 0
    if (!slash.visible) return
    const length = Math.hypot(this.width, this.height) * 0.95
    const cx = (x + this.width / 2) / 2
    const cy = (y + this.height / 2) / 2
    slash.rotation = angle
    slash.position.set(cx - Math.cos(angle) * length * 0.5, cy - Math.sin(angle) * length * 0.5)
    slash.width = length * reveal
    slash.height = Math.max(60, this.height * 0.17)
  }

  /** Inks the flat effects for an impact frame, so they flip with the picture under them. */
  setInked(inked: boolean): void {
    if (inked === this.inked) return
    this.inked = inked
    this.focus.tint = this.colorOf(inked ? "ink" : this.focusColor)
    for (const slash of this.slashes) slash.tint = inked ? this.zone.ink : 0xffffff
  }

  clear(): void {
    this.setStrobe("paper", 0)
    this.setPulse("ink", 0)
    this.setBars(0)
    this.hideFocus()
    for (const slash of this.slashes) slash.visible = false
  }

  private drawBars(): void {
    const bar = (this.height * 0.1) * this.barAmount
    this.bars.clear()
    if (bar <= 0) return
    this.bars.rect(0, 0, this.width, bar).rect(0, this.height - bar, this.width, bar).fill(this.zone.ink)
    this.bars.rect(0, bar - 1, this.width, 1).rect(0, this.height - bar, this.width, 1).fill({ color: PALETTE.paper, alpha: 0.35 })
  }
}
