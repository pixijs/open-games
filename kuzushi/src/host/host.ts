import type { View3D } from "@pixi/3d"
import { FixedLoop, Result } from "@typeonce/ritmo"
import { Keyboard, Pointer } from "@typeonce/ritmo-browser"
import { mulberry32 } from "math/random"
import type { Application, Ticker } from "pixi.js"

import { makeFrameControls } from "../art/frame.ts"
import { makeGround } from "../art/ground.ts"
import type { CameraRig } from "../camera/rig.ts"
import { diffCounts, NO_COMPILES } from "../gpu/compiles.ts"
import type { CompileCounts, CompileEvent, CompileWatch } from "../gpu/compiles.ts"
import { afterRender, drained, warmUp } from "../gpu/warmup.ts"
import type { WarmupReport, WarmupStep } from "../gpu/warmup.ts"
import { ActorVisuals, makeActorRegistry, MomentSink, render, RenderClock, updateActors } from "../render/index.ts"
import {
  buttons,
  ControlsInput,
  DEFAULT_SEED,
  Game,
  initialMachines,
  initialResources,
  Intents,
  keys,
  makeControls,
  OPEN_FLOOR,
  PlayTime,
  ReadGame,
  stageOf,
  step,
  update,
  warmPaths
} from "../sim/index.ts"
import type { GameView, Intent } from "../sim/index.ts"
import { makeMouseAim } from "./aim.ts"
import { makeMomentBus } from "./moments.ts"
import { makePostStack } from "./post.ts"
import type { FrameTime, HostContext, Install, Installed, IntentApi, SceneLayers } from "./types.ts"

export interface LoadOptions {
  /** The renderer's compile watch, made before anything drew. */
  readonly watch: CompileWatch
  /** The warm-up's share done, 0 to 1; it never goes back. */
  onProgress?(done: number): void
  /** How a compile after loading is reported: a console warning or error with the program's label, or not at all. */
  readonly lateCompiles?: "warn" | "error"
}

/** What compiled after loading, which should be nothing but after a device or context change, or in the lab. */
export interface LateCompiles {
  readonly sinceLoaded: CompileCounts
  readonly events: ReadonlyArray<CompileEvent>
}

const ReadPlayStep = Game.Inspector("Game/HostPlayStep", { resources: { play: Game.System.readResource(PlayTime) } }, ({ resources }) => resources.play.get().step)

export interface HostOptions {
  readonly app: Application
  readonly view: View3D
  readonly layers: SceneLayers
  readonly overlay: HTMLElement
  readonly rig: CameraRig
}

/** The host's controls for the debug API and the debug scenes: freezing for stills, stepping, slow motion, and the seed of the next run. */
export interface HostControls {
  readonly context: HostContext
  readonly intents: IntentApi
  freeze(on: boolean): void
  readonly frozen: boolean
  /** While frozen: advance `steps` fixed steps (and the visuals by as much) over the next frames. */
  step(steps: number): void
  /** How fast time runs, 1 for real time: the fixed-step loop, the visuals and the camera all slow together. */
  timeScale: number
  /** Whether the pause and confirm keys (Esc, P, Enter) reach the game; the debug scenes take them while open. */
  flowKeys: boolean
  seed: number
  install(install: Install): Promise<void>
  /** Starts the fixed-step loop on pixi's ticker. */
  start(): void
  /**
   * After `start`, under the loader: warms the enemies' paths, draws every install's warm steps, then lets the title
   * start at t = 0 and draws its first frame. Resolves `context.loaded` with the report; a device or context change
   * on the way starts it over.
   */
  load(options: LoadOptions): Promise<WarmupReport>
  /** The finished load's report, or null while loading. */
  readonly loadReport: WarmupReport | null
  /** What compiled after loading (nothing before it ends). */
  compiles(): LateCompiles
}

/**
 * The browser host: the runtime with its live input and render services, the fixed-step loop on pixi's ticker,
 * moments out, intents in, and the per-frame order: render sync (which forwards moments), moment handlers, actor views, installs, camera.
 * While loading it holds the game's keys and the camera, and draws every install's warm steps through those same frames.
 */
export const makeHost = (options: HostOptions): HostControls => {
  const { app, view, layers, overlay, rig } = options
  const registry = makeActorRegistry(layers.actors)
  const renderClock = { alpha: 0 }
  const moments = makeMomentBus()
  const flow = { keys: true }
  let loading = true
  const keyboard = Keyboard.actions(window, keys)
  const quiet = Keyboard.idle(keys)
  const made = Game.Runtime.make({
    services: Game.Runtime.services(
      Game.Runtime.service(ControlsInput, makeControls({
        keyboard: {
          ...keyboard,
          snapshot: () => {
            const snapshot = keyboard.snapshot()
            if (loading) return quiet
            return flow.keys ? snapshot : { ...snapshot, actions: { ...snapshot.actions, pause: quiet.actions.pause, confirm: quiet.actions.confirm } }
          }
        },
        mouse: Pointer.actions(app.canvas, window, buttons)
      })),
      Game.Runtime.service(ActorVisuals, registry),
      Game.Runtime.service(RenderClock, renderClock),
      Game.Runtime.service(MomentSink, moments)
    ),
    resources: initialResources(),
    machines: initialMachines()
  })
  if (!made.ok) throw new Error("The runtime could not start")
  const runtime = made.value
  const installed: Array<Installed> = []

  const send = (intent: Intent) => runtime.send(Intents, intent)
  const seeds = mulberry32.create(Date.now())
  const freshSeed = () => 1 + Math.floor(mulberry32.sample(seeds) * 0x7ffffffe)
  const controls = {
    seed: DEFAULT_SEED,
    /** Whether the debug API set the seed; until it does, every run the menu starts draws its own. */
    seedSet: false,
    frozen: false,
    pending: 0,
    steppedThisFrame: 0,
    timeScale: 1
  }
  const intents: IntentApi = {
    start: (wave = 1, seed = controls.seed) => send({ type: "start", wave, seed }),
    startStage: (stage, wave = 1, seed = controls.seed) => send({ type: "startStage", stage, wave, seed }),
    startZone: (zone, room, seed = controls.seedSet ? controls.seed : freshSeed()) => send({ type: "startZone", zone, room: room ?? null, seed, weapon: null }),
    pause: () => send({ type: "pause" }),
    resume: () => send({ type: "resume" }),
    restart: () => send({ type: "restart" }),
    quit: () => send({ type: "quit" }),
    send
  }

  let latest: GameView = runtime.inspect(ReadGame)
  let lastPlayStep = runtime.inspect(ReadPlayStep)
  let stepsSinceAdvance = 0
  let time: FrameTime = { dt: 0, elapsed: 0, gameScale: 0, gameDt: 0, gameElapsed: 0 }
  let resolveLoaded = () => {}
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve
  })
  /** Set once loading ends: its report, and the compiles since. */
  let done: { readonly report: WarmupReport; readonly watch: CompileWatch; readonly atLoaded: CompileCounts; readonly events: ReadonlyArray<CompileEvent> } | null = null

  const context: HostContext = {
    app,
    view,
    layers,
    overlay,
    rig,
    game: {
      view: () => latest,
      get arena() {
        return latest.debug.openFloor ? OPEN_FLOOR : latest.room?.layout ?? stageOf(latest.zone).layout
      }
    },
    moments: moments.bus,
    intents,
    post: makePostStack(view),
    frame: makeFrameControls(),
    ground: makeGround(),
    actor: (id) => registry.get(id),
    get time() {
      return time
    },
    get loading() {
      return loading
    },
    loaded
  }
  const aim = makeMouseAim(app.canvas, view, intents)

  const fixedStep = () => {
    if (controls.frozen) {
      if (controls.pending <= 0) return Result.success(undefined)
      controls.pending -= 1
      controls.steppedThisFrame += 1
    }
    const ticked = runtime.tick(update)
    if (!ticked.ok) return ticked
    const playStep = runtime.inspect(ReadPlayStep)
    stepsSinceAdvance = playStep === lastPlayStep ? stepsSinceAdvance + 1 : 0
    lastPlayStep = playStep
    return ticked
  }

  const drawFrame = (frame: FixedLoop.Frame) => {
    const dt = controls.frozen ? controls.steppedThisFrame * step.dt : frame.elapsedSeconds
    controls.steppedThisFrame = 0
    latest = runtime.inspect(ReadGame)
    const { tempo } = latest
    const period = 1 / tempo.slowScale
    const alpha = controls.frozen ? 1 : Math.min(1, (stepsSinceAdvance + frame.alpha) / period)
    const gameScale = latest.flow !== "Playing" || tempo.hitStop || tempo.frozen ? 0 : tempo.slowScale
    time = {
      dt,
      elapsed: time.elapsed + dt,
      gameScale,
      gameDt: dt * gameScale,
      gameElapsed: time.gameElapsed + dt * gameScale
    }
    renderClock.alpha = alpha
    const drawn = runtime.tick(render)
    if (!drawn.ok) console.error(drawn.error)
    moments.flush()
    updateActors(registry, latest, time)
    aim.update(latest)
    for (const each of installed) each.update(time)
    // The camera holds while loading, so the title's first frame starts its framing as on a page with no loader.
    rig.update(loading ? 0 : dt)
  }

  const resize = () => rig.setSize(app.screen.width, app.screen.height)
  resize()
  app.renderer.on("resize", resize)

  return {
    context,
    intents,
    get frozen() {
      return controls.frozen
    },
    freeze: (on) => {
      controls.frozen = on
      controls.pending = 0
    },
    step: (steps) => {
      controls.pending += Math.max(0, Math.round(steps))
    },
    get timeScale() {
      return controls.timeScale
    },
    get flowKeys() {
      return flow.keys
    },
    set flowKeys(on: boolean) {
      flow.keys = on
    },
    set timeScale(value: number) {
      controls.timeScale = Math.max(0, value)
    },
    get seed() {
      return controls.seed
    },
    set seed(value: number) {
      controls.seed = value
      controls.seedSet = true
    },
    install: async (install) => {
      installed.push(await install(context))
    },
    start: () => {
      const ticks = FixedLoop.source((onTick) => {
        const listener = (ticker: Ticker) => onTick({ deltaMS: ticker.deltaMS * controls.timeScale })
        app.ticker.add(listener)
        return { stop: () => app.ticker.remove(listener) }
      })
      FixedLoop.start({
        source: ticks,
        step,
        maxFrameSeconds: 0.25,
        maxStepsPerFrame: 5,
        update: fixedStep,
        render: drawFrame,
        onFailure: (failure) => console.error(failure)
      })
    },
    load: async (options) => {
      const { watch } = options
      warmPaths()
      const handover: WarmupStep = {
        label: "handover",
        async *poses() {
          // A first visit's pipelines are still compiling in the GPU process: the title waits for them under the loader.
          await drained(app.renderer)
          loading = false
          // The frame clock starts with the title, as on a page with no loader, so the grain plays the same.
          time = { ...time, elapsed: 0, gameElapsed: 0 }
          yield "title"
        }
      }
      const report = await warmUp([...installed.flatMap((each) => [...(each.warm?.() ?? [])]), handover], {
        renderer: app.renderer,
        watch,
        nextFrame: afterRender(app.ticker),
        onProgress: (progress) => options.onProgress?.(progress.done),
        // A device change emptied every cache: everything draws again, the title and the keys held.
        onRestart: () => {
          loading = true
        }
      })
      const events: Array<CompileEvent> = []
      watch.on((event) => {
        events.push(event)
        if (options.lateCompiles !== undefined) console[options.lateCompiles](`compiled after loading: ${event.kind} ${event.label}`)
      })
      done = { report, watch, atLoaded: watch.counts, events }
      resolveLoaded()
      return report
    },
    get loadReport() {
      return done?.report ?? null
    },
    compiles: () => done === null ? { sinceLoaded: NO_COMPILES, events: [] } : { sinceLoaded: diffCounts(done.watch.counts, done.atLoaded), events: done.events }
  }
}
