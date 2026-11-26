# KUZUSHI

KUZUSHI, a sakuga-styled top-down action game on the Ritmo ECS (`@typeonce/ritmo`), rendered with PixiJS 3D (`@pixi/3d`) on pixi.js v8.

## Skills

The skills ship inside the packages: run `npm install` before reading one.

- `ritmo` (`node_modules/@typeonce/ritmo/skills/ritmo`): on every change. It routes to the other `ritmo-*` skills beside it and says where Ritmo's docs are.
- `pixijs-3d` (`node_modules/@pixi/3d/skills/pixijs-3d`): before writing any `@pixi/3d` code. Its API is newer than your training data.
- `pixijs` (`node_modules/pixi.js/skills/pixijs`): the pixi.js v8 app around the 3D view (`Application`, `Assets`, text, events, the ticker).
- `math` (`node_modules/math/skills/math`): the `math` package (vectors, `clamp`, noise, seeded random) that code outside the simulation uses.

## Docs

- `docs/DESIGN.md`: what the game does and looks like, with every number. Read the section on a mechanic, room, enemy, look, camera move or lab scene before changing it, and keep it in step with the change.
- `docs/LAYOUT.md`: where each thing lives in `src/`, file by file. Read it to find code; update it when you add, move or remove a file.
- `scripts/README.md`: headless screenshots, frame-time measurement and the ready-made step lists. Read it before you shoot or measure the game.
- `docs/reference/` holds the concept boards.

## Boundaries

- `src/sim/` is the whole game, deterministic and headless, under oxlint's simulation override. Intents go in (`Game/Intents`), moments come out (`Game/Moments`, typed in `moments.ts`), and the host reads the view through `ReadGame` (`view.ts`). Host code imports it through `src/sim/index.ts`.
- `src/render/`'s `RenderSync` makes one `ActorVisual` per actor entity, places it between steps and forwards moments to the host. `src/host/` runs the fixed-step loop, hands every install a `HostContext` (`types.ts`), loads (each install's `warm` steps, under the DOM loader in `index.html`) and serves the debug API on `window.__game` (`debug.ts`).
- `look` (the world and actors), `vfx` (effects driven by moments and the view; it may drive the camera rig), `ui` (the UI, drawn in Pixi on `layers.ui` and animated with GSAP), `camera` (the Klipp rig and its shots) and `title` (the title's 3D scene) each export one `Install`: `(context: HostContext) => Installed | Promise<Installed>`.
- `look`, `vfx` and `ui` import only `src/sim/index.ts`, `src/art`, `src/host/types.ts` and the camera's types. `title` imports the same plus `look` and `vfx`, and draws with look's actor visuals from views it writes itself.
- `lab` (the debug scenes) drives the game through the debug API alone and reads it through `src/sim/index.ts`. Beyond those it borrows only the UI's DOM menu, panel ticks, DOM helpers, `makeModal` and extras (`registerExtra`, `hidePlayUi`), never `ui/kit` or another folder under ui; and look's ink material and the camera rig.
- `src/gpu/` (the compile watch and the warm-up) is generic pixi code meant for upstreaming: it imports only pixi.js and knows nothing of KUZUSHI. `main.ts` and `src/host/` use it; installs see its types only through `host/types.ts`.

oxlint enforces these directions.

## Checks

`npm run check` runs the type check, `oxlint`, `ritmo-devtools lint src/lint.ts` and the tests. Each test gets 20 s (`vitest.config.ts`): the generator and determinism tests take a second or two alone, several times that on a loaded machine. After a Ritmo upgrade, compare `.oxlintrc.json` with the `@typeonce/oxlint-plugin-ritmo` README: new rules stay off until listed.
