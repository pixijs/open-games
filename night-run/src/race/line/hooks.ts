/**
 * `window.__lines`, for harnesses: how far each track's line search has come, waiting for a stage, the line the bots
 * race now and which line each bot took. Nothing in the game calls it.
 */

import type { Race } from '../../Race';
import { registerTestHook } from '../../testHooks';
import type { LineService, LineStage, LineStatus } from './LineService';

const ORDER: readonly LineStage[] = ['centre', 'heuristic', 'refined'];
/** How often `wait` looks. */
const POLL_MS = 50;

/**
 * Put `window.__lines` up.
 * @param lines - The game's line service.
 * @param race - The race, whose course says which track is built and whose bots say which line they took.
 */
export function installLineHooks(lines: LineService, race: Race): void {
  const status = (code?: string): LineStatus => lines.status(code ?? race.course.def.code);

  registerTestHook('__lines', {
    status,
    /**
     * Resolves with the status once the built track's line reaches `stage` (Night Run's is always there), or once
     * `timeoutMs` passes, whichever is first.
     */
    wait: (stage: LineStage, timeoutMs: number, code?: string): Promise<LineStatus> =>
      new Promise((resolve) => {
        const until = performance.now() + timeoutMs;
        const look = () => {
          const now = status(code);
          const reached = now.stage === 'shipped' || ORDER.indexOf(now.stage) >= ORDER.indexOf(stage);

          if (reached || performance.now() >= until) resolve(now);
          else setTimeout(look, POLL_MS);
        };

        look();
      }),
    offsets: (code?: string): number[] => lines.offsets(code ?? race.course.def.code).slice(),
    /** Each bot's lap and the search's count when its line was found: -1 for none, Night Run's included. */
    botLines: (): { id: string; lap: number; evals: number }[] =>
      race.racers
        .filter((racer) => racer.kind === 'bot' && racer.brain)
        .map((racer) => ({ id: racer.id, lap: racer.progress.lap, evals: lines.evalsOf(racer.brain!.line) })),
    /** `performance.now()` when the built track's line was first asked for. */
    askedAt: (code?: string): number => lines.askedAt(code ?? race.course.def.code),
    /** Workers made on this page. */
    get workers(): number {
      return lines.workers;
    },
    /** When each candidate scored on this page finished, ms since the epoch. */
    scoredAt: (): number[] => lines.scoredAt.slice(),
    /**
     * Each pause of the search, from a countdown or a hidden page: from and to in ms since the epoch (`to` is null
     * while it lasts), and the candidates taken in when it began.
     */
    pauses: (): { from: number; to: number | null; scored: number }[] => lines.pauses.map((pause) => ({ ...pause })),
  });
}
