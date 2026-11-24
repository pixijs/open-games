import type { Text } from 'pixi.js';

import { COLORS, RACERS } from '../art/tokens';
import type { CarColor, Screen } from '../contract';
import type { Button } from '../kit/Button';
import { swatchButton } from '../kit/buttons';
import { fitText } from '../kit/text';
import { MenuScreen } from './MenuScreen';

type SelectData = Extract<Screen, { id: 'select' }>;

const CARS: readonly CarColor[] = [0, 1, 2, 3];

/** From a swatch's face to the top of its caption: clear of the plate's depth at every size. */
const CAPTION_GAP = 14;

/** A swatch's caption and what it fits: it changes as colours are taken, so it refits from its own size each time. */
interface Caption {
  readonly text: Text;
  readonly size: number;
  readonly max: number;
}

/**
 * Name and truck colour, over the lobby camera. Picking a colour punches its swatch, lights it, throws confetti in
 * the colour and flashes the 3D truck's repaint; a colour someone else has is locked and says who. Continue (or back)
 * returns to the lobby.
 */
export class SelectScreen extends MenuScreen<SelectData> {
  private _name = '';
  private _car: CarColor = 0;
  private _swatches: Button[] = [];
  private _captions: Caption[] = [];

  public override mount(): void {
    this._name = this.data.name;
    this._car = this.data.car;
    super.mount();
  }

  /** The lobby changed underneath: taken colours (and a reassigned car) update in place, the name being typed stays. */
  public override update(data: SelectData): void {
    this.data = data;
    if (!data.taken.includes(this._car) || data.car === this._car) this._car = data.car;
    for (const s of this._swatches) s.refresh();
    this._captions.forEach((c, i) => this._caption(c, CARS[i]));
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const color = RACERS[this._car];
    const onName = (v: string): void => void (this._name = v);
    const done = (): void => this._done();

    this._swatches = [];
    this._captions = [];
    if (k === 'd') {
      const size = 112;
      const gridY = 216;
      const pitch = 160;
      // The panel ends with its content: the second row's 16 px captions, then Continue (60) with 24 above and below.
      const h = gridY + pitch + size + CAPTION_GAP + 16 + 24 + 60 + 24;

      this.begin(true);
      this.scrim('right', 0.92, 0.6);
      this.begin();
      const p = this.panel(W - S.r - 520, Math.round((H - h) / 2), 520, h, { accent: COLORS.cyan });

      this.iconBtn('back', p.c.x + 20, p.c.y + 22, 40, 'secondary', done);
      this.title('Pick your truck', p.c.x + 82, p.c.y + 22, 40);
      this.label('Name', p.c.x + 24, p.c.y + 92);
      this.nameField(p.c.x + 24, p.c.y + 112, 472, 54, this._name, color, onName, done);
      this.label('Colour', p.c.x + 24, p.c.y + 192);
      this._grid(p.c.x + 24, p.c.y + gridY, 472, 2, size, pitch, 16);
      this.button('Continue', p.c.x + 24, p.c.y + h - 84, 472, 60, 'primary', 'forward', done, true);

      return;
    }
    this.begin(true);
    this.scrim(k === 'p' ? 'bottom' : 'right', k === 'p' ? 0.96 : 0.94, 0.7);
    this.begin();
    // The lobby's header, so opening the picker from it keeps the back button and title where they were.
    this.iconBtn('back', S.l, S.t, 44, 'secondary', done);
    if (k === 'p') this.title('Pick your truck', S.l + 70, S.t + 6, 32);
    else this.title('Pick your truck', S.l + 66, S.t + 7, 28);
    if (k === 'p') {
      const bw = W - S.l - S.r;
      const y0 = H - S.b - 352;

      this.begin();
      this.label('Name', S.l, y0);
      this.nameField(S.l, y0 + 20, bw, 52, this._name, color, onName, done);
      this.label('Colour', S.l, y0 + 92);
      this._grid(S.l, y0 + 114, bw, 4, 62, 0, 13);
      this.begin();
      this.button('Continue', S.l, H - S.b - 64, bw, 64, 'primary', 'forward', done, true);

      return;
    }
    const x = W - S.r - 380;
    // Stacked on Continue as on a phone: the captions end 24 above it, and what's left opens beside the title.
    const y0 = H - S.b - 56 - 24 - 194;

    this.begin();
    this.label('Name', x, y0);
    this.nameField(x, y0 + 18, 380, 46, this._name, color, onName, done);
    this.label('Colour', x, y0 + 82);
    this._grid(x, y0 + 104, 380, 4, 60, 0, 13);
    this.begin();
    this.button('Continue', x, H - S.b - 56, 380, 54, 'primary', 'forward', done, true);
  }

  /** Phones: over the scene, above the form. */
  public override toastBottom(): number | null {
    const { k, H, S } = this;

    return k === 'p' ? H - S.b - 366 : k === 'l' ? H - S.b - 8 : null;
  }

  public override back(): boolean {
    this._done();

    return true;
  }

  /**
   * The four swatches in `cols` equal columns across `w`, each centred in its column with its caption centred under
   * it, so the grid keeps even side margins at any width.
   * @param pitch - Row to row, when there's more than one row.
   * @param ts - Caption size.
   */
  private _grid(x: number, y: number, w: number, cols: number, size: number, pitch: number, ts: number): void {
    const cw = w / cols;

    for (const car of CARS) {
      const cx = x + ((car % cols) + 0.5) * cw;
      const sy = y + Math.floor(car / cols) * pitch;

      this._swatch(car, size, cx, sy, ts, cw);
    }
  }

  /** One swatch centred on `cx` with its top at `y`, and its caption under it, fitted to `max`. */
  private _swatch(car: CarColor, size: number, cx: number, y: number, ts: number, max: number): void {
    const mode = (): 'selected' | 'taken' | null =>
      car === this._car ? 'selected' : this.data.taken.includes(car) ? 'taken' : null;
    const b = swatchButton(this.host.kit, RACERS[car], size, mode, () => this._pick(car));

    b.placeFace(cx - b.faceBox.w / 2, y);
    b.setDisabled(mode() === 'taken');
    this.add(b, car === this._car);
    this._swatches.push(b);
    const caption = {
      text: this.text('', cx, y + size + CAPTION_GAP, { s: ts, w: 600, i: true, a: 'c' }),
      size: ts,
      max,
    };

    this._caption(caption, car);
    this._captions.push(caption);
  }

  private _caption({ text: t, size, max }: Caption, car: CarColor): void {
    const taken = this.data.taken.includes(car) && car !== this._car;
    const taker = this.host.memory.lobby?.seats.find((s) => s.car === car && !s.isYou && s.kind !== 'open');
    const wide = this.k === 'd';

    t.text = taken
      ? wide && taker
        ? `${taker.name} has it`
        : 'Taken'
      : car === this._car
        ? 'Yours'
        : RACERS[car].name;
    t.style.fontSize = size;
    fitText(t, max);
    t.style.fill = car === this._car ? COLORS.cyan : taken ? COLORS.mist : COLORS.white;
    this._swatches[car]?.setDisabled(taken);
  }

  private _pick(car: CarColor): void {
    if (car === this._car || this.data.taken.includes(car)) return;
    this._car = car;
    this.host.memory.car = car;
    this.host.actions.setCar(car);
    for (const s of this._swatches) s.refresh();
    this._captions.forEach((c, i) => this._caption(c, CARS[i]));
    const b = this._swatches[car];

    this.host.kit.sound.play('revBlip');
    this.host.flash(0.35, 0.3);
    if (!b) return;
    this.motion.punch(b.scale, 1.15);
    const at = this.host.fx.toLocal(b.getGlobalPosition());

    this.host.confetti(at.x, at.y, RACERS[car].main, 12, 0.8);
  }

  private _done(): void {
    const name = this._name.trim();

    if (name && name !== this.host.memory.name) {
      this.host.actions.setName(name);
      this.host.memory.name = name;
    }
    this.host.kit.sound.play('confirm');
    this.host.backLocal();
  }
}
