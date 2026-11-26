import { Keyboard } from "@typeonce/ritmo-browser"

/**
 * The lab's keys. None is a game key (WASD and the arrows, J, K, Q, L, E, Space, Shift, Tab, M), so every scene stays playable;
 * Esc, P and Enter are held back from the game's pause and confirm while the lab is open (P pauses the lab instead).
 */
export const labBindings = {
  back: ["Escape"],
  fold: [Keyboard.code("Backquote")],
  pause: [Keyboard.code("KeyF"), Keyboard.code("KeyP")],
  step: [Keyboard.code("Period")],
  slower: [Keyboard.code("BracketLeft")],
  faster: [Keyboard.code("BracketRight")],
  replay: [Keyboard.code("KeyR")],
  hitboxes: [Keyboard.code("KeyB")],
  invulnerable: [Keyboard.code("KeyI")],
  ai: [Keyboard.code("KeyN")],
  hud: [Keyboard.code("KeyU")],
  post: [Keyboard.code("KeyX")],
  camera: [Keyboard.code("KeyC")],
  floor: [Keyboard.code("KeyG")],
  zone: [Keyboard.code("KeyZ")],
  scene1: [Keyboard.code("Digit1")],
  scene2: [Keyboard.code("Digit2")],
  scene3: [Keyboard.code("Digit3")],
  scene4: [Keyboard.code("Digit4")],
  scene5: [Keyboard.code("Digit5")],
  scene6: [Keyboard.code("Digit6")],
  scene7: [Keyboard.code("Digit7")],
  scene8: [Keyboard.code("Digit8")],
  scene9: [Keyboard.code("Digit9")],
  scene10: [Keyboard.code("Digit0")]
} as const

export type LabAction = keyof typeof labBindings

export const LAB_ACTIONS = Object.keys(labBindings) as ReadonlyArray<LabAction>

/** The keys a scene's own controls take, in order. */
export const SCENE_KEYS = ["scene1", "scene2", "scene3", "scene4", "scene5", "scene6", "scene7", "scene8", "scene9", "scene10"] as const satisfies ReadonlyArray<LabAction>

const NAMES: Readonly<Record<string, string>> = { Escape: "Esc", Backquote: "`", Period: ".", BracketLeft: "[", BracketRight: "]" }

/** How an action's first key is printed on its keycap. */
export const keyName = (action: LabAction): string => {
  const first = labBindings[action][0]
  const code = typeof first === "string" ? first : first.code
  return NAMES[code] ?? code.replace(/^(Key|Digit)/, "")
}
