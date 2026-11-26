import { enemyKinds, sizeOf, wave } from "../tuning.ts"
import type { EnemyKind, WaveEntry } from "../tuning.ts"
import type { ZoneId } from "../zones.ts"

/** How hard a wave entry is: a room draws its waves' tiers from its depth. */
export type Tier = "light" | "medium" | "heavy"

/** Each zone's wave entries in three tiers (docs/DESIGN.md, Waves in rooms). Only the zone's own four kinds. */
export const POOLS = {
  courtyard: {
    light: [wave({ chaser: 3 }), wave({ chaser: 2, shooter: 1 }), wave({ chaser: 2, trickster: 1 }), wave({ shooter: 2, chaser: 1 })],
    medium: [
      wave({ chaser: 3, shooter: 2 }),
      wave({ chaser: 2, shooter: 1, bruiser: 1 }),
      wave({ chaser: 2, trickster: 2 }),
      wave({ shooter: 2, bruiser: 1, chaser: 1 }),
      wave({ chaser: 3, trickster: 1, shooter: 1 })
    ],
    heavy: [
      wave({ chaser: 3, shooter: 2, bruiser: 1 }),
      wave({ chaser: 2, shooter: 2, trickster: 2 }),
      wave({ chaser: 3, bruiser: 1, trickster: 2 }),
      wave({ shooter: 3, bruiser: 1, trickster: 1 }),
      wave({ chaser: 4, shooter: 2, bruiser: 1 })
    ]
  },
  spiral: {
    light: [wave({ orbiter: 2, sweeper: 1 }), wave({ orbiter: 3 }), wave({ sweeper: 2, pulsar: 1 }), wave({ orbiter: 2, pulsar: 1 })],
    medium: [
      wave({ orbiter: 3, sweeper: 1 }),
      wave({ orbiter: 2, warden: 1 }),
      wave({ sweeper: 2, pulsar: 1, orbiter: 1 }),
      wave({ orbiter: 2, pulsar: 2 }),
      wave({ warden: 1, sweeper: 2 })
    ],
    heavy: [
      wave({ orbiter: 3, warden: 1, sweeper: 1 }),
      wave({ orbiter: 2, pulsar: 2, sweeper: 1 }),
      wave({ warden: 2, orbiter: 2 }),
      wave({ orbiter: 3, sweeper: 2, pulsar: 1 }),
      wave({ warden: 1, pulsar: 2, orbiter: 2 })
    ]
  },
  void: {
    light: [wave({ lancer: 2, splitter: 1 }), wave({ splitter: 2, leaper: 1 }), wave({ lancer: 1, cutter: 1, splitter: 1 }), wave({ leaper: 2, lancer: 1 })],
    medium: [
      wave({ lancer: 2, splitter: 2 }),
      wave({ leaper: 2, cutter: 1, lancer: 1 }),
      wave({ splitter: 2, cutter: 1, leaper: 1 }),
      wave({ lancer: 3, leaper: 1 }),
      wave({ cutter: 2, splitter: 2 })
    ],
    heavy: [
      wave({ lancer: 3, splitter: 2, leaper: 1 }),
      wave({ leaper: 2, cutter: 2, splitter: 1 }),
      wave({ lancer: 2, splitter: 3, cutter: 1 }),
      wave({ lancer: 3, leaper: 2, cutter: 1 }),
      wave({ splitter: 3, leaper: 2, lancer: 1 })
    ]
  }
} as const satisfies Record<ZoneId, Record<Tier, ReadonlyArray<WaveEntry>>>

/** The tiers a room's waves are drawn from, by its depth: deeper rooms fight more waves of harder entries. */
export const tiersOf = (depth: number): ReadonlyArray<Tier> => {
  if (depth <= 1) return ["light"]
  if (depth === 2) return ["light", "medium"]
  if (depth === 3) return ["medium", "medium"]
  if (depth === 4) return ["medium", "medium", "heavy"]
  return ["medium", "heavy", "heavy"]
}

/** One enemy of a wave as it appears; `elite` marks an elite room's elite. */
export interface WaveSlot {
  readonly kind: EnemyKind
  readonly elite: boolean
}

/** The order a wave's enemies appear in: the kinds taken in turn (`enemyKinds` order), so a wave never opens with all of one kind. */
export const rosterOf = (entry: WaveEntry): ReadonlyArray<EnemyKind> => {
  const left = { ...entry }
  const roster: Array<EnemyKind> = []
  const total = sizeOf(entry)
  while (roster.length < total) {
    for (const kind of enemyKinds) {
      if (left[kind] <= 0) continue
      left[kind] -= 1
      roster.push(kind)
    }
  }
  return roster
}

/** An elite room's last wave: two of the zone's first kind as escorts, then the elite. */
export const eliteWave = (escort: EnemyKind, elite: EnemyKind): ReadonlyArray<WaveSlot> => [
  { kind: escort, elite: false },
  { kind: escort, elite: false },
  { kind: elite, elite: true }
]
