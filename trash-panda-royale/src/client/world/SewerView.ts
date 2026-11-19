import { Container3D, CylinderGeometry, Material3D, Mesh3D } from "@pixi/3d";
import { GRAVITY } from "../../shared/constants.js";
import { CITY } from "../../shared/map.js";
import { MANHOLE_R, MANHOLES, SEWER } from "../../shared/sewer.js";
import { find, hasModel, instance } from "../assets.js";
import { Band, bandMaterial, bandMesh, canvasTexture, Strip } from "../gfx/Band.js";
import type { Fx } from "../Fx.js";
import { HEIGHTS } from "./Ground.js";

/** The covers sit just over the asphalt and its markings (see `HEIGHTS`). */
const COVER_Y = HEIGHTS.lotDecal + 0.004;
/** A lid knocked off lands about this far from its hole, the way it flew. */
const LID_REST = 0.95;
/** The sewer's map drawn on the street while you're down there: this far round you (m), and how high over the asphalt. */
const MAP_R = 55, MAP_Y = 0.075;
const MAX_PIPES = 28, PIPE_PTS = 48, MAX_RINGS = 14;
const SEWER_GREEN = 0x3dff78;

interface Cover {
  root: Container3D;
  lid: Container3D | null;
  hole: Container3D | null;
  /** The lid: on, flying off, lying beside the hole, or sliding back on. */
  at: "on" | "flying" | "off" | "closing";
  /** Lid pose while it's off (relative to the cover): position, velocity, spin; where it lies. */
  lx: number; ly: number; lz: number; lvx: number; lvy: number; lvz: number; spin: number; flip: number;
  restX: number; restZ: number;
  /** A jig on the frame (rattle: someone scurried under; slide: someone went down) and its time left (s). */
  jig: "rattle" | "slide" | null; jigT: number;
  t: number;
}

/**
 * The manholes: their covers on the streets, and the lids that rattle as someone scurries under
 * them, fly off when someone climbs out (`state.manholes` says which are off) and lie by the hole
 * till they're back on. While you're down the sewer (or watching someone who is), the pipes round
 * you and the manholes you can climb out of glow on the street, like a map.
 */
export class SewerView {
  readonly root = new Container3D({ label: "sewer" });
  private covers: Cover[] = [];
  private pipes: Strip[] = [];
  private rings: Mesh3D[] = [];
  private here: Band;
  private mapOn = false;
  private mapKey = "";
  private time = 0;
  private steamAt = 0;

  constructor(private fx: Fx) {
    const model = hasModel("manhole");
    for (const m of MANHOLES) {
      const root = model ? instance("manhole", { castShadow: false }) : fallbackCover();
      root.position.set(m.x, COVER_Y, m.z);
      root.rotation.set(0, m.yaw, 0);
      this.root.addChild(root);
      const hole = find(root, "hole");
      if (hole) hole.visible = false;
      this.covers.push({
        root, lid: find(root, "lid"), hole, at: "on", lx: 0, ly: 0, lz: 0, lvx: 0, lvy: 0, lvz: 0, spin: 0, flip: 0,
        restX: 0, restZ: 0, jig: null, jigT: 0, t: 0,
      });
    }
    // the sewer map: a green glow along the pipes (soft-edged, not a marking), rings round the
    // manholes, and where you are
    const pipeTex = canvasTexture(8, 32, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.3, "rgba(255,255,255,0.55)"); g.addColorStop(0.5, "rgba(255,255,255,1)");
      g.addColorStop(0.7, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // little bubbles along it, every so often (the texture repeats along the pipe)
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath(); ctx.arc(w / 2, h / 2, 1.6, 0, Math.PI * 2); ctx.fill();
    });
    const pipeMat = bandMaterial(SEWER_GREEN, pipeTex, 0.7, SEWER_GREEN, 1.1);
    for (let i = 0; i < MAX_PIPES; i++) {
      const s = new Strip(pipeMat, PIPE_PTS);
      s.mesh.visible = false;
      this.root.addChild(s.mesh);
      this.pipes.push(s);
    }
    const glow = canvasTexture(4, 32, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    const ringMat = bandMaterial(0xffffff, glow, 0.9, SEWER_GREEN, 3);
    for (let i = 0; i < MAX_RINGS; i++) {
      const b = bandMesh(ringMat, false, MANHOLE_R + 0.15, 0.22, 1, 32);
      b.visible = false;
      this.root.addChild(b);
      this.rings.push(b);
    }
    this.here = new Band(bandMaterial(0xffffff, glow, 0.9, 0xfff6a0, 3.5), false, 1, 40);
    this.here.mesh.visible = false;
    this.root.addChild(this.here.mesh);
  }

  /** Lid `i` came off (`yaw`: the way it flew; `seen`: it happened just now, not before we got here). */
  open(i: number, yaw: number, seen: boolean) {
    const c = this.covers[i], m = MANHOLES[i];
    if (!c || !m) return;
    // (in the cover's frame: it's turned along its street)
    const a = yaw - m.yaw;
    c.restX = Math.sin(a) * LID_REST; c.restZ = Math.cos(a) * LID_REST;
    if (!seen) { this.lieDown(c); return; }
    c.at = "flying";
    c.lx = 0; c.ly = 0.02; c.lz = 0;
    c.lvx = Math.sin(a) * 2.2; c.lvz = Math.cos(a) * 2.2; c.lvy = 5.5;
    c.spin = (Math.random() - 0.5) * 18; c.flip = 0;
    c.jig = null;
    if (c.hole) c.hole.visible = true;
    this.fx.dustPuff(m.x, 0.1, m.z, 8);
    this.fx.sewerPuff(m.x, m.z, 1);
  }

  /** Lid `i` is back on: it slides back over the hole. */
  close(i: number) {
    const c = this.covers[i];
    if (!c || c.at === "on") return;
    c.at = "closing";
    c.t = 0;
  }

  /** Someone scurried under manhole `i`: its lid rattles, and a puff comes up. */
  rattle(i: number) {
    const c = this.covers[i], m = MANHOLES[i];
    if (!c || !m) return;
    if (c.at === "on") { c.jig = "rattle"; c.jigT = 0.45; }
    this.fx.sewerPuff(m.x, m.z, 0.6);
  }

  /** Someone went down manhole `i`: its lid slides aside and back over them. */
  slide(i: number) {
    const c = this.covers[i], m = MANHOLES[i];
    if (!c || !m) return;
    if (c.at === "on") { c.jig = "slide"; c.jigT = 0.6; }
    this.fx.dustPuff(m.x, 0.1, m.z, 6);
  }

  private lieDown(c: Cover) {
    c.at = "off";
    c.lx = c.restX; c.lz = c.restZ; c.ly = 0.005;
    c.lvx = c.lvy = c.lvz = 0;
    if (c.hole) c.hole.visible = true;
    if (c.lid) {
      c.lid.position.set(c.lx, c.ly, c.lz);
      c.lid.rotation.set(0, 0, 0);
    }
  }

  /**
   * Once a frame. `under`: where the raccoon down the sewer we follow (ours, or whoever we watch) is,
   * and the street it's under, or null to hide the map. `near` says which covers are worth animating.
   */
  update(dt: number, under: { x: number; z: number; edge: number } | null, near: (x: number, z: number) => boolean) {
    this.time += dt;
    for (let i = 0; i < this.covers.length; i++) {
      const c = this.covers[i], m = MANHOLES[i];
      if (!c.lid) continue;
      if (c.at === "flying") {
        // tumbling through the air, then a clank and a bounce, and it lies there
        c.lvy -= GRAVITY * dt;
        c.lx += c.lvx * dt; c.ly += c.lvy * dt; c.lz += c.lvz * dt;
        c.flip += c.spin * dt;
        if (c.ly <= 0.005 && c.lvy < 0) {
          if (c.lvy < -3) { c.lvy *= -0.3; c.lvx *= 0.5; c.lvz *= 0.5; c.spin *= 0.4; }
          else this.lieDown(c);
        }
        if (c.at === "flying") { c.lid.position.set(c.lx, c.ly, c.lz); c.lid.rotation.set(c.flip, c.flip * 0.4, 0); }
        continue;
      }
      if (c.at === "closing") {
        c.t += dt / 0.35;
        const k = Math.min(1, c.t), s = k * k * (3 - 2 * k);
        c.lid.position.set(c.restX * (1 - s), 0.005 + Math.sin(k * Math.PI) * 0.08, c.restZ * (1 - s));
        c.lid.rotation.set(0, (1 - s) * 0.8, 0);
        if (k >= 1) { c.at = "on"; c.lid.position.set(0, 0, 0); c.lid.rotation.set(0, 0, 0); if (c.hole) c.hole.visible = false; }
        continue;
      }
      if (c.at !== "on" || !c.jig) continue;
      if (!near(m.x, m.z)) { c.jig = null; c.lid.position.set(0, 0, 0); c.lid.rotation.set(0, 0, 0); continue; }
      c.jigT -= dt;
      if (c.jigT <= 0) { c.jig = null; c.lid.position.set(0, 0, 0); c.lid.rotation.set(0, 0, 0); continue; }
      if (c.jig === "rattle") {
        const k = c.jigT / 0.45;
        c.lid.position.set(0, Math.abs(Math.sin(this.time * 55)) * 0.05 * k, 0);
        c.lid.rotation.set(Math.sin(this.time * 41) * 0.08 * k, 0, Math.sin(this.time * 47) * 0.08 * k);
      } else {
        // aside and back: up a little, slid half off, then back over
        const k = 1 - c.jigT / 0.6, s = Math.sin(k * Math.PI);
        c.lid.position.set(s * 0.55, s * 0.06, 0);
        c.lid.rotation.set(0, s * 0.5, s * 0.15);
        if (c.hole) c.hole.visible = s > 0.2;
      }
    }

    // now and then, a wisp of steam out of a manhole near the camera (the sewer is down there)
    if (this.time > this.steamAt) {
      this.steamAt = this.time + 0.35 + Math.random() * 0.5;
      const k = (Math.random() * MANHOLES.length) | 0, m = MANHOLES[k];
      if (near(m.x, m.z) && Math.random() < 0.35) this.fx.sewerPuff(m.x, m.z, 0.25);
    }
    this.updateMap(under);
  }

  /** The sewer's map round `under` (null: none). */
  private updateMap(under: { x: number; z: number; edge: number } | null) {
    const on = !!under;
    if (on !== this.mapOn) {
      this.mapOn = on;
      if (!on) {
        for (const s of this.pipes) s.mesh.visible = false;
        for (const r of this.rings) r.visible = false;
        this.here.mesh.visible = false;
        this.mapKey = "";
      }
    }
    if (!under) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
    this.here.set(under.x, under.z, 0.55 + 0.25 * pulse, MAP_Y + 0.004, 0.18);
    this.here.mesh.visible = true;
    // the pipes and manholes round us (redone when we've moved on a bit)
    const key = `${Math.round(under.x / 6)}|${Math.round(under.z / 6)}`;
    if (key === this.mapKey) return;
    this.mapKey = key;
    const edges = CITY.roads.edges;
    const near: { e: number; d: number }[] = [];
    edges.forEach((e, i) => {
      if (!SEWER.piped[i]) return;
      let d = Infinity;
      for (const p of e.pts) d = Math.min(d, Math.hypot(p.x - under.x, p.z - under.z));
      // (a long street can pass close by between its points)
      for (let k = 1; k < e.pts.length; k++) d = Math.min(d, segDist(under.x, under.z, e.pts[k - 1], e.pts[k]));
      if (d < MAP_R) near.push({ e: i, d });
    });
    near.sort((a, b) => a.d - b.d);
    const xyz = new Float32Array(PIPE_PTS * 3);
    for (let k = 0; k < this.pipes.length; k++) {
      const s = this.pipes[k], it = near[k];
      if (!it) { s.mesh.visible = false; continue; }
      const pts = resample(edges[it.e].pts, PIPE_PTS);
      pts.forEach((p, j) => { xyz[j * 3] = p.x; xyz[j * 3 + 1] = MAP_Y; xyz[j * 3 + 2] = p.z; });
      s.set(xyz, pts.length, it.e === under.edge ? 1.3 : 0.9, 2);
      s.mesh.visible = true;
    }
    const holes = MANHOLES.map((m, i) => ({ i, d: Math.hypot(m.x - under.x, m.z - under.z) })).filter((h) => h.d < MAP_R).sort((a, b) => a.d - b.d);
    for (let k = 0; k < this.rings.length; k++) {
      const r = this.rings[k], h = holes[k];
      if (!h) { r.visible = false; continue; }
      const m = MANHOLES[h.i];
      r.position.set(m.x, MAP_Y + 0.002, m.z);
      r.visible = true;
    }
  }

  /** Loading-screen warm-up: the map once (its band material), then hidden. */
  prewarm(): () => void {
    const m = MANHOLES[0];
    if (m) this.updateMap({ x: m.x, z: m.z, edge: m.edge });
    return () => this.updateMap(null);
  }
}

function segDist(x: number, z: number, a: { x: number; z: number }, b: { x: number; z: number }) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}

/** A polyline's points, evenly every so far along it (at most `max`, ends included). */
function resample(pts: { x: number; z: number }[], max: number): { x: number; z: number }[] {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const n = Math.max(2, Math.min(max, Math.ceil(len / 2) + 1));
  const out: { x: number; z: number }[] = [];
  let seg = 1, segStart = 0;
  for (let k = 0; k < n; k++) {
    const s = (len * k) / (n - 1);
    while (seg < pts.length - 1 && segStart + Math.hypot(pts[seg].x - pts[seg - 1].x, pts[seg].z - pts[seg - 1].z) < s) {
      segStart += Math.hypot(pts[seg].x - pts[seg - 1].x, pts[seg].z - pts[seg - 1].z);
      seg++;
    }
    const a = pts[seg - 1], b = pts[seg], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, t = Math.min(1, Math.max(0, (s - segStart) / l));
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

/** If the manhole's model didn't load: a dark disc with a lid on it. */
function fallbackCover(): Container3D {
  const root = new Container3D({ label: "manhole-fallback" });
  const iron = new Material3D({ baseColor: 0x4a4d57, roughness: 0.7, metallic: 0 });
  const dark = new Material3D({ baseColor: 0x14161c, roughness: 1, metallic: 0 });
  const hole = new Container3D({ label: "hole" });
  const hm = new Mesh3D({ geometry: new CylinderGeometry({ radiusTop: MANHOLE_R, radiusBottom: MANHOLE_R, height: 0.004, radialSegments: 20 }), material: dark, castShadow: false });
  hole.addChild(hm);
  const lid = new Container3D({ label: "lid" });
  const lm = new Mesh3D({ geometry: new CylinderGeometry({ radiusTop: MANHOLE_R, radiusBottom: MANHOLE_R, height: 0.035, radialSegments: 20 }), material: iron, castShadow: false });
  lm.position.set(0, 0.02, 0);
  lid.addChild(lm);
  root.addChild(hole, lid);
  return root;
}
