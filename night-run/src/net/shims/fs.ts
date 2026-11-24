/** Node's `fs` for Colyseus in a tab: dev mode looks for its cache file, and there never is one */
export default {
  existsSync: (): boolean => false,
  readFileSync(): never {
    throw new Error('fs is not available in the browser');
  },
  writeFileSync(): void {},
};
