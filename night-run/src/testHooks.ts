import type { Container3D, View3D } from '@pixi/3d';
import { createRaycastHit3D, Mesh3D } from '@pixi/3d';
import type { Application } from 'pixi.js';
import { UPDATE_PRIORITY } from 'pixi.js';

import type { CameraRig } from './CameraRig';
import type { Flow } from './Flow';
import type { Game } from './Game';
import type { Race } from './Race';
import { FINISH_LINE } from './race/route';
import { angleDelta, MAX_RACERS, TRUCK_COLORS } from './race/truck';

/** The drawing buffer's resolution, as the test hooks read and force it. */
export interface RenderScale {
  /** Drawing-buffer pixels per CSS pixel now. */
  readonly current: number;
  /** Sets the buffer's resolution; the governor, if it runs, carries on from there. */
  force(scale: number): void;
}

/** What the test hooks read. */
export interface TestHookParts {
  app: Application;
  view: View3D;
  race: Race;
  rig: CameraRig;
  game: Game;
  flow: Flow;
  scale: RenderScale;
}

/**
 * How smoothly one thing moved: frames, mean speed (m/s), the mean and worst share a frame's speed is off the average
 * of its neighbours', frames more than 35 % off, top speed, and the hardest frame-to-frame change of speed (m/s²).
 */
interface TraceStats {
  kind: string;
  frames: number;
  speed: number;
  jitter: number;
  spikes: number;
  worst: number;
  top: number;
  accel: number;
}

/** Points on a truck's body in its own frame (+z forward, +x its left) that `sight` looks for: its middle and corners. */
const SIGHT_POINTS: readonly (readonly [number, number, number])[] = [
  [0, 0.45, 0],
  [0.36, 0.15, 0.68],
  [-0.36, 0.15, 0.68],
  [0.36, 0.15, -0.68],
  [-0.36, 0.15, -0.68],
  [0.36, 0.72, 0.5],
  [-0.36, 0.72, 0.5],
  [0.36, 0.72, -0.68],
  [-0.36, 0.72, -0.68],
];
/**
 * Where the arch's sign hung, which `sight` still frames so its shares compare with how the sign was framed: half its
 * width, its bottom and top, and how far its faces stood off the line.
 */
const SIGN_BOX = { halfWidth: 2.2, bottom: 3.65, top: 4.65, face: 1.2 } as const;
/** The scenery `sight` lets block a view: track pieces and trees, the arch's neon, floodlight towers. */
const SIGHT_BLOCKERS = ['track', 'neon', 'floodlight-steel', 'floodlight-lamps'];

/** Each hook on `window` by name, and the fields other modules added to it, which a hook registered later still gets. */
const _hooks = new Map<string, object>();
const _extensions = new Map<string, PropertyDescriptorMap>();

/**
 * Put a test hook on `window`, for harnesses to read and drive; nothing in the game calls them. A module that owns a
 * hook registers it itself, so this file needn't know every hook. Fields {@link extendTestHook} added to the name
 * before it was registered carry over.
 * @param name - The global's name, as `__track`.
 * @param value - The hook; its getters stay getters.
 */
export function registerTestHook(name: string, value: object): void {
  const extra = _extensions.get(name);

  if (extra) Object.defineProperties(value, extra);

  _hooks.set(name, value);
  Object.assign(window, { [name]: value });
}

/**
 * Add fields to a test hook, registered yet or not: another module's additions to `__net`, say.
 * @param name - The global's name.
 * @param fields - What to add; getters stay getters.
 */
export function extendTestHook(name: string, fields: object): void {
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  const hook = _hooks.get(name);

  _extensions.set(name, { ..._extensions.get(name), ...descriptors });

  if (hook) Object.defineProperties(hook, descriptors);
}

/**
 * What a capture harness reads, and the game for it to drive: `window.__race`, `__net`, `__game` and `__flow`, and a
 * tracer that records every truck's drawn position and the lens's each frame. Nothing in the game calls these.
 * @param parts - The game's parts.
 */
export function installTestHooks({ app, view, race, rig, game, flow, scale }: TestHookParts): void {
  /** Each racer's drawn position every frame, and the camera's, for measuring how smoothly trucks and the lens move. */
  const STRIDE = (MAX_RACERS + 1) * 3;
  const trace = {
    frames: 0,
    limit: 0,
    ids: [] as string[],
    data: new Float64Array(0),
    record(ms: number): void {
      this.limit = Math.ceil((ms / 1000) * 240);
      this.data = new Float64Array(this.limit * STRIDE);
      this.ids = [...race.racers.map((racer) => racer.id), 'camera'];
      this.frames = 0;
    },
    tick(): void {
      if (this.frames >= this.limit) return;

      const at = this.frames * STRIDE;
      const lens = view.camera.position;

      for (let i = 0; i < this.ids.length; i++) {
        const pose = race.getRacer(this.ids[i])?.pose;

        this.data[at + i * 3] = app.ticker.lastTime + app.ticker.elapsedMS;
        this.data[at + i * 3 + 1] = this.ids[i] === 'camera' ? lens.x : (pose?.x ?? NaN);
        this.data[at + i * 3 + 2] = this.ids[i] === 'camera' ? lens.z : (pose?.z ?? NaN);
      }

      this.frames++;
    },
    /** Per racer: frame-to-frame speed and how much it varies; stutter shows as frames far off the running speed. */
    result(): Record<string, TraceStats> {
      const out: Record<string, TraceStats> = {};

      for (let i = 0; i < this.ids.length; i++) {
        const speeds: number[] = [];
        const times: number[] = [];

        for (let f = 1; f < this.frames; f++) {
          const a = (f - 1) * STRIDE + i * 3;
          const b = f * STRIDE + i * 3;
          const dt = (this.data[b] - this.data[a]) / 1000;

          if (dt > 0) {
            speeds.push(Math.hypot(this.data[b + 1] - this.data[a + 1], this.data[b + 2] - this.data[a + 2]) / dt);
            times.push(dt);
          }
        }

        const moving = speeds.slice(1);
        let change = 0;
        let spikes = 0;
        let worst = 0;

        // Compare each frame with the average of its neighbours, so honest acceleration doesn't count as stutter.
        for (let k = 1; k < moving.length - 1; k++) {
          const around = (moving[k - 1] + moving[k + 1]) / 2;
          const off = around > 0.5 ? Math.abs(moving[k] - around) / around : 0;

          change += off;
          worst = Math.max(worst, off);

          if (off > 0.35) spikes++;
        }

        const mean = moving.reduce((sum, v) => sum + v, 0) / Math.max(1, moving.length);
        let accel = 0;

        for (let k = 1; k < speeds.length; k++) accel = Math.max(accel, Math.abs(speeds[k] - speeds[k - 1]) / times[k]);

        out[this.ids[i]] = {
          kind: this.ids[i] === 'camera' ? 'camera' : (race.getRacer(this.ids[i])?.kind ?? 'gone'),
          frames: moving.length,
          speed: Math.round(mean * 100) / 100,
          jitter: Math.round((change / Math.max(1, moving.length - 2)) * 1000) / 1000,
          spikes,
          worst: Math.round(worst * 100) / 100,
          top: Math.round(Math.max(0, ...speeds) * 100) / 100,
          accel: Math.round(accel),
        };
      }

      return out;
    },
  };

  app.ticker.add(() => trace.tick(), null, UPDATE_PRIORITY.LOW);

  /** Every racer's lap times this race, at full precision; a new race starts each list over at its first lap. */
  const lapTimes = new Map<string, number[]>();
  const onLap = race.onLap;
  const onFinish = race.onFinish;
  const keepLap = (id: string, laps: number, time: number): void => {
    const times = laps === 1 ? [] : (lapTimes.get(id) ?? []);

    times.push(time);
    lapTimes.set(id, times);
  };

  race.onLap = (racer, lapTime) => {
    onLap?.(racer, lapTime);
    keepLap(racer.id, racer.progress.lap, lapTime);
  };
  race.onFinish = (racer) => {
    onFinish?.(racer);
    keepLap(racer.id, racer.progress.lap, racer.progress.lastLap);
  };

  const hit = createRaycastHit3D();
  const point = { x: 0, y: 0, z: 0 };
  /** The track group the blockers were made pickable with: every track build makes new ones. */
  let pickedWith: Container3D | null = null;
  /** Pickable, by its triangles rather than its bounding box. */
  const byTriangles = (node: Container3D): void => {
    if (node instanceof Mesh3D && node.hitVolume !== 'geometry') node.hitVolume = 'geometry';

    for (const child of node.children) byTriangles(child as Container3D);
  };
  const pickable = (node: Container3D): void => {
    if (node.eventMode !== 'static') node.eventMode = 'static';

    byTriangles(node);
  };

  /**
   * How the truck the cameras follow reads on screen: the height of its body in CSS px, where its middle sits (0 top to
   * 1 bottom), the share of its body points inside the screen, and the share of those the lens sees unblocked, with
   * what blocked the first one that wasn't.
   */
  const sight = () => {
    const subject = game.subject;

    if (!subject) return null;

    const track = view.root.getChildByLabel('track', true);

    if (track !== pickedWith) {
      pickedWith = track;

      for (const label of SIGHT_BLOCKERS) {
        const node = view.root.getChildByLabel(label, true);

        if (node) pickable(node as Container3D);
      }
    }

    for (const racer of race.racers) pickable(racer.model.root);

    const pose = subject.pose;
    const cos = Math.cos(pose.yaw);
    const sin = Math.sin(pose.yaw);
    const lens = view.camera.position;
    const width = app.screen.width;
    const height = app.screen.height;
    let top = Infinity;
    let bottom = -Infinity;
    let on = 0;
    let seen = 0;
    let blocker = '';

    for (const [lx, ly, lz] of SIGHT_POINTS) {
      point.x = pose.x + lx * cos + lz * sin;
      point.y = pose.y + ly;
      point.z = pose.z - lx * sin + lz * cos;

      const screen = view.worldToScreen(point);

      if (!screen) continue;

      top = Math.min(top, screen.y);
      bottom = Math.max(bottom, screen.y);

      if (screen.x < 0 || screen.y < 0 || screen.x > width || screen.y > height) continue;

      on++;

      const far = Math.hypot(point.x - lens.x, point.y - lens.y, point.z - lens.z);
      const struck = view.raycast(screen, hit);

      if (!struck || struck.target === subject.model.root || struck.distance > far - 0.3) {
        seen++;
      } else if (!blocker) {
        const truck = race.racers.find((racer) => racer.model.root === struck.target);

        blocker = truck
          ? `truck ${truck.id}`
          : `${struck.target.label || 'scenery'} ${struck.point.x.toFixed(1)},${struck.point.y.toFixed(1)},${struck.point.z.toFixed(1)}`;
      }
    }

    const middle = view.worldToScreen({ x: pose.x, y: pose.y + 0.45, z: pose.z });
    // Where the arch's sign hung: wholly on screen, wholly off it, or cut by an edge.
    let corners = 0;
    let inside = 0;
    let left = Infinity;
    let right = -Infinity;
    let high = Infinity;
    let low = -Infinity;

    for (const sx of [-1, 1]) {
      for (const sy of [SIGN_BOX.bottom, SIGN_BOX.top]) {
        for (const sz of [-1, 1]) {
          point.x = FINISH_LINE.x + sx * SIGN_BOX.halfWidth;
          point.y = sy;
          point.z = FINISH_LINE.z + sz * SIGN_BOX.face;

          const screen = view.worldToScreen(point);

          if (!screen) continue;

          corners++;
          left = Math.min(left, screen.x);
          right = Math.max(right, screen.x);
          high = Math.min(high, screen.y);
          low = Math.max(low, screen.y);

          if (screen.x >= 0 && screen.y >= 0 && screen.x <= width && screen.y <= height) inside++;
        }
      }
    }

    const signOff = corners === 0 || right < 0 || left > width || low < 0 || high > height;

    return {
      phase: game.phase,
      camera: rig.activeCamera,
      height: Number.isFinite(top) ? Math.round(bottom - top) : 0,
      top: Number.isFinite(top) ? Math.round((top / height) * 1000) / 1000 : -1,
      middle: middle ? Math.round((middle.y / height) * 1000) / 1000 : -1,
      across: middle ? Math.round((middle.x / width) * 1000) / 1000 : -1,
      on: on / SIGHT_POINTS.length,
      seen: on > 0 ? seen / on : 0,
      blocker,
      distance: Math.round(Math.hypot(pose.x - lens.x, pose.y - lens.y, pose.z - lens.z) * 100) / 100,
      lensY: Math.round(lens.y * 100) / 100,
      sign: signOff ? 'out' : inside === 8 ? 'whole' : 'cropped',
    };
  };

  registerTestHook('__game', game);
  registerTestHook('__flow', flow);
  registerTestHook('__race', {
    get phase() {
      return game.phase;
    },
    get fps() {
      return Math.round(game.fps);
    },
    /** The drawing buffer's resolution: the governor's scale, or the one `?resolution=` pins. */
    get resolution() {
      return scale.current;
    },
    forceResolution(value: number) {
      scale.force(value);
    },
    get time() {
      return race.rules.time;
    },
    get laps() {
      return race.rules.laps;
    },
    get camera() {
      return rig.activeCamera;
    },
    get counts() {
      return { ...game.counts };
    },
    get racers() {
      return race.racers.map((racer) => ({
        id: racer.id,
        kind: racer.kind,
        color: TRUCK_COLORS[racer.color].name,
        distance: Math.round(racer.progress.distance * 100) / 100,
        lap: racer.progress.lap,
        rank: racer.progress.rank,
        speed: Math.round(racer.pose.speed * 100) / 100,
        drift: Math.round(racer.pose.drift * 100) / 100,
        charge: racer.pose.charge,
        boosting: racer.pose.boosting,
        finished: racer.progress.finished,
        wrongWay: racer.progress.wrongWay,
        visible: racer.model.root.visible,
      }));
    },
    sight,
    /** Every racer's lap times this race in seconds, at full precision, by racer id. */
    lapTimes() {
      return Object.fromEntries(lapTimes);
    },
    /**
     * Where the route `ahead` metres past the player's truck lies: on screen from the truck, in CSS px, for steering by
     * touch, and as `turn`, the yaw it needs (positive is to the left), for steering by keys.
     */
    aim(ahead: number) {
      const local = race.local;

      if (!local) return null;

      const point = { x: 0, y: 0, z: 0 };

      game.course.route.point(local.progress.distance + ahead, 0, point);

      const truck = view.worldToScreen(local.pose);
      const target = view.worldToScreen(point);

      const pose = local.pose;
      const turn = angleDelta(pose.yaw, Math.atan2(point.x - pose.x, point.z - pose.z));

      return truck && target ? { x: truck.x, y: truck.y, tx: target.x, ty: target.y, turn } : null;
    },
  });
  registerTestHook('__net', {
    get mode() {
      return flow.session?.mode ?? 'none';
    },
    get code() {
      return flow.session?.code ?? '';
    },
    get phase() {
      return flow.session?.phase ?? 'none';
    },
    get screen() {
      return flow.screen;
    },
    get sessionId() {
      return flow.session?.sessionId ?? '';
    },
    get isHost() {
      return flow.session?.isHost ?? false;
    },
    get rtt() {
      return flow.session?.rtt ?? 0;
    },
    get paused() {
      return flow.session?.paused ?? false;
    },
    get racers() {
      const state = flow.session?.state;

      if (!state) return [];

      return [...state.racers.entries()].map(([id, seat]) => ({
        id,
        name: seat.name,
        car: seat.car,
        rank: seat.rank,
        lap: seat.lap,
        grid: seat.grid,
        ready: seat.ready,
        isBot: seat.isBot,
        connected: seat.connected,
        spectator: seat.spectator,
        finishTime: seat.finishTime,
      }));
    },
    get results() {
      return [...(flow.session?.state.results ?? [])].map((result) => ({
        id: result.id,
        name: result.name,
        time: result.time,
        projected: result.projected,
      }));
    },
    /** The HUD's name-tag anchors this frame, in CSS px. */
    get tags() {
      return flow.hud.racers
        .filter((tag) => tag.active)
        .map((tag) => ({
          id: tag.id,
          x: Math.round(tag.screenX),
          y: Math.round(tag.screenY),
          visible: tag.tagVisible,
          place: tag.place,
        }));
    },
    actions: flow,
    trace(ms: number) {
      trace.record(ms);
    },
    traceResult() {
      return trace.result();
    },
    /** One traced thing's frames as [time ms, x, z], for finding where it jolted. */
    traceRaw(id: string) {
      const i = trace.ids.indexOf(id);
      const rows: number[][] = [];

      for (let f = 0; i >= 0 && f < trace.frames; f++)
        rows.push([...trace.data.subarray(f * STRIDE + i * 3, f * STRIDE + i * 3 + 3)]);

      return rows;
    },
  });
}
