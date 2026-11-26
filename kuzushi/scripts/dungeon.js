// Page-side helpers for walking a dungeon in screenshot steps. Load with { "evalFile": "scripts/dungeon.js" }, then:
//
//   window.__dungeon.walk("gate")     walk out through the boss room's open gate
//   window.__dungeon.walk("north")    walk out through the door on that side
//   window.__dungeon.walk(3)          walk out through the door that leads to room 3
//   window.__dungeon.walk()           walk out through the first door that leads somewhere
//   window.__dungeon.door("gate")     the door view walk would take, or null
//
// walk puts the player just inside the door, holds the stick out through it, and resolves with the door's side once
// the transition has started (the stick is let go then), or null when the room has no such open door.
;(() => {
  const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
  const game = () => window.__game
  const door = (target) => {
    const room = game()?.view().room
    if (!room) return null
    const doors = room.doors.filter((each) => each.state === "open")
    if (target === undefined) return doors.find((each) => each.to !== null) ?? null
    if (target === "gate") return doors.find((each) => each.mark === "gate") ?? null
    if (typeof target === "number") return doors.find((each) => each.to === target) ?? null
    return doors.find((each) => each.side === target) ?? null
  }
  const walk = async (target) => {
    const chosen = door(target)
    if (chosen === null) return null
    const [dx, dz] = STEP[chosen.side]
    game().teleport(chosen.x - dx * 1.2, chosen.z - dz * 1.2, Math.atan2(dz, dx))
    game().steer(dx, dz)
    await game().until((state) => state.transition !== null, 4000)
    game().steer(0, 0)
    return chosen.side
  }
  window.__dungeon = { walk, door }
  return true
})()
