import { Vector3 } from "@pixi/3d";
import { Point, type Ticker } from "pixi.js";
import { GRAVITY, JUMP_VELOCITY } from "../shared/constants.js";
import { CITY, nearestBin } from "../shared/map.js";
import type { Game } from "./Game.js";
import { sfx } from "./Sfx.js";
import { CharacterView } from "./views/CharacterView.js";
import { raccoonLook } from "./views/looks.js";

/**
 * Where the raccoon poses for the start screen: next to the trash can nearest the town's menu
 * spot (`CITY.landmarks.menu`, on the plaza), offset dx / dz, turned `face` (world yaw), with
 * the camera looking along `yaw` (see `CameraRig`), `pitch` up. Picked from screenshots: the
 * fountain and the houses behind it, and no lamp post or tree between the camera and the raccoon.
 */
const SPOT = { dx: -1.15, dz: 0.35, face: Math.PI - 0.05, yaw: 0.6, pitch: 0.2, height: 0.62 };
/** How tall the raccoon stands in the stage element (more of a short stage). */
const FILL = (stageH: number) => Math.min(0.65, Math.max(0.45, 0.45 + (520 - stageH) / 900));
/** Metres of raccoon (and hat) to fit. */
const TALL = 1.55;
/** Where your name floats (m): just over the tallest hat (the cone, 1.52). */
const TAG_Y = 1.62;

/**
 * The start screen's live preview: the player's raccoon by a trash can in the real town
 * (the game's own scene and camera, so nothing new to compile), framed into the menu's
 * `stage` element, the town blurred behind it. It hops when its outfit changes, and a drag
 * on the stage turns it round, `tag` (your name) floats over its head, and `button` (DRESS
 * ME UP!) and `hint` (drag to spin) at its feet. When the stage changes size (the wardrobe
 * opening) the camera glides to the new framing. `dispose()` hands the scene back to the game.
 */
export class MenuStage {
  private view: CharacterView;
  private x = 0;
  private z = 0;
  private y = 0;
  private vy = 0;
  private face = SPOT.face;
  private spin = 0;
  private dragX: number | null = null;
  private t = 0;
  private readonly tick = (ticker: Ticker) => this.update(ticker);
  private readonly off: (() => void)[] = [];
  private readonly tmp = new Vector3();
  private readonly screen = new Point();
  /** The camera's distance for this stage size. */
  private dist = 5;

  constructor(
    private game: Game, private look: number, private stage: HTMLElement,
    private tag: HTMLElement | null = null, private hint: HTMLElement | null = null, private button: HTMLElement | null = null,
  ) {
    const { app, view3d, hud, zoneView } = game.devScene();
    this.view = new CharacterView(raccoonLook(look), { unique: true });
    view3d.root.addChild(this.view.root);
    hud.root.visible = false;
    zoneView.update(0, null);
    this.frame();
    app.ticker.add(this.tick);

    // drag to spin; let go and it turns back to face you
    const listen = <K extends keyof WindowEventMap>(target: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.off.push(() => target.removeEventListener(type, fn as EventListener));
    };
    listen(stage, "pointerdown", (e) => { this.dragX = e.clientX; stage.setPointerCapture(e.pointerId); stage.classList.add("dragging"); });
    listen(stage, "pointermove", (e) => {
      if (this.dragX === null) return;
      this.face += (e.clientX - this.dragX) * 0.012;
      this.spin = (e.clientX - this.dragX) * 0.012;
      this.dragX = e.clientX;
    });
    const up = () => { this.dragX = null; stage.classList.remove("dragging"); };
    listen(stage, "pointerup", up);
    listen(stage, "pointercancel", up);
    listen(window, "resize", () => this.frame());
    // the stage itself resized (the wardrobe opening or closing): glide there
    const resized = new ResizeObserver(() => this.frame(false));
    resized.observe(stage);
    this.off.push(() => resized.disconnect());
  }

  /** The wardrobe opened (a hop) or closed (a pose, and a chitter: looking good). */
  dressing(open: boolean) {
    if (open) {
      this.view.event("hop");
      sfx.pickup();
    } else {
      this.view.event("taunt");
      sfx.chitter(this.x, this.z);
    }
  }

  /** Try a look on without keeping it (a colour hovered in the menu), quietly; null: back to the outfit. */
  preview(look: number | null) {
    this.view.restyle(raccoonLook(look ?? this.look));
  }

  /** A new outfit: dressed in place, with a little hop (and a puff of sparkles). */
  setLook(look: number, fanfare = false) {
    this.look = look;
    this.view.restyle(raccoonLook(look));
    if (fanfare) {
      this.view.event("taunt");
      this.game.devScene().fx.poof(this.x, 0.7, this.z);
      sfx.chitter(this.x, this.z);
    } else {
      this.view.event("hop");
      this.game.devScene().fx.sparkle(this.x, 1.25, this.z, this.view.look.colors.Acc ?? 0xffe066);
      sfx.pickup();
    }
  }

  /** Off it goes (PLAY). */
  jump() {
    if (this.y > 0) return;
    this.vy = JUMP_VELOCITY;
    this.view.event("jump");
    sfx.jump();
  }

  /**
   * Point the camera so the raccoon stands in the middle of the stage element, filling it:
   * there at once (`cut`), or gliding there (the stage changed size).
   */
  private frame(cut = true) {
    const { rig, view3d, tilt } = this.game.devScene();
    const r = this.stage.getBoundingClientRect(), H = innerHeight;
    const tan = Math.tan((view3d.camera.fov * Math.PI) / 360);
    this.dist = (TALL * H) / (2 * tan * FILL(r.height) * Math.max(120, r.height));
    rig.base = this.dist;
    if (!cut) return;
    const at = CITY.landmarks.menu, i = nearestBin(at.x, 0, at.z, 8);
    const bin = CITY.bins[i] ?? at;
    this.x = bin.x + SPOT.dx;
    this.z = bin.z + SPOT.dz;
    sfx.listener.x = this.x;
    sfx.listener.z = this.z;
    rig.yaw = SPOT.yaw;
    rig.pitch = SPOT.pitch;
    rig.distance = this.dist;
    view3d.camera.near = 0.3;
    tilt.focalDepth = this.dist;
    rig.cut();
  }

  private focus() {
    const { rig, view3d } = this.game.devScene();
    const W = innerWidth, H = innerHeight;
    const r = this.stage.getBoundingClientRect();
    // where the stage's centre is on screen, and how big the view is at the raccoon
    // (a little below the middle: your name floats over its head)
    const fx = (r.left + r.width / 2) / W, fy = (r.top + r.height * 0.6) / H;
    const halfH = Math.tan((view3d.camera.fov * Math.PI) / 360) * rig.distance;
    const halfW = (halfH * W) / H;
    const right = rig.right, side = (0.5 - fx) * 2 * halfW;
    return { x: this.x + right.x * side, y: SPOT.height - (0.5 - fy) * 2 * halfH * Math.cos(SPOT.pitch), z: this.z + right.z * side };
  }

  private update(ticker: Ticker) {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);
    const { rig, tilt, city, trains, bins, fx, view3d } = this.game.devScene();
    this.t += dt;
    // a turntable: spun by a drag, eased back to the pose when let go
    if (this.dragX === null) {
      let d = (SPOT.face - this.face) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      this.face += d * (1 - Math.exp(-2.2 * dt));
    }
    const grounded = this.y <= 0 && this.vy <= 0;
    if (!grounded) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.view.event("land"); sfx.land(); }
    }
    this.view.update(dt, {
      x: this.x, y: this.y, z: this.z, yaw: this.face, speed: 0, vy: this.vy, pose: this.y > 0 ? "air" : "move", aiming: false,
    });
    const now = performance.now();
    trains.update(dt, now);
    city.update(dt, now, this.x, this.z);
    const cam = view3d.camera.position;
    bins.update(dt, null, null, { x: cam.x, z: cam.z }, () => false);
    const f = this.focus();
    // (zooming as quickly as it pans, when the stage changes size)
    rig.update(dt, f.x, f.y, f.z, 0, 0, 0, 0, 0, 6);
    tilt.focalDepth = rig.distance;
    fx.update(ticker);
    // your name over its head, like the name tags in the game: at one height, over the
    // tallest hat, so it stays put whatever the raccoon wears (and when it hops)
    this.pin(this.tag, TAG_Y);
    // and DRESS ME UP! and the hint on the ground at its feet (the same when it hops)
    this.pin(this.button, 0);
    this.pin(this.hint, 0);
  }

  /** Put `el` (a child of the full-window menu) on screen where the raccoon is, `y` metres up. */
  private pin(el: HTMLElement | null, y: number) {
    const s = el && this.game.devScene().view3d.worldToScreen(this.tmp.set(this.x, y, this.z), this.screen);
    if (!el || !s) return;
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
  }

  /** Hand the scene back to the game (its camera, the HUD), the preview raccoon gone. */
  dispose() {
    const { app, rig, view3d, hud } = this.game.devScene();
    app.ticker.remove(this.tick);
    for (const off of this.off) off();
    this.view.destroy();
    hud.root.visible = true;
    view3d.camera.near = 6;
    rig.yaw = Math.PI;
    rig.pitch = 0.88;
    rig.base = rig.distance = 25;
    rig.cut();
  }

  /** Dev: tune the shot from the console (`__menu.tune({ dist: 6 })`). */
  tune(o: Partial<typeof SPOT>) {
    Object.assign(SPOT, o);
    this.frame();
  }
}
