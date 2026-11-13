import { Container3D, Quaternion } from "@pixi/3d";
import { GRAVITY } from "../../shared/constants.js";
import { BIN_H, CITY, collideCircle, groundHeight, type XZ } from "../../shared/map.js";
import type { Bin } from "../../shared/schema.js";
import { find, instance } from "../assets.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

/** A knocked-off lid comes to rest about this far from its can, the way it flew (where its flight lands, bounce included). */
const LID_REST = 2.3;
/** How high a hider lifts their lid to peek out from under it, and how far it tips back from the camera. */
const PEEK_LIFT = 0.2;
const PEEK_TIP = 0.4;
const UP = { x: 0, y: 1, z: 0 };

interface Entry {
  /** What a car knocks about (`KnockView`): where the can stands, unturned; `root` (the can, turned) hangs from it. */
  carrier: Container3D;
  root: Container3D;
  lid: Container3D | null;
  peek: Container3D | null;
  /** The can's own turn (`BinSpot.rot`). */
  yaw: Quaternion;
  /** Where the lid is: on the can, flying off it, or lying on the ground. */
  lidAt: "on" | "flying" | "off";
  /** The lid while it's off the can (world): position, velocity, tumble. */
  lx: number; ly: number; lz: number; lvx: number; lvy: number; lvz: number;
  spin: number; flip: number; lyaw: number; bounced: boolean;
  /** The can wobbling on its base: tilt (world, toward +x / +z, rad) and its rate. */
  tx: number; tz: number; tvx: number; tvz: number;
  /** A lid jig on the can: a hop as someone dives in, a flip as they hop out (s left). */
  jig: "dive" | "flip" | null; jigT: number; jigYaw: number;
  /** 0..1: how far the lid is lifted for peeking out. */
  peekK: number;
  /** The synced state has been seen once (what it is when we arrive isn't animated). */
  synced: boolean;
}

/**
 * The trash cans raccoons hide in. Drawn from the map (where they stand) and the synced
 * lids (`state.bins`); whether anyone is inside is never known here, except for the can we
 * are in ourselves (or the one whoever we spectate is in), which shows its hider peeking out
 * from under a lifted lid.
 *
 * Lids fly off when a can is hit, lie where they land and pop back on when the server says
 * so; cans wobble on their base when something happens to them. A car knocks a can itself
 * about on each screen alone (`KnockView`, moving its `carriers`); a can someone uses is stood
 * back on its spot first (`standUp`).
 */
export class BinsView {
  readonly root = new Container3D({ label: "bins" });
  /** Each can's carrier, by index into `CITY.bins` (`KnockView` moves them). */
  readonly carriers: Container3D[] = [];
  /** Can `i` is being used (dived into, hopped out of, rattled): put it back on its spot if it's been knocked off. */
  standUp: ((i: number) => void) | null = null;
  private bins: Entry[] = [];
  private readonly q = new Quaternion();
  private readonly xz: XZ = { x: 0, z: 0 };
  private elapsed = 0;

  constructor(private fx: Fx) {
    for (const b of CITY.bins) {
      const carrier = new Container3D({ label: "bin" });
      carrier.position.set(b.x, b.y, b.z);
      const root = instance("trashcan");
      const yaw = new Quaternion().setFromAxisAngle(UP, b.rot);
      root.quaternion = yaw;
      carrier.addChild(root);
      this.root.addChild(carrier);
      this.carriers.push(carrier);
      const peek = find(root, "peek");
      if (peek) peek.visible = false;
      this.bins.push({
        carrier, root, lid: find(root, "lid"), peek, yaw, lidAt: "on",
        lx: 0, ly: 0, lz: 0, lvx: 0, lvy: 0, lvz: 0, spin: 0, flip: 0, lyaw: 0, bounced: false,
        tx: 0, tz: 0, tvx: 0, tvz: 0, jig: null, jigT: 0, jigYaw: 0, peekK: 0, synced: false,
      });
    }
  }

  /** Where can `i`'s rim is (world, wherever it's been knocked to), for effects. */
  rim(i: number) {
    const e = this.bins[i];
    return e ? this.rimOf(e) : { x: 0, y: 0, z: 0 };
  }

  /** Up the can's own up from its carrier, as far as its rim. */
  private rimOf(e: Entry) {
    const p = e.carrier.position, q = e.carrier.quaternion, s = e.carrier.scale.y * BIN_H;
    return {
      x: p.x + s * 2 * (q.x * q.y - q.w * q.z),
      y: p.y + s * (1 - 2 * (q.x * q.x + q.z * q.z)),
      z: p.z + s * 2 * (q.y * q.z + q.w * q.x),
    };
  }

  /** Someone dove into can `i`: the lid hops and clanks shut, the can rocks. */
  dive(i: number) {
    const e = this.bins[i], b = CITY.bins[i];
    if (!e) return;
    this.standUp?.(i);
    if (e.lidAt === "on") { e.jig = "dive"; e.jigT = 0.42; }
    this.kick(e, 0, 0, 0.35);
    this.fx.dustPuff(b.x, b.top - 0.1, b.z, 6);
    sfx.binIn(b.x, b.z);
  }

  /** Someone hopped out of can `i` toward `yaw`: the lid flips up on that side and drops back. */
  hop(i: number, yaw: number) {
    const e = this.bins[i], b = CITY.bins[i];
    if (!e) return;
    this.standUp?.(i);
    if (e.lidAt === "on") { e.jig = "flip"; e.jigT = 0.55; e.jigYaw = yaw; }
    this.kick(e, -Math.sin(yaw), -Math.cos(yaw), 0.25);
    this.fx.dustPuff(b.x, b.top, b.z, 6);
    sfx.binOut(b.x, b.z);
  }

  /** Can `i` took a hit from along (dx, dz): it rocks away from it (the lid is the state's business). */
  hit(i: number, dx: number, dz: number) {
    const e = this.bins[i];
    if (e) this.kick(e, dx, dz, 1);
  }

  /** Something inside can `i` stirs (a taunt from in there): it rattles. */
  rattle(i: number) {
    const e = this.bins[i];
    if (!e) return;
    this.standUp?.(i);
    const a = Math.random() * Math.PI * 2;
    this.kick(e, Math.cos(a), Math.sin(a), 0.6);
    if (e.lidAt === "on") { e.jig = "dive"; e.jigT = 0.3; }
  }

  /** A push on a can's rim (along (dx, dz), or straight down to just bounce it). */
  private kick(e: Entry, dx: number, dz: number, k: number) {
    const l = Math.hypot(dx, dz);
    if (l > 1e-6) { e.tvx += (dx / l) * 2.2 * k; e.tvz += (dz / l) * 2.2 * k; }
    else { const a = Math.random() * Math.PI * 2; e.tvx += Math.cos(a) * 1.2 * k; e.tvz += Math.sin(a) * 1.2 * k; }
  }

  /**
   * Per frame. `lids`: the synced cans (null before we have them); `peek`: the can we're
   * hiding in (or whoever we watch is), and where they look; `cam`: where the camera is (a
   * peeking lid opens toward it); `near`: is a world point close enough to the camera to
   * animate a lid flying off (else it just lies where it lands).
   */
  update(dt: number, lids: { get(key: string): Bin | undefined } | null, peek: { i: number; yaw: number } | null, cam: XZ, near: (x: number, z: number) => boolean) {
    this.elapsed += dt;
    for (let i = 0; i < this.bins.length; i++) {
      const e = this.bins[i], b = CITY.bins[i];
      const st = lids?.get(String(i));
      if (st) this.syncLid(i, e, st, near(b.x, b.z));

      // the wobble: a stiff spring back upright
      if (e.tx || e.tz || e.tvx || e.tvz) {
        const k = 160, c = 9;
        e.tvx += (-k * e.tx - c * e.tvx) * dt; e.tvz += (-k * e.tz - c * e.tvz) * dt;
        e.tx += e.tvx * dt; e.tz += e.tvz * dt;
        if (Math.abs(e.tx) + Math.abs(e.tz) + Math.abs(e.tvx) + Math.abs(e.tvz) < 1e-3) e.tx = e.tz = e.tvx = e.tvz = 0;
        const t = Math.hypot(e.tx, e.tz);
        // tip the top toward (tx, tz): about the horizontal axis across it, after the can's own turn
        if (t > 1e-5) e.root.quaternion = this.q.setFromAxisAngle({ x: e.tz / t, y: 0, z: -e.tx / t }, Math.min(t, 0.3)).multiply(e.yaw);
        else e.root.quaternion = e.yaw;
      }

      // peeking out (only ever one can: ours, or the one we're watching)
      const mine = peek?.i === i && e.lidAt === "on";
      e.peekK += ((mine ? 1 : 0) - e.peekK) * Math.min(1, dt * 10);
      if (e.peekK < 0.01) e.peekK = 0;
      if (e.peek) {
        e.peek.visible = e.peekK > 0.3;
        // up into the gap under the lid; the eyes look where the hider aims (relative to the can's own turn)
        e.peek.position.y = BIN_H + 0.04 + 0.08 * e.peekK;
        if (mine) e.peek.rotation.set(0, peek!.yaw - b.rot, 0);
      }

      if (e.lidAt === "on") this.lidOnCan(e, b.rot, Math.atan2(cam.x - b.x, cam.z - b.z), dt);
      else this.lidLoose(e, dt);
    }
  }

  /** Follow the synced lid: knocked off (fly or lie), or back on. */
  private syncLid(i: number, e: Entry, st: Bin, near: boolean) {
    const off = e.lidAt !== "on";
    if (st.lidOff === off) { e.synced = true; return; }
    // (the can's rim where it is: knocked about by a car, the can may not be on its spot)
    const r = this.rimOf(e);
    if (st.lidOff) {
      // off it goes, the way the hit pushed it (or straight to where it would have landed)
      const dx = Math.sin(st.lidYaw), dz = Math.cos(st.lidYaw);
      this.detachLid(e, r.x, r.y + 0.02, r.z);
      e.lyaw = st.lidYaw;
      if (e.synced && near) {
        e.lidAt = "flying";
        e.lvx = dx * 3.2; e.lvz = dz * 3.2; e.lvy = 6.2;
        e.spin = (Math.random() - 0.5) * 14; e.flip = 0; e.bounced = false;
        this.fx.sparkle(r.x, r.y - 0.4, r.z, 0xd9fff0);
      } else {
        this.restLid(e, r.x + dx * LID_REST, r.z + dz * LID_REST, r.y);
      }
    } else {
      // back on: a poof where it lay, and one on the can
      if (e.synced && near) {
        this.fx.poof(e.lx, e.ly - 0.3, e.lz);
        this.fx.dustPuff(r.x, r.y, r.z, 6);
      }
      this.attachLid(e);
    }
    e.synced = true;
  }

  /**
   * The lid sitting on its can (a child of it): lifted for a peek (open toward the camera,
   * `camYaw`, so the hider sees their own eyes under it), hopping, flipping.
   */
  private lidOnCan(e: Entry, canYaw: number, camYaw: number, dt: number) {
    const lid = e.lid;
    if (!lid) return;
    let y = BIN_H, rx = 0, rz = 0;
    if (e.peekK > 0) {
      // propped up on the hider's head, breathing a little
      const a = camYaw - canYaw, k = e.peekK;
      y += (PEEK_LIFT + Math.sin(this.elapsed * 2.6) * 0.015) * k;
      rx = -PEEK_TIP * Math.cos(a) * k; rz = PEEK_TIP * Math.sin(a) * k;
    }
    if (e.jig) {
      e.jigT -= dt;
      if (e.jigT <= 0) e.jig = null;
      else if (e.jig === "dive") {
        // up as they drop in, then a clattering landing
        const t = 0.42 - e.jigT;
        y += t < 0.26 ? Math.sin((t / 0.26) * Math.PI) * 0.32 : Math.abs(Math.sin((t - 0.26) * 40)) * 0.03 * (e.jigT / 0.16);
        rx += Math.sin(t * 31) * 0.12 * (e.jigT / 0.42);
      } else {
        // flipped up on the hop's side, then dropped back
        const t = 0.55 - e.jigT, a = e.jigYaw - canYaw;
        const u = t < 0.32 ? Math.sin((t / 0.32) * Math.PI * 0.5) : Math.max(0, 1 - (t - 0.32) / 0.2);
        y += 0.38 * u;
        rx += -1.1 * Math.cos(a) * u; rz += 1.1 * Math.sin(a) * u;
      }
    }
    lid.position.set(0, y, 0);
    lid.rotation.set(rx, 0, rz);
  }

  /** A lid off its can: flying (gravity, a bounce, bumping walls) or lying still. */
  private lidLoose(e: Entry, dt: number) {
    const lid = e.lid;
    if (!lid || e.lidAt !== "flying") return;
    e.lvy -= GRAVITY * dt;
    e.lx += e.lvx * dt; e.ly += e.lvy * dt; e.lz += e.lvz * dt;
    this.xz.x = e.lx; this.xz.z = e.lz;
    if (collideCircle(this.xz, e.ly, 0.4, false)) {
      // off a wall: back the way it came
      e.lx = this.xz.x; e.lz = this.xz.z;
      e.lvx *= -0.4; e.lvz *= -0.4;
    }
    e.lyaw += e.spin * dt;
    e.flip = Math.min(Math.PI, e.flip + dt * 9);
    const floor = groundHeight(e.lx, e.lz, e.ly) + 0.15;
    if (e.ly <= floor && e.lvy < 0) {
      if (!e.bounced) {
        // one clanging bounce, then it settles (upside down)
        e.bounced = true;
        e.ly = floor;
        e.lvy = -e.lvy * 0.3; e.lvx *= 0.45; e.lvz *= 0.45; e.spin *= 0.4;
        sfx.clang(e.lx, e.lz);
        this.fx.dustPuff(e.lx, floor - 0.15, e.lz, 5);
      } else {
        this.restLid(e, e.lx, e.lz, e.ly + 1);
        return;
      }
    }
    lid.position.set(e.lx, e.ly, e.lz);
    lid.rotation.set(e.flip, e.lyaw, 0);
  }

  /** Off the can and into the world (where the can's rim is now). */
  private detachLid(e: Entry, x: number, y: number, z: number) {
    if (!e.lid) return;
    this.root.addChild(e.lid);
    e.lx = x; e.ly = y; e.lz = z;
    e.lid.position.set(x, y, z);
    e.lid.rotation.set(0, 0, 0);
    e.jig = null;
  }

  /** Lying on the ground at (x, z) (or just outside a wall there), upside down, under `from` (a height to look down from). */
  private restLid(e: Entry, x: number, z: number, from: number) {
    e.lidAt = "off";
    if (!e.lid) return;
    this.xz.x = x; this.xz.z = z;
    collideCircle(this.xz, 0, 0.4, false);
    x = this.xz.x; z = this.xz.z;
    const floor = groundHeight(x, z, from) + 0.15;
    e.lx = x; e.ly = floor; e.lz = z;
    e.lid.position.set(x, floor, z);
    e.lid.rotation.set(Math.PI, e.lyaw, 0);
  }

  /** Back on its can. */
  private attachLid(e: Entry) {
    e.lidAt = "on";
    if (!e.lid) return;
    e.root.addChild(e.lid);
    e.lid.position.set(0, BIN_H, 0);
    e.lid.rotation.set(0, 0, 0);
  }

  /**
   * Loading-screen warm-up: one can shows its peeking hider for a frame, so the eyes'
   * material is compiled now rather than the first time someone hides. Returns the undo.
   */
  prewarm(): () => void {
    const e = this.bins[0];
    if (!e?.peek) return () => {};
    e.peek.visible = true;
    return () => { e.peek!.visible = false; };
  }
}
