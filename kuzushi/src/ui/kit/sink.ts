import type { Container, FederatedPointerEvent } from "pixi.js"

import { el } from "../dom.ts"
import { makeModal } from "../screen.ts"
import type { Modal } from "../screen.ts"

export interface Sink extends Modal {
  /** Reads `text` out to a screen reader: what is highlighted or opened on a screen it cannot see. */
  announce(text: string): void
  /** Releases the keyboard and takes the sink out of the page. */
  dispose(): void
}

/**
 * The keyboard's home for a Pixi screen: a hidden modal element that holds focus while the screen is up, so keys reach
 * `onKey` and never the game (ritmo's Keyboard leaves keys inside `[aria-modal="true"]` to the page). Key repeats are
 * ignored, as on the DOM screens, and Tab is held so focus can't leave. It also carries the screen's label and a live
 * region for screen readers.
 */
export const createSink = (parent: HTMLElement, label: string, onKey: (event: KeyboardEvent) => boolean): Sink => {
  const live = el("p")
  live.setAttribute("aria-live", "polite")
  const element = el("div", "k-sink", live)
  parent.append(element)
  const modal = makeModal(element, label, onKey)
  // Focus never tabs out: on the page's body, keys would reach the game (Enter would start a run from the title).
  element.addEventListener("keydown", (event) => {
    if (event.code === "Tab") event.preventDefault()
  })
  return {
    ...modal,
    announce: (text) => {
      live.textContent = text
    },
    dispose: () => {
      modal.release()
      element.remove()
    }
  }
}

/**
 * Makes `node` swallow presses: Pixi's canvas listener runs in the capture phase, before ritmo's, so the game never
 * sees a press on a modal screen and the canvas never takes focus from its sink. Its owner sets a full-screen
 * `hitArea` in layout, or presses on the screen's empty parts fall through.
 */
export const blockPointer = (node: Container): void => {
  node.eventMode = "static"
  node.on("pointerdown", (event: FederatedPointerEvent) => {
    const native = event.nativeEvent
    if (native instanceof Event) {
      native.preventDefault()
      native.stopImmediatePropagation()
    }
  })
}
