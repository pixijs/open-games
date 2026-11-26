import { HostClock } from "@typeonce/ritmo"
import { Keyboard, Pointer } from "@typeonce/ritmo-browser"
import type { Lint } from "@typeonce/ritmo-devtools"

import { buttons, Intents, keys, makeControls, makeHeadlessRuntime, update } from "./sim/index.ts"
import type { GameSchema, Root } from "./sim/index.ts"

export const lintTarget = async (): Promise<Lint.Target<GameSchema, typeof Root>> => {
  const { render } = await import("./render/index.ts")
  const made = makeHeadlessRuntime({
    controls: makeControls({ keyboard: Keyboard.scripted(keys, []), mouse: Pointer.scripted(buttons, []) }),
    debug: { hostClock: HostClock.test() }
  })
  if (!made.ok) throw new Error("The headless runtime could not start")
  return { runtime: made.value, schedules: { update }, describe: { render }, hostEvents: [Intents] }
}
