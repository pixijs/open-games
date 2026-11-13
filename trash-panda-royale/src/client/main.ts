import { Application, Assets } from "pixi.js";
import { loadGroundTextures, loadModels } from "./assets.js";
import { loadDecalAtlas } from "./gfx/Decals.js";
import { loadBillboardArt } from "./gfx/Billboard.js";
import { BTN } from "./Controls.js";
import { Game } from "./Game.js";
import { loadIcons } from "./icons.js";
import { installInstanceIndexUploadFix } from "./gfx/instanceIndexUpload.js";
import { MenuStage } from "./MenuStage.js";
import { padColor, padLabel, type PadButton } from "./padGlyphs.js";
import { OutfitPicker } from "./OutfitPicker.js";
import { OutfitThumbs } from "./outfitThumbs.js";
import { sfx } from "./Sfx.js";
import { randomName, randomOutfit, sanitizeOutfit } from "../shared/outfit.js";

const menu = document.getElementById("menu")!;
const stageEl = document.getElementById("stage")!;
const play = document.getElementById("play") as HTMLButtonElement;
/** What PLAY! says (LOADING…, PLAY!, JOINING…, TRY AGAIN). */
const playLabel = play.querySelector(".label")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const status = document.getElementById("status")!;
const loading = document.getElementById("loading")!;
const loadTrack = document.getElementById("load-track")!;
const loadBar = document.getElementById("load-bar")!;
const loadStatus = document.getElementById("load-status")!;

/** The Wavedash host's SDK: injected before any script runs there, absent anywhere else. */
const wavedash = (window as { Wavedash?: { updateLoadProgressZeroToOne(f: number): void; init(config?: object): boolean } }).Wavedash;

/**
 * The loading screen's bar to `f` (0..1), saying `what`. `creep`: over that many seconds, for
 * a step that reports nothing on the way (it keeps moving, so it doesn't look stuck).
 */
function loadingAt(f: number, what?: string, creep = 0) {
  loadBar.style.transitionDuration = creep ? `${creep}s` : "";
  loadBar.style.width = `${Math.round(f * 100)}%`;
  loadTrack.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  if (what !== undefined) loadStatus.textContent = what;
  wavedash?.updateLoadProgressZeroToOne(f);
}

/** The bar fills up, then the loading screen fades off the menu (and is gone). */
function loadingDone() {
  loadingAt(1, "");
  wavedash?.init(); // lifts Wavedash's own loading screen
  setTimeout(() => {
    loading.classList.add("done");
    setTimeout(() => loading.remove(), 600);
  }, 250);
}

/** localStorage, or nothing (private windows, blocked storage). */
const load = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* not kept */ } };

// your name and outfit come back next time; a first visit gets a random outfit (and a name
// to take, or to type over)
nameInput.value = load("ttm:name") ?? "";
nameInput.placeholder = randomName(Math.random);
const stored = load("ttm:look");
let look = sanitizeOutfit(stored ? Number(stored) : NaN, Math.random);
save("ttm:look", String(look));
let stage: MenuStage | null = null;
const picker = new OutfitPicker(document.getElementById("looks")!, look);
picker.onPreview = (l) => stage?.preview(l);
picker.onChange = (l, surprise) => {
  look = l;
  save("ttm:look", String(l));
  stage?.setLook(l, surprise);
};
(document.getElementById("surprise") as HTMLButtonElement).onclick = () => picker.set(randomOutfit(Math.random), true);
(document.getElementById("dice") as HTMLButtonElement).onclick = () => {
  nameInput.value = randomName(Math.random);
  stage?.setLook(look, true);
};

// the wardrobe stays shut until DRESS ME UP! (at the raccoon's feet) opens it; it says
// LOOKIN' GOOD! then, which shuts it again (so does Esc). "credits", by the keys, slides the
// same sheet in with the credits on it instead (BACK or Esc shuts them): one at a time
const dress = document.getElementById("dress") as HTMLButtonElement;
const wardrobe = document.getElementById("side")!;
const credits = document.getElementById("credits")!;
const creditsOpen = document.getElementById("credits-open") as HTMLButtonElement;
const back = document.getElementById("back") as HTMLButtonElement;
let onSheet: "dressing" | "credits" | null = null;
const sheet = (open: typeof onSheet) => {
  if (open === onSheet) return;
  if (onSheet === "dressing") {
    picker.close();
    stage?.dressing(false);
  }
  // (a focused button that's about to hide hands its focus over: Enter on nothing would PLAY)
  const handOff = document.activeElement === creditsOpen || document.activeElement === back;
  onSheet = open;
  menu.classList.toggle("open", open !== null);
  menu.classList.toggle("dressing", open === "dressing");
  menu.classList.toggle("credits", open === "credits");
  dress.setAttribute("aria-expanded", String(open === "dressing"));
  creditsOpen.setAttribute("aria-expanded", String(open === "credits"));
  wardrobe.inert = open !== "dressing";
  credits.inert = open !== "credits";
  if (open === "dressing") stage?.dressing(true);
  if (handOff) (open === "credits" ? back : creditsOpen).focus({ preventScroll: true });
};
dress.onclick = () => sheet(onSheet === "dressing" ? null : "dressing");
creditsOpen.onclick = () => sheet(onSheet === "credits" ? null : "credits");
back.onclick = () => sheet(null);
addEventListener("keydown", (e) => {
  // (an Esc that closed a colour palette closes only that)
  if (e.key === "Escape" && !e.defaultPrevented && !menu.classList.contains("hidden")) sheet(null);
});
// its top hat, baked like the wardrobe's pictures, in pink
OutfitThumbs.load().then(
  (t) => t.paint(dress.querySelector("canvas")!, "acc_tophat", 0xff5d8f),
  () => dress.querySelector("canvas")?.remove(),
);

/** A named span in the browser's Performance panel (and `performance.getEntriesByType("measure")`). */
const span = (name: string, start: number) => performance.measure(`ttm ${name}`, { start });

async function boot() {
  const params = new URLSearchParams(location.search);
  let t = performance.now();
  if (params.get("indexfix") !== "0") installInstanceIndexUploadFix();
  // pixi joins relative asset URLs onto the page URL as if it were a folder: on Wavedash the
  // page is /embed, so models would load from /embed/assets/…
  await Assets.init({ basePath: new URL(".", document.baseURI).href });
  loadingAt(0.03, "starting the engine…");
  const app = new Application();
  await app.init({
    resizeTo: window,
    antialias: true,
    preference: (params.get("renderer") as "webgl" | "webgpu") ?? "webgl",
    background: 0x9ad7ff,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    // input is read off the DOM (Controls): pixi's pointer events would only hit-test the stage on every mouse move
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  });
  document.body.prepend(app.canvas);
  // nothing is drawn while the (opaque) menu covers the canvas: the first frame would
  // also compile every shader on the main thread and freeze the page for seconds
  app.stop();
  span("renderer init", t);

  loadingAt(0.06, "loading cute things…");
  t = performance.now();
  let models = 0, icons = 0;
  const report = () => loadingAt(0.06 + 0.72 * (models * 0.85 + icons * 0.15));
  await Promise.all([
    loadModels((f) => { models = f; report(); }),
    loadIcons((f) => { icons = f; report(); }),
    loadGroundTextures(),
    loadDecalAtlas(),
    loadBillboardArt(),
    // the HUD draws its text once, so its faces must be in before the scene is built
    ...["700 20px 'Barlow Semi Condensed'", "600 20px 'Barlow Semi Condensed'", "400 20px 'Bebas Neue'"].map((f) => document.fonts?.load(f).catch(() => {})),
  ]);
  span("load assets", t);

  loadingAt(0.8, "building the town…");
  // (let that paint first, building the town holds the main thread; a hidden tab paints nothing, so not for long)
  await new Promise((r) => { requestAnimationFrame(() => setTimeout(r)); setTimeout(r, 100); });
  t = performance.now();
  const game = new Game(app);
  span("build scene", t);
  (window as any).__game = game; // handy for poking around from the console
  // the menu's hints follow the last thing touched too: keys, or a pad (in its own labels and colours)
  const controls = game.controls;
  const showDevice = () => {
    document.documentElement.classList.toggle("pad", controls.device === "pad");
    for (const el of document.querySelectorAll<HTMLElement>("kbd[data-pad]")) {
      const b = el.dataset.pad as PadButton;
      el.textContent = padLabel(b, controls.padStyle);
      // (on PLAY!'s sun, in its ink)
      el.style.color = el.closest("#play") ? "" : padColor(b, controls.padStyle) ?? "";
    }
  };
  controls.onDeviceChange(showDevice);
  showDevice();
  // compile every shader now, behind the loading screen, not mid-game (`?prewarm=0` skips
  // it, to compare: then the first car, shot, etc. each freeze a frame while one compiles)
  if (params.get("prewarm") !== "0") {
    loadingAt(0.97, "warming up the shaders…", 3);
    const warm = await game.prewarm();
    console.info(`shader warm-up: ${warm.ms.toFixed(0)} ms (${warm.parallel} programs compiled in parallel first)`);
  }
  // `?debug=shaders`: how many programs the warm-up left, and any compiled later (each one is a freeze)
  if (params.get("debug") === "shaders") {
    let programs = game.shaderCount();
    console.info(`shaders: ${programs} programs after warm-up`);
    app.ticker.add(() => {
      const n = game.shaderCount();
      if (n !== programs) console.warn(`shaders: ${n - programs} more program(s) compiled mid-game (now ${n})`);
      programs = n;
    });
  }
  // `?gallery=1`: every character state and face, instead of the game (a lazily loaded dev page)
  if (params.get("gallery") === "1") {
    const { startGallery } = await import("./dev/Gallery.js");
    menu.classList.add("hidden");
    loadingDone();
    app.start();
    startGallery(game, params);
    return;
  }
  // the live preview: your raccoon in the town, behind the see-through menu
  stage = new MenuStage(game, look, stageEl, document.getElementById("nametag"), document.getElementById("spin"), dress);
  (window as any).__menu = stage;
  app.start();
  menu.classList.add("stage");
  dress.disabled = false;
  // the wedge is all sun now
  play.classList.add("ready");
  play.disabled = false;
  playLabel.textContent = "PLAY!";
  loadingDone();

  const start = async () => {
    if (play.disabled) return;
    play.disabled = true;
    play.classList.remove("again");
    playLabel.textContent = "JOINING…";
    status.textContent = "";
    sfx.unlock();
    // an empty box takes the suggested name: the one you see is the one you get
    const name = nameInput.value.trim() || nameInput.placeholder;
    nameInput.value = name;
    save("ttm:name", name);
    // off it hops, and the sky comes back over the town while we join (hiding the camera's cut to your spawn)
    stage?.jump();
    menu.classList.add("joining");
    try {
      await Promise.all([game.connect(name, look), new Promise((r) => setTimeout(r, 450))]);
      stage?.dispose();
      stage = null;
      (window as any).__menu = undefined;
      // let go of the name box (Enter plays from it): the game ignores keys typed into a field
      (document.activeElement as HTMLElement | null)?.blur?.();
      game.start();
      menu.classList.add("hidden");
    } catch (e) {
      console.error(e);
      menu.classList.remove("joining");
      status.textContent = `could not join: ${(e as Error).message ?? e}`;
      play.disabled = false;
      play.classList.add("again");
      playLabel.textContent = "TRY AGAIN";
    }
  };
  play.onclick = start;
  // on a pad: A (or Start) plays, X opens and shuts the wardrobe, View the credits, B shuts
  // either, Y picks a surprise outfit
  controls.onPadButton = (b) => {
    if (menu.classList.contains("hidden") || menu.classList.contains("joining")) return;
    if (b === BTN.A || b === BTN.Menu) void start();
    else if (b === BTN.X) sheet(onSheet === "dressing" ? null : "dressing");
    else if (b === BTN.View) sheet(onSheet === "credits" ? null : "credits");
    else if (b === BTN.B) sheet(null);
    else if (b === BTN.Y) picker.set(randomOutfit(Math.random), true);
  };
  // Enter plays, from the name box or from nowhere in particular (not from a focused button: that presses it)
  addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || menu.classList.contains("hidden")) return;
    const at = document.activeElement;
    if (at === nameInput || at === document.body || at === null) void start();
  });
}

addEventListener("pointerdown", () => sfx.unlock());

boot().catch((e) => {
  console.error(e);
  loading.classList.add("failed");
  loadStatus.textContent = `failed to start: ${e?.message ?? e}`;
  wavedash?.init(); // or Wavedash's loading screen hides the error
});
