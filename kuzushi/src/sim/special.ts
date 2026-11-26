import { Clock } from "@typeonce/ritmo"

import { normalize, within } from "./geometry.ts"
import { groundOf } from "./ground.ts"
import type { SpecialTarget } from "./moments.ts"
import { Actor, Body, Buffer, CurrentStage, Drill, enemyKindOf, EnemyState, Game, Hazard, Health, HitMark, Moments, Motion, PlayerState, PrevBody, Run, Tempo, Vitals, Waves } from "./schema.ts"
import { piecesOf, splitlingDraft } from "./split.ts"
import { playing, slowMoment, withSlowMotion } from "./tempo.ts"
import { PlayTime, secondsOf, Time } from "./time.ts"
import { ENEMY, FOCUS, SPECIAL } from "./tuning.ts"
import { Transition } from "./dungeon/schema.ts"
import { allSpawned } from "./waves.ts"

const untouchable = new Set(["Spawning", "Blink", "Falling"])

/**
 * KUZUSHI, on the run clock while the world stands frozen: with FOCUS full, a held special press (never mid-transition) freezes time,
 * then strikes every enemy in a wide radius again and again (through a warden's shell), ends on a heavy blow, and
 * lets go in slow motion. Splitters it kills break into splitlings it can still strike.
 */
export const Special = Game.System("Game/Special", {
  when: [playing],
  resources: {
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    buffer: Game.System.writeResource(Buffer),
    run: Game.System.writeResource(Run),
    tempo: Game.System.writeResource(Tempo),
    waves: Game.System.readResource(Waves),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard),
    transition: Game.System.readResource(Transition)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.read(Body), state: Game.Query.write(PlayerState), vitals: Game.Query.write(Vitals) } }),
    enemies: Game.Query({
      selection: {
        body: Game.Query.read(Body),
        actor: Game.Query.read(Actor),
        health: Game.Query.write(Health),
        state: Game.Query.read(EnemyState),
        drill: Game.Query.optional(Drill)
      }
    })
  },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState), Game.System.despawns(Actor))
}, ({ resources, queries, events, commands }) => {
  const time = resources.time.get()
  const players = queries.players
  const enemies = queries.enemies

  for (const player of players.each()) {
    const state = players.data.state.get(player)
    const body = players.data.body.get(player)

    if (state._tag !== "Special") {
      const buffer = resources.buffer.get()
      const run = resources.run.get()
      if (buffer._tag !== "Held" || buffer.action !== "special" || run.focus < FOCUS.max || resources.transition.get()._tag !== "None") continue
      const data = { x: body.x, z: body.z, nextHitAt: Clock.deadline(time, SPECIAL.freeze), hits: 0, kills: 0, endAt: null }
      if (state._tag === "Down") continue
      players.data.state.transition(player, { from: state._tag, to: "Special", data })
      resources.buffer.set({ _tag: "Empty" })
      resources.run.set({ ...run, focus: 0 })
      events.moments.emit({ type: "specialStarted", x: body.x, z: body.z, facing: body.facing, radius: SPECIAL.radius, freeze: secondsOf(SPECIAL.freeze) })
      continue
    }

    if (state.endAt !== null) {
      if (!Clock.reached(time, state.endAt)) continue
      players.data.state.transition(player, { from: "Special", to: "Free" })
      const vitals = players.data.vitals.get(player)
      players.data.vitals.set(player, { ...vitals, invulnerableUntil: Clock.deadline(resources.play.get(), SPECIAL.slowFor) })
      resources.tempo.update((tempo) => withSlowMotion(tempo, time, SPECIAL.slowFor, SPECIAL.slowPeriod))
      events.moments.emit(slowMoment(SPECIAL.slowFor, SPECIAL.slowPeriod))
      events.moments.emit({ type: "specialEnded", x: state.x, z: state.z, kills: state.kills })
      continue
    }

    if (!Clock.reached(time, state.nextHitAt)) continue
    const index = state.hits + 1
    const final = index >= SPECIAL.hits
    const damage = final ? SPECIAL.finalDamage : SPECIAL.hitDamage
    const targets: Array<SpecialTarget> = []
    let kills = 0
    const living = enemies.each().filter((enemy) => enemies.data.health.get(enemy).hp > 0)
    const waves = resources.waves.get()
    const current = resources.stage.get()
    const lastWaveSpawn = allSpawned(waves)
    let alive = living.length
    for (const enemy of living) {
      const enemyBody = enemies.data.body.get(enemy)
      const kind = enemyKindOf(enemies.data.actor.get(enemy).kind)
      if (kind === undefined) continue
      if (untouchable.has(enemies.data.state.get(enemy)._tag)) continue
      if (!within(enemyBody.x, enemyBody.z, state.x, state.z, SPECIAL.radius + ENEMY[kind].radius)) continue
      const health = enemies.data.health.get(enemy)
      const dummy = enemies.data.drill.get(enemy)?.mode === "dummy"
      const left = health.hp - damage
      const killed = left <= 0 && !dummy
      enemies.data.health.set(enemy, { ...health, hp: killed ? 0 : left <= 0 ? health.max : left })
      const dir = normalize(enemyBody.x - state.x, enemyBody.z - state.z, { x: 1, z: 0 })
      targets.push({ id: enemy.id, kind, x: enemyBody.x, z: enemyBody.z, killed })
      events.moments.emit({ type: "hit", id: enemy.id, kind, x: enemyBody.x, z: enemyBody.z, dirX: dir.x, dirZ: dir.z, damage, source: "special", step: 0, killed })
      if (!killed) continue
      kills += 1
      alive -= 1
      commands.despawn(enemy)
      if (kind === "splitter") {
        const pieces = piecesOf(groundOf(current, resources.hazard.get()), enemyBody.x, enemyBody.z, dir)
          .map((piece) => ({ ...piece, id: commands.spawn(splitlingDraft(piece, resources.play.get())) }))
        alive += pieces.length
        events.moments.emit({ type: "split", id: enemy.id, x: enemyBody.x, z: enemyBody.z, pieces })
      }
      events.moments.emit({ type: "enemyKilled", id: enemy.id, kind, x: enemyBody.x, z: enemyBody.z, dirX: dir.x, dirZ: dir.z, source: "special", lastOfWave: lastWaveSpawn && alive === 0 })
    }
    if (kills > 0) resources.run.update((run) => ({ ...run, kills: run.kills + kills }))
    events.moments.emit({ type: "specialHit", index, count: SPECIAL.hits, final, x: state.x, z: state.z, targets })
    players.data.state.update(player, {
      state: "Special",
      data: (special) => ({
        ...special,
        hits: index,
        kills: special.kills + kills,
        nextHitAt: Clock.deadline(time, SPECIAL.interval),
        endAt: final ? Clock.deadline(time, SPECIAL.release) : null
      })
    })
  }
})
