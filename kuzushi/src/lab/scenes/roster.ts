import { bossIds, DOOR, doorLine, enemyKinds, isBoss, onSide, SIDE_DIRS, Tuning, zoneOf } from "../../sim/index.ts"
import type { ArenaLayout, EnemyKind, GameView, Point, Side, ZoneId } from "../../sim/index.ts"
import { isOneOf } from "../choose.ts"
import type { Control, LabTools } from "../scene.ts"
import type { Ink, Sketch } from "../sketch.ts"

/** Up the screen: where the player faces when a scene starts. */
export const NORTH = -Math.PI / 2

export const NAMES: Readonly<Record<EnemyKind, string>> = {
  chaser: "Chaser",
  shooter: "Shooter",
  bruiser: "Bruiser",
  trickster: "Trickster",
  orbiter: "Orbiter",
  warden: "Warden",
  lancer: "Lancer",
  splitter: "Splitter",
  splitling: "Splitling",
  sweeper: "Sweeper",
  pulsar: "Pulsar",
  leaper: "Leaper",
  cutter: "Cutter",
  gatekeeper: "Gatekeeper",
  orrery: "Orrery",
  sunder: "Sunder"
}

/** What each kind does, in a line (docs/DESIGN.md, Enemies). */
export const BEHAVIOUR: Readonly<Record<EnemyKind, string>> = {
  chaser: "Rushes in and lunges along a short line; touching it hurts.",
  shooter: "Keeps 6 to 9.5 units away and fires bursts of three orbs.",
  bruiser: "Slow and armoured; slams everything inside a ring.",
  trickster: "Orbits, blinks beside you, sometimes feints, then dashes.",
  orbiter: "Circles you, tightening, then cuts straight through.",
  warden: "Fires a spiral volley; shelled while it fires, open after.",
  lancer: "Locks a long aim line, then charges its full length.",
  splitter: "Lunges; splits into two splitlings when killed.",
  splitling: "Small and fast; lunges, and touching it hurts.",
  sweeper: "Plants, marks an arc, then sweeps its arm round it.",
  pulsar: "Sends out a ring wave with one gap; pillars block it.",
  leaper: "Jumps; its landing ring follows you, stops, then it lands.",
  cutter: "Draws a seam along a line that burns for 2 s.",
  gatekeeper: "Zone 1 boss: slams, charges into walls, fires fans.",
  orrery: "Zone 2 boss: spiral volleys, moon cuts, sweeping hands.",
  sunder: "Zone 3 boss: needles, lunges and leaps; splits in two."
}

/** What an elite changes, in a line (docs/DESIGN.md, Enemies). */
export const ELITE_NOTE = "Elite: 3× health, 1.3× size, half the knockback, quicker windups."

/** Each kind as the wave tables write it: C3 is three chasers. */
const CODES: Readonly<Record<EnemyKind, string>> = {
  chaser: "C",
  shooter: "S",
  bruiser: "B",
  trickster: "T",
  orbiter: "O",
  warden: "W",
  lancer: "La",
  splitter: "Sp",
  splitling: "Sl",
  sweeper: "Sw",
  pulsar: "P",
  leaper: "Le",
  cutter: "Cu",
  gatekeeper: "Gatekeeper",
  orrery: "Orrery",
  sunder: "Sunder"
}

/** A wave as the wave tables write it: kinds in order with their counts, an elite after an E. */
export const waveCode = (wave: ReadonlyArray<{ readonly kind: EnemyKind; readonly elite: boolean }>): string => {
  const counts = new Map<string, number>()
  for (const each of wave) {
    const code = `${each.elite ? "E" : ""}${CODES[each.kind]}`
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts].map(([code, count]) => `${code}${count}`).join(" ")
}

/** Every kind that isn't a boss, in roster order. */
const regularKinds: ReadonlyArray<EnemyKind> = enemyKinds.filter((kind) => !isBoss(kind))

/** A zone's kinds in the gallery's order: its four, a splitter's splitling after it, then its boss. */
export const zoneKinds = (zone: ZoneId): ReadonlyArray<EnemyKind> => {
  const { roster, boss } = zoneOf(zone)
  return [...roster.flatMap((kind): ReadonlyArray<EnemyKind> => (kind === "splitter" ? ["splitter", "splitling"] : [kind])), boss]
}

export const kindChoices = regularKinds.map((kind) => ({ value: kind, label: NAMES[kind] }))

/** A zone's four kinds as choices. */
export const rosterChoices = (zone: ZoneId) => zoneOf(zone).roster.map((kind) => ({ value: kind, label: NAMES[kind] }))

export const bossChoices = bossIds.map((boss) => ({ value: boss, label: NAMES[boss] }))

export const isKind = isOneOf(enemyKinds)

export const isBossId = isOneOf(bossIds)

/** The angle from one ground point to another. */
export const facingTo = (from: Point, to: Point): number => Math.atan2(to.z - from.z, to.x - from.x)

/** `count` points evenly round a circle, the first straight up the screen. */
export const ringAround = (centre: Point, count: number, radius: number): ReadonlyArray<Point> =>
  Array.from({ length: count }, (_, index) => {
    const angle = NORTH + (index / count) * Math.PI * 2
    return { x: centre.x + Math.cos(angle) * radius, z: centre.z + Math.sin(angle) * radius }
  })

/** How fast a kind's lunge, cut or charge runs, or null for kinds whose attack is orbs or a slam. */
export const lungeSpeedOf = (kind: EnemyKind): number | null => {
  switch (kind) {
    case "chaser": return Tuning.CHASER.lungeSpeed
    case "trickster": return Tuning.TRICKSTER.dashSpeed
    case "orbiter": return Tuning.ORBITER.cutSpeed
    case "lancer": return Tuning.LANCER.chargeSpeed
    case "splitter": return Tuning.SPLITTER.lungeSpeed
    case "splitling": return Tuning.SPLITLING.lungeSpeed
    case "shooter":
    case "bruiser":
    case "warden":
    case "sweeper":
    case "pulsar":
    case "leaper":
    case "cutter":
    case "gatekeeper":
    case "orrery":
    case "sunder":
      return null
  }
}

/** A distance each kind attacks well from: inside its lunge, its slam or its firing band. */
export const reachOf: Readonly<Record<EnemyKind, number>> = {
  chaser: 3.2,
  shooter: 7,
  bruiser: 2.2,
  trickster: 4,
  orbiter: 4.5,
  warden: 7,
  lancer: 8,
  splitter: 2.8,
  splitling: 2.2,
  sweeper: 2.4,
  pulsar: 7,
  leaper: 7,
  cutter: 7,
  gatekeeper: 3.5,
  orrery: 7,
  sunder: 6
}

/** A value that settles: `touch` on every change, `due` once it has held still for `delay` seconds. */
export const settler = (delay: number) => {
  let at = Number.POSITIVE_INFINITY
  return {
    touch: () => {
      at = performance.now() / 1000 + delay
    },
    due: (): boolean => {
      if (performance.now() / 1000 < at) return false
      at = Number.POSITIVE_INFINITY
      return true
    }
  }
}

/** Whether any door of the room the player is in is sealed. */
export const sealed = (view: GameView): boolean => view.room?.doors.some((door) => door.state === "locked") ?? false

/** The control that shuts the room's seals or breaks them. */
export const sealsToggle = (tools: LabTools): Control => ({
  kind: "toggle",
  label: "Seals shut",
  get: () => sealed(tools.context.game.view()),
  set: (on) => tools.game.lockDoors(on)
})

/** A doorway's marks: the line past which a walk out starts the transition, then the arrow where a player arrives. */
export const drawDoorway = (sketch: Sketch, layout: ArenaLayout, side: Side, trigger: Ink, arrow: Ink) => {
  const line = doorLine(layout, side)
  const half = DOOR.width / 2
  sketch.path([onSide(side, line + DOOR.trigger, -half), onSide(side, line + DOOR.trigger, half)], trigger)
  const arrival = onSide(side, line - DOOR.arrival)
  sketch.arrow(arrival.x, arrival.z, Math.atan2(-SIDE_DIRS[side].z, -SIDE_DIRS[side].x), 0.5, arrow)
}
