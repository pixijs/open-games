import { Container, Sprite, Text, Texture } from 'pixi.js';

import { vignetteSvg } from '../art/motifs';
import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';
import { COLORS, MOTION } from '../art/tokens';
import type {
  Callout,
  HudFrame,
  HudRacer,
  RaceHudApi,
  RaceHudOptions,
  Role,
  StickInput,
  Toast,
  TrackOutline,
  UiSound,
} from '../contract';
import { Callouts } from './Callouts';
import { ControlsCard } from './ControlsCard';
import { CountdownView } from './CountdownView';
import { FinishView } from './FinishView';
import { GlyphFont } from './GlyphFont';
import { calloutArts, calloutSizes, hudArts, startArts } from './hudArt';
import { HudAtlas } from './HudAtlas';
import { HudButton } from './HudButton';
import { HudMotion } from './HudMotion';
import type { HudBox, Insets } from './layout';
import { hudBox, hudSpec, landscapePauseX, mapWidth } from './layout';
import { MiniMap } from './MiniMap';
import { NameTag } from './NameTag';
import { PlaceBadge } from './PlaceBadge';
import { RaceToasts } from './RaceToasts';
import type { HudScene, HudServices } from './scene';
import { SpectatePanel } from './SpectatePanel';
import { SpeedCluster } from './SpeedCluster';
import { INK } from './text';
import { TimingPlate } from './TimingPlate';
import { TimingTower } from './TimingTower';
import { TouchControls } from './TouchControls';

/** ms before GO the How to drive card starts to whip out, so it has gone as the countdown's 3 lands 3 s out */
const CARD_LEAVES = 3000 + MOTION.whip.duration * 1000;
/** Seconds after GO the start art stays loaded */
const START_HOLD = 1.6;
/** Seconds after GO the speed readout slots in, as GO fades */
const SPEED_AFTER_GO = 0.5;
/** Portrait tags stay above this box y, clear of the thumbs */
const TAG_FLOOR = 640;
const PHONE_TAGS = 3;
const SEEN_KEY = 'nightrun.howToDrive';
/** Room a tag's pointer takes under its plate, box px */
const TAG_POINTER = 9;
/** HUD plates a name tag fades behind, at most */
const MAX_PLATES = 9;
/** Seconds after a layout, the grid moment or GO before the HUD's parts have seated and their boxes are measured */
const PLATES_SETTLE = 0.6;
/** Per second: how fast a tag fades out behind a plate and back */
const TAG_FADE_RATE = 12;
/** Box px between two tags side by side, and the most of its width a tag steps sideways before it fades instead */
const TAG_GAP = 4;
const TAG_STEP = 0.6;
/**
 * The HUD's guess at the followed truck's size, for keeping tags off it: screen px per metre at 1 m away per px of
 * screen height (a lens of about 50 degrees), half the truck's width and how far it reaches down from its tag point.
 */
const LENS = 1.07;
const TRUCK_HALF_W = 0.9;
const TRUCK_DROP = 1.1;

/** `m:ss.cc`, for words that change once (callouts), never per frame */
function formatTime(ms: number): string {
  const cs = Math.floor(Math.max(0, ms) / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;

  return `${m}:${s < 10 ? '0' : ''}${s}.${c < 10 ? '0' : ''}${c}`;
}

function firstRaceInTab(): boolean {
  try {
    if (sessionStorage.getItem(SEEN_KEY)) return false;
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    return true;
  }

  return true;
}

/**
 * NIGHT RUN's race HUD: place, timing tower and plate, mini-map, speed and charge, name
 * tags, the countdown, every race callout, compact toasts and the touch controls, laid out for desktop, tablet,
 * phone portrait and phone landscape.
 *
 * The art comes from three atlases ({@link HudAtlas}): the HUD's own, the callouts', and the start's (the countdown and
 * the controls card, freed after GO), so the whole HUD is a handful of textures. Readouts that change every frame draw
 * from two bitmap glyph fonts. `update` writes into sprites it already has and allocates nothing.
 */
export class RaceHud implements RaceHudApi {
  public readonly container = new Container();
  private readonly _textures: SvgTextures;
  private readonly _sound: UiSound;
  private readonly _actions: RaceHudOptions['actions'];
  private readonly _services: HudServices;
  private readonly _motion = new HudMotion();
  private readonly _fx = new Container();
  private readonly _boostGlow = new Sprite();
  private readonly _dangerGlow = new Sprite();
  private readonly _fade = new Sprite(Texture.WHITE);
  private readonly _tagLayer = new Container();
  private readonly _shaker = new Container();
  private readonly _placeGroup = new Container();
  private readonly _towerGroup = new Container();
  private readonly _plateGroup = new Container();
  private readonly _mapGroup = new Container();
  private readonly _speedGroup = new Container();
  private readonly _place: PlaceBadge;
  private readonly _tower: TimingTower;
  private readonly _plate: TimingPlate;
  private readonly _pause: HudButton;
  private readonly _map: MiniMap;
  private readonly _speed: SpeedCluster;
  private readonly _touch: TouchControls;
  private readonly _tags: NameTag[] = [];
  private readonly _countdown: CountdownView;
  private readonly _card: ControlsCard;
  private readonly _callouts: Callouts;
  private readonly _finish: FinishView;
  private readonly _toasts: RaceToasts;
  private readonly _spectate: SpectatePanel;
  private readonly _vignettes: SvgArt[] = [];
  private readonly _names: string[] = ['', '', '', ''];
  /** The HUD plates tags fade behind, in box px, as x, y, w, h; `_plateCount` are live */
  private readonly _plates = new Float32Array(MAX_PLATES * 4);
  private readonly _tagFade = new Float32Array(4);
  /** Tags in the order they're placed, and what orders them */
  private readonly _tagOrder = new Int8Array(4);
  private readonly _tagKey = new Float32Array(4);
  /** Each tag's sideways step off another, eased; and the tops-left (x, y) of the tags placed this frame */
  private readonly _tagShift = new Float32Array(4);
  private readonly _tagRects = new Float32Array(8);
  private _tagCount = 0;
  /** The followed truck as x, y, w, h in box px; w 0 when there's none */
  private readonly _followedRect = new Float32Array(4);
  private _plateCount = 0;
  /** performance.now() time to measure the plates; 0 once measured */
  private _platesAt = 0;
  private readonly _places = new Int8Array(4);
  private readonly _cars = new Int8Array(4);
  private _probe: HTMLDivElement | null = null;
  private _heavy: GlyphFont | null = null;
  private _light: GlyphFont | null = null;
  private _hudAtlas: HudAtlas<string> | null = null;
  private _calloutAtlas: HudAtlas<string> | null = null;
  private _startAtlas: HudAtlas<string> | null = null;
  private _hudKey = '';
  private _calloutKey = '';
  private _startKey = '';
  private _scene: HudScene | null = null;
  private _width = 0;
  private _height = 0;
  private _resolution = 1;
  private _token = 0;
  private _touchMode = false;
  private _shown = false;
  private _spectating = false;
  private _watching = '';
  private _watchShown = '';
  private _wantStart = false;
  private _pendingStep = -1;
  private _cardWanted = false;
  private _seated = false;
  private _goSeen = false;
  private _passPending = false;
  private _racing = false;
  private _finished = false;
  private _shownPlace = 0;
  private _laps = 3;
  /** Laps completed, from the last 'lap' callout */
  private _lapsDone = 0;
  private _raceTime = 0;
  private _prevLapTime = 0;
  private _lastLapTime = 0;
  private _boostGlowLevel = 0;
  private _wasBoosting = false;
  private _dangerTime = 0;
  private _shakeAmp = 0;
  private _shakeLeft = 0;
  private _shakeDuration = 0.2;
  private _shakeTime = 0;
  private _bumpCooldown = 0;
  private _you = -1;
  private _destroyed = false;

  constructor(options: RaceHudOptions) {
    this._textures = options.textures;
    this._sound = options.sound;
    this._actions = options.actions;
    this._services = { motion: this._motion, sound: this._sound };
    this._touchMode = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this._place = new PlaceBadge(this._services);
    this._tower = new TimingTower(this._services);
    this._plate = new TimingPlate(this._services);
    this._pause = new HudButton(this._onPause);
    this._pause.label = 'race menu';
    this._map = new MiniMap(this._textures);
    this._speed = new SpeedCluster(this._services);
    this._touch = new TouchControls(this._services, this._actions);
    this._touch.onTouch = this._onTouch;
    this._countdown = new CountdownView(this._services);
    this._card = new ControlsCard(this._services);
    this._callouts = new Callouts(this._services, this._textures);
    this._finish = new FinishView(this._services, this._textures);
    this._finish.onSlam = this._finishShake;
    this._toasts = new RaceToasts(this._services, this._textures);
    this._spectate = new SpectatePanel(this._services, this._actions);
    for (let i = 0; i < 4; i++) {
      const tag = new NameTag(this._services);

      this._tags.push(tag);
      this._tagLayer.addChild(tag);
    }
    this._fade.tint = INK;
    this._fade.alpha = 0;
    this._fade.visible = false;
    this._boostGlow.alpha = 0;
    this._dangerGlow.alpha = 0;
    this._fx.addChild(this._boostGlow, this._dangerGlow, this._fade);
    this._placeGroup.addChild(this._place);
    this._towerGroup.addChild(this._tower);
    this._plateGroup.addChild(this._plate, this._pause);
    this._mapGroup.addChild(this._map);
    this._speedGroup.addChild(this._speed);
    this._shaker.addChild(
      this._mapGroup,
      this._towerGroup,
      this._placeGroup,
      this._plateGroup,
      this._speedGroup,
      this._callouts,
      this._countdown.gantry,
      this._card,
      this._countdown,
    );
    this.container.addChild(
      this._fx,
      this._tagLayer,
      this._shaker,
      this._touch,
      this._spectate,
      this._finish,
      this._toasts,
    );
    this.container.visible = false;
    this._loadVignette(COLORS.magenta, 1, this._boostGlow);
    this._loadVignette(COLORS.danger, 0.85, this._dangerGlow);
  }

  public get stick(): StickInput {
    return this._touch.stick;
  }

  public get touchMode(): boolean {
    return this._touchMode;
  }

  /** Textures the HUD holds right now: its atlas pages, the glyph pages and the art it loads on its own */
  public get textureCount(): number {
    return (
      (this._hudAtlas?.pageCount ?? 0) +
      (this._calloutAtlas?.pageCount ?? 0) +
      (this._startAtlas?.pageCount ?? 0) +
      (this._heavy ? 1 : 0) +
      (this._light ? 1 : 0)
    );
  }

  public setInputMode(mode: 'touch' | 'keys'): void {
    const touch = mode === 'touch';

    if (touch === this._touchMode) return;
    this._touchMode = touch;
    if (!touch) this._touch.release();
    if (this._scene) this._apply(this._scene.box, true);
  }

  public setVisible(visible: boolean, role: Role, laps: number): void {
    this._laps = laps;
    if (!visible) {
      this._shown = false;
      this.container.visible = false;
      this._seated = false;
      this._racing = false;
      this._clearRace();
      this._dropStart();
      this._release();

      return;
    }
    this._shown = true;
    this._watchShown = '';
    this._goSeen = false;
    this._finished = false;
    this._racing = false;
    this._shownPlace = 0;
    this._clearRace();
    this._spectating = role === 'spectator';
    this._cardWanted = !this._spectating && firstRaceInTab();
    this._wantStart = !this._spectating;
    this._seated = false;
    this._build();
  }

  public setSpectating(on: boolean, watching: string): void {
    if (on === this._spectating && watching === this._watching) return;
    this._spectating = on;
    this._watching = watching;
    if (this._scene) this._apply(this._scene.box, false);
    this._spectate.setShown(on && this._shown);
  }

  public callout(callout: Callout): void {
    if (!this._scene) return;
    const sound = this._sound;

    switch (callout.kind) {
      case 'finalLap':
        this._plate.punchLap(true);
        this._callouts.finalLap();
        break;
      case 'wrongWay':
        this._callouts.wrongWay(callout.on && !this._finished);
        break;
      case 'positionGained':
        this._callouts.positionGained(callout.by, this._passed());
        this._passPending = true;
        break;
      case 'lap': {
        this._lapsDone = callout.lap;
        this._plate.showStar(false);
        this._plate.punchLap(callout.lap + 1 >= this._laps);
        if (callout.split !== null) {
          const completed = this._prevLapTime > 1500 ? this._prevLapTime : this._lastLapTime;

          this._callouts.lapSplit(callout.split, callout.lap, completed > 0 ? formatTime(completed) : '');
        }
        sound.play(callout.split !== null && callout.split > 0 ? 'back' : 'confirm');
        break;
      }
      case 'lapRecord':
        this._callouts.lapRecord(formatTime(callout.time), this._laps > 1 && this._lapsDone === this._laps - 1);
        this._plate.showStar(true);
        break;
      case 'ultraBoost':
        this._boostGlowLevel = 0.5;
        this._callouts.ultraBoost();
        sound.play('ultraBoost');
        break;
      case 'launchBoost':
        this._countdown.launchBoost();
        this._speed.flash();
        this._boostGlowLevel = 0.5;
        sound.play('launch');
        break;
      case 'backOnTrack':
        this._flashFade();
        this._callouts.backOnTrack();
        sound.play('respawn');
        break;
      case 'someoneFinished':
        this._callouts.someoneFinished(callout.name, callout.place, formatTime(this._raceTime), callout.closesAt);
        sound.play('pluck');
        break;
      case 'finished': {
        this._finished = true;
        this._callouts.wrongWay(false);
        this._callouts.yieldToFinish();
        this._motion.whip(this._speedGroup, 0, 60);
        // On a phone the finish's plate takes the map's spot, and in landscape its big place takes the badge's
        if (this._scene.box.kind !== 'desktop') this._motion.whip(this._mapGroup, 80, 0);
        if (this._scene.box.kind === 'landscape') this._motion.whip(this._placeGroup, -80, 0);
        this._finish.play(
          callout.place,
          `${formatTime(callout.time)}${callout.personalBest ? ', a new best' : ''}`,
          this._youCar(),
        );
        break;
      }
    }
  }

  public toast(toast: Toast): void {
    this._toasts.show(toast);
  }

  public countdown(step: 3 | 2 | 1 | 0): void {
    this._pendingStep = step;
    if (!this._startAtlas || !this._scene?.start) return;
    this._showStep(step);
  }

  public setTrack(outline: TrackOutline): void {
    this._map.setTrack(outline);
  }

  public update(frame: HudFrame, dt: number): void {
    const scene = this._scene;

    if (!scene || !this._shown) return;
    const now = performance.now();

    this._raceTime = frame.raceTime;
    if (this._card.visible) this._card.setCamera(frame.camera);
    if (frame.raceTime < 0 && frame.raceTime > -CARD_LEAVES && (this._cardWanted || this._card.visible)) {
      this._cardWanted = false;
      this._card.hide();
    }
    if (frame.lapTime < this._prevLapTime - 500) this._lastLapTime = this._prevLapTime;
    this._prevLapTime = frame.lapTime;
    this._you = -1;
    for (let i = 0; i < 4; i++) {
      const r = frame.racers[i];

      this._names[i] = r?.active ? r.name : '';
      this._places[i] = r?.active ? r.place : 0;
      this._cars[i] = r?.active ? r.car : 0;
      if (r?.active && r.isYou) this._you = i;
    }
    if (!this._racing && frame.raceTime > 0) this._racing = true;
    if (!this._goSeen && frame.raceTime > 300) this._skipStart();
    if (this._passPending) {
      this._passPending = false;
      this._callouts.setPassed(this._passed());
    }
    if (!this._spectating) {
      if (frame.place !== this._shownPlace && frame.place > 0) {
        const animate = this._racing && this._shownPlace > 0;

        if (animate) this._sound.play(frame.place < this._shownPlace ? 'whooshUp' : 'whooshDown');
        this._place.setPlace(frame.place, frame.racerCount, animate);
        this._shownPlace = frame.place;
      }
      this._place.update(dt);
      this._tower.update(frame, this._racing);
      this._plate.update(frame);
      this._plate.setFinal(frame.laps > 1 && frame.lap >= frame.laps);
      if (this._speedGroup.visible) this._speed.update(frame, dt);
      this._touch.setCameraLabel(frame.camera);
    } else {
      const watching = frame.watching || this._watching;

      if (watching !== this._watchShown) {
        const index = this._indexOf(watching);

        if (this._watchShown && index >= 0) this._tags[index].punch();
        if (this._watchShown) this._sound.play('tick');
        this._watchShown = watching;
      }
      this._spectate.watch(watching, this._placeOf(watching), true);
      this._spectate.setLap(frame.lap, frame.laps, this._touchMode);
    }
    this._map.update(frame);
    if (this._platesAt && now >= this._platesAt) this._measurePlates();
    this._updateTags(frame, scene, dt);
    this._impact(frame.impact, dt);
    this._glows(frame.boosting, dt);
    this._callouts.update(dt, now);
    this._finish.update(dt);
    this._shake(dt);
  }

  public layout(width: number, height: number, resolution: number): void {
    this._width = width;
    this._height = height;
    this._resolution = resolution;
    if (this._shown) this._build();
  }

  /** Draws (or redraws) the atlases for the current screen, then lays everything out; the HUD seats once they're up */
  private _build(): void {
    if (!this._width || this._destroyed) return;
    const box = hudBox(this._width, this._height, this._resolution, this._insets());
    const scale = Math.round(Math.max(1, box.scale) * 100) / 100;
    const hudKey = `${box.kind}|${box.kind === 'portrait' ? box.width : 0}|${scale}`;
    const calloutKey = `${box.kind}|${box.kind === 'desktop' ? 0 : box.width}|${scale}`;
    const token = ++this._token;
    const pending: Promise<void>[] = [];
    let hud = this._hudAtlas;
    let callouts = this._calloutAtlas;

    if (hudKey !== this._hudKey || !hud) {
      hud = new HudAtlas(this._textures, hudArts(box), scale);
      pending.push(hud.ready);
    }
    if (calloutKey !== this._calloutKey || !callouts) {
      callouts = new HudAtlas(this._textures, calloutArts(box), scale);
      pending.push(callouts.ready);
    }
    const nextHud = hud;
    const nextCallouts = callouts;
    const finish = (): void => {
      if (token !== this._token || this._destroyed) {
        if (nextHud !== this._hudAtlas) nextHud.destroy();
        if (nextCallouts !== this._calloutAtlas) nextCallouts.destroy();

        return;
      }
      const oldHud = this._hudAtlas;
      const oldCallouts = this._calloutAtlas;

      this._hudAtlas = nextHud;
      this._calloutAtlas = nextCallouts;
      this._hudKey = hudKey;
      this._calloutKey = calloutKey;
      this._apply(box, false);
      // Shown only now: until the new atlases are on every sprite, some still hold the last race's freed textures.
      this.container.visible = this._shown;
      const swap = new Map<Texture, Texture>();

      if (oldHud && oldHud !== nextHud) oldHud.mapTo(nextHud, swap);
      if (oldCallouts && oldCallouts !== nextCallouts) oldCallouts.mapTo(nextCallouts, swap);
      this._rebind(swap);
      if (oldHud && oldHud !== nextHud) oldHud.destroy();
      if (oldCallouts && oldCallouts !== nextCallouts) oldCallouts.destroy();
      this._ensureStart();
      if (this._shown && !this._seated) this._seat();
    };

    if (pending.length) void Promise.all(pending).then(finish);
    else finish();
  }

  /** Frees the race's atlases and glyph pages between races; the next race draws them again */
  private _release(): void {
    this._token++;
    this._hudAtlas?.destroy();
    this._calloutAtlas?.destroy();
    this._hudAtlas = null;
    this._calloutAtlas = null;
    this._hudKey = '';
    this._calloutKey = '';
    this._heavy?.destroy();
    this._light?.destroy();
    this._heavy = null;
    this._light = null;
    this._scene = null;
  }

  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._token++;
    this._motion.destroy();
    this._sound.loop('buzzerLoop', false);
    this._touch.onTouch = null;
    this.container.destroy({ children: true });
    this._hudAtlas?.destroy();
    this._calloutAtlas?.destroy();
    this._startAtlas?.destroy();
    this._hudAtlas = null;
    this._calloutAtlas = null;
    this._startAtlas = null;
    this._heavy?.destroy();
    this._light?.destroy();
    this._heavy = null;
    this._light = null;
    for (const art of this._vignettes) this._textures.release(art);
    this._vignettes.length = 0;
    this._probe?.remove();
    this._probe = null;
    this._scene = null;
  }

  /** Builds the scene from the current atlases and lays every part out */
  private _apply(box: HudBox, positionsOnly: boolean): void {
    const hud = this._hudAtlas;
    const callouts = this._calloutAtlas;

    if (!hud || !callouts) return;
    const density = Math.round(this._resolution * Math.max(1, box.scale) * 4) / 4;
    const oldHeavy = this._heavy;
    const oldLight = this._light;
    const fontsChanged = !oldHeavy || !oldLight || oldHeavy.density !== density;
    const heavy = fontsChanged ? new GlyphFont('900', density) : oldHeavy;
    const light = fontsChanged ? new GlyphFont('700', density) : oldLight;

    this._heavy = heavy;
    this._light = light;
    const scene: HudScene = {
      box,
      spec: hudSpec(box.kind),
      sizes: calloutSizes(box),
      hud,
      callouts,
      start: this._startAtlas,
      heavy,
      light,
      touch: this._touchMode,
    };

    this._scene = scene;
    this.container.scale.set(box.scale);
    if (!positionsOnly) {
      this._place.layout(scene);
      this._tower.layout(scene);
      this._plate.layout(scene);
      this._callouts.layout(scene);
      this._finish.layout(scene);
      for (const tag of this._tags) tag.layout(scene);
      this._countdown.layout(scene, this._plateRight());
      this._card.layout(scene);
      this._spectate.layout(scene);
    }
    this._touch.layout(scene);
    this._placeParts(scene);
    this._toasts.layout(scene, this._plateRight());
    this._boostGlow.width = box.width;
    this._boostGlow.height = box.height;
    this._dangerGlow.width = box.width;
    this._dangerGlow.height = box.height;
    this._fade.width = box.width;
    this._fade.height = box.height;
    this._setTextResolution(this.container, this._resolution * Math.max(1, box.scale));
    if (positionsOnly) this._card.layout(scene);
    this._remeasurePlates();
    if (fontsChanged && oldHeavy && oldLight) {
      const swap = new Map<Texture, Texture>();

      oldHeavy.textures.forEach((glyph, i) => swap.set(glyph, heavy.textures[i]));
      oldLight.textures.forEach((glyph, i) => swap.set(glyph, light.textures[i]));
      this._rebind(swap);
      oldHeavy.destroy();
      oldLight.destroy();
    }
  }

  /**
   * Points every sprite still drawing a texture in `swap` at its replacement. A relayout redraws the atlases; parts
   * that set their textures only when what they show changes (a tag's plate, a callout mid-flight) would otherwise draw
   * a freed one.
   */
  private _rebind(swap: Map<Texture, Texture>): void {
    if (swap.size === 0) return;
    const visit = (node: Container): void => {
      if (node instanceof Sprite) {
        const next = swap.get(node.texture);

        if (next) node.texture = next;
      }
      for (const child of node.children) visit(child);
    };

    visit(this.container);
  }

  /** Puts the map, dial, pause and touch controls where this layout and input mode want them */
  private _placeParts(scene: HudScene): void {
    const { box, spec } = scene;
    const s = box.safe;
    const W = box.width;
    const H = box.height;
    const d = box.kind === 'desktop';
    const p = box.kind === 'portrait';
    const touch = scene.touch;
    const mw = mapWidth(spec.map);
    let mapX: number;
    let mapY: number;

    if (this._spectating) {
      mapX = d ? s.left : W - s.right - mw;
      mapY = d ? H - s.bottom - 206 : p ? s.top + 70 : s.top;
    } else if (d) {
      mapX = touch ? W - s.right - mw : s.left;
      mapY = touch ? s.top + 146 : H - s.bottom - 206;
    } else {
      mapX = W - s.right - mw;
      mapY = p ? s.top + 86 : s.top;
    }
    this._map.layout(scene, mapX, mapY);
    if (spec.dial) {
      // Bottom right, beside the camera button when touch controls show: the chase camera puts your truck at the
      // bottom centre
      const half = spec.dial / 2;
      const cx = touch ? W - s.right - spec.camera - 4 - (d ? 24 : 16) - half : W - s.right - (d ? 96 : half + 4);
      const cy = d ? H - s.bottom - 92 : H - s.bottom - 52;

      this._speed.layout(scene, cx, cy);
    } else this._speed.layout(scene, W / 2 + 27, H - s.bottom - 98);
    const hud = scene.hud;
    let px: number;
    let py: number;

    if (this._spectating) {
      px = d || p ? W - s.right - spec.pause - 10 : landscapePauseX(box, spec);
      py = s.top + 4;
    } else if (d) {
      px = W - s.right - spec.plateW - 66;
      py = s.top + 2;
    } else if (p) {
      px = W / 2 - 24;
      py = s.top + 6;
    } else {
      px = landscapePauseX(box, spec);
      py = s.top + 2;
    }
    this._pause.setArt(hud.art('pause'), hud.texture('pause'), hud.texture('pauseDown'), px, py);
    const racing = this._shown && !this._spectating;

    this._placeGroup.visible = racing;
    this._towerGroup.visible = racing && spec.tower;
    this._plate.visible = !this._spectating;
    this._plateGroup.visible = this._shown;
    this._touch.visible = racing;
    this._touch.setShown(racing && this._touchMode);
    if (this._spectating) this._speedGroup.visible = false;
  }

  /** Measures the HUD's plates again once the parts in motion now have seated */
  private _remeasurePlates(): void {
    this._platesAt = performance.now() + PLATES_SETTLE * 1000;
  }

  /** Notes where the HUD's plates sit on screen, so name tags can fade out behind them */
  private _measurePlates(): void {
    const scene = this._scene;

    this._platesAt = 0;
    this._plateCount = 0;
    if (!scene) return;
    const k = 1 / scene.box.scale;
    const parts: Container[] = [this._place, this._plate, this._pause, this._map];

    if (scene.spec.tower) parts.push(this._tower);
    if (this._speedGroup.visible) parts.push(this._speed);
    if (this._touch.visible && this._touchMode) parts.push(...this._touch.pads);
    let n = 0;

    for (const part of parts) {
      if (!part.visible || !part.parent?.visible || n >= MAX_PLATES) continue;
      const b = part.getBounds();

      if (b.width <= 0 || b.height <= 0) continue;
      this._plates[n * 4] = b.x * k;
      this._plates[n * 4 + 1] = b.y * k;
      this._plates[n * 4 + 2] = b.width * k;
      this._plates[n * 4 + 3] = b.height * k;
      n++;
    }
    this._plateCount = n;
  }

  /** Right edge of the timing plate's face, box px, for the parts that share the landscape top row with it */
  private _plateRight(): number {
    return this._plate.face.x + this._plate.face.w;
  }

  /**
   * Whether a tag's plate, centred on `x` with its bottom at `bottom`, meets a HUD plate, a callout, a toast, the
   * countdown or the controls card. All of those draw over the tags, so a tag beside one would poke out.
   */
  private _tagBlocked(x: number, bottom: number, w: number, h: number): boolean {
    const left = x - w / 2;
    const top = bottom - h;
    const p = this._plates;

    for (let i = 0; i < this._plateCount; i++) {
      const o = i * 4;

      if (left < p[o] + p[o + 2] && left + w > p[o] && top < p[o + 1] + p[o + 3] && bottom > p[o + 1]) return true;
    }

    return (
      this._countdown.blocks(left, top, w, h) ||
      this._callouts.blocks(left, top, w, h) ||
      this._toasts.blocks(left, top, w, h) ||
      this._card.blocks(left, top, w, h)
    );
  }

  /** The grid moment: every part slots in from its nearest edge */
  private _seat(): void {
    const scene = this._scene;

    if (!scene) return;
    const motion = this._motion;
    const groups = [this._placeGroup, this._towerGroup, this._plateGroup, this._mapGroup];
    const d = scene.box.kind === 'desktop';
    const mapLeft = d && !scene.touch && !this._spectating;

    this._placeParts(scene);
    this._plate.reset();
    this._speed.reset();
    this._speedGroup.visible = false;
    this._seated = true;
    if (!this._spectating) {
      motion.slot(groups[0], 0, 0, -80, 0, 0);
      motion.slot(groups[2], 0, 0, 80, 0, 0.08);
      if (scene.spec.tower) motion.slot(groups[1], 0, 0, -80, 0, 0.16);
      motion.slot(groups[3], 0, 0, mapLeft ? -80 : 80, 0, 0.24);
      if (this._touchMode) motion.fadeIn(this._touch, 0.3, 0.3);
      this._countdown.showGrid();
      if (this._cardWanted && scene.start && this._pendingStep < 0) this._card.show();
    } else {
      motion.slot(groups[3], 0, 0, 80, 0, 0);
      motion.slot(groups[2], 0, 0, 80, 0, 0);
      this._spectate.setShown(true);
    }
    this._sound.play('whooshUp');
    this._remeasurePlates();
  }

  private _showStep(step: 3 | 2 | 1 | 0): void {
    if (step === 0) this._goSeen = true;
    this._cardWanted = false;
    this._card.cut();
    this._countdown.show(step);
    this._shakeOnce(4, 0.2);
    this._sound.play(step === 0 ? 'highBeep' : 'lowBeep');
    if (step !== 0) return;
    this._pendingStep = -1;
    this._motion.delay(SPEED_AFTER_GO, this._showSpeed);
    this._motion.delay(START_HOLD, this._dropStart);
  }

  /** Seated in a race already running (a rejoin): no lights, no card, the speed readout at once */
  private _skipStart(): void {
    this._goSeen = true;
    this._card.visible = false;
    this._dropStart();
    this._showSpeed();
  }

  private readonly _showSpeed = (): void => {
    if (!this._shown || this._spectating || this._finished) return;
    this._motion.slot(this._speedGroup, 0, 0, 0, 50);
    this._remeasurePlates();
  };

  private readonly _finishShake = (): void => {
    this._shakeOnce(6, 0.28);
  };

  /** Loads the start art for this layout if the race is starting */
  private _ensureStart(): void {
    const scene = this._scene;

    if (!scene || !this._wantStart) return;
    const box = scene.box;
    const scale = Math.round(Math.max(1, box.scale) * 100) / 100;
    const key = `${box.kind}|${box.width}|${scale}`;

    if (key === this._startKey && this._startAtlas) return;
    const atlas = new HudAtlas(this._textures, startArts(box), scale);

    this._startKey = key;
    void atlas.ready.then(() => {
      if (this._destroyed || !this._wantStart || this._startKey !== key) {
        atlas.destroy();

        return;
      }
      const old = this._startAtlas;

      this._startAtlas = atlas;
      if (this._scene) {
        const scene = { ...this._scene, start: atlas };

        this._scene = scene;
        this._countdown.layout(scene, this._plateRight());
        this._card.layout(scene);
        this._setTextResolution(this.container, this._resolution * Math.max(1, scene.box.scale));
      }
      if (old) {
        const swap = new Map<Texture, Texture>();

        old.mapTo(atlas, swap);
        this._rebind(swap);
        old.destroy();
      }
      if (this._seated && !this._spectating && this._pendingStep < 0) {
        this._countdown.showGrid();
        if (this._cardWanted) this._card.show();
      }
      if (this._pendingStep >= 0) this._showStep(this._pendingStep as 3 | 2 | 1 | 0);
    });
  }

  private readonly _dropStart = (): void => {
    this._wantStart = false;
    this._startKey = '';
    this._countdown.unbind();
    this._card.unbind();
    const atlas = this._startAtlas;

    this._startAtlas = null;
    if (atlas && this._scene) this._scene = { ...this._scene, start: null };
    atlas?.destroy();
  };

  private _clearRace(): void {
    this._motion.kill(this._showSpeed, this._dropStart);
    this._callouts.clear();
    this._finish.clear();
    this._toasts.clear();
    this._countdown.clear();
    this._card.visible = false;
    this._pendingStep = -1;
    this._boostGlowLevel = 0;
    this._boostGlow.alpha = 0;
    this._dangerGlow.alpha = 0;
    this._fade.visible = false;
    this._shakeLeft = 0;
    this._shaker.position.set(0, 0);
    this._lastLapTime = 0;
    this._prevLapTime = 0;
    this._lapsDone = 0;
    for (const tag of this._tags) tag.free();
  }

  /**
   * Tags follow their trucks inside the safe area, and fade out while they'd sit on a HUD plate (place, tower, timing
   * plate, map, speed), a callout, a toast, the countdown or the truck the cameras follow, so they never slide under one
   * or hide it. They're placed nearest truck first (the watched one before all), and a tag that would land on one
   * already placed steps sideways clear of it, or fades out when that's too far. Once you finish they all fade: the
   * finish's plate, place and time take the screen.
   */
  private _updateTags(frame: HudFrame, scene: HudScene, dt: number): void {
    const { box, spec } = scene;
    const phone = box.kind !== 'desktop';
    const k = 1 / box.scale;
    const s = box.safe;
    const w = spec.tagW;
    const h = spec.tagH + TAG_POINTER;
    const ease = Math.min(1, dt * TAG_FADE_RATE);
    const watched = this._spectating ? this._indexOf(frame.watching || this._watching) : -1;
    const followed = watched >= 0 ? watched : this._you;
    const order = this._tagOrder;
    let shown = 0;

    this._sortTags(frame, watched);
    this._markFollowed(followed >= 0 ? frame.racers[followed] : undefined, box.height, k);
    this._tagCount = 0;
    for (let n = 0; n < 4; n++) {
      const i = order[n];
      const r = frame.racers[i];
      const tag = this._tags[i];

      if (!r || !r.active || r.isYou || !r.tagVisible || (phone && shown >= PHONE_TAGS)) {
        if (tag.visible || tag.racerId) tag.free();
        this._tagFade[i] = 0;
        continue;
      }
      const near = Math.min(1, Math.max(0, (r.distance - 3) / 3));
      const far = Math.min(1, Math.max(0, (70 - r.distance) / 10));
      const x = Math.min(box.width - s.right - w / 2, Math.max(s.left + w / 2, r.screenX * k));
      let y = Math.min(box.height - s.bottom, Math.max(s.top + h, r.screenY * k));

      if (box.kind === 'portrait') y = Math.min(y, TAG_FLOOR);
      let shift = i === followed || !this._onFollowed(x - w / 2, y - h, w, h) ? this._clearOfTags(x, y, w, h, s) : NaN;

      if (!Number.isNaN(shift) && (this._finished || this._tagBlocked(x + shift, y, w, h))) shift = NaN;
      const target = Number.isNaN(shift) ? 0 : 1;
      const fresh = tag.racerId !== r.id;

      if (target) {
        const o = this._tagCount++ * 2;

        this._tagRects[o] = x + shift - w / 2;
        this._tagRects[o + 1] = y - h;
      } else shift = fresh ? 0 : this._tagShift[i];
      this._tagShift[i] = fresh ? shift : this._tagShift[i] + (shift - this._tagShift[i]) * ease;
      const fade = fresh ? target : this._tagFade[i] + (target - this._tagFade[i]) * ease;

      this._tagFade[i] = fade;
      tag.follow(r, x + this._tagShift[i], y, near * far * fade);
      if (tag.visible) shown++;
    }
  }

  /** Orders the tags: the watched racer's first, then nearest first */
  private _sortTags(frame: HudFrame, watched: number): void {
    const order = this._tagOrder;
    const key = this._tagKey;

    for (let i = 0; i < 4; i++) {
      const r = frame.racers[i];

      order[i] = i;
      key[i] = i === watched ? -1 : r?.active ? r.distance : Infinity;
    }
    for (let i = 1; i < 4; i++) {
      const v = order[i];
      let j = i - 1;

      while (j >= 0 && key[order[j]] > key[v]) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
  }

  /**
   * Notes the box (box px) of the truck the cameras follow: under its tag point, about a truck's size at its distance.
   * No racer, or one off screen, marks nothing.
   */
  private _markFollowed(r: HudRacer | undefined, height: number, k: number): void {
    const f = this._followedRect;

    if (!r || !r.active || !r.tagVisible || r.distance <= 0) {
      f[2] = 0;

      return;
    }
    const metre = (LENS * height) / r.distance;

    f[0] = r.screenX * k - TRUCK_HALF_W * metre;
    f[1] = r.screenY * k;
    f[2] = TRUCK_HALF_W * 2 * metre;
    f[3] = TRUCK_DROP * metre;
  }

  /** Whether a box (box px) meets the followed truck */
  private _onFollowed(left: number, top: number, w: number, h: number): boolean {
    const f = this._followedRect;

    return f[2] > 0 && left < f[0] + f[2] && left + w > f[0] && top < f[1] + f[3] && top + h > f[1];
  }

  /**
   * How far a tag centred on `x`, its bottom at `y`, steps sideways to clear the tags placed so far: 0 when it's clear,
   * NaN when it would have to go more than {@link TAG_STEP} of its width or leave the safe area.
   */
  private _clearOfTags(x: number, y: number, w: number, h: number, safe: Insets): number {
    const rects = this._tagRects;
    const width = this._scene?.box.width ?? 0;
    let left = x - w / 2;
    const top = y - h;

    for (let pass = 0; pass < 2; pass++) {
      let moved = false;

      for (let n = 0; n < this._tagCount; n++) {
        const px = rects[n * 2];
        const py = rects[n * 2 + 1];

        if (left >= px + w || left + w <= px || top >= py + h || top + h <= py) continue;
        left = left + w / 2 >= px + w / 2 ? px + w + TAG_GAP : px - w - TAG_GAP;
        moved = true;
      }
      if (!moved) break;
      if (pass === 1) return NaN;
    }
    const shift = left - (x - w / 2);

    if (Math.abs(shift) > w * TAG_STEP || left < safe.left || left + w > width - safe.right) return NaN;

    return shift;
  }

  private _impact(impact: number, dt: number): void {
    this._bumpCooldown = Math.max(0, this._bumpCooldown - dt);
    if (impact < 0.05) return;
    this._shakeOnce(3 * Math.min(1, impact), 0.15);
    this._speed.dip(impact);
    if (this._bumpCooldown <= 0) {
      this._sound.play('bump', Math.min(1, impact));
      this._bumpCooldown = 0.12;
    }
  }

  private _glows(boosting: boolean, dt: number): void {
    if (boosting && !this._wasBoosting && this._boostGlowLevel <= 0) this._boostGlowLevel = 0.5;
    this._wasBoosting = boosting;
    this._boostGlowLevel = Math.max(0, this._boostGlowLevel - dt * (boosting ? 0.35 : 1.5));
    this._boostGlow.alpha = this._boostGlowLevel;
    this._boostGlow.visible = this._boostGlowLevel > 0.002;
    const wrong = this._callouts.wrongShowing;

    this._dangerTime = wrong ? this._dangerTime + dt : 0;
    const target = wrong ? 0.55 + 0.15 * Math.sin(this._dangerTime * Math.PI * 4) : 0;

    this._dangerGlow.alpha += (target - this._dangerGlow.alpha) * Math.min(1, dt * 10);
    this._dangerGlow.visible = this._dangerGlow.alpha > 0.002;
  }

  private _shakeOnce(amp: number, duration: number): void {
    if (this._motion.reduced) return;
    const current = this._shakeLeft > 0 ? this._shakeAmp * (this._shakeLeft / this._shakeDuration) : 0;

    if (amp < current) return;
    this._shakeAmp = amp;
    this._shakeLeft = duration;
    this._shakeDuration = duration;
  }

  private _shake(dt: number): void {
    if (this._shakeLeft <= 0) return;
    this._shakeLeft = Math.max(0, this._shakeLeft - dt);
    this._shakeTime += dt;
    const a = this._shakeAmp * (this._shakeLeft / this._shakeDuration);

    this._shaker.position.set(Math.sin(this._shakeTime * 83) * a, Math.cos(this._shakeTime * 71) * a * 0.7);
  }

  private _flashFade(): void {
    const motion = this._motion;
    const f = this._fade;

    motion.kill(f);
    f.visible = true;
    f.alpha = 0;
    motion.to(f, { alpha: 0.6, duration: 0.12, ease: 'power1.out' });
    motion.to(f, { alpha: 0, delay: 0.12, duration: 0.25, ease: 'power1.in', onComplete: this._hideFade });
  }

  private readonly _hideFade = (): void => {
    this._fade.visible = false;
  };

  /** Name of whoever is now right behind you, after a pass */
  private _passed(): string {
    if (this._you < 0) return '';
    const mine = this._places[this._you];

    for (let i = 0; i < 4; i++) if (i !== this._you && this._places[i] === mine + 1) return this._names[i];

    return '';
  }

  private _indexOf(name: string): number {
    for (let i = 0; i < 4; i++) if (name && this._names[i] === name) return i;

    return -1;
  }

  private _placeOf(name: string): number {
    const i = this._indexOf(name);

    return i >= 0 ? this._places[i] : 0;
  }

  private _youCar(): number {
    return this._you >= 0 ? this._cars[this._you] : 0;
  }

  private _insets(): Insets {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };

    if (typeof document === 'undefined') return zero;
    if (!this._probe) {
      const probe = document.createElement('div');

      probe.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
      document.body.appendChild(probe);
      this._probe = probe;
    }
    const cs = getComputedStyle(this._probe);

    return {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
  }

  private _setTextResolution(node: Container, resolution: number): void {
    for (const child of node.children) {
      if (child instanceof Text) {
        if (child.resolution !== resolution) child.resolution = resolution;
      } else if (child.children.length) this._setTextResolution(child, resolution);
    }
  }

  private _loadVignette(color: string, strength: number, sprite: Sprite): void {
    const art = vignetteSvg(color, strength);

    this._vignettes.push(art);
    void this._textures.load(art).then((texture) => {
      if (!this._destroyed) sprite.texture = texture;
    });
  }

  private readonly _onPause = (): void => {
    this._sound.play('tick');
    this._actions.pause();
  };

  private readonly _onTouch = (): void => {
    if (!this._touchMode) this.setInputMode('touch');
  };
}
