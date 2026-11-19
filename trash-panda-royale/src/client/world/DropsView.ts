import { Container3D, Geometry3D, Material3D, Mesh3D, SphereGeometry } from "@pixi/3d";
import { Texture } from "pixi.js";
import { DROP_SUBSTEP, stepDrop, type GrenadeLike } from "../../shared/sim.js";
import { canvasTexture } from "../gfx/Band.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

/**
 * A dropping on its way down (everyone falls their own, from the `poop` message, the same way). It's
 * drawn easing out of `from` (where its gull is drawn here) onto its path over its first moment.
 */
interface Drop extends GrenadeLike { owner: string; acc: number; mesh: Mesh3D; age: number; from: { x: number; y: number; z: number } | null }
/** A dropping is drawn easing from the gull onto its path over this long (s). */
const EASE_S = 0.2;
/** A splat on the street, fading out. */
interface Splat { mesh: Mesh3D; mat: Material3D; life: number }
/** A splat on someone's head, while it lasts. */
interface Stuck { mesh: Mesh3D; key: string; life: number }

const SPLATS = 40, SPLAT_LIFE = 25, STUCK_LIFE = 3.5;
/** How a splat looks on the street, and on a head. */
const SPLAT_SIZE = 0.95;

/** The goo: a white blob with drips and a grey heart (painted once). */
export const splatTexture = (): Texture => canvasTexture(128, 128, (ctx, w, h) => {
  const c = w / 2;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath();
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2, r = c * (0.55 + 0.18 * Math.sin(a * 3 + 1) + 0.12 * Math.sin(a * 7));
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.fill();
  for (const [x, y, r] of [[0.15, 0.3, 0.07], [0.85, 0.62, 0.06], [0.7, 0.12, 0.05], [0.25, 0.85, 0.06], [0.9, 0.25, 0.035]]) {
    ctx.beginPath(); ctx.arc(x * w, y * h, r * w, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "rgba(170,175,160,0.85)";
  ctx.beginPath(); ctx.arc(c * 1.05, c * 0.95, c * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(120,125,110,0.9)";
  ctx.beginPath(); ctx.arc(c * 1.12, c * 0.88, c * 0.09, 0, Math.PI * 2); ctx.fill();
});

let quad: Geometry3D | null = null;
/** A flat quad on the ground (facing up), 1 m across. */
function groundQuad() {
  return (quad ??= new Geometry3D({
    positions: new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  }));
}

/**
 * Droppings. A gull lets one go: its own client starts it falling at once (its step did), everyone
 * else when the `poop` message comes, and all of them fall it the same way (`stepDrop`), so it
 * lands in the same place on every screen: a splat on the street. Only a hit on a raccoon is the
 * server's word (`pooped`): the dropping is gone, and the raccoon has it on its head a while.
 */
export class DropsView {
  readonly root = new Container3D({ label: "drops" });
  private drops: Drop[] = [];
  private splats: Splat[] = [];
  private stuck: Stuck[] = [];
  private blobGeo = new SphereGeometry({ radius: 0.11, widthSegments: 10, heightSegments: 7 });
  /** (lit like the tracers: emissive, blended — their shader program) */
  private blobMat = new Material3D({ baseColor: 0xf6f6ee, emissive: { color: 0xd8dccf, strength: 0.6 }, alphaMode: "blend", alpha: 1 });
  private splatTex = splatTexture();
  private next = 0;

  constructor(private fx: Fx) {}

  /** A dropping let go of at `d` by gull `owner`, drawn leaving `from` (its gull as drawn), if given. */
  add(d: GrenadeLike, owner: string, from: { x: number; y: number; z: number } | null = null) {
    const mesh = new Mesh3D({ geometry: this.blobGeo, material: this.blobMat, castShadow: false, receiveShadow: false });
    mesh.scale.set(1, 1.3, 1);
    this.root.addChild(mesh);
    this.drops.push({ ...d, owner, acc: 0, mesh, age: 0, from });
  }

  /** The server says gull `owner`'s dropping got someone at (x, y, z): the one of theirs nearest there is gone. */
  hit(owner: string, x: number, y: number, z: number) {
    let best = -1, bestD = 25;
    this.drops.forEach((d, i) => {
      if (d.owner !== owner) return;
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2 + (d.z - z) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (best >= 0) { this.drops[best].mesh.destroy(); this.drops.splice(best, 1); }
  }

  /** Raccoon `key` has it on its head for a while (`at` says where its head is, each frame). */
  stick(key: string) {
    for (const s of this.stuck) if (s.key === key) { s.life = STUCK_LIFE; return; }
    const mat = this.splatMat();
    const mesh = new Mesh3D({ geometry: groundQuad(), material: mat, castShadow: false, receiveShadow: false });
    mesh.scale.set(0.55, 1, 0.55);
    this.root.addChild(mesh);
    this.stuck.push({ mesh, key, life: STUCK_LIFE });
  }

  private splatMat() {
    return new Material3D({ baseColor: 0xffffff, baseColorTexture: this.splatTex, roughness: 0.4, metallic: 0, doubleSided: true, alphaMode: "blend", alpha: 1 });
  }

  /** A splat on the street (or a roof) at (x, y, z). */
  private splatAt(x: number, y: number, z: number) {
    let s = this.splats[this.next % SPLATS];
    if (!s) {
      const mat = this.splatMat();
      s = { mesh: new Mesh3D({ geometry: groundQuad(), material: mat, castShadow: false, receiveShadow: false }), mat, life: 0 };
      this.root.addChild(s.mesh);
      this.splats[this.next % SPLATS] = s;
    }
    this.next++;
    s.life = SPLAT_LIFE;
    s.mat.alpha = 1;
    s.mesh.visible = true;
    // (over the street's markings, and a little higher each time: no two fight for a pixel)
    s.mesh.position.set(x, y + 0.06 + (this.next % 7) * 0.002, z);
    s.mesh.rotation.set(0, Math.random() * 6.28, 0);
    s.mesh.scale.set(SPLAT_SIZE * (0.85 + Math.random() * 0.3), 1, SPLAT_SIZE * (0.85 + Math.random() * 0.3));
    this.fx.goo(x, y + 0.05, z);
    sfx.splat(x, z);
  }

  /** Once a frame. `head(key)`: where raccoon `key`'s head is drawn (null: not on screen). */
  update(dt: number, head: (key: string) => { x: number; y: number; z: number } | null) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.acc += Math.min(dt, 0.1);
      let landed = false;
      while (d.acc >= DROP_SUBSTEP && !landed) {
        d.acc -= DROP_SUBSTEP;
        landed = stepDrop(d, DROP_SUBSTEP) === 1;
      }
      const f = d.from;
      if (f && d.age < EASE_S) {
        const k = d.age / EASE_S, s = k * k * (3 - 2 * k);
        d.mesh.position.set(f.x + (d.x - f.x) * s, f.y + (d.y - f.y) * s, f.z + (d.z - f.z) * s);
      } else d.mesh.position.set(d.x, d.y, d.z);
      if (landed || d.age > 6) {
        if (landed) this.splatAt(d.x, d.y, d.z);
        d.mesh.destroy();
        this.drops.splice(i, 1);
      }
    }
    for (const s of this.splats) {
      if (!s || s.life <= 0) continue;
      s.life -= dt;
      s.mat.alpha = Math.min(1, s.life / 4);
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (let i = this.stuck.length - 1; i >= 0; i--) {
      const s = this.stuck[i];
      s.life -= dt;
      const at = head(s.key);
      if (s.life <= 0) {
        // (its own material, made for its fade: it goes with it)
        const mat = s.mesh.material as Material3D;
        s.mesh.destroy();
        mat.destroy?.();
        this.stuck.splice(i, 1);
        continue;
      }
      s.mesh.visible = !!at;
      if (at) s.mesh.position.set(at.x, at.y, at.z);
      (s.mesh.material as Material3D).alpha = Math.min(1, s.life / 0.6);
    }
  }

  /** Loading-screen warm-up: a dropping and a splat, far below the town, for one frame. */
  prewarm(): () => void {
    this.add({ x: 5000, y: -500, z: 5000, vx: 0, vy: 0, vz: 0 }, "");
    this.splatAt(5000, -500, 5000);
    return () => {
      for (const d of this.drops) d.mesh.destroy();
      this.drops.length = 0;
      for (const s of this.splats) if (s) { s.life = 0; s.mesh.visible = false; }
    };
  }
}
