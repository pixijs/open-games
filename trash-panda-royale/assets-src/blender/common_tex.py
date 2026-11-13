"""Texture helpers shared by every Blender build script (Blender 5.2 + numpy, headless).

Why the rules below exist (the game renders with @pixi/3d, WebGL): every shader feature
combination is its own program (0.3-0.8 s to compile).  If EVERY mesh carries exactly one
float32x2 UV set (TEXCOORD_0), the program family is replaced rather than doubled, and
filling a material's baseColor texture slot adds no program.  Therefore:
  * base-colour (and emissive) textures only: no normal / occlusion / metallicRoughness
    maps, no alphaMode MASK;
  * PNGs carry ONLY IHDR/IDAT/IEND (gAMA/cHRM/sRGB/iCCP render wrong in the engine);
  * opaque materials use grey or RGB PNGs, never RGBA (texture alpha must be 1);
  * base-colour textures are decoded with pow(x, 2.2) AFTER filtering, so tiling
    textures are low-contrast and mostly white (they multiply a flat / tinted colour).

Contents
  write_png / png_bytes / png_chunks     deterministic PNG I/O (IHDR, IDAT, IEND only)
  rng, hash01, grid, pnoise, fbm, blur,  seeded numpy image helpers (periodic = tiling)
    quantize, periodic, resize, ...
  sd_* / cover / dilate_disc             2D signed distance fields + anti-aliased coverage
  text_mask                              text -> alpha mask via a Workbench render
  Canvas                                 tiny sRGB compositing canvas used by the atlas art
  Atlas, atlas_town, PALETTE, swatch_uv  atlas layout (pixel / Blender UV / glTF UV rects)
  TEX, load_tex, tmat                    texture registry + textured Principled material
  norm_uv, default_uv, corner_uvs, ...   UV modes shared by common_cp.MB / common_vb.MeshBuilder
  externalize_images                     GLB post-process: embedded PNGs -> uri "tex/<name>.png"

UV modes (the `uv=` argument of every builder primitive; Blender UV space, v up):
  ('const', u, v)        every corner gets (u, v)          (default for untextured materials)
  ('box', tile_m)        per face, from the face normal's dominant axis, in the builder's
                         (asset) frame after the primitive's transform:
                           |n.z| largest -> (x, y); |n.x| -> (sign(n.x)*y, z);
                           |n.y| -> (-sign(n.y)*x, z); all divided by tile_m
                         (default for textured materials: ('box', m['tile_m']))
  ('slope', tile_m)      like 'box' on walls, but sloped faces use u = horizontal tangent,
                         v = up the slope (roof shingles always point downhill)
  ('cyl',)               grid rows (lathe / capsule / cylinder / tube, MB.grid; VB cyl/torus):
                         u = j/segs (wrap corner at 1.0), v = arc length along the profile / total
  ('sphere', c)          spherical around centre c (seam + pole corners fixed per face)
  ('planar', origin, u_axis, v_axis, w, h)   0..1 over a w x h rectangle
Any mode may end with a dict {'rect': (u0, v0, u1, v1)} (Blender UV space) that remaps
0..1 into an atlas cell, e.g. ('planar', o, ua, va, w, h, {'rect': atlas_town().uv_blender('window_cat')}).
"""
import hashlib
import json
import math
import os
import struct
import sys
import tempfile
import zlib
from collections import namedtuple

import numpy as np

try:  # the pure-numpy parts are importable outside Blender too
    import bpy
    from mathutils import Vector
except ImportError:  # pragma: no cover
    bpy = None
    Vector = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MODELS_DIR = os.path.join(ROOT, "public", "assets", "models")
TEX_DIR = os.path.join(MODELS_DIR, "tex")
TEX_URI = "tex/"
INK = "#2b2340"


# =============================================================================
# PNG
# =============================================================================
def png_bytes(img):
    """uint8 (H, W) grey -> colour type 0, (H, W, 3) -> 2, (H, W, 4) -> 6 (rows top-down).
    Only IHDR, IDAT, IEND; per-row adaptive filter (min sum of |signed residual|), zlib 9.
    Deterministic: same pixels -> same bytes."""
    img = np.ascontiguousarray(img, dtype=np.uint8)
    if img.ndim == 2:
        img = img[:, :, None]
    H, W, ch = img.shape
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[ch]
    x = img.reshape(H, W * ch).astype(np.int16)
    left = np.zeros_like(x)
    left[:, ch:] = x[:, :-ch]
    upr = np.zeros_like(x)
    upr[1:] = x[:-1]
    ul = np.zeros_like(x)
    ul[1:, ch:] = x[:-1, :-ch]
    pp = left + upr - ul
    pa, pb, pc = np.abs(pp - left), np.abs(pp - upr), np.abs(pp - ul)
    paeth = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, upr, ul))
    cands = np.stack([x, x - left, x - upr, x - (left + upr) // 2, x - paeth]) & 0xFF
    cost = np.abs(cands.astype(np.uint8).view(np.int8).astype(np.int32)).sum(axis=2)
    best = np.argmin(cost, axis=0)
    rows = cands[best, np.arange(H)].astype(np.uint8)
    raw = np.concatenate([best.astype(np.uint8)[:, None], rows], axis=1).tobytes()

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, ctype, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def write_png(path, img):
    """Write uint8 (H, W[, 3|4]) rows top-down as a minimal PNG; returns the bytes."""
    data = png_bytes(img)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    return data


def png_chunks(data):
    """[(type, length)] of a PNG byte string (for checks)."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n', "not a PNG"
    out, o = [], 8
    while o < len(data):
        n, t = struct.unpack('>I4s', data[o:o + 8])
        out.append((t.decode('latin-1'), n))
        o += 12 + n
    return out


def read_png(path):
    """Decode a PNG written by png_bytes (8-bit, non-interlaced) -> uint8 (H, W[, C])."""
    with open(path, 'rb') as f:
        data = f.read()
    o, idat, hdr = 8, b'', None
    while o < len(data):
        n, t = struct.unpack('>I4s', data[o:o + 8])
        body = data[o + 8:o + 8 + n]
        if t == b'IHDR':
            hdr = struct.unpack('>IIBBBBB', body)
        elif t == b'IDAT':
            idat += body
        o += 12 + n
    W, H, depth, ctype, _c, _f, inter = hdr
    assert depth == 8 and inter == 0, "only 8-bit non-interlaced PNGs"
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(H, 1 + W * ch)
    out = np.zeros((H, W * ch), np.int32)
    prev = np.zeros((W, ch), np.int32)
    for y in range(H):
        ft, line = raw[y, 0], raw[y, 1:].astype(np.int32).reshape(W, ch)
        if ft == 0:
            cur = line
        elif ft == 1:
            cur = np.cumsum(line, axis=0) & 255
        elif ft == 2:
            cur = (line + prev) & 255
        else:  # Average / Paeth: sequential along the row (per pixel, vectorised over channels)
            cur = np.zeros((W, ch), np.int32)
            a = np.zeros(ch, np.int32)
            c = np.zeros(ch, np.int32)
            for x in range(W):
                b = prev[x]
                if ft == 3:
                    p = (a + b) // 2
                else:
                    q = a + b - c
                    pa_, pb_, pc_ = np.abs(q - a), np.abs(q - b), np.abs(q - c)
                    p = np.where((pa_ <= pb_) & (pa_ <= pc_), a, np.where(pb_ <= pc_, b, c))
                cur[x] = (line[x] + p) & 255
                a, c = cur[x], b
        out[y] = cur.reshape(-1)
        prev = cur
    out = out.astype(np.uint8)
    return out.reshape(H, W) if ch == 1 else out.reshape(H, W, ch)


# =============================================================================
# colour
# =============================================================================
def srgb01(h):
    """'#rrggbb' -> float32 array (3,), sRGB 0..1."""
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def srgb_to_lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_lin(h):
    return tuple(float(x) for x in srgb_to_lin(srgb01(h)))


def col(c):
    """hex string | (r, g, b) sRGB floats | float grey | array -> float array (..., 3)."""
    if isinstance(c, str):
        return srgb01(c).astype(np.float64)
    a = np.asarray(c, np.float64)
    if a.ndim == 0:
        return np.full(3, float(a))
    return a


def mix(a, b, t):
    return col(a) * (1 - t) + col(b) * t


# =============================================================================
# seeded numpy image helpers (all periodic -> textures tile seamlessly)
# =============================================================================
def rng(seed):
    return np.random.default_rng(int(seed) & 0xFFFFFFFF)


def _shape(n):
    return (int(n), int(n)) if np.isscalar(n) else (int(n[0]), int(n[1]))


def grid(h, w):
    """Pixel-centre coordinates X, Y (float64, shape (h, w)); y grows downward."""
    return np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)


def _freqs(h, w):
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    return fx, fy


def pnoise(n, f0, seed):
    """Tileable smooth noise: white noise low-passed by a Gaussian of sigma f0 (cycles per
    tile) in FFT space, min-max normalised to 0..1.  n = size or (h, w)."""
    h, w = _shape(n)
    white = rng(seed).standard_normal((h, w))
    fx, fy = _freqs(h, w)
    G = np.exp(-(fx ** 2 + fy ** 2) / (2.0 * float(f0) ** 2))
    a = np.fft.irfft2(np.fft.rfft2(white) * G, s=(h, w))
    a -= a.min()
    a /= max(a.max(), 1e-12)
    return a


def fbm(n, f0, seed, octaves=4, gain=0.5, lacunarity=2.0):
    """Sum of pnoise octaves (frequency f0 * lacunarity^k, amplitude gain^k), 0..1."""
    h, w = _shape(n)
    acc = np.zeros((h, w))
    amp, tot = 1.0, 0.0
    for k in range(octaves):
        acc += amp * (pnoise((h, w), f0 * lacunarity ** k, seed * 7919 + k) - 0.5)
        tot += amp
        amp *= gain
    acc -= acc.min()
    return acc / max(acc.max(), 1e-12)


def blur(a, sigma):
    """Periodic Gaussian blur (sigma in pixels) of a 2D array via FFT."""
    if sigma <= 0:
        return a.copy()
    h, w = a.shape
    fx, fy = _freqs(h, w)
    G = np.exp(-2.0 * math.pi ** 2 * sigma ** 2 * ((fx / w) ** 2 + (fy / h) ** 2))
    return np.fft.irfft2(np.fft.rfft2(a) * G, s=(h, w))


def blur_rgb(img, sigma):
    return np.stack([blur(img[..., c], sigma) for c in range(img.shape[2])], axis=2)


def quantize(a, levels):
    """Posterise 0..1 values to `levels` evenly spaced steps (cartoon bands, small PNGs)."""
    levels = max(2, int(levels))
    return np.round(np.clip(a, 0, 1) * (levels - 1)) / (levels - 1)


def hash01(*keys, seed=0):
    """Deterministic integer hash of integer arrays -> float64 in [0, 1) (splitmix64-ish)."""
    with np.errstate(over='ignore'):
        hsh = np.full(np.broadcast(*[np.asarray(k) for k in keys]).shape,
                      np.uint64((seed * 0x9E3779B97F4A7C15 + 0x632BE59BD9B4E019) & 0xFFFFFFFFFFFFFFFF))
        for k in keys:
            hsh = hsh ^ (np.asarray(k).astype(np.int64).astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15))
            hsh = (hsh ^ (hsh >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
            hsh = (hsh ^ (hsh >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
            hsh = hsh ^ (hsh >> np.uint64(31))
    return (hsh >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def periodic(fn, X, Y, W, H):
    """min over the 9 periodic copies of an SDF fn(X, Y) (tiling textures)."""
    out = None
    for oy in (-H, 0, H):
        for ox in (-W, 0, W):
            d = fn(X + ox, Y + oy)
            out = d if out is None else np.minimum(out, d)
    return out


def _resample_matrix(n_in, n_out):
    """(n_out, n_in) weights: area average when shrinking, linear when enlarging."""
    Wm = np.zeros((n_out, n_in))
    if n_out <= n_in:
        s = n_in / n_out
        for i in range(n_out):
            a, b = i * s, (i + 1) * s
            for j in range(int(math.floor(a)), int(math.ceil(b))):
                Wm[i, j] = min(b, j + 1) - max(a, j)
        Wm /= Wm.sum(axis=1, keepdims=True)
    else:
        for i in range(n_out):
            x = (i + 0.5) * n_in / n_out - 0.5
            j0 = int(math.floor(x))
            t = x - j0
            Wm[i, min(max(j0, 0), n_in - 1)] += 1 - t
            Wm[i, min(max(j0 + 1, 0), n_in - 1)] += t
    return Wm


def resize(img, h, w):
    """Separable area/linear resample of (H, W) or (H, W, C) float arrays."""
    a = np.asarray(img, np.float64)
    Ry, Rx = _resample_matrix(a.shape[0], h), _resample_matrix(a.shape[1], w)
    if a.ndim == 2:
        return Ry @ a @ Rx.T
    return np.stack([Ry @ a[..., c] @ Rx.T for c in range(a.shape[2])], axis=2)


def shift(a, dx, dy):
    """Integer translate of a 2D/3D array with zero fill (not periodic)."""
    out = np.zeros_like(a)
    H, W = a.shape[:2]
    x0, x1 = max(0, dx), min(W, W + dx)
    y0, y1 = max(0, dy), min(H, H + dy)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = a[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    return out


def to_u8(a):
    return np.round(np.clip(a, 0.0, 1.0) * 255.0).astype(np.uint8)


def linear_mean(u8):
    """(mean of (v/255)^2.2, (mean v/255)^2.2) -> correct vs. far-mip (filter-then-decode)."""
    v = np.asarray(u8, np.float64) / 255.0
    return float((v ** 2.2).mean()), float(v.mean() ** 2.2)


# =============================================================================
# 2D signed distance fields (pixel units; negative inside)
# =============================================================================
def cover(d, px=1.0):
    """Anti-aliased coverage of an SDF (d in pixels -> 0..1)."""
    return np.clip(0.5 - d / px, 0.0, 1.0)


def sd_circle(X, Y, cx, cy, r):
    return np.hypot(X - cx, Y - cy) - r


def sd_ellipse(X, Y, cx, cy, rx, ry, ang=0.0):
    """Approximate ellipse SDF (exact on the boundary; good for AA and outlines)."""
    dx, dy = X - cx, Y - cy
    if ang:
        c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        dx, dy = c * dx + s * dy, -s * dx + c * dy
    k0 = np.hypot(dx / rx, dy / ry)
    k1 = np.hypot(dx / (rx * rx), dy / (ry * ry))
    return np.where(k1 > 1e-9, k0 * (k0 - 1.0) / np.maximum(k1, 1e-9), -min(rx, ry))


def sd_segment(X, Y, ax, ay, bx, by):
    pax, pay, bax, bay = X - ax, Y - ay, bx - ax, by - ay
    h = np.clip((pax * bax + pay * bay) / max(bax * bax + bay * bay, 1e-12), 0.0, 1.0)
    return np.hypot(pax - bax * h, pay - bay * h)


def sd_capsule(X, Y, ax, ay, bx, by, r, r1=None):
    """Capsule from (ax, ay) radius r to (bx, by) radius r1 (default r)."""
    if r1 is None or r1 == r:
        return sd_segment(X, Y, ax, ay, bx, by) - r
    pax, pay, bax, bay = X - ax, Y - ay, bx - ax, by - ay
    h = np.clip((pax * bax + pay * bay) / max(bax * bax + bay * bay, 1e-12), 0.0, 1.0)
    return np.hypot(pax - bax * h, pay - bay * h) - (r + (r1 - r) * h)


def sd_rbox(X, Y, cx, cy, hw, hh, r=0.0, ang=0.0):
    """Rounded box centred at (cx, cy), half sizes hw, hh, corner radius r, rotated ang deg."""
    dx, dy = X - cx, Y - cy
    if ang:
        c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        dx, dy = c * dx + s * dy, -s * dx + c * dy
    qx = np.abs(dx) - (hw - r)
    qy = np.abs(dy) - (hh - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def sd_poly(X, Y, pts):
    """Exact SDF of a simple polygon [(x, y), ...]."""
    P = [(float(x), float(y)) for x, y in pts]
    d = (X - P[0][0]) ** 2 + (Y - P[0][1]) ** 2
    s = np.ones_like(X)
    n = len(P)
    j = n - 1
    for i in range(n):
        vix, viy = P[i]
        vjx, vjy = P[j]
        ex, ey = vjx - vix, vjy - viy
        wx, wy = X - vix, Y - viy
        t = np.clip((wx * ex + wy * ey) / max(ex * ex + ey * ey, 1e-12), 0.0, 1.0)
        bx, by = wx - ex * t, wy - ey * t
        d = np.minimum(d, bx * bx + by * by)
        c1 = Y >= viy
        c2 = Y < vjy
        c3 = ex * wy > ey * wx
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
        j = i
    return s * np.sqrt(d)


def sd_arc(X, Y, cx, cy, R, a0, a1, th):
    """Arc of radius R, half thickness th, from angle a0 to a1 (degrees, measured from +x
    toward +y, i.e. clockwise on screen since image y points down)."""
    dx, dy = X - cx, Y - cy
    ang = np.degrees(np.arctan2(dy, dx))
    span = (a1 - a0) % 360.0 or 360.0
    inside = ((ang - a0) % 360.0) <= span
    ring = np.abs(np.hypot(dx, dy) - R) - th
    e0 = (cx + R * math.cos(math.radians(a0)), cy + R * math.sin(math.radians(a0)))
    e1 = (cx + R * math.cos(math.radians(a1)), cy + R * math.sin(math.radians(a1)))
    ends = np.minimum(np.hypot(X - e0[0], Y - e0[1]), np.hypot(X - e1[0], Y - e1[1])) - th
    return np.where(inside, ring, ends)


def sd_star(X, Y, cx, cy, r_out, r_in, points=5, rot=-90.0):
    pts = []
    for k in range(points * 2):
        a = math.radians(rot + 180.0 * k / points)
        r = r_out if k % 2 == 0 else r_in
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return sd_poly(X, Y, pts)


def sd_union(*ds):
    out = ds[0]
    for d in ds[1:]:
        out = np.minimum(out, d)
    return out


def sd_smooth_union(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def sd_sub(a, b):
    """a minus b."""
    return np.maximum(a, -b)


def sd_inter(a, b):
    return np.maximum(a, b)


def dilate_disc(a, radius):
    """Grey-scale dilation of `a` with an anti-aliased disc of `radius` px."""
    H, W = a.shape
    p = int(math.ceil(radius + 0.5))
    A = np.zeros((H + 2 * p, W + 2 * p), np.float32)
    A[p:p + H, p:p + W] = a
    out = np.zeros_like(a)
    for dy in range(-p, p + 1):
        for dx in range(-p, p + 1):
            w = min(1.0, radius + 0.5 - math.hypot(dx, dy))
            if w <= 0.0:
                continue
            s = A[p + dy:p + dy + H, p + dx:p + dx + W]
            np.maximum(out, s if w >= 1.0 else s * w, out=out)
    return out


# =============================================================================
# text (Blender FONT object, built-in font = Blender's bundled Inter, Workbench render)
# =============================================================================
_TEXT_CACHE = {}


class _QuietStdout:
    """Silence C-level stdout (Blender's per-render 'Saved:' lines) inside a with-block."""

    def __enter__(self):
        self.saved = None
        try:
            sys.stdout.flush()
            self.fd = 1
            self.saved = os.dup(self.fd)
            self.null = os.open(os.devnull, os.O_WRONLY)
            os.dup2(self.null, self.fd)
        except (OSError, ValueError, AttributeError):
            self.saved = None
        return self

    def __exit__(self, *exc):
        if self.saved is not None:
            sys.stdout.flush()
            os.dup2(self.saved, self.fd)
            os.close(self.saved)
            os.close(self.null)
        return False


def _eval_mesh_xy(ob):
    deps = bpy.context.evaluated_depsgraph_get()
    oe = ob.evaluated_get(deps)
    me = oe.to_mesh()
    mw = oe.matrix_world.copy()
    pts = [mw @ v.co for v in me.vertices]
    oe.to_mesh_clear()
    return pts


def text_mask(text, px_h, max_w=None, offset=0.04, spacing=1.0, line_gap=1.0, align='CENTER',
              rot=0.0, shear=0.0, pad=2, ss=2):
    """Render `text` with a FONT object (built-in font, flat fill, extrude 0, thickened by
    `offset` in font units) and return an alpha mask float32 (h, w) in 0..1, rows top-down.

    The tight bounding box of the glyphs is `px_h` pixels tall (scaled down to `max_w`
    pixels wide if wider), plus `pad` empty pixels on each side.  Rendered with Workbench
    (flat light, render_aa 32, transparent film) through an orthographic camera fitted to
    the glyphs, at `ss` x resolution, then box-downsampled.  `rot` (degrees, CCW on screen)
    and `shear` (italic) are applied by Blender.  Results are cached per run."""
    key = (text, round(px_h, 3), max_w, offset, spacing, line_gap, align, rot, shear, pad, ss)
    if key in _TEXT_CACHE:
        return _TEXT_CACHE[key].copy()
    sc = bpy.context.scene
    hidden = []
    for o in sc.objects:
        if not o.hide_render:
            hidden.append(o)
            o.hide_render = True
    cu = bpy.data.curves.new("_txt", 'FONT')
    cu.body = text
    cu.size = 1.0
    cu.align_x = align
    cu.align_y = 'CENTER'
    cu.offset = offset
    cu.extrude = 0.0
    cu.bevel_depth = 0.0
    cu.space_character = spacing
    cu.space_line = line_gap
    cu.shear = shear
    ob = bpy.data.objects.new("_txt", cu)
    sc.collection.objects.link(ob)
    ob.rotation_euler = (0.0, 0.0, math.radians(rot))
    bpy.context.view_layer.update()
    pts = _eval_mesh_xy(ob)
    if not pts:
        raise RuntimeError("text_mask: no glyph geometry for %r" % text)
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
    s = px_h / bh                                  # pixels per font unit
    if max_w is not None and bw * s > max_w:
        s = max_w / bw
    W = int(math.ceil(bw * s)) + 2 * pad
    H = int(math.ceil(bh * s)) + 2 * pad
    cd = bpy.data.cameras.new("_txtcam")
    cd.type = 'ORTHO'
    cd.sensor_fit = 'AUTO'
    cd.ortho_scale = max(W, H) / s
    cd.clip_start = 0.01
    cd.clip_end = 100.0
    cam = bpy.data.objects.new("_txtcam", cd)
    sc.collection.objects.link(cam)
    cam.location = ((x0 + x1) / 2, (y0 + y1) / 2, 10.0)
    cam.rotation_euler = (0.0, 0.0, 0.0)
    old_cam = sc.camera
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'FLAT'
    sc.display.shading.color_type = 'SINGLE'
    sc.display.shading.single_color = (1.0, 1.0, 1.0)
    sc.display.shading.show_object_outline = False
    sc.display.shading.show_cavity = False
    sc.display.shading.show_shadows = False
    sc.display.shading.show_specular_highlight = False
    sc.display.render_aa = '32'
    sc.render.film_transparent = True
    sc.render.resolution_x = W * ss
    sc.render.resolution_y = H * ss
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '16'
    sc.view_settings.view_transform = 'Standard'
    tmpdir = tempfile.mkdtemp(prefix="txt_")
    path = os.path.join(tmpdir, "t.png")
    try:
        sc.render.filepath = path
        with _QuietStdout():
            bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(path, check_existing=False)
        w_, h_ = im.size
        px = np.empty(w_ * h_ * 4, np.float32)
        im.pixels.foreach_get(px)
        bpy.data.images.remove(im)
    finally:
        try:
            os.remove(path)
            os.rmdir(tmpdir)
        except OSError:
            pass
        sc.camera = old_cam
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cd)
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.curves.remove(cu)
        for o in hidden:
            o.hide_render = False
    a = px.reshape(h_, w_, 4)[::-1, :, 3]
    a = a[:H * ss, :W * ss].reshape(H, ss, W, ss).mean(axis=(1, 3)).astype(np.float32)
    _TEXT_CACHE[key] = a
    return a.copy()


# =============================================================================
# canvas (sRGB float compositing; good enough for flat cartoon art)
# =============================================================================
class Canvas:
    # Transparent mode (see `render_transparent`): canvases made while it's on start fully
    # transparent and track coverage in `a`; `rgb` then holds PREMULTIPLIED colour, which
    # the same "over" blend in fill() composites correctly.  Background helpers skip.
    transparent = False
    log = None

    def __init__(self, w, h, bg='#ffffff'):
        self.w, self.h = int(w), int(h)
        self.X, self.Y = grid(self.h, self.w)
        self.rgb = np.empty((self.h, self.w, 3))
        self.rgb[:] = col(bg)
        self.a = None
        if Canvas.transparent:
            self.rgb[:] = 0.0
            self.a = np.zeros((self.h, self.w))
        if Canvas.log is not None:
            Canvas.log.append(self)

    def fill(self, cov, color, alpha=1.0):
        a = np.clip(np.asarray(cov, np.float64) * alpha, 0.0, 1.0)
        if a.ndim == 2:
            a = a[..., None]
        c = col(color) if not (isinstance(color, np.ndarray) and color.ndim == 3) else color
        self.rgb = self.rgb * (1.0 - a) + c * a
        if self.a is not None:
            self.a = self.a * (1.0 - a[..., 0]) + a[..., 0]
        return self

    def shape(self, d, color, outline=None, ow=0.0, alpha=1.0):
        """Fill an SDF with `color`, optionally with an `ow`-px outline drawn under it."""
        if outline is not None and ow > 0:
            self.fill(cover(d - ow), outline, alpha)
        self.fill(cover(d), color, alpha)
        return self

    def place(self, mask, cx, cy):
        """Full-canvas coverage array with `mask` centred at (cx, cy)."""
        out = np.zeros((self.h, self.w), np.float64)
        mh, mw = mask.shape
        x0 = int(round(cx - mw / 2.0))
        y0 = int(round(cy - mh / 2.0))
        sx0, sy0 = max(0, -x0), max(0, -y0)
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(self.w, x0 + mw), min(self.h, y0 + mh)
        if dx1 > dx0 and dy1 > dy0:
            out[dy0:dy1, dx0:dx1] = mask[sy0:sy0 + dy1 - dy0, sx0:sx0 + dx1 - dx0]
        return out

    def text(self, s, cx, cy, h, color, outline=None, ow=0.0, max_w=None, shadow=None,
             sh_off=(0, 3), **kw):
        """Draw text centred at (cx, cy), `h` px tall (tight bbox); returns its coverage."""
        cov = self.place(text_mask(s, h, max_w=max_w, **kw), cx, cy)
        if shadow is not None:
            sc_ = dilate_disc(cov.astype(np.float32), ow) if ow > 0 else cov
            self.fill(shift(sc_, int(sh_off[0]), int(sh_off[1])), shadow)
        if outline is not None and ow > 0:
            self.fill(dilate_disc(cov.astype(np.float32), ow), outline)
        self.fill(cov, color)
        return cov

    def noise(self, amount, seed, f0=None, mono=True):
        """Add subtle multiplicative grain (paper / paint texture)."""
        if f0 is None:
            g = rng(seed).standard_normal((self.h, self.w))
        else:
            g = pnoise((self.h, self.w), f0, seed) * 2 - 1
        self.rgb = self.rgb * (1.0 + amount * g[..., None])
        return self

    def u8(self):
        return to_u8(self.rgb)


def render_transparent(fn, w, h):
    """Run a cell's art function `fn(w, h)` with transparent canvases: everything it draws
    over its (skipped) background, as straight-alpha RGBA floats (h, w, 4)."""
    Canvas.transparent, Canvas.log = True, []
    try:
        ret = np.asarray(fn(w, h), np.float64)
    finally:
        log = Canvas.log
        Canvas.transparent, Canvas.log = False, None
    cv = next((c for c in log if c.rgb is ret), None) or next((c for c in reversed(log) if c.rgb.shape == ret.shape), None)
    if cv is None or cv.a is None:
        raise RuntimeError("render_transparent: %s drew on no canvas" % getattr(fn, '__name__', fn))
    a = np.clip(cv.a, 0.0, 1.0)
    rgb = np.where(a[..., None] > 1e-6, np.clip(ret, 0.0, None) / np.maximum(a, 1e-6)[..., None], 0.0)
    return np.concatenate([np.clip(rgb, 0.0, 1.0), a[..., None]], axis=2)


# =============================================================================
# atlas layout
# =============================================================================
class Atlas:
    """Cells packed first-fit on a grid of half-cells.  Every cell owns a pitch rect; its
    content rect is inset by `gutter` px, and pad() edge-extends the content into that
    gutter so mip levels never bleed neighbouring cells.

    Rects:  rect_px(name)     -> (x, y, w, h) content, pixels, y down
            uv_gltf(name)     -> (u0, v0, u1, v1) content, glTF UV (v down: u0 = x/W, v0 = y/H)
            uv_blender(name)  -> (u0, v0, u1, v1) content, Blender UV (v up)"""

    def __init__(self, w, h, cell=128, gutter=8):
        self.w, self.h, self.cell, self.gutter = int(w), int(h), int(cell), int(gutter)
        self.unit = self.cell // 2
        self.occ = np.zeros((self.h // self.unit, self.w // self.unit), bool)
        self.cells = {}

    def add(self, name, cw=1.0, ch=1.0, aspect=None, gutter=None, **info):
        """Add a cell of cw x ch cells (multiples of 0.5).  `aspect` = intended quad w/h
        when the art is drawn pre-squashed (None = the content's own aspect)."""
        if name in self.cells:
            raise ValueError("duplicate atlas cell %s" % name)
        uw, uh = int(round(cw * 2)), int(round(ch * 2))
        gh, gw = self.occ.shape
        for gy in range(gh - uh + 1):
            for gx in range(gw - uw + 1):
                if not self.occ[gy:gy + uh, gx:gx + uw].any():
                    self.occ[gy:gy + uh, gx:gx + uw] = True
                    g = self.gutter if gutter is None else int(gutter)
                    x, y, pw, ph = gx * self.unit, gy * self.unit, uw * self.unit, uh * self.unit
                    cw_px, ch_px = pw - 2 * g, ph - 2 * g
                    self.cells[name] = dict(pitch=(x, y, pw, ph), gutter=g,
                                            rect=(x + g, y + g, cw_px, ch_px),
                                            aspect=float(aspect if aspect is not None else cw_px / ch_px),
                                            **info)
                    return self.cells[name]
        raise RuntimeError("atlas full: cannot place %s (%gx%g cells)" % (name, cw, ch))

    def rect_px(self, name):
        return self.cells[name]['rect']

    def uv_gltf(self, name):
        x, y, w, h = self.rect_px(name)
        return (x / self.w, y / self.h, (x + w) / self.w, (y + h) / self.h)

    def uv_blender(self, name):
        x, y, w, h = self.rect_px(name)
        return (x / self.w, 1.0 - (y + h) / self.h, (x + w) / self.w, 1.0 - y / self.h)

    def pad(self, img):
        """Edge-extend every cell's content rect into its gutter (in place, returns img)."""
        for c in self.cells.values():
            g = c['gutter']
            if g <= 0:
                continue
            x, y, w, h = c['rect']
            img[y - g:y, x:x + w] = img[y:y + 1, x:x + w]
            img[y + h:y + h + g, x:x + w] = img[y + h - 1:y + h, x:x + w]
            img[y - g:y + h + g, x - g:x] = img[y - g:y + h + g, x:x + 1]
            img[y - g:y + h + g, x + w:x + w + g] = img[y - g:y + h + g, x + w - 1:x + w]
        return img

    def to_json(self, file, palette=None, swatch_cell=None):
        cells = {}
        for name, c in self.cells.items():
            if name == swatch_cell:
                continue
            u0, v0, u1, v1 = self.uv_gltf(name)
            x, y, w, h = c['rect']
            cells[name] = {"u0": round(u0, 6), "v0": round(v0, 6), "u1": round(u1, 6), "v1": round(v1, 6),
                           "x": x, "y": y, "w": w, "h": h, "aspect": round(c['aspect'], 4)}
        out = {"$generated": "assets-src/blender/build_textures.py (do not edit)",
               "file": file, "width": self.w, "height": self.h, "gutter": self.gutter,
               "uv": "glTF UV space (v down); content rects exclude the edge-extended gutters",
               "cells": cells}
        if palette is not None and swatch_cell is not None:
            sw = {}
            for name, hx in palette.items():
                x, y = swatch_px(name)
                sw[name] = {"hex": hx, "u": round(x / self.w, 6), "v": round(y / self.h, 6)}
            out["swatches"] = sw
        return out


# 64 named sRGB colours, 8 x 8 swatches of 32 px in atlas_town's top-left 256 x 256 corner.
PALETTE = {
    # neutrals
    'ink': '#2b2340', 'charcoal': '#3b3d52', 'slate': '#4f5566', 'grey': '#8a8fa3',
    'silver': '#c7cdd8', 'cloud': '#e9edf5', 'cream': '#fff1d6', 'white': '#ffffff',
    # reds / pinks
    'cherry': '#e8283c', 'red': '#ff4d5e', 'coral': '#ff6b6b', 'salmon': '#ff8a80',
    'hotpink': '#ff6f91', 'pink': '#ff9ecf', 'blush': '#ffb3c7', 'rose': '#ffd1dc',
    # oranges / yellows
    'orange': '#ff8a2a', 'tangerine': '#ffa94d', 'peach': '#ffb37a', 'apricot': '#ffd6a5',
    'gold': '#ffc94d', 'yellow': '#ffd23f', 'lemon': '#ffe066', 'butter': '#fff3b0',
    # greens
    'forest': '#3faf7a', 'leaf': '#6cc66f', 'grass': '#8fd16a', 'lime': '#b8e986',
    'mint': '#7fe3c8', 'seafoam': '#a6f0d6', 'sage': '#b5c99a', 'olive': '#8a9a5b',
    # blues
    'navy': '#2a4fb8', 'blue': '#3d7bff', 'azure': '#4ea8de', 'sky': '#6ec3ff',
    'glass': '#9fdcff', 'ice': '#cfe6fa', 'teal': '#2ec4b6', 'aqua': '#4ecdc4',
    # purples
    'grape': '#6d4c7d', 'purple': '#7b6cf6', 'violet': '#9b7bff', 'lilac': '#b795ff',
    'lavender': '#d6cde8', 'plum': '#8e5a9b', 'orchid': '#e0a3ff', 'mauve': '#c3a6c9',
    # browns / skin
    'chocolate': '#6e4330', 'brown': '#8a5a3c', 'wood': '#c98a57', 'tan': '#e3c08f',
    'sand': '#e2cfb4', 'skin': '#ffcda8', 'caramel': '#d99a5b', 'terracotta': '#c9734f',
    # misc
    'rubber': '#2d2d3a', 'steel': '#9aa3b5', 'chrome': '#dfe7f0', 'brass': '#f4c13c',
    'copper': '#ee8a4c', 'raccoon': '#8f8a9c', 'raccoon_dark': '#4a4458', 'paper': '#f6ecd2',
}
SWATCH_PX = 32
SWATCH_COLS = 8
assert len(PALETTE) == 64


def swatch_px(name):
    """Pixel centre (x, y; y down) of a palette swatch in atlas_town."""
    i = list(PALETTE).index(name)
    x0, y0 = atlas_town().rect_px('swatches')[:2]
    return (x0 + (i % SWATCH_COLS) * SWATCH_PX + SWATCH_PX / 2.0,
            y0 + (i // SWATCH_COLS) * SWATCH_PX + SWATCH_PX / 2.0)


def swatch_uv(name):
    """Constant Blender UV (v up) at the centre of a palette swatch in atlas_town:
    `uv=('const', *swatch_uv('red'))` with a tmat(..., 'atlas_town') material."""
    x, y = swatch_px(name)
    A = atlas_town()
    return (x / A.w, 1.0 - y / A.h)


def swatch_uv_gltf(name):
    x, y = swatch_px(name)
    A = atlas_town()
    return (x / A.w, y / A.h)


# (name, cells wide, cells high, intended quad aspect w/h or None, note)
ATLAS_TOWN_CELLS = (
    [('swatches', 2, 2, None, 'palette, 8x8 swatches of 32 px')] +
    [('sign_' + n, 2, 1, None, 'shop sign') for n in
     ('pizza', 'donuts', 'snack_shack', 'laundromat', 'burger', 'trash_treasures', 'no_raccoons',
      'pest_control')] +
    [('car_pest_control', 2, 1, None, 'van side lettering + crossed-out raccoon logo'),
     ('graffiti_trash_is_life', 2, 1, None, 'painted panel'),
     ('graffiti_raccoons_rule', 2, 1, None, 'painted panel'),
     ('car_checker', 2, 0.5, None, 'taxi checker strip')] +
    [('window_' + n, 1, 1, 1.0, 'window glass') for n in
     ('curtains', 'blinds', 'plant', 'cat', 'raccoon', 'lamp', 'fishbowl', 'for_rent')] +
    [('door_' + n, 1, 1, 0.5, 'door, drawn pre-squashed for a 1:2 quad') for n in
     ('wood', 'blue', 'shop', 'red')] +
    [('poster_' + n, 1, 1, 0.75, 'poster, drawn pre-squashed for a 3:4 quad') for n in
     ('wanted', 'lost_sandwich', 'beware', 'donut_day', 'yard_sale', 'vote_bandit')] +
    [('graffiti_' + n, 1, 1, None, 'painted panel') for n in
     ('paws', 'nom', 'heart', 'crown', 'bandit', 'wow')] +
    [('decal_' + n, 1, 1, None, 'ground decal on asphalt') for n in
     ('manhole', 'drain', 'paw_trail', 'oil', 'arrow', 'trash_zone', 'patch', 'raccoon_xing')] +
    [('car_icecream_menu', 1, 1, None, 'ice-cream van menu board')] +
    [('car_plate_a', 1, 0.5, None, 'licence plate'), ('car_plate_b', 1, 0.5, None, 'licence plate'),
     ('car_taxi_sign', 1, 0.5, None, 'taxi roof sign'), ('label_fizz', 1, 0.5, None, 'soda can label'),
     ('label_beans', 1, 0.5, None, 'bean can label'), ('rip_plaque', 1, 0.5, None, 'RIP plaque')] +
    [('label_caps', 0.5, 0.5, None, 'bottle cap'), ('label_tape', 0.5, 0.5, None, 'duct tape'),
     ('loot_q', 0.5, 0.5, None, 'loot "?" sticker')]
)
_ATLAS_TOWN = None


def atlas_town():
    """The (deterministic) atlas_town layout: 1024 x 1024, 128 px cells, 8 px gutters."""
    global _ATLAS_TOWN
    if _ATLAS_TOWN is None:
        A = Atlas(1024, 1024, cell=128, gutter=8)
        for name, cw, ch, aspect, note in ATLAS_TOWN_CELLS:
            A.add(name, cw, ch, aspect=aspect, gutter=0 if name == 'swatches' else None, note=note)
        _ATLAS_TOWN = A
    return _ATLAS_TOWN


def atlas_rect(name):
    """Blender-UV content rect of an atlas_town cell (for uv=(..., {'rect': ...}))."""
    return atlas_town().uv_blender(name)


# =============================================================================
# texture registry + materials
# =============================================================================
TexInfo = namedtuple('TexInfo', 'file tile_m tint_ok size')

TEX = {
    # greyscale tiling multipliers (mostly white: tint with the material colour)
    'grass': TexInfo('grass.png', 3.0, True, 256),
    'asphalt': TexInfo('asphalt.png', 5.0, True, 256),
    'paving': TexInfo('paving.png', 4.0, True, 256),
    'plaza': TexInfo('plaza.png', 3.0, True, 256),
    'lot': TexInfo('lot.png', 6.0, True, 256),
    'ballast': TexInfo('ballast.png', 1.5, True, 128),
    'wood': TexInfo('wood.png', 1.0, True, 128),
    'brick': TexInfo('brick.png', 2.0, True, 256),
    'siding': TexInfo('siding.png', 2.0, True, 256),
    'stucco': TexInfo('stucco.png', 3.0, True, 256),
    'shingle': TexInfo('shingle.png', 2.0, True, 256),
    'roof_tar': TexInfo('roof_tar.png', 3.0, True, 128),
    'metal': TexInfo('metal.png', 1.0, True, 128),
    # full-colour atlas (not tinted: use a white material colour + explicit UVs)
    'atlas_town': TexInfo('atlas_town.png', None, False, 1024),
}
MAX_TEXTURES = 20


def tex_path(name):
    return os.path.join(TEX_DIR, TEX[name].file)


def load_tex(name):
    """bpy image for a registered texture (loaded once; pixels never touched, so the
    image stays un-dirty and the glTF exporter embeds the PNG bytes verbatim)."""
    path = tex_path(name)
    if not os.path.isfile(path):
        raise FileNotFoundError("texture %s missing (%s): run build_textures.py first" % (name, path))
    img = bpy.data.images.load(path, check_existing=True)
    if img.colorspace_settings.name != 'sRGB':
        img.colorspace_settings.name = 'sRGB'
    return img


def _sock(node, identifier, outputs=False):
    for s in (node.outputs if outputs else node.inputs):
        if s.identifier == identifier:
            return s
    raise KeyError(identifier)


def tmat(name, color, tex, rough=0.6, emit=None, strength=0.0, emit_tex=False, metallic=0.0):
    """Principled material whose Base Color = flat colour x texture:
         Image Texture (Linear, REPEAT) -> Mix (RGBA, MULTIPLY, Factor 1, A = colour) -> Base Color
    The glTF exporter writes baseColorFactor = colour and baseColorTexture = the PNG.
    `color` is sRGB hex (or a linear RGB tuple).  emit_tex also feeds the image (times the
    emit colour) into Emission Color.  Stores m['tex'] and m['tile_m'] for the builders'
    default UV mode.  Reuses an existing material of that name (must use the same tex)."""
    if tex not in TEX:
        raise KeyError("unknown texture %s" % tex)
    m = bpy.data.materials.get(name)
    if m is not None:
        if m.get('tex') != tex:
            raise RuntimeError("material %s already exists without texture %s" % (name, tex))
        return m
    m = bpy.data.materials.new(name)
    if m.name != name:
        raise RuntimeError("material name clash: %s -> %s" % (name, m.name))
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    lin = hex_lin(color) if isinstance(color, str) else tuple(color)
    img = load_tex(tex)
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = img
    tn.interpolation = 'Linear'
    tn.extension = 'REPEAT'
    tn.location = (-700, 200)

    def multiply(a_rgb, loc):
        mx = nt.nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        mx.clamp_result = False
        mx.location = loc
        _sock(mx, 'Factor_Float').default_value = 1.0
        _sock(mx, 'A_Color').default_value = (*a_rgb, 1.0)
        nt.links.new(tn.outputs['Color'], _sock(mx, 'B_Color'))
        return _sock(mx, 'Result_Color', outputs=True)
    nt.links.new(multiply(lin, (-350, 250)), p.inputs['Base Color'])
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = rough
    if emit is not None:
        e = hex_lin(emit) if isinstance(emit, str) else tuple(emit)
        p.inputs['Emission Strength'].default_value = strength
        if emit_tex:
            nt.links.new(multiply(e, (-350, -50)), p.inputs['Emission Color'])
        else:
            p.inputs['Emission Color'].default_value = (*e, 1.0)
    m.diffuse_color = (*lin, 1.0)
    m.roughness = rough
    m.metallic = metallic
    m['tex'] = tex
    m['tile_m'] = float(TEX[tex].tile_m or 0.0)
    return m


# =============================================================================
# UV modes (shared by common_cp.MB and common_vb.MeshBuilder)
# =============================================================================
UV_KINDS = ('const', 'box', 'slope', 'cyl', 'sphere', 'planar')


def norm_uv(uv):
    """uv= argument -> (kind, args, rect) or None."""
    if uv is None:
        return None
    if isinstance(uv, str):
        uv = (uv,)
    uv = tuple(uv)
    rect = None
    if uv and isinstance(uv[-1], dict):
        rect = uv[-1].get('rect')
        uv = uv[:-1]
    if not uv or uv[0] not in UV_KINDS:
        raise ValueError("bad uv mode %r" % (uv,))
    return (uv[0], uv[1:], tuple(rect) if rect is not None else None)


def default_uv(m):
    """Default mode for a material: ('box', tile_m) if textured, else ('const', 0, 0)."""
    if m is not None and m.get('tex'):
        tile = float(m.get('tile_m', 0.0))
        if tile <= 0:
            raise ValueError("material %s uses atlas texture %s: pass uv= explicitly" % (m.name, m['tex']))
        return ('box', (tile,), None)
    return ('const', (0.0, 0.0), None)


def remap_rect(uv, rect):
    if rect is None:
        return uv
    u0, v0, u1, v1 = rect
    return (u0 + uv[0] * (u1 - u0), v0 + uv[1] * (v1 - v0))


def _seam_fix(us):
    if max(us) - min(us) > 0.5:
        return [u + 1.0 if u < 0.5 else u for u in us]
    return us


def corner_uvs(mode, cos, normal):
    """Per-corner (u, v) for one face.  mode = norm_uv() tuple, cos = corner coordinates
    (Vectors, builder frame), normal = face normal.  'cyl' needs grid indices: the grid
    primitives assign it themselves."""
    kind, a, rect = mode
    if kind == 'const':
        uvs = [(float(a[0]), float(a[1]))] * len(cos)
    elif kind in ('box', 'slope'):
        t = float(a[0])
        nx, ny, nz = normal
        ax, ay, az = abs(nx), abs(ny), abs(nz)
        horiz = math.hypot(nx, ny)
        if kind == 'slope' and horiz > 1e-4 and az < 0.9999:
            tx, ty = -ny / horiz, nx / horiz             # Z x n, normalised (horizontal)
            bx, by, bz = -nz * ty, nz * tx, nx * ty - ny * tx   # n x t (up the slope)
            uvs = [((p.x * tx + p.y * ty) / t, (p.x * bx + p.y * by + p.z * bz) / t) for p in cos]
        elif az >= ax and az >= ay:
            uvs = [(p.x / t, p.y / t) for p in cos]
        elif ax >= ay:
            s = 1.0 if nx >= 0 else -1.0
            uvs = [(s * p.y / t, p.z / t) for p in cos]
        else:
            s = 1.0 if ny >= 0 else -1.0
            uvs = [(-s * p.x / t, p.z / t) for p in cos]
    elif kind == 'planar':
        o, ua, va, w, h = a
        o, ua, va = Vector(o), Vector(ua).normalized(), Vector(va).normalized()
        uvs = [((p - o).dot(ua) / w, (p - o).dot(va) / h) for p in cos]
    elif kind == 'sphere':
        c = Vector(a[0])
        us, vs, poles = [], [], []
        for p in cos:
            d = p - c
            r = max(d.length, 1e-12)
            us.append(0.5 + math.atan2(d.y, d.x) / (2 * math.pi))
            vs.append(0.5 + math.asin(max(-1.0, min(1.0, d.z / r))) / math.pi)
            poles.append(math.hypot(d.x, d.y) < 1e-6 * r)
        rest = [u for u, pl in zip(us, poles) if not pl]
        if rest:
            rest = _seam_fix(rest)
            avg = sum(rest) / len(rest)
            it = iter(rest)
            us = [avg if pl else next(it) for pl in poles]
        uvs = list(zip(us, vs))
    else:
        raise ValueError("uv mode %s needs a grid primitive (lathe/capsule/tube/cylinder)" % kind)
    return [remap_rect(uv, rect) for uv in uvs]


def row_params(rows, wrap_rows=False):
    """Cumulative arc-length parameter (0..1) of grid rows: mean distance between
    consecutive rows (poles = single-point rows).  With wrap_rows the closing band
    (last row -> first row) ends at v = 1.0."""
    def dist(A, B):
        if len(A) == 1 or len(B) == 1:
            P, Q = (A, B) if len(A) == 1 else (B, A)
            return sum((Vector(P[0]) - Vector(q)).length for q in Q) / len(Q)
        n = min(len(A), len(B))
        return sum((Vector(A[j]) - Vector(B[j])).length for j in range(n)) / n
    acc = [0.0]
    for i in range(len(rows) - 1):
        acc.append(acc[-1] + dist(rows[i], rows[i + 1]))
    total = acc[-1] + (dist(rows[-1], rows[0]) if wrap_rows else 0.0)
    total = total if total > 1e-12 else 1.0
    return [x / total for x in acc]


# =============================================================================
# GLB post-processing
# =============================================================================
def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, length = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF' or ver != 2:
        raise ValueError("%s: not a glTF 2 binary" % path)
    o, js, binc = 12, None, b''
    while o < length:
        clen, ctype = struct.unpack_from('<I4s', data, o)
        body = data[o + 8:o + 8 + clen]
        if ctype == b'JSON':
            js = json.loads(body.decode('utf-8'))
        elif ctype == b'BIN\x00':
            binc = body
        o += 8 + clen
    return js, binc


def write_glb(path, js, binc):
    jb = json.dumps(js, separators=(',', ':'), allow_nan=False).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = bytes(binc) + b'\x00' * ((4 - len(binc) % 4) % 4)
    length = 12 + 8 + len(jb) + (8 + len(bb) if bb else 0)
    out = [b'glTF', struct.pack('<II', 2, length), struct.pack('<I', len(jb)), b'JSON', jb]
    if bb:
        out += [struct.pack('<I', len(bb)), b'BIN\x00', bb]
    with open(path, 'wb') as f:
        f.write(b''.join(out))


def externalize_images(glb_path):
    """Replace every embedded image of a GLB by {"name", "uri": "tex/<name>.png"}.

    The embedded bytes must equal public/assets/models/tex/<name>.png (sha1) - true when
    the exporter took its happy path (FILE image, not dirty, PNG).  The image bufferViews
    are dropped, the rest repacked with 4-byte alignment, accessor indices remapped and
    buffers[0].byteLength fixed.  Returns the list of uris."""
    js, binc = read_glb(glb_path)
    images = js.get('images', [])
    if not images:
        return []
    for ext in ('EXT_meshopt_compression', 'KHR_draco_mesh_compression'):
        if ext in js.get('extensionsUsed', []):
            raise RuntimeError("%s: %s not supported by externalize_images" % (glb_path, ext))
    views = js.get('bufferViews', [])
    drop, uris = set(), []
    tex_dir = os.path.join(os.path.dirname(os.path.abspath(glb_path)), 'tex')
    for im in images:
        name = im.get('name')
        if 'bufferView' not in im:
            if not str(im.get('uri', '')).startswith(TEX_URI):
                raise RuntimeError("%s: image %s neither embedded nor under tex/" % (glb_path, name))
            uris.append(im['uri'])
            continue
        bv = views[im['bufferView']]
        o = bv.get('byteOffset', 0)
        data = binc[o:o + bv['byteLength']]
        disk = os.path.join(tex_dir, "%s.png" % name)
        if not os.path.isfile(disk):
            raise RuntimeError("%s: embedded image %r has no file %s" % (glb_path, name, disk))
        with open(disk, 'rb') as f:
            ref = f.read()
        if hashlib.sha1(ref).hexdigest() != hashlib.sha1(data).hexdigest():
            raise RuntimeError("%s: embedded image %r differs from %s (exporter re-encoded it: "
                               "image dirty / not a PNG FILE?)" % (glb_path, name, disk))
        drop.add(im['bufferView'])
        im.clear()
        im['name'] = name
        im['uri'] = TEX_URI + name + '.png'
        uris.append(im['uri'])
    if drop:
        remap, newbin, new_views = {}, bytearray(), []
        for i, bv in enumerate(views):
            if i in drop:
                continue
            o = bv.get('byteOffset', 0)
            chunk = binc[o:o + bv['byteLength']]
            newbin += b'\x00' * ((4 - len(newbin) % 4) % 4)
            nb = dict(bv)
            nb['byteOffset'] = len(newbin)
            newbin += chunk
            remap[i] = len(new_views)
            new_views.append(nb)
        for acc in js.get('accessors', []):
            if 'bufferView' in acc:
                acc['bufferView'] = remap[acc['bufferView']]
            sp = acc.get('sparse')
            if sp:
                sp['indices']['bufferView'] = remap[sp['indices']['bufferView']]
                sp['values']['bufferView'] = remap[sp['values']['bufferView']]
        for im in images:
            if 'bufferView' in im:
                im['bufferView'] = remap[im['bufferView']]
        js['bufferViews'] = new_views
        newbin += b'\x00' * ((4 - len(newbin) % 4) % 4)
        js['buffers'][0]['byteLength'] = len(newbin)
        binc = bytes(newbin)
    write_glb(glb_path, js, binc)
    return uris


# =============================================================================
# atlas_chars: character faces (expressions), shirt patterns, accessory prints
# (drawn by build_textures.build_atlas_chars, used by build_characters_props.py)
# =============================================================================
TEX['atlas_chars'] = TexInfo('atlas_chars.png', None, False, 1024)
CHARS_W, CHARS_H = 1024, 512
FACE_CELL = 128          # px.  Expression e sits at column e % 4, row e // 4 of its species'
FACE_MARGIN = 6          # block; the patch UVs stay >= FACE_MARGIN px inside the cell.
FACE_BLOCK = {'raccoon': (0, 0), 'human': (512, 0)}
EXPRESSIONS = ('neutral', 'blink', 'happy', 'ouch', 'ko', 'panic', 'determined', 'mischief')
# Planar front projection of a head's face patch into its NEUTRAL cell:
#   px = block_x + cx + X * sx,   py = block_y + cy - Z * sz      (sx, sz: px per metre)
# X = metres toward the model's LEFT (image right), Z = metres up, both from the head centre.
FACE_PROJ = {
    'raccoon': dict(cx=64.0, cy=51.5, sx=150.0, sz=240.0),
    'human': dict(cx=64.0, cy=58.0, sx=160.0, sz=160.0),
}
SHIRT_Y = 256            # shirt pattern k (0 plain, 1 stripes, 2 dots, 3 hawaiian) at x = k * 128
SHIRT_PATTERNS = ('plain', 'stripes', 'dots', 'hawaiian')
SHIRT_INNER = 6          # px margin of the shirt UVs inside pattern cell 0


def face_cell_px(species, expr=0):
    bx, by = FACE_BLOCK[species]
    return bx + (expr % 4) * FACE_CELL, by + (expr // 4) * FACE_CELL


def face_px(species, X, Z):
    """Atlas pixel (x, y down) of head-local (X, Z) metres in the neutral face cell."""
    bx, by = FACE_BLOCK[species]
    p = FACE_PROJ[species]
    return bx + p['cx'] + X * p['sx'], by + p['cy'] - Z * p['sz']


def chars_uv(px, py):
    """Blender UV (v up) of an atlas_chars pixel position."""
    return (px / CHARS_W, 1.0 - py / CHARS_H)


def face_uv(species, X, Z):
    return chars_uv(*face_px(species, X, Z))


# 32 fixed accessory / prop colours, 8 x 4 swatches of 16 px at CHARS_SWATCH_XY.
CHARS_PALETTE = {
    'ink': '#2b2340', 'charcoal': '#3b3d52', 'slate': '#5a6072', 'steel': '#9aa3b5',
    'silver': '#c7cdd8', 'cloud': '#eef1f6', 'white': '#ffffff', 'cream': '#fff1d6',
    'red': '#ff4d5e', 'cherry': '#d92b3a', 'pink': '#ff8fb8', 'orange': '#ff9f43',
    'gold': '#ffc94d', 'yellow': '#ffd23f', 'lemon': '#ffe98a', 'straw': '#ecd08f',
    'brown': '#8a5a3c', 'chocolate': '#5e3a28', 'wood': '#c98a57', 'cork': '#d9a066',
    'olive': '#7d8a4a', 'khaki': '#b9b07a', 'leaf': '#6cc66f', 'bottle': '#3faf6a',
    'mint': '#9fe8c8', 'teal': '#2ec4b6', 'sky': '#6ec3ff', 'navy': '#2a4fb8',
    'purple': '#9b7bff', 'lilac': '#d6c4ff', 'glass': '#bfe8ff', 'rubber': '#2d2d3a',
}
CHARS_SWATCH_XY = (512, 256)
CHARS_SWATCH_PX = 16
assert len(CHARS_PALETTE) == 32


def chars_swatch_px(name):
    i = list(CHARS_PALETTE).index(name)
    x0, y0 = CHARS_SWATCH_XY
    return (x0 + (i % 8) * CHARS_SWATCH_PX + CHARS_SWATCH_PX / 2.0,
            y0 + (i // 8) * CHARS_SWATCH_PX + CHARS_SWATCH_PX / 2.0)


def chars_swatch_uv(name):
    """Constant Blender UV at the centre of an atlas_chars swatch: uv=('const', *chars_swatch_uv('red'))."""
    return chars_uv(*chars_swatch_px(name))


# Accessory prints: pitch rects (x, y, w, h) in px; the art fills the content rect (inset by
# CHARS_GUTTER, edge-extended into the gutter).
CHARS_GUTTER = 6
CHARS_PRINTS = {
    'paisley': (640, 256, 128, 128),     # bandana (grey on white: tinted by Acc)
    'sack': (768, 256, 128, 128),        # burlap loot sack with a sewn patch
    'apron': (896, 256, 128, 128),       # chef apron: pinstripes + ketchup splat
    'skull': (512, 320, 64, 64),         # pirate hat skull & crossbones
    'stink': (576, 320, 64, 64),         # stink bomb label
    'pest': (512, 384, 128, 64),         # PEST CONTROL overalls patch
    'tank': (640, 384, 128, 64),         # spray tank label (no raccoons!)
    'tie': (768, 384, 64, 128),          # office tie stripes
    'hatband': (832, 384, 128, 32),      # tourist sun hat band (flowers)
    'badge': (832, 416, 64, 64),         # kid backpack pocket badge (star)
    'knit': (896, 416, 64, 64),          # beanie rib knit (grey on white: tinted by Acc)
    'camera': (960, 416, 64, 64),        # camera front (lens)
}


def chars_print_px(name):
    """Content rect (x, y, w, h) px of a print."""
    x, y, w, h = CHARS_PRINTS[name]
    g = CHARS_GUTTER
    return x + g, y + g, w - 2 * g, h - 2 * g


def chars_print_rect(name):
    """Blender UV rect (u0, v0, u1, v1) of a print's content (for uv=(..., {'rect': ...}))."""
    x, y, w, h = chars_print_px(name)
    return (x / CHARS_W, 1.0 - (y + h) / CHARS_H, (x + w) / CHARS_W, 1.0 - y / CHARS_H)
