import { Texture } from "pixi.js";

/**
 * The billboards' poster: "PixiJS + Colyseus = AWESOMESAUCE!", painted once, here, at load (two
 * small SVGs are the only download). The browser rasterizes the logos itself, so the Colyseus
 * gradient and the PixiJS pink come out exactly; everything else is drawn in the town's cartoon
 * style: a sky-blue sunburst, the logos as die-cut stickers, fat ink-outlined letters, sauce.
 *
 * The picture is 2:1, the board faces' shape (`BILLBOARD` in town.ts). It's drawn on a
 * 2048 × 1024 reference grid and scaled to the canvas (1024 × 512 with `?fx=low`).
 */

const INK = "#2b2340", SUN = "#ffd23f", PINK = "#ff5d8f", SKY = "#6ec3ff", PALE = "#9ad7ff", WHITE = "#ffffff";
const W = 2048, H = 1024;
const FONT = "'Bebas Neue', Impact, 'Arial Narrow', sans-serif";

const lowFx = typeof location !== "undefined" && new URLSearchParams(location.search).get("fx") === "low";

/** The logos (public/assets/brand), rasterized this wide by the browser, then drawn smaller. */
const LOGOS = { pixijs: "assets/brand/pixijs.svg", colyseus: "assets/brand/colyseus.svg" } as const;
const RASTER_W = 1600;
const art: Partial<Record<keyof typeof LOGOS, HTMLImageElement>> = {};

/** An SVG as a picture `RASTER_W` px wide (its own size attributes swapped for that, so it's drawn sharp). */
async function loadSvg(url: string): Promise<HTMLImageElement> {
  const text = await (await fetch(url)).text();
  const vb = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*"/.exec(text);
  if (!vb) throw new Error(`${url}: no viewBox`);
  const w = RASTER_W, h = Math.round((RASTER_W * +vb[4]) / +vb[3]);
  const sized = text.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="${w}" height="${h}">`);
  const img = new Image(w, h);
  const blob = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    img.src = blob;
    await img.decode();
  } finally {
    URL.revokeObjectURL(blob);
  }
  return img;
}

/**
 * Load the logos and the lettering's font, and paint the poster: while the models are still
 * loading, so it isn't part of building the scene. A logo that fails is left off the poster.
 */
export async function loadBillboardArt() {
  await Promise.all([
    ...Object.entries(LOGOS).map(async ([name, url]) => {
      try {
        art[name as keyof typeof LOGOS] = await loadSvg(url);
      } catch (e) {
        console.warn(`billboard logo ${name} failed to load`, e);
      }
    }),
    document.fonts?.load(`400 20px ${FONT}`).catch(() => {}),
  ]);
  const start = performance.now();
  billboardCanvas();
  performance.measure("ttm paint billboard", { start });
}

/** A blank canvas `w` × `h`. */
function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}

const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** The complementary error function (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7), x ≥ 0. */
function erfc(x: number) {
  const t = 1 / (1 + 0.3275911 * x);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
}

/**
 * A die-cut sticker's backing for `img` (drawn `w` × `h`): its shape grown by about `pad` px,
 * rounded and with the holes (the counters of the letters) filled, in white, and an ink rim
 * about `edge` px round that: the logo blurred and cut low (grown), its holes flooded, then
 * blurred and cut again (rounded off). Worked out at half size (it's all soft shapes) and
 * returned at that size: draw them twice as big, centred on the logo.
 */
function backing(img: CanvasImageSource, w: number, h: number, pad: number, edge: number) {
  const k = 0.5;
  w *= k; h *= k; pad *= k; edge *= k;
  // a blurred straight edge falls off as ½·erfc(d / (σ√2)) past it: cutting a blur low grows a
  // shape by d (thin strokes a little less), cutting it at ½ rounds it off where it stands
  const cut = (d: number, sigma: number) => 0.5 * erfc(d / (sigma * Math.SQRT2));
  const grow = pad * 0.8, g1 = grow / 1.6, soft = pad * 0.45, m = Math.ceil(pad + edge + soft * 2);
  const cw = Math.ceil(w + m * 2), ch = Math.ceil(h + m * 2), n = cw * ch;
  const blurred = (src: CanvasImageSource, sigma: number, dw?: number, dh?: number) => {
    const c = canvas(cw, ch), g = c.getContext("2d")!;
    g.filter = `blur(${sigma}px)`;
    if (dw) g.drawImage(src, m, m, dw, dh!); else g.drawImage(src, 0, 0);
    return g.getImageData(0, 0, cw, ch);
  };
  // grown: the logo blurred and cut low
  const shape = blurred(img, g1, w, h);
  const px = shape.data, t1 = Math.round(cut(grow, g1) * 255);
  // the holes (a letter's counter): whatever the outside, flooded in from the border, doesn't reach
  const outside = new Uint8Array(n), stack = new Int32Array(n);
  let top = 0;
  const visit = (q: number) => { if (!outside[q] && px[q * 4 + 3] < t1) { outside[q] = 1; stack[top++] = q; } };
  for (let x = 0; x < cw; x++) { visit(x); visit(n - cw + x); }
  for (let y = 0; y < ch; y++) { visit(y * cw); visit(y * cw + cw - 1); }
  while (top) {
    const p = stack[--top], x = p % cw;
    if (x > 0) visit(p - 1);
    if (x < cw - 1) visit(p + 1);
    if (p >= cw) visit(p - cw);
    if (p < n - cw) visit(p + cw);
  }
  for (let p = 0; p < n; p++) px[p * 4 + 3] = outside[p] ? 0 : 255;
  const filled = canvas(cw, ch);
  filled.getContext("2d")!.putImageData(shape, 0, 0);
  // rounded off: blurred again, cut at ½ (the white) and `edge` px further out (the ink)
  const src = blurred(filled, soft).data;
  const back = new ImageData(cw, ch), rim = new ImageData(cw, ch);
  const rimCut = cut(edge, soft);
  for (let i = 3; i < src.length; i += 4) {
    const a = src[i] / 255;
    back.data[i - 3] = back.data[i - 2] = back.data[i - 1] = 255;
    back.data[i] = Math.round(smoothstep(0.47, 0.53, a) * 255);
    rim.data[i - 3] = 0x2b; rim.data[i - 2] = 0x23; rim.data[i - 1] = 0x40;
    rim.data[i] = Math.round(smoothstep(rimCut - 0.04, rimCut + 0.04, a) * 255);
  }
  const out = (d: ImageData) => { const c = canvas(cw, ch); c.getContext("2d")!.putImageData(d, 0, 0); return c; };
  return { back: out(back), rim: out(rim), scale: 1 / k };
}

/** A logo as a sticker slapped on the board: white die-cut backing, ink edge, a soft shadow, a slight tilt. */
function sticker(g: CanvasRenderingContext2D, img: HTMLImageElement | undefined, cx: number, cy: number, h: number, tilt: number) {
  if (!img) return;
  const w = (h * img.width) / img.height;
  const { back, rim, scale } = backing(img, w, h, 34, 10);
  const bw = back.width * scale, bh = back.height * scale;
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);
  g.imageSmoothingQuality = "high";
  g.save();
  g.shadowColor = "rgba(43, 35, 64, 0.45)";
  g.shadowBlur = 26;
  g.shadowOffsetY = 14;
  g.drawImage(rim, -bw / 2, -bh / 2, bw, bh);
  g.restore();
  g.drawImage(back, -bw / 2, -bh / 2, bw, bh);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  g.restore();
}

/** Sky-blue rays from a point low in the middle, a darker rim, and the seams between the poster's paper sheets. */
function background(g: CanvasRenderingContext2D) {
  g.fillStyle = SKY;
  g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.66, rays = 26;
  g.fillStyle = PALE;
  for (let k = 0; k < rays; k += 2) {
    const a0 = (k / rays) * Math.PI * 2, a1 = ((k + 1) / rays) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, W, a0, a1);
    g.closePath();
    g.fill();
  }
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.42);
  glow.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  glow.addColorStop(1, "rgba(255, 255, 255, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  const rim = g.createRadialGradient(cx, H / 2, H * 0.45, cx, H / 2, W * 0.62);
  rim.addColorStop(0, "rgba(43, 35, 64, 0)");
  rim.addColorStop(1, "rgba(43, 35, 64, 0.32)");
  g.fillStyle = rim;
  g.fillRect(0, 0, W, H);
  // paper sheets, pasted edge to edge
  for (let k = 1; k < 6; k++) {
    const x = Math.round((W * k) / 6) + (k % 2 ? 3 : -2);
    g.fillStyle = "rgba(43, 35, 64, 0.10)";
    g.fillRect(x, 0, 3, H);
    g.fillStyle = "rgba(255, 255, 255, 0.22)";
    g.fillRect(x + 3, 0, 3, H);
  }
}

/** Text in the town's sign style: a stacked ink extrude, a fat round ink outline, the fill, a shine. */
function chunky(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, depth = 12) {
  g.save();
  g.font = `400 ${size}px ${FONT}`;
  g.textBaseline = "alphabetic";
  g.lineJoin = "round";
  g.miterLimit = 2;
  const ow = size * 0.07;
  g.lineWidth = ow * 2;
  g.strokeStyle = INK;
  g.fillStyle = INK;
  for (let d = depth; d > 0; d -= 2) { g.strokeText(text, x, y + d); g.fillText(text, x, y + d); }
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
  // a glossy band across the top of the letters (in the letters only), on a strip just that tall
  const top = y - size * 0.7, band = size * 0.22, pad = 8;
  const c = canvas(g.measureText(text).width + pad * 2, band);
  const cg = c.getContext("2d")!;
  cg.font = g.font;
  cg.textBaseline = "alphabetic";
  cg.fillStyle = WHITE;
  cg.fillText(text, pad, y - top);
  cg.globalCompositeOperation = "source-in";
  const shine = cg.createLinearGradient(0, 0, 0, band);
  shine.addColorStop(0, "rgba(255, 255, 255, 0.75)");
  shine.addColorStop(1, "rgba(255, 255, 255, 0)");
  cg.fillStyle = shine;
  cg.fillRect(0, 0, c.width, c.height);
  g.drawImage(c, x - pad, top);
  g.restore();
}

/** A fat cartoon "+" (or, `bars` = 2, an "="): rounded bars, ink outline and extrude, sun yellow. */
function symbol(g: CanvasRenderingContext2D, kind: "+" | "=", cx: number, cy: number, s: number) {
  const bar = s * 0.34, r = bar / 2;
  const shapes: [number, number, number, number][] = kind === "+"
    ? [[-s / 2, -bar / 2, s, bar], [-bar / 2, -s / 2, bar, s]]
    : [[-s / 2, -bar * 1.15, s, bar], [-s / 2, bar * 0.15, s, bar]];
  const path = () => {
    g.beginPath();
    for (const [x, y, w, h] of shapes) g.roundRect(cx + x, cy + y, w, h, r);
  };
  g.save();
  g.lineJoin = "round";
  g.lineWidth = s * 0.13;
  g.strokeStyle = INK;
  g.fillStyle = INK;
  for (let d = 14; d > 0; d -= 2) { g.save(); g.translate(0, d); path(); g.stroke(); g.fill(); g.restore(); }
  path();
  g.stroke();
  g.fillStyle = SUN;
  // (the bars of a "+" overlap: fill them as one shape)
  g.fill("nonzero");
  g.restore();
}

/** Sauce running down off the letters: a drop on a string, ink outlined, with a shine. */
function drip(g: CanvasRenderingContext2D, x: number, y0: number, len: number, w: number) {
  const r = w * 0.78;
  const shape = () => {
    g.beginPath();
    g.moveTo(x - w / 2, y0);
    g.lineTo(x - w / 2, y0 + len);
    g.arc(x, y0 + len + r * 0.55, r, Math.PI + 0.75, -0.75, true);
    g.lineTo(x + w / 2, y0);
    g.closePath();
  };
  g.save();
  g.lineJoin = "round";
  g.lineWidth = 18;
  g.strokeStyle = INK;
  shape();
  g.stroke();
  g.fillStyle = PINK;
  shape();
  g.fill();
  g.fillStyle = "rgba(255, 255, 255, 0.8)";
  g.beginPath();
  g.ellipse(x - r * 0.35, y0 + len + r * 0.3, r * 0.2, r * 0.3, -0.4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** The whole poster, on the 2048 × 1024 reference grid. */
function paint(g: CanvasRenderingContext2D) {
  background(g);

  // PixiJS + Colyseus
  const top = H * 0.3;
  sticker(g, art.pixijs, W * 0.225, top, 250, -0.045);
  symbol(g, "+", W * 0.446, top + 6, 156);
  sticker(g, art.colyseus, W * 0.735, top + 4, 168, 0.03);

  // = AWESOMESAUCE! (as big as fits between the frame's margins)
  const words: [string, string][] = [["AWESOME", SUN], ["SAUCE", PINK], ["!", SUN]];
  const fit = (s: number) => { g.font = `400 ${s}px ${FONT}`; return words.map(([t]) => g.measureText(t).width); };
  const gapK = 0.16, eqK = 0.5, room = W * 0.86;
  let size = 300;
  const span = (ws: number[]) => size * (eqK + gapK) + ws.reduce((a, b) => a + b, 0);
  let widths = fit(size);
  if (span(widths) > room) { size *= room / span(widths); widths = fit(size); }
  const base = H * 0.8, eq = size * eqK;
  let x = (W - span(widths)) / 2;
  symbol(g, "=", x + eq / 2, base - size * 0.36, eq);
  x += size * (eqK + gapK);
  // the drips hang from under SAUCE: drawn first, so the letters cover their tops
  const sauceX = x + widths[0];
  for (const [f, len, w] of [[0.1, 80, 30], [0.34, 132, 36], [0.58, 58, 28], [0.84, 104, 32]] as const) {
    drip(g, sauceX + widths[1] * f, base - 30, len, w);
  }
  words.forEach(([t, color], i) => {
    chunky(g, t, x, base, size, color);
    x += widths[i];
  });

  // an ink frame round the paper
  g.lineWidth = 18;
  g.strokeStyle = INK;
  g.strokeRect(9, 9, W - 18, H - 18);
}

let painted: HTMLCanvasElement | null = null;

/** The poster as a canvas (painted on first use: the fonts and logos must be in by then). */
export function billboardCanvas(): HTMLCanvasElement {
  if (painted) return painted;
  const scale = lowFx ? 0.5 : 1;
  const c = canvas(W * scale, H * scale);
  const g = c.getContext("2d")!;
  g.scale(scale, scale);
  paint(g);
  return (painted = c);
}

let texture: Texture | null = null;

/** The poster as a texture: mipmapped, clamped at its edges, a little anisotropic (it's seen at angles). */
export function billboardTexture(): Texture {
  if (texture) return texture;
  const t = Texture.from(billboardCanvas());
  t.source.style.addressMode = "clamp-to-edge";
  t.source.style.maxAnisotropy = lowFx ? 1 : 4;
  t.source.autoGenerateMipmaps = true;
  return (texture = t);
}
