import type { Container3D, Pass3D, View3D } from "@pixi/3d"
import type { Application, Container } from "pixi.js"

import type { FrameControls } from "../art/frame.ts"
import type { Ground } from "../art/ground.ts"
import type { CameraRig } from "../camera/rig.ts"
import type { WarmupStep } from "../gpu/warmup.ts"
import type { ArenaLayout, DartView, EnemyView, GameView, Intent, MomentOf, MomentType, PlayerView, ProjectileView, RoomKind, StageId, ZoneId } from "../sim/index.ts"

export type { WarmupStep }

/** Timing of one drawn frame. */
export interface FrameTime {
  /** Real seconds since the previous drawn frame; 0 while the game is frozen for a still. */
  readonly dt: number
  /** Real seconds since loading ended (since the host started, while loading), frozen time excluded. */
  readonly elapsed: number
  /** How fast game time runs this frame: 1, the slow-motion scale, or 0 in hit-stop, the special's freeze, pause, menus or a still. */
  readonly gameScale: number
  /** `dt * gameScale`: seconds of game time this frame. */
  readonly gameDt: number
  /** Game seconds since loading ended (the sum of `gameDt`). */
  readonly gameElapsed: number
}

/** The simulation's moments, delivered once per drawn frame in the order they happened. */
export interface MomentBus {
  /** Calls `handler` for each moment of `type`, at the start of the frame, before any install's `update`. Returns an unsubscribe. */
  on<T extends MomentType>(type: T, handler: (moment: MomentOf<T>) => void): () => void
}

/** Requests to the simulation. Every one is validated there; nothing here changes the world directly. */
export interface IntentApi {
  /** Starts a run of The Courtyard's dungeon with `seed` from any screen; `wave` 0 starts its sandbox (its classic arena, no fights) instead. */
  start(wave?: number, seed?: number): void
  /** Starts a run of `stage`'s zone (its dungeon) with `seed` from any screen; `wave` 0 starts its sandbox instead. */
  startStage(stage: StageId, wave?: number, seed?: number): void
  /** Starts a run in `zone` (its start room, or `room` by index or the first of a kind) with `seed`, from any screen; with no seed, the debug API's `setSeed` if it was called, else a fresh one. */
  startZone(zone: ZoneId, room?: number | RoomKind, seed?: number): void
  pause(): void
  resume(): void
  /** A fresh run (a new seed) the way the last began: the zone it started in, its dungeon or its sandbox; from pause or the results. */
  restart(): void
  /** Back to the title, from pause or the results. */
  quit(): void
  send(intent: Intent): void
}

/** The latest world projection, read once per frame. */
export interface GameReader {
  /** This frame's view of the world. */
  view(): GameView
  /**
   * The floor the player is on: the current room's layout (mirrored, its doorways open, locked or closed), or the
   * zone's classic arena in the sandbox; its bounding box (`halfWidth`, `halfDepth`), shape, props and spawn points.
   * `OPEN_FLOOR` (no props) while a debug scene has swapped it in.
   */
  readonly arena: ArenaLayout
}

/** The scene's layers, bottom to top. */
export interface SceneLayers {
  /** The arena and its dressing (look). */
  readonly world: Container3D
  /** Actor visuals, one per entity, made by `createActorVisual` from src/look and placed by the render systems. */
  readonly actors: Container3D
  /** Transient 3D effects (vfx). */
  readonly effects: Container3D
  /** Pixi 2D drawn over the 3D view: screen-space effects such as speed lines and impact frames (vfx). */
  readonly screen: Container
  /** Pixi 2D UI over the 3D view and vfx's screen layer, ungraded: every UI screen. It takes the pointer only while a modal screen is up. */
  readonly ui: Container
}

/** One actor's latest view, by role. */
export type ActorView =
  | { readonly role: "player"; readonly player: PlayerView }
  | { readonly role: "enemy"; readonly enemy: EnemyView }
  | { readonly role: "orb"; readonly orb: ProjectileView }
  | { readonly role: "dart"; readonly dart: DartView }

/** What src/look makes for each entity; the render systems create, place, update and destroy it. */
export interface ActorVisual {
  readonly node: Container3D
  /** Every drawn frame: the position blended between gameplay steps, and the facing (simulation radians). */
  place(x: number, z: number, facing: number): void
  /** Every drawn frame, after `place`: the actor's latest view. */
  update(actor: ActorView, frame: FrameTime): void
  /** The entity is gone: release what this visual owns and take its node out of the scene. */
  destroy(): void
}

/** The post-processing passes of the view, composed from named layers so look and vfx never overwrite each other. */
export interface PostStack {
  /** Sets one layer's passes; the view runs look's, then vfx's. */
  set(layer: "look" | "vfx", passes: ReadonlyArray<Pass3D>): void
}

/** What every install gets. */
export interface HostContext {
  readonly app: Application
  readonly view: View3D
  readonly layers: SceneLayers
  /** The DOM overlay above the canvas, for the UI's keyboard sinks and the lab's DOM panels. `pointer-events: none` except on what the lab makes interactive. */
  readonly overlay: HTMLElement
  readonly rig: CameraRig
  readonly game: GameReader
  readonly moments: MomentBus
  readonly intents: IntentApi
  readonly post: PostStack
  /** Whole-frame looks (impact frames, flashes, focus blur): vfx sets them, look's grade pass draws them. */
  readonly frame: FrameControls
  /** The floor on screen: look's world sets it, effects that must read on it check it. */
  readonly ground: Ground
  /** The visual drawn for an entity id this frame, if it has one. */
  actor(id: number): ActorVisual | undefined
  /** The current frame's timing. */
  readonly time: FrameTime
  /**
   * True while loading draws every install's warm steps under the loader: the title and the camera hold at t = 0 and
   * the game's keys are held. It turns false for the title's first frame, still under the loader.
   */
  readonly loading: boolean
  /**
   * Resolves once loading has drawn every warm step and the title's first frame, as the loader starts to lift: the UI
   * enters the title then, so its intro plays in view, and the debug API lands.
   */
  readonly loaded: Promise<void>
}

/** What an install returns: work for every drawn frame, and teardown. */
export interface Installed {
  update(frame: FrameTime): void
  dispose(): void
  /**
   * What loading uploads and draws once before play, so nothing compiles or uploads on first use. Called once, after
   * every install, in install order.
   */
  warm?(): Iterable<WarmupStep>
}

export type Install = (context: HostContext) => Installed | Promise<Installed>
