import { iconSvg } from '../art/icons';
import { COLORS, RACERS } from '../art/tokens';
import type { Screen } from '../contract';
import type { Button } from '../kit/Button';
import { MenuScreen, SHEET } from './MenuScreen';

type InviteData = Extract<Screen, { id: 'invite' }>;

/**
 * A friend landing on `?join=CODE&from=Maya` for the first time: who invited them, the party's plate, a name field,
 * and Join the party. A failed join opens the join entry with the error.
 */
export class InviteScreen extends MenuScreen<InviteData> {
  private _name = '';
  private _busy = false;
  private _join: Button | null = null;

  public override mount(): void {
    this._name = this.data.name;
    super.mount();
  }

  public override update(data: InviteData): void {
    if (data.name !== this.data.name) this._name = data.name;
    super.update(data);
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const { code, from } = this.data;
    const color = RACERS[this.host.memory.car];
    const pad = SHEET.pad;
    const titleS = SHEET.title[k];
    const bh = SHEET.button[k];
    const w = k === 'd' ? 520 : k === 'p' ? W - 40 : 560;
    const iw = w - pad * 2;
    const icon = k === 'l' ? 26 : 30;
    const crown = iconSvg('crown', { size: icon, color: RACERS[0].main, accent: RACERS[0].main });
    const notNow = (): void => this.host.showLocal({ ...this.host.titleScreen(), name: this._name }, true);
    const onName = (v: string): void => {
      this._name = v;
      this._join?.setDisabled(!v.trim() || this._busy);
    };
    const go = (): void => this._go();

    this.begin(true);
    this.dim(0.5);
    if (k === 'p') this.scrim('top', 0.9, 0.7);
    this.begin();
    // Everything stacks down from the copy, which wraps to one or two lines, so the sheet is drawn to fit it: the
    // copy first to measure it, then the panel under it.
    const body = this.body(`You're joining ${from}'s party. Pick a name and you're in.`, 0, 0, k === 'l' ? 250 : iw);
    const bodyY = SHEET.body[k];
    // Landscape: the plate stands right of the copy, level with it.
    const plateY = k === 'l' ? bodyY - 16 : bodyY + Math.ceil(body.height) + 24;
    const plateH = k === 'd' ? 84 : k === 'p' ? 80 : 70;
    const labelY = Math.max(bodyY + Math.ceil(body.height), plateY + plateH + 6) + (k === 'l' ? 18 : 24);
    const fieldH = k === 'l' ? 52 : 56;
    const buttonsY = labelY + 20 + fieldH + (k === 'l' ? 24 : 32);
    const h = buttonsY + (k === 'p' ? bh * 2 + 10 : bh) + pad;
    const x = (W - w) / 2;
    // A phone's sheet sits high, like every sheet with a name to type, so the keyboard leaves the field in view.
    const y = k === 'p' ? S.t + 80 : (H - h) / 2;
    const p = this.panel(x, y, w, h, { accent: COLORS.cyan });
    const cx = p.c.x + pad;

    this.put(crown, cx, p.c.y + SHEET.titleY + Math.round(0.46 * titleS - icon / 2));
    this.title(`${from} invited you`, cx + icon + 12, p.c.y + SHEET.titleY, titleS);
    this.target.addChild(body);
    body.position.set(cx, p.c.y + bodyY);
    if (k === 'l') this.codePlate(cx + iw - 214, p.c.y + plateY, 214, plateH, 'idle', code);
    else this.codePlate(cx, p.c.y + plateY, k === 'd' ? 260 : iw, plateH, 'idle', code);
    this.label('Your name', cx, p.c.y + labelY);
    const field = this.nameField(cx, p.c.y + labelY + 20, iw, fieldH, this._name, color, onName, go);
    const by = p.c.y + buttonsY;

    if (k !== 'l' && !this.host.kit.touch) field.focus();
    if (k === 'p') {
      this._join = this.button('Join the party', cx, by, iw, bh, 'primary', 'forward', go, true);
      this.button('Not now', cx, by + bh + 10, iw, bh, 'secondary', null, notNow);
    } else {
      this.button('Not now', cx, by, 170, bh, 'secondary', null, notNow);
      this._join = this.button('Join the party', cx + 190, by, iw - 190, bh, 'primary', 'forward', go, true);
    }
    if (this._busy) this._join.setLabel('Joining…');
    this._join.setDisabled(!this._name.trim() || this._busy);
  }

  public override back(): boolean {
    this.host.showLocal({ ...this.host.titleScreen(), name: this._name }, true);

    return true;
  }

  private _go(): void {
    const name = this._name.trim();

    if (!name || this._busy) return;
    this._busy = true;
    this._join?.setLabel('Joining…');
    this._join?.setDisabled(true);
    this.host.kit.sound.play('confirm');
    if (name !== this.host.memory.name) {
      this.host.actions.setName(name);
      this.host.memory.name = name;
    }
    this.host.join(this.data.code);
  }
}
