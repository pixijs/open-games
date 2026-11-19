import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  FOOD_HP, Mode, PICKUP_FOOD, PlayerStatus, RoundPhase, SEWER_Y, TICK_RATE, Weapon, WEAPONS,
} from "../src/shared/constants.ts";
import { CITY, forBoxesIn, mulberry32 } from "../src/shared/map.ts";
import { Grenade, PlayerInput, type Player } from "../src/shared/schema.ts";
import { MANHOLES } from "../src/shared/sewer.ts";
import { stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";
import {
  newZoneState, nextCircle, ZONE_BOUND, ZONE_R0, ZONE_STAGES, zoneAt, zoneDamage, zoneDepth, type ZoneLike,
} from "../src/shared/zone.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;

async function waitFor(cond: () => boolean, ms = 5000, what = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

type Input = { data: any; send(): void };

/** Keep sending one input per step for `n` steps (like a real client). */
async function drive(input: Input, n: number, stage: (d: any, i: number) => void = () => {}) {
  for (let i = 0; i < n; i++) {
    const d = input.data;
    d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
    stage(d, i);
    input.send();
    await sleep(STEP_MS);
  }
}

function place(p: Player, x: number, z: number) {
  p.x = x; p.z = z; p.y = 0; p.vx = 0; p.vy = 0; p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
}

// ----------------------------------------------------------------------------- shared
describe("the fumes (zone)", () => {
  it("each next circle is inside the last, inside the map bound, small ones not in a building", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = mulberry32(seed);
      let x = 0, z = 0, r = ZONE_R0;
      for (const st of ZONE_STAGES) {
        const c = nextCircle(rand, x, z, r, st.r, { x: 0, z: 0 });
        assert.ok(Math.hypot(c.x - x, c.z - z) + st.r <= r + 1e-9, `seed ${seed}: circle r=${st.r} leaves its parent`);
        assert.ok(Math.abs(c.x) <= Math.max(0, ZONE_BOUND - st.r) + 1e-9 || (c.x === x && c.z === z), `seed ${seed}: out of bounds`);
        if (st.r < 25 && !(c.x === x && c.z === z)) {
          let inBuilding = false;
          forBoxesIn(c.x, c.z, c.x, c.z, (b) => { if (b.top > 0.45 && c.x >= b.minX && c.x <= b.maxX && c.z >= b.minZ && c.z <= b.maxZ) inBuilding = true; });
          assert.ok(!inBuilding, `seed ${seed}: small circle centred in a building`);
        }
        x = c.x; z = c.z; r = st.r;
      }
    }
  });

  it("closes smoothly from one circle to the next, and freezes once the round is decided", () => {
    const z: ZoneLike = { x0: 0, z0: 0, r0: 100, x1: 20, z1: -10, r1: 40, shrinkAt: 1000, doneAt: 3000, stage: 1 };
    const s = newZoneState();
    zoneAt(z, 500, 0, s);
    assert.deepStrictEqual([s.x, s.z, s.r, s.closing], [0, 0, 100, false]);
    assert.ok(Math.abs(s.left - 0.5) < 1e-9);
    zoneAt(z, 2000, 0, s);
    assert.deepStrictEqual([s.x, s.z, s.r, s.closing], [10, -5, 70, true]);
    zoneAt(z, 5000, 0, s);
    assert.deepStrictEqual([s.x, s.z, s.r, s.closing], [20, -10, 40, false]);
    zoneAt(z, 5000, 1500, s); // stopped at 1.5 s
    assert.deepStrictEqual([s.x, s.r], [5, 85]);
    let prev = -1;
    for (let t = 1000; t <= 3000; t += 10) {
      zoneAt(z, t, 0, s);
      if (prev >= 0) assert.ok(prev - s.r >= 0 && prev - s.r < 0.4, "radius shrinks steadily");
      prev = s.r;
    }
    // deeper in the fumes hurts more, up to 3×
    zoneAt(z, 0, 0, s);
    assert.strictEqual(zoneDamage(s, -1), 0);
    assert.ok(zoneDamage(s, 80) > zoneDamage(s, 1) && zoneDamage(s, 1000) === s.dps * 3);
    assert.ok(zoneDepth(s, 0, 150) > 0 && zoneDepth(s, 0, 50) < 0);
  });
});

describe("shared step: countdown freeze and snacks", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 1 };
  const fresh = (): PlayerSim => ({
    x: 0, y: 0, z: -22, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
    grounded: true, weapon: 1, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });

  it("frozen before GO: no moving, jumping, shooting or grabbing — but you can look around", () => {
    const s = fresh();
    const crate: WorldView = { ...world, pickup: () => ({ id: "3", kind: Weapon.Smg }) };
    for (let i = 0; i < 20; i++) {
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: 1000 + i * 33, memo: (_k, f) => f(), frozen: true };
      const ev = stepPlayer(ctx, s, { ...idle, mx: 100, jump: true, fire: true, aim: 1.2 }, crate);
      assert.strictEqual(ev, 0, "nothing happens");
      assert.strictEqual(ctx.picked, "");
    }
    assert.strictEqual(s.x, 0);
    assert.strictEqual(s.ammo1, 10);
    assert.strictEqual(s.ammo2, 0);
    assert.ok(Math.abs(s.yaw - 1.2) < 1e-6, "turned to aim");
  });

  it("a snack is picked up without touching weapons or ammo (the server heals)", () => {
    const s = fresh();
    const ctx = { dt: 1 / TICK_RATE, time: 0, memo: (_k: string, f: () => any) => f() };
    stepPlayer(ctx as any, s, idle, { ...world, pickup: () => ({ id: "40", kind: PICKUP_FOOD }) });
    assert.strictEqual((ctx as any).picked, "40");
    assert.deepStrictEqual([s.weapon, s.ammo1, s.ammo2, s.ammo3, s.ammo4], [1, 10, 0, 0, 0]);
  });

  it("nobody spawns within reach of a loot can (in-flight inputs would loot it unpredicted)", () => {
    assert.ok(CITY.spawns.length >= 40, `${CITY.spawns.length} spawn points`);
    for (const sp of CITY.spawns) {
      for (const p of CITY.pickups) assert.ok(Math.hypot(p.x - sp.x, p.z - sp.z) >= 4, `spawn (${sp.x}, ${sp.z}) next to a can at (${p.x}, ${p.z})`);
    }
  });
});

// ----------------------------------------------------------------------------- server
describe("battle royale rounds", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  const FAST = { countdownMs: 400, victoryMs: 400, pace: 40 };

  async function room(br: object | false = FAST) {
    return (await colyseus.createRoom("town", { br })) as unknown as GameRoom;
  }

  async function join(r: GameRoom, name: string) {
    const client = await colyseus.connectTo(r as any, { name });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    const sid = client.sessionId;
    return { client, input, sid, p: r.state.players.get(sid)!, info: () => r.state.roster.get(sid)! };
  }

  /** Keep a bunch of clients sending idle inputs while `ms` pass. */
  const idleAll = (inputs: Input[], ms: number) => Promise.all(inputs.map((i) => drive(i, Math.ceil(ms / STEP_MS))));

  it("two players start a countdown: respawned apart, full health, frozen until GO", async () => {
    const r = await room({ ...FAST, countdownMs: 1500 });
    const a = await join(r, "Ann");
    assert.strictEqual(r.state.round.phase, RoundPhase.Warmup, "alone: warm-up");
    const lifeA = a.p.life;
    const b = await join(r, "Bob");
    await waitFor(() => r.state.round.phase === RoundPhase.Countdown, 2000, "countdown");
    assert.ok(a.p.life > lifeA, "A was teleported (life bumped)");
    assert.strictEqual(a.p.hp, 100);
    assert.strictEqual(a.info().status, PlayerStatus.Playing);
    assert.strictEqual(b.info().status, PlayerStatus.Playing);
    assert.ok(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) >= 20, "spawned apart");
    // frozen: pushing the stick does nothing before GO
    const x0 = a.p.x, z0 = a.p.z;
    await Promise.all([drive(a.input, 12, (d) => { d.mx = 100; }), drive(b.input, 12)]);
    assert.strictEqual(r.state.round.phase, RoundPhase.Countdown);
    assert.ok(Math.hypot(a.p.x - x0, a.p.z - z0) < 0.01, "didn't move during the countdown");
    await waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "GO");
    await Promise.all([drive(a.input, 15, (d) => { d.mx = 100; }), drive(b.input, 15)]);
    assert.ok(Math.hypot(a.p.x - x0, a.p.z - z0) > 1, "moves after GO");
  });

  it("a knockout is final; the last raccoon standing wins; then the next round starts", async () => {
    const r = await room();
    const a = await join(r, "Ann"), b = await join(r, "Bob"), c = await join(r, "Cat");
    const inputs = [a.input, b.input, c.input];
    await Promise.all([idleAll(inputs, 800), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    assert.strictEqual(r.state.round.entrants, 3);
    // Ann bonks Bob
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await idleAll(inputs, 200);
    assert.strictEqual(b.info().status, PlayerStatus.Out);
    assert.strictEqual(b.info().killedBy, a.sid);
    assert.strictEqual(b.info().place, 3);
    assert.strictEqual(b.p.mode, Mode.Dead);
    assert.strictEqual(r.state.round.alive, 2);
    assert.strictEqual(a.info().roundKills, 1);
    await idleAll(inputs, 400);
    assert.strictEqual(b.p.mode, Mode.Dead, "no respawn during a round");
    // Cat bonks Ann
    r.combat.damagePlayer(a.p, a.sid, 500, c.sid, WEAPONS[Weapon.Smg].name);
    await Promise.all([idleAll(inputs, 300), waitFor(() => r.state.round.phase === RoundPhase.Victory, 2000, "victory")]);
    assert.strictEqual(r.state.round.winner, c.sid);
    assert.strictEqual(r.state.round.winnerName, "Cat");
    assert.strictEqual(c.info().wins, 1);
    assert.strictEqual(c.info().place, 1);
    assert.strictEqual(a.info().place, 2);
    // next round: everyone back in
    const lifeB = b.p.life;
    await Promise.all([idleAll(inputs, 900), waitFor(() => r.state.round.phase === RoundPhase.Countdown && r.state.round.number === 2, 3000, "round 2")]);
    for (const x of [a, b, c]) assert.strictEqual(x.info().status, PlayerStatus.Playing);
    assert.ok(b.p.life > lifeB && (b.p.mode as number) === Mode.Foot && b.p.hp === 100, "Bob respawned for round 2");
  });

  it("two knocked out by the same blast share first place: a draw", async () => {
    const r = await room();
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    await Promise.all([idleAll([a.input, b.input], 800), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    place(a.p, 0, -22); place(b.p, 2, -22);
    a.p.hp = 1; b.p.hp = 1;
    r.combat.explode(1, 0.5, -22, 6.5, 95, "");
    await Promise.all([idleAll([a.input, b.input], 200), waitFor(() => r.state.round.phase === RoundPhase.Victory, 2000, "victory")]);
    assert.strictEqual(r.state.round.winner, "");
    assert.strictEqual(a.info().place, 1);
    assert.strictEqual(b.info().place, 1);
    assert.strictEqual(a.info().wins + b.info().wins, 0);
  });

  it("joining mid-round: waiting (and out of sight) until the next round", async () => {
    const r = await room({ ...FAST, victoryMs: 300 });
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    await Promise.all([idleAll([a.input, b.input], 800), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    const c = await join(r, "Cat");
    assert.strictEqual(c.info().status, PlayerStatus.Waiting);
    assert.strictEqual(c.p.mode, Mode.Dead);
    assert.ok(c.p.x < -150 && c.p.z < -150, "parked off the map");
    assert.strictEqual(r.state.round.alive, 2, "not counted as alive");
    // B leaves for good: A wins, then C joins the next round
    await b.client.leave();
    let winner = "?";
    await Promise.all([idleAll([a.input, c.input], 300), waitFor(() => {
      if (r.state.round.phase === RoundPhase.Victory) winner = r.state.round.winner;
      return winner !== "?";
    }, 2000, "victory")]);
    assert.strictEqual(winner, a.sid);
    await Promise.all([idleAll([a.input, c.input], 900), waitFor(() => r.state.round.phase === RoundPhase.Countdown && r.state.round.number === 2, 3000, "round 2")]);
    assert.strictEqual(c.info().status, PlayerStatus.Playing);
    assert.strictEqual(c.p.mode, Mode.Foot);
  });

  it("the fumes hurt (deeper, more), and a fume death goes to whoever hit you last", async () => {
    const r = await room({ ...FAST, pace: 1 });
    const a = await join(r, "Ann"), b = await join(r, "Bob"), c = await join(r, "Cat");
    const inputs = [a.input, b.input, c.input];
    await Promise.all([idleAll(inputs, 800), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    // well outside the first circle (r 185 around the middle)
    place(b.p, 160, 160);
    await idleAll(inputs, 1200);
    assert.ok(b.p.hp < 100, `the fumes hurt: hp ${b.p.hp}`);
    // Ann tags Bob, then the fumes finish him: Ann gets the kill (and a little heal)
    a.p.hp = 50;
    r.combat.damagePlayer(b.p, b.sid, 1, a.sid, WEAPONS[Weapon.Pistol].name);
    b.p.hp = 1;
    await Promise.all([idleAll(inputs, 1500), waitFor(() => b.info().status === PlayerStatus.Out, 3000, "fumigated")]);
    assert.strictEqual(b.info().killedBy, a.sid);
    assert.strictEqual(a.info().kills, 1);
    assert.ok(a.p.hp >= 70, `a kill heals: hp ${a.p.hp}`);
  });

  it("the sewer: the fumes smoke you out of it; down to the last two, it floods, washing you out for good", async () => {
    const r = await room({ ...FAST, pace: 1 });
    const a = await join(r, "Ann"), b = await join(r, "Bob"), c = await join(r, "Cat");
    const inputs = [a.input, b.input, c.input];
    await Promise.all([idleAll(inputs, 800), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    /** Down manhole `i`, as if they'd dived in. */
    const dive = (x: typeof a, i: number) => {
      const h = MANHOLES[i];
      x.p.mode = Mode.Sewer; x.p.veh = h.edge; x.p.lx = h.s; x.p.lz = i; x.p.vx = 0; x.p.vy = 0; x.p.vz = 0;
      x.p.x = h.x; x.p.z = h.z; x.p.y = SEWER_Y; x.p.timer = 0;
      r.sewers.onDive(x.sid, i);
    };
    // the circle, small and well away from Bob's manhole
    const z = r.state.round.zone, m0 = MANHOLES[0];
    z.x0 = m0.x > 0 ? m0.x - 120 : m0.x + 120; z.z0 = m0.z; z.r0 = 5;
    z.shrinkAt = z.doneAt = r.now + 1e7;
    dive(b, 0);
    await Promise.all([idleAll(inputs, 1500), waitFor(() => b.p.mode !== Mode.Sewer, 3000, "smoked out")]);
    assert.ok(b.p.hp < 100, `and hurt: hp ${b.p.hp}`);
    // the circle back over the whole town: Ann goes down, then Cat's knocked out
    z.x0 = 0; z.z0 = 0; z.r0 = ZONE_R0;
    dive(a, 1);
    await idleAll(inputs, 200);
    assert.strictEqual(a.p.mode, Mode.Sewer, "three left: down there");
    r.combat.damagePlayer(c.p, c.sid, 500, b.sid, WEAPONS[Weapon.Pistol].name);
    await idleAll(inputs, 300);
    assert.strictEqual(r.state.round.alive, 2);
    assert.notStrictEqual(a.p.mode, Mode.Sewer, "washed out");
    const m = MANHOLES[1];
    place(a.p, m.x + 0.3, m.z);
    await Promise.all([drive(a.input, 10, (d) => { d.use = true; }), drive(b.input, 10)]);
    assert.notStrictEqual(a.p.mode, Mode.Sewer, "the flooded sewer takes nobody");
  });

  it("crates in the fumes go away; snacks heal when hurt and are left alone at full health", async () => {
    const r = await room(false);
    const a = await join(r, "Ann");
    const [key, food] = [...r.state.pickups.entries()].find(([, q]) => q.kind === PICKUP_FOOD)!;
    // full health: walk over it, it stays
    place(a.p, food.x, food.z); a.p.y = food.y;
    await drive(a.input, 8);
    assert.strictEqual(r.state.pickups.get(key)!.active, true, "not eaten at full health");
    a.p.hp = 50;
    await drive(a.input, 8);
    assert.strictEqual(r.state.pickups.get(key)!.active, false, "eaten");
    assert.strictEqual(a.p.hp, 50 + FOOD_HP);

    // a live round whose circle is tiny: every crate outside it disappears
    const r2 = await room({ ...FAST, pace: 1 });
    const b = await join(r2, "Bob"), c = await join(r2, "Cat");
    await Promise.all([idleAll([b.input, c.input], 800), waitFor(() => r2.state.round.phase === RoundPhase.Live, 3000, "live")]);
    const z = r2.state.round.zone;
    z.x0 = 0; z.z0 = 0; z.r0 = 10; z.x1 = 0; z.z1 = 0; z.r1 = 10; z.shrinkAt = z.doneAt = 1e12;
    await idleAll([b.input, c.input], 200);
    for (const pk of r2.state.pickups.values()) {
      if (Math.hypot(pk.x, pk.z) > 10.5) assert.strictEqual(pk.active, false, `crate at ${pk.x.toFixed(0)},${pk.z.toFixed(0)} is gone`);
    }
  });

  it("a new round puts the town back (wrecks repaired at home, grenades gone)", async () => {
    const r = await room();
    const a = await join(r, "Ann");
    await drive(a.input, 3);
    const parked = [...r.carsById.values()].find((c) => c.id > 16)!;
    parked.state = 2; parked.x += 30; parked.hp = 0;
    r.state.grenades.set("x", new Grenade({ x: 0, y: 1, z: 0, bornMs: r.now }));
    r.br.startCountdown();
    assert.strictEqual(parked.state, 0);
    assert.strictEqual(parked.hp, 100);
    assert.strictEqual(r.state.grenades.size, 0);
  });

  it("someone leaving during the countdown sends the room back to warm-up", async () => {
    const r = await room({ ...FAST, countdownMs: 3000 });
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    await Promise.all([idleAll([a.input, b.input], 200), waitFor(() => r.state.round.phase === RoundPhase.Countdown, 2000, "countdown")]);
    await b.client.leave();
    await Promise.all([drive(a.input, 6), waitFor(() => r.state.round.phase === RoundPhase.Warmup, 2000, "warm-up")]);
    assert.strictEqual(r.state.round.goAt, 0);
    assert.strictEqual(a.info().status, PlayerStatus.Playing);
  });

  it("interest management (StateView): players far apart don't receive each other (or each other's surroundings); close, they do", async () => {
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const ca = await colyseus.connectTo(r as any, { name: "Ann" });
    const cb = await colyseus.connectTo(r as any, { name: "Bob" });
    const ia = ca.input({ type: PlayerInput }) as unknown as Input, ib = cb.input({ type: PlayerInput }) as unknown as Input;
    const a = r.state.players.get(ca.sessionId)!, b = r.state.players.get(cb.sessionId)!;
    place(a, -110, -110);
    place(b, 110, 110);
    await Promise.all([drive(ia, 12), drive(ib, 12)]);
    const sa = (ca as any).state, sb = (cb as any).state;
    assert.ok(sa.players.has(ca.sessionId), "you always see yourself");
    assert.ok(!sa.players.has(cb.sessionId), "Ann doesn't receive Bob");
    assert.ok(!sb.players.has(ca.sessionId), "Bob doesn't receive Ann");
    assert.strictEqual(sa.roster.size, 2, "but the roster lists everyone");
    const nearA = (s: any) => [...s.cars.values()].every((c: any) => Math.hypot(c.x + 110, c.z + 110) <= 80.5);
    assert.ok(sa.cars.size < r.state.cars.size && nearA(sa), "only cars around Ann");
    assert.ok(sa.npcs.size < r.state.npcs.size, "only townsfolk around Ann");
    // a shot near Bob isn't sent to Ann
    let annHeard = 0;
    ca.onMessage("shot", () => { annHeard++; });
    b.weapon = Weapon.Pistol; b.ammo1 = 10;
    await Promise.all([drive(ia, 6), drive(ib, 6, (d, i) => { d.weapon = Weapon.Pistol; d.fire = i === 1; })]);
    assert.strictEqual(annHeard, 0, "far shot not sent");
    // walk Bob over to Ann
    place(b, -100, -100);
    await Promise.all([drive(ia, 12), drive(ib, 12)]);
    assert.ok(sa.players.has(cb.sessionId), "Ann now receives Bob");
    await Promise.all([drive(ia, 6), drive(ib, 6, (d, i) => { d.weapon = Weapon.Pistol; d.fire = i === 1; })]);
    assert.ok(annHeard > 0, "near shot sent");
  });

  it("each client is told whose surroundings it's sent (`aoi`, a field nobody else receives); out of the round, it moves to whom they watch", async () => {
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const ca = await colyseus.connectTo(r as any, { name: "Ann" });
    const cb = await colyseus.connectTo(r as any, { name: "Bob" });
    const ia = ca.input({ type: PlayerInput }) as unknown as Input, ib = cb.input({ type: PlayerInput }) as unknown as Input;
    place(r.state.players.get(ca.sessionId)!, -110, -110);
    place(r.state.players.get(cb.sessionId)!, -100, -100);
    await Promise.all([drive(ia, 12), drive(ib, 12)]);
    const sa = (ca as any).state, sb = (cb as any).state;
    assert.strictEqual(sa.players.get(ca.sessionId)?.aoi, ca.sessionId, "Ann's view is around Ann");
    assert.strictEqual(sb.players.get(cb.sessionId)?.aoi, cb.sessionId, "Bob's view is around Bob");
    assert.ok(sa.players.has(cb.sessionId) && sb.players.has(ca.sessionId), "they receive each other");
    assert.strictEqual(r.state.players.get(cb.sessionId)!.aoi, cb.sessionId);
    assert.strictEqual(sa.players.get(cb.sessionId).aoi ?? "", "", "but Ann isn't sent Bob's aoi (never sent: undefined)");
    assert.strictEqual(sb.players.get(ca.sessionId).aoi ?? "", "", "nor Bob Ann's");
    // Bob is out (his body far away): his view follows Ann, and the server tells him so
    r.state.roster.get(cb.sessionId)!.status = PlayerStatus.Out;
    place(r.state.players.get(cb.sessionId)!, 110, 110);
    await Promise.all([drive(ia, 12), drive(ib, 12)]);
    assert.strictEqual(sb.players.get(cb.sessionId)?.aoi, ca.sessionId, "Bob's view is around Ann now");
    assert.ok(sb.players.has(ca.sessionId), "so he still receives her");
    assert.strictEqual(sa.players.get(cb.sessionId)?.aoi ?? "", "", "and Ann still isn't sent his aoi");
  });

  it("taunts reach the raccoons around (not the taunter, not far away), at most one per 1.5 s", async () => {
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const ca = await colyseus.connectTo(r as any, { name: "Ann" });
    const cb = await colyseus.connectTo(r as any, { name: "Bob" });
    const cc = await colyseus.connectTo(r as any, { name: "Cid" });
    const inputs = [ca, cb, cc].map((c) => c.input({ type: PlayerInput }) as unknown as Input);
    place(r.state.players.get(ca.sessionId)!, -100, -100);
    place(r.state.players.get(cb.sessionId)!, -95, -100);
    place(r.state.players.get(cc.sessionId)!, 100, 100);
    const heard = { a: 0, b: 0, c: 0 };
    ca.onMessage("taunt", () => { heard.a++; });
    cb.onMessage("taunt", (m: { s: string }) => { if (m.s === ca.sessionId) heard.b++; });
    cc.onMessage("taunt", () => { heard.c++; });
    await Promise.all(inputs.map((i) => drive(i, 6)));
    ca.send("taunt");
    ca.send("taunt"); // spam: dropped
    await Promise.all(inputs.map((i) => drive(i, 6)));
    assert.deepStrictEqual(heard, { a: 0, b: 1, c: 0 });
    await Promise.all(inputs.map((i) => drive(i, Math.ceil(1500 / STEP_MS))));
    ca.send("taunt");
    await Promise.all(inputs.map((i) => drive(i, 6)));
    assert.strictEqual(heard.b, 2, "allowed again after the cooldown");
  });
});
