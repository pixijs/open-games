import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import { mulberry32 } from "../src/shared/map.ts";
import {
  ACC_COLORS, BACKS, BELLIES, FACES, FURS, HEADS, isOutfit, NECKS, packOutfit, randomOutfit, sanitizeOutfit, tintable, unpackOutfit,
  wornNodes, type Outfit,
} from "../src/shared/outfit.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const TABLES: [keyof Outfit, number][] = [
  ["fur", FURS.length], ["belly", BELLIES.length], ["head", HEADS.length], ["face", FACES.length],
  ["neck", NECKS.length], ["back", BACKS.length], ["acc", ACC_COLORS.length],
];
const zero: Outfit = { fur: 0, belly: 0, head: 0, face: 0, neck: 0, back: 0, acc: 0 };
const inRange = (o: Outfit) => TABLES.every(([k, n]) => Number.isInteger(o[k]) && o[k] >= 0 && o[k] < n);

describe("outfits (the start screen's raccoon)", function () {
  this.timeout(30000);

  it("pack and unpack every option of every field", () => {
    for (const [k, n] of TABLES) {
      for (let i = 0; i < n; i++) {
        const o = { ...zero, [k]: i };
        const look = packOutfit(o);
        assert.ok(isOutfit(look), `${k}=${i} is flagged as an outfit`);
        assert.ok(look >= 0 && look <= 0xffffffff, "fits a uint32");
        assert.deepStrictEqual(unpackOutfit(look), o);
      }
    }
    const all: Outfit = { fur: FURS.length - 1, belly: BELLIES.length - 1, head: HEADS.length - 1, face: FACES.length - 1, neck: NECKS.length - 1, back: BACKS.length - 1, acc: ACC_COLORS.length - 1 };
    assert.deepStrictEqual(unpackOutfit(packOutfit(all)), all);
  });

  it("a seed is not an outfit (the gallery's and the warm-up's random looks)", () => {
    for (const seed of [0, 1, 7, 12345, 0x7fffffff]) assert.ok(!isOutfit(seed));
  });

  it("sanitize keeps a good outfit, fixes fields out of range, and rolls one for garbage", () => {
    const rand = mulberry32(42);
    const good = packOutfit({ fur: 12, belly: 3, head: 6, face: 1, neck: 2, back: 1, acc: 5 });
    assert.strictEqual(sanitizeOutfit(good, rand), good);
    // every field bit set: the unused values read as 0
    const fixed = sanitizeOutfit(0xffffffff, rand);
    assert.ok(isOutfit(fixed) && inRange(unpackOutfit(fixed)));
    assert.strictEqual(unpackOutfit(fixed).head, 0, "head 7 doesn't exist");
    assert.strictEqual(fixed & 0x7ffc0000, 0, "no bits above the fields");
    for (const bad of [NaN, Infinity, -1, 1.5, 2 ** 32, 12345, "0x80000000", null, undefined, {}, [1]]) {
      const v = sanitizeOutfit(bad, rand);
      assert.ok(isOutfit(v) && inRange(unpackOutfit(v)), `${String(bad)} → a valid outfit`);
    }
  });

  it("random outfits are valid, varied, and mostly natural fur", () => {
    const rand = mulberry32(7);
    const seen = new Set<number>();
    let dyed = 0;
    for (let i = 0; i < 2000; i++) {
      const v = randomOutfit(rand);
      const o = unpackOutfit(v);
      assert.ok(isOutfit(v) && inRange(o));
      if (FURS[o.fur].rare) dyed++;
      seen.add(v);
    }
    assert.ok(seen.size > 1500, `varied (${seen.size} distinct)`);
    assert.ok(dyed > 100 && dyed < 330, `about 1 in 10 dyed (${dyed} / 2000)`);
  });

  it("worn nodes and the colour row", () => {
    assert.deepStrictEqual(wornNodes(zero), []);
    const o: Outfit = { ...zero, head: HEADS.findIndex((w) => w.id === "cone"), face: 1, neck: NECKS.findIndex((w) => w.id === "bowtie"), back: 1 };
    assert.deepStrictEqual(wornNodes(o), ["acc_cone", "acc_shades", "acc_bowtie", "acc_sack"]);
    assert.ok(!tintable(zero));
    assert.ok(!tintable({ ...zero, head: HEADS.findIndex((w) => w.id === "pirate") }), "the pirate hat keeps its own colours");
    assert.ok(tintable({ ...zero, face: 1 }));
    assert.ok(tintable({ ...zero, head: HEADS.findIndex((w) => w.id === "cone") }), "the cone's stripes");
  });

  describe("joining", () => {
    let colyseus: ColyseusTestServer;
    before(async () => { colyseus = await testServer(); });
    beforeEach(async () => await colyseus.cleanup());

    async function join(options: Record<string, unknown>) {
      const room = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
      const client = await colyseus.connectTo(room as any, options);
      await client.waitForInitialState?.();
      return { room, sid: client.sessionId };
    }

    it("wears the outfit picked on the start screen", async () => {
      const look = packOutfit({ fur: 9, belly: 2, head: 5, face: 1, neck: 1, back: 0, acc: 3 });
      const { room, sid } = await join({ name: "Dapper", look });
      assert.strictEqual(room.state.players.get(sid)!.look, look);
      assert.strictEqual(room.state.roster.get(sid)!.look, look, "the roster has it too");
    });

    it("cleans up a bad outfit, and dresses someone who sent none", async () => {
      const a = await join({ name: "Hacker", look: 0xffffffff });
      const la = a.room.state.players.get(a.sid)!.look;
      assert.ok(isOutfit(la) && inRange(unpackOutfit(la)));
      await colyseus.cleanup();
      const b = await join({ name: "Bot" });
      const lb = b.room.state.players.get(b.sid)!.look;
      assert.ok(isOutfit(lb) && inRange(unpackOutfit(lb)));
      assert.strictEqual(b.room.state.roster.get(b.sid)!.look, lb);
    });
  });
});
