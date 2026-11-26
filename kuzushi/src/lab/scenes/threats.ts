import { BOSSES, enemyKinds, homeOf, isBoss, Tuning } from "../../sim/index.ts"
import type { BossId, BossPattern, EnemyKind, EnemyView, GameView, PlayerView } from "../../sim/index.ts"
import { oneOf } from "../choose.ts"
import { toSteps } from "../frames.ts"
import type { Scene } from "../scene.ts"
import type { Tone } from "../timeline.ts"
import { bossChoices, isKind, kindChoices, lungeSpeedOf, NAMES, NORTH, reachOf } from "./roster.ts"

const { ORB, PLAYER, WARDEN } = Tuning

const responses = [
  { value: "stand", label: "Stand" },
  { value: "parry", label: "Parry" },
  { value: "dash", label: "Dash" }
] as const

/** How long before an attack lands the player answers it: inside the parry window, and inside the dash. */
const CUE = { parry: 0.1, dash: 0.07 } as const
/** Gameplay steps between one attack's end and the next on a loop, and from the reset to the order. */
const REST_STEPS = 48
const READY_STEPS = 18

const LANES = [{ id: "enemy", label: "Enemy" }, { id: "player", label: "Player" }, { id: "result", label: "Result" }] as const

const ENEMY_TONES: Partial<Readonly<Record<EnemyView["state"], readonly [Tone, string]>>> = {
  Spawning: ["move", "Appear"],
  Windup: ["telegraph", "Telegraph"],
  Lunge: ["attack", "Lunge"],
  Burst: ["attack", "Burst"],
  Volley: ["attack", "Volley"],
  Recover: ["rest", "Recover"],
  Stagger: ["stagger", "Stagger"],
  Blink: ["safe", "Blink"],
  Sweep: ["attack", "Sweep"],
  Pulse: ["attack", "Pulse"],
  Leap: ["safe", "Leap"],
  Cut: ["attack", "Cut"],
  Quake: ["attack", "Quake"],
  Moons: ["attack", "Moons"],
  Glide: ["move", "Glide"]
}

/** A boss's patterns by phase, as the Pattern control lists them: each phase's own, once. */
const patternsByPhase = (boss: BossId): ReadonlyArray<{ readonly value: string; readonly label: string; readonly phase: number; readonly pattern: BossPattern }> =>
  BOSSES[boss].phases.flatMap((phase, index) => [...new Set(phase.patterns)].map((pattern) => ({
    value: `${index + 1}.${pattern}`,
    label: `${index + 1} · ${pattern}`,
    phase: index + 1,
    pattern
  })))

const playerTone = (player: PlayerView): readonly [Tone, string] | null =>
  player.state === "Parry" ? (player.parryOpen ? ["guard", "Window"] : ["stance", "Stance"])
  : player.state === "Dash" ? ["dash", "Dash"]
  : player.invulnerable ? ["safe", "Safe"]
  : null

/** Seconds until an attack can land on the player: a lunge closing in, a slam about to fall, or an orb on its way. */
const timeToImpact = (view: GameView, enemy: EnemyView, player: PlayerView): number | null => {
  const gap = Math.max(0, Math.hypot(enemy.x - player.x, enemy.z - player.z) - (Tuning.radiusOf(enemy.kind) + 0.1 + PLAYER.radius))
  const speed = lungeSpeedOf(enemy.kind)
  const orbs = view.projectiles.filter((orb) => orb.owner === "enemy").flatMap((orb) => {
    const along = (player.x - orb.x) * orb.dirX + (player.z - orb.z) * orb.dirZ
    const aside = Math.abs((player.x - orb.x) * orb.dirZ - (player.z - orb.z) * orb.dirX)
    const reach = ORB.radius + PLAYER.radius
    if (along <= 0 || aside > reach) return []
    return [(along - Math.sqrt(reach * reach - aside * aside)) / (enemy.kind === "warden" ? WARDEN.orbSpeed : ORB.speed)]
  })
  const nearest = orbs.length > 0 ? Math.min(...orbs) : null
  if (enemy.state === "Lunge" && speed !== null) return gap / speed
  if (enemy.state === "Windup" && enemy.telegraph?.feint !== true) {
    if (enemy.kind === "bruiser") return gap <= Tuning.BRUISER.slamRadius ? enemy.timeLeft : null
    if (speed !== null) return enemy.timeLeft + gap / speed
    if (enemy.telegraph?.shape !== undefined && enemy.telegraph.shape !== "line") return enemy.timeLeft
    if (isBoss(enemy.kind)) return enemy.timeLeft
  }
  return nearest
}

/**
 * One enemy of any kind, or a boss playing one of its patterns in a phase, attacking the player on a loop from a set
 * distance, with the player standing still, parrying or dashing on cue, so each telegraph, attack and answer can be
 * watched and timed on the timeline. Choosing a kind moves the scene to its zone, so it shows in its own colours.
 */
export const threatsScene: Scene = {
  id: "threats",
  title: "Enemy attacks",
  summary: "Any enemy or boss pattern on a loop; parry or dash on cue.",
  defaults: { invulnerable: false, camera: "play" },
  usesAi: true,
  create: (tools) => {
    const { game, anchor, timeline } = tools
    const kindOption = tools.option("kind", "chaser")
    const kind = (): EnemyKind => oneOf(enemyKinds, kindOption.get(), "chaser")
    const distance = tools.option(`distance.${kind()}`, reachOf[kind()])
    const response = tools.option<string>("response", "parry")
    const loop = tools.option("loop", true)
    const picked = kind()
    const patterns = isBoss(picked) ? patternsByPhase(picked) : []
    const patternOption = tools.option(`pattern.${kind()}`, patterns[0]?.value ?? "")
    const pattern = patterns.find((each) => each.value === patternOption.get()) ?? patterns[0]

    const at = { enemy: { x: anchor.x, z: anchor.z - distance.get() / 2 }, player: { x: anchor.x, z: anchor.z + distance.get() / 2 } }
    let id: number | null = null
    let phase: "settle" | "ready" | "attacking" | "rest" = "settle"
    /** The gameplay step the phase began on, and whether the ordered attack has begun. */
    let since = 0
    let engaged = false
    let answered = false
    let result = "Waiting"
    const tally = { parried: 0, nearMiss: 0, hit: 0, missed: 0 }

    game.teleport(at.player.x, at.player.z, NORTH)
    game.spawn(kind(), at.enemy.x, at.enemy.z, { facing: -NORTH, drill: tools.ai ? undefined : "idle" })
    tools.frame({ x: anchor.x, z: anchor.z, radius: Math.max(3.5, distance.get() / 2 + 2.5), side: 0 })
    timeline.setup(`${NAMES[kind()]} · gameplay steps at 60 a second`, LANES, 120)

    const reset = () => {
      if (id === null) return
      game.steer(0, 0)
      game.teleport(at.player.x, at.player.z, NORTH)
      game.teleport(at.enemy.x, at.enemy.z, -NORTH, id)
    }
    const attack = () => {
      if (id === null || tools.ai) return
      const view = tools.context.game.view()
      timeline.begin(view.tempo.playStep)
      answered = false
      engaged = false
      result = "Watching"
      phase = "attacking"
      if (pattern !== undefined) {
        game.bossPhase(pattern.phase)
        game.bossPattern(pattern.pattern)
      }
      game.attack(id)
    }
    const settleResult = (text: string) => {
      result = text
      timeline.mark(tools.context.game.view().tempo.playStep, "result", text, text === "Hit")
    }

    tools.on("enemySpawned", (moment) => {
      if (moment.kind === kind()) id = moment.id
    })
    tools.on("parry", () => {
      tally.parried += 1
      settleResult("Parried")
    })
    tools.on("nearMiss", () => {
      tally.nearMiss += 1
      settleResult("Near miss")
    })
    tools.on("playerHurt", () => {
      tally.hit += 1
      settleResult("Hit")
      game.heal()
    })
    tools.on("dashEnded", () => game.steer(0, 0))

    return {
      controls: [
        { kind: "action", label: "Attack", run: () => {
          reset()
          phase = "ready"
          since = tools.context.game.view().tempo.playStep
        } },
        { kind: "toggle", label: "Loop", get: loop.get, set: loop.set },
        { kind: "choice", label: "Player", options: responses, get: response.get, set: response.set },
        { kind: "choice", label: "Enemy", options: [...kindChoices, ...bossChoices], get: kind, set: (value) => {
          kindOption.set(value)
          if (isKind(value) && homeOf(value) !== tools.zone) tools.setZone(homeOf(value))
          else tools.replay()
        } },
        ...(patterns.length === 0 ? [] : [{ kind: "choice" as const, label: "Pattern", options: patterns, get: () => pattern?.value ?? "", set: (value: string) => {
          patternOption.set(value)
          tools.replay()
        } }]),
        { kind: "range", label: "Distance", min: 1.5, max: 14, step: 0.1, get: distance.get, set: (value) => {
          distance.set(value)
          tools.replay()
        }, format: (value) => `${value.toFixed(1)} u` }
      ],
      update: (view) => {
        const player = view.player
        const enemy = view.enemies.find((each) => each.id === id)
        if (player === null) return
        const step = view.tempo.playStep
        const enemyTone = enemy === undefined ? null : ENEMY_TONES[enemy.state] ?? null
        timeline.sample(step, "enemy", enemyTone?.[0] ?? null, enemyTone?.[1])
        const own = playerTone(player)
        timeline.sample(step, "player", own?.[0] ?? null, own?.[1])
        timeline.playhead(step)
        if (enemy === undefined || tools.ai) return
        switch (phase) {
          case "settle":
            if (enemy.state === "Move") {
              phase = "ready"
              since = step
            }
            return
          case "ready":
            if (step - since >= READY_STEPS && player.state === "Free") attack()
            return
          case "attacking": {
            const impact = timeToImpact(view, enemy, player)
            const answer = response.get()
            if (impact !== null && answer === "parry" && player.state === "Free" && impact <= CUE.parry) {
              game.press("parry")
              timeline.mark(step, "result", "Cue")
            }
            if (impact !== null && answer === "dash" && !answered && impact <= CUE.dash) {
              answered = true
              game.steer(1, 0)
              game.press("dash")
              timeline.mark(step, "result", "Cue")
            }
            if (enemy.state !== "Move") {
              engaged = true
              return
            }
            if (!engaged) return
            if (result === "Watching") {
              tally.missed += 1
              settleResult("Missed")
            }
            phase = "rest"
            since = step
            return
          }
          case "rest":
            if (!loop.get() || step - since < REST_STEPS) return
            reset()
            phase = "ready"
            since = step
        }
      },
      readouts: (view) => {
        const enemy = view.enemies.find((each) => each.id === id)
        const player = view.player
        const impact = enemy === undefined || player === null ? null : timeToImpact(view, enemy, player)
        return [
          { label: "Enemy", value: enemy === undefined ? NAMES[kind()] : `${NAMES[enemy.kind]} · ${enemy.state}${enemy.timeLeft > 0 ? ` ${toSteps(enemy.timeLeft)} f` : ""}` },
          ...(view.boss === null ? [] : [{ label: "Pattern", value: `${view.boss.pattern ?? pattern?.pattern ?? "-"} · phase ${view.boss.phase}/${view.boss.phases}` }]),
          { label: "Distance", value: enemy === undefined || player === null ? "-" : `${Math.hypot(enemy.x - player.x, enemy.z - player.z).toFixed(2)} u` },
          { label: "Impact in", value: impact === null ? "-" : `${toSteps(impact)} f`, hot: impact !== null && impact < 0.2 },
          { label: "Result", value: result, hot: result === "Hit" },
          { label: "Tally", value: `${tally.parried} parried · ${tally.nearMiss} near · ${tally.hit} hit · ${tally.missed} missed` }
        ]
      },
      dispose: () => {
        game.steer(0, 0)
      }
    }
  }
}
