import type { DebugApi } from "../host/debug.ts"
import type { FrameTime, HostContext } from "../host/types.ts"
import type { GameView, MomentOf, MomentType, Point, ZoneId } from "../sim/index.ts"
import type { CameraPreset } from "./camera.ts"
import type { LabAction } from "./keys.ts"
import type { Sketch } from "./sketch.ts"
import type { Floor, OptionValue } from "./store.ts"
import type { Timeline } from "./timeline.ts"

export const sceneIds = ["special", "attacks", "gallery", "threats", "bosses", "movement", "zones", "rooms", "dungeon", "doors"] as const
export type SceneId = (typeof sceneIds)[number]

/**
 * A ground circle the lab cameras fit in the frame; `side` is the ground direction (radians) the low side camera
 * stands in. `close` asks for a close-up even on the play camera: the lab films the circle from the play angle.
 */
export interface Framing extends Point {
  readonly radius: number
  readonly side?: number
  readonly close?: boolean
}

/** The screen area the panel and the timeline cover, in CSS pixels, so the lab cameras centre the action beside them. */
export interface Insets {
  readonly right: number
  readonly bottom: number
}

/** One control in a scene's part of the lab panel. The lab gives each a number key, in order (sliders take none). */
export type Control =
  | { readonly kind: "action"; readonly label: string; readonly key?: LabAction; readonly run: () => void }
  | { readonly kind: "toggle"; readonly label: string; readonly key?: LabAction; readonly get: () => boolean; readonly set: (on: boolean) => void }
  | {
    readonly kind: "range"
    readonly label: string
    readonly min: number
    readonly max: number
    readonly step: number
    readonly get: () => number
    readonly set: (value: number) => void
    readonly format: (value: number) => string
  }
  | {
    readonly kind: "choice"
    readonly label: string
    /** Steps to the next option. */
    readonly key?: LabAction
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
    readonly get: () => string
    readonly set: (value: string) => void
  }

export interface Readout {
  readonly label: string
  readonly value: string
  /** Drawn in red: a state worth noticing. */
  readonly hot?: boolean
}

/** A remembered option of a scene, as `LabTools.option` and `SceneStart.option` give it. */
export type OptionOf = <T extends OptionValue>(name: string, initial: T) => Option<Widened<T>>

/** What a scene that starts its own run (a dungeon run rather than the sandbox) gets to start it. */
export interface SceneStart {
  readonly game: DebugApi
  readonly zone: ZoneId
  readonly option: OptionOf
}

/** A remembered option of a scene. */
export interface Option<T extends OptionValue> {
  get(): T
  set(value: T): void
}

/** An option's type from its first value: any number, string or boolean. */
export type Widened<T extends OptionValue> = T extends number ? number : T extends string ? string : boolean

/** The lab's play controls, shared by the panel and the scenes. */
export interface Transport {
  readonly paused: boolean
  pause(on: boolean): void
  /** Advances one fixed step, pausing first. */
  step(): void
  readonly speed: number
  setSpeed(scale: number): void
}

/** What a running scene gets from the lab. */
export interface LabTools {
  readonly game: DebugApi
  readonly context: HostContext
  /** The zone this run is in: its palette, its enemies, its hazard. */
  readonly zone: ZoneId
  /** The floor this run plays on (a room for scenes that start a dungeon run), and the scene's centre on it. */
  readonly floor: Floor | "room"
  readonly anchor: Point
  /** Whether the enemies the scene spawns think for themselves (the lab's AI toggle). */
  readonly ai: boolean
  readonly transport: Transport
  readonly timeline: Timeline
  /** The DOM layer over the canvas and under the panel, for labels pinned to the ground. */
  readonly layer: HTMLElement
  readonly option: OptionOf
  /** Calls `handler` for each moment of `type` while this run lasts: the lab unsubscribes when it stops the run. */
  on<T extends MomentType>(type: T, handler: (moment: MomentOf<T>) => void): void
  /** Moves the scene to `zone` and starts it again there. */
  setZone(zone: ZoneId): void
  /** Where the lab cameras look. */
  frame(framing: Framing): void
  /** A ground point (lifted by `y`) on screen, or null behind the camera. */
  toScreen(x: number, z: number, y?: number): { readonly x: number; readonly y: number } | null
  /** How much of the screen the docked panel (right) and the timeline (bottom) cover, in pixels. */
  insets(): Insets
  /** Starts the scene again on a fresh run. */
  replay(): void
}

/** A scene while it runs. */
export interface SceneRun {
  readonly controls: ReadonlyArray<Control>
  /** Every drawn frame, with this frame's view. */
  update(view: GameView, frame: FrameTime): void
  readouts(view: GameView): ReadonlyArray<Readout>
  /** Draws the scene's own marks (ranges, ghosts, markers) on this frame's overlay. */
  draw?(sketch: Sketch, view: GameView): void
  dispose?(): void
}

export interface Scene {
  readonly id: SceneId
  readonly title: string
  /** One line saying what the scene shows. */
  readonly summary: string
  /** What the lab switches to when the scene opens; the enemy AI always starts off. */
  readonly defaults: { readonly invulnerable: boolean; readonly camera: CameraPreset }
  /** Whether the scene spawns enemies that the AI toggle changes. */
  readonly usesAi: boolean
  /**
   * Starts the scene's own run, a room of a dungeon run, instead of the sandbox (the measuring grid, or its zone's
   * classic arena, as the floor control picks). A scene that has one plays in that room and has no floor control.
   */
  start?(setup: SceneStart): void
  create(tools: LabTools): SceneRun
}
