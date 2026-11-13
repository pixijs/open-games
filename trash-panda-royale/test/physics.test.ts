import assert from "assert";
import { CAR_TYPES, CLIMB_SETTLE, Mode, PLAYER_RADIUS, ticks, TICK_RATE } from "../src/shared/constants.ts";
import {
  collideCar, groundHeight, makeBox, makePit, makeRamp, makeStaticWorld, placeParts, segmentClear, withStaticWorld, type Box, type Pit, type Ramp,
} from "../src/shared/map.ts";
import { KIT } from "../src/shared/kit.ts";
import {
  EV_CLIMB, EV_DAZE, EV_JUMP, stepGrenade, stepPlayer, type GrenadeLike, type InputLike, type PlayerSim, type SeenCar, type WorldView,
} from "../src/shared/sim.ts";

/**
 * The static world's new shapes (turned boxes, floating slabs, solid ramps, pits) and what the
 * shared step does with them: no tunnelling through roofs, climbing ledges, coyote time and
 * the daze from a long fall. Every test runs in a small world of its own (`withStaticWorld`).
 */
describe("walls, roofs, stairs and ledges (shared step)", () => {
  const DT = 1 / TICK_RATE;
  const STEP_MS = 1000 / TICK_RATE;
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  const noCars: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const at = (x: number, z: number, y = 0): PlayerSim => ({
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: y === 0, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  /** Runs `n` steps; `cmd(i)` gives each one's input. Returns the OR of every step's events, and calls `each` after each step. */
  const run = (s: PlayerSim, n: number, cmd: (i: number) => Partial<InputLike>, world = noCars, each?: (i: number, ev: number) => void | boolean) => {
    let all = 0;
    for (let i = 0; i < n; i++) {
      const ev = stepPlayer({ dt: DT, time: Math.round(5000 + i * STEP_MS), memo: (_k, f) => f() }, s, { ...idle, ...cmd(i) }, world);
      all |= ev;
      if (each?.(i, ev) === true) break;
    }
    return all;
  };
  const world = (boxes: Box[], ramps: Ramp[] = [], pits: Pit[] = []) => makeStaticWorld(boxes, ramps, pits);
  /** Drops onto whatever is below and settles. */
  const settle = (s: PlayerSim, world = noCars) => run(s, 120, () => ({}), world, () => s.grounded && s.vy === 0);

  it("a box turned 30° is never walked into, from any side", () => {
    const b = makeBox(0, 0, Math.PI / 6, 2, 1.2, 4);
    withStaticWorld(world([b]), () => {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const s = at(Math.sin(a) * 6, Math.cos(a) * 6);
        run(s, 60, () => ({ mx: -Math.sin(a) * 100, mz: -Math.cos(a) * 100 }), noCars, () => {
          // in the box's frame, the player's centre stays a radius away from it
          const dx = s.x - b.rot!.cx, dz = s.z - b.rot!.cz;
          const lx = dx * b.rot!.c - dz * b.rot!.s, lz = dx * b.rot!.s + dz * b.rot!.c;
          const ex = Math.max(0, Math.abs(lx) - b.rot!.hx), ez = Math.max(0, Math.abs(lz) - b.rot!.hz);
          assert.ok(Math.hypot(ex, ez) >= PLAYER_RADIUS - 1e-4, `from ${k}: ${Math.hypot(ex, ez)}`);
        });
        assert.strictEqual(s.y, 0, "still on the ground");
      }
    });
  });

  it("a plank overhead is walked under, a low slab bonks a jump, and a plank holds you up", () => {
    const plank = makeBox(0, 0, 0, 3, 0.45, 4, { base: 3.88 });
    const slab = makeBox(10, 0, 0, 2, 2, 2.75, { base: 2.6 });
    withStaticWorld(world([plank, slab]), () => {
      const s = at(0, -5);
      run(s, 60, () => ({ mz: 100 }));
      assert.ok(s.z > 4, `walked under it: z ${s.z}`);
      assert.strictEqual(s.y, 0);

      const j = at(10, 0);
      let top = 0;
      run(j, 30, (i) => ({ jump: i === 0 }), noCars, () => { top = Math.max(top, j.y); });
      assert.ok(top + 1.3 <= 2.6 + 1e-4, `head under the slab: ${top + 1.3}`);
      assert.strictEqual(j.y, 0, "back down");

      const p = at(0, 0, 6);
      settle(p);
      assert.strictEqual(p.y, Math.fround(4), "standing on the plank");
    });
  });

  // a flight of stairs up to a 5 m roof: 0.67 slope, a roof box beyond its top
  const stairs = () => [makeRamp(0, 0, 0, 0.65, 3.75, 0, 5, { solid: true })];
  const roof = () => [makeBox(0, 7.75, 0, 4, 4, 5)];

  for (const fast of [false, true]) {
    it(`stairs: ${fast ? "with the zoomies" : "walking"}, up and back down without leaving them`, () => {
      withStaticWorld(world(roof(), stairs()), () => {
        const s = at(0, -5);
        if (fast) s.zoomies = 999;
        run(s, 90, () => ({ mz: 100 }), noCars, () => s.z > 5);
        assert.strictEqual(s.y, Math.fround(5), `on the roof: y ${s.y}`);
        assert.ok(s.z > 4, `z ${s.z}`);
        // back down: never in the air on the way
        s.zoomies = fast ? 999 : 0;
        run(s, 90, () => ({ mz: -100 }), noCars, (_i, _ev) => {
          if (s.z > -3.5 && s.z < 3.5) assert.ok(s.grounded, `airborne on the stairs at z ${s.z.toFixed(2)}, y ${s.y.toFixed(2)}`);
        });
        assert.strictEqual(s.y, 0);
        assert.ok(s.z < -4);
      });
    });
  }

  it("stairs: a wall from the side where they're high, a step where they're low", () => {
    withStaticWorld(world(roof(), stairs()), () => {
      const s = at(-3, 1.5); // beside the middle of the flight (about 3.3 m up)
      run(s, 40, () => ({ mx: 100 }));
      assert.strictEqual(s.y, 0);
      assert.ok(s.x <= -0.65 - PLAYER_RADIUS + 1e-4, `stopped at its side: x ${s.x}`);
      const f = at(-3, -3.6); // beside its foot (a few cm up)
      run(f, 40, () => ({ mx: 100 }));
      assert.ok(f.x > -0.65, `stepped onto it: x ${f.x}`);
    });
  });

  for (const h of [14, 30]) {
    it(`a ${h} m fall lands on a roof, a low box and a plank (no tunnelling through)`, () => {
      const tops = [5, 0.5];
      for (const top of tops) {
        withStaticWorld(world([makeBox(0, 0, 0, 3, 3, top)]), () => {
          const s = at(0.7, -0.4, h);
          settle(s);
          assert.strictEqual(s.y, Math.fround(top), `onto ${top}`);
          assert.strictEqual(s.x, Math.fround(0.7));
          assert.strictEqual(s.z, Math.fround(-0.4));
        });
      }
      withStaticWorld(world([makeBox(0, 0, 0, 3, 0.45, 4, { base: 3.88 })]), () => {
        const s = at(0, 0, h);
        settle(s);
        assert.strictEqual(s.y, Math.fround(4), "onto the plank");
      });
    });
  }

  it(`a fall onto a car's roof lands on it and rides it (no tunnelling through, no daze)`, () => {
    const t = CAR_TYPES[0];
    const c: SeenCar = { id: 7, kind: 0, driven: false, wreck: false, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: t.halfL, halfW: t.halfW, roof: t.roof };
    const withCar: WorldView = { ...noCars, cars: () => [c], car: (id) => (id === 7 ? c : null) };
    withStaticWorld(world([]), () => {
      const s = at(0.1, 0.2, 14);
      const ev = run(s, 120, () => ({}), withCar, () => s.mode === Mode.Roof);
      assert.strictEqual(s.mode, Mode.Roof);
      assert.ok(!(ev & EV_DAZE));
    });
  });

  // ---------------------------------------------------------------- ledges
  /** A wall from x = 0.5 on (its face toward us at x = 0.5), `top` high and `deep` deep, with an optional clutter box on it. */
  const wall = (top: number, deep = 4, clutter = false) => {
    const boxes = [makeBox(0.5 + deep / 2, 0, 0, deep / 2, 3, top)];
    if (clutter) boxes.push(makeBox(1.2, 0, 0, 0.4, 3, top + 1.5));
    return world(boxes);
  };
  /** Jump at the wall from just in front of it, the stick as given. Returns the events. */
  const jumpAt = (s: PlayerSim, stick: Partial<InputLike>) => run(s, 40, (i) => ({ ...stick, jump: i === 0 }), noCars, (_i, ev) => !!(ev & EV_CLIMB));

  it("a jump into a 3.2 m wall, pushing into it, climbs it", () => {
    withStaticWorld(wall(3.2), () => {
      const s = at(0, 0);
      const ev = jumpAt(s, { mx: 100 });
      assert.ok(ev & EV_CLIMB, "climbed");
      assert.strictEqual(s.y, Math.fround(3.2));
      assert.ok(s.x > 0.5 + PLAYER_RADIUS - 1e-4, `on top, in from the edge: x ${s.x}`);
      assert.strictEqual(s.mode, Mode.Foot);
    });
  });

  it("but not a 3.5 m wall, nor without pushing into it, nor jumping along it", () => {
    withStaticWorld(wall(3.5), () => assert.ok(!(jumpAt(at(0, 0), { mx: 100 }) & EV_CLIMB), "3.5 m is out of reach"));
    withStaticWorld(wall(2.9), () => {
      assert.ok(!(jumpAt(at(0, 0), {}) & EV_CLIMB), "no stick");
      assert.ok(!(jumpAt(at(0.1, -1.5), { mz: 100 }) & EV_CLIMB), "along the wall");
    });
  });

  it("a wall's thin top, or one with no room on it, isn't a ledge", () => {
    withStaticWorld(wall(2.9, 0.3), () => assert.ok(!(jumpAt(at(0, 0), { mx: 100 }) & EV_CLIMB), "0.3 m deep"));
    withStaticWorld(wall(2.9, 4, true), () => assert.ok(!(jumpAt(at(0, 0), { mx: 100 }) & EV_CLIMB), "cluttered"));
  });

  it("after a climb, the stick held into the wall and the held jump do nothing for a moment", () => {
    withStaticWorld(wall(2.9), () => {
      const s = at(0, 0);
      assert.ok(jumpAt(s, { mx: 100 }) & EV_CLIMB);
      const x0 = s.x;
      let jumped = false;
      run(s, ticks(CLIMB_SETTLE), () => ({ mx: 100, jump: true }), noCars, (_i, ev) => { if (ev & EV_JUMP) jumped = true; });
      assert.strictEqual(s.x, x0, "not walked on");
      assert.ok(!jumped, "not hopped off");
      run(s, 10, () => ({ mx: 100 }));
      assert.ok(s.x > x0, "then walks");
    });
  });

  it("climbs out of a 2.2 m pit with a jump into its side", () => {
    withStaticWorld(world([], [], [makePit(0, 0, 0, 3, 3, -2.2)]), () => {
      const s = at(0, 0, -2.2);
      s.grounded = true;
      run(s, 40, () => ({ mx: 100 }));
      assert.strictEqual(s.y, Math.fround(-2.2), "the wall held");
      assert.ok(s.x <= 3 - PLAYER_RADIUS + 1e-4, `x ${s.x}`);
      const ev = jumpAt(s, { mx: 100 });
      assert.ok(ev & EV_CLIMB, "climbed out");
      assert.strictEqual(s.y, 0);
      assert.ok(s.x > 3);
    });
  });

  // ---------------------------------------------------------------- coyote time, daze
  /** Walks east off a `h` m high block whose edge is at x = 0, jumping `late` steps after the step that left it. */
  const walkOff = (h: number, late: number) => {
    const s = at(-2, 0, h);
    s.grounded = true;
    let left = -1, jumpAt = -1;
    run(s, 60, (i) => ({ mx: 60, jump: left >= 0 && i === left + late }), noCars, (i, ev) => {
      if (left < 0 && !s.grounded) left = i;
      if (ev & EV_JUMP) jumpAt = i;
    });
    return jumpAt >= 0;
  };

  it("a jump just after walking off an edge still works (coyote time); a late one doesn't", () => {
    withStaticWorld(world([makeBox(-5, 0, 0, 5, 3, 3)]), () => {
      assert.ok(walkOff(3, 1), "1 step late");
      assert.ok(walkOff(3, 2), "2 steps late");
      assert.ok(!walkOff(3, 6), "6 steps late");
    });
  });

  it("no second jump in the air", () => {
    withStaticWorld(world([]), () => {
      const s = at(0, 0);
      let jumps = 0;
      run(s, 40, (i) => ({ jump: i === 0 || i === 3 || i === 11 }), noCars, (_i, ev) => { if (ev & EV_JUMP) jumps++; });
      assert.strictEqual(jumps, 1);
    });
  });

  it("walking off 6.5 m is free; off 8 m dazes you for a second", () => {
    for (const [h, dazed] of [[6.5, false], [8, true]] as const) {
      withStaticWorld(world([makeBox(-5, 0, 0, 5, 3, h)]), () => {
        const s = at(-1, 0, h);
        s.grounded = true;
        let daze = -1;
        run(s, 60, () => ({ mx: 100 }), noCars, (i, ev) => { if (ev & EV_DAZE) daze = i; return daze >= 0; });
        assert.strictEqual(daze >= 0, dazed, `${h} m`);
        if (!dazed) return;
        assert.strictEqual(s.mode, Mode.Knocked);
        assert.strictEqual(s.y, 0);
        let up = -1;
        run(s, 60, () => ({ mx: 100 }), noCars, (i) => { if (s.mode === Mode.Foot) { up = i; return true; } });
        assert.ok(up >= ticks(1) - 2 && up <= ticks(1) + 2, `back on its feet after ${up} steps`);
      });
    }
  });

  it("a running jump off a shop roof (4.95 m) is free", () => {
    withStaticWorld(world([makeBox(-5, 0, 0, 5, 3, 4.95)]), () => {
      const s = at(-1.5, 0, 4.95);
      s.grounded = true;
      const ev = run(s, 60, (i) => ({ mx: 100, sprint: true, jump: i === 4 }));
      assert.ok(!(ev & EV_DAZE));
      assert.strictEqual(s.mode, Mode.Foot);
    });
  });

  it("E on a roof's edge doesn't get you into the car parked below", () => {
    const t = CAR_TYPES[0];
    const c: SeenCar = { id: 7, kind: 0, driven: false, wreck: false, x: 1.6, z: 0, yaw: 0, vx: 0, vz: 0, halfL: t.halfL, halfW: t.halfW, roof: t.roof };
    const withCar: WorldView = { ...noCars, cars: () => [c], car: (id) => (id === 7 ? c : null) };
    withStaticWorld(world([makeBox(-2, 0, 0, 2, 3, 4.95)]), () => {
      const s = at(-0.3, 0, 4.95);
      run(s, 2, () => ({ use: true }), withCar);
      assert.strictEqual(s.mode, Mode.Foot);
    });
  });

  // ---------------------------------------------------------------- pits
  it("a pit: you drop in, its walls hold, a ramp gets you out; a grenade stays in; a car can't drive in", () => {
    const pit = makePit(0, 0, 0, 4, 3, -2.2);
    // a ramp in the pit's west end, rising westward to its rim
    const out = makeRamp(-2.5, 0, -Math.PI / 2, 3, 1.5, -2.2, 0, { solid: true });
    withStaticWorld(world([], [out], [pit]), () => {
      assert.strictEqual(groundHeight(2, 0, 0), -2.2);
      const s = at(2, -6);
      run(s, 60, () => ({ mz: 100 }));
      assert.strictEqual(s.y, Math.fround(-2.2), "fell in");
      assert.ok(s.z <= 3 - PLAYER_RADIUS + 1e-4, `the far wall held: z ${s.z}`);
      // walk west: up the ramp and out over the rim
      run(s, 90, () => ({ mx: -100 }));
      assert.strictEqual(s.y, 0, `out: y ${s.y}, x ${s.x}`);
      assert.ok(s.x < -4);

      const g: GrenadeLike = { x: 2, y: -1.5, z: 0, vx: 6, vy: 0, vz: 0 };
      for (let i = 0; i < 300; i++) stepGrenade(g, 1 / 60);
      assert.ok(g.x < 4 && g.y < -2, `stays in: ${g.x.toFixed(2)}, ${g.y.toFixed(2)}`);

      const car = { x: 7, z: 0 };
      assert.ok(collideCar(car, 1, undefined) === false);
      car.x = 4.5;
      assert.ok(collideCar(car, 1), "the rim stops a car");
      assert.ok(car.x >= 5 - 1e-6, `pushed out: ${car.x}`);
    });
  });

  it("line of sight: a box is a column, a floating slab has room under it, a pit is open only down in it", () => {
    withStaticWorld(world([makeBox(0, 0, 0, 1, 1, 5), makeBox(0, 10, 0, 1, 1, 6, { base: 4 })], [], [makePit(0, -10, 0, 3, 3, -2.2)]), () => {
      assert.ok(!segmentClear(-5, 1, 0, 5, 1, 0), "through the box");
      assert.ok(segmentClear(-5, 6, 0, 5, 6, 0), "over it");
      assert.ok(segmentClear(-5, 1, 10, 5, 1, 10), "under the slab");
      assert.ok(!segmentClear(-5, 5, 10, 5, 5, 10), "through the slab");
      assert.ok(segmentClear(-1, -1, -10, 1, -1.5, -10), "across the pit, down in it");
      assert.ok(!segmentClear(-1, -1, -10, 8, 0.5, -10), "out through its wall");
    });
  });

  // ---------------------------------------------------------------- the buildings' own colliders (kit.json)
  /** A model's colliders at the origin, facing +z (its front toward +z). */
  const building = (model: string, withStairs = false) => {
    const out = { boxes: [] as Box[], ramps: [] as Ramp[] };
    placeParts(KIT.buildings[model], 0, 0, 0, out);
    if (withStairs) placeParts(KIT.buildings[model].stairs!, 0, 0, 0, out);
    return world(out.boxes, out.ramps);
  };

  it("a shop: a running jump grabs its awning, and a jump from there gets onto its roof", () => {
    withStaticWorld(building("bld_shop"), () => {
      let ok = 0;
      // sprint at it, jumping from 1.8 to 4.6 m short of the awning's edge (z 5.35): by the time
      // a raccoon reaches it, it's high enough to meet its side, not run under it
      for (let d = 1.8; d <= 4.61; d += 0.4) {
        const s = at(0, 14);
        let jumped = false;
        const ev = run(s, 60, () => {
          const jump = !jumped && s.z <= 5.35 + d;
          if (jump) jumped = true;
          return { mz: -100, sprint: true, jump };
        }, noCars, (_i, e) => !!(e & EV_CLIMB));
        if (!(ev & EV_CLIMB)) continue;
        ok++;
        assert.ok(s.y > 2.9 && s.y < 3.45, `on the awning: y ${s.y}`);
        // from the awning: a jump into the wall lands on the roof
        run(s, 40, (i) => ({ mz: -100, jump: i === 8 }));
        assert.strictEqual(s.y, Math.fround(4.97), `on the roof: y ${s.y}`);
      }
      assert.ok(ok >= 6, `the awning caught ${ok} of 8 running jumps`);
    });
  });

  /** Walks `s` to each (x, z) in turn (stopping within 0.15 m), for at most 90 steps each. */
  const walkThrough = (s: PlayerSim, pts: [number, number][]) => {
    for (const [x, z] of pts) {
      run(s, 90, () => {
        const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz);
        return { mx: Math.round((100 * dx) / d), mz: Math.round((100 * dz) / d) };
      }, noCars, () => Math.hypot(x - s.x, z - s.z) < 0.15);
    }
  };

  it("a shop's stairs and an apartment's fire escape go all the way up", () => {
    withStaticWorld(building("bld_shop", true), () => {
      const s = at(6.55, 4.3);
      walkThrough(s, [[6.55, -3.9], [5, -3.9]]);
      assert.strictEqual(s.y, Math.fround(4.97), `the shop's roof: y ${s.y}`);
    });
    withStaticWorld(building("bld_apartment", true), () => {
      // up flight 1 (inner lane), across the landing, flight 2 (outer lane) back, and so on, then onto the roof
      const s = at(6.3, 3.6);
      const A = 6.3, B = 7.4, lo = -2.3, hi = 3.5;
      walkThrough(s, [[A, lo], [B, lo], [B, hi], [A, hi], [A, lo], [B, lo], [B, hi], [A, hi], [5, hi]]);
      assert.strictEqual(s.y, Math.fround(13.67), `the apartment's roof: y ${s.y} at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`);
    });
  });

  it("the burnt-out shell: in through the hole in its back wall, but not through the wall beside it", () => {
    const out = { boxes: [] as Box[], ramps: [] as Ramp[] };
    placeParts(KIT.setpieces.shell, 0, 0, 0, out);
    withStaticWorld(world(out.boxes, out.ramps), () => {
      const s = at(4.5, -6.5);
      walkThrough(s, [[4.5, -3.5]]);
      assert.ok(s.z > -3.7, `inside: z ${s.z}`);
      const w = at(2, -6.5);
      walkThrough(w, [[2, -3.5]]);
      assert.ok(w.z <= -5 - PLAYER_RADIUS + 1e-3, `held by the wall: z ${w.z}`);
    });
  });

  it("a donut shop: a jump from its roof lands in the giant donut's hole", () => {
    withStaticWorld(building("bld_donut"), () => {
      const s = at(0, 1.4, 4.25);
      s.grounded = true;
      run(s, 40, (i) => ({ mz: -100, jump: i === 2 }), noCars, () => s.grounded && s.y > 6);
      assert.strictEqual(s.y, Math.fround(6.13));
    });
  });

  it("is deterministic over a mixed course", () => {
    const boxes = [makeBox(0, 0, Math.PI / 5, 2, 2, 2.6), makeBox(6, 0, 0, 2, 3, 4.95), makeBox(6, 6, 0, 3, 0.45, 5, { base: 4.88 })];
    const ramps = [makeRamp(-4, 4, 0.4, 0.7, 3, 0, 2.6, { solid: true })];
    const go = () => withStaticWorld(world(boxes, ramps, [makePit(-6, -6, 0, 2, 2, -2.2)]), () => {
      const s = at(-8, 8);
      const trail: number[] = [];
      run(s, 400, (i) => ({ mx: Math.round(100 * Math.sin(i * 0.05)), mz: Math.round(100 * Math.cos(i * 0.031)), jump: i % 17 === 0, sprint: i % 50 < 25 }), noCars, () => {
        trail.push(s.x, s.y, s.z, s.mode);
      });
      return trail;
    });
    assert.deepStrictEqual(go(), go());
  });
});
