/**
 * The vite plugin that lets the Colyseus server run in a browser tab: it swaps the Node built-ins
 * `@colyseus/*` imports, and the optional servers it loads on demand, for the small stand-ins in
 * this folder.
 *
 * The swap is scoped to imports made from inside `@colyseus` packages, so every other example
 * resolves exactly as before. Colyseus is pre-bundled, so the same resolver also runs inside
 * vite's dependency optimizer, which doesn't run ordinary plugins. The packages are listed for
 * pre-bundling up front so the first game that goes online doesn't make vite reload the page.
 */

import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite';

const shim = (name: string): string => fileURLToPath(new URL(`./${name}.ts`, import.meta.url));

const SHIMS: Record<string, string> = {
  fs: shim('fs'),
  path: shim('path'),
  'node:path': shim('path'),
  os: shim('os'),
  url: shim('url'),
  'node:crypto': shim('crypto'),
  'node:fs/promises': shim('empty'),
  http: shim('empty'),
  https: shim('empty'),
  'node:http': shim('empty'),
  '@colyseus/redis-presence': shim('empty'),
  '@colyseus/redis-driver': shim('empty'),
  '@pm2/io': shim('empty'),
};

const fromColyseus = (importer: string | undefined): boolean =>
  importer !== undefined && importer.replaceAll('\\', '/').includes('/node_modules/@colyseus/');

const resolver = {
  name: 'colyseus-browser-shims',
  resolveId(source: string, importer: string | undefined): string | null {
    return fromColyseus(importer) ? (SHIMS[source] ?? null) : null;
  },
};

/** Shims Node for `@colyseus/*` in the browser, for `vite.config.ts` */
export function colyseusShims(): Plugin {
  return {
    ...resolver,
    enforce: 'pre',
    config: () => ({
      optimizeDeps: {
        include: [
          '@colyseus/core',
          '@colyseus/schema',
          '@colyseus/sdk',
          'trystero',
          '@trystero-p2p/ws-relay',
          'buffer',
          'events',
        ],
        rolldownOptions: { plugins: [resolver] },
      },
    }),
  };
}
