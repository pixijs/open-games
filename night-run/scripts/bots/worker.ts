/**
 * A Node worker for the bot scripts: races what `pool.ts` sends it, a line's score or a whole headless race, on the
 * game's own modules.
 */

import { parentPort } from 'node:worker_threads';

import { lineFor } from '../../src/race/line/RacingLine';
import { scoreLine } from '../../src/race/line/search';
import type { SimTrack } from '../../src/race/line/sim';
import { runRace, simTrack } from '../../src/race/line/sim';
import type { TrackDef } from '../../src/track/code';
import { decodeTrack, isTrackError } from '../../src/track/code';
import type { PoolTask } from './pool';

const tracks = new Map<string, SimTrack>();

function trackOf(code: string): SimTrack {
  let track = tracks.get(code);

  if (!track) {
    const def = decodeTrack(code);

    if (isTrackError(def)) throw new Error(`Bad track ${code}: ${def}`);

    track = simTrack(def as TrackDef);
    tracks.set(code, track);
  }

  return track;
}

parentPort!.on('message', ({ id, task }: { id: number; task: PoolTask }) => {
  const track = trackOf(task.code);

  if (task.kind === 'score') {
    parentPort!.postMessage({ id, result: scoreLine(track, task.offsets, task.conditions) });
  } else {
    const { offsets, ...options } = task.race;

    parentPort!.postMessage({ id, result: runRace(track, { ...options, line: lineFor(track.route, offsets) }) });
  }
});
