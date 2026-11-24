import type { StickInput } from './ui/contract';

export interface ControlsState {
  x: number;
  z: number;
  touchActive: boolean;
}

/** Gamepad buttons the game acts on, as bits of {@link Controls.pressed}. */
export const PAD = {
  confirm: 1,
  back: 2,
  camera: 4,
  /** Y: no race action uses it, but the track editor reads this bit as redo. */
  y: 8,
  respawn: 16,
  pause: 32,
  up: 64,
  down: 128,
  left: 256,
  right: 512,
} as const;

/** The standard gamepad mapping's button index for each of {@link PAD}'s bits, in the same order. */
const PAD_BUTTONS = [0, 1, 2, 3, 8, 9, 12, 13, 14, 15];
/** How far the left stick has to go to count as a d-pad press in the menus. */
const STICK_PRESS = 0.6;
/** Past this share of its travel down the screen, the stick brakes and then reverses. */
const STICK_BRAKE_PULL = 0.6;
const DEAD_ZONE = 0.15;

export class Controls {
  /** The touch stick the UI draws; null before the UI exists. */
  public stick: StickInput | null = null;
  /** Gamepad buttons that went down this frame, as {@link PAD} bits. */
  public pressed = 0;
  /** Whether a gamepad drove or pressed anything this frame. */
  public padUsed = false;

  private readonly _keys: Record<string, boolean> = Object.create(null);
  private readonly _state: ControlsState = { x: 0, z: 0, touchActive: false };
  private _held = 0;
  private _pad: Gamepad | null = null;

  constructor() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Gamepad buttons down now, as {@link PAD} bits: a screen that repeats a held d-pad reads them. */
  public get held(): number {
    return this._held;
  }

  /**
   * Reads the gamepad's buttons into {@link Controls.pressed} and {@link Controls.held} without driving anything, for a
   * screen that runs while the game's frame doesn't (the track editor, with the world paused under it).
   */
  public poll(): void {
    this._readPad();
  }

  public destroy(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.stick = null;
  }

  /**
   * Read every input source into one state.
   *
   * Touch steering is camera-relative: the stick points where the car should head on screen, so it
   * needs the camera's forward direction on the ground. Behind the car, where that direction turns
   * with the car itself, the stick steers instead and the throttle stays on.
   * @param forwardX - Camera forward, flattened onto the ground and normalized, x.
   * @param forwardZ - Camera forward, flattened onto the ground and normalized, z.
   * @param steer - Whether touch steers relative to the car rather than the screen.
   */
  public update(forwardX: number, forwardZ: number, steer: boolean): ControlsState {
    let x = 0;
    let z = 0;

    if (this._keys.KeyA || this._keys.ArrowLeft) x -= 1;
    if (this._keys.KeyD || this._keys.ArrowRight) x += 1;
    if (this._keys.KeyW || this._keys.ArrowUp) z += 1;
    if (this._keys.KeyS || this._keys.ArrowDown) z -= 1;

    this._readPad();

    const pad = this._pad;

    if (pad) {
      const stickX = pad.axes[0] ?? 0;

      if (Math.abs(stickX) > DEAD_ZONE) x = stickX;

      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;

      if (rt > 0.1 || lt > 0.1) z = rt - lt;
    }

    let touchActive = false;
    const stick = this.stick;

    if (stick?.active) {
      const jx = stick.x;
      // Down the screen is positive here, as pulling back to brake reads.
      const jy = -stick.y;
      const mag = Math.sqrt(jx * jx + jy * jy);

      if (mag > DEAD_ZONE && steer) {
        x = jx;
        z = jy > STICK_BRAKE_PULL ? -1 : 1;
      } else if (mag > DEAD_ZONE) {
        // Screen right is the camera's right on the ground: (-forwardZ, forwardX).
        x = (-forwardZ * jx - forwardX * jy) / mag;
        z = (forwardX * jx - forwardZ * jy) / mag;
        touchActive = true;
      }
    }

    this._state.x = x;
    this._state.z = z;
    this._state.touchActive = touchActive;

    return this._state;
  }

  /** The first connected gamepad's buttons, as presses since the last frame. */
  private _readPad(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;

    for (const each of pads) {
      if (each) {
        pad = each;
        break;
      }
    }

    this._pad = pad;

    let held = 0;

    if (pad) {
      for (let i = 0; i < PAD_BUTTONS.length; i++) if (pad.buttons[PAD_BUTTONS[i]]?.pressed) held |= 1 << i;

      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;

      if (ay < -STICK_PRESS) held |= PAD.up;
      if (ay > STICK_PRESS) held |= PAD.down;
      if (ax < -STICK_PRESS) held |= PAD.left;
      if (ax > STICK_PRESS) held |= PAD.right;
    }

    this.pressed = held & ~this._held;
    this._held = held;

    const driving =
      pad !== null &&
      (Math.abs(pad.axes[0] ?? 0) > DEAD_ZONE ||
        (pad.buttons[7]?.value ?? 0) > 0.1 ||
        (pad.buttons[6]?.value ?? 0) > 0.1);

    this.padUsed = this.pressed !== 0 || driving;
  }

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    this._keys[e.code] = true;
  };

  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    this._keys[e.code] = false;
  };

  /** Keys let go while the tab was away never send their keyup. */
  private readonly _onBlur = (): void => {
    for (const code in this._keys) this._keys[code] = false;
  };
}
