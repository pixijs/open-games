import assert from "assert";
import { checkAssets, MAX_TEXTURES } from "../assets-src/check-assets.mjs";

// The baked GLBs must follow the texture rules (one float VEC2 TEXCOORD_0 per primitive,
// base-colour/emissive textures only, trilinear repeat samplers, external tex/*.png with
// only IHDR/IDAT/IEND) and keep the nodes the game looks up (assets-src/contract.json).
describe("baked assets (public/assets/models)", function () {
  const result = checkAssets({ log: () => {} });

  it("pass assets-src/check-assets.mjs", () => {
    assert.deepStrictEqual(result.errors, [], `asset errors:\n${result.errors.join("\n")}`);
  });

  it("stay within the texture budget", () => {
    assert.ok(result.rows.length > 0, "no GLBs found");
    assert.ok(result.textures.files.length <= MAX_TEXTURES, `${result.textures.files.length} textures`);
    for (const uri of result.textures.used) assert.ok(result.textures.files.includes(uri.slice(4)), `${uri} not in tex/`);
  });
});
