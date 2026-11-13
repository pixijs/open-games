import express from "express";
import {
  createEndpoint,
  createRouter,
  defineServer,
  defineRoom,
  matchMaker,
  monitor,
  playground,
  RedisDriver,
  RedisPresence,
} from "colyseus";
import { uWebSocketsTransport } from "@colyseus/uwebsockets-transport";
import { GameRoom } from "./server/GameRoom.js";

/**
 * Behind a path prefix (as on demos.colyseus.cloud/trash-panda-royale, which pixijs.io
 * connects to): one unix socket per process. The SDK drops its own pathname once a seat
 * reservation carries a publicAddress, so that address must include the prefix, and
 * matchmaking lives in Redis so processes can see each other's rooms.
 */
const publicAddressBase = process.env.PUBLIC_ADDRESS_BASE;
const port = 2567 + Number(process.env.NODE_APP_INSTANCE || "0");

// Wavedash serves the client cross-origin isolated (COEP require-corp): every response
// it reads from us must opt in.
const corsHeaders = matchMaker.controller.getCorsHeaders;
matchMaker.controller.getCorsHeaders = function (headers) {
  return { ...corsHeaders.call(this, headers), "Cross-Origin-Resource-Policy": "cross-origin" };
};

const server = defineServer({
  // uWebSockets.js: cheaper sends and receives than `ws`. (In dev, Vite's own server carries the sockets.)
  transport: process.env.NODE_ENV === "production" ? new uWebSocketsTransport() : undefined,

  ...(publicAddressBase && {
    presence: new RedisPresence(process.env.REDIS_URI),
    driver: new RedisDriver(process.env.REDIS_URI),
    publicAddress: `${publicAddressBase}/${port}`,
  }),

  rooms: {
    town: defineRoom(GameRoom),
  },

  routes: createRouter({
    health: createEndpoint("/health", { method: "GET" }, async () => ({ ok: true })),
  }),

  express: (app) => {
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
      app.use("/playground", playground());
    } else {
      // single-process deploys: serve the built client next to the game server
      app.use(express.static("dist/client"));
    }
  },
});

export default server;

/** Named export read by the `colyseus/vite` plugin's `serverEntry`. */
export { server };
