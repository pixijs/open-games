import type { View3D } from '@pixi/3d';
import type { Application } from 'pixi.js';
import { UPDATE_PRIORITY } from 'pixi.js';

import type { GameAudio } from './Audio';
import { PAD } from './Controls';
import type { CountdownStep, Game } from './Game';
import { HudFeed } from './HudFeed';
import { netSwitches } from './net/hooks';
import { LAP_CHOICES, MAX_RACERS, minProgress, NAME_LENGTH, RECONNECT_SECONDS, seatKey } from './net/messages';
import type { Seat } from './net/schema';
import type * as NetModule from './net/session';
import type { CloseReason, PoseReport, Session } from './net/session';
import { NOT_SET_UP } from './net/signal';
import type { Race, RaceImpact } from './Race';
import type { Route } from './race/route';
import { BASE_ROUTE, CELL, Route as TrackRoute } from './race/route';
import { angleDelta } from './race/truck';
import type { Racer } from './Racer';
import { RemoteTrucks } from './RemoteTrucks';
import type { TrackDef, TrackError } from './track/code';
import { BASE_TRACK, cleanTrackName, decodeTrack, isTrackError, roomTrackCode, UNSHOWN_CHARACTERS } from './track/code';
import type { Rot, TrackDoc } from './track/doc';
import { cellX, cellY, feel, fromTrack, placement, shuffle, template, toBoard } from './track/doc';
import type { LibraryEntry } from './track/library';
import { BASE_ID, entryDoc, entryTrack, Library, trackName } from './track/library';
import type {
  CarColor,
  ClosedReason,
  CreateGameUI,
  GameUI,
  HudFrame,
  JoinError,
  NavInput,
  NewTrack,
  ResultRow,
  Role,
  Screen,
  SeatView,
  TrackCard,
  UiActions,
} from './ui/contract';

/** Where the player is when no session runs. */
type Home = 'title' | 'invite' | 'join' | 'connecting' | 'closed' | 'tracks' | 'editor' | 'trackLink';

/** Closing speed that fills the HUD's impact shake. */
const FULL_IMPACT = 8;
/**
 * A quick race closes once every bot has finished, or this long after the player takes the flag, whichever comes
 * first; a bot still running then gets a time projected from its pace.
 */
const SOLO_RESULTS_AFTER_MS = 8000;
/** A remote truck whose newest pose is this old, mid-race, fades out until its poses come again. */
const STALLED_POSE_MS = 1000;
/** The player's own finish moment plays this long before the results take over. */
const FINISH_MOMENT_MS = 2600;
/** A new place has to hold this long before the HUD calls out a gain. */
const PLACE_SETTLE_MS = 500;
/** A host away from the page this long is reminded to keep it open: the party stops while it's hidden. */
const AWAY_NOTICE_MS = 3000;
const KEEP_OPEN = "Keep NIGHT RUN open: the party stops while you're away.";
const TRACK_TOO_NEW = 'Reload Night Run to join this party.';
/** What a track link or code that isn't a track says. */
const TRACK_ERRORS: Readonly<Record<TrackError, string>> = {
  version: 'This track needs a newer Night Run.',
  characters: 'That track link is broken.',
  length: 'That track link is broken.',
  open: 'That track link is broken.',
  crossing: 'That track link is broken.',
  start: 'The start needs three straight pieces in a row.',
  size: 'That track is too big for the board.',
};
/** The lap trail samples the player's truck this often, in ms. */
const TRAIL_EVERY_MS = 100;
/** A truck this fast lights its trail full cyan, metres a second. */
const TRAIL_FAST = 24;
/** The editor's track queues its bots' line search once it has been ready and unchanged this long, in ms. */
const EDITOR_PREFETCH_MS = 1500;
/** `?autostart` waits this long in the lobby, and after a track change there, so the harness sees it. */
const AUTOSTART_DELAY_MS = 800;
/** Keys that belong to the browser or a screen recorder rather than the game: modifiers, combos and F-keys. */
const SYSTEM_KEY = /^(Shift|Meta|Control|Alt|OS|CapsLock|Tab|F\d)/;
const MENU_KEYS: Readonly<Record<string, NavInput>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Space: 'confirm',
  Escape: 'back',
};
const PAD_NAV: readonly (readonly [number, NavInput])[] = [
  [PAD.up, 'up'],
  [PAD.down, 'down'],
  [PAD.left, 'left'],
  [PAD.right, 'right'],
  [PAD.confirm, 'confirm'],
  [PAD.back, 'back'],
];
const JOIN_ERRORS: readonly JoinError[] = ['notFound', 'full', 'malformed', 'unreachable', 'version'];
const STORE = { name: 'nightrun:name', car: 'nightrun:car' } as const;
/** A first visit's driver name, kept until the player types their own; none is a bot's */
const DEFAULT_NAMES = [
  'Ember',
  'Flux',
  'Ghost',
  'Halo',
  'Juno',
  'Kite',
  'Mako',
  'Onyx',
  'Pike',
  'Rally',
  'Sable',
  'Turbo',
  'Vega',
  'Wisp',
  'Zephyr',
  'Bolt',
  'Cinder',
  'Dash',
  'Echo',
  'Fang',
  'Hex',
  'Jet',
  'Lynx',
  'Raven',
] as const;

const _report: PoseReport = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  steer: 0,
  drift: 0,
  charge: 0,
  boosting: false,
  progress: 0,
};

/** The page's local storage, or null where the browser blocks it. */
function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the setting lasts until the page closes.
  }
}

const asCar = (car: number): CarColor => (car & 3) as CarColor;

/** What the flow drives, and the switches the page was opened with. */
export interface FlowOptions {
  app: Application;
  /**
   * The display's resolution, which the UI rasterises its art and text at. The renderer's own follows the resolution
   * governor; the UI keeps to this, so a step neither redraws its textures nor rebuilds its screens.
   */
  resolution: number;
  view: View3D;
  game: Game;
  audio: GameAudio;
  createUI: CreateGameUI;
  params: URLSearchParams;
}

/**
 * NIGHT RUN's flow between screens, and the bridge between the room and the world.
 *
 * It answers every {@link UiActions} call, runs the session (a quick race, a hosted party or a joined one, all through
 * the same room), turns the room's state into the {@link Screen} the UI shows, its toasts and callouts, and stages the
 * world to match: the attract race behind the title, the trucks on the grid as people join, the countdown to the
 * room's GO, the race, and the podium in the room's order. Every frame it feeds remote trucks from the session's
 * interpolated poses, sends this screen's trucks back, and fills one {@link HudFrame} in place.
 */
export class Flow implements UiActions {
  public readonly ui: GameUI;
  /** The running session, or null on the title and the screens before one. */
  public session: Session | null = null;
  /** The screen the UI shows now. */
  public screen: Screen['id'] = 'title';

  private readonly _app: Application;
  /** The display's resolution, for the UI; see {@link FlowOptions.resolution}. */
  private readonly _resolution: number;
  private readonly _game: Game;
  private readonly _race: Race;
  private readonly _audio: GameAudio;
  private readonly _params: URLSearchParams;
  /** `?debug`: G shows klipp's framing overlay. */
  private readonly _debug: boolean;
  private readonly _hud: HudFeed;
  private readonly _remote: RemoteTrucks;
  private _net: typeof NetModule | null = null;
  private _unbind: (() => void)[] = [];
  private readonly _seatUnbind = new Map<string, () => void>();

  // -- Tracks --
  /** My tracks, the selection and best laps. */
  private readonly _library: Library;
  /** A track the page opened on (`?track=`) that isn't in the library: it's the selection until another is picked. */
  private _transient: TrackDef | null = null;
  /** `?r=`: how the page's own track is turned on every plan. */
  private _transientRot: Rot | null = null;
  /** The library over the lobby, as the host's track picker. */
  private _picking = false;
  /** The editor's track and how its history opens. */
  private _editor: { entry: LibraryEntry; history: 'restore' | 'fresh' } | null = null;
  /** The track My tracks shows first: the one the editor just closed; '' for the selected one. */
  private _tracksFocus = '';
  /** A shared track's link the page landed on. */
  private _link: { def: TrackDef; from: string; rot: Rot | null } | null = null;
  /** The library entry a quick race was started from (the editor's or a card's), for Edit track. */
  private _raceFrom: string | null = null;
  /** The player's last whole lap on the track raced from the editor, for its plan. */
  private _trail: { id: string; data: Float32Array } | null = null;
  private _trailLap: number[] = [];
  /** The lap the samples in `_trailLap` belong to. */
  private _trailLapOf = 0;
  private _trailAt = 0;
  private _trailEvent = 0;
  /** Routes of custom tracks the cards have drawn, by code. */
  private readonly _routes = new Map<string, Route>();
  /** A warning that tracks can't be saved was shown this page. */
  private _warnedFull = false;
  /** The library's codes the line cache was last told to keep, joined. */
  private _pinned = '';
  /** Each track's lap time as last worked out for a screen, whole seconds, so a better line redraws only a change. */
  private readonly _lapsShown = new Map<string, number>();
  private _prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  // -- Settings the player chose --
  private _name: string;
  private _car: CarColor;
  private _sound: boolean;
  private _laps: number;
  private readonly _bots: number;

  // -- Screen state --
  private _home: Home = 'title';
  /** The race menu is open over the race. */
  private _paused = false;
  private _dirty = false;
  /** The race screen last shown, so it isn't shown again unchanged; '' after any other screen. */
  private _raceShown = '';
  /** The game just took its own history entry back: the next popstate is that, not the player's Back. */
  private _unguarding = false;
  /** `performance.now()` the page was hidden at, or 0 while it shows. */
  private _hiddenAt = 0;
  /** Counts the player's moves between sessions; a session that arrives after a newer move is left at once. */
  private _ticket = 0;
  private _code = '';
  private _inviteFrom = '';
  private _joinError: JoinError | null = null;
  private _closedReason: ClosedReason = 'lost';
  private _hostName = '';

  // -- Room state seen so far --
  private _initial = true;
  private _phaseSeen = '';
  private _raceSeen = -1;
  private _resultsSeen = 0;
  private _resultsShown = false;
  /** `performance.now()` the player took the flag this race, or 0. */
  private _finishedAt = 0;
  /** `performance.now()` the results take over once the player's finish moment has played, or 0. */
  private _resultsAt = 0;
  /** `performance.now()` a quick race closes into its results, or 0. */
  private _soloEndAt = 0;
  private _myBestLap = 0;
  /** The place the player last held for {@link PLACE_SETTLE_MS}, and the one they hold now and since when. */
  private _placeHeld = 0;
  private _place = 0;
  private _placeSince = 0;
  private _wrongWay = false;
  /** `performance.now()` this screen entered the lobby, or last changed track there. */
  private _lobbyAt = 0;
  private _autoReadied = false;
  private _autoStarted = false;
  /** Whether the session's clock had synced at the last look; room times shown before it are guesses. */
  private _clockSeen = false;

  // -- Every frame --
  private _impact = 0;
  private _width = 0;
  private _height = 0;

  constructor(options: FlowOptions) {
    this._app = options.app;
    this._resolution = options.resolution;
    this._game = options.game;
    this._race = options.game.race;
    this._audio = options.audio;
    this._params = options.params;

    const params = options.params;
    const laps = Number.parseInt(params.get('laps') ?? '', 10);
    const bots = Number.parseInt(params.get('bots') ?? '', 10);
    const car = Number.parseInt(params.get('car') ?? read(STORE.car) ?? '', 10);

    let name = params.get('name') ?? read(STORE.name);

    if (!name) {
      name = DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
      write(STORE.name, name);
    }

    this._name = name.replace(UNSHOWN_CHARACTERS, '').slice(0, NAME_LENGTH) || DEFAULT_NAMES[0];
    this._car = Number.isInteger(car) ? asCar(car) : 0;
    this._laps = LAP_CHOICES.includes(laps) ? laps : 3;
    this._bots = Number.isInteger(bots) ? Math.max(0, Math.min(MAX_RACERS - 1, bots)) : MAX_RACERS - 1;
    this._debug = params.has('debug');
    this._hud = new HudFeed(options.view, options.game, this._laps);
    this._remote = new RemoteTrucks(options.game.race, options.app.ticker);

    this._library = new Library(localStore());
    this._library.onChange = () => this._libraryChanged();
    this._pinLines();

    // The page's own track (main.ts builds it right after the flow is made): the selection until another is picked.
    const opened = decodeTrack(params.get('track') ?? '', params.get('tn') ?? undefined);
    const r = Number.parseInt(params.get('r') ?? '', 10);

    if (!isTrackError(opened) && !opened.builtIn) {
      this._transient = opened;
      this._transientRot = r >= 0 && r <= 3 ? (r as Rot) : null;
    }

    this.ui = options.createUI(this);
    this._sound = this.ui.soundOn ?? true;
    this._app.stage.addChild(this.ui.container);
    this._audio.setSound(this._sound);
    this.ui.setAudio(this._audio.context, this._audio.uiOutput);
    this._game.onTrackBuilt = (def) =>
      this.ui.setTrack(trackOutline(this._game.course.route, def.builtIn ? undefined : this._rotFor(def)));
    this._game.onLineImproved = (code) => this._lineImproved(code);
    this._game.controls.stick = this.ui.stick;
    this._game.race.autodrive = params.has('autodrive');

    const race = this._race;
    const onImpact = race.onImpact;
    const onBoost = race.onBoost;
    const onLap = race.onLap;
    const onFinish = race.onFinish;
    const onRespawn = race.onRespawn;

    race.onImpact = (impact) => {
      onImpact?.(impact);
      this._onImpact(impact);
      if (impact.racer === race.local && !impact.other) this._trailEvent = 1;
    };
    race.onBoost = (racer) => {
      onBoost?.(racer);
      this._onBoost(racer);
    };
    race.onLap = (racer, lapTime) => {
      onLap?.(racer, lapTime);
      this._onLap(racer, lapTime, false);
    };
    race.onFinish = (racer) => {
      onFinish?.(racer);
      this._onLap(racer, racer.progress.lastLap, true);
    };
    race.onRespawn = (racer) => {
      onRespawn?.(racer);
      if (racer !== race.local) return;

      this.ui.callout({ kind: 'backOnTrack' });
      this._trailEvent = 2;
    };
    this._game.onCountdown = this._onCountdown;
    this._game.onGo = this._onGo;

    this._app.ticker.add(this._before, null, UPDATE_PRIORITY.HIGH);
    this._app.ticker.add(this._after, null, UPDATE_PRIORITY.LOW);
    window.addEventListener('keydown', this._onKey);
    this._app.canvas.addEventListener('pointerdown', this._onPointer, true);
    window.addEventListener('pointerdown', this._onPointer, true);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('popstate', this._onPopState);
  }

  /** Opens on what the page's switches ask for: a quick race, a party, an invite, a code, or the title. */
  public open(): void {
    const params = this._params;
    const join = params.get('join');
    const code = params.get('track');

    this._game.showAttract();

    // A track flag that isn't a track says why, over the title on Night Run.
    if (code !== null) {
      const def = decodeTrack(code);

      if (isTrackError(def)) this.ui.toast({ kind: 'notice', text: TRACK_ERRORS[def] });
    }

    const busy = params.has('solo') || params.has('race') || params.has('host') || !!join;

    if (!busy && params.has('editor')) {
      this._openEditorAtBoot();
    } else if (!busy && code && params.has('from') && this._transient) {
      this._link = { def: this._transient, from: cleanTrackName(params.get('from')), rot: this._transientRot };
      this._home = 'trackLink';
      this._show();
    } else if (params.has('solo') || params.has('race')) {
      this.quickRace();
    } else if (params.has('host')) {
      this.host();
    } else if (join && params.has('from') && !heldSeat(join)) {
      this._code = join.toUpperCase();
      this._inviteFrom = (params.get('from') ?? '').replace(UNSHOWN_CHARACTERS, '').slice(0, NAME_LENGTH);
      this._home = 'invite';
      this._show();
    } else if (join) {
      this.join(join).catch(() => undefined);
    } else {
      this._show();
    }
  }

  /** The HUD frame as last filled, for test harnesses. */
  public get hud(): Readonly<HudFrame> {
    return this._hud.frame;
  }

  // -- UiActions --

  public quickRace(): void {
    this._raceFrom = null;
    void this._begin('solo');
  }

  public host(): void {
    this._raceFrom = null;
    void this._begin('host');
  }

  public async join(code: string): Promise<void> {
    const ticket = ++this._ticket;

    this._code = code.toUpperCase();
    this._joinError = null;
    this._home = 'connecting';
    this._show();

    try {
      const net = await this._loadNet();

      await this._end();

      const session = await net.join(code, { name: this._name, car: this._car });

      if (ticket !== this._ticket) {
        await session.leave();

        return;
      }

      this._attach(session);
    } catch (error) {
      if (ticket !== this._ticket) return;
      if ((error as Error).message === NOT_SET_UP) {
        this.ui.toast({ kind: 'notice', text: NOT_SET_UP });
        this._home = 'title';
        this._show();

        return;
      }

      const message = (error as Error).message as JoinError;
      const reason: JoinError = JOIN_ERRORS.includes(message) ? message : 'unreachable';

      if (reason !== message) console.warn('Joining failed:', error);

      this._joinError = reason;
      this._home = 'join';
      this._show();

      throw new Error(reason);
    }
  }

  public setName(name: string): void {
    const clean = name.replace(UNSHOWN_CHARACTERS, '').trim().slice(0, NAME_LENGTH);

    if (!clean) return;

    this._name = clean;
    write(STORE.name, clean);
    this.session?.setName(clean);
    this._dirty = true;
  }

  public setSound(on: boolean): void {
    this._sound = on;
    this._audio.setSound(on);
  }

  public setCar(car: CarColor): void {
    this._car = asCar(car);
    write(STORE.car, String(this._car));
    this.session?.setCar(this._car);
    this._dirty = true;
  }

  public setReady(ready: boolean): void {
    this.session?.setReady(ready);
  }

  public setLaps(laps: number): void {
    const current = this.session?.state.laps ?? this._laps;
    const choice =
      laps > current ? LAP_CHOICES.find((choice) => choice >= laps) : LAP_CHOICES.findLast((choice) => choice <= laps);

    if (choice === undefined || choice === current) return;

    this._laps = choice;
    this.session?.setLaps(choice);
  }

  public addBot(): void {
    const session = this.session;

    if (!session) return;

    let car = 0;

    for (; car < MAX_RACERS; car++) if (!this._carDriven(car)) break;

    session.addBot(car % MAX_RACERS);
  }

  public removeBot(id: string): void {
    this.session?.removeBot(id);
  }

  public kick(id: string): void {
    this.session?.kick(id);
  }

  public start(force: boolean): void {
    this.session?.start(force);
  }

  /** On a phone, opens the share sheet over the page, so the host never has to leave it; elsewhere, copies the link. */
  public async shareInvite(): Promise<'shared' | 'copied'> {
    const link = this._inviteLink();

    if (!link) throw new Error('No party to invite to.');

    if (this.ui.touchMode && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'NIGHT RUN',
          text: `Race me in NIGHT RUN. Party code ${this._code}`,
          url: link,
        });

        return 'shared';
      } catch {
        // Closed without sharing, or not allowed here: copy the link instead.
      }
    }

    await this.copyInvite();

    return 'copied';
  }

  public async copyInvite(): Promise<void> {
    const link = this._inviteLink();

    if (!link) throw new Error('No party to invite to.');

    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // The async clipboard needs focus and permission; the old copy command often works without.
      const field = document.createElement('textarea');

      field.value = link;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();

      const copied = document.execCommand('copy');

      field.remove();

      if (!copied) throw new Error('The browser would not copy.');
    }
  }

  public picking(open: boolean): void {
    if (this.session?.phase === 'lobby') this._game.showPicker(open);
  }

  public rematch(): void {
    const session = this.session;

    if (!session?.isHost) return;

    session.rematch();

    if (session.mode === 'solo') session.start(true);
  }

  public endRace(): void {
    const session = this.session;

    if (!session?.isHost) return;

    if (this._paused) this.resume();

    session.endRace();
  }

  public pause(): void {
    const session = this.session;
    const phase = session?.phase;

    if (!session || (phase !== 'countdown' && phase !== 'racing') || this._paused) return;

    this._paused = true;
    // Online the race runs on under the menu, so the truck coasts rather than taking the arrow keys that move the focus.
    this._game.inputHeld = true;

    if (session.mode === 'solo') {
      session.pause(true);
      this._game.setPaused(true);
    }

    this._show();
  }

  public resume(): void {
    if (!this._paused) return;

    this._paused = false;
    this._game.inputHeld = false;

    if (this.session?.mode === 'solo') {
      this.session.pause(false);
      this._game.setPaused(false);
    }

    this._show();
  }

  public respawn(): void {
    const local = this._race.local;

    if (this._paused) this.resume();
    if (local && this._game.phase === 'racing' && !local.progress.finished) this._race.respawn(local.id);
  }

  public restart(): void {
    const session = this.session;

    if (session?.mode !== 'solo') return;

    if (this._paused) this.resume();

    session.rematch();
    session.start(true);
  }

  public leave(): void {
    this._ticket++;
    this._home = 'title';
    this._link = null;
    void this._end().then(() => {
      this._showSelected();
      this._show();
    });
  }

  public rejoin(): void {
    if (this._code) this.join(this._code).catch(() => undefined);
  }

  public cycleCamera(): void {
    this._game.rig.cycleMode();
  }

  public spectateNext(): void {
    this._game.cycleSpectate();
  }

  // -- Tracks --

  public openTracks(mode: 'library' | 'pick'): void {
    const session = this.session;

    if (mode === 'pick') {
      if (!session?.isHost || session.phase !== 'lobby') return;

      this._picking = true;
    } else {
      if (session) return;

      this._home = 'tracks';
      this._link = null;
      this._tracksFocus = '';
    }

    this._show();
  }

  public closeTracks(): void {
    if (this._picking) {
      this._picking = false;
      this._show();

      return;
    }

    if (this.session) return;

    // Back to the title, the selected track building behind it as the library goes.
    this._home = 'title';
    this._link = null;
    this._showSelected();
    this._show();
  }

  public selectTrack(id: string): void {
    const def = this._entryDef(id);

    if (!def) return;

    this._library.select(id);
    this._transient = null;
    this._game.lines.prefetch(def);

    const session = this.session;

    if (this._picking && session?.isHost && session.phase === 'lobby') {
      this._picking = false;
      session.setTrack(def.code, def.name);
    }

    this._show();
  }

  public newTrack(start: NewTrack): void {
    if (this.session) return;

    const doc = start === 'shuffle' ? shuffle(Math.floor(Math.random() * 2 ** 31)) : template(start);
    const entry = this._library.create(doc, {
      name: start === 'nightrun' ? 'Night Run remix' : trackName(),
      author: this._name,
      rot: placement(doc).rot,
    });

    if (!this._keep(entry)) return;

    this._editor = { entry, history: 'fresh' };
    this._home = 'editor';
    this._prefetchSoon(entry);
    this._show();
  }

  public editTrack(id: string): void {
    // Night Run is edited as a copy of itself: the original stays as it is, first in the library.
    if (id === BASE_ID) {
      this._ticket++;
      void this._end().then(() => this.newTrack('nightrun'));

      return;
    }

    const entry = this._library.get(id);

    if (!entry) return;

    this._ticket++;
    void this._end().then(() => {
      this._editor = { entry, history: 'restore' };
      this._home = 'editor';
      this._link = null;
      this._prefetchSoon(entry);
      this._show();
    });
  }

  public closeEditor(): void {
    const entry = this._editor?.entry ?? null;
    const def = entry ? entryTrack(entry) : null;

    // The track as the editor left it is kept in the library, so its line is worth keeping between visits too.
    if (def) this._game.lines.prefetch(def);

    // My tracks shows the track just edited, and selects it when it can be raced; a draft leaves Quick race as it was.
    if (entry && def) {
      this._library.select(entry.id);
      this._transient = null;
    }

    this._tracksFocus = entry?.id ?? '';
    this._editor = null;
    this._home = 'tracks';
    this._show();
  }

  public saveTrack(entry: LibraryEntry): void {
    if (this._editor?.entry.id === entry.id) this._editor = { ...this._editor, entry };

    this._keep(entry);
    this._prefetchSoon(entry);
  }

  public deleteTrack(id: string): void {
    this._library.remove(id);
    this._pinLines();
    this._show();
  }

  public duplicateTrack(id: string): void {
    const entry = this._library.get(id);

    if (!entry) return;

    const copy = this._library.create(entryDoc(entry), {
      name: `${entry.name} copy`.slice(0, 24),
      author: this._name,
      rot: entry.rot,
    });

    if (this._keep(copy)) this.ui.toast({ kind: 'notice', text: `Made a copy: ${copy.name}.` });

    this._show();
  }

  public raceTrack(id: string, bots: boolean): void {
    const def = this._entryDef(id);

    if (!def) {
      this.ui.toast({ kind: 'notice', text: 'Close the loop in the editor to race it.' });

      return;
    }

    this._library.select(id);
    this._transient = null;
    this._raceFrom = id;
    this._trailLap = [];
    this._trailLapOf = 0;
    this._picking = false;
    this._link = null;
    // The editor stays up until the race does; the title is where the player comes back to.
    this._home = 'title';
    this._game.setTrack(def);
    void this._begin('solo', bots ? this._bots : 0);
  }

  public async shareTrack(id: string): Promise<'shared' | 'copied'> {
    const entry = this._library.get(id);
    const def = entry ? entryTrack(entry) : null;

    if (!entry || !def) throw new Error('Only a finished track can be shared.');

    const link = trackLink(def, entry.author || this._name, entry.rot);

    if (this.ui.touchMode && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'NIGHT RUN', text: `Race my track ${def.name} in NIGHT RUN`, url: link });

        return 'shared';
      } catch {
        // Closed without sharing, or not allowed here: copy the link instead.
      }
    }

    await copyText(link);

    return 'copied';
  }

  public importTrack(text: string): string | null {
    const parsed = parseTrackText(text);

    if (!parsed) {
      this.ui.toast({ kind: 'notice', text: TRACK_ERRORS.characters });

      return null;
    }

    const def = decodeTrack(parsed.code, parsed.name);

    if (isTrackError(def)) {
      this.ui.toast({ kind: 'notice', text: TRACK_ERRORS[def] });

      return null;
    }

    if (def.builtIn) {
      this.ui.toast({ kind: 'notice', text: "That's Night Run: it's always first in My tracks." });

      return BASE_ID;
    }

    const had = this._library.byCode(def.code);

    if (had) {
      this.ui.toast({ kind: 'notice', text: `You already have this track: ${had.name}.` });

      return had.id;
    }

    const id = this._addShared(def, parsed.from, parsed.rot);

    if (id) this._show();

    return id;
  }

  public saveSharedTrack(): string | null {
    const link = this._link;
    const def = link ? link.def : this._game.course.def;

    if (def.builtIn) return BASE_ID;

    const had = this._library.byCode(def.code);

    if (had) return had.id;

    const id = link ? this._addShared(def, link.from, link.rot) : this._addShared(def, this._hostName, null);

    this._show();

    return id;
  }

  /** About how long a lap of a track takes a pace-1 bot, in seconds, as a card or a landing shows it. */
  private _lapSeconds(code: string): number {
    const def = decodeTrack(code);

    if (isTrackError(def)) return 0;

    // Not through the cards' route cache: the line search reports every track it times.
    return this._game.lines.lapSeconds(def, def.builtIn ? BASE_ROUTE : new TrackRoute(def.cells));
  }

  public editing(open: boolean): void {
    this._game.setEditing(open);

    if (!open && !this.session) this._showSelected();
  }

  public destroy(): void {
    void this._end();
    if (this._prefetchTimer !== null) clearTimeout(this._prefetchTimer);
    this._app.ticker.remove(this._before);
    this._app.ticker.remove(this._after);
    window.removeEventListener('keydown', this._onKey);
    this._app.canvas.removeEventListener('pointerdown', this._onPointer, true);
    window.removeEventListener('pointerdown', this._onPointer, true);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('popstate', this._onPopState);
    this._game.onCountdown = null;
    this._game.onGo = null;
    this._game.onLineImproved = null;
    this._game.controls.stick = null;
    this.ui.destroy();
  }

  // -- Tracks, inside --

  /** The track the title shows and Quick race races: the page's own `?track=`, else the library's selection. */
  private _selectedDef(): TrackDef {
    if (this._transient) return this._transient;

    return this._entryDef(this._selectedId()) ?? BASE_TRACK;
  }

  /** The library's selection as Quick race takes it: a selected track edited back into a draft leaves Night Run. */
  private _selectedId(): string {
    const id = this._library.selected;

    return this._entryDef(id) ? id : BASE_ID;
  }

  /** A library entry's track; Night Run for {@link BASE_ID}; null for a draft or a missing entry. */
  private _entryDef(id: string): TrackDef | null {
    if (id === BASE_ID) return BASE_TRACK;

    const entry = this._library.get(id);

    return entry ? entryTrack(entry) : null;
  }

  /** The selected track behind the title: built when it isn't the one standing there. */
  private _showSelected(): void {
    if (this.session) return;

    const def = this._selectedDef();
    const now = this._game.course.def;

    if (def.code !== now.code || def.name !== now.name) this._game.setTrack(def);
  }

  /**
   * How a track's plans are turned: its library entry's way, a link's `r`, else the first way round that fits the
   * board (Night Run's own is 0, the mini-map's view of it before tracks).
   */
  private _rotFor(def: TrackDef): Rot {
    if (def.builtIn) return 0;

    const entry = this._library.byCode(def.code);

    if (entry) return entry.rot;
    if (this._link?.def.code === def.code && this._link.rot !== null) return this._link.rot;
    if (this._transient?.code === def.code && this._transientRot !== null) return this._transientRot;

    return placement(fromTrack(def)).rot;
  }

  private _route(def: TrackDef): Route {
    if (def.builtIn) return BASE_ROUTE;

    let route = this._routes.get(def.code);

    if (!route) {
      route = new TrackRoute(def.cells);
      this._routes.set(def.code, route);
    }

    return route;
  }

  /** A card for a track, from its library entry when it has one. */
  private _defCard(def: TrackDef, rot: Rot | null = null): TrackCard {
    if (def.builtIn) return this._baseCard();

    const entry = this._library.byCode(def.code);

    if (entry) return this._entryCard(entry);

    return this._readyCard(def, {
      id: '',
      author: '',
      from: this._link?.def.code === def.code ? this._link.from : '',
      rot: rot ?? this._rotFor(def),
    });
  }

  private _baseCard(): TrackCard {
    return this._readyCard(BASE_TRACK, { id: BASE_ID, author: '', from: '', rot: 0 });
  }

  private _entryCard(entry: LibraryEntry): TrackCard {
    const def = entryTrack(entry);

    if (def) return this._readyCard(def, { id: entry.id, author: entry.author, from: entry.from, rot: entry.rot });

    // A draft: its cells as drawn, on the board's own axes.
    const outline = new Float32Array(entry.path.length * 2);

    entry.path.forEach((cell, i) => {
      outline[i * 2] = cellX(cell);
      outline[i * 2 + 1] = cellY(cell);
    });

    return {
      id: entry.id,
      code: null,
      name: entry.name,
      author: entry.author,
      from: entry.from,
      builtIn: false,
      ready: false,
      lengthM: 0,
      lapSeconds: 0,
      feel: 'Flowing',
      feelLevel: 1,
      corners: 0,
      best: 0,
      outline,
      rot: entry.rot,
      selected: false,
    };
  }

  private _readyCard(def: TrackDef, o: { id: string; author: string; from: string; rot: Rot }): TrackCard {
    const route = this._route(def);
    const f = feel(def.turns);
    const selected = this._transient
      ? this._transient.code === def.code && o.id === ''
      : o.id !== '' && o.id === this._selectedId();

    return {
      id: o.id,
      code: def.code,
      name: def.name,
      author: o.author,
      from: o.from,
      builtIn: def.builtIn,
      ready: true,
      lengthM: route.lapLength,
      lapSeconds: this._game.lines.lapSeconds(def, route),
      feel: f.word,
      feelLevel: f.level,
      corners: f.corners,
      best: this._library.best(def.code, this._laps),
      outline: planOutline(route, o.rot),
      rot: o.rot,
      selected,
    };
  }

  private _titleScreen(): Screen {
    const def = this._selectedDef();
    const entry = this._transient ? null : this._library.get(this._selectedId());
    const track = entry ? this._entryCard(entry) : this._defCard(def, this._transientRot);
    const hasTracks = this._library.list().length > 0;

    return { id: 'title', name: this._name, sound: this._sound, track, hasTracks };
  }

  private _tracksScreen(mode: 'library' | 'pick'): Screen {
    const cards = [this._baseCard(), ...this._library.list().map((entry) => this._entryCard(entry))];

    return mode === 'library' && this._tracksFocus
      ? { id: 'tracks', mode, cards, focus: this._tracksFocus }
      : { id: 'tracks', mode, cards };
  }

  /** Whether Edit track can go back to the track just raced. */
  private _editable(): boolean {
    const id = this._raceFrom;

    return !!id && id !== BASE_ID && this.session?.mode === 'solo' && this._library.get(id) !== null;
  }

  /** Saves an entry; says so when the library is full or storage refused it. */
  private _keep(entry: LibraryEntry): boolean {
    const result = this._library.save(entry);

    if (result === 'full') {
      this.ui.toast({ kind: 'notice', text: 'Your library is full: delete a track first.' });

      return false;
    }

    if (result === 'memory' && !this._warnedFull) {
      this._warnedFull = true;
      this.ui.toast({
        kind: 'notice',
        text: this._library.stored
          ? "Couldn't save: this browser's storage is full."
          : 'Storage is blocked: tracks last until the page closes.',
      });
    }

    this._pinLines();

    return true;
  }

  /** A better line can change "about N s a lap" on a card or on a landing: those redraw when it does. */
  private _lineImproved(code: string): void {
    const seconds = Math.round(this._lapSeconds(code));

    if (this._lapsShown.get(code) === seconds) return;

    this._lapsShown.set(code, seconds);

    const session = this.session;

    // The host's lobby card shows the party's track's lap; nothing else shows one during a session.
    if (session) {
      if (session.phase === 'lobby' && this._game.course.def.code === code) this._show();

      return;
    }

    const shown = this._home === 'tracks' || (this._home === 'trackLink' && this._link?.def.code === code);

    if (shown) this._show();
  }

  /** The line cache keeps every library track's line, however long it goes unraced. */
  private _pinLines(): void {
    const codes = this._library.list().flatMap((entry) => (entry.code ? [entry.code] : []));
    const key = codes.join();

    if (key === this._pinned) return;

    this._pinned = key;
    this._game.lines.pin(codes);
  }

  /**
   * The editor's track, once it has stayed ready and unchanged for a moment, queues its bots' line search behind the
   * track built now, in memory only until it's raced or the editor closes on it: every edit makes a new track.
   */
  private _prefetchSoon(entry: LibraryEntry): void {
    if (this._prefetchTimer !== null) clearTimeout(this._prefetchTimer);

    this._prefetchTimer = null;

    const def = entryTrack(entry);

    if (!def || def.builtIn) return;

    this._prefetchTimer = setTimeout(() => {
      this._prefetchTimer = null;
      if (this._editor?.entry.code === def.code) this._game.lines.prefetch(def, { persist: false });
    }, EDITOR_PREFETCH_MS);
  }

  /** A shared track into the library, from whoever shared it, the way their board turned it. */
  private _addShared(def: TrackDef, from: string, rot: Rot | null): string | null {
    const doc = fromTrack(def, rot ?? undefined);
    const entry = this._library.create(doc, {
      name: def.name || trackName(),
      author: from,
      from,
      rot: placement(doc).rot,
    });

    return this._keep(entry) ? entry.id : null;
  }

  /**
   * Opens the editor as the page loads (`?editor`): on `?track=` (its entry in My tracks when there is one, else a copy
   * saved from the link), else the last edited track, else the Oval.
   */
  private _openEditorAtBoot(): void {
    const def = this._transient;

    if (def) {
      const id = this._library.byCode(def.code)?.id ?? this._addShared(def, '', this._transientRot);

      if (id) this.editTrack(id);

      return;
    }

    const last = [...this._library.list()].sort((a, b) => b.updated - a.updated)[0];

    if (last) this.editTrack(last.id);
    else this.newTrack('oval');
  }

  /** Another tab changed the library or the selection: the cards and the title follow, and the backdrop with them. */
  private _libraryChanged(): void {
    this._pinLines();

    if (this.session) return;

    if (this._home === 'title') this._showSelected();
    if (this._home === 'title' || this._home === 'tracks' || this._home === 'trackLink') this._show();
  }

  /**
   * The lap trail: during a quick race from the editor or the library, the player's truck every 100 ms; each lap it
   * finishes becomes the trail its plan shows, mapped onto the board the way the editor lays the track.
   */
  private _sampleTrail(session: Session): void {
    const id = this._raceFrom;
    const local = this._race.local;

    if (!id || id === BASE_ID || session.mode !== 'solo' || !local) return;
    if (session.phase !== 'racing') return;

    const now = performance.now();

    if (local.progress.lap > 0 && this._trailLap.length > 0 && this._trailLapOf !== local.progress.lap) {
      this._closeTrailLap(id);
    }

    this._trailLapOf = local.progress.lap;

    if (now - this._trailAt < TRAIL_EVERY_MS) return;

    this._trailAt = now;

    const pose = local.pose;

    this._trailLap.push(pose.x, pose.z, Math.min(1, Math.abs(pose.speed) / TRAIL_FAST), this._trailEvent);
    this._trailEvent = 0;
  }

  /** A lap's samples onto the board: canonical grid cells, turned and moved as the entry's start line sits. */
  private _closeTrailLap(id: string): void {
    const entry = this._library.get(id);
    const samples = this._trailLap;

    this._trailLap = [];

    if (!entry) return;

    const place = placement(entryDoc(entry) as TrackDoc);
    const out = new Float32Array(samples.length);

    for (let i = 0; i + 3 < samples.length; i += 4) {
      const [bx, by] = toBoard(samples[i] / CELL - 0.5, samples[i + 1] / CELL - 0.5, place);

      out[i] = bx;
      out[i + 1] = by;
      out[i + 2] = samples[i + 2];
      out[i + 3] = samples[i + 3];
    }

    this._trail = { id, data: out };
  }

  // -- Sessions --

  private async _loadNet(): Promise<typeof NetModule> {
    this._net ??= await import('./net/session');

    return this._net;
  }

  /** A quick race (room in this tab, bots, straight to the grid) or a hosted party (room in this tab, lobby). */
  private async _begin(mode: 'solo' | 'host', botCount = this._bots): Promise<void> {
    const ticket = ++this._ticket;

    try {
      const net = await this._loadNet();

      await this._end();

      const track = this._game.course.def;
      const options = { name: this._name, car: this._car, laps: this._laps, track: track.code, trackName: track.name };
      const session = mode === 'solo' ? await net.startSolo(options) : await net.host(options);

      if (ticket !== this._ticket) {
        await session.leave();

        return;
      }

      this._attach(session);

      const bots = mode === 'solo' || this._params.has('bots') ? botCount : 0;

      for (let i = 0; i < bots; i++) session.addBot((this._car + 1 + i) % MAX_RACERS);
      if (mode === 'solo') session.start(true);
    } catch (error) {
      if ((error as Error).message !== NOT_SET_UP) console.error(error);
      this.ui.toast({ kind: 'notice', text: (error as Error).message });
      this._home = 'title';
      this._show();
    }
  }

  /** Takes a session on: the room's state and events start driving the world and the screens. */
  private _attach(session: Session): void {
    const callbacks = session.callbacks;

    this.session = session;
    this._initial = true;
    this._phaseSeen = '';
    this._raceSeen = -1;
    this._resultsSeen = 0;
    this._resultsShown = false;
    this._resultsAt = 0;
    this._paused = false;
    this._clockSeen = session.clockSynced;
    this._code = session.code;
    this._race.clear();
    this._game.slowMotion = session.mode === 'solo';
    // The host drives the bots, so a guest's page has no line to search for.
    this._game.lines.setSearching(session.mode !== 'guest');

    const bind = (unbind: () => void): void => {
      this._unbind.push(unbind);
    };
    const dirty = (): void => {
      this._dirty = true;
    };

    bind(
      callbacks.onAdd('racers', (seat: Seat, id: string) => {
        this._seatUnbind.get(id)?.();

        const unbinds = [
          callbacks.listen(seat, 'name', dirty),
          callbacks.listen(seat, 'car', dirty),
          callbacks.listen(seat, 'ready', dirty),
          callbacks.listen(seat, 'connected', dirty),
          callbacks.listen(seat, 'spectator', dirty),
          callbacks.listen(seat, 'grid', dirty),
        ];

        this._seatUnbind.set(id, () => unbinds.forEach((unbind) => unbind()));

        if (!this._initial && !seat.isBot && id !== session.sessionId) {
          this.ui.toast({ kind: 'joined', name: seat.name, car: asCar(seat.car) });
        }

        this._dirty = true;
      }),
    );
    bind(
      callbacks.onRemove('racers', (seat: Seat, id: string) => {
        this._seatUnbind.get(id)?.();
        this._seatUnbind.delete(id);

        if (!seat.isBot && id !== session.sessionId)
          this.ui.toast({ kind: 'left', name: seat.name, car: asCar(seat.car) });

        this._dirty = true;
      }),
    );

    for (const field of [
      'phase',
      'race',
      'laps',
      'track',
      'trackName',
      'hostId',
      'lobbyAt',
      'endAt',
      'joining',
    ] as const) {
      bind(callbacks.listen(field, dirty));
    }

    bind(callbacks.onAdd('results', dirty));
    bind(
      session.on('fx', ({ id, kind, power, target }) => {
        if (this._game.remoteFx(id, kind, power, target)) this._impact = Math.max(this._impact, power);
      }),
    );
    bind(session.on('notice', ({ text }) => this.ui.toast({ kind: 'notice', text })));
    bind(
      session.onConnection((status) =>
        this.ui.reconnecting(status === 'reconnecting' ? performance.now() + RECONNECT_SECONDS * 1000 : null),
      ),
    );
    bind(session.onClosed((reason) => this._closed(reason)));

    const me = session.me;

    if (session.mode === 'guest' && me && !me.spectator && me.car !== this._car) {
      this.ui.toast({ kind: 'colorReassigned', from: this._car, to: asCar(me.car) });
    }

    this._initial = false;
    this._sync();
  }

  /** Lets go of the session's callbacks, without leaving. */
  private _detach(): void {
    for (const unbind of this._unbind) unbind();
    for (const unbind of this._seatUnbind.values()) unbind();

    this._unbind = [];
    this._seatUnbind.clear();
    this.session = null;
    this._paused = false;
    this._game.lines.setSearching(true);
    this._game.inputHeld = false;
    this._game.setPaused(false);
    this._audio.duck(false);
    this.ui.reconnecting(null);
  }

  /** Leaves the session, if there is one, and puts the attract race back behind the title. */
  private async _end(): Promise<void> {
    const session = this.session;

    if (!session) return;

    this._detach();
    await session.leave();
    this._game.showAttract();
  }

  private _closed(reason: CloseReason): void {
    if (reason === 'left') return;

    this._detach();
    this._closedReason = reason;
    this._home = 'closed';
    this._game.showAttract();
    this._showSelected();
    this._show();
  }

  // -- The room's state into the world and the screens --

  /** Brings the race's trucks in line with the room's seats: who races, how each is driven, colour, name and slot. */
  private _reconcile(): void {
    const session = this.session!;
    const seats = session.state.racers;
    const race = this._race;
    const me = session.sessionId;

    for (let i = race.racers.length - 1; i >= 0; i--) {
      const truck = race.racers[i];
      const seat = seats.get(truck.id);

      if (!seat || seat.spectator || truck.kind !== this._kindOf(truck.id, seat)) race.removeRacer(truck.id);
    }

    for (const [id, seat] of seats) {
      if (seat.spectator) continue;

      let truck = race.getRacer(id);

      if (!truck) {
        truck =
          race.addRacer({ id, kind: this._kindOf(id, seat), color: seat.car, name: seat.name, grid: seat.grid }) ??
          undefined;

        if (truck && !this._initial && this._phaseSeen === 'lobby') this._game.dropIn(truck);
      }

      if (!truck) continue;

      race.setGhost(id, this._absent(session, seat));

      if (truck.color !== seat.car) {
        race.setColor(id, seat.car);

        if (this._phaseSeen === 'lobby') this._game.repainted(truck, id === me);
      }

      truck.name = seat.name;
      race.setGrid(id, seat.grid);
    }
  }

  /**
   * Whether a seat's truck should fade out of everyone else's race: its player dropped and the room holds the seat, or
   * its poses stopped coming mid-race, as a phone's do when it switches apps, so nobody crashes into a parked truck.
   */
  private _absent(session: Session, seat: Seat): boolean {
    if (!seat.isBot && !seat.connected) return true;
    if (session.phase !== 'racing' || !session.clockSynced) return false;

    return session.serverNow() - Math.max(seat.pose.t, session.state.goAt) > STALLED_POSE_MS;
  }

  /** Remote trucks fade out while their poses have stalled, and back in when they come again. */
  private _ghostStalled(session: Session): void {
    const racers = this._race.racers;
    const seats = session.state.racers;

    for (let i = 0; i < racers.length; i++) {
      const truck = racers[i];
      const seat = truck.kind === 'remote' ? seats.get(truck.id) : undefined;

      if (seat) this._race.setGhost(truck.id, this._absent(session, seat));
    }
  }

  private _kindOf(id: string, seat: Seat): 'local' | 'bot' | 'remote' {
    const session = this.session!;

    if (id === session.sessionId) return 'local';

    return seat.isBot && session.isHost ? 'bot' : 'remote';
  }

  /** The room changed: stage the world for its phase, and show the screen that goes with it. */
  private _sync(): void {
    const session = this.session;

    this._dirty = false;

    if (!session) return;

    const state = session.state;
    const phase = session.phase;
    const host = state.racers.get(state.hostId);

    if (host) this._hostName = host.name;

    if (!this._ensureTrack(session)) return;

    this._reconcile();

    const newRace = state.race !== this._raceSeen;

    if (phase !== this._phaseSeen || (newRace && phase !== 'lobby')) {
      const was = this._phaseSeen;

      this._phaseSeen = phase;
      this._raceSeen = state.race;

      if (phase === 'lobby') {
        this._resultsShown = false;
        this._autoReadied = false;
        this._autoStarted = false;
        this._lobbyAt = performance.now();
        this._audio.duck(false);

        this.resume();

        // A quick race passes through the lobby on its way to the grid: line up under the start shot at once, so the
        // camera leaves the attract race the moment its trucks go rather than stalling on a truck that's gone.
        this._game.showLobby(session.mode === 'solo' ? 'start' : 'lobby');
      } else if (phase === 'countdown') {
        this._newRace();
        this._game.startCountdown(this._localTime(state.goAt), state.laps);
        this._audio.duck(true);
        this._watchLeader();
      } else if (phase === 'racing' && (was !== 'countdown' || newRace)) {
        this._newRace();
        this._game.watchRace(state.laps, session.raceTime() / 1000);
        this._resumeLocal();
        this._watchLeader();
      }
    }

    this._results();

    // The player's own finish moment plays out first; the frame loop comes back for the results when it has.
    if (phase === 'results' && !this._resultsShown) {
      const at = this._finishedAt > 0 ? this._finishedAt + FINISH_MOMENT_MS : 0;

      if (performance.now() >= at) {
        // Only racers with a time take a block, and the fireworks fire only when someone really took the flag.
        const order: string[] = [];
        let finished = false;

        for (const result of state.results) {
          if (result.time > 0) order.push(result.id);
          if (result.time > 0 && !result.projected) finished = true;
        }

        this._resultsShown = true;
        this._resultsAt = 0;
        this._paused = false;
        this._game.setPaused(false);
        this._game.inputHeld = false;
        this._game.showResults(order, finished);
      } else {
        this._resultsAt = at;
      }
    }

    this._show();
  }

  /**
   * Builds the room's track when it isn't the one built here, before anything is staged on it. It differs on joining, on
   * the host's pick in the lobby, and for a screen back from a dropped link after the room moved on, whose stale race
   * stops first. A screen that can't build it tells the host and leaves.
   * @returns False when this screen left the party instead.
   */
  private _ensureTrack(session: Session): boolean {
    const state = session.state;
    const code = roomTrackCode(state.track);

    if (code === this._game.course.def.code) return true;

    const def = netSwitches.failNextTrack ? 'version' : decodeTrack(code, state.trackName);

    netSwitches.failNextTrack = false;

    if (isTrackError(def)) {
      session.trackFailed(code);
      this.leave();
      this.ui.toast({ kind: 'notice', text: TRACK_TOO_NEW });

      return false;
    }

    // A lobby this screen already shows, or comes back to from the results or a dropped link; not the first state.
    const picked = this._phaseSeen !== '' && session.phase === 'lobby';

    this._game.setTrack(def, { abortRace: true });

    if (picked) {
      this._lobbyAt = performance.now();

      if (!session.isHost) {
        this.ui.toast({ kind: 'notice', text: `${this._hostName} picked ${def.name || 'a new track'}` });
      }
    }

    return true;
  }

  /** Per-race state back to the start, as a countdown begins or a race already under way is joined. */
  private _newRace(): void {
    const session = this.session!;

    this._hud.reset(session.state.laps);
    this._finishedAt = 0;
    // A quick race's Race again goes from the results straight to the countdown, with no lobby between.
    this._resultsShown = false;
    this._resultsAt = 0;
    this._myBestLap = 0;
    this._placeHeld = 0;
    this._place = 0;
    this._placeSince = 0;
    this._wrongWay = false;
    this._soloEndAt = 0;
    this._resultsSeen = session.state.results.length;
  }

  /** A page that reloaded mid-race puts its truck back where the room last saw it, laps and all. */
  private _resumeLocal(): void {
    const session = this.session!;
    const local = this._race.local;
    const me = session.me;

    if (!local || !me || (me.lap === 0 && me.progress <= 0)) return;

    const pose = me.pose;

    const distance = (me.lap + me.progress) * this._game.course.route.lapLength;

    this._race.resume(local.id, pose.x, pose.y, pose.z, pose.yaw, distance, me.lap);
  }

  /** A spectator watches the leader. */
  private _watchLeader(): void {
    const session = this.session!;

    if (!session.me?.spectator) return;

    let first = '';
    let best = Infinity;

    for (const [id, seat] of session.state.racers) {
      if (!seat.spectator && seat.rank > 0 && seat.rank < best) {
        best = seat.rank;
        first = id;
      }
    }

    this._game.spectate(first || null);
  }

  /**
   * Callouts for racers who took the flag since the last look. The player's own finish is called out even when the
   * same patch closed the race, as it does when they finish last; the others' only while the race is on.
   */
  private _results(): void {
    const session = this.session!;
    const state = session.state;
    const results = state.results;
    const racing = session.phase === 'racing';

    for (; this._resultsSeen < results.length; this._resultsSeen++) {
      const result = results[this._resultsSeen];
      const place = this._resultsSeen + 1;

      if (result.id === session.sessionId) {
        if (!racing && !(this._finishedAt > 0 && result.time > 0 && !result.projected)) continue;

        // Night Run keeps the key it always had; a custom track's bests are kept by its code.
        const personalBest =
          result.time > 0 && this._library.offerBest(this._game.course.def.code, state.laps, result.time);

        this.ui.callout({ kind: 'finished', place, time: result.time, personalBest });
      } else if (racing && !this._finishedAt) {
        this.ui.callout({
          kind: 'someoneFinished',
          name: result.name,
          place,
          closesAt: state.endAt > 0 ? this._localTime(state.endAt) : 0,
        });
      }
    }
  }

  /** Room time as this page's `performance.now()`. */
  private _localTime(roomTime: number): number {
    return performance.now() + (roomTime - this.session!.serverNow());
  }

  private _carDriven(car: number): boolean {
    const session = this.session;

    if (!session) return false;

    for (const seat of session.state.racers.values()) if (!seat.spectator && seat.car === car) return true;

    return false;
  }

  private _inviteLink(): string {
    const session = this.session;

    if (!session || !session.code || !this._net) return '';

    return this._net.inviteLink(session.code, this._hostName);
  }

  private _role(): Role {
    const session = this.session;

    if (!session) return 'solo';
    if (session.mode === 'solo') return 'solo';
    if (session.me?.spectator) return 'spectator';

    return session.isHost ? 'host' : 'guest';
  }

  /** Shows the screen for where the player is now; the race screen only when it changed, as the UI rebuilds it. */
  private _show(): void {
    // A race is a press away from the editor and the library: have the online code in by then.
    if (this._home === 'editor' || this._home === 'tracks' || this._home === 'trackLink') {
      this._loadNet().catch(() => undefined);
    }

    const screen = this._screenNow();
    const race = screen.id === 'race' ? `${screen.role} ${screen.spectating} ${screen.laps}` : '';

    this.screen = screen.id;

    if (race && race === this._raceShown) return;

    this._raceShown = race;
    this.ui.show(screen);
    this._syncBack();
  }

  /**
   * In My tracks and the editor, the browser's (or a phone's) Back steps back inside the game, as Esc does: one history
   * entry stands for being in there, pushed on the way in and taken back on the way out.
   */
  private _syncBack(): void {
    const inside = !this.session && (this._home === 'tracks' || this._home === 'editor');
    const guarded = (history.state as { nightRun?: boolean } | null)?.nightRun === true;

    if (inside && !guarded) history.pushState({ nightRun: true }, '');
    else if (!inside && guarded) {
      this._unguarding = true;
      history.back();
    }
  }

  private readonly _onPopState = (): void => {
    if (this._unguarding) {
      this._unguarding = false;

      return;
    }

    if (!this.session && (this._home === 'tracks' || this._home === 'editor')) this._navigate('back');

    this._syncBack();
  };

  private _screenNow(): Screen {
    const session = this.session;

    if (!session) {
      switch (this._home) {
        case 'invite':
          return { id: 'invite', code: this._code, from: this._inviteFrom, name: this._name };
        case 'join':
          return { id: 'join', code: this._code, error: this._joinError, busy: false };
        case 'connecting':
          return { id: 'connecting', code: this._code };
        case 'closed':
          return { id: 'closed', reason: this._closedReason, hostName: this._hostName };
        case 'tracks':
          return this._tracksScreen('library');
        case 'editor':
          if (this._editor) {
            const { entry, history } = this._editor;
            const trail = this._trail?.id === entry.id ? this._trail.data : null;

            return { id: 'editor', entry, history, trail, laps: this._laps };
          }

          return this._titleScreen();
        case 'trackLink':
          if (this._link) {
            const link = this._link;
            const saved = link.def.builtIn || this._library.byCode(link.def.code) !== null;

            return { id: 'trackLink', card: this._defCard(link.def, link.rot), from: link.from, saved };
          }

          return this._titleScreen();
        default:
          return this._titleScreen();
      }
    }

    const state = session.state;
    const role = this._role();

    if (this._paused) {
      return { id: 'pause', role, sound: this._sound, editable: this._editable(), trackId: this._raceFrom ?? '' };
    }

    if (this._picking && session.phase === 'lobby' && session.isHost) return this._tracksScreen('pick');

    const phase = session.phase;

    if (phase === 'results' && this._resultsShown) return this._resultsScreen(role);
    if (phase !== 'lobby' || session.mode === 'solo') {
      return { id: 'race', role, spectating: !!session.me?.spectator, laps: state.laps };
    }

    return this._lobbyScreen(role === 'solo' ? 'host' : role);
  }

  private _lobbyScreen(role: Exclude<Role, 'solo'>): Screen {
    const session = this.session!;
    const state = session.state;
    const seats: SeatView[] = [];
    const waitingFor: string[] = [];
    let spectators = 0;

    for (let grid = 0; grid < MAX_RACERS; grid++) {
      seats.push({
        id: '',
        kind: 'open',
        name: '',
        car: asCar(grid),
        ready: false,
        isHost: false,
        isYou: false,
        connected: true,
      });
    }

    for (const [id, seat] of state.racers) {
      if (seat.spectator) {
        spectators++;
        continue;
      }

      const view = seats[seat.grid & 3];

      view.id = id;
      view.kind = seat.isBot ? 'bot' : 'player';
      view.name = seat.name;
      view.car = asCar(seat.car);
      view.ready = seat.isBot || seat.ready;
      view.isHost = id === state.hostId;
      view.isYou = id === session.sessionId;
      view.connected = seat.isBot || seat.connected;

      if (!seat.isBot && !seat.ready && id !== state.hostId) waitingFor.push(seat.name);
    }

    // A guest whose link is up but who hasn't sat down yet shows on the next open seat, its shutter half up.
    let joining = state.joining;

    for (const view of seats) {
      if (joining === 0) break;
      if (view.kind !== 'open') continue;
      view.kind = 'joining';
      joining--;
    }

    const def = this._game.course.def;

    return {
      id: 'lobby',
      role,
      code: session.code,
      link: this._inviteLink(),
      hostName: this._hostName,
      laps: state.laps,
      seats,
      waitingFor,
      spectators,
      track: this._defCard(def),
      canChangeTrack: role === 'host',
      trackSaved: def.builtIn || this._library.byCode(def.code) !== null,
    };
  }

  private _resultsScreen(role: Role): Screen {
    const session = this.session!;
    const state = session.state;
    const rows: ResultRow[] = [];
    const winner = state.results.length > 0 ? state.results[0].time : 0;

    for (let i = 0; i < state.results.length; i++) {
      const result = state.results[i];

      rows.push({
        id: result.id,
        place: i + 1,
        name: result.name,
        car: asCar(result.car),
        isBot: result.isBot,
        isYou: result.id === session.sessionId,
        time: result.time,
        gap: i > 0 && result.time > 0 ? result.time - winner : 0,
        bestLap: result.bestLap,
        projected: result.projected,
      });
    }

    const def = this._game.course.def;

    return {
      id: 'results',
      role,
      rows,
      hostName: this._hostName,
      lobbyAt: state.lobbyAt > 0 && session.clockSynced ? this._localTime(state.lobbyAt) : 0,
      editable: this._editable(),
      trackId: this._raceFrom ?? '',
      canSaveTrack: (role === 'guest' || role === 'spectator') && !def.builtIn && !this._library.byCode(def.code),
    };
  }

  // -- Race moments into the room and the HUD --

  private readonly _onCountdown = (step: CountdownStep): void => {
    this.ui.countdown(step);

    if (step === 0) this._audio.duck(false);
  };

  private readonly _onGo = (launched: boolean): void => {
    if (launched) this.ui.callout({ kind: 'launchBoost' });
  };

  /** A lap, or the last one: reported to the room, and the player's own told on the HUD. */
  private _onLap(racer: Racer, lapTime: number, finished: boolean): void {
    const session = this.session;

    if (!session || racer.kind === 'remote') return;

    const lap = racer.progress.lap;
    // A quick race has every truck on this page's clock, which a long frame doesn't run ahead of as the wall's does:
    // its results then agree with the laps the race timed. A party's screens share only the room's clock.
    const at =
      session.mode === 'solo' ? session.state.goAt + Math.round(racer.progress.lapStart * 1000) : session.serverNow();

    if (racer.kind === 'bot') {
      if (session.isHost) session.reportBotLap(racer.id, lap, at);

      return;
    }

    session.reportLap(lap, at);

    if (finished) {
      this._finishedAt = performance.now();
      this._wrong(false);

      if (session.mode === 'solo') this._soloEndAt = this._finishedAt + SOLO_RESULTS_AFTER_MS;

      return;
    }

    const ms = Math.round(lapTime * 1000);
    const split = this._myBestLap > 0 ? ms - this._myBestLap : null;
    let fastest = this._myBestLap > 0 ? this._myBestLap : Infinity;

    for (const [id, seat] of session.state.racers) {
      if (id !== session.sessionId && seat.bestLap > 0) fastest = Math.min(fastest, seat.bestLap);
    }

    this.ui.callout({ kind: 'lap', lap, split });

    if (fastest !== Infinity && ms < fastest) this.ui.callout({ kind: 'lapRecord', time: ms });
    if (lap === session.state.laps - 1) this.ui.callout({ kind: 'finalLap' });

    this._myBestLap = this._myBestLap > 0 ? Math.min(this._myBestLap, ms) : ms;
  }

  private _onBoost(racer: Racer): void {
    const session = this.session;

    if (!session) return;

    if (racer === this._race.local) {
      session.fx('boost', 1);
      this.ui.callout({ kind: 'ultraBoost' });
    } else if (racer.kind === 'bot' && session.isHost) {
      session.botFx(racer.id, 'boost', 1);
    }
  }

  private _onImpact(impact: Readonly<RaceImpact>): void {
    const session = this.session;
    const racer = impact.racer;
    const other = impact.other;
    const power = Math.min(1, impact.strength / FULL_IMPACT);
    const subject = this._game.subject;

    if (racer === subject || other === subject) this._impact = Math.max(this._impact, power);

    if (!session || !racer) return;

    if (other) {
      this._bump(session, racer, other, power);

      return;
    }

    if (racer === this._race.local) session.fx('wall', power);
    else if (racer.kind === 'bot' && session.isHost) session.botFx(racer.id, 'wall', power);
  }

  /**
   * A truck driven here hit one driven on another screen, whose stand-in can't give: tell that screen, so its player
   * feels the hit too.
   */
  private _bump(session: Session, a: Racer, b: Racer, power: number): void {
    const mine = a.kind === 'remote' ? b : a;
    const theirs = mine === a ? b : a;

    if (mine.kind === 'remote' || theirs.kind !== 'remote') return;

    if (mine === this._race.local) session.fx('bump', power, theirs.id);
    else if (mine.kind === 'bot' && session.isHost) session.botFx(mine.id, 'bump', power, theirs.id);
  }

  private _wrong(on: boolean): void {
    if (on === this._wrongWay) return;

    this._wrongWay = on;
    this.ui.callout({ kind: 'wrongWay', on });
  }

  // -- Frame --

  /** Before the game's frame: the room's changes, then every remote truck where the session says it was. */
  private readonly _before = (): void => {
    if (this._resultsAt > 0 && performance.now() >= this._resultsAt) {
      this._resultsAt = 0;
      this._dirty = true;
    }

    if (this._dirty) this._sync();

    const session = this.session;

    if (!session) return;

    // A screen that just joined shows the results' countdown once it knows the room's clock.
    if (session.clockSynced !== this._clockSeen) {
      this._clockSeen = session.clockSynced;
      this._dirty = true;
    }

    const phase = session.phase;
    const game = this._game;

    if (phase === 'countdown' && game.phase === 'countdown') game.goAt = this._localTime(session.state.goAt);
    if (phase === 'countdown' || phase === 'racing') this._remote.update(session, this._raceSeen);
    if (phase === 'racing') this._ghostStalled(session);
  };

  /** After the game's frame: this screen's trucks to the room, the HUD, input for the UI, harness switches. */
  private readonly _after = (): void => {
    const app = this._app;
    // The window's size, which the app fills. `app.screen` is the drawing buffer's size over its resolution, so it
    // moves by a fraction of a pixel whenever the governor steps, and the UI would lay itself out again each time.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dt = Math.min(app.ticker.deltaMS / 1000, 1 / 20);

    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      this.ui.layout(width, height, this._resolution);
    }

    this._pad();
    this._audio.music.setPaused(this._paused);

    const session = this.session;

    if (session) {
      this._sendPoses(session);
      this._watchRace(session);
      this._harness(session);
      this._sampleTrail(session);
    }

    if (this._race.racers.length > 0) {
      this._hud.fill(session, this._impact, width, height);
      this.ui.updateHud(this._hud.frame, dt);
    }

    this._impact = 0;
  };

  private _sendPoses(session: Session): void {
    const phase = session.phase;

    if ((phase !== 'countdown' && phase !== 'racing') || this._game.paused) return;

    const race = this._race;
    const local = race.local;
    const lap = this._game.course.route.lapLength;

    if (local) session.sendPose(report(local, lap));

    if (!session.isHost) return;

    for (let i = 0; i < race.racers.length; i++) {
      const truck = race.racers[i];

      if (truck.kind === 'bot') session.sendBotPose(truck.id, report(truck, lap));
    }
  }

  /** The player's place and heading through the race, and a quick race's close. */
  private _watchRace(session: Session): void {
    const local = this._race.local;
    const me = session.me;

    if (session.phase !== 'racing' || !local || !me) return;

    const finished = local.progress.finished;

    this._wrong(!finished && local.progress.wrongWay);
    this._watchPlace(me.rank, finished);

    if (this._soloEndAt > 0 && performance.now() >= this._soloEndAt) {
      this._soloEndAt = 0;
      session.endRace();
    }
  }

  /** Calls out a place gained once the new place has held for {@link PLACE_SETTLE_MS}, against the last one that held. */
  private _watchPlace(rank: number, finished: boolean): void {
    const now = performance.now();

    if (rank !== this._place) {
      this._place = rank;
      this._placeSince = now;
    }

    if (rank === 0 || rank === this._placeHeld || now - this._placeSince < PLACE_SETTLE_MS) return;

    if (this._placeHeld > 0 && rank < this._placeHeld && !finished) {
      this.ui.callout({ kind: 'positionGained', by: this._placeHeld - rank });
    }

    this._placeHeld = rank;
  }

  /** `?autoready` and `?autostart=N`, so a harness can run a party without pressing anything. */
  private _harness(session: Session): void {
    if (session.phase !== 'lobby') return;

    const me = session.me;

    if (this._params.has('autoready') && !this._autoReadied && me && !me.spectator && !session.isHost) {
      this._autoReadied = true;
      session.setReady(true);
    }

    const want = Number.parseInt(this._params.get('autostart') ?? '', 10);

    if (!session.isHost || !(want > 0) || this._autoStarted) return;
    if (performance.now() - this._lobbyAt < AUTOSTART_DELAY_MS) return;

    let seated = 0;
    let ready = true;

    for (const [id, seat] of session.state.racers) {
      if (seat.spectator) continue;

      seated++;

      if (!seat.isBot && !seat.ready && id !== session.state.hostId) ready = false;
    }

    if (seated >= want && ready) {
      this._autoStarted = true;
      session.start(false);
    }
  }

  // -- Input --

  private _inRace(): boolean {
    return !this._paused && this.screen === 'race';
  }

  /** Keys the UI already used (typing a party code or a name) never reach the game's own. */
  private readonly _onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || SYSTEM_KEY.test(e.code)) return;

    this._audio.unlock();
    this.ui.setInputMode('keys');

    const target = e.target as HTMLElement | null;

    if (e.defaultPrevented) return;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if (this._debug && e.code === 'KeyG' && !e.repeat) {
      this._game.rig.toggleDebug(document.body);

      return;
    }

    if (this._inRace()) {
      if (e.repeat) return;

      if (e.code === 'Escape') this.pause();
      else if (e.code === 'KeyC') this.cycleCamera();
      else if (e.code === 'KeyR') this.respawn();
      else if (e.code === 'KeyV') this.spectateNext();

      return;
    }

    const nav = MENU_KEYS[e.code];

    if (nav) this._navigate(nav);
  };

  private _navigate(nav: NavInput): void {
    if (this.ui.navigate(nav) || nav !== 'back') return;

    if (this._paused) this.resume();
    else if (!this.session && this._home !== 'title') this.leave();
  }

  private readonly _onPointer = (e: PointerEvent): void => {
    this._audio.unlock();

    if (e.pointerType === 'touch') this.ui.setInputMode('touch');
  };

  /** A host back from another app or tab is told to keep the page open: the room stops while it's hidden. */
  private readonly _onVisibility = (): void => {
    if (document.hidden) {
      this._hiddenAt = performance.now();

      return;
    }

    const away = this._hiddenAt > 0 ? performance.now() - this._hiddenAt : 0;

    this._hiddenAt = 0;

    if (this.session?.mode === 'host' && away > AWAY_NOTICE_MS) this.ui.toast({ kind: 'notice', text: KEEP_OPEN });
  };

  /** Gamepad buttons: race buttons while racing, the editor's own reading in the editor, menu navigation elsewhere. */
  private _pad(): void {
    const controls = this._game.controls;

    // The world's frame (which reads the pad) is paused under the editor.
    if (this._home === 'editor' && !this.session) controls.poll();

    const pressed = controls.pressed;

    if (controls.padUsed) {
      this._audio.unlock();
      this.ui.setInputMode('keys');
    }

    const editing = this._home === 'editor' && !this.session;

    // The editor hears every frame, releases too, so a held d-pad's repeat starts afresh on each press.
    if (pressed === 0 && !editing) return;

    if (this._inRace()) {
      if (pressed & PAD.camera) this.cycleCamera();
      if (pressed & PAD.respawn) this.respawn();
      if (pressed & PAD.pause) this.pause();
      if (pressed & PAD.right && this.session?.me?.spectator) this.spectateNext();

      return;
    }

    if (pressed & PAD.pause && this._paused) {
      this.resume();

      return;
    }

    if (editing && this.ui.pad?.(controls.held, pressed)) return;

    for (const [bit, nav] of PAD_NAV) if (pressed & bit) this._navigate(nav);
  }
}

/** Whether this tab holds a seat in party `code` from before a reload, so it goes straight back in. */
function heldSeat(code: string): boolean {
  try {
    return !!sessionStorage.getItem(seatKey(code.toUpperCase()));
  } catch {
    return false;
  }
}

/**
 * A truck's pose as the room takes it, with how far round its lap of length `lap` it is (a little below 0 on the
 * grid); reverse is a negative speed.
 */
function report(truck: Racer, lap: number): PoseReport {
  const pose = truck.pose;
  const progress = truck.progress;
  const reversing = Math.abs(angleDelta(pose.yaw, pose.heading)) > Math.PI / 2 && pose.speed > 0.3;
  const round = (progress.distance - progress.lap * lap) / lap;

  _report.x = pose.x;
  _report.y = pose.y;
  _report.z = pose.z;
  _report.yaw = pose.yaw;
  _report.pitch = pose.pitch;
  _report.roll = pose.roll;
  _report.speed = reversing ? -pose.speed : pose.speed;
  _report.steer = pose.steer;
  _report.drift = pose.drift;
  _report.charge = pose.charge;
  _report.boosting = pose.boosting;
  _report.progress = Math.max(minProgress(lap), Math.min(1, round));

  return _report;
}

/**
 * A track's centreline for the mini-map, a point a metre, from the finish line round, with how its author's board
 * turned it; none for Night Run, which the map turns to fill its frame as it always has.
 */
function trackOutline(route: Route, rot: Rot | undefined): { points: Float32Array; finishIndex: number; rot?: Rot } {
  const count = Math.ceil(route.lapLength);
  const points = new Float32Array(count * 2);
  const point = { x: 0, y: 0, z: 0 };

  for (let i = 0; i < count; i++) {
    route.point((i / count) * route.lapLength, 0, point);
    points[i * 2] = point.x;
    points[i * 2 + 1] = point.z;
  }

  return { points, finishIndex: 0, rot };
}

/**
 * A track's centreline for a card's plan: a point every two metres from the start line, turned by `rot` the way the
 * board turns it.
 */
function planOutline(route: Route, rot: Rot): Float32Array {
  const count = Math.max(8, Math.ceil(route.lapLength / 2));
  const out = new Float32Array(count * 2);
  const point = { x: 0, y: 0, z: 0 };
  const place = { rot, dx: 0, dz: 0 };

  for (let i = 0; i < count; i++) {
    route.point((i / count) * route.lapLength, 0, point);

    const [x, y] = toBoard(point.x, point.z, place);

    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }

  return out;
}

/**
 * A track's share link on this page's own address: the code, its name, who shared it and how their board turns it.
 * @param def - The track.
 * @param from - Who's sharing it.
 * @param rot - Its board turn.
 * @returns The link.
 */
function trackLink(def: TrackDef, from: string, rot: Rot): string {
  const url = new URL(location.pathname, location.origin);

  url.searchParams.set('track', def.code);
  if (def.name) url.searchParams.set('tn', def.name);
  if (from) url.searchParams.set('from', from);
  url.searchParams.set('r', String(rot));

  return url.toString();
}

/** A pasted track link or bare code: the code and whatever the link says about it. */
function parseTrackText(text: string): { code: string; name: string; from: string; rot: Rot | null } | null {
  const trimmed = text.trim();

  if (!trimmed) return null;

  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query.split('#')[0]);
  const code = params.get('track') ?? (query ? null : trimmed.replace(/\s+/g, ''));

  if (code === null) return null;

  const r = Number.parseInt(params.get('r') ?? '', 10);

  return {
    code,
    name: params.get('tn') ?? '',
    from: cleanTrackName(params.get('from') ?? ''),
    rot: r >= 0 && r <= 3 ? (r as Rot) : null,
  };
}

/** Copies text: the async clipboard, else the old copy command. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');

    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();

    const copied = document.execCommand('copy');

    field.remove();

    if (!copied) throw new Error('The browser would not copy.');
  }
}
