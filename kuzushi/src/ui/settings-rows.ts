import { clamp } from "math"

import { flashLevels, settings } from "../art/settings.ts"
import type { Settings } from "../art/settings.ts"

export interface Choice<T> {
  readonly label: string
  readonly value: T
}

/** One setting: a 0 to 1 range in steps of `STEP`, or a choice of values. */
export type Row =
  | { readonly kind: "range"; readonly label: string; readonly detail: string; read(): number; write(value: number): void }
  | { readonly kind: "choice"; readonly label: string; readonly detail: string; readonly choices: ReadonlyArray<Choice<string>>; read(): string; write(value: string): void }

const ON_OFF: ReadonlyArray<Choice<string>> = [{ label: "On", value: "on" }, { label: "Off", value: "off" }]
const STEP = 0.1

const toggle = (key: "grain" | "fps") => ({
  read: () => (settings.get()[key] ? "on" : "off"),
  write: (value: string) => settings.set({ [key]: value === "on" } satisfies Partial<Settings>)
})

const fullscreen = {
  read: () => (document.fullscreenElement === null ? "off" : "on"),
  write: (value: string) => {
    const request = value === "on" ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.()
    request?.catch(() => {})
  }
}

/** The settings, saved as they change: screen shake, impact flashes, film grain, the FPS readout, fullscreen and the two volumes. */
export const ROWS: ReadonlyArray<Row> = [
  { kind: "range", label: "Screen shake", detail: "How hard hits, slams and the special kick the camera.", read: () => settings.get().shake, write: (value) => settings.set({ shake: value }) },
  {
    kind: "choice",
    label: "Impact flashes",
    detail: "Full-screen impact frames on big hits. Reduced darkens the frame's edge instead; off removes them.",
    choices: flashLevels.map((level) => ({ label: level, value: level })),
    read: () => settings.get().flashes,
    write: (value) => settings.set({ flashes: flashLevels.find((level) => level === value) ?? "full" })
  },
  { kind: "choice", label: "Film grain", detail: "Moving grain over the picture.", choices: ON_OFF, ...toggle("grain") },
  { kind: "choice", label: "Show FPS", detail: "Frames per second in the bottom-right corner.", choices: ON_OFF, ...toggle("fps") },
  { kind: "choice", label: "Fullscreen", detail: "Fill the screen with the game; Esc leaves fullscreen.", choices: ON_OFF, ...fullscreen },
  { kind: "range", label: "Music", detail: "How loud the music plays.", read: () => settings.get().music, write: (value) => settings.set({ music: value }) },
  { kind: "range", label: "Sound effects", detail: "How loud the fight and the menus sound.", read: () => settings.get().sfx, write: (value) => settings.set({ sfx: value }) }
]

export const percent = (value: number) => `${Math.round(value * 100)}%`

/** A range's value held within 0 to 1 and rounded to a tenth. */
export const snap = (value: number): number => Math.round(clamp(value, 0, 1) * 10) / 10

/** Steps row `index` by one: a range by `STEP` within 0 to 1, a choice to its next or previous value, wrapping. Callers repaint. */
export const change = (index: number, by: -1 | 1): void => {
  const row = ROWS[index]
  if (row === undefined) return
  if (row.kind === "range") row.write(snap(row.read() + by * STEP))
  else {
    const at = row.choices.findIndex((choice) => choice.value === row.read())
    const next = row.choices[(at + by + row.choices.length) % row.choices.length]
    if (next !== undefined) row.write(next.value)
  }
}
