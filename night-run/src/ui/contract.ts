/**
 * The seam between NIGHT RUN's game and its 2D interface.
 *
 * The game owns the world, the session and the rules; the UI owns every 2D pixel, UI sound and touch control. The
 * game tells the UI what to show with {@link GameUI.show} (a whole screen, described as data) and a few transient
 * calls, and fills one {@link HudFrame} every frame. The UI tells the game what the player chose through the
 * {@link UiActions} it was created with. Neither side reaches into the other's objects.
 *
 * Calling `show` with the screen already showing updates it in place (no enter animation), so the game can call it
 * whenever lobby state changes.
 */

import type { Container } from 'pixi.js';

import type { TemplateName } from '../track/doc';
import type { LibraryEntry } from '../track/library';
import type { SvgTextures } from './art/svgTexture';

/** 0 yellow, 1 green, 2 purple, 3 red */
export type CarColor = 0 | 1 | 2 | 3;
export type Role = 'host' | 'guest' | 'spectator' | 'solo';
export type JoinError = 'notFound' | 'full' | 'malformed' | 'unreachable' | 'version';
export type ClosedReason = 'hostLeft' | 'kicked' | 'lost';

/** One of the 4 seats in the lobby */
export interface SeatView {
  /** Racer id (session id or 'botN'); '' for an open seat */
  id: string;
  kind: 'open' | 'joining' | 'player' | 'bot';
  name: string;
  car: CarColor;
  ready: boolean;
  isHost: boolean;
  isYou: boolean;
  /** False while a dropped guest's seat is held for reconnection */
  connected: boolean;
}

export interface ResultRow {
  id: string;
  place: number;
  name: string;
  car: CarColor;
  isBot: boolean;
  isYou: boolean;
  /** Race time in ms; 0 = did not finish */
  time: number;
  /** ms behind the winner; 0 for the winner and DNFs */
  gap: number;
  bestLap: number;
  /**
   * The racer was still running when the race closed (the host's End race, or a quick race that stopped waiting), and
   * `time` is projected from their pace and how far round they were, rather than a time they took the flag in
   */
  projected?: boolean;
}

/** One track as the library, the title chip, the lobby and the share landing show it. */
export interface TrackCard {
  /** The library entry's id; 'base' for Night Run; '' for a track that isn't in the library. */
  id: string;
  /** Its share code; null for a draft; '' for Night Run. */
  code: string | null;
  name: string;
  /** Who drew it. */
  author: string;
  /** Who shared it; '' for your own and Night Run. */
  from: string;
  builtIn: boolean;
  /** It's a track every client accepts, not a draft. */
  ready: boolean;
  /** Lap length in metres. */
  lengthM: number;
  /** About how long a lap takes, seconds. */
  lapSeconds: number;
  feel: 'Flowing' | 'Twisty' | 'Wild';
  feelLevel: 1 | 2 | 3;
  corners: number;
  /** Your best race on it at the laps you race, ms; 0 for none. */
  best: number;
  /**
   * The plan to draw: a ready track's centreline from the start line, turned by `rot`, as x/y pairs; a draft's cell
   * centres in board cells, in drawing order.
   */
  outline: Float32Array;
  /** How its author's board turned it: quarter turns clockwise. */
  rot: 0 | 1 | 2 | 3;
  selected: boolean;
}

/** A new track's starting point: a template, or Shuffle's random one. */
export type NewTrack = TemplateName | 'shuffle';

export type Screen =
  /** `hasTracks`: the player has a track of their own, so My tracks opens the library rather than a first Oval */
  | { id: 'title'; name: string; sound: boolean; track: TrackCard; hasTracks: boolean }
  /**
   * My tracks: the library, or the host's track picker over the lobby. `focus`: the track to show first, the one the
   * editor just closed, draft or not; else the selected one
   */
  | { id: 'tracks'; mode: 'library' | 'pick'; cards: readonly TrackCard[]; focus?: string }
  /**
   * The track editor over a hidden world. The UI owns the live document and its history while it's open, and saves
   * every commit through {@link UiActions.saveTrack}. `trail` is the player's last lap on it, as x, y (board cells),
   * speed (0 to 1) and an event (0 none, 1 a wall hit, 2 a respawn), four numbers a sample.
   */
  | {
      id: 'editor';
      entry: LibraryEntry;
      history: 'restore' | 'fresh';
      trail: Float32Array | null;
      laps: number;
    }
  /** A shared track's link, landed on: the attract race runs on it behind */
  | { id: 'trackLink'; card: TrackCard; from: string; saved: boolean }
  /** A first-time friend landing on `?join=CODE&from=Maya` */
  | { id: 'invite'; code: string; from: string; name: string }
  | { id: 'join'; code: string; error: JoinError | null; busy: boolean }
  | { id: 'connecting'; code: string }
  /** The truck picker; the UI opens it itself from the lobby, and the game never shows it */
  | { id: 'select'; name: string; car: CarColor; taken: readonly CarColor[] }
  | {
      id: 'lobby';
      role: Exclude<Role, 'solo'>;
      code: string;
      link: string;
      hostName: string;
      laps: number;
      seats: readonly SeatView[];
      /** Names of players the host is waiting on; empty when everyone is ready */
      waitingFor: readonly string[];
      spectators: number;
      /** The party's track */
      track: TrackCard;
      /** The host can pick another track here */
      canChangeTrack: boolean;
      /** The track is in this player's library (or is Night Run) */
      trackSaved: boolean;
    }
  /** In a race: the HUD shows, fed by {@link GameUI.updateHud}; `spectating` swaps the HUD for the watching chip */
  | { id: 'race'; role: Role; spectating: boolean; laps: number }
  | {
      id: 'results';
      role: Role;
      rows: readonly ResultRow[];
      hostName: string;
      /** performance.now() time the room returns to the lobby; 0 in solo */
      lobbyAt: number;
      /** The race was started from the editor or the library: Edit track goes back to it */
      editable?: boolean;
      /** The library entry raced, for Edit track */
      trackId?: string;
      /** A guest raced a custom track that isn't in their library: Save track keeps it */
      canSaveTrack?: boolean;
    }
  | { id: 'pause'; role: Role; sound: boolean; editable?: boolean; trackId?: string }
  /** The leave question; the UI asks it itself before calling {@link UiActions.leave}, and the game never shows it */
  | { id: 'leaveConfirm'; role: Role; hostName: string; others: readonly string[] }
  | { id: 'closed'; reason: ClosedReason; hostName: string };

export type Callout =
  | { kind: 'finalLap' }
  | { kind: 'wrongWay'; on: boolean }
  | { kind: 'positionGained'; by: number }
  | { kind: 'lap'; lap: number; split: number | null }
  | { kind: 'lapRecord'; time: number }
  /** The player's held slide fired the ultra boost */
  | { kind: 'ultraBoost' }
  | { kind: 'launchBoost' }
  | { kind: 'backOnTrack' }
  | { kind: 'someoneFinished'; name: string; place: number; closesAt: number }
  | { kind: 'finished'; place: number; time: number; personalBest: boolean };

export type Toast =
  | { kind: 'joined'; name: string; car: CarColor }
  | { kind: 'left'; name: string; car: CarColor }
  | { kind: 'colorReassigned'; from: CarColor; to: CarColor }
  | { kind: 'linkCopied' }
  | { kind: 'notice'; text: string };

/** One racer's slice of the HUD frame; the game keeps 4 and reuses them */
export interface HudRacer {
  active: boolean;
  id: string;
  name: string;
  car: CarColor;
  place: number;
  isYou: boolean;
  /** World position and heading, for the mini-map */
  x: number;
  z: number;
  yaw: number;
  /** Name tag anchor in screen pixels, already projected by the game; `tagVisible` false when off screen or too near/far */
  screenX: number;
  screenY: number;
  tagVisible: boolean;
  /** Distance from the camera in metres, for tag fade */
  distance: number;
  /** ms behind the leader in the timing tower; 0 for the leader */
  gap: number;
  finished: boolean;
}

/** Everything the HUD reads each frame. The game fills one instance in place; the UI never keeps references into it */
export interface HudFrame {
  place: number;
  racerCount: number;
  lap: number;
  laps: number;
  /** ms since GO; negative during the countdown */
  raceTime: number;
  lapTime: number;
  /** 0 = none yet */
  bestLap: number;
  speedKmh: number;
  /** How far the drift charge has built toward the ultra boost, 0..1; 1 when it's ready and fires as the slide ends */
  charge: number;
  boosting: boolean;
  /** 0..1 hit strength this frame, for HUD shake; 0 most frames */
  impact: number;
  /** Klipp camera label shown on the camera button, e.g. 'Chase' */
  camera: string;
  racers: HudRacer[];
  /** Name of the racer the cameras follow while spectating; '' otherwise */
  watching?: string;
}

/** The track's centreline in world x/z, closed, for the mini-map; sent once */
export interface TrackOutline {
  points: Float32Array;
  /** Index of the point at the start/finish line */
  finishIndex: number;
  /**
   * Quarter turns clockwise the track's author drew it at, which the map keeps; without one (Night Run) the map turns
   * the track a quarter when that fills its frame better
   */
  rot?: 0 | 1 | 2 | 3;
}

/** The floating stick the game's Controls read; the UI draws and drives it */
export interface StickInput {
  /** A finger is on the stick */
  readonly active: boolean;
  /** -1..1 right, -1..1 forward (up the screen) */
  readonly x: number;
  readonly y: number;
}

/** What the player can ask of the game. The game implements these; the UI calls them */
export interface UiActions {
  quickRace(): void;
  host(): void;
  /** Resolves once connected (the game then shows the lobby); rejects with a {@link JoinError} as the message */
  join(code: string): Promise<void>;
  setName(name: string): void;
  setSound(on: boolean): void;
  setCar(car: CarColor): void;
  setReady(ready: boolean): void;
  /** The room takes 1, 2, 3 or 5 laps; a count between them steps on to the next one the way the count moved */
  setLaps(laps: number): void;
  addBot(): void;
  removeBot(id: string): void;
  kick(id: string): void;
  start(force: boolean): void;
  /** Copies the share link; the UI shows the 'linkCopied' toast when it resolves */
  copyInvite(): Promise<void>;
  /**
   * Invites friends: on touch, opens the share sheet over the page; elsewhere, or when the sheet closes without
   * sharing, copies the link. Resolves with which happened, and the UI says so ('Shared' with a line asking the host to
   * keep the page open, or 'Link copied'), so the game shows no toast of its own for it. The UI calls this in place of
   * {@link UiActions.copyInvite} when the game has it.
   */
  shareInvite?(): Promise<'shared' | 'copied'>;
  /**
   * The truck picker opened over the lobby, or closed: while it's open the game turns the lobby's camera onto the
   * player's own truck, beside the picker's panel on a landscape screen and above it on a tall phone, so a colour picked
   * repaints the truck in view. The UI calls it as the picker opens and closes, when the game has it.
   */
  picking?(open: boolean): void;
  /** Host: results → lobby. Solo: race again */
  rematch(): void;
  endRace(): void;
  pause(): void;
  resume(): void;
  respawn(): void;
  restart(): void;
  /** Leave the party (or quit a solo race) and go back to the title, at once: the UI asks first where it should */
  leave(): void;
  /** After `closed`/'lost': try the same code again */
  rejoin(): void;
  cycleCamera(): void;
  spectateNext(): void;

  /** Opens My tracks: the library from the title, or the host's picker over the lobby */
  openTracks(mode: 'library' | 'pick'): void;
  /** Closes My tracks: back to the title (building the selected track behind it) or the lobby */
  closeTracks(): void;
  /** Selects a track for Quick race and the title; in the picker, it's the party's track */
  selectTrack(id: string): void;
  /** A new track in the editor, from a starting point */
  newTrack(start: NewTrack): void;
  /** Opens the editor on a track; Night Run opens a copy */
  editTrack(id: string): void;
  /** Leaves the editor for the library */
  closeEditor(): void;
  /** The editor committed a change: keep it */
  saveTrack(entry: LibraryEntry): void;
  deleteTrack(id: string): void;
  duplicateTrack(id: string): void;
  /** Selects a track and races it at once, with three bots or alone */
  raceTrack(id: string, bots: boolean): void;
  /** Shares a track's link: the share sheet on touch, else the clipboard; the UI says which */
  shareTrack?(id: string): Promise<'shared' | 'copied'>;
  /** A pasted link or code into the library: the entry's id (new, or the one already there), or null */
  importTrack(text: string): string | null;
  /** Keeps the track shown (a share landing's, or a party's) in the library; returns its entry's id */
  saveSharedTrack(): string | null;
  /** The editor opened or closed: the world hides and holds still under it */
  editing?(open: boolean): void;
}

export type NavInput = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';

/** Implemented by the UI (`ui/GameUI.ts`, `createGameUI`), called by the game */
export interface GameUI {
  /** Top of `app.stage`, above the 3D view */
  readonly container: Container;
  readonly stick: StickInput;
  /** Resolves once fonts and first textures are ready */
  readonly ready: Promise<void>;
  /** Whether touch controls are showing (touch seen and no key/pad driving since) */
  readonly touchMode: boolean;
  /** Sound on or off as the player last left it, remembered across visits; start the game's master gain from it */
  readonly soundOn?: boolean;
  show(screen: Screen): void;
  callout(callout: Callout): void;
  toast(toast: Toast): void;
  /** Countdown lamps and numerals: 3, 2, 1, then 0 for GO */
  countdown(step: 3 | 2 | 1 | 0): void;
  /** The reconnecting dialog over whatever shows; `heldUntil` is a performance.now() time; null hides it */
  reconnecting(heldUntil: number | null): void;
  setTrack(outline: TrackOutline): void;
  updateHud(frame: HudFrame, dt: number): void;
  /** Menu navigation from keys or a gamepad; returns whether the UI used it */
  navigate(input: NavInput): boolean;
  /** Mark that a key or gamepad drove (hides touch controls) or a touch happened (shows them) */
  setInputMode(mode: 'touch' | 'keys'): void;
  /**
   * Gamepad buttons held this frame, as `Controls` PAD bits, for screens that read the pad themselves (the editor's
   * cursor); returns whether the screen took them, so the menu navigation leaves them alone.
   */
  pad?(held: number, pressed: number): boolean;
  /** WebAudio for UI sounds, from the game's audio graph */
  setAudio(context: AudioContext, output: AudioNode): void;
  layout(width: number, height: number, resolution: number): void;
  destroy(): void;
}

export type CreateGameUI = (actions: UiActions) => GameUI;

/** The UI sounds, synthesised by `ui/sfx.ts` */
export type UiCue =
  | 'tick'
  | 'thock'
  | 'confirm'
  | 'back'
  | 'arm'
  | 'error'
  | 'join'
  | 'leave'
  | 'pluck'
  | 'warn'
  | 'lowBeep'
  | 'highBeep'
  | 'launch'
  | 'chargeTick'
  | 'chargeReady'
  | 'ultraBoost'
  | 'bump'
  | 'respawn'
  | 'bell'
  | 'record'
  | 'whooshUp'
  | 'whooshDown'
  | 'clack'
  | 'revBlip'
  | 'neonBuzz'
  | 'copySnap'
  | 'finishStab'
  | 'fanfare';

export interface UiSound {
  /** `amount` scales the cue's gain (bump strength) or picks its variant (the charge meter's step, 1 or 2) */
  play(cue: UiCue, amount?: number): void;
  /** The wrong-way buzzer loop */
  loop(cue: 'buzzerLoop', on: boolean): void;
}

/**
 * The in-race half of the UI (`ui/hud/RaceHud.ts`): HUD, callouts, countdown, name tags, mini-map and touch
 * controls. {@link GameUI} owns one and forwards the race calls to it; it shows while the screen is 'race'.
 */
export interface RaceHudApi {
  readonly container: Container;
  readonly stick: StickInput;
  readonly touchMode: boolean;
  setInputMode(mode: 'touch' | 'keys'): void;
  /** Seats the HUD for a race (grid moment) or hides it */
  setVisible(visible: boolean, role: Role, laps: number): void;
  setSpectating(on: boolean, watching: string): void;
  callout(callout: Callout): void;
  /** In-race toasts use the compact phone style; GameUI routes them here while racing */
  toast(toast: Toast): void;
  countdown(step: 3 | 2 | 1 | 0): void;
  setTrack(outline: TrackOutline): void;
  update(frame: HudFrame, dt: number): void;
  layout(width: number, height: number, resolution: number): void;
  destroy(): void;
}

/** `new RaceHud(options)`; GameUI creates it with its shared textures and sound */
export interface RaceHudOptions {
  textures: SvgTextures;
  sound: UiSound;
  actions: Pick<UiActions, 'pause' | 'cycleCamera' | 'spectateNext' | 'respawn'>;
}
