import { Clock, Random } from "@typeonce/ritmo"

import { standable } from "./arena.ts"
import type { ArenaLayout, Point, Terrain } from "./arena.ts"
import { fights, groundFor } from "./dungeon/enter.ts"
import { bossSpot, wellInside } from "./dungeon/layout.ts"
import type { WaveSlot } from "./dungeon/pools.ts"
import { ROOM } from "./dungeon/rules.ts"
import { Dungeon, updateRoom } from "./dungeon/schema.ts"
import type { RoomRecord, ZoneDungeon } from "./dungeon/schema.ts"
import { angleOf } from "./geometry.ts"
import { groundOf, hazardOf, layoutOf } from "./ground.ts"
import { startingHazard } from "./hazards.ts"
import { bossDraft, eliteDraft } from "./bosses/spawn.ts"
import { Actor, Body, Boss, BossState, CurrentStage, Elite, enemyKindOf, EnemyState, Flow, Game, Hazard, Health, HitMark, Moments, Motion, PlayerState, PrevBody, Rng, Run, Tempo, Waves } from "./schema.ts"
import type { WavesValue } from "./schema.ts"
import { enemyDraft, pickSpawnPoint, spawnPointsOf } from "./spawning.ts"
import { slowMoment, withSlowMotion } from "./tempo.ts"
import { PlayTime, secondsOf, step, Time } from "./time.ts"
import { isBoss, PLAYER, SLOW, SPAWN, WAVE } from "./tuning.ts"
import type { DropKind } from "./rooms.ts"
import { zoneOf } from "./zones.ts"

/** Whether every enemy of the wave being fought has appeared: its last kill then ends the wave. */
export const allSpawned = (waves: WavesValue): boolean => waves._tag === "Fighting" && waves.spawned >= waves.size

/** The enemy a room's wave slot spawns: an elite under its crown, or one of its kind. */
const slotDraft = (slot: WaveSlot, at: Point, facing: number, play: Clock.Time<60>) =>
  slot.elite ? eliteDraft(slot.kind, at, facing, play) : enemyDraft(slot.kind, at, facing, play)

/**
 * Where a clear's drops stand: side by side across `at`, `ROOM.dropApart` apart, or across the nearest spawn point when
 * they would not all stand on open floor there (a kill against a wall, or off a Void edge).
 */
const dropsAt = (kinds: ReadonlyArray<DropKind>, at: Point, layout: ArenaLayout, terrain: Terrain): RoomRecord["drops"] => {
  const across = (centre: Point) => kinds.map((kind, index) => ({ kind, x: centre.x + (index - (kinds.length - 1) / 2) * ROOM.dropApart, z: centre.z, taken: false }))
  const there = across(at)
  if (there.every((spot) => standable(terrain, spot.x, spot.z, ROOM.dropReach))) return there
  const distance = (point: Point) => (point.x - at.x) ** 2 + (point.z - at.z) ** 2
  return across(spawnPointsOf(layout, terrain).reduce<Point>((best, point) => (distance(point) < distance(best) ? point : best), { x: 0, z: 0 }))
}

/**
 * The current room's fight, on the gameplay clock. A room still to win arms its doors as the player arrives; once
 * control is back, `DOOR.lockDelay` has passed and the player stands well inside, its seals shut and its hazard wakes.
 * Then each wave's banner, its enemies one by one at the room's spawn points, and a breath after its last kill; the
 * room's last kill slows time, may leave a diamond (an elite room always does) and in a cache FOCUS where it fell, and
 * breaks the seals as the slow motion ends. A boss room sends its boss alone; the boss's defeat raises a spring where
 * it fell and opens the gate to the next zone, or after the last zone's boss, ends the run. Also keeps the run's tally
 * of hits taken.
 */
export const RunWaves = Game.System("Game/Waves", {
  resources: {
    play: Game.System.readResource(PlayTime),
    time: Game.System.readResource(Time),
    waves: Game.System.writeResource(Waves),
    run: Game.System.writeResource(Run),
    tempo: Game.System.writeResource(Tempo),
    rng: Game.System.writeResource(Rng),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    dungeon: Game.System.writeResource(Dungeon)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.read(Body) }, with: [PlayerState] }),
    enemies: Game.Query({ selection: { actor: Game.Query.read(Actor), body: Game.Query.read(Body), health: Game.Query.read(Health) }, with: [EnemyState] })
  },
  nextMachines: { flow: Game.System.nextState(Flow) },
  events: { heard: Game.System.readEvent(Moments), moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(
    Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState),
    Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState, Elite),
    Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState, Boss, BossState),
    Game.System.despawns(Actor)
  )
}, ({ resources, queries, nextMachines, events, commands }) => {
  const play = resources.play.get()
  const time = resources.time.get()
  const heard = events.heard.all()
  const hurt = heard.filter((moment) => moment.type === "playerHurt").length
  if (hurt > 0) resources.run.update((run) => ({ ...run, hits: run.hits + hurt }))
  const lastKill = heard.reduce<Point | null>((at, moment) => (moment.type === "enemyKilled" ? { x: moment.x, z: moment.z } : at), null)
  const defeated = heard.reduce<Point | null>((at, moment) => (moment.type === "bossDefeated" ? { x: moment.x, z: moment.z } : at), null)

  const dungeon = resources.dungeon.get()
  const waves = resources.waves.get()
  const current = resources.stage.get()
  const ground = current.room
  if (dungeon._tag !== "Zone" || ground === null || waves._tag === "Idle") return
  const record = dungeon.rooms[ground.index]
  if (record === undefined) return
  const players = queries.players
  const player = players.each().map((entity) => players.data.body.get(entity))[0]
  const enemies = queries.enemies
  const living = enemies.each().filter((entity) => enemies.data.health.get(entity).hp > 0)
  const here = lastKill ?? player ?? { x: 0, z: 0 }

  const unseal = (next: ZoneDungeon) => {
    const opened = groundFor(next, ground.index, false)
    if (opened === null) return
    resources.stage.set({ ...current, room: opened })
    events.moments.emit({ type: "doorsOpened", room: ground.index, sides: opened.exits })
  }

  /**
   * The room's last wave is down: slow motion, the clear, and the seals break as the slow motion ends. Where the last
   * enemy fell it leaves a diamond (an elite room always, a combat room by its heal roll) and, in a cache, FOCUS.
   */
  const won = () => {
    const missing = PLAYER.lives - resources.run.get().lives
    const diamond = record.kind === "elite" || (missing > 0 && Random.draw(resources.rng).next() < ROOM.healChance * missing)
    const kinds: ReadonlyArray<DropKind> = [...(diamond ? ["diamond" as const] : []), ...(record.cache ? ["focus" as const] : [])]
    const drops = dropsAt(kinds, here, layoutOf(current), groundOf(current, resources.hazard.get()))
    resources.dungeon.set(updateRoom(dungeon, ground.index, (room) => ({ ...room, state: "cleared", drops })))
    resources.run.update((run) => ({ ...run, rooms: run.rooms + 1 }))
    resources.tempo.update((tempo) => withSlowMotion(tempo, time, SLOW.lastKill, SLOW.lastKillPeriod))
    events.moments.emit(slowMoment(SLOW.lastKill, SLOW.lastKillPeriod))
    const total = record.waves.length
    events.moments.emit({ type: "waveCleared", wave: total, total, x: here.x, z: here.z })
    events.moments.emit({ type: "roomCleared", room: ground.index, kind: record.kind, x: here.x, z: here.z, drops: kinds })
    resources.waves.set({ _tag: "Clearing", until: Clock.deadline(time, SLOW.lastKill) })
  }

  /** The boss is down at `at`: a spring rises there, the zone is cleared, its seals break, and its gate opens (or the run is won). */
  const bossDown = (at: Point) => {
    const next = updateRoom(dungeon, ground.index, (room) => ({ ...room, state: "cleared", spring: { x: at.x, z: at.z, spent: false } }))
    resources.dungeon.set(next)
    const run = resources.run.get()
    resources.run.set({ ...run, rooms: run.rooms + 1 })
    for (const entity of living) {
      const kind = enemyKindOf(enemies.data.actor.get(entity).kind)
      if (kind !== undefined && !isBoss(kind)) commands.despawn(entity)
    }
    const zone = zoneOf(dungeon.zone)
    events.moments.emit({ type: "roomCleared", room: ground.index, kind: record.kind, x: at.x, z: at.z, drops: [] })
    events.moments.emit({
      type: "zoneCleared",
      zone: zone.id,
      next: zone.next,
      time: (time.step - dungeon.startedAt) / time.hz,
      run: (time.step - run.startedAt) / time.hz,
      kills: run.kills
    })
    unseal(next)
    resources.waves.set(zone.next === null ? { _tag: "Won", until: Clock.deadline(time, ROOM.runClear) } : { _tag: "Idle" })
  }

  switch (waves._tag) {
    case "Arming": {
      if (waves.until === null || !Clock.reached(play, waves.until) || player === undefined) return
      if (!wellInside(ground, player.x, player.z, PLAYER.radius) || !fights(record)) return
      resources.stage.set({ ...current, room: { ...ground, sealed: true } })
      resources.hazard.set(startingHazard(hazardOf(current), play, record.fallen))
      events.moments.emit({ type: "doorsLocked", room: ground.index, sides: ground.exits })
      if (record.kind !== "boss") {
        resources.waves.set({ _tag: "Intro", wave: 1, total: record.waves.length, until: Clock.deadline(play, WAVE.intro) })
        return
      }
      const kind = zoneOf(dungeon.zone).boss
      const at = bossSpot(record, ground.exits[0] ?? null)
      const id = commands.spawn(bossDraft(kind, at, angleOf(player.x - at.x, player.z - at.z), play))
      events.moments.emit({ type: "enemySpawned", id, kind, x: at.x, z: at.z, duration: secondsOf(SPAWN.time) })
      resources.waves.set({ _tag: "Fighting", wave: 1, total: 1, spawned: 1, size: 1, nextSpawnAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)) })
      return
    }
    case "Intro": {
      if (!Clock.reached(play, waves.until)) return
      const size = record.waves[waves.wave - 1]?.length ?? 0
      resources.waves.set({ _tag: "Fighting", wave: waves.wave, total: waves.total, spawned: 0, size, nextSpawnAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)) })
      events.moments.emit({ type: "waveStarted", wave: waves.wave, total: waves.total, enemies: size })
      return
    }
    case "Fighting": {
      if (record.kind === "boss") {
        const standing = enemies.each().some((entity) => {
          const kind = enemyKindOf(enemies.data.actor.get(entity).kind)
          return kind !== undefined && isBoss(kind)
        })
        if (defeated !== null) bossDown(defeated)
        else if (!standing) bossDown({ x: 0, z: 0 })
        return
      }
      const slot = record.waves[waves.wave - 1]?.[waves.spawned]
      if (slot !== undefined) {
        if (!Clock.reached(play, waves.nextSpawnAt)) return
        const taken = enemies.each().map((entity) => enemies.data.body.get(entity))
        const points = spawnPointsOf(layoutOf(current), groundOf(current, resources.hazard.get()))
        const at = pickSpawnPoint(Random.draw(resources.rng), points, player, taken)
        const facing = player === undefined ? 0 : angleOf(player.x - at.x, player.z - at.z)
        const id = commands.spawn(slotDraft(slot, at, facing, play))
        events.moments.emit({ type: "enemySpawned", id, kind: slot.kind, x: at.x, z: at.z, duration: secondsOf(SPAWN.time) })
        resources.waves.set({ ...waves, spawned: waves.spawned + 1, nextSpawnAt: Clock.deadline(play, WAVE.spawnInterval) })
        return
      }
      if (living.length > 0) return
      if (waves.wave >= waves.total) {
        won()
        return
      }
      resources.waves.set({ _tag: "Breath", wave: waves.wave, total: waves.total, until: Clock.deadline(play, WAVE.breath) })
      events.moments.emit({ type: "waveCleared", wave: waves.wave, total: waves.total, x: here.x, z: here.z })
      return
    }
    case "Breath": {
      if (!Clock.reached(play, waves.until)) return
      resources.waves.set({ _tag: "Intro", wave: waves.wave + 1, total: waves.total, until: Clock.deadline(play, WAVE.intro) })
      return
    }
    case "Clearing": {
      if (!Clock.reached(time, waves.until)) return
      unseal(dungeon)
      resources.waves.set({ _tag: "Idle" })
      return
    }
    case "Won": {
      if (!Clock.reached(time, waves.until)) return
      const run = resources.run.get()
      resources.run.set({ ...run, endedAt: time.step })
      nextMachines.flow.transition({ from: "Playing", to: "RunClear" })
      events.moments.emit({ type: "runCleared", time: (time.step - run.startedAt) / time.hz, kills: run.kills, rooms: run.rooms, from: run.from })
      return
    }
  }
})
