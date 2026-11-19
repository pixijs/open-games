/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Game server for a client hosted apart from it (`.env.client`); unset, the page's own host. */
  readonly VITE_SERVER_URL?: string;
}
