import type { Pass3D } from "@pixi/3d"
import { Keyboard } from "@typeonce/ritmo-browser"
import { UPDATE_PRIORITY } from "pixi.js"

import type { DebugApi } from "../host/debug.ts"
import type { Install } from "../host/types.ts"
import { zoneIds, zoneOf } from "../sim/index.ts"
import type { Point, ZoneId } from "../sim/index.ts"
import { el } from "../ui/dom.ts"
import { hidePlayUi, registerExtra } from "../ui/extras.ts"
import { cameraPresets, createLabCamera } from "./camera.ts"
import type { CameraPreset } from "./camera.ts"
import { after, oneOf } from "./choose.ts"
import { createGridFloor } from "./floor.ts"
import { playerStateLabel, toSeconds } from "./frames.ts"
import { createHitboxes } from "./hitboxes.ts"
import { LAB_ACTIONS, labBindings, SCENE_KEYS } from "./keys.ts"
import type { LabAction } from "./keys.ts"
import { createSceneList } from "./list.ts"
import { createLabPanel, SPEEDS } from "./panel.ts"
import type { Toggle } from "./panel.ts"
import type { Control, LabTools, Option, OptionOf, Scene, SceneId, SceneRun, Transport, Widened } from "./scene.ts"
import { SCENES } from "./scenes.ts"
import { createSketch } from "./sketch.ts"
import { floors, loadLab, saveLab } from "./store.ts"
import type { Floor, LabStore, OptionValue } from "./store.ts"
import { createTimeline } from "./timeline.ts"
import "./lab.css"

/** Where each zone's classic arena puts a scene's centre: open ground clear of props. The grid and rooms centre on (0, 0). */
const ARENA_ANCHORS: Readonly<Record<ZoneId, Point>> = {
  courtyard: { x: 0, z: 1 },
  spiral: { x: 0, z: 9.5 },
  void: { x: 0, z: 0.5 }
}
const ORIGIN: Point = { x: 0, z: 0 }

/** The scene list's view of the grid, straight down: close enough that the grid runs past every edge of a wide window. */
const LIST_FRAMING = { x: -1.5, z: 0, radius: 6 } as const

const CAMERA_LABELS: Readonly<Record<CameraPreset, string>> = { play: "Play", top: "Top", side: "Side", orbit: "Orbit" }
const FLOOR_LABELS: Readonly<Record<Floor, string>> = { grid: "Grid", arena: "Arena" }

/** `window.__lab`: open and read the lab from screenshot scripts and the console. It lands once loading ends. */
export interface LabApi {
  /** Opens a scene by id, or the scene list with no id. */
  open(scene?: SceneId): void
  /** Leaves the lab for the title. */
  close(): void
  /** The open scene, "list", or null when the lab is closed. */
  scene(): SceneId | "list" | null
  /** Whether the open scene has set up its actors on its fresh run. */
  ready(): boolean
  /**
   * Works one of the open scene's controls by its label (any case): runs an action, sets a toggle (flips it with no
   * value), picks a choice by value or label, sets a slider; a value it already has changes nothing (no replay). False
   * when the scene has no such control.
   */
  control(label: string, value?: string | number | boolean): boolean
  /** Moves the open scene to a zone (and starts it again there). */
  zone(zone: ZoneId): void
  /** Puts the open scene on the measuring grid or its zone's classic arena (and starts it again). */
  floor(floor: Floor): void
}

declare global {
  interface Window {
    __lab?: LabApi
  }
}

/** The scene's controls with their keys: the number keys in order; sliders take none. */
const keyed = (controls: ReadonlyArray<Control>): ReadonlyArray<Control> => {
  let next = 0
  return controls.map((control) => {
    if (control.kind === "range") return control
    const key = SCENE_KEYS[next++]
    return key === undefined ? control : { ...control, key }
  })
}

/**
 * The lab: isolated scenes to review the special, the player's attacks with every weapon, every enemy and boss and
 * their attacks, movement, the zones, the rooms and their hazards, the dungeons, and the doors and transitions.
 * `?lab` opens its scene list and `?lab=<scene>` a scene; EXTRAS on the title lists every scene. Each scene runs in a
 * zone, on a sandbox run (the measuring grid or the zone's classic arena) or a dungeon run it starts itself, through
 * the simulation's debug hooks, under the game's own look, with a docked panel for its controls, time (pause, step,
 * slow motion, replay), hit shapes, invulnerability, enemy AI, HUD, post, camera, zone and floor. Leaving puts back
 * everything the lab changed and returns to the title.
 */
export const installLab = (game: DebugApi): Install => (context) => {
  let store: LabStore = loadLab()
  const save = (patch: Partial<LabStore>) => {
    store = { ...store, ...patch }
    saveLab(store)
  }

  let mode: "closed" | "list" | "scene" = "closed"
  let scene: Scene | null = null
  let run: SceneRun | null = null
  /** The open run's moment subscriptions, dropped when it stops. */
  let subscriptions: Array<() => void> = []
  let controls: ReadonlyArray<Control> = []
  /** A scene waiting for its fresh run, and whether that run has started. */
  let waiting = false
  let started = false
  let invulnerable = false
  let ai = false
  let speed: number = 1
  let quitting = false
  const disabled = new Set<Pass3D>()
  /** From the special's cut-in until its slow motion has played out: the panel steps back from the frame. */
  let cinematic = false
  /** The player's speed as it moves on screen, from its position between gameplay steps (dashes and lunges included). */
  const measured = { x: 0, z: 0, step: -1, speed: 0 }

  const floorOf = (each: Scene): Floor | "room" => each.start !== undefined ? "room" : oneOf(floors, store.options[`${each.id}.floor`], "grid")
  const zoneOfScene = (each: Scene): ZoneId => oneOf(zoneIds, store.options[`${each.id}.zone`], "courtyard")

  const transport: Transport = {
    get paused() {
      return game.state().frozen
    },
    pause: (on) => game.freeze(on),
    step: () => {
      if (!game.state().frozen) game.freeze(true)
      game.step(1)
    },
    get speed() {
      return speed
    },
    setSpeed: (scale) => {
      speed = scale
      game.speed(scale)
    }
  }

  const root = el("div", "k-ui k-lab")
  const layer = el("div", "k-lab-layer")
  const drag = el("div", "k-lab-drag")
  const timeline = createTimeline()
  const sketch = createSketch(context.view, context.layers.screen)
  const grid = createGridFloor(context.layers)
  const hitboxes = createHitboxes(context.moments)
  const keyboard = Keyboard.actions(window, labBindings, { preventDefault: false })

  /** How much of the screen the docked panel (right) and the timeline or a scene's board docked under the action (bottom) cover, in pixels. */
  const insets = () => {
    if (mode !== "scene") return { right: 0, bottom: 0 }
    const docked = [timeline.element, ...layer.querySelectorAll<HTMLElement>(".is-docked")].map((each) => (each.hidden ? 0 : each.offsetHeight + 16))
    return { right: store.collapsed ? 0 : panel.element.offsetWidth + 16, bottom: Math.max(0, ...docked) }
  }
  const camera = createLabCamera(context.rig, () => context.app.screen, insets)

  const replay = () => {
    if (scene !== null) start(scene)
  }

  const toggles: ReadonlyArray<Toggle> = [
    { label: "Hitboxes", key: "hitboxes", get: () => store.hitboxes, set: (on) => save({ hitboxes: on }) },
    {
      label: "Invulnerable",
      key: "invulnerable",
      get: () => invulnerable,
      set: (on) => {
        invulnerable = on
        game.invulnerable(on)
      }
    },
    {
      label: "Enemy AI",
      key: "ai",
      get: () => ai,
      set: (on) => {
        ai = on
        replay()
      },
      idle: () => scene?.usesAi !== true
    },
    { label: "HUD", key: "hud", get: () => store.hud, set: (on) => save({ hud: on }) },
    { label: "Post", key: "post", get: () => store.post, set: (on) => save({ post: on }) }
  ]

  const setCamera = (preset: CameraPreset) => {
    camera.set(preset)
    drag.classList.toggle("is-on", preset === "orbit")
  }

  const setFloor = (value: Floor) => {
    if (scene === null || scene.start !== undefined) return
    save({ options: { ...store.options, [`${scene.id}.floor`]: value } })
    replay()
  }

  const setZone = (value: ZoneId) => {
    if (scene === null) return
    save({ options: { ...store.options, [`${scene.id}.zone`]: value } })
    replay()
  }

  const fold = () => save({ collapsed: !store.collapsed })

  const panel = createLabPanel({
    back: () => showList(),
    fold,
    folded: () => store.collapsed,
    transport,
    replay,
    toggles,
    camera: {
      options: cameraPresets.map((value) => ({ value, label: CAMERA_LABELS[value] })),
      get: () => camera.preset,
      set: (value) => setCamera(oneOf(cameraPresets, value, "play"))
    },
    zone: {
      options: zoneIds.map((value) => ({ value, label: `${zoneOf(value).number} ${zoneOf(value).kanji}` })),
      get: () => scene === null ? "courtyard" : zoneOfScene(scene),
      set: (value) => setZone(oneOf(zoneIds, value, "courtyard"))
    },
    floor: {
      options: floors.map((value) => ({ value, label: FLOOR_LABELS[value] })),
      get: () => scene === null ? "grid" : floorOf(scene),
      set: (value) => setFloor(oneOf(floors, value, "grid"))
    },
    readouts: () => {
      const view = context.game.view()
      const player = view.player
      const common = [
        { label: "Player", value: playerStateLabel(view), hot: player?.attackPhase === "active" },
        { label: "Speed", value: `${measured.speed.toFixed(2)} u/s` },
        { label: "Frame", value: `${Math.round(context.app.ticker.FPS)} fps · step ${view.tempo.playStep}` }
      ]
      return run === null ? common : [...common, ...run.readouts(view)]
    }
  })

  const list = createSceneList(SCENES, (each) => openScene(each), () => close())
  root.append(drag, layer, timeline.element, panel.element, list.element)
  context.overlay.append(root)

  const option = <T extends OptionValue>(owner: Scene, name: string, initial: T): Option<Widened<T>> => {
    const key = `${owner.id}.${name}`
    const read = (): Widened<T> => {
      const stored = store.options[key]
      return (typeof stored === typeof initial ? stored : initial) as Widened<T>
    }
    return { get: read, set: (value) => save({ options: { ...store.options, [key]: value } }) }
  }

  const optionsOf = (owner: Scene): OptionOf => (name, initial) => option(owner, name, initial)

  const toolsFor = (owner: Scene): LabTools => {
    const floor = floorOf(owner)
    const zone = zoneOfScene(owner)
    return {
      game,
      context,
      zone,
      floor,
      anchor: floor === "arena" ? ARENA_ANCHORS[zone] : ORIGIN,
      ai,
      transport,
      timeline,
      layer,
      option: optionsOf(owner),
      on: (type, handler) => {
        subscriptions.push(context.moments.on(type, handler))
      },
      setZone,
      frame: (framing) => camera.frame(framing),
      toScreen: (x, z, y = 0) => context.view.worldToScreen({ x, y, z }),
      insets,
      replay
    }
  }

  const stop = () => {
    run?.dispose?.()
    for (const off of subscriptions) off()
    subscriptions = []
    run = null
    layer.replaceChildren()
    timeline.setup("", null)
    game.steer(0, 0)
  }

  /**
   * Starts a fresh run for the scene: its own (a dungeon run) when it starts one, else the sandbox in its zone, on the
   * measuring grid (the zone's hazard off) or the classic arena. The scene is made once the run has its player.
   */
  const start = (each: Scene) => {
    stop()
    game.freeze(false)
    const floor = floorOf(each)
    const zone = zoneOfScene(each)
    if (each.start !== undefined) each.start({ game, zone, option: optionsOf(each) })
    else {
      game.startStage(zone, 0)
      if (floor === "grid") {
        game.floor(true)
        game.hazard(false)
      }
    }
    grid.show(floor === "grid")
    waiting = true
    started = false
  }

  const setUrl = (value: string | null) => {
    const url = new URL(window.location.href)
    if (value === null) url.searchParams.delete("lab")
    else url.searchParams.set("lab", value)
    window.history.replaceState(window.history.state, "", url)
  }

  const enter = () => {
    root.classList.add("is-open")
    game.flowKeys(false)
  }

  const openScene = (each: Scene) => {
    enter()
    mode = "scene"
    scene = each
    root.classList.add("is-scene")
    list.show(false)
    invulnerable = each.defaults.invulnerable
    game.invulnerable(invulnerable)
    ai = false
    setCamera(each.defaults.camera)
    setUrl(each.id)
    start(each)
  }

  const showList = () => {
    enter()
    stop()
    const from = scene === null ? 0 : SCENES.indexOf(scene)
    mode = "list"
    scene = null
    root.classList.remove("is-scene")
    game.freeze(false)
    transport.setSpeed(1)
    setCamera("top")
    camera.frame(LIST_FRAMING)
    game.startStage("courtyard", 0)
    game.floor(true)
    game.invulnerable(true)
    grid.show(true)
    list.show(true, Math.max(0, from))
    setUrl("")
  }

  const close = () => {
    stop()
    mode = "closed"
    scene = null
    list.show(false)
    root.classList.remove("is-open", "is-scene")
    game.freeze(false)
    transport.setSpeed(1)
    game.invulnerable(false)
    game.tune(null)
    game.flowKeys(true)
    setCamera("play")
    grid.show(false)
    setUrl(null)
    game.pause()
    quitting = true
  }

  const stepSpeed = (by: number) => transport.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.findIndex((each) => each === speed) + by))] ?? 1)

  const labActions: Partial<Readonly<Record<LabAction, () => void>>> = {
    back: () => showList(),
    fold,
    pause: () => transport.pause(!transport.paused),
    step: transport.step,
    slower: () => stepSpeed(1),
    faster: () => stepSpeed(-1),
    replay,
    camera: () => setCamera(after(cameraPresets, camera.preset) ?? "play"),
    floor: () => {
      if (scene === null || scene.start !== undefined) return
      setFloor(after(floors, floorOf(scene) === "arena" ? "arena" : "grid") ?? "grid")
    },
    zone: () => {
      if (scene !== null) setZone(after(zoneIds, zoneOfScene(scene)) ?? "courtyard")
    },
    ...Object.fromEntries(toggles.map((toggle) => [toggle.key, () => toggle.set(!toggle.get())]))
  }

  /** What a scene control's key does. */
  const sceneAction = (key: LabAction): (() => void) | undefined => {
    const control = controls.find((each) => each.kind !== "range" && each.key === key)
    switch (control?.kind) {
      case "action": return control.run
      case "toggle": return () => control.set(!control.get())
      case "choice": return () => control.set(after(control.options.map((each) => each.value), control.get()) ?? control.get())
      default: return undefined
    }
  }

  /** The lab's keys this frame: the ritmo keyboard leaves keys a focused control or the scene list is using to the page. */
  const readKeys = () => {
    const input = keyboard.snapshot()
    if (mode !== "scene") return
    for (const name of LAB_ACTIONS) {
      if (input.actions[name].pressed) (labActions[name] ?? sceneAction(name))?.()
    }
  }

  let dragging: { x: number; y: number } | null = null
  drag.addEventListener("pointerdown", (event) => {
    dragging = { x: event.clientX, y: event.clientY }
    drag.setPointerCapture(event.pointerId)
  })
  drag.addEventListener("pointermove", (event) => {
    if (dragging === null) return
    camera.orbit(event.clientX - dragging.x, event.clientY - dragging.y)
    dragging = { x: event.clientX, y: event.clientY }
  })
  drag.addEventListener("pointerup", () => {
    dragging = null
  })
  drag.addEventListener("wheel", (event) => {
    event.preventDefault()
    camera.zoom(Math.pow(1.1, event.deltaY / 100))
  }, { passive: false })

  const offRun = context.moments.on("runStarted", () => {
    measured.step = -1
    started = true
  })
  const offSpecial = context.moments.on("specialStarted", () => {
    cinematic = true
  })

  /** After the host moved the camera and before pixi renders: the overlay drawn with this frame's camera. */
  const late = () => {
    sketch.clear()
    if (mode !== "scene") return
    const view = context.game.view()
    if (store.hitboxes) hitboxes.draw(sketch.sketch, view)
    run?.draw?.(sketch.sketch, view)
  }
  context.app.ticker.add(late, undefined, (UPDATE_PRIORITY.NORMAL + UPDATE_PRIORITY.LOW) / 2)

  /** Post off: every pass the view runs is switched off (vfx may add more), and switched back on after. */
  const applyPost = () => {
    const off = mode === "scene" && !store.post
    if (off) {
      for (const pass of context.view.passes) {
        if (!pass.enabled) continue
        pass.enabled = false
        disabled.add(pass)
      }
      return
    }
    for (const pass of disabled) pass.enabled = true
    disabled.clear()
  }

  const unregister = SCENES.map((each) => registerExtra({ label: each.title, detail: each.summary, open: () => openScene(each) }))

  /** Opens the scene with that id, or the scene list for any other. */
  const openById = (id: string | null | undefined) => {
    const named = SCENES.find((each) => each.id === id)
    if (named === undefined) showList()
    else openScene(named)
  }

  const api: LabApi = {
    open: openById,
    close,
    scene: () => mode === "closed" ? null : scene?.id ?? "list",
    ready: () => run !== null,
    control: (label, value) => {
      const wanted = label.toLowerCase()
      const control = controls.find((each) => each.label.toLowerCase() === wanted)
      switch (control?.kind) {
        case undefined: return false
        case "action":
          control.run()
          return true
        case "toggle": {
          const on = typeof value === "boolean" ? value : !control.get()
          if (on !== control.get()) control.set(on)
          return true
        }
        case "range":
          if (Number(value) !== control.get()) control.set(Number(value))
          return true
        case "choice": {
          const text = `${value ?? ""}`.toLowerCase()
          const picked = control.options.find((each) => each.value.toLowerCase() === text || each.label.toLowerCase() === text)
          if (picked !== undefined && picked.value !== control.get()) control.set(picked.value)
          return picked !== undefined
        }
      }
    },
    zone: (value) => setZone(value),
    floor: (value) => setFloor(value)
  }

  // Scenes start runs, so they wait for loading to end.
  const requested = new URLSearchParams(window.location.search).get("lab")
  void context.loaded.then(() => {
    window.__lab = api
    if (requested !== null) openById(requested)
  })

  return {
    update: (frame) => {
      if (quitting) {
        quitting = false
        game.quit()
      }
      readKeys()
      hidePlayUi(mode === "list" || (mode === "scene" && !store.hud))
      applyPost()
      camera.update()
      if (mode === "closed") return
      const view = context.game.view()
      const player = view.player
      if (cinematic && !view.tempo.frozen && player?.state !== "Special" && view.tempo.slowScale === 1) cinematic = false
      root.classList.toggle("is-cinematic", cinematic && mode === "scene")
      if (player !== null && view.tempo.playStep !== measured.step) {
        const steps = view.tempo.playStep - measured.step
        measured.speed = measured.step < 0 || steps <= 0 ? 0 : Math.hypot(player.x - measured.x, player.z - measured.z) / toSeconds(steps)
        measured.x = player.x
        measured.z = player.z
        measured.step = view.tempo.playStep
      }
      grid.update()
      if (mode !== "scene" || scene === null) return
      if (view.flow === "GameOver" || view.flow === "RunClear") {
        replay()
        return
      }
      if (waiting && started && view.player !== null) {
        waiting = false
        run = scene.create(toolsFor(scene))
        controls = keyed(run.controls)
        panel.scene(scene, SCENES.indexOf(scene), controls)
      }
      run?.update(view, frame)
      timeline.draw()
      panel.refresh()
    },
    dispose: () => {
      if (mode !== "closed") close()
      for (const off of unregister) off()
      offRun()
      offSpecial()
      keyboard.dispose()
      window.__lab = undefined
      context.app.ticker.remove(late)
      camera.dispose()
      hitboxes.dispose()
      sketch.destroy()
      grid.dispose()
      root.remove()
    }
  }
}
