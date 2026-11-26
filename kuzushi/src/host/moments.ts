import type { Moment, MomentOf, MomentType } from "../sim/index.ts"
import type { MomentBus } from "./types.ts"

const isType = <T extends MomentType>(moment: Moment, type: T): moment is MomentOf<T> => moment.type === type

/** Collects moments after every fixed step and hands them out once per drawn frame. */
export const makeMomentBus = () => {
  let pending: Array<Moment> = []
  const handlers = new Set<(moment: Moment) => void>()
  const bus: MomentBus = {
    on: (type, handler) => {
      const listener = (moment: Moment) => {
        if (isType(moment, type)) handler(moment)
      }
      handlers.add(listener)
      return () => {
        handlers.delete(listener)
      }
    }
  }
  return {
    bus,
    push: (moments: ReadonlyArray<Moment>) => {
      pending.push(...moments)
    },
    /** Calls every handler with the moments collected since the last flush. */
    flush: () => {
      const frame = pending
      pending = []
      for (const moment of frame) for (const handler of handlers) handler(moment)
    }
  }
}
