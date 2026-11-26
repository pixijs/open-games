import { el } from "../ui/dom.ts"
import { ticks } from "../ui/panel.ts"
import { after } from "./choose.ts"
import { keyName } from "./keys.ts"
import type { LabAction } from "./keys.ts"
import type { Control, Readout, Scene, Transport } from "./scene.ts"

export interface Toggle {
  readonly label: string
  readonly key: LabAction
  get(): boolean
  set(on: boolean): void
  /** Greyed out: the scene has nothing it changes. */
  readonly idle?: () => boolean
}

export interface Choice {
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  get(): string
  set(value: string): void
}

export interface PanelSetup {
  back(): void
  fold(): void
  readonly folded: () => boolean
  readonly transport: Transport
  replay(): void
  readonly toggles: ReadonlyArray<Toggle>
  readonly camera: Choice
  readonly zone: Choice
  readonly floor: Choice
  readonly readouts: () => ReadonlyArray<Readout>
}

export interface LabPanel {
  readonly element: HTMLElement
  /** Shows a scene's number, title and controls, each with its key. */
  scene(scene: Scene, index: number, controls: ReadonlyArray<Control>): void
  /** Brings every state and readout up to date; cheap enough for every frame. */
  refresh(): void
}

export const SPEEDS = [1, 0.5, 0.25, 0.1] as const

const keycaps = (...keys: ReadonlyArray<LabAction | undefined>) => keys.flatMap((key) => key === undefined ? [] : [el("kbd", "", keyName(key))])

const setText = (node: Node, text: string) => {
  if (node.textContent !== text) node.textContent = text
}

const button = (label: string, key: LabAction | undefined, run: () => void, className = "") => {
  const text = el("span", "k-lab-btn-label", label)
  const node = el("button", `k-lab-btn ${className}`, text, ...keycaps(key))
  node.type = "button"
  node.addEventListener("click", () => {
    run()
    node.blur()
  })
  return { node, text }
}

/** A part of the panel between rules, with a title when its controls need one. */
const section = (title: string | null, ...children: ReadonlyArray<Node>) =>
  el("section", "k-lab-sec", ...(title === null ? [] : [el("h3", "k-lab-sec-title", title)]), ...children)

/** A named row: its name (and the keys that work it) on the left, its control on the right. */
const row = (name: string, keys: ReadonlyArray<LabAction | undefined>, ...children: ReadonlyArray<Node>) =>
  el("div", "k-lab-field", el("span", "k-lab-field-name", name, ...keycaps(...keys)), ...children)

/** One choice as a row of chips, the chosen one lit. */
const chips = (choice: Choice) => {
  const options = choice.options.map((option) => ({ option, node: button(option.label, undefined, () => choice.set(option.value), "is-chip").node }))
  const node = el("div", "k-lab-chips", ...options.map((each) => each.node))
  return { node, update: () => options.forEach((each) => each.node.classList.toggle("is-on", each.option.value === choice.get())) }
}

/** A long choice as one value between arrows. */
const cycler = (choice: Choice) => {
  const step = (by: number) => {
    const next = after(choice.options.map((option) => option.value), choice.get(), by)
    if (next !== undefined) choice.set(next)
  }
  const shown = el("span", "k-lab-cycle-value")
  const node = el("div", "k-lab-cycle", button("‹", undefined, () => step(-1), "is-arrow").node, shown, button("›", undefined, () => step(1), "is-arrow").node)
  return { node, update: () => setText(shown, choice.options.find((option) => option.value === choice.get())?.label ?? "") }
}

/** A scene control as panel markup, and how to bring it up to date. */
const controlNode = (control: Control): { readonly node: HTMLElement; readonly update: () => void } => {
  switch (control.kind) {
    case "action":
      return { node: button(control.label, control.key, control.run, "is-action").node, update: () => {} }
    case "toggle": {
      const { node } = button(control.label, control.key, () => control.set(!control.get()), "is-toggle")
      return { node, update: () => node.classList.toggle("is-on", control.get()) }
    }
    case "range": {
      const input = el("input", "k-lab-slider")
      input.type = "range"
      input.min = `${control.min}`
      input.max = `${control.max}`
      input.step = `${control.step}`
      input.value = `${control.get()}`
      input.addEventListener("input", () => control.set(Number(input.value)))
      input.addEventListener("change", () => input.blur())
      const value = el("output", "k-lab-field-value")
      return {
        node: el("label", "k-lab-range", el("span", "k-lab-field-name", control.label), input, value),
        update: () => {
          setText(value, control.format(control.get()))
          if (document.activeElement !== input && Number(input.value) !== control.get()) input.value = `${control.get()}`
        }
      }
    }
    case "choice": {
      const made = control.options.length <= 4 ? chips(control) : cycler(control)
      return { node: row(control.label, [control.key], made.node), update: made.update }
    }
  }
}

/**
 * The lab panel, docked right like the game's framed panels: the scene's number, title and the way back; its own
 * controls; readouts; time (pause, one step, speed, replay); view toggles; camera, zone and floor. Every control shows its
 * key, and the body folds away with one key, leaving the header.
 */
export const createLabPanel = (setup: PanelSetup): LabPanel => {
  const index = el("span", "k-index")
  const title = el("span", "k-lab-title")
  const back = button("Scenes", "back", setup.back, "is-back").node
  const fold = button("Fold", "fold", setup.fold, "is-fold")
  const head = el("header", "k-lab-head",
    el("div", "k-lab-head-row", back, fold.node),
    el("div", "k-lab-head-row is-title", el("i", "k-panel-mark"), index, title))

  const sceneBox = el("div", "k-lab-controls")
  const reads = el("dl", "k-lab-read")
  let readRows: Array<{ readonly label: string; readonly value: HTMLElement; readonly row: HTMLElement }> = []

  const { transport } = setup
  const pause = button("Pause", "pause", () => transport.pause(!transport.paused), "is-play")
  const speeds = chips({
    options: SPEEDS.map((value) => ({ value: `${value}`, label: `${value}×` })),
    get: () => `${transport.speed}`,
    set: (value) => transport.setSpeed(Number(value))
  })
  const time = section(null,
    el("div", "k-lab-row", pause.node, button("Step", "step", transport.step).node, button("Replay", "replay", setup.replay).node),
    row("Speed", ["slower", "faster"], speeds.node))

  const toggles = setup.toggles.map((toggle) => ({ toggle, node: button(toggle.label, toggle.key, () => toggle.set(!toggle.get()), "is-toggle").node }))
  const view = section(null, el("div", "k-lab-row is-toggles", ...toggles.map((each) => each.node)))

  const camera = chips(setup.camera)
  const zone = chips(setup.zone)
  const floor = chips(setup.floor)
  const floorRow = row("Floor", ["floor"], floor.node)
  const cameraSec = section(null, row("Camera", ["camera"], camera.node), row("Zone", ["zone"], zone.node), floorRow)

  const sceneSec = section("Scene", sceneBox)
  const body = el("div", "k-lab-body", sceneSec, section("Readout", reads), time, view, cameraSec)
  const element = el("aside", "k-panel k-lab-dock", head, body)
  element.insertAdjacentHTML("afterbegin", ticks)

  let sceneUpdates: ReadonlyArray<() => void> = []

  return {
    element,
    scene: (scene, at, controls) => {
      setText(index, `${at + 1}`.padStart(2, "0"))
      setText(title, scene.title)
      const made = controls.map(controlNode)
      sceneBox.replaceChildren(...made.map((each) => each.node))
      sceneUpdates = made.map((each) => each.update)
      sceneSec.hidden = controls.length === 0
      floorRow.hidden = scene.start !== undefined
    },
    refresh: () => {
      element.classList.toggle("is-folded", setup.folded())
      body.classList.toggle("is-scrolling", body.scrollHeight - body.scrollTop - body.clientHeight > 2)
      setText(fold.text, setup.folded() ? "Open" : "Fold")
      for (const update of sceneUpdates) update()
      setText(pause.text, transport.paused ? "Play" : "Pause")
      pause.node.classList.toggle("is-on", transport.paused)
      speeds.update()
      for (const { toggle, node } of toggles) {
        node.classList.toggle("is-on", toggle.get())
        node.classList.toggle("is-idle", toggle.idle?.() ?? false)
      }
      camera.update()
      zone.update()
      floor.update()
      const rows = setup.readouts()
      if (rows.length !== readRows.length || rows.some((each, at) => each.label !== readRows[at]?.label)) {
        readRows = rows.map((each) => {
          const value = el("dd", "")
          return { label: each.label, value, row: el("div", "k-lab-read-row", el("dt", "", each.label), value) }
        })
        reads.replaceChildren(...readRows.map((each) => each.row))
      }
      rows.forEach((each, at) => {
        const shown = readRows[at]
        if (shown === undefined) return
        setText(shown.value, each.value)
        shown.row.classList.toggle("is-hot", each.hot ?? false)
      })
    }
  }
}
