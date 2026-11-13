import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  FALL_DAZE_H, Mode, PLAYER_RADIUS, TICK_RATE, WALL_KICK_SETTLE, WALL_SPEED, Weapon, ticks,
} from "../src/shared/constants.ts";
import { CITY, ceilingAbove, collideBody, groundHeight, insideSolid, newContacts } from "../src/shared/map.ts";
import type { Box } from "../src/shared/town.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import {
  EV_CLIMB, EV_DAZE, EV_FALL_OFF, EV_FIRE, EV_JUMP, EV_WALL, stepPlayer, type InputLike, type PlayerSim, type WorldView,
} from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const DT = 1 / TICK_RATE;
const STEP_MS = 1000 / TICK_RATE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A building's face: its box, the way out of it (n), its middle, half its width, and the box's top. */
interface Face { b: Box; nx: number; nz: number; cx: number; cz: number; half: number; top: number }

const probe = newContacts();
/** Does a body at (x, z), feet at `y`, touch only walls `top` high (this building, nothing else)? */
const onlyThis = (x: number, z: number, y: number, top: number) => {
  collideBody({ x, z }, y, y, PLAYER_RADIUS, 1.3, undefined, probe);
  for (let k = 0; k < probe.n; k++) if (Math.abs(probe.top[k] - top) > 1e-3) return false;
  return true;
};

/**
 * A real building to climb, found on the map (it may change): tall enough for a fall off it to
 * daze, a flat roof to climb onto, open street off one face, nothing else on the way up that
 * face, and a clear way round its right-hand corner.
 */
function findFace(): Face {
  for (const b of CITY.boxes) {
    if (b.rot || b.base !== undefined || b.grab === false || b.pole !== undefined || b.top < FALL_DAZE_H + 3) continue;
    const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
    const faces: Face[] = [
      { b, nx: 0, nz: 1, cx: mx, cz: b.maxZ, half: (b.maxX - b.minX) / 2, top: b.top },
      { b, nx: 0, nz: -1, cx: mx, cz: b.minZ, half: (b.maxX - b.minX) / 2, top: b.top },
      { b, nx: 1, nz: 0, cx: b.maxX, cz: mz, half: (b.maxZ - b.minZ) / 2, top: b.top },
      { b, nx: -1, nz: 0, cx: b.minX, cz: mz, half: (b.maxZ - b.minZ) / 2, top: b.top },
    ];
    for (const f of faces) {
      if (f.half < 2) continue;
      const tx = f.nz, tz = -f.nx;
      const at = (s: number, d: number) => ({ x: f.cx + tx * s + f.nx * d, z: f.cz + tz * s + f.nz * d });
      // a flat roof just in from the edge, open sky over it
      const roof = at(0, -0.8);
      if (Math.abs(groundHeight(roof.x, roof.z, f.top + 0.2) - f.top) > 1e-3 || ceilingAbove(roof.x, roof.z, f.top) < Infinity) continue;
      // the street off the face, for 6 m
      let ok = true;
      for (let d = 0.36; d < 6 && ok; d += 0.3) {
        const q = at(0, d);
        if (insideSolid(q.x, q.z) || groundHeight(q.x, q.z, 0.2) > 0.05) ok = false;
      }
      // straight up the face, and along it to the right and round the corner, at a few heights
      for (let y = 0; y < f.top - 0.5 && ok; y += 0.5) {
        const q = at(0, 0.3);
        if (!onlyThis(q.x, q.z, y, f.top) || ceilingAbove(q.x, q.z, y) < f.top + 2) ok = false;
      }
      for (const y of [2, 3, 4]) {
        for (let s = 0; s <= f.half && ok; s += 0.25) { const q = at(s, 0.3); if (!onlyThis(q.x, q.z, y, f.top)) ok = false; }
        for (let u = 0; u <= 2 && ok; u += 0.25) { const q = at(f.half + 0.3, -u); if (!onlyThis(q.x, q.z, y, f.top)) ok = false; }
      }
      const side = at(f.half + 1, -1);
      if (insideSolid(side.x, side.z)) ok = false;
      if (ok) return f;
    }
  }
  throw new Error("no building on the map to climb");
}

describe("crawling on walls with the zoomies (shared step)", () => {
  const f = findFace();
  const tx = f.nz, tz = -f.nx;
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  /** The stick pushing into the wall (towards the building), and along it to the right. */
  const into = { mx: Math.round(-f.nx * 100), mz: Math.round(-f.nz * 100) };
  const away = { mx: -into.mx, mz: -into.mz };
  /** How far (x, z) is out from the face's plane. */
  const off = (s: { x: number; z: number }) => (s.x - f.cx) * f.nx + (s.z - f.cz) * f.nz;
  /** How far (x, z) is from the building's box (0 inside). */
  const gap = (s: { x: number; z: number }) => {
    const dx = Math.max(f.b.minX - s.x, 0, s.x - f.b.maxX), dz = Math.max(f.b.minZ - s.z, 0, s.z - f.b.maxZ);
    return Math.hypot(dx, dz);
  };
  /** Standing in the street `d` m out from the middle of the face, with (or without) the zoomies. */
  const standing = (zoomies: number, d = 0.6): PlayerSim => {
    const x = f.cx + f.nx * (PLAYER_RADIUS + d), z = f.cz + f.nz * (PLAYER_RADIUS + d);
    return {
      x, y: groundHeight(x, z, 0), z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0,
      steer: 0, yawRate: 0, grounded: true, weapon: Weapon.Pistol, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies, charge: 0, coyote: 0, stench: 0,
    };
  };
  let time = 5000;
  const step = (s: PlayerSim, cmd: Partial<InputLike>) => stepPlayer({ dt: DT, time: (time += STEP_MS), memo: (_k, fn) => fn() }, s, { ...idle, ...cmd }, world);
  /** Step with `cmd` until an event in `mask` (or `n` steps); returns the events of that step (0: none came). */
  const until = (s: PlayerSim, mask: number, n: number, cmd: (i: number) => Partial<InputLike>) => {
    for (let i = 0; i < n; i++) {
      const ev = step(s, cmd(i));
      if (ev & mask) return ev;
    }
    return 0;
  };
  /** On the wall, `h` m up it. */
  const upTo = (h: number) => {
    const s = standing(ticks(10));
    assert.ok(until(s, EV_WALL, 30, () => into), "stuck to it");
    for (let i = 0; i < 300 && s.y < h; i++) step(s, into);
    assert.strictEqual(s.mode, Mode.Wall);
    return s;
  };

  it(`(climbing a ${f.top.toFixed(1)} m building at (${f.cx.toFixed(1)}, ${f.cz.toFixed(1)}), face out (${f.nx}, ${f.nz}))`, () => {});

  it("without the zoomies, running into a wall just stops you", () => {
    const s = standing(0);
    for (let i = 0; i < 30; i++) assert.ok(!(step(s, into) & EV_WALL));
    assert.strictEqual(s.mode, Mode.Foot);
    assert.ok(s.grounded && s.y < 0.05, `y ${s.y}`);
    assert.ok(Math.abs(off(s) - PLAYER_RADIUS) < 1e-3, `off the face ${off(s)}`);
  });

  it("with them, running at it squarely sticks you to it, facing it, PLAYER_RADIUS off its face", () => {
    const s = standing(ticks(10));
    assert.ok(until(s, EV_WALL, 30, () => into), "stuck to it");
    assert.strictEqual(s.mode, Mode.Wall);
    assert.ok(Math.abs(wrap(s.lyaw - Math.atan2(f.nx, f.nz))) < 1e-4, `lyaw ${s.lyaw}`);
    assert.ok(Math.abs(wrap(s.yaw - Math.atan2(-f.nx, -f.nz))) < 1e-4, `yaw ${s.yaw}`);
    assert.ok(Math.abs(off(s) - PLAYER_RADIUS) < 1e-3, `off the face ${off(s)}`);
    // the run carries on up it
    assert.ok(s.vy > 1, `vy ${s.vy}`);
    // a jump tapped on the way in doesn't kick straight back off
    step(s, { ...into, jump: true });
    assert.strictEqual(s.mode, Mode.Wall);
  });

  it("running along it at a shallow angle doesn't", () => {
    // from its left end, 30° into it
    const s = standing(ticks(10), 0.05);
    s.x -= tx * (f.half - 0.5); s.z -= tz * (f.half - 0.5);
    const a = (30 * Math.PI) / 180;
    const cmd = { mx: Math.round((tx * Math.cos(a) - f.nx * Math.sin(a)) * 100), mz: Math.round((tz * Math.cos(a) - f.nz * Math.sin(a)) * 100) };
    let touched = false;
    for (let i = 0; i < 40; i++) {
      if ((s.x - f.cx) * tx + (s.z - f.cz) * tz > f.half - PLAYER_RADIUS) break;
      assert.ok(!(step(s, cmd) & EV_WALL), "stuck to it");
      if (Math.abs(off(s) - PLAYER_RADIUS) < 1e-3) touched = true;
    }
    assert.ok(touched, "ran along it");
    assert.strictEqual(s.mode, Mode.Foot);
  });

  it("holding into it climbs at WALL_SPEED, and over the top onto the roof", () => {
    const s = upTo(3);
    assert.ok(Math.abs(s.vy - WALL_SPEED) < 0.01, `vy ${s.vy}`);
    assert.ok(Math.abs(off(s) - PLAYER_RADIUS) < 1e-3, `off the face ${off(s)}`);
    const ev = until(s, EV_CLIMB | EV_FALL_OFF | EV_JUMP, Math.ceil((f.top / WALL_SPEED) * TICK_RATE) + 30, () => into);
    assert.ok(ev & EV_CLIMB, `climbed over (events ${ev})`);
    assert.strictEqual(s.mode, Mode.Foot);
    assert.ok(s.grounded);
    assert.strictEqual(s.y, Math.fround(f.top));
    assert.ok(off(s) < -PLAYER_RADIUS, `on the roof, ${-off(s)} m in from the edge`);
  });

  it("along it, it stays PLAYER_RADIUS off the face, and goes round the corner onto the next one", () => {
    {
      const s = upTo(3);
      // along the wall to the right, held that way all round the corner
      const right = () => ({ mx: Math.round(tx * 100), mz: Math.round(tz * 100) });
      // (the climb eases to a stop first)
      for (let i = 0; i < 10; i++) step(s, right());
      const y0 = s.y;
      for (let i = 0; i < 200; i++) {
        step(s, right());
        assert.strictEqual(s.mode, Mode.Wall, `fell off at step ${i}`);
        assert.ok(Math.abs(gap(s) - PLAYER_RADIUS) < 0.02, `step ${i}: ${gap(s).toFixed(3)} m off the building`);
        // well along the side face
        if ((s.x - f.cx) * f.nx + (s.z - f.cz) * f.nz < -1) break;
      }
      assert.ok(Math.abs(wrap(s.lyaw - Math.atan2(tx, tz))) < 1e-3, `facing out of the side face: lyaw ${s.lyaw}`);
      assert.ok(Math.abs(s.y - y0) < 0.05, `stayed at the same height: ${s.y} vs ${y0}`);
      assert.ok(Math.hypot(s.vx, s.vz) > WALL_SPEED - 0.01, `still crawling along at ${Math.hypot(s.vx, s.vz)}`);
      // let go, and the same push is read against the face we're on now: away from it, down
      step(s, {});
      for (let i = 0; i < 10; i++) step(s, right());
      assert.ok(Math.abs(s.vy + WALL_SPEED) < 0.01, `crawling down: vy ${s.vy}`);
    }
  });

  it("pulling away crawls down, and at the street steps off onto it", () => {
    const s = upTo(2);
    let down = false;
    for (let i = 0; i < 60 && s.mode === Mode.Wall; i++) {
      step(s, away);
      if (s.mode === Mode.Wall && Math.abs(s.vy + WALL_SPEED) < 0.01) down = true;
    }
    assert.ok(down, "crawled down at WALL_SPEED");
    assert.strictEqual(s.mode, Mode.Foot);
    assert.ok(s.grounded && s.y < 0.05, `y ${s.y}`);
  });

  it("Space kicks off it, and holding into it after brings you back onto it (no sooner than a moment)", () => {
    const s = upTo(6);
    const ev = step(s, { ...into, jump: true });
    assert.ok(ev & EV_JUMP);
    assert.strictEqual(s.mode, Mode.Foot);
    assert.ok(s.vy > 0 && s.vx * f.nx + s.vz * f.nz > 0, `kicked off up and away: v (${s.vx}, ${s.vy}, ${s.vz})`);
    for (let i = 0; i < ticks(WALL_KICK_SETTLE); i++) assert.ok(!(step(s, into) & EV_WALL), "straight back on");
    assert.ok(off(s) > PLAYER_RADIUS + 0.3, `clear of it: ${off(s)}`);
    assert.ok(until(s, EV_WALL, 30, () => into), "back on it");
    assert.ok(s.y > 3, `caught it again at ${s.y}`);
  });

  it("no shooting on a wall: the paws are busy", () => {
    const s = upTo(2);
    for (let i = 0; i < 10; i++) assert.ok(!(step(s, { ...into, fire: true, weapon: Weapon.Pistol }) & EV_FIRE));
    assert.strictEqual(s.ammo1, 10);
  });

  it("when the zoomies wear off you fall, and from high up the landing dazes you", () => {
    const s = upTo(FALL_DAZE_H + 1.5);
    s.zoomies = 1;
    assert.ok(step(s, into) & EV_FALL_OFF);
    assert.strictEqual(s.mode, Mode.Foot);
    assert.ok(until(s, EV_DAZE, 60, () => into), "dazed");
    assert.strictEqual(s.mode, Mode.Knocked);
  });
});

describe("crawling on walls: every building on the map", () => {
  it("a raccoon with the zoomies pushing into a building ends up on top of it (awnings, cornices and all)", () => {
    const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
    const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
    let faces = 0, up = 0;
    const misses: string[] = [];
    for (const b of CITY.boxes) {
      // every side of every building that has open street in front of it
      if (b.rot || b.base !== undefined || b.grab === false || b.pole !== undefined || b.top < 2.5) continue;
      const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
      for (const [nx, nz, cx, cz] of [[0, 1, mx, b.maxZ], [0, -1, mx, b.minZ], [1, 0, b.maxX, mz], [-1, 0, b.minX, mz]] as const) {
        const sx = cx + nx * (PLAYER_RADIUS + 0.8), sz = cz + nz * (PLAYER_RADIUS + 0.8);
        if (insideSolid(sx, sz) || groundHeight(sx, sz, 0.2) > 0.1) continue;
        faces++;
        const s: PlayerSim = {
          x: sx, y: groundHeight(sx, sz, 0), z: sz, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0,
          steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: ticks(20), charge: 0, coyote: 0, stench: 0,
        };
        const cmd = { ...idle, mx: Math.round(-nx * 100), mz: Math.round(-nz * 100) };
        let t = 5000, grabbed = false, made = false;
        for (let i = 0; i < 600 && !made; i++) {
          if (stepPlayer({ dt: DT, time: (t += STEP_MS), memo: (_k, fn) => fn() }, s, cmd, world) & EV_WALL) grabbed = true;
          made = grabbed && s.mode === Mode.Foot && s.grounded && s.y >= b.top - 0.3;
        }
        if (made) up++;
        else misses.push(`(${cx.toFixed(1)}, ${cz.toFixed(1)}) out (${nx}, ${nz}), ${b.top.toFixed(1)} m: ended at y ${s.y.toFixed(1)}, mode ${s.mode}`);
      }
    }
    assert.ok(faces > 50, `only ${faces} faces`);
    // (a ruin's heap of slabs can keep one busy: nearly all, not all)
    assert.ok(up / faces >= 0.95, `${up} of ${faces} made it up:\n  ${misses.join("\n  ")}`);
  });
});

describe("crawling on walls: server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  it("with the zoomies, a raccoon run into a wall is up it", async () => {
    const f = findFace();
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const client = await colyseus.connectTo(r as any, { name: "Ann" });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as { data: any; send(): void };
    const p = r.state.players.get(client.sessionId) as Player;
    p.x = f.cx + f.nx * 1.5; p.z = f.cz + f.nz * 1.5; p.y = 0; p.vx = 0; p.vy = 0; p.vz = 0;
    p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
    p.zoomies = ticks(10);
    for (let i = 0; i < 30; i++) {
      const d = input.data;
      d.mx = Math.round(-f.nx * 100); d.mz = Math.round(-f.nz * 100);
      d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
      input.send();
      await sleep(STEP_MS);
    }
    assert.strictEqual(p.mode, Mode.Wall);
    assert.ok(p.y > 1, `y ${p.y}`);
  });
});
