import { ClientState, enqueueClientRaw, getMessageBytes, Protocol } from '@colyseus/core';
import type { ISendOptions } from '@colyseus/core';

import type { WireSocket } from './WireSocket';

/** One player's connection to the room, as Colyseus's `Client` */
export class WireClient {
  public state: ClientState = ClientState.JOINING;
  public reconnectionToken = '';
  public readonly _enqueuedMessages: unknown[] = [];
  public _joinedAt = 0;
  public _numMessagesLastSecond = 0;
  public _messageCountResetsAt = 0;
  public _lastMessageTime = 0;

  constructor(
    public readonly sessionId: string,
    public readonly ref: WireSocket,
  ) {}

  public get readyState(): number {
    return this.ref.readyState;
  }

  public raw(data: Uint8Array, _options?: ISendOptions, cb?: () => void): void {
    this.ref.send(data);
    cb?.();
  }

  public enqueueRaw(data: Uint8Array, options?: ISendOptions): void {
    enqueueClientRaw(this as unknown as Parameters<typeof enqueueClientRaw>[0], data, options);
  }

  public send(type: string | number, message?: unknown, options?: ISendOptions): void {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA, type, message), options);
  }

  public sendBytes(type: string | number, bytes: Uint8Array, options?: ISendOptions): void {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA_BYTES, type, undefined, bytes), options);
  }

  public error(code: number, message = ''): void {
    this.ref.send(getMessageBytes[Protocol.ERROR](code, message));
  }

  public leave(code?: number, reason?: string): void {
    this.ref.close(code, reason);
  }

  public close(code?: number, reason?: string): void {
    this.ref.close(code, reason);
  }
}
