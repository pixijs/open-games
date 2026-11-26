/**
 * Which option of a menu is highlighted. A menu opens on its first option and ignores the pointer until it has
 * moved: a menu that appears under a resting cursor (the player was aiming there) keeps its safe first choice.
 */
export interface Cursor {
  readonly active: number
  /** True once the pointer has moved since the menu opened. */
  readonly armed: boolean
}

export const opened: Cursor = { active: 0, armed: false }

/** The pointer is over option `index`, having moved by (dx, dy) pixels since its last event. */
export const pointed = (cursor: Cursor, index: number, dx: number, dy: number): Cursor => {
  if (!cursor.armed && dx === 0 && dy === 0) return cursor
  return { active: index, armed: true }
}

/** Moves the highlight `by` options, wrapping round `count`. */
export const stepped = (cursor: Cursor, by: number, count: number): Cursor =>
  ({ ...cursor, active: (cursor.active + by + count) % count })

const BACK = new Set(["ArrowUp", "KeyW", "ArrowLeft", "KeyA"])
const FORWARD = new Set(["ArrowDown", "KeyS", "ArrowRight", "KeyD"])
const CHOOSE = new Set(["Enter", "NumpadEnter", "Space", "KeyJ"])

/** What key `code` does in a menu: move the highlight, choose it, or nothing. */
export const keyAction = (code: string): { readonly move: -1 | 1 } | "choose" | null =>
  BACK.has(code) ? { move: -1 } : FORWARD.has(code) ? { move: 1 } : CHOOSE.has(code) ? "choose" : null
