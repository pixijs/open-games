// Re-bakes every texture (public/assets/models/tex/*.png + src/client/gfx/atlasTown.gen.json),
// every GLB in public/assets/models from the Blender scripts, then the HUD icons
// (public/assets/icons/*.png, rendered from those GLBs + icon-only meshes), meshopt-compresses
// the new GLBs (assets-src/compress-models.mjs), and finally validates the result with
// assets-src/check-assets.mjs.
// Uses $BLENDER, else the default Windows install path, else `blender` on PATH.
// Extra args go to every script: `--only a,b` (each script ignores names it doesn't own;
// build_icons.py also rebuilds icons rendered from a listed model, build_textures.py only
// rebuilds listed texture names), `--no-preview`.
// Every Blender run uses --python-exit-code 1, so a Python exception fails the build.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const candidates = [
  process.env.BLENDER,
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "blender",
].filter(Boolean);
const blender = candidates.find((c) => c === "blender" || existsSync(c));
const args = process.argv.slice(2);

function run(cmd, argv, label) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, argv, { stdio: "inherit" });
  if (r.error) {
    console.error(`✖ ${label}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✖ ${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
}

for (const script of [
  "assets-src/blender/build_textures.py",
  "assets-src/blender/build_characters_props.py",
  "assets-src/blender/build_vehicles_buildings.py",
  "assets-src/blender/build_icons.py",
]) {
  run(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", ...args], script);
}
run(process.execPath, ["assets-src/compress-models.mjs"], "assets-src/compress-models.mjs");
run(process.execPath, ["assets-src/check-assets.mjs"], "assets-src/check-assets.mjs");
