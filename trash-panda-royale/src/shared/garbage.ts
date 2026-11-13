/**
 * Garbage Day's geometry, shared: where the garbage truck puts the golden dumpster down, and the
 * dumpster as the shared step sees it (see `GarbageDay` on the server).
 */
import { CAR_GARBAGE, DUMPSTER_H, DUMPSTER_HD, DUMPSTER_HW } from "./constants.js";
import { CRATE_ID, type SeenCar } from "./sim.js";

/** The dumpster goes down this far right of the lane's middle (m), level with the truck's lift (this far back of its middle). */
const DUMP_RIGHT = 2.0, DUMP_BACK = 0.8;

/**
 * Where a truck at (x, z) facing `yaw` puts the dumpster down: by the kerb on its right, level with
 * its lift, lying along the street and facing across it (its front, with the emblem, to the road).
 */
export function dumpSpot(x: number, z: number, yaw: number) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // (local +X is a car's left: its right is −X)
  const rx = -Math.cos(yaw), rz = Math.sin(yaw);
  return { x: x + rx * DUMP_RIGHT - fx * DUMP_BACK, z: z + rz * DUMP_RIGHT - fz * DUMP_BACK, yaw: yaw + Math.PI / 2 };
}

/** The golden dumpster at (g.x, g.z), as the shared step sees it: a solid box with a top to stand on. */
export function crateOf(g: { x: number; z: number; yaw: number }): SeenCar {
  return {
    id: CRATE_ID, kind: CAR_GARBAGE, driven: false, wreck: true,
    x: g.x, z: g.z, yaw: g.yaw, vx: 0, vz: 0, halfW: DUMPSTER_HW, halfL: DUMPSTER_HD, roof: DUMPSTER_H,
  };
}
