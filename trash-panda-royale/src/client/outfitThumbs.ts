/** sRGB byte -> linear light. */
const TO_LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
/** Linear light (0..1, in 4096 steps) -> sRGB byte. */
const STEPS = 4095;
const TO_SRGB = new Uint8Array(STEPS + 1).map((_, i) => {
  const c = i / STEPS;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
});
const srgb = (lin: number) => TO_SRGB[lin >= 1 ? STEPS : (lin * STEPS + 0.5) | 0];

/**
 * The start screen's pictures of the hats and extras, baked in Blender from the raccoon's own
 * accessories (assets-src/blender/build_icons.py, `build_outfit`). outfit.png holds a column
 * per accessory: on top its base (the part that takes the gear colour rendered black, over
 * the ink outline), below its tint (the light that part sends back when white). In linear
 * light the accessory in a colour c is base + c × tint, worked out here per pixel, so the
 * pictures wear whatever gear colour you pick.
 */
export class OutfitThumbs {
  private constructor(
    readonly px: number,
    private columns: Map<string, number>,
    private width: number,
    private base: Uint8ClampedArray,
    private tint: Uint8ClampedArray,
  ) {}

  private static loading: Promise<OutfitThumbs> | null = null;

  /** The atlas, fetched once (the wardrobe and DRESS ME UP! both draw from it). */
  static load(): Promise<OutfitThumbs> {
    return (OutfitThumbs.loading ??= OutfitThumbs.fetch());
  }

  private static async fetch(): Promise<OutfitThumbs> {
    const res = await fetch("assets/icons/outfit.json");
    if (!res.ok) throw new Error(`outfit.json: ${res.status}`);
    const meta = (await res.json()) as { px: number; items: string[] };
    const img = new Image();
    img.src = "assets/icons/outfit.png";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const { px } = meta;
    return new OutfitThumbs(px, new Map(meta.items.map((n, i) => [n, i])), c.width,
      g.getImageData(0, 0, c.width, px).data, g.getImageData(0, px, c.width, px).data);
  }

  has(node: string) { return this.columns.has(node); }

  /** Draw accessory `node` in gear colour `color` (0xrrggbb) on `canvas` (`px` square). */
  paint(canvas: HTMLCanvasElement, node: string, color: number) {
    const col = this.columns.get(node);
    if (col === undefined) return;
    const { px, base, tint } = this;
    const r = TO_LIN[(color >> 16) & 255], g = TO_LIN[(color >> 8) & 255], b = TO_LIN[color & 255];
    const out = new ImageData(px, px);
    const d = out.data;
    for (let y = 0; y < px; y++) {
      let i = (y * this.width + col * px) * 4, o = y * px * 4;
      for (let x = 0; x < px; x++, i += 4, o += 4) {
        const a = base[i + 3];
        if (a === 0) continue;
        d[o] = srgb(TO_LIN[base[i]] + r * TO_LIN[tint[i]]);
        d[o + 1] = srgb(TO_LIN[base[i + 1]] + g * TO_LIN[tint[i + 1]]);
        d[o + 2] = srgb(TO_LIN[base[i + 2]] + b * TO_LIN[tint[i + 2]]);
        d[o + 3] = a;
      }
    }
    canvas.getContext("2d")!.putImageData(out, 0, 0);
  }
}
