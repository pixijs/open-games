import { Container3D, Material3D } from "@pixi/3d";
import { Matrix } from "pixi.js";
import { GRENADE_FUSE_MS, GRENADE_RADIUS, Weapon, WEAPONS } from "../../shared/constants.js";
import { GRENADE_SUBSTEP, type GrenadePath } from "../../shared/sim.js";
import { instance } from "../assets.js";
import type { Fx } from "../Fx.js";
import { Band, bandMaterial, tapeTexture } from "../gfx/Band.js";
import { sfx } from "../Sfx.js";

/** One stink bomb to draw this frame. */
export interface GrenadeDraw {
  /** Stable for its whole life, across the predicted → server hand-off (the spawn entry's id). */
  id: number;
  x: number; y: number; z: number;
  /** Seconds since it was thrown, on the timeline it's drawn at. */
  t: number;
  /** Its path from `t0` s after the throw on (bounces, where it goes off), or null while unknown. */
  path: GrenadePath | null;
  t0: number;
}

interface Bomb {
  node: Container3D;
  ring: Band | null;
  ringMat: Material3D | null;
  ringUv: Matrix;
  seen: boolean;
  path: GrenadePath | null;
  /** The next bounce of `path` to clink and squash on (an index into its pairs). */
  bounce: number;
  squash: number;
  spin: number;
  /** Where it was drawn last frame (for its speed). */
  px: number; py: number; pz: number;
  throb: number;
  nextTick: number;
  whistled: boolean;
  wisp: number;
}

const FUSE = GRENADE_FUSE_MS / 1000;
/** The blast's reach (m): the danger ring is this big. */
const BLAST_R = WEAPONS[Weapon.Grenade].range;
/** How big the bottle is drawn (the model is hand-sized). */
const SCALE = 1.6;
/** Danger rings at once (more stink bombs than that just don't get one). */
const RINGS = 8;

/**
 * Every stink bomb in the air or on the ground: a green glass bottle, corked, full of stink.
 * - In flight it tumbles end over end with its speed, trailing stink from the cork.
 * - Its bounces are known in advance (its path is the server's own integration), so each one
 *   lands on time: a squash, a glassy clink, a puff of dust.
 * - The pressure builds as the fuse runs down: it bulges and rattles, faster and faster,
 *   wisps thicker, ticks quicker, and in its last moments a whistle. Then the server's boom.
 * - A green hazard tape, the size of the blast, marks where it will go off from the moment
 *   it's thrown, brighter and crawling faster as the fuse runs out: get out of the ring!
 */
export class GrenadesView {
  readonly root = new Container3D({ label: "grenades" });
  private bombs = new Map<number, Bomb>();
  private freeRings: { band: Band; mat: Material3D }[] = [];
  private ringCount = 0;
  private readonly tape = tapeTexture();

  constructor(private fx: Fx) {}

  /**
   * Draw `list` (everything else goes). `near(x, z)`: close enough to the camera to hear and
   * to bother with wisps.
   */
  update(dt: number, list: GrenadeDraw[], near: (x: number, z: number) => boolean) {
    for (const b of this.bombs.values()) b.seen = false;
    for (const g of list) this.draw(dt, g, near(g.x, g.z));
    for (const [id, b] of this.bombs) {
      if (b.seen) continue;
      b.node.destroy({ children: true });
      if (b.ring && b.ringMat) { b.ring.mesh.visible = false; this.freeRings.push({ band: b.ring, mat: b.ringMat }); }
      this.bombs.delete(id);
    }
  }

  private draw(dt: number, g: GrenadeDraw, near: boolean) {
    let b = this.bombs.get(g.id);
    if (!b) {
      const node = instance("wpn_grenade", { castShadow: true });
      node.scale.set(SCALE);
      this.root.addChild(node);
      const r = this.takeRing();
      b = {
        node, ring: r?.band ?? null, ringMat: r?.mat ?? null, ringUv: new Matrix(), seen: true, path: null, bounce: 0,
        squash: 0, spin: Math.random() * 6, px: g.x, py: g.y, pz: g.z, throb: 0, nextTick: g.t + 0.15, whistled: false, wisp: 0,
      };
      this.bombs.set(g.id, b);
    }
    b.seen = true;
    if (g.path !== b.path) {
      b.path = g.path;
      // its bounces from here on (the ones it's past already were before we saw it)
      b.bounce = 0;
      if (g.path) while (b.bounce * 2 < g.path.bounces.length && g.t0 + g.path.bounces[b.bounce * 2] * GRENADE_SUBSTEP < g.t - 0.05) b.bounce++;
    }
    const u = Math.max(0, Math.min(1, g.t / FUSE));
    const vx = (g.x - b.px) / Math.max(dt, 1e-3), vy = (g.y - b.py) / Math.max(dt, 1e-3), vz = (g.z - b.pz) / Math.max(dt, 1e-3);
    b.px = g.x; b.py = g.y; b.pz = g.z;
    const speed = Math.min(40, Math.hypot(vx, vy, vz));

    // bounces, on time
    const path = g.path;
    while (path && b.bounce * 2 < path.bounces.length && g.t0 + path.bounces[b.bounce * 2] * GRENADE_SUBSTEP <= g.t) {
      const i = path.bounces[b.bounce * 2], hit = path.bounces[b.bounce * 2 + 1];
      const k = Math.min(1, hit / 8);
      b.squash = Math.max(b.squash, 0.35 + 0.65 * k);
      if (near) {
        sfx.clink(path.xyz[i * 3], path.xyz[i * 3 + 2], k);
        this.fx.bouncePuff(path.xyz[i * 3], path.xyz[i * 3 + 1] - GRENADE_RADIUS, path.xyz[i * 3 + 2], k);
      }
      b.bounce++;
    }
    b.squash *= Math.exp(-dt / 0.07);

    // tumbling end over end in the air; on the ground it rolls onto its side
    const moving = speed > 0.6;
    if (moving) b.spin += speed * dt * 2.2;
    else {
      const side = Math.PI / 2 + Math.round((b.spin - Math.PI / 2) / Math.PI) * Math.PI;
      b.spin += (side - b.spin) * (1 - Math.exp(-dt / 0.08));
    }
    const heading = moving && Math.hypot(vx, vz) > 0.3 ? Math.atan2(vx, vz) : b.node.rotation.y;
    // the pressure: a throb that quickens, and a rattle near the end
    const late = Math.max(0, (u - 0.45) / 0.55);
    b.throb += dt * Math.PI * 2 * (2 + 14 * late * late);
    const bulge = late > 0 ? (0.05 + 0.2 * late) * Math.max(0, Math.sin(b.throb)) : 0;
    const rattle = late > 0.5 ? Math.sin(b.throb * 3.1) * 0.12 * late : 0;
    b.node.position.set(g.x, g.y + (late > 0.75 ? Math.abs(Math.sin(b.throb * 1.7)) * 0.04 : 0), g.z);
    b.node.rotation.set(b.spin, heading, rattle);
    const sq = b.squash;
    b.node.scale.set(SCALE * (1 + 0.25 * sq + bulge), SCALE * (1 - 0.4 * sq + bulge * 1.2), SCALE * (1 + 0.25 * sq + bulge));

    if (near) {
      // stink off the cork, thicker as the pressure builds
      b.wisp += dt * (moving ? 18 : 3 + 14 * u);
      while (b.wisp >= 1) {
        b.wisp -= 1;
        this.fx.stinkWisp(g.x, g.y + 0.12, g.z, u);
      }
      if (g.t >= b.nextTick) {
        sfx.fuseTick(g.x, g.z, u);
        b.nextTick = g.t + Math.max(0.08, 0.5 - 0.42 * u * u);
      }
      if (!b.whistled && g.t >= FUSE - 0.4) {
        b.whistled = true;
        sfx.whistle(g.x, g.z);
      }
    }

    // the danger ring, where it'll go off
    if (b.ring && b.ringMat) {
      let rx = g.x, ry = g.y, rz = g.z;
      if (path && path.n > 0) {
        const e = (path.n - 1) * 3;
        rx = path.xyz[e]; ry = path.xyz[e + 1]; rz = path.xyz[e + 2];
      }
      const pulse = 1 + 0.04 * late * Math.sin(b.throb);
      b.ring.mesh.visible = true;
      b.ring.set(rx, rz, BLAST_R * pulse - 0.16, ry - GRENADE_RADIUS + 0.06, 0.32);
      b.ringMat.alpha = 0.3 + 0.7 * Math.min(1, u * 1.4) ** 2;
      b.ringUv.tx -= dt * (0.3 + 2.4 * u);
      b.ringMat.uvTransform = b.ringUv;
    }
  }

  /** A danger ring off the pool (its own material: each fades and crawls at its own pace). */
  private takeRing(): { band: Band; mat: Material3D } | null {
    const free = this.freeRings.pop();
    if (free) return free;
    if (this.ringCount >= RINGS) return null;
    this.ringCount++;
    const mat = bandMaterial(0x9be35a, this.tape, 0.5, 0x7fcf3f, 0.5);
    const band = new Band(mat, false, 1.2, 96);
    this.root.addChild(band.mesh);
    return { band, mat };
  }

  /** Loading-screen warm-up: a danger ring drawn (invisibly faint) for a frame. */
  prewarm(): () => void {
    const r = this.takeRing();
    if (!r) return () => {};
    r.band.set(0, 0, 6, -500, 0.3);
    r.mat.alpha = 0.001;
    r.band.mesh.visible = true;
    return () => { r.band.mesh.visible = false; this.freeRings.push(r); };
  }
}
