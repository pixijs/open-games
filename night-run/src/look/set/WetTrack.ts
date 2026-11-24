import type { BaseMaterial3D, Container3D, Material3DData, ShaderBit } from '@pixi/3d';
import { Material3D, Mesh3D } from '@pixi/3d';
import { Texture } from 'pixi.js';

/** Soaked grass at night: dark, with a soft sheen. */
const GROUND_COLOR = 0x1d2f1f;
const GROUND_ROUGHNESS = 0.55;

/**
 * How much of the road is puddle, and how hard the raindrop rings tilt the water. Both match the wet-road
 * reflection's (`WetReflection` in the look, set by `LensRig`), whose mask and rings this material repeats, so a
 * puddle that mirrors the scene also catches the lights as one.
 */
const PUDDLE_COVER = 0.6;
const RIPPLE_STRENGTH = 0.15;

// Per palette surface: albedo multiplier (wet surfaces darken) and roughness.
const ASPHALT = { dark: 0.78, roughness: 0.3 };
const FOLIAGE = { dark: 0.3, roughness: 0.5 };
const PAINT = { dark: 0.8, roughness: 0.24 };

const PUDDLE_GPU = /*wgsl*/ `
fn wetHash(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn wetNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(wetHash(i), wetHash(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(wetHash(i + vec2<f32>(0.0, 1.0)), wetHash(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y
  );
}

// One raindrop ring per cell of a world-space grid, each on its own rate and phase: the tilt it adds.
fn wetRipple(p: vec2<f32>, cell: f32, t: f32, seed: f32) -> vec2<f32> {
  let q = p / cell + seed;
  let id = floor(q);
  let d = fract(q) - 0.5 - (vec2<f32>(wetHash(id + 3.7), wetHash(id + 9.2)) - 0.5) * 0.24;
  let h = wetHash(id + seed);
  let phase = fract(t * (0.8 + h * 0.7) + h * 13.0);
  let r = length(d);
  let x = (r - phase * 0.34) * 26.0;
  let fade = (1.0 - phase) * (1.0 - phase);

  return d / max(r, 1e-3) * (x * exp(-x * x) * fade);
}
`;

const PUDDLE_GL = /*glsl*/ `
float wetHash(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float wetNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), u.x),
    mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

vec2 wetRipple(vec2 p, float cell, float t, float seed) {
  vec2 q = p / cell + seed;
  vec2 id = floor(q);
  vec2 d = fract(q) - 0.5 - (vec2(wetHash(id + 3.7), wetHash(id + 9.2)) - 0.5) * 0.24;
  float h = wetHash(id + seed);
  float phase = fract(t * (0.8 + h * 0.7) + h * 13.0);
  float r = length(d);
  float x = (r - phase * 0.34) * 26.0;
  float fade = (1.0 - phase) * (1.0 - phase);

  return d / max(r, 1e-3) * (x * exp(-x * x) * fade);
}
`;

const COVER = ((PUDDLE_COVER - 0.5) * 0.5).toFixed(4);
const RINGS = RIPPLE_STRENGTH.toFixed(4);

/**
 * Standing water on flat asphalt, which the red channel of the roughness map marks: world-space noise picks the
 * pools, which go near-mirror and a shade darker, and raindrop rings on two grids tilt their surface. The rings run
 * on `wetTime`, so they stop dead when the world does.
 */
const puddleBit: ShaderBit = {
  name: 'racing-puddles',
  bindings: { material: { wetTime: 'f32' } },
  gpu: {
    header: PUDDLE_GPU,
    fragment: {
      material: /*wgsl*/ `
  let wetFlat = mrTex.r * smoothstep(0.9, 0.98, normal.y);

  if (wetFlat > 0.0) {
    let wetXz = input.vPosition.xz;
    let wetN = wetNoise(wetXz * 0.45) * 0.65 + wetNoise(wetXz * 1.3 + 17.0) * 0.35;
    let wetPuddle = smoothstep(0.56, 0.64, wetN + ${COVER}) * wetFlat;
    // The rings fade out with distance before they're small enough to sparkle.
    let wetNear = 1.0 - smoothstep(3.0, 12.0, length(camera.uCameraPosition - input.vPosition));
    let wetTilt = (wetRipple(wetXz, 0.16, material.wetTime, 0.0) + wetRipple(wetXz, 0.11, material.wetTime * 1.13, 7.31))
      * (${RINGS} * mix(0.15, 1.0, wetPuddle) * wetFlat * wetNear);

    roughness = mix(roughness, 0.08, wetPuddle);
    albedo *= 1.0 - 0.3 * wetPuddle;
    normal = normalize(normal - vec3<f32>(wetTilt.x, 0.0, wetTilt.y));
    specularNormal = normal;
  }
`,
    },
  },
  gl: {
    fragment: {
      header: PUDDLE_GL,
      material: /*glsl*/ `
  float wetFlat = mrTex.r * smoothstep(0.9, 0.98, normal.y);

  if (wetFlat > 0.0) {
    vec2 wetXz = vPosition.xz;
    float wetN = wetNoise(wetXz * 0.45) * 0.65 + wetNoise(wetXz * 1.3 + 17.0) * 0.35;
    float wetPuddle = smoothstep(0.56, 0.64, wetN + ${COVER}) * wetFlat;
    float wetNear = 1.0 - smoothstep(3.0, 12.0, length(uCameraPosition - vPosition));
    vec2 wetTilt = (wetRipple(wetXz, 0.16, material.wetTime, 0.0) + wetRipple(wetXz, 0.11, material.wetTime * 1.13, 7.31))
      * (${RINGS} * mix(0.15, 1.0, wetPuddle) * wetFlat * wetNear);

    roughness = mix(roughness, 0.08, wetPuddle);
    albedo *= 1.0 - 0.3 * wetPuddle;
    normal = normalize(normal - vec3(wetTilt.x, 0.0, wetTilt.y));
    specularNormal = normal;
  }
`,
    },
  },
};

/**
 * Soaks the track. The Kenney pieces and decorations all paint from one palette texture, so a single replacement
 * material covers the lot: a darkened copy of the palette, and a roughness map that sorts each palette texel into
 * asphalt (near-mirror, with puddles), foliage (dull) or paint (glossy). The ground plane turns to dark wet grass.
 *
 * {@link WetTrack.destroy} puts the original materials back.
 */
export class WetTrack {
  /** Seconds the raindrop rings have run. */
  public time = 0;

  private readonly _material: Material3D | null = null;
  private readonly _albedo: Texture | null = null;
  private readonly _roughness: Texture | null = null;
  private readonly _meshes: Mesh3D[] = [];
  private readonly _originals: BaseMaterial3D[] = [];
  private readonly _ground: Mesh3D;
  private readonly _groundColor: number = 0;
  private readonly _groundRoughness: number = 0;

  /**
   * @param group - The track pieces and decorations.
   * @param ground - The ground plane.
   */
  constructor(group: Container3D, ground: Mesh3D) {
    collectMeshes(group, this._meshes);

    const palette = findPalette(this._meshes);

    if (palette) {
      const { albedo, roughness } = soak(palette);

      this._albedo = albedo;
      this._roughness = roughness;
      this._material = new Material3D({
        baseColorTexture: albedo,
        metallicRoughnessTexture: roughness,
        roughness: 1,
        metallic: 0,
        doubleSided: true,
        extraBits: [puddleBit],
      });

      for (const mesh of this._meshes) {
        this._originals.push(mesh.material);
        mesh.material = this._material;
      }
    }

    this._ground = ground;

    const groundMaterial = ground.material;

    if (groundMaterial instanceof Material3D) {
      this._groundColor = groundMaterial.baseColor;
      this._groundRoughness = groundMaterial.roughness;
      groundMaterial.baseColor = GROUND_COLOR;
      groundMaterial.roughness = GROUND_ROUGHNESS;
    }
  }

  /** Push {@link WetTrack.time} to the shader. */
  public update(): void {
    if (this._material) (this._material.data as Material3DData & { wetTime: number }).wetTime = this.time;
  }

  public destroy(): void {
    const meshes = this._meshes;

    for (let i = 0; i < meshes.length; i++) {
      if (!meshes[i].destroyed) meshes[i].material = this._originals[i];
    }

    meshes.length = 0;
    this._originals.length = 0;

    const groundMaterial = this._ground.material;

    if (!this._ground.destroyed && groundMaterial instanceof Material3D) {
      groundMaterial.baseColor = this._groundColor;
      groundMaterial.roughness = this._groundRoughness;
    }

    this._material?.destroy();
    this._albedo?.destroy(true);
    this._roughness?.destroy(true);
  }
}

function collectMeshes(node: Container3D, out: Mesh3D[]): void {
  if (node instanceof Mesh3D && node.material instanceof Material3D) out.push(node);

  for (const child of node.children) collectMeshes(child, out);
}

/** The palette every piece paints from: the base colour texture of the first textured material. */
function findPalette(meshes: readonly Mesh3D[]): Texture | null {
  for (const mesh of meshes) {
    const texture = (mesh.material as Material3D).textures.baseColor;

    if (texture && texture !== Texture.WHITE) return texture;
  }

  return null;
}

/**
 * The wet palette and its roughness map. Asphalt is the dark greys, foliage the greens; everything else is paint.
 * Roughness lives in green; red marks the asphalt the puddles may cover.
 */
function soak(palette: Texture): { albedo: Texture; roughness: Texture } {
  const source = palette.source;
  const width = source.pixelWidth;
  const height = source.pixelHeight;
  const canvas = document.createElement('canvas');

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  ctx.drawImage(source.resource as CanvasImageSource, 0, 0);

  const image = ctx.getImageData(0, 0, width, height);
  const rough = new ImageData(width, height);
  const px = image.data;
  const out = rough.data;

  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const grey = max - min < 24;
    const asphalt = grey && max < 110;
    const foliage = g > r + 20 && g > b;
    const surface = asphalt ? ASPHALT : foliage ? FOLIAGE : PAINT;

    px[i] = r * surface.dark;
    px[i + 1] = g * surface.dark;
    px[i + 2] = b * surface.dark;
    out[i] = asphalt ? 255 : 0;
    out[i + 1] = surface.roughness * 255;
    out[i + 2] = 0;
    out[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);

  const albedo = paletteTexture(canvas, palette);
  const roughCanvas = document.createElement('canvas');

  roughCanvas.width = width;
  roughCanvas.height = height;
  roughCanvas.getContext('2d')!.putImageData(rough, 0, 0);

  return { albedo, roughness: paletteTexture(roughCanvas, palette) };
}

/** A canvas texture sampled the way the palette is: nearest texel, with mips. */
function paletteTexture(canvas: HTMLCanvasElement, like: Texture): Texture {
  const texture = Texture.from({ resource: canvas, autoGenerateMipmaps: true });
  const style = texture.source.style;
  const from = like.source.style;

  style.magFilter = from.magFilter;
  style.minFilter = from.minFilter;
  style.mipmapFilter = from.mipmapFilter;

  return texture;
}
