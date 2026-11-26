import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { markReached, readRecords, recordRun, recordZone } from "../src/ui/records.ts"

const memory = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
}

describe("records", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memory()))
  afterEach(() => vi.unstubAllGlobals())

  it("opens zone 1 only until a run reaches another zone", () => {
    expect(readRecords().reached).toEqual(["courtyard"])
    markReached("void")
    expect(readRecords().reached).toEqual(["courtyard", "void"])
  })

  it("keeps each zone's fastest clear", () => {
    expect(recordZone("spiral", 300)).toBe(300)
    expect(recordZone("spiral", 420)).toBe(300)
    expect(recordZone("spiral", 250)).toBe(250)
    expect(readRecords().zones).toEqual({ spiral: 250 })
  })

  it("keeps the best full run's time and rank, which may come from different runs", () => {
    recordRun(900, "B")
    expect(recordRun(1000, "A")).toEqual({ time: 900, rank: "A" })
  })

  it("reads nothing but zone 1 from storage that holds something else, or none at all", () => {
    localStorage.setItem("kuzushi.records.v2", "{\"reached\":7,\"zones\":{\"void\":-3},\"run\":{\"rank\":\"Z\"}}")
    expect(readRecords()).toEqual({ reached: ["courtyard"], zones: {}, run: null })
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } })
    expect(readRecords().reached).toEqual(["courtyard"])
    expect(recordZone("courtyard", 12)).toBe(12)
  })
})
