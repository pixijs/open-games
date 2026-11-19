import { Client, type Room } from "@colyseus/sdk";
import { cli, type Options } from "@colyseus/loadtest";
import { TICK_RATE, Weapon } from "../src/shared/constants.ts";
import { PlayerInput } from "../src/shared/schema.ts";

/**
 * Wandering bots: each one sends one input per fixed step (like a real client),
 * strolls around, takes the odd pot shot, now and then winds up a stink bomb (if it has one)
 * and sometimes hops into a car.
 */
export async function main(options: Options) {
  const client = new Client(options.endpoint);
  const room: Room = await client.joinOrCreate(options.roomName, { name: `Bot${Math.floor(Math.random() * 900 + 100)}` });
  const input = room.input({ type: PlayerInput });
  let dir = Math.random() * Math.PI * 2;
  let tick = 0;

  const timer = setInterval(() => {
    tick++;
    if (tick % 60 === 0) dir += (Math.random() - 0.5) * 2.5;
    const d = input.data as any;
    d.mx = Math.round(Math.sin(dir) * 100);
    d.mz = Math.round(Math.cos(dir) * 100);
    d.throttle = 100;
    d.steer = tick % 90 < 20 ? 60 : 0;
    d.aim = Math.atan2(Math.sin(dir + 0.4), Math.cos(dir + 0.4));
    d.fire = tick % 45 === 0;
    // held for 12 steps, then let go: a stink bomb about 12 m out
    d.nade = tick % 400 < 12;
    d.sprint = tick % 300 > 150;
    d.jump = tick % 97 === 0;
    d.use = tick % 600 === 300;
    d.weapon = Weapon.Pistol;
    input.send();
  }, 1000 / TICK_RATE);

  room.onLeave(() => clearInterval(timer));
}

cli(main);
