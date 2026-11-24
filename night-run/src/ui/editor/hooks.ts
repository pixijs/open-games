/**
 * `window.__editor`, for harnesses: the open editor's document, its status, code and history, why it can't be raced,
 * and where each board cell is on the page, so a harness can press real pointer events on cells. Nothing in the game
 * calls it.
 */

import type { DocStatus, TrackDoc } from '../../track/doc';
import { EMPTY_DOC } from '../../track/doc';
import { registerTestHook } from '../../testHooks';

/** What the hook reads off the editor screen. */
export interface EditorView {
  readonly doc: TrackDoc;
  readonly docStatus: DocStatus;
  readonly code: string;
  readonly name: string;
  readonly historyCounts: { undo: number; redo: number };
  readonly reason: string;
  readonly boardState: { loupe: boolean; bubble: string; refusals: { cross: number; edge: number } };
  cellToClient(bx: number, by: number): { x: number; y: number };
  clientToCell(x: number, y: number): { bx: number; by: number } | null;
}

let active: EditorView | null = null;

/**
 * The editor showing now, or null as it closes.
 * @param editor - The screen.
 */
export function setActiveEditor(editor: EditorView | null): void {
  active = editor;
}

/** Puts `window.__editor` up. */
export function installEditorHooks(): void {
  registerTestHook('__editor', {
    get open(): boolean {
      return active !== null;
    },
    get doc(): TrackDoc {
      return active?.doc ?? EMPTY_DOC;
    },
    get status(): DocStatus | null {
      return active?.docStatus ?? null;
    },
    get code(): string {
      return active?.code ?? '';
    },
    get name(): string {
      return active?.name ?? '';
    },
    get history(): { undo: number; redo: number } {
      return active?.historyCounts ?? { undo: 0, redo: 0 };
    },
    /** Why the track can't be raced, as it shows beside Race it; '' once it can. */
    get reason(): string {
      return active?.reason ?? '';
    },
    /** The loupe showing, the bubble's last line and the refusals shown so far. */
    get board(): { loupe: boolean; bubble: string; refusals: { cross: number; edge: number } } | null {
      return active?.boardState ?? null;
    },
    /** CSS px of a board cell's centre, after the board's turn on a tall phone. */
    cellToClient(bx: number, by: number): { x: number; y: number } | null {
      return active?.cellToClient(bx, by) ?? null;
    },
    clientToCell(x: number, y: number): { bx: number; by: number } | null {
      return active?.clientToCell(x, y) ?? null;
    },
  });
}
