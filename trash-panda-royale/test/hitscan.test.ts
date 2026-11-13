import assert from "assert";
import { Mode, TICK_RATE, Weapon, WEAPONS } from "../src/shared/constants.ts";
import { BLAST_KICK, BLAST_LIFT, EV_FIRE, stepPlayer, type InputLike, type PlayerSim, type WorldView } from "../src/shared/sim.ts";
import {
  AIM_Q, autoPitch, BLAST_CONE, BLAST_FAR, BLAST_FULL, DRIVE_EYE_Y, EYE_Y, GUN_Y, newPellet, pelletDamage, pelletDir, shotHeight, shotYaw, tracePellet, type ShotTarget,
} from "../src/shared/hitscan.ts";
import { makeBox, makePit, makeRamp, makeStaticWorld, rayStatic, withStaticWorld } from "../src/shared/map.ts";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("rays in 3D through the town (shared)", () => {
  const w = makeStaticWorld(
    [makeBox(0, 0, 0, 1, 1, 5), makeBox(0, 10, 0, 1, 1, 6, { base: 4 })],
    [makeRamp(20, 0, 0, 2, 4, 0, 4, { solid: true })],
    [makePit(0, -10, 0, 3, 3, -2.2)],
  );
  const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT = 50) => {
    const l = Math.hypot(dx, dy, dz);
    return withStaticWorld(w, () => rayStatic(ox, oy, oz, dx / l, dy / l, dz / l, maxT));
  };

  it("a box is a column, a floating slab has room under it", () => {
    assert.ok(near(ray(-5, 1, 0, 1, 0, 0), 4), "into the box's face");
    assert.strictEqual(ray(-5, 6, 0, 1, 0, 0), 50, "over it");
    assert.strictEqual(ray(-5, 1, 10, 1, 0, 0), 50, "under the slab");
    assert.ok(near(ray(-5, 5, 10, 1, 0, 0), 4), "into the slab");
    assert.ok(near(ray(0, 9, 0, 0, -1, 0), 4), "straight down onto the box's top");
  });

  it("the street stops a shot going down; a pit is open only down in it", () => {
    assert.ok(near(ray(5, 2, 5, 1, -1, 0), 2 * Math.SQRT2), "into the street");
    assert.ok(near(ray(0, 2, -10, 0, -1, 0), 4.2), "down to the pit's floor");
    assert.ok(near(ray(0, -1, -10, 1, 0, 0), 3), "out through its wall");
    assert.ok(near(ray(0, -1, -10, 1, 1, 0), 50), "up and out over its rim");
  });

  it("a solid ramp is a wedge", () => {
    assert.ok(near(ray(20, 1, -10, 0, 0, 1), 8), "in where its surface reaches the shot's height");
    assert.strictEqual(ray(20, 5, -10, 0, 0, 1), 50, "over its top end");
  });
});

/**
 * The shared hitscan: a straight line in 3D along the aim's yaw and pitch, so a shot goes
 * where it was aimed, up, down or level. A small world of its own: one 5 m building whose east
 * face is at x = 0.
 */
describe("hitscan along the aim (shared)", () => {
  const range = WEAPONS[Weapon.Pistol].range;
  const roof = makeBox(-6, 0, 0, 6, 6, 5);
  const post = makeBox(6, 0, 0, 0.18, 0.18, 4.2); // too thin to stop a bullet
  const wall = makeBox(20, 0, 0, 0.5, 6, 3);
  const barrier = makeBox(10.5, 0, 0, 0.5, 6, 1.2); // chest-high: stops a level shot, not one from a roof
  const w = makeStaticWorld([roof, post, wall, barrier]);
  const raccoon = (x: number, z: number, feet: number): ShotTarget => ({ x, z, y0: feet, y1: feet + 1.45, y: feet + 0.9, r: 0.55 });
  /** A hatchback along z, its roof 1.45 m up. */
  const car = (x: number, z: number): ShotTarget => ({ x, z, y0: 0, y1: 1.45, y: 0.8, r: 0, yaw: 0, hw: 1, hl: 2 });
  /** A pistol shot from the muzzle (ox, oy, oz) at the point (px, py, pz). */
  const at = (ox: number, oy: number, oz: number, px: number, py: number, pz: number, targets: ShotTarget[]) => {
    const yaw = Math.atan2(px - ox, pz - oz), pitch = Math.atan2(py - oy, Math.hypot(px - ox, pz - oz));
    return withStaticWorld(w, () => tracePellet(ox, oy, oz, yaw, pitch, range, targets, newPellet()));
  };
  /** A pistol shot from feet (x, feet, z) aimed east (+x), pitched up by `pitch`. */
  const east = (x: number, feet: number, z: number, targets: ShotTarget[], pitch = 0) =>
    withStaticWorld(w, () => tracePellet(x, feet + 1, z, Math.PI / 2, pitch, range, targets, newPellet()));
  const autoEast = (x: number, feet: number, z: number, targets: ShotTarget[]) =>
    withStaticWorld(w, () => autoPitch(x, feet + 1, z, Math.PI / 2, range, targets));

  it("from a roof's edge, a shot aimed down at the street lands where it was aimed", () => {
    const p = at(-0.5, 6, 0, 8, 0, 0, []);
    assert.strictEqual(p.target, -1);
    assert.ok(near(p.x, 8) && near(p.y, 0) && near(p.z, 0), `${p.x}, ${p.y}, ${p.z}`);
  });

  it("from a roof's edge, hits someone it's aimed at down on the street", () => {
    assert.strictEqual(at(-0.5, 6, 0, 14, 0.9, 0, [raccoon(14, 0, 0)]).target, 0);
  });

  it("from back on the roof, the roof takes a shot down at someone close below", () => {
    const p = at(-6, 6, 0, 3, 0.9, 0, [raccoon(3, 0, 0)]);
    assert.strictEqual(p.target, -1);
    assert.ok(near(p.y, 5) && p.x < 0, `on the roof: ${p.x}, ${p.y}`);
  });

  it("standing on a car, a shot past it misses the car; one aimed down at it hits it", () => {
    const under = [car(14, 0)];
    const level = east(14, 1.45, 0, under);
    assert.strictEqual(level.target, -1, "level, over the bonnet");
    assert.ok(near(level.x, 19.5), `on to the wall: ${level.x}`);
    const street = at(14, 2.45, 0, 14, 0, 6, under);
    assert.strictEqual(street.target, -1, "down to the street beside it");
    assert.ok(near(street.z, 6) && near(street.y, 0), `${street.z}, ${street.y}`);
    assert.strictEqual(at(14, 2.45, 0, 14.8, 1.45, 0, under).target, 0, "down at its bonnet");
  });

  it("level on the street: walls stop it, posts don't", () => {
    const behindWall = east(12, 0, 0, [raccoon(25, 0, 0)]);
    assert.strictEqual(behindWall.target, -1, "the 3 m wall");
    assert.ok(near(behindWall.x, 19.5) && near(behindWall.y, 1), `${behindWall.x}, ${behindWall.y}`);
    assert.strictEqual(east(2, 0, 0, [raccoon(8, 0, 0)]).target, 0, "past the lamp post");
  });

  it("over someone's head misses them", () => {
    assert.strictEqual(east(2, 0, 0, [raccoon(8, 0, 0)], 0.3).target, -1);
  });

  it("the nearest target along the line wins", () => {
    assert.strictEqual(east(2, 0, 0, [raccoon(9, 0, 0), raccoon(8, 0, 0)]).target, 1);
  });

  it("a chest-high barrier stops a level shot, but not one down from a roof", () => {
    assert.strictEqual(east(4, 0, 0, [raccoon(14, 0, 0)]).target, -1, "level");
    const pitch = autoEast(-0.5, 5, 0, [raccoon(14, 0, 0)]);
    assert.ok(pitch !== null && pitch < 0, `pitched down: ${pitch}`);
    assert.strictEqual(east(-0.5, 5, 0, [raccoon(14, 0, 0)], pitch!).target, 0, "from the roof");
  });

  describe("autoPitch (overhead, or a stick: no up or down to aim with)", () => {
    it("from a roof's edge, pitches onto someone on the street below, at the chest", () => {
      const pitch = autoEast(-0.5, 5, 0, [raccoon(10, 0, 0)])!;
      const p = east(-0.5, 5, 0, [raccoon(10, 0, 0)], pitch);
      assert.strictEqual(p.target, 0);
      assert.ok(p.y > 0.8 && p.y < 1.2, `about the chest: ${p.y}`);
    });

    it("from back on the roof, the roof's edge hides someone close below", () => {
      assert.strictEqual(autoEast(-6, 5, 0, [raccoon(3, 0, 0)]), null);
    });

    it("from the street, onto someone at the roof's edge but not someone standing back", () => {
      const west = (targets: ShotTarget[]) => withStaticWorld(w, () => autoPitch(8, 1, 0, -Math.PI / 2, range, targets));
      assert.ok(west([raccoon(-0.6, 0, 5)])! > 0, "at the edge");
      assert.strictEqual(west([raccoon(-3, 0, 5)]), null, "3 m back");
    });

    it("never onto the car you're standing on", () => {
      assert.strictEqual(autoEast(14, 1.45, 0, [car(14, 0)]), null);
      assert.strictEqual(autoEast(14, 1.45, 0, [car(14, 0), raccoon(18, 0, 0)])! < 0, true, "but onto someone past it");
    });

    it("the nearest one you can see wins", () => {
      const pitch = autoEast(-0.5, 5, 0, [raccoon(14, 0, 0), raccoon(9, 0, 0)])!;
      assert.strictEqual(east(-0.5, 5, 0, [raccoon(14, 0, 0), raccoon(9, 0, 0)], pitch).target, 1);
    });
  });

  describe("where a shot leaves from", () => {
    const slab = makeStaticWorld([makeBox(0, 30, 0, 3, 3, 2.2, { base: 1.5 })]);
    it("overhead from the gun; over the raccoon's back from the crosshair's line, under a low ceiling from the gun", () => {
      withStaticWorld(slab, () => {
        assert.strictEqual(shotHeight(0, 0, 0, false, false), GUN_Y);
        assert.strictEqual(shotHeight(0, 0, 0, false, true), EYE_Y);
        assert.strictEqual(shotHeight(0, 2, 0, true, true), 2 + DRIVE_EYE_Y);
        assert.strictEqual(shotHeight(0, 0, 30, false, true), GUN_Y, "under the slab");
      });
    });

    it("from the crosshair's line, a shot down from just back of a roof's edge clears its lip", () => {
      // (a 0.3 m lip along the edge; the gun, lower, would hit it)
      const lipped = makeStaticWorld([roof, makeBox(-0.15, 0, 0, 0.15, 6, 5.3)]);
      const down = (oy: number) => withStaticWorld(lipped, () => {
        const pitch = Math.atan2(-oy, 7.5);
        return tracePellet(-1.5, oy, 0, Math.PI / 2, pitch, range, [], newPellet());
      });
      assert.ok(down(5 + GUN_Y).x < 0, "the gun's line: into the lip");
      const p = down(5 + EYE_Y);
      assert.ok(near(p.x, 6, 1e-3) && near(p.y, 0), `the eye's: on to the street, ${p.x}, ${p.y}`);
    });
  });

  describe("the Blunderbuss's blast", () => {
    const n = WEAPONS[Weapon.Shotgun].pellets;
    const vec = (d: { yaw: number; pitch: number }) => [Math.sin(d.yaw) * Math.cos(d.pitch), Math.sin(d.pitch), Math.cos(d.yaw) * Math.cos(d.pitch)];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    it("is a cone: one pellet down the middle, the rest evenly round it BLAST_CONE out, up, down or level", () => {
      for (const pitch of [-1.1, -0.3, 0, 0.6]) {
        const axis = vec({ yaw: 1, pitch });
        const ring = Array.from({ length: n }, (_, k) => vec(pelletDir(1, pitch, Weapon.Shotgun, k, { yaw: 0, pitch: 0 })));
        assert.ok(near(dot(ring[0], axis), 1), "the middle one");
        for (let k = 1; k < n; k++) {
          assert.ok(near(dot(ring[k], axis), Math.cos(BLAST_CONE)), `pellet ${k} at pitch ${pitch}`);
          const next = ring[k === n - 1 ? 1 : k + 1];
          assert.ok(near(dot(ring[k], next), dot(ring[1], ring[2])), "evenly round");
        }
      }
    });

    it("is the same every time (nothing about it is sent), and a gun's single pellet flies straight", () => {
      const a = pelletDir(0.4, -0.2, Weapon.Shotgun, 3, { yaw: 0, pitch: 0 }), b = pelletDir(0.4, -0.2, Weapon.Shotgun, 3, { yaw: 0, pitch: 0 });
      assert.deepStrictEqual(a, b);
      assert.deepStrictEqual(pelletDir(0.4, -0.2, Weapon.Pistol, 0, { yaw: 0, pitch: 0 }), { yaw: 0.4, pitch: -0.2 });
      assert.strictEqual(shotYaw(1, Weapon.Pistol, 7), 1);
      assert.strictEqual(shotYaw(1, Weapon.Shotgun, 7), 1);
      assert.notStrictEqual(shotYaw(1, Weapon.Smg, 7), shotYaw(1, Weapon.Smg, 8), "a machine gun wobbles by the step");
    });

    it("puts all its pellets in a raccoon close up, fewer further off", () => {
      const count = (d: number) => {
        let hits = 0;
        withStaticWorld(makeStaticWorld([]), () => {
          for (let k = 0; k < n; k++) {
            const dir = pelletDir(Math.PI / 2, 0, Weapon.Shotgun, k, { yaw: 0, pitch: 0 });
            if (tracePellet(100, 1, 100, dir.yaw, dir.pitch, WEAPONS[Weapon.Shotgun].range, [raccoon(100 + d, 100, 0)], newPellet()).target === 0) hits++;
          }
        });
        return hits;
      };
      assert.strictEqual(count(3), n, "3 m");
      assert.strictEqual(count(7), 3, "7 m");
      assert.strictEqual(count(12), 1, "12 m");
    });

    describe("its kick (shared step: predicted, nothing sent)", () => {
      const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
      const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: Math.PI / 2, fire: false, jump: false, sprint: false, use: false, weapon: Weapon.Shotgun };
      const fresh = (weapon: number = Weapon.Shotgun): PlayerSim => ({
        x: 0, y: 0, z: -22, vx: 0, vy: 0, vz: 0, yaw: Math.PI / 2, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
        grounded: true, weapon, ammo1: 10, ammo2: 0, ammo3: 10, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
      });
      let time = 0;
      const step = (s: PlayerSim, cmd: InputLike) => stepPlayer({ dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f() }, s, cmd, world);

      it("on the ground, it skids you back a little, away from the shot", () => {
        const s = fresh();
        assert.ok(step(s, { ...idle, fire: true }) & EV_FIRE);
        assert.ok(near(s.vx, -BLAST_KICK, 1e-3), `kicked back: vx ${s.vx}`);
        for (let i = 0; i < 20; i++) step(s, idle);
        assert.ok(s.x < -0.2 && s.x > -0.5 && Math.abs(s.vx) < 0.05, `skidded ${s.x.toFixed(2)} m and stopped`);
        const p = fresh(Weapon.Pistol);
        step(p, { ...idle, weapon: Weapon.Pistol, fire: true });
        assert.strictEqual(p.vx, 0, "a pop-gun doesn't kick");
      });

      it("in the air, a blast down holds you up, never above BLAST_LIFT; a level one doesn't", () => {
        const down = Math.round((-Math.PI / 2) * AIM_Q);
        const air = (vy: number) => { const s = fresh(); s.y = 3; s.vy = vy; s.grounded = false; return s; };
        const a = air(-12);
        step(a, { ...idle, fire: true, pitch: down });
        assert.ok(near(a.vy, BLAST_LIFT, 1e-3), `falling fast, then up: vy ${a.vy}`);
        const b = air(5);
        step(b, { ...idle, fire: true, pitch: down });
        assert.ok(near(b.vy, BLAST_LIFT, 1e-3), `rising, no faster than BLAST_LIFT: vy ${b.vy}`);
        const c = air(2);
        step(c, { ...idle, fire: true, pitch: 0 });
        assert.ok(c.vy < 2, `level: just falling, vy ${c.vy}`);
      });
    });

    it("does full damage out to BLAST_FULL m, then less, down to BLAST_FAR of it at its range", () => {
      const w = WEAPONS[Weapon.Shotgun];
      assert.strictEqual(pelletDamage(Weapon.Shotgun, BLAST_FULL), w.damage);
      assert.ok(near(pelletDamage(Weapon.Shotgun, w.range), w.damage * BLAST_FAR));
      assert.ok(pelletDamage(Weapon.Shotgun, 12) < w.damage && pelletDamage(Weapon.Shotgun, 12) > w.damage * BLAST_FAR);
      assert.strictEqual(pelletDamage(Weapon.Pistol, 40), WEAPONS[Weapon.Pistol].damage, "a gun's pellet doesn't fall off");
    });
  });
});
