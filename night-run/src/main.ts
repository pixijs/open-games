/**
 * NIGHT RUN: an online arcade truck race on a rain-soaked night track, for up to four racers, with every camera
 * directed by klipp. A port of the three.js Starter-Kit-Racing.
 *
 * It opens on the title over the attract race: four bots lapping the track under a chase camera. A quick race
 * puts you against bots; hosting a party gives you a five-letter code and a link for friends, whose browsers reach
 * yours over WebRTC, with your tab running the room. The README lists the URL switches a harness uses.
 *
 * Shows off PBR on wet surfaces with screen-space reflections, up to 27 dynamic lights with tiled culling, cascaded and
 * spot shadows, glTF loading, a procedural night sky and reflection cube, GPU-driven rain lit by the scene's lights,
 * light trails, volumetric headlight beams, and a post chain (depth of field, bloom and a custom lens pass: flares,
 * raindrops, streaks, grade) under a 2D HUD.
 *
 * Controls: WASD or arrow keys, gamepad, or touch joystick. C switches camera, R puts you back on the track, V watches
 * another truck while spectating, Esc opens the race menu.
 *
 * `index.html` paints the loading screen before this runs; it fades out once the title is up. The game draws with WebGL,
 * or WebGPU with `?renderer=webgpu`. Nothing here awaits at the top level: a production build hoists pixi's shared code
 * into this entry, and the renderer's init imports chunks that import that code back, so an entry awaiting at its top
 * level would never finish evaluating.
 */

import type { Scene3DSource } from '@pixi/3d';
import { View3D } from '@pixi/3d';
import type { Texture } from 'pixi.js';
import { Application, Assets, UPDATE_PRIORITY } from 'pixi.js';

import { GameAudio } from './Audio';
import { bootDone, bootFail, canRun } from './boot';
import { CameraRig } from './CameraRig';
import { DriftMarks } from './DriftMarks';
import { Flow } from './Flow';
import { Game } from './Game';
import { LensFx } from './look/LensFx';
import { NightLook } from './look/NightLook';
import { HORIZON } from './look/NightSky';
import { Pyro } from './look/Pyro';
import { TruckLights } from './look/TruckLights';
import { Weather } from './look/Weather';
import { installNetHooks } from './net/hooks';
import { Occluders } from './Occluders';
import { CarEffects } from './Particles';
import { PhysicsWorld } from './Physics';
import { Race } from './Race';
import { Course } from './race/course';
import { installLineHooks } from './race/line/hooks';
import { LineService } from './race/line/LineService';
import { baseLine } from './race/line/RacingLine';
import { BASE_ROUTE } from './race/route';
import { MAX_RACERS, TRUCK_COLORS } from './race/truck';
import { ResolutionGovernor } from './ResolutionGovernor';
import type { RenderScale } from './testHooks';
import { installTestHooks } from './testHooks';
import type { TrackDef } from './track/code';
import { BASE_TRACK, decodeTrack, isTrackError } from './track/code';
import { installTrackHooks } from './track/hooks';
import type { CarColor } from './ui/contract';
import { createGameUI } from './ui/GameUI';
import { Venue } from './Venue';

/**
 * The most drawing-buffer pixels per CSS pixel: the screen's own, up to 1.5. At a 2x or 3x screen's own ratio, every
 * pass of the post chain would shade 1.8 or 4 times the pixels, for detail nobody sees. The resolution governor starts
 * here and never climbs past it.
 */
const MAX_RESOLUTION = 1.5;
/**
 * The governor's floor: a quarter of a 1x screen's pixels, where the frame is soft but still reads. A GPU too slow for
 * that is better off at a lower frame rate.
 */
const MIN_RESOLUTION = 0.75;
/**
 * A frame longer than this is a hitch, not the renderer's pace: a tab coming back, or the assets or the online code
 * arriving. The governor leaves it out.
 */
const HITCH_MS = 100;

const ASSET_KEYS = [
  ...TRUCK_COLORS.map((color) => color.asset),
  'track-straight',
  'track-corner',
  'track-bump',
  'track-finish',
  'decoration-empty',
  'decoration-forest',
  'decoration-tents',
  'colyseus-logo',
  'pixijs-logo',
];

async function start(params: URLSearchParams, webgpu: boolean): Promise<void> {
  const app = new Application();
  // `?resolution=N` pins the drawing buffer for a harness, with the governor off; otherwise it starts at the screen's.
  const pinned = params.has('resolution');
  const pin = Number(params.get('resolution'));
  const resolution =
    pin > 0
      ? Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, pin))
      : Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION);

  await app.init({
    resizeTo: window,
    preference: webgpu ? 'webgpu' : 'webgl',
    backgroundColor: HORIZON,
    resolution,
    autoDensity: true,
  });

  document.body.appendChild(app.canvas);

  // The models, sprites and sounds are in `public/racing/`, under whatever base path the site is served from.
  await Assets.init({ basePath: import.meta.env.BASE_URL });

  const [smokeTexture, ...sourceList] = await Promise.all([
    Assets.load<Texture>('racing/sprites/smoke.png'),
    ...ASSET_KEYS.map((key) => Assets.load<Scene3DSource>(`racing/${key}.glb`)),
  ]);

  const sources: Record<string, Scene3DSource> = Object.create(null);

  ASSET_KEYS.forEach((key, i) => {
    sources[key] = sourceList[i];
  });

  // -- The view: the night look owns the moon, sky, fog and post chain --

  const look = new NightLook();
  // What the effects ask of the lens each frame; the look reads and clears it.
  const fx = new LensFx();
  const view3d = new View3D({ autoResize: true, ...look.viewOptions, passes: look.passes });

  app.stage.addChild(view3d);

  // The track raced, which every part that needs the road reads as it goes.
  const course = new Course(BASE_TRACK, BASE_ROUTE, baseLine());
  // What the cameras see past: the track and the set add their trees, poles, beams and arch as they're built.
  const occluders = new Occluders(course);

  // `?debug` times the cameras' sight checks, for `__track.occluderTime()`.
  occluders.timing = params.has('debug');
  const rig = new CameraRig(view3d, occluders, course);

  look.attach(view3d, rig.klipp, fx);

  // -- The venue: the grass and the night set's lights now, ahead of the trucks'; the track once the game exists --

  const physics = new PhysicsWorld();
  const venue = new Venue({ view: view3d, sources, physics, occluders, fx, course });

  // -- The race: trucks, their effects and lamps --

  const effects = new CarEffects(view3d.root, smokeTexture);
  const marks = new DriftMarks(view3d.root, MAX_RACERS * 2);
  const lights = new TruckLights(view3d.root, fx);
  const race = new Race({ parent: view3d.root, sources, physics, effects, marks, lights, course });
  // The rain falls round the camera, so it runs after the camera has moved.
  const weather = new Weather(view3d.root, view3d.camera, smokeTexture, fx);
  const pyro = new Pyro(view3d.root, fx);
  const audio = new GameAudio();
  const lines = new LineService(localStore(), params);

  void audio.load();

  const game = new Game({
    app,
    resolution,
    view: view3d,
    race,
    rig,
    look,
    venue,
    set: venue.set,
    weather,
    pyro,
    lights,
    effects,
    marks,
    audio,
    lines,
  });
  const treeSeed = Number.parseInt(params.get('treeSeed') ?? '', 10);

  if (Number.isInteger(treeSeed)) game.treeSeed = treeSeed;

  // -- The interface: the one place it's made --

  const flow = new Flow({ app, resolution, view: view3d, game, audio, params, createUI: createGameUI });

  game.setTrack(initialTrack(params));

  // The title waits for the UI's fonts (or gives up on them after 2.5 s), so its sign never shows in a fallback face.
  await flow.ui.ready;
  flow.open();
  bootDone();

  // A results moment without racing first, for checking the podium's staging: the attract field in a shuffled order,
  // under the results screen as a quick race's end shows it.
  if (params.has('podium')) {
    const order = race.racers.map((racer) => racer.id).sort(() => Math.random() - 0.5);
    const names = ['Viper', 'Nova', 'Blaze', 'Rook'];

    game.showResults(order);
    flow.ui.show({
      id: 'results',
      role: 'solo',
      hostName: '',
      lobbyAt: 0,
      rows: order.map((id, i) => ({
        id,
        place: i + 1,
        name: names[i],
        car: (race.getRacer(id)?.color ?? 0) as CarColor,
        isBot: true,
        isYou: false,
        time: 61_400 + i * 840,
        gap: i * 840,
        bestLap: 29_120 + i * 310,
      })),
    });
  }

  const scale = governResolution(app, resolution, !pinned);
  const onTrackBuilt = game.onTrackBuilt;

  // The build's long frame says nothing of the GPU, and the frames round it are the new track's.
  game.onTrackBuilt = (def) => {
    onTrackBuilt?.(def);
    scale.restart();
  };

  installTestHooks({ app, view: view3d, race, rig, game, flow, scale });
  installTrackHooks({ app, view: view3d, game, venue });
  installNetHooks(flow);
  installLineHooks(lines, race);
}

/**
 * The track the page opens on: `?track=CODE`, named by `tn=`, or Night Run.
 * @param params - The page's URL switches.
 * @returns A valid track; Night Run, with a warning, for a code that isn't one.
 */
function initialTrack(params: URLSearchParams): TrackDef {
  const code = params.get('track') ?? '';
  const def = decodeTrack(code, params.get('tn') ?? undefined);

  if (!isTrackError(def)) return def;

  console.warn(`[night-run] ?track=${code} isn't a track (${def}); racing Night Run`);

  return BASE_TRACK;
}

/** The page's local storage, or null where the browser blocks it. */
function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Runs a {@link ResolutionGovernor} on every frame, so the drawing buffer's resolution follows the frame rate between
 * {@link MIN_RESOLUTION} and the display's. Only the buffer moves: the UI and the effects' quality tiers keep to the
 * display's resolution, which `Game` and `Flow` are given.
 * @param app - The app whose renderer it resizes.
 * @param display - The resolution the app started at, and the most the governor climbs to.
 * @param governed - False when `?resolution=` pins the buffer; then only the test hooks move it.
 * @returns The buffer's resolution, for the test hooks, and a way to forget the frame times so far.
 */
function governResolution(app: Application, display: number, governed: boolean): RenderScale & { restart(): void } {
  // The window's size, which is what `resizeTo` fills. `app.screen` is the buffer's rounded size over its resolution,
  // so feeding it back would walk the canvas a fraction of a pixel off the window at every step.
  const apply = (scale: number): void => app.renderer.resize(window.innerWidth, window.innerHeight, scale);
  let governor = new ResolutionGovernor(MIN_RESOLUTION, display, display, apply);
  const restart = (scale: number): void => {
    governor = new ResolutionGovernor(MIN_RESOLUTION, display, scale, apply);
  };

  if (governed) {
    // The browser stops or throttles a hidden tab's frames; the half second that spans that says nothing of the GPU.
    document.addEventListener('visibilitychange', () => restart(governor.scale));
    // Ahead of the game's frame and the render, so a step reaches the whole frame at once. `elapsedMS` is the real time
    // between frames; `deltaMS` is capped at 100 ms and scaled by the ticker's speed.
    app.ticker.add(
      () => {
        const ms = app.ticker.elapsedMS;

        if (ms <= HITCH_MS) governor.frame(ms / 1000);
      },
      null,
      UPDATE_PRIORITY.HIGH,
    );
  }

  return {
    get current() {
      return governor.scale;
    },
    force(scale: number) {
      restart(scale);
      apply(scale);
    },
    /** Forget the frame times so far, keeping the resolution. */
    restart() {
      restart(governor.scale);
    },
  };
}

const params = new URLSearchParams(location.search);
const webgpu = params.get('renderer') === 'webgpu';

if (canRun(webgpu)) {
  start(params, webgpu).catch((error: unknown) => {
    console.error(error);
    bootFail('error', error instanceof Error ? error.message : String(error));
  });
} else {
  bootFail('unsupported');
}
