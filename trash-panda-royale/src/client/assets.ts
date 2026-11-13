import { Container3D, Material3D, Mesh3D, Model3D, type BaseMaterial3D, type Scene3DSource } from "@pixi/3d";
import { Assets, Texture, type Matrix } from "pixi.js";

export const MODEL_NAMES = [
  "raccoon", "human",
  "car_hatch", "car_taxi", "car_pest", "car_van", "car_garbage",
  "train_loco", "train_wagon",
  "bld_house", "bld_shop", "bld_apartment", "bld_tower", "bld_donut", "bld_station",
  "tree_round", "tree_pine", "bush", "lamp", "billboard", "billboard_roof", "hydrant", "bench", "drum", "cone", "trashcan",
  "crossing_sign", "crossing_barrier", "fountain", "flowerbed", "fx_star",
  "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade",
  "loot_can", "food_pizza", "food_donut", "coffee", "tombstone", "crown", "dumpster", "trash_bags",
  "bld_demolished", "crane", "bld_collapsed", "bld_shell", "sinkhole",
  "lm_clocktower", "lm_maple", "lm_millyard", "lm_racsign", "lm_mast",
  "gull", "manhole", "dumpster_gold",
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

const sources = new Map<string, Scene3DSource>();
const recolorCache = new Map<string, Material3D>();
/** Copies made for one instance alone: destroyed with it (see `destroyInstance`). */
const owned = new WeakSet<BaseMaterial3D>();
const prepared = new Set<unknown>();
const lowFx = typeof location !== "undefined" && new URLSearchParams(location.search).get("fx") === "low";

/**
 * Tiling textures (the GLBs' and the ground's): repeat, mipmapped, a little anisotropic
 * filtering for walls seen at an angle. Must run before the texture's first upload (WebGL
 * fixes the mip count then): models load while the app is stopped, so it does.
 */
export function prepTexture(t: Texture) {
  const s = t.source;
  if (prepared.has(s)) return;
  prepared.add(s);
  s.style.addressMode = "repeat";
  s.style.maxAnisotropy = lowFx ? 1 : 4;
  s.autoGenerateMipmaps = true;
}

/** A shared texture from the asset pipeline (`public/assets/models/tex/<name>.png`), the same URL the GLBs use. */
export async function loadTexture(name: string): Promise<Texture> {
  try {
    const t = await Assets.load<Texture>({ src: `assets/models/tex/${name}.png`, data: { autoGenerateMipmaps: true } });
    prepTexture(t);
    return t;
  } catch (e) {
    console.warn(`texture ${name} failed to load`, e);
    return Texture.WHITE;
  }
}

/** The tiling textures the ground layers use (made by assets-src/blender/build_textures.py). */
export const GROUND_TEXTURES = ["grass", "paving", "asphalt", "plaza", "lot", "ballast", "wood"] as const;
const groundTex = new Map<string, Texture>();

export async function loadGroundTextures() {
  await Promise.all(GROUND_TEXTURES.map(async (n) => groundTex.set(n, await loadTexture(n))));
}

/** A ground texture, or plain white if it didn't load. */
export const groundTexture = (name: (typeof GROUND_TEXTURES)[number]) => groundTex.get(name) ?? Texture.WHITE;

export async function loadModels(onProgress: (f: number) => void) {
  let done = 0;
  await Promise.all(MODEL_NAMES.map(async (name) => {
    try {
      const url = `assets/models/${name}.glb`;
      let src: Scene3DSource | null = null;
      for (let attempt = 0; !src; attempt++) {
        try {
          src = await Assets.load<Scene3DSource>(url);
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      sources.set(name, src);
      for (const mat of src.materials) {
        // cute assets: never let a glTF default turn them into dark metal
        if (mat instanceof Material3D && mat.metallic > 0.5) mat.metallic = 0;
        // see-through car glass: blended, so cull its back faces (state, not a shader feature)
        if (mat instanceof Material3D && mat.alphaMode === "blend") mat.state.culling = true;
      }
      for (const t of src.textures ?? []) if (t) prepTexture(t);
    } catch (e) {
      console.warn(`model ${name} failed to load`, e);
    }
    onProgress(++done / MODEL_NAMES.length);
  }));
}

export function hasModel(name: string) {
  return sources.has(name);
}

export interface InstanceOptions {
  /** glTF material name → colour. */
  recolor?: Record<string, number>;
  /** glTF material name → UV transform for its textures (say, one shirt pattern out of a strip of them). */
  uv?: Record<string, Matrix>;
  /** Give every material its own emissive-capable copy (hit flashes). */
  unique?: boolean;
  /** Materials (by glTF name) this instance always gets a private copy of, e.g. a face whose expression changes. */
  own?: string[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/**
 * New lightweight instance of a loaded model (shares geometry with the source). Destroy it
 * with `destroyInstance`, which also frees the material copies made for it alone.
 */
export function instance(name: string, opts: InstanceOptions = {}): Container3D {
  const src = sources.get(name);
  if (!src) return new Container3D({ label: `${name}-missing` });
  return new Model3D({
    source: src,
    castShadow: opts.castShadow ?? true,
    receiveShadow: opts.receiveShadow ?? true,
    autoUpdate: false,
    // called once per source material, so meshes that share one share its replacement
    materials: opts.recolor || opts.uv || opts.unique || opts.own ? (mat) => swapMaterial(mat, opts) : undefined,
  });
}

/** What an instance draws instead of source material `mat`: a copy of its own, a shared variant, or `mat`. */
function swapMaterial(mat: BaseMaterial3D, { recolor = {}, uv = {}, unique = false, own }: InstanceOptions): BaseMaterial3D {
  if (!(mat instanceof Material3D)) return mat;
  const name = materialName(mat);
  if (!unique && !own?.includes(name)) return variant(mat, recolor[name], uv[name]);
  // flashable (emissive) copies only for `unique` instances
  const copy = mat.clone({ baseColor: recolor[name], uvTransform: uv[name], emissive: unique && !mat.emissive ? { color: 0x000000, strength: 1 } : undefined });
  owned.add(copy);
  return copy;
}

/** `mat` in `color` and `uv`, one copy shared by every mesh that asks for the same; `mat` itself with neither. */
function variant(mat: Material3D, color: number | undefined, uv?: Matrix): Material3D {
  if (color === undefined && !uv) return mat;
  // per material, not per name: two models' "Wall" can have different textures
  const key = `${mat.uid}:${color}:${uv ? [uv.a, uv.b, uv.c, uv.d, uv.tx, uv.ty].join() : ""}`;
  let m = recolorCache.get(key);
  if (!m) recolorCache.set(key, (m = mat.clone({ baseColor: color, uvTransform: uv })));
  return m;
}

/**
 * Recolours what `root`'s meshes draw now (glTF name → colour): shared materials swap to a
 * shared recoloured copy, as `instance()`'s `recolor` does; the instance's own copies change in place.
 */
export function recolorMeshes(root: Container3D, recolor: Record<string, number>) {
  forEachMesh(root, (mesh) => {
    const mat = mesh.material;
    if (!(mat instanceof Material3D)) return;
    const color = recolor[materialName(mat)];
    if (owned.has(mat)) { if (color !== undefined) mat.baseColor = color; }
    else mesh.material = variant(mat, color);
  });
}

/** Destroys `root` and the material copies made for its instances alone; shared and source materials stay. */
export function destroyInstance(root: Container3D) {
  const mine = new Set<BaseMaterial3D>();
  forEachMesh(root, (m) => { if (owned.has(m.material)) mine.add(m.material); });
  root.destroy({ children: true });
  for (const m of mine) m.destroy();
}

/**
 * A see-through copy of `src` for fading a building out of the camera's way: alpha
 * blended (the alpha is set per frame), with back faces culled: the GLBs are double
 * sided and a blended mesh writes no depth, so its back faces would show through.
 * (It must not write depth either: tilt-shift focuses on the depth buffer, and would
 * blur the player standing behind the faded wall.)
 *
 * Culling goes through the render state, not `doubleSided: false`: on WebGL blending
 * and culling are state, but `doubleSided` is a shader feature. Keeping it means the
 * copy compiles to the very program the opaque building already uses, so the first
 * fade costs no shader compile (that alone was a ~0.7 s freeze).
 */
export function fadeClone(src: Material3D): Material3D {
  const m = src.clone({ alphaMode: "blend", alpha: 1 });
  m.state.culling = true;
  return m;
}

export function forEachMesh(node: Container3D, fn: (m: Mesh3D) => void) {
  if (node instanceof Mesh3D) fn(node);
  for (const c of node.children) forEachMesh(c, fn);
}

export function find(node: Container3D, label: string): Container3D | null {
  return node.getChildByLabel(label, true);
}

/** All materials (deduplicated) used under `node`. */
export function materialsOf(node: Container3D): Material3D[] {
  const out = new Set<Material3D>();
  forEachMesh(node, (m) => { if (m.material instanceof Material3D) out.add(m.material); });
  return [...out];
}

/** A material's name in its glTF file ("" for one made in code): the loader labels them, and copies keep the label. */
export function materialName(m: BaseMaterial3D) {
  return m.label ?? "";
}

