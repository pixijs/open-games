import { Container3D, CubeGeometry, Material3D, Mesh3D, PointLight, Vector3 } from "@pixi/3d";
import { ConeShape, ParticleSystem3D, SphereShape } from "@pixi/3d/extras";
import { Texture, type Ticker } from "pixi.js";

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  return Texture.from(c);
}

const soft = () => canvasTexture(64, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

const puff = () => canvasTexture(64, (ctx, s) => {
  // a fluffy cartoon cloud blob
  ctx.fillStyle = "white";
  for (const [x, y, r] of [[0.5, 0.55, 0.3], [0.32, 0.5, 0.2], [0.68, 0.48, 0.22], [0.5, 0.35, 0.2]]) {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
});

const ring = () => canvasTexture(128, (ctx, s) => {
  ctx.strokeStyle = "white";
  ctx.lineWidth = s * 0.07;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
  ctx.stroke();
});

const square = () => canvasTexture(16, (ctx, s) => { ctx.fillStyle = "white"; ctx.fillRect(0, 0, s, s); });
/** A bottle cap, crimped round the edge (white: tinted per piece of junk). */
const cap = () => canvasTexture(32, (ctx, s) => {
  const c = s / 2;
  ctx.beginPath();
  for (let i = 0; i < 42; i++) {
    const a = (i / 42) * Math.PI * 2, r = i % 2 ? c * 0.86 : c * 0.98;
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.fillStyle = "#f2f2f2";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c, c, c * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = "#c4c4c4";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c * 0.8, c * 0.78, c * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.fill();
});
/** A gull's feather: a soft white quill (tinted per feather). */
const feather = () => canvasTexture(32, (ctx, s) => {
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-0.6);
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.16, s * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(170,175,185,0.9)";
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.44); ctx.lineTo(0, s * 0.48);
  ctx.stroke();
});
/** A drop of water: a round bead, brightest up one side (white: tinted per drop). */
const drop = () => canvasTexture(32, (ctx, s) => {
  const g = ctx.createRadialGradient(s * 0.4, s * 0.36, s * 0.04, s / 2, s / 2, s * 0.48);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(225,240,255,0.95)");
  g.addColorStop(1, "rgba(200,225,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.48, 0, Math.PI * 2);
  ctx.fill();
});
/** What the Blunderbuss is loaded with: caps, bits of glass, peel, a fish bone. */
const JUNK = [0xe2483a, 0xd0d6e0, 0x5fbf5a, 0xf2c94c, 0x9b6a45, 0x3ec1ff];

/** `k`: how bright it is at its brightest (the tail of a shot that hit nothing is dimmer). */
interface Tracer { mesh: Mesh3D; mat: Material3D; life: number; max: number; k: number }
interface Flash { light: PointLight; life: number; max: number; peak: number }

const CONFETTI = [0xff5d8f, 0xffd23f, 0x3ec1ff, 0x7cff6b, 0xb084ff, 0xff9f43];

/** Tracer look per weapon (by index): the cork, the caps, the junk. */
const TRACERS: Record<number, { color: number; glow: number; w: number; life: number }> = {
  1: { color: 0xffe2b0, glow: 0xffb35c, w: 0.07, life: 0.1 },
  2: { color: 0xeaf3ff, glow: 0xb8d8ff, w: 0.035, life: 0.07 },
  3: { color: 0xffe27a, glow: 0xffd04a, w: 0.05, life: 0.09 },
};

export class Fx {
  readonly root = new Container3D({ label: "fx" });
  private fire: ParticleSystem3D;
  private smoke: ParticleSystem3D;
  private sparks: ParticleSystem3D;
  private confetti: ParticleSystem3D;
  private rings: ParticleSystem3D;
  private dust: ParticleSystem3D;
  /** Little stink wisps off a stink bomb's cork (smoke-like, but they stay small). */
  private wisps: ParticleSystem3D;
  /** The Blunderbuss's load, flying out along its pellets. */
  private junkBits: ParticleSystem3D;
  /** A shooed gull's feathers, drifting down. */
  private feathers: ParticleSystem3D;
  /** A knocked-off hydrant's water. */
  private drops: ParticleSystem3D;
  private tracers: Tracer[] = [];
  private flashes: Flash[] = [];
  private tracerGeo = new CubeGeometry({ width: 1, height: 1, depth: 1 });
  private v = new Vector3();

  constructor() {
    const softTex = soft();
    this.fire = new ParticleSystem3D({
      texture: softTex, blendMode: "add", capacity: 2500, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.3 }), life: [0.25, 0.7], speed: [2, 8],
      size: [0.8, 1.8], sizeEnd: [0.2, 0.6], alpha: 0.95, alphaEnd: 0,
      color: 0xffe08a, colorEnd: 0xff3b1f, drag: 2.5, gravity: -3,
    });
    this.smoke = new ParticleSystem3D({
      texture: puff(), capacity: 2500, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.4 }), life: [1.2, 2.6], speed: [0.5, 2.5],
      size: [0.6, 1.2], sizeEnd: [2.2, 3.6], alpha: 0.75, alphaEnd: 0,
      color: 0x8a8f99, colorEnd: 0xd8dbe2, drag: 1.2, gravity: -1.6, spin: [-1, 1],
    });
    this.sparks = new ParticleSystem3D({
      texture: softTex, blendMode: "add", capacity: 1500, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.05 }), life: [0.2, 0.5], speed: [4, 12],
      size: [0.12, 0.22], sizeEnd: 0.02, alpha: 1, alphaEnd: 0.2,
      color: 0xfff1a8, colorEnd: 0xff8a2b, gravity: 22, drag: 1,
    });
    this.confetti = new ParticleSystem3D({
      texture: square(), capacity: 1500, emitRate: 0, autoUpdate: false,
      shape: new ConeShape({ angle: 55, radius: 0.2 }), life: [0.9, 1.6], speed: [4, 8],
      size: [0.12, 0.2], alpha: 1, alphaEnd: 0, gravity: 14, drag: 1.5, spin: [-12, 12],
      startRotation: [0, 6.28],
    });
    this.rings = new ParticleSystem3D({
      texture: ring(), blendMode: "add", billboard: "horizontal", capacity: 64, emitRate: 0, autoUpdate: false,
      life: 0.45, speed: 0, size: 1, sizeEnd: 14, alpha: 0.9, alphaEnd: 0, color: 0xfff0c0,
    });
    this.dust = new ParticleSystem3D({
      texture: puff(), capacity: 1200, emitRate: 0, autoUpdate: false,
      shape: new ConeShape({ angle: 80, radius: 0.3 }), life: [0.4, 0.8], speed: [1, 3],
      size: [0.3, 0.5], sizeEnd: [0.9, 1.3], alpha: 0.6, alphaEnd: 0, color: 0xf3ead8, drag: 3,
    });
    // the same features as the smoke (so the same shader program), at a fraction of the size
    this.wisps = new ParticleSystem3D({
      texture: puff(), capacity: 600, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.04 }), life: [0.5, 0.9], speed: [0.2, 0.6],
      size: [0.1, 0.16], sizeEnd: [0.32, 0.5], alpha: 0.7, alphaEnd: 0,
      color: 0x8fdc4c, colorEnd: 0xd6f5b0, drag: 1.5, gravity: -1.2, spin: [-1, 1],
    });
    // (the confetti's features, so its shader program, with a cap for a texture)
    this.junkBits = new ParticleSystem3D({
      texture: cap(), capacity: 600, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.05 }), life: 0.3, speed: 0,
      size: [0.13, 0.2], alpha: 1, alphaEnd: 1, gravity: 6, spin: [-18, 18], startRotation: [0, 6.28],
    });
    // (the confetti's features again: a feather for a texture, falling slow)
    this.feathers = new ParticleSystem3D({
      texture: feather(), capacity: 400, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.25 }), life: [1.4, 2.4], speed: [1.5, 4],
      size: [0.16, 0.26], alpha: 1, alphaEnd: 0, gravity: 1.6, drag: 2.6, spin: [-4, 4], startRotation: [0, 6.28],
    });
    // (the confetti's features again: a bead of water, shot up and falling back)
    this.drops = new ParticleSystem3D({
      texture: drop(), capacity: 800, emitRate: 0, autoUpdate: false,
      shape: new SphereShape({ radius: 0.06 }), life: [0.9, 1.3], speed: 0,
      size: [0.07, 0.14], alpha: 0.9, alphaEnd: 0.5, gravity: 14, drag: 0.6, spin: [-2, 2], startRotation: [0, 6.28],
    });
    this.root.addChild(this.smoke, this.dust, this.wisps, this.confetti, this.junkBits, this.feathers, this.drops, this.fire, this.sparks, this.rings);

    // (two per pellet that hits nothing: see `tracer`)
    for (let i = 0; i < 64; i++) {
      const mat = new Material3D({ baseColor: 0xffe27a, emissive: { color: 0xffd04a, strength: 4 }, alphaMode: "blend", alpha: 1 });
      const mesh = new Mesh3D({ geometry: this.tracerGeo, material: mat, castShadow: false, receiveShadow: false });
      mesh.visible = false;
      this.root.addChild(mesh);
      this.tracers.push({ mesh, mat, life: 0, max: 1, k: 1 });
    }
    for (let i = 0; i < 6; i++) {
      const light = new PointLight({ color: 0xffb35c, intensity: 0, range: 12 });
      // a dark light still gets binned into screen tiles and evaluated per pixel: hide it
      light.visible = false;
      this.root.addChild(light);
      this.flashes.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  private at(x: number, y: number, z: number) { return this.v.set(x, y, z); }

  flash(x: number, y: number, z: number, intensity: number, range: number, dur: number, color = 0xffb35c) {
    const f = this.flashes.reduce((a, b) => (a.life < b.life ? a : b));
    f.light.visible = true;
    f.light.position.set(x, y, z);
    f.light.range = range;
    f.light.color.setValue(color);
    f.life = f.max = dur;
    f.peak = intensity;
  }

  /** Muzzle blast by weapon: a cork puff, a cap-blaster glint, a blunderbuss belch of junk. */
  muzzle(x: number, y: number, z: number, dx: number, dz: number, weapon = 1) {
    const pos = { x: x + dx * 0.3, y, z: z + dz * 0.3 };
    const big = weapon === 3;
    const out = (lo: number, hi: number, side = 2) => (r: () => number) =>
      ({ x: dx * (lo + r() * (hi - lo)) + (r() - 0.5) * side, y: (r() - 0.5) * side, z: dz * (lo + r() * (hi - lo)) + (r() - 0.5) * side });
    if (weapon === 2) {
      this.sparks.spawn(4, { position: pos, velocity: out(5, 10), color: 0xe8f1ff, size: [0.08, 0.14] });
      this.flash(pos.x, y + 0.2, pos.z, 4, 6, 0.05, 0xcfe3ff);
      return;
    }
    this.fire.spawn(big ? 10 : 4, { position: pos, velocity: out(4, 10), life: [0.04, 0.09], size: big ? [0.5, 0.8] : [0.25, 0.4] });
    // a little cloud of cork dust / the junk flying out
    this.dust.spawn(big ? 6 : 3, { position: pos, velocity: out(1, 3, 1), color: 0xffffff, size: [0.25, 0.4] });
    if (big) this.confetti.spawn(12, { position: pos, velocity: out(6, 11, 3), color: CONFETTI[(Math.random() * CONFETTI.length) | 0] });
    this.flash(pos.x, y + 0.2, pos.z, big ? 10 : 5, 7, 0.06, 0xffd27a);
  }

  /**
   * A shot's streak from (x0, y0, z0) to (x1, y1, z1). `fade`: it hit nothing and just ran out
   * of range, so it thins and dims over its last stretch instead of stopping dead in mid-air.
   */
  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, weapon = 1, fade = false) {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (len < 0.2) return;
    const look = TRACERS[weapon] ?? TRACERS[1];
    if (!fade) { this.beam(x0, y0, z0, x1, y1, z1, look, 1, 1); return; }
    const m = 0.65, xm = x0 + (x1 - x0) * m, ym = y0 + (y1 - y0) * m, zm = z0 + (z1 - z0) * m;
    this.beam(x0, y0, z0, xm, ym, zm, look, 1, 1);
    this.beam(xm, ym, zm, x1, y1, z1, look, 0.35, 0.6);
  }

  /** One streak segment, `k` as bright and `w` as thick as `look`'s. */
  private beam(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, look: (typeof TRACERS)[number], k: number, w: number) {
    const t = this.tracers.reduce((a, b) => (a.life < b.life ? a : b));
    t.mat.baseColor = look.color;
    t.mat.emissive!.color = look.glow;
    t.mat.alpha = k;
    t.mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    t.mesh.scale.set(look.w * w, look.w * w, Math.hypot(x1 - x0, y1 - y0, z1 - z0));
    t.mesh.lookAt(this.at(x1, y1, z1));
    t.mesh.visible = true;
    t.life = t.max = look.life;
    t.k = k;
  }

  /**
   * The Blunderbuss's load flying out of the barrel at (x0, y0, z0), along one pellet to where it
   * ended at (x1, y1, z1): a couple of bottle caps and bits, gone when they get there.
   */
  junk(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return;
    for (let i = 0; i < 2; i++) {
      const speed = 26 + Math.random() * 10, life = Math.min(0.7, len / speed);
      this.junkBits.spawn(1, {
        position: this.at(x0, y0, z0), color: JUNK[(Math.random() * JUNK.length) | 0], life: [life * 0.9, life],
        velocity: (r) => ({ x: (dx / len) * speed + (r() - 0.5) * 1.5, y: (dy / len) * speed + (r() - 0.5) * 1.5 + 1.5, z: (dz / len) * speed + (r() - 0.5) * 1.5 }),
      });
    }
  }

  /** Where a shot lands: the cork bounces off, caps glint, junk scatters. */
  impact(x: number, y: number, z: number, n = 8, weapon = 0) {
    const at = this.at(x, y, z);
    if (weapon === 1) this.confetti.spawn(3, { position: at, color: 0xc8894f, size: [0.14, 0.2] });
    else if (weapon === 2) this.sparks.spawn(n, { position: at, color: 0xe8f1ff });
    else if (weapon === 3) this.confetti.spawn(n, { position: at, color: CONFETTI[(Math.random() * CONFETTI.length) | 0] });
    else this.sparks.spawn(n, { position: at });
  }

  hitPuff(x: number, y: number, z: number) {
    this.confetti.spawn(14, { position: this.at(x, y, z), color: CONFETTI[(Math.random() * CONFETTI.length) | 0] });
    this.sparks.spawn(6, { position: this.at(x, y, z), color: 0xffffff });
  }

  /** A stink bomb: no fire, a big green cloud that hangs around, and a sickly flash. */
  stink(x: number, y: number, z: number, r: number) {
    const s = r / 6.5;
    this.smoke.spawn(36, {
      position: this.at(x, y + 0.6, z), color: 0x9be35a, size: [1.6 * s, 2.8 * s],
      velocity: (rnd) => ({ x: (rnd() - 0.5) * 9, y: 1 + rnd() * 3, z: (rnd() - 0.5) * 9 }),
    });
    // the haze that lingers, low over the ground
    this.smoke.spawn(18, {
      position: (rnd) => ({ x: x + (rnd() - 0.5) * r * 1.4, y: y + 0.1 + rnd() * 0.8, z: z + (rnd() - 0.5) * r * 1.4 }),
      color: 0x7fcf3f, size: [2 * s, 3 * s], life: [3, 4.5], velocity: { x: 0, y: 0.25, z: 0 }, alpha: 0.55,
    });
    this.dust.spawn(20, { position: this.at(x, y + 0.2, z), color: 0xc8f08f, size: [0.8, 1.2] });
    this.confetti.spawn(16, { position: this.at(x, y + 0.5, z), color: 0x6b8f3a });
    this.rings.spawn(1, { position: this.at(x, 0.15, z), size: 1, color: 0xb6f07a });
    this.flash(x, y + 2, z, 30, 22, 0.4, 0x9be35a);
  }

  /**
   * A wisp of stink off a stink bomb's cork: in the paw while it's wound up, behind it in
   * flight, thicker as it's about to go. `k`: 0..1, how much.
   */
  stinkWisp(x: number, y: number, z: number, k = 0.5) {
    this.wisps.spawn(1, {
      position: this.at(x, y, z), size: [0.08 + 0.06 * k, 0.12 + 0.08 * k],
      velocity: (r) => ({ x: (r() - 0.5) * 0.5, y: 0.4 + r() * 0.6, z: (r() - 0.5) * 0.5 }), alpha: 0.45 + 0.35 * k,
    });
  }

  /** A stink bomb bouncing: a puff of dust and a few green flecks, `k` 0..1 how hard. */
  bouncePuff(x: number, y: number, z: number, k = 0.5) {
    this.dust.spawn(Math.round(3 + 6 * k), { position: this.at(x, y + 0.02, z), size: [0.2, 0.35] });
    this.confetti.spawn(Math.round(2 + 4 * k), { position: this.at(x, y + 0.1, z), color: 0x9be35a, size: [0.06, 0.1] });
  }

  /** A stink bomb that never was (the server didn't throw it): it fizzles into a grey poof. */
  fizzle(x: number, y: number, z: number) {
    this.dust.spawn(10, { position: this.at(x, y, z), color: 0xb9bcc4, size: [0.3, 0.5] });
    this.smoke.spawn(4, { position: this.at(x, y, z), color: 0x9aa0a8, size: [0.3, 0.5], life: [0.4, 0.7] });
  }

  /** WINNER WINNER: confetti fired into the sky. */
  confettiCannon(x: number, y: number, z: number) {
    for (const color of CONFETTI) {
      this.confetti.spawn(26, {
        position: this.at(x, y + 0.5, z), color, life: [1.6, 2.6], size: [0.16, 0.26],
        velocity: (r) => ({ x: (r() - 0.5) * 9, y: 11 + r() * 8, z: (r() - 0.5) * 9 }),
      });
    }
    this.sparks.spawn(30, { position: this.at(x, y + 0.5, z), color: 0xfff1a8, velocity: (r) => ({ x: (r() - 0.5) * 8, y: 8 + r() * 10, z: (r() - 0.5) * 8 }) });
  }

  /** Digging through a trash can: junk flies out of the top. */
  rummage(x: number, y: number, z: number) {
    for (const color of [0xc8894f, 0x9aa3b5, 0xf3ead8]) {
      this.confetti.spawn(6, { position: this.at(x, y + 0.7, z), color, velocity: (r) => ({ x: (r() - 0.5) * 4, y: 4 + r() * 4, z: (r() - 0.5) * 4 }) });
    }
    this.dust.spawn(6, { position: this.at(x, y + 0.6, z), color: 0xe9e2d0 });
  }

  /** Flattened by a car: a dusty ring around the pancake. */
  pancake(x: number, y: number, z: number) {
    this.rings.spawn(1, { position: this.at(x, 0.12, z), size: 0.6, color: 0xd9cfbd, alpha: 0.6 });
    this.dust.spawn(14, { position: this.at(x, y + 0.05, z), velocity: (r) => { const a = r() * 6.28; return { x: Math.cos(a) * 4, y: 0.6, z: Math.sin(a) * 4 }; } });
  }

  explosion(x: number, y: number, z: number, r: number) {
    const s = r / 6.5;
    this.fire.spawn(70, { position: this.at(x, y + 0.5, z), size: [1.2 * s, 2.6 * s] });
    this.fire.spawn(25, {
      position: this.at(x, y + 0.5, z),
      velocity: (rnd) => ({ x: (rnd() - 0.5) * 10, y: 6 + rnd() * 10, z: (rnd() - 0.5) * 10 }),
      life: [0.4, 0.9], size: [0.6, 1.2],
    });
    this.smoke.spawn(40, { position: this.at(x, y + 1, z), color: 0x5b5f68, size: [1.2 * s, 2 * s] });
    this.sparks.spawn(50, { position: this.at(x, y + 0.5, z), velocity: (rnd) => ({ x: (rnd() - 0.5) * 26, y: 4 + rnd() * 14, z: (rnd() - 0.5) * 26 }) });
    this.confetti.spawn(30, { position: this.at(x, y + 0.5, z), color: 0x3a3a3a });
    this.rings.spawn(1, { position: this.at(x, 0.15, z), size: 1 });
    this.flash(x, y + 2, z, 60, 26, 0.35);
  }

  dustPuff(x: number, y: number, z: number, n = 8) {
    this.dust.spawn(n, { position: this.at(x, y + 0.05, z) });
  }

  poof(x: number, y: number, z: number) {
    this.dust.spawn(16, { position: this.at(x, y + 0.4, z), color: 0xffffff, size: [0.6, 0.9] });
    this.confetti.spawn(18, { position: this.at(x, y + 0.6, z), color: CONFETTI[(Math.random() * CONFETTI.length) | 0] });
  }

  sparkle(x: number, y: number, z: number, color = 0xffe066) {
    this.sparks.spawn(20, { position: this.at(x, y + 0.6, z), color, velocity: (r) => ({ x: (r() - 0.5) * 6, y: 3 + r() * 5, z: (r() - 0.5) * 6 }) });
  }

  /** A gull shooed (or hatching): a burst of feathers, `n` of them. */
  featherBurst(x: number, y: number, z: number, n = 16) {
    for (const color of [0xffffff, 0xe7ebf0, 0xb7c0cc]) this.feathers.spawn(Math.ceil(n / 3), { position: this.at(x, y, z), color });
  }

  /** A bush brushed through: `n` leaves (feathers, tinted) flicked up along the way (vx, vz), drifting down. */
  leaves(x: number, y: number, z: number, color: number, vx: number, vz: number, n = 5) {
    this.feathers.spawn(n, {
      position: (r) => ({ x: x + (r() - 0.5) * 0.6, y: y + r() * 0.3, z: z + (r() - 0.5) * 0.6 }),
      color, size: [0.1, 0.17], life: [0.9, 1.6],
      velocity: (r) => ({ x: vx * 0.35 + (r() - 0.5) * 2.4, y: 1.4 + r() * 2, z: vz * 0.35 + (r() - 0.5) * 2.4 }),
    });
  }

  /** Steam (or worse) puffing up out of a manhole, `k` 0..1 how much. */
  sewerPuff(x: number, z: number, k = 0.5) {
    this.smoke.spawn(Math.max(1, Math.round(5 * k)), {
      position: (r) => ({ x: x + (r() - 0.5) * 0.6, y: 0.15, z: z + (r() - 0.5) * 0.6 }),
      color: Math.random() < 0.5 ? 0xc9e8c4 : 0xe4ece3, size: [0.35, 0.6], life: [0.8, 1.5],
      velocity: (r) => ({ x: (r() - 0.5) * 0.4, y: 1 + r() * 1.2, z: (r() - 0.5) * 0.4 }), alpha: 0.5,
    });
  }

  /** A dropping lands: a splash of white goo. */
  goo(x: number, y: number, z: number) {
    this.confetti.spawn(8, { position: this.at(x, y, z), color: 0xf6f6ee, size: [0.06, 0.12], velocity: (r) => ({ x: (r() - 0.5) * 3, y: 1.5 + r() * 2, z: (r() - 0.5) * 3 }) });
    this.dust.spawn(3, { position: this.at(x, y, z), color: 0xffffff, size: [0.2, 0.3] });
  }

  /** The golden dumpster bursting open: gold sparks, a ring, a flash. */
  goldBurst(x: number, y: number, z: number) {
    this.sparks.spawn(60, { position: this.at(x, y, z), color: 0xffd23f, velocity: (r) => ({ x: (r() - 0.5) * 12, y: 5 + r() * 10, z: (r() - 0.5) * 12 }) });
    this.confetti.spawn(40, { position: this.at(x, y, z), color: 0xffc93c, life: [1.2, 2], velocity: (r) => ({ x: (r() - 0.5) * 10, y: 6 + r() * 7, z: (r() - 0.5) * 10 }) });
    this.rings.spawn(1, { position: this.at(x, 0.15, z), size: 1.5, color: 0xffe27a });
    this.dust.spawn(16, { position: this.at(x, 0.2, z), color: 0xfff1c8 });
    this.flash(x, y + 1.5, z, 40, 20, 0.5, 0xffd23f);
  }

  /** A bench a car went through: wooden chips flying off along the car's way (vx, vz). */
  splinters(x: number, y: number, z: number, vx: number, vz: number) {
    for (const color of [0xb07a4a, 0x8a5a32]) {
      this.confetti.spawn(6, {
        position: this.at(x, y, z), color, size: [0.07, 0.14],
        velocity: (r) => ({ x: vx * 0.6 + (r() - 0.5) * 4, y: 2.5 + r() * 3.5, z: vz * 0.6 + (r() - 0.5) * 4 }),
      });
    }
  }

  /** A knocked-off hydrant's geyser out of the pipe at (x, y, z) (call per frame). */
  spray(x: number, y: number, z: number, dt: number) {
    const n = Math.floor(dt * 80 + Math.random());
    if (n > 0) {
      this.drops.spawn(n, {
        position: (r) => ({ x: x + (r() - 0.5) * 0.12, y: y + 0.2, z: z + (r() - 0.5) * 0.12 }),
        color: Math.random() < 0.5 ? 0x9ad8ff : 0xeaf7ff,
        velocity: (r) => ({ x: (r() - 0.5) * 1.8, y: 8 + r() * 2.5, z: (r() - 0.5) * 1.8 }),
      });
    }
    if (Math.random() < dt * 9) {
      this.dust.spawn(1, {
        position: this.at(x, y + 1.6 + Math.random(), z), color: 0xdff3ff, size: [0.5, 0.8], life: [0.6, 1],
        velocity: (r) => ({ x: (r() - 0.5) * 1.2, y: -0.5 - r(), z: (r() - 0.5) * 1.2 }),
      });
    }
  }

  /** Continuous emitters (call per frame with an intensity 0..1). */
  burn(x: number, y: number, z: number, dt: number) {
    if (Math.random() < dt * 40) this.fire.spawn(1, { position: this.at(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5)), velocity: { x: 0, y: 3, z: 0 }, life: [0.3, 0.6] });
    if (Math.random() < dt * 12) this.smoke.spawn(1, { position: this.at(x, y + 0.8, z), color: 0x3d3f45, velocity: { x: 0, y: 2.5, z: 0 } });
  }

  smokeTrail(x: number, y: number, z: number, dt: number, rate: number, color = 0x9a9ea8) {
    if (Math.random() < dt * rate) this.smoke.spawn(1, { position: this.at(x, y, z), color, size: [0.4, 0.7], velocity: { x: 0, y: 1.2, z: 0 } });
  }

  driftSmoke(x: number, z: number) {
    this.dust.spawn(1, { position: this.at(x, 0.1, z), color: 0xe9e9ee, size: [0.5, 0.8], life: [0.6, 1.1] });
  }

  /** A puff of the purple fumigation gas, rising from the edge of the circle. */
  fumes(x: number, z: number) {
    this.smoke.spawn(1, {
      position: this.at(x + (Math.random() - 0.5) * 1.5, 0.4 + Math.random() * 2.5, z + (Math.random() - 0.5) * 1.5),
      color: Math.random() < 0.5 ? 0xb38bff : 0x8a5cff, size: [1, 1.8], velocity: { x: 0, y: 0.6, z: 0 },
    });
  }

  update(ticker: Ticker) {
    const dt = ticker.deltaMS / 1000;
    for (const p of [this.fire, this.smoke, this.sparks, this.confetti, this.junkBits, this.feathers, this.drops, this.rings, this.dust, this.wisps]) p.update(ticker);
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
      else t.mat.alpha = (t.life / t.max) * t.k;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) { f.light.intensity = 0; f.light.visible = false; continue; }
      f.life -= dt;
      f.light.intensity = Math.max(0, f.peak * (f.life / f.max));
    }
  }

  /**
   * Loading-screen warm-up: run every effect once (far below the city) so particle spawn
   * code is generated now, and show a tracer (fully transparent) for one frame so its
   * shader is compiled now instead of on the first shot. Returns the undo.
   */
  prewarm(): () => void {
    // far below and far away: some effects (ground rings) sit at a fixed height
    const y = -500, x = 5000, z = 5000;
    for (let w = 1; w <= 3; w++) {
      this.muzzle(x, y, z, 1, 0, w);
      this.impact(x, y, z, 4, w);
    }
    this.tracer(x, y, z, x + 3, y, z);
    this.junk(x, y, z, x + 3, y, z);
    this.impact(x, y, z);
    this.hitPuff(x, y, z);
    this.explosion(x, y, z, 6.5);
    this.stink(x, y, z, 6.5);
    this.stinkWisp(x, y, z);
    this.bouncePuff(x, y, z);
    this.fizzle(x, y, z);
    this.confettiCannon(x, y, z);
    this.pancake(x, y, z);
    this.rummage(x, y, z);
    this.dustPuff(x, y, z);
    this.poof(x, y, z);
    this.sparkle(x, y, z);
    this.burn(x, y, z, 1);
    this.smokeTrail(x, y, z, 1, 1e3);
    this.driftSmoke(x, z);
    this.featherBurst(x, y, z);
    this.sewerPuff(x, z);
    this.goo(x, y, z);
    this.goldBurst(x, y, z);
    this.splinters(x, y, z, 1, 0);
    this.spray(x, y, z, 1);
    const t = this.tracers.find((tr) => tr.life > 0)!;
    t.mat.alpha = 0;
    return () => {
      for (const tr of this.tracers) { tr.life = 0; tr.mesh.visible = false; }
      for (const f of this.flashes) { f.life = 0; f.light.intensity = 0; f.light.visible = false; }
    };
  }
}
