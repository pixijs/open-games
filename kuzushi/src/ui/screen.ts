import { Container } from "pixi.js"

import type { GameView } from "../sim/index.ts"
import type { Accent } from "./accent.ts"
import type { Viewport } from "./kit/viewport.ts"

/**
 * What installUi draws in Pixi on `layers.ui`: it lays it out at install and on every resize (nothing on the stage
 * listens for resize itself), and disposes of it with the UI.
 *
 * Layout places slots; motion moves bodies inside them that rest at 0, 0, whole (see `piece`), so the two never fight
 * over a position. Motion conventions:
 * - turn by `angle`, in degrees, rather than `rotation`;
 * - fade with `shown()` when the node should also stop drawing and taking the pointer once hidden;
 * - scale `node.scale` about a pivot, with the position moved to match;
 * - wipe with kit/wipe, and draw brushes on along their spine with kit/ink's `spineReveal`;
 * - tween letter spacing with kit/type's `tracked`;
 * - GSAP can't tween `tint`: tween a proxy and set a Color lerp;
 * - never redraw a Graphics each frame for a value: scale it, mask it, or show figures in kit/digits.
 */
export interface Staged {
  readonly node: Container
  layout(viewport: Viewport): void
  /** Stops its motion, lets go of anything outside the stage (the keyboard, page listeners) and destroys its node. */
  dispose(): void
}

/** A slot placed by layout, holding a body that motion moves (with `children` in it), added to `parent`. */
export const piece = (parent: Container, label: string, ...children: Array<Container>): { readonly slot: Container; readonly body: Container } => {
  const slot = new Container({ label })
  const body = new Container()
  if (children.length > 0) body.addChild(...children)
  slot.addChild(body)
  parent.addChild(slot)
  return { slot, body }
}

/** A piece in the zone's accent: installUi tints it whenever the accent changes (the Courtyard's on the title). */
export interface Tinted {
  tint(accent: Accent): void
}

/** One full-screen state of the UI drawn in Pixi on `layers.ui`, shown while the game is on its flow. */
export interface StageScreen extends Staged {
  enter(view: GameView): void
  exit(): void
}

export interface Modal {
  /** Takes the keyboard: from now on keys go to this screen and the game ignores them. */
  focus(): void
  /** Gives the keyboard back to the game. */
  release(): void
}

/**
 * Makes `element` a modal dialog that owns the keyboard while it has focus. The game's keyboard leaves keys inside
 * a modal to the page, so a menu's Enter never also reaches the game. `onKey` returns whether it used the key.
 */
export const makeModal = (element: HTMLElement, label: string, onKey: (event: KeyboardEvent) => boolean): Modal => {
  element.setAttribute("role", "dialog")
  element.setAttribute("aria-modal", "true")
  element.setAttribute("aria-label", label)
  element.tabIndex = -1
  element.addEventListener("keydown", (event) => {
    if (!event.repeat && onKey(event)) event.preventDefault()
  })
  return {
    focus: () => element.focus({ preventScroll: true }),
    release: () => {
      if (element.contains(document.activeElement)) element.blur()
    }
  }
}
