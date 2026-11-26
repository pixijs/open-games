/**
 * What the lab remembers between visits, in localStorage: its view toggles and each scene's own options (its zone and
 * floor among them). Every read and write is guarded, so blocked storage just keeps the defaults for the session.
 */

/** The floor a sandbox scene plays on: the open floor with its measuring grid, or its zone's classic arena. */
export const floors = ["grid", "arena"] as const
export type Floor = (typeof floors)[number]

export type OptionValue = number | string | boolean

export interface LabStore {
  readonly hitboxes: boolean
  readonly hud: boolean
  readonly post: boolean
  readonly collapsed: boolean
  /** Each scene's options, keyed `scene.option`. */
  readonly options: Readonly<Record<string, OptionValue>>
}

const KEY = "kuzushi.lab.v2"

const DEFAULTS: LabStore = { hitboxes: true, hud: false, post: true, collapsed: false, options: {} }

const isOption = (value: unknown): value is OptionValue => typeof value === "number" || typeof value === "string" || typeof value === "boolean"

const parse = (raw: string | null): LabStore => {
  if (raw === null) return DEFAULTS
  try {
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== "object" || stored === null) return DEFAULTS
    const read = (key: string): unknown => (stored as Record<string, unknown>)[key]
    const flag = (key: "hitboxes" | "hud" | "post" | "collapsed") => {
      const value = read(key)
      return typeof value === "boolean" ? value : DEFAULTS[key]
    }
    const options = read("options")
    return {
      hitboxes: flag("hitboxes"),
      hud: flag("hud"),
      post: flag("post"),
      collapsed: flag("collapsed"),
      options: typeof options === "object" && options !== null
        ? Object.fromEntries(Object.entries(options).filter((entry): entry is [string, OptionValue] => isOption(entry[1])))
        : {}
    }
  } catch {
    return DEFAULTS
  }
}

export const loadLab = (): LabStore => {
  try {
    return parse(globalThis.localStorage?.getItem(KEY) ?? null)
  } catch {
    return DEFAULTS
  }
}

export const saveLab = (store: LabStore): void => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(store))
  } catch {
    // Storage full or blocked: the lab still works for this session.
  }
}
