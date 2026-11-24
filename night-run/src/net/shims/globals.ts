/**
 * Everything that has to be in place before any Colyseus module evaluates. `session.ts` imports
 * this first, so ES module order runs it, and what it imports, ahead of `@colyseus/*`:
 *
 * - the Node globals `@colyseus/core` reads at load: `Buffer` for its frame encoder and
 *   `process.env` for its settings;
 * - the `WebSocket` routing in `socket.ts`, because `@colyseus/sdk` keeps the `WebSocket` it finds
 *   when it loads.
 *
 * Timers are left alone: the room's matchmaker runs standalone, so it never calls Node's
 * `unref()` on one.
 */

import '../socket';
import { Buffer } from 'buffer';

const scope = globalThis as { Buffer?: typeof Buffer; process?: { env: Record<string, string | undefined> } };

scope.Buffer ??= Buffer;
scope.process ??= { env: {} };
