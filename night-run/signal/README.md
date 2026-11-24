# Night Run signalling Worker

A Cloudflare Worker that helps Night Run's racers find each other. Each player posts an encrypted connection offer here; once the host and a guest have each other's, WebRTC links their browsers directly, and the race's traffic never comes back through Cloudflare. The party's game server is the host's own tab, so this is the only server the game needs.

It holds no secrets and hands out no credentials. Players find their own public address through Cloudflare's free STUN server, which the game names itself. There's no TURN relay, so the few players whose networks block direct links, such as some office, school and mobile networks, can't join a party; they see the Join screen's "unreachable" error, and quick races still work. Adding TURN would mean handing out relay credentials, which anyone could take and run traffic through, so it should only come back behind a bot check such as Turnstile.

It lives beside the game, not in it: the site build never sees this folder, GitHub Pages doesn't deploy it, and the game's own `tsc` leaves it out. It has its own `package.json`, lockfile and TypeScript config with Cloudflare's types.

The dev servers signal through public Nostr relays unless the URL has `?signal=worker`, so a party can be tested without running this Worker. `?signal=local` skips signalling altogether and links the tabs of one browser. A built site uses the Worker at `DEPLOYED_SIGNAL_URL`, empty until you deploy your own. `../src/net/signal.ts` makes the choice.

## Run it locally

From this folder:

```sh
npm install          # Cloudflare's types, for the typecheck
npm run typecheck
npm run dev          # wrangler dev at http://localhost:8787, answering the local servers
```

Open the game's dev server with `?signal=worker` to use it. To try a build against it, build with
`VITE_NIGHTRUN_SIGNAL_URL=http://localhost:8787` and run `npm run preview`.

## Who may call it

`ALLOWED_ORIGINS` in `wrangler.jsonc` lists the pages the Worker answers; any other origin, and a request with none, gets 403 from `/signal`, and every join from it ends in "no party with that code". It ships empty, so a deployed Worker answers nobody until you put your site's origin there. `npm run dev` swaps in the local servers instead, on both `127.0.0.1` and `localhost`: Vite's default dev and preview ports (5173 and 4173) and this game's own `npm run dev` (5350) and `npm run preview` (5351). Keep them out of the deployed list, so a copy of the game running on someone's machine can't use your Worker.

The origin check only stops other websites: a script can send any `Origin` it likes. What holds back a caller who isn't a browser is the limits per network (an IPv4 address, or an IPv6 address's /64): 20 connections a minute (`CONNECT_LIMIT` in `wrangler.jsonc`) and 16 open sockets at once (`MAX_SOCKETS_PER_NETWORK` in `worker.ts`), under 2,000 for everyone.

## Deploy

Run these from this folder with your Cloudflare account. Wrangler is pinned in `package.json`'s scripts and runs through `npx`, so nothing else needs installing.

1. Put your site's origin in `ALLOWED_ORIGINS` in `wrangler.jsonc`.
2. Log in: `npx wrangler@4.145.0 login`.
3. Deploy: `npm run deploy`. It creates the `nightrun-signal` Worker with its Durable Object and prints its URL, such as `https://nightrun-signal.<account>.workers.dev`.
4. Put the URL from step 3 in `DEPLOYED_SIGNAL_URL` in `../src/net/signal.ts`, with no trailing slash, and build. The build bakes it in. A build with `VITE_NIGHTRUN_SIGNAL_URL` set uses that instead, which is handy for trying another Worker from `npm run preview`.

To check it: `curl -i <url>/signal` answers 403, and the same call with `-H 'Origin: <your site>'` answers 404, since it isn't a WebSocket. Then open the deployed game in two browsers, host in one and join with the code in the other.

## Free tier

A 4-player party of about 15 minutes costs about 4 Worker requests and 10 to 20 Durable Object requests. The Workers Free plan allows 100,000 of each a day. The Durable Object sleeps between messages, through the WebSocket Hibernation API, so its duration charge stays near zero.

If a daily limit runs out, new parties can't form until 00:00 UTC. Refused requests count too, so a flood from someone else can run it out; on the Free plan that costs nothing, it only stops online races for the day. Parties already racing carry on, and a quick race never touches the Worker.
