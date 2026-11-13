import { Container3D, Material3D, type Mesh3D } from "@pixi/3d";
import { Matrix, Texture } from "pixi.js";
import { GRENADE_RADIUS, Weapon, WEAPONS } from "../../shared/constants.js";
import type { GrenadePath } from "../../shared/sim.js";
import { Band, bandMaterial, bandMesh, dashTexture, Strip } from "../gfx/Band.js";
import { chargeColor } from "../Hud.js";

/** The arc takes every 2nd point of the path (1/30 s apart), at most this many. */
const ARC_EVERY = 2, ARC_MAX = 60;
/** The blast's reach (m): the ring is this big. */
const BLAST_R = WEAPONS[Weapon.Grenade].range;
/** Bounce markers (the first few bounces). */
const DOTS = 4;

/**
 * Where your stink bomb would go if you let go now, while you wind it up: a dashed arc along
 * its exact path (`grenadePath`: the server's own integration, bounces and walls included),
 * dots where it bounces, and a dashed ring the size of the blast with a bullseye, where it
 * lies when it goes off. Tinted like the wind-up meter. All flat glowing bands: the tracers'
 * shader program, nothing new to compile.
 */
export class ThrowView {
  readonly root = new Container3D({ label: "throw-aim" });
  private arc: Strip;
  private ring: Band;
  private eye: Mesh3D;
  private dots: Mesh3D[] = [];
  private arcMat: Material3D;
  private ringMat: Material3D;
  private dotMat: Material3D;
  private readonly arcUv = new Matrix();
  private readonly ringUv = new Matrix();
  private readonly pts = new Float32Array(ARC_MAX * 3);
  private t = 0;
  /** Fades in and out (0..1). */
  private shown = 0;
  /** The last landing spot drawn, eased (it's stepped at 30 Hz). */
  private rx = 0;
  private ry = 0;
  private rz = 0;
  private placed = false;

  constructor() {
    this.arcMat = bandMaterial(0xffffff, dashTexture(), 0.9, 0xffffff, 0.6);
    this.ringMat = bandMaterial(0xffffff, dashTexture(), 0.85, 0xffffff, 0.6);
    this.dotMat = bandMaterial(0xffffff, Texture.WHITE, 0.8, 0xffffff, 0.6);
    this.arc = new Strip(this.arcMat, ARC_MAX);
    this.ring = new Band(this.ringMat, false, 0.9, 96);
    this.eye = bandMesh(this.dotMat, false, 0.18, 0.2, 1000, 24);
    for (let i = 0; i < DOTS; i++) this.dots.push(bandMesh(this.dotMat, false, 0.06, 0.12, 1000, 16));
    this.root.addChild(this.arc.mesh, this.ring.mesh, this.eye, ...this.dots);
    this.root.visible = false;
  }

  /**
   * Show the throw `path` (starting at the paw), wound up `k` 0..1 (`full`: all the way), or
   * null to fade it out.
   */
  update(dt: number, path: GrenadePath | null, k = 0, full = false) {
    this.t += dt;
    this.shown = Math.max(0, Math.min(1, this.shown + (path ? dt / 0.08 : -dt / 0.12)));
    this.root.visible = this.shown > 0.01;
    if (!this.root.visible) { this.placed = false; return; }
    if (path) this.draw(dt, path, k, full);
    const a = this.shown;
    this.arcMat.alpha = 0.9 * a;
    this.ringMat.alpha = 0.85 * a;
    this.dotMat.alpha = 0.8 * a;
  }

  private draw(dt: number, path: GrenadePath, k: number, full: boolean) {
    const color = chargeColor(k);
    for (const m of [this.arcMat, this.ringMat, this.dotMat]) {
      m.baseColor = color;
      if (m.emissive) m.emissive.color = color;
    }
    // the arc: from the paw to where it lies still (after that it just sits there)
    const last = Math.min(path.n - 1, path.still + ARC_EVERY);
    const n = Math.min(ARC_MAX, Math.floor(last / ARC_EVERY) + 1);
    for (let i = 0; i < n; i++) {
      const j = Math.min(last, i * ARC_EVERY) * 3;
      this.pts[i * 3] = path.xyz[j];
      this.pts[i * 3 + 1] = path.xyz[j + 1];
      this.pts[i * 3 + 2] = path.xyz[j + 2];
    }
    this.arc.set(this.pts, n, 0.13, 0.55);
    // the dashes march out toward the target
    this.arcUv.tx = -this.t * 2.2;
    this.arcMat.uvTransform = this.arcUv;

    // the ring where it goes off (on the ground under it), eased: the path moves in 30 Hz steps
    const e = (path.n - 1) * 3;
    const x = path.xyz[e], y = path.xyz[e + 1] - GRENADE_RADIUS + 0.07, z = path.xyz[e + 2];
    if (!this.placed) { this.rx = x; this.ry = y; this.rz = z; this.placed = true; }
    const f = 1 - Math.exp(-dt / 0.04);
    this.rx += (x - this.rx) * f; this.ry += (y - this.ry) * f; this.rz += (z - this.rz) * f;
    const beat = full ? 1 + 0.06 * Math.sin(this.t * 22) : 1;
    this.ring.set(this.rx, this.rz, BLAST_R * beat - 0.12, this.ry, 0.24);
    this.ringUv.tx = this.t * 0.35;
    this.ringMat.uvTransform = this.ringUv;
    this.eye.position.set(this.rx, this.ry + 0.01, this.rz);

    // a dot where it bounces (the first few)
    for (let i = 0; i < DOTS; i++) {
      const d = this.dots[i];
      const b = path.bounces[i * 2];
      d.visible = b !== undefined && b < last;
      if (d.visible) d.position.set(path.xyz[b * 3], path.xyz[b * 3 + 1] - GRENADE_RADIUS + 0.08, path.xyz[b * 3 + 2]);
    }
  }

  /** Loading-screen warm-up: drawn (invisibly faint) for a frame so its materials are ready. */
  prewarm(): () => void {
    this.root.visible = true;
    this.arcMat.alpha = this.ringMat.alpha = this.dotMat.alpha = 0.001;
    this.ring.set(0, 0, 6, -500, 0.2);
    this.eye.position.set(0, -500, 0);
    for (const d of this.dots) d.position.set(0, -500, 0);
    const pts = new Float32Array([0, -500, 0, 1, -500, 0, 2, -500, 0]);
    this.arc.set(pts, 3, 0.1, 1);
    return () => { this.root.visible = false; this.shown = 0; };
  }
}
