/** An entry of the title's EXTRAS menu. */
export interface Extra {
  readonly label: string
  /** One line saying what it opens. */
  readonly detail: string
  /**
   * Runs when the player picks it. It usually starts a run (`intents.start(0)` for the sandbox) and sets up its
   * scene; the title leaves on its own once the flow does.
   */
  readonly open: () => void
}

const extras: Array<Extra> = []

/**
 * Adds an entry to EXTRAS, in the order registered; the menu reads the list each time it opens. Returns the
 * unregister.
 *
 * @example
 * ```ts
 * registerExtra({ label: "Special lab", detail: "KUZUSHI against a ring of chasers, on repeat", open: () => lab.open("special") })
 * ```
 */
export const registerExtra = (extra: Extra): (() => void) => {
  extras.push(extra)
  return () => {
    const at = extras.indexOf(extra)
    if (at >= 0) extras.splice(at, 1)
  }
}

/** Every registered extra, in the order registered. */
export const listExtras = (): ReadonlyArray<Extra> => extras

let playUiOff = false

/**
 * Hides what the game's UI keeps over play (the HUD, banners, the boss's bar, the map, altar cards, the FPS readout)
 * until called again with false; a boss's name card and the zone card stay, as parts of the intro and the zone
 * change. The lab turns it off for clean shots of a scene.
 */
export const hidePlayUi = (hidden: boolean): void => {
  playUiOff = hidden
}

export const playUiHidden = (): boolean => playUiOff
