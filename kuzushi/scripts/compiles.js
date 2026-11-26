// Records every GPU shader compile and every frame's time, so a run shows what compiles after loading and what it costs.
// It has to run before the game makes its device or context, so load it with `node scripts/shot.mjs --init scripts/compiles.js`
// (page.addInitScript), never with an evalFile step.
//
//   __compiles.ready(ms)              resolves true once the game has loaded (logs a console error after ms, default 60 s)
//   __compiles.mark(label)            starts a segment named label; segments run from one mark to the next
//   __compiles.reach(what, check, ms) resolves once __game.until(check) holds; logs a console error when it never does
//   __compiles.expectNone()           the compiles since loading; logs a console error when there are any
//   __compiles.loadTime(seconds)      when loading ended and the first frame after it, then frame times over `seconds`
//   __compiles.since(label)           the summary of everything since the last mark named label
//   __compiles.report()               every segment's summary, and the totals before and after loading
//   __compiles.table()                report() as a markdown table
//   __compiles.sourcesAfter()         the source of every shader compiled after loading, by hash
//   __compiles.dump(frames)           raw events, marks, long animation frames, and every frame's [end, interval] when frames is true
//
// WebGPU: GPUDevice createShaderModule, createRenderPipeline(Async) and createComputePipeline. WebGL: compileShader and
// linkProgram, each with the wait of the COMPILE_STATUS or LINK_STATUS query after it added, since Chrome compiles in
// the GPU process and the main thread blocks on that query. A compile's label names its program, so a missed one can
// be found.
//
// Loading ends when the debug API lands on window.__game, as the loader lifts (with the performance mark
// "kuzushi:loaded"): the segment "startup" runs from navigation to the mark "loaded" set then.
//
// Add ?compiles-cold to the page's URL to defeat the OS shader caches: every shader gets a dead local seeded with this
// load's random number, so Metal (behind Dawn and ANGLE) compiles everything from scratch, as on a first visit.
;(() => {
  if (window.__compiles) return
  const now = () => performance.now()
  const events = []
  const marks = [{ label: "startup", t: 0 }]
  const frames = []
  const loafs = []
  const textures = []
  const blocks = []
  const sources = {}
  const seen = new Map()
  const NEAR_MS = 250
  const cold = new URLSearchParams(location.search).has("compiles-cold")
  const nonce = (Math.random() * 1e6).toFixed(3)
  let firstFrame = null

  // Inserts `statement` at the start of the body of every function named in `names`.
  const intoBodies = (code, names, statement) => {
    let out = code
    for (const name of new Set(names)) {
      const at = out.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`))
      if (at < 0) continue
      let i = out.indexOf("(", at)
      for (let depth = 0; i < out.length; i++) {
        if (out[i] === "(") depth++
        else if (out[i] === ")" && --depth === 0) break
      }
      const brace = out.indexOf("{", i)
      if (brace < 0) continue
      out = `${out.slice(0, brace + 1)} ${statement} ${out.slice(brace + 1)}`
    }
    return out
  }
  const ENTRY = /@(vertex|fragment|compute)\b[^{;]*?\bfn\s+(\w+)/g
  const coldWgsl = (code) => intoBodies(code, [...code.matchAll(ENTRY)].map((m) => m[2]), `var compiles_nonce: f32 = ${nonce}; compiles_nonce += 1.0;`)
  const coldGlsl = (code) => code.replace(/void\s+main\s*\(\s*(?:void)?\s*\)\s*\{/, (match) => `${match} float compiles_nonce = ${nonce}; compiles_nonce += 1.0;`)

  const hash = (text) => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, "0")
  }
  const ids = new WeakMap()
  let nextId = 1
  const idOf = (object) => {
    if (object === null || typeof object !== "object") return String(object)
    if (!ids.has(object)) ids.set(object, nextId++)
    return ids.get(object)
  }

  // A key seen before is a repeat: the same program or pipeline state compiled again.
  const record = (kind, start, ms, label, key) => {
    const first = seen.get(key)
    const event = { i: events.length, t: +start.toFixed(2), ms: +ms.toFixed(3), wait: 0, kind, label, repeatOf: first ?? null }
    if (first === undefined) seen.set(key, event.i)
    events.push(event)
    return event
  }

  // Calls that can wait on the GPU process: any over 8 ms is kept, to show where a compile's stall lands on the main thread.
  const timeCall = (proto, name, what) => {
    const original = proto?.[name]
    if (typeof original !== "function") return
    proto[name] = function (...args) {
      const start = now()
      const result = original.apply(this, args)
      const ms = now() - start
      if (ms > 8) blocks.push({ t: +start.toFixed(1), ms: +ms.toFixed(1), what })
      return result
    }
  }

  if (typeof GPUDevice !== "undefined") {
    const proto = GPUDevice.prototype
    const modules = new WeakMap()
    const stageOf = (stage) => {
      if (!stage) return null
      const info = modules.get(stage.module)
      return `${info?.hash ?? "?"}:${stage.entryPoint ?? info?.entries.join("+") ?? "?"}`
    }
    const blendOf = (blend) => blend ? `${blend.color?.srcFactor ?? "one"}/${blend.color?.dstFactor ?? "zero"}/${blend.color?.operation ?? "add"},${blend.alpha?.srcFactor ?? "one"}/${blend.alpha?.dstFactor ?? "zero"}` : "none"
    // Everything a pipeline's cache key can differ in, so two states of one shader show as two pipelines.
    const describe = (d) => {
      const targets = (d.fragment?.targets ?? []).map((t) => t ? `${t.format}${t.blend ? "+blend" : ""}${t.writeMask !== undefined && t.writeMask !== 15 ? `/mask${t.writeMask}` : ""}` : "null")
      const ds = d.depthStencil
      const depth = ds ? `${ds.format}${ds.depthWriteEnabled ? "+write" : ""}/${ds.depthCompare ?? "-"}` : "none"
      const samples = d.multisample?.count ?? 1
      const primitive = `${d.primitive?.topology ?? "triangle-list"}/${d.primitive?.cullMode ?? "none"}/${d.primitive?.frontFace ?? "ccw"}`
      const buffers = (d.vertex?.buffers ?? []).map((b) => b ? `${b.arrayStride}${b.stepMode === "instance" ? "i" : ""}[${(b.attributes ?? []).map((a) => `${a.shaderLocation}:${a.format}@${a.offset}`).join(" ")}]` : "-").join(" ")
      const vs = stageOf(d.vertex)
      const fs = stageOf(d.fragment)
      const blends = (d.fragment?.targets ?? []).map((t) => blendOf(t?.blend)).filter((b) => b !== "none")
      const label = `${d.label ?? "(no label)"} vs=${vs} fs=${fs} -> [${targets.join(", ")}] depth=${depth} x${samples} ${primitive} buf=${hash(buffers).slice(0, 6)}${blends.length > 0 ? ` blend=${blends.join(";")}` : ""}${ds?.depthBias ? ` bias=${ds.depthBias}` : ""}`
      const key = JSON.stringify([vs, fs, targets, (d.fragment?.targets ?? []).map((t) => blendOf(t?.blend)), depth, ds?.stencilFront ?? null, ds?.stencilBack ?? null, ds?.depthBias ?? 0, samples, d.multisample?.alphaToCoverageEnabled ?? false, primitive, buffers, d.vertex?.constants ?? null, d.fragment?.constants ?? null])
      return { label, key }
    }

    const createShaderModule = proto.createShaderModule
    proto.createShaderModule = function (descriptor) {
      const code = descriptor?.code ?? ""
      const start = now()
      const module = createShaderModule.call(this, cold ? { ...descriptor, code: coldWgsl(code) } : descriptor)
      const ms = now() - start
      const h = hash(code)
      sources[h] ??= code
      const entries = [...code.matchAll(ENTRY)].map((m) => `${m[1][0]}s:${m[2]}`)
      modules.set(module, { hash: h, entries })
      record("module", start, ms, `wgsl#${h} ${entries.join(",") || "(no entry)"} ${code.length}B`, `module:${h}`)
      return module
    }
    const createRenderPipeline = proto.createRenderPipeline
    proto.createRenderPipeline = function (descriptor) {
      const start = now()
      const pipeline = createRenderPipeline.call(this, descriptor)
      const { label, key } = describe(descriptor)
      record("pipeline", start, now() - start, label, `pipeline:${key}`)
      return pipeline
    }
    const createRenderPipelineAsync = proto.createRenderPipelineAsync
    proto.createRenderPipelineAsync = function (descriptor) {
      const start = now()
      const promise = createRenderPipelineAsync.call(this, descriptor)
      const { label, key } = describe(descriptor)
      const event = record("pipelineAsync", start, now() - start, label, `pipeline:${key}`)
      promise.then(() => { event.resolvedMs = +(now() - start).toFixed(2) }, () => { event.failed = true })
      return promise
    }
    const createComputePipeline = proto.createComputePipeline
    proto.createComputePipeline = function (descriptor) {
      const start = now()
      const pipeline = createComputePipeline.call(this, descriptor)
      const cs = stageOf(descriptor.compute)
      record("compute", start, now() - start, `${descriptor.label ?? "(no label)"} cs=${cs}`, `compute:${cs}:${JSON.stringify(descriptor.compute?.constants ?? null)}`)
      return pipeline
    }
    const createTexture = proto.createTexture
    proto.createTexture = function (descriptor) {
      const size = descriptor?.size
      const [w, h, layers] = Array.isArray(size) ? [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1] : [size?.width ?? 1, size?.height ?? 1, size?.depthOrArrayLayers ?? 1]
      textures.push({ t: now(), texels: w * h * layers })
      return createTexture.call(this, descriptor)
    }

    timeCall(GPUCanvasContext.prototype, "getCurrentTexture", "getCurrentTexture")
    for (const name of ["submit", "writeBuffer", "writeTexture", "copyExternalImageToTexture"]) timeCall(GPUQueue.prototype, name, `queue.${name}`)
    for (const name of ["createBindGroup", "createBuffer"]) timeCall(proto, name, name)
  }

  const wrapGl = (Context) => {
    if (typeof Context === "undefined") return
    const proto = Context.prototype
    const shaderType = new WeakMap()
    const shaderSource = new WeakMap()
    const shaderEvent = new WeakMap()
    const programShaders = new WeakMap()
    const programEvent = new WeakMap()
    const COMPILE_STATUS = 0x8b81
    const COMPLETION_STATUS_KHR = 0x91b1

    const createShader = proto.createShader
    proto.createShader = function (type) {
      const shader = createShader.call(this, type)
      if (shader) shaderType.set(shader, type === this.VERTEX_SHADER ? "vs" : "fs")
      return shader
    }
    const setSource = proto.shaderSource
    proto.shaderSource = function (shader, source) {
      const h = hash(source)
      sources[h] ??= source
      shaderSource.set(shader, { hash: h, length: source.length })
      return setSource.call(this, shader, cold ? coldGlsl(source) : source)
    }
    const compileShader = proto.compileShader
    proto.compileShader = function (shader) {
      const start = now()
      const result = compileShader.call(this, shader)
      const source = shaderSource.get(shader)
      const type = shaderType.get(shader) ?? "?"
      shaderEvent.set(shader, record("shader", start, now() - start, `${type} glsl#${source?.hash} ${source?.length}B`, `shader:${type}:${source?.hash}`))
      return result
    }
    const attachShader = proto.attachShader
    proto.attachShader = function (program, shader) {
      programShaders.set(program, [...(programShaders.get(program) ?? []), shader])
      return attachShader.call(this, program, shader)
    }
    const linkProgram = proto.linkProgram
    proto.linkProgram = function (program) {
      const start = now()
      const result = linkProgram.call(this, program)
      const ms = now() - start
      const parts = (programShaders.get(program) ?? []).map((shader) => `${shaderType.get(shader)}#${shaderSource.get(shader)?.hash}`)
      // pixi links a GLSL ES 1.0 program a second time after binding its attributes in sorted order: a relink, not a new program.
      programEvent.set(program, programEvent.has(program)
        ? record("relink", start, ms, `relink ${parts.join(" ")}`, `relink:${idOf(program)}`)
        : record("program", start, ms, `program ${parts.join(" ")}`, `program:${parts.join(":")}`))
      return result
    }
    // The first status query after a compile or link waits for it to finish in the GPU process.
    const waited = (event, start) => {
      if (event === undefined || event.waited) return
      event.wait = +(now() - start).toFixed(3)
      event.waited = true
    }
    const getShaderParameter = proto.getShaderParameter
    proto.getShaderParameter = function (shader, name) {
      const start = now()
      const result = getShaderParameter.call(this, shader, name)
      if (name === COMPILE_STATUS) waited(shaderEvent.get(shader), start)
      return result
    }
    const getProgramParameter = proto.getProgramParameter
    proto.getProgramParameter = function (program, name) {
      const start = now()
      const result = getProgramParameter.call(this, program, name)
      if (name !== COMPLETION_STATUS_KHR || result === true) waited(programEvent.get(program), start)
      return result
    }
    const createTexture = proto.createTexture
    proto.createTexture = function () {
      textures.push({ t: now(), texels: 0 })
      return createTexture.call(this)
    }
    for (const name of ["getUniformLocation", "getActiveUniform", "getActiveAttrib", "getAttribLocation", "useProgram", "drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "texImage2D", "texSubImage2D", "readPixels", "getError"]) {
      timeCall(proto, name, `gl.${name}`)
    }
  }
  wrapGl(globalThis.WebGL2RenderingContext)
  wrapGl(globalThis.WebGLRenderingContext)

  // [the timestamp of the frame that ended the interval, the interval in ms]
  let last = null
  const tick = (timestamp) => {
    if (last !== null) frames.push([timestamp, timestamp - last])
    last = timestamp
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        loafs.push({
          t: +entry.startTime.toFixed(1),
          ms: +entry.duration.toFixed(1),
          scripts: scripts.map((s) => `${s.sourceFunctionName || s.invoker || "?"}@${(s.sourceURL || "").split("/").pop().split("?")[0]}:${Math.round(s.duration)}`)
        })
      }
    }).observe({ type: "long-animation-frame", buffered: true })
  } catch {
    // This browser has no long animation frame timing.
  }

  const mark = (label) => {
    marks.push({ label, t: now() })
    return label
  }
  let game
  Object.defineProperty(window, "__game", {
    configurable: true,
    enumerable: true,
    get: () => game,
    set: (value) => {
      game = value
      // The game finishes the task it published the API in (host.start today), so a timeout lands after it.
      setTimeout(() => {
        mark("loaded")
        // The first frame after loading has been drawn and shown once the frame after it begins.
        requestAnimationFrame(() => requestAnimationFrame(() => { firstFrame = now() }))
      }, 0)
    }
  })
  const loadedAt = () => marks.find((m) => m.label === "loaded")?.t

  const isCompile = (e) => e.kind !== "relink"
  const cost = (e) => e.ms + (e.wait ?? 0)
  const round = (x) => +x.toFixed(1)
  const median = (values) => values.length === 0 ? 0 : values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const segmentOf = (t) => marks.filter((m) => m.t <= t).pop()?.label ?? "startup"
  const counts = (list) => {
    const count = (...kinds) => list.filter((e) => kinds.includes(e.kind)).length
    return { pipelines: count("pipeline", "pipelineAsync"), compute: count("compute"), modules: count("module"), programs: count("program"), shaders: count("shader"), relinks: count("relink") }
  }
  const frameStats = (from, to) => {
    const dts = frames.filter(([end]) => end > from && end <= to).map(([, dt]) => dt)
    return { worstFrame: round(Math.max(0, ...dts)), medianFrame: round(median(dts)), over33: dts.filter((dt) => dt > 33.4).length }
  }
  const summarize = (label, from, to) => {
    const list = events.filter((e) => e.t >= from && e.t < to)
    let worstNear = 0
    for (const e of list) {
      if (!isCompile(e)) continue
      // Every frame interval that overlaps the 250 ms after the call, however long it ran.
      for (const [end, dt] of frames) if (end > e.t && end - dt < e.t + NEAR_MS && dt > worstNear) worstNear = dt
    }
    const slow = loafs.filter((l) => l.t >= from && l.t < to).sort((a, b) => b.ms - a.ms)
    const made = textures.filter((x) => x.t >= from && x.t < to)
    const waits = blocks.filter((b) => b.t >= from && b.t < to).sort((a, b) => b.ms - a.ms)
    return {
      label,
      from: round(from),
      seconds: round((to - from) / 1000),
      ...counts(list),
      repeats: list.filter((e) => e.repeatOf !== null).length,
      compileMs: round(list.reduce((sum, e) => sum + cost(e), 0)),
      maxCallMs: round(list.reduce((max, e) => Math.max(max, cost(e)), 0)),
      asyncResolvedMs: round(list.reduce((max, e) => Math.max(max, e.resolvedMs ?? 0), 0)),
      ...frameStats(from, to),
      worstNear: round(worstNear),
      longestLoaf: round(slow[0]?.ms ?? 0),
      longestLoafScripts: slow[0]?.scripts ?? [],
      textures: made.length,
      megatexels: round(made.reduce((sum, x) => sum + x.texels, 0) / 1e6),
      blockedMs: round(waits.reduce((sum, b) => sum + b.ms, 0)),
      worstBlock: waits[0] ? `${waits[0].what} ${waits[0].ms}ms` : null,
      new: list.filter((e) => e.repeatOf === null).map((e) => `${e.kind} ${cost(e).toFixed(2)}ms ${e.label}`),
      repeated: list.filter((e) => e.repeatOf !== null).map((e) => `${e.kind} ${e.label} (first #${e.repeatOf} in ${segmentOf(events[e.repeatOf].t)})`)
    }
  }
  const total = (c) => c.pipelines + c.compute + c.modules + c.programs + c.shaders
  const rendererOf = () => events.some((e) => e.kind === "pipeline" || e.kind === "module") ? "webgpu" : "webgl"

  const since = (label) => summarize(label, marks.filter((m) => m.label === label).pop()?.t ?? 0, now())
  const totals = (from, to) => {
    const s = summarize("", from, to)
    return { pipelines: s.pipelines, compute: s.compute, modules: s.modules, programs: s.programs, relinks: s.relinks, shaders: s.shaders, repeats: s.repeats, compileMs: s.compileMs, textures: s.textures }
  }
  const report = () => {
    const end = now()
    const at = loadedAt() ?? end
    return {
      cold,
      renderer: rendererOf(),
      userAgent: navigator.userAgent,
      medianFrame: round(median(frames.map(([, dt]) => dt))),
      beforeLoaded: totals(0, at),
      afterLoaded: totals(at, end),
      segments: marks.map((m, i) => summarize(m.label, m.t, marks[i + 1]?.t ?? end))
    }
  }
  const table = () => {
    const r = report()
    return [
      `${r.renderer}${r.cold ? " cold" : ""}, median frame ${r.medianFrame} ms; before loaded ${JSON.stringify(r.beforeLoaded)}; after ${JSON.stringify(r.afterLoaded)}`,
      "| segment | seconds | pipelines | modules | programs | shaders | repeats | compile ms | max call ms | worst frame near | worst frame | textures |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...r.segments.map((s) => `| ${s.label} | ${s.seconds} | ${s.pipelines + s.compute} | ${s.modules} | ${s.programs} | ${s.shaders} | ${s.repeats} | ${s.compileMs} | ${s.maxCallMs} | ${s.worstNear || "-"} | ${s.worstFrame} | ${s.textures} |`)
    ].join("\n")
  }
  const sourcesAfter = () => {
    const at = loadedAt() ?? 0
    const out = {}
    for (const e of events) {
      const h = /(?:wgsl|glsl)#([0-9a-f]{8})/.exec(e.label)?.[1]
      if (e.t >= at && h !== undefined && sources[h] !== undefined) out[h] = sources[h]
    }
    return out
  }
  const dump = (withFrames = false) => ({ marks, events, loafs, blocks, textures: textures.length, ...(withFrames ? { frames: frames.map(([end, dt]) => [+end.toFixed(1), +dt.toFixed(1)]) } : {}) })

  const poll = (check, timeoutMs) => new Promise((resolve) => {
    const started = now()
    const next = () => {
      if (check()) resolve(true)
      else if (now() - started > timeoutMs) resolve(false)
      else setTimeout(next, 50)
    }
    next()
  })
  const ready = async (timeoutMs = 60000) => {
    const ok = await poll(() => loadedAt() !== undefined, timeoutMs)
    if (!ok) console.error(`compiles: the game never loaded (no window.__game after ${timeoutMs} ms)`)
    return ok
  }
  const reach = async (what, check, timeoutMs = 20000) => {
    const ok = window.__game !== undefined && await window.__game.until(check, timeoutMs)
    if (!ok) console.error(`compiles: never reached ${what} (${timeoutMs} ms)`)
    return ok ? what : `NOT REACHED: ${what}`
  }
  const expectNone = () => {
    const after = events.filter((e) => e.t >= (loadedAt() ?? Infinity))
    const c = counts(after)
    if (total(c) > 0) {
      const first = after.filter((e) => e.repeatOf === null && isCompile(e)).slice(0, 3).map((e) => `${e.kind} in ${segmentOf(e.t)}: ${e.label}`)
      console.error(`compiles: compiled after loading: ${JSON.stringify(c)}; first ${first.join(" | ")}`)
    }
    return c
  }
  const loadTime = async (seconds = 6.5) => {
    await ready()
    await poll(() => firstFrame !== null, 60000)
    const loaded = loadedAt() ?? 0
    await poll(() => now() >= loaded + seconds * 1000, seconds * 1000 + 1000)
    const end = loaded + seconds * 1000
    return {
      renderer: rendererOf(),
      cold,
      loaded: round(loaded),
      firstFrame: round(firstFrame ?? 0),
      mark: performance.getEntriesByName("kuzushi:loaded")[0]?.startTime ?? null,
      seconds,
      ...frameStats(loaded, end),
      compiles: counts(events.filter((e) => e.t >= loaded && e.t < end))
    }
  }

  window.__compiles = { ready, mark, reach, expectNone, loadTime, since, report, table, sourcesAfter, dump, events, marks, frames, loafs, sources, textures, blocks }
})()
