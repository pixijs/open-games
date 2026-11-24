/**
 * `window.__net`'s party controls, for harnesses that run a party across tabs: the host's track and Start, a guest's
 * Ready, a dropped link, and the two failures a real page meets only with an old or broken copy of the game. Nothing
 * in the game calls them.
 */

import type { Flow } from '../Flow';
import { extendTestHook } from '../testHooks';

/** Failures a harness asks for, which the session and the flow act on once, then forget. */
export const netSwitches = {
  /** The next join leaves `proto` out, as a page from before tracks did. */
  dropProto: false,
  /** The next track the room asks this screen to build is taken for one it can't. */
  failNextTrack: false,
};

/**
 * Add the party controls to `window.__net`.
 * @param flow - The flow whose session they drive.
 */
export function installNetHooks(flow: Flow): void {
  extendTestHook('__net', {
    /** The room's track code and name, as this screen last heard them. */
    get track() {
      const state = flow.session?.state;

      return state ? { code: state.track, name: state.trackName } : null;
    },
    /** The host's pick of track in the lobby, as the lobby would send it. */
    setTrack(code: string, name = ''): void {
      flow.session?.setTrack(code, name);
    },
    /** A guest's Ready, without `?autoready`. */
    setReady(ready: boolean): void {
      flow.setReady(ready);
    },
    /** The host's Start, without `?autostart`; `force` starts with players still not ready. */
    start(force = false): void {
      flow.start(force);
    },
    /** The next join omits `proto`, so the room sees an old page. */
    dropProto(): void {
      netSwitches.dropProto = true;
    },
    /** A guest's link to the host closes, and comes back after `ms`. */
    simulateDrop(ms: number): void {
      flow.session?.simulateDrop(ms);
    },
    /** The next track the room asks for can't be built here. */
    failNextTrack(): void {
      netSwitches.failNextTrack = true;
    },
  });
}
