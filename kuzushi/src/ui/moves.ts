import type { Shape } from "./icons.ts"

export interface Move {
  readonly name: string
  readonly shape: Shape
  readonly keys: ReadonlyArray<string>
  readonly note: string
}

/** The four moves, with the boards' diamond, circle, triangle and square. */
export const MOVES: ReadonlyArray<Move> = [
  { name: "Dash", shape: "diamond", keys: ["Space", "Shift"], note: "Invulnerable while dashing; passes through enemies." },
  { name: "Attack", shape: "circle", keys: ["J", "L-Click"], note: "Plays the weapon in hand; hold with darts to charge." },
  { name: "Parry", shape: "triangle", keys: ["K", "R-Click"], note: "Stuns melee attackers; reflects orbs back." },
  { name: "Special", shape: "square", keys: ["Q", "L"], note: "Needs full FOCUS; strikes every enemy near you." }
]

/** How to move, aim, take a weapon, see the map and pause. */
export const BINDINGS: ReadonlyArray<readonly [name: string, keys: ReadonlyArray<string>]> = [["Move", ["WASD"]], ["Aim", ["Mouse"]], ["Take", ["E"]], ["Map", ["Tab", "M"]], ["Pause", ["Esc"]]]
