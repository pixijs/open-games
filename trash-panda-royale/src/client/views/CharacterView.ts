import { Container3D, Material3D, Mesh3D, Quaternion, Vector3 } from "@pixi/3d";
import { Matrix } from "pixi.js";
import { PLAYER_RADIUS, Weapon } from "../../shared/constants.js";
import { Animator, Ch, RIG_STEP, type AnimEvent, type AnimInput, type Pose, type RigShape } from "../anim/Animator.js";
import { destroyInstance, find, forEachMesh, instance, materialName, materialsOf } from "../assets.js";
import type { Look } from "./looks.js";

export type { Pose };
/** What a character is doing this frame (see `AnimInput`). */
export type CharState = AnimInput;

const WEAPON_MODELS: Record<number, string> = {
  [Weapon.Pistol]: "wpn_pistol", [Weapon.Smg]: "wpn_smg", [Weapon.Shotgun]: "wpn_shotgun", [Weapon.Grenade]: "wpn_grenade",
};

/** After throwing a stink bomb the paw is empty this long (s), then the next thing pops in over this long. */
const TOSS_EMPTY = 0.25, TOSS_POP = 0.17;

/** Head-wear the crown replaces. */
const HATS = ["acc_beanie", "acc_cap", "acc_pirate", "acc_tophat", "acc_headphones", "acc_cone"];

/** Face atlas: each species' expressions sit in 4×2 cells of 1/8 × 1/4 of the texture. */
const CELL_U = 0.125, CELL_V = 0.25;
/** Shirt patterns sit side by side, 1/8 of the texture apart. */
const PATTERN_U = 0.125;
/**
 * On a wall, the body tips back about a point this far up (m, world): the player's circle is
 * this far out from the wall's face, so the floor the paws stand on ends up flat on the face.
 * And it turns, crawling, about this far along its length from the hind feet (m, model).
 */
const WALL_PIVOT = PLAYER_RADIUS, WALL_MID = 0.18;

interface Joint { node: Container3D; py: number }
/** Joints found with a rest rotation (warned about once each). */
const turnedJoints = new Set<string>();

/** The raccoon's legs and arms, measured off the model once (see `RigShape`). */
let raccoonRig: RigShape | null = null;
function measureRig(body: Container3D): RigShape | null {
  const legs = find(body, "legs"), leg = find(body, "leg_l"), foot = find(body, "foot_l");
  const hips = find(body, "hips"), arm = find(body, "arm_l"), fore = find(body, "forearm_l");
  if (!legs || !leg || !foot || !hips || !arm || !fore) return null;
  // the lowest point of a node's own mesh (its primitives sit at its origin), tipped by each angle
  const table = (n: Container3D) => {
    const zy: number[] = [];
    for (const m of [n, ...n.children]) {
      if (!(m instanceof Mesh3D) || (m !== n && m.label !== "Mesh3D")) continue;
      const p = m.geometry.positions;
      for (let i = 0; i + 2 < p.length; i += 3) zy.push(p[i + 2], p[i + 1]);
    }
    const out = new Float32Array(Math.round((Math.PI * 2) / RIG_STEP));
    for (let k = 0; k < out.length; k++) {
      const a = -Math.PI + k * RIG_STEP, c = Math.cos(a), s = Math.sin(a);
      let low = Infinity;
      for (let i = 0; i < zy.length; i += 2) low = Math.min(low, zy[i + 1] * c - zy[i] * s);
      out[k] = low;
    }
    return out;
  };
  return {
    hip: legs.position.y + leg.position.y, hipX: leg.position.x, ankleZ: foot.position.z, ankleY: foot.position.y,
    hips: hips.position.y, shoulder: arm.position.y, elbow: fore.position.y,
    foot: table(foot), paw: table(fore),
  };
}

/**
 * A raccoon (players) or a person (townsfolk, drivers): the model, its joints, and the
 * `Animator` that moves them.
 */
export class CharacterView {
  readonly root = new Container3D({ label: "character" });
  readonly anim: Animator;
  private body: Container3D;
  /**
   * On a wall, between the root and the body: `tilt` tips the body back onto the wall (about
   * WALL_PIVOT up, so the gallop's floor lands on the wall's face), then `turn` turns it about
   * the wall's normal (through WALL_MID along it), the way it crawls. Both still off the wall.
   */
  private tilt = new Container3D({ label: "wall_tilt" });
  private turn = new Container3D({ label: "wall_turn" });
  private joints: (Joint | null)[] = [];
  private socket: Container3D | null;
  private weapons = new Map<number, Container3D>();
  private weapon = -1;
  /** The tip of a held stink bomb's cork (where its stink wisps off). */
  private cork: Container3D | null = null;
  /** Just threw a stink bomb: the paw is empty for a beat, then the next thing pops in (s left). */
  private tossT = 0;
  private stars: Container3D;
  private flashMats: Material3D[] = [];
  private faceMats: Material3D[] = [];
  private faceUv = new Matrix();
  private face = -1;
  private flashT = 0;
  private flashOn = false;
  /** A kid's balloon: kept floating upright whatever the arm does. */
  private balloon: Container3D | null = null;
  private crowned = false;
  private readonly tmp = new Vector3();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly eul = { x: 0, y: 0, z: 0 };

  constructor(public look: Look, private opts: { unique?: boolean } = {}) {
    const unique = !!opts.unique;
    // (the shirt's pattern: shared by everyone in the same shirt)
    const uv = look.pattern ? { Shirt: new Matrix(1, 0, 0, 1, look.pattern * PATTERN_U, 0) } : undefined;
    this.body = instance(look.species, { recolor: look.colors, uv, unique, own: ["Face"] });
    this.root.scale.set(look.scale);
    this.root.addChild(this.tilt);
    this.tilt.addChild(this.turn);
    this.turn.addChild(this.body);
    this.anim = new Animator(look.species, look.role);
    if (look.species === "raccoon") this.anim.rig = raccoonRig ??= measureRig(this.body);
    this.dress();

    // (the Animator's angles, assets-src/poses.json and the Blender previews all take every
    // joint's rest turn to be none; a loaded node's rest turn is in its quaternion, not `rotation`)
    const j = (label: string) => {
      const node = find(this.body, label);
      if (!node) return null;
      const q = node.quaternion;
      const key = `${look.species} ${label}`;
      if (Math.abs(q.w) < 0.99999 && !turnedJoints.has(key)) {
        turnedJoints.add(key);
        console.warn(`${key}: a rest rotation in the model, which the animation overwrites`);
      }
      return { node, py: node.position.y };
    };
    this.joints = [
      j("hips"), j("torso"), j("head"), j("ear_l"), j("ear_r"), j("arm_l"), j("arm_r"), j("forearm_l"), j("forearm_r"),
      j("legs"), j("leg_l"), j("leg_r"), j("foot_l"), j("foot_r"), j("tail_0"), j("tail_1"), j("tail_2"),
    ];
    this.socket = find(this.body, "hand_r_socket");
    if (unique) this.flashMats = materialsOf(this.body).filter((m) => m.emissive && !["Eyes", "EyeShine", "Face"].includes(materialName(m)));
    forEachMesh(this.body, (m) => {
      if (materialName(m.material) === "Face" && m.material instanceof Material3D && !this.faceMats.includes(m.material)) this.faceMats.push(m.material);
    });

    this.stars = new Container3D({ label: "stars" });
    for (let i = 0; i < 3; i++) {
      const s = instance("fx_star", { castShadow: false });
      const a = (i / 3) * Math.PI * 2;
      s.position.set(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35);
      s.scale.set(0.8);
      this.stars.addChild(s);
    }
    this.stars.visible = false;
    this.root.addChild(this.stars);
  }

  setWeapon(kind: number) {
    if (kind === this.weapon) return;
    this.weapon = kind;
    this.anim.weapon = kind;
    for (const w of this.weapons.values()) w.visible = false;
    const name = WEAPON_MODELS[kind];
    if (!name || !this.socket) return;
    let w = this.weapons.get(kind);
    if (!w) {
      w = instance(name, { castShadow: false });
      // barrel (+Z) along the arm, top (+Y) toward the arm's front
      w.rotation.set(Math.PI / 2, 0, 0);
      this.socket.addChild(w);
      this.weapons.set(kind, w);
      if (kind === Weapon.Grenade) {
        this.cork = new Container3D({ label: "cork" });
        this.cork.position.set(0, 0.13, 0);
        w.addChild(this.cork);
      }
    }
    w.visible = true;
  }

  /** Something happened (see `AnimEvent`): jump, land, fire, slap, throw, flatten… */
  event(kind: AnimEvent, k = 1) {
    this.anim.event(kind, k);
    if (kind === "throw") this.tossT = TOSS_EMPTY + TOSS_POP;
  }

  /** Where the cork of the stink bomb in its paw is (world), or null if it isn't holding one. */
  corkAt(out: { x: number; y: number; z: number }) {
    const w = this.weapons.get(Weapon.Grenade);
    if (!this.cork || !w || this.weapon !== Weapon.Grenade || !w.visible || !this.root.visible) return null;
    this.cork.getGlobalPosition(this.tmp);
    out.x = this.tmp.x; out.y = this.tmp.y; out.z = this.tmp.z;
    return out;
  }
  punch() { this.anim.event("slap"); }
  recoil() { this.anim.event("fire"); }
  flash() { this.flashT = 0.12; this.anim.event("hurt"); }
  /** The reigning champion wears the crown (instead of their hat). */
  setCrown(on: boolean) {
    if (on === this.crowned) return;
    this.crowned = on;
    if (find(this.body, "acc_crown")) this.dress();
  }

  /**
   * Another look of the same species, without rebuilding the character (the start screen's
   * preview): its own materials take the new colours, and it wears the new accessories.
   * Only for `unique` views (the others share their materials); undoes `hide()`.
   */
  restyle(look: Look) {
    if (!this.opts.unique || look.species !== this.look.species) throw new Error("restyle: needs a unique view of the same species");
    this.look = look;
    forEachMesh(this.body, (m) => {
      const c = look.colors[materialName(m.material)];
      if (c !== undefined && m.material instanceof Material3D) m.material.baseColor = c;
    });
    this.dress();
  }

  /** Show the look's accessories (the crown instead of a hat while crowned), hide every other one. */
  private dress() {
    const keep = new Set(this.look.accessories);
    const walk = (n: Container3D) => {
      const l = n.label ?? "";
      if (l.startsWith("acc_") || l.startsWith("hair_")) {
        n.visible = l === "acc_crown" ? this.crowned : keep.has(l) && !(this.crowned && HATS.includes(l));
      }
      for (const c of n.children) walk(c as Container3D);
    };
    walk(this.body);
    // a loot sack on the back: the tail swings round it; galloping, the head stays clear of it
    // and of whatever is round the neck
    this.anim.sack = keep.has("acc_sack");
    this.anim.collar = keep.has("acc_bandana") || keep.has("acc_bowtie");
    if (keep.has("acc_balloon")) this.balloon = find(this.body, "acc_balloon");
  }

  /**
   * The pose as numbers, for dev tools (the gallery's overlap checks): every joint's Euler
   * rotation (radians, XYZ, glTF axes) and the body node's transform, which turns and scales
   * around `originY` (pixi3d's `origin`). The root sits at the character's position, turned
   * by its yaw and scaled by `scale`. A held weapon hangs off `hand_r_socket`, turned (π/2, 0, 0).
   */
  snapshot() {
    const joints: Record<string, [number, number, number]> = {};
    for (const jt of this.joints) if (jt) joints[jt.node.label] = [jt.node.rotation.x, jt.node.rotation.y, jt.node.rotation.z];
    // how far each leg has slid up into the hips (m; < 0: reaching out of them)
    const legSlide: Record<string, number> = {};
    for (const jt of this.joints) if (jt && jt.node.label.startsWith("leg_")) legSlide[jt.node.label] = jt.node.position.y - jt.py;
    const b = this.body, q = this.balloon?.quaternion;
    return {
      species: this.look.species, role: this.look.role, accessories: this.shownAccessories(),
      scale: this.root.scale.x, yaw: this.root.rotation.y, weapon: this.weapons.get(this.weapon)?.visible ? WEAPON_MODELS[this.weapon] : null,
      expr: this.anim.expr, joints, legSlide,
      body: { y: b.position.y, rot: [b.rotation.x, b.rotation.y, b.rotation.z], scale: [b.scale.x, b.scale.y, b.scale.z], originY: b.origin.y },
      // (on a wall: Ch.wall's weight and the turn up it; 0, 0 everywhere else)
      wall: [this.anim.out[Ch.wall], this.anim.out[Ch.wallTurn]],
      balloonQuat: q ? [q.x, q.y, q.z, q.w] : null,
    };
  }

  /** The accessory and hair nodes showing right now. */
  private shownAccessories() {
    const out: string[] = [];
    const scan = (n: Container3D) => {
      const l = n.label ?? "";
      if (!n.visible) return;
      if (l.startsWith("acc_") || l.startsWith("hair_")) out.push(l);
      for (const c of n.children) scan(c as Container3D);
    };
    scan(this.body);
    return out;
  }

  /** Hide one of this look's accessories (say, a balloon in a car). */
  hide(name: string) {
    const n = find(this.body, name);
    if (n) n.visible = false;
    if (name === "acc_balloon") this.balloon = null;
    if (name === "acc_sack") this.anim.sack = false;
  }

  /** Height (m, unscaled) of the top of what's visible (head, ears, hair, hat) standing at rest. */
  restTop() {
    return this.body.getLocalBounds().max.y;
  }

  /** 0 near (everything), 1 mid (no secondary motion), 2 far (pose only). */
  setLod(lod: number) { this.anim.lod = lod; }

  /** World position of the muzzle: the gun's `muzzle` node, or an estimate from the body pose. */
  muzzle(s: CharState) {
    const w = this.weapons.get(this.weapon);
    const node = w?.visible ? find(w, "muzzle") : null;
    if (node) {
      node.getGlobalPosition(this.tmp);
      return { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
    }
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw);
    const len = this.weapon === Weapon.Shotgun ? 1.05 : this.weapon === Weapon.Smg ? 0.8 : 0.65;
    return { x: s.x + fx * len + rx * 0.24, y: s.y + 0.78, z: s.z + fz * len + rz * 0.24 };
  }

  update(dt: number, s: CharState) {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.set(0, s.yaw, 0);
    this.root.visible = s.pose !== "hidden";
    if (s.pose === "hidden") return;

    const a = this.anim;
    a.update(dt, s);
    if (this.tossT > 0) this.tossT = Math.max(0, this.tossT - dt);
    if (a.lod < 2 || this.flashT > 0) this.apply(s.pose);

    // dizzy stars over a knocked-out head
    this.stars.visible = s.pose === "lying";
    if (this.stars.visible) {
      this.stars.position.set(0, 0.55, -1.0);
      this.stars.rotation.set(0, performance.now() / 250, 0);
    }

    // the face
    if (this.faceMats.length && a.expr !== this.face) {
      this.face = a.expr;
      this.faceUv.tx = (a.expr % 4) * CELL_U;
      this.faceUv.ty = Math.floor(a.expr / 4) * CELL_V;
      for (const m of this.faceMats) m.uvTransform = this.faceUv;
    }

    if (this.flashMats.length && (this.flashT > 0 || this.flashOn)) {
      const on = this.flashT > 0;
      this.flashT -= dt;
      this.flashOn = on;
      for (const m of this.flashMats) {
        if (!m.emissive) continue;
        m.emissive.color = on ? 0xffffff : 0x000000;
        m.emissive.strength = on ? 0.8 : 1;
      }
    }
  }

  /** Write the animation into the joints (only the ones this model has). */
  private apply(pose: Pose) {
    const x = this.anim.out;
    const [hips, torso, head, earL, earR, armL, armR, foreL, foreR, legs, legL, legR, footL, footR, t0, t1, t2] = this.joints;
    const rot = (jt: Joint | null, rx: number, ry: number, rz: number) => { if (jt) jt.node.rotation.set(rx, ry, rz); };
    rot(hips, 0, x[Ch.hipsRY], x[Ch.hipsRZ]);
    rot(torso, x[Ch.torsoRX], x[Ch.torsoRY], x[Ch.torsoRZ]);
    rot(head, x[Ch.headRX], x[Ch.headRY], x[Ch.headRZ]);
    rot(earL, x[Ch.earLRX], 0, x[Ch.earLRZ]);
    rot(earR, x[Ch.earRRX], 0, x[Ch.earRRZ]);
    rot(armL, x[Ch.armLRX], x[Ch.armLRY], x[Ch.armLRZ]);
    rot(armR, x[Ch.armRRX], x[Ch.armRRY], x[Ch.armRRZ]);
    rot(foreL, x[Ch.foreL], 0, 0);
    rot(foreR, x[Ch.foreR], 0, 0);
    rot(legs, 0, x[Ch.legsRY], 0);
    rot(legL, x[Ch.legLRX], 0, x[Ch.legLRZ]);
    rot(legR, x[Ch.legRRX], 0, x[Ch.legRRZ]);
    // a leg slides into the hips (a stubby leg's knee bend) or reaches out of them
    if (legL) legL.node.position.y = legL.py + x[Ch.legLY];
    if (legR) legR.node.position.y = legR.py + x[Ch.legRY];
    rot(footL, x[Ch.footL], 0, 0);
    rot(footR, x[Ch.footR], 0, 0);
    rot(t0, x[Ch.tail0X], x[Ch.tail0Y], 0);
    rot(t1, x[Ch.tail1X], x[Ch.tail1Y], 0);
    rot(t2, x[Ch.tail2X], x[Ch.tail2Y], 0);
    // the balloon floats: undo the hips, torso, arm and forearm turns (a whole-body tumble still turns it)
    if (this.balloon) {
      const e = this.eul, q = this.q.setFromEuler({ x: 0, y: x[Ch.hipsRY], z: x[Ch.hipsRZ] });
      const turn = (rx: number, ry: number, rz: number) => { e.x = rx; e.y = ry; e.z = rz; q.multiply(this.q2.setFromEuler(e)); };
      turn(x[Ch.torsoRX], x[Ch.torsoRY], x[Ch.torsoRZ]);
      turn(x[Ch.armRRX], x[Ch.armRRY], x[Ch.armRRZ]);
      turn(x[Ch.foreR], 0, 0);
      this.balloon.quaternion = q.conjugate();
    }
    // galloping, the gun is tucked away (both front paws are feet); it's back out to shoot
    const gun = this.weapons.get(this.weapon);
    if (gun) {
      let k = 1 - Math.min(1, Math.max(0, (x[Ch.gallop] - 0.25) / 0.35));
      // a stink bomb just left the paw: empty for a beat, then the next thing pops in (overshooting)
      if (this.tossT > 0) {
        const t = this.tossT > TOSS_POP ? 0 : 1 - this.tossT / TOSS_POP;
        k *= t * (1 + 0.6 * Math.sin(t * Math.PI));
      }
      gun.visible = k > 0.02;
      gun.scale.set(k, k, k);
    }

    const sy = x[Ch.bodySY], sxz = x[Ch.bodySXZ];
    this.body.scale.set(sxz, sy, sxz);
    // tumble around the belly, everything else around the feet
    this.body.origin.set(0, pose === "ragdoll" ? (this.look.species === "human" ? 0.95 : 0.65) : 0, 0);
    // on a wall: tipped back onto it about a point WALL_PIVOT up (that point stays, and the floor
    // the body stands on swings up flat against the wall in front of it), turned the way it
    // crawls about the middle of its length
    const w = Math.max(0, Math.min(1, x[Ch.wall])), pivot = WALL_PIVOT / this.root.scale.x;
    this.tilt.position.set(0, pivot * w, 0);
    this.tilt.rotation.set((-Math.PI / 2) * w, 0, 0);
    this.turn.position.set(0, -pivot * w, WALL_MID * w);
    this.turn.rotation.set(0, x[Ch.wallTurn] * w, 0);
    this.body.position.set(0, x[Ch.bodyY], -WALL_MID * w);
    this.body.rotation.set(x[Ch.bodyRX], x[Ch.bodyRY], x[Ch.bodyRZ]);
  }

  destroy() {
    destroyInstance(this.root);
  }
}
