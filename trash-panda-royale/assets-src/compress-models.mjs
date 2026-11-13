// Meshopt-compresses the baked GLBs (public/assets/models) in place, with EXT_meshopt_compression,
// which @pixi/3d decodes as it loads (and three.js, Babylon.js and glTF-Transform read too). Only vertex and index data change: the scene tree, node
// names and transforms, materials and texture URIs stay exactly as Blender wrote them, so the
// game's node lookups and assets-src/contract.json still hold.
//   - positions stay float32 (the game reads them), their precision trimmed by an exponential
//     filter to POSITION_BITS; min/max are recomputed from what decodes;
//   - normals become 8-bit octahedral (KHR_mesh_quantization);
//   - UVs and indices are lossless.
// A GLB already compressed is left alone, so it's safe to rerun (build-assets.mjs does, after
// every bake). usage: node assets-src/compress-models.mjs [dir]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const EXT = "EXT_meshopt_compression";
const QUANT = "KHR_mesh_quantization";
const FLOAT = 5126, BYTE = 5120, USHORT = 5123, UINT = 5125;
/** Mantissa bits kept per position component: under 0.2 mm off across the biggest model. */
const POSITION_BITS = 18;
const NORMAL_BITS = 8;
/** meshopt codec version 0, the one EXT_meshopt_compression allows (KHR_'s v1 saves only ~7% more). */
const VERSION = 0;

const dir = process.argv[2] ?? "public/assets/models";
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);

const align4 = (n) => (n + 3) & ~3;
/** A copy of `u8`'s bytes as floats (the slice of a GLB's BIN chunk isn't float-aligned). */
const floats = (u8) => new Float32Array(u8.slice().buffer);

function readGlb(path) {
  const b = readFileSync(path);
  if (b.toString("latin1", 0, 4) !== "glTF" || b.readUInt32LE(4) !== 2) throw new Error(`${path}: not a glTF 2 GLB`);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString("utf8", 20, 20 + jsonLen));
  const binAt = 20 + jsonLen;
  const bin = binAt < b.length ? new Uint8Array(b.buffer, b.byteOffset + binAt + 8, b.readUInt32LE(binAt)) : new Uint8Array(0);
  return { json, bin };
}

function writeGlb(path, json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLen = align4(text.length), binLen = align4(bin.length);
  const out = Buffer.alloc(12 + 8 + jsonLen + 8 + binLen);
  out.write("glTF", 0, "latin1"); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLen, 12); out.write("JSON", 16, "latin1");
  text.copy(out, 20); out.fill(0x20, 20 + text.length, 20 + jsonLen);
  out.writeUInt32LE(binLen, 20 + jsonLen); out.write("BIN\0", 24 + jsonLen, "latin1");
  Buffer.from(bin.buffer, bin.byteOffset, bin.length).copy(out, 28 + jsonLen);
  writeFileSync(path, out);
}

/** Compresses one GLB; returns its sizes and worst position error, or null if it already was. */
function compress(path) {
  const { json, bin } = readGlb(path);
  if (json.extensionsUsed?.includes(EXT) || json.extensionsUsed?.includes("KHR_meshopt_compression")) return null;
  const file = path.split("/").pop();
  const fail = (msg) => { throw new Error(`${file}: ${msg}`); };
  if ((json.buffers ?? []).length > 1 || json.buffers?.[0]?.uri) fail("expects one embedded buffer");

  // what each accessor holds: a vertex attribute by semantic, or indices
  const role = new Map();
  const setRole = (ai, r) => { if (role.has(ai) && role.get(ai) !== r) fail(`accessor ${ai} is both ${role.get(ai)} and ${r}`); role.set(ai, r); };
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) {
    if (p.targets?.length) fail("morph targets aren't handled");
    for (const [sem, ai] of Object.entries(p.attributes)) setRole(ai, sem);
    if (p.indices !== undefined) setRole(p.indices, "INDICES");
  }
  const users = new Map();
  (json.accessors ?? []).forEach((a, ai) => { if (a.bufferView !== undefined) users.set(a.bufferView, [...(users.get(a.bufferView) ?? []), ai]); });

  const parts = [];
  let binLen = 0, fallbackLen = 0, worst = 0;
  const put = (u8) => { const at = align4(binLen); parts.push([at, u8]); binLen = at + u8.length; return at; };
  /** A view whose data is now `encoded` in the BIN chunk, decoding to `count` × `stride` bytes. */
  const compressedView = (bv, encoded, count, stride, mode, filter, vertexStride) => {
    const view = { buffer: 1, byteOffset: fallbackLen, byteLength: count * stride };
    if (vertexStride) view.byteStride = stride;
    if (bv.target !== undefined) view.target = bv.target;
    view.extensions = { [EXT]: { buffer: 0, byteOffset: put(encoded), byteLength: encoded.length, byteStride: stride, count, mode, filter } };
    fallbackLen = align4(fallbackLen + count * stride);
    return view;
  };

  json.bufferViews = (json.bufferViews ?? []).map((bv, vi) => {
    const src = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const ais = users.get(vi) ?? [];
    const r = ais.length === 1 ? role.get(ais[0]) : undefined;
    // anything that isn't one attribute or index list (none, in these files) goes in as it was
    if (!r) return { ...bv, buffer: 0, byteOffset: put(src) };
    const a = json.accessors[ais[0]];
    if ((a.byteOffset ?? 0) !== 0) fail(`accessor ${ais[0]} doesn't start its view`);
    const n = a.count;

    if (r === "INDICES") {
      const size = a.componentType === UINT ? 4 : a.componentType === USHORT ? 2 : fail(`8-bit indices (accessor ${ais[0]})`);
      if (n % 3) fail(`index count ${n} isn't triangles`);
      const data = src.slice(0, n * size);
      return compressedView(bv, MeshoptEncoder.encodeGltfBuffer(data, n, size, "TRIANGLES", VERSION), n, size, "TRIANGLES", "NONE", false);
    }
    if (a.componentType !== FLOAT || (bv.byteStride ?? 0) > (a.type === "VEC3" ? 12 : 8)) fail(`${r} isn't packed floats`);

    if (r === "POSITION") {
      const f = floats(src.subarray(0, n * 12));
      const encoded = MeshoptEncoder.encodeGltfBuffer(MeshoptEncoder.encodeFilterExp(f, n, 12, POSITION_BITS), n, 12, "ATTRIBUTES", VERSION);
      // what the game will get back: min/max must match it
      const back = new Uint8Array(n * 12);
      MeshoptDecoder.decodeGltfBuffer(back, n, 12, encoded, "ATTRIBUTES", "EXPONENTIAL");
      const d = new Float32Array(back.buffer);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < d.length; i++) {
        const c = i % 3;
        min[c] = Math.min(min[c], d[i]); max[c] = Math.max(max[c], d[i]);
        worst = Math.max(worst, Math.abs(d[i] - f[i]));
      }
      a.min = min; a.max = max;
      return compressedView(bv, encoded, n, 12, "ATTRIBUTES", "EXPONENTIAL", true);
    }
    if (r === "NORMAL") {
      const f = floats(src.subarray(0, n * 12)), xyzw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) xyzw.set(f.subarray(i * 3, i * 3 + 3), i * 4);
      const encoded = MeshoptEncoder.encodeGltfBuffer(MeshoptEncoder.encodeFilterOct(xyzw, n, 4, NORMAL_BITS), n, 4, "ATTRIBUTES", VERSION);
      a.componentType = BYTE; a.normalized = true;
      delete a.min; delete a.max;
      return compressedView(bv, encoded, n, 4, "ATTRIBUTES", "OCTAHEDRAL", true);
    }
    // UVs (and any other float attribute): lossless
    const stride = a.type === "VEC3" ? 12 : a.type === "VEC2" ? 8 : fail(`${r} is a ${a.type}`);
    const data = src.slice(0, n * stride);
    return compressedView(bv, MeshoptEncoder.encodeGltfBuffer(data, n, stride, "ATTRIBUTES", VERSION), n, stride, "ATTRIBUTES", "NONE", true);
  });

  const out = new Uint8Array(align4(binLen));
  for (const [at, u8] of parts) out.set(u8, at);
  json.buffers = [{ byteLength: out.length }, { byteLength: fallbackLen, extensions: { [EXT]: { fallback: true } } }];
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXT, QUANT])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXT, QUANT])];
  const before = readFileSync(path).length;
  writeGlb(path, json, out);
  return { before, after: readFileSync(path).length, worst };
}

let before = 0, after = 0, worst = 0, done = 0, skipped = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".glb")).sort()) {
  const r = compress(join(dir, f));
  if (!r) { skipped++; continue; }
  done++; before += r.before; after += r.after; worst = Math.max(worst, r.worst);
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(done
  ? `compressed ${done} GLBs: ${kb(before)} -> ${kb(after)}; positions within ${(worst * 1000).toFixed(3)} mm${skipped ? `; ${skipped} already were` : ""}`
  : `all ${skipped} GLBs already compressed`);
