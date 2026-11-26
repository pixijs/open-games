import { describe, expect, it } from "vitest"

import { formatTime } from "../src/ui/format.ts"

describe("formatTime", () => {
  it("shows minutes, seconds and hundredths, never rounding up into the next second", () => {
    expect(formatTime(0)).toBe("00:00.00")
    expect(formatTime(137.4)).toBe("02:17.40")
    expect(formatTime(59.999)).toBe("00:59.99")
  })
})
