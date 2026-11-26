import { Keyboard } from "@typeonce/ritmo-browser"
import { describe, expect, test } from "vitest"

import { DOOR, generateDungeon, Intents, keys, ROOM, SIDE_DIRS, TRANSITION, Tuning, weaponIds, zoneIds, ZONES } from "../src/sim/index.ts"
import type { Side, ZoneId } from "../src/sim/index.ts"
import { expectRestores, makeGame, reachable, replays } from "./harness.ts"
import type { TestGame } from "./harness.ts"

/** The dungeon the run made: the generator's records for the seed `zoneStarted` named. */
const dungeonOf = (game: TestGame) => {
  const started = game.of("zoneStarted").at(-1)
  if (started === undefined) throw new Error("no zone started")
  return generateDungeon(started.zone, started.seed)
}

/** Puts the player just inside the door on `side` and holds the stick out through it until a transition starts. */
const walkOut = (game: TestGame, side: Side) => {
  const door = game.view().room?.doors.find((each) => each.side === side)
  if (door === undefined) throw new Error(`no door on the ${side}`)
  const dir = SIDE_DIRS[side]
  game.send({ type: "teleport", x: door.x - dir.x * 1.2, z: door.z - dir.z * 1.2, facing: null })
  game.send({ type: "steer", x: dir.x, z: dir.z })
  game.tickUntil(() => game.view().transition !== null, 120)
  game.send({ type: "steer", x: 0, z: 0 })
}

const doorSteps = TRANSITION.door.exit + TRANSITION.door.cover + TRANSITION.door.hold + TRANSITION.door.reveal

/** Ticks until the room's doors have locked (its fight armed and the player well inside). */
const locked = (game: TestGame) => game.tickUntil(() => game.of("doorsLocked").length > game.of("doorsOpened").length, 240)

describe("a run", () => {
  test.each(zoneIds)("starts in %s's start room at its south door, with full diamonds and the map's first rooms seen", (zone: ZoneId) => {
    const game = makeGame()
    game.startZone(zone)
    const view = game.view()
    expect(view).toMatchObject({ zone, lives: Tuning.PLAYER.lives, room: { index: 0, kind: "start", state: "cleared" } })
    expect(view.map?.rooms).toHaveLength(ZONES[zone].rooms)
    const seen = view.map?.rooms.filter((room) => room.state === "seen").map((room) => room.index).sort() ?? []
    expect(seen).toEqual([...(view.room?.doors.flatMap((door) => (door.to === null ? [] : [door.to])) ?? [])].sort())
    expect(view.player).toMatchObject({ x: 0, z: (view.room?.layout.halfDepth ?? 0) - DOOR.arrival })
    expect(game.of("runStarted")).toEqual([expect.objectContaining({ zone, sandbox: false })])
    expect(game.of("zoneStarted")).toEqual([expect.objectContaining({ zone, number: ZONES[zone].number, rooms: ZONES[zone].rooms })])
    expect(game.of("roomEntered")).toEqual([expect.objectContaining({ zone, room: 0, kind: "start", from: null })])
  })

  test("its first room holds the three weapons not in hand, and interact by an altar swaps the hand for it", () => {
    const game = makeGame()
    game.startZone("courtyard")
    const altars = game.view().room?.altars ?? []
    expect(altars.map((altar) => altar.weapon).sort()).toEqual(weaponIds.filter((weapon) => weapon !== "blade").sort())
    const altar = altars[1]
    if (altar === undefined) throw new Error("three altars")
    game.send({ type: "teleport", x: altar.x, z: altar.z + 1, facing: null })
    game.tick()
    expect(game.view().room?.altars[1]?.near).toBe(true)
    game.send({ type: "interact" })
    game.tick()
    expect(game.of("weaponTaken")).toEqual([expect.objectContaining({ weapon: altar.weapon, left: "blade", altar: 1 })])
    expect(game.view().weapon.id).toBe(altar.weapon)
    expect(game.view().room?.altars[1]?.weapon).toBe("blade")
    game.send({ type: "interact" })
    game.tick()
    expect(game.view().weapon.id).toBe("blade")
  })

  test("the same seed makes the same dungeon run after run", () => {
    const first = makeGame()
    first.startZone("spiral", null, 41)
    const second = makeGame()
    second.startZone("spiral", null, 41)
    expect(second.view().map).toEqual(first.view().map)
    expect(dungeonOf(second)).toEqual(dungeonOf(first))
  })
})

describe("doors and transitions", () => {
  test("walking into an open door plays exit, cover, hold and reveal on the run clock while gameplay holds, and swaps the room under cover", () => {
    const game = makeGame()
    game.startZone("courtyard")
    const door = game.view().room?.doors.find((each) => each.to !== null)
    if (door === undefined || door.to === null) throw new Error("the start room has a door")
    walkOut(game, door.side)
    const started = game.of("transitionStarted")[0]
    expect(started).toMatchObject({ kind: "door", side: door.side, from: 0, to: door.to, duration: doorSteps / 60 })
    const at = started?.frame ?? 0
    const play = game.view().tempo.playStep
    game.tick(TRANSITION.door.exit)
    expect(game.view().transition).toMatchObject({ beat: "cover", swapped: false })
    game.tick(TRANSITION.door.cover)
    expect(game.of("roomSwapped")).toEqual([expect.objectContaining({ kind: "door", room: door.to, side: door.side })])
    expect((game.of("roomSwapped")[0]?.frame ?? 0) - at).toBe(TRANSITION.door.exit + TRANSITION.door.cover)
    expect(game.view().transition).toMatchObject({ beat: "hold", swapped: true })
    expect(game.view().room?.index).toBe(door.to)
    game.tickUntil(() => game.of("transitionEnded").length > 0, doorSteps)
    expect((game.of("transitionEnded")[0]?.frame ?? 0) - at).toBe(doorSteps)
    expect(game.view().tempo.playStep - play).toBeLessThanOrEqual(1)
    expect(game.view().transition).toBeNull()
    const dir = SIDE_DIRS[door.side]
    const entry = game.view().room?.doors.find((each) => each.to === 0)
    expect(game.view().player).toMatchObject({ x: expect.closeTo((entry?.x ?? 0) + dir.x * DOOR.arrival, 1), z: expect.closeTo((entry?.z ?? 0) + dir.z * DOOR.arrival, 1) })
    expect(Math.hypot(game.view().player?.vx ?? 0, game.view().player?.vz ?? 0)).toBeCloseTo(Tuning.PLAYER.speed)
    expect(game.view().map?.current).toBe(door.to)
  })

  test("a combat room locks once control is back and the player stands inside, its waves come with banners and breaths, and its clear breaks the seals", () => {
    const game = makeGame()
    game.startZone("courtyard")
    const rooms = dungeonOf(game)
    const combat = rooms.findIndex((room) => room.kind === "combat" && room.depth >= 2)
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "enterRoom", room: combat, instant: true })
    game.tick()
    expect(game.view().room).toMatchObject({ index: combat, kind: "combat", state: "visited" })
    expect(game.view().room?.doors.every((door) => door.state === "open")).toBe(true)
    locked(game)
    expect(game.of("doorsLocked")[0]?.frame).toBeGreaterThanOrEqual(DOOR.lockDelay.steps)
    expect(game.view().room?.doors.every((door) => door.state === "locked")).toBe(true)
    const total = rooms[combat]?.waves.length ?? 0
    expect(total).toBe(2)
    for (let wave = 1; wave <= total; wave++) {
      game.tickUntil(() => game.of("waveStarted").length >= wave, 240)
      expect(game.of("waveStarted")[wave - 1]).toMatchObject({ wave, total, enemies: rooms[combat]?.waves[wave - 1]?.length })
      game.tickUntil(() => game.view().wave.phase === "fighting" && game.of("enemySpawned").length >= game.of("waveStarted").reduce((sum, each) => sum + each.enemies, 0), 240)
      game.send({ type: "clearWave" })
      game.tickUntil(() => game.of("waveCleared").length >= wave, 60)
      if (wave < total) expect(game.view().room?.doors.every((door) => door.state === "locked")).toBe(true)
    }
    expect(game.of("roomCleared")).toEqual([expect.objectContaining({ room: combat, kind: "combat" })])
    expect(game.view().tempo.slowScale).toBeCloseTo(1 / Tuning.SLOW.lastKillPeriod)
    game.tickUntil(() => game.of("doorsOpened").length > 0, 120)
    expect(game.view()).toMatchObject({ room: { state: "cleared" }, run: { rooms: 1 } })
    expect(game.view().room?.doors.every((door) => door.state === "open")).toBe(true)
  })

  test("locked doors hold the player in; a cleared room never locks again", () => {
    const game = makeGame()
    game.startZone("courtyard")
    const rooms = dungeonOf(game)
    const combat = rooms.findIndex((room) => room.kind === "combat")
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "enterRoom", room: combat, instant: true })
    game.tick()
    locked(game)
    const door = game.view().room?.doors[0]
    if (door === undefined) throw new Error("a door")
    const dir = SIDE_DIRS[door.side]
    game.send({ type: "teleport", x: door.x - dir.x * 1.2, z: door.z - dir.z * 1.2, facing: null })
    game.send({ type: "steer", x: dir.x, z: dir.z })
    game.tick(60)
    expect(game.view().transition).toBeNull()
    expect(game.of("transitionStarted")).toHaveLength(0)
    game.send({ type: "steer", x: 0, z: 0 })
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("doorsOpened").length > 0, 120)
    walkOut(game, door.side)
    game.tickUntil(() => game.of("transitionEnded").length > 0, doorSteps + 5)
    const back = game.view().room?.doors.find((each) => each.to === combat)
    if (back === undefined) throw new Error("the way back")
    walkOut(game, back.side)
    game.tickUntil(() => game.of("transitionEnded").length > 1, doorSteps + 5)
    expect(game.view().room).toMatchObject({ index: combat, state: "cleared" })
    game.tick(120)
    expect(game.of("doorsLocked")).toHaveLength(1)
    expect(game.view().wave.phase).toBe("idle")
  })

  test("an elite room always leaves a diamond when cleared, which waits on the floor until a diamond is missing; a spring heals them all, once", () => {
    const game = makeGame()
    game.startZone("spiral", null, 5)
    const rooms = dungeonOf(game)
    game.send({ type: "enterRoom", room: "elite", instant: true })
    game.tick()
    expect(game.view().room?.kind).toBe("elite")
    expect(rooms.find((room) => room.kind === "elite")?.waves.at(-1)?.filter((slot) => slot.elite)).toHaveLength(1)
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("roomCleared").length > 0, 30)
    expect(game.of("roomCleared")[0]?.drops).toEqual(["diamond"])
    game.tick(4)
    expect(game.view().room?.drops).toEqual([expect.objectContaining({ kind: "diamond", taken: false })])
    expect(game.of("healed")).toHaveLength(0)
    game.send({ type: "lives", lives: 2 })
    game.tick(2)
    expect(game.of("dropTaken")).toEqual([expect.objectContaining({ kind: "diamond", amount: 1 })])
    expect(game.of("healed")[0]).toMatchObject({ amount: 1, lives: 3, source: "elite" })
    expect(game.view().room?.drops[0]?.taken).toBe(true)
    game.send({ type: "enterRoom", room: "spring", instant: true })
    game.tick()
    const spring = game.view().room?.spring
    expect(spring).toMatchObject({ spent: false })
    game.send({ type: "teleport", x: spring?.x ?? 0, z: spring?.z ?? 0, facing: null })
    game.tick(2)
    expect(game.of("healed")[1]).toMatchObject({ amount: Tuning.PLAYER.lives - 3, lives: Tuning.PLAYER.lives, source: "spring" })
    expect(game.view().room?.spring?.spent).toBe(true)
    game.send({ type: "lives", lives: 1 })
    game.tick(10)
    expect(game.view().lives).toBe(1)
  })
})

describe("bosses and zones", () => {
  test("the boss room sends its boss alone; its defeat raises a spring, clears the zone and opens the gate to the next", () => {
    const game = makeGame()
    game.startZone("courtyard", "boss")
    game.send({ type: "invulnerable", on: true })
    locked(game)
    expect(game.of("enemySpawned")).toEqual([expect.objectContaining({ kind: "gatekeeper" })])
    expect(game.view().room?.doors).toHaveLength(1)
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("zoneCleared").length > 0, 60)
    expect(game.of("zoneCleared")[0]).toMatchObject({ zone: "courtyard", next: "spiral" })
    const room = game.view().room
    expect(room?.spring).toMatchObject({ spent: false })
    const gate = room?.doors.find((door) => door.mark === "gate")
    expect(gate).toMatchObject({ state: "open", to: null })
    expect(game.of("doorsOpened").at(-1)?.sides).toContain(gate?.side)
  })

  test("a boss struck down plays out its defeat, then its zone clears where it fell", () => {
    const game = makeGame()
    game.startZone("courtyard", "boss")
    game.send({ type: "invulnerable", on: true })
    locked(game)
    for (let blow = 0; blow < 8 && game.of("bossDefeated").length === 0; blow++) {
      game.tickUntil(() => game.view().boss?.state === "fighting" || game.of("bossDefeated").length > 0, 600)
      const boss = game.view().enemies.find((enemy) => enemy.kind === "gatekeeper")
      if (boss !== undefined && game.view().boss?.state === "fighting") game.send({ type: "blow", id: boss.id, damage: 999, step: 1 })
      game.tick(10)
    }
    game.tickUntil(() => game.of("bossDefeated").length > 0, 600)
    game.tickUntil(() => game.of("zoneCleared").length > 0, 10)
    const defeated = game.of("bossDefeated")[0]
    expect(game.view().room?.spring).toMatchObject({ x: defeated?.x, z: defeated?.z, spent: false })
    expect(game.view().room?.doors.some((door) => door.mark === "gate" && door.state === "open")).toBe(true)
  })

  test("walking into the gate plays the zone change: exit, cover (the next zone made), its card, then reveal at its start room", () => {
    const game = makeGame()
    game.startZone("courtyard", "boss")
    game.send({ type: "invulnerable", on: true })
    locked(game)
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("zoneCleared").length > 0, 60)
    const gate = game.view().room?.doors.find((door) => door.mark === "gate")
    if (gate === undefined) throw new Error("the gate")
    const kills = game.view().kills
    walkOut(game, gate.side)
    expect(game.of("transitionStarted").at(-1)).toMatchObject({ kind: "zone", to: 0 })
    game.tick(TRANSITION.zone.exit + TRANSITION.zone.cover)
    expect(game.of("zoneStarted").at(-1)).toMatchObject({ zone: "spiral", number: 2, rooms: 10 })
    expect(game.view()).toMatchObject({ zone: "spiral", transition: { kind: "zone", beat: "card", zone: "spiral", swapped: true }, room: { index: 0, kind: "start" } })
    expect(game.view().room?.altars).toHaveLength(0)
    game.tickUntil(() => game.of("transitionEnded").length > 0, TRANSITION.zone.card + TRANSITION.zone.reveal + 2)
    expect(game.view()).toMatchObject({ zone: "spiral", kills, transition: null, run: { from: "courtyard" } })
    expect(game.view().player).toMatchObject({ x: 0, facing: expect.closeTo(-Math.PI / 2, 3) })
  })

  test("the last boss's defeat breaks its seals and wins the run three seconds later, its doors not to be taken", () => {
    const game = makeGame()
    game.startZone("void", "boss")
    game.send({ type: "invulnerable", on: true })
    locked(game)
    expect(game.of("enemySpawned")).toEqual([expect.objectContaining({ kind: "sunder" })])
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("zoneCleared").length > 0, 60)
    expect(game.of("zoneCleared")[0]).toMatchObject({ zone: "void", next: null })
    expect(game.view().room?.doors.some((door) => door.mark === "gate")).toBe(false)
    expect(game.view().room?.doors.every((door) => door.state === "open")).toBe(true)
    const door = game.view().room?.doors[0]
    if (door === undefined) throw new Error("the boss room has a door")
    const dir = SIDE_DIRS[door.side]
    game.send({ type: "teleport", x: door.x - dir.x * 1.2, z: door.z - dir.z * 1.2, facing: null })
    game.send({ type: "steer", x: dir.x, z: dir.z })
    game.tick(60)
    expect(game.view().transition).toBeNull()
    game.send({ type: "steer", x: 0, z: 0 })
    game.tickUntil(() => game.view().flow === "RunClear", 240)
    expect((game.of("runCleared")[0]?.frame ?? 0) - (game.of("zoneCleared")[0]?.frame ?? 0)).toBeGreaterThanOrEqual(179)
    expect(game.of("runCleared")[0]).toMatchObject({ from: "void", rooms: 1 })
    expect(game.view().run).toMatchObject({ rooms: 1, rank: null })
  })

  test("losing the last diamond ends the run where it fell", () => {
    const game = makeGame()
    game.startZone("spiral", "combat")
    game.send({ type: "lives", lives: 1 })
    const player = game.view().player
    for (const dx of [-0.6, 0.6]) game.send({ type: "spawn", kind: "orbiter", x: (player?.x ?? 0) + dx, z: (player?.z ?? 0) - 1.5 })
    game.tickUntil(() => game.view().flow === "GameOver", 3000)
    expect(game.of("gameOver")[0]).toMatchObject({ zone: "spiral", room: game.view().room?.index })
    expect(game.view().run.hits).toBe(1)
  })
})

describe("debug hooks", () => {
  test("enterRoom goes through a door's transition, or at once; revealMap shows every room; lockDoors shuts and breaks the seals alone", () => {
    const game = makeGame()
    game.startZone("void", null, 9)
    game.send({ type: "revealMap" })
    game.tick()
    expect(game.view().map?.rooms.filter((room) => room.state === "hidden")).toHaveLength(0)
    game.send({ type: "enterRoom", room: "weapon" })
    game.tick()
    expect(game.view().transition).toMatchObject({ kind: "door", beat: "exit" })
    game.tickUntil(() => game.view().transition === null, doorSteps + 2)
    expect(game.view().room).toMatchObject({ kind: "weapon" })
    expect(game.view().room?.altars.map((altar) => altar.weapon)).toHaveLength(2)
    expect(game.view().room?.altars.every((altar) => altar.weapon !== "blade")).toBe(true)
    game.send({ type: "enterRoom", room: "boss", instant: true })
    game.tick()
    expect(game.view()).toMatchObject({ room: { kind: "boss" }, transition: null })
    game.send({ type: "lockDoors", locked: true })
    game.tick()
    expect(game.view().room?.doors.every((door) => door.state === "locked")).toBe(true)
    game.send({ type: "lockDoors", locked: false })
    game.tick()
    expect(game.view().room?.doors.every((door) => door.state === "open")).toBe(true)
  })

  test("the sandbox still plays a classic arena with no fights, and restart keeps to it", () => {
    const game = makeGame()
    game.startStage("void")
    expect(game.view()).toMatchObject({ zone: "void", map: null, room: null, run: { sandbox: true }, wave: { phase: "idle" } })
    game.send({ type: "restart" })
    game.tick()
    expect(game.view()).toMatchObject({ zone: "void", room: null })
  })
})

describe("saves and determinism", () => {
  test("a run in a room saves to JSON and restores into a fresh game that plays on the same", () => {
    const game = makeGame()
    game.startZone("void", "combat", 11)
    game.tick(200)
    expectRestores(game)
  })

  const timeline: Keyboard.Timeline<typeof keys> = [
    { frame: 10, press: ["move.up"] },
    { frame: 40, press: ["slash"] }, { frame: 41, release: ["slash"] },
    { frame: 50, press: ["slash"] }, { frame: 51, release: ["slash"] },
    { frame: 80, release: ["move.up"], press: ["move.left", "dash"] }, { frame: 81, release: ["dash"] },
    { frame: 120, press: ["parry"] }, { frame: 121, release: ["parry"] },
    { frame: 200, release: ["move.left"], press: ["move.right"] },
    { frame: 260, press: ["slash"] }, { frame: 261, release: ["slash"] },
    { frame: 400, release: ["move.right"], press: ["move.down", "special"] }, { frame: 401, release: ["special"] },
    { frame: 700, press: ["dash"] }, { frame: 701, release: ["dash"] }
  ]

  test.each(zoneIds)("a scripted run in a %s combat room replays exactly", (zone: ZoneId) => {
    expect(replays(1200, (runtime) => runtime.send(Intents, { type: "startZone", zone, room: "combat", seed: 42, weapon: null }), timeline)).toEqual({ ok: true, frames: 1200 })
  })

  test("a cache's clear leaves FOCUS, and walking over it fills FOCUS", () => {
    const game = makeGame()
    const found = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((seed) => {
      game.startZone("courtyard", null, seed)
      return dungeonOf(game).some((room) => room.cache)
    })
    expect(found).toBeDefined()
    const cache = dungeonOf(game).findIndex((room) => room.cache)
    game.send({ type: "enterRoom", room: cache, instant: true })
    game.tick()
    expect(game.view().room?.cache).toBe(true)
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("dropTaken").length > 0, 60)
    expect(game.of("roomCleared").at(-1)?.drops).toEqual(["focus"])
    expect(game.of("dropTaken").at(-1)).toMatchObject({ kind: "focus", amount: ROOM.cacheFocus })
    expect(game.view().focus).toBeCloseTo(ROOM.cacheFocus / Tuning.FOCUS.max)
  })
})

describe("caches", () => {
  test.each(zoneIds)("%s: a cache is a combat room off the way to the boss: the boss is reached without it", (zone) => {
    for (let seed = 1; seed <= 200; seed++) {
      const rooms = generateDungeon(zone, seed)
      const boss = rooms.findIndex((room) => room.kind === "boss")
      for (const [index, room] of rooms.entries()) {
        if (!room.cache) continue
        expect(room.kind).toBe("combat")
        expect(reachable(rooms, index).has(boss)).toBe(true)
      }
    }
  })
})
