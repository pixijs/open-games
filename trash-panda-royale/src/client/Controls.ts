/** A G tap keeps the stink bomb's wind-up asked for until it starts, at most this long (ms). */
const NADE_TAP_MS = 150;

/** What the player last touched: the hints show its keys, or its buttons. */
export type Device = "keys" | "pad";
/** Whose buttons a pad has: the layout is the same, the labels and colours differ. */
export type PadStyle = "xbox" | "ps" | "nintendo";

/** Standard-mapping buttons, by where they sit (named as on an Xbox pad). */
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9, L3: 10, R3: 11, Up: 12, Down: 13, Left: 14, Right: 15 } as const;

/** A trigger or a stick this far in counts as the player picking up the pad. */
const WAKE = 0.5;
/** Mouse travel (px) that hands the hints back to the keyboard while a pad is in use (a nudged desk doesn't). */
const MOUSE_WAKE = 80;
/** The right stick takes over the aim past AIM_ON, and lets go of it under AIM_OFF (no flicker as it springs back). */
const AIM_ON = 0.45, AIM_OFF = 0.3;

/** A stick past its dead zone, rescaled so it still reaches 1: radial, so it doesn't snap to the axes. */
function stick(x: number, y: number, dead = 0.2) {
  const m = Math.hypot(x, y);
  if (m < dead) return { x: 0, y: 0, m: 0 };
  const k = Math.min(1, (m - dead) / (0.95 - dead));
  return { x: (x / m) * k, y: (y / m) * k, m: k };
}

/** A trigger past a small dead zone (0..1). */
function trigger(v: number) {
  return v < 0.06 ? 0 : Math.min(1, (v - 0.06) / 0.9);
}

/** Pressed, with the analog triggers pressed only past a third of their travel. */
function held(p: Gamepad, i: number) {
  const b = p.buttons[i];
  if (!b) return false;
  return i === BTN.LT || i === BTN.RT ? b.value > 0.3 : b.pressed;
}

function padStyle(id: string): PadStyle {
  if (/054c|playstation|dualshock|dualsense/i.test(id)) return "ps";
  if (/057e|nintendo|pro controller|joy-con/i.test(id)) return "nintendo";
  return "xbox";
}

/**
 * Keyboard + mouse + gamepad. Held buttons are sampled live by each fixed step;
 * taps (E, number keys, jump) are BUFFERED when they happen and consumed by
 * exactly one step — the netcode "buffer, then consume" recipe — so a tap on a
 * frame with zero due steps isn't lost and a multi-step frame doesn't double it.
 * Pad buttons are polled once a frame (`poll`) and buffered the same way.
 *
 * It also keeps track of which `device` is in use: a pad button (or a stick pushed
 * well over) hands the hints to the pad, a key or a click hands them back.
 */
export class Controls {
  private keys = new Set<string>();
  mouseX = innerWidth / 2;
  mouseY = innerHeight / 2;
  mouseDown = false;
  /** Pointer is over the game (not a menu). */
  active = false;

  private useBuffered = false;
  private jumpBuffered = false;
  /** When G last went down (ms): a tap is held until the wind-up starts (at most `NADE_TAP_MS`). */
  private nadeAt = -Infinity;
  private weaponBuffered: number | null = null;
  private wheel = 0;
  /** LB / RB taps: the previous / next weapon, on foot only (in a car LB shoots and RB is the handbrake). */
  private shoulderWheel = 0;
  /** Left clicks since the last `consumeClicks()` (spectators switch whom they watch). */
  private clicks = 0;
  onKey: ((code: string) => void) | null = null;
  /** A pad button went down (its standard index), in the game or on the menu. */
  onPadButton: ((button: number) => void) | null = null;

  device: Device = "keys";
  padStyle: PadStyle = "xbox";
  private deviceListeners: (() => void)[] = [];
  /** The pad we read: the last one pressed. */
  private padIndex = -1;
  /** Per pad: its buttons, and whether a stick or trigger was over WAKE, last poll (edges only: a pad at rest never takes over). */
  private padPrev = new Map<number, { buttons: boolean[]; awake: boolean }>();
  private mouseTravel = 0;

  /** Right stick: the aim (screen x right, y up), while it's pushed over. */
  padAim: { x: number; y: number } | null = null;
  /** The behind-the-back camera is on: a click on the game captures the mouse (and doesn't shoot). */
  wantLock = false;
  /** Mouse travel (px) while it's captured, since the last `consumeLook()`. */
  private lookX = 0;
  private lookY = 0;
  /** The rumble playing, so a small one doesn't cut a big one short. */
  private rumbleUntil = 0;
  private rumbleK = 0;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener("keydown", (e) => {
      this.use("keys");
      if (!this.active) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        if (e.code === "KeyE" || e.code === "KeyF") this.useBuffered = true;
        if (e.code === "Space") this.jumpBuffered = true;
        if (e.code === "KeyG") this.nadeAt = performance.now();
        const n = e.code.match(/^Digit([0-4])$/);
        if (n) this.weaponBuffered = Number(n[1]);
        this.onKey?.(e.code);
      }
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => { this.keys.clear(); this.mouseDown = false; });
    addEventListener("pointermove", (e) => {
      // captured, the cursor stays put and only the travel counts (the first event after the
      // capture can carry a wild jump: capped)
      const locked = this.locked;
      const mx = locked ? Math.max(-200, Math.min(200, e.movementX)) : e.clientX - this.mouseX;
      const my = locked ? Math.max(-200, Math.min(200, e.movementY)) : e.clientY - this.mouseY;
      if (locked) { this.lookX += mx; this.lookY += my; }
      if (this.device === "pad" && e.pointerType === "mouse") {
        this.mouseTravel += Math.hypot(mx, my);
        if (this.mouseTravel > MOUSE_WAKE) this.use("keys");
      }
      if (!locked) { this.mouseX = e.clientX; this.mouseY = e.clientY; }
    });
    addEventListener("pointerdown", () => this.use("keys"));
    canvas.addEventListener("pointerdown", (e) => {
      // the first click on the behind view only captures the mouse
      if (this.wantLock && !this.locked && this.active) { this.lockPointer(); return; }
      if (e.button === 0) { this.mouseDown = true; this.clicks++; }
      // (a captured mouse can't be captured again: that throws)
      if (!this.locked) canvas.setPointerCapture?.(e.pointerId);
    });
    addEventListener("pointerup", (e) => { if (e.button === 0) this.mouseDown = false; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => { this.use("keys"); this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    addEventListener("gamepaddisconnected", (e) => {
      this.padPrev.delete(e.gamepad.index);
      if (e.gamepad.index === this.padIndex) { this.padIndex = -1; this.use("keys"); }
    });
  }

  /** Call `fn` whenever `device` or `padStyle` changes. */
  onDeviceChange(fn: () => void) { this.deviceListeners.push(fn); }

  private use(device: Device, style = this.padStyle) {
    if (device === "pad") this.mouseTravel = 0;
    if (device === this.device && style === this.padStyle) return;
    this.device = device;
    this.padStyle = style;
    if (device === "keys") this.padAim = null;
    for (const fn of this.deviceListeners) fn();
  }

  down(code: string) { return this.keys.has(code); }

  /** The mouse is captured by the game (pointer lock): it turns the behind-the-back camera. */
  get locked() { return document.pointerLockElement === this.canvas; }

  /** Capture the mouse (needs a key press or a click to be allowed; a refusal is ignored). */
  lockPointer() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch { /* not allowed right now */ }
  }

  unlockPointer() {
    if (this.locked) document.exitPointerLock();
  }

  /** Mouse travel (px, x right, y down) while captured, since the last call. */
  consumeLook(): { x: number; y: number } {
    const l = { x: this.lookX, y: this.lookY };
    this.lookX = this.lookY = 0;
    return l;
  }

  /** The right stick (x right, y up, each -1..1, past a dead zone and eased in): turning the behind-the-back camera. */
  padLook(): { x: number; y: number } {
    const p = this.pad();
    if (!p) return { x: 0, y: 0 };
    const s = stick(p.axes[2] ?? 0, p.axes[3] ?? 0, 0.15);
    const k = s.m ** 1.5 / (s.m || 1);
    return { x: s.x * k, y: -s.y * k };
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    const p = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (p?.connected) return p;
    let any: Gamepad | null = null;
    for (const q of pads) {
      if (!q?.connected) continue;
      if (q.mapping === "standard") return q;
      any ??= q;
    }
    return any;
  }

  /**
   * Once a frame (menu or game): which pad is in use and whether it's taken over from the
   * keyboard, the right stick's aim, and the pad's taps, buffered for the next step.
   */
  poll() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p?.connected) continue;
      let prev = this.padPrev.get(p.index);
      // (a pad without the standard mapping may rest with an axis at -1: only its moves count)
      if (!prev) this.padPrev.set(p.index, (prev = { buttons: [], awake: p.mapping !== "standard" }));
      const awake = Math.abs(p.axes[0] ?? 0) > WAKE || Math.abs(p.axes[1] ?? 0) > WAKE || Math.abs(p.axes[2] ?? 0) > WAKE || Math.abs(p.axes[3] ?? 0) > WAKE
        || (p.buttons[BTN.LT]?.value ?? 0) > WAKE || (p.buttons[BTN.RT]?.value ?? 0) > WAKE;
      let woke = awake && !prev.awake;
      prev.awake = awake;
      const presses: number[] = [];
      for (let i = 0; i < p.buttons.length; i++) {
        const now = held(p, i);
        if (now && !prev.buttons[i]) presses.push(i);
        prev.buttons[i] = now;
      }
      if (presses.length) woke = true;
      if (woke) {
        this.padIndex = p.index;
        this.use("pad", padStyle(p.id));
      }
      if (p.index === this.padIndex) for (const b of presses) this.press(b);
    }

    const p = this.pad();
    if (!p) { this.padAim = null; return; }
    // the right stick aims while it's pushed over, and lets go of the aim as it springs back
    const ax = p.axes[2] ?? 0, ay = p.axes[3] ?? 0, am = Math.hypot(ax, ay);
    if (am > AIM_ON || (this.padAim && am > AIM_OFF)) this.padAim = { x: ax / am, y: -ay / am };
    else this.padAim = null;
  }

  /** A pad button went down (on the pad in use). */
  private press(b: number) {
    this.onPadButton?.(b);
    if (!this.active) return;
    // laid out like GTA V: X jumps (into a car's or a train's side: up onto its roof), Y gets in
    // and out of cars (and cans), A is held to run, B taunts
    switch (b) {
      case BTN.X: this.jumpBuffered = true; break;
      case BTN.Y: this.useBuffered = true; break;
      case BTN.B: this.onKey?.("PadB"); break;
      case BTN.LB: this.shoulderWheel -= 1; this.onKey?.("PadLB"); break;
      case BTN.RB: this.shoulderWheel += 1; this.onKey?.("PadRB"); break;
      // (the d-pad's up also switches a gull out of the round to watching, and back)
      case BTN.Up: this.wheel += 1; this.onKey?.("PadUp"); break;
      case BTN.Down: this.wheel -= 1; break;
      case BTN.LT: this.onKey?.("PadLT"); break;
      // L3 taunts on foot too, and honks in a car; the d-pad switches whom a spectator watches
      case BTN.L3: this.onKey?.("PadL3"); break;
      // R3: the camera, overhead or behind the back (like C)
      case BTN.R3: this.onKey?.("PadR3"); break;
      case BTN.Left: this.onKey?.("ArrowLeft"); break;
      case BTN.Right: this.onKey?.("ArrowRight"); break;
      case BTN.Menu: this.onKey?.("F1"); break;
    }
  }

  /** Screen-space movement axes (x right, y up), each -1..1. */
  moveAxes(): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.down("KeyA") || this.down("ArrowLeft")) x -= 1;
    if (this.down("KeyD") || this.down("ArrowRight")) x += 1;
    if (this.down("KeyW") || this.down("ArrowUp")) y += 1;
    if (this.down("KeyS") || this.down("ArrowDown")) y -= 1;
    const p = this.pad();
    if (p) {
      const s = stick(p.axes[0] ?? 0, p.axes[1] ?? 0);
      x += s.x;
      y -= s.y;
    }
    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  /** Driving: throttle (W/S, RT/LT) and steer (A/D, left stick). */
  driveAxes(): { throttle: number; steer: number } {
    let throttle = 0, steer = 0;
    if (this.down("KeyW") || this.down("ArrowUp")) throttle += 1;
    if (this.down("KeyS") || this.down("ArrowDown")) throttle -= 1;
    if (this.down("KeyA") || this.down("ArrowLeft")) steer -= 1;
    if (this.down("KeyD") || this.down("ArrowRight")) steer += 1;
    const p = this.pad();
    if (p) {
      throttle += trigger(p.buttons[BTN.RT]?.value ?? 0) - trigger(p.buttons[BTN.LT]?.value ?? 0);
      // a little curve: fine corrections near the middle, full lock at the edge
      const s = stick(p.axes[0] ?? 0, 0, 0.15).x;
      steer += Math.sign(s) * Math.abs(s) ** 1.4;
    }
    return { throttle: Math.max(-1, Math.min(1, throttle)), steer: Math.max(-1, Math.min(1, steer)) };
  }

  /** Shooting: the mouse, J, RT on foot (in a car RT is the gas), LB in a car. */
  fire(driving = false): boolean {
    const p = this.pad();
    return this.mouseDown || this.down("KeyJ") || !!(p && held(p, driving ? BTN.LB : BTN.RT));
  }

  /** Shift held, or A held. */
  sprint(): boolean {
    const p = this.pad();
    return this.down("ShiftLeft") || this.down("ShiftRight") || !!(p && held(p, BTN.A));
  }

  /** Space held, or X held: a gull climbing. */
  jumpHeld(): boolean {
    const p = this.pad();
    return this.down("Space") || !!(p && held(p, BTN.X));
  }

  /** Space held, or RB held. */
  handbrakeHeld(): boolean {
    const p = this.pad();
    return this.down("Space") || !!(p && held(p, BTN.RB));
  }

  /** The scoreboard: Tab, or View held. */
  scores(): boolean {
    const p = this.pad();
    return this.down("Tab") || !!(p && held(p, BTN.View));
  }

  /**
   * Winding up a stink bomb: G held, or LT on foot (in a car LT is also the brake, so there it
   * only keeps a wind-up going). A G tap counts as held until the wind-up has started (`winding`),
   * for at most NADE_TAP_MS, so a tap between two steps (or at the very end of a cooldown)
   * still throws, as the shortest throw there is.
   */
  nade(now: number, winding: boolean, driving: boolean): boolean {
    if (winding) this.nadeAt = -Infinity;
    const p = this.pad();
    const lt = !!(p && held(p, BTN.LT)) && (!driving || winding);
    return this.down("KeyG") || now - this.nadeAt < NADE_TAP_MS || lt;
  }

  /**
   * A jolt through the pad (0..1), when it's the one in use: a short buzz for a shot, a long
   * heavy one for a blast. A weaker one doesn't cut a stronger one short.
   */
  rumble(k: number) {
    if (this.device !== "pad" || k <= 0) return;
    const now = performance.now();
    if (now < this.rumbleUntil && k < this.rumbleK) return;
    const act = (this.pad() as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    if (!act?.playEffect) return;
    k = Math.min(1, k);
    const ms = Math.round(70 + 280 * k);
    this.rumbleUntil = now + ms;
    this.rumbleK = k;
    act.playEffect("dual-rumble", { duration: ms, strongMagnitude: Math.min(1, k * 1.1), weakMagnitude: Math.min(1, 0.15 + k * 1.3) }).catch(() => {});
  }

  /** Left clicks since the last call. */
  consumeClicks(): number {
    const n = this.clicks;
    this.clicks = 0;
    return n;
  }

  /** Consume buffered taps for one fixed step (LB / RB pick weapons only on foot). */
  consumeTaps(driving = false) {
    const t = {
      use: this.useBuffered,
      jump: this.jumpBuffered,
      weapon: this.weaponBuffered,
      wheel: this.wheel + (driving ? 0 : this.shoulderWheel),
    };
    this.useBuffered = this.jumpBuffered = false;
    this.weaponBuffered = null;
    this.wheel = 0;
    this.shoulderWheel = 0;
    return t;
  }
}
