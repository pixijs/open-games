import { gsap } from "gsap"

import { brushStroke, svgPaths } from "./brush.ts"
import { keyAction, opened, pointed, stepped } from "./cursor.ts"
import type { Cursor } from "./cursor.ts"
import { fromMarkup, pick, pickAll } from "./dom.ts"
import { drawn, ON_ONES, rattle } from "./motion.ts"

export interface MenuItem {
  readonly label: string
  /** A second line under the label, for items that need explaining. */
  readonly detail?: string
  /** Runs at once when chosen; the screen's own exit plays while the game reacts. */
  readonly action: () => void
}

export interface MenuOptions {
  /** An extra class on the menu, for its size and type. */
  readonly className?: string
}

export interface Menu {
  readonly element: HTMLElement
  /** The highlighted item. */
  readonly active: number
  /** Puts the highlight on `index` (the first by default) at once. */
  reset(index?: number): void
  /** Arrows and WASD move, Enter, Space and J choose. Returns whether the key was used. */
  key(event: KeyboardEvent): boolean
  /** The items slide in one after another and the bar wipes in under the highlighted one. */
  intro(): gsap.core.Timeline
}

let made = 0

/** The highlight's bar, the choice's slash and its paper core, in 300x40 units; the Pixi menu draws the same strokes. */
export const FILL = brushStroke([[1, 20.5], [90, 19], [190, 20.5], [299, 19.5]], { width: 38, seed: 7, start: 0.97, attack: 0.01, release: 0.05, dry: 0.42, bristles: 12, rough: 0.035, wobble: 0.05 })
export const SLASH = brushStroke([[-6, 31], [120, 22], [306, 9]], { width: 5, seed: 13, start: 0.15, attack: 0.35, release: 0.45, dry: 0.2, bristles: 4, rough: 0.1 })
export const SLASH_CORE = brushStroke([[30, 27], [130, 21], [250, 13]], { width: 1.6, seed: 14, start: 0.1, attack: 0.4, release: 0.5, dry: 0 })

/** Which way each corner bracket sits from the bar's middle: tl, tr, bl, br. */
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const
const cornerX = (index: number) => CORNERS[index]?.[0] ?? 0
const cornerY = (index: number) => CORNERS[index]?.[1] ?? 0

/**
 * The lab's DOM menu (its scene list), the twin of the game's kit/menu: a column of options in wide-tracked caps, the
 * highlighted one on a brush bar in the accent that fades out to the right, inside corner brackets. Moving smears the
 * bar across to the next item and snaps the brackets onto it; choosing slashes across the item. It opens on the first
 * item, and the pointer selects only once it has moved (see `Cursor`), so a menu that appears under a resting mouse
 * keeps its safe first choice. Styled by ui.css.
 */
export const createMenu = (items: ReadonlyArray<MenuItem>, options: MenuOptions = {}): Menu => {
  const id = `k-menu-${made++}`
  const element = fromMarkup(`
<div class="k-menu ${options.className ?? ""}" role="menu">
  <div class="k-menu-bar" aria-hidden="true">
    <svg class="k-menu-fill" viewBox="0 0 300 40" preserveAspectRatio="none">
      <defs><linearGradient id="${id}-fade" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" style="stop-color:var(--accent-fill)"/><stop offset="0.38" style="stop-color:var(--accent-fill);stop-opacity:0.92"/>
        <stop offset="0.72" style="stop-color:var(--accent-deep);stop-opacity:0.55"/><stop offset="1" style="stop-color:var(--accent-deep);stop-opacity:0"/>
      </linearGradient></defs>
      <path fill="url(#${id}-fade)" d="${FILL.ink}"/>
    </svg>
    <i class="k-menu-flash"></i>
    ${["tl", "tr", "bl", "br"].map((corner) => `<i class="k-bracket is-${corner}"></i>`).join("")}
  </div>
  <svg class="k-menu-slash" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
    <g class="k-menu-slash-red">${svgPaths(SLASH.shapes)}</g><g class="k-menu-slash-core">${svgPaths(SLASH_CORE.shapes)}</g>
  </svg>
  ${items.map((item) => `
  <button class="k-option" type="button" role="menuitem" tabindex="-1">
    <span class="k-option-label">${item.label}</span>${item.detail === undefined ? "" : `<span class="k-option-detail">${item.detail}</span>`}
  </button>`).join("")}
</div>`)
  const bar = pick(element, ".k-menu-bar")
  const fill = pick(element, ".k-menu-fill")
  const flash = pick(element, ".k-menu-flash")
  const brackets = pickAll(element, ".k-bracket")
  const slash = pick(element, ".k-menu-slash")
  const buttons = pickAll<HTMLButtonElement>(element, ".k-option")
  const labels = buttons.map((button) => pick(button, ".k-option-label"))

  let cursor: Cursor = opened
  let moving: gsap.core.Timeline | null = null

  const rectOf = (index: number) => {
    const button = buttons[index]
    return button === undefined ? { x: 0, y: 0, w: 0, h: 0 } : { x: button.offsetLeft, y: button.offsetTop, w: button.offsetWidth, h: button.offsetHeight }
  }

  const mark = (index: number) => {
    buttons.forEach((button, at) => button.classList.toggle("is-active", at === index))
  }

  const place = (index: number) => {
    const { x, y, w, h } = rectOf(index)
    gsap.set(bar, { x, y, width: w, height: h, opacity: 1, skewX: 0 })
    gsap.set(fill, { scaleX: 1, scaleY: 1 })
    gsap.set(brackets, { x: 0, y: 0 })
    labels.forEach((label, at) => gsap.set(label, { x: at === index ? 12 : 0 }))
  }

  const moveTo = (next: Cursor) => {
    const from = cursor.active
    cursor = next
    if (next.active === from) return
    mark(next.active)
    const a = rectOf(from)
    const b = rectOf(next.active)
    const left = Math.min(a.x, b.x)
    const top = Math.min(a.y, b.y)
    const toward = Math.sign(b.y - a.y)
    moving?.kill()
    moving = gsap.timeline()
      .set(bar, { x: left, y: top, width: Math.max(a.x + a.w, b.x + b.w) - left, height: Math.max(a.y + a.h, b.y + b.h) - top, opacity: 0.5, skewX: -14 * toward })
      .set(fill, { scaleY: 0.55, scaleX: 1 })
      .set(brackets, { opacity: 0 })
      .set(bar, { x: b.x, y: b.y, width: b.w, height: b.h, opacity: 1, skewX: 0 }, 1 / ON_ONES)
      .fromTo(fill, { scaleX: 0.55, scaleY: 1.3 }, { scaleX: 1, scaleY: 1, duration: 0.25, ease: drawn(0.25, "back.out(2.4)", ON_ONES) }, 1 / ON_ONES)
      .fromTo(brackets, { x: (at: number) => cornerX(at) * 12, y: (at: number) => cornerY(at) * 8, opacity: 0 },
        { x: 0, y: 0, opacity: 1, duration: 0.17, ease: drawn(0.17, "expo.out", ON_ONES), stagger: 0.012 }, 1.5 / ON_ONES)
    const fromLabel = labels[from]
    const toLabel = labels[next.active]
    if (fromLabel !== undefined) gsap.to(fromLabel, { x: 0, duration: 0.2, ease: "power2.out", overwrite: true })
    if (toLabel !== undefined) gsap.fromTo(toLabel, { x: -4 }, { x: 12, duration: 0.3, ease: drawn(0.3, "back.out(3)", ON_ONES), overwrite: true })
  }

  const choose = (index: number) => {
    moveTo({ active: index, armed: true })
    const label = labels[index]
    if (label === undefined) return
    const { x, y, w, h } = rectOf(index)
    gsap.killTweensOf([slash, flash])
    gsap.timeline()
      .set(slash, { x, y: y - h * 0.25, width: w, height: h * 1.5, opacity: 1, clipPath: "inset(0% 100% 0% 0%)" })
      .to(slash, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.1, ease: drawn(0.1, "power3.in", ON_ONES) })
      .set(flash, { opacity: 1 }, 0.1)
      .add(() => buttons[index]?.classList.add("is-struck"), 0.1)
      .set(flash, { opacity: 0 }, 0.1 + 2 / ON_ONES)
      .add(() => buttons[index]?.classList.remove("is-struck"), 0.1 + 2 / ON_ONES)
      .add(rattle(label, 5, 0.22), 0.1)
      .fromTo(brackets, { x: (at: number) => cornerX(at) * 7, y: (at: number) => cornerY(at) * 5 }, { x: 0, y: 0, duration: 0.3, ease: drawn(0.3, "elastic.out(1, 0.5)") }, 0.1)
      .to(slash, { x: x + w * 0.12, opacity: 0, clipPath: "inset(0% 0% 0% 100%)", duration: 0.26, ease: drawn(0.26, "power2.in") }, 0.18)
    items[index]?.action()
  }

  buttons.forEach((button, index) => {
    button.addEventListener("pointermove", (event) => moveTo(pointed(cursor, index, event.movementX, event.movementY)))
    button.addEventListener("pointerdown", (event) => event.preventDefault())
    button.addEventListener("click", () => choose(index))
  })
  new ResizeObserver(() => {
    if (moving === null || !moving.isActive()) place(cursor.active)
  }).observe(element)

  return {
    element,
    get active() {
      return cursor.active
    },
    reset: (index = 0) => {
      moving?.kill()
      cursor = { active: Math.max(0, Math.min(items.length - 1, index)), armed: false }
      mark(cursor.active)
      place(cursor.active)
      gsap.set(brackets, { opacity: 1 })
    },
    key: (event) => {
      const action = keyAction(event.code)
      if (action === null) return false
      if (action === "choose") choose(cursor.active)
      else moveTo(stepped(cursor, action.move, items.length))
      return true
    },
    intro: () => {
      place(cursor.active)
      return gsap.timeline()
        .fromTo(buttons, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.34, ease: drawn(0.34, "expo.out"), stagger: 0.06 })
        .fromTo(fill, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.24, ease: drawn(0.24, "power3.out", ON_ONES) }, 0.05)
        .fromTo(brackets, { opacity: 0, x: (at: number) => cornerX(at) * 16, y: (at: number) => cornerY(at) * 10 }, { opacity: 1, x: 0, y: 0, duration: 0.2, ease: drawn(0.2, "expo.out", ON_ONES), stagger: 0.03 }, 0.15)
    }
  }
}
