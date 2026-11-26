import { describe, expect, test } from "vitest"

import { keyAction, opened, pointed, stepped } from "../src/ui/cursor.ts"

const PAUSE = ["Resume", "Restart", "Controls", "Quit to title"] as const

/** What Enter chooses after `events` in a freshly opened pause menu. */
const enterAfter = (events: ReadonlyArray<{ readonly over: number; readonly dx: number; readonly dy: number } | string>) => {
  let cursor = opened
  for (const event of events) {
    if (typeof event !== "string") cursor = pointed(cursor, event.over, event.dx, event.dy)
    else {
      const action = keyAction(event)
      if (action !== null && action !== "choose") cursor = stepped(cursor, action.move, PAUSE.length)
    }
  }
  expect(keyAction("Enter")).toBe("choose")
  return PAUSE[cursor.active]
}

describe("menu cursor", () => {
  test("a pause menu opening under a resting cursor still resumes on Enter", () => {
    expect(enterAfter([{ over: 1, dx: 0, dy: 0 }, { over: 1, dx: 0, dy: 0 }])).toBe("Resume")
  })

  test("the pointer selects once it moves", () => {
    expect(enterAfter([{ over: 1, dx: 0, dy: 0 }, { over: 1, dx: 0, dy: 3 }])).toBe("Restart")
    expect(enterAfter([{ over: 2, dx: 2, dy: 0 }, { over: 2, dx: 0, dy: 0 }])).toBe("Controls")
  })

  test("keys move the highlight from the first option, wrapping", () => {
    expect(enterAfter(["ArrowDown"])).toBe("Restart")
    expect(enterAfter(["ArrowUp"])).toBe("Quit to title")
    expect(enterAfter([{ over: 2, dx: 0, dy: 0 }, "KeyS"])).toBe("Restart")
  })
})
