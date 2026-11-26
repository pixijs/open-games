/**
 * What the title menu tells the title's 3D scene, so the scene answers the menu: a nudge when the highlight moves,
 * a reframe when a panel opens beside the menu, and the hero's dash when a zone is chosen. main.ts makes one
 * channel and hands it to the UI (which sends) and the title scene (which listens).
 */
export type TitleCue =
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "panel"; readonly open: boolean }
  | { readonly type: "launch" }

export interface TitleCues {
  send(cue: TitleCue): void
  /** Returns the unsubscribe. */
  on(listener: (cue: TitleCue) => void): () => void
}

/** Under this CSS width the title stacks: its UI covers the screen and the title scene centres its subject. */
export const NARROW_WIDTH = 760

/** Seconds from choosing a zone to the run starting: the hero dashes off while the menu cuts away. */
export const LAUNCH_SECONDS = 0.42

export const makeTitleCues = (): TitleCues => {
  const listeners = new Set<(cue: TitleCue) => void>()
  return {
    send: (cue) => {
      for (const listener of listeners) listener(cue)
    },
    on: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}
