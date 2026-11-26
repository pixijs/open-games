/**
 * Draws an app's programs while it loads, through the app's own frames, until nothing new compiles, so play never
 * stalls on a first draw.
 *
 * pixi compiles a pipeline or program on the first draw that needs it, keyed by everything that draw sets: target
 * formats and sample count, blend, depth and stencil state, geometry layout and shader source. Drawing the app's real
 * objects into the real canvas, while a loading screen covers it, reproduces those keys by construction; nothing about
 * them is copied here.
 *
 * Each step hands its textures to the GPU within a byte budget per frame, then sets up its poses one at a time. After
 * each pose the app draws real frames until `settleFrames` in a row compile nothing. Steps and poses are factories, so
 * when a device or context change empties pixi's caches mid-way, the warm-up starts over.
 *
 * Warm up after everything that changes how programs compile, such as view settings, post passes and the first
 * shadow-casting light: a change after loading compiles every program it touches again.
 */
import { UPDATE_PRIORITY } from "pixi.js"
import type { Renderer, TextureSource, Ticker } from "pixi.js"

import { diffCounts } from "./compiles.ts"
import type { CompileCounts, CompileWatch } from "./compiles.ts"

/** One part of loading: textures to upload, then poses to draw. */
export interface WarmupStep {
  /** Names the step in progress and in the report. */
  readonly label: string
  /** Textures to hand to the GPU before the first pose. A source listed by several steps is uploaded once. */
  readonly uploads?: () => Iterable<TextureSource>
  /**
   * Sets up each pose, then yields its name, or nothing to be named by its number. The warm-up draws frames until the
   * pose settles, then resumes the iterator for the next. Undo the poses in a `finally`: on an error or a restart the
   * warm-up calls `return()`.
   */
  readonly poses?: () => Iterator<string | void, void, undefined> | AsyncIterator<string | void, void, undefined>
}

export interface WarmupProgress {
  /** The step, or `step/pose` while a pose draws. */
  readonly label: string
  /** 0 to 1: steps done over steps, creeping toward the next step with each frame drawn. Never decreases. */
  readonly done: number
  /** Frames drawn since the warm-up began. */
  readonly frames: number
  /** Compiles since the warm-up began. */
  readonly compiles: number
}

export interface WarmupOptions {
  /** Takes the uploads through `renderer.texture.initSource`. */
  readonly renderer: { readonly texture: { initSource(source: TextureSource): unknown } }
  readonly watch: CompileWatch
  /** Resolves once the app has drawn its next real frame: `afterRender(app.ticker)`. */
  readonly nextFrame: () => Promise<void>
  /** Frames in a row that compile nothing before a pose counts as drawn. Default 1, so a pose with nothing new costs one frame. */
  readonly settleFrames?: number
  /** Frames a pose may take: one still compiling after them is listed in `unsettled`, and the warm-up moves on. Default 20. */
  readonly maxFramesPerPose?: number
  /** Bytes uploaded in one frame before the warm-up waits for the next (estimated as RGBA8, a third more with mips). Default 32 MiB. */
  readonly uploadBytesPerFrame?: number
  /** Called at each step's start and end and after every frame. */
  readonly onProgress?: (progress: WarmupProgress) => void
  /** Called before a context change starts the warm-up over, once the open pose is undone: put back what the steps changed. */
  readonly onRestart?: () => void
}

export interface WarmupStepReport {
  readonly label: string
  readonly poses: number
  readonly frames: number
  readonly ms: number
  /** Compiles during the step, its pose setup included. */
  readonly compiles: number
  /** Estimated bytes uploaded. */
  readonly bytes: number
}

export interface WarmupReport {
  /** Wall time, restarts included, as are `frames`, `compiles` and `bytes`. */
  readonly ms: number
  readonly frames: number
  readonly compiles: CompileCounts
  readonly bytes: number
  /** The last pass's steps. */
  readonly steps: ReadonlyArray<WarmupStepReport>
  /** `step/pose` for each pose of the last pass still compiling after `maxFramesPerPose` frames. Empty when every pose settled. */
  readonly unsettled: ReadonlyArray<string>
  /** How many times a device or context change started the warm-up over. */
  readonly restarts: number
}

/** A device that keeps getting lost would otherwise hold loading forever; past this many restarts the warm-up finishes as it can. */
const MAX_RESTARTS = 3
/** Frames into a step at which progress has crept half way to the next step. */
const CREEP_FRAMES = 8

class Restart extends Error {}

/** Uploads and draws `steps` in order through the app's own frames until nothing new compiles; see the module header. */
export const warmUp = async (steps: Iterable<WarmupStep>, options: WarmupOptions): Promise<WarmupReport> => {
  const { renderer, watch, nextFrame, onProgress, onRestart } = options
  const settleFrames = options.settleFrames ?? 1
  const maxFramesPerPose = options.maxFramesPerPose ?? 20
  const budget = options.uploadBytesPerFrame ?? 32 * 2 ** 20
  const list = [...steps]
  const started = performance.now()
  const countsAtStart = watch.counts
  const totalAtStart = watch.total
  let frames = 0
  let bytes = 0
  let done = 0
  let restarts = 0

  const report = (label: string, fraction: number) => {
    done = Math.max(done, fraction)
    onProgress?.({ label, done, frames, compiles: watch.total - totalAtStart })
  }

  const pass = async () => {
    const changes = watch.contextChanges
    const restart = () => watch.contextChanges !== changes && restarts < MAX_RESTARTS
    const stepReports: Array<WarmupStepReport> = []
    const unsettled: Array<string> = []
    const uploaded = new Set<TextureSource>()
    let spent = 0
    let index = 0
    let stepFrames = 0
    const share = () => list.length === 0 ? 1 : (index + stepFrames / (stepFrames + CREEP_FRAMES)) / list.length

    const frame = async (label: string) => {
      await nextFrame()
      frames += 1
      stepFrames += 1
      spent = 0
      if (restart()) throw new Restart()
      report(label, share())
    }
    const settle = async (label: string) => {
      for (let drawn = 0, quiet = 0; drawn < maxFramesPerPose; drawn += 1) {
        const total = watch.total
        await frame(label)
        quiet = watch.total === total ? quiet + 1 : 0
        if (quiet >= settleFrames) return true
      }
      return false
    }

    for (const step of list) {
      const at = { ms: performance.now(), frames, total: watch.total, bytes }
      stepFrames = 0
      report(step.label, share())
      for (const source of step.uploads?.() ?? []) {
        if (uploaded.has(source)) continue
        if (spent >= budget) await frame(step.label)
        uploaded.add(source)
        renderer.texture.initSource(source)
        const size = bytesOf(source)
        spent += size
        bytes += size
      }
      let poses = 0
      const iterator = step.poses?.()
      let open = false
      try {
        while (iterator !== undefined) {
          open = false
          const next = await iterator.next()
          if (next.done === true) break
          open = true
          poses += 1
          const label = `${step.label}/${next.value ?? poses}`
          if (!(await settle(label))) unsettled.push(label)
        }
      } finally {
        if (open) await iterator?.return?.()
      }
      index += 1
      stepFrames = 0
      stepReports.push({ label: step.label, poses, frames: frames - at.frames, ms: performance.now() - at.ms, compiles: watch.total - at.total, bytes: bytes - at.bytes })
      report(step.label, share())
    }
    if (restart()) throw new Restart()
    return { steps: stepReports, unsettled }
  }

  for (;;) {
    try {
      const last = await pass()
      return { ms: performance.now() - started, frames, compiles: diffCounts(watch.counts, countsAtStart), bytes, ...last, restarts }
    } catch (error) {
      if (!(error instanceof Restart)) throw error
      restarts += 1
      onRestart?.()
    }
  }
}

/**
 * A `nextFrame` for `warmUp`: resolves after the ticker's next render. Its listener runs at `UPDATE_PRIORITY.UTILITY`,
 * after an Application's render at `LOW`; call it from outside the ticker's UTILITY listeners. It waits while the
 * ticker is stopped or the page is hidden.
 */
export const afterRender = (ticker: Ticker) => () => new Promise<void>((resolve) => {
  ticker.addOnce(() => resolve(), undefined, UPDATE_PRIORITY.UTILITY)
})

/**
 * Resolves once the GPU has done all the work sent to it. On WebGPU the browser compiles a pipeline in the GPU process
 * after the call that creates it returns, so on a cold shader cache a warm-up's compiles land on the frames after it;
 * await this before the warm-up's last pose to keep them under the loader. On WebGL pixi already waits for each compile
 * when it checks its status, so this resolves at once.
 */
export const drained = (renderer: Renderer): Promise<void> =>
  "gpu" in renderer ? renderer.gpu.device.queue.onSubmittedWorkDone() : Promise.resolve()

const bytesOf = (source: TextureSource) =>
  source.pixelWidth * source.pixelHeight * source.depth * source.arrayLayerCount * 4 * (source.autoGenerateMipmaps || source.mipLevelCount > 1 ? 4 / 3 : 1)
