/** Options for {@link TextField}. */
export interface TextFieldOptions {
  readonly value: string;
  readonly max: number;
  /** Keeps only what the field accepts, e.g. upper-cases a code */
  readonly clean?: (raw: string) => string;
  readonly onChange: (value: string) => void;
  readonly onEnter?: () => void;
  readonly onEscape?: () => void;
  /** `characters` for party codes */
  readonly capitalize?: 'off' | 'characters' | 'words';
  /** Up or Down while typing: the screen moves its focus on, off the field */
  readonly onNavigate?: (input: 'up' | 'down') => void;
  /** The input gained or lost the keyboard (the drawn caret shows only while it has it) */
  readonly onFocusChange?: (focused: boolean) => void;
}

/**
 * A hidden DOM input behind a field the UI draws in pixi, so typing, pasting, IME and the phone's own keyboard all
 * work. Keys typed into it don't reach the game's window listeners, except Escape, which `onEscape` handles.
 */
export class TextField {
  private readonly _input: HTMLInputElement;
  private readonly _options: TextFieldOptions;
  /** The caret goes to the end once the key that moved focus here has done its own default */
  private _caretTimer = 0;

  constructor(options: TextFieldOptions) {
    this._options = options;
    const input = document.createElement('input');

    input.type = 'text';
    input.value = options.value;
    input.maxLength = options.max * 2;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', options.capitalize ?? 'words');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', 'Text');
    input.style.cssText =
      'position:fixed;left:50%;top:40%;width:2px;height:2px;opacity:0;font-size:16px;border:0;padding:0;' +
      'pointer-events:none;caret-color:transparent;background:transparent;color:transparent';
    input.addEventListener('input', this._onInput);
    input.addEventListener('keydown', this._onKey);
    input.addEventListener('focus', this._onFocus);
    input.addEventListener('blur', this._onBlur);
    document.body.appendChild(input);
    this._input = input;
  }

  public get value(): string {
    return this._input.value;
  }

  public set value(v: string) {
    this._input.value = v;
  }

  public get focused(): boolean {
    return document.activeElement === this._input;
  }

  /** Focuses the input; on a phone, call it from a tap so the keyboard opens. */
  public focus(): void {
    const input = this._input;
    const end = (): void => input.setSelectionRange(input.value.length, input.value.length);

    input.focus({ preventScroll: true });
    end();
    // An arrow key that moved focus here goes on to move the caret (Up to the start): put it back at the end after.
    clearTimeout(this._caretTimer);
    this._caretTimer = window.setTimeout(end, 0);
  }

  public blur(): void {
    this._input.blur();
  }

  public destroy(): void {
    clearTimeout(this._caretTimer);
    this._input.removeEventListener('input', this._onInput);
    this._input.removeEventListener('keydown', this._onKey);
    this._input.removeEventListener('focus', this._onFocus);
    this._input.removeEventListener('blur', this._onBlur);
    this._input.remove();
  }

  private readonly _onInput = (): void => {
    const raw = this._input.value;
    const clean = (this._options.clean ? this._options.clean(raw) : raw).slice(0, this._options.max);

    if (clean !== raw) this._input.value = clean;
    this._options.onChange(clean);
  };

  private readonly _onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._options.onEscape?.();
      this._input.blur();

      return;
    }
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      this._options.onEnter?.();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this._options.onNavigate) {
      e.preventDefault();
      this._options.onNavigate(e.key === 'ArrowUp' ? 'up' : 'down');
    }
  };

  private readonly _onFocus = (): void => this._options.onFocusChange?.(true);

  private readonly _onBlur = (): void => this._options.onFocusChange?.(false);
}
