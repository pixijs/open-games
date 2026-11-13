import { Room, type Client, type CloseCode, type StepContext } from "colyseus";
import {
  CAR_GARBAGE, CAR_MAX_HP, CAR_TYPES, FOOD_HP, FOOD_RESPAWN_MS, GRENADE_FUSE_MS, LOOSE_KNOCK_SPEED, MAX_PLAYERS, MAX_REWIND_MS, Mode, NEAR_EVENTS,
  PARK_X, PARK_Z, PATCH_RATE_MS, PICKUP_FOOD, PICKUP_RESPAWN_MS, PICKUP_ZOOMIES, ZOOMIES_RESPAWN_MS, PLAYER_MAX_HP, RESPAWN_MS, RoundPhase, TAUNT_MS, TICK_RATE, TRAIN_ROOF, Weapon, WEAPONS, ticks,
  PlayerStatus,
} from "../shared/constants.js";
import { AIM_Q } from "../shared/hitscan.js";
import { CITY, groundHeight, mulberry32 } from "../shared/map.js";
import { NAMES, sanitizeOutfit } from "../shared/outfit.js";
import { Car, GameState, Grenade, Pickup, Player, PlayerInfo, PlayerInput } from "../shared/schema.js";
import { MANHOLES } from "../shared/sewer.js";
import {
  addAmmo, carLights, EV_CLIMB, EV_CRASH, EV_DROP, EV_ENTER, EV_EXIT, EV_FIRE, EV_HIDE, EV_POOP, EV_PUNCH, EV_SEWER, EV_SNATCH, EV_THROW, EV_TRAIN_HIT,
  EV_UNHIDE, EV_UNSEWER, getAmmo, stepGrenade, stepPlayer, wrapAngle, type GrenadeLike, type SimCtx,
} from "../shared/sim.js";
import { TRAIN_SLOTS } from "../shared/train.js";
import { BattleRoyale, DEFAULT_ROUND, type RoundOptions } from "./BattleRoyale.js";
import { Bins } from "./Bins.js";
import { Combat } from "./Combat.js";
import { GarbageDay } from "./GarbageDay.js";
import { Gulls } from "./Gulls.js";
import { Interest } from "./Interest.js";
import { Loot } from "./Loot.js";
import { Pedestrians } from "./Pedestrians.js";
import { Poles } from "./Poles.js";
import { ServerWorld } from "./ServerWorld.js";
import { Sewers } from "./Sewers.js";
import { Traffic, type CarBody } from "./Traffic.js";

const DEV = process.env.NODE_ENV !== "production";

export interface CreateOptions {
  /** Dev/test only: `false` keeps the room in warmup (no rounds); an object tunes the rounds. */
  br?: false | Partial<RoundOptions>;
}

export class GameRoom extends Room<{ state: GameState; input: PlayerInput }> {
  maxClients = MAX_PLAYERS;
  state = new GameState();
  patchRate = PATCH_RATE_MS;

  /**
   * One flat input per fixed step per client. `sanitize` clamps every decoded
   * frame in place (NaN-safe), so a modified client can't send a 127-strength
   * stick or a NaN aim into the shared step.
   */
  inputs = this.defineInput(PlayerInput, {
    bufferMaxSize: 64,
    sanitize: {
      mx: [-100, 100], mz: [-100, 100], throttle: [-100, 100], steer: [-100, 100],
      aim: [-Math.PI, Math.PI], pitch: [-Math.round(Math.PI / 2 * AIM_Q), Math.round(Math.PI / 2 * AIM_Q)], weapon: [0, Weapon.Grenade],
    },
  });

  /**
   * Lag compensation. Players and cars are shown interpolated on clients
   * (snapshot timeline); pedestrians are dead-reckoned (reckon timeline). Having a
   * reckon group also makes every input carry its integer reckon stamp, which the
   * shared step uses as the clock for the (un-networked) trains.
   */
  rewind = this.allowRewindState({ maxRewindMs: MAX_REWIND_MS });

  readonly bodies = new Map<number, CarBody>();
  readonly carsById = new Map<number, Car>();
  readonly world = new ServerWorld(this);
  readonly traffic = new Traffic(this);
  readonly peds = new Pedestrians(this);
  readonly combat = new Combat(this);
  readonly interest = new Interest(this);
  readonly bins = new Bins(this);
  readonly poles = new Poles(this);
  readonly sewers = new Sewers(this);
  readonly gulls = new Gulls(this);
  readonly loot = new Loot(this);
  readonly garbage = new GarbageDay(this);
  br = new BattleRoyale(this, DEFAULT_ROUND);
  readonly rand = mulberry32(Date.now() & 0xffffffff);

  private respawnAt = new Map<string, number>();
  /** CarLight bits of each driver's last input (their car shows them). */
  private lights = new Map<string, number>();
  private tauntAt = new Map<string, number>();
  private pickupRespawn = new Map<string, number>();
  private grenadeSeq = 0;
  private nameIdx = 0;
  now = 0;

  messages = {
    honk: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.mode !== Mode.Driving) return;
      this.interest.broadcastNear("honk", { id: p.veh }, p.x, p.z, NEAR_EVENTS, client);
      const car = this.carsById.get(p.veh);
      if (car && (car.kind === 2 || car.kind === CAR_GARBAGE)) {
        // pest control (and the garbage truck): the horn button toggles the siren (its beacons)
        car.siren = !car.siren;
        this.bodies.get(car.id)!.sirenUntil = car.siren ? this.now + 60000 : 0;
      }
    },
    /** A spectator chose whom to watch: their view of the world follows. */
    spectate: (client: Client, m: { s?: string }) => {
      if (typeof m?.s === "string") this.interest.spectate(client, m.s);
    },
    /** V, out of the round: fly about as a gull (`on`), or watch someone instead. */
    gull: (client: Client, m: { on?: boolean }) => {
      const info = this.info(client.sessionId);
      if (!info || info.status === PlayerStatus.Playing || typeof m?.on !== "boolean") return;
      if (this.gulls.toggle(client.sessionId, m.on)) this.interest.update(client);
    },
    /**
     * T: a butt-wiggle and a chitter for whoever is around (the sender already played it).
     * From inside a trash can it gives you away: the can rattles (`c`).
     */
    taunt: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.mode === Mode.Dead || p.mode === Mode.Knocked || p.mode === Mode.Driving) return;
      const sid = client.sessionId;
      if (this.now < (this.tauntAt.get(sid) ?? 0)) return;
      this.tauntAt.set(sid, this.now + TAUNT_MS);
      // (from a trash can the can rattles, `c`; down the sewer, the manhole over you, `m`; a gull squawks)
      const where = p.mode === Mode.Hidden ? { c: p.veh } : p.mode === Mode.Sewer ? { m: p.lz } : {};
      this.interest.broadcastNear("taunt", { s: sid, ...where }, p.x, p.z, NEAR_EVENTS, client);
    },
    // Dev-only test hooks (automated browser tests).
    ...(DEV ? {
      // Teleport yourself. With `yaw` while driving, the car comes along (and faces `yaw`).
      dbg_tp: (client: Client, m: { x: number; z: number; y?: number; yaw?: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (!p || !Number.isFinite(m?.x) || !Number.isFinite(m?.z)) return;
        p.life = (p.life + 1) & 0xffff;
        const car = p.mode === Mode.Driving ? this.carsById.get(p.veh) : undefined;
        if (car && Number.isFinite(m.yaw)) {
          car.x = p.x = m.x; car.z = p.z = m.z; car.y = p.y = 0;
          car.yaw = p.yaw = m.yaw!;
          car.vx = car.vz = p.vx = p.vy = p.vz = 0;
          p.steer = p.yawRate = 0;
          return;
        }
        // (a gull stays a gull: up where it was, or at `y`)
        if (p.mode === Mode.Gull) {
          p.x = m.x; p.z = m.z; p.y = m.y ?? p.y; p.vx = 0; p.vy = 0; p.vz = 0; p.timer = 0;
          return;
        }
        if (p.mode === Mode.Driving) this.releaseCar(p);
        p.x = m.x; p.z = m.z; p.y = m.y ?? 0; p.vx = 0; p.vy = 0; p.vz = 0;
        p.mode = Mode.Foot; p.veh = -1; p.grounded = true; p.charge = 0; p.coyote = 0; p.timer = 0;
      },
      // Stand on a train roof: car `slot` (as in TRAIN_SLOTS), at train coordinate `u` (U: 0 at the
      // train's nose, negative toward its tail; see train.ts).
      dbg_ride: (client: Client, m: { slot: number; u: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (!p || !Number.isInteger(m?.slot) || m.slot < 0 || m.slot >= TRAIN_SLOTS || !Number.isFinite(m?.u)) return;
        if (p.mode === Mode.Driving) this.releaseCar(p);
        p.life = (p.life + 1) & 0xffff;
        p.charge = 0;
        p.mode = Mode.Train; p.veh = m.slot;
        p.lx = 0; p.ly = TRAIN_ROOF; p.lz = m.u; p.lyaw = 0;
        p.vx = 0; p.vy = 0; p.vz = 0; p.grounded = true;
        // (the next step places them in the world from the timetable)
      },
      // Give yourself the zoomies for `s` seconds (0 ends them), as if you'd drunk a coffee.
      dbg_zoomies: (client: Client, m: { s: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (p && p.mode !== Mode.Dead && Number.isFinite(m?.s)) p.zoomies = Math.max(0, Math.min(0xffff, ticks(m.s)));
      },
      // Set your own health (to get knocked out quickly in a scripted round).
      dbg_hp: (client: Client, m: { hp: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (p && p.mode !== Mode.Dead && Number.isFinite(m?.hp)) p.hp = Math.max(1, Math.min(PLAYER_MAX_HP, Math.round(m.hp)));
      },
      // Set your ammo for weapon `w` (1-4) to `n`, behind your client's back: a stink bomb it
      // predicts throwing then never comes (the browser tests' server-side rejection).
      dbg_ammo: (client: Client, m: { w: number; n: number }) => {
        const p = this.state.players.get(client.sessionId);
        if (!p || !Number.isInteger(m?.w) || m.w < Weapon.Pistol || m.w > Weapon.Grenade || !Number.isFinite(m?.n)) return;
        addAmmo(p, m.w, Math.round(m.n) - getAmmo(p, m.w));
      },
      // Garbage Day now (in a live round).
      dbg_garbage: () => this.garbage.startNow(),
      // Knock yourself out (in a live round: out of it, a gull soon).
      dbg_ko: (client: Client) => {
        const p = this.state.players.get(client.sessionId);
        if (p) this.combat.damagePlayer(p, client.sessionId, 999, null, "zone");
      },
      // Out of the round: hatch as a gull now (instead of after the knockout's moment).
      dbg_gull: (client: Client) => this.gulls.toggle(client.sessionId, true),
      // Down manhole `i` (index into MANHOLES), as if you'd dived in.
      dbg_sewer: (client: Client, m: { i: number }) => {
        const p = this.state.players.get(client.sessionId);
        const h = MANHOLES[m?.i];
        if (!p || !h || p.mode === Mode.Dead || p.mode === Mode.Gull) return;
        if (p.mode === Mode.Driving) this.releaseCar(p);
        p.life = (p.life + 1) & 0xffff;
        p.mode = Mode.Sewer; p.veh = h.edge; p.lx = h.s; p.lz = m.i; p.vx = 0; p.vy = 0; p.vz = 0;
        p.x = h.x; p.z = h.z; p.charge = 0; p.timer = 0;
        this.sewers.onDive(client.sessionId, m.i);
      },
      // Drive the round: { phase: "warmup" | "countdown" | "live" } jumps there (live: GO now);
      // { skip: ms } fast-forwards the fumes.
      dbg_round: (_client: Client, m: { phase?: string; skip?: number }) => {
        if (m?.phase === "warmup") this.br.toWarmup();
        else if (m?.phase === "countdown") this.br.startCountdown();
        else if (m?.phase === "live" && this.state.round.phase === RoundPhase.Countdown) this.state.round.goAt = this.state.round.endsAt = this.now;
        if (Number.isFinite(m?.skip)) this.br.skipZone(m.skip!);
      },
    } : {}),
  };

  onCreate(options: CreateOptions = {}) {
    // test/dev knobs for the rounds (never from a production client)
    if (DEV && options?.br !== undefined) {
      this.br = new BattleRoyale(this, options.br === false ? { ...DEFAULT_ROUND, enabled: false } : { ...DEFAULT_ROUND, ...options.br });
    }

    this.rewind.attachAll(this.state.players, { fields: ["x", "y", "z", "lx", "lz"] });
    // what a player was standing on, as of the same instant: a rider's lx/lz only mean
    // something together with the mode and the car (or train car) they're relative to
    this.rewind.attachAll(this.state.players, { fields: ["mode", "veh"], interpolate: "step" });
    this.rewind.attachAll(this.state.cars, { fields: ["x", "z", "yaw", "vx", "vz"] });
    this.rewind.attachAll(this.state.npcs, { fields: ["x", "y", "z"], mode: "reckon" });

    CITY.pickups.forEach((spot, i) => {
      this.state.pickups.set(String(i), new Pickup({
        x: spot.x, z: spot.z, y: spot.y ?? groundHeight(spot.x, spot.z, 5), kind: spot.kind, active: true,
      }));
    });
    this.bins.ensure();
    this.traffic.populate();
    this.garbage.ensureTruck();
    this.peds.populate();

    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);
  }

  /** A dev-mode reload: the clock restarted, so every round timestamp is meaningless now. */
  onRestoreRoom() {
    this.br.toWarmup();
  }

  onJoin(client: Client, options: { name?: string; look?: number }) {
    const name = String(options?.name ?? "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 14)
      || `${NAMES[this.nameIdx++ % NAMES.length]}${Math.floor(this.rand() * 90 + 10)}`;
    // the outfit picked on the start screen (or a random one)
    const look = sanitizeOutfit(options?.look, this.rand);
    const p = new Player({ name, look });
    this.state.players.set(client.sessionId, p);
    this.state.roster.set(client.sessionId, new PlayerInfo({ name, look }));
    this.br.onJoin(client.sessionId, p);
    this.interest.onJoin(client);
    this.broadcast("feed", { text: `${name} crawled out of a dumpster`, i: "raccoon" });
  }

  onDrop(client: Client, _code: CloseCode) {
    const info = this.info(client.sessionId);
    if (info) info.connected = false;
    this.allowReconnection(client, 20).catch(() => {});
  }

  onReconnect(client: Client) {
    const sid = client.sessionId;
    const info = this.info(sid);
    if (info) info.connected = true;
    const p = this.state.players.get(sid);
    if (p) this.br.onReconnect(sid, p);
    this.interest.update(client);
  }

  onLeave(client: Client, _code: CloseCode) {
    const sid = client.sessionId;
    const p = this.state.players.get(sid);
    this.br.onLeave(sid);
    // (a gull lets go of what it carries before it goes)
    this.gulls.forget(sid);
    if (p) {
      if (p.mode === Mode.Driving) this.releaseCar(p);
      this.broadcast("feed", { text: `${p.name} left`, i: "raccoon" });
    }
    this.state.players.delete(sid);
    this.state.roster.delete(sid);
    this.respawnAt.delete(sid);
    this.tauntAt.delete(sid);
    this.lights.delete(sid);
    this.bins.forget(sid);
    this.sewers.forget(sid);
    this.interest.onLeave(client);
  }

  info(sid: string): PlayerInfo | undefined {
    return this.state.roster.get(sid);
  }

  // ------------------------------------------------------------------ simulation
  private step(ctx: StepContext) {
    this.now = this.clock.elapsedTime;
    this.ensureIndexes();
    this.bins.ensure();
    // (a dev-mode restore brings the cars back, but a room from before Garbage Day has no truck)
    this.garbage.ensureTruck();
    this.br.preStep(this.now);

    // 1. players: exactly one shared step per received input, in order
    this.world.frame();
    for (const [sid, p] of this.state.players) {
      const channel = this.inputs.get(sid);
      for (const cmd of channel) {
        // The reckon stamp of THIS input: the exact instant the client predicted at.
        const time = channel.reckonTime;
        // The world as this client saw it when sending this input.
        const seen = this.rewind.lastSeenBy(sid);
        this.world.bind(seen, sid);
        const sctx: SimCtx = { dt: ctx.dt, time, memo: (_k, compute) => compute(), frozen: this.br.frozen(time) };
        const prevVeh = p.veh, prevMode = p.mode;
        const ev = stepPlayer(sctx, p, cmd, this.world);
        p.aim = cmd.aim;
        if (p.mode === Mode.Driving) this.lights.set(sid, carLights(p, cmd));
        if (sctx.picked) this.takePickup(p, sctx.picked);
        // down a manhole, up out of one, and the ones scurried under on the way (they rattle)
        if (ev & EV_SEWER && sctx.hole! >= 0) this.sewers.onDive(sid, sctx.hole!);
        if (ev & EV_UNSEWER && sctx.hole! >= 0) this.sewers.onClimb(sid, p, sctx.hole!);
        if (sctx.rattled) this.sewers.rattle(sid, sctx.rattled);
        // a gull's doings: a dropping, loot snatched and let go of
        if (ev & EV_POOP && sctx.poop) this.gulls.poop(sid, sctx.poop);
        if (ev & EV_SNATCH && sctx.snatched) this.loot.snatch(sid, sctx.snatched, p);
        if (ev & EV_DROP && sctx.dropped) this.loot.drop(sid, sctx.dropped);
        // right away: the next input (anyone's) already finds the post lying there
        if (sctx.knocked) for (const k of sctx.knocked) this.poles.knock(k.i, k.fall);
        // and the townsfolk our car ran over are flying before anyone's next input
        if (sctx.runOver) for (const h of sctx.runOver) this.combat.runOver(sid, p.veh, h, time);
        this.afterPlayerStep(sid, p, ev, prevMode, prevVeh, time, channel.consumedCount, cmd, sctx.thrown ?? null);
      }
    }

    // 2. driven cars mirror their drivers
    for (const [sid, p] of this.state.players) {
      if (p.mode !== Mode.Driving) continue;
      const car = this.carsById.get(p.veh);
      if (!car || car.driver !== sid) continue;
      car.x = p.x; car.z = p.z; car.y = p.y;
      car.vx = p.vx; car.vz = p.vz;
      car.yaw = car.yaw + wrapAngle(p.yaw - car.yaw);
      car.steer = p.steer;
      const lights = this.lights.get(sid) ?? 0;
      if (car.lights !== lights) car.lights = lights;
      const body = this.bodies.get(car.id)!;
      body.vy = p.vy;
      body.yawRate = p.yawRate;
    }

    // 3-5. AI (the garbage truck's own first: it's a car too), free bodies, everything that hits everything
    this.garbage.step(ctx.dt);
    this.traffic.step(ctx.dt);
    this.peds.step(ctx.dt);
    this.combat.stepCollisions(ctx.dt);
    this.bins.step();
    this.sewers.step();
    this.gulls.step(ctx.dt);

    // 6. grenades (one thrown this step starts flying next step: its launch state is
    //    the one the thrower's client predicted at `bornMs`)
    for (const [key, g] of this.state.grenades) {
      if (g.bornMs !== this.now) stepGrenade(g, ctx.dt);
      if (this.now - g.bornMs >= GRENADE_FUSE_MS) {
        this.state.grenades.delete(key);
        this.combat.explode(g.x, g.y, g.z, WEAPONS[Weapon.Grenade].range, WEAPONS[Weapon.Grenade].damage, g.owner);
      }
    }

    // 7. pickups come back (grabbing one happens inside the shared step), never in the fumes; loose
    //    loot lands, and goes
    this.loot.step();
    for (const [key, pk] of this.state.pickups) {
      if (pk.active || pk.loose) continue;
      const at = this.pickupRespawn.get(key) ?? 0;
      if (this.now >= at && this.br.pickupAllowed(pk)) pk.active = true;
    }

    // 8. respawns (only outside a round)
    if (this.br.respawnsOn) {
      for (const [sid, at] of this.respawnAt) {
        if (this.now < at) continue;
        const p = this.state.players.get(sid);
        this.respawnAt.delete(sid);
        if (p) this.spawnPlayer(p);
      }
    }

    // 9. the round (after all of this step's damage), then who sees what
    this.br.postStep(ctx.dt);
    this.interest.step();
  }

  private afterPlayerStep(sid: string, p: Player, ev: number, prevMode: number, prevVeh: number, time: number, tick: number, cmd: PlayerInput, thrown: GrenadeLike | null) {
    if (ev & EV_ENTER) {
      const car = this.carsById.get(p.veh);
      if (!car || car.state === 2) {
        // rejected: the client will reconcile back onto its feet
        p.mode = Mode.Foot;
        p.veh = -1;
      } else {
        this.takeCar(sid, p, car);
      }
    }
    if (ev & EV_EXIT && prevMode === Mode.Driving) {
      const car = this.carsById.get(prevVeh);
      if (car && car.driver === sid) {
        car.driver = "";
        this.bodies.get(car.id)!.idleSince = this.now;
      }
    }
    if (ev & EV_TRAIN_HIT) {
      if (p.mode === Mode.Driving) {
        const car = this.carsById.get(p.veh);
        if (car) this.combat.damageCar(car, 70, sid);
        for (const [, q] of this.state.players) {
          if (q.mode === Mode.Roof && q.veh === p.veh) this.combat.knock(q, p.vx * 0.8, 11, p.vz * 0.8, ticks(1.6));
        }
        this.combat.damagePlayer(p, sid, 25, null, "train");
      } else {
        this.combat.damagePlayer(p, sid, 45, null, "train");
      }
    }
    if (ev & EV_CRASH && p.mode === Mode.Driving) {
      const car = this.carsById.get(p.veh);
      if (car) this.combat.damageCar(car, 4, sid);
    }
    // a trash can it drives through (cars don't stop at them): lid off, and out pops whoever was in it
    if (p.mode === Mode.Driving && p.y < 1 && p.vx * p.vx + p.vz * p.vz >= LOOSE_KNOCK_SPEED * LOOSE_KNOCK_SPEED) {
      const car = this.carsById.get(p.veh);
      if (car) {
        const type = CAR_TYPES[car.kind];
        this.bins.ram(p.x, p.z, p.yaw, type.halfW, type.halfL, sid);
      }
    }
    // trash cans: in (others stop getting you once they've seen the dive), out, or someone's in there already
    if (ev & EV_HIDE) this.bins.onHide(sid);
    if (ev & EV_UNHIDE && prevMode === Mode.Hidden) this.bins.onUnhide(sid, p, prevVeh);
    if (this.world.taken >= 0 && !(ev & (EV_HIDE | EV_ENTER | EV_CLIMB))) this.bins.knock(this.world.taken, sid);
    // (only a raccoon in the round shoots: out of it, nothing it does can hurt anyone)
    if (ev & (EV_FIRE | EV_PUNCH) && (this.br.respawnsOn || this.br.isPlaying(sid))) this.combat.fire(sid, p, cmd.aim, cmd.pitch / AIM_Q, cmd.eye, time, tick);
    if (ev & EV_THROW && thrown) this.throwGrenade(sid, thrown, tick);
  }

  /**
   * The shared step emptied a loot can (its ammo, or a coffee's zoomies, are already in) or a
   * snack (the heal is ours: hp isn't part of the step): either way it's gone for a while.
   */
  private takePickup(p: Player, key: string) {
    const pk = this.state.pickups.get(key);
    if (!pk) return;
    if (pk.kind === PICKUP_FOOD) p.hp = Math.min(PLAYER_MAX_HP, p.hp + FOOD_HP);
    // loose loot is had once; a can refills
    if (pk.loose) this.loot.take(key);
    else this.emptyCan(key, pk);
  }

  /** Loot can `key` was emptied (looted, or a gull snatched its loot): it refills a while later. */
  emptyCan(key: string, pk: Pickup) {
    pk.active = false;
    this.pickupRespawn.set(key, this.now + (pk.kind === PICKUP_FOOD ? FOOD_RESPAWN_MS : pk.kind === PICKUP_ZOOMIES ? ZOOMIES_RESPAWN_MS : PICKUP_RESPAWN_MS));
  }

  // ------------------------------------------------------------------ cars
  /** `sid` takes the wheel of `car`, yanking out whoever was driving. */
  private takeCar(sid: string, p: Player, car: Car) {
    const prev = car.driver;
    if (prev === "npc") {
      this.peds.ejectDriver(car);
      const what = CAR_TYPES[car.kind].name;
      this.broadcast("feed", { text: `${p.name} stole ${/^[aeiou]/i.test(what) ? "an" : "a"} ${what}!`, i: CAR_TYPES[car.kind].model });
    } else if (prev && prev !== sid) {
      const victim = this.state.players.get(prev);
      if (victim && victim.mode === Mode.Driving && victim.veh === car.id) {
        const lx = Math.cos(victim.yaw), lz = -Math.sin(victim.yaw);
        victim.mode = Mode.Knocked;
        victim.timer = ticks(1.2);
        victim.veh = -1;
        victim.x += lx * 1.8; victim.z += lz * 1.8;
        victim.vx = lx * 6; victim.vz = lz * 6; victim.vy = 5;
        victim.grounded = false;
        this.broadcast("feed", { text: `${p.name} carjacked ${victim.name}!`, i: CAR_TYPES[car.kind].model });
      }
    }
    car.driver = sid;
    const body = this.bodies.get(car.id)!;
    body.ai = null;
    // the step placed us at the car pose this player saw; the car follows us from now on
  }

  /** The driver is gone: the car keeps rolling on its own. */
  releaseCar(p: Player) {
    const car = this.carsById.get(p.veh);
    if (car && car.driver !== "npc") {
      car.driver = "";
      this.bodies.get(car.id)!.idleSince = this.now;
    }
  }

  /**
   * `sid` let go of a stink bomb on their input `seq`: `launch` is what the shared step
   * computed (the thrower's client predicted the very same numbers, and keys its throw by `seq`).
   */
  private throwGrenade(sid: string, launch: GrenadeLike, seq: number) {
    const g = new Grenade({ ...launch, owner: sid, seq, bornMs: this.now });
    this.state.grenades.set(String(++this.grenadeSeq), g);
    // straight into nearby views: the thrower's predicted grenade hands off to this one
    this.interest.addNear(g, g.x, g.z);
  }

  // ------------------------------------------------------------------ players
  /** A fresh life at `spot` (a random sidewalk corner by default). Clients reset their prediction (`life`). */
  spawnPlayer(p: Player, spot?: { x: number; z: number }) {
    const s = spot ?? CITY.spawns[Math.floor(this.rand() * CITY.spawns.length)];
    p.x = s.x + (this.rand() - 0.5) * 2;
    p.z = s.z + (this.rand() - 0.5) * 2;
    p.y = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.mode = Mode.Foot;
    p.veh = -1;
    p.lx = 0; p.ly = 0; p.lz = 0; p.lyaw = 0;
    p.steer = 0; p.yawRate = 0;
    p.grounded = true;
    p.hp = PLAYER_MAX_HP;
    p.weapon = Weapon.Pistol;
    p.ammo1 = 24; p.ammo2 = 0; p.ammo3 = 0; p.ammo4 = 1;
    p.cd = 0; p.timer = 0; p.zoomies = 0; p.charge = 0; p.coyote = 0; p.stench = 0;
    p.life = (p.life + 1) & 0xffff;
  }

  /** Out of the game until the next round: an inert body off the map (never in anyone's view). */
  park(p: Player) {
    if (p.mode === Mode.Driving) this.releaseCar(p);
    p.x = PARK_X; p.z = PARK_Z; p.y = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.mode = Mode.Dead;
    p.veh = -1;
    p.grounded = true;
    p.hp = PLAYER_MAX_HP;
    p.cd = 0; p.timer = 0; p.zoomies = 0; p.charge = 0; p.coyote = 0; p.stench = 0;
    p.life = (p.life + 1) & 0xffff;
  }

  /** `by`: who gets the kill ("" for nobody). */
  killPlayer(p: Player, sid: string, by = "") {
    if (p.mode === Mode.Driving) this.releaseCar(p);
    p.mode = Mode.Dead;
    p.veh = -1;
    p.hp = 0;
    const info = this.info(sid);
    if (info) info.deaths++;
    if (this.br.respawnsOn) this.respawnAt.set(sid, this.now + RESPAWN_MS);
    else this.br.onEliminated(sid, by);
  }

  /** A new round: put the town back the way it was (car ids stay the same). */
  resetWorld() {
    for (const p of this.state.players.values()) if (p.mode === Mode.Driving) this.releaseCar(p);
    this.traffic.resetAll();
    this.peds.resetAll();
    this.state.grenades.clear();
    for (const pk of this.state.pickups.values()) pk.active = true;
    this.pickupRespawn.clear();
    this.respawnAt.clear();
    this.combat.reset();
    this.bins.reset();
    this.poles.reset();
    this.sewers.reset();
    this.loot.reset();
    this.gulls.reset();
    this.garbage.reset();
  }

  /**
   * Server-only side tables (car bodies, the id index) aren't part of the synced
   * state. In dev mode a hot-reloaded room comes back with its state restored (as new
   * instances) but these empty or stale, so rebuild them from the state.
   */
  private ensureIndexes() {
    let stale = this.carsById.size !== this.state.cars.size;
    if (!stale) for (const car of this.state.cars.values()) if (this.carsById.get(car.id) !== car) { stale = true; break; }
    if (!stale) return;
    this.carsById.clear();
    for (const car of this.state.cars.values()) {
      this.carsById.set(car.id, car);
      if (!this.bodies.has(car.id)) {
        this.bodies.set(car.id, { vy: 0, yawRate: 0, ai: null, idleSince: 0, burnUntil: 0, wreckUntil: 0, lastHitBy: "", sirenUntil: 0, truck: car.kind === CAR_GARBAGE });
        if (car.driver === "npc") car.driver = "";
      }
    }
  }

  newCar(kind: number, x: number, z: number, yaw: number): Car {
    const id = this.carsById.size + 1;
    const type = CAR_TYPES[kind];
    const car = new Car({
      id, kind, x, z, yaw,
      paint: type.paint[Math.floor(this.rand() * type.paint.length)],
      hp: CAR_MAX_HP,
    });
    this.carsById.set(id, car);
    this.bodies.set(id, { vy: 0, yawRate: 0, ai: null, idleSince: 0, burnUntil: 0, wreckUntil: 0, lastHitBy: "", sirenUntil: 0 });
    this.state.cars.set(String(id), car);
    return car;
  }
}
