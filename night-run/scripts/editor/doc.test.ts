/**
 * The editor's document operations, checked in Node: laying, rubbing out
 * and closing road, the refusals, reroutes either side of the start line, erasing, the start line's placement, hops
 * and reversal, the start fix on a family of loops with no start, routing to a cell, mirroring, nudging, the round
 * trip through a track and back for every suite track in every orientation, and Shuffle on 500 seeds. Then the
 * strokes the board drives: an open road stays open until a stroke closes it, a reroute always drops the shorter side,
 * and road laid from one end rings the other.
 *
 *   npx tsx scripts/editor/doc.test.ts
 */

import assert from 'node:assert/strict';

import type { TrackDef } from '../../src/track/code';
import { BASE_TRACK, decodeTrack, isTrackError } from '../../src/track/code';
import type { BoardCell, Rot, TrackDoc } from '../../src/track/doc';
import {
  adjacent,
  backtrack,
  BOARD_H,
  BOARD_W,
  cellAt,
  close,
  EMPTY_DOC,
  erase,
  eraseSpan,
  extend,
  feel,
  finishSpots,
  fromTrack,
  measure,
  mirror,
  moveFinish,
  nudge,
  placement,
  reroute,
  rerouteDrop,
  reverse,
  routeTo,
  shuffle,
  startFix,
  status,
  stepCell,
  template,
  toBoard,
  toTrack,
} from '../../src/track/doc';
import { rng } from '../../src/track/generate';
import { TRACK_SUITE } from '../../src/track/hooks';
import type { StrokeFeedback } from '../../src/ui/editor/Strokes';
import { Strokes } from '../../src/ui/editor/Strokes';

let checks = 0;

function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`ok  ${name}`);
}

const c = (bx: number, by: number): BoardCell => cellAt(bx, by);
const line = (pts: readonly (readonly [number, number])[]): BoardCell[] => pts.map(([x, y]) => c(x, y));

/** A straight run of cells from (x, y), `n` long, heading `dir` (0 east, 1 south, 2 west, 3 north). */
function run(x: number, y: number, n: number, dir: number): BoardCell[] {
  const out = [c(x, y)];

  while (out.length < n) out.push(stepCell(out[out.length - 1], dir));

  return out;
}

/** Whether a document is a sound path: board cells, no repeats, each beside the next (and round, when closed). */
function sound(doc: TrackDoc): boolean {
  const seen = new Set<BoardCell>();

  for (let i = 0; i < doc.path.length; i++) {
    const cell = doc.path[i];

    if (cell < 0 || cell >= BOARD_W * BOARD_H || seen.has(cell)) return false;
    seen.add(cell);
    if (i > 0 && !adjacent(doc.path[i - 1], cell)) return false;
  }

  return !doc.closed || adjacent(doc.path[0], doc.path[doc.path.length - 1]);
}

check('extend lays neighbours, rubs out with backtrack, and closes into a loop with a start', () => {
  let doc = extend(EMPTY_DOC, 'head', run(3, 2, 8, 0));

  assert.equal(doc.path.length, 8);
  assert.equal(status(doc), 'open');
  doc = extend(doc, 'head', run(10, 3, 3, 1));
  doc = extend(doc, 'head', run(9, 5, 7, 2));
  doc = extend(doc, 'head', [c(3, 4), c(3, 3)]);
  assert.equal(doc.path.length, 20);
  assert.equal(backtrack(doc, 'head', 2).path.length, 18);
  assert.equal(backtrack(doc, 'tail', 3).path[0], c(6, 2));

  const loop = close(doc);

  assert.equal(loop.closed, true);
  assert.equal(status(loop), 'ready');
  // Two six-straight sides: the tie goes to the one nearest where drawing began, its middle leaning back.
  assert.equal(loop.path[loop.finish], c(6, 2));
  assert.deepEqual(finishSpots(loop).includes(loop.finish), true);
  // Extending from the tail prepends.
  assert.equal(extend(extend(EMPTY_DOC, 'head', [c(5, 5)]), 'tail', [c(4, 5), c(3, 5)]).path[0], c(3, 5));
});

check('extend refuses a crossing and the board edge; close refuses ends apart', () => {
  const doc = extend(EMPTY_DOC, 'head', [...run(2, 2, 4, 0), ...run(5, 3, 2, 1), c(4, 4), c(4, 3)]);

  assert.equal(doc.path.length, 8);
  // Back into its own road: refused at that cell, the rest not laid either.
  assert.equal(extend(doc, 'head', [c(4, 2), c(4, 1)]).path.length, 8);
  // Off the board: stepCell gives -1 and extend stops.
  const edge = extend(EMPTY_DOC, 'head', [c(0, 0)]);

  assert.equal(stepCell(c(0, 0), 2), -1);
  assert.equal(extend(edge, 'head', [stepCell(c(0, 0), 3)]).path.length, 1);
  // Not next to the head.
  assert.equal(extend(edge, 'head', [c(2, 0)]).path.length, 1);
  assert.equal(close(doc), doc);
});

check('a loop with no straight of three closes with no start, and the 10-cell oval is the smallest track', () => {
  const square = close(extend(EMPTY_DOC, 'head', [c(1, 1), c(2, 1), c(2, 2), c(1, 2)]));

  assert.equal(square.closed, true);
  assert.equal(status(square), 'noStart');
  assert.equal(square.finish, -1);

  const small = close(extend(EMPTY_DOC, 'head', [...run(1, 1, 5, 0), ...run(5, 2, 1, 1), ...run(4, 2, 4, 2)]));

  assert.equal(small.path.length, 10);
  assert.equal(status(small), 'ready');
  assert.equal(toTrack(small, '') !== 'start' && !isTrackError(toTrack(small, '')), true);
});

check('reroute: the shorter side goes (the start fix may take the other), the race keeps its direction', () => {
  const oval = template('oval');
  const turns = (doc: TrackDoc): string => (toTrack(doc, '') as TrackDef).turns;

  assert.equal(status(oval), 'ready');

  // From (5,2) on the top straight out north two cells, along, and back down onto (8,2).
  const from = oval.path.indexOf(c(5, 2));
  const to = oval.path.indexOf(c(8, 2));
  const cells = line([
    [5, 1],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [8, 1],
  ]);
  const drop = rerouteDrop(oval, from, to, false);

  assert.deepEqual(
    drop.map((i) => oval.path[i]),
    [c(6, 2), c(7, 2)],
  );

  const short = reroute(oval, from, cells, to, false);

  assert.equal(sound(short), true);
  assert.equal(short.path.length, 20 - 2 + 6);
  assert.equal(status(short), 'ready');
  // The start was on (6,2), in the dropped part: it hops along the old route, ahead first.
  assert.notEqual(short.path[short.finish], c(6, 2));
  assert.equal(finishSpots(short).includes(short.finish), true);

  const long = reroute(oval, from, cells, to, true);

  assert.equal(sound(long), true);
  assert.equal(long.path.length, 2 + 2 + 6);
  assert.deepEqual(rerouteDrop(oval, from, to, true).length, 20 - 4);
  // Both keep travelling the kept road the same way: (5,2) then the detour clockwise.
  assert.equal(long.path.indexOf(c(5, 1)) >= 0, true);
  // What's left is a 4 by 3 ring: no straight of three, so the start line has nowhere to hop.
  assert.equal(status(long), 'noStart');
  assert.equal(long.finish, -1);

  // With the start outside the dropped part it stays where it is.
  const bottomFrom = oval.path.indexOf(c(9, 5));
  const bottomTo = oval.path.indexOf(c(7, 5));
  const bottom = reroute(
    oval,
    bottomFrom,
    line([
      [9, 6],
      [8, 6],
      [7, 6],
    ]),
    bottomTo,
    false,
  );

  assert.equal(bottom.path[bottom.finish], oval.path[oval.finish]);
  assert.equal(turns(bottom).length, 20 - 1 + 3);
});

check('reroute on an open road replaces the stretch between, whichever way it was drawn', () => {
  const road = extend(EMPTY_DOC, 'head', run(2, 4, 8, 0));
  const detour = line([
    [4, 3],
    [5, 3],
    [6, 3],
  ]);
  const forward = reroute(road, 2, detour, 4, false);

  assert.deepEqual(
    forward.path.slice(0, 7),
    line([
      [2, 4],
      [3, 4],
      [4, 4],
      [4, 3],
      [5, 3],
      [6, 3],
      [6, 4],
    ]),
  );

  const backward = reroute(road, 4, [...detour].reverse(), 2, false);

  assert.deepEqual(backward.path, forward.path);
  assert.equal(forward.closed, false);
});

check('eraseSpan: one span off a loop, from an open end, and refused in an open road`s middle', () => {
  const oval = template('oval');
  const at = (x: number, y: number): number => oval.path.indexOf(c(x, y));
  // Along the top straight, off onto the grass, then across the bottom straight: only the first span goes.
  const touched = [at(5, 2), at(6, 2), at(7, 2), -1, -1, at(7, 5), at(6, 5)];
  const span = eraseSpan(oval, touched);

  assert.notEqual(span, 'middle');
  assert.deepEqual(
    (span as number[]).map((i) => oval.path[i]),
    [c(5, 2), c(6, 2), c(7, 2)],
  );

  const opened = erase(oval, span as number[]);

  assert.equal(opened.closed, false);
  assert.equal(opened.path.length, 17);
  assert.equal(opened.path[0], c(8, 2));
  assert.equal(opened.path[16], c(4, 2));
  assert.equal(status(opened), 'open');

  // Straight from one span onto a parallel lane that isn't the next cell of the road: the stroke has left the span.
  const lanes = eraseSpan(oval, [at(4, 2), at(4, 3)]);

  assert.deepEqual(lanes, [at(4, 2)]);

  const road = extend(EMPTY_DOC, 'head', run(2, 4, 8, 0));

  assert.equal(eraseSpan(road, [3, 4, 5]), 'middle');
  assert.deepEqual(eraseSpan(road, [7, 6]), [6, 7]);
  assert.deepEqual(erase(road, eraseSpan(road, [1, 0]) as number[]).path, road.path.slice(2));
  assert.deepEqual(erase(road, [0, 1, 2, 3, 4, 5, 6, 7]), EMPTY_DOC);
});

check('the start line: placement, moving it only onto straights, hops, and reverse', () => {
  const oval = template('oval');
  const spots = finishSpots(oval);

  assert.equal(spots.length, 8);
  assert.equal(moveFinish(oval, spots[5]).finish, spots[5]);
  // A corner, and a straight's end cell beside a corner, aren't spots.
  assert.equal(moveFinish(oval, oval.path.indexOf(c(10, 2))), oval);
  assert.equal(moveFinish(oval, oval.path.indexOf(c(4, 2))), oval);

  const back = reverse(oval);

  assert.equal(back.path[back.finish], oval.path[oval.finish]);
  assert.equal(status(back), 'ready');

  const there = toTrack(oval, '') as TrackDef;
  const away = toTrack(back, '') as TrackDef;

  // The same cells the other way: the turns read backwards from the start line, each one the other hand.
  const backwards = there.turns[0] + [...there.turns.slice(1)].reverse().join('');

  assert.equal(away.turns, backwards.replace(/R/g, 'L'));
  assert.equal(placement(back).rot, ((placement(oval).rot + 2) % 4) as Rot);
  assert.deepEqual(reverse(back), oval);
});

check('startFix on a seeded family of loops with no start gives a track or nothing, never a broken loop', () => {
  const rand = rng(99);
  const family: TrackDoc[] = [];

  // Rings up to 4 a side, and loops grown from them by random detours, kept while they have no straight of three.
  for (let w = 2; w <= 4; w++) for (let h = 2; h <= 4; h++) family.push(ringDoc(4, 2, w, h));

  for (let k = 0; family.length < 300 && k < 20000; k++) {
    const base = family[Math.floor(rand() * family.length)];
    const grown = randomDetour(base, rand);

    if (grown && status(grown) === 'noStart') family.push(grown);
  }

  let fixed = 0;

  for (const doc of family) {
    assert.equal(status(doc), 'noStart');

    const fix = startFix(doc);

    if (!fix) continue;

    const next = reroute(doc, fix.from, fix.cells, fix.to, fix.longer);

    assert.equal(sound(next), true);
    assert.equal(status(next), 'ready');
    fixed++;
  }

  console.log(`    ${fixed} of ${family.length} fixed`);
  assert.ok(fixed > family.length * 0.9);
});

check('routeTo lays a straight or an L, either leg first, and refuses a blocked way', () => {
  const road = extend(EMPTY_DOC, 'head', run(2, 2, 3, 0));

  assert.deepEqual(routeTo(road, 'head', c(8, 2), 'x'), run(5, 2, 4, 0));
  assert.deepEqual(routeTo(road, 'head', c(6, 5), 'x'), [...run(5, 2, 2, 0), ...run(6, 3, 3, 1)]);
  assert.deepEqual(routeTo(road, 'head', c(6, 5), 'y'), [...run(4, 3, 3, 1), ...run(5, 5, 2, 0)]);
  assert.equal(routeTo(road, 'tail', c(6, 2), 'x'), null);
  assert.deepEqual(routeTo(road, 'tail', c(0, 2), 'x'), [c(1, 2), c(0, 2)]);
});

check('mirror flips left and right in place; nudge moves, refused at the edge', () => {
  const nr = template('nightrun');
  const flipped = mirror(nr);
  const there = toTrack(nr, '') as TrackDef;
  const back = toTrack(flipped, '') as TrackDef;

  assert.equal(
    back.turns,
    there.turns.replace(/[LR]/g, (t) => (t === 'L' ? 'R' : 'L')),
  );
  assert.deepEqual(mirror(flipped), nr);

  const moved = nudge(nr, 1, 0);

  assert.ok(moved);
  assert.equal(moved.path[0], nr.path[0] + 1);
  assert.equal(nudge(template('ring'), 1, 0), null);
  assert.equal(nudge(template('ring'), 0, -1), null);
});

check('toTrack and fromTrack round trip every suite track, in every orientation that fits', () => {
  for (const [name, code] of Object.entries(TRACK_SUITE)) {
    const def = decodeTrack(code) as TrackDef;

    assert.equal(isTrackError(def), false, name);

    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const doc = fromTrack(def, rot);
      const back = toTrack(doc, '');

      assert.equal(sound(doc), true, name);
      assert.equal(isTrackError(back), false, `${name} rot ${rot}`);
      assert.equal((back as TrackDef).code, def.code, `${name} rot ${rot}`);

      // The orientation it was laid in is the one placement reads back, when it fits that way.
      const place = placement(doc);
      const fits = (() => {
        const xs = def.cells.map(([x, z]) => toBoard(x, z, { rot, dx: 0, dz: 0 }));
        const w = Math.max(...xs.map((p) => p[0])) - Math.min(...xs.map((p) => p[0])) + 1;
        const h = Math.max(...xs.map((p) => p[1])) - Math.min(...xs.map((p) => p[1])) + 1;

        return w <= BOARD_W && h <= BOARD_H;
      })();

      if (fits) assert.equal(place.rot, rot, `${name} rot ${rot}`);

      // Every cell of the canonical track lands on the board where placement says.
      def.cells.forEach(([x, z], i) => {
        const [bx, by] = toBoard(x, z, place);

        assert.equal(doc.path[i], c(bx, by), `${name} rot ${rot} cell ${i}`);
      });
    }
  }

  assert.equal(template('nightrun').path.length, BASE_TRACK.cells.length);
  assert.equal(placement(template('nightrun')).rot, 0);
  assert.equal((toTrack(template('nightrun'), 'Remix') as TrackDef).code, '');
});

check('feel and measure: Night Run is Twisty at 0.41, 110.2 m; the oval is Wild', () => {
  assert.equal(feel(BASE_TRACK.turns).word, 'Twisty');
  assert.equal(feel(BASE_TRACK.turns).corners, 6);
  assert.ok(Math.abs(measure(BASE_TRACK.turns).metres - 110.2326) < 0.001);
  assert.equal(feel('SSRRSSSRRS').word, 'Wild');
  assert.equal(feel((decodeTrack(TRACK_SUITE.ring) as TrackDef).turns).word, 'Flowing');
});

check('templates and Shuffle: 500 seeds all ready', () => {
  assert.equal(status(template('oval')), 'ready');
  assert.equal(template('oval').path.length, 20);
  assert.equal(status(template('ring')), 'ready');
  assert.equal(template('ring').path.length, 42);
  assert.equal(status(template('blank')), 'empty');

  for (let seed = 0; seed < 500; seed++) {
    const doc = shuffle(seed);

    assert.equal(sound(doc), true, `seed ${seed}`);
    assert.equal(status(doc), 'ready', `seed ${seed}`);
  }
});

/** A stroke's feedback with nobody listening: the checks read what the strokes commit and paint. */
const QUIET: StrokeFeedback = {
  refuse: () => undefined,
  laid: () => undefined,
  rubbed: () => undefined,
  pulseEnds: () => undefined,
  hint: () => undefined,
  bubble: () => undefined,
  showDirection: () => undefined,
};

/** Drags a stroke through cells (each step one cell over, as the board reports it) and lets go. */
function stroke(doc: TrackDoc, cells: readonly BoardCell[], s = new Strokes(QUIET)): TrackDoc {
  s.down(doc, cells[0], false);
  s.begin();
  for (const cell of cells.slice(1)) s.to(cell);

  return s.up()?.doc ?? doc;
}

check('a stroke that ends away from its start leaves an open road: nothing joins the ends for the player', () => {
  const u = stroke(EMPTY_DOC, [...run(4, 2, 5, 1), ...run(5, 6, 5, 0), ...run(9, 5, 4, 3)]);

  assert.equal(u.closed, false);
  assert.equal(status(u), 'open');
  assert.equal(u.path.length, 14);

  // Drawn on from the head round to the tail, it closes into a track the way it was drawn.
  const loop = stroke(u, [c(9, 2), c(9, 1), ...run(8, 1, 5, 2), c(4, 2)]);

  assert.equal(loop.closed, true);
  assert.equal(status(loop), 'ready');
  assert.equal(loop.path.length, 14 + 6);
});

check('a reroute stroke always drops the shorter side, either way round the loop', () => {
  const oval = template('oval');
  const out = [c(5, 2), c(5, 1), c(5, 0), c(6, 0), c(7, 0), c(8, 0), c(8, 1), c(8, 2)];

  for (const cells of [out, [...out].reverse()]) {
    const next = stroke(oval, cells);

    assert.equal(sound(next), true);
    assert.equal(status(next), 'ready');
    // The two cells between (5,2) and (8,2) go; the long way round stays.
    assert.equal(next.path.length, 20 - 2 + 6);
    assert.equal(next.path.includes(c(6, 2)) || next.path.includes(c(7, 2)), false);
  }
});

check('road laid from one end rings the other, the end it closes on', () => {
  const road = extend(EMPTY_DOC, 'head', run(3, 3, 5, 0));
  const s = new Strokes(QUIET);

  s.down(road, c(7, 3), false);
  s.begin();
  s.to(c(7, 4));
  assert.equal(s.paint()?.kind, 'lay');
  assert.equal(s.paint()?.target, c(3, 3));

  // From the tail, the head is the one it closes on.
  s.cancel();
  s.down(road, c(3, 3), false);
  s.begin();
  s.to(c(3, 4));
  assert.equal(s.paint()?.target, c(7, 3));
  s.cancel();
  assert.equal(s.paint(), null);
});

console.log(`\n${checks} checks passed`);

/** A ring w by h with its top-left at (x, y), closed clockwise. */
function ringDoc(x: number, y: number, w: number, h: number): TrackDoc {
  const cells: BoardCell[] = [];

  for (let i = x; i < x + w; i++) cells.push(c(i, y));
  for (let j = y + 1; j < y + h; j++) cells.push(c(x + w - 1, j));
  for (let i = x + w - 2; i >= x; i--) cells.push(c(i, y + h - 1));
  for (let j = y + h - 2; j > y; j--) cells.push(c(x, j));

  return close(extend(EMPTY_DOC, 'head', cells));
}

/** A random short detour off a loop: out from one road cell over free cells and back onto another. */
function randomDetour(doc: TrackDoc, rand: () => number): TrackDoc | null {
  const n = doc.path.length;
  const from = Math.floor(rand() * n);
  const used = new Set(doc.path);
  const cells: BoardCell[] = [];
  let at = doc.path[from];

  for (let step = 0; step < 6; step++) {
    const options = [0, 1, 2, 3].map((d) => stepCell(at, d)).filter((x) => x >= 0);
    const back = options.filter((x) => used.has(x) && x !== doc.path[from] && cells.length > 0);

    if (back.length > 0 && rand() < 0.6) {
      const to = doc.path.indexOf(back[Math.floor(rand() * back.length)]);

      return reroute(doc, from, cells, to, rand() < 0.5);
    }

    const free = options.filter((x) => !used.has(x) && !cells.includes(x));

    if (free.length === 0) return null;

    at = free[Math.floor(rand() * free.length)];
    cells.push(at);
  }

  return null;
}
