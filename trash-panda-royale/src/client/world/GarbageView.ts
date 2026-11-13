import { Container3D, CubeGeometry, Material3D, Mesh3D, Vector3 } from "@pixi/3d";
import { DUMPSTER_H, DUMPSTER_HD, DUMPSTER_HW, GARBAGE_BEEP_S, GARBAGE_LOWER_MS, GarbagePhase, GRAVITY } from "../../shared/constants.js";
import { find, hasModel, instance } from "../assets.js";
import { bandMaterial, bandMesh, canvasTexture } from "../gfx/Band.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

/** Where the dumpster rides on the truck, as the truck is drawn (its lift's socket), or null: not on screen. */
export type Socket = { x: number; y: number; z: number; yaw: number } | null;

/** The golden dumpster's beacon: a column of light this tall over it, while it's padlocked, seen across town. */
const BEACON_H = 34;

/**
 * The golden dumpster (Garbage Day, see `GarbageDay`): drawn from `state.garbage` alone. On the
 * truck's lift while it comes (`socket`), coming down by the kerb once it's stopped and beeped,
 * padlocked with a beam of gold over it, then the lid flies open and the padlock pops off. The loot
 * that fountains out is loose loot, drawn with the other pickups.
 */
export class GarbageView {
  readonly root = new Container3D({ label: "garbage" });
  private box: Container3D;
  private lid: Container3D | null;
  private lock: Container3D | null;
  /** A wall of gold 1 m round, scaled to the beam's radius. */
  private beam: Mesh3D;
  private beamGlow: Mesh3D;
  private phase: number = GarbagePhase.None;
  /** Where the lowering started (the socket as drawn when it did). */
  private from: { x: number; y: number; z: number; yaw: number } | null = null;
  private landed = false;
  private lidOpen = 0;
  /** The padlock popped off: flying (relative to the dumpster), then gone. */
  private lockFly: { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number } | null = null;
  private beepAt = 0;
  private time = 0;
  private lastCount = -1;
  private tmp = new Vector3();

  constructor(private fx: Fx) {
    this.box = hasModel("dumpster_gold") ? instance("dumpster_gold") : fallbackDumpster();
    this.lid = find(this.box, "lid");
    this.lock = find(this.box, "lock");
    this.box.visible = false;
    this.root.addChild(this.box);
    const glow = canvasTexture(4, 64, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.75, "rgba(255,255,255,0.8)"); g.addColorStop(1, "rgba(255,255,255,1)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    this.beam = bandMesh(bandMaterial(0xffe27a, glow, 0.55, 0xffc93c, 3), true, 1, BEACON_H, 4, 24);
    this.beamGlow = bandMesh(bandMaterial(0xffffff, glow, 0.25, 0xfff1b0, 2), true, 1, BEACON_H * 0.8, 4, 24);
    this.beam.visible = this.beamGlow.visible = false;
    this.root.addChild(this.beam, this.beamGlow);
  }

  /** Where it is now (x, z, its top), while it's anywhere at all. */
  get spot(): { x: number; y: number; z: number } | null {
    return this.box.visible ? { x: this.box.position.x, y: this.box.position.y + DUMPSTER_H, z: this.box.position.z } : null;
  }

  /**
   * Once a frame. `g`: the synced Garbage Day; `now`: the server clock it's on; `socket`: where it
   * rides on the truck as drawn. Returns how far down the truck's lift should be drawn (0..1).
   */
  update(dt: number, g: { phase: number; x: number; z: number; yaw: number; at: number }, now: number, socket: Socket): number {
    this.time += dt;
    const phase = g.phase;
    if (phase !== this.phase) this.enter(phase, g, socket);
    let lift = 0;
    const box = this.box;
    box.visible = phase !== GarbagePhase.None && (phase !== GarbagePhase.Coming || !!socket);
    switch (phase) {
      case GarbagePhase.Coming:
        if (socket) { box.position.set(socket.x, socket.y, socket.z); box.rotation.set(0, socket.yaw, 0); }
        break;
      case GarbagePhase.Lowering: {
        const beeping = now - g.at < GARBAGE_BEEP_S * 1000;
        // reversing beeps while it lines up
        if (beeping && now > this.beepAt) { this.beepAt = now + 520; sfx.truckBeep(g.x, g.z); }
        const k = beeping ? 0 : Math.min(1, (now - g.at - GARBAGE_BEEP_S * 1000) / GARBAGE_LOWER_MS);
        lift = beeping ? 0 : Math.min(1, k * 1.6);
        // from the lift (as it was drawn when it started down), out and down onto the street
        const f = this.from ?? (socket ? { ...socket } : { x: g.x, y: 1.2, z: g.z, yaw: g.yaw });
        if (!this.from && !beeping) this.from = f;
        const s = k * k * (3 - 2 * k);
        const y = f.y * (1 - s) + Math.sin(s * Math.PI) * 0.35;
        box.position.set(f.x + (g.x - f.x) * s, Math.max(0, y), f.z + (g.z - f.z) * s);
        box.rotation.set(0, f.yaw + wrap(g.yaw - f.yaw) * s, 0);
        if (k >= 1 && !this.landed) this.land(g);
        break;
      }
      case GarbagePhase.Locked: {
        if (!this.landed) this.land(g);
        box.position.set(g.x, 0, g.z);
        box.rotation.set(0, g.yaw, 0);
        // the padlock jiggles, more as it nears the end; the last three seconds tick
        const left = (g.at - now) / 1000;
        if (this.lock) this.lock.rotation.set(0, 0, Math.sin(this.time * (8 + 20 / Math.max(0.5, left))) * 0.12 * (left < 3 ? 2 : 1));
        const count = Math.ceil(left);
        if (count !== this.lastCount && count >= 1 && count <= 3) sfx.countdown(count);
        this.lastCount = count;
        if (Math.random() < dt * 6) this.fx.sparkle(g.x + (Math.random() - 0.5) * 2, 0.6 + Math.random(), g.z + (Math.random() - 0.5) * 2, 0xffd23f);
        break;
      }
      case GarbagePhase.Open:
        box.position.set(g.x, 0, g.z);
        box.rotation.set(0, g.yaw, 0);
        this.lidOpen = Math.min(1, this.lidOpen + dt * 5);
        if (Math.random() < dt * 1.5) this.fx.sparkle(g.x, 0.9, g.z, 0xffe066);
        break;
    }
    if (this.lid) {
      // flung open with an overshoot, settling back a little
      const k = this.lidOpen, over = Math.sin(Math.min(1, k) * Math.PI) * 0.35;
      this.lid.rotation.set(-(1.9 * k + over), 0, 0);
    }
    if (this.lockFly && this.lock) {
      const l = this.lockFly;
      l.t += dt;
      l.vy -= GRAVITY * dt;
      l.x += l.vx * dt; l.y += l.vy * dt; l.z += l.vz * dt;
      this.lock.position.set(l.x, l.y, l.z);
      this.lock.rotation.set(l.t * 14, l.t * 6, 0);
      if (l.t > 1.4) { this.lock.visible = false; this.lockFly = null; }
    }
    // the beam of gold over it while it's down and padlocked (and fading once it's open)
    const beam = phase === GarbagePhase.Locked ? 1 : phase === GarbagePhase.Open ? Math.max(0, 1 - (now - g.at) / 2500) : phase === GarbagePhase.Lowering ? 0.4 : 0;
    this.beam.visible = this.beamGlow.visible = beam > 0.01;
    if (beam > 0.01) {
      const p = this.box.position, w = 0.9 + 0.08 * Math.sin(this.time * 4);
      this.beam.position.set(p.x, 0.2, p.z);
      this.beam.scale.set(w * beam, 1, w * beam);
      this.beamGlow.position.set(p.x, 0.2, p.z);
      this.beamGlow.scale.set((w + 0.6) * beam, 1, (w + 0.6) * beam);
    }
    return lift;
  }

  private enter(phase: number, g: { x: number; z: number; yaw: number }, socket: Socket) {
    const was = this.phase;
    this.phase = phase;
    if (phase === GarbagePhase.None || phase === GarbagePhase.Coming) {
      // a new day: everything back on
      this.from = null; this.landed = false; this.lidOpen = 0; this.lockFly = null;
      if (this.lock) { this.lock.visible = true; this.lock.position.set(0, 0, 0); this.lock.rotation.set(0, 0, 0); }
      if (this.lid) this.lid.rotation.set(0, 0, 0);
      return;
    }
    if (phase === GarbagePhase.Lowering) { this.from = socket ? { ...socket } : null; this.landed = false; return; }
    if (phase === GarbagePhase.Open) {
      if (!this.landed) this.land(g);
      this.burst(g, was === GarbagePhase.Locked);
    }
  }

  /** Down on the street: a thud and a puff of dust (a big one: it's heavy). */
  private land(g: { x: number; z: number }) {
    this.landed = true;
    this.fx.dustPuff(g.x, 0, g.z, 22);
    this.fx.pancake(g.x, 0.3, g.z);
    sfx.dumpsterThud(g.x, g.z);
  }

  /** Padlock off, lid up, and the loot fountains out (`seen`: we watched it happen, not arrived after). */
  private burst(g: { x: number; z: number; yaw: number }, seen: boolean) {
    if (this.lock) {
      if (seen) this.lockFly = { x: 0, y: 0, z: 0, vx: (Math.random() - 0.5) * 2, vy: 6, vz: 3, t: 0 };
      else this.lock.visible = false;
    }
    if (!seen) { this.lidOpen = 1; return; }
    const top = DUMPSTER_H + 0.2;
    this.fx.confettiCannon(g.x, top - 0.5, g.z);
    this.fx.goldBurst(g.x, top, g.z);
    sfx.jackpot(g.x, g.z);
    this.tmp.set(g.x, top, g.z);
  }

  /** Loading-screen warm-up: shown, beam and all, for one frame. */
  prewarm(): () => void {
    this.box.visible = true;
    this.box.position.set(0, -50, 0);
    this.beam.position.set(0, -50, 0);
    this.beamGlow.position.set(0, -50, 0);
    this.beam.visible = this.beamGlow.visible = true;
    return () => { this.box.visible = false; this.beam.visible = this.beamGlow.visible = false; };
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** If its model didn't load: a gold box with a lid and a lock. */
function fallbackDumpster(): Container3D {
  const root = new Container3D({ label: "dumpster-fallback" });
  const gold = new Material3D({ baseColor: 0xffc93c, roughness: 0.4, metallic: 0 });
  const dark = new Material3D({ baseColor: 0x8a5a1c, roughness: 0.6, metallic: 0 });
  const cube = new CubeGeometry({ width: 1, height: 1, depth: 1 });
  const body = new Mesh3D({ geometry: cube, material: gold });
  body.scale.set(DUMPSTER_HW * 2, DUMPSTER_H - 0.1, DUMPSTER_HD * 2);
  body.position.set(0, (DUMPSTER_H - 0.1) / 2, 0);
  const lid = new Container3D({ label: "lid" });
  lid.position.set(0, DUMPSTER_H - 0.1, -DUMPSTER_HD);
  const lm = new Mesh3D({ geometry: cube, material: gold });
  lm.scale.set(DUMPSTER_HW * 2 + 0.06, 0.1, DUMPSTER_HD * 2 + 0.06);
  lm.position.set(0, 0.05, DUMPSTER_HD);
  lid.addChild(lm);
  const lock = new Container3D({ label: "lock" });
  lock.position.set(0, DUMPSTER_H - 0.35, DUMPSTER_HD + 0.04);
  const km = new Mesh3D({ geometry: cube, material: dark });
  km.scale.set(0.22, 0.26, 0.08);
  lock.addChild(km);
  root.addChild(body, lid, lock);
  return root;
}
