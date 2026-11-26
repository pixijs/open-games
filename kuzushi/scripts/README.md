# Scripts

Headless screenshots and frame-time measurements of the running game. Start the dev server first.

## Shooting

`node scripts/shot.mjs` drives the installed Chrome through a list of steps; its header lists the options and the step types (`--dpr 2` shoots a retina screen). The game runs on WebGPU there; add `?renderer=webgl` to the URL to shoot WebGL. Shots go in `shots/` (ignored by git); save them as `.jpg`.

- **Loading.** The steps start `--wait` ms (default 1500) after the game has loaded: the performance mark `kuzushi:loaded`, when `window.__game`, `__title` and `__lab` land. The browser this script drives lets audio play without a press, so the music plays from the title on. A game that never loads (60 s, `--load-timeout`) or whose loader shows a failure ends the run with exit 1 and the reason.
- **The loader.** `?loading=hold` keeps it up after loading: `window.__loading.set(share)` moves its bar (0 to 1) and `window.__loading.finish()` plays its outro, whose CSS animations `document.getElementById("loading").getAnimations({ subtree: true })` can pause and seek drawing by drawing (each 1/12 s).
- **Compiles after loading.** `?compiles` warns of each one and `?compiles=strict` makes each a console error naming its program (`compiled after loading: <kind> <label>`), so a step list fails on it; `window.__game.compiles()` lists them and `loadReport()` says what loading uploaded and drew, with any pose it gave up on in `unsettled`. Play's programs still compile on first draw, so only lists that stay on the title pass with `?compiles=strict`.

- **Page helpers** load with an `evalFile` step:
  - `scripts/autopilot.js` plays the game (`window.__bot`): it fights in any weapon's style, dodges telegraphs, parries orbs, takes a chosen weapon from an altar and drinks from springs. With `explore` it walks out through doors toward unexplored rooms, the boss and the gate; with `rush`, straight to the boss.
  - `scripts/dungeon.js` adds `window.__dungeon.walk(target)`: walk out through a side's door, the door to a room, or the gate.
  - `scripts/measure.js` adds `window.__measure(label, seconds)` for frame times.
- **Frozen frames.** `__game.freeze` and `step` hold and step the simulation. The boss's name card and the zone card follow it, being scrubbed by the view's progress; everything else in the UI runs on GSAP's clock, which `freeze` pauses. The title scene runs its own loop clock, `window.__title.time()`.
- **Long lists** are cut short when the dev server reloads the page because a file changed. Run them against a server started with `server: { hmr: false, watch: null }`.

`scripts/swaps.mjs` (run with node, a URL and a zone) walks 30 door transitions and prints each one's worst frame and the heap before and after, for leaks.

## Shader compiles and load time

`scripts/compiles.js` records every shader compile (WebGPU pipelines and modules, WebGL shaders and programs, each labelled with its program) and every frame's time. It has to run before the game makes its device or context, so it loads with `--init`, never `evalFile`. Its header lists `window.__compiles`. Loading ends when `window.__game` lands, which it marks `loaded`; everything compiled after that mark is a hitch in play. `?compiles-cold` in the URL salts every shader so the OS caches miss, as on a first visit.

- `scripts/steps/compiles.json` walks the game through the debug API in about 140 s at 1×: the title's loop, its menus and a settings change, the run panel locked and open, a run from the zone card, the altar, the map, pause and its panels, a Courtyard fight (the autopilot, then each kind attacking, one hurt and one behind a pillar), each weapon, the special, the Gatekeeper's patterns, shift, break and fall, the gate into The Spiral, the Well's beam and its kinds, the Dial, the Orrery, a Void collapse room with its kinds and 24 splitlings, Sunder, the run's clear, a game over and the title again. The rooms come from fixed seeds and each is checked by template and mirroring. Each beat waits for its state (`__compiles.reach`) and logs a console error when it never comes. It ends with a table of compiles per segment, the label of every compile after loading, then `__compiles.expectNone()`, which logs a console error for any. It exits 0 only when nothing compiled after loading, so today it exits 1 and its table is the list of what play still compiles on first draw. Run both renderers at once; the counts don't depend on GPU contention:

  ```sh
  node scripts/shot.mjs --init scripts/compiles.js --steps scripts/steps/compiles.json > webgpu.log &
  node scripts/shot.mjs --init scripts/compiles.js --steps scripts/steps/compiles.json --url 'http://localhost:5352/?renderer=webgl' > webgl.log &
  wait
  ```

- `scripts/steps/load-time.json` prints when loading ended, when the first frame after it was shown, and the frame times over the title's next 6.5 s. Run it with `--wait 0`, alone on the GPU, warm and with `?compiles-cold`. Loading waits for the GPU to finish what it was sent before the title starts, so on WebGPU a cold run's time includes the pipelines the GPU process compiles after their calls return; no frame after loading should pass 33 ms, warm or cold. `__game.loadReport().steps` says what each step cost.

## Step lists

`scripts/steps/` holds ready-made lists. These are the ones to start from:

- `title.json`: the title at rest, its impact and shatter beats, each submenu, a settings change, the run panel with every zone open. `settings.json`: settings changed on the title, then the FPS readout and a special with impact flashes off in play.
- `stage-courtyard.json`, `stage-spiral.json`, `stage-void.json`: from the menu into each zone, a fight in one of its combat rooms, its hazard (the beam; ring-outs and falling slabs), pause and its panels, the run's clear, game over.
- `dungeon-rooms.json`: each zone's start room, a locked combat room in each zone, a cleared one. `dungeon-transition.json`: a door transition frame by frame, beat by beat. `dungeon-boss.json`: the Courtyard's boss room, the spring its boss leaves rising frame by frame, its gate opening, the zone change into The Spiral, the Void's boss room and the run's clear. `dungeon-clear.json`: a locked combat room of the Courtyard and of the Void fought by the autopilot until it clears (the seals, the fight, the last kill's slow motion frame by frame, the seals breaking).
- `zones-rooms.json`: every room of one dungeon in each zone with its fight ended, then a sealed room per zone, into `shots/zones/rooms/`. `zones-door.json`: a door transition frozen and stepped in each zone, into `shots/zones/door-<zone>/`. `zones-gate.json`: the Courtyard boss's name-card shot, its gate opening and the zone change into The Spiral frame by frame, into `shots/zones/gate/`.
- `lab-<scene>.json` (special, attacks, gallery, threats, bosses, movement, zones, rooms, dungeon, doors): each lab scene through its controls in every zone it needs, into `shots/lab/<scene>/`. Each opens its scene itself (`window.__lab.open`), so any URL works. `lab-extras.json` goes in through EXTRAS and back out; `lab-scenes.json` shoots every scene once.
- `ui-dungeon.json`: the first zone's banner, the altar's prompt and a swap, a door, the seals and wave banner, the full map on Tab and M, a room's CLEAR, pause's map, an elite wave in The Spiral with darts, The Void with FOCUS full. `ui-boss.json`: the Gatekeeper's name card frame by frame, its bar hit, broken, shifting and felled, the zone's clear. `ui-zone-card.json`: the zone change from The Spiral into The Void frame by frame. `ui-run.json`: the run panel locked and open, a practice start in The Void and its clear, a full run's clear with its rank, the panel after. All shoot into `shots/interface/`. `ui-sizes.json` shoots the title, a banner, the HUD, pause and a clear at whatever `--size` it runs, and prints the HUD's and the boss bar's rects from `window.__ui.rects()`.
- `perf.json`: frame times on the title, in a busy combat room of each zone (its wave plus six more of its kinds; the Spiral's beam sweeping), the special, each boss's first and last phase, about ten door transitions on the lab's loop, and the special and gallery lab scenes; shots into `shots/integrate/perf/`.
- `boss-rooms.json`: what each boss does to its room (a Gatekeeper charge breaking a pillar, the Orrery's beam lighting at its shift, Sunder's slabs cracking and falling at each shift), into `shots/integrate/boss-rooms/`.
- `full-run.json`: a whole run with the autopilot from the title: zone 1 explored room by room (the darts taken from the first room's altar), its boss, the gate and zone card, then zones 2 and 3 straight to their bosses, the results, then a game over. It freezes on each moment it shoots, into `shots/lab/full-run/`.
- `arsenal-<weapon>.json` (blade, breaker, darts, sigil): each weapon's moves as frame sequences in a frozen sandbox, into `shots/arsenal/<weapon>/`. `lab-attacks.json` plays every weapon's chain in the attacks scene.
- `bestiary-kinds.json`: the sweeper's, pulsar's, leaper's and cutter's attacks as frozen frame sequences in their zones. `bestiary-gatekeeper.json`, `bestiary-orrery.json`, `bestiary-sunder.json`: each boss's name card, every pattern, each shift, its break and its defeat, frame by frame (`__game.bossPattern`, `bossPhase`, `breakBoss`, `bossHealth`).
- `art-*.json`: frame sequences of the later zones' enemies' attacks, the beam, the slabs, ring-outs, the special in each stage and the play frame's limits. `stages-*.json`: the stages' debug hooks.
