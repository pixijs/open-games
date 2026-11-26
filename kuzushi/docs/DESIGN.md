# KUZUSHI design

A sakuga-styled top-down action game: a white arrowhead fights through three zones of generated rooms, each zone a place with its own colours, enemies and boss, where every hit is drawn like a hand-animated anime moment. The concept boards are `docs/reference/kuzushi-board.png` and `docs/reference/kakuhan-board.png`.

This page mirrors the code's numbers (`src/sim/tuning.ts`, `src/sim/dungeon/rules.ts`, `src/art/palette.ts`); when the two disagree, the code wins and this page is fixed. Where each part lives, in the simulation and on screen: `docs/LAYOUT.md`.

## Conventions

- **Steps.** The simulation runs at 60 steps per second. Durations are whole steps (`Clock.duration`), timers are deadlines on a clock, never floats counted down.
- **Space.** The ground is the x/z plane, y up. One unit is about the player's width. Up on the screen is -z (the camera looks north). Each room has its own coordinates, its floor centred on (0, 0).
- **Facing.** An angle in radians: 0 points +x, π/2 points +z, -π/2 points up the screen. Directions in moments are unit x/z vectors. Sides are north (-z), east (+x), south (+z), west (-x); angles in degrees on this page count from east toward south.
- **Clocks.** The *run clock* (`Game/Time`) advances every step of a run and stops on the title, in pause and on the results screens. The *gameplay clock* (`Game/PlayTime`) is the run clock minus hit-stop, minus skipped beats in slow motion, minus the special's freeze, minus transitions and a boss's name card. Movement, AI, cooldowns and projectiles use the gameplay clock; hit-stop, slow motion, the special's beats, transitions, the input buffer and the run timer use the run clock.
- **Randomness.** Everything the simulation draws comes from the run's `Random` resource, seeded at the run's start: the same seed makes the same dungeons, waves and drops. Cosmetic randomness in the host uses its own generator.

## Controls

| Action | Keys | Mouse |
|---|---|---|
| Move | WASD, arrows | |
| Aim | faces the move direction | points the player at the cursor (for 2 s after the mouse last moved or clicked) |
| Attack | J | left click |
| Dash | Space, Shift | |
| Parry | K | right click |
| KUZUSHI (special) | Q, L | |
| Interact | E | |
| Map | Tab (hold), M (toggle) | |
| Pause / resume | Esc, P | |
| Menus | W/S or arrows move, Enter (Space, J) chooses, Esc goes back | the pointer selects once it moves, a click chooses |

What Attack does depends on the weapon in hand (Weapons); in code the attack button is still the `slash` action. Interact takes the weapon on the altar the player stands by. A pressed action waits in a buffer for **0.2 s** (run clock) until the player can act on it, so presses during hit-stop or an attack's recovery still land. The lab's keys: Debug scenes.

## Screens

```
Loading ──▶ Title ──start (a zone)──▶ Playing ──pause──▶ Paused ──resume──▶ Playing
                                         │                 ├──restart──▶ Playing (a fresh run from the same zone)
                                         │                 └──quit─────▶ Title
                                         ├──last boss defeated──▶ RunClear ──retry──▶ Playing / ──title──▶ Title
                                         └──last diamond lost───▶ GameOver ──retry──▶ Playing / ──title──▶ Title
```

The title is a menu: **START** opens the run panel, **CONTROLS**, **SETTINGS** (screen shake 0 to 100%, impact flashes full, reduced or off, film grain, an FPS readout, fullscreen, music and sound effects 0 to 100%; kept in localStorage; what shake and flashes do: Look, Impact frames; the volumes: Audio) and **EXTRAS** (entries added with `registerExtra`: the debug scenes). The run panel holds one card per zone with its number, name and kanji, a strip of its palette, its four enemy icons, its hazard, its boss's name and kanji, and its best clear time on this device; zone 1's card also shows the best full run's time and rank. Zone 1 is always open. Zones 2 and 3 open once a run has reached them on this device; a locked card shows LOCKED and the zone's number only. Choosing a card plays the hero's dash at the lens, the panel slides out of its way at once, an ink cover closes, and the run starts 0.42 s later under it (Title scene). The title menu holds the keyboard, so only the run panel starts a run from the title.

Pause offers Resume, Restart, Map, Controls, Settings and Quit to title; Map opens the full map in a panel. The results card (RunClear or GameOver) offers Retry and Title; what it shows is The run's Results, laid out as in Look (UI, Results).

## Loading

From the first paint until the title's first frame has drawn, a loader covers the canvas (`index.html`, driven by `src/host/loading.ts`). It is HTML and CSS, so it shows before any script runs, and it moves only by transform and opacity, so it keeps moving while the page's script is busy. Sizes are px at 1680 × 800, scaled with the window's shorter side; the colours are The Courtyard's. Nothing sits behind its words.

- **The stroke.** A dry-brush stroke 36% of the window wide and 12 px high, centred at 52% of its height, in paper at 85%: a blunt pressed start, dry streaks, a tail split into bristles. An ink shutter over it slides right as loading goes, leaving a 1 px ground-dark (#35353a) rule where the stroke is still to come; each move lands as two held drawings over 120 ms.
- **The nib.** A red tick, 2 × 18 px leaning 20°, at the stroke's head, flickering on twos (1/12 s full, 1/12 s at 35%).
- **The label.** Under the stroke, LOADING at its left end and the percent at its right: Barlow Condensed 500, 12 px, tracked 0.32em, paper at 55%. It waits up to 1.5 s for its face rather than flash a fallback.
- **The outro**, 0.33 s, four drawings at 12 a second: a 2 px red slash across the whole screen, rising 12° to the right through the stroke's middle; the ink split along it, each half (with its piece of the stroke and label) thrown 7% of the window's height off the slash, the slash still showing between; the halves 32% off and turned 2° further; 54% off and turned 5°. Then the loader is gone. With reduced motion the nib holds still and the outro is a 0.2 s fade.
- **Failure.** The label reads FAILED TO LOAD with the error's first line under it, and the nib holds where the stroke stopped.

The bar's first half is the boot: the renderer, then each install, a step each. Its second half is the warm-up (`src/gpu/warmup.ts`): the enemies' paths are built first, then each install's warm steps and the handover draw, each step one share, the bar creeping within a step as its frames draw. A step hands its textures to the GPU first, at most 32 MiB a frame; then each of its poses draws real frames until one compiles nothing, or for 20 frames, after which loading moves on and reports the pose as unsettled. There is no minimum display time.

While loading, the title scene, the camera and the drifting air hold at t = 0, the game's keys are held and the loader takes the pointer. The handover first waits until the GPU has done everything loading sent it (on WebGPU a first visit's pipelines compile in the GPU process after loading asked for them, and would otherwise stall the title's first second); then it starts the title's loop at t = 0, the title's random draws from their seed, and the frame clock that steps the grain at 0, and lets the camera and the air move, as on a page with no loader, and draws the title's first frame under the loader; then loading ends: the outro starts, the title's menu plays its intro in view, and the debug API lands. A device or context change while loading draws everything again.

The title's first frame compiles under the loader. Every other program still compiles the first time play draws it, a hitch on that frame. `?compiles` warns of each compile after loading with its program's label, `?compiles=strict` makes each a console error so a step list fails on it, and `__game.compiles()` lists them.

What loading hands the GPU, so play doesn't upload it on first use:

- **The world.** The Courtyard's classic floor, the concrete grain, every actor's glyph (the player's dash drawings too), the small sprites and each zone's shots, the room kit (door icons, altar kanji and moves, seals, springs, drops, the gate's glare, dials, rifts), and all seven Courtyard room floors, drawn without waiting for idle time.
- **The effects.** Every texture vfx draws with: its kit, made once and shared with the title, and the weapons' kit.
- **The UI.** The results' seal in both forms in every zone's accent.
- **The title.** Its sun and clouds.
- **Per zone, as before.** The Spiral's and The Void's room floors are drawn when their zone starts; a room's meshes are built as the player enters it.

## The run

- **Order.** Zone 1 The Courtyard, zone 2 The Spiral, zone 3 The Void. Each zone is a dungeon of rooms ending at its boss; the boss's defeat opens the gate to the next zone. The third boss's defeat wins the run.
- **Start.** The zone's start room, 5 diamonds, FOCUS 0, the blade in hand. The run's first room (whichever zone the run starts in) holds three altars with the other three weapons.
- **Health.** **5 diamonds** for the whole run (`PLAYER.lives`). Every hit costs one: an enemy's attack or orb, a boss's attack, the beam, a pulsar's wave, a cutter's seam, a falling slab. After a hit: knocked back at 8 u/s, **1.2 s** invulnerable (the player blinks), 8 steps of hit-stop, an attack or parry cancelled. At 0 the player goes down: 1/4 speed for 1 s, and 1.2 s later, GameOver.
- **Healing.** A zone's spring room heals to full, once: stepping into the spring heals, and spends it only if it healed. A boss's defeat raises a spring where it fell: full heal. A room's clear may leave a diamond (Drops). These are the only heals.
- **Drops.** A room's clear leaves its rewards on the floor where its last enemy fell (or across the nearest spawn point when that isn't open floor), side by side 1.3 apart, for the hero to walk over (within 0.9): a **diamond** (one diamond back) from a combat room with a chance of **12% per missing diamond** (0 at full, 48% at one left), drawn at the clear, and always from an elite room; and from a **cache** (a combat room off the way from the start to the boss) always **FOCUS +40**. A diamond waits on the floor while no diamond is missing, FOCUS while FOCUS is full.
- **What carries.** Diamonds, FOCUS (it never decays), the weapon, kills, the run timer. Darts reload on entering a room; marks on the ground and orbs are gone after a transition.
- **The end.** GameOver when the last diamond goes; RunClear 3.0 s after the third boss's defeat. The run timer stops at either.
- **Results.** Time, kills, rooms cleared, the zone reached (number and name), diamonds left, the weapon in hand; for a full run (started in zone 1) its rank and New best or the best time; for a run started later, FROM ZONE 2 (or 3) instead of a rank. A full run's rank: its time plus **30 s per hit taken**, against S ≤ 14:00, A ≤ 19:00, B ≤ 26:00, else C.
- **Practice.** The run panel starts a run in any zone reached on this device; it plays from that zone to the end with a fresh start (5 diamonds, FOCUS 0, the blade, the three altars). Kept in localStorage: the zones reached, each zone's best clear time (from entering its start room to its boss's defeat, in any run), the best full run's time and rank.
- **Pacing.** About 30 to 60 s per combat room, 5 to 8 minutes per zone, 15 to 25 minutes per run.

Every run the run panel starts draws a fresh seed (unless the debug API's `setSeed` named one), and Restart and Retry begin a fresh run from the zone the run started in with a new seed. The lab and the debug API start any zone, in any room, with any seed and weapon (Debug hooks).

## Zones

| Zone | Name | Rooms | Enemies | Hazard | Boss |
|---|---|---|---|---|---|
| 1 | The Courtyard 中庭 | 8 | chaser, shooter, bruiser, trickster | none | Gatekeeper 門番 |
| 2 | The Spiral 螺旋 | 10 | orbiter, warden, sweeper, pulsar | the spire's sweeping beam, in well and dial rooms | Orrery 渾天儀 |
| 3 | The Void 虚空 | 12 | lancer, splitter (and its splitlings), leaper, cutter | edges (ring-outs) and collapsing slabs | Sunder 断 |

Each zone sends only its own four kinds. Shape language: the Courtyard's are the board's solids (circle, triangle, square, diamond); the Spiral's turn and circle (ring, eye, clock hand, cog); the Void's are thin and sharp (needle, hexagon, cross, slanted bar).

### Palettes

Each zone's palette is limited: ink, three ground values, a light, the hero's paper white, and **one danger accent**, which in play takes every place the Courtyard's red takes there: enemies, telegraphs, orbs, the edges of the hero's effects, impact frames' tint, the HUD's accent. A frame of play holds only its zone's colours. The title and its menus keep the Courtyard's. Tokens: `ZONE_PALETTES` and `paletteOf(zone)` in `src/art/palette.ts`.

| Zone | Ink | Ground dark | Ground | Ground light | Light | Danger | Danger deep | Mood |
|---|---|---|---|---|---|---|---|---|
| Courtyard | #0d0d0f | #35353a | #505056 | #76767c | #f2efe8 | #ff2e3f | #b3121f | grey concrete at a low warm sun, long hard shadows |
| Spiral | #091017 | #182630 | #2a404b | #46626c | #b8cfe0 | #ffad1f | #a65f00 | a teal-slate dial at dusk under a cold steel light; amber is the only warm colour |
| Void | #08070c | #44465a | #686b84 | #8487a0 | #d9d2ff | #a646ff | #5a17b8 | blue-grey slabs in black space under a high lavender light; violet glows against the dark |

The hero is paper white #f2efe8 in every zone. Contrast against the three ground values (dark, ground, light): WCAG luminance ratio and CIELAB ΔE.

| Zone | Hero ratio | Hero ΔE | Danger ratio | Danger ΔE | Danger against ink |
|---|---|---|---|---|---|
| Courtyard | 10.6, 7.0, 3.9 | 73, 61, 45 | 3.3, 2.2, 1.2 | 94, 90, 88 | 5.3 |
| Spiral | 13.5, 9.5, 5.7 | 81, 70, 57 | 8.3, 5.8, 3.5 | 107, 102, 96 | 10.4 |
| Void | 8.1, 4.5, 3.1 | 66, 52, 42 | 2.2, 1.2, 1.2 | 94, 90, 91 | 4.7 |

Danger separates from every floor by hue (ΔE 88 and up) even where its luminance is close; the Courtyard's red on its light concrete is today's pair. The hero's weakest pair, the Void's lit slab tops, is 3:1, with the ink rim, contact shadow and glow on top. The three accents are far apart in hue (red, amber, violet), so the zones read apart from a thumbnail.

**How the palette reaches the screen** (`src/look/grade.ts`, `src/look/tones.ts`). The world is modelled in the Courtyard's greys in every zone, and the finishing grade maps each grey to the zone's tone at the same place on the scale: the frame's lightness (after the stark curve) picks a colour on a ramp of six stops, ink at 0, ground dark at 0.178, ground at 0.298, ground light at 0.467, the light at 0.8 and paper at 1, which are the Courtyard's own ground values' places on its ink-to-paper ramp. So a surface lit as the Courtyard's floor reads as the zone's floor; sampled in play, the Void's lit slab tops read #86869f and #737790, the Spiral's dial #1c323f to #2a404b. The Courtyard's ramp is the plain ink-to-paper one, so it and the title look as they always have. Every colour but the zone's accent is locked to the ramp; outside the Courtyard the Courtyard's red, wherever an effect or material still uses it (the spire's slit, the Void's column, impact frames, halos, sparks, the blade's rims), is first turned to the zone's accent in the plane of colour round the grey axis, so a pixel some parts red becomes as many parts accent with its white kept. Impact frames, flashes and the vignette use the zone's ink, paper and accent. Effects drawn flat over the frame after the grade (strobes, vignette pulses, focus lines, cinema bars) take the zone's accent and ink directly. Through a boss room's open gate the grade also keeps the next zone's accent, for the glare.

## The dungeon

Each zone's dungeon is made when the zone starts, from the run's `Random`, by a generator modelled on The Binding of Isaac's:

1. A grid of **9 columns × 9 rows**; the start room takes the middle cell (4, 4).
2. Breadth first: take the next cell from the queue and try its neighbours north, east, south, west. A neighbour becomes a room unless it is off the grid, already a room, has more than one room next to it, the zone already has its count, or a 50% coin says no. Each new room joins the queue.
3. When the queue empties short of the count (8, 10 or 12), start again with fresh draws.
4. *Depth* is a room's distance in doors from the start; a *dead end* is a room other than the start with one neighbour. Start again unless there are at least 3 dead ends (zone 1) or 4 (zones 2, 3) and the deepest dead end's depth is at least 3 (zone 1) or 4 (zones 2, 3).
5. Kinds, by dead ends from deepest (ties to the earlier room): boss, weapon, spring, then (zones 2 and 3) elite. With no dead end left for the elite, it takes the deepest combat room that isn't next to the boss. Every other room is combat.
6. *Caches*: every combat room off the way from the start to the boss (found by stepping back from the boss through a room one door nearer each time) is a cache. Its clear always leaves FOCUS (The run, Drops), so a side room is a real choice: about half of a zone's combat rooms (zone 1 has 0 to 2, zone 3 up to 4).

Rooms per zone: zone 1: start, weapon, spring, boss and 4 combat; zone 2: start, weapon, spring, elite, boss and 5 combat; zone 3: start, weapon, spring, elite, boss and 6 combat. A test generates seeds 1 to 1000 for every zone and finds a valid dungeon each time, within 500 tries.

| Kind | What it is |
|---|---|
| start | Where the zone begins. No fight. In the run's first room, three altars hold the three weapons not in hand |
| combat | 1 to 3 waves of the zone's enemies; the doors lock until the last falls |
| elite | A combat room whose last wave is an elite with two escorts; always leaves a diamond when cleared |
| weapon | Two altars, each holding a weapon not in hand when the player first enters. No fight |
| spring | The spring: full heal, once. No fight |
| boss | The zone's boss, alone. After its defeat, a spring and the gate to the next zone |

Doors join every pair of neighbouring rooms. A room is addressed by its index in the zone's rooms (generation order); the start is 0.

### The map

The minimap sits top right in a framed window (`src/ui/minimap.ts`): 5 × 4 cells centred on the current room, cells 22 × 14 px with 4 px gaps, fading out at the window's edges. A door is a 1 px line across the gap between two rooms, drawn once the hero has entered either; while the room is locked its doors turn to the accent with a short seal across each, and the frame takes the accent; the boss room's open gate is an accent line with an arrowhead pointing out of the map. Moving to another room slides the map under the window and inks the new cell in; rooms coming into view draw in. Holding Tab (or M to toggle) shows the full map over play, the game running on (`src/ui/map-overlay.ts`): a panel of translucent ink (70%) docked on the half of the screen away from the hero (left and centred when the hero is right of centre, else bottom right), with the altar's prompt hidden while it is up; Pause's Map shows it in a panel beside pause (`src/ui/full-map.ts`, "Sandbox: no rooms to map" on a classic arena). The full map draws the whole zone with cells 44 × 28 px, the zone's number, name and kanji above it, and a legend of the icons with their names: You, Cleared, Seen, Start, Altar, Spring, Cache, Elite (zones 2 and 3), the zone's boss by name, and Gate (zones 1 and 2).

| Room state | Drawn |
|---|---|
| hidden | not at all |
| seen (next door to a visited room) | a 1 px outline; a marked kind (start, elite, weapon, spring, boss) or a cache not yet cleared shows its icon |
| visited (entered, its fight not yet won: only the current room) | filled ink, the icon if any |
| cleared | filled ink with a paper outline, the icon if any |
| current | filled paper, with the hero's arrowhead |

Icons, in the UI's 1px line style (`src/ui/room-icons.ts`): start, a ring round a doorway's arch (the hero's arrowhead marks only where the hero is); elite, three small triangles in a crown; weapon, the altar (a square plinth with a diamond above); spring, a ring with a dot; cache, FOCUS's four-point spark round a small solid diamond (until its room is cleared); boss, the zone's boss's icon (the Gatekeeper's crest, the Orrery's orbit, Sunder's seam). The seal on a door, and an open door's marker, show the icon of the marked room or cache behind it once that room is seen.

## Rooms

Every room is one floor with a door at the centre of each edge of its bounding box, so any template fits any cell. A side without a neighbour is plain wall: the wall, kerb or ring wall runs straight through, with no posts (in the Void, no landing), so only real doors break the wall. The room is built when the player enters it; only the current room exists.

**Size by depth.** Depth 1: small; depth 2 and 3: medium; depth 4 and more: large. Start, weapon and spring rooms use their zone's start and shrine templates; elite rooms are medium or large by depth; the boss room has its own. A template is drawn at random within its size, different from every neighbour's when the size has two or more. Each room is mirrored left to right with 50%, and top to bottom with 50% (props, spawn points and altars; doors stay centred).

**Door lanes.** Each door's lane (3 wide, straight into the room) is clear of props for 4 units from its mouth, so the player arrives in the open; every altar and spring stands at least 4 units from where the hero arrives through any side, either way mirrored, so the hero arrives clear of every altar's prompt (a test checks every template). **Spawn points** are found from the template (`SPAWNS` in `src/sim/dungeon/rules.ts`): points on a 1-unit lattice at least 4 units from every door's mouth, clear of every prop and wall for the largest wave enemy (radius 1.0) and 0.6 in from any open edge, thinned to the 16 that spread widest; every combat template has at least 8. On a slab floor, points on fallen slabs are skipped. Enemies appear at spawn points at least 7 units from the player (the farthest free one when none is).

### Courtyard rooms

Rectangular stone floors, 2-unit tiles, inside a wall 2 thick and 1.1 high; doors are 3-wide gaps through it, each with a recess 2 deep. Cover is blocks (full cover: they stop bodies and orbs) and round pillars.

| Template | Size | Floor | Props |
|---|---|---|---|
| `courtyard.forecourt` (start) | — | 24 × 16 | two low blocks 2 × 1.4, 1.2 high, at (±7, −5.5); altars at (−5, 1), (0, −1.5), (5, 1) |
| `courtyard.shrine` (weapon, spring) | — | 20 × 14 | four pillars r 0.7, 3.5 high, at (±6, ±3.5); altars at (±3, 0), or the spring at (0, 0) |
| `courtyard.yard` | small | 24 × 16 | a block 3.2 × 3.2, 3 high, at (−6, −3); a block 4 × 2.4, 2.2 high, at (6.5, 3); a pillar r 0.8, 4.5 high, at (4, −3.5) |
| `courtyard.cloister` | medium | 30 × 20 | four pillars r 0.8, 5 high, at (±6, ±4.5); blocks 2.8 × 2.8, 2.5 high, at (−11, −6) and (11, 6) |
| `courtyard.gate` | medium | 28 × 20 | a broken wall across the middle: blocks 6 × 1.4, 1.4 high, at (±5.5, 0); pillars r 0.9, 5 high, at (0, ±5) |
| `courtyard.court` | large | 36 × 24 | the classic Courtyard arena, its props out of the door lanes: the north low wall at (−6, −9.5), the south one at (6, 9.5), the east pillar at (16, −5), the west at (−16, 4.5) |
| `courtyard.great` (boss) | — | 36 × 26 | four pillars r 1.1, 6 high, at (±10, ±6.5); nothing else |

### Spiral rooms

Round stone dials inside a ring wall 1.2 thick and 0.9 high; doors are 3-wide cuts through the ring at the four compass points, each with a recess 2 deep. The spire and its beam stand only in well and dial rooms (medium and large, so from depth 2).

| Template | Size | Floor | Props and hazard |
|---|---|---|---|
| `spiral.gnomon` (start) | — | radius 9 | a stump r 1.2, 1.6 high, at the centre; altars at radius 4.5 at 210° and 330°, and 3.3 at 270° |
| `spiral.shrine` (weapon, spring) | — | radius 8 | four pillars r 0.7, 3 high, at radius 5.5 on the diagonals; altars at (±2.2, 0), or the spring at (0, 0) |
| `spiral.ring` | small | radius 10 | four pillars r 0.8, 3.5 high, at radius 5.5 on the diagonals |
| `spiral.colonnade` | medium | radius 12 | seven pillars on a spiral from radius 9.5 at 22.5° in to radius 4 at 292.5°, 45° apart, r 0.9 down to 0.7, 2.4 up to 6 high |
| `spiral.well` | medium | radius 12 | a spire r 1.4, 9 high, at the centre; four pillars r 0.85, 4 high, at radius 7.5 on the diagonals; the beam at **30°/s** |
| `spiral.dial` | large | radius 15 | the classic Spiral arena: the spire r 2, 16 high, the seven pillars below; the beam at **40°/s** |
| `spiral.orrery` (boss) | — | radius 15 | six pillars r 1.0, 4.5 high, at radius 9.5 at 30°, 90°, 150°, 210°, 270°, 330°; the Orrery at the centre |

The classic Spiral arena's pillars (the dial's), outermost first:

| Pillar | Centre (x, z) | Angle, distance | Radius | Height |
|---|---|---|---|---|
| 1 | (-10.7, 6.2) | 150°, 12.4 | 0.95 | 2.2 |
| 2 | (-10.3, -4.2) | 202°, 11.1 | 0.92 | 3.0 |
| 3 | (-2.7, -9.5) | 254°, 9.9 | 0.88 | 3.8 |
| 4 | (5.1, -7.0) | 306°, 8.7 | 0.85 | 4.6 |
| 5 | (7.3, -0.3) | 358°, 7.3 | 0.82 | 5.4 |
| 6 | (3.9, 4.6) | 50°, 6.0 | 0.78 | 6.2 |
| 7 | (-1.0, 4.7) | 102°, 4.8 | 0.75 | 7.0 |

### Void rooms

Slabs over nothing, no walls. Each door is a gate at the end of a **landing**, a 3 × 2 slab reaching out from the centre of an edge of the room's bounding box (only where a door is). Landings, and a path of slabs joining every edge's centre to the core, never fall; other slabs may (Hazards). Slabs sit on the half-unit grid. Gaps between slabs stop the player and walking enemies like any edge; lunges, leaps and hard knocks cross them or fall in.

| Template | Size | Floor | Falls |
|---|---|---|---|
| `void.threshold` (start) | — | a 14 × 12 core | none; altars at (±4.2, −3.9) and (0, −0.2) |
| `void.shrine` (weapon, spring) | — | a 14 × 12 core | none; altars at (±4.2, −3.9), or the spring at (0, 0) |
| `void.islet` | small | a 14 × 10 core, side slabs 4 × 6 from x ±7 to ±11 | none |
| `void.causeway` | medium | three 7 × 7 slabs in a row 2 apart (x −12.5 to 12.5), joined by 3-wide bridges; 3-wide paths north and south from the middle one to z ±6.5; four 3 × 3 corner slabs against the end slabs' outer corners | the corner slabs after wave 1 |
| `void.shards` | medium | six 6 × 5 slabs with 1-unit gaps (x −10 to 10, z −5.5 to 5.5), joined by 2-wide bridges so every slab is reached; 2 × 3 paths to the east and west doors | none (the gaps are the hazard) |
| `void.collapse` | large | the classic Void arena's slabs A to I below, and paths that never fall: x −1.5 to 1.5 from z 4 to 9 (south), x 11 to 12 and −12 to −11 at z ±1.5 (east, west); H reaches the north edge | F and G after wave 1, C and I after wave 2; A, B, D, E and H carry doors or the core and never fall |
| `void.abyss` (boss) | — | a 12 × 8 core in an 18 × 14 rim of eight strips, 3-wide paths through the rim to the north and south edges and out to x ±14 east and west, four 4 × 5 outer slabs beside the east and west paths | the outer slabs as Sunder's shift into phase 2 begins; the rim as its shift into phase 3 begins |

The classic Void arena's slabs (the collapse room's), on the 1-unit grid:

| Slab | x | z |
|---|---|---|
| A (core) | -6 to 6 | -4 to 4 |
| B | -6 to 0 | 4 to 7 |
| C | 2 to 8 | -7 to -4 |
| D | -11 to -6 | -3 to 3 |
| E | 6 to 11 | -4 to 2 |
| F | -9 to -6 | -8 to -3 |
| G | 8 to 12 | 2 to 6 |
| H | -2 to 2 | -9 to -4 |
| I | 0 to 5 | 4 to 6 |

A column of light stands beyond the north edge of every Void room, 8 units past the floor: a landmark, not floor.

## Doors

- **Open:** the doorway is clear. Walking 0.6 units past the floor's edge into the recess (or onto the end of the gate's landing) starts the transition.
- **Locked:** a seal fills the doorway: a wall to bodies and orbs.
- A combat, elite or boss room that isn't cleared **locks** once the player's whole body is inside the floor's edge (at least its radius plus 0.6 in from the door line; an arrival already is): 0.4 s after control returns the seals draw shut (`doorsLocked`).
- It **unlocks** when the room's last wave clears: the seals break as the clear's slow motion ends (`doorsOpened`).
- **Cleared rooms stay cleared**: walking back into one leaves its doors open, as rooms without a fight always are.
- **The boss door** (both sides of the door into the boss room) has taller posts and the boss's icon on its lintel once seen.
- **The zone gate** opens in the boss room's wall opposite its door after the boss's defeat (zones 1 and 2); it leads to the next zone.
- A side without a neighbour is plain wall (Rooms).
- Doors are the player's alone; enemies stay in their room.

*Reads:* Courtyard: a 3-wide gap in the wall framed by two square posts with caps and a plain lintel (the south door's low, no lintel) over a worn threshold; the seal is an ink plug filling the gap under a thick dry-brush stroke, which drops in on twos and lands with a squash, and breaks by splitting into halves that fly apart. Spiral: a cut in the ring between two stele with lit slits; the seal is an iris of four stone plates that slides shut from the stele round an amber seam, sliding back into them to open. Void: two needle posts with paper lamps at the landing's end; the seal is a membrane of hatched accent lines drawn across between them, row by row, that snap and fall away. A locked door hangs a seal emblem in the accent in its doorway above the seal (the south door's, and its open marker, on its right post, 2.5 across and 1.75 up, off the lane the hero arrives by, so both stay clear of the hero), a ring of ticks round the icon of the marked room behind it, facing the camera so it reads from any side mid-fight; open, a marked door carries that icon in paper above its posts. The boss door's posts are taller and its emblem pulses slowly.

**An open door is lit**, so the way on reads at a glance as in Cult of the Lamb: a soft fan of the zone's light spills from it across the floor (24% at its foot, fading out at its sides and far end), a dim blade of light stands in the doorway flickering on twos, and two paper chevrons with an ink rim on its threshold point out; as the seals break they pop in on twos after the flash. **Off the frame**: a beat (0.7 s) after a room's seals break, or at once in a room entered cleared, each open door and open gate the frame doesn't show, or that stands under a corner of the HUD, gets two small chevrons in the zone's accent with an ink rim on the frame's edge, 34 px in, pointing at it from the middle of the frame and bobbing toward it on twos, clear of the HUD's corners; each goes as its door comes into the frame. As a room locks every seal slams shut with an ink starburst held two drawings, an accent shock on the floor, dust, stones and ink thrown into the room, speed lines driving down and a kick of the camera and lens; as it clears every seal breaks with a white light out of its doorway, ink and paper flecks thrown into the room, and the doorway glows paper for half a second. The zone gate's two leaves stand shut in the boss room's far wall (its icon above them); on the boss's defeat they topple outward and sink on twos onto the next zone's light: a blade of it in the doorway, a haze over it, and a fan of it spilling across the floor (at most 35%, fading out at its sides and far end), with thin streaks of the next zone's accent running through the fan, flickering on twos.

## Waves in rooms

**How many.** Depth 1: 1 wave; depth 2 and 3: 2 waves; depth 4 and more: 3 waves. An elite room adds its elite wave after those.

**Which.** Each zone has a pool of wave entries in three tiers. A depth-1 room draws [light]; depth 2 draws [light, medium]; depth 3 [medium, medium]; depth 4 [medium, medium, heavy]; depth 5 and more [medium, heavy, heavy]. The draws are made when the zone is generated, each entry at most once in a room.

Courtyard (chaser C, shooter S, bruiser B, trickster T):

| Tier | Entries |
|---|---|
| light | C3 · C2 S1 · C2 T1 · S2 C1 |
| medium | C3 S2 · C2 S1 B1 · C2 T2 · S2 B1 C1 · C3 T1 S1 |
| heavy | C3 S2 B1 · C2 S2 T2 · C3 B1 T2 · S3 B1 T1 · C4 S2 B1 |

Spiral (orbiter O, warden W, sweeper Sw, pulsar P):

| Tier | Entries |
|---|---|
| light | O2 Sw1 · O3 · Sw2 P1 · O2 P1 |
| medium | O3 Sw1 · O2 W1 · Sw2 P1 O1 · O2 P2 · W1 Sw2 |
| heavy | O3 W1 Sw1 · O2 P2 Sw1 · W2 O2 · O3 Sw2 P1 · W1 P2 O2 |

Void (lancer La, splitter Sp, leaper Le, cutter Cu):

| Tier | Entries |
|---|---|
| light | La2 Sp1 · Sp2 Le1 · La1 Cu1 Sp1 · Le2 La1 |
| medium | La2 Sp2 · Le2 Cu1 La1 · Sp2 Cu1 Le1 · La3 Le1 · Cu2 Sp2 |
| heavy | La3 Sp2 Le1 · Le2 Cu2 Sp1 · La2 Sp3 Cu1 · La3 Le2 Cu1 · Sp3 Le2 La1 |

**The elite wave**: one elite of a kind drawn from the zone's four, with two of the zone's first kind (chasers, orbiters or lancers). What makes an elite: Enemies, Elites.

**Timing.** Once the doors lock (Doors), the first wave's banner shows for **1.0 s** (WAVE 1/N and the enemy mix, so the room's wave count shows before the first spawn, as Cult of the Lamb's beacons do); then its enemies appear one every **0.25 s**, kinds in turn (the order of `enemyKinds`). When a wave's last enemy falls and waves remain: that kill's hit-stop, a **1.0 s** breath, the next banner (1.0 s), its spawns. When the room's last enemy falls: **1/4 speed for 1 s** and an impact frame; the heal roll; `roomCleared` with the drops it leaves (the diamond, a cache's FOCUS); the seals break as the slow motion ends.

## Transitions

### Through a door

Walking into an open door. The gameplay clock holds throughout (cooldowns, invulnerability and marks wait); the run clock runs. Leave through a side, arrive through the opposite side of the next room still moving the same way.

| Beat | Steps | Ends at | Simulation | Drawn |
|---|---|---|---|---|
| exit | 8 | 0.13 s | control off; the hero carried along the travel direction at 18 u/s into the doorway | the hero's dash smear (the dart drawing) through the doorway, speed lines along the travel |
| cover | 18 | 0.43 s | at its end, the swap: `roomSwapped`; the next room replaces the old; the hero stands 1.6 units inside its opposite door, facing the travel direction, moving at run speed | an ink brush wipe sweeps across the screen in the travel direction, a dry-brush leading edge, speed lines; the hero held as a white drawing on top, its body hidden from here until the reveal uncovers it, so only one hero shows; under full cover look rebuilds the world and the camera cuts to the new room |
| hold | 36 | 1.03 s | the room's fight loads: the path meshes its enemies will walk, one a step (`PreparePaths`) | full ink; the hero's held drawing bursts on along the travel (square to the frame, not the wipe's slant), off the far edge and in from the near one on the same line, and settles where the hero now stands under the cut camera, its afterimages closing on it, radial focus lines closing on it only once it lands; the minimap's new cell inks in |
| reveal | 18 | 1.33 s | at its end control returns (`transitionEnded`) | the wipe runs off the far side the same way; the new room inks in behind it, outlines for two drawings, then fills; the held drawing stays over the hero until the ink's tail uncovers it, so the hero stays on screen throughout; the hero comes in with afterimages |

*Reads:* drawn flat over the frame, every band in the zone's own ink. The exit punches the lens and the hero smears into the doorway with afterimages and speed lines. The band sweeps slanted a little, accelerating and stepping 20 drawings a second, its front a dry-brush edge whose bristles run with the stroke, drops and spray thrown ahead of it, boiling between three drawings on twos; dry-brush grain streams along the ink and speed lines (paper on the ink, ink on the picture) are redrawn on twos. The held hero is a white dart drawing with a heavy ink rim, jittering on twos, growing as the ink closes and held larger through the hold, radial focus lines round it while it is still. In the reveal the new room shows as paper outlines on ink for two drawings, half filled for one, then whole.

### Into the next zone

Walking into the zone gate after a boss.

| Beat | Steps | Ends at | Simulation | Drawn |
|---|---|---|---|---|
| exit | 10 | 0.17 s | the hero carried into the gate at 18 u/s | the dash smear into the gate's glare as the frame washes 55% toward paper; the hero's drawing, ink rim and afterimages held over the wash, focus lines closing on it |
| cover | 30 | 0.67 s | at its end, the swap: the next zone's dungeon is made (`zoneStarted`, `roomSwapped`); the hero stands 1.6 units inside its start room's south door, facing north | the wipe rises up the screen in the old zone's ink: a dry-brush edge with ink drops flung ahead and a thin stroke of the old accent riding ahead of it |
| card | 120 | 2.67 s | — | the zone card on the new zone's ink: ZONE and its number, the name brush-lettered, the kanji large; its accent bar draws in the new danger colour; ink and paper change to the new palette under it |
| reveal | 36 | 3.27 s | at its end control returns | the wipe rises off the top, revealing the start room |

The ink sheet of cover, card and reveal and the card on it are the UI's (`src/ui/zone-card.ts`), drawn over the canvas and scrubbed by the transition's `overall`, so they hold and step with the game; the exit beat's smear and glare are vfx's. Through the exit the hero's dart drawing with its ink rim is held over the wash where the hero is, three afterimages trailing back along the travel and focus lines closing on it from halfway (paper, then ink), until the ink sheet passes over it; the new start room inks in under the sheet as it lifts off, outlines first. The card: the kanji huge right of centre in paper with a glow of the new accent, over a soft pool of the new ground's dark value; left of centre ZONE and its number in the new accent, the name in heavy italic caps, a brush bar in the new accent drawn on, and the zone's room count and its boss's name and kanji, in paper at about 68%. The HUD steps back from the cover until the reveal. A run's first zone shows its card as a banner over play instead (the title's dash into play is its transition): its kanji, name and room count, as its start room opens.

## Player

Body radius **0.42**. Runs at **7.5 u/s**, reaching full speed in about 0.1 s (accel 70 u/s², decel 90 u/s²). Walls, blocks, pillars and locked doors stop it and it slides along them; enemies never block it.

```
Free ──attack──▶ Attack (the weapon's move) ──next press after its cancel point──▶ Attack (next move)
 │                 ├──breaker's second press──▶ Slam (hop, then slam) ──ends──▶ Free
 │                 └──darts: a dart ends with attack still held──▶ Charge ──release when full──▶ Attack (pierce)
 │  ──dash────▶ Dash   ──ends──▶ Free
 │  ──parry───▶ Parry  ──ends or parries──▶ Free
 │  ──special (FOCUS full)──▶ Special ──finisher ends──▶ Free
 └  ──last diamond lost──▶ Down ──1.2 s──▶ GameOver
Attack, Charge and Parry can be cancelled into Dash at any time, Slam only in its windup. Attack, Slam, Charge, Dash and
Parry can go into Special. A hit cancels an attack, a charge or a parry. Taking another weapon ends the attack in hand.
```

### Dash

**24 u/s for 0.15 s** (3.6 units) along the stick, or the facing with no stick. Invulnerable for the dash and 3 steps after; passes through enemies; walls still stop it. Cooldown **0.35 s** from the dash's end. Cancels an attack or a parry. Reloads darts.

A hit that lands while dashing is a **near miss**: no damage, +10 FOCUS, once per dash.

### Parry

Window **0.18 s** at the start of a **0.4 s** stance; cooldown 0.5 s from the press. Inside the window:

- a melee attack (lunge, dash, slam, contact, a sweeper's arm, a leaper's landing, a boss's melee) does nothing and **staggers the attacker for 1.4 s** (a boss gains +25 balance instead);
- an orb is **reflected**: it becomes the player's, flies 1.6× faster toward the nearest enemy (homing at 6 rad/s), and deals 2 damage.

A successful parry gives +15 FOCUS, 6 steps of hit-stop, ends the stance at once and refunds the cooldown. Outside the window the player is open. Ring waves, seams and the beam pass through a parry; dash through them.

### KUZUSHI (special)

Usable when FOCUS is full (100), outside transitions. The world freezes (the gameplay clock holds) and the camera cuts in low beside the player. After a **0.5 s** freeze, **6 beats 5 steps apart** strike every enemy within **9 units** of where the special began: beats 1 to 5 deal 1, the final beat deals 3. A 0.35 s release follows, then the game runs at **1/3 speed for 0.7 s**. The player is invulnerable throughout and for the slow motion after. FOCUS empties when it starts. Against a broken boss every beat deals double.

### FOCUS

0 to 100, starting at 0 each run, never decaying, carried across rooms and zones. +8 per kill, +15 per parry, +10 per near miss, +6 per reflected-orb hit, and per weapon hit: blade 5, cleave 5, slam 8, dart 3, pierce 6 (+5 for a perfect release), sigil 4, seal 6.

## Weapons

A weapon is drawn only through its attack: its moves, timing, hit shapes, animation and effects. Dash, parry and KUZUSHI are the same with every weapon. Aim: the cursor while the mouse aims, else the facing. A move hits each enemy at most once. Moving is slowed while attacking by the weapon's move factor. Frame data in steps (60 a second).

| Weapon | Kanji | Style | Plays |
|---|---|---|---|
| Blade | 刃 | melee | close, fast, all round; the spin clears a crowd |
| Breaker | 砕 | heavy | slow and committed; hops onto its mark, staggers armour, throws enemies off the Void |
| Darts | 矢 | ranged | keeps distance, reloads by dashing, strongest point blank and when charged |
| Sigil | 印 | magic | places delayed blasts and moves away while they land; leads moving targets |

### Blade 刃

The slash combo. The arc is centred on the aim at the press, and the active frames lunge forward. Move factor 0.3.

| Move | Windup | Active | Recover | Next from | Range | Arc | Damage | Lunge | Knockback | Hit-stop | Sweep |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cut | 3 | 5 | 12 | active end + 2 | 2.3 | 150° | 1 | 9 u/s | 5 | 3 | right to left |
| crosscut | 3 | 5 | 12 | active end + 2 | 2.4 | 160° | 1 | 9 u/s | 5 | 3 | left to right |
| spin | 5 | 8 | 18 | — | 2.8 | 360° | 2 | 4 u/s | 9 | 5 | all round |

After a move ends, the next press within **0.3 s** continues the chain; later it starts again at the cut. Hits stagger light enemies for 0.2 s; the bruiser and the warden are armoured (only the spin staggers them). Balance on a boss: cut and crosscut 2, spin 6.

*Reads:* crescent arcs, white-hot across most of their width with the zone's accent on the outer rim, inner edge and dry-brush tail, drawn about 1.65× the range; the two cuts are turned and flattened opposite ways so they cross; the spin a full ring with speed lines.

### Breaker 砕

Two moves. Move factor 0.15. Chain grace 0.35 s.

| Move | Windup | Active | Recover | Next from | Hit shape | Damage | Knockback | Hit-stop | Balance |
|---|---|---|---|---|---|---|---|---|---|
| cleave | 9 | 6 | 16 | active end + 4 | arc 3.0, 200°, right to left, lunging 6 u/s | 2 | 9 | 5 | 6 |
| slam | 18 | 4 | 24 | — | circle r 2.2 round the hero where it lands | 4 | 12, out from the centre | 8 | 14 |

The slam's **mark** is placed at the windup's start, 2.6 units along the aim (the cursor's spot when the mouse aims, clamped 1.5 to 3.5 from the hero, then stepped back toward the hero a quarter unit at a time until the hero could stand there: clear of walls and on standing floor): a white ring r 2.2 (`marked`, delay 18 steps). Through the windup the hero hops onto the mark (walls stop the hop; the hero stays hittable), then slams round itself (`burst`). The slam staggers armoured enemies for 0.6 s: the bruiser, and the warden through its shell. In the Void its knockback (×1.8 there) throws enemies off edges. A dash cancels the slam only in its windup.

*Reads:* the cleave a fat crescent in a heavier dry brush, smeared over two drawings; the slam's mark a thin white ring with four ticks; the hop an arc on twos, its top held two drawings; the landing an ink starburst cracking out across the floor, a shock ring in the accent with a white core, stone chips and dust, radial speed lines and a lens punch.

### Darts 矢

Pressing attack fires one dart at once; holding it on charges a pierce, fired on release. Clip of **6**.

| Move | Windup | Speed | Reach | Radius | Damage | Knockback | Hit-stop | Ammo | Balance |
|---|---|---|---|---|---|---|---|---|---|
| dart | 2 | 26 u/s | 14 | 0.18 | 1, or 2 within 3 units of the hero | 3 | 2 | 1 | 1 |
| pierce | charge 27, then release | 36 u/s | 18 | 0.24 | 3 through every enemy on its line; +1 when perfect | 7 | 4 | 2 | 6 |

- At most one dart every **9 steps**: a dart's move is 2 windup, 1 active (it leaves), 6 recover, and the next press may follow at its end. Each leaves from the hero's tip, 0.5 units ahead, along the aim at that step. An empty clip fires nothing; the press waits in the buffer.
- The pierce leaves on the release's step; the hero then recovers for 13 steps (1 + 12).
- Reload: after 30 steps (0.5 s) without firing, one dart every 18 steps (0.3 s); a charge isn't firing, so darts load through it. A dash reloads the whole clip at its start (`reloaded`, `dash: true`). Entering a room reloads it.
- Charging needs 2 loaded and starts 9 steps after the press while the button stays held; it is full 27 steps later (`charged`). Releasing within the 9 steps after it is full is **perfect**: +1 damage, +5 FOCUS, a ring flash on the tip. Letting go before it is full fires nothing more.
- Move factor 0.7 while firing, 0.4 while charging.
- Walls stop darts; they fly over the Void's gaps. A warden's shell clanks them, a pierce too. A pierce cuts every enemy orb it crosses; a dart passes them by.

*Reads:* a muzzle star at the tip, a white needle with a dotted trail; while charging, a thin white aim line grows from the tip with chevrons and the hero's back notch folds toward the dart pose; the pierce a long white streak with speed lines, its line held for two drawings; ammo as pips in the HUD.

### Sigil 印

Each press casts a sigil at the aim as its windup ends: the cursor's spot when the mouse aims (clamped 2 to 9 units from the hero, pushed clear of props), else 5 units along the facing. It bursts after its delay. Every third cast within **1.0 s** of the one before is a **seal**. At most 3 marks wait at once; a fourth cast waits in the buffer for one to land.

| Move | Windup | Delay | Hit shape | Damage | Knockback | Hit-stop | Balance |
|---|---|---|---|---|---|---|---|
| sigil | 6 | 25 (0.42 s) | circle r 1.6 at the mark | 2 | 6, outward | 3 | 4 |
| seal | 9 | 30 (0.5 s) | circle r 2.4 at the mark; staggers armour 0.6 s | 3 | 9, outward | 5 | 10 |

- A cast takes 14 steps to the next (the sigil 6 + 1 + 7, the seal 9 + 1 + 4). Move factor 0.5 through the windup; after it the hero moves freely while the mark waits.
- A reflected orb crossing a waiting mark bursts it at once, +1 damage.
- A warden's shell turns a burst aside (`clank`); only the slam and the special land through it.

*Reads:* the hero's tip flicks and holds; a white ring inks round the mark stroke by stroke through the delay, a seal glyph drawn at its centre; the burst an ink starburst, a white ring rimmed in the accent, splatter, and an ink stamp left on the floor that fades; the seal larger, stamping 印.

### Getting weapons

Every run starts with the blade. The run's first room holds three altars with the other three weapons; each zone's weapon room holds two altars with two of the three weapons not in hand when the player first enters it. Standing within **1.4 units** of an altar's centre shows its prompt, a framed card pinned over the altar (`src/ui/altar.ts`; it waits while a banner plays, so it stays clear of the run's first zone banner): E TAKE and the weapon's style, its kanji and name, its line under it, and IN HAND with the weapon that goes onto the altar; Interact swaps: the altar's weapon goes into the hand and the one in hand onto the altar (`weaponTaken`), so a choice can be undone in that room. Swapping ends an attack in progress; marks on the ground still land; darts start full.

*Reads:* an altar is a low square plinth; above it the weapon's kanji floats in paper white inside a thin ring, and the weapon's first move is ink-drawn on the plinth's face (a crescent, a ring with ticks, a needle, a seal); taken, the ring empties and the drawing fades.

## Enemies

Flat shapes in their zone's danger colour (outlines, glow and health bar: Look, Actors). Each appears over **0.7 s** (untouchable, harmless), at a spawn point. Every attack is telegraphed. Every kind dies in pieces of its own shape.

| Kind | Zone | Shape | Radius | HP | Speed | Behaviour |
|---|---|---|---|---|---|---|
| Chaser | 1 | circle | 0.45 | 3 | 4.2 | rushes in; contact hurts |
| Shooter | 1 | triangle | 0.45 | 2 | 3.0 | keeps 6 to 9.5 units away, strafes, fires bursts |
| Bruiser | 1 | square | 0.7 | 8 | 2.2 | slow, armoured, slams |
| Trickster | 1 | diamond | 0.4 | 3 | 4.8 | orbits at 5 units, blinks, feints, dashes |
| Orbiter | 2 | ring (hollow circle) | 0.5 | 3 | 5.4 | circles the player, tightening, then cuts straight through |
| Warden | 2 | eye (disc, black pupil, broken ring) | 1.0 | 14 | 1.1 | keeps its distance, fires spiral volleys; shelled while firing |
| Sweeper | 2 | clock hand (pivot disc, tapered arm) | 0.5 | 4 | 3.4 | plants and sweeps its arm round an arc it marks first |
| Pulsar | 2 | cog (eight teeth) | 0.55 | 5 | 2.0 | keeps its distance, sends out a ring wave with one gap |
| Lancer | 3 | needle | 0.35 | 2 | 3.2 | keeps its distance, locks a long aim line, charges along it |
| Splitter | 3 | hexagon | 0.55 | 4 | 3.2 | rushes and lunges; splits into two splitlings when killed |
| Splitling | 3 | small hexagon | 0.3 | 1 | 6.0 | rushes and lunges; contact hurts |
| Leaper | 3 | cross | 0.45 | 3 | 3.6 | leaps; its landing ring follows the player, stops, then it lands |
| Cutter | 3 | slanted bar | 0.45 | 3 | 3.0 | keeps its distance, draws a seam along a line that burns |

Every enemy shares one state machine and uses the states its behaviour needs:

```
Spawning ─▶ Move ─▶ Windup ─▶ Lunge (chaser, trickster, orbiter, lancer, splitter, splitling) ─▶ Recover ─▶ Move
                          ├─▶ Burst (shooter) ──────────▶ Recover
                          ├─▶ Volley (warden) ──────────▶ Recover (open)
                          ├─▶ slam (bruiser) ───────────▶ Recover
                          ├─▶ Sweep (sweeper) ──────────▶ Recover
                          ├─▶ Pulse (pulsar) ───────────▶ Recover
                          ├─▶ Leap (leaper) ─lands──────▶ Recover
                          ├─▶ Cut (cutter) ─────────────▶ Recover
                          └─▶ Windup (trickster feint → real)
             Move ─▶ Blink (trickster) ─▶ Windup
Any of Move, Windup, Lunge, Burst, Volley, Sweep, Pulse, Cut, Recover ─hit or parried─▶ Stagger ─▶ Move
Any state but Leap ─centre off the floor (The Void)─▶ Falling ─0.8 s─▶ gone (a ring-out kill)
```

- **Chaser.** Approaches. Within **3.4 units** and off cooldown: windup **0.45 s** with a line telegraph 4.2 long, then lunges at **17 u/s for 0.22 s** along the locked line; recovers 0.55 s; cooldown 0.9 s. Touching the player while moving hurts too.
- **Shooter.** Backs off under 6 units, closes in past 9.5, strafes between (switching side every 1.6 s). Every 2.4 to 3.2 s (first after 1 to 2 s), within 3 to 13 units: windup **0.6 s** with a line telegraph to the player, then a **burst of 3 orbs 0.12 s apart**, each aimed at the player ±6°; recovers 0.4 s.
- **Bruiser.** Approaches. Within **2.6 units**: windup **0.85 s** with a ring telegraph of radius 2.8, then slams everything inside the ring; recovers 1.0 s; cooldown 1.2 s.
- **Trickster.** Orbits. Every 1.6 to 2.4 s it blinks out for **0.3 s** and reappears 3.5 to 4.5 units from the player. Then 45% of the time it feints (a thin telegraph for 0.35 s, no attack) before the real windup of **0.38 s** (line 4.5), then dashes at **20 u/s for 0.2 s**; recovers 0.7 s.
- **Orbiter.** Closes in, then circles the player (side picked at random), its orbit tightening from **5 to 2.6 units over 2.2 s** (the first time after 1.6 to 2.4 s). Then windup **0.42 s** with a line telegraph through the player and 2.5 units past them, then cuts along it at **18 u/s** to the line's end, passing through; recovers 0.6 s; the orbit opens out to 5 units and tightens again. *Reads:* a ring that spins (faster as it winds up and cuts), leaving a dotted orbit on the floor; its cut leaves afterimages and speed lines.
- **Warden.** Drifts to stay 5.5 to 9.5 units away; never strafes. 1.6 s after its open window ends (the first time 1.2 to 2 s after it appears), within 14 units: windup **0.9 s** with a ring telegraph of radius 2.2, then a **volley**: 14 shots 0.11 s apart, each 3 orbs 120° apart, the first along its aim, the spiral turning 13° per shot (one way or the other, picked at random each volley); orbs fly at 5.5 u/s. While winding up and firing its shell is up: every player hit *clanks* (no damage, no knockback, 2 steps of hit-stop, one clank per move) except the breaker's slam, reflected orbs and the special. After the volley it is **open for 2.2 s** (Recover). Armoured (only the spin, the slam and the seal stagger it), knockback taken ×0.15. Reflected orbs seek the nearest warden first, deal **3× damage (6)** through the shell and stagger it for 0.8 s, cutting the volley short. *Reads:* an eye in a shell of six plates that drift round it, close and spin up as it winds up (three chevrons on its windup ring show where its arms will fire) and while it fires, then slide out and sag while it is open, its eye flickering white and a white ring tightening round it; a blow on the shell rings off in white sparks; its death throws the plates.
- **Sweeper.** Approaches to **2.4 units**, plants. Windup **0.55 s**: an **arc telegraph**, a thin sector outline of radius **2.9** spanning **200°** centred on the player, an arrowhead at its leading end showing the turn (one way or the other at random), while the arm draws out to 2.9 long. Then the arm sweeps the arc at **600°/s** (0.33 s), hitting the player where it passes (melee: a parry staggers it 1.4 s). Recovers 0.6 s; cooldown 1.0 s; first after 0.6 to 1.2 s. The arm sweeps through pillars. *Reads:* the arm leaves a crescent smear in the accent and spins back to rest after.
- **Pulsar.** Keeps 6 to 9 units away, strafing slowly. Every 3.0 to 3.8 s (first after 1.5 to 2.5 s), within 12 units: windup **0.8 s**, spinning up, with a **ring telegraph** of radius **6.0** broken by a **60° gap** facing a random way. Then a **ring wave** runs out from its body to radius 6.0 at **10 u/s** (0.54 s), half-width 0.25: it hurts the player where its front crosses them, unless they are in the gap, dashing (a near miss), or behind a pillar from the pulsar (the beam's cover rule: the line from the pulsar to the player passes through a pillar, with the player's radius as margin). Recovers 0.7 s. *Reads:* the cog spins faster through the windup; the wave a thin bright ring in the accent with a white core, scorching the floor it crosses.
- **Lancer.** Backs off under 6 units, closes in past 10, strafes slowly between. Every 2.4 to 3.2 s (first after 1.2 to 2 s), within 3 to 14 units: locks its aim at the player and winds up **0.8 s** with a line telegraph as long as its charge, the distance to the player plus 4, between 8 and 15 units; then charges along it at **22 u/s** to the end; recovers 1.0 s. Walls stop a charge; it runs on over edges, so a sidestepped lancer can run off The Void. *Reads:* a flat needle (1.3 long, 0.3 wide) that hovers low and rolls, draws back and quivers as it winds up, flashes white on the windup's last three steps under a lock-on tightening at the end of its line, and charges in a white streak with afterimages and a scar on the floor.
- **Splitter.** Approaches. Within **3 units** and off cooldown (first after 0.5 to 1 s): windup **0.5 s** with a line telegraph 3.8 long, then lunges at **14 u/s for 0.24 s**; recovers 0.6 s; cooldown 1.0 s. Killed by any player hit, a reflected orb or the special, it splits into **two splitlings** 0.6 units to either side of the blow, thrown outward at 6 u/s, recovering 0.35 s before they act. A ring-out takes it whole. *Reads:* it breaks along its seam: a white cut, the halves flung out along the splitlings' paths with speed lines, then the splitlings pop in.
- **Splitling.** Approaches. Within **2.4 units**: windup **0.3 s** with a line telegraph 3.0 long, then lunges at **15 u/s for 0.18 s**; recovers 0.45 s; cooldown 0.8 s. Touching the player while moving hurts too. Dies whole.
- **Leaper.** Approaches to **7 units**. Off cooldown (first after 1.0 to 1.8 s): crouches **0.5 s**, then **leaps**: airborne **0.9 s**, untouchable, over edges and gaps. As it leaves, a **spot telegraph** (a ring r **1.4**) appears under the player and follows them at **5 u/s** (below their run speed) for 0.6 s, then stops; the leaper lands on it at 0.9 s, hitting inside it (melee: a parry on the landing staggers it 1.4 s). Landing over no floor, it falls (a ring-out kill). After landing it is stuck for **0.9 s** (Recover) and light (knockback taken ×1.4): ring-out bait. Cooldown 1.4 s. *Reads:* a shadow under the spot shrinking to it, speed lines on the fall, a dust ring on landing.
- **Cutter.** Keeps 5 to 9 units away. Every 2.8 to 3.6 s (first after 1.2 to 2.0 s), within 12 units: windup **0.7 s** with a line telegraph from itself through the player out to **10 units**. Then it draws a **seam**: a crack running out along the line at **20 u/s**, stopping at the floor's edge or a wall, that stays live **2.0 s** (half-width 0.2) and hurts the player on touch; crossing it while dashing is a near miss. At most 2 of a cutter's seams live at once. Recovers 0.8 s. *Reads:* a thin crack glowing in the accent with a white core, flickering on twos, healing back to stone as it ends.

**Orbs**: radius 0.22, 8.5 u/s (warden 5.5), 1 damage, 3 s life; a wall ends them; they fly on over The Void's edges.

**Finding the way.** An enemy (or a boss) walking toward the player goes straight at them when nothing stands between; otherwise it walks the shortest way round the walls, props and floor's edges, turning at each corner. The way comes from a navigation mesh ([navcat](https://github.com/isaac-mason/navcat)) built from the same walls bodies collide with, for the body's radius (`src/sim/paths.ts`), so every room, mirrored, sealed, with slabs fallen or pillars broken, has its ways with nothing authored. The meshes a room's fight needs are built under the transition's full ink once the room has swapped (a door's hold, the zone card), one a step: for each floor it is fought on (sealed, and after each slab group falls) and each body its waves or boss send; any a body still lacks in play (a broken pillar's floor) is built the step it appears. With a wall or prop between it and the player, every kind walks round and holds its attack until it has a clear line (the trickster still blinks); across a gap in The Void it sees the player, so it attacks as ever (a leaper still leaps it) and only walks the way round. A test walks every room's spawn points to its doors for each size its zone's waves send.

Hit knockback fades at 10/s. Enemies keep apart from each other and out of the player's body (unless lunging or leaping, or the player is dashing through).

Knockback taken: chaser and shooter ×1, bruiser ×0.25, trickster ×1.2, orbiter ×1.1, warden ×0.15, sweeper ×0.8, pulsar ×0.6, lancer ×1.3, splitter ×0.9, splitling ×1.5, leaper ×1.4, cutter ×1.2.

**Elites.** An elite is any wave kind at **×3 health**, **×1.3 radius** (its body, and every hit the player lands on it), knockback taken ×0.5 and windups ×0.85, with a white crown of three small triangles over it and a brighter glow. It counts as one kill. Elites appear only in elite rooms' last wave.

## Bosses

One per zone, alone in its boss room, each a large composition of its zone's shapes.

- **Intro.** The doors seal as the player enters; the gameplay clock holds **2.0 s** while the camera holds the boss in a low three-quarter shot with its name card, the kanji large and the name in tracked caps (`bossIntro`); then a 0.6 s blend back to play.
- **Bar.** Top centre: the boss's kanji and name, a thin bar of its health with a tick at each phase threshold, and under it a thinner **balance** meter.
- **Balance (kuzushi).** 0 to 100. Gains: a parried boss attack +25, a reflected orb +12, the weapon's balance per hit (Weapons). It decays 8 a second after 2.5 s without a gain. Full: the boss is **broken** for **3.0 s** (`bossBroken`): staggered, attacking nothing, taking ×1.5 damage (the special ×2), and the meter empties. The meter holds through shifts.
- **Phases.** At each threshold the boss **shifts** for **1.6 s** (`bossPhase`): invulnerable, it roars (a ring that pushes the player back at 6 u/s, no damage), summons, and its arena changes; then the next phase.
- **Patterns.** Phase 1 plays its patterns in a fixed order, looping, to teach them. Later phases draw at random, each pattern different from the one before (`bossPattern` as each starts). Rest between patterns: 0.9 s, 0.7 s, 0.5 s in phases 1, 2, 3. Each pattern reuses the tell of the enemy it grew from and ends with the boss open for at least 0.6 s.
- **Summons** are its zone's kinds, at the room's spawn points; they die with it.
- **Defeat.** The killing blow (`bossFelled`, its summons struck down with it): 1/4 speed for **1.5 s** (run clock) under cinema bars, with impact frames and a held drawing of the boss breaking apart (its parts flung off, crossing white cuts); then it is gone (`bossDefeated`, one kill) and `zoneCleared`; a spring rises where it fell; the zone gate opens. After the third boss its room's seals break as for the others (no gate), the HUD reads CLEAR, the player stays in the room while the run ends, and RunClear comes 3.0 s later. The health bar stops at the next phase's threshold until that shift has played.
- Bosses take no knockback, never fall, and stagger only when broken. Their health is balanced against the blade.

| Boss | Zone | Shape | Radius | HP | Phases (from) |
|---|---|---|---|---|---|
| Gatekeeper 門番 | 1 | a great square carrying a diamond crest and two triangle shoulders | 1.7 | 60 | 1 (100%), 2 (50%) |
| Orrery 渾天儀 | 2 | a great eye in two tilted rings, three ring moons orbiting at radius 3 | 1.6 | 90 | 1 (100%), 2 (50%) |
| Sunder 断 | 3 | a great hexagon crowned by six needles, a white seam across it | 1.8 | 120 | 1 (100%), 2 (60%), 3 (30%) |

*Reads:* each boss is built of its zone's shapes at scale, with the same ink rims, accent glow and white flashes, its parts moving on twos (the Gatekeeper's crest and shoulders lifting into a slam, the Orrery's rings and moons turning, Sunder's needles bristling). Broken: it sags, its glow drops to a third, a cracked white ring round it. Shifting: a roar ring, the frame's edge darkening, the arena's change on beats. **The name card** is a held sakuga drawing: the boss mid-pose in a low shot (Camera, `boss`), and on the left, while the intro holds and scrubbed by the boss view's `progress`, an ink band slashes in with an accent edge, the kanji, brush-lettered, stamps down large and rattles, ZONE n · BOSS over it, the name tracks in over an accent stroke, its phase count, speed lines streaming behind, and the band slashes away. **The bar**, top centre once the card ends: the kanji in the accent, the name, PHASE I / II in roman numerals, the health bar in the accent with a paper chip trailing each blow and a paper tick at each threshold, the balance meter under it (a 1px paper rule at 35% filled in paper; while broken it floods the accent and drains through the break), its BALANCE and PHASE words in paper at 60%, the whole block on a soft ink scrim (#0d0d0f at about 65%, fading at its sides) so it reads over any floor, and a tag for BROKEN, SHIFT or OPEN. While the boss stands within 28 px of the bar's box on screen the bar fades to 40%, so the boss reads through it. The killing blow cracks the bar and throws its halves apart.

### Gatekeeper 門番

Walks at 2.4 u/s toward the player between patterns. Room: `courtyard.great`, standing 4 units from its centre away from the door the player came in by.

- **slam** (the bruiser's tell): a ring telegraph r **3.6**, windup **1.0 s**; slams inside it; 0.35 s later a second ring from 3.6 out to **6.0** strikes (both rings telegraphed together).
- **charge** (the chaser's tell): a line telegraph **16** long at the player, windup **0.8 s**; charges along it at **20 u/s**. Meeting a pillar or wall it stops **stunned 1.5 s** (open, ×1.5 damage); else it recovers 0.8 s.
- **fan** (the shooter's tell): five line telegraphs fanned over 60°, windup **0.7 s**; then **4 bursts 0.25 s apart**, each 5 orbs over 60°, every other burst offset by half a gap.
- **blink** (the trickster's tell; phase 2): blinks out **0.3 s**, reappears 4.5 units beside the player, feints 40% of the time (0.35 s), then two crossing line telegraphs 9 long through it, windup **0.45 s**, and both lines strike (half-width 0.6).
- Phase 1: slam, charge, fan, charge. Phase 2: slam, charge, fan, blink, at random.
- Shift at 50%: summons 2 chasers and 1 shooter. From then on a charge that meets a pillar breaks it (the stun still comes, `bossStunned` with `breaks`); a broken pillar leaves the room's layout and terrain for good (the room's record keeps it, as it keeps fallen slabs), so cover runs out.
- Defeat: a white seam opens across the square, the crest and shoulders fly off, the square breaks into quarters.

### Orrery 渾天儀

Hovers at the room's centre and turns to the player; never walks. Room: `spiral.orrery`.

- **volley** (the warden's tell): a ring telegraph r **2.6** with chevrons, windup **0.9 s**; **20 shots 0.1 s apart**, 4 arms, turning 11° a shot, orbs at 5.5 u/s. Shelled while winding up and firing (clanks as the warden's); open **1.8 s** after.
- **moons** (the orbiter's tell): its three moons leave their orbit and circle the player, tightening from 5 to 2.6 over **1.6 s**; each then cuts through in turn, **0.25 s** apart, each after a line telegraph of **0.42 s**; they return to orbit.
- **hands** (the sweeper's tell): two hands reach out from opposite sides; two arc telegraphs r **7**, 180° each, windup **0.8 s**; both sweep at **300°/s**. Safe: within 2.2 of its centre, outside 7, or dashing through.
- **pulse** (the pulsar's tell; phase 2): three ring waves **0.6 s** apart out to radius **12** at 10 u/s, each with a 60° gap facing a different way; pillars cover as from the pulsar.
- Phase 1: volley, moons, hands, moons. Phase 2: volley, moons, hands, pulse, at random.
- Shift at 50%: summons 2 orbiters. **The beam lights:** from then on the Orrery is the spire; the beam's first telegraph shows as the shift ends (1.6 s), then it sweeps from the Orrery's edge (radius 1.6) at 40°/s through 270°, resting **3 s**, the six pillars its cover. Its room keeps the beam (`lit`) until the boss falls; a beam mid-sweep then finishes.
- Defeat: the rings fly apart, the moons drop and roll, the eye shatters.

### Sunder 断

Walks at 3.0 u/s; edges stop it. Room: `void.abyss`, standing 3 units from its centre away from the door the player came in by.

- **needles** (the lancer's tell): locks three aim lines (at the player and 25° either side), windup **0.8 s**; fires a needle along each at **26 u/s**; they fly off into the void. Open **0.8 s** while they regrow.
- **lunge** (the splitter's tell): a line telegraph 7, windup **0.6 s**, lunges at **16 u/s for 0.4 s**, stopping at the edge.
- **leap** (the leaper's tell; phases 2 and 3): airborne **1.1 s**, untouchable; a spot telegraph r **2.6** follows the player at **5.5 u/s** for 0.7 s, stops; it lands inside it. Landing on a cracking slab brings its whole cracking group down at once.
- **seams** (the cutter's tell; phases 2 and 3): four seams run from it in a cross (or an X, alternating) at **20 u/s** out to 14 units, live **2.0 s**.
- **split** (phase 3): splits into two half-hexagons for **8 s**, each playing lunge and leap on its own and sharing the one health bar (a blow on either counts); then they rejoin at the centre over **1.0 s**, open and taking ×1.5 damage.
- Phase 1: needles, lunge, needles, lunge. Phase 2: needles, lunge, leap, seams, at random. Phase 3: needles, leap, seams, split, at random.
- Shift at 60%: summons 2 lancers; the four outer slabs crack (2.6 s) and fall. Shift at 30%: summons 2 splitters; the core's rim cracks and falls, leaving 12 × 8.
- Defeat: the hexagon breaks along its seam into six wedges that tumble into the void as a ring-out does, the needles after; a white flash far below. RunClear 3.0 s later.

## Hazards

Each zone's hazard appears only in its rooms that carry it. A room's hazard starts when its doors lock and stops when it clears (a beam mid-sweep finishes and goes dark; a crack already running still falls). Each room starts with its hazard on; the debug hooks can switch it off (Debug hooks, Hazard).

**The beam** (Spiral well and dial rooms; the Orrery's room from its second phase). A beam sweeps round from the spire like a clock hand: it starts at the spire's surface and reaches the first pillar or the wall along its line, half-width 0.3. It turns clockwise (on screen) through **270°** at **40°/s** (dial and the Orrery) or **30°/s** (well), rests **5 s** (the Orrery: 3 s), then sweeps again from where it stopped; the first sweep starts at north 3 s after the doors lock. **1 s** before a sweep a thin telegraph line appears where it will start, and during the sweep the telegraph runs **1 s ahead** of the beam. Pillars block it, so the ground behind a pillar is cover. It hurts only the player: a hit costs a diamond like any other (knocked out of the beam, 1.2 s of invulnerability); a dash passes through it (a near miss, +10 FOCUS, once per dash). Near the spire the beam is slow enough to outrun (at 6 units the dial's moves 4.2 u/s); at the rim it is not (9.8 u/s at 14 units), so there the player hides or dashes. *Reads:* a second before a sweep a crisp line marks where it starts, with chevrons pointing the way it will turn; then a white-hot core in an amber glow whose edges waver with heat, over a burning strip of floor, throwing sparks and a starburst where it strikes a pillar or the wall. While it is warned and while it sweeps, the floor it will cross in the next second washes amber, a scorch fades behind it, and the ground a pillar keeps out of it is hatched in paper, only where a ray grazing the pillar passes at least 0.72 from a body's centre (the beam's half width plus the player's radius); its floor and cover are read from the room's own floor and pillars. The spire's slit and its glow: Look, The Spiral.

**Edges** (every Void room). Edges stop the player, walking or dashing, and any enemy walking under its own power. An enemy that is lunging (a charging lancer, a cutting orbiter, any lunge) or knocked back faster than 1 u/s (freshly split splitlings included) ignores edges: an enemy whose centre leaves the floor **falls for 0.8 s and dies**, drifting on its momentum. That is a **ring-out**: it counts as a kill (+8 FOCUS, 6 steps of hit-stop), and a splitter rung out dies whole. Every blow knocks enemies back **1.8× as far** in the Void. *Reads:* the shape holds white at the edge for two drawings over an ink burst, then tumbles down out of sight, shrinking, with accent and white speed lines streaming up past it; a flash far below at the end of its fall.

**Collapse** (Void causeway and collapse rooms; Sunder's room). When the wave a slab group names clears (in Sunder's room, as the boss's shift into the phase after it begins), its slabs crack: **2.6 s** of telegraph, then they fall (during the next wave's breath and banner). A player standing on a falling slab is hurt (a diamond, unless invulnerable) and set down on the nearest standing floor; an enemy on it falls. Slabs that fell stay fallen when the player comes back. *Reads:* a player caught on a falling slab leaves a white afterimage dropping and a dotted line to where they land in a ring; how slabs crack and fall: Look, The Void.

### What changed from the board's sketch, and why

- The beam turns one way only, clockwise, so it reads as a clock hand and the player can learn where it comes from; each sweep is 270°, so it starts somewhere new each time.
- Its telegraph shows where the beam starts a second ahead and then runs a second ahead of it, so it warns of the next second, never of a fixed line.
- The warden's reflected orbs seek the nearest warden first and stagger it: a parry during a volley breaks it, which is what makes the parry matter.
- Knockback is 1.8× in The Void; at the Courtyard's numbers a spin moves an enemy under a unit, too little for ring-outs to be a tactic.
- Slabs fall between waves rather than mid-wave, so a fall never lands in the middle of a fight; slabs that carry a door or the core never fall.

## Time

| Moment | Effect |
|---|---|
| Blade cut or crosscut hit | 3 steps hit-stop |
| Spin hit | 5 steps hit-stop |
| Other weapon hits | the weapon's hit-stop (Weapons) |
| Kill | 6 steps hit-stop |
| Parry | 6 steps hit-stop |
| Player hurt | 8 steps hit-stop |
| A wave's last kill, waves to come | its kill's hit-stop only |
| A room's last kill | 1/4 speed for 1 s; the seals break as it ends |
| Special | world frozen ~1.15 s, then 1/3 speed for 0.7 s |
| Door transition | gameplay frozen 1.33 s |
| Zone change | gameplay frozen 3.27 s |
| Boss intro | gameplay frozen 2.0 s |
| Boss defeated | 1/4 speed for 1.5 s |
| Player down | 1/4 speed for 1 s |
| Pause, menus | both clocks stop |

Hit-stop holds the gameplay clock while the run clock goes on; overlapping hit-stops hold until the last of them ends. Effects may keep animating through hit-stop (they read `FrameTime.dt`) or freeze with the game (`FrameTime.gameDt`).

## Look

The current room's world is built from its layout when the player enters it, in its zone's look (`src/look/worlds.ts`, the rooms in `src/look/rooms/`; the title always shows The Courtyard, the sandbox each zone's classic arena). The hero, the ink-and-paper drawing, thin telegraphs and the UI's style are the same everywhere; the palette, the light and the location change by zone. Each template's floor is drawn once as an SVG in its own units and mirrored with the room by flipping how it is laid; a zone's floors (and in The Void its slabs' crack glows) are drawn and handed to the GPU one a frame when the zone starts (The Courtyard's while loading), so a door's swap only builds meshes under the ink; the other zones' are released (`src/look/rooms/art.ts`).

- **Palette.** Each zone's own; where its accent goes, and the title's red, are in Zones, Palettes.
- **The Courtyard** (classic: `arena.ts`, `floor.ts`; rooms: `rooms/yard.ts`, `rooms/yard-floor.ts`). High three-quarter top-down camera over the yard. Big grey blocks and pillars throw long hard shadows from a low sun at the upper left. Worn mid-grey tiles: cracks, scuffs, ink stains, faint brush marks, worn lanes between the doors. Paper grain and a vignette over the frame. Each room has its own inlay: the forecourt an arrowhead in a ring with its north path paved pale, the shrine a double rule with a diamond at each corner, the yard a drain grate where its lanes cross, the cloister a darker walk one tile in from its walls, the gate the broken footing of its wall, the court the old court's rings, and the great court an arena: a wide ring of dark stone ticked every 15° round a scorched heart, its pillars on plinths with bands and a heavy capital. The walls carry pilasters on their outer face; outside, stone lanterns burn paper-white behind the far wall and down the flanks, monoliths stand tall to the north and low to the south, rubble lies along the walls. Each template has set pieces of its own off the floor (`rooms/yard-pieces.ts`): the forecourt and the great court hang tall ink banners, each with a paper ring of ticks, on poles in the north wall, swaying on twos, and the cloister a row of four; the shrine, the cloister and the court burn small stone lamps along the top of the north wall; the yard, the gate and the court have a column fallen in pieces on the sunken ground outside a side wall.
- **The Spiral** (classic: `spiral.ts`, `spiral-floor.ts`; rooms: `rooms/dial.ts`, `rooms/dial-floor.ts`; the stonework both share, `dial-parts.ts`). Round dials of teal-slate stone at dusk under a cold steel light: flagstones in rings that alternate pale and dark like a target, a pale spiral inlay with notches, the rim ticked like a dial, faint hour lines, burn streaks fanning from any spire. The spire is three stepped drums with an amber slit round the lowest (where the beam leaves, glowing brighter while it is warned or sweeps, throwing amber on the stones within about 8 units) and an obelisk with an amber lamp near its top. While the player, an enemy or the far end of a telegraph stands behind the spire or a pillar from the camera, it thins to a dithered fifth of itself (the lamp goes out), its shadow staying. The pillars are stone columns: a square plinth, a tapering shaft banded near each end, a flared cap and a thin abacus. A ring wall (a low kerb on the south arc) carries stele at the hours, and needles of stone stand outside, tall to the north. The low sun wheels round once every 96 s of play, so long shadows sweep the dial like clock hands. Each room has its inlay: the gnomon's sundial (hour lines fanning north of a stump with a sundial's blade, its long shadow cut into the stone), the shrine's eight-pointed star, the ring's single groove, the colonnade's spiral through its pillars' feet, the well's groove round its spire, the dial's spiral as the classic arena's, and the Orrery's orbits with bodies resting on them and the zodiac's ticks. The Orrery's room stands inside a great armillary: three rings far bigger than the dial, tilted so their high arcs stand behind the north wall and their low arcs sink under the ground, moons riding them and throwing their shadows. Every other room has its own landmark beyond the ring wall where the frame shows past the floor (`rooms/dial-pieces.ts`; the tall ones west, clear of the HUD's column): the gnomon's room and the well a great dial face on a post, square to the camera, a pale plate with ink rings and hour marks whose hand ticks on; the shrine and the colonnade an armillary of three nested rings on a post round a lamp, one ring lit, turning on twos; the ring a row of bronze gnomon blades with a lit edge to the east and the dial (too wide to show past its sides) to the south-east, their long shadows sweeping as the sun wheels.
- **The beam** (`src/vfx/beam.ts`): Hazards, The beam, *Reads*.
- **The Void** (classic: `void.ts`, `void-floor.ts`; rooms: `rooms/islands.ts`, `rooms/islands-floor.ts`). Cool grey slabs in ink-black space, lit from high above by a lavender light: each a thick tablet with a worn lip, a paper rule round its edge, a faint 1-unit grid, sides that drop into the dark within a few units and broken rock hanging under it. Every slab that will fall shows from the start the hairline cracks it will break along. The violet column of light beyond the north edge tints the slabs near it. Broken slabs and monoliths hang far off and far below; debris drifts down past them. A cracking slab shakes on twos while its cracks glow violet and brighten, grit trickling off its edges; when it falls it bursts dust and stone, drops and tips away, and its pieces flash far below. Each landing is a darker slab with chevrons pointing out to its gate. The slab a room turns on carries its mark: the threshold an arrowhead in a ring, the shrine two crossed squares, every other the seal, and Sunder's abyss a great hexagon split by its seam; great stone needles hang round the abyss in the dark. Every other room has its own landmark in the dark beside its slabs (`rooms/island-pieces.ts`): the threshold and the collapse a far slab with the broken stumps of columns on it and one fallen; the islet, the shards and the collapse a cluster of broken rock hanging and turning on twos; the shrine, the causeway and the shards a rift torn down through the dark to the west, a core of the zone's light in an accent glow, flickering on twos. What shares a room with the rift stands east, south of the HUD's column.
- **Ring-outs** (`src/vfx/edges.ts`): Hazards, Edges and Collapse, *Reads*.
- **Doors** (`src/look/rooms/doors.ts`; their bursts `src/vfx/doors.ts`; the chevrons off the frame `src/vfx/exits.ts`). Each zone's doorways, seals, emblems, an open door's light and the zone gate: Doors, *Reads*.
- **Altars and springs.** An altar: Weapons, Getting weapons, *Reads*. A spring: a round pool of paper-white light in a stone lip, rippling on twos; spent, a dry ink ring. The spring a boss leaves rises where it fell (`src/look/rooms/shrines.ts`, made the moment the view first shows it, so it joins the room without a rebuild): its stone lip inks in with an overshoot round a dry bed; once the zone's CLEAR banner has gone (26 drawings), a starburst and a shaft of paper light flash up, the pool fills with light, and one wide ripple runs out before the pool settles. A clear's drops pop up where the last enemy fell on twos and float, turning and bobbing, over a soft pool of light with a ring that pulses out: the diamond a paper rhombus with an ink rim, FOCUS a paper four-point spark; picking one up bursts it in a paper starburst with a ring and glints (`src/vfx/combat.ts`).
- **Transitions** (`src/vfx/transitions.ts`, drawn flat over the frame). Each beat's drawing and the *Reads* are in Transitions.
- **The air** (`src/look/atmosphere.ts`). Paper flecks and a few embers in the accent over the floor on screen: in The Courtyard on a slow wind, the embers rising; in The Spiral the air turns slowly round the dial; in The Void the flecks sink toward the dark.
- **Actors.** Player: white arrowhead, thin dark outline, soft contact shadow, faint white glow. Enemies: flat shapes in the zone's accent, dark outlines, an accent glow, and a thin accent health bar the same height above every kind once hurt. An enemy behind a prop from the camera draws through it, dimmed under its rim (`XRAY_BAND` in `src/art/depth.ts`). Telegraphs are thin accent lines, rings, arcs and spots; a line draws over props. On a pale floor (flagged by the world through `HostContext.ground`) orbs draw with an ink rim and a deep core, and telegraph lines are a solid stroke edged in ink. The player's own marks (the slam's ring, sigils, the charge's aim line) are thin paper-white lines, so they read apart from danger. Enemies a splitter throws out pop in with a white flash.
- **Enemy kinds** (the orbiter, warden, lancer and splitter in `src/look/actors.ts` and `src/vfx/foes.ts`). Each kind's *Reads* are in Enemies.
- **Bosses.** Bosses, *Reads*; each boss's defeat under its own heading.
- **Effects.** White shard speed lines, impact starbursts, accent sparks and ink splatter, dotted dash trails and afterimages, a parry X-flash; for the special, a full-screen radial burst, 1 to 2 inverted impact frames, accent/white strobe and slow motion. Each weapon's own reads, the blade's slash crescents among them, are in Weapons. Effects animate on twos (12 to 15 drawings a second) with smear frames and held key poses; the game itself runs smoothly.
- **Impact frames.** Full-screen impact frames are kept for the special, parries, a room's last kill, a boss's shift and defeat, and the player going down, at most one every 0.45 s (the special's own frames skip the wait). An ordinary kill draws a local ink starburst and closes an ink vignette round the frame for a drawing; a hurt closes an accent one. The impact-flash setting (default reduced under `prefers-reduced-motion`): reduced darkens the frame's edge instead of inverting it, off draws none; full-screen strobes scale to 25% or 0. The screen-shake setting scales every camera kick.
- **Hurt blink.** While invulnerable after a hit the player alternates between solid and a ghost (its body at 30% under the rim light) on twos, always in view; its contact shadow stays.
- **UI.** Brush-lettered KUZUSHI with 崩し under it and a red slash through it; 1px rules and framed panels; condensed small caps. Menus: wide-tracked caps, the chosen item on a brush bar fading out to the right inside corner brackets; moving smears the bar to the next item, choosing slashes across it. Every word on screen names, counts, states, or says what a control or choice does. **HUD:** bottom left, the diamonds (5) and the brush-stroke FOCUS bar, and beside them the weapon's kanji in a diamond with its name and style, the darts' six pips and a charge line under it (a taken weapon stamps in; a dash's reload sweeps the pips full); top right, the minimap, and under it ZONE and its number with its kanji in the accent, its name, the run timer, and the room: its kind (Start, Combat, Cache, Elite, Altar, Spring, Boss), SEALED in an accent box while its doors are locked or CLEAR once its fight is won (each stamped in as it happens), and WAVE n/N while a room of more than one wave fights, the line on a short ink scrim fading out to its left so it reads over a door's seal behind it. The HUD steps back for the zone change's card, a boss's name card and its defeat. **Boss:** the name card (`src/ui/boss-card.ts`) and bar (`src/ui/boss-bar.ts`) are in Bosses, *Reads*. **Banners:** the run's first zone as its start room opens; WAVE n/N with the enemy mix as a wave starts, its kicker DOORS SEALED on the first, FINAL WAVE on the last, ELITE WAVE with a crown over the elite's icon; a wave's CLEARED between waves; CLEAR as a room's seals break, kicker DOORS OPEN, with what the clear left on the floor: a diamond and +1, FOCUS's spark and +40 FOCUS; a zone's CLEAR with its kanji, its time against its best (NEW BEST) and GATE OPEN; in the Void, how many slabs a clear brings down (2 SLABS FALL). The FPS readout sits in the bottom-right corner, inside the title's frame while the title is up. While the special plays (from its start until its slow motion ends) the HUD, the combo counter and any banner wait. Menus open on their first option (resume, retry) and the pointer selects only once it moves. In play the HUD, banners, pause and results take the current zone's accent; the title's menus stay red. On the Spiral, paper text sits on a darker amber (#b86a00) rather than the bright accent: menu bars and the rank seal fill with it there (`src/ui/accent.ts`). **Run panel** (what each card holds: Screens): each card in its own palette (a plan of its classic arena in its ground, light and accent values, a strip of its six colours, its number in its accent), with its boss's icon, its best clear labelled BEST and, on zone 1, the best full run and its rank labelled RUN; the brackets take the chosen card's accent. **Results:** ZONE n and its name over RUN CLEAR or GAME OVER, the run's span when it crossed zones (ZONE 1 TO ZONE 3; left out when it would repeat the zone), then time, kills, rooms, zones cleared out of those the run could, diamonds and the weapon in hand; the seal holds a full run's rank (NEW BEST or the best time), a practice run's starting zone (FROM ZONE, PRACTICE), or the zone the player fell in (FELL IN, the zone's number in the seal, the room's kind: COMBAT ROOM).

## Title scene

The title's 3D scene (`src/title/`) plays only while the flow is Title, in The Courtyard whatever zone was played last. The hero stands in the courtyard's centre circle inside a ring of seven red shapes at full health (so no bars), drawn by look's actor visuals from views the title writes, outside the simulation. A huge red sun sits low over the south wall, where the backdrop is kept low, with dry-ink cloud bands across it; cloud shadows (which start each loop in the same place) and wind streaks drift. A 6.3 s loop cuts between designed shots: the page opens on the hero shot, low behind the hero, which stands up on its tail with its face to the lens and its head inside the sun's disc, leaning and turned a little off square with its edge lit red by the sun, while the ring re-forms (0 to 0.7 s) and starts to close; at 2.5 s the wide shot looks down as the ring closes in and winds up at 3.9 s, its telegraph lines filling along the floor; the hero dashes east through the ring (a little south of east, then north of it on the next loop) with a spin crescent at 4.45 s under the clash shot, one impact frame plays at 4.55 s (it follows the impact-flash setting) and the hero stands up again under it, facing the lens, every effect holds, and the shapes shatter into ink at 4.69 s. A shape that would stand within 3.2 units of a shot's lens, seen less than 10° above edge-on (so none in the low hero shot), behind the lens, or in the menu's column (left of 0.49 of the screen's width; no column on a narrow screen) is left out of that shot. The loop starts at t = 0 as the loader lifts, and the menu is up within 0.8 s of the loader's outro starting; any key or click finishes its intro at once. While a panel is open the loop holds the hero shot short of the windup, so the panel sits over one steady shot. Moving the menu selection turns the hero, flashes a glint and a shape, and adds a tiny shake. Choosing a zone cuts to a shot facing the hero from the side away from the sun, and the hero dashes at the lens; as it strikes, an ink blot in the starting zone's ink bursts from the middle of the screen on twos and covers it whole before the run starts (`src/ui/launch.ts`). Under full cover the title scene hides at once, look builds the start room and the camera cuts to the play shot; the title's red slash cuts across the ink, the wordmark cleaves over it (its impact frame inverts the letterforms only: each half's letters turn ink on a rough paper swell of their own shapes rather than a box), and the ink splits along the slash, its halves thrown apart to show the hero framed in the start room as the zone's banner plays.

## Camera

Klipp virtual cameras (`src/camera/rig.ts`):

- `title`: designed shots the title scene cuts between on its beats (low behind the hero against the red sun, wide over the ring, about 35° down from the south on the clash with the ring left of the hero, in front of the hero for the launch), panned so the subject sits right of the menu, 0.5 of the half-width right of centre whether or not a panel is open (centred on a narrow screen).
- `play`: 60° down, distance 24, fov 40 (about 21 units of ground top to bottom), the player at the centre of the screen, dead zone 0.05 × 0.05, hard limit 0.2 × 0.17, damping 0.18, lookahead 0.12 s. It leads up to 0.7 units toward the aim. While a boss fights (after its name card), the follow target leans from the player toward the boss, half the way and at most 6 units, easing in and out, so the boss stays in frame (the Orrery at the dial's centre with the player at the south door); while its bar shows, the frame keeps the bar's band (120 px) clear, its subject moved down by it, and stands 1.1× further back, both eased, so the boss stays under the bar. **Once the zone gate opens** the frame turns toward it: across, its middle comes within 0.38 of the half width of the gate (some 30% of the frame in from its edge) as far as keeps the hero within half the half width of the middle; up and down, the follow target comes to where the gate stands no more than 5.5 units north of it or 4.5 south, as far as keeps the hero no more than 7 north or 4.5 south; the bound on the gate's side gives way to let it, through the exit beat too. **On a narrow screen** (aspect under 2) in a room with an east doorway, the subject moves left by up to 0.14 of the half width (0.6 for each step of aspect under 2; half that with a west doorway too), so the east door's seal stands clear of the HUD's right column; a docked lab panel that takes more wins. **Each room bounds it** from its floor's box: the frame's edges stay within the floor's half-width plus 4 of its centre line, and the follow target within z from −halfDepth + 5 to halfDepth − 3 (so the south door and its seal's emblem clear the frame's bottom edge) (collapsed to their middle when the floor is shallower than 9). The classic arenas keep their own bounds: the Courtyard half width 22, z −7 to 8; the Spiral half width 20, z −9 to 9.5; the Void half width 15.5 about x 0.5, z −3 to 1.5, its band tightening to the slabs still standing after each collapse (4 units inside their north edge, 3.5 inside their south). Under a transition's full cover (`roomSwapped`) and at a run's start the play camera cuts to its frame, its damping and lookahead dropped (`cutPlay`); after a door's cut the frame starts 1.6 units back the way the hero came and glides on into the room as the lead settles. A transition's exit punches the lens (4°, 6° into the next zone) and kicks the camera along the travel.
- `boss`: a boss's intro (the hero is hidden while it holds: the flat arrowhead would stand edge-on in the foreground), low and three-quarter on from the player's side (8.6 units out, 2.3 up, turned 0.62 rad off the line between them, a 4° dutch), the boss's centre at 0.3 of the half-width right of centre so it fills the right two thirds and its name card the left, pushing 1.4 units in while the intro holds (`setBoss` on `bossIntro`; the shot follows `view.boss.state === "intro"`), then a 0.6 s blend back to play.
- `pause`: a 4.5-unit push-in from wherever play was, also used on the results screens.
- `special`: a low cut-in over the player's shoulder that pushes in while time is frozen, the player a third of the way in from one side and a little low, the marked enemies filling the rest. It films from the side that keeps enemies, blocks, pillars and walls out of the line to the player and keeps every enemy in front of the lens at least 3.2 units from it. On the first beat it cuts wide and high (56° down) over the centre of the player and the targets, standing back far enough that they fit between the cinema bars, and it rolls (a dutch angle) to alternate sides between beats.

Blends: title → play a cut (under the run's ink cover), into pause 1.1 s, into special a cut, out of special 0.55 s, boss → play 0.6 s, transitions a cut under cover.

`installCamera` (`src/camera/index.ts`) picks the shot from the screen, sets the room's bounds, feeds the follow target and the lead, and frames the special against the current room's props and walls (in the Void, which has none, the lens may hang over the dark). vfx drives the rest through the rig: `shake`, `punch` (narrows the play lens, then springs back), `specialStrike(x, z, reach)` (the wide cut on the first beat), `dutch(degrees)`, and `hold`/`release` for choreography. `setSpecial(x, z, azimuth, side)` takes the ground direction the camera stands in from the player (simulation radians), not the player's facing, and the side of the frame the player takes.

## Audio

Music and sound effects play through @pixi/sound from the files in `src/audio/sfx/` and `src/audio/music/`. Loading loads every file (its warm step, `audio`), and nothing plays while it runs. Audio starts on the first click, tap or key. It pauses while the window is out of focus.

SETTINGS' **Music** (default 80%) and **Sound effects** (default 100%) step in tenths, each heard as its square: 80% is about -4 dB, 50% -12 dB.

| Sound | Plays on |
|---|---|
| ui-move | the highlight moving in a menu, a settings row or the zone cards; a setting's value changing |
| ui-select | a menu choice; a zone chosen |
| ui-back | Esc or BACK closing a panel on the title or in pause; Esc or P leaving pause |
| attack | every weapon's attack (`attack`) |
| hit | a blow that doesn't kill (`hit`) |
| kill | an enemy's death, off an edge too (`enemyKilled`) |
| hurt | the hero hit (`playerHurt`) |
| dash | a dash (`dashStarted`) |
| parry | a parry (`parry`) |
| special | KUZUSHI drawn (`specialStarted`) |
| door | a room's doors locking and opening (`doorsLocked`, `doorsOpened`) |
| clear | a room cleared, a boss's room too (`roomCleared`) |
| boss | a boss's name card and its killing blow (`bossIntro`, `bossFelled`) |

Five loops, one at a time; a new one starts as the last stops. Each file holds its loop and then the loop's first second again, and plays looping from 0.5 s to its end less 0.5 s, so the MP3 encoder's delay never lands on the seam.

| On screen | Music |
|---|---|
| The title | title |
| A boss in the room, from its name card until its killing blow | boss |
| Anything else: a run's rooms, pause, the results, the sandbox, the lab | the zone's loop (`courtyard`, `spiral`, `void`) |

## Debug hooks

For tests, the debug API (`window.__game`) and the debug scenes. Each is an intent `DebugIntents` handles during a run (in a room or in the sandbox); invulnerability and the player's moves last across runs, so `DebugCheats` takes them on any screen, the title and pause included:

- **Start** a zone's sandbox (`startStage(zone, 0)`: a run with no fights on that zone's classic arena), or a run in any zone, in its start room or any room by index or kind (`startZone(zone, room)`), with any seed and weapon; `startStage(zone)` and `start()` with any other wave start that zone's (The Courtyard's) dungeon at its start room. Restart begins the same way with a new seed.
- **Rooms** (`src/sim/dungeon/debug.ts`): go through to any room of the zone by index or kind (`enterRoom(room)`; `"boss"` skips to the boss room), through a door's transition or at once (`instant`); end the room's fight as if its enemies fell, without kills (`openDoors`: it counts as cleared, leaves its drops where the player stands, and a boss room raises its spring at its centre and opens its gate); shut or break the seals alone (`lockDoors`); show the whole map (`revealMap`); mark every other room of the zone cleared, so none locks and the boss room's gate stands open (`clearRooms`, for the lab).
- **Spawn** any kind at a point (pushed clear of walls) and facing, normal, as an elite, with its AI off (`idle`: it stands, turns to nothing and attacks only when told, but can be hurt, knocked back and killed), or as a **dummy** (AI off, never dies: its health refills when it would, no knockback, no stagger, and edges hold it). Both kinds of drill are harmless to touch.
- **Attack now**: an enemy (or every enemy) standing in Move starts its attack at once, whatever the distance, and plays it through.
- **Bosses**: take the room's boss to a phase (`bossPhase`; its shift plays, but a drill, which never shifts, takes the phase at once), break it open (`breakBoss`), make it play a pattern next (`bossPattern`), set its health (`bossHealth`).
- **Invulnerable**: the player takes no hits (enemy attacks and hazards pass through, with no near misses) until switched off.
- **Teleport** the player, or one enemy, to a point and facing, at rest.
- **Press** attack, dash, parry or special as one key press (an attack may name its step of the weapon's chain, so the blade's crosscut or spin, the breaker's slam or a seal plays alone), **hold** attack down for some seconds of gameplay time (the darts' charge and pierce), **interact**, and **steer**: hold a move direction until released (a new run releases it).
- **Weapon**: put any weapon in hand (`setWeapon`); marks already on the ground still land.
- **Blow**: one enemy takes a hit as a blade step would, from the player's side (damage, knockback, stagger, death, a splitter's split), through a warden's shell. **Remove** takes one enemy away without a kill. **Heal** refills the diamonds; **setLives** sets them (1 to the most).
- **Player moves**: speed, acceleration, deceleration, dash distance and dash time, overriding the numbers above until reset.
- **Hazard** on or off (off, the beam ends at once and rests, and no new slabs crack; a crack already running still falls), **sweep** the beam now (its telegraph first) and **collapse** the next slabs now (their crack first).
- **Open floor**: the run's floor becomes `OPEN_FLOOR`, The Courtyard's 36 × 24 and walls with no props, until the run ends.

`window.__game`, `window.__title` and `window.__lab` land once loading ends, and a `?lab` scene opens then. `__game.compiles()` lists what compiled since (by kind, and each with its program's label) and `__game.loadReport()` what loading uploaded and drew, step by step, with any pose still compiling when it gave up on it. `?loading=hold` keeps the loader up after loading, for screenshots: `window.__loading.set(share)` moves its bar and `window.__loading.finish()` plays its outro. `?compiles` warns of each compile after loading and `?compiles=strict` turns each into a console error.

## Debug scenes (the lab)

`?lab` in the URL opens the lab's scene list, `?lab=<scene>` a scene, and EXTRAS on the title lists every scene. Every scene runs in a **zone** (its palette, its enemies, its hazard; Z or the zone chips change it). A sandbox scene runs on a sandbox run of that zone through the debug hooks, on the **grid** (the open floor drawn as a measuring grid: 1-unit lines, 5-unit lines labelled with their distance from the centre, and fainter ground past its edge fading into the dark; the zone's hazard is off) or the zone's classic **arena** (G or the floor chips). A room scene starts its own dungeon run in that zone and plays in one of its rooms. A panel docked right holds the scene's controls and readouts (the player's state with its frame of its length, measured speed, frame rate, the gameplay step), time (pause, one fixed step, 1×, 0.5×, 0.25× or 0.1× speed, replay), view toggles (hit shapes, invulnerability, enemy AI, HUD, post-processing) and the camera (the game's play camera, with its subject moved into the middle of the screen the panel and timeline leave; straight down; low from the side; or a free orbit dragged with the mouse), zone and floor. Scenes that time things trace the steps on a timeline under the action. From the special's cut-in until its slow motion ends the panel fades to 15% and lets clicks through. With HUD off, what the game's UI keeps over play hides (HUD, banners, boss bar, map, altar cards, FPS readout); a boss's name card and the zone card stay, as parts of the intro and the zone change.

Hit shapes: the player's body, its weapon's reach (an arc's wedge, the slam's ring, the darts' line), its guard, its marks and darts, and the shape each hit puts live (from `attack` and `burst`, held at least 6 steps); each enemy's body (an elite's larger), its telegraphed strike (line, ring, arc, or a leap's landing spot) and lunge; a boss's every telegraph at once, its moons, the Orrery's hands, and whether it is open or shelled; seams; orbs.

| Scene | URL | Runs on | What it shows |
|---|---|---|---|
| Special | `?lab=special` | sandbox | KUZUSHI against a ring of 1 to 12 of the zone's enemies (one kind or its four mixed, radius 2 to 8), with its boss if asked (it can be broken first, when the special lands twice as hard), on demand or on a loop, with the enemies struck this beat and in all and the kills as each beat lands |
| Player attacks | `?lab=attacks` | sandbox | any weapon in hand: each of its moves alone, its whole chain pressed on its cancel points (three darts on their cadence, the pierce held to a perfect release), dash and parry, against dummies of the zone's kinds in an arc, alone or on a loop, with each move's windup, active and recover frames and its numbers; its effects in the zone's accent |
| Enemy gallery | `?lab=gallery` | sandbox | the zone's four kinds (a splitter's splitling beside it) in a row and its boss facing them, in the zone's colours, each with its name and health on a card kept clear of the panel, as elites if asked; the selected one steps through spawn, idle, telegraph (held for a look; a boss plays each of its patterns in turn), attack, stagger (a boss breaks) and death, and the camera can frame it. A kind that dies stands on its spot again 0.8 s later |
| Enemy attacks | `?lab=threats` | sandbox | one kind, or a boss playing one of its patterns in a phase, attacking the player on a loop from a set distance, the player standing, parrying or dashing on cue, with the telegraph, attack and answer on the timeline; choosing a kind moves the scene to its zone |
| Bosses | `?lab=bosses` | the boss room | the zone's boss in its own room, the real fight: its name card (replayed on demand), each phase on demand with its shift, any pattern played next or on a loop, its balance filled until it breaks, its health set; its state, pattern and the player's answers on the timeline |
| Movement | `?lab=movement` | sandbox | runs and dashes between distance markers (on the grid from its centre line, so the markers and the grid's numbers agree), on a loop or by hand, with live sliders for the movement numbers, ghosts every 0.1 s, measured top speed (dash steps left out), time to it, stopping, dash distance and dash speed, and a copy of the numbers in tuning.ts form |
| Zones | `?lab=zones` | a room | the three palettes side by side (each token with its value; the hero's and danger's WCAG contrast against the three floor values, and danger's against ink), and the zone's start, combat or boss room with its four kinds and its boss standing in it, to judge floor, light, hero and danger on screen against the tokens |
| Rooms and hazards | `?lab=rooms` | a room | any template of the zone mirrored either way, as the generator places it (the first seed that builds it so, in its room with the most doors), empty or with its own waves: door lanes, arrival points, exit lines, spawn points, altars and spring marked; its seals shut or broken; its hazard on its clock (only while sealed) or called now: the beam swept, the next slabs cracked |
| Dungeon | `?lab=dungeon` | a dungeon run | the zone's dungeon for any run seed on the lab's map (each room's kind, index, depth, waves and template; the way from the start to the boss in the zone's accent; the player's room in paper), seeds browsed or picked on a slider, and any room entered through a door's transition or at once, its rooms cleared beforehand so none locks, or fought for real with the map's fog as the player sees it |
| Doors and transitions | `?lab=doors` | a dungeon run | from a start room with a door on every side, a walk out through any door and back as a player would, alone or on a loop, the seals shut or broken; the zone change through the boss room's open gate (zones 1 and 2); every beat traced on the run clock, slowed or stepped, and paused as each beat begins if asked |

| Key | Lab |
|---|---|
| 1 to 9, 0 | the scene's controls, in panel order (on the scene list: open that scene) |
| F (or P) | pause or play |
| . | one fixed step |
| [ ] | slower, faster |
| R | replay the scene |
| B, I, N, U, X | hit shapes, invulnerable, enemy AI, HUD, post |
| C, Z, G | next camera, next zone, next floor |
| \` | fold the panel |
| Esc | back to the scene list; from the list, back to the title |

Lab keys sit apart from the game's, so every scene stays playable. While the lab is open it takes Esc, P and Enter for itself, away from the game's pause and confirm. Leaving the lab switches invulnerability and the movement overrides off and puts time back to 1×. For screenshot scripts, `window.__lab` opens a scene (`open`), moves it to a zone or floor (`zone`, `floor`), works any of its controls by label (`control("Fire KUZUSHI")`, `control("Weapon", "darts")`) and says when it is set up (`ready`).

## Later ideas

Out of scope this round: tarot-like run buffs and relics; currency, shops and resource rooms; followers and a base to build; curses as a second attack; weapon levels and variants; a heavy attack per weapon; difficulty settings that scale room counts; secret rooms, keys and bombs; challenge rooms (survive 45 s); a route map between zones; more zones.
