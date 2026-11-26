/**
 * Counts the shader and pipeline compiles a pixi renderer asks its GPU for, so an app can prove that loading compiled
 * everything play draws, and catch anything that compiles later.
 *
 * pixi creates each WebGPU pipeline and shader module, and each WebGL shader and program, synchronously, on the first
 * draw that needs it, and caches it until the device or context changes. A frame that leaves `total` unchanged drew
 * only what was compiled before.
 *
 * It wraps methods on the renderer's own GPUDevice or WebGL context, never on their prototypes, so it composes with
 * tools that wrap the prototypes.
 */
import type { Renderer } from "pixi.js"

/** What the GPU was asked to compile. */
export type CompileKind = "pipeline" | "computePipeline" | "shaderModule" | "glShader" | "glProgram"

/** One compile, reported while the call that asked for it is still on the stack. */
export interface CompileEvent {
  readonly kind: CompileKind
  /**
   * What was compiled. On WebGPU, the descriptor's label (pixi labels its pipelines `PIXI Pipeline (<program name>)`),
   * or `wgsl#<hash of the code>` for a module without one. On WebGL, a shader's `SHADER_NAME` define (pixi adds one
   * from the program's name), or `glsl#<hash of the source>`; a program joins its shaders' names with ` + `.
   */
  readonly label: string
  /** `performance.now()` when it was asked for. */
  readonly at: number
}

/** Compiles by kind. Async pipeline creation counts with its sync form, and `glProgram` counts every link, relinks included. */
export type CompileCounts = { readonly [K in CompileKind]: number }

/** A running count of a renderer's compiles. */
export interface CompileWatch {
  /** Every compile since `watchCompiles`, by kind; a snapshot that later compiles don't change. */
  readonly counts: CompileCounts
  /** The sum of `counts`. */
  readonly total: number
  /**
   * How many times the renderer has changed device (WebGPU) or restored its context (WebGL) since `watchCompiles`.
   * Each change empties pixi's pipeline and program caches, so anything compiled before it compiles again.
   */
  readonly contextChanges: number
  /** Calls `listener` for every compile from now on, inside the call that compiled, so a stack taken there shows who drew it. Returns an unsubscribe. */
  on(listener: (event: CompileEvent) => void): () => void
  /** Stops counting and puts back the methods it wrapped, where nothing has wrapped them since. */
  stop(): void
}

/** No compiles of any kind. */
export const NO_COMPILES: CompileCounts = { pipeline: 0, computePipeline: 0, shaderModule: 0, glShader: 0, glProgram: 0 }

/** `after - before` for each kind. */
export const diffCounts = (after: CompileCounts, before: CompileCounts): CompileCounts => ({
  pipeline: after.pipeline - before.pipeline,
  computePipeline: after.computePipeline - before.computePipeline,
  shaderModule: after.shaderModule - before.shaderModule,
  glShader: after.glShader - before.glShader,
  glProgram: after.glProgram - before.glProgram
})

/** Counts every compile `renderer` performs from now on, across device and context changes. The canvas renderer compiles nothing. */
export const watchCompiles = (renderer: Renderer): CompileWatch => {
  const counts: Record<CompileKind, number> = { ...NO_COMPILES }
  let total = 0
  let contextChanges = 0
  let stopped = false
  const listeners = new Set<(event: CompileEvent) => void>()
  const record: Recorder = (kind, label, call) => {
    const at = performance.now()
    const result = call()
    if (!stopped) {
      counts[kind] += 1
      total += 1
      const event = { kind, label: label(), at }
      for (const listener of listeners) listener(event)
    }
    return result
  }

  const watched = new WeakSet<object>()
  const undo: Array<() => void> = []
  const watch = <T extends object>(target: T, wrap: (target: T, record: Recorder) => Array<() => void>) => {
    if (watched.has(target)) return
    watched.add(target)
    undo.push(...wrap(target, record))
  }
  const watchCurrent = () => {
    if ("gpu" in renderer) watch(renderer.gpu.device, wrapDevice)
    else if ("gl" in renderer) watch(renderer.gl, wrapGl)
  }
  watchCurrent()
  // pixi's own systems are on the runner first, so the renderer holds the new device when this runs.
  const onContext = {
    contextChange: () => {
      contextChanges += 1
      watchCurrent()
    }
  }
  renderer.runners.contextChange.add(onContext)

  return {
    get counts() {
      return { ...counts }
    },
    get total() {
      return total
    },
    get contextChanges() {
      return contextChanges
    },
    on: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: () => {
      stopped = true
      renderer.runners.contextChange.remove(onContext)
      for (const each of undo.splice(0)) each()
      listeners.clear()
    }
  }
}

/** Calls `call`, then counts one compile of `kind` labelled by `label()`. */
type Recorder = <R>(kind: CompileKind, label: () => string, call: () => R) => R

const wrapDevice = (device: GPUDevice, record: Recorder) => {
  const { createRenderPipeline, createRenderPipelineAsync, createComputePipeline, createComputePipelineAsync, createShaderModule } = device
  return [
    replace(device, "createRenderPipeline", (descriptor) => record("pipeline", () => descriptor.label ?? "", () => createRenderPipeline.call(device, descriptor))),
    replace(device, "createRenderPipelineAsync", (descriptor) => record("pipeline", () => descriptor.label ?? "", () => createRenderPipelineAsync.call(device, descriptor))),
    replace(device, "createComputePipeline", (descriptor) => record("computePipeline", () => descriptor.label ?? "", () => createComputePipeline.call(device, descriptor))),
    replace(device, "createComputePipelineAsync", (descriptor) => record("computePipeline", () => descriptor.label ?? "", () => createComputePipelineAsync.call(device, descriptor))),
    replace(device, "createShaderModule", (descriptor) => record("shaderModule", () => descriptor.label || `wgsl#${hash(descriptor.code)}`, () => createShaderModule.call(device, descriptor)))
  ]
}

const wrapGl = (gl: WebGL2RenderingContext, record: Recorder) => {
  const { compileShader, linkProgram } = gl
  const nameOf = (shader: WebGLShader) => {
    const source = gl.getShaderSource(shader) ?? ""
    return /#define SHADER_NAME (\S+)/.exec(source)?.[1] ?? `glsl#${hash(source)}`
  }
  return [
    replace(gl, "compileShader", (shader) => record("glShader", () => nameOf(shader), () => compileShader.call(gl, shader))),
    replace(gl, "linkProgram", (program) => record("glProgram", () => (gl.getAttachedShaders(program) ?? []).map(nameOf).join(" + "), () => linkProgram.call(gl, program)))
  ]
}

/** Sets `value` as `target`'s own `name`; returns what restores the previous one, unless something has replaced `value` since. */
const replace = <T extends object, K extends keyof T>(target: T, name: K, value: T[K]) => {
  const own = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, { value, configurable: true, writable: true })
  return () => {
    if (target[name] !== value) return
    if (own === undefined) Reflect.deleteProperty(target, name)
    else Object.defineProperty(target, name, own)
  }
}

/** FNV-1a, so the same source reads as the same label. */
const hash = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, "0")
}
