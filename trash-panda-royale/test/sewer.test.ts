import assert from "assert";
import {
  MANHOLE_REACH, Mode, RoundPhase, SEWER_AIR_MIN_S, SEWER_AIR_REFILL, SEWER_AIR_S, SEWER_SPEED, SEWER_Y, TICK_RATE, ticks,
} from "../src/shared/constants.ts";
import { lineAt } from "../src/shared/geom.ts";
import { EDGE_SPOKE } from "../src/shared/layout.ts";
import { CITY, groundHeight, roomAt } from "../src/shared/map.ts";
import { leaving, MANHOLES, nearestManhole, SEWER, sewerFlooded } from "../src/shared/sewer.ts";
import {
  EV_ARRIVE, EV_SEWER, EV_UNSEWER, SEWER_AIR, stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";
import { trackDistance } from "../src/shared/train.ts";
import { ZONE_STAGES } from "../src/shared/zone.ts";

const DT = 1 / TICK_RATE;
const idle = (): InputLike => ({ mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 });
const raccoon = (x: number, z: number): PlayerSim => ({
  x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
  grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
});

/** A world with no cars, no loot, no trash cans: just the manholes (`open`: whose lids are off). */
function world(open = new Set<number>()): WorldView {
  return {
    cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], snatch: () => null,
    manhole: (x, z, r) => { const i = nearestManhole(x, z, r); return i < 0 ? null : { i, open: open.has(i) }; },
  };
}

/** Step `p` once with `cmd`; returns the events and what the step said. */
function step(p: PlayerSim, cmd: InputLike, w: WorldView, time = 0) {
  const ctx: SimCtx = { dt: DT, time, memo: (_k, f) => f() };
  const ev = stepPlayer(ctx, p, cmd, w);
  return { ev, ctx };
}

/** Down manhole `i` (stood on it, E), settled. */
function down(i: number, w = world()) {
  const m = MANHOLES[i];
  const p = raccoon(m.x + 0.3, m.z);
  const { ev } = step(p, { ...idle(), use: true }, w);
  assert.ok(ev & EV_SEWER, "dove in");
  for (let k = 0; k < 12; k++) step(p, idle(), w);
  return p;
}

/** The stick pointing along the pipe at manhole `i`, toward its street's `b` end (dir 1) or `a` (-1). */
function along(i: number, dir: number): InputLike {
  const m = MANHOLES[i];
  const t = lineAt(CITY.roads.edges[m.edge], m.s);
  return { ...idle(), mx: Math.round(t.dx * dir * 100), mz: Math.round(t.dz * dir * 100) };
}

describe("the sewer: manholes and pipes", () => {
  it("covers on the streets' centre lines, clear of everything, all over town; every pipe under a street, all joined up", () => {
    assert.ok(MANHOLES.length >= 40, `${MANHOLES.length} manholes`);
    const edges = CITY.roads.edges;
    for (const [i, m] of MANHOLES.entries()) {
      const e = edges[m.edge];
      assert.ok(!(e.flags & EDGE_SPOKE), `manhole ${i} on a spoke out of town`);
      const on = lineAt(e, m.s);
      assert.ok(Math.hypot(on.x - m.x, on.z - m.z) < 0.02, `manhole ${i} off its street's centre line`);
      assert.ok(roomAt(CITY, m.x, m.z, 0, 0.7), `manhole ${i} at (${m.x}, ${m.z}) in something solid`);
      assert.ok(Math.abs(groundHeight(m.x, m.z, 0.5)) < 0.05, `manhole ${i} not on the street`);
      assert.ok(Math.abs(trackDistance(m.x, m.z)) >= 9, `manhole ${i} on the railway`);
      assert.ok(SEWER.onEdge[m.edge].includes(i), `manhole ${i} not listed on its street`);
      for (const [j, q] of MANHOLES.entries()) if (j !== i) assert.ok(Math.hypot(q.x - m.x, q.z - m.z) >= 14, `manholes ${i} and ${j} too close`);
    }
    // every piped street's manholes in order along it
    for (const on of SEWER.onEdge) for (let k = 1; k < on.length; k++) assert.ok(MANHOLES[on[k]].s > MANHOLES[on[k - 1]].s);
    // one network: from the first manhole's street, every manhole's street is reachable under the junctions
    const seen = new Set<number>([MANHOLES[0].edge]), todo = [MANHOLES[0].edge];
    while (todo.length) {
      const e = edges[todo.pop()!];
      for (const n of [e.a, e.b]) for (const f of SEWER.atNode[n]) if (!seen.has(f)) { seen.add(f); todo.push(f); }
    }
    for (const [i, m] of MANHOLES.entries()) assert.ok(seen.has(m.edge), `manhole ${i} cut off from the rest`);
    // and every quarter of town has some
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      assert.ok(MANHOLES.filter((m) => Math.sign(m.x) === sx && Math.sign(m.z) === sz).length >= 6, `few manholes in the (${sx}, ${sz}) quarter`);
    }
  });

  it("E by a manhole dives in; the stick scurries along; letting go stops under the next manhole, rattling those passed; Space climbs out", () => {
    // a street with two manholes on it
    const e = SEWER.onEdge.findIndex((on) => on.length >= 2);
    const [i, j] = SEWER.onEdge[e];
    const p = down(i);
    assert.strictEqual(p.mode, Mode.Sewer);
    assert.strictEqual(p.veh, e);
    assert.strictEqual(p.lz, i);
    assert.strictEqual(p.y, Math.fround(SEWER_Y));
    assert.strictEqual(p.vx, 0);
    // a tap toward j sets us off, and letting go we coast on to j and stop under it
    const rattled: number[] = [];
    let arrived = false;
    for (let k = 0; k < 6 * TICK_RATE && !arrived; k++) {
      const { ev, ctx } = step(p, k < 3 ? along(i, 1) : idle(), world());
      if (ctx.rattled) rattled.push(...ctx.rattled);
      arrived = !!(ev & EV_ARRIVE);
      assert.ok(Math.abs(p.vx) <= SEWER_SPEED + 1e-3);
    }
    assert.ok(arrived, "stopped under a manhole");
    assert.strictEqual(p.lz, j, "under the next one along");
    assert.deepStrictEqual(rattled, [j], "rattled it on the way");
    assert.ok(Math.hypot(p.x - MANHOLES[j].x, p.z - MANHOLES[j].z) < 0.05, "right under its cover");
    for (let k = 0; k < 12; k++) step(p, idle(), world());
    const { ev, ctx } = step(p, { ...idle(), jump: true }, world());
    assert.ok(ev & EV_UNSEWER, "climbed out");
    assert.strictEqual(ctx.hole, j);
    assert.strictEqual(p.mode, Mode.Foot);
    assert.ok(p.vy > 5, "hopping up out of the hole");
  });

  it("Space on the way: out of the next manhole, the moment it gets there", () => {
    const e = SEWER.onEdge.findIndex((on) => on.length >= 2);
    const [i, j] = SEWER.onEdge[e];
    const p = down(i);
    let out = -1;
    for (let k = 0; k < 6 * TICK_RATE && p.mode === Mode.Sewer; k++) {
      const { ev, ctx } = step(p, k < 6 ? along(i, 1) : k === 8 ? { ...idle(), jump: true } : idle(), world());
      if (ev & EV_UNSEWER) out = ctx.hole!;
    }
    assert.strictEqual(out, j, "climbed out of the next one");
    assert.strictEqual(p.mode, Mode.Foot);
    assert.ok(Math.hypot(p.x - MANHOLES[j].x, p.z - MANHOLES[j].z) < 0.3);
  });

  it("held on, it goes past manholes and through junctions the way the stick points (straight on without one); a dead end turns it round", () => {
    // from a manhole near a junction where a street goes off to the side: run toward the junction, steering into the side street
    let tried = 0;
    for (const [i, m] of MANHOLES.entries()) {
      const e = CITY.roads.edges[m.edge];
      for (const dir of [1, -1]) {
        const node = dir > 0 ? e.b : e.a;
        const others = SEWER.atNode[node].filter((f) => f !== m.edge);
        if (others.length < 2) continue;
        // the side street: the one that turns the most
        const into = lineAt(e, dir > 0 ? e.len : 0);
        const hx = into.dx * dir, hz = into.dz * dir;
        const d = { x: 0, z: 0 };
        const side = others.map((f) => ({ f, turn: (leaving(CITY.roads.edges[f], node, d), d.x * hx + d.z * hz), dx: d.x, dz: d.z })).sort((a, b) => a.turn - b.turn)[0];
        if (side.turn > 0.3) continue;
        const p = down(i);
        let ended = false;
        for (let k = 0; k < 15 * TICK_RATE && !ended; k++) {
          // along the pipe until the junction, then into the side street
          const near = Math.hypot(p.x - CITY.roads.nodes[node].x, p.z - CITY.roads.nodes[node].z) < 10;
          const cmd = p.veh === m.edge && !near ? along(i, dir) : { ...idle(), mx: Math.round(side.dx * 100), mz: Math.round(side.dz * 100) };
          step(p, cmd, world());
          if (p.veh === side.f) ended = true;
          if (p.mode !== Mode.Sewer) break;
        }
        assert.ok(ended, `from manhole ${i} the stick took it into street ${side.f}`);
        tried++;
        break;
      }
      if (tried >= 3) break;
    }
    assert.ok(tried >= 3, "found junctions to try");
    // a dead end: the cul-de-sac's street turns you round
    const cds = CITY.roads.nodes.findIndex((n) => SEWER.atNode.length && n.kind === "culdesac");
    const deadStreet = SEWER.atNode[cds]?.[0];
    if (deadStreet !== undefined && SEWER.onEdge[deadStreet].length) {
      const i = SEWER.onEdge[deadStreet][SEWER.onEdge[deadStreet].length - 1];
      const e = CITY.roads.edges[deadStreet];
      const dir = e.b === cds ? 1 : -1;
      const p = down(i);
      let turned = false;
      for (let k = 0; k < 8 * TICK_RATE && !turned; k++) {
        step(p, k < 4 ? along(i, dir) : idle(), world());
        if (p.vx * dir < 0) turned = true;
      }
      assert.ok(turned, "turned round at the dead end");
    }
  });

  it("walking onto an open manhole drops you in; a closed one you just walk over", () => {
    const i = 3, m = MANHOLES[i];
    const run = (open: boolean) => {
      const p = raccoon(m.x - 3, m.z);
      const w = world(open ? new Set([i]) : new Set());
      for (let k = 0; k < 40; k++) {
        const dx = m.x - p.x, dz = m.z - p.z, l = Math.hypot(dx, dz) || 1;
        step(p, { ...idle(), mx: Math.round((dx / l) * 100), mz: Math.round((dz / l) * 100) }, w);
        if (p.mode === Mode.Sewer) return p;
      }
      return p;
    };
    assert.strictEqual(run(true).mode, Mode.Sewer, "fell in");
    assert.strictEqual(run(false).mode, Mode.Foot, "walked over it");
  });

  it("only from the street: E from a roof's edge over a manhole doesn't dive", () => {
    const m = MANHOLES[0];
    const p = raccoon(m.x, m.z);
    p.y = 2; p.grounded = false; p.vy = 0;
    step(p, { ...idle(), use: true }, world());
    assert.notStrictEqual(p.mode, Mode.Sewer);
    assert.ok(MANHOLE_REACH > 1);
  });

  it("a breath lasts SEWER_AIR_S: then up the manhole, gasping (dazed); up top it comes back SEWER_AIR_REFILL times slower", () => {
    const w = world(), p = down(10, w);
    // (down() spent 12 steps under it already)
    let n = 12, ev = 0;
    while (p.mode === Mode.Sewer && n < 2 * ticks(SEWER_AIR_S)) { ev = step(p, idle(), w).ev; n++; }
    assert.ok(ev & EV_UNSEWER, "came up");
    assert.strictEqual(n, ticks(SEWER_AIR_S), `out after ${n} steps`);
    assert.strictEqual(p.mode, Mode.Knocked, "gasping");
    for (let k = 0; k < ticks(SEWER_AIR_S); k++) step(p, idle(), w);
    assert.strictEqual(p.mode, Mode.Foot, "back on its feet");
    assert.strictEqual(p.stench, SEWER_AIR - ticks(SEWER_AIR_S), "as long up top: a third of it back");
    assert.strictEqual(SEWER_AIR_REFILL, 3);
  });

  it("out of breath on the move, stick held or not: up the next manhole it gets to", () => {
    const w = world(), i = 10, p = down(i, w);
    for (let k = 0; k < 10; k++) step(p, along(i, 1), w);
    assert.notStrictEqual(p.vx, 0, "on the move");
    p.stench = SEWER_AIR - SEWER_AIR_REFILL;
    let ev = 0, hole = -1;
    for (let k = 0; k < 10 * TICK_RATE && p.mode === Mode.Sewer; k++) {
      const s = step(p, along(i, 1), w);
      ev = s.ev; hole = s.ctx.hole ?? -1;
    }
    assert.ok(ev & EV_UNSEWER, "came up");
    assert.strictEqual(p.mode, Mode.Knocked, "gasping");
    assert.ok(hole >= 0 && Math.hypot(p.x - MANHOLES[hole].x, p.z - MANHOLES[hole].z) < 1e-3, "out of a manhole");
  });

  it("short of breath (under SEWER_AIR_MIN_S left), no way down: E by a manhole does nothing, an open one you walk over", () => {
    const i = 3, m = MANHOLES[i];
    // the most a dive allows
    const most = SEWER_AIR - ticks(SEWER_AIR_MIN_S) * SEWER_AIR_REFILL;
    const p = raccoon(m.x + 0.3, m.z);
    p.stench = most + 2;
    step(p, { ...idle(), use: true }, world());
    assert.strictEqual(p.mode, Mode.Foot, "too short of breath");
    assert.ok(step(p, { ...idle(), use: true }, world()).ev & EV_SEWER, "just enough: down");
    const q = raccoon(m.x - 3, m.z), w = world(new Set([i]));
    q.stench = most + 100;
    for (let k = 0; k < 40; k++) {
      const dx = m.x - q.x, dz = m.z - q.z, l = Math.hypot(dx, dz) || 1;
      step(q, { ...idle(), mx: Math.round((dx / l) * 100), mz: Math.round((dz / l) * 100) }, w);
    }
    assert.strictEqual(q.mode, Mode.Foot, "walked over the open one");
  });

  it("floods for the showdown: once the last circle closes in, or a round of more than two is down to two", () => {
    const r = (stage: number, entrants: number, alive: number, phase: number = RoundPhase.Live) => ({ phase, entrants, alive, zone: { stage } });
    assert.ok(!sewerFlooded(r(0, 6, 6)), "a round under way");
    assert.ok(sewerFlooded(r(ZONE_STAGES.length - 1, 6, 5)), "the last circle");
    assert.ok(sewerFlooded(r(1, 6, 2)), "the last two");
    assert.ok(!sewerFlooded(r(1, 2, 2)), "a round of two keeps it until the last circle");
    assert.ok(!sewerFlooded(r(ZONE_STAGES.length, 6, 1, RoundPhase.Victory)), "not after the round");
  });

  it("is deterministic: the same inputs, the same run, bit for bit", () => {
    const run = () => {
      const p = down(10);
      const out: number[] = [];
      for (let k = 0; k < 8 * TICK_RATE; k++) {
        const a = (k * 0.07) % (Math.PI * 2);
        step(p, { ...idle(), mx: Math.round(Math.sin(a) * 100), mz: Math.round(Math.cos(a) * 100), jump: k === 200 }, world(), k * 33);
        out.push(p.x, p.z, p.lx, p.vx, p.veh, p.lz, p.mode);
      }
      return out;
    };
    assert.deepStrictEqual(run(), run());
  });
});
