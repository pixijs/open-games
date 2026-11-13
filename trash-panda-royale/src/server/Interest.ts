import { StateView, type Ref } from "@colyseus/schema";
import type { Client } from "colyseus";
import { AOI_EVERY, AOI_IN, AOI_OUT, Mode, PlayerStatus, RoundPhase } from "../shared/constants.js";
import { OWNER, type Player } from "../shared/schema.js";
import type { GameRoom } from "./GameRoom.js";
import { Spots } from "./Spots.js";

const IN2 = AOI_IN * AOI_IN, OUT2 = AOI_OUT * AOI_OUT;

/**
 * Interest management: each client only receives the players, cars, pedestrians and
 * grenades near what it's looking at — its own player, or whoever it spectates (the
 * `players`, `cars`, `npcs` and `grenades` maps are `.view()` collections). Entities
 * enter a client's `StateView` within AOI_IN metres and leave beyond AOI_OUT; positional
 * events (shots, crashes, honks…) are sent only to clients looking from nearby.
 *
 * Everything the shared step reads about other entities is within ~12 m, and hit tests
 * reach 45 m, both well inside AOI_IN: what a client predicts against is always in view.
 *
 * A raccoon hiding in a trash can isn't sent to anyone (but whoever spectates them) once
 * those around have seen the dive (`Bins.secret`): hiding is the server keeping a secret,
 * not the clients agreeing not to draw someone. They come back the moment they're out. The
 * same goes for a raccoon down the sewer (`Sewers.secret`).
 *
 * A gull (a raccoon out of the round, flying about) is sent its own surroundings, like a raccoon
 * still in it: it's somewhere in the town, not watching someone.
 */
export class Interest {
  /** Spectator sid → the sid they asked to watch. */
  private targets = new Map<string, string>();
  /** Where each client is looking from, as of the last pass. */
  private centres = new Map<string, { x: number; z: number }>();
  private tick = 0;
  private readonly c = { x: 0, z: 0 };
  // (as of the last `locate`)
  private readonly players = new Spots<Player>();
  private readonly secret: boolean[] = [];
  private readonly others = new Spots<Ref>();

  constructor(private room: GameRoom) {}

  /** A spectator picked someone to watch: their view moves there right away. */
  spectate(client: Client, target: string) {
    if (typeof target !== "string" || !this.room.state.players.has(target)) return;
    this.targets.set(client.sessionId, target);
    this.update(client);
  }

  /** Whose surroundings client `sid` is sent. */
  watching(sid: string): string {
    const r = this.room.state.round;
    if (r.phase === RoundPhase.Victory && r.winner && this.room.state.players.has(r.winner)) return r.winner;
    // a gull (or one about to hatch where it fell) is somewhere in town itself
    if (this.room.state.players.get(sid)?.mode === Mode.Gull || this.room.gulls.hatching(sid)) return sid;
    const info = this.room.info(sid);
    if (info && info.status !== PlayerStatus.Playing) {
      const t = this.targets.get(sid);
      if (t && this.room.info(t)?.status === PlayerStatus.Playing && this.room.state.players.has(t)) return t;
      // nobody picked (yet): anyone still in
      for (const [qsid, q] of this.room.state.roster) if (q.status === PlayerStatus.Playing && this.room.state.players.has(qsid)) return qsid;
    }
    return sid;
  }

  onJoin(client: Client) {
    const p = this.room.state.players.get(client.sessionId);
    if (!client.view) client.view = new StateView();
    if (p) client.view.add(p, OWNER);
    this.update(client);
  }

  onLeave(client: Client) {
    client.view?.dispose();
    this.targets.delete(client.sessionId);
    this.centres.delete(client.sessionId);
  }

  step() {
    if (++this.tick % AOI_EVERY !== 0) return;
    this.locate();
    for (const client of this.room.clients) this.update(client, false);
  }

  /** Where everything is, and who's keeping out of sight: once per pass, shared by every client's update. */
  private locate() {
    const state = this.room.state;
    const players = this.players.reset();
    for (const [qsid, q] of state.players) {
      this.secret[players.n] = this.room.bins.secret(qsid, q) || this.room.sewers.secret(qsid, q);
      const pos = this.room.br.livePos(q, this.c);
      players.add(qsid, q, pos.x, pos.z);
    }
    const others = this.others.reset();
    for (const car of state.cars.values()) others.add("", car, car.x, car.z);
    for (const npc of state.npcs.values()) others.add("", npc, npc.x, npc.z);
    for (const g of state.grenades.values()) others.add("", g, g.x, g.z);
  }

  /** Bring one client's view up to date (`fresh`: on its own, not as part of a pass). */
  update(client: Client, fresh = true) {
    if (fresh) this.locate();
    // a dev-mode reload restores the state but not the clients' views
    const view = (client.view ??= new StateView());
    const sid = client.sessionId;
    const state = this.room.state;
    const own = state.players.get(sid);
    if (own && !view.has(own)) view.add(own, OWNER);

    const watched = this.watching(sid);
    // (so the client can draw where its view is: the minimap's rings)
    if (own && own.aoi !== watched) own.aoi = watched;
    const who = state.players.get(watched);
    if (!who) return;
    const c = this.room.br.livePos(who, this.c);
    const cx = c.x, cz = c.z;
    this.centres.set(sid, { x: cx, z: cz });

    const consider = (e: Ref, x: number, z: number) => {
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      const seen = view.has(e);
      if (!seen && d2 <= IN2) view.add(e);
      else if (seen && d2 > OUT2) view.remove(e);
    };
    const players = this.players, others = this.others;
    for (let i = 0; i < players.n; i++) {
      const qsid = players.keys[i], q = players.items[i];
      if (qsid === sid) continue;
      if (qsid !== watched && this.secret[i]) {
        if (view.has(q)) view.remove(q);
        continue;
      }
      consider(q, players.x[i], players.z[i]);
    }
    for (let i = 0; i < others.n; i++) consider(others.items[i], others.x[i], others.z[i]);
  }

  /** Where client `sid` was last looking from (its view's centre), if it has been placed yet. */
  centreOf(sid: string): { x: number; z: number } | undefined {
    return this.centres.get(sid);
  }

  /** A new entity at (x, z) (a grenade): into every view near it now, not at the next pass. */
  addNear(e: Ref, x: number, z: number) {
    for (const client of this.room.clients) {
      const c = this.centres.get(client.sessionId);
      if (c && (x - c.x) ** 2 + (z - c.z) ** 2 > IN2) continue;
      (client.view ??= new StateView()).add(e);
    }
  }

  /** Out of a trash can: back into every view near them now, not at the next pass. */
  reveal(p: Player) {
    for (const client of this.room.clients) {
      const c = this.centres.get(client.sessionId);
      if (c && (p.x - c.x) ** 2 + (p.z - c.z) ** 2 > IN2) continue;
      const view = (client.view ??= new StateView());
      if (!view.has(p)) view.add(p);
    }
  }

  /** Send a positional event only to clients looking from within `radius` of (x, z). */
  broadcastNear(type: string, message: unknown, x: number, z: number, radius: number, except?: Client) {
    const r2 = radius * radius;
    for (const client of this.room.clients) {
      if (client === except) continue;
      const c = this.centres.get(client.sessionId);
      // no centre yet (just joined): send rather than drop
      if (c && (x - c.x) ** 2 + (z - c.z) ** 2 > r2) continue;
      client.send(type, message);
    }
  }
}
