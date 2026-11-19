import { boot, type ColyseusTestServer } from "@colyseus/testing";
import appConfig from "../src/app.config.ts";

let server: Promise<ColyseusTestServer> | null = null;

/**
 * One Colyseus test server for every test file: booting a second one in the same
 * process (after the first shut down) fails to matchmake.
 */
export function testServer(): Promise<ColyseusTestServer> {
  return (server ??= boot(appConfig as any));
}

// a root hook: runs once, after every test file is done
after(async () => {
  if (server) await (await server).shutdown();
});
