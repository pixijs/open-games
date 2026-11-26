import type { FrameTime } from "../host/types.ts"

/** Effects, cloth and flicker move on twos: twelve drawings a second. */
export const DRAWINGS = 12

/** True on alternate drawings: flicker on twos. */
export const onTwos = (frame: FrameTime) => Math.floor(frame.elapsed * DRAWINGS) % 2 === 0

/** A step through drawings: the value at each drawing of a short hand-timed move, held on its last. */
export const keyed = (drawing: number, keys: ReadonlyArray<number>): number => keys[Math.max(0, Math.min(keys.length - 1, drawing))] ?? 0
