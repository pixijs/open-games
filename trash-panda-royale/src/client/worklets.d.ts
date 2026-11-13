/** Vite's `?worker&url`: the worker (here an AudioWorklet module) bundled on its own, and its URL. */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
