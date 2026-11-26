import type { Block, Pillar, Point } from "../../arena.ts"
import { room } from "../plan.ts"
import type { RoomTemplate, TemplateRole } from "../plan.ts"

/**
 * The Courtyard's rooms: rectangular stone floors of 2-unit tiles inside a wall 2 thick and 1.1 high, each doorway a
 * 3-wide gap through it. Cover is blocks and round pillars (docs/DESIGN.md, Courtyard rooms).
 */

const block = (x: number, z: number, width: number, depth: number, height: number): Block =>
  ({ x, z, halfWidth: width / 2, halfDepth: depth / 2, height })

const pillar = (x: number, z: number, radius: number, height: number): Pillar => ({ x, z, radius, height })

interface Yard {
  readonly role: TemplateRole
  readonly name: string
  readonly width: number
  readonly depth: number
  readonly blocks?: ReadonlyArray<Block>
  readonly pillars?: ReadonlyArray<Pillar>
  readonly altars?: ReadonlyArray<Point>
  readonly spring?: Point
  readonly bossOffset?: number
}

const yard = (plan: Yard): RoomTemplate => room({
  zone: "courtyard",
  role: plan.role,
  name: plan.name,
  halfWidth: plan.width / 2,
  halfDepth: plan.depth / 2,
  wall: 2,
  wallHeight: 1.1,
  tile: 2,
  floor: { kind: "rect" },
  blocks: plan.blocks ?? [],
  pillars: plan.pillars ?? [],
  altars: plan.altars ?? [],
  spring: plan.spring ?? null,
  bossOffset: plan.bossOffset ?? 0,
  hazard: { kind: "none" }
})

export const COURTYARD_ROOMS = {
  "courtyard.forecourt": yard({
    role: "start",
    name: "Forecourt",
    width: 24,
    depth: 16,
    blocks: [block(-7, -5.5, 2, 1.4, 1.2), block(7, -5.5, 2, 1.4, 1.2)],
    altars: [{ x: -5, z: 1 }, { x: 0, z: -1.5 }, { x: 5, z: 1 }]
  }),
  "courtyard.shrine": yard({
    role: "shrine",
    name: "Shrine",
    width: 20,
    depth: 14,
    pillars: [pillar(-6, -3.5, 0.7, 3.5), pillar(6, -3.5, 0.7, 3.5), pillar(-6, 3.5, 0.7, 3.5), pillar(6, 3.5, 0.7, 3.5)],
    altars: [{ x: -3, z: 0 }, { x: 3, z: 0 }],
    spring: { x: 0, z: 0 }
  }),
  "courtyard.yard": yard({
    role: "small",
    name: "Yard",
    width: 24,
    depth: 16,
    blocks: [block(-6, -3, 3.2, 3.2, 3), block(6.5, 3, 4, 2.4, 2.2)],
    pillars: [pillar(4, -3.5, 0.8, 4.5)]
  }),
  "courtyard.cloister": yard({
    role: "medium",
    name: "Cloister",
    width: 30,
    depth: 20,
    blocks: [block(-11, -6, 2.8, 2.8, 2.5), block(11, 6, 2.8, 2.8, 2.5)],
    pillars: [pillar(-6, -4.5, 0.8, 5), pillar(6, -4.5, 0.8, 5), pillar(-6, 4.5, 0.8, 5), pillar(6, 4.5, 0.8, 5)]
  }),
  "courtyard.gate": yard({
    role: "medium",
    name: "Gate",
    width: 28,
    depth: 20,
    blocks: [block(-5.5, 0, 6, 1.4, 1.4), block(5.5, 0, 6, 1.4, 1.4)],
    pillars: [pillar(0, -5, 0.9, 5), pillar(0, 5, 0.9, 5)]
  }),
  "courtyard.court": yard({
    role: "large",
    name: "Court",
    width: 36,
    depth: 24,
    blocks: [
      block(-12.5, -7, 3.2, 3.2, 3.0),
      block(12, 6.5, 4, 2.8, 2.2),
      block(-14, 6.5, 2.4, 4.4, 4.5),
      block(13.5, -7.5, 2.8, 2.8, 5.0),
      block(-6, -9.5, 5, 1.4, 1.4),
      block(6, 9.5, 4, 1.6, 1.2),
      block(8, 1.5, 2, 2, 1.8)
    ],
    pillars: [
      pillar(-6.5, -4.5, 0.85, 5.5),
      pillar(5.5, -5.5, 0.7, 4.0),
      pillar(-5.5, 6, 0.7, 3.5),
      pillar(16, -5, 1.0, 6.5),
      pillar(-16, 4.5, 1.0, 6.5)
    ]
  }),
  "courtyard.great": yard({
    role: "boss",
    name: "Great Court",
    width: 36,
    depth: 26,
    pillars: [pillar(-10, -6.5, 1.1, 6), pillar(10, -6.5, 1.1, 6), pillar(-10, 6.5, 1.1, 6), pillar(10, 6.5, 1.1, 6)],
    bossOffset: 4
  })
} as const satisfies Record<`courtyard.${string}`, RoomTemplate>
