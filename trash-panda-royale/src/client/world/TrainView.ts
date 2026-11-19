import { Container3D, Vector3 } from "@pixi/3d";
import { TRAIN_CARS, TRAIN_COUNT } from "../../shared/constants.js";
import { CITY } from "../../shared/map.js";
import { TRAIN_SLOTS, trainCarPose, trainHead, TRACK_LENGTH, type CarPose } from "../../shared/train.js";
import { find, instance } from "../assets.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

const PAINTS = [[0xff5a5f, 0x2ec4b6, 0xffd166, 0x9b7bff], [0x3d8bff, 0xff9f68, 0x06d6a0, 0xff7eb6]];

/**
 * Trains are drawn from the shared timetable at the render clock: no network
 * traffic at all, yet every client (and the server) agrees where they are.
 */
export class TrainView {
  readonly root = new Container3D({ label: "trains" });
  private cars: Container3D[] = [];
  private smoke: (Container3D | null)[] = [];
  private pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
  private tmp = new Vector3();
  private lastHorn = new Map<string, number>();

  constructor(private fx: Fx) {
    for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
      const t = Math.floor(slot / TRAIN_CARS), i = slot % TRAIN_CARS;
      const m = instance(i === 0 ? "train_loco" : "train_wagon", { recolor: { Paint: PAINTS[t % PAINTS.length][i] } });
      this.root.addChild(m);
      this.cars.push(m);
      this.smoke.push(i === 0 ? find(m, "smoke_socket") : null);
    }
  }

  /** Pose of a train car at the render time (used to place riders). */
  carPose(slot: number, timeMs: number, out: CarPose) {
    return trainCarPose(slot, timeMs, out);
  }

  private pa: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
  private pb: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

  /**
   * A train car's acceleration (world, m/s²) at `timeMs`: exact, from the timetable (zero on
   * the straights, the pull of the curve on the corners). Riders sway with it.
   */
  accel(slot: number, timeMs: number, out: { x: number; z: number }) {
    const h = 40;
    trainCarPose(slot, timeMs - h, this.pa);
    trainCarPose(slot, timeMs + h, this.pb);
    out.x = (this.pb.vx - this.pa.vx) / (2 * h / 1000);
    out.z = (this.pb.vz - this.pa.vz) / (2 * h / 1000);
    return out;
  }

  update(dt: number, timeMs: number) {
    for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
      const p = trainCarPose(slot, timeMs, this.pose);
      const m = this.cars[slot];
      m.position.set(p.x, 0, p.z);
      m.rotation.set(0, p.yaw, 0);
      // a gentle rock
      m.rotation.z = Math.sin(timeMs / 180 + slot) * 0.012;
      const sock = this.smoke[slot];
      if (sock) {
        sock.getGlobalPosition(this.tmp);
        this.fx.smokeTrail(this.tmp.x, this.tmp.y + 0.2, this.tmp.z, dt, 14, 0xf4f4f6);
      }
    }
    // toot at every crossing on approach
    for (let t = 0; t < TRAIN_COUNT; t++) {
      const head = ((trainHead(t, timeMs) % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
      for (const c of CITY.crossings) {
        let d = c.s - head;
        if (d < 0) d += TRACK_LENGTH;
        const key = `${t}:${c.s}`;
        if (d < 45 && d > 35 && (this.lastHorn.get(key) ?? -1e9) < timeMs - 10000) {
          this.lastHorn.set(key, timeMs);
          const p = trainCarPose(t * TRAIN_CARS, timeMs, this.pose);
          sfx.trainHorn(p.x, p.z);
        }
      }
    }
  }
}
