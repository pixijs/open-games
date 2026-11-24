import { EventEmitter } from 'events';

import type { Wire } from './wire';

/** A socket over a wire, in the shape Colyseus expects of a `ws` socket */
export class WireSocket extends EventEmitter {
  public readyState = 1;

  constructor(
    private readonly _wire: Wire,
    private readonly _sid: number,
  ) {
    super();
  }

  public send(data: Uint8Array): void {
    if (this.readyState === 1) this._wire.sendBin(this._sid, data);
  }

  public close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this._wire.sendCtl({ t: 'close', sid: this._sid, code, reason });
    this.closed(code, reason);
  }

  /** The socket is gone, closed by the player or by its wire */
  public closed(code: number, reason: string): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}
