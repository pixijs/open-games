import { CHAINS, chainLength, Tuning, WEAPON_LIST, weaponIds, zoneOf } from "../../sim/index.ts"
import type { ComboStep, GameView, WeaponId, WeaponMove } from "../../sim/index.ts"
import { oneOf } from "../choose.ts"
import { attackFrame, MOVE_LABELS, toSeconds, toSteps } from "../frames.ts"
import type { Scene } from "../scene.ts"
import type { Tone } from "../timeline.ts"
import { facingTo, NORTH, rosterChoices } from "./roster.ts"

const { DARTS, DASH, MOVE, PARRY } = Tuning

/**
 * What a control plays: one press of the chain at `step`, the whole chain pressed on its cancel points, `count` darts
 * on their cadence, the pierce held to a perfect release, or a dash or parry.
 */
type Play =
  | { readonly kind: "press"; readonly step: ComboStep }
  | { readonly kind: "chain" }
  | { readonly kind: "volley"; readonly count: number }
  | { readonly kind: "pierce" }
  | { readonly kind: "dash" }
  | { readonly kind: "parry" }

interface Action {
  readonly id: string
  readonly label: string
  readonly play: Play
}

const STEPS: ReadonlyArray<ComboStep> = [1, 2, 3]

/** Each weapon's moves alone (by the chain press that plays them), its whole chain, then the dash and parry every weapon has. */
const actionsOf = (weapon: WeaponId): ReadonlyArray<Action> => {
  const chain: ReadonlyArray<WeaponMove> = CHAINS[weapon]
  const moves = chain.flatMap((move, index): ReadonlyArray<Action> =>
    chain.indexOf(move) === index ? [{ id: move, label: MOVE_LABELS[move], play: { kind: "press", step: STEPS[index] ?? 1 } }] : [])
  const own: ReadonlyArray<Action> = weapon === "darts"
    ? [...moves, { id: "volley", label: "Three darts", play: { kind: "volley", count: 3 } }, { id: "pierce", label: "Pierce", play: { kind: "pierce" } }]
    : [...moves, { id: "chain", label: "Full chain", play: { kind: "chain" } }]
  return [...own, { id: "dash", label: "Dash", play: { kind: "dash" } }, { id: "parry", label: "Parry", play: { kind: "parry" } }]
}

const LANES = [{ id: "step", label: "Move" }, { id: "phase", label: "Phase" }, { id: "hits", label: "Hits" }] as const

/** Gameplay steps a looping action rests between plays. */
const REST_STEPS = 27

/** How long the pierce is held: the dart, the charge, and four steps into the perfect window. */
const PIERCE_HOLD = toSeconds(MOVE.dart.windup.steps + MOVE.dart.active.steps + MOVE.dart.recover.steps + DARTS.charge.steps + 4)

/** An arc's whole width in degrees, from its half angle in radians. */
const arcDegrees = (halfAngle: number) => Math.round((halfAngle * 360) / Math.PI)

const framesOf = (move: WeaponMove) => {
  const spec = MOVE[move]
  return { label: "Frames", value: `${spec.windup.steps} windup · ${spec.active.steps} active · ${spec.recover.steps} recover` }
}

const shapeOf = (move: WeaponMove) => {
  const spec = MOVE[move]
  const blow = `${spec.damage} dmg · stop ${spec.hitStop.steps} f`
  switch (spec.kind) {
    case "arc": return { label: "Shape", value: `${spec.range} u · ${arcDegrees(spec.halfAngle)}° · ${blow}` }
    case "slam": return { label: "Shape", value: `r ${spec.radius} · hop ${spec.reach.min}–${spec.reach.max} u · ${blow}` }
    case "shot": return { label: "Shape", value: `${spec.speed} u/s · ${spec.reach} u · ${blow}${spec.close === null ? "" : ` · ${spec.close.damage} within ${spec.close.range} u`}` }
    case "cast": return { label: "Shape", value: `r ${spec.radius} · lands ${spec.delay.steps} f · ${blow}` }
  }
}

/** The tuning numbers behind each action. */
const frameData = (weapon: WeaponId, action: Action, view: GameView) => {
  const play = action.play
  switch (play.kind) {
    case "press": {
      const move = CHAINS[weapon][play.step - 1] ?? "cut"
      const spec = MOVE[move]
      const last = play.step >= chainLength(weapon)
      return [framesOf(move), shapeOf(move), { label: "Chain", value: last ? "Ends the chain" : `Next from frame ${spec.windup.steps + spec.active.steps + spec.cancel.steps + 1}` }]
    }
    case "chain": {
      const chain: ReadonlyArray<WeaponMove> = CHAINS[weapon]
      const parts = chain.map((move, index) => {
        const spec = MOVE[move]
        return spec.windup.steps + spec.active.steps + (index === chain.length - 1 ? spec.recover.steps : spec.cancel.steps)
      })
      return [
        { label: "Frames", value: `${parts.join(" + ")} = ${parts.reduce((sum, each) => sum + each, 0)}` },
        { label: "Chain", value: chain.map((move) => MOVE_LABELS[move]).join(" → ") }
      ]
    }
    case "volley": return [framesOf("dart"), shapeOf("dart"), { label: "Clip", value: `${view.weapon.ammo?.loaded ?? 0}/${DARTS.clip} · reload ${DARTS.reloadAfter.steps} f, then every ${DARTS.reloadEvery.steps} f` }]
    case "pierce": return [
      { label: "Frames", value: `charge ${DARTS.charge.steps} · perfect ${DARTS.perfect.steps} · recover ${MOVE.pierce.recover.steps}` },
      shapeOf("pierce"),
      { label: "Perfect", value: `+${DARTS.perfectDamage} dmg · +${DARTS.perfectFocus} FOCUS a hit` }
    ]
    case "dash": {
      const { dashTime, dashDistance } = view.debug.moves
      return [
        { label: "Frames", value: `${toSteps(dashTime)} dash · ${DASH.afterglow.steps} safe after` },
        { label: "Shape", value: `${dashDistance.toFixed(2)} u · cooldown ${DASH.cooldown.steps} f${weapon === "darts" ? " · reloads" : ""}` }
      ]
    }
    case "parry": return [
      { label: "Frames", value: `${PARRY.window.steps} window · ${PARRY.time.steps} stance` },
      { label: "Shape", value: `cooldown ${PARRY.cooldown.steps} f · stuns ${PARRY.stagger.steps} f` }
    ]
  }
}

/** What the timeline's lanes show for the player this step. */
const lanesOf = (view: GameView): { readonly step: readonly [Tone, string] | null; readonly phase: readonly [Tone, string] | null } => {
  const player = view.player
  if (player === null) return { step: null, phase: null }
  const attack = attackFrame(player)
  if (attack !== null) {
    const tone: Tone = attack.phase === "windup" || attack.phase === "charge" ? "windup" : attack.phase === "active" ? "active" : "recover"
    return { step: ["stance", MOVE_LABELS[attack.move]], phase: [tone, attack.phase] }
  }
  if (player.state === "Dash") return { step: ["stance", "Dash"], phase: ["dash", "Dash"] }
  if (player.state === "Parry") return { step: ["stance", "Parry"], phase: player.parryOpen ? ["guard", "Window"] : ["recover", "Stance"] }
  if (player.invulnerable) return { step: null, phase: ["safe", "Safe"] }
  return { step: null, phase: null }
}

const weaponChoices = WEAPON_LIST.map((weapon) => ({ value: weapon.id, label: weapon.name }))

/**
 * The player's attacks against dummies of the zone's kinds in an arc ahead, with any weapon in hand: each move alone,
 * the weapon's whole chain pressed on its cancel points (three darts on their cadence, the pierce held to a perfect
 * release), the dash and the parry, on demand or on a loop, with each move's windup, active and recover frames traced
 * on the timeline and its effects in the zone's accent.
 */
export const attacksScene: Scene = {
  id: "attacks",
  title: "Player attacks",
  summary: "Each weapon's moves, its chain, dash and parry, with frame data.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  create: (tools) => {
    const { game, anchor, timeline } = tools
    const weapon = tools.option("weapon", "blade")
    const kind = tools.option("dummy", "chaser")
    const roster = zoneOf(tools.zone).roster
    const dummy = oneOf(roster, kind.get(), roster[0])
    const count = tools.option("count", 5)
    const distance = tools.option("distance", 2)
    const loop = tools.option("loop", false)
    const last = tools.option("action", "chain")
    const held: WeaponId = oneOf(weaponIds, weapon.get(), "blade")
    const actions = actionsOf(held)
    const fallback: Action = actions[0] ?? { id: "dash", label: "Dash", play: { kind: "dash" } }
    let action: Action | null = null
    let pressed = 0
    let hits = 0
    /** Whether the action has begun (the player left Free), and the step it ended on. */
    let engaged = false
    let endedAt: number | null = null

    game.setWeapon(held)
    game.teleport(anchor.x, anchor.z, NORTH)
    const spread = Math.min((Math.PI * 2) / 3, (count.get() - 1) * (Math.PI / 6))
    for (let index = 0; index < count.get(); index++) {
      const angle = NORTH - spread / 2 + (count.get() === 1 ? spread / 2 : (spread * index) / (count.get() - 1))
      const spot = { x: anchor.x + Math.cos(angle) * distance.get(), z: anchor.z + Math.sin(angle) * distance.get() }
      game.spawn(dummy, spot.x, spot.z, { facing: facingTo(spot, anchor), drill: "dummy" })
    }
    tools.frame({ x: anchor.x, z: anchor.z - distance.get() / 2, radius: held === "sigil" || held === "darts" ? 5.5 : 4.2, side: 0 })
    timeline.setup("Frames · gameplay steps at 60 a second", LANES, 90)

    const play = (next: Action) => {
      const view = tools.context.game.view()
      action = next
      last.set(next.id)
      pressed = 1
      hits = 0
      engaged = false
      endedAt = null
      game.teleport(anchor.x, anchor.z, NORTH)
      timeline.begin(view.tempo.playStep + 1)
      switch (next.play.kind) {
        case "press": game.press("slash", next.play.step); break
        case "chain":
        case "volley": game.press("slash", 1); break
        case "pierce": game.hold(PIERCE_HOLD); break
        case "dash":
          game.steer(1, 0)
          game.press("dash")
          break
        case "parry": game.press("parry"); break
      }
    }

    /** Whether the move playing has gone live and waits for its follow-up press. */
    let armed = false
    /**
     * Presses the chain's next move as each one starts recovering, so the press waits in the buffer for the cancel
     * point (or the next dart's turn) however long the hit-stop held the move.
     */
    const continueChain = (view: GameView) => {
      const now = action?.play
      if (!armed || view.player?.attackPhase !== "recover" || now === undefined || (now.kind !== "chain" && now.kind !== "volley")) return
      armed = false
      if (pressed >= (now.kind === "volley" ? now.count : chainLength(held))) return
      pressed += 1
      game.press("slash")
    }

    tools.on("hit", () => {
      hits += 1
      timeline.mark(tools.context.game.view().tempo.playStep, "hits", "Hit")
    })
    tools.on("dashEnded", () => game.steer(0, 0))
    tools.on("attack", () => {
      armed = true
    })

    return {
      controls: [
        ...actions.map((each) => ({ kind: "action" as const, label: each.label, run: () => play(each) })),
        { kind: "toggle", label: "Loop", get: loop.get, set: loop.set },
        { kind: "choice", label: "Weapon", options: weaponChoices, get: weapon.get, set: (value) => {
          weapon.set(value)
          tools.replay()
        } },
        { kind: "choice", label: "Dummy", options: rosterChoices(tools.zone), get: () => dummy, set: (value) => {
          kind.set(value)
          tools.replay()
        } },
        { kind: "range", label: "Dummies", min: 1, max: 7, step: 1, get: count.get, set: (value) => {
          count.set(value)
          tools.replay()
        }, format: (value) => `${value}` },
        { kind: "range", label: "Distance", min: 1, max: 5, step: 0.1, get: distance.get, set: (value) => {
          distance.set(value)
          tools.replay()
        }, format: (value) => `${value.toFixed(1)} u` }
      ],
      update: (view) => {
        const player = view.player
        if (player === null) return
        game.aim(anchor.x, anchor.z - Math.max(distance.get(), 2.2))
        const lanes = lanesOf(view)
        const step = view.tempo.playStep
        timeline.sample(step, "step", lanes.step?.[0] ?? null, lanes.step?.[1])
        timeline.sample(step, "phase", lanes.phase?.[0] ?? null, lanes.phase?.[1])
        timeline.playhead(step)
        continueChain(view)
        const idle = player.state === "Free" && !player.invulnerable && view.weapon.marks.length === 0
        if (!idle) engaged = true
        if (action !== null && engaged && idle && endedAt === null) endedAt = step
        if (!loop.get() || endedAt === null || step - endedAt < REST_STEPS) return
        play(actions.find((each) => each.id === last.get()) ?? fallback)
      },
      readouts: (view) => {
        const shown = action ?? actions.find((each) => each.id === last.get()) ?? fallback
        return [
          { label: "Action", value: shown.label },
          ...frameData(held, shown, view),
          { label: "Hits", value: `${hits}` }
        ]
      }
    }
  }
}
