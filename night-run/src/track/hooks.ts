/**
 * `window.__track`, for harnesses: the track built, its venue's counts, and loading, validating, generating and
 * stress-switching tracks; where the camera's truck is on screen, which towers the floodlights are on, and, with
 * `?debug`, the cameras' time in occluder queries. Nothing in the game calls it.
 */

import type { View3D } from '@pixi/3d';
import type { Application } from 'pixi.js';
import { UPDATE_PRIORITY } from 'pixi.js';

import type { Game } from '../Game';
import { registerTestHook } from '../testHooks';
import type { Venue, VenueStats } from '../Venue';
import { decodeTrack, isTrackError, trackFromTurns } from './code';
import { generateTurns } from './generate';

/** The checks' tracks by name: small to the largest the format holds. */
export const TRACK_SUITE: Readonly<Record<string, string>> = {
  base: '1gIkII8',
  oval: '1gCo8',
  hairpin: '1AKhgg8',
  esses: '1ACCmp8',
  longcomplex: '1AAaCAIy',
  'gen-1': '1AQQAAhUA',
  'gen-2': '1AFgEAFCShEUII8',
  'gen-3': '1ASoESAKQIAy',
  'gen-4': '1AFAF',
  'gen-7': '1AIASoAQAK8',
  'gen-11': '1ACgSIhy',
  wiggle: '1AIaplWKC',
  comb: '1AIoUoUoUogw',
  snake: '1AKAFAKAFAKAIAC',
  ring: '1AAIAACAAAIAACA',
  long500: '1AAIgCFoQBKUgCFoQBKUgCIA8',
  max: '1AAIAAKAQBAoAAFAgCAUAAKAQBAoAAFAgCAUAAKAACA',
};

/** Frames of occluder timing kept for {@link installTrackHooks}'s `occluderTime`, a minute at 60 a second. */
const KEEP_FRAMES = 3600;

/** A venue's counts with what the view and the renderer hold, to catch a build that leaks. */
export type TrackStats = VenueStats & { lights: number; meshes: number; textures: number; programs: number };

/** What the hook reads. */
export interface TrackHookParts {
  app: Application;
  view: View3D;
  game: Game;
  venue: Venue;
}

/** The renderer's caches the counts read; pixi keeps them private, and a harness may. */
interface RendererCaches {
  texture: { managedTextures: readonly unknown[] };
  material3d?: { _shaderCache?: { size: number } };
  shader?: { _programDataHash?: Record<string, unknown> };
}

/**
 * Put `window.__track` up.
 * @param parts - What it reads and drives.
 */
export function installTrackHooks({ app, view, game, venue }: TrackHookParts): void {
  const occluders = game.rig.occluders;
  /** Each frame's milliseconds and queries in the occluders since the last read, with `?debug`. */
  const queryMs: number[] = [];
  const queries: number[] = [];

  // After the game's frame, which runs every camera's queries.
  if (occluders.timing) {
    app.ticker.add(
      () => {
        const taken = occluders.takeQueryTime();

        queryMs.push(taken.ms);
        queries.push(taken.queries);

        // An hour unread would hold a few megabytes; keep the last minute or so.
        if (queryMs.length > KEEP_FRAMES) {
          queryMs.splice(0, queryMs.length - KEEP_FRAMES);
          queries.splice(0, queries.length - KEEP_FRAMES);
        }
      },
      null,
      UPDATE_PRIORITY.LOW,
    );
  }

  const stats = (): TrackStats => {
    const renderer = app.renderer as unknown as RendererCaches;

    return {
      ...venue.stats(),
      lights: view.lights.length,
      meshes: view.meshes.items.length,
      // A freed texture leaves a null behind in the renderer's list.
      textures: renderer.texture.managedTextures.filter(Boolean).length,
      // Compiled 3D materials, and on WebGL the GL programs behind every shader.
      programs:
        (renderer.material3d?._shaderCache?.size ?? 0) + Object.keys(renderer.shader?._programDataHash ?? {}).length,
    };
  };
  const load = (code: string, name?: string): boolean => {
    const def = decodeTrack(code, name);

    return !isTrackError(def) && game.setTrack(def);
  };
  /** At least `n` frames and `ms` milliseconds. */
  const frames = (n: number, ms = 0): Promise<void> =>
    new Promise((resolve) => {
      const until = performance.now() + ms;
      const step = (left: number): void => {
        if (left <= 0 && performance.now() >= until) resolve();
        else requestAnimationFrame(() => step(left - 1));
      };

      step(n);
    });

  registerTestHook('__track', {
    get code() {
      return game.course.def.code;
    },
    get name() {
      return game.course.def.name;
    },
    get lapLength() {
      return game.course.route.lapLength;
    },
    get cells() {
      return game.course.def.cells;
    },
    get turns() {
      return game.course.def.turns;
    },
    get plan() {
      return venue.plan;
    },
    stats,
    /** Build a track now, as the title would; false while a race runs, or for a code that isn't a track. */
    load,
    /** Why a code isn't a track, or null when it is. */
    validate(code: string): string | null {
      const def = decodeTrack(code);

      return isTrackError(def) ? def : null;
    },
    /** A random track's code, from the editor's generator; '' when it makes Night Run. */
    random(seed: number): string {
      const def = trackFromTurns(generateTurns(seed));

      return isTrackError(def) ? '' : def.code;
    },
    suite: TRACK_SUITE,
    /** Where the camera's truck stands on screen, in CSS px; null with none, or behind the lens. */
    subjectScreen(): { x: number; y: number } | null {
      const pose = game.subject?.pose;
      const screen = pose ? view.worldToScreen({ x: pose.x, y: pose.y, z: pose.z }) : null;

      return screen ? { x: screen.x, y: screen.y } : null;
    },
    /** The tower each of the set's spot lights is given to, -1 for one left dark. */
    lightTowers(): number[] {
      return [...venue.set.lightTowers];
    },
    /**
     * The cameras' time in occluder queries per frame since the last call, with `?debug`; null without it.
     * @returns Frames counted, the mean and worst milliseconds a frame, and the mean queries a frame.
     */
    occluderTime(): { frames: number; meanMs: number; maxMs: number; queries: number } | null {
      if (!occluders.timing) return null;

      const frames = queryMs.length;
      const total = queryMs.reduce((sum, ms) => sum + ms, 0);
      const count = queries.reduce((sum, n) => sum + n, 0);
      const report = {
        frames,
        meanMs: frames > 0 ? total / frames : 0,
        maxMs: frames > 0 ? Math.max(...queryMs) : 0,
        queries: frames > 0 ? count / frames : 0,
      };

      queryMs.length = 0;
      queries.length = 0;

      return report;
    },
    /**
     * Switch to the oval, the largest track and back, `n` times, two frames on each, and count what the world holds
     * before and after: a build that leaks shows as a difference. One round goes first, uncounted, so what is made once
     * and kept (a texture first drawn on another track) isn't taken for a leak, and a second passes before each count,
     * so art still being drawn off the main thread (the mini-map's) has landed.
     */
    async stress(n: number): Promise<{ before: TrackStats; after: TrackStats }> {
      const home = game.course.def;
      // The same trees on the way back, so a custom track's occluders count the same.
      const { treeSeed } = venue.stats();
      const round = async (): Promise<void> => {
        for (const code of [TRACK_SUITE.oval, TRACK_SUITE.max]) {
          load(code);
          await frames(2);
        }

        game.setTrack(home, { treeSeed });
        await frames(2);
      };

      await round();
      await frames(30, 1000);

      const before = stats();

      for (let i = 0; i < n; i++) await round();

      await frames(30, 1000);

      return { before, after: stats() };
    },
  });
}
