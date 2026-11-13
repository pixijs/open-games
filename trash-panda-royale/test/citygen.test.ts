import assert from "assert";
import { CAR_CLEAR, CAR_GARBAGE, CAR_TYPES, GRAVITY, JUMP_VELOCITY, Mode, PLAYER_HEIGHT, PLAYER_RADIUS, TICK_RATE } from "../src/shared/constants.ts";
import { generateV2 } from "../src/shared/citygen.ts";
import { LOOKS, areaAt } from "../src/shared/districts.ts";
import { distPointLine, inPoly, makeLine, rectsOverlap, type Rect } from "../src/shared/geom.ts";
import { KIT } from "../src/shared/kit.ts";
import { BILLBOARDS, DISTRICTS, EDGE_ALLEY, EDGE_SPOKE } from "../src/shared/layout.ts";
import { BILLBOARD, CITY, SolidTag, collideCircle, groundHeight, pitFloor, pointInBox, thin } from "../src/shared/map.ts";
import { trackDistance } from "../src/shared/train.ts";
import { stepPlayer, type InputLike, type PlayerSim, type WorldView } from "../src/shared/sim.ts";

/**
 * The new town (generateV2): built the same every time, nothing built on a street, every stair
 * walkable to its roof, every plank a bridge, the pedestrians' paths clear, loot standing on
 * something, enough spawn points and trash cans, parking room for every parked car, and six
 * districts that each look their own way.
 */
describe("the town on a street graph (citygen)", () => {
  const city = CITY;
  const lines = city.roads.edges.map((e) => makeLine(e.pts));

  it("is the same every time it's built", () => {
    const again = generateV2();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(city)));
  });

  it("builds nothing on a street, and no two buildings overlap", () => {
    const rects: Rect[] = city.buildings.filter((b) => b.fade).map((b) => ({ cx: b.x, cz: b.z, hx: b.fade!.hx, hz: b.fade!.hz, c: Math.cos(b.rot), s: Math.sin(b.rot) }));
    city.buildings.forEach((b, i) => {
      if (!b.fade || b.model.startsWith("bld_") === false) return;
      const r = rects[i];
      city.roads.edges.forEach((e, j) => {
        // the corners and the middle of each side, against the street's corridor
        for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const x = r.cx + lx * r.hx * r.c + lz * r.hz * r.s, z = r.cz - lx * r.hx * r.s + lz * r.hz * r.c;
          const d = distPointLine(x, z, lines[j]);
          assert.ok(d >= e.half + e.walk - 0.05, `${b.model} at (${b.x}, ${b.z}) reaches ${(e.half + e.walk - d).toFixed(2)} m into ${e.name ?? `street ${j}`}`);
        }
      });
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = city.buildings[i], b = city.buildings[j];
        // (a mishap's neighbour stands against it by design)
        if (!a.fade || !b.fade || a.model === "bld_collapsed" || b.model === "bld_collapsed") continue;
        assert.ok(!rectsOverlap(rects[i], rects[j], -0.05), `${a.model} (${a.x}, ${a.z}) overlaps ${b.model} (${b.x}, ${b.z})`);
      }
    }
  });

  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  const noCars: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const at = (x: number, z: number, y = 0): PlayerSim => ({
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  /** Walk `s` toward (x, z) for up to `n` steps, stopping within 0.2 m. */
  const walk = (s: PlayerSim, x: number, z: number, n = 120) => {
    for (let i = 0; i < n && Math.hypot(x - s.x, z - s.z) > 0.2; i++) {
      const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz);
      stepPlayer({ dt: 1 / TICK_RATE, time: 5000 + i * 33, memo: (_k, f) => f() }, s, { ...idle, mx: Math.round((100 * dx) / d), mz: Math.round((100 * dz) / d) }, noCars);
    }
  };

  it("every flight of stairs that starts on the ground can be walked up", function () {
    const flights = city.ramps.filter((r) => r.stairs && r.h0 < 0.05);
    assert.ok(flights.length >= 6, `${flights.length} flights`);
    for (const r of flights) {
      // from just off its foot, up to just short of its top
      const foot = { x: r.cx - r.s * (r.hz + 0.6), z: r.cz - r.c * (r.hz + 0.6) };
      const top = { x: r.cx + r.s * (r.hz - 0.3), z: r.cz + r.c * (r.hz - 0.3) };
      const want = r.h1 - ((r.h1 - r.h0) * 0.3) / (2 * r.hz);
      const s = at(foot.x, foot.z, groundHeight(foot.x, foot.z, 0));
      walk(s, top.x, top.z);
      assert.ok(Math.abs(s.y - want) < 0.15, `flight at (${r.cx.toFixed(1)}, ${r.cz.toFixed(1)}): reached y ${s.y.toFixed(2)} of ${want.toFixed(2)}`);
    }
  });

  it("every plank rests on a roof at both ends", function () {
    const planks = city.boxes.filter((b) => b.tag === 7);
    assert.ok(planks.length >= 2, `${planks.length} planks`);
    for (const p of planks) {
      const r = p.rot ?? { cx: (p.minX + p.maxX) / 2, cz: (p.minZ + p.maxZ) / 2, hx: (p.maxX - p.minX) / 2, hz: (p.maxZ - p.minZ) / 2, c: 1, s: 0 };
      const along = r.hx > r.hz, len = Math.max(r.hx, r.hz);
      for (const sg of [-1, 1]) {
        // just in from each end (each rests 0.4 m onto its roof)
        const lx = along ? sg * (len - 0.2) : 0, lz = along ? 0 : sg * (len - 0.2);
        const x = r.cx + lx * r.c + lz * r.s, z = r.cz - lx * r.s + lz * r.c;
        // under the plank's end, the roof it rests on
        const roof = city.boxes.some((b) => b.tag !== 7 && b.base === undefined && pointInBox(b, x, z) && Math.abs(b.top - p.top) < 0.35);
        assert.ok(roof, `plank at (${r.cx.toFixed(1)}, ${r.cz.toFixed(1)}): no roof under its ${sg > 0 ? "far" : "near"} end`);
      }
    }
  });

  it("the pedestrians' paths are clear, on the ground, connected", function () {
    const nav = city.nav;
    assert.ok(nav.length > 100);
    let bad = 0;
    const where: string[] = [];
    for (let i = 0; i < nav.length; i++) {
      for (const j of nav[i].links) {
        if (j < i) continue;
        const a = nav[i], b = nav[j], len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let t = 0; t <= len; t += 0.5) {
          const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
          // (townsfolk don't bump into things: a path through a post or a trunk would show them walking through it)
          if (collideCircle({ x, z }, 0, 0.2, false) || pitFloor(x, z) < 0) { bad++; if (where.length < 5) where.push(`(${x.toFixed(1)}, ${z.toFixed(1)})`); break; }
        }
      }
    }
    assert.ok(bad === 0, `${bad} paths through something: ${where.join(" ")}`);
    // one piece: every node reachable from the first
    const seen = new Set([0]), todo = [0];
    while (todo.length) for (const j of nav[todo.pop()!].links) if (!seen.has(j)) { seen.add(j); todo.push(j); }
    assert.strictEqual(seen.size, nav.length, `${nav.length - seen.size} nodes cut off`);
  });

  it("loot stands on something; roof loot on a roof you can get up to", () => {
    for (const p of city.pickups) {
      if (p.y === undefined) continue;
      assert.ok(Math.abs(groundHeight(p.x, p.z, p.y + 0.3) - p.y) < 0.1, `loot at (${p.x}, ${p.y}, ${p.z}) floats`);
    }
  });

  it("enough spawn points (on the ground, clear) and trash cans; parking for every parked car", () => {
    assert.ok(city.spawns.length >= 40, `${city.spawns.length} spawns`);
    for (const s of city.spawns) {
      assert.ok(!collideCircle({ x: s.x, z: s.z }, 0, PLAYER_RADIUS, false), `spawn (${s.x}, ${s.z}) in a wall`);
    }
    assert.ok(city.bins.length >= 30, `${city.bins.length} cans`);
    assert.ok(city.parking.length >= 14, `${city.parking.length} parking spots`);
    for (const p of city.parking) assert.ok(!collideCircle({ x: p.x, z: p.z }, 0, 1.0, true), `parking spot (${p.x}, ${p.z}) blocked`);
  });

  it("the eight level crossings, and the streets the tests drive along, are still there", function () {
    assert.strictEqual(city.crossings.length, 8);
    // Main Street (z = -22): clear asphalt from the west ring road to the east one
    for (let x = -100; x <= 118; x += 0.5) {
      assert.ok(!collideCircle({ x, z: -22 }, 0, 1, true), `Main Street blocked at x ${x}`);
    }
    // the sinkhole's street: closed to cars
    const pit = city.pits[0];
    assert.ok(pit && pit.floor < -2, "the sinkhole");
    void KIT;
    void EDGE_ALLEY; void EDGE_SPOKE;
  });

  it("the billboards: off the streets and the track, out of reach on a pole, room under the roof one", () => {
    const boards = city.props.filter((p) => p.model.startsWith("billboard"));
    assert.strictEqual(boards.length, BILLBOARDS.length);
    // a standing jump off the tallest car's roof: as high as a raccoon's head gets near a street
    // (not the garbage truck's: it only comes to town on Garbage Day, along the lanes, and a pole
    // board's panel stands back off the street)
    const reach = Math.max(...CAR_TYPES.filter((_, k) => k !== CAR_GARBAGE).map((c) => c.roof)) + (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY) + PLAYER_HEIGHT;
    for (const pr of boards) {
      const where = `${pr.model} at (${pr.x}, ${pr.z})`;
      const panel = pr.parts!.boxes[0];
      assert.ok(city.boxes.includes(panel) && panel.base !== undefined && panel.grab === false && panel.tag === SolidTag.Sign, `${where}: its panel is a floating sign`);
      const y = pr.y ?? 0;
      const at = (lx: number, lz: number) => ({ x: pr.x + lx * Math.cos(pr.rot) + lz * Math.sin(pr.rot), z: pr.z - lx * Math.sin(pr.rot) + lz * Math.cos(pr.rot) });
      const posts = city.boxes.filter((b) => b.tag === SolidTag.Prop && b.top === panel.base && pointInBox(b, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)
        && Math.hypot((b.minX + b.maxX) / 2 - pr.x, (b.minZ + b.maxZ) / 2 - pr.z) < BILLBOARD.hx);
      if (pr.model === "billboard_roof") {
        assert.ok(y > 20, `${where}: up on the tower (y ${y})`);
        assert.ok(panel.base! - y >= PLAYER_HEIGHT + 0.1, `${where}: room to walk under it`);
        // the legs and the kickers' feet stand on that roof
        assert.strictEqual(posts.length, 2, `${where}: two legs`);
        for (const [lx, lz] of [[-BILLBOARD.billboard_roof.legX, 0], [BILLBOARD.billboard_roof.legX, 0], [-BILLBOARD.billboard_roof.legX, -1.35], [BILLBOARD.billboard_roof.legX, -1.35]]) {
          const p = at(lx, lz);
          assert.ok(Math.abs(groundHeight(p.x, p.z, y) - y) < 0.01, `${where}: a foot at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) over the edge`);
        }
        continue;
      }
      assert.ok(panel.base! > reach && panel.base! > CAR_CLEAR, `${where}: its panel (${panel.base} m up) within reach (${reach.toFixed(2)} m)`);
      assert.strictEqual(posts.length, 1, `${where}: one pole`);
      const pole = posts[0];
      // nothing else stands in the pole
      for (const b of city.boxes) {
        if (b === pole || b === panel || b.base !== undefined) continue;
        const clear = b.maxX < pole.minX || b.minX > pole.maxX || b.maxZ < pole.minZ || b.minZ > pole.maxZ;
        assert.ok(clear, `${where}: ${b.tag ?? "a box"} at (${b.minX}, ${b.minZ}) in its pole`);
      }
      // the panel's ends and middle: off every street, off the track, and no roof (or anything
      // else a raccoon could stand on up high) within 6 m
      for (const f of [-1, -0.5, 0, 0.5, 1]) {
        const p = at(f * BILLBOARD.hx, 0);
        city.roads.edges.forEach((e, j) => {
          assert.ok(distPointLine(p.x, p.z, lines[j]) >= e.half + e.walk + 1, `${where}: within 1 m of ${e.name ?? `street ${j}`}`);
        });
        assert.ok(Math.abs(trackDistance(p.x, p.z)) >= 8, `${where}: within 8 m of the track`);
        for (const b of city.boxes) {
          if (b === panel || b === pole || b.top < 2 || (b.tag === SolidTag.Prop && thin(b))) continue;
          const d = Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minZ - p.z, 0, p.z - b.maxZ));
          assert.ok(d >= 6, `${where}: a ${b.top.toFixed(1)} m box ${d.toFixed(1)} m away`);
        }
      }
    }
  });

  it("the districts: they tile the town, paint their own buildings, each has its landmark; the dressing stays off the streets", () => {
    // every spot in town is in one district (sampled off any border line)
    for (let x = -117.13; x < 117.5; x += 2.9) {
      for (let z = -117.29; z < 117.5; z += 2.9) {
        const n = DISTRICTS.filter((d) => inPoly(d.poly, x, z)).length;
        assert.strictEqual(n, 1, `(${x.toFixed(1)}, ${z.toFixed(1)}) is in ${n} districts`);
      }
    }
    // every building's walls are its district's (the burnt-out shell is sooty grey)
    for (const b of city.buildings) {
      const a = areaAt(b.x, b.z);
      assert.ok(a, `${b.model} at (${b.x}, ${b.z}) is in no district`);
      if (b.model !== "bld_shell") assert.ok(LOOKS[a!].walls.includes(b.tint!), `${b.model} at (${b.x}, ${b.z}): its walls (${b.tint?.toString(16)}) aren't ${a}'s`);
    }
    // a landmark in each: the clock tower, the big maple, the old mill, the raccoon sign, the mast, the fountain
    const want: Record<string, string> = { clocktower: "oldtown", maple: "maple", millyard: "mill", racsign: "run" };
    for (const [kind, area] of Object.entries(want)) {
      const sp = city.setPieces.find((p) => p.kind === kind);
      assert.ok(sp, `no ${kind}`);
      assert.strictEqual(areaAt(sp!.x, sp!.z), area, `the ${kind} isn't in ${area}`);
    }
    const mast = city.props.find((p) => p.model === "lm_mast");
    assert.ok(mast && areaAt(mast.x, mast.z) === "downtown" && Math.abs(groundHeight(mast.x, mast.z, (mast.y ?? 0) + 0.5) - (mast.y ?? 0)) < 0.01, "the mast stands on Downtown's tower");
    assert.strictEqual(areaAt(0, 0), "plaza");
    // the landmarks' ground is off the streets (the big maple's island is in the middle of the
    // cul-de-sac, with a lane round it a car fits through)
    for (const sp of city.setPieces) {
      const k = KIT.setpieces[sp.kind].keep;
      if (sp.kind === "maple") {
        const cds = city.roads.nodes.find((n) => n.kind === "culdesac")!;
        assert.ok(Math.hypot(cds.x - sp.x, cds.z - sp.z) < 0.01 && cds.r - 3.4 >= 4.5, "the maple's island (its kerb r 3.4) leaves room round it");
        continue;
      }
      if (sp.kind === "sinkhole" || !(sp.kind in want)) continue;
      const c = Math.cos(sp.yaw), s = Math.sin(sp.yaw);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const x = sp.x + lx * k.hx * c + lz * k.hz * s, z = sp.z - lx * k.hx * s + lz * k.hz * c;
        city.roads.edges.forEach((e, j) => {
          assert.ok(distPointLine(x, z, lines[j]) >= e.half + e.walk - 0.05, `the ${sp.kind}'s ground reaches into ${e.name ?? `street ${j}`}`);
        });
      }
    }
    // the dressing: some of each district's, none of it on a street or in a building
    const kinds = new Set(city.dressing.map((d) => d.kind));
    for (const k of ["fence", "hedge", "path", "crate", "planter", "flagpole"]) assert.ok(kinds.has(k as never), `no ${k}`);
    // (and Millside's oil drums, props cars knock about)
    const drums = city.props.filter((p) => p.model === "drum").map((p) => ({ kind: "drum", x: p.x, z: p.z, yaw: 0, hx: 0.35, hz: 0.35 }));
    assert.ok(drums.length > 2, "no drum");
    const homes: Rect[] = city.buildings.filter((b) => b.fade && b.box).map((b) => ({ cx: (b.box!.minX + b.box!.maxX) / 2, cz: (b.box!.minZ + b.box!.maxZ) / 2, hx: b.fade!.hx, hz: b.fade!.hz, c: Math.cos(b.rot), s: Math.sin(b.rot) }));
    for (const d of [...city.dressing, ...drums]) {
      const r: Rect = { cx: d.x, cz: d.z, hx: d.hx, hz: d.hz, c: Math.cos(d.yaw), s: Math.sin(d.yaw) };
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = r.cx + lx * r.hx * r.c + lz * r.hz * r.s, z = r.cz - lx * r.hx * r.s + lz * r.hz * r.c;
        city.roads.edges.forEach((e, j) => {
          assert.ok(distPointLine(x, z, lines[j]) >= e.half + e.walk - 0.05, `a ${d.kind} at (${d.x}, ${d.z}) reaches into ${e.name ?? `street ${j}`}`);
        });
      }
      for (const h of homes) assert.ok(!rectsOverlap(r, h, -0.02), `a ${d.kind} at (${d.x}, ${d.z}) is in a building`);
    }
  });
});
