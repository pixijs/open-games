// A page-side autopilot for screenshot runs: plays the game through synthetic key events and `window.__game`.
// Load it with a `{ "evalFile": "scripts/autopilot.js" }` step, then drive it from `eval` steps:
//
//   window.__bot.start() / stop()          play: fight what is in the room, dodge telegraphs, parry orbs, take the
//                                          wanted weapon from an altar, pick up a clear's diamond when hurt and its
//                                          FOCUS short of full, and drink from a spring when hurt
//   window.__bot.explore = true            then walk out through doors toward unexplored rooms, the boss and, once
//                                          it falls, the gate into the next zone (off: it stays in its room)
//   window.__bot.weapon = "darts"          the weapon it takes from an altar when it finds one (null: keeps its own)
//   window.__bot.rush = true               explores straight to the boss room by the shortest known way
//   window.__bot.keepAlive = true          refills the diamonds when one is left (counted in stats().rescues)
//   window.__bot.passive = true            walk into enemies without attacking or dodging (to take a hit)
//   window.__bot.arm(name, (view) => bool)  freeze the game the first frame `check` holds; `caught` becomes `name`
//   window.__bot.release()                 unfreeze after the still
//   window.__bot.stats()                   attacks, dashes, parries, rooms entered, weapons taken, rescues so far
//
// Not part of the game: it exists for scripts/steps/full-run.json, dungeon-clear.json and the stage-*.json lists.
(() => {
  const game = window.__game
  const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
  /** The rooms whose doors lock until their fight is won: the bot stays in them until then. */
  const FIGHTS = new Set(["combat", "elite", "boss"])
  /** How each weapon likes to fight: the distance it keeps, the distance it attacks from, and how often it presses. */
  const STYLE = {
    blade: { keep: 1.6, reach: 2.4, every: 150 },
    breaker: { keep: 2.0, reach: 2.9, every: 220 },
    darts: { keep: 3.4, reach: 7, every: 140 },
    sigil: { keep: 5, reach: 8.5, every: 260 }
  }
  const held = new Set()
  const send = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, key: code, bubbles: true }))
  const hold = (code, on) => {
    if (on && !held.has(code)) {
      held.add(code)
      send(code, true)
    } else if (!on && held.has(code)) {
      held.delete(code)
      send(code, false)
    }
  }
  const tap = (code) => {
    send(code, true)
    setTimeout(() => send(code, false), 40)
  }
  const steer = (dx, dz) => {
    const length = Math.hypot(dx, dz) || 1
    hold("KeyD", dx / length > 0.38)
    hold("KeyA", dx / length < -0.38)
    hold("KeyS", dz / length > 0.38)
    hold("KeyW", dz / length < -0.38)
  }
  const bot = {
    on: false,
    passive: false,
    dodge: true,
    parry: true,
    explore: false,
    rush: false,
    keepAlive: false,
    weapon: null,
    counts: { attacks: 0, dashes: 0, parries: 0, rooms: 0, weapons: 0, rescues: 0 },
    last: { attack: 0, dash: 0, parry: 0, interact: 0, room: "" },
    track: { at: 0, x: 0, z: 0 },
    detour: { side: 1, until: 0, x: 0, z: 0 },
    watch: null,
    caught: null
  }

  /** Stands still for an orb flying at the player and parries it when it is about to land. */
  const parryOrbs = (view, player, now) => {
    let incoming = false
    for (const orb of view.projectiles) {
      if (orb.owner !== "enemy") continue
      const dx = player.x - orb.x
      const dz = player.z - orb.z
      const distance = Math.hypot(dx, dz)
      if (distance > 4 || (dx * orb.dirX + dz * orb.dirZ) / (distance || 1) < 0.85) continue
      incoming = true
      if (distance < 1.45 && now - bot.last.parry > 90 && player.state !== "Parry") {
        game.aim(orb.x, orb.z)
        tap("KeyK")
        bot.last.parry = now
        bot.counts.parries++
      }
    }
    return incoming
  }

  /** Every telegraph on the floor now: each enemy's, and each of a boss's (its halves' and moons' too). */
  const tellsOf = (view) => [
    ...view.enemies.flatMap((enemy) => (enemy.telegraph === null ? [] : [{ ...enemy.telegraph, x: enemy.x, z: enemy.z }])),
    ...(view.boss?.telegraphs ?? [])
  ]

  /** Which way to dash out of a telegraph about to strike where the player stands, or null when it is clear of it. */
  const threat = (tell, player) => {
    if (tell.feint || tell.progress < 0.55) return null
    if (tell.shape === "spot") {
      const spot = tell.spot ?? tell
      return Math.hypot(player.x - spot.x, player.z - spot.z) <= tell.size + 0.8 ? [player.x - spot.x, player.z - spot.z] : null
    }
    const ax = player.x - tell.x
    const az = player.z - tell.z
    const distance = Math.hypot(ax, az)
    if (tell.shape === "ring" || tell.shape === "arc") return distance <= tell.size + 0.6 ? [ax, az] : null
    if (distance > tell.size + 0.8) return null
    const along = ax * tell.dirX + az * tell.dirZ
    const aside = ax * -tell.dirZ + az * tell.dirX
    if (along < -0.5 || Math.abs(aside) > 1.4) return null
    const side = aside >= 0 ? 1 : -1
    return [-tell.dirZ * side, tell.dirX * side]
  }

  /** Dashes out of a telegraph that is about to strike: sideways out of a line, straight out of a ring, arc or spot. */
  const dodge = (view, player, now) => {
    if (now - bot.last.dash < 450 || !player.dashReady) return false
    for (const tell of tellsOf(view)) {
      const away = threat(tell, player)
      if (away === null) continue
      steer(away[0], away[1])
      tap("Space")
      bot.last.dash = now
      bot.counts.dashes++
      return true
    }
    return false
  }

  /** Walks sideways for a moment when the player has not moved, to slide round a block between it and its target. */
  const route = (player, dx, dz, now) => {
    if (now < bot.detour.until) return { x: bot.detour.x, z: bot.detour.z }
    if (now - bot.track.at > 350) {
      if (Math.hypot(player.x - bot.track.x, player.z - bot.track.z) < 0.5 && Math.hypot(dx, dz) > 1) {
        const side = -bot.detour.side
        const length = Math.hypot(dx, dz) || 1
        bot.detour = { side, until: now + 700, x: (-dz / length) * side + (dx / length) * 0.2, z: (dx / length) * side + (dz / length) * 0.2 }
      }
      bot.track = { at: now, x: player.x, z: player.z }
    }
    return { x: dx, z: dz }
  }

  /** Grid cells for finding a way across a room: half a unit, and how far the body keeps from edges, walls and props. */
  const CELL = 0.5
  const BODY = 0.5

  /** The indices of the view's fallen slabs, set once a frame in `tick`: `standable` runs thousands of times a frame. */
  let fallen = new Set()
  const fallenOf = (view) => new Set(view.hazard.kind === "slabs" ? view.hazard.slabs.filter((slab) => slab.state === "fallen").map((slab) => slab.index) : [])

  /** Whether the player's body fits standing at (x, z): on the floor (a standing slab in the Void), clear of every prop. */
  const standable = (view, x, z) => {
    const layout = view.room?.layout
    if (layout === undefined) return true
    const floor = layout.floor
    if (floor.kind === "slabs") {
      const onSlab = (px, pz) => floor.slabs.some((slab, index) => !fallen.has(index) && Math.abs(px - slab.x) <= slab.halfWidth && Math.abs(pz - slab.z) <= slab.halfDepth)
      if (![[0, 0], [BODY, 0], [-BODY, 0], [0, BODY], [0, -BODY]].every(([ox, oz]) => onSlab(x + ox, z + oz))) return false
    } else if (floor.kind === "round") {
      if (Math.hypot(x, z) > floor.radius - BODY) return false
    } else if (Math.abs(x) > layout.halfWidth - BODY || Math.abs(z) > layout.halfDepth - BODY) return false
    if (layout.blocks.some((block) => Math.abs(x - block.x) < block.halfWidth + BODY && Math.abs(z - block.z) < block.halfDepth + BODY)) return false
    return !layout.pillars.some((pillar) => Math.hypot(x - pillar.x, z - pillar.z) < pillar.radius + BODY)
  }

  /** The way across the room to (x, z) as ground points a cell apart, breadth first over standable cells, or null. */
  const findWay = (view, from, to) => {
    const layout = view.room?.layout
    if (layout === undefined) return null
    const columns = Math.ceil((layout.halfWidth * 2 + 6) / CELL)
    const rows = Math.ceil((layout.halfDepth * 2 + 6) / CELL)
    const left = -layout.halfWidth - 3
    const top = -layout.halfDepth - 3
    const index = (x, z) => Math.round((z - top) / CELL) * columns + Math.round((x - left) / CELL)
    const point = (at) => ({ x: left + (at % columns) * CELL, z: top + Math.floor(at / columns) * CELL })
    const open = new Map()
    const free = (at) => {
      if (!open.has(at)) {
        const p = point(at)
        open.set(at, standable(view, p.x, p.z))
      }
      return open.get(at)
    }
    const nearestFree = (x, z) => {
      const at = index(x, z)
      if (free(at)) return at
      for (let ring = 1; ring <= 4; ring++) {
        for (let dz = -ring; dz <= ring; dz++) {
          for (let dx = -ring; dx <= ring; dx++) {
            const each = at + dz * columns + dx
            if (each >= 0 && each < columns * rows && free(each)) return each
          }
        }
      }
      return null
    }
    const start = nearestFree(from.x, from.z)
    const goal = nearestFree(to.x, to.z)
    if (start === null || goal === null) return null
    const before = new Map([[start, start]])
    const queue = [start]
    for (let at = 0; at < queue.length && !before.has(goal); at++) {
      const here = queue[at]
      const column = here % columns
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (column + dx < 0 || column + dx >= columns) continue
        const next = here + dz * columns + dx
        if (next < 0 || next >= columns * rows || before.has(next) || !free(next)) continue
        if (dx !== 0 && dz !== 0 && (!free(here + dx) || !free(here + dz * columns))) continue
        before.set(next, here)
        queue.push(next)
      }
    }
    if (!before.has(goal)) return null
    const way = [goal]
    while (way[0] !== start) way.unshift(before.get(way[0]))
    return way.map(point)
  }

  /** Whether the straight walk from one point to another stays on standable ground. */
  const clearWalk = (view, from, to) => {
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    for (let along = 0.25; along < length; along += 0.25) {
      if (!standable(view, from.x + ((to.x - from.x) * along) / length, from.z + ((to.z - from.z) * along) / length)) return false
    }
    return true
  }

  /** The way being followed: its goal, its points, and when it was found. */
  let way = { x: 0, z: 0, at: 0, points: null }

  /** The direction to walk toward (x, z): straight when the ground allows, else along a way found round props and gaps. */
  const heading = (view, player, x, z, now) => {
    if (clearWalk(view, player, { x, z })) return { x: x - player.x, z: z - player.z }
    if (now - way.at > 300 || Math.hypot(way.x - x, way.z - z) > 1) way = { x, z, at: now, points: findWay(view, player, { x, z }) }
    const points = way.points
    if (points === null || points.length === 0) return route(player, x - player.x, z - player.z, now)
    let next = points[Math.min(points.length - 1, 2)]
    for (let at = points.length - 1; at >= 0; at--) {
      if (clearWalk(view, player, points[at])) {
        next = points[at]
        break
      }
    }
    return { x: next.x - player.x, z: next.z - player.z }
  }

  /** Walks toward a ground point; true once within `near` of it. */
  const walkTo = (view, player, x, z, near, now) => {
    if (Math.hypot(x - player.x, z - player.z) <= near) {
      steer(0, 0)
      return true
    }
    const toward = heading(view, player, x, z, now)
    steer(toward.x, toward.z)
    return false
  }

  /** Whether a block or pillar of the room stands between two ground points (sampled every half unit). */
  const blocked = (view, from, to) => {
    const layout = view.room?.layout ?? null
    if (layout === null) return false
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    for (let along = 0.5; along < length - 0.5; along += 0.5) {
      const x = from.x + ((to.x - from.x) * along) / length
      const z = from.z + ((to.z - from.z) * along) / length
      if (layout.blocks.some((block) => Math.abs(x - block.x) < block.halfWidth && Math.abs(z - block.z) < block.halfDepth)) return true
      if (layout.pillars.some((pillar) => Math.hypot(x - pillar.x, z - pillar.z) < pillar.radius)) return true
    }
    return false
  }

  /** Fights the nearest enemy (a boss's nearest body in a boss room) in the weapon's style; closes in when cover is in the way. */
  const fight = (view, player, now) => {
    const style = STYLE[view.weapon.id] ?? STYLE.blade
    const target = view.enemies
      .filter((enemy) => enemy.state !== "Spawning" && enemy.state !== "Falling")
      .map((enemy) => ({ enemy, distance: Math.hypot(enemy.x - player.x, enemy.z - player.z) }))
      .sort((a, b) => a.distance - b.distance)[0]
    if (target === undefined) return false
    game.aim(target.enemy.x, target.enemy.z)
    const big = view.boss !== null && (target.enemy.id === view.boss.id || target.enemy.id === view.boss.twin)
    const covered = blocked(view, player, target.enemy)
    const reach = covered ? 1.6 : style.reach + (big ? 1.4 : 0)
    const keep = covered ? 1.2 : style.keep + (big ? 1.4 : 0)
    const dx = target.enemy.x - player.x
    const dz = target.enemy.z - player.z
    const detouring = now < bot.detour.until
    if (bot.passive || detouring || target.distance > Math.max(keep, reach * 0.8)) {
      const toward = heading(view, player, target.enemy.x, target.enemy.z, now)
      steer(toward.x, toward.z)
    } else if (target.distance < keep * 0.7) steer(-dx, -dz)
    else steer(0, 0)
    if (!bot.passive && target.distance < reach && now - bot.last.attack > style.every) {
      tap("KeyJ")
      bot.last.attack = now
      bot.counts.attacks++
    }
    return true
  }

  const cell = (room) => `${room.column},${room.row}`

  /**
   * The side of the current room to leave by: through the gate once the boss has fallen; else the first step of the
   * shortest known way (through rooms already won) to the nearest room still to explore, or to the boss room when
   * rushing or when nothing else is left.
   */
  const nextSide = (view) => {
    const room = view.room
    const map = view.map
    if (room === null || map === null) return null
    const open = room.doors.filter((door) => door.state === "open")
    const gate = open.find((door) => door.mark === "gate")
    if (gate !== undefined) return gate.side
    const byCell = new Map(map.rooms.map((each) => [cell(each), each]))
    const known = (each) => each.state !== "hidden"
    const passable = (each) => each.state === "cleared" || each.index === map.current
    const boss = map.rooms.find((each) => each.kind === "boss" && known(each))
    const unexplored = map.rooms.filter((each) => known(each) && each.state !== "cleared" && each.kind !== "boss" && each.index !== map.current)
    const toBoss = (bot.rush && boss !== undefined) || unexplored.length === 0
    const goals = new Set(toBoss ? (boss === undefined ? [] : [boss.index]) : unexplored.map((each) => each.index))
    if (goals.size === 0) return null
    const first = new Map([[map.current, null]])
    const queue = [map.rooms[map.current]]
    for (let at = 0; at < queue.length; at++) {
      const here = queue[at]
      if (goals.has(here.index)) {
        const side = first.get(here.index)
        return open.some((door) => door.side === side) ? side : null
      }
      if (!passable(here)) continue
      for (const side of here.exits) {
        const [dx, dz] = STEP[side]
        const next = byCell.get(`${here.column + dx},${here.row + dz}`)
        if (next === undefined || !known(next) || first.has(next.index)) continue
        first.set(next.index, first.get(here.index) ?? side)
        queue.push(next)
      }
    }
    return null
  }

  /** Between fights: takes the wanted weapon, drinks from the spring when hurt, picks up what the clear left, then walks out through the next door. */
  const roam = (view, player, now) => {
    const room = view.room
    if (room === null) {
      walkTo(view, player, 0, 2, 1, now)
      return
    }
    const sealed = room.doors.some((door) => door.state === "locked")
    const unwon = room.state !== "cleared" && FIGHTS.has(room.kind)
    if (sealed || unwon || view.wave.phase === "intro") {
      walkTo(view, player, 0, 0, 2.5, now)
      return
    }
    const altar = bot.weapon === null || view.weapon.id === bot.weapon ? undefined : room.altars.find((each) => each.weapon === bot.weapon)
    if (altar !== undefined) {
      if (walkTo(view, player, altar.x, altar.z, 0.9, now) && altar.near && now - bot.last.interact > 400) {
        game.interact()
        bot.last.interact = now
        bot.counts.weapons++
      }
      return
    }
    if (room.spring !== null && !room.spring.spent && view.lives < view.maxLives) {
      walkTo(view, player, room.spring.x, room.spring.z, 0.4, now)
      return
    }
    const drop = room.drops.find((each) => !each.taken && (each.kind === "diamond" ? view.lives < view.maxLives : !view.focusFull))
    if (drop !== undefined) {
      walkTo(view, player, drop.x, drop.z, 0.3, now)
      return
    }
    if (!bot.explore) return
    const side = nextSide(view)
    const door = side === null ? undefined : room.doors.find((each) => each.side === side && each.state === "open")
    if (door === undefined) {
      walkTo(view, player, 0, 0, 2, now)
      return
    }
    const [dx, dz] = STEP[door.side]
    const mouth = { x: door.x - dx * 2.2, z: door.z - dz * 2.2 }
    const across = Math.abs((player.x - door.x) * dz - (player.z - door.z) * dx)
    if (across < 0.9 && Math.hypot(player.x - mouth.x, player.z - mouth.z) < 3.5) steer(dx, dz)
    else walkTo(view, player, mouth.x, mouth.z, 0.3, now)
  }

  const tick = () => {
    if (!bot.on) return
    requestAnimationFrame(tick)
    const view = game.view()
    fallen = fallenOf(view)
    const player = view.player
    if (bot.watch !== null && !game.state().frozen && bot.watch.check(view)) {
      bot.caught = bot.watch.name
      bot.watch = null
      game.freeze(true)
      steer(0, 0)
      return
    }
    if (view.flow !== "Playing" || player === null || view.tempo.frozen || view.transition !== null) {
      steer(0, 0)
      return
    }
    const here = view.room === null ? "" : `${view.zone}.${view.room.index}`
    if (here !== "" && here !== bot.last.room) {
      bot.last.room = here
      bot.counts.rooms++
    }
    if (bot.keepAlive && view.lives <= 1) {
      game.setLives(view.maxLives)
      bot.counts.rescues++
    }
    const now = performance.now()
    if (bot.parry && !bot.passive && parryOrbs(view, player, now)) {
      steer(0, 0)
      return
    }
    if (bot.dodge && !bot.passive && dodge(view, player, now)) return
    if (fight(view, player, now)) return
    roam(view, player, now)
  }

  bot.arm = (name, check) => {
    bot.caught = null
    bot.watch = { name, check }
  }
  bot.release = () => {
    bot.caught = null
    game.freeze(false)
  }
  bot.start = () => {
    if (bot.on) return
    bot.on = true
    tick()
  }
  bot.stop = () => {
    bot.on = false
    for (const code of held) hold(code, false)
  }
  bot.stats = () => ({ ...bot.counts })
  window.__bot = bot
  return "autopilot ready"
})()
