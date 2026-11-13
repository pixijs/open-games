import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  BIN_LID_MS, BIN_REACH, BIN_REVEAL_MS, Mode, NpcState, PLAYER_RADIUS, RoundPhase, TICK_RATE, Weapon, WEAPONS,
} from "../src/shared/constants.ts";
import { BIN_R, CITY, nearestBin } from "../src/shared/map.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import {
  EV_FIRE, EV_HIDE, EV_UNHIDE, stepPlayer, type InputLike, type PlayerSim, type SeenCar, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;

/** A street trash can (on the ground, by the westmost road): the one these tests hide in. */
const BI = CITY.bins.findIndex((b) => b.y === 0 && b.x < -100);
const BIN = CITY.bins[BI];

// ----------------------------------------------------------------------------- the map
describe("trash cans: where they stand", () => {
  it("a few dozen, solid, each clear of the loot, the spawn corners, the parking spots and each other", () => {
    assert.ok(CITY.bins.length >= 30, `${CITY.bins.length} cans`);
    CITY.bins.forEach((b, i) => {
      const box = CITY.boxes.find((q) => Math.abs(q.minX - (b.x - BIN_R)) < 1e-9 && Math.abs(q.maxZ - (b.z + BIN_R)) < 1e-9);
      assert.ok(box && box.top === b.top, `can ${i} has its collider`);
      assert.ok(Math.abs(b.top - b.y - 1) < 1e-9, `can ${i} is 1 m tall`);
      for (const p of CITY.pickups) assert.ok(Math.hypot(p.x - b.x, p.z - b.z) >= 2.5, `can ${i} on loot`);
      for (const s of CITY.spawns) assert.ok(Math.hypot(s.x - b.x, s.z - b.z) >= 2.5, `can ${i} on a spawn corner`);
      for (const s of CITY.parking) assert.ok(Math.hypot(s.x - b.x, s.z - b.z) >= 3.2, `can ${i} on a parking spot`);
      CITY.bins.forEach((o, j) => { if (j !== i) assert.ok(Math.hypot(o.x - b.x, o.z - b.z) >= 2.5, `cans ${i} and ${j} touch`); });
      // nothing else solid inside it (it may stand on a platform)
      for (const q of CITY.boxes) {
        if (q === box || q.top <= b.y + 0.05) continue;
        const overlap = q.minX < b.x + BIN_R && q.maxX > b.x - BIN_R && q.minZ < b.z + BIN_R && q.maxZ > b.z - BIN_R;
        assert.ok(!overlap, `can ${i} overlaps a collider`);
      }
    });
  });

  it("the cans to reach: the nearest within reach, on the same floor", () => {
    assert.strictEqual(nearestBin(BIN.x + 1, 0, BIN.z, BIN_REACH), BI);
    assert.strictEqual(nearestBin(BIN.x + 1.5, 0, BIN.z, BIN_REACH), -1, "too far");
    const st = CITY.bins.findIndex((b) => b.y > 1);
    assert.ok(st >= 0, "a can on a station platform");
    assert.strictEqual(nearestBin(CITY.bins[st].x + 1, 0, CITY.bins[st].z, BIN_REACH), -1, "not from below the platform");
    assert.strictEqual(nearestBin(CITY.bins[st].x + 1, 1.6, CITY.bins[st].z, BIN_REACH), st);
  });
});

// ----------------------------------------------------------------------------- the shared step
describe("shared step: hiding in a trash can", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: (x, y, z) => nearestBin(x, y, z, BIN_REACH), poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 1 };
  const ctxAt = (i = 0, frozen = false): SimCtx => ({ dt: 1 / TICK_RATE, time: 5000 + i * 33, memo: (_k, f) => f(), frozen });
  /** On foot right by the can (east of it, on the sidewalk). */
  const byTheCan = (): PlayerSim => ({
    x: BIN.x + 0.95, y: 0, z: BIN.z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
    grounded: true, weapon: Weapon.Pistol, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  /** Run idle steps until they're standing on something (at most 2 s). */
  const settle = (s: PlayerSim, w = world) => {
    for (let i = 0; i < 60 && !(s.grounded && s.mode === Mode.Foot && i > 3); i++) stepPlayer(ctxAt(100 + i), s, idle, w);
  };

  it("E dives in; inside you stay put, peek around, and can't loot or be moved", () => {
    const s = byTheCan();
    const ev = stepPlayer(ctxAt(), s, { ...idle, use: true }, world);
    assert.ok(ev & EV_HIDE, "dove in");
    assert.strictEqual(s.mode, Mode.Hidden);
    assert.strictEqual(s.veh, BI);
    assert.deepStrictEqual([s.x, s.z], [Math.fround(BIN.x), Math.fround(BIN.z)]);
    const loot: WorldView = { ...world, pickup: () => ({ id: "9", kind: Weapon.Smg }) };
    for (let i = 1; i <= 20; i++) {
      const ctx = ctxAt(i);
      stepPlayer(ctx, s, { ...idle, mx: 100, sprint: true, aim: 2, weapon: Weapon.Pistol }, loot);
      assert.strictEqual(ctx.picked, "", "no looting from inside a can");
    }
    assert.strictEqual(s.mode, Mode.Hidden);
    assert.deepStrictEqual([s.x, s.z, s.vx, s.vz], [Math.fround(BIN.x), Math.fround(BIN.z), 0, 0], "the stick does nothing");
    assert.ok(Math.abs(s.yaw - 2) < 1e-5, "looks where it aims");
  });

  it("E or Space hops out over the rim and clear of the can (no stick needed)", () => {
    for (const key of ["use", "jump"] as const) {
      for (const aim of [0, Math.PI / 2, Math.PI, -2.3]) {
        const s = byTheCan();
        stepPlayer(ctxAt(), s, { ...idle, use: true }, world);
        const ev = stepPlayer(ctxAt(1), s, { ...idle, [key]: true, aim }, world);
        assert.ok(ev & EV_UNHIDE, "hopped out");
        assert.strictEqual(s.mode, Mode.Foot);
        assert.strictEqual(s.veh, -1);
        settle(s);
        const d = Math.hypot(s.x - BIN.x, s.z - BIN.z);
        assert.ok(s.grounded && Math.abs(s.y - BIN.y) < 0.05, `${key} aim ${aim}: down on the ground, y=${s.y.toFixed(2)}`);
        // out of the collider (the square round the can) and not on top of it
        const out = Math.max(Math.abs(s.x - BIN.x), Math.abs(s.z - BIN.z)) >= BIN_R + PLAYER_RADIUS - 0.01;
        assert.ok(out, `${key} aim ${aim}: clear of the can (${d.toFixed(2)} m from its middle)`);
      }
    }
  });

  it("the stick picks the way out; a click hops out and shoots the same step (an ambush)", () => {
    const s = byTheCan();
    stepPlayer(ctxAt(), s, { ...idle, use: true }, world);
    stepPlayer(ctxAt(1), s, { ...idle, jump: true, mz: 100, aim: Math.PI }, world);
    assert.ok(s.vz > 3, `hops along the stick (+z), vz=${s.vz}`);

    const a = byTheCan();
    stepPlayer(ctxAt(), a, { ...idle, use: true }, world);
    const ev = stepPlayer(ctxAt(1), a, { ...idle, fire: true, aim: Math.PI / 2, weapon: Weapon.Pistol }, world);
    assert.ok(ev & EV_UNHIDE && ev & EV_FIRE, "out and firing");
    assert.strictEqual(a.ammo1, 9);
    assert.strictEqual(a.cd, WEAPONS[Weapon.Pistol].cooldown);
  });

  it("a car nearer than the can gets the E instead (and the can, when it's nearer)", () => {
    const carAt = (x: number, z: number): SeenCar => ({ id: 3, kind: 0, driven: false, wreck: false, x, z, yaw: 0, vx: 0, vz: 0, halfL: 1.9, halfW: 1.0, roof: 1.45 });
    // a car right up against the player's other side
    const s = byTheCan();
    const w: WorldView = { ...world, cars: () => [carAt(s.x + 1.2, s.z)] };
    stepPlayer(ctxAt(), s, { ...idle, use: true }, w);
    assert.strictEqual(s.mode, Mode.Driving, "the car was nearer");
    // the car a bit further off: the can wins
    const t = byTheCan();
    const w2: WorldView = { ...world, cars: () => [carAt(t.x + 2.2, t.z)] };
    stepPlayer(ctxAt(), t, { ...idle, use: true }, w2);
    assert.strictEqual(t.mode, Mode.Hidden, "the can was nearer");
  });

  it("no diving in (or hopping out) before GO; a can someone's in (as you know it) stays shut", () => {
    const s = byTheCan();
    stepPlayer(ctxAt(0, true), s, { ...idle, use: true }, world);
    assert.strictEqual(s.mode, Mode.Foot, "frozen");
    const full: WorldView = { ...world, bin: () => -1 };
    stepPlayer(ctxAt(), s, { ...idle, use: true }, full);
    assert.strictEqual(s.mode, Mode.Foot, "taken");
    stepPlayer(ctxAt(), s, { ...idle, use: true }, world);
    stepPlayer(ctxAt(1, true), s, { ...idle, use: true, jump: true, fire: true }, world);
    assert.strictEqual(s.mode, Mode.Hidden, "frozen in");
  });

  it("is deterministic in and out of a can", () => {
    const run = () => {
      const s = byTheCan();
      for (let i = 0; i < 90; i++) {
        stepPlayer(ctxAt(i), s, { ...idle, use: i === 2 || i === 40, jump: i === 70, fire: i === 71, mx: i > 40 ? 100 : 0, aim: Math.sin(i / 7) }, world);
      }
      return JSON.stringify(s);
    };
    assert.strictEqual(run(), run());
  });
});

// ----------------------------------------------------------------------------- the server
type Input = { data: any; send(): void };

async function drive(input: Input, n: number, stage: (d: any, i: number) => void = () => {}) {
  for (let i = 0; i < n; i++) {
    const d = input.data;
    d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
    stage(d, i);
    input.send();
    await sleep(STEP_MS);
  }
}

async function waitFor(cond: () => boolean, ms = 5000, what = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function place(p: Player, x: number, z: number, y = 0) {
  p.x = x; p.z = z; p.y = y; p.vx = 0; p.vy = 0; p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
}

describe("trash cans on the server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  /** Nobody else around: cars parked far off, townsfolk gone. */
  function quiet(r: GameRoom) {
    let i = 0;
    for (const car of r.carsById.values()) {
      const body = r.bodies.get(car.id)!;
      body.ai = null; car.driver = ""; car.vx = 0; car.vz = 0; car.y = 0;
      car.x = -150 + (i % 10) * 6; car.z = 150 - Math.floor(i / 10) * 7; car.yaw = 0;
      i++;
    }
    for (const npc of r.state.npcs.values()) { npc.state = NpcState.Hidden; npc.x = 1000; }
  }

  async function join(r: GameRoom, name: string) {
    const client = await colyseus.connectTo(r as any, { name });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    const sid = client.sessionId;
    return { client, input, sid, p: r.state.players.get(sid)!, seen: () => (client as any).state };
  }

  /** Two raccoons by the can: Ann right next to it, Bob out on the road 6 m east of it. */
  async function setup(br: object | false = false) {
    const r = (await colyseus.createRoom("town", { br })) as unknown as GameRoom;
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    quiet(r);
    place(a.p, BIN.x + 0.95, BIN.z);
    place(b.p, BIN.x + 6, BIN.z);
    await Promise.all([drive(a.input, 4), drive(b.input, 4)]);
    return { r, a, b, both: (n: number, sa?: (d: any, i: number) => void, sb?: (d: any, i: number) => void) => Promise.all([drive(a.input, n, sa), drive(b.input, n, sb)]) };
  }

  /** Ann dives in, and stays in long enough for Bob to stop getting her. */
  async function hide(s: Awaited<ReturnType<typeof setup>>) {
    await s.both(2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(s.a.p.mode, Mode.Hidden, "Ann is in the can");
    assert.strictEqual(s.a.p.veh, BI);
    await s.both(Math.ceil((BIN_REVEAL_MS + 300) / STEP_MS));
  }

  it("in a can, the others stop receiving you (StateView); out of it, you're back for them at once", async () => {
    const s = await setup();
    const { a, b } = s;
    assert.ok(b.seen().players.has(a.sid), "Bob sees Ann");
    await s.both(2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(a.p.mode, Mode.Hidden);
    await s.both(6);
    assert.ok(b.seen().players.has(a.sid), "Bob still gets her right after the dive (to see it)");
    await s.both(Math.ceil(BIN_REVEAL_MS / STEP_MS));
    assert.ok(!b.seen().players.has(a.sid), "then Bob doesn't receive Ann at all");
    assert.ok(a.seen().players.get(a.sid)?.mode === Mode.Hidden, "Ann still gets herself");
    assert.strictEqual(b.seen().roster.size, 2, "the roster still lists her");
    let flips = 0;
    b.client.onMessage("unhide", (m: { s: string; c: number }) => { if (m.s === a.sid && m.c === BI) flips++; });
    await s.both(3, (d, i) => { d.jump = i === 0; });
    assert.strictEqual(a.p.mode, Mode.Foot, "hopped out");
    await s.both(3);
    assert.ok(b.seen().players.has(a.sid), "back in Bob's view");
    assert.strictEqual(flips, 1, "Bob saw the lid flip");
  });

  it("a shot at the can pops its hider out unhurt and knocks its lid off; nobody hides there till it's back on", async () => {
    const s = await setup();
    const { r, a, b } = s;
    await hide(s);
    let found: { s: string; b: string } | null = null;
    b.client.onMessage("bin", (m: { c: number; s: string; b: string }) => { if (m.c === BI) found = m; });
    let feed = "";
    b.client.onMessage("feed", (m: { text: string }) => { feed = m.text; });
    b.p.weapon = Weapon.Pistol; b.p.ammo1 = 10;
    // Bob shoots west, at the can
    await s.both(4, undefined, (d, i) => { d.aim = -Math.PI / 2; d.weapon = Weapon.Pistol; d.fire = i === 1; });
    assert.ok(a.p.mode === Mode.Knocked || a.p.mode === Mode.Foot, `popped out (mode ${a.p.mode})`);
    assert.strictEqual(a.p.hp, 100, "the can took the shot");
    assert.strictEqual(r.state.bins.get(String(BI))!.lidOff, true, "lid off");
    await s.both(6);
    assert.deepStrictEqual(found, { c: BI, s: a.sid, b: b.sid, x: -1, z: 0 });
    assert.match(feed, /Bob found Ann in a trash can/);
    assert.ok(b.seen().players.has(a.sid), "Bob sees her again");
    // Ann lands and tries to get back in: the lid's off
    await s.both(30);
    place(a.p, BIN.x + 0.95, BIN.z);
    await s.both(2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(a.p.mode, Mode.Foot, "no hiding in a can with its lid off");
    // later the lid's back on (fast-forwarded), and in she goes
    (r.bins as any).lidBack[BI] = r.now;
    await s.both(2);
    assert.strictEqual(r.state.bins.get(String(BI))!.lidOff, false, "lid back on");
    await s.both(2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(a.p.mode, Mode.Hidden);
    assert.ok(BIN_LID_MS >= 5000);
  });

  it("a can someone's in bounces the next raccoon (and they both hear the knock)", async () => {
    const s = await setup();
    const { a, b } = s;
    await hide(s);
    let taken = 0, knocked = 0;
    b.client.onMessage("taken", (m: { c: number }) => { if (m.c === BI) taken++; });
    a.client.onMessage("knock", (m: { c: number }) => { if (m.c === BI) knocked++; });
    place(b.p, BIN.x - 0.95, BIN.z);
    await s.both(2, undefined, (d, i) => { d.use = i === 0; });
    await s.both(4);
    assert.strictEqual(b.p.mode, Mode.Foot, "Bob stays out");
    assert.strictEqual(a.p.mode, Mode.Hidden, "Ann stays in");
    assert.deepStrictEqual([taken, knocked], [1, 1]);
  });

  it("a slap, a stink bomb or a car into the can pops the hider out; the fumes smoke them out (and hurt)", async () => {
    // a slap
    let s = await setup();
    await hide(s);
    s.b.p.weapon = Weapon.Fists;
    place(s.b.p, BIN.x + 1.1, BIN.z);
    await s.both(3, undefined, (d, i) => { d.aim = -Math.PI / 2; d.weapon = Weapon.Fists; d.fire = i === 0; });
    assert.notStrictEqual(s.a.p.mode, Mode.Hidden, "slapped out");
    assert.strictEqual(s.a.p.hp, 100);

    // a stink bomb going off next to the can
    s = await setup();
    await hide(s);
    s.r.combat.explode(BIN.x + 2, 0.3, BIN.z, WEAPONS[Weapon.Grenade].range, WEAPONS[Weapon.Grenade].damage, s.b.sid);
    assert.notStrictEqual(s.a.p.mode, Mode.Hidden, "blown out");
    assert.strictEqual(s.a.p.hp, 100, "the can took the blast");
    assert.ok(s.a.p.vy > 5, "flung up out of it");

    // a car rolling into it
    s = await setup();
    await hide(s);
    s.r.bins.ram(BIN.x + 1.5, BIN.z, 0, 1.0, 1.9, "");
    assert.notStrictEqual(s.a.p.mode, Mode.Hidden, "rammed out");

    // the fumes: they hop out (no can keeps the gas out) and it hurts
    const r = (await colyseus.createRoom("town", { br: { countdownMs: 300, victoryMs: 400, pace: 1 } })) as unknown as GameRoom;
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    await Promise.all([drive(a.input, 30), drive(b.input, 30), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    quiet(r);
    place(a.p, BIN.x + 0.95, BIN.z);
    place(b.p, 0, -22);
    await Promise.all([drive(a.input, 3, (d, i) => { d.use = i === 1; }), drive(b.input, 3)]);
    assert.strictEqual(a.p.mode, Mode.Hidden);
    let smoked = "";
    b.client.onMessage("feed", (m: { text: string }) => { if (/smoked out/.test(m.text)) smoked = m.text; });
    // a tiny circle, far from the can
    const z = r.state.round.zone;
    z.x0 = 0; z.z0 = -22; z.r0 = 10; z.x1 = 0; z.z1 = -22; z.r1 = 10; z.shrinkAt = z.doneAt = 1e12;
    await Promise.all([drive(a.input, 40), drive(b.input, 40)]);
    assert.notStrictEqual(a.p.mode, Mode.Hidden, "smoked out");
    assert.ok(a.p.hp < 100, `and hurt: hp ${a.p.hp}`);
    assert.match(smoked, /Ann got smoked out of a trash can/);
  });

  it("the last raccoon standing hops out of their can to celebrate; a new round puts every lid back", async () => {
    const r = (await colyseus.createRoom("town", { br: { countdownMs: 300, victoryMs: 500, pace: 1 } })) as unknown as GameRoom;
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    await Promise.all([drive(a.input, 30), drive(b.input, 30), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    quiet(r);
    place(a.p, BIN.x + 0.95, BIN.z);
    await Promise.all([drive(a.input, 3, (d, i) => { d.use = i === 1; }), drive(b.input, 3)]);
    assert.strictEqual(a.p.mode, Mode.Hidden);
    // some other can loses its lid
    const other = (BI + 5) % CITY.bins.length;
    r.bins.hit(other, "", 1, 0);
    assert.strictEqual(r.state.bins.get(String(other))!.lidOff, true);
    // Bob's out: Ann wins, and comes out of her can for it
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await Promise.all([drive(a.input, 6), drive(b.input, 6), waitFor(() => r.state.round.phase === RoundPhase.Victory, 2000, "victory")]);
    assert.strictEqual(r.state.round.winner, a.sid);
    assert.notStrictEqual(a.p.mode, Mode.Hidden, "out of the can for the victory lap");
    await Promise.all([drive(a.input, 30), drive(b.input, 30), waitFor(() => r.state.round.number === 2, 3000, "round 2")]);
    for (const st of r.state.bins.values()) assert.strictEqual(st.lidOff, false, "every lid back on");
  });
});
