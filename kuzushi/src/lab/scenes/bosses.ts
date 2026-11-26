import { BOSSES, Tuning, zoneOf } from "../../sim/index.ts"
import type { BossPattern, BossView, GameView, PlayerView } from "../../sim/index.ts"
import { roomFraming } from "../camera.ts"
import { oneOf } from "../choose.ts"
import type { Scene } from "../scene.ts"
import type { Tone } from "../timeline.ts"
import { bossChoices, isBossId } from "./roster.ts"

const LANES = [{ id: "boss", label: "Boss" }, { id: "pattern", label: "Pattern" }, { id: "player", label: "Player" }] as const

const STATE_TONES: Readonly<Record<BossView["state"], readonly [Tone, string]>> = {
  intro: ["safe", "Intro"],
  fighting: ["move", "Fight"],
  shifting: ["stagger", "Shift"],
  broken: ["guard", "Broken"],
  defeated: ["rest", "Defeat"]
}

const playerTone = (player: PlayerView): readonly [Tone, string] | null =>
  player.state === "Parry" ? (player.parryOpen ? ["guard", "Window"] : ["stance", "Stance"])
  : player.state === "Dash" ? ["dash", "Dash"]
  : player.state === "Attack" || player.state === "Slam" ? ["active", "Attack"]
  : null

/** The pattern lane: the pattern's telegraph while it winds up, then the pattern itself. */
const patternTone = (view: GameView, boss: BossView): readonly [Tone, string] | null => {
  if (boss.pattern === null) return null
  const body = view.enemies.find((each) => each.id === boss.id)
  return body?.state === "Windup" || boss.telegraphs.length > 0 ? ["telegraph", boss.pattern] : ["attack", boss.pattern]
}

/**
 * A zone's boss in its own room, the real fight: its name card on arrival (replayed on demand), each phase reached
 * on demand with its shift, any of its patterns played next or on a loop, its balance filled until it breaks, its
 * health set; the boss's state, the pattern and the player's answer traced on the timeline.
 */
export const bossesScene: Scene = {
  id: "bosses",
  title: "Bosses",
  summary: "Each boss in its room: intro, phases, patterns, its balance.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  start: ({ game, zone }) => game.startZone(zone, "boss", { seed: 1 }),
  create: (tools) => {
    const { game, timeline } = tools
    const id = zoneOf(tools.zone).boss
    const boss = BOSSES[id]
    const patterns: ReadonlyArray<BossPattern> = [...new Set(boss.phases.flatMap((phase) => phase.patterns))]
    const patternOption = tools.option(`pattern.${id}`, patterns[0] ?? "slam")
    const pattern = (): BossPattern => oneOf(patterns, patternOption.get(), patterns[0] ?? "slam")
    const loop = tools.option("loop", false)
    let played = 0
    let breaks = 0

    const view = () => tools.context.game.view()
    const maxHp = Tuning.ENEMY[id].hp
    timeline.setup(`${boss.name} · gameplay steps at 60 a second`, LANES, 240)
    timeline.begin(view().tempo.playStep)

    tools.on("bossPattern", (moment) => {
      played += 1
      timeline.mark(view().tempo.playStep, "pattern", moment.pattern)
      if (loop.get()) game.bossPattern(pattern())
    })
    tools.on("bossBroken", () => {
      breaks += 1
      timeline.mark(view().tempo.playStep, "boss", "Break", true)
    })
    tools.on("bossPhase", (moment) => timeline.mark(view().tempo.playStep, "boss", `Phase ${moment.phase}`, true))
    tools.on("bossIntro", () => timeline.begin(view().tempo.playStep))

    return {
      controls: [
        { kind: "choice", label: "Boss", options: bossChoices, get: () => id, set: (value) => {
          if (isBossId(value)) tools.setZone(BOSSES[value].zone)
        } },
        { kind: "action", label: "Replay intro", run: tools.replay },
        { kind: "choice", label: "Phase", options: boss.phases.map((_, index) => ({ value: `${index + 1}`, label: `${index + 1}` })), get: () => `${view().boss?.phase ?? 1}`, set: (value) => game.bossPhase(Number(value)) },
        { kind: "choice", label: "Pattern", options: patterns.map((each) => ({ value: each, label: each })), get: pattern, set: patternOption.set },
        { kind: "action", label: "Play pattern", run: () => game.bossPattern(pattern()) },
        { kind: "toggle", label: "Loop", get: loop.get, set: (on) => {
          loop.set(on)
          if (on) game.bossPattern(pattern())
        } },
        { kind: "action", label: "Break balance", run: game.breakBoss },
        { kind: "range", label: "Health", min: 1, max: maxHp, step: 1, get: () => view().boss?.hp ?? maxHp, set: (value) => game.bossHealth(value), format: (value) => `${Math.round(value)} / ${maxHp}` }
      ],
      update: (now) => {
        if (now.room !== null) tools.frame(roomFraming(now.room.layout))
        const step = now.tempo.playStep
        const fight = now.boss
        const tone = fight === null ? null : STATE_TONES[fight.state]
        timeline.sample(step, "boss", tone?.[0] ?? null, tone?.[1])
        const shown = fight === null ? null : patternTone(now, fight)
        timeline.sample(step, "pattern", shown?.[0] ?? null, shown?.[1])
        const own = now.player === null ? null : playerTone(now.player)
        timeline.sample(step, "player", own?.[0] ?? null, own?.[1])
        timeline.playhead(step)
      },
      readouts: (now) => {
        const fight = now.boss
        if (fight === null) return [{ label: "Boss", value: `${boss.name} ${boss.kanji} · gone` }]
        const thresholds = fight.thresholds.map((each) => `${Math.round(each * fight.maxHp)}`).join(", ")
        return [
          { label: "Boss", value: `${boss.name} ${boss.kanji}` },
          { label: "State", value: `${fight.state}${fight.timeLeft > 0 ? ` · ${fight.timeLeft.toFixed(2)} s` : ""}`, hot: fight.state === "broken" || fight.open },
          { label: "Phase", value: `${fight.phase} / ${fight.phases}${thresholds === "" ? "" : ` · shifts at ${thresholds}`}` },
          { label: "Health", value: `${Math.round(fight.hp)} / ${fight.maxHp}` },
          { label: "Balance", value: `${Math.round(fight.balance * 100)}% · broken ${breaks}×`, hot: fight.balance > 0.75 },
          { label: "Pattern", value: `${fight.pattern ?? "resting"} · ${played} played${fight.shelled ? " · shelled" : ""}` }
        ]
      }
    }
  }
}
