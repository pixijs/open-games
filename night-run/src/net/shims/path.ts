/** Node's `path` for Colyseus in a tab: dev mode resolves a cache file name when it loads */
const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/+/g, '/');

export default { join, resolve: join, sep: '/' };
