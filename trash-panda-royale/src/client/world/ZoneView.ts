import { Container3D, Material3D } from "@pixi/3d";
import { Matrix, Texture } from "pixi.js";
import type { ZoneState } from "../../shared/zone.js";
import { Band, bandMaterial, canvasTexture, dashTexture, tapeTexture } from "../gfx/Band.js";

/** Height of the wall of fumes. */
const WALL_H = 7;

/** Purple fumes: thick at the bottom, fading up, in soft vertical streaks (repeats along u). */
const fumesTexture = () => canvasTexture(256, 128, (ctx, w, h) => {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const up = y / (h - 1); // 0 at the top row of the canvas = top of the wall
    for (let x = 0; x < w; x++) {
      const a = x / w * Math.PI * 2;
      const streak = 0.75 + 0.25 * Math.sin(a * 3 + Math.sin(a * 7) * 0.8) * Math.sin(a * 5 + up * 2);
      const alpha = Math.pow(up, 1.6) * streak; // up = 1 at the ground
      const i = (y * w + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
});

/**
 * The fumes on screen: a wall of purple gas on the circle, a purple tint over everything
 * outside it, crisp hazard tape on the edge (what you actually read from the high camera),
 * and white dashes where it's closing to. All four reuse the tracers' shader program
 * (emissive, blended, no shadows): no compile, and blending writes no depth, so the
 * tilt-shift focus isn't fooled.
 */
export class ZoneView {
  readonly root = new Container3D({ label: "zone" });
  private wall: Band;
  private tint: Band;
  private tape: Band;
  private next: Band;
  private wallMat: Material3D;
  private tapeMat: Material3D;
  private scroll = 0;
  private readonly wallUv = new Matrix();
  private readonly tapeUv = new Matrix();

  constructor() {
    const mat = bandMaterial;
    this.wallMat = mat(0xb38bff, fumesTexture(), 0.8, 0x8a5cff, 0.6);
    this.tapeMat = mat(0xffffff, tapeTexture(), 1, 0xffd23f, 0.6);
    this.wall = new Band(this.wallMat, true, 8);
    this.tint = new Band(mat(0x6b5a8e, Texture.WHITE, 0.35, 0x000000, 1), false, 1000);
    this.tape = new Band(this.tapeMat, false, 1.2);
    this.next = new Band(mat(0xffffff, dashTexture(), 0.55, 0xffffff, 0.4), false, 3);
    this.root.addChild(this.tint.mesh, this.tape.mesh, this.next.mesh, this.wall.mesh);
    this.root.visible = false;
  }

  /** Draw the fumes as `z` describes them (null: no round, nothing to show). */
  update(dt: number, z: ZoneState | null) {
    this.root.visible = !!z && z.r < 200;
    if (!z || !this.root.visible) return;
    const r = Math.max(0.01, z.r);
    this.wall.set(z.x, z.z, r, 0, WALL_H);
    this.tint.set(z.x, z.z, r, 0.07, 450);
    this.tape.set(z.x, z.z, r, 0.075, 0.6);
    this.next.mesh.visible = !z.final && z.nr < z.r - 0.5;
    if (this.next.mesh.visible) this.next.set(z.nx, z.nz, Math.max(0.01, z.nr - 0.15), 0.08, 0.3);
    // the gas drifts and the tape crawls (data writes only)
    this.scroll += dt;
    this.wallUv.tx = this.scroll * 0.05;
    this.tapeUv.tx = -this.scroll * 0.4;
    this.wallMat.uvTransform = this.wallUv;
    this.tapeMat.uvTransform = this.tapeUv;
  }

  /** Loading-screen warm-up: shown (invisibly faint) for a frame so its materials are ready. */
  prewarm(): () => void {
    const z = { x: 0, z: 0, r: 30, nx: 0, nz: 0, nr: 10, stage: 1, closing: false, left: 1, dps: 1, final: false };
    this.update(0, z);
    return () => { this.root.visible = false; };
  }
}
