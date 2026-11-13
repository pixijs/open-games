/**
 * The town's plan, drawn by hand: the street graph, the set pieces, parks, parking lots and the
 * places nothing gets built. `citygen.ts` fills in the rest (the buildings along every street,
 * their stairs, the street furniture, the loot) from seeded random numbers.
 *
 * North is −z (the minimap's up), east is +x. Inside the ring road (±108), around the plaza at
 * the middle:
 * - NW: Maple Close, a winding lane of gable-roofed houses with a cul-de-sac, and the Crescent,
 *   a half ring of a street around Crescent Park on Main Street.
 * - N: Old Town, small blocks along the skewed Old Mill Road, with the burnt-out shell.
 * - NE: Downtown: towers, Market Street, Trash Alley, the High Line (apartment roofs joined by a
 *   plank and jumps) and the demolition site with its wrecking-ball crane.
 * - SE: Mill Lane, closed to cars by the sinkhole, curving Riverside Drive and Riverside Park.
 * - SW: Raccoon Run, the 45° avenue from the ring's south-west corner to the plaza, the shop row
 *   on Main Street and the collapsed building.
 * The eight level crossings stay where they were: spokes at x = ±22 and z = ±22 run out from the
 * ring road to the map's edge.
 *
 * Six districts (`DISTRICTS`), each with its own look (districts.ts) and a landmark you can see
 * from across town: Maple Close (an autumn suburb; the big maple in its cul-de-sac), Old Town
 * (brick and terracotta; the clock tower on its square), Downtown (glass and concrete; the
 * radio mast on the tower, the crane), the Plaza (bunting and flowers; the fountain), Raccoon Run
 * (graffiti and neon; the raccoon sign on the diagonal) and Millside (rust and gravel; the old
 * mill's chimney and water tower). Their borders run down the middle of streets.
 */
import type { P2 } from "./geom.js";

export interface NodeDef { x: number; z: number; kind?: "culdesac" | "edge" | "dead"; r?: number }
export interface EdgeDef {
  a: string; b: string;
  /** Points between its ends (kinks, curves). */
  via?: [number, number][];
  /** A circular arc around (cx, cz) from a to b instead (the shorter way round unless `long`). */
  arc?: { cx: number; cz: number; long?: boolean };
  /** Half width of the asphalt (0: a footpath), and of each sidewalk. */
  half?: number; walk?: number;
  flags?: number;
  /** Which sides get buildings: "l", "r" (as seen going from a to b), "both" (default), "none". */
  front?: "l" | "r" | "both" | "none";
  name?: string;
}

/** Edge flags. */
export const EDGE_NO_CARS = 1, EDGE_NO_TRAFFIC = 2, EDGE_ALLEY = 4, EDGE_SPOKE = 8, EDGE_RING = 16;

export const NODES: Record<string, NodeDef> = {
  // ring road, clockwise from the north-west corner (rounded at the north corners)
  R_NW1: { x: -108, z: -94 }, R_NW2: { x: -94, z: -108 },
  N_maple: { x: -62, z: -108 }, N_mill: { x: -22, z: -108 }, N_station: { x: 22, z: -108 }, N_market: { x: 82, z: -108 },
  R_NE1: { x: 94, z: -108 }, R_NE2: { x: 108, z: -94 },
  E_tower: { x: 108, z: -66 }, E_main: { x: 108, z: -22 }, E_mill: { x: 108, z: 22 }, E_river: { x: 108, z: 84 },
  SE: { x: 108, z: 108 },
  S_station: { x: 22, z: 108 }, S_m22: { x: -22, z: 108 },
  SW: { x: -108, z: 108 },
  W_elm: { x: -108, z: 66 }, W_canal: { x: -108, z: 22 }, W_main: { x: -108, z: -22 },
  // the spokes' far ends, at the map's edge
  X_wmain: { x: -165, z: -22, kind: "edge" }, X_emain: { x: 165, z: -22, kind: "edge" },
  X_wcanal: { x: -165, z: 22, kind: "edge" }, X_emill: { x: 165, z: 22, kind: "edge" },
  X_nst: { x: 22, z: -165, kind: "edge" }, X_sst: { x: 22, z: 165, kind: "edge" },
  X_nm22: { x: -22, z: -165, kind: "edge" }, X_sm22: { x: -22, z: 165, kind: "edge" },
  // Main Street (z = −22)
  M_cw: { x: -90, z: -22 }, M_ce: { x: -40, z: -22 }, M_mill: { x: 0, z: -22 }, M_st: { x: 22, z: -22 },
  M_alley: { x: 44, z: -22 }, M_market: { x: 70, z: -22 },
  // the Crescent's apex, Maple Close and its cul-de-sac
  A: { x: -65, z: -47 }, K: { x: -62, z: -80 }, CDS: { x: -88, z: -79, kind: "culdesac", r: 9 },
  // Old Mill Road crossing Bakery Lane / Tower Street (z = −66)
  B: { x: -11.256, z: -66 }, ST_bak: { x: 22, z: -66 }, T_alley: { x: 44, z: -66 }, T_mk: { x: 76, z: -66 },
  // south of Main Street
  P: { x: -22, z: 22 }, F_st: { x: 22, z: 22 },
  MILL_W: { x: 56, z: 22, kind: "dead" }, MILL_E: { x: 76, z: 22, kind: "dead" },
  X_elm: { x: -66, z: 66 }, E22: { x: -22, z: 66 }, ST_elm: { x: 22, z: 66 },
};

const RING = { half: 5, walk: 2.5, flags: EDGE_RING };
const SPOKE = { half: 5, walk: 0, flags: EDGE_SPOKE | EDGE_NO_TRAFFIC, front: "none" as const };
const LANE = { half: 4, walk: 2 };

export const EDGES: EdgeDef[] = [
  // ---- the ring road
  { a: "R_NW1", b: "R_NW2", arc: { cx: -94, cz: -94 }, ...RING },
  { a: "R_NW2", b: "N_maple", ...RING }, { a: "N_maple", b: "N_mill", ...RING }, { a: "N_mill", b: "N_station", ...RING },
  { a: "N_station", b: "N_market", ...RING }, { a: "N_market", b: "R_NE1", ...RING },
  { a: "R_NE1", b: "R_NE2", arc: { cx: 94, cz: -94 }, ...RING },
  { a: "R_NE2", b: "E_tower", ...RING }, { a: "E_tower", b: "E_main", ...RING }, { a: "E_main", b: "E_mill", ...RING },
  { a: "E_mill", b: "E_river", ...RING }, { a: "E_river", b: "SE", ...RING },
  { a: "SE", b: "S_station", ...RING }, { a: "S_station", b: "S_m22", ...RING },
  { a: "S_m22", b: "SW", ...RING },
  { a: "SW", b: "W_elm", ...RING }, { a: "W_elm", b: "W_canal", ...RING }, { a: "W_canal", b: "W_main", ...RING },
  { a: "W_main", b: "R_NW1", ...RING },
  // ---- spokes out to the level crossings and the map's edge
  { a: "W_main", b: "X_wmain", ...SPOKE }, { a: "E_main", b: "X_emain", ...SPOKE },
  { a: "W_canal", b: "X_wcanal", ...SPOKE }, { a: "E_mill", b: "X_emill", ...SPOKE },
  { a: "N_station", b: "X_nst", ...SPOKE }, { a: "S_station", b: "X_sst", ...SPOKE },
  { a: "N_mill", b: "X_nm22", ...SPOKE }, { a: "S_m22", b: "X_sm22", ...SPOKE },
  // ---- Main Street
  { a: "W_main", b: "M_cw", name: "Main Street" }, { a: "M_cw", b: "M_ce", name: "Main Street" },
  { a: "M_ce", b: "M_mill", name: "Main Street" }, { a: "M_mill", b: "M_st", name: "Main Street" },
  { a: "M_st", b: "M_alley", name: "Main Street" }, { a: "M_alley", b: "M_market", name: "Main Street" },
  { a: "M_market", b: "E_main", name: "Main Street" },
  // ---- the Crescent and Maple Close
  { a: "M_cw", b: "A", arc: { cx: -65, cz: -22 }, name: "The Crescent" },
  { a: "A", b: "M_ce", arc: { cx: -65, cz: -22 }, name: "The Crescent" },
  { a: "N_maple", b: "K", via: [[-70, -96]], ...LANE, name: "Maple Close" },
  { a: "K", b: "A", via: [[-56, -68], [-63, -57]], ...LANE, name: "Maple Close" },
  { a: "K", b: "CDS", via: [[-75, -85]], ...LANE, flags: EDGE_NO_TRAFFIC, name: "Maple Close" },
  // ---- Old Mill Road, Bakery Lane, Tower Street
  { a: "N_mill", b: "B", half: 4.5, walk: 2.5, name: "Old Mill Road" }, { a: "B", b: "M_mill", half: 4.5, walk: 2.5, name: "Old Mill Road" },
  { a: "B", b: "ST_bak", ...LANE, name: "Bakery Lane" },
  { a: "ST_bak", b: "T_alley", name: "Tower Street" }, { a: "T_alley", b: "T_mk", name: "Tower Street" }, { a: "T_mk", b: "E_tower", name: "Tower Street" },
  // ---- Station Road (x = 22)
  { a: "N_station", b: "ST_bak", name: "Station Road" }, { a: "ST_bak", b: "M_st", name: "Station Road" },
  { a: "M_st", b: "F_st", name: "Station Road", front: "r" }, { a: "F_st", b: "ST_elm", name: "Station Road" },
  { a: "ST_elm", b: "S_station", name: "Station Road" },
  // ---- Market Street, Trash Alley
  { a: "M_market", b: "T_mk", via: [[70, -46]], name: "Market Street" },
  { a: "T_mk", b: "N_market", name: "Market Street" },
  { a: "M_alley", b: "T_alley", half: 0, walk: 1.6, flags: EDGE_ALLEY | EDGE_NO_CARS, front: "none", name: "Trash Alley" },
  // ---- south of Main Street
  { a: "W_canal", b: "P", name: "Canal Lane", ...LANE },
  { a: "P", b: "F_st", name: "Fountain Lane", front: "r" },
  { a: "F_st", b: "MILL_W", ...LANE, flags: EDGE_NO_TRAFFIC, name: "Mill Lane" },
  { a: "MILL_E", b: "E_mill", ...LANE, flags: EDGE_NO_TRAFFIC, name: "Mill Lane" },
  { a: "ST_elm", b: "E_river", via: [[38, 63], [55, 69], [72, 79], [92, 84]], name: "Riverside Drive" },
  { a: "W_elm", b: "X_elm", name: "Elm Street" }, { a: "X_elm", b: "E22", name: "Elm Street" }, { a: "E22", b: "ST_elm", name: "Elm Street" },
  { a: "SW", b: "X_elm", half: 6, walk: 2.5, name: "Raccoon Run" }, { a: "X_elm", b: "P", half: 6, walk: 2.5, name: "Raccoon Run" },
  { a: "P", b: "E22", name: "Plaza Street" }, { a: "E22", b: "S_m22", name: "Plaza Street" },
];

/** A rectangle placed and turned (yaw: its local +z, the side it faces, points along (sin, cos)). */
export interface Placed { x: number; z: number; yaw: number; hx: number; hz: number }

/** The plaza: paved, with the fountain in the middle (nothing built on it). */
export const PLAZA = { minX: -14.5, minZ: -14.5, maxX: 14.5, maxZ: 14.5 };

/** Parks (polygons): lawns with trees, benches, a loot can and a trash can. */
export const PARKS: P2[][] = [
  // Crescent Park: the half disc inside the Crescent, on Main Street
  (() => {
    const pts: P2[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI + (Math.PI * i) / 12;
      const x = -65 + Math.cos(a) * 16.5, z = -22 + Math.sin(a) * 16.5;
      pts.push({ x, z: Math.min(z, -30.5) });
    }
    return pts;
  })(),
  // Wedge Park: the triangle between Raccoon Run, Elm Street and Plaza Street
  [{ x: -44.6, z: 58 }, { x: -30.5, z: 58 }, { x: -30.5, z: 43.9 }],
  // Riverside Park: south of Riverside Drive's bend
  [{ x: 31, z: 74 }, { x: 47, z: 76 }, { x: 62, z: 85 }, { x: 79, z: 93 }, { x: 79, z: 99.5 }, { x: 31, z: 99.5 }],
];

/** Parking lots: rectangles (yaw: the way their bays face), each with a dumpster corner. */
export const LOTS: (Placed & { spots: number })[] = [
  { x: 6, z: 40, yaw: 0, hx: 7, hz: 8.5, spots: 3 },
  { x: -88, z: 40, yaw: 0, hx: 8, hz: 8, spots: 3 },
  { x: 40, z: 2, yaw: 0, hx: 7, hz: 8, spots: 3 },
  { x: -48, z: 3, yaw: 0, hx: 7, hz: 7.5, spots: 2 },
  { x: -42, z: -91, yaw: 0, hx: 6.5, hz: 6, spots: 2 },
];

/** Buildings placed by hand (the High Line: apartment roofs a jump and a plank apart, a fire escape up). */
export interface PlacedBuilding { model: string; x: number; z: number; yaw: number; stairs?: "+X" | "-X"; tint?: number }
export const BUILDINGS: PlacedBuilding[] = [
  { model: "bld_apartment", x: 36, z: -80, yaw: 0 },
  { model: "bld_apartment", x: 52.5, z: -80, yaw: 0, stairs: "+X" },
  { model: "bld_apartment", x: 36, z: -94, yaw: Math.PI },
  // the skyline: a tower downtown (the radio mast on top)
  { model: "bld_tower", x: 54, z: -44, yaw: Math.PI / 2 },
  { model: "bld_apartment", x: 94.2, z: -88, yaw: -Math.PI / 2 },
];

/** The set pieces: the mishaps and the districts' landmarks (see `kit.json`), placed and turned. */
export interface SetPieceDef {
  kind: "demolition" | "collapsed" | "sinkhole" | "shell" | "clocktower" | "maple" | "millyard" | "racsign";
  x: number; z: number; yaw: number;
}
export const SET_PIECES: SetPieceDef[] = [
  { kind: "sinkhole", x: 66, z: 22, yaw: 0 },
  { kind: "demolition", x: 89, z: -44, yaw: 0 },
  { kind: "collapsed", x: -66, z: -4, yaw: Math.PI },
  // facing Old Mill Road (it runs 14° off north-south here)
  { kind: "shell", x: -18.5, z: -41.8, yaw: Math.atan2(0.969, -0.248) },
  // the landmarks: the clock tower on a square between Old Mill Road and Station Road, facing
  // Bakery Lane; the big maple on its island in Maple Close's cul-de-sac; the old mill on Mill
  // Lane, facing it; the raccoon sign in Wedge Park, facing down Raccoon Run both ways
  { kind: "clocktower", x: 4, z: -86, yaw: 0 },
  { kind: "maple", x: -88, z: -79, yaw: 0 },
  { kind: "millyard", x: 42, z: 40, yaw: Math.PI },
  { kind: "racsign", x: -40.2, z: 55.2, yaw: -Math.PI / 4 },
];

/** Downtown's landmark on the tower's roof (its crown's lower step): a radio mast, a red light on top. */
export const MAST = { x: 50, z: -48, y: 25.2 };

export type AreaKey = "maple" | "oldtown" | "downtown" | "plaza" | "run" | "mill";

/**
 * The districts: where each is (its outline runs down the middle of the streets it ends at, out
 * to the town's edge past the ring road) and what gets built along its streets. `row`: the chance
 * a building stands wall to wall with the last; `stairs`: the chance it gets outside stairs;
 * `setback`: extra front garden (m).
 */
export interface District { area: AreaKey; poly: P2[]; mix: Record<string, number>; row?: number; stairs?: number; setback?: number }
const box = (x0: number, z0: number, x1: number, z1: number): P2[] => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const E = 117.5;
/** Maple Close's lane, from the ring road to the Crescent's apex. */
const MAPLE_LANE: P2[] = [{ x: -62, z: -108 }, { x: -70, z: -96 }, { x: -62, z: -80 }, { x: -56, z: -68 }, { x: -63, z: -57 }, { x: -65, z: -47 }];
/** The Crescent's east half, from its apex down to Main Street. */
const CRESCENT_EAST: P2[] = [-75, -60, -45, -30, -15, 0].map((d) => ({ x: -65 + 25 * Math.cos((d * Math.PI) / 180), z: -22 + 25 * Math.sin((d * Math.PI) / 180) }));
export const DISTRICTS: District[] = [
  // west of Maple Close's lane, and the Crescent with its park
  { area: "maple", poly: [{ x: -E, z: -E }, { x: -62, z: -E }, ...MAPLE_LANE, ...CRESCENT_EAST, { x: -E, z: -22 }], mix: { bld_house: 7, bld_shop: 0.4 }, setback: 2.5 },
  // between the lane (and the Crescent) and Station Road
  { area: "oldtown", poly: [{ x: -62, z: -E }, { x: 22, z: -E }, { x: 22, z: -22 }, ...[...CRESCENT_EAST].reverse(), ...[...MAPLE_LANE].reverse()], mix: { bld_shop: 4, bld_donut: 0.5, bld_house: 1.5, bld_apartment: 1 }, row: 0.5, stairs: 0.35 },
  { area: "downtown", poly: box(22, -E, E, -22), mix: { bld_tower: 2, bld_apartment: 4, bld_shop: 2 }, stairs: 0.35 },
  { area: "plaza", poly: box(-E, -22, 22, 22), mix: { bld_shop: 6, bld_donut: 1.4, bld_apartment: 1.5 }, row: 0.55, stairs: 0.35 },
  { area: "run", poly: box(-E, 22, 22, E), mix: { bld_apartment: 3, bld_shop: 2.5, bld_house: 1, bld_donut: 0.6 }, stairs: 0.3 },
  { area: "mill", poly: box(22, -22, E, E), mix: { bld_shop: 3, bld_apartment: 2, bld_house: 0.6, bld_donut: 0.6 }, row: 0.3, stairs: 0.35 },
];

/** Kept open: no buildings, no props (only lamps). The driving tests' open ground, the outer belt's gaps. */
export const KEEP_OPEN: P2[][] = [
  box(84, 96, 128, 128), // the south-east corner, outside the ring (driving tests)
  box(150, -10, 165, 10), // the east edge between the spokes (driving tests)
];

/** Where the start screen's camera looks from (an open spot on the plaza; the menu frames the trash can nearest it). */
export const MENU_SPOT: P2 = { x: -7.2, z: -11.6 };

/**
 * The billboards (PixiJS + Colyseus = AWESOMESAUCE!), facing `yaw` (like `Placed`); the poster
 * is on both sides. On the grass between the ring road and the railway, turned a little toward
 * the traffic; at the back of two parks; and one up on the Downtown tower's crown (`roof`: it
 * stands on whatever roof is under it).
 */
export interface BillboardDef { x: number; z: number; yaw: number; roof?: true }
export const BILLBOARDS: BillboardDef[] = [
  { x: -62, z: -122, yaw: 0.3 }, // north, outside the ring road
  { x: 122, z: -44, yaw: -Math.PI / 2 - 0.3 }, // east
  { x: -122, z: 44, yaw: Math.PI / 2 + 0.3 }, // west
  { x: -61, z: -34, yaw: 0 }, // Crescent Park, over Main Street
  { x: 55, z: 94, yaw: 0 }, // Riverside Park, over the ring road
  { x: 54, z: -42.4, yaw: 0, roof: true }, // the Downtown tower, looking down over Main Street
];
