# Bot checks

Node scripts that race the game's own bots headless, with `npx tsx` from this game's folder. They import the
game's modules unchanged: `src/race/line/sim.ts` (the headless race: `Vehicle`, `PhysicsWorld`, `DriftBoost`,
`RaceRules` and `BotDriver` on a track's ground and walls, stepped in `Race.update`'s order) and
`src/race/line/search.ts` (how a line is scored and searched for). `pool.ts` runs the races on `worker_threads`,
half the machine's cores unless `--workers N` says otherwise.

| Script             | What it does                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `verify-base.ts`   | Night Run against its recording from before tracks became data, bit for bit. Run it after any change.                         |
| `run-reference.ts` | Searches each suite track for twice the game's budget and writes `reference/best-<name>.json`.                                |
| `run-calibrate.ts` | The long-track calibration: `ring`, `snake`, `long500` and `max`, every checkpoint measured. Writes `results/calibration.md`. |
| `run-suite.ts`     | Holds every suite track's lines to the competence bars. Writes `results/suite.md` and `results/suite.json`.                   |

`suite.ts` lists the tracks, from the 68 m oval to `max`, the 899 m serpentine that fills the board, and the bars;
`validate.ts` measures one line; `search.ts` drives the game's `LineSearch` on the pool.

## The search, in brief

A custom track's bots race its centreline at once. The search then races 55 lines that aim toward the inside of each
bend (the centreline and a grid of how far, how smoothly and how early) at three conditions; the best six and the
centreline race three more, and the best of them over all six is the heuristic stage's line, so it never trails the
centreline there. Then it runs CMA-ES over the whole line from there for 18 candidates a point of the line, at least
1600, with no cap, rounded up to whole stretches between the panel races below: 1647 on a 110 m track, 6545 on
`max`. A line has one point every 2.5 m. Past 200 points CMA-ES keeps only the covariance's diagonal, whose work
grows with the points rather than their cube.

A candidate races alone from the grid, two laps a condition (one from 400 m), since the host's screen and the rubber
band set the bots' physics. Its score is the race time plus 2 s a hard wall hit, 5 s a respawn and 2 s a back-out.
The truck slides through every bend, so a lap is chaotic in the conditions, and a search scored at a few fixed ones
learns their luck: its best-scoring line threads them and scrapes the walls at the rates between. So each CMA-ES
generation races at three conditions of its own, drawn from 30 to 165 Hz and top speeds x0.9 to x1.1 with a frame
clock that wavers by up to 15%, and the line the bots race is chosen on a fixed panel of six conditions no generation
draws (`LINE_PANEL` in `src/race/line/search.ts`): every four generations CMA-ES's mean races the panel, and becomes
the line only by beating it there. A lone truck repeats exactly and the search's own arithmetic is the same in every
engine (`src/race/line/portable.ts`), so a line scores the same on any worker or thread, and the seeded search finds
the same lines in Node as in Chrome.

## Re-running the references

The references define T3, T4 and T9, so make them again whenever the physics, the bot's controller or the objective
changes (and bump `LINE_VERSION` in `src/race/line/LineService.ts`, so players' cached lines are searched again):

```sh
npx tsx scripts/bots/run-reference.ts            # every suite track; or name some: run-reference.ts oval max
npx tsx scripts/bots/run-calibrate.ts
npx tsx scripts/bots/run-suite.ts                # add --search to search again and check it finds the same lines
```

A reference search is the game's search run on, seeded the same and racing the panel at the same counts, so its line
at the game's budget is exactly the line the game finds; `run-suite.ts` races that checkpoint as the refined line, and
`--search` proves it.

## The bars

Each line is raced alone at paces 1, 0.92 and 0.85 at 30, 60, 120, 144 and 240 Hz (4 laps; 2 from 400 m); chased,
with the rubber band's reference held 30 m ahead, and eased, held 25 m behind, at paces 1 and 0.85 at 30, 60 and
144 Hz (3 laps); and as a four-bot field over three seeds. `U` is a track's U-turns a lap (two same-hand corners in
a row) and `G` its corner groups.

| #   | Bar                                                                                                                  | Lines       |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| T1  | No failed lap, alone, chased, eased or in the field                                                                  | every stage |
| T2  | No back-out or respawn alone, chased or eased; field respawns at most 0.25 per km; no crawl under 1.2 m/s over 0.5 s | every stage |
| T3  | Pace-1 lap, mean of the five rates, within 3% of the reference (5% past 250 m)                                       | refined     |
| T4  | Within 10% of the reference at each rate                                                                             | refined     |
| T5  | Ultras a lap at least `min(0.9 * lap / 100, 0.5 * G)`                                                                | refined     |
| T6  | Hard wall hits a lap alone at most `0.12 * U + 0.1 * lap / 100`                                                      | refined     |
| T9  | Within 25% of the reference                                                                                          | heuristic   |
| T10 | Hard wall hits a lap chased at most three times T6's bar plus 0.3                                                    | refined     |

Night Run's shipped line is held to the refined bars, and `verify-base.ts` checks that Night Run races as it
shipped. `results/suite.md`, which `run-suite.ts` writes (git ignores it), ends with the bars the current lines miss.
At the time of writing those are two tracks' T5, which their references miss too (the fastest lines found there fire
fewer ultras than the bar asks), and two tracks' T3, where the search at the game's budget stops 3.7 and 4.1% short
of the line it finds with twice the candidates. Field races start as on a fresh thread, so a run repeats exactly.
