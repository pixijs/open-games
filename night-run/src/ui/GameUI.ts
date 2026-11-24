import { Container, Sprite, Texture } from 'pixi.js';

import { SvgTextures } from './art/svgTexture';
import type {
  Callout,
  CreateGameUI,
  GameUI,
  HudFrame,
  JoinError,
  NavInput,
  RaceHudApi,
  Screen,
  StickInput,
  TrackCard,
  TrackOutline,
  UiActions,
} from './contract';
import { EditorScreen } from './editor/EditorScreen';
import { installEditorHooks } from './editor/hooks';
import { RaceHud } from './hud/RaceHud';
import { confettiBurst } from './kit/confetti';
import { loadFonts } from './kit/fonts';
import type { UiKit } from './kit/kit';
import type { UiLayout } from './kit/layout';
import { computeLayout, readSafeInsets, sameLayout } from './kit/layout';
import { Motion } from './kit/Motion';
import type { MenuToast } from './kit/ToastStack';
import { ToastStack } from './kit/ToastStack';
import { ClosedScreen } from './screens/ClosedScreen';
import { ConnectingScreen } from './screens/ConnectingScreen';
import { InviteScreen } from './screens/InviteScreen';
import { JoinScreen } from './screens/JoinScreen';
import { LeaveScreen } from './screens/LeaveScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { RaceMenuScreen } from './screens/RaceMenuScreen';
import { RaceScreen } from './screens/RaceScreen';
import { ReconnectDialog } from './screens/ReconnectDialog';
import { ResultsScreen } from './screens/ResultsScreen';
import type { ScreenHost, UiMemory } from './screens/ScreenHost';
import type { ScreenView } from './screens/ScreenView';
import { EXIT_FADE } from './screens/ScreenView';
import { SelectScreen } from './screens/SelectScreen';
import { TitleScreen } from './screens/TitleScreen';
import { TrackLinkScreen } from './screens/TrackLinkScreen';
import { TracksScreen } from './screens/TracksScreen';
import { UiSfx } from './sfx';

const JOIN_ERRORS: readonly string[] = [
  'notFound',
  'full',
  'malformed',
  'unreachable',
  'version',
] satisfies JoinError[];
/** The title's track before the game has described one: Night Run. */
const NIGHT_RUN_CARD: TrackCard = {
  id: 'base',
  code: '',
  name: 'Night Run',
  author: '',
  from: '',
  builtIn: true,
  ready: true,
  lengthM: 0,
  lapSeconds: 0,
  feel: 'Twisty',
  feelLevel: 2,
  corners: 0,
  best: 0,
  outline: new Float32Array(0),
  rot: 0,
  selected: true,
};
/** Screens the HUD stays up behind: the race and the menus over it */
const OVER_RACE = new Set<Screen['id']>(['race', 'pause', 'leaveConfirm']);
/** Menus the reconnecting dialog takes the place of while it shows, so its panel never stacks on theirs */
const UNDER_DIALOG = new Set<Screen['id']>(['pause', 'leaveConfirm']);

/** The kit the shell hands every screen; its layout and input flags change in place. */
interface ShellKit extends UiKit {
  textures: SvgTextures;
  layout: UiLayout;
  keys: boolean;
  touch: boolean;
}

/**
 * NIGHT RUN's 2D interface: the screen router, the toasts, the reconnecting dialog and focus navigation over the
 * game's 3D view, with the race HUD (`RaceHud`) inside it. Screens enter and exit with the shared choreography; a
 * `show` for the screen already up updates it in place. The UI opens some screens itself (join from the title, the
 * truck picker from the lobby, leave confirms) and goes back to the game's screen when they close.
 */
class NightRunUi implements GameUI, ScreenHost {
  public readonly container = new Container();
  public readonly ready: Promise<void>;
  public readonly actions: UiActions;
  public readonly memory: UiMemory = {
    name: '',
    sound: true,
    car: 0,
    laps: 3,
    lobby: null,
    role: 'solo',
    racing: false,
    title: null,
  };
  public readonly fx = new Container();
  public readonly kit: ShellKit;
  /** The HUD's touch stick, read through; the game takes this once, before the HUD exists */
  public readonly stick: StickInput;
  private readonly _sfx = new UiSfx();
  private readonly _motion = new Motion();
  private readonly _screens = new Container();
  private readonly _dialogs = new Container();
  private readonly _flash = new Sprite(Texture.WHITE);
  private readonly _toasts: ToastStack;
  private _hud: RaceHudApi | null = null;
  private _current: ScreenView | null = null;
  private _dialog: ReconnectDialog | null = null;
  /** Screens the UI opened over the game's, oldest first; the game's own is at 0 */
  private _stack: Screen[] = [];
  private _pending: Screen | null = null;
  private _track: TrackOutline | null = null;
  private _laid = false;
  private _destroyed = false;
  private _picking = false;
  private _editing = false;

  constructor(actions: UiActions) {
    this.actions = actions;
    const hud = (): RaceHudApi | null => this._hud;

    this.stick = {
      get active() {
        return hud()?.stick.active ?? false;
      },
      get x() {
        return hud()?.stick.x ?? 0;
      },
      get y() {
        return hud()?.stick.y ?? 0;
      },
    };
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const resolution = Math.min(3, Math.max(1, window.devicePixelRatio || 1));

    this.kit = {
      textures: new SvgTextures(resolution),
      sound: this._sfx,
      layout: computeLayout(window.innerWidth, window.innerHeight, resolution, readSafeInsets()),
      keys: false,
      touch: coarse,
    };
    this.memory.sound = !this._sfx.muted;
    this._toasts = new ToastStack(this.kit, () => this._current);
    this._flash.tint = 0xffffff;
    this._flash.alpha = 0;
    this._flash.visible = false;
    this._flash.eventMode = 'none';
    this.fx.eventMode = 'none';
    this.container.addChild(this._screens, this._toasts.container, this._dialogs, this.fx, this._flash);
    this.container.eventMode = 'passive';
    this._screens.eventMode = 'passive';
    this._dialogs.eventMode = 'passive';
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('pointerdown', this._onPointer, { capture: true });
    this.ready = loadFonts(2500, () => this._refresh()).then(() => undefined);
    installEditorHooks();
  }

  public get soundOn(): boolean {
    return !this._sfx.muted;
  }

  public get touchMode(): boolean {
    return this._hud?.touchMode ?? this.kit.touch;
  }

  public show(screen: Screen): void {
    if (this._destroyed) return;
    this._remember(screen);
    const base = this._stack[0];

    if (this._stack.length > 1 && base && base.id === screen.id) {
      this._stack[0] = screen;
      if (this._current?.data.id === 'select' && screen.id === 'lobby') this._current.update(this._selectFor());

      return;
    }
    this._stack = [screen];
    this._route(screen);
  }

  public showLocal(screen: Screen, replace = false): void {
    if (replace) this._stack[this._stack.length - 1] = screen;
    else this._stack.push(screen);
    this._route(screen);
  }

  public join(code: string): void {
    this.actions.join(code).catch((reason: unknown) => {
      if (this._destroyed) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      const error = (JOIN_ERRORS.includes(message) ? message : 'unreachable') as JoinError;
      const screen: Screen = { id: 'join', code, error, busy: false };

      if (this._current?.data.id === 'join') {
        this._stack[this._stack.length - 1] = screen;
        this._current.update(screen);

        return;
      }
      this._stack = [this.titleScreen(), screen];
      this._route(screen);
    });
  }

  public titleScreen(): Extract<Screen, { id: 'title' }> {
    const m = this.memory;
    const title = m.title;

    if (title) return { ...title, name: m.name, sound: m.sound };

    return { id: 'title', name: m.name, sound: m.sound, track: NIGHT_RUN_CARD, hasTracks: false };
  }

  public openSelect(): void {
    this.showLocal(this._selectFor());
  }

  public backLocal(): boolean {
    if (this._stack.length < 2) return false;
    this._stack.pop();
    const prev = this._stack[this._stack.length - 1];

    this._route(prev.id === 'select' ? this._selectFor() : prev);

    return true;
  }

  public callout(callout: Callout): void {
    this._hud?.callout(callout);
  }

  /** In a race (its menus included) the HUD shows toasts; elsewhere the menu toasts do. */
  public toast(toast: MenuToast): void {
    if (this.memory.racing && this._hud) {
      if (toast.kind !== 'shared') this._hud.toast(toast);
    } else this._toasts.push(toast);
  }

  public countdown(step: 3 | 2 | 1 | 0): void {
    this._hud?.countdown(step);
  }

  public reconnecting(heldUntil: number | null): void {
    if (heldUntil === null) {
      const d = this._dialog;

      this._dialog = null;
      if (d) void d.exit().then(() => d.destroy());
      this._tuck(true);

      return;
    }
    if (this._dialog) {
      this._dialog.setHeld(heldUntil);

      return;
    }
    this._dialog = new ReconnectDialog(this, heldUntil);
    this._dialog.mount();
    this._dialogs.addChild(this._dialog.root);
    void this._dialog.enter();
    this._tuck(true);
  }

  public setTrack(outline: TrackOutline): void {
    this._track = outline;
    this._hud?.setTrack(outline);
  }

  public updateHud(frame: HudFrame, dt: number): void {
    if (this.memory.racing) this._hud?.update(frame, dt);
    this._current?.frame(frame.racers);
  }

  /** The editor reads the pad itself, for its cursor's repeat; other screens leave it to the menu navigation. */
  public pad(held: number, pressed: number): boolean {
    const current = this._current;

    if (this._destroyed || this._dialog || !(current instanceof EditorScreen)) return false;
    if (held !== 0 && !this.kit.keys) this.setInputMode('keys');

    return current.pad(held, pressed);
  }

  public navigate(input: NavInput): boolean {
    if (this._destroyed) return false;
    if (!this.kit.keys) this.setInputMode('keys');
    if (this._dialog) return this._dialog.navigate(input);

    return this._current?.navigate(input) ?? false;
  }

  public setInputMode(mode: 'touch' | 'keys'): void {
    const keys = mode === 'keys';
    const touch = mode === 'touch';

    this._hud?.setInputMode(mode);
    if (this.kit.keys === keys && this.kit.touch === touch) return;
    this.kit.keys = keys;
    this.kit.touch = touch;
    this._current?.inputChanged();
    this._dialog?.inputChanged();
  }

  public setAudio(context: AudioContext, output: AudioNode): void {
    this._sfx.setAudio(context, output);
  }

  public setSound(on: boolean): void {
    this.memory.sound = on;
    this._sfx.setMuted(!on);
    this.actions.setSound(on);
  }

  public flash(alpha: number, duration: number): void {
    if (this._motion.reduced) return;
    const f = this._flash;

    f.visible = true;
    this._motion.stop(f);
    this._motion.fromTo(
      f,
      { alpha },
      { alpha: 0, duration, ease: 'power2.out', onComplete: () => void (f.visible = false) },
    );
  }

  public confetti(x: number, y: number, color: string, count = 12, spread = 1): void {
    confettiBurst(this.kit, this._motion, this.fx, x, y, color, count, spread);
  }

  public layout(width: number, height: number, resolution: number): void {
    if (this._destroyed) return;
    const next = computeLayout(width, height, resolution, readSafeInsets());
    const first = !this._laid;

    this._laid = true;
    if (first && this.kit.textures.resolution !== resolution) {
      this.kit.textures.destroy();
      this.kit.textures = new SvgTextures(resolution);
    }
    if (!this._hud) this._makeHud();
    this._hud!.layout(width, height, resolution);
    const changed = !sameLayout(this.kit.layout, next);

    this.kit.layout = next;
    for (const layer of [this._screens, this._toasts.container, this._dialogs, this.fx]) layer.scale.set(next.scale);
    this._flash.width = width;
    this._flash.height = height;
    if (this._pending) {
      const p = this._pending;

      this._pending = null;
      this._route(p);
    } else if (changed && !first) {
      this._current?.relayout();
      this._dialog?.relayout();
      this._toasts.relayout();
    }
  }

  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('pointerdown', this._onPointer, { capture: true });
    this._motion.destroy();
    this._current?.destroy();
    this._current = null;
    this._dialog?.destroy();
    this._dialog = null;
    this._toasts.destroy();
    this._hud?.destroy();
    this._hud = null;
    this._sfx.destroy();
    this.container.destroy({ children: true });
    this.kit.textures.destroy();
  }

  private _makeHud(): void {
    this._hud = new RaceHud({
      textures: this.kit.textures,
      sound: this._sfx,
      actions: this.actions,
    });
    // Under the screens, so the race menu and the leave question dim it and take its touches.
    this.container.addChildAt(this._hud.container, 0);
    this._hud.setInputMode(this.kit.touch ? 'touch' : 'keys');
    if (this._track) this._hud.setTrack(this._track);
  }

  /** The race menu or the leave question steps aside while the reconnecting dialog shows, and comes back after it. */
  private _tuck(animate: boolean): void {
    const current = this._current;

    if (!current) return;
    const root = current.root;
    const hidden = this._dialog !== null && UNDER_DIALOG.has(current.data.id);
    const alpha = hidden ? 0 : 1;

    root.eventMode = hidden ? 'none' : 'passive';
    if (root.alpha === alpha) return;
    this._motion.stop(root);
    if (animate && !this._motion.reduced) this._motion.to(root, { alpha, duration: 0.15, ease: 'power1.out' });
    else root.alpha = alpha;
  }

  /** Keeps what the game said, for the screens the UI opens itself. */
  private _remember(screen: Screen): void {
    const m = this.memory;

    switch (screen.id) {
      case 'title':
        m.name = screen.name;
        m.sound = screen.sound;
        m.lobby = null;
        m.role = 'solo';
        m.title = screen;
        break;
      case 'invite':
        m.name = screen.name;
        break;
      case 'select':
        m.name = screen.name;
        m.car = screen.car;
        break;
      case 'lobby': {
        m.lobby = screen;
        m.role = screen.role;
        m.laps = screen.laps;
        const you = screen.seats.find((s) => s.isYou);

        if (you) {
          m.car = you.car;
          m.name = you.name;
        }
        break;
      }
      case 'race':
        m.role = screen.role;
        m.laps = screen.laps;
        break;
      case 'pause':
        m.sound = screen.sound;
        m.role = screen.role;
        break;
      default:
        break;
    }
  }

  /** The truck picker's data from the lobby the game last showed; a bot's truck is free, the room swaps with it. */
  private _selectFor(): Extract<Screen, { id: 'select' }> {
    const lobby = this.memory.lobby;
    const taken = lobby ? lobby.seats.filter((s) => !s.isYou && s.kind === 'player').map((s) => s.car) : [];

    return { id: 'select', name: this.memory.name, car: this.memory.car, taken };
  }

  private _route(screen: Screen): void {
    if (!this._laid) {
      this._pending = screen;

      return;
    }
    const wasRacing = this.memory.racing;
    const racing = OVER_RACE.has(screen.id) && (screen.id === 'race' || wasRacing);
    const picking = screen.id === 'select';

    if (picking !== this._picking) {
      this._picking = picking;
      this.actions.picking?.(picking);
    }
    const editing = screen.id === 'editor';
    const leftEditor = !editing && this._editing;

    // The world hides as the editor comes up and shows again as it goes; the editor itself says so once it's in.
    if (leftEditor) {
      this._editing = false;
      this.actions.editing?.(false);
    } else if (editing) {
      this._editing = true;
    }
    this.memory.racing = racing;
    this._sfx.setRacing(racing);
    if (screen.id === 'race') {
      if (!wasRacing) this._hud?.setVisible(true, screen.role, screen.laps);
      this._hud?.setSpectating(screen.spectating, '');
    } else if (!racing && wasRacing) {
      this._hud?.setVisible(false, this.memory.role, 0);
    }
    // A race shows its own toasts, a closed party has nothing left to report, and the editor's were about its board.
    if (racing || screen.id === 'closed' || leftEditor) this._toasts.clear();
    const current = this._current;

    if (current && current.data.id === screen.id) {
      current.update(screen);

      return;
    }
    const next = this._make(screen);

    this._current = next;
    next.mount();
    this._screens.addChild(next.root);
    this._tuck(false);
    if (current) void current.exit().then(() => current.destroy());
    void next.enter(current && current.data.id !== 'race' ? EXIT_FADE : 0);
    this._toasts.restack();
  }

  private _make(screen: Screen): ScreenView {
    switch (screen.id) {
      case 'title':
        return new TitleScreen(this, screen);
      case 'invite':
        return new InviteScreen(this, screen);
      case 'join':
        return new JoinScreen(this, screen);
      case 'connecting':
        return new ConnectingScreen(this, screen);
      case 'select':
        return new SelectScreen(this, screen);
      case 'lobby':
        return new LobbyScreen(this, screen);
      case 'race':
        return new RaceScreen(this, screen);
      case 'results':
        return new ResultsScreen(this, screen);
      case 'pause':
        return new RaceMenuScreen(this, screen);
      case 'leaveConfirm':
        return new LeaveScreen(this, screen);
      case 'closed':
        return new ClosedScreen(this, screen);
      case 'tracks':
        return new TracksScreen(this, screen);
      case 'editor':
        return new EditorScreen(this, screen);
      case 'trackLink':
        return new TrackLinkScreen(this, screen);
    }
  }

  /** Fonts arrived late: redraw what's up so its Text picks them up. */
  private _refresh(): void {
    if (this._destroyed) return;
    this._current?.relayout();
    this._dialog?.relayout();
  }

  private readonly _onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace') return;
    const screen = this._dialog ?? this._current;

    if (screen?.key(e.key)) e.preventDefault();
  };

  private readonly _onPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') this.setInputMode('touch');
    else if (this.kit.keys) {
      this.kit.keys = false;
      this._current?.inputChanged();
      this._dialog?.inputChanged();
    }
  };
}

/** Builds NIGHT RUN's UI; the game adds `container` over its 3D view and drives it. */
export const createGameUI: CreateGameUI = (actions) => new NightRunUi(actions);
