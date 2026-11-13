/**
 * Collider templates for the models the town is built from (`kit.json`, which the Blender
 * scripts read too): each in its model's own frame (glTF: +Z out of its front, +X its left).
 * `placeParts` in map.ts turns them into the town's boxes and ramps.
 */
import data from "./kit.json";

/** A box: centre (x, z), half sizes, its top, and (floating) its underside. */
export interface PartBox { x: number; z: number; hx: number; hz: number; top: number; base?: number; grab?: false; tag?: string }

/**
 * A ramp rising toward +z (`dir` 1) or −z (−1), from `lo` to `hi` (see `Ramp` in map.ts); with
 * `ax` "x", toward +x or −x instead. `hz` is always its half length along the way it rises.
 */
export interface PartRamp {
  x: number; z: number; hx: number; hz: number; dir: 1 | -1; lo: number; hi: number; ax?: "x";
  solid?: boolean; thick?: number; stairs?: boolean; tag?: string;
}

/** A hole in the ground (see `Pit` in map.ts). */
export interface PartPit { x: number; z: number; hx: number; hz: number; floor: number }

export interface PartSet { boxes?: PartBox[]; ramps?: PartRamp[]; pits?: PartPit[] }

/**
 * A model drawn at (x, z) turned by `yaw`, in a set piece's frame. With `fade` ([hx, hz, height,
 * and optionally its middle's offset from the model's origin]: the footprint of what hides a
 * raccoon) it fades out of the camera's way like a building; `roof`: where you stand on top of
 * it (up there it's the floor, never in the way); `tint`: a prop's paint (`Placement.tint`).
 */
export interface PartModel { model: string; x: number; z: number; yaw: number; fade?: number[]; roof?: number; tint?: number }

/** A mishap: its colliders, its models, whole buildings that come with it, trash cans, and the ground it keeps clear. */
export interface SetPieceKit extends PartSet {
  models?: PartModel[];
  buildings?: PartModel[];
  bins?: { x: number; z: number }[];
  keep: { x?: number; z?: number; hx: number; hz: number };
}

export interface BuildingKit extends PartSet {
  /** Where you stand on its roof (its main walkable height). */
  roof: number;
  /** Its stairs (or fire escape) up the +X side (mirrored for −X), and how much room beside the wall they need (m). */
  stairs?: PartSet & { need: number };
}

export const KIT = data as unknown as { buildings: Record<string, BuildingKit>; setpieces: Record<string, SetPieceKit> };
