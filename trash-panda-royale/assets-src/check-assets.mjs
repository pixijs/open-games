// Validates every baked GLB in public/assets/models against the engine's texture rules and
// the node contract (assets-src/contract.json).  No dependencies.
//
//   node assets-src/check-assets.mjs        prints a budget report, exits 1 on any error
//   import { checkAssets } from "./check-assets.mjs"   (used by test/assets.test.ts)
//
// Why these rules (@pixi/3d, WebGL): every shader feature combination is its own program
// (0.3-0.8 s to compile).  If every primitive has exactly one float VEC2 TEXCOORD_0, adding a
// baseColor texture costs no new program; vertex colours / tangents / extra UV sets, MASK
// alpha and normal / occlusion / metallicRoughness maps would.  PNGs with gAMA/cHRM/sRGB/
// iCCP chunks render wrong in the engine, and opaque materials need texture alpha = 1.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const MODELS_DIR = join(ROOT, "public", "assets", "models");
export const CONTRACT_PATH = join(HERE, "contract.json");
export const MAX_TEXTURES = 20;
export const PIVOT_TOLERANCE = 0.001; // metres

const FLOAT = 5126;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const REPEAT = 10497;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_ALLOWED = new Set(["IHDR", "IDAT", "IEND"]);

/** Parse a .glb -> { json, bin } (bin = Buffer of the BIN chunk or null). */
export function readGlb(path) {
  const b = readFileSync(path);
  if (b.length < 20 || b.toString("latin1", 0, 4) !== "glTF") throw new Error("not a GLB");
  const version = b.readUInt32LE(4);
  if (version !== 2) throw new Error(`glTF version ${version}`);
  const length = b.readUInt32LE(8);
  let o = 12, json = null, bin = null;
  while (o + 8 <= Math.min(length, b.length)) {
    const len = b.readUInt32LE(o);
    const type = b.toString("latin1", o + 4, o + 8);
    const body = b.subarray(o + 8, o + 8 + len);
    if (type === "JSON") json = JSON.parse(body.toString("utf8"));
    else if (type === "BIN\0") bin = body;
    o += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

/** PNG header + chunk list (no decoding). */
export function readPngInfo(path) {
  const b = readFileSync(path);
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  const chunks = [];
  let o = 8;
  while (o + 8 <= b.length) {
    const len = b.readUInt32BE(o);
    chunks.push(b.toString("latin1", o + 4, o + 8));
    o += 12 + len;
  }
  return {
    width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25],
    interlace: b[28], chunks, bytes: b.length,
  };
}

// ---- tiny 4x4 column-major matrix helpers (glTF conventions) ---------------------------------
function trs(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}

/** name -> world-space position (glTF space) of every node reachable from the scene. */
export function nodeWorldPositions(json) {
  const out = new Map();
  const nodes = json.nodes ?? [];
  const isChild = new Set(nodes.flatMap((n) => n.children ?? []));
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i).filter((i) => !isChild.has(i));
  const visit = (i, parent) => {
    const m = mul(parent, trs(nodes[i]));
    if (nodes[i].name !== undefined) out.set(nodes[i].name, [m[12], m[13], m[14]]);
    for (const c of nodes[i].children ?? []) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of roots) visit(r, I);
  return out;
}

function loadContract(path) {
  if (!existsSync(path)) return { models: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Check every GLB (and every PNG in tex/).  Returns { ok, errors, rows, textures }.
 * opts: { modelsDir, contractPath, log } (log = console.log by default; pass () => {} to silence).
 */
export function checkAssets(opts = {}) {
  const modelsDir = opts.modelsDir ?? MODELS_DIR;
  const contract = loadContract(opts.contractPath ?? CONTRACT_PATH);
  const log = opts.log ?? console.log;
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  // ---- textures on disk -----------------------------------------------------------------------
  const texDir = join(modelsDir, "tex");
  const pngFiles = existsSync(texDir) ? readdirSync(texDir).filter((f) => /\.png$/i.test(f)).sort() : [];
  const otherFiles = existsSync(texDir) ? readdirSync(texDir).filter((f) => !/\.png$/i.test(f)) : [];
  for (const f of otherFiles) err(`tex/${f}`, "only .png files belong in tex/");
  const pngInfo = new Map();
  let texBytes = 0;
  for (const f of pngFiles) {
    const where = `tex/${f}`;
    let info;
    try { info = readPngInfo(join(texDir, f)); } catch (e) { err(where, e.message); continue; }
    pngInfo.set(`tex/${f}`, info);
    texBytes += info.bytes;
    const extra = info.chunks.filter((c) => !PNG_ALLOWED.has(c));
    if (extra.length) err(where, `PNG chunks other than IHDR/IDAT/IEND: ${[...new Set(extra)].join(", ")}`);
    if (info.chunks[0] !== "IHDR" || info.chunks[info.chunks.length - 1] !== "IEND") err(where, "malformed chunk order");
    if (info.bitDepth !== 8) err(where, `bit depth ${info.bitDepth} (must be 8)`);
    if (![0, 2, 4, 6].includes(info.colorType)) err(where, `colour type ${info.colorType} (grey, RGB, grey+alpha or RGBA only)`);
    if (info.interlace !== 0) err(where, "interlaced PNG");
    for (const [k, v] of [["width", info.width], ["height", info.height]]) {
      if (v > 1024 || v < 1 || (v & (v - 1)) !== 0) err(where, `${k} ${v} is not a power of two <= 1024`);
    }
  }

  // ---- models -----------------------------------------------------------------------------------
  const glbs = existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => f.endsWith(".glb")).sort() : [];
  if (!glbs.length) err(modelsDir, "no .glb files");
  const rows = [];
  const usedUris = new Set();
  for (const file of glbs) {
    const model = file.replace(/\.glb$/, "");
    let json;
    try { ({ json } = readGlb(join(modelsDir, file))); } catch (e) { err(file, e.message); continue; }
    const acc = json.accessors ?? [];
    const meshes = json.meshes ?? [];
    const materials = json.materials ?? [];
    const textures = json.textures ?? [];
    const images = json.images ?? [];

    // primitives: exactly one float VEC2 TEXCOORD_0, no COLOR_n / TANGENT
    meshes.forEach((mesh, mi) => (mesh.primitives ?? []).forEach((p, pi) => {
      const where = `${file} mesh "${mesh.name ?? mi}" primitive ${pi}`;
      const names = Object.keys(p.attributes ?? {});
      const uvs = names.filter((a) => a.startsWith("TEXCOORD_"));
      if (uvs.length !== 1 || uvs[0] !== "TEXCOORD_0") err(where, `needs exactly one TEXCOORD_0, has [${uvs.join(", ")}]`);
      else {
        const a = acc[p.attributes.TEXCOORD_0];
        if (!a || a.componentType !== FLOAT || a.type !== "VEC2" || a.normalized) {
          err(where, `TEXCOORD_0 must be float VEC2 (componentType ${a?.componentType}, type ${a?.type})`);
        }
      }
      for (const a of names) if (a.startsWith("COLOR_") || a === "TANGENT") err(where, `has ${a}`);
      if (p.targets?.length) err(where, "has morph targets");
      if (p.mode !== undefined && p.mode !== 4) err(where, `primitive mode ${p.mode} (triangles only)`);
    }));

    // materials: double sided, no MASK, base colour / emissive textures only
    const texUse = new Map(); // texture index -> [{ material, opaque }]
    materials.forEach((m, i) => {
      const where = `${file} material "${m.name ?? i}"`;
      if (m.doubleSided !== true) err(where, "not doubleSided");
      if (m.alphaMode === "MASK") err(where, "alphaMode MASK");
      for (const k of ["normalTexture", "occlusionTexture"]) if (m[k]) err(where, `has ${k}`);
      if (m.pbrMetallicRoughness?.metallicRoughnessTexture) err(where, "has metallicRoughnessTexture");
      if (m.extensions && /"index"\s*:/.test(JSON.stringify(m.extensions))) err(where, "textures inside material extensions");
      const opaque = m.alphaMode === undefined || m.alphaMode === "OPAQUE";
      for (const ti of [m.pbrMetallicRoughness?.baseColorTexture, m.emissiveTexture]) {
        if (!ti) continue;
        if ((ti.texCoord ?? 0) !== 0) err(where, `texture uses TEXCOORD_${ti.texCoord}`);
        if (ti.extensions?.KHR_texture_transform) err(where, "KHR_texture_transform");
        if (!texUse.has(ti.index)) texUse.set(ti.index, []);
        texUse.get(ti.index).push({ material: m.name ?? String(i), opaque });
      }
    });

    // samplers: trilinear, repeat (or omitted wrap)
    (json.samplers ?? []).forEach((s, i) => {
      const where = `${file} sampler ${i}`;
      if (s.magFilter !== LINEAR || s.minFilter !== LINEAR_MIPMAP_LINEAR) {
        err(where, `filters ${s.magFilter}/${s.minFilter} (need ${LINEAR}/${LINEAR_MIPMAP_LINEAR})`);
      }
      for (const k of ["wrapS", "wrapT"]) if (s[k] !== undefined && s[k] !== REPEAT) err(where, `${k} ${s[k]} (omit or ${REPEAT})`);
    });
    textures.forEach((t, i) => {
      if (t.sampler === undefined) err(`${file} texture ${i}`, "no sampler (filters undefined)");
      if (t.extensions) err(`${file} texture ${i}`, `extensions ${Object.keys(t.extensions).join(", ")}`);
    });

    // images: external tex/*.png only
    const imgUris = [];
    images.forEach((im, i) => {
      const where = `${file} image "${im.name ?? i}"`;
      if (im.bufferView !== undefined) { err(where, "embedded in the GLB (bufferView); run externalize_images()"); return; }
      if (typeof im.uri !== "string" || !im.uri.startsWith("tex/") || im.uri.includes("..")) { err(where, `uri ${im.uri} is not under tex/`); return; }
      if (!existsSync(join(modelsDir, im.uri))) { err(where, `missing file ${im.uri}`); return; }
      usedUris.add(im.uri);
      imgUris.push(im.uri);
    });
    for (const [ti, uses] of texUse) {
      const t = textures[ti];
      const im = t ? images[t.source] : undefined;
      if (!im) { err(`${file} texture ${ti}`, "missing image"); continue; }
      const info = pngInfo.get(im.uri);
      if (info && (info.colorType === 4 || info.colorType === 6)) {
        for (const u of uses.filter((x) => x.opaque)) err(`${file} material "${u.material}"`, `opaque material uses ${im.uri} with an alpha channel`);
      }
    }

    // node contract (names + pivots in glTF space)
    const want = contract.models?.[model];
    if (want) {
      const pos = nodeWorldPositions(json);
      for (const n of want.nodes ?? []) if (!pos.has(n)) err(`${file}`, `required node "${n}" missing`);
      for (const [n, p] of Object.entries(want.pivots ?? {})) {
        const q = pos.get(n);
        if (!q) { if (!(want.nodes ?? []).includes(n)) err(file, `pivot node "${n}" missing`); continue; }
        const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (d > PIVOT_TOLERANCE) err(file, `node "${n}" pivot ${q.map((v) => v.toFixed(4)).join(",")} != contract ${p.join(",")} (off ${(d * 1000).toFixed(1)} mm)`);
      }
    }

    // budget numbers: unique vertices (memory), draw calls / triangles per instance
    let vertices = 0, primitives = 0, triangles = 0;
    meshes.forEach((mesh) => {
      const seen = new Set();
      for (const p of mesh.primitives ?? []) {
        if (!seen.has(p.attributes.POSITION)) { seen.add(p.attributes.POSITION); vertices += acc[p.attributes.POSITION]?.count ?? 0; }
      }
    });
    for (const n of json.nodes ?? []) {
      if (n.mesh === undefined) continue;
      for (const p of meshes[n.mesh]?.primitives ?? []) {
        primitives++;
        triangles += Math.floor((p.indices !== undefined ? acc[p.indices]?.count : acc[p.attributes.POSITION]?.count) / 3) || 0;
      }
    }
    rows.push({ model, bytes: statSync(join(modelsDir, file)).size, vertices, primitives, triangles, images: imgUris });
  }
  for (const model of Object.keys(contract.models ?? {})) {
    if (!glbs.includes(`${model}.glb`)) err(`${model}.glb`, "listed in contract.json but missing");
  }
  for (const uri of usedUris) if (!pngInfo.has(uri)) err(uri, "referenced but not a checked tex/*.png");
  const distinct = new Set([...pngInfo.keys(), ...usedUris]);
  if (distinct.size > MAX_TEXTURES) err("tex/", `${distinct.size} distinct textures (max ${MAX_TEXTURES})`);

  // ---- report ---------------------------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  log("model                     bytes   verts  prims   tris  textures");
  let tb = 0, tv = 0, tp = 0, tt = 0;
  for (const r of rows) {
    tb += r.bytes; tv += r.vertices; tp += r.primitives; tt += r.triangles;
    log(`${pad(r.model, 20)}${lpad(r.bytes, 10)}${lpad(r.vertices, 8)}${lpad(r.primitives, 7)}${lpad(r.triangles, 7)}  ${r.images.map((u) => u.slice(4, -4)).join(" ")}`);
  }
  log(`${pad("TOTAL " + rows.length + " GLBs", 20)}${lpad(tb, 10)}${lpad(tv, 8)}${lpad(tp, 7)}${lpad(tt, 7)}`);
  log(`textures: ${distinct.size} distinct (max ${MAX_TEXTURES}), tex/ = ${pngFiles.length} PNGs, ${(texBytes / 1024).toFixed(1)} KB; used by GLBs: ${[...usedUris].sort().join(", ") || "none"}`);
  if (errors.length) {
    log(`\n✖ ${errors.length} asset error(s):`);
    for (const e of errors) log(`  - ${e}`);
  } else {
    log("✔ assets OK");
  }
  return { ok: errors.length === 0, errors, rows, textures: { files: pngFiles, used: [...usedUris].sort(), bytes: texBytes } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = checkAssets();
  process.exit(r.ok ? 0 : 1);
}
