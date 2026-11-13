import { Box, Container3D, Material3D, Matrix4, Mesh3D, Vector3 } from "@pixi/3d";
import { Container, Point, Text, type Ticker } from "pixi.js";
import { CAR_FUSE_MS, CAR_TYPES, GRAVITY, JUMP_VELOCITY, RUN_SPEED, WALK_SPEED, WALL_SPEED, Weapon, ZOOMIES_SPEED } from "../../shared/constants.js";
import { mulberry32 } from "../../shared/map.js";
import { packOutfit } from "../../shared/outfit.js";
import { newZoneState } from "../../shared/zone.js";
import { find, groundTexture, instance } from "../assets.js";
import { Ch, type AnimEvent } from "../anim/Animator.js";
import type { Game } from "../Game.js";
import { MeshBuilder } from "../gfx/MeshBuilder.js";
import { CarView } from "../views/CarView.js";
import { CharacterView, type CharState } from "../views/CharacterView.js";
import { humanLook, raccoonLook, type Look, type Role } from "../views/looks.js";

/**
 * `?gallery=1`: a dev page instead of the game. Every character look, animation state and
 * face, every car with a driver, and the loot and props, on a patch of pavement with the
 * fumes behind them: for tuning poses, checking new models, and golden screenshots. `&t=2.5` steps everything 2.5 s at a fixed 60 Hz (seeded random) and
 * then holds still, so two runs draw the same frame. `&row=N` centres the camera on row N
 * (`&col=M` on one cell of it), `&zoom=12` brings it closer, `&yaw=` / `&pitch=` (radians)
 * turn it round the focus and `&fy=` lifts the focus (close-ups of a face, say); `&solo=1`
 * shows only that row's cell (or lab lane).
 *
 * After the props comes the motion lab: raccoons on lanes, moved by the game's own foot
 * physics, to judge walking, running and jumping in motion (see `Lane`).
 */

interface Cell {
  label: string;
  look: Look;
  weapon?: number;
  expr?: number;
  /** The animation input at time t (position and facing are filled in). */
  input?: (t: number) => Partial<CharState>;
  /** A one-shot event, every `every` seconds. */
  event?: AnimEvent;
  every?: number;
}

const ROLES: Role[] = ["jogger", "office", "chef", "granny", "kid", "pest", "tourist"];
const EXPRS = ["neutral", "blink", "happy", "ouch", "KO", "panic", "determined", "mischief"];

function rows(): Cell[][] {
  const coon = raccoonLook(3), human = humanLook(5, "office");
  const air = (t: number) => ({ pose: "air" as const, vy: 5 - ((t * 9.8) % 10) });
  // the start screen's outfit pieces (shades, bow tie, headphones, cone), worn in the poses that bring them closest
  const dressed = (fur: number, head: number, face: number, neck: number, back: number, acc: number) =>
    raccoonLook(packOutfit({ fur, belly: 0, head, face, neck, back, acc }));
  return [
    [
      ...Array.from({ length: 8 }, (_, i) => ({ label: `raccoon #${i + 1}`, look: raccoonLook(i * 7 + 1) })),
      { label: "shades", look: dressed(0, 0, 1, 0, 0, 0) },
      { label: "bow tie", look: dressed(4, 0, 0, 2, 0, 2) },
      { label: "headphones", look: dressed(5, 5, 0, 0, 0, 3) },
      { label: "cone", look: dressed(6, 6, 0, 0, 0, 6) },
      { label: "outfit zoomies", look: dressed(10, 6, 1, 2, 0, 7), input: () => ({ speed: ZOOMIES_SPEED, zoomies: true }) },
      { label: "outfit taunt", look: dressed(9, 5, 1, 0, 1, 1), event: "taunt", every: 2.2 },
      { label: "outfit KO", look: dressed(10, 6, 1, 2, 0, 7), input: () => ({ pose: "lying" }) },
      { label: "outfit drive", look: dressed(9, 5, 1, 2, 1, 1), input: (t) => ({ pose: "sit", steer: Math.sin(t * 1.5) }) },
    ],
    [
      ...ROLES.map((role, i) => ({ label: role, look: humanLook(i * 13 + 2, role) })),
      { label: "panic!", look: humanLook(77, "tourist"), input: () => ({ speed: 4.2, panic: true }) },
      { label: "kid panic", look: { ...humanLook(4, "kid"), accessories: ["acc_cap", "acc_backpack", "acc_balloon"] }, input: () => ({ speed: 4.2, panic: true }) },
    ],
    [
      { label: "idle", look: coon },
      { label: "walk", look: coon, input: () => ({ speed: 2.4 }) },
      { label: "sprint", look: coon, input: () => ({ speed: RUN_SPEED }) },
      { label: "armed sprint", look: coon, weapon: Weapon.Smg, input: () => ({ speed: RUN_SPEED, aiming: true }) },
      { label: "zoomies", look: coon, input: () => ({ speed: ZOOMIES_SPEED, zoomies: true }) },
      { label: "armed zoomies", look: coon, weapon: Weapon.Smg, input: () => ({ speed: ZOOMIES_SPEED, zoomies: true }) },
      { label: "zoomies, no sack", look: { ...coon, accessories: ["acc_beanie"] }, input: () => ({ speed: ZOOMIES_SPEED, zoomies: true }) },
      { label: "jump", look: coon, input: air },
      { label: "long fall", look: coon, input: () => ({ pose: "air", vy: -12 }) },
      { label: "surf", look: coon, input: (t) => ({ ride: true, platSpeed: 12, platAx: Math.sin(t * 1.3) * 7, platAz: Math.cos(t * 0.9) * 3 }) },
      { label: "drive", look: coon, input: (t) => ({ pose: "sit", steer: Math.sin(t * 1.5), accF: Math.sin(t * 0.7) * 6, accL: Math.cos(t * 1.5) * 5 }) },
      { label: "dance", look: coon, input: () => ({ dance: true }) },
      { label: "surf, parked", look: coon, input: () => ({ ride: true }) },
    ],
    [
      { label: "pop-gun", look: coon, weapon: Weapon.Pistol, input: () => ({ aiming: true }), event: "fire", every: 0.6 },
      { label: "cap blaster", look: coon, weapon: Weapon.Smg, input: () => ({ aiming: true }), event: "fire", every: 0.15 },
      { label: "blunderbuss", look: coon, weapon: Weapon.Shotgun, input: () => ({ aiming: true }), event: "fire", every: 1.2 },
      { label: "paw slap", look: coon, weapon: Weapon.Fists, event: "slap", every: 0.9 },
      // wound up over 0.9 s (then held at full, trembling), thrown on the 1.6 s beat
      { label: "stink bomb", look: coon, weapon: Weapon.Grenade, input: (t) => ({ aiming: true, windup: t % 1.6 < 0.5 ? 0 : Math.min(1, (t % 1.6 - 0.5) / 0.9) }), event: "throw", every: 1.6 },
      { label: "taunt", look: coon, event: "taunt", every: 2.2 },
      { label: "tumble", look: coon, input: () => ({ pose: "ragdoll" }) },
      { label: "KO", look: coon, input: () => ({ pose: "lying" }) },
    ],
    [
      { label: "pancake", look: coon, event: "flatten", every: 3 },
      { label: "hurt", look: coon, event: "hurt", every: 1.5 },
      { label: "grab", look: coon, event: "pickup", every: 1.5 },
      { label: "jump + land", look: coon, event: "jump", every: 1.4, input: (t) => (t % 1.4 < 0.7 ? { pose: "air", vy: 4.5 - (t % 1.4) * 13 } : {}) },
      { label: "human drive", look: human, input: (t) => ({ pose: "sit", steer: Math.sin(t * 1.5) }) },
      { label: "human tumble", look: human, input: () => ({ pose: "ragdoll" }) },
      { label: "human KO", look: human, input: () => ({ pose: "lying" }) },
      { label: "human pancake", look: human, event: "flatten", every: 3 },
      // on a wall (it would be in front of them, facing +z): up it, along it, down it, hanging on
      { label: "wall: up", look: coon, input: () => ({ pose: "wall", wallUp: WALL_SPEED, zoomies: true }) },
      { label: "wall: along", look: coon, input: () => ({ pose: "wall", wallSide: WALL_SPEED, zoomies: true }) },
      { label: "wall: down", look: coon, input: () => ({ pose: "wall", wallUp: -WALL_SPEED, zoomies: true }) },
      { label: "wall: hold", look: coon, input: () => ({ pose: "wall", zoomies: true }) },
    ],
    EXPRS.map((name, i) => ({ label: name, look: coon, expr: i })),
    EXPRS.map((name, i) => ({ label: name, look: human, expr: i })),
  ];
}

/**
 * A motion-lab lane: one raccoon moved by `stepFoot`'s own numbers (acceleration, top
 * speeds, turning, jump and gravity) from a script of stick, sprint, zoomies and jump presses.
 */
interface Lane {
  label: string;
  look: Look;
  weapon?: number;
  /** The script's length (s). It then starts over, where it began. */
  period: number;
  /** The stick (x along the lane, z across it), sprint and the zoomies, `t` s into the script. */
  stick: (t: number) => { mx: number; mz?: number; sprint?: boolean; zoomies?: boolean };
  /** When jump is pressed (s into the script). */
  jumps?: number[];
  /** When the gun goes off (s into the script): facing the aim to shoot, even with the zoomies. */
  shots?: number[];
  /** Holding a gun aimed this way (yaw) throughout: the body faces it, the legs strafe. */
  aim?: number;
  /** A roof this high up to `at` m along the lane (the lane starts on it): a fall off its edge. */
  ledge?: { at: number; h: number };
  /** Where along x the run is centred (default the middle): out of the other lanes' views. */
  x?: number;
}

function lanes(): Lane[] {
  const coon = raccoonLook(3);
  // out for `go` s, stop for `rest`, back for `go`, stop for `rest`
  const outBack = (go: number, rest: number, sprint = false, zoomies = false) => (t: number) =>
    ({ mx: t < go ? 1 : t < go + rest ? 0 : t < 2 * go + rest ? -1 : 0, sprint, zoomies });
  // the gallop needs the zoomies (a coffee): these lanes have them throughout, or for a second
  return [
    { label: "walk, stop", look: coon, period: 6.2, stick: outBack(2.2, 0.9) },
    { label: "zoomies, stop", look: coon, period: 5, stick: outBack(1.5, 1, false, true) },
    {
      label: "run, zoomies, run", look: coon, period: 7,
      stick: (t) => { const u = t % 3.5; return { mx: (t < 3.5 ? 1 : -1) * (u < 2.7 ? 1 : 0), zoomies: u > 0.9 && u < 1.9 }; },
    },
    { label: "jump on the spot", look: coon, period: 1.8, stick: () => ({ mx: 0 }), jumps: [0.3] },
    { label: "running jumps", look: coon, period: 6.2, stick: outBack(2.2, 0.9), jumps: [0.6, 1.5, 3.7, 4.6] },
    { label: "zoomies jumps", look: coon, period: 5, stick: outBack(1.5, 1, false, true), jumps: [0.5, 3.0] },
    { label: "off a train roof", look: coon, period: 3, stick: (t) => ({ mx: t < 1.6 ? 1 : 0 }), ledge: { at: 2.5, h: 3 }, x: 20 },
    {
      label: "zig-zag", look: coon, period: 6.4,
      stick: (t) => { const u = t % 3.2, go = u < 2.6; return { mx: (t < 3.2 ? 1 : -1) * (go ? 1 : 0), mz: go ? (Math.floor(u / 0.65) % 2 ? 0.9 : -0.9) : 0 }; },
    },
    { label: "no sack: zoomies, jumps", look: { ...coon, accessories: ["acc_beanie"] }, period: 5, stick: outBack(1.5, 1, false, true), jumps: [0.6, 3.1] },
    { label: "armed: run, strafe", look: coon, weapon: Weapon.Smg, aim: 0, period: 6.2, stick: outBack(2.2, 0.9) },
    // (new lanes go last, so the rows above keep their numbers)
    { label: "sprint, stop (Shift: two legs)", look: coon, period: 5, stick: outBack(1.5, 1, true) },
    { label: "armed zoomies: gallop, shoot", look: coon, weapon: Weapon.Pistol, aim: 0, period: 5, stick: outBack(1.5, 1, false, true), shots: [0.7, 3.2] },
  ];
}

/** Points traced on a character (`trace()`): a node, and where on its own mesh. */
const TRACE_POINTS: [string, string, "sole" | "toe" | "heel" | "origin" | "centre" | "top" | "back"][] = [
  ["footL", "foot_l", "sole"], ["toeL", "foot_l", "toe"], ["heelL", "foot_l", "heel"],
  ["footR", "foot_r", "sole"], ["toeR", "foot_r", "toe"], ["heelR", "foot_r", "heel"],
  ["handL", "hand_l_socket", "origin"], ["handR", "hand_r_socket", "origin"],
  ["head", "head", "centre"], ["earL", "ear_l", "top"], ["earR", "ear_r", "top"],
  ["tail", "tail_2", "back"], ["hips", "hips", "origin"], ["chest", "torso", "centre"],
];

export function startGallery(game: Game, params: URLSearchParams) {
  const { app, view3d, rig, tilt, city, trains, fx, zoneView, hud } = game.devScene();
  const hold = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : null;
  // the same frame every run: the animators' idle randomness comes from a seeded stream
  if (hold !== null) Math.random = mulberry32(0x9a11e7);

  city.root.visible = false;
  trains.root.visible = false;
  hud.root.visible = false;

  const DX = 2.6, DZ = 3.6;
  const grid = rows();
  const lab = lanes();
  // after the characters: the cars (with drivers), the loot and props, then the lab's lanes
  const LAB = grid.length + 2;
  const nRows = LAB + lab.length;
  const rowZ = (j: number) => (j - (nRows - 1) / 2) * DZ;
  // every car, side on with the driver's door to the camera: raccoons drive, and people of every role
  const drivers: [number, Look][] = [
    [0, raccoonLook(11)], [0, humanLook(31, "office")], [1, raccoonLook(12)], [1, humanLook(32, "tourist")], [1, humanLook(36, "kid")],
    [2, humanLook(9, "pest")], [2, raccoonLook(13)], [3, humanLook(3, "chef")], [3, humanLook(33, "granny")],
  ];
  const CAR_DX = 5.4;
  // (and after them, a taxi that blows up on a loop)
  const nCars = drivers.length + 1;
  const carX = (i: number) => (i - (nCars - 1) / 2) * CAR_DX;
  const width = Math.max(Math.max(...grid.map((r) => r.length)) * DX, nCars * CAR_DX) + 6;
  const depth = nRows * DZ;

  // the lab's lanes: where each script's run is centred (a dry run finds its extent)
  type Runner = {
    lane: Lane; view: CharacterView; x0: number; z0: number; t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
    yaw: number; grounded: boolean; zoomies: boolean; firing: number;
  };
  const restart = (r: Runner) => {
    r.t = 0; r.x = r.x0; r.y = r.lane.ledge?.h ?? 0; r.z = r.z0;
    r.vx = r.vy = r.vz = 0; r.yaw = r.lane.aim ?? Math.PI / 2; r.grounded = true; r.zoomies = false; r.firing = 0;
  };
  const turn = (from: number, to: number, max: number) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
    return from + Math.max(-max, Math.min(max, d));
  };
  /** One step of the lane's script, with `stepFoot`'s own movement numbers. */
  const runStep = (r: Runner, dt: number) => {
    const ln = r.lane, prev = r.t;
    let t = prev + dt;
    if (t >= ln.period) {
      t -= ln.period;
      // off the roof: back up on it for the next go (out-and-back scripts end where they began)
      if (ln.ledge) restart(r);
    }
    r.t = t;
    const c = ln.stick(t);
    let mx = c.mx, mz = c.mz ?? 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    r.zoomies = !!c.zoomies;
    const speed = r.zoomies ? ZOOMIES_SPEED : c.sprint ? RUN_SPEED : WALK_SPEED;
    const k = Math.min(1, (r.grounded ? 16 : 5) * dt);
    r.vx += (mx * speed - r.vx) * k;
    r.vz += (mz * speed - r.vz) * k;
    const pressed = (j: number) => (prev <= t ? prev < j && j <= t : j > prev || j <= t);
    // a shot: facing the aim for it (the step turns you to the mouse while you fire)
    if (ln.shots?.some(pressed)) { r.firing = 0.15; r.view.event("fire"); }
    r.firing = Math.max(0, r.firing - dt);
    if (ln.aim !== undefined && (!r.zoomies || r.firing > 0)) r.yaw = turn(r.yaw, ln.aim, 20 * dt);
    else if (ml > 0.1) r.yaw = turn(r.yaw, Math.atan2(mx, mz), 14 * dt);
    if (r.grounded && ln.jumps?.some(pressed)) {
      r.vy = JUMP_VELOCITY;
      r.grounded = false;
      r.view.event("jump");
    }
    r.vy -= GRAVITY * dt;
    r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    const ground = ln.ledge && r.x - r.x0 < ln.ledge.at ? ln.ledge.h : 0;
    if (r.y <= ground) { r.y = ground; r.vy = 0; r.grounded = true; } else r.grounded = false;
  };
  const runners: Runner[] = lab.map((lane, i) => {
    const r: Runner = {
      lane, view: null as unknown as CharacterView, x0: 0, z0: rowZ(LAB + i), t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, grounded: true,
      zoomies: false, firing: 0,
    };
    restart(r);
    // a dry run (without a view: no events) to centre the run on the lane
    let lo = 0, hi = 0;
    const view = { event() {} } as unknown as CharacterView;
    r.view = view;
    for (let k = 0; k < Math.round(lane.period * 60); k++) { runStep(r, 1 / 60); lo = Math.min(lo, r.x); hi = Math.max(hi, r.x); }
    r.x0 = -(lo + hi) / 2 + (lane.x ?? 0);
    restart(r);
    return r;
  });

  // a patch of pavement (the city ground's own shader: nothing new to compile)
  const b = new MeshBuilder(4);
  b.rect(-width / 2 - 4, -depth / 2 - 4, width / 2 + 4, depth / 2 + 4, 0, 0xecd9bd);
  // the lab's roofs, as high as a train's
  for (const r of runners) {
    const l = r.lane.ledge;
    if (l) b.box(r.x0 + l.at / 2 - 1, r.z0, Math.PI / 2, l.at + 2, 1.6, 0, l.h, 0x8a6d5a);
  }
  const ground = new Material3D({ baseColor: 0xffffff, roughness: 0.95, metallic: 0, baseColorTexture: groundTexture("paving"), vertexColors: true });
  view3d.root.addChild(new Mesh3D({ geometry: b.build(), material: ground, castShadow: false, receiveShadow: true }));

  // the fumes, closing in behind the back row
  const zone = newZoneState();
  zone.x = 0; zone.z = depth / 2 + 6; zone.r = depth + 9;
  zone.nx = 0; zone.nz = zone.z; zone.nr = zone.r * 0.6;

  const labels = new Container();
  app.stage.addChild(labels);
  const tags: { label: Text; x: number; z: number }[] = [];
  const tag = (text: string, x: number, z: number) => {
    const label = new Text({ text, style: { fontFamily: "Fredoka, sans-serif", fontSize: 12, fontWeight: "700", fill: 0x2b2340 } });
    label.anchor.set(0.5, 0);
    labels.addChild(label);
    tags.push({ label, x, z });
  };
  const cells: { cell: Cell; view: CharacterView; x: number; z: number; next: number }[] = [];
  /** Everything placed, by row and column (for `solo`), and its name tag. */
  const placed: { row: number; col: number; node: Container3D; tag: Text }[] = [];
  grid.forEach((row, j) => {
    row.forEach((cell, i) => {
      const view = new CharacterView(cell.look, { unique: cell.look.species === "raccoon" });
      if (cell.weapon !== undefined) view.setWeapon(cell.weapon);
      if (cell.expr !== undefined) view.anim.exprOverride = cell.expr as never;
      view3d.root.addChild(view.root);
      const x = (i - (row.length - 1) / 2) * DX, z = rowZ(j);
      tag(cell.label, x, z);
      cells.push({ cell, view, x, z, next: cell.every ?? Infinity });
      placed.push({ row: j, col: i, node: view.root, tag: tags[tags.length - 1].label });
    });
  });

  const cars = drivers.map(([kind, look], i) => {
    const car = new CarView(kind, CAR_TYPES[kind].paint[0]);
    car.setDriver(`gallery${i}`, look);
    view3d.root.addChild(car.root);
    const x = carX(i), z = rowZ(grid.length);
    tag(`${CAR_TYPES[kind].name} · ${look.role ?? "raccoon"}`, x, z + 1.2);
    placed.push({ row: grid.length, col: i, node: car.root, tag: tags[tags.length - 1].label });
    return { car, x, z, kind };
  });
  // the bomb: whole for BOMB_IDLE, the fuse, then the wreck's hop (the server's: up at 9 m/s, one
  // bounce at 0.3) and spin, and good as new again. Its car is swapped each loop (the char stays).
  const BOMB_IDLE = 1, BOMB_WRECK = 3, FUSE = CAR_FUSE_MS / 1000;
  const bomb = { holder: new Container3D(), car: null as CarView | null, x: carX(drivers.length), z: rowZ(grid.length), s: Infinity, blown: false, y: 0, vy: 0, yaw: -Math.PI / 2, spin: 0 };
  view3d.root.addChild(bomb.holder);
  tag("taxi · car bomb", bomb.x, bomb.z + 1.2);
  placed.push({ row: grid.length, col: drivers.length, node: bomb.holder, tag: tags[tags.length - 1].label });
  const stepBomb = (dt: number) => {
    bomb.s += dt;
    if (bomb.s >= BOMB_IDLE + FUSE + BOMB_WRECK) {
      bomb.car?.destroy();
      bomb.car = new CarView(1, CAR_TYPES[1].paint[1]);
      bomb.holder.addChild(bomb.car.root);
      bomb.s = 0; bomb.blown = false; bomb.y = 0; bomb.vy = 0; bomb.yaw = -Math.PI / 2; bomb.spin = 0;
    }
    const state = bomb.s < BOMB_IDLE ? 0 : bomb.s < BOMB_IDLE + FUSE ? 1 : 2;
    if (state === 2 && !bomb.blown) { bomb.blown = true; bomb.vy = 9; bomb.y = 0.05; bomb.spin = 2.5; fx.explosion(bomb.x, 0.8, bomb.z, 7); }
    if (bomb.y > 0 || bomb.vy > 0) {
      bomb.vy -= GRAVITY * dt;
      bomb.y += bomb.vy * dt;
      if (bomb.y <= 0) { bomb.y = 0; bomb.vy = bomb.vy < -5 ? -bomb.vy * 0.3 : 0; }
    } else bomb.spin *= Math.max(0, 1 - 4 * dt);
    bomb.yaw += bomb.spin * dt;
    if (state === 1) fx.burn(bomb.x, bomb.y + 1.2, bomb.z, dt);
    const car = bomb.car!;
    car.update(dt, { x: bomb.x, y: bomb.y, z: bomb.z, yaw: bomb.yaw, vx: 0, vz: 0, steer: 0, state, hp: state ? 0 : 100, siren: false });
    if (car.thud > 3) fx.dustPuff(bomb.x, 0, bomb.z, Math.round(car.thud * 2));
  };

  // the loot, the props, and the reigning champion
  const things: [string, (n: Container3D) => void, string?][] = [
    ["loot_can", () => {}],
    ["loot_can", (n) => { const lid = find(n, "lid"); if (lid) lid.rotation.set(-1.9, 0, 0); }, "loot_can (looted)"],
    ["trashcan", () => {}],
    ["trashcan", (n) => {
      // what a hider sees of their own can: the lid lifted, their eyes under it (BinsView)
      const lid = find(n, "lid"), peek = find(n, "peek");
      if (lid) { lid.position.y += 0.14; lid.rotation.set(-0.22, 0, 0); }
      if (peek) peek.visible = true;
    }, "trashcan (hiding)"],
    ["trashcan", (n) => {
      // knocked off: the lid on the ground beside it, upside down
      const lid = find(n, "lid");
      if (lid) { lid.position.set(0.75, 0.15, 0.55); lid.rotation.set(Math.PI, 0.6, 0); }
    }, "trashcan (lid off)"],
    ["food_pizza", (n) => { n.scale.set(1.6); n.position.y = 1.05; }],
    ["food_donut", (n) => { n.scale.set(1.6); n.position.y = 1.05; }],
    ["tombstone", () => {}],
    ["crown", (n) => { n.position.y = 0.4; }],
    ["dumpster", () => {}],
    ["trash_bags", () => {}],
  ];
  const thingX = (i: number) => (i - things.length / 2) * DX * 1.15;
  things.forEach(([name, setup, label], i) => {
    const n = instance(name);
    const peek = find(n, "peek");
    if (peek) peek.visible = false;
    setup(n);
    n.position.x = thingX(i);
    n.position.z = rowZ(grid.length + 1);
    view3d.root.addChild(n);
    tag(label ?? name, thingX(i), rowZ(grid.length + 1));
    placed.push({ row: grid.length + 1, col: i, node: n, tag: tags[tags.length - 1].label });
  });
  const champ = new CharacterView(raccoonLook(21), { unique: true });
  champ.setCrown(true);
  view3d.root.addChild(champ.root);
  const champX = thingX(things.length);
  tag("champion", champX, rowZ(grid.length + 1));
  placed.push({ row: grid.length + 1, col: things.length, node: champ.root, tag: tags[tags.length - 1].label });

  runners.forEach((r, i) => {
    r.view = new CharacterView(r.lane.look, { unique: true });
    if (r.lane.weapon !== undefined) r.view.setWeapon(r.lane.weapon);
    view3d.root.addChild(r.view.root);
    tag(`lab: ${r.lane.label}`, -width / 2 + 4, r.z0);
    placed.push({ row: LAB + i, col: 0, node: r.view.root, tag: tags[tags.length - 1].label });
  });

  // where the camera looks: `look()` moves it (also from a test harness, without a reload)
  let row: number | null = null, focusX = 0, focusY = 0, focusZ = 0;
  /** A lab lane the camera keeps up with. */
  let follow: Runner | null = null;
  // `solo`: only that one cell is shown (side views without the neighbours in the way)
  // `tags: false` hides every name tag (film frames); `follow: false` holds the camera where
  // a lab lane's raccoon is now instead of keeping up with it (onion skins)
  let shown: ((p: (typeof placed)[number]) => boolean) | null = null;
  // (again after every step: a character's update shows it)
  const showOnly = () => { if (shown) for (const p of placed) p.node.visible = shown(p); };
  const look = (o: { row?: number; col?: number; zoom?: number; yaw?: number; pitch?: number; fy?: number; solo?: boolean; tags?: boolean; follow?: boolean }) => {
    shown = o.solo ? (p) => p.row === o.row && (p.col === o.col || p.row >= LAB) : null;
    for (const p of placed) {
      const show = !shown || shown(p);
      p.node.visible = show;
      if (p.tag) p.tag.renderable = show && o.tags !== false;
    }
    row = o.row ?? null;
    const col = o.col ?? NaN;
    focusZ = row === null ? 0 : rowZ(row);
    follow = row !== null && row >= LAB ? runners[row - LAB] ?? null : null;
    // `col`: one cell of the row (characters, then the cars, then the things)
    focusX = row === null || !Number.isFinite(col) ? 0
      : row < grid.length ? (col - (grid[row].length - 1) / 2) * DX
      : row === grid.length ? (cars[col]?.x ?? (col === drivers.length ? bomb.x : 0))
      : row >= LAB ? 0
      : col < things.length ? thingX(col) : champX;
    focusY = o.fy ?? 0;
    // (not its height: the camera holds still while it jumps, so the arcs show)
    if (follow) { focusX = follow.x; focusZ = follow.z; }
    if (o.follow === false) follow = null;
    rig.base = rig.distance = Math.max(3, o.zoom ?? 25);
    // close-ups: pull the near plane in (the game keeps it at 6 m, past anything in front of the camera)
    view3d.camera.near = Math.min(6, rig.distance * 0.25);
    rig.yaw = o.yaw ?? Math.PI;
    rig.pitch = o.pitch ?? 0.88;
    rig.cut();
  };
  const num = (k: string) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
  look({ row: num("row"), col: num("col"), zoom: num("zoom"), yaw: num("yaw"), pitch: num("pitch"), fy: num("fy"), solo: params.get("solo") === "1" });
  const tmp = new Vector3(), screen = new Point();
  let t = 0;

  const step = (dt: number) => {
    t += dt;
    for (const c of cells) {
      if (t >= c.next) { c.view.event(c.cell.event!); c.next += c.cell.every!; }
      const input: CharState = { x: c.x, y: 0, z: c.z, yaw: 0, speed: 0, vy: 0, pose: "move", aiming: false, ...c.cell.input?.(t) };
      // treadmill: the walk cycle plays in place, facing the camera
      c.view.update(dt, input);
    }
    for (const c of cars) {
      c.car.update(dt, { x: c.x, y: 0, z: c.z, yaw: -Math.PI / 2, vx: 0, vz: 0, steer: Math.sin(t * 1.2), state: 0, hp: 100, siren: c.kind === 2 });
    }
    stepBomb(dt);
    champ.update(dt, { x: champX, y: 0, z: rowZ(grid.length + 1), yaw: 0, speed: 0, vy: 0, pose: "move", aiming: false, dance: true });
    for (const r of runners) {
      runStep(r, dt);
      r.view.update(dt, {
        x: r.x, y: r.y, z: r.z, yaw: r.yaw, speed: Math.hypot(r.vx, r.vz), vy: r.vy, vx: r.vx, vz: r.vz,
        pose: r.grounded ? "move" : "air", aiming: r.lane.aim !== undefined && (!r.zoomies || r.firing > 0), zoomies: r.zoomies,
      });
    }
    zoneView.update(dt, zone);
    showOnly();
  };
  // `&t=`: run up to the instant, then hold still
  if (hold !== null) for (let k = 0; k < Math.round(hold * 60); k++) step(1 / 60);

  app.ticker.add((ticker: Ticker) => {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);
    if (hold === null) step(dt);
    if (follow) { focusX = follow.x; focusZ = follow.z; }
    rig.update(dt, focusX, focusY, focusZ, 0, 0, row === null ? 1 : 0);
    tilt.focalDepth = rig.distance;
    fx.update(ticker);
    for (const c of tags) {
      const s = view3d.worldToScreen(tmp.set(c.x, 0, c.z + 0.9), screen);
      c.label.visible = !!s;
      if (s) c.label.position.set(s.x, s.y);
    }
  });
  // every character's pose as numbers (for overlap checks outside the browser)
  const poses = () => [
    ...placed.filter((p) => p.row < grid.length).map((p) => {
      const c = cells.find((c) => c.view.root === p.node)!;
      return { row: p.row, col: p.col, label: c.cell.label, ...c.view.snapshot() };
    }),
    { row: grid.length + 1, col: things.length, label: "champion", ...champ.snapshot() },
    ...cars.filter((c) => c.car.driver).map((c, i) => ({ row: grid.length, col: i, label: `driver of ${CAR_TYPES[c.kind].name}`, ...c.car.driver!.snapshot() })),
  ];
  // a character by gallery label ("walk") or lab label ("lab: walk, stop"), and where it is
  const who = (label: string): { view: CharacterView; at: () => { x: number; y: number; z: number; yaw: number }; input: () => Partial<CharState> } | null => {
    const r = runners.find((r) => `lab: ${r.lane.label}` === label);
    if (r) return { view: r.view, at: () => ({ x: r.x, y: r.y, z: r.z, yaw: r.yaw }), input: () => ({ speed: Math.hypot(r.vx, r.vz), vy: r.vy, pose: r.grounded ? "move" : "air" }) };
    const c = cells.find((c) => c.cell.label === label);
    if (c) return { view: c.view, at: () => ({ x: c.x, y: 0, z: c.z, yaw: 0 }), input: () => ({ ...c.cell.input?.(t) }) };
    return null;
  };
  // where each traced point sits on its node's own mesh (not its children's)
  const own = new Box();
  const anchor = (node: Container3D, where: (typeof TRACE_POINTS)[number][2]) => {
    if (where === "origin") return { x: 0, y: 0, z: 0 };
    const hidden = node.children.filter((c) => c.label !== "Mesh3D" && c.visible);
    for (const c of hidden) c.visible = false;
    node.getLocalBounds(own);
    for (const c of hidden) c.visible = true;
    const { min, max } = own;
    const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2, cz = (min.z + max.z) / 2;
    switch (where) {
      case "sole": return { x: cx, y: min.y, z: cz };
      case "toe": return { x: cx, y: min.y, z: max.z };
      case "heel": return { x: cx, y: min.y, z: min.z };
      case "top": return { x: cx, y: max.y, z: cz };
      case "back": return { x: cx, y: cy, z: min.z };
      default: return { x: cx, y: cy, z: cz };
    }
  };
  /**
   * Step everything `frames` × 1/60 s and record, every frame, for each labelled character:
   * the traced points (world), its animation channels, root and input. For the motion tools.
   */
  const trace = (labels: string[], frames: number) => {
    const subjects = labels.map((label) => {
      const w = who(label);
      if (!w) throw new Error(`no character "${label}"`);
      const pts = TRACE_POINTS.map(([name, node, where]) => {
        const n = find(w.view.root, node);
        return { name, node: n, local: n ? anchor(n, where) : null };
      });
      return { label, w, pts, out: { t: [] as number[], root: [] as number[][], ch: [] as number[][], spring: [] as number[][], input: [] as Partial<CharState>[], pts: Object.fromEntries(pts.map((p) => [p.name, [] as number[][]])) } };
    });
    // the lowest point of a foot's (or a front paw's) mesh, from its vertices
    const lowNodes = ["foot_l", "foot_r", "forearm_l", "forearm_r"] as const;
    const lowKeys = ["lowL", "lowR", "pawL", "pawR"] as const;
    const meshesOf = (n: Container3D | null) => !n ? [] : [n, ...n.children].filter((c): c is Mesh3D => c instanceof Mesh3D && (c === n || c.label === "Mesh3D"));
    const m4 = new Matrix4();
    const lowest = (meshes: Mesh3D[]) => {
      let best: number[] | null = null;
      for (const m of meshes) {
        const pos = m.geometry.positions, e = m.getGlobalTransform(m4).elements;
        for (let q = 0; q + 2 < pos.length; q += 3) {
          const x = pos[q], y = pos[q + 1], z = pos[q + 2];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          if (!best || wy < best[1]) best = [e[0] * x + e[4] * y + e[8] * z + e[12], wy, e[2] * x + e[6] * y + e[10] * z + e[14]];
        }
      }
      return best;
    };
    const lows = subjects.map((s) => lowNodes.map((n) => meshesOf(find(s.w.view.root, n))));
    for (const s of subjects) for (const k of lowKeys) s.out.pts[k] = [];
    const v = new Vector3();
    for (let k = 0; k < frames; k++) {
      step(1 / 60);
      for (const s of subjects) {
        const a = s.w.at();
        s.out.t.push(t);
        s.out.root.push([a.x, a.y, a.z, a.yaw]);
        s.out.ch.push(Array.from(s.w.view.anim.out, (x) => Math.round(x * 1e5) / 1e5));
        // (the springs alone, before the gait's cycle and the planting: for debugging)
        s.out.spring.push(Array.from(s.w.view.anim.s.x, (x) => Math.round(x * 1e5) / 1e5));
        s.out.input.push(s.w.input());
        for (const p of s.pts) {
          if (!p.node || !p.local) continue;
          p.node.toGlobal(p.local, v);
          s.out.pts[p.name].push([v.x, v.y, v.z].map((x) => Math.round(x * 1e5) / 1e5));
        }
        lowKeys.forEach((key, n) => {
          const low = lowest(lows[subjects.indexOf(s)][n]);
          if (low) s.out.pts[key].push(low.map((x) => Math.round(x * 1e5) / 1e5));
        });
      }
    }
    return Object.fromEntries(subjects.map((s) => [s.label, s.out]));
  };
  /** Where a character is on screen (CSS px), for cropping film frames round it. */
  const onScreen = (label: string, h = 1.6) => {
    const w = who(label);
    if (!w) return null;
    const a = w.at();
    const lo = view3d.worldToScreen(tmp.set(a.x, a.y, a.z), new Point());
    const hi = view3d.worldToScreen(tmp.set(a.x, a.y + h, a.z), new Point());
    return lo && hi ? { x: lo.x, y: lo.y, topX: hi.x, topY: hi.y } : null;
  };
  (window as unknown as { __gallery: unknown }).__gallery = { cells, step, look, poses, time: () => t, trace, onScreen,
    channels: Object.entries(Ch).sort((a, b) => a[1] - b[1]).map(([k]) => k),
    lanes: runners.map((r, i) => ({ row: LAB + i, label: `lab: ${r.lane.label}`, period: r.lane.period })) };
}
