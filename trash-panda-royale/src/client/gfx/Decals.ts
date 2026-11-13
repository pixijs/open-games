import { Material3D, Mesh3D, PlaneGeometry } from "@pixi/3d";
import { Rectangle, Texture } from "pixi.js";
import atlas from "./atlasTown.gen.json";
import { loadTexture } from "../assets.js";

/** A picture in the town atlas (posters, graffiti, ground markings…). */
export type DecalCell = keyof typeof atlas.cells;

const CELLS = atlas.cells as Record<string, { u0: number; v0: number; u1: number; v1: number; aspect: number }>;

let atlasTexture: Texture = Texture.WHITE;

/**
 * The decal sheet: the town atlas's ground markings and graffiti again, painted over
 * transparency (posters stay opaque paper), laid out exactly like `atlas_town` so its cell
 * UVs apply. The GLBs keep the opaque atlas; these are drawn blended.
 */
export async function loadDecalAtlas() {
  atlasTexture = await loadTexture("decals");
}

export const decalAtlas = () => atlasTexture;

/** UV rectangle of a cell (glTF space: v down), and its width / height. */
export function decalCell(cell: DecalCell) {
  return CELLS[cell];
}

const materials = new Map<string, Material3D>();

/**
 * The material for `cell`: its frame of the decal sheet, blended (graffiti is sprayed
 * straight on the wall). Frames of one sheet share its source, so every decal in town is
 * one instanced draw. Double-sided like every GLB material, and blending is render state,
 * not a shader feature: it compiles to the program the buildings already use.
 */
export function decalMaterial(cell: DecalCell): Material3D {
  let m = materials.get(cell);
  if (!m) {
    const c = CELLS[cell], src = atlasTexture.source;
    const frame = atlasTexture === Texture.WHITE ? atlasTexture
      : new Texture({ source: src, frame: new Rectangle(c.u0 * src.width, c.v0 * src.height, (c.u1 - c.u0) * src.width, (c.v1 - c.v0) * src.height) });
    m = new Material3D({ baseColor: 0xffffff, baseColorTexture: frame, roughness: 0.85, metallic: 0, doubleSided: true, alphaMode: "blend" });
    materials.set(cell, m);
  }
  return m;
}

/** A decal `height` metres tall (width from the cell's aspect), facing +Z of its parent. */
export function decal(cell: DecalCell, height: number): Mesh3D {
  const mesh = new Mesh3D({ geometry: PlaneGeometry.spriteQuad, material: decalMaterial(cell), castShadow: false, receiveShadow: true });
  mesh.scale.set(height * CELLS[cell].aspect, height, 1);
  return mesh;
}
