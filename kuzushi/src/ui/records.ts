import { zoneIds } from "../sim/index.ts"
import type { Rank, ZoneId } from "../sim/index.ts"

/** The best full run (started in zone 1 and won): the fastest time and the best rank, which may come from different runs. */
export interface RunRecord {
  readonly time: number
  readonly rank: Rank
}

/** What this device keeps: the zones a run has reached, each zone's best clear time, and the best full run. */
export interface Records {
  readonly reached: ReadonlyArray<ZoneId>
  readonly zones: Readonly<Partial<Record<ZoneId, number>>>
  readonly run: RunRecord | null
}

const KEY = "kuzushi.records.v2"
const RANKS: ReadonlyArray<Rank> = ["S", "A", "B", "C"]
const EMPTY: Records = { reached: ["courtyard"], zones: {}, run: null }

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
const field = (value: object, key: string): unknown => (key in value ? (value as Record<string, unknown>)[key] : undefined)

const parse = (stored: unknown): Records => {
  if (typeof stored !== "object" || stored === null) return EMPTY
  const reached = field(stored, "reached")
  const zones = field(stored, "zones")
  const run = field(stored, "run")
  const list: ReadonlyArray<unknown> = Array.isArray(reached) ? reached : []
  const times = typeof zones === "object" && zones !== null ? zones : {}
  const runRank = typeof run === "object" && run !== null ? RANKS.find((each) => each === field(run, "rank")) : undefined
  const runTime = typeof run === "object" && run !== null ? field(run, "time") : undefined
  return {
    reached: zoneIds.filter((id) => id === "courtyard" || list.includes(id)),
    zones: Object.fromEntries(zoneIds.flatMap((id) => {
      const best = field(times, id)
      return isTime(best) ? [[id, best]] : []
    })),
    run: runRank !== undefined && isTime(runTime) ? { time: runTime, rank: runRank } : null
  }
}

/** The records kept in localStorage; zone 1 open and nothing else when storage is blocked or holds something else. */
export const readRecords = (): Records => {
  try {
    return parse(JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}"))
  } catch {
    return EMPTY
  }
}

const write = (records: Records): void => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(records))
  } catch {
    // Storage blocked or full: the run is shown but not kept.
  }
}

/** A run has reached `zone`: it opens for practice starts. */
export const markReached = (zone: ZoneId): void => {
  const records = readRecords()
  if (!records.reached.includes(zone)) write({ ...records, reached: zoneIds.filter((id) => id === zone || records.reached.includes(id)) })
}

/** Keeps `time` as `zone`'s best clear if it is faster. Returns the best now kept. */
export const recordZone = (zone: ZoneId, time: number): number => {
  const records = readRecords()
  const best = Math.min(records.zones[zone] ?? Number.POSITIVE_INFINITY, time)
  write({ ...records, zones: { ...records.zones, [zone]: best } })
  return best
}

/** Keeps a won full run if it beats the stored time or rank. Returns the record now kept. */
export const recordRun = (time: number, rank: Rank): RunRecord => {
  const records = readRecords()
  const before = records.run
  const best: RunRecord = before === null
    ? { time, rank }
    : { time: Math.min(before.time, time), rank: RANKS.indexOf(rank) < RANKS.indexOf(before.rank) ? rank : before.rank }
  write({ ...records, run: best })
  return best
}
