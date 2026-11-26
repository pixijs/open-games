import { Descriptor } from "@typeonce/ritmo"
import { Controls, Keyboard, Pointer } from "@typeonce/ritmo-browser"
import type { InputCapture } from "@typeonce/ritmo-browser"

export const Actions = Controls.actions({
  buttons: ["slash", "dash", "parry", "special", "interact", "pause", "confirm"],
  vectors: ["move"]
})

export const keys = {
  move: Keyboard.vector({
    up: ["ArrowUp", Keyboard.code("KeyW")],
    down: ["ArrowDown", Keyboard.code("KeyS")],
    left: ["ArrowLeft", Keyboard.code("KeyA")],
    right: ["ArrowRight", Keyboard.code("KeyD")]
  }),
  slash: [Keyboard.code("KeyJ")],
  dash: [Keyboard.code("Space"), Keyboard.code("ShiftLeft"), Keyboard.code("ShiftRight")],
  parry: [Keyboard.code("KeyK")],
  special: [Keyboard.code("KeyQ"), Keyboard.code("KeyL")],
  interact: [Keyboard.code("KeyE")],
  pause: ["Escape", Keyboard.code("KeyP")],
  confirm: ["Enter"]
} as const

export const buttons = {
  slash: ["primary"],
  parry: ["secondary"]
} as const

export const makeControls = (devices: {
  readonly keyboard: Keyboard.Actions<typeof keys>
  readonly mouse: Pointer.Actions<typeof buttons>
}) => Actions.merge({ desktop: Actions.group(devices) })

export const idleInput = () => Actions.idle({ keyboard: Keyboard.idle(keys), mouse: Pointer.idle(buttons) })

export const ControlsInput = Descriptor.Service<InputCapture.SourceOf<ReturnType<typeof makeControls>>>()("Game/Controls")
