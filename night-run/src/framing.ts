/**
 * Where a lens should look so a point sits a given way down the screen, centred across it, then turned about the
 * vertical by `lean`, which moves the point across the screen the other way.
 * @param out - Receives the point to look at, as far from the lens as the subject is.
 * @param lx - The lens, x.
 * @param ly - The lens, y.
 * @param lz - The lens, z.
 * @param fx - The subject, x.
 * @param fy - The subject, y.
 * @param fz - The subject, z.
 * @param down - Where the subject sits down the screen, 0 at the top to 1 at the bottom.
 * @param fov - The lens's vertical field of view, in degrees.
 * @param lean - Radians to turn the view about the vertical; positive turns it toward a larger yaw.
 * @returns `out`.
 */
export function lookToFrame(
  out: [number, number, number],
  lx: number,
  ly: number,
  lz: number,
  fx: number,
  fy: number,
  fz: number,
  down: number,
  fov: number,
  lean = 0,
): [number, number, number] {
  let vx = fx - lx;
  let vy = fy - ly;
  let vz = fz - lz;
  const distance = Math.hypot(vx, vy, vz) || 1;

  vx /= distance;
  vy /= distance;
  vz /= distance;

  // Up, square to the line of sight; tilting toward it lifts the view, so the subject drops down the screen.
  let ux = -vx * vy;
  let uy = 1 - vy * vy;
  let uz = -vz * vy;
  const up = Math.hypot(ux, uy, uz) || 1;

  ux /= up;
  uy /= up;
  uz /= up;

  const tilt = Math.atan(2 * (down - 0.5) * Math.tan((fov * Math.PI) / 360));
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const dx = vx * ct + ux * st;
  const dz = vz * ct + uz * st;
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);

  out[0] = lx + (dx * cl + dz * sl) * distance;
  out[1] = ly + (vy * ct + uy * st) * distance;
  out[2] = lz + (dz * cl - dx * sl) * distance;

  return out;
}

/** Ease an angle toward a range, softly: inside a knee at either end it starts to give, and it never leaves the range. */
function softRange(angle: number, low: number, high: number): number {
  const knee = Math.min(0.12, (high - low) * 0.3);

  if (angle > high - knee) return high - knee + knee * Math.tanh((angle - high + knee) / knee);
  if (angle < low + knee) return low + knee - knee * Math.tanh((low + knee - angle) / knee);

  return angle;
}

/**
 * Turn a view, keeping its lens, just enough that a point stays inside a box on screen: as the point nears the box's
 * edge the view starts to follow it, and the point never crosses the edge.
 * @param look - The point the lens looks at; moved in place, as far from the lens as before.
 * @param lx - The lens, x.
 * @param ly - The lens, y.
 * @param lz - The lens, z.
 * @param fx - The point, x.
 * @param fy - The point, y.
 * @param fz - The point, z.
 * @param fov - The lens's vertical field of view, in degrees.
 * @param aspect - The screen's width over its height.
 * @param left - The box's left edge, 0 at the left of the screen to 1 at the right.
 * @param right - The box's right edge.
 * @param top - The box's top edge, 0 at the top of the screen to 1 at the bottom.
 * @param bottom - The box's bottom edge.
 * @returns `look`.
 */
export function keepInFrame(
  look: [number, number, number],
  lx: number,
  ly: number,
  lz: number,
  fx: number,
  fy: number,
  fz: number,
  fov: number,
  aspect: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
): [number, number, number] {
  // One turn and tilt lands a point from far outside the frame short of the box, the tilt moving it across the screen
  // again; a second lands it.
  turnToBox(look, lx, ly, lz, fx, fy, fz, fov, aspect, left, right, top, bottom);

  return turnToBox(look, lx, ly, lz, fx, fy, fz, fov, aspect, left, right, top, bottom);
}

/** One step of {@link keepInFrame}: turn the view across toward the point, then tilt it up or down toward it. */
function turnToBox(
  look: [number, number, number],
  lx: number,
  ly: number,
  lz: number,
  fx: number,
  fy: number,
  fz: number,
  fov: number,
  aspect: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
): [number, number, number] {
  let ax = look[0] - lx;
  let ay = look[1] - ly;
  let az = look[2] - lz;
  const distance = Math.hypot(ax, ay, az);
  let rx = -az;
  let rz = ax;
  const flat = Math.hypot(rx, rz);

  if (distance < 1e-6 || flat < 1e-6) return look;

  ax /= distance;
  ay /= distance;
  az /= distance;
  rx /= flat;
  rz /= flat;

  // The view's up, square to its line of sight and its right.
  const ux = -rz * ay;
  const uy = rz * ax - rx * az;
  const uz = rx * ay;
  const vx = fx - lx;
  const vy = fy - ly;
  const vz = fz - lz;
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = aspect * tanV;
  const x = vx * rx + vz * rz;
  const y = vx * ux + vy * uy + vz * uz;
  const z = vx * ax + vy * ay + vz * az;
  const across = Math.atan2(x, z);
  const turn = across - softRange(across, Math.atan((2 * left - 1) * tanH), Math.atan((2 * right - 1) * tanH));
  const ct = Math.cos(turn);
  const st = Math.sin(turn);
  // Turned toward the point across the screen, then tilted toward it up or down the screen.
  const bx = ax * ct + rx * st;
  const by = ay * ct;
  const bz = az * ct + rz * st;
  const up = Math.atan2(y, x * st + z * ct);
  const tilt = up - softRange(up, Math.atan((1 - 2 * bottom) * tanV), Math.atan((1 - 2 * top) * tanV));
  const cu = Math.cos(tilt);
  const su = Math.sin(tilt);

  look[0] = lx + (bx * cu + ux * su) * distance;
  look[1] = ly + (by * cu + uy * su) * distance;
  look[2] = lz + (bz * cu + uz * su) * distance;

  return look;
}

/**
 * Whether a point shows inside a box on screen, for a lens looking at a point without roll.
 * @param look - The point the lens looks at.
 * @param lx - The lens, x.
 * @param ly - The lens, y.
 * @param lz - The lens, z.
 * @param px - The point, x.
 * @param py - The point, y.
 * @param pz - The point, z.
 * @param fov - The lens's vertical field of view, in degrees.
 * @param aspect - The screen's width over its height.
 * @param left - The box's left edge, 0 at the left of the screen to 1 at the right.
 * @param right - The box's right edge.
 * @param top - The box's top edge, 0 at the top of the screen to 1 at the bottom.
 * @param bottom - The box's bottom edge.
 */
export function inFrame(
  look: readonly [number, number, number],
  lx: number,
  ly: number,
  lz: number,
  px: number,
  py: number,
  pz: number,
  fov: number,
  aspect: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
): boolean {
  let ax = look[0] - lx;
  let ay = look[1] - ly;
  let az = look[2] - lz;
  const distance = Math.hypot(ax, ay, az);
  let rx = -az;
  let rz = ax;
  const flat = Math.hypot(rx, rz);

  if (distance < 1e-6 || flat < 1e-6) return false;

  ax /= distance;
  ay /= distance;
  az /= distance;
  rx /= flat;
  rz /= flat;

  // The view's up, square to its line of sight and its right.
  const ux = -rz * ay;
  const uy = rz * ax - rx * az;
  const uz = rx * ay;
  const vx = px - lx;
  const vy = py - ly;
  const vz = pz - lz;
  const depth = vx * ax + vy * ay + vz * az;

  if (depth <= 0) return false;

  const tanV = Math.tan((fov * Math.PI) / 360);
  const across = 0.5 + (vx * rx + vz * rz) / (2 * depth * aspect * tanV);
  const down = 0.5 - (vx * ux + vy * uy + vz * uz) / (2 * depth * tanV);

  return across >= left && across <= right && down >= top && down <= bottom;
}
