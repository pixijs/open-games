import { clamp } from "math"

/**
 * The player's settings, kept in localStorage so they survive a reload. One store for the page: the UI edits it,
 * and look (film grain), vfx (impact flashes), the camera (shake) and audio (the volumes) read it. Every storage read
 * and write is guarded: a private window or blocked storage just keeps the defaults for the session.
 *
 * @example
 * ```ts
 * settings.get().shake                       // 0 to 1
 * settings.set({ flashes: "reduced" })
 * const off = settings.subscribe((values) => grade.setGrain(values.grain))
 * ```
 */

/** How full-screen impact frames and strobes play: in full, swapped for a darkened edge, or not at all. */
export type FlashLevel = "full" | "reduced" | "off"

export const flashLevels = ["full", "reduced", "off"] as const satisfies ReadonlyArray<FlashLevel>

export interface Settings {
  /** Camera shake strength, 0 (none) to 1 (full). */
  readonly shake: number
  readonly flashes: FlashLevel
  /** The grade's moving film grain. */
  readonly grain: boolean
  /** A frames-per-second readout in the corner. */
  readonly fps: boolean
  /** The music's volume, 0 (silent) to 1 (full). */
  readonly music: number
  /** The sound effects' volume (play's and the menus'), 0 (silent) to 1 (full). */
  readonly sfx: number
}

export interface SettingsStore {
  get(): Readonly<Settings>
  set(patch: Partial<Settings>): void
  /** Calls `listener` now and after every change. Returns the unsubscribe. */
  subscribe(listener: (values: Readonly<Settings>) => void): () => void
}

const KEY = "kuzushi.settings.v1"

const prefersCalm = (): boolean => {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  } catch {
    return false
  }
}

const defaults = (): Settings => ({ shake: 1, flashes: prefersCalm() ? "reduced" : "full", grain: true, fps: false, music: 0.8, sfx: 1 })

/** A stored 0 to 1 value, or `fallback` when it isn't a finite number. */
const unit = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : fallback)

/** Keeps only fields of the right type and range from whatever was stored. */
const parse = (raw: string | null, base: Settings): Settings => {
  if (raw === null) return base
  try {
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== "object" || stored === null) return base
    const read = (key: string): unknown => (key in stored ? (stored as Record<string, unknown>)[key] : undefined)
    const shake = read("shake")
    const flashes = read("flashes")
    const grain = read("grain")
    const fps = read("fps")
    return {
      shake: unit(shake, base.shake),
      flashes: flashLevels.find((level) => level === flashes) ?? base.flashes,
      grain: typeof grain === "boolean" ? grain : base.grain,
      fps: typeof fps === "boolean" ? fps : base.fps,
      music: unit(read("music"), base.music),
      sfx: unit(read("sfx"), base.sfx)
    }
  } catch {
    return base
  }
}

const load = (): Settings => {
  try {
    return parse(globalThis.localStorage?.getItem(KEY) ?? null, defaults())
  } catch {
    return defaults()
  }
}

const save = (values: Settings): void => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(values))
  } catch {
    // Storage full or blocked: the settings still apply for this session.
  }
}

const makeSettings = (): SettingsStore => {
  let values = load()
  const listeners = new Set<(values: Readonly<Settings>) => void>()
  const publish = () => {
    for (const listener of listeners) listener(values)
  }
  return {
    get: () => values,
    set: (patch) => {
      values = { ...values, ...patch, shake: unit(patch.shake, values.shake), music: unit(patch.music, values.music), sfx: unit(patch.sfx, values.sfx) }
      save(values)
      publish()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(values)
      return () => void listeners.delete(listener)
    }
  }
}

/** The page's settings. */
export const settings: SettingsStore = makeSettings()
