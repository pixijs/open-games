"""Bake every texture used by the mini-gta GLBs (Blender 5.2 + numpy, headless).

Runs FIRST in the pipeline (assets-src/build-assets.mjs): the model scripts load these
PNGs with common_tex.load_tex() and the glTF exporter embeds them verbatim, after which
common_tex.externalize_images() turns them into uri "tex/<name>.png" references.

Run (from the project root):
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      --python-exit-code 1 --python assets-src/blender/build_textures.py
Optional args after `--`:
  --only a,b     rebuild only the named textures (names that are not textures are ignored;
                 if none match, nothing is rebuilt)
  --no-preview   skip the contact sheet

Outputs (all deterministic: seeded numpy + a CPU/GPU Workbench text render):
  public/assets/models/tex/<name>.png     greyscale tiling multipliers + atlas_town (RGB)
  src/client/gfx/atlasTown.gen.json       atlas cells: glTF UV rects + pixel rects
  assets-src/previews/textures.png        contact sheet (1:1 seam crossings, tinted "game
                                          distance" views, the atlas)

Tiling textures are GREYSCALE and mostly white: they multiply the material colour (also
the runtime tints), so the mean of (v/255)^2.2 is kept around 0.80-0.95 and details are
darker variations.  The atlas is full colour (white material colour, explicit UVs).
"""
import json
import math
import os
import sys
import time
import traceback

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import common_tex as T  # noqa: E402
from common_tex import (Canvas, blur, col, cover, dilate_disc, fbm, grid, hash01, pnoise,  # noqa: E402
                        quantize, resize, sd_arc, sd_capsule, sd_circle, sd_ellipse, sd_poly,
                        sd_rbox, sd_segment, sd_star, sd_union, shift, to_u8)

ROOT = T.ROOT
PREVIEWS = os.path.join(ROOT, "assets-src", "previews")
ATLAS_JSON = os.path.join(ROOT, "src", "client", "gfx", "atlasTown.gen.json")
INK = T.INK
P = T.PALETTE


# =============================================================================
# helpers
# =============================================================================
def stamp(img, cx, cy, rad, fn, mode='max', k=1.0):
    """Evaluate fn(X, Y) (coverage / value) in a periodic window around (cx, cy) and
    combine it into img ('max', 'min', 'mul': img *= 1 - k c, 'add': img += k c)."""
    H, W = img.shape
    x0, y0 = int(math.floor(cx - rad)), int(math.floor(cy - rad))
    n = int(math.ceil(2 * rad)) + 2
    xs, ys = np.arange(x0, x0 + n), np.arange(y0, y0 + n)
    Xl, Yl = np.meshgrid(xs + 0.5, ys + 0.5)
    c = fn(Xl, Yl)
    ix, iy = np.mod(xs, W), np.mod(ys, H)
    sub = img[np.ix_(iy, ix)]
    if mode == 'max':
        sub = np.maximum(sub, k * c)
    elif mode == 'min':
        sub = np.minimum(sub, c)
    elif mode == 'mul':
        sub = sub * (1.0 - k * c)
    elif mode == 'add':
        sub = sub + k * c
    img[np.ix_(iy, ix)] = sub


def anoise(n, fx0, fy0, seed):
    """Anisotropic tileable noise (Gaussian low-pass with different x / y cut-offs)."""
    h, w = (n, n) if np.isscalar(n) else n
    white = T.rng(seed).standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    G = np.exp(-(fx ** 2 / (2.0 * fx0 ** 2) + fy ** 2 / (2.0 * fy0 ** 2)))
    a = np.fft.irfft2(np.fft.rfft2(white) * G, s=(h, w))
    a -= a.min()
    return a / max(a.max(), 1e-12)


def grain(n, seed, sigma=0.0):
    """Zero-mean, unit-std fine noise (optionally blurred), periodic."""
    g = T.rng(seed).standard_normal((n, n) if np.isscalar(n) else n)
    if sigma > 0:
        g = blur(g, sigma)
    return g / max(g.std(), 1e-9)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def crack_field(S, seed, n=3, length=(110, 190), width=0.65, branch=0.035):
    """Random-walk cracks (coverage 0..1), periodic: mostly straight with sudden kinks."""
    r = T.rng(seed)
    field = np.zeros((S, S))

    def walk(x, y, ang, steps, w, depth):
        heading = ang
        for _ in range(steps):
            if r.random() < 0.12:
                heading += r.normal(0.0, 0.55)          # kink
            ang = heading + r.normal(0.0, 0.18)         # jagged, but keeps its course
            nx, ny = x + 2.0 * math.cos(ang), y + 2.0 * math.sin(ang)
            stamp(field, (x + nx) / 2, (y + ny) / 2, 3.0,
                  lambda X, Y, a=(x, y, nx, ny): cover(sd_capsule(X, Y, a[0], a[1], a[2], a[3], w)),
                  'max')
            x, y = nx, ny
            w = max(0.4, w * 0.997)
            if depth < 1 and r.random() < branch:
                walk(x, y, heading + r.choice([-1, 1]) * r.uniform(0.6, 1.1), int(steps * 0.3), w * 0.8,
                     depth + 1)
    for _ in range(n):
        walk(r.uniform(0, S), r.uniform(0, S), r.uniform(0, 2 * math.pi),
             int(r.uniform(*length) / 2), width, 0)
    return field


def report(name, v):
    lin, far = T.linear_mean(to_u8(v))
    return "%-10s mean lin %.3f  far-mip %.3f  range %.2f..%.2f" % (name, lin, far, v.min(), v.max())


# =============================================================================
# greyscale tiling textures (float 0..1, periodic)
# =============================================================================
def tex_grass(S=256, seed=11):
    X, Y = grid(S, S)
    base = fbm(S, 3.0, seed, octaves=4, gain=0.5)
    v = 0.88 + 0.11 * quantize(base, 7)
    blades = np.zeros((S, S))
    light = np.zeros((S, S))
    r = T.rng(seed + 2)

    def blade(x, y, ang, L, tgt, k):
        x1, y1 = x + L * math.cos(ang), y + L * math.sin(ang)
        stamp(tgt, (x + x1) / 2, (y + y1) / 2, L / 2 + 2.5,
              lambda X_, Y_, a=(x, y, x1, y1): cover(sd_capsule(X_, Y_, a[0], a[1], a[2], a[3], 0.6, 0.2)),
              'max', k)
    for i in range(1300):                            # loose short blades
        blade(r.uniform(0, S), r.uniform(0, S), math.radians(-90 + r.normal(0, 24)), r.uniform(3.5, 7.0),
              blades if r.random() < 0.7 else light, r.uniform(0.6, 1.0))
    for i in range(110):                             # tufts: little fans of darker blades
        x, y = r.uniform(0, S), r.uniform(0, S)
        for k in range(r.integers(4, 7)):
            blade(x + r.normal(0, 0.8), y, math.radians(-90 + r.uniform(-48, 48)), r.uniform(5.0, 9.0), blades, 1.0)
    v *= 1.0 - 0.15 * blades
    v += 0.05 * light
    # clover clusters (three round leaves, slightly lighter, dark centre dot)
    for i in range(34):
        x, y = r.uniform(0, S), r.uniform(0, S)
        rot = r.uniform(0, 2 * math.pi)
        lv = np.zeros((S, S))
        for k in range(3):
            a = rot + 2 * math.pi * k / 3
            cx, cy = x + 2.6 * math.cos(a), y + 2.6 * math.sin(a)
            stamp(lv, cx, cy, 5, lambda X_, Y_, c=(cx, cy): cover(sd_circle(X_, Y_, c[0], c[1], 2.3)), 'max')
        v = v * (1 - 0.08 * lv) + 0.08 * lv * 1.0
        stamp(v, x, y, 3, lambda X_, Y_, c=(x, y): 1.0 - 0.12 * cover(sd_circle(X_, Y_, c[0], c[1], 0.9)), 'min')
    return np.clip(v, 0, 1)


def tex_asphalt(S=256, seed=21):
    v = np.full((S, S), 0.93)
    v += 0.028 * grain(S, seed, 0.6)                      # fine aggregate
    v += 0.014 * grain(S, seed + 1, 0.0)
    patches = smoothstep(0.55, 0.68, pnoise(S, 2.3, seed + 2))
    v *= 1.0 - 0.06 * patches                             # slightly darker patches
    v *= 1.0 - 0.025 * (pnoise(S, 5.0, seed + 3) - 0.5)
    r = T.rng(seed + 4)
    spk = np.zeros((S, S))
    for i in range(900):                                  # bright stone speckles
        x, y = r.uniform(0, S), r.uniform(0, S)
        rad = r.uniform(0.45, 1.05)
        stamp(spk, x, y, 2.5, lambda X, Y, c=(x, y, rad): cover(sd_circle(X, Y, c[0], c[1], c[2])), 'max',
              r.uniform(0.5, 1.0))
    v = v + (1.0 - v) * 0.85 * spk
    for i in range(160):                                  # a few darker pebbles
        x, y = r.uniform(0, S), r.uniform(0, S)
        stamp(v, x, y, 2.5, lambda X, Y, c=(x, y): 1.0 - 0.09 * cover(sd_circle(X, Y, c[0], c[1], 0.8)), 'min')
    cr = crack_field(S, seed + 5, n=3)
    v = v * (1.0 - cr) + 0.70 * cr
    return np.clip(v, 0, 1)


def tex_paving(S=256, seed=31, n=4):
    X, Y = grid(S, S)
    cell = S / n
    ix, iy = np.floor(X / cell).astype(int) % n, np.floor(Y / cell).astype(int) % n
    lx, ly = X - ix * cell, Y - iy * cell
    tone = 0.90 + 0.10 * hash01(ix, iy, seed=seed)
    v = tone + 0.018 * grain(S, seed + 1, 0.7)
    v *= 1.0 - 0.035 * (pnoise(S, 6.0, seed + 2) - 0.5)
    stains = smoothstep(0.62, 0.8, pnoise(S, 5.0, seed + 3))
    v *= 1.0 - 0.05 * stains
    # bevelled slab edges: light top/left lip, darker bottom/right lip
    v += 0.035 * cover(lx - 3.0) * (ly > 2)
    v += 0.035 * cover(ly - 3.0) * (lx > 2)
    v -= 0.04 * cover((cell - lx) - 3.0)
    v -= 0.04 * cover((cell - ly) - 3.0)
    # chipped corners (periodic): a jagged triangular bite out of some slab corners
    r = T.rng(seed + 4)
    chip = np.zeros((S, S))
    for j in range(n):
        for i in range(n):
            if r.random() < 0.5:
                sx, sy = r.choice([-1, 1]), r.choice([-1, 1])     # which slab of the corner
                ox, oy = i * cell, j * cell
                a, b = r.uniform(4.0, 8.0), r.uniform(4.0, 8.0)
                m = r.uniform(0.3, 0.6)
                tri = [(ox, oy), (ox + sx * a, oy), (ox + sx * a * m * 1.1, oy + sy * b * m * 0.9),
                       (ox, oy + sy * b)]
                stamp(chip, ox, oy, 10, lambda X_, Y_, p=tri: cover(sd_poly(X_, Y_, p)), 'max')
    v = v * (1.0 - chip) + 0.70 * chip
    # joints
    dj = np.minimum(np.minimum(lx, cell - lx), np.minimum(ly, cell - ly))
    joint = cover(dj - 1.4)
    v = v * (1.0 - joint) + 0.66 * joint
    return np.clip(v, 0, 1)


def herringbone_ids(S, unit):
    """Per pixel: (centre x, centre y) of its 2:1 herringbone brick (pixels, mod S),
    distance to the brick's edge (px).  Lattice: H = [0,2]x[0,1], V = [2,3]x[0,2] translated
    by a(1,-1) + b(2,2) units (tiles when S/unit is a multiple of 4)."""
    X, Y = grid(S, S)
    x, y = X / unit, Y / unit
    a0 = np.floor((x - y) / 2.0)
    b0 = np.floor((x + y) / 4.0)
    cx = np.zeros_like(x)
    cy = np.zeros_like(x)
    de = np.full_like(x, -1.0)
    for da in (-2, -1, 0, 1):
        for db in (-1, 0, 1):
            A, B = a0 + da, b0 + db
            ox, oy = A + 2 * B, -A + 2 * B
            qx, qy = x - ox, y - oy
            inH = (qx >= 0) & (qx < 2) & (qy >= 0) & (qy < 1)
            inV = (qx >= 2) & (qx < 3) & (qy >= 0) & (qy < 2)
            dH = np.minimum(np.minimum(qx, 2 - qx), np.minimum(qy, 1 - qy))
            dV = np.minimum(np.minimum(qx - 2, 3 - qx), np.minimum(qy, 2 - qy))
            sel = inH & (de < 0)
            cx[sel], cy[sel], de[sel] = (ox + 1)[sel], (oy + 0.5)[sel], dH[sel]
            sel = inV & (de < 0)
            cx[sel], cy[sel], de[sel] = (ox + 2.5)[sel], (oy + 1)[sel], dV[sel]
    assert (de >= 0).all(), "herringbone: uncovered pixels"
    return np.mod(cx * unit, S), np.mod(cy * unit, S), de * unit


def tex_plaza(S=256, seed=41, unit=16):
    cx, cy, de = herringbone_ids(S, unit)
    kx, ky = np.round(cx * 2).astype(int), np.round(cy * 2).astype(int)
    tone = 0.91 + 0.09 * quantize(hash01(kx, ky, seed=seed), 5)
    v = tone + 0.012 * grain(S, seed + 1, 0.6)
    v *= 1.0 - 0.04 * (pnoise(S, 4.0, seed + 2) - 0.5)
    v -= 0.02 * cover(de - 2.6) * (1 - cover(de - 1.1))     # soft lip next to the joint
    joint = cover(de - 0.95)
    v = v * (1.0 - joint) + 0.76 * joint
    return np.clip(v, 0, 1)


def tex_lot(S=256, seed=51):
    X, Y = grid(S, S)
    v = np.full((S, S), 0.94)
    v += 0.03 * (fbm(S, 4.0, seed, octaves=2) - 0.5)
    v += 0.016 * grain(S, seed + 1, 0.6)
    r = T.rng(seed + 2)
    oil = np.zeros((S, S))
    for i in range(7):
        x, y = r.uniform(0, S), r.uniform(0, S)
        for k in range(r.integers(2, 5)):
            ex, ey = x + r.normal(0, 7), y + r.normal(0, 7)
            rx, ry, ang = r.uniform(5, 13), r.uniform(4, 9), r.uniform(0, 180)
            stamp(oil, ex, ey, 18, lambda X_, Y_, c=(ex, ey, rx, ry, ang): cover(
                sd_ellipse(X_, Y_, c[0], c[1], c[2], c[3], c[4]), 2.0), 'max', r.uniform(0.6, 1.0))
    oil = blur(oil, 3.5)
    v *= 1.0 - 0.17 * np.clip(oil, 0, 1)
    for jx in (0.0, S / 2.0):                                   # saw-cut joints every 3 m
        d = np.abs(((X - jx + S / 2) % S) - S / 2)
        v = v * (1 - 0.12 * cover(d - 0.8))
        d = np.abs(((Y - jx + S / 2) % S) - S / 2)
        v = v * (1 - 0.12 * cover(d - 0.8))
    return np.clip(v, 0, 1)


def tex_ballast(S=128, seed=61, n=90):
    """Rounded pebbles: per Voronoi cell a stone whose outline is the cell shrunk toward its
    seed with rounded corners (Voronoi edge distance blended with the seed distance), a
    little dome shading, darker grit in the gaps.  Periodic (9 copies of the seeds)."""
    X, Y = grid(S, S)
    r = T.rng(seed)
    pts = r.uniform(0, S, (n, 2))
    ids = np.tile(np.arange(n), 9)

    def voronoi(pts):
        P = np.concatenate([pts + (ox, oy) for oy in (-S, 0, S) for ox in (-S, 0, S)])
        F1 = np.zeros((S, S))
        F2 = np.zeros((S, S))
        J1 = np.zeros((S, S), int)                               # index into P (with offsets)
        for y0 in range(0, S, 16):
            d = np.hypot(X[y0:y0 + 16, :, None] - P[None, None, :, 0], Y[y0:y0 + 16, :, None] - P[None, None, :, 1])
            part = np.argpartition(d, 1, axis=2)[..., :2]
            d1 = np.take_along_axis(d, part[..., :1], 2)[..., 0]
            d2 = np.take_along_axis(d, part[..., 1:2], 2)[..., 0]
            sw = d2 < d1
            F1[y0:y0 + 16] = np.where(sw, d2, d1)
            F2[y0:y0 + 16] = np.where(sw, d1, d2)
            J1[y0:y0 + 16] = np.where(sw, part[..., 1], part[..., 0])
        return P, F1, F2, J1
    for _ in range(3):                                           # Lloyd relaxation (periodic)
        P, F1, F2, J1 = voronoi(pts)
        I1 = ids[J1]
        dx, dy = X - P[J1, 0], Y - P[J1, 1]                     # offsets from the cell's own seed copy
        cnt = np.bincount(I1.ravel(), minlength=n)
        mx = np.bincount(I1.ravel(), dx.ravel(), minlength=n) / np.maximum(cnt, 1)
        my = np.bincount(I1.ravel(), dy.ravel(), minlength=n) / np.maximum(cnt, 1)
        pts = np.mod(pts + 0.85 * np.stack([mx, my], 1), S)
    P, F1, F2, J1 = voronoi(pts)
    I1 = ids[J1]
    # per-stone size: distance to the nearest other seed
    dd = np.hypot(pts[:, None, 0] - P[None, :, 0], pts[:, None, 1] - P[None, :, 1])
    dd[dd < 1e-6] = 1e9
    nn = dd.min(axis=1)
    SX, SY = P[J1, 0], P[J1, 1]                                  # the nearest seed copy itself
    edge = (F2 - F1) / 2.0                                       # distance to the cell border
    rad = 0.9 * nn[I1]                                           # stone "radius" around its seed
    # signed inside-distance of a rounded stone: min(edge, rad - F1), softened at corners
    inside = np.minimum(edge - 0.35, rad - F1)
    tone = 0.92 + 0.08 * quantize(hash01(I1, seed=seed), 5)
    dome = 1.0 - 0.10 * np.clip(F1 / np.maximum(rad, 1e-6), 0, 1) ** 2
    lit = 0.03 * np.clip(((SX - X) + (SY - Y)) / np.maximum(rad, 1e-6), -1, 1)
    stone = tone * dome + lit
    grit = 0.72 + 0.05 * grain(S, seed + 2, 0.6)
    a = smoothstep(-0.4, 0.8, inside)
    v = grit * (1 - a) + stone * a
    v *= 1.0 - 0.08 * smoothstep(0.0, 1.6, 1.2 - inside) * a    # soft contact shadow rim
    return np.clip(v, 0, 1)


def tex_wood(S=128, seed=71, planks=5):
    X, Y = grid(S, S)
    ph = S / planks
    k = np.floor(Y / ph).astype(int) % planks
    ly = Y - k * ph
    r = T.rng(seed)
    shifts = r.uniform(0, S, planks)
    g = anoise(S, 1.6, 9.0, seed + 1)
    v = np.zeros((S, S))
    tone = 0.935 + 0.055 * r.uniform(0, 1, planks)
    for i in range(planks):
        sel = k == i
        gx = np.roll(g, int(shifts[i]), axis=1)
        lines = 0.5 + 0.5 * np.sin(2 * math.pi * (Y / 5.5 + 3.2 * gx))
        vv = tone[i] - 0.04 * quantize(lines, 4) - 0.015 * gx
        v[sel] = vv[sel]
    v += 0.01 * grain(S, seed + 2, 0.5)
    # knots
    for i in range(3):
        kx, ky = r.uniform(0, S), (r.integers(0, planks) + r.uniform(0.3, 0.7)) * ph
        for rr, dv in ((4.0, 0.04), (2.4, 0.06), (1.2, 0.09)):
            stamp(v, kx, ky, 8, lambda X_, Y_, c=(kx, ky, rr): cover(sd_ellipse(X_, Y_, c[0], c[1], c[2] * 1.7, c[2])),
                  'mul', dv)
    # plank seams (with a slight shadow under each) + staggered butt joints
    dseam = np.minimum(ly, ph - ly)
    v -= 0.035 * cover(ly - 2.2) * (1 - cover(ly - 0.8))
    seam = cover(dseam - 0.65)
    v = v * (1 - seam) + 0.62 * seam
    for i in range(planks):
        bx = r.uniform(0, S)
        d = np.abs(((X - bx + S / 2) % S) - S / 2)
        sel = (k == i) & (dseam > 0.6)
        v[sel] = (v * (1 - 0.28 * cover(d - 0.6)))[sel]
    return np.clip(v, 0, 1)


def tex_brick(S=256, seed=81, courses=12, per_row=4):
    X, Y = grid(S, S)
    ch = S / courses
    bw = S / per_row
    row = np.floor(Y / ch).astype(int) % courses
    off = (row % 2) * (bw / 2)
    xb = (X + off) % S
    col_ = np.floor(xb / bw).astype(int) % per_row
    lx, ly = xb - col_ * bw, Y - row * ch
    tone = 0.86 + 0.14 * quantize(hash01(row, col_, seed=seed), 5)
    v = tone + 0.02 * grain(S, seed + 1, 0.8)
    v *= 1.0 - 0.05 * (pnoise(S, 3.0, seed + 2) - 0.5)
    v += 0.03 * cover(ly - 3.0) - 0.04 * cover((ch - ly) - 3.0)  # lit top edge, shaded bottom
    dj = np.minimum(np.minimum(lx, bw - lx), np.minimum(ly, ch - ly))
    joint = cover(dj - 1.3)
    mortar = 0.74 + 0.04 * (pnoise(S, 12.0, seed + 3) - 0.5)
    v = v * (1 - joint) + mortar * joint
    return np.clip(v, 0, 1)


def tex_siding(S=256, seed=91, boards=8):
    X, Y = grid(S, S)
    bh = S / boards
    k = np.floor(Y / bh).astype(int) % boards
    t = Y - k * bh                                   # 0 at the top of the board
    v = 0.965 + 0.025 * (t / bh)                     # a little lighter toward the lip
    v -= 0.26 * np.exp(-t / 2.4)                     # shadow cast by the board above
    v += 0.03 * cover((bh - t) - 1.6)                # lit bottom lip
    v += 0.012 * (anoise(S, 1.5, 10.0, seed) - 0.5)
    v += 0.008 * grain(S, seed + 1, 0.6)
    r = T.rng(seed + 2)
    for i in range(boards):                          # butt joints
        for _ in range(1 if r.random() < 0.6 else 2):
            bx = r.uniform(0, S)
            d = np.abs(((X - bx + S / 2) % S) - S / 2)
            sel = (k == i) & (t > 2.5)
            v[sel] = (v * (1 - 0.22 * cover(d - 0.6)))[sel]
    return np.clip(v, 0, 1)


def tex_stucco(S=256, seed=101):
    """Two-octave trowelled plaster (0.88-1.0): soft mid-size dabs over a fine bumpy grain."""
    n = 0.45 * pnoise(S, 16.0, seed) + 0.55 * pnoise(S, 48.0, seed + 1)
    n = (n - n.min()) / (n.max() - n.min())
    n = smoothstep(0.2, 0.85, n)                    # flatter plateaus, short soft edges
    v = 0.88 + 0.12 * quantize(n, 10)
    v -= 0.006 * np.clip(grain(S, seed + 2, 0.6), -2, 2)
    return np.clip(v, 0, 1)


def tex_shingle(S=256, seed=111, rows=8, per_row=8):
    """Fish-scale shingles: rows painted bottom->top on a taller canvas (rows -1..rows)
    so each row's scallops overlap the row below, then cropped (seamless)."""
    rh, sw = S / rows, S / per_row
    rad = sw / 2.0
    pad = int(2 * rh)
    Hc = S + 2 * pad
    X, Y = grid(Hc, S)
    Y = Y - pad
    v = np.full((Hc, S), 0.8)
    for rr in range(rows, -2, -1):
        rk = rr % rows
        off = (rk % 2) * (sw / 2)
        yc = rr * rh + rh / 2                      # where the round bottom starts
        best = None
        for i in range(-1, per_row + 1):
            cx = i * sw + off + sw / 2
            for ox in (-S, 0, S):
                d = sd_union(sd_rbox(X, Y, cx + ox, yc - rh / 2, sw / 2, rh / 2),
                             sd_circle(X, Y, cx + ox, yc, rad))
                best = d if best is None else np.minimum(best, d)
        d = best
        # tone per shingle (periodic id)
        sid = np.floor(((X - off) % S) / sw).astype(int)
        tone = 0.92 + 0.08 * quantize(hash01(sid, np.full_like(sid, rk), seed=seed), 5)
        # cast shadow onto the row below, then the shingle itself
        sh = cover(d - 3.0, 3.0) * (1 - cover(d))
        v = v * (1 - 0.13 * sh)
        inside = cover(d)
        tb = np.clip((Y - (yc - rh / 2)) / rh, 0, 1)    # 0 top .. 1 round bottom
        face = tone * (0.94 + 0.06 * tb)                 # lighter toward the rounded lip
        v = v * (1 - inside) + face * inside
        rim = inside * (1 - cover(d + 1.0))              # dark rim along the scallop edge
        v = v * (1 - 0.16 * rim)
    v = v[pad:pad + S]
    v += 0.01 * grain(S, seed + 1, 0.8)
    return np.clip(v, 0, 1)


def tex_roof_tar(S=128, seed=121):
    X, Y = grid(S, S)
    v = np.full((S, S), 0.93)
    v += 0.035 * grain(S, seed, 0.55)
    v *= 1.0 - 0.05 * smoothstep(0.5, 0.75, pnoise(S, 2.5, seed + 1))
    r = T.rng(seed + 2)
    for i in range(240):
        x, y = r.uniform(0, S), r.uniform(0, S)
        stamp(v, x, y, 2, lambda X_, Y_, c=(x, y): 1.0 - 0.07 * cover(sd_circle(X_, Y_, c[0], c[1], 0.7)), 'min')
    for yy in (0.0, S / 2.0):                        # membrane seams every 1.5 m
        d = ((Y - yy) % S)
        v = v * (1 - 0.10 * cover(np.minimum(d, S - d) - 0.8)) + 0.03 * cover(np.abs(d - 2.0) - 0.7)
    return np.clip(v, 0, 1)


def tex_metal(S=128, seed=131):
    X, Y = grid(S, S)
    v = np.full((S, S), 0.93)
    v += 0.07 * (anoise(S, 1.2, 40.0, seed) - 0.5)        # brushed streaks along u
    v += 0.025 * (anoise(S, 3.0, 60.0, seed + 1) - 0.5)
    v += 0.02 * (pnoise(S, 2.0, seed + 3) - 0.5)           # faint large-scale unevenness
    r = T.rng(seed + 2)
    dents = np.zeros((S, S))
    for i in range(14):                                     # small, varied dings (lit from top-left)
        x, y = r.uniform(0, S), r.uniform(0, S)
        rad = r.uniform(2.0, 5.0)
        k = r.uniform(0.4, 1.0)
        stamp(dents, x, y, rad * 2.5, lambda X_, Y_, c=(x, y, rad, k): c[3] * np.exp(
            -((X_ - c[0]) ** 2 + (Y_ - c[1]) ** 2) / (2 * c[2] ** 2)) * (X_ - c[0] + Y_ - c[1]) / c[2], 'add')
    v += 0.03 * dents
    return np.clip(v, 0, 1)


TILING = {
    'grass': tex_grass, 'asphalt': tex_asphalt, 'paving': tex_paving, 'plaza': tex_plaza,
    'lot': tex_lot, 'ballast': tex_ballast, 'wood': tex_wood, 'brick': tex_brick,
    'siding': tex_siding, 'stucco': tex_stucco, 'shingle': tex_shingle, 'roof_tar': tex_roof_tar,
    'metal': tex_metal,
}
TINT = {  # typical game colours, for the contact sheet's "game distance" views
    'grass': '#8fd16a', 'asphalt': '#4f5566', 'paving': '#ecd9bd', 'plaza': '#f6d7b0',
    'lot': '#6a6f7e', 'ballast': '#b4a796', 'wood': '#edb57e', 'brick': '#e0876a',
    'siding': '#ffe5a3', 'stucco': '#bff0dc', 'shingle': '#f2706b', 'roof_tar': '#8c9bb5',
    'metal': '#dfe7f0',
}


# =============================================================================
# atlas art (sRGB float canvases)
# =============================================================================
RAC = '#9a95a8'       # raccoon fur
RAC_D = '#5c556b'     # inner ear / dark fur
MASK = '#3a3347'
CREAM = '#fff6e8'


def raccoon_head(cv, cx, cy, s, ow=None, look=(0.0, 0.0), mood='smile', blush=True, ears=True,
                 outline=INK):
    """Cartoon raccoon head centred at (cx, cy); s = half width of the head (px)."""
    X, Y = cv.X, cv.Y
    ow = max(1.2, 0.075 * s) if ow is None else ow
    parts = [sd_ellipse(X, Y, cx, cy, s, 0.78 * s)]
    for sx in (-1, 1):
        if ears:
            parts.append(sd_ellipse(X, Y, cx + sx * 0.6 * s, cy - 0.6 * s, 0.28 * s, 0.34 * s, ang=sx * 28))
        parts.append(sd_poly(X, Y, [(cx + sx * 0.7 * s, cy + 0.02 * s), (cx + sx * 1.22 * s, cy + 0.36 * s),
                                    (cx + sx * 0.52 * s, cy + 0.6 * s)]))
    sil = sd_union(*parts)
    cv.shape(sil, RAC, outline=outline, ow=ow)
    if ears:
        for sx in (-1, 1):
            cv.shape(sd_ellipse(X, Y, cx + sx * 0.6 * s, cy - 0.58 * s, 0.15 * s, 0.2 * s, ang=sx * 28), RAC_D)
    # white brow / muzzle patches
    for sx in (-1, 1):
        cv.shape(sd_ellipse(X, Y, cx + sx * 0.36 * s, cy - 0.3 * s, 0.3 * s, 0.13 * s, ang=sx * -12), CREAM)
    cv.shape(sd_ellipse(X, Y, cx, cy + 0.38 * s, 0.46 * s, 0.32 * s), CREAM)
    cv.shape(sd_ellipse(X, Y, cx, cy - 0.28 * s, 0.09 * s, 0.34 * s), RAC_D, alpha=0.55)
    # bandit mask
    mask = sd_union(sd_ellipse(X, Y, cx - 0.4 * s, cy + 0.02 * s, 0.4 * s, 0.24 * s, ang=14),
                    sd_ellipse(X, Y, cx + 0.4 * s, cy + 0.02 * s, 0.4 * s, 0.24 * s, ang=-14),
                    sd_rbox(X, Y, cx, cy - 0.02 * s, 0.25 * s, 0.1 * s, 0.05 * s))
    cv.shape(mask, MASK)
    for sx in (-1, 1):
        ex, ey = cx + sx * 0.38 * s, cy
        cv.shape(sd_circle(X, Y, ex, ey, 0.16 * s), '#ffffff')
        px, py = ex + look[0] * 0.05 * s, ey + look[1] * 0.05 * s
        cv.shape(sd_circle(X, Y, px, py, 0.105 * s), INK)
        cv.shape(sd_circle(X, Y, px - 0.04 * s, py - 0.045 * s, 0.04 * s), '#ffffff')
        if blush:
            cv.shape(sd_ellipse(X, Y, cx + sx * 0.6 * s, cy + 0.38 * s, 0.12 * s, 0.07 * s), '#ff9aae', alpha=0.85)
    cv.shape(sd_ellipse(X, Y, cx, cy + 0.25 * s, 0.13 * s, 0.085 * s), INK)
    th = max(0.6, 0.028 * s)
    if mood == 'smile':
        for sx in (-1, 1):
            cv.shape(sd_arc(X, Y, cx + sx * 0.085 * s, cy + 0.33 * s, 0.085 * s, 10, 170, th), INK)
    elif mood == 'grin':
        m = sd_ellipse(X, Y, cx, cy + 0.44 * s, 0.17 * s, 0.1 * s)
        m = np.maximum(m, -(Y - (cy + 0.42 * s)))
        cv.shape(m, '#7c2f3b', outline=INK, ow=th)
        cv.shape(sd_rbox(X, Y, cx, cy + 0.44 * s, 0.07 * s, 0.03 * s), '#ffffff')
    elif mood == 'o':
        cv.shape(sd_ellipse(X, Y, cx, cy + 0.45 * s, 0.07 * s, 0.08 * s), '#7c2f3b', outline=INK, ow=th)
    return sil


def paw(cv, cx, cy, s, ang, color, outline=None, ow=0.0, alpha=1.0):
    """Paw print (pad + 4 toes) centred at (cx, cy), size s (px), pointing to `ang` degrees
    (0 = up on screen, clockwise)."""
    X, Y = cv.X, cv.Y
    a = math.radians(ang)
    ca, sa = math.cos(a), math.sin(a)
    parts = []

    def P(dx, dy):
        # local offset (dx right, dy up) rotated clockwise by ang; image y points down
        return cx + dx * ca + dy * sa, cy + dx * sa - dy * ca
    px, py = P(0, -0.18 * s)
    parts.append(sd_ellipse(X, Y, px, py, 0.42 * s, 0.34 * s, ang=ang))
    for k, (dx, dy, rr) in enumerate(((-0.42, 0.28, 0.15), (-0.15, 0.48, 0.16), (0.15, 0.48, 0.16), (0.42, 0.28, 0.15))):
        tx, ty = P(dx * s, dy * s)
        parts.append(sd_ellipse(X, Y, tx, ty, rr * s, rr * 1.25 * s, ang=ang + dx * 40))
    d = sd_union(*parts)
    cv.shape(d, color, outline=outline, ow=ow, alpha=alpha)
    return d


def fill_bg(cv, color, seed=None, grain_amt=0.0, f0=None):
    if cv.a is not None:                 # transparent canvas: no background
        return
    cv.rgb[:] = col(color)
    if seed is not None and grain_amt > 0:
        cv.noise(grain_amt, seed, f0=f0)


def frame(cv, color=INK, w=4.0, r=0.0, inset=0.0):
    """Ink frame along the canvas edge (square outside, rounded inside)."""
    X, Y = cv.X, cv.Y
    inner = sd_rbox(X, Y, cv.w / 2, cv.h / 2, cv.w / 2 - inset - w, cv.h / 2 - inset - w, r)
    outer = sd_rbox(X, Y, cv.w / 2, cv.h / 2, cv.w / 2 - inset, cv.h / 2 - inset, r + w if r else 0.0)
    cv.shape(np.maximum(outer, -inner), color)


def shine_text(cv, s, cx, cy, h, fill, outline=INK, ow=3.0, max_w=None, shadow=True, hl=True, **kw):
    """Bold sign lettering: ink outline + drop shadow + a light rim on the top edge."""
    cov = cv.place(T.text_mask(s, h, max_w=max_w, **kw), cx, cy)
    o = dilate_disc(cov.astype(np.float32), ow)
    if shadow:
        cv.fill(shift(o, 0, max(1, int(round(ow * 0.8)))), INK)
    cv.fill(o, outline)
    cv.fill(cov, fill)
    if hl:
        rim = np.clip(cov - shift(cov, 0, 2), 0, 1) * cov
        cv.fill(rim, '#ffffff', alpha=0.45)
    return cov


def graffiti(cv, s, cx, cy, h, fill, fill2=None, outline=INK, ow=4.0, max_w=None, seed=0, drips=5,
             spray=True, rot=0.0, shear=0.18, offset=0.075):
    """Spray-paint tag: bubbly letters, thick outline, paint drips, overspray mist."""
    X, Y = cv.X, cv.Y
    cov = cv.place(T.text_mask(s, h, max_w=max_w, offset=offset, rot=rot, shear=shear), cx, cy)
    o = dilate_disc(cov.astype(np.float32), ow).astype(np.float64)
    r = T.rng(seed)
    dr = np.zeros_like(cov)
    cols = np.nonzero(cov.max(axis=0) > 0.6)[0]
    for _ in range(drips if len(cols) else 0):
        x = int(r.choice(cols))
        ys = np.nonzero(cov[:, x] > 0.6)[0]
        y = float(ys.max())
        w = r.uniform(1.4, 2.4)
        L = min(r.uniform(0.18, 0.45) * h, cv.h - 6.0 - ow - y - 1.35 * w)   # stay on the panel
        if L < 3.0:
            continue
        dr = np.maximum(dr, cover(sd_capsule(X, Y, x + 0.5, y - 2, x + 0.5, y + L, w * 0.8, w)))
        dr = np.maximum(dr, cover(sd_circle(X, Y, x + 0.5, y + L, w * 1.35)))
    od = np.maximum(o, dilate_disc(dr.astype(np.float32), ow * 0.75).astype(np.float64))
    if spray:
        mist = blur(od, 3.0) * (T.rng(seed + 1).random(od.shape) < 0.55)
        cv.fill(np.clip(mist * 0.5, 0, 1), outline)
    cv.fill(od, outline)
    body = np.maximum(cov, dr)
    if fill2 is not None:
        ys = np.nonzero(body.max(axis=1) > 0)[0]
        t = np.clip((Y - ys.min()) / max(1.0, ys.max() - ys.min()), 0, 1)[..., None]
        grad = col(fill) * (1 - t) + col(fill2) * t
        cv.fill(body, grad)
    else:
        cv.fill(body, fill)
    rim = np.clip(cov - shift(cov, 1, 2), 0, 1) * cov
    cv.fill(rim, '#ffffff', alpha=0.6)
    return body


def panel_bg(cv, kind, seed):
    if cv.a is not None:                 # transparent canvas: sprayed straight on the wall
        return
    X, Y = cv.X, cv.Y
    if kind == 'concrete':
        fill_bg(cv, '#d8d4cc')
        cv.noise(0.04, seed, f0=18)
    elif kind == 'plywood':
        fill_bg(cv, '#e6c58f')
        g = anoise((cv.h, cv.w), 1.2, 6.0, seed)
        cv.rgb *= (0.94 + 0.08 * np.sin(2 * math.pi * (Y / 7.0 + 2.5 * g)))[..., None]
    elif kind == 'blue':
        fill_bg(cv, '#bfe3ff')
        cv.noise(0.03, seed, f0=10)
    elif kind == 'pink':
        fill_bg(cv, '#ffd6e4')
        cv.noise(0.03, seed, f0=10)
    elif kind == 'mint':
        fill_bg(cv, '#c9f2e2')
        cv.noise(0.03, seed, f0=10)
    elif kind == 'brick':
        fill_bg(cv, '#e8a48a')
        bh, bw = 12.0, 30.0
        row = np.floor(Y / bh)
        xb = X + (row % 2) * bw / 2
        lx, ly = xb % bw, Y % bh
        dj = np.minimum(np.minimum(lx, bw - lx), np.minimum(ly, bh - ly))
        cv.fill(cover(dj - 1.0), '#f3e3d6')
        cv.noise(0.03, seed, f0=16)
    # painted panel border (thin, darker) so the quad edge reads as a board edge
    frame(cv, col(cv.rgb.mean(axis=(0, 1))) * 0.72, w=2.0)


def paper_bg(cv, color='#f6ecd2', seed=0, tape=True):
    X, Y = cv.X, cv.Y
    fill_bg(cv, color)
    cv.noise(0.03, seed, f0=20)
    d = np.minimum(np.minimum(X, cv.w - X), np.minimum(Y, cv.h - Y))
    cv.rgb *= (1.0 - 0.10 * np.exp(-d / 3.0))[..., None]
    frame(cv, col(color) * 0.6, w=1.2)
    if tape:
        for (tx, ty, ang) in ((10, 6, -30), (cv.w - 10, 6, 30)):
            cv.shape(sd_rbox(X, Y, tx, ty, 10, 4, 0.5, ang), '#fffbe6', alpha=0.75)


# ---- windows -------------------------------------------------------------
def glass(cv, top='#bfe8ff', bot='#7fc4f0', interior=None):
    t = (cv.Y / cv.h)[..., None]
    cv.rgb = col(top) * (1 - t) + col(bot) * t
    if interior is not None:
        cv.fill(np.ones((cv.h, cv.w)), interior, alpha=0.65)


def reflections(cv, alpha=0.32):
    X, Y = cv.X, cv.Y
    for off, w in ((-0.15, 0.09), (0.12, 0.035), (0.45, 0.06)):
        d = np.abs((X - cv.w * (0.5 + off)) + (Y - cv.h / 2) * 0.9) - cv.w * w
        cv.fill(cover(d), '#ffffff', alpha=alpha)


def inner_shadow(cv, a=0.25, w=6.0):
    X, Y = cv.X, cv.Y
    cv.rgb *= (1 - a * np.exp(-Y / w) - 0.5 * a * np.exp(-X / w) - 0.5 * a * np.exp(-(cv.w - X) / w))[..., None]


def win_curtains(w, h):
    cv = Canvas(w, h)
    glass(cv, '#3f5a8a', '#2c3f66')
    X, Y = cv.X, cv.Y
    # far wall lamp glow
    cv.fill(cover(sd_circle(X, Y, w * 0.5, h * 0.42, w * 0.22), 12.0), '#ffe9a8', alpha=0.45)
    reflections(cv, 0.18)
    for sx in (-1, 1):
        x_edge = w / 2 + sx * w * 0.5
        # curtain = region between the window side and a curve pinched at the tieback
        tie_y = h * 0.6
        wid = np.where(Y < tie_y, w * 0.36 - (Y / tie_y) * w * 0.16, w * 0.2 + (Y - tie_y) / (h - tie_y) * w * 0.12)
        d = np.abs(X - x_edge) - wid
        cv.shape(d, '#ff8fb3', outline=INK, ow=1.8)
        folds = 0.5 + 0.5 * np.sin((X - x_edge) / (w * 0.045) * math.pi)
        cv.fill(cover(d) * folds, '#e86a95', alpha=0.45)
        cv.shape(sd_rbox(X, Y, x_edge - sx * w * 0.2, tie_y, 5, 3.0, 1.5), '#ffd23f', outline=INK, ow=1.2)
    # valance
    val = sd_rbox(X, Y, w / 2, 7, w / 2 + 2, 9, 0)
    scal = sd_union(*[sd_circle(X, Y, w * (i + 0.5) / 6, 15, w / 12) for i in range(6)])
    cv.shape(np.minimum(val, scal), '#ffb3cc', outline=INK, ow=1.6)
    inner_shadow(cv, 0.2)
    return cv.rgb


def win_blinds(w, h):
    cv = Canvas(w, h)
    glass(cv, '#405b88', '#2f4166')
    X, Y = cv.X, cv.Y
    reflections(cv, 0.18)
    bottom = h * 0.62
    slat = 7.0
    for i in range(int(bottom // slat) + 1):
        y = i * slat + slat * 0.5
        d = sd_rbox(X, Y, w / 2, y, w / 2 + 2, slat * 0.36, 1.0, -2.0)
        cv.shape(d, '#fff3dc', outline='#b7a58a', ow=0.8)
    cv.shape(sd_rbox(X, Y, w / 2, bottom + 2, w / 2 + 2, 3.5, 1.5), '#f0dcb8', outline=INK, ow=1.2)
    cv.shape(sd_segment(X, Y, w * 0.8, 0, w * 0.8, bottom + 18) - 0.8, '#8a7a66')
    cv.shape(sd_circle(X, Y, w * 0.8, bottom + 20, 2.6), '#e8c56a', outline=INK, ow=0.8)
    # cactus silhouette on the sill below the blinds
    cv.shape(sd_rbox(X, Y, w * 0.3, h - 10, 9, 8, 2), '#c9734f', outline=INK, ow=1.5)
    cv.shape(sd_union(sd_capsule(X, Y, w * 0.3, h - 18, w * 0.3, h - 34, 4.5),
                      sd_capsule(X, Y, w * 0.3 + 7, h - 26, w * 0.3 + 7, h - 32, 2.5)), '#6cc66f', outline=INK, ow=1.4)
    inner_shadow(cv, 0.2)
    return cv.rgb


def win_plant(w, h):
    cv = Canvas(w, h)
    glass(cv, '#a9ddf7', '#6fb3e0')
    X, Y = cv.X, cv.Y
    reflections(cv)
    cx = w * 0.5
    leaves = []
    r = T.rng(7)
    for k in range(9):
        a = math.radians(-160 + 140 * k / 8 + r.normal(0, 6))
        L = r.uniform(26, 38)
        lx, ly = cx + L * math.cos(a), h - 30 + L * math.sin(a)
        leaves.append(sd_ellipse(X, Y, (cx + lx) / 2, (h - 30 + ly) / 2, L * 0.55, 6.5, ang=math.degrees(a)))
    d = sd_union(*leaves)
    cv.shape(d, '#5fc46a', outline=INK, ow=1.6)
    for k, ld in enumerate(leaves):
        cv.fill(cover(ld + 3.5) * 0.35, '#8ee08a')
    pot = sd_poly(X, Y, [(cx - 18, h - 30), (cx + 18, h - 30), (cx + 13, h - 4), (cx - 13, h - 4)])
    cv.shape(pot, '#e07b55', outline=INK, ow=1.8)
    cv.shape(sd_rbox(X, Y, cx, h - 30, 21, 4, 1.5), '#f0956d', outline=INK, ow=1.5)
    inner_shadow(cv, 0.18)
    return cv.rgb


def win_cat(w, h):
    cv = Canvas(w, h)
    glass(cv, '#a9ddf7', '#6fb3e0')
    X, Y = cv.X, cv.Y
    reflections(cv)
    cx, base = w * 0.48, h - 6
    ginger, dark = '#ffaa55', '#e07b2f'
    tail = sd_capsule(X, Y, cx + 22, base - 6, cx + 34, base - 30, 4.0, 3.2)
    tail = np.minimum(tail, sd_capsule(X, Y, cx + 34, base - 30, cx + 28, base - 44, 3.2, 3.6))
    body = sd_ellipse(X, Y, cx, base - 18, 22, 22)
    head = sd_circle(X, Y, cx, base - 50, 17)
    ears = sd_union(sd_poly(X, Y, [(cx - 16, base - 56), (cx - 13, base - 76), (cx - 2, base - 64)]),
                    sd_poly(X, Y, [(cx + 16, base - 56), (cx + 13, base - 76), (cx + 2, base - 64)]))
    sil = sd_union(body, head, ears, tail)
    cv.shape(sil, ginger, outline=INK, ow=2.0)
    for k in range(3):  # stripes
        cv.fill(cover(sd_capsule(X, Y, cx - 14 + 0, base - 40 + k * 9, cx - 4, base - 38 + k * 9, 2.0)) * cover(body), dark)
        cv.fill(cover(sd_capsule(X, Y, cx + 14, base - 40 + k * 9, cx + 4, base - 38 + k * 9, 2.0)) * cover(body), dark)
    cv.fill(cover(sd_capsule(X, Y, cx - 6, base - 64, cx - 2, base - 58, 1.6)) * cover(head), dark)
    cv.fill(cover(sd_capsule(X, Y, cx + 6, base - 64, cx + 2, base - 58, 1.6)) * cover(head), dark)
    cv.shape(sd_ellipse(X, Y, cx, base - 14, 12, 14), '#fff1dc')
    for sx in (-1, 1):
        cv.shape(sd_ellipse(X, Y, cx + sx * 6.5, base - 52, 3.4, 4.2), INK)
        cv.shape(sd_circle(X, Y, cx + sx * 6.5 - 1, base - 53.5, 1.2), '#ffffff')
        cv.shape(sd_ellipse(X, Y, cx + sx * 11, base - 45, 3.5, 2.0), '#ff9aae', alpha=0.8)
        for k in (-1, 1):
            cv.shape(sd_segment(X, Y, cx + sx * 8, base - 44 + k, cx + sx * 21, base - 46 + k * 3) - 0.4, INK)
    cv.shape(sd_poly(X, Y, [(cx - 2.5, base - 47), (cx + 2.5, base - 47), (cx, base - 44.5)]), '#e05a7a')
    for sx in (-1, 1):
        cv.shape(sd_arc(X, Y, cx + sx * 2.2, base - 43.5, 2.2, 10, 170, 0.6), INK)
    inner_shadow(cv, 0.18)
    return cv.rgb


def win_raccoon(w, h):
    cv = Canvas(w, h)
    glass(cv, '#3f5a8a', '#2c3f66')
    X, Y = cv.X, cv.Y
    reflections(cv, 0.2)
    raccoon_head(cv, w * 0.5, h - 18, 38, look=(0.4, -0.6), mood='o', ow=2.2)
    for sx in (-1, 1):  # paws on the sill
        cv.shape(sd_ellipse(X, Y, w * 0.5 + sx * 26, h - 5, 11, 7), RAC_D, outline=INK, ow=1.8)
        for k in (-1, 0, 1):
            cv.shape(sd_segment(X, Y, w * 0.5 + sx * 26 + k * 4, h - 8, w * 0.5 + sx * 26 + k * 4, h - 3) - 0.5, INK)
    inner_shadow(cv, 0.15)
    return cv.rgb


def win_lamp(w, h):
    cv = Canvas(w, h)
    t = (cv.Y / h)[..., None]
    cv.rgb = col('#ffe7a1') * (1 - t) + col('#ffc76b') * t
    X, Y = cv.X, cv.Y
    cv.fill(cover(sd_circle(X, Y, w * 0.62, h * 0.45, w * 0.32), 18.0), '#fff8d8', alpha=0.8)
    shade = sd_poly(X, Y, [(w * 0.62 - 14, h * 0.5), (w * 0.62 + 14, h * 0.5), (w * 0.62 + 22, h * 0.68),
                           (w * 0.62 - 22, h * 0.68)])
    cv.shape(shade, '#ff8fb3', outline=INK, ow=1.8)
    cv.shape(sd_rbox(X, Y, w * 0.62, h * 0.82, 2.5, h * 0.14, 1), '#8a5a3c', outline=INK, ow=1.2)
    cv.shape(sd_rbox(X, Y, w * 0.62, h - 6, 13, 4, 2), '#8a5a3c', outline=INK, ow=1.5)
    # picture frame on the far wall
    cv.shape(sd_rbox(X, Y, w * 0.24, h * 0.36, 14, 18, 1.5), '#ffffff', outline=INK, ow=2.0)
    cv.shape(sd_circle(X, Y, w * 0.24, h * 0.33, 7), '#ff8a80')
    cv.shape(sd_poly(X, Y, [(w * 0.24 - 12, h * 0.36 + 14), (w * 0.24 - 2, h * 0.36), (w * 0.24 + 12, h * 0.36 + 14)]),
             '#6cc66f')
    reflections(cv, 0.2)
    inner_shadow(cv, 0.15)
    return cv.rgb


def win_fishbowl(w, h):
    cv = Canvas(w, h)
    glass(cv, '#a9ddf7', '#6fb3e0')
    X, Y = cv.X, cv.Y
    reflections(cv)
    cx, cy, R = w * 0.5, h - 34, 28
    bowl = sd_circle(X, Y, cx, cy, R)
    cv.shape(bowl, '#d8f3ff', outline=INK, ow=1.8)
    water = np.maximum(bowl + 2.5, -(Y - (cy - R * 0.45)))
    cv.shape(water, '#5cc8ff')
    fx, fy = cx + 4, cy + 2
    cv.shape(sd_union(sd_ellipse(X, Y, fx, fy, 10, 7),
                      sd_poly(X, Y, [(fx + 8, fy), (fx + 17, fy - 7), (fx + 17, fy + 7)])), '#ff8a2a', outline=INK, ow=1.4)
    cv.shape(sd_circle(X, Y, fx - 5, fy - 1.5, 1.8), INK)
    for k, (bx, by, br) in enumerate(((cx - 9, cy - 8, 2.4), (cx - 13, cy - 16, 1.8), (cx - 8, cy - 22, 1.4))):
        cv.shape(sd_circle(X, Y, bx, by, br), '#ffffff', alpha=0.85)
    cv.shape(sd_rbox(X, Y, cx, cy - R + 1, 14, 3, 1.5), '#bfe8ff', outline=INK, ow=1.4)
    cv.fill(cover(sd_arc(X, Y, cx, cy, R - 6, 200, 250, 2.0)), '#ffffff', alpha=0.8)
    cv.shape(sd_rbox(X, Y, cx, h - 3, 40, 3, 1), '#c9734f')
    inner_shadow(cv, 0.18)
    return cv.rgb


def win_for_rent(w, h):
    cv = Canvas(w, h)
    glass(cv, '#a9ddf7', '#6fb3e0')
    X, Y = cv.X, cv.Y
    reflections(cv)
    cx, cy = w * 0.5, h * 0.52
    cv.shape(sd_rbox(X, Y, cx + 1.5, cy + 2, 38, 26, 2, -4), INK, alpha=0.25)
    cv.shape(sd_rbox(X, Y, cx, cy, 38, 26, 2, -4), '#ffffff', outline='#ff4d5e', ow=2.5)
    sub = Canvas(76, 52)
    sub.rgb[:] = 1.0
    sub.text("FOR\nRENT", 38, 26, 38, '#ff4d5e', max_w=62, offset=0.05, line_gap=0.9)
    rot = resize(sub.rgb, 52, 76)
    # paste rotated-ish: small tilt by shearing rows
    for yy in range(52):
        dx = int(round((yy - 26) * math.tan(math.radians(-4))))
        y_ = int(cy - 26 + yy)
        x0 = int(cx - 38 + dx)
        cv.rgb[y_, x0 + 3:x0 + 73] = rot[yy, 3:73]
    for (tx, ty) in ((cx - 34, cy - 24), (cx + 34, cy - 28)):
        cv.shape(sd_rbox(X, Y, tx, ty, 7, 3, 0.5, 35), '#fffbe6', alpha=0.8)
    inner_shadow(cv, 0.18)
    return cv.rgb


# ---- doors (drawn at w x 2h, squashed to w x h) -----------------------------
def door_base(w, h, color, seed, panels=True, window=None):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, color)
    cv.noise(0.02, seed, f0=14)
    frame(cv, INK, w=3.0)
    if panels:
        for (px, py, pw, ph) in ((0.3, 0.62, 0.17, 0.12), (0.7, 0.62, 0.17, 0.12),
                                 (0.3, 0.86, 0.17, 0.08), (0.7, 0.86, 0.17, 0.08)):
            d = sd_rbox(X, Y, w * px, h * py, w * pw, h * ph, 3)
            cv.shape(d, col(color) * 0.82)
            cv.shape(d + 3, col(color) * 1.0)
            cv.fill(cover(d + 3) * (1 - cover(shift(d, 0, 2) + 3)), '#ffffff', alpha=0.25)
    return cv


def knob(cv, x, y, r=5.5):
    cv.shape(sd_circle(cv.X, cv.Y, x, y, r), '#ffd23f', outline=INK, ow=1.6)
    cv.shape(sd_circle(cv.X, cv.Y, x - 1.5, y - 1.5, r * 0.35), '#fff6c8')


def door_wood(w, h):
    H2 = h * 2
    cv = door_base(w, H2, '#c98a57', 3)
    X, Y = cv.X, cv.Y
    g = anoise((H2, w), 6.0, 1.0, 5)
    cv.rgb *= (0.95 + 0.07 * np.sin(2 * math.pi * (X / 9.0 + 2.0 * g)))[..., None]
    arch = sd_union(sd_rbox(X, Y, w / 2, H2 * 0.27, w * 0.3, H2 * 0.08, 2), sd_circle(X, Y, w / 2, H2 * 0.2, w * 0.3))
    cv.shape(arch, '#bfe8ff', outline=INK, ow=2.5)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.22, 1.6, H2 * 0.12, 0), INK)
    cv.fill(cover(sd_arc(X, Y, w / 2, H2 * 0.22, w * 0.2, 200, 250, 2.5)), '#ffffff', alpha=0.7)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.4, 14, 9, 2), '#ffd23f', outline=INK, ow=1.5)
    cv.text("12", w / 2, H2 * 0.4, 11, INK, offset=0.06)
    knob(cv, w * 0.8, H2 * 0.55)
    return resize(cv.rgb, h, w)


def door_blue(w, h):
    H2 = h * 2
    cv = door_base(w, H2, '#4ea8de', 4)
    X, Y = cv.X, cv.Y
    cv.shape(sd_circle(X, Y, w / 2, H2 * 0.24, w * 0.24), '#bfe8ff', outline='#fff6e8', ow=4.0)
    cv.shape(sd_circle(X, Y, w / 2, H2 * 0.24, w * 0.24 + 4), INK, alpha=0.0)
    d = sd_circle(X, Y, w / 2, H2 * 0.24, w * 0.24 + 6)
    cv.fill(cover(np.abs(d) - 1.2), INK)
    cv.fill(cover(sd_arc(X, Y, w / 2, H2 * 0.24, w * 0.16, 200, 250, 2.2)), '#ffffff', alpha=0.7)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.45, 18, 4, 1.5), '#ffd23f', outline=INK, ow=1.5)
    knob(cv, w * 0.8, H2 * 0.55)
    return resize(cv.rgb, h, w)


def door_shop(w, h):
    H2 = h * 2
    cv = Canvas(w, H2)
    X, Y = cv.X, cv.Y
    glass(cv, '#a9ddf7', '#6fb3e0')
    cv.fill(np.ones((H2, w)), '#2f4a7a', alpha=0.35)
    reflections(cv, 0.28)
    frame(cv, '#dfe7f0', w=9.0)
    frame(cv, INK, w=2.5)
    cv.fill(cover(np.abs(sd_rbox(X, Y, w / 2, H2 / 2, w / 2 - 9, H2 / 2 - 9, 0)) - 1.0), INK)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.56, w * 0.36, 4, 2), '#dfe7f0', outline=INK, ow=1.5)
    # hanging OPEN sign
    cv.shape(sd_segment(X, Y, w / 2 - 14, H2 * 0.2, w / 2, H2 * 0.13) - 0.7, INK)
    cv.shape(sd_segment(X, Y, w / 2 + 14, H2 * 0.2, w / 2, H2 * 0.13) - 0.7, INK)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.28, 30, 14, 3), '#ff4d5e', outline=INK, ow=2.0)
    cv.text("OPEN", w / 2, H2 * 0.28, 15, '#ffffff', max_w=50, offset=0.05)
    cv.text("HOURS: WHENEVER", w / 2, H2 * 0.72, 7, '#ffffff', max_w=w - 26, offset=0.03)
    return resize(cv.rgb, h, w)


def door_red(w, h):
    H2 = h * 2
    cv = door_base(w, H2, '#ff6b6b', 6)
    X, Y = cv.X, cv.Y
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.22, w * 0.26, H2 * 0.09, 4), '#bfe8ff', outline=INK, ow=2.5)
    cv.fill(cover(sd_segment(X, Y, w * 0.32, H2 * 0.28, w * 0.48, H2 * 0.16) - 2.0), '#ffffff', alpha=0.5)
    cv.shape(sd_rbox(X, Y, w / 2, H2 * 0.42, 16, 3.5, 1.5), '#dfe7f0', outline=INK, ow=1.5)
    knob(cv, w * 0.8, H2 * 0.55)
    # claw scratches near the bottom (raccoon was here)
    for k in range(3):
        x0 = w * 0.3 + k * 6
        cv.shape(sd_capsule(X, Y, x0, H2 * 0.7, x0 + 9, H2 * 0.82, 1.2, 0.5), '#ffd1d1', outline='#b83a4a', ow=0.8)
    return resize(cv.rgb, h, w)


# ---- signs (240 x 112) ---------------------------------------------------
def sign_board(w, h, bg, seed, border=INK, inner='#ffffff'):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, bg)
    cv.noise(0.02, seed, f0=12)
    frame(cv, border, w=5.0)
    d = sd_rbox(X, Y, w / 2, h / 2, w / 2 - 10, h / 2 - 10, 7)
    cv.fill(cover(np.abs(d) - 1.2), inner, alpha=0.8)
    # bolts
    for (bx, by) in ((12, 12), (w - 12, 12), (12, h - 12), (w - 12, h - 12)):
        cv.shape(sd_circle(X, Y, bx, by, 2.6), '#dfe7f0', outline=INK, ow=1.0)
    return cv


def icon_pizza(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    tri = sd_poly(X, Y, [(cx - s, cy - 0.7 * s), (cx + s, cy - 0.7 * s), (cx, cy + s)])
    cv.shape(tri, '#ffd84a', outline=INK, ow=2.2)
    cv.shape(sd_rbox(X, Y, cx, cy - 0.72 * s, s * 1.05, 0.17 * s, 0.15 * s), '#e8a25b', outline=INK, ow=2.0)
    for (px, py) in ((-0.35, -0.3), (0.3, -0.2), (0.0, 0.25), (0.05, -0.45)):
        cv.shape(sd_circle(X, Y, cx + px * s, cy + py * s, 0.15 * s), '#e8283c', outline=INK, ow=1.0)


def icon_donut(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    ring = np.maximum(sd_circle(X, Y, cx, cy, s), -sd_circle(X, Y, cx, cy, 0.38 * s))
    cv.shape(ring, '#f0b46a', outline=INK, ow=2.2)
    fr = np.maximum(sd_circle(X, Y, cx, cy, 0.84 * s) + 0.06 * s * np.sin(7 * np.arctan2(Y - cy, X - cx)),
                    -sd_circle(X, Y, cx, cy, 0.48 * s))
    cv.shape(fr, '#ff8cc6')
    r = T.rng(3)
    for k in range(10):
        a = r.uniform(0, 2 * math.pi)
        rr = r.uniform(0.55, 0.75) * s
        x, y = cx + rr * math.cos(a), cy + rr * math.sin(a)
        b = r.uniform(0, math.pi)
        cv.shape(sd_capsule(X, Y, x - 0.08 * s * math.cos(b), y - 0.08 * s * math.sin(b),
                            x + 0.08 * s * math.cos(b), y + 0.08 * s * math.sin(b), 0.035 * s),
                 ['#ffffff', '#ffd23f', '#4cc9f0', '#7ae582'][k % 4])


def icon_fries(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    for k in range(5):
        x = cx + (k - 2) * 0.25 * s
        cv.shape(sd_rbox(X, Y, x, cy - 0.35 * s - (k % 2) * 0.12 * s, 0.09 * s, 0.45 * s, 0.03 * s, (k - 2) * 6),
                 '#ffd84a', outline=INK, ow=1.5)
    box = sd_poly(X, Y, [(cx - 0.7 * s, cy - 0.1 * s), (cx + 0.7 * s, cy - 0.1 * s), (cx + 0.5 * s, cy + s),
                         (cx - 0.5 * s, cy + s)])
    cv.shape(box, '#ff4d5e', outline=INK, ow=2.0)
    cv.shape(sd_circle(cv.X, cv.Y, cx, cy + 0.42 * s, 0.2 * s), '#ffffff')


def icon_washer(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    cv.shape(sd_rbox(X, Y, cx, cy, 0.85 * s, s, 0.15 * s), '#ffffff', outline=INK, ow=2.2)
    cv.shape(sd_rbox(X, Y, cx, cy - 0.78 * s, 0.85 * s, 0.22 * s, 0.1 * s), '#dfe7f0', outline=INK, ow=1.5)
    cv.shape(sd_circle(X, Y, cx, cy + 0.15 * s, 0.55 * s), '#9fdcff', outline=INK, ow=2.0)
    cv.fill(cover(np.maximum(sd_circle(X, Y, cx, cy + 0.15 * s, 0.53 * s), -(Y - (cy + 0.2 * s)))), '#5cc8ff')
    for (bx, by, br) in ((0.75, -0.95, 0.16), (1.0, -1.25, 0.11), (0.55, -1.25, 0.09)):
        cv.shape(sd_circle(X, Y, cx + bx * s, cy + by * s, br * s), '#ffffff', outline=INK, ow=1.0)


def icon_burger(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    top = np.maximum(sd_ellipse(X, Y, cx, cy - 0.2 * s, s, 0.62 * s), Y - (cy - 0.15 * s))
    cv.shape(sd_rbox(X, Y, cx, cy + 0.55 * s, 0.95 * s, 0.2 * s, 0.15 * s), '#f0b46a', outline=INK, ow=2.0)
    cv.shape(sd_rbox(X, Y, cx, cy + 0.25 * s, 1.0 * s, 0.17 * s, 0.12 * s), '#8a5a3c', outline=INK, ow=2.0)
    cv.shape(sd_rbox(X, Y, cx, cy + 0.05 * s, 1.05 * s, 0.08 * s, 0.05 * s), '#ffd23f', outline=INK, ow=1.5)
    wav = sd_rbox(X, Y, cx, cy - 0.08 * s, 1.08 * s, 0.07 * s, 0.05 * s) + 0.05 * s * np.sin(X / (0.12 * s))
    cv.shape(wav, '#6cc66f', outline=INK, ow=1.5)
    cv.shape(top, '#f0b46a', outline=INK, ow=2.0)
    for (px, py) in ((-0.4, -0.45), (0.0, -0.6), (0.4, -0.42), (-0.15, -0.3), (0.25, -0.28)):
        cv.shape(sd_ellipse(X, Y, cx + px * s, cy + py * s, 0.06 * s, 0.035 * s), '#fff6dc')


def icon_trashcan(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    body = sd_poly(X, Y, [(cx - 0.62 * s, cy - 0.45 * s), (cx + 0.62 * s, cy - 0.45 * s), (cx + 0.5 * s, cy + s),
                          (cx - 0.5 * s, cy + s)])
    cv.shape(body, '#79cba6', outline=INK, ow=2.0)
    for k in (-1, 0, 1):
        cv.shape(sd_capsule(X, Y, cx + k * 0.25 * s, cy - 0.2 * s, cx + k * 0.22 * s, cy + 0.8 * s, 0.04 * s), '#4d9e80')
    cv.shape(sd_rbox(X, Y, cx, cy - 0.55 * s, 0.75 * s, 0.13 * s, 0.06 * s, -12), '#4d9e80', outline=INK, ow=2.0)
    cv.shape(sd_star(X, Y, cx + 0.62 * s, cy - 0.95 * s, 0.32 * s, 0.14 * s), '#ffd23f', outline=INK, ow=1.5)
    cv.shape(sd_star(X, Y, cx - 0.7 * s, cy - 0.85 * s, 0.18 * s, 0.08 * s), '#ffffff', outline=INK, ow=1.0)


def no_sign(cv, cx, cy, s, ow=4.0):
    X, Y = cv.X, cv.Y
    ring = np.abs(sd_circle(X, Y, cx, cy, s * 0.9)) - s * 0.12
    a = math.radians(45)
    bar = sd_capsule(X, Y, cx - s * 0.75 * math.cos(a), cy - s * 0.75 * math.sin(a),
                     cx + s * 0.75 * math.cos(a), cy + s * 0.75 * math.sin(a), s * 0.1)
    d = np.minimum(ring, bar)
    cv.shape(d, '#ff4d5e', outline=INK, ow=ow * 0.6)


def icon_spray(cv, cx, cy, s):
    X, Y = cv.X, cv.Y
    cv.shape(sd_rbox(X, Y, cx, cy + 0.25 * s, 0.38 * s, 0.75 * s, 0.12 * s), '#ffd23f', outline=INK, ow=2.0)
    cv.shape(sd_rbox(X, Y, cx, cy - 0.6 * s, 0.22 * s, 0.14 * s, 0.05 * s), '#dfe7f0', outline=INK, ow=1.5)
    cv.shape(sd_rbox(X, Y, cx, cy + 0.25 * s, 0.38 * s, 0.22 * s, 0), '#ff4d5e')
    for k in range(5):
        cv.shape(sd_circle(X, Y, cx - 0.45 * s - k * 0.12 * s, cy - 0.65 * s + (k - 2) * 0.12 * s, 0.05 * s), INK)


def make_sign(w, h, bg, text, text_color, icon, seed, two_lines=False, text_h=None, outline=INK):
    cv = sign_board(w, h, bg, seed)
    ic_x = 52
    if icon is not None:
        icon(cv, ic_x, h / 2 + 2, 30)
    tx0 = 92 if icon is not None else 18
    tw = w - tx0 - 16
    th = text_h or (64 if two_lines else 46)
    shine_text(cv, text, tx0 + tw / 2, h / 2 + 1, th, text_color, outline=outline, ow=3.0, max_w=tw,
               offset=0.055, line_gap=0.92)
    return cv.rgb


def sign_pizza(w, h):
    return make_sign(w, h, '#ffd23f', "PIZZA", '#ff4d5e', icon_pizza, 1, text_h=50)


def sign_donuts(w, h):
    return make_sign(w, h, '#ff9ecf', "DONUTS", '#ffffff', icon_donut, 2)


def sign_snack_shack(w, h):
    return make_sign(w, h, '#7fe3c8', "SNACK\nSHACK", '#fff3b0', icon_fries, 3, two_lines=True)


def sign_laundromat(w, h):
    return make_sign(w, h, '#6ec3ff', "LAUNDRO\nMAT", '#ffffff', icon_washer, 4, two_lines=True)


def sign_burger(w, h):
    return make_sign(w, h, '#ffa94d', "BURGER", '#fff3b0', icon_burger, 5)


def sign_trash_treasures(w, h):
    return make_sign(w, h, '#b795ff', "TRASH &\nTREASURES", '#ffe066', icon_trashcan, 6, two_lines=True)


def sign_no_raccoons(w, h):
    cv = sign_board(w, h, '#fff6e8', 7, border=INK, inner='#ff4d5e')
    raccoon_head(cv, 52, h / 2 + 4, 26, look=(0.5, 0), mood='o', ow=2.0)
    no_sign(cv, 52, h / 2 + 2, 40)
    shine_text(cv, "NO\nRACCOONS!", 92 + (w - 108) / 2, h / 2 + 1, 66, '#ff4d5e', ow=3.0, max_w=w - 108,
               offset=0.055, line_gap=0.92)
    return cv.rgb


def sign_pest_control(w, h):
    return make_sign(w, h, '#8fd16a', "PEST\nCONTROL", '#ffffff', icon_spray, 8, two_lines=True)


# ---- posters (drawn at w x 4/3 h, squashed) --------------------------------
def poster_wanted(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#f3e2bd', 11)
    X, Y = cv.X, cv.Y
    cv.text("WANTED", w / 2, 17, 21, '#7c2f3b', max_w=w - 14, offset=0.06)
    # mugshot box with height lines
    bx, by, bw, bh = w / 2, H2 * 0.5, w * 0.36, H2 * 0.26
    cv.shape(sd_rbox(X, Y, bx, by, bw, bh, 2), '#d6cde8', outline=INK, ow=2.0)
    for k in range(1, 6):
        yy = by - bh + k * 2 * bh / 6
        cv.fill(cover(np.abs(Y - yy) - 0.5) * cover(sd_rbox(X, Y, bx, by, bw - 2, bh - 2, 1)), '#a99fbf')
    raccoon_head(cv, bx, by + 4, 27, look=(-0.3, 0.2), mood='grin', ow=2.0)
    cv.text("$5 REWARD", w / 2, H2 - 18, 16, '#2b2340', max_w=w - 16, offset=0.06)
    cv.shape(sd_rbox(X, Y, w / 2, H2 - 35, w * 0.38, 1.0, 0), '#7c2f3b')
    return resize(cv.rgb, h, w)


def poster_lost_sandwich(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#ffffff', 12)
    X, Y = cv.X, cv.Y
    cv.text("LOST:", w / 2, 15, 16, '#ff4d5e', offset=0.06)
    cv.text("SANDWICH", w / 2, 36, 15, INK, max_w=w - 14, offset=0.06)
    sx, sy = w / 2, H2 * 0.54
    tri = lambda dy, c: cv.shape(sd_poly(X, Y, [(sx - 34, sy + 22 + dy), (sx + 34, sy + 22 + dy), (sx, sy - 24 + dy)]), c,
                                 outline=INK, ow=1.8)
    tri(6, '#f0c27b')
    cv.shape(sd_rbox(X, Y, sx, sy + 15, 36, 4, 2) + 1.5 * np.sin(X / 2.2), '#6cc66f', outline=INK, ow=1.5)
    cv.shape(sd_rbox(X, Y, sx - 4, sy + 9, 30, 3.5, 1, -2), '#ffd23f', outline=INK, ow=1.2)
    cv.shape(sd_rbox(X, Y, sx + 2, sy + 4, 28, 3, 1.5, 1), '#ff6b6b', outline=INK, ow=1.2)
    tri(-2, '#f6d49a')
    cv.text("REWARD: CRUMBS", w / 2, H2 - 30, 8, INK, max_w=w - 16, offset=0.05)
    for k in range(7):  # tear-off strips
        x = 8 + (k + 0.5) * (w - 16) / 7
        cv.fill(cover(np.abs(X - (8 + k * (w - 16) / 7)) - 0.4) * (Y > H2 - 18), '#b8b0a0')
    cv.fill(cover(np.abs(Y - (H2 - 18)) - 0.5), '#b8b0a0')
    return resize(cv.rgb, h, w)


def poster_beware(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#ffe066', 13)
    X, Y = cv.X, cv.Y
    cv.text("BEWARE", w / 2, 16, 19, INK, max_w=w - 14, offset=0.06)
    tri = sd_poly(X, Y, [(w / 2 - 38, H2 * 0.62), (w / 2 + 38, H2 * 0.62), (w / 2, H2 * 0.3)])
    cv.shape(tri, '#ffffff', outline=INK, ow=3.0)
    raccoon_head(cv, w / 2, H2 * 0.52, 15, mood='grin', ow=1.4)
    cv.text("OF\nRACCOONS", w / 2, H2 - 24, 27, '#ff4d5e', outline=INK, ow=1.5, max_w=w - 14, offset=0.06,
            line_gap=0.95)
    return resize(cv.rgb, h, w)


def poster_donut_day(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#ffd1dc', 14)
    X, Y = cv.X, cv.Y
    for k in range(12):  # sunburst
        a0 = k * 30
        d = sd_poly(X, Y, [(w / 2, H2 * 0.5), (w / 2 + 120 * math.cos(math.radians(a0)), H2 * 0.5 + 120 * math.sin(math.radians(a0))),
                           (w / 2 + 120 * math.cos(math.radians(a0 + 15)), H2 * 0.5 + 120 * math.sin(math.radians(a0 + 15)))])
        cv.fill(cover(d), '#ffb3c7', alpha=0.8)
    icon_donut(cv, w / 2, H2 * 0.5, 30)
    cv.text("DONUT", w / 2, 18, 20, '#ffffff', outline=INK, ow=2.0, max_w=w - 14, offset=0.06)
    cv.text("DAY!", w / 2, H2 - 18, 20, '#ff6f91', outline=INK, ow=2.0, offset=0.06)
    return resize(cv.rgb, h, w)


def poster_yard_sale(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#c9f2e2', 15)
    X, Y = cv.X, cv.Y
    cv.text("YARD\nSALE", w / 2, 34, 50, INK, max_w=w - 14, offset=0.06, line_gap=0.9)
    cv.text("SAT 9AM", w / 2, H2 * 0.62, 13, '#ff4d5e', max_w=w - 20, offset=0.05)
    arrow = sd_union(sd_rbox(X, Y, w / 2 - 6, H2 * 0.8, 24, 6, 0),
                     sd_poly(X, Y, [(w / 2 + 14, H2 * 0.8 - 15), (w / 2 + 38, H2 * 0.8), (w / 2 + 14, H2 * 0.8 + 15)]))
    cv.shape(arrow, '#ff8a2a', outline=INK, ow=2.0)
    return resize(cv.rgb, h, w)


def poster_vote_bandit(w, h):
    H2 = int(round(h * 4 / 3))
    cv = Canvas(w, H2)
    paper_bg(cv, '#cfe6fa', 16)
    X, Y = cv.X, cv.Y
    cv.shape(sd_rbox(X, Y, w / 2, 17, w / 2 - 6, 12, 2), '#2a4fb8')
    cv.text("VOTE", w / 2, 17, 15, '#ffffff', offset=0.06)
    raccoon_head(cv, w / 2, H2 * 0.48, 30, mood='smile', ow=2.0)
    tie = sd_poly(X, Y, [(w / 2 - 5, H2 * 0.48 + 26), (w / 2 + 5, H2 * 0.48 + 26), (w / 2 + 8, H2 * 0.48 + 42),
                         (w / 2, H2 * 0.48 + 48), (w / 2 - 8, H2 * 0.48 + 42)])
    cv.shape(tie, '#ff4d5e', outline=INK, ow=1.5)
    for sx in (-1, 1):
        cv.shape(sd_star(X, Y, w / 2 + sx * 40, H2 * 0.3, 8, 3.5), '#ffd23f', outline=INK, ow=1.2)
    cv.text("BANDIT", w / 2, H2 - 18, 18, '#ff4d5e', outline=INK, ow=1.5, max_w=w - 14, offset=0.06)
    return resize(cv.rgb, h, w)


# ---- graffiti panels ---------------------------------------------------------
def graffiti_trash_is_life(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'concrete', 21)
    graffiti(cv, "TRASH IS\nLIFE", w / 2 - 6, h / 2 - 8, 68, '#ff6fa8', '#ffd23f', max_w=w - 60, seed=1, drips=7,
             rot=3)
    cv.shape(sd_star(cv.X, cv.Y, w - 22, 24, 12, 5), '#ffffff', outline=INK, ow=2)
    cv.shape(sd_star(cv.X, cv.Y, 20, h - 22, 8, 3.5), '#ffd23f', outline=INK, ow=1.6)
    return cv.rgb


def graffiti_raccoons_rule(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'plywood', 22)
    X, Y = cv.X, cv.Y
    graffiti(cv, "RACCOONS\nRULE", w / 2 + 10, h / 2 + 4, 80, '#7fe3c8', '#3faf7a', max_w=w - 64, seed=2, drips=6,
             rot=-3)
    crown = sd_poly(X, Y, [(14, 46), (14, 22), (24, 32), (32, 14), (40, 32), (50, 22), (50, 46)])
    cv.shape(crown, '#ffd23f', outline=INK, ow=2.5)
    for x in (20, 32, 44):
        cv.shape(sd_circle(X, Y, x, 40, 2.4), '#ff4d5e')
    return cv.rgb


def graffiti_paws(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'blue', 23)
    for k, (x, y, a) in enumerate(((22, 92, 30), (44, 74, 50), (52, 46, 20), (78, 34, 40), (90, 12, 30))):
        paw(cv, x, y, 15, a, '#ff6fa8' if k % 2 else '#ffffff', outline=INK, ow=2.0)
    return cv.rgb


def graffiti_nom(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'brick', 24)
    graffiti(cv, "NOM", w / 2, h / 2 - 6, 46, '#ffa94d', '#ff4d5e', max_w=w - 16, seed=4, drips=4, rot=6)
    graffiti(cv, "NOM", w / 2 + 6, h - 20, 22, '#ffffff', max_w=w - 40, seed=5, drips=2, rot=-4, spray=False, ow=3)
    return cv.rgb


def graffiti_heart(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'pink', 25)
    X, Y = cv.X, cv.Y
    t = np.linspace(0, 2 * math.pi, 120, endpoint=False)
    hx = 16 * np.sin(t) ** 3
    hy = -(13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t))
    pts = list(zip(w / 2 + hx * 2.9, h / 2 - 2 + hy * 2.9))
    heart = sd_poly(X, Y, pts)
    cv.fill(np.clip(blur(cover(heart - 4), 3) * 0.5, 0, 1), INK)
    cv.shape(heart, '#ff4d6d', outline=INK, ow=3.5)
    cv.fill(cover(sd_ellipse(X, Y, w / 2 - 22, h / 2 - 22, 9, 5, -35)), '#ffffff', alpha=0.7)
    cv.text("R+T", w / 2, h / 2 + 2, 22, '#ffffff', outline=INK, ow=2.0, offset=0.06)
    return cv.rgb


def graffiti_crown(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'concrete', 26)
    X, Y = cv.X, cv.Y
    raccoon_head(cv, w / 2, h / 2 + 12, 36, mood='grin', ow=2.5)
    crown = sd_poly(X, Y, [(w / 2 - 24, 34), (w / 2 - 26, 10), (w / 2 - 12, 22), (w / 2, 4), (w / 2 + 12, 22),
                           (w / 2 + 26, 10), (w / 2 + 24, 34)])
    cv.shape(crown, '#ffd23f', outline=INK, ow=2.5)
    for x in (-12, 0, 12):
        cv.shape(sd_circle(X, Y, w / 2 + x, 28, 2.5), '#4cc9f0')
    return cv.rgb


def graffiti_bandit(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'mint', 27)
    X, Y = cv.X, cv.Y
    mask = sd_union(sd_ellipse(X, Y, w / 2 - 22, 30, 24, 14, 12), sd_ellipse(X, Y, w / 2 + 22, 30, 24, 14, -12))
    cv.shape(mask, MASK, outline=INK, ow=2.5)
    for sx in (-1, 1):
        cv.shape(sd_circle(X, Y, w / 2 + sx * 20, 30, 7), '#ffffff')
        cv.shape(sd_circle(X, Y, w / 2 + sx * 20 + 2, 31, 3.5), INK)
    graffiti(cv, "BANDIT", w / 2, h * 0.68, 30, '#b795ff', '#7b6cf6', max_w=w - 12, seed=7, drips=4, rot=-5)
    return cv.rgb


def graffiti_wow(w, h):
    cv = Canvas(w, h)
    panel_bg(cv, 'concrete', 28)
    X, Y = cv.X, cv.Y
    pts = []
    for k in range(24):
        a = math.radians(k * 15)
        rr = 50 if k % 2 == 0 else 34
        pts.append((w / 2 + rr * math.cos(a), h / 2 + rr * math.sin(a)))
    burst = sd_poly(X, Y, pts)
    cv.shape(burst, '#ffe066', outline=INK, ow=3.0)
    graffiti(cv, "WOW!", w / 2, h / 2, 30, '#ff6f91', max_w=w - 36, seed=8, drips=3, rot=8, spray=False, ow=3.0)
    return cv.rgb


# ---- ground decals (on asphalt) ---------------------------------------------
ASPHALT = '#4f5566'


def asphalt_bg(cv, seed):
    if cv.a is not None:                 # transparent canvas: painted straight on the ground
        return
    fill_bg(cv, ASPHALT)
    v = 0.93 + 0.02 * grain((cv.h, cv.w), seed, 0.7)
    spk = T.rng(seed + 1).random((cv.h, cv.w)) < 0.012
    v = v + spk * 0.07
    cv.rgb *= v[..., None]


def paint(cv, d, color='#f4f1ea', alpha=0.92, seed=0):
    """Worn road paint: coverage of d with a little wear."""
    wear = 1.0 - 0.25 * (pnoise((cv.h, cv.w), 12.0, seed) > 0.72)
    cv.fill(cover(d) * wear, color, alpha)


def decal_manhole(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 31)
    X, Y = cv.X, cv.Y
    c = sd_circle(X, Y, w / 2, h / 2, 48)
    cv.shape(c + 0, '#6f7484')
    cv.fill(cover(np.abs(c) - 1.2), '#2e313b')
    cv.shape(sd_circle(X, Y, w / 2, h / 2, 42), '#3e424f')
    lx = ((X - w / 2) % 12) - 6
    ly = ((Y - h / 2) % 12) - 6
    grid_ = np.maximum(np.abs(lx) - 3.2, np.abs(ly) - 3.2)
    cv.fill(cover(grid_) * cover(sd_circle(X, Y, w / 2, h / 2, 38)), '#565b6a')
    cv.fill(cover(np.abs(sd_circle(X, Y, w / 2, h / 2, 38)) - 1.0), '#2e313b')
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, 16, 8, 3), '#3e424f', outline='#2e313b', ow=1.0)
    cv.text("TT", w / 2, h / 2, 9, '#8a8fa3', offset=0.05)
    return cv.rgb


def decal_drain(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 32)
    X, Y = cv.X, cv.Y
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, 44, 30, 4), '#8a8fa3')
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, 38, 24, 3), '#2b2d35')
    for k in range(7):
        x = w / 2 - 30 + k * 10
        cv.shape(sd_rbox(X, Y, x, h / 2, 2.4, 22, 1), '#6f7484')
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, 37, 2.2, 1), '#6f7484')
    paint(cv, sd_union(*[sd_rbox(X, Y, w / 2 + i * 14, h / 2 + 42, 5, 3, 1) for i in range(-2, 3)]), '#ffd23f', 0.8, 1)
    return cv.rgb


def decal_paw_trail(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 33)
    for k, (x, y) in enumerate(((26, 98), (52, 82), (40, 58), (68, 44), (58, 20), (86, 10))):
        paw(cv, x, y, 13, 25, '#f4f1ea', alpha=0.9)
    return cv.rgb


def decal_oil(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 34)
    X, Y = cv.X, cv.Y
    r = T.rng(5)
    d = None
    for k in range(6):
        e = sd_ellipse(X, Y, w / 2 + r.normal(0, 12), h / 2 + r.normal(0, 10), r.uniform(14, 26), r.uniform(10, 18),
                       r.uniform(0, 180))
        d = e if d is None else sd_union(d, e)
    soft = blur(cover(d, 3.0), 2.5)
    cv.fill(soft, '#1f2129', alpha=0.85)
    ring = np.clip(blur(cover(np.abs(d + 4) - 2.0, 2.0), 1.5), 0, 1)
    t = (X + Y) / (w + h)
    sheen = col('#b795ff') * (1 - t[..., None]) + col('#4ecdc4') * t[..., None]
    cv.fill(ring * soft, sheen, alpha=0.45)
    cv.fill(cover(sd_ellipse(X, Y, w / 2 - 10, h / 2 - 8, 8, 4, -20)), '#ffffff', alpha=0.18)
    return cv.rgb


def decal_arrow(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 35)
    X, Y = cv.X, cv.Y
    d = sd_union(sd_rbox(X, Y, w / 2, h * 0.64, 9, 36, 0),
                 sd_poly(X, Y, [(w / 2 - 28, h * 0.4), (w / 2, 6), (w / 2 + 28, h * 0.4)]))
    paint(cv, d, seed=2)
    return cv.rgb


def decal_trash_zone(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 36)
    X, Y = cv.X, cv.Y
    box = np.abs(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 8, h / 2 - 8, 4)) - 2.5
    paint(cv, box, '#ffd23f', seed=3)
    # stencil text: render then cut thin bridges
    m = cv.place(T.text_mask("TRASH\nZONE", 66, max_w=w - 30, offset=0.06, line_gap=0.9), w / 2, h / 2)
    bridges = cover(np.abs(((X - 3) % 13) - 6.5) - 0.9) * (np.abs(Y - h / 2) > 3)
    stencil = m * (1 - 0.0 * bridges)
    wear = 1.0 - 0.3 * (pnoise((h, w), 10.0, 9) > 0.7)
    cv.fill(stencil * wear, '#ffd23f', alpha=0.92)
    return cv.rgb


def decal_patch(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 37)
    X, Y = cv.X, cv.Y
    pts = [(14, 20), (90, 12), (100, 60), (92, 98), (30, 100), (10, 64)]
    d = sd_poly(X, Y, pts)
    cv.fill(cover(d), '#434856', alpha=0.9)                       # fresher, darker asphalt
    cv.fill(cover(np.abs(d) - 1.4), '#2a2c34', alpha=0.85)        # tar seal along the cut
    cv.fill(cover(np.abs(d + 3.0) - 0.6), '#5d6273', alpha=0.5)
    return cv.rgb


def decal_raccoon_xing(w, h):
    cv = Canvas(w, h)
    asphalt_bg(cv, 38)
    X, Y = cv.X, cv.Y
    m = cv.place(T.text_mask("RACCOON\nXING", 64, max_w=w - 10, offset=0.07, line_gap=0.95), w / 2, h * 0.36)
    wear = 1.0 - 0.25 * (pnoise((h, w), 12.0, 4) > 0.72)
    cv.fill(m * wear, '#f4f1ea', 0.92)
    paw(cv, w / 2 - 18, h * 0.85, 11, -10, '#ffd23f', alpha=0.9)
    paw(cv, w / 2 + 18, h * 0.81, 11, 10, '#ffd23f', alpha=0.9)
    return cv.rgb


# ---- car decals --------------------------------------------------------------
def plate(w, h, text, seed):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#fff6e0')
    cv.noise(0.015, seed, f0=10)
    frame(cv, INK, w=3.0)
    cv.fill(cover(np.abs(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 6, h / 2 - 6, 3)) - 0.7), '#2a4fb8')
    cv.text("TINY TOWN", w / 2, 10, 6, '#ff4d5e', offset=0.04)
    cv.text(text, w / 2, h / 2 + 5, 22, '#2a4fb8', max_w=w - 20, offset=0.05)
    return cv.rgb


def car_plate_a(w, h):
    return plate(w, h, "TRSH 01", 41)


def car_plate_b(w, h):
    return plate(w, h, "RCN 123", 42)


def car_taxi_sign(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#ffd23f')
    for k in range(int(w // 8) + 1):
        for row in (0, 1):
            if (k + row) % 2 == 0:
                cv.fill(cover(sd_rbox(X, Y, k * 8 + 4, row * 6 + 3, 4, 3)), INK)
                cv.fill(cover(sd_rbox(X, Y, k * 8 + 4, h - 9 + row * 6, 4, 3)), INK)
    cv.text("TAXI", w / 2, h / 2, 22, INK, offset=0.06)
    frame(cv, INK, w=2.0)
    return cv.rgb


def car_checker(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    s = h / 2.0
    ix, iy = np.floor(X / s).astype(int), np.floor(Y / s).astype(int)
    blk = ((ix + iy) % 2 == 0)
    cv.rgb[:] = col('#fffdf5')
    cv.rgb[blk] = col('#2b2b36')
    return cv.rgb


def car_pest_control(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#fffaf3')
    cv.shape(sd_circle(X, Y, 56, h / 2, 46), '#c9f2e2', outline=INK, ow=3.0)
    raccoon_head(cv, 56, h / 2 + 4, 27, mood='o', ow=2.0, look=(0.3, 0.2))
    no_sign(cv, 56, h / 2, 46, ow=4.0)
    shine_text(cv, "PEST\nCONTROL", 108 + (w - 118) / 2, h / 2 - 2, 70, '#3faf7a', ow=3.0, max_w=w - 122,
               offset=0.055, line_gap=0.92)
    cv.text("WE GET THEM. EVENTUALLY.", 108 + (w - 118) / 2, h - 7, 6, INK, max_w=w - 124, offset=0.03)
    return cv.rgb


def car_icecream_menu(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#a6f0d6')
    frame(cv, INK, w=3.0)
    cv.shape(sd_rbox(X, Y, w / 2, 14, w / 2 - 10, 9, 3), '#ff9ecf', outline=INK, ow=1.5)
    cv.text("MENU", w / 2, 14, 11, '#ffffff', offset=0.06)
    rows = (('$2', 'cone'), ('$3', 'pop'), ('$4', 'sundae'))
    for k, (price, kind) in enumerate(rows):
        y = 40 + k * 26
        ix = 30
        if kind == 'cone':
            cv.shape(sd_poly(X, Y, [(ix - 7, y - 2), (ix + 7, y - 2), (ix, y + 12)]), '#e8b26a', outline=INK, ow=1.2)
            cv.shape(sd_circle(X, Y, ix, y - 5, 7), '#ff8ac0', outline=INK, ow=1.2)
        elif kind == 'pop':
            cv.shape(sd_rbox(X, Y, ix, y + 9, 1.5, 5, 1), '#c98a57', outline=INK, ow=1.0)
            cv.shape(sd_rbox(X, Y, ix, y - 2, 7, 10, 5), '#ffd23f', outline=INK, ow=1.2)
        else:
            cv.shape(np.maximum(sd_circle(X, Y, ix, y, 9), -(Y - y)), '#ffffff', outline=INK, ow=1.2)
            cv.shape(sd_circle(X, Y, ix, y - 3, 6), '#7fe3c8', outline=INK, ow=1.0)
            cv.shape(sd_circle(X, Y, ix + 1, y - 10, 2.5), '#e8283c')
        cv.text(price, w * 0.66, y + 1, 15, INK, offset=0.06)
        cv.fill(cover(np.abs(Y - (y + 1)) - 0.5) * (X > 44) * (X < 56), INK)
    return cv.rgb


# ---- labels / misc -----------------------------------------------------------
def label_fizz(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    t = (Y / h)[..., None]
    cv.rgb = col('#ff4d5e') * (1 - t) + col('#e8283c') * t
    r = T.rng(6)
    for k in range(18):
        cv.shape(sd_circle(X, Y, r.uniform(0, w), r.uniform(0, h), r.uniform(1.0, 3.0)), '#ffffff', alpha=0.5)
    cv.shape(sd_rbox(X, Y, w / 2, h - 5, w / 2 + 2, 2.0, 0), '#ffffff')
    cv.shape(sd_rbox(X, Y, w / 2, 5, w / 2 + 2, 2.0, 0), '#ffffff')
    shine_text(cv, "FIZZ", w / 2, h / 2, 26, '#ffffff', ow=2.0, max_w=w - 20, offset=0.06)
    return cv.rgb


def label_beans(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#ffa94d')
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, w / 2 + 2, h / 2 - 8, 0), '#fff1d6')
    for k, x in enumerate((14, 26, w - 26, w - 14)):
        cv.shape(sd_ellipse(X, Y, x, h / 2 + (k % 2) * 4 - 2, 5, 3.4, 25 + k * 30), '#c9734f', outline=INK, ow=1.0)
    cv.text("BEANS", w / 2, h / 2, 20, '#8a5a3c', max_w=w - 64, offset=0.06)
    return cv.rgb


def label_caps(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#fff1d6')
    ang = np.arctan2(Y - h / 2, X - w / 2)
    cap = sd_circle(X, Y, w / 2, h / 2, w * 0.42) + 1.2 * np.sin(ang * 21)
    cv.shape(cap, '#e8283c', outline=INK, ow=1.5)
    cv.shape(sd_circle(X, Y, w / 2, h / 2, w * 0.3), '#ff4d5e')
    cv.shape(sd_star(X, Y, w / 2, h / 2, w * 0.2, w * 0.09), '#ffffff')
    return cv.rgb


def label_tape(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#b9bfcc')
    weave = 0.5 + 0.25 * np.sin(X * 1.6) + 0.25 * np.sin(Y * 1.6)
    cv.rgb *= (0.94 + 0.08 * weave)[..., None]
    cv.fill(cover(sd_ellipse(X, Y, w * 0.35, h * 0.3, w * 0.3, h * 0.08, -20)), '#ffffff', alpha=0.35)
    return cv.rgb


def loot_q(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#ff6fa8')
    cv.shape(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 4, h / 2 - 4, 7), '#ffd23f', outline=INK, ow=2.0)
    shine_text(cv, "?", w / 2, h / 2 + 1, 28, '#ffffff', ow=2.0, offset=0.07)
    return cv.rgb


def rip_plaque(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    fill_bg(cv, '#b4aec6')
    cv.noise(0.04, 5, f0=14)
    frame(cv, INK, w=2.5)
    cv.fill(cover(np.abs(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 7, h / 2 - 7, 3)) - 0.8), '#8d86a3')
    m = cv.place(T.text_mask("R.I.P.", 24, offset=0.05), w / 2, h / 2 - 2)
    cv.fill(shift(m, 0, 1), '#e4e0ee')
    cv.fill(m, '#5d5876')
    cv.text("TRASH PANDA", w / 2, h - 11, 5, '#5d5876', offset=0.03)
    return cv.rgb


ATLAS_ART = {
    'window_curtains': win_curtains, 'window_blinds': win_blinds, 'window_plant': win_plant,
    'window_cat': win_cat, 'window_raccoon': win_raccoon, 'window_lamp': win_lamp,
    'window_fishbowl': win_fishbowl, 'window_for_rent': win_for_rent,
    'door_wood': door_wood, 'door_blue': door_blue, 'door_shop': door_shop, 'door_red': door_red,
    'sign_pizza': sign_pizza, 'sign_donuts': sign_donuts, 'sign_snack_shack': sign_snack_shack,
    'sign_laundromat': sign_laundromat, 'sign_burger': sign_burger,
    'sign_trash_treasures': sign_trash_treasures, 'sign_no_raccoons': sign_no_raccoons,
    'sign_pest_control': sign_pest_control,
    'poster_wanted': poster_wanted, 'poster_lost_sandwich': poster_lost_sandwich,
    'poster_beware': poster_beware, 'poster_donut_day': poster_donut_day,
    'poster_yard_sale': poster_yard_sale, 'poster_vote_bandit': poster_vote_bandit,
    'graffiti_trash_is_life': graffiti_trash_is_life, 'graffiti_raccoons_rule': graffiti_raccoons_rule,
    'graffiti_paws': graffiti_paws, 'graffiti_nom': graffiti_nom, 'graffiti_heart': graffiti_heart,
    'graffiti_crown': graffiti_crown, 'graffiti_bandit': graffiti_bandit, 'graffiti_wow': graffiti_wow,
    'decal_manhole': decal_manhole, 'decal_drain': decal_drain, 'decal_paw_trail': decal_paw_trail,
    'decal_oil': decal_oil, 'decal_arrow': decal_arrow, 'decal_trash_zone': decal_trash_zone,
    'decal_patch': decal_patch, 'decal_raccoon_xing': decal_raccoon_xing,
    'car_plate_a': car_plate_a, 'car_plate_b': car_plate_b, 'car_taxi_sign': car_taxi_sign,
    'car_checker': car_checker, 'car_pest_control': car_pest_control,
    'car_icecream_menu': car_icecream_menu,
    'label_fizz': label_fizz, 'label_beans': label_beans, 'label_caps': label_caps,
    'label_tape': label_tape, 'loot_q': loot_q, 'rip_plaque': rip_plaque,
}


def build_atlas_town():
    A = T.atlas_town()
    missing = [n for n in A.cells if n != 'swatches' and n not in ATLAS_ART]
    if missing:
        raise RuntimeError("atlas cells without art: %s" % missing)
    img = np.ones((A.h, A.w, 3))                     # unused space stays white
    sx, sy, _, _ = A.rect_px('swatches')
    for i, (name, hx) in enumerate(T.PALETTE.items()):
        x = sx + (i % T.SWATCH_COLS) * T.SWATCH_PX
        y = sy + (i // T.SWATCH_COLS) * T.SWATCH_PX
        img[y:y + T.SWATCH_PX, x:x + T.SWATCH_PX] = col(hx)
    for name, cell in A.cells.items():
        if name == 'swatches':
            continue
        x, y, w, h = cell['rect']
        art = np.asarray(ATLAS_ART[name](w, h), np.float64)
        if art.shape != (h, w, 3):
            raise RuntimeError("%s: art shape %s != %s" % (name, art.shape, (h, w, 3)))
        img[y:y + h, x:x + w] = np.clip(art, 0, 1)
    A.pad(img)
    return to_u8(img), A


# =============================================================================
# decals: the town atlas's ground markings and graffiti again, with real alpha
# =============================================================================
# The GLBs draw atlas_town opaque (an alpha channel there would be wasted on them, and
# check-assets forbids it on opaque materials).  The game's own ground markings and wall
# pictures (CityView, gfx/Decals.ts) are blended instead, from this RGBA copy laid out
# exactly like atlas_town (same cell rects, so atlasTown.gen.json's UVs apply): markings
# and graffiti are drawn over nothing, so only the paint shows; posters stay opaque paper.
DECALS_ALPHA = [n for n in ATLAS_ART if n.startswith('decal_') or n.startswith('graffiti_')]
DECALS_OPAQUE = [n for n in ATLAS_ART if n.startswith('poster_')]
T.TEX['decals'] = T.TexInfo('decals.png', None, False, 1024)


def build_decals():
    A = T.atlas_town()
    img = np.zeros((A.h, A.w, 4))                    # everything else: transparent black
    for name in DECALS_ALPHA + DECALS_OPAQUE:
        x, y, w, h = A.rect_px(name)
        if name in DECALS_OPAQUE:
            art = np.clip(np.asarray(ATLAS_ART[name](w, h), np.float64), 0, 1)
            rgba = np.concatenate([art, np.ones((h, w, 1))], axis=2)
        else:
            rgba = T.render_transparent(ATLAS_ART[name], w, h)
        if rgba.shape != (h, w, 4):
            raise RuntimeError("%s: decal shape %s != %s" % (name, rgba.shape, (h, w, 4)))
        img[y:y + h, x:x + w] = rgba
    A.pad(img)
    return to_u8(img)


# =============================================================================
# atlas_chars: faces (8 expressions per species), shirt patterns, accessory prints
# =============================================================================
# Faces are drawn ON WHITE where the material tint shows (the raccoon face plate takes the
# Belly cream, people take their skin colour); ink features stay dark under any tint.
# Every cell of a species frames the face identically (T.FACE_PROJ), because the game swaps
# expressions by translating the UVs by whole cells.  Features are placed in head-local
# metres (X toward the model's left = image right, Z up from the head centre).
FACE_SS = 3                       # supersampling of the face cells
MOUTH = '#8c2f45'
TONGUE = '#ff7f9c'
BLUSH = '#ff8fa8'
RAC_MASK = '#2f2838'


class FaceCanvas(Canvas):
    """A face cell canvas whose drawing helpers take head-local metres.  Drawn isotropically
    at the projection's vertical scale, then squeezed to the cell (the projection may give
    the face more texels vertically than horizontally)."""

    def __init__(self, species):
        self.sp = species
        p = T.FACE_PROJ[species]
        self.kx = p['sz'] / p['sx']                       # horizontal stretch of the drawing
        self.cx, self.cy, self.ppm = p['cx'] * self.kx * FACE_SS, p['cy'] * FACE_SS, p['sz'] * FACE_SS
        super().__init__(int(round(T.FACE_CELL * self.kx * FACE_SS)), T.FACE_CELL * FACE_SS, '#ffffff')

    def P(self, X, Z):
        return self.cx + X * self.ppm, self.cy - Z * self.ppm

    def m(self, v):
        return v * self.ppm

    def ell(self, X, Z, rx, rz, ang=0.0):
        x, y = self.P(X, Z)
        return sd_ellipse(self.X, self.Y, x, y, self.m(rx), self.m(rz), ang)

    def circ(self, X, Z, r):
        x, y = self.P(X, Z)
        return sd_circle(self.X, self.Y, x, y, self.m(r))

    def seg(self, X0, Z0, X1, Z1, th):
        a, b = self.P(X0, Z0), self.P(X1, Z1)
        return sd_capsule(self.X, self.Y, a[0], a[1], b[0], b[1], self.m(th))

    def poly(self, pts):
        return sd_poly(self.X, self.Y, [self.P(x, z) for x, z in pts])

    def arc(self, X, Z, r, a0, a1, th):
        """Arc in image angles (degrees from image-right toward image-DOWN)."""
        x, y = self.P(X, Z)
        return sd_arc(self.X, self.Y, x, y, self.m(r), a0, a1, self.m(th))

    def rbox(self, X, Z, hw, hz, r=0.0, ang=0.0):
        x, y = self.P(X, Z)
        return sd_rbox(self.X, self.Y, x, y, self.m(hw), self.m(hz), self.m(r), ang)

    def out(self):
        return resize(self.rgb, T.FACE_CELL, T.FACE_CELL)


def wobble_line(fc, X0, X1, Z, amp, n, th):
    """Zig-zag line (ouch mouth) from X0 to X1 at height Z."""
    d = None
    pts = []
    for k in range(n + 1):
        x = X0 + (X1 - X0) * k / n
        pts.append((x, Z + (amp if k % 2 else -amp)))
    for a, b in zip(pts, pts[1:]):
        s = fc.seg(a[0], a[1], b[0], b[1], th)
        d = s if d is None else np.minimum(d, s)
    return d


def open_mouth(fc, X, Z, w, h, tongue=True, ink=INK, th=0.007, tooth=False):
    """D-shaped open smile: flat top at Z, round bottom, dark inside, tongue at the bottom."""
    body = np.maximum(fc.ell(X, Z, w, h), fc.P(0, Z)[1] - fc.Y)      # lower half-ellipse
    fc.shape(body, MOUTH, outline=ink, ow=fc.m(th))
    if tongue:
        fc.fill(cover(np.maximum(fc.ell(X, Z - h * 0.75, w * 0.62, h * 0.45), body)), TONGUE)
    if tooth:
        fc.fill(cover(np.maximum(fc.rbox(X - w * 0.35, Z - h * 0.12, w * 0.16, h * 0.14, w * 0.04), body)), '#ffffff')


# ---- raccoon ------------------------------------------------------------------
R_EYE_X, R_EYE_Z = 0.106, 0.03


def _smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def raccoon_mask(fc, top_l=0.098, top_r=0.098, bridge_top=0.084, slant=0.0, raise_r=0.0):
    """The bandit mask band (near-black, so it stays dark under the belly tint), between a
    smooth brow curve above and a cheek curve below.  top_*: brow line height above each
    eye; slant > 0 tips the brow line down toward the nose (angry); raise_r arches the
    image-right brow up."""
    Xm = (fc.X - fc.cx) / fc.ppm                      # metres, per pixel column
    ax = np.abs(Xm)
    right = Xm > 0
    top = np.where(right, top_r, top_l)
    zb = R_EYE_Z + top
    # brow line: low at the bridge, flat over the eye, falling toward the side of the head
    z_top = bridge_top + (zb - bridge_top) * _smooth(0.015, 0.085, ax)
    z_top = z_top - slant * 0.055 * (1.0 - _smooth(0.03, 0.17, ax)) * _smooth(0.0, 0.04, ax)
    z_top = z_top + np.where(right, raise_r * 0.034 * np.exp(-((ax - 0.11) / 0.06) ** 2), 0.0)
    z_top = z_top - 0.075 * _smooth(0.17, 0.44, ax)
    # cheek line: dips round each eye, up at the nose bridge, down the sides
    z_bot = (R_EYE_Z - 0.032) - 0.046 * np.exp(-((ax - R_EYE_X) / 0.06) ** 2) - 0.06 * _smooth(0.17, 0.44, ax)
    yt = fc.cy - z_top * fc.ppm
    yb = fc.cy - z_bot * fc.ppm
    band = np.maximum(yt - fc.Y, fc.Y - yb)
    fc.shape(band, RAC_MASK)
    return band


def raccoon_eye_white(fc, s, rx=0.058, rz=0.064, dz=0.0):
    return fc.ell(s * R_EYE_X, R_EYE_Z + dz, rx, rz)


def raccoon_pupil(fc, s, r=0.042, dx=-0.004, dz=-0.004, shine=True):
    X, Z = s * R_EYE_X + s * dx, R_EYE_Z + dz
    fc.shape(fc.circ(X, Z, r), INK)
    if shine:
        fc.shape(fc.circ(X - 0.016, Z + 0.017, r * 0.36), '#ffffff')
        fc.shape(fc.circ(X + 0.013, Z - 0.014, r * 0.15), '#ffffff')


def raccoon_nose_mouth(fc):
    """Texture nose (under the 3D nose) and the line down to the mouth."""
    fc.shape(fc.poly([(-0.042, -0.035), (0.042, -0.035), (0.0, -0.078)]) - fc.m(0.012), INK)
    fc.shape(fc.seg(0, -0.07, 0, -0.105, 0.0055), INK)


def raccoon_blush(fc):
    for s in (1, -1):
        fc.fill(cover(fc.ell(s * 0.19, -0.075, 0.042, 0.024)), BLUSH, alpha=0.75)


def raccoon_face(expr):
    fc = FaceCanvas('raccoon')
    # cream everywhere (brows, muzzle, cheeks); the 3D patch outline decides what shows
    if expr == 0:      # neutral
        raccoon_mask(fc)
        for s in (1, -1):
            fc.shape(raccoon_eye_white(fc, s), '#ffffff')
            raccoon_pupil(fc, s)
    elif expr == 1:    # blink
        raccoon_mask(fc)
        for s in (1, -1):
            fc.shape(fc.arc(s * R_EYE_X, R_EYE_Z + 0.02, 0.048, 25, 155, 0.0085), '#ffffff')
    elif expr == 2:    # happy ^^
        raccoon_mask(fc, top_l=0.104, top_r=0.104)
        for s in (1, -1):
            fc.shape(fc.arc(s * R_EYE_X, R_EYE_Z - 0.03, 0.05, 205, 335, 0.012), '#ffffff')
    elif expr == 3:    # ouch ><
        raccoon_mask(fc, slant=0.4)
        for s in (1, -1):
            x = s * R_EYE_X
            tip = x - s * 0.028
            fc.shape(np.minimum(fc.seg(x + s * 0.03, R_EYE_Z + 0.034, tip, R_EYE_Z, 0.0105),
                                fc.seg(tip, R_EYE_Z, x + s * 0.03, R_EYE_Z - 0.034, 0.0105)), '#ffffff')
    elif expr == 4:    # KO: X X
        raccoon_mask(fc)
        for s in (1, -1):
            x = s * R_EYE_X
            fc.shape(np.minimum(fc.seg(x - 0.034, R_EYE_Z + 0.034, x + 0.034, R_EYE_Z - 0.034, 0.0105),
                                fc.seg(x - 0.034, R_EYE_Z - 0.034, x + 0.034, R_EYE_Z + 0.034, 0.0105)), '#ffffff')
    elif expr == 5:    # panic: huge eyes, tiny pupils
        raccoon_mask(fc, top_l=0.08, top_r=0.08)
        for s in (1, -1):
            fc.shape(raccoon_eye_white(fc, s, 0.07, 0.078, 0.004), '#ffffff')
            raccoon_pupil(fc, s, r=0.016, dx=0.0, dz=0.0, shine=False)
    elif expr == 6:    # determined: angry brows, narrowed eyes
        raccoon_mask(fc, slant=1.0, top_l=0.09, top_r=0.09)
        for s in (1, -1):
            white = raccoon_eye_white(fc, s, 0.058, 0.058, -0.006)
            lid = fc.poly([(s * (R_EYE_X - 0.09), R_EYE_Z - 0.008), (s * (R_EYE_X + 0.09), R_EYE_Z + 0.05),
                           (s * (R_EYE_X + 0.09), R_EYE_Z + 0.2), (s * (R_EYE_X - 0.09), R_EYE_Z + 0.2)])
            vis = np.maximum(white, -lid)
            fc.shape(vis, '#ffffff')
            fc.fill(cover(np.maximum(fc.circ(s * (R_EYE_X - 0.006), R_EYE_Z - 0.014, 0.036), vis)), INK)
            fc.fill(cover(np.maximum(fc.circ(s * (R_EYE_X - 0.018), R_EYE_Z - 0.004, 0.011), vis)), '#ffffff')
    elif expr == 7:    # mischief: one brow up, half-lidded eyes
        raccoon_mask(fc, raise_r=1.0, slant=0.0, top_l=0.075)
        for s in (1, -1):
            white = raccoon_eye_white(fc, s)
            lid_z = R_EYE_Z + (0.012 if s > 0 else -0.004)
            lid = fc.rbox(s * R_EYE_X, lid_z + 0.1, 0.12, 0.1)
            vis = np.maximum(white, -lid)
            fc.shape(vis, '#ffffff')
            fc.fill(cover(np.maximum(fc.circ(s * R_EYE_X + 0.012, R_EYE_Z - 0.012, 0.04), vis)), INK)
            fc.fill(cover(np.maximum(fc.circ(s * R_EYE_X - 0.002, R_EYE_Z - 0.004, 0.012), vis)), '#ffffff')
            fc.fill(cover(np.abs(lid) - fc.m(0.004)) * cover(white - fc.m(0.006)), '#ffffff')
    raccoon_nose_mouth(fc)
    # mouths
    if expr in (0, 1):
        for s in (1, -1):
            fc.shape(fc.arc(s * 0.026, -0.104, 0.026, 15, 165, 0.0055), INK)
        raccoon_blush(fc)
    elif expr == 2:
        open_mouth(fc, 0.0, -0.108, 0.07, 0.065, tooth=True)
        raccoon_blush(fc)
    elif expr == 3:
        fc.shape(wobble_line(fc, -0.055, 0.055, -0.125, 0.011, 5, 0.006), INK)
    elif expr == 4:
        fc.shape(fc.ell(0.0, -0.125, 0.032, 0.022), MOUTH, outline=INK, ow=fc.m(0.006))
        fc.shape(np.minimum(fc.ell(0.018, -0.16, 0.026, 0.036, ang=-15), fc.rbox(0.012, -0.135, 0.024, 0.012)),
                 TONGUE, outline=INK, ow=fc.m(0.0055))
        fc.shape(fc.seg(0.016, -0.145, 0.02, -0.17, 0.0025), '#e05a7a')
    elif expr == 5:
        fc.shape(fc.ell(0.0, -0.13, 0.034, 0.048), MOUTH, outline=INK, ow=fc.m(0.006))
        fc.fill(cover(np.maximum(fc.ell(0.0, -0.155, 0.022, 0.018), fc.ell(0.0, -0.13, 0.034, 0.048))), TONGUE)
    elif expr == 6:
        fc.shape(fc.seg(-0.045, -0.112, 0.045, -0.112, 0.0058), INK)
    elif expr == 7:
        sm = np.minimum(fc.arc(0.02, -0.088, 0.05, 30, 140, 0.0058), fc.seg(-0.025, -0.115, -0.045, -0.106, 0.0055))
        fc.shape(sm, INK)
        fc.fill(cover(np.maximum(fc.rbox(0.03, -0.142, 0.012, 0.012, 0.004), -fc.circ(0.02, -0.088, 0.05))), '#ffffff')
        raccoon_blush(fc)
    return fc.out()


# ---- people -------------------------------------------------------------------
H_EYE_X, H_EYE_Z = 0.126, -0.01
H_BROW_Z = 0.088
H_MOUTH_Z = -0.142


def human_brow(fc, s, dz=0.0, tilt=0.0, arch=0.0, th=0.0115):
    """s: +1 image right.  tilt > 0 lowers the inner end (angry)."""
    xi, xo = s * 0.075, s * 0.17
    zi, zo = H_BROW_Z + dz - tilt * 0.03, H_BROW_Z + dz + tilt * 0.01
    xm, zm = (xi + xo) / 2, (zi + zo) / 2 + 0.012 + arch
    return np.minimum(fc.seg(xi, zi, xm, zm, th), fc.seg(xm, zm, xo, zo, th))


def human_eye(fc, s, rx=0.056, rz=0.076, dz=0.0, lid=None):
    x, z = s * H_EYE_X, H_EYE_Z + dz
    e = fc.ell(x, z, rx, rz)
    if lid is not None:
        e = np.maximum(e, -lid)
    fc.shape(e, INK)
    sh = np.maximum(fc.circ(x - 0.019, z + 0.027, 0.021), e)
    fc.fill(cover(sh), '#ffffff')
    fc.fill(cover(np.maximum(fc.circ(x + 0.018, z - 0.027, 0.0095), e)), '#ffffff')
    return e


def human_blush(fc):
    for s in (1, -1):
        fc.fill(cover(fc.ell(s * 0.205, -0.098, 0.048, 0.026)), BLUSH, alpha=0.7)


def human_face(expr):
    fc = FaceCanvas('human')
    if expr == 0:
        for s in (1, -1):
            human_eye(fc, s)
            fc.shape(human_brow(fc, s), INK)
        fc.shape(fc.arc(0.0, H_MOUTH_Z + 0.03, 0.042, 25, 155, 0.0085), INK)
        human_blush(fc)
    elif expr == 1:
        for s in (1, -1):
            fc.shape(fc.arc(s * H_EYE_X, H_EYE_Z + 0.025, 0.048, 30, 150, 0.0095), INK)
            fc.shape(human_brow(fc, s, dz=-0.005), INK)
        fc.shape(fc.arc(0.0, H_MOUTH_Z + 0.03, 0.042, 25, 155, 0.0085), INK)
        human_blush(fc)
    elif expr == 2:
        for s in (1, -1):
            fc.shape(fc.arc(s * H_EYE_X, H_EYE_Z - 0.035, 0.052, 205, 335, 0.0115), INK)
            fc.shape(human_brow(fc, s, dz=0.012, arch=0.008), INK)
        open_mouth(fc, 0.0, H_MOUTH_Z + 0.03, 0.075, 0.07, tooth=True)
        human_blush(fc)
    elif expr == 3:
        for s in (1, -1):
            x = s * H_EYE_X
            tip = x - s * 0.03
            fc.shape(np.minimum(fc.seg(x + s * 0.032, H_EYE_Z + 0.036, tip, H_EYE_Z, 0.0105),
                                fc.seg(tip, H_EYE_Z, x + s * 0.032, H_EYE_Z - 0.036, 0.0105)), INK)
            fc.shape(human_brow(fc, s, dz=0.004, tilt=-0.6), INK)
        fc.shape(wobble_line(fc, -0.06, 0.06, H_MOUTH_Z + 0.004, 0.012, 5, 0.0075), INK)
    elif expr == 4:
        for s in (1, -1):
            x = s * H_EYE_X
            fc.shape(np.minimum(fc.seg(x - 0.036, H_EYE_Z + 0.036, x + 0.036, H_EYE_Z - 0.036, 0.0105),
                                fc.seg(x - 0.036, H_EYE_Z - 0.036, x + 0.036, H_EYE_Z + 0.036, 0.0105)), INK)
        fc.shape(fc.ell(0.0, H_MOUTH_Z + 0.008, 0.036, 0.024), MOUTH, outline=INK, ow=fc.m(0.007))
        fc.shape(np.minimum(fc.ell(0.02, H_MOUTH_Z - 0.03, 0.028, 0.038, ang=-15), fc.rbox(0.014, H_MOUTH_Z - 0.004, 0.026, 0.012)),
                 TONGUE, outline=INK, ow=fc.m(0.0065))
    elif expr == 5:
        for s in (1, -1):
            x = s * H_EYE_X
            ring = np.abs(fc.ell(x, H_EYE_Z + 0.006, 0.066, 0.082)) - fc.m(0.0075)
            fc.shape(ring, INK)
            fc.shape(fc.circ(x, H_EYE_Z + 0.004, 0.017), INK)
            fc.shape(human_brow(fc, s, dz=0.03, arch=0.016, tilt=-0.5), INK)
        fc.shape(fc.ell(0.0, H_MOUTH_Z - 0.004, 0.036, 0.052), MOUTH, outline=INK, ow=fc.m(0.007))
        fc.fill(cover(np.maximum(fc.ell(0.0, H_MOUTH_Z - 0.032, 0.024, 0.02), fc.ell(0.0, H_MOUTH_Z - 0.004, 0.036, 0.052))), TONGUE)
    elif expr == 6:
        for s in (1, -1):
            lid = fc.poly([(s * (H_EYE_X - 0.09), H_EYE_Z + 0.008), (s * (H_EYE_X + 0.09), H_EYE_Z + 0.06),
                           (s * (H_EYE_X + 0.09), H_EYE_Z + 0.3), (s * (H_EYE_X - 0.09), H_EYE_Z + 0.3)])
            human_eye(fc, s, lid=lid, rz=0.062)
            fc.shape(human_brow(fc, s, dz=-0.012, tilt=1.0, th=0.013), INK)
        fc.shape(fc.seg(-0.05, H_MOUTH_Z + 0.006, 0.05, H_MOUTH_Z + 0.006, 0.0075), INK)
    elif expr == 7:
        for s in (1, -1):
            lid = fc.rbox(s * H_EYE_X, H_EYE_Z + 0.012 + 0.1, 0.12, 0.1)
            e = human_eye(fc, s, lid=lid)
            fc.shape(fc.seg(s * H_EYE_X - 0.055, H_EYE_Z + 0.012, s * H_EYE_X + 0.055, H_EYE_Z + 0.012, 0.0075), INK)
            if s > 0:
                fc.shape(human_brow(fc, s, dz=0.032, arch=0.02), INK)
            else:
                fc.shape(human_brow(fc, s, dz=-0.004, tilt=0.5), INK)
        sm = np.minimum(fc.arc(0.024, H_MOUTH_Z + 0.04, 0.054, 30, 140, 0.0085), fc.seg(-0.026, H_MOUTH_Z + 0.004, -0.05, H_MOUTH_Z + 0.014, 0.0075))
        fc.shape(sm, INK)
        human_blush(fc)
    return fc.out()


# ---- shirt patterns (light: the shirt colour multiplies them) ------------------------
def shirt_pattern(k):
    S = T.FACE_CELL
    cv = Canvas(S, S)
    X, Y = cv.X, cv.Y
    inner = S - 2 * T.SHIRT_INNER          # pattern period along u: seamless round the body
    if k == 0:
        cv.rgb[:] = 1.0
        cv.rgb *= (0.985 + 0.015 * np.sin((X + Y) * 1.7))[..., None]
    elif k == 1:
        per = inner / 6.0
        d = np.abs(((Y - T.SHIRT_INNER) % per) - per / 2) - per * 0.24
        cv.fill(cover(d), '#b9bcc9')
    elif k == 2:
        per = inner / 5.0
        best = None
        for row in range(-1, 8):
            off = (row % 2) * per / 2
            for ci in range(-1, 7):
                cx, cy = T.SHIRT_INNER + ci * per + off, T.SHIRT_INNER + row * per * 0.87
                dd = sd_circle(X, Y, cx, cy, per * 0.24)
                best = dd if best is None else np.minimum(best, dd)
        cv.fill(cover(best), '#b5b8c6')
    else:
        cv.rgb[:] = col('#e4e6ee')
        r = T.rng(77)
        motifs = []
        for i in range(7):
            motifs.append((r.uniform(0, inner), r.uniform(0, S), r.uniform(0, 360), r.uniform(12, 17)))
        leaves = None
        flowers = []
        for (x, y, a, s) in motifs:
            for ox in (-inner, 0, inner):
                cx = T.SHIRT_INNER + x + ox
                for la in (a + 40, a + 160, a + 280):
                    lx = cx + math.cos(math.radians(la)) * s * 0.95
                    ly = y + math.sin(math.radians(la)) * s * 0.95
                    d = sd_ellipse(X, Y, lx, ly, s * 0.75, s * 0.32, la)
                    leaves = d if leaves is None else np.minimum(leaves, d)
                flowers.append((cx, y, a, s))
        cv.fill(cover(leaves), '#a7abbd')
        for (cx, cy, a, s) in flowers:
            ang = np.arctan2(Y - cy, X - cx) - math.radians(a)
            pet = np.hypot(X - cx, Y - cy) - s * (0.62 + 0.28 * np.abs(np.cos(2.5 * ang)))
            cv.shape(pet, '#ffffff', outline='#9a9eb1', ow=1.2)
            cv.shape(sd_circle(X, Y, cx, cy, s * 0.2), '#c9ccd8')
    return cv.rgb


# ---- accessory prints ------------------------------------------------------------
def print_paisley(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    r = T.rng(5)
    for i in range(9):
        x, y = (i % 3 + 0.5) * w / 3 + r.uniform(-6, 6), (i // 3 + 0.5) * h / 3 + r.uniform(-6, 6)
        a = r.uniform(0, 360)
        d = sd_union(sd_circle(X, Y, x, y, 9), sd_capsule(X, Y, x, y, x + 15 * math.cos(math.radians(a)),
                                                           y + 15 * math.sin(math.radians(a)), 7, 1.5))
        cv.fill(cover(np.abs(d) - 1.6), '#b7b9c6')
        cv.fill(cover(sd_circle(X, Y, x, y, 3.5)), '#b7b9c6')
    for i in range(30):
        cv.fill(cover(sd_circle(X, Y, r.uniform(0, w), r.uniform(0, h), 1.8)), '#c9cbd6')
    cv.fill(cover(np.abs(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 5, h / 2 - 5, 0)) - 1.5), '#c3c5d0')
    return cv.rgb


def print_sack(w, h):
    cv = Canvas(w, h, '#d9b98a')
    X, Y = cv.X, cv.Y
    weave = 0.5 + 0.25 * np.sin(X * 1.9) + 0.25 * np.sin(Y * 1.9)
    cv.rgb *= (0.9 + 0.12 * weave)[..., None]
    cv.noise(0.03, 3, f0=12)
    # sewn patch (slightly crooked) with stitches
    d = sd_rbox(X, Y, w * 0.5, h * 0.5, w * 0.22, h * 0.2, 3, 8)
    cv.shape(d, '#7fc8ff', outline='#5a4630', ow=1.5)
    st = (np.abs(d + 4.0) < 1.1) & (np.sin((X + Y) * 0.9) > 0.2)
    cv.fill(st.astype(float), '#fff6e0')
    paw(cv, w * 0.5, h * 0.52, h * 0.2, 8, '#2a4fb8')
    return cv.rgb


def print_apron(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    cv.fill(cover(np.abs((X % 10) - 5) - 1.0), '#cfe1f5')
    cv.shape(sd_rbox(X, Y, w * 0.5, h * 0.66, w * 0.2, h * 0.11, 3), '#ffffff', outline='#9fbfe6', ow=1.4)
    r = T.rng(9)
    sp = sd_circle(X, Y, w * 0.68, h * 0.3, 8)
    for k in range(7):
        a = r.uniform(0, 2 * math.pi)
        sp = np.minimum(sp, sd_circle(X, Y, w * 0.68 + math.cos(a) * r.uniform(8, 13), h * 0.3 + math.sin(a) * r.uniform(7, 12),
                                      r.uniform(1.5, 3.5)))
    cv.fill(cover(sp), '#e8283c')
    return cv.rgb


def print_skull(w, h):
    cv = Canvas(w, h, '#2b2340')
    X, Y = cv.X, cv.Y
    for a in (40, -40):
        c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
        cv.shape(sd_capsule(X, Y, w / 2 - 18 * c, h * 0.58 - 18 * s, w / 2 + 18 * c, h * 0.58 + 18 * s, 3.2), '#ffffff')
        for e in (-1, 1):
            cv.shape(sd_circle(X, Y, w / 2 + e * 19 * c - e * 2.5 * s, h * 0.58 + e * 19 * s + e * 2.5 * c, 3.6), '#ffffff')
            cv.shape(sd_circle(X, Y, w / 2 + e * 19 * c + e * 2.5 * s, h * 0.58 + e * 19 * s - e * 2.5 * c, 3.6), '#ffffff')
    cv.shape(sd_union(sd_circle(X, Y, w / 2, h * 0.42, 13), sd_rbox(X, Y, w / 2, h * 0.58, 8, 6, 2)), '#ffffff')
    for e in (-1, 1):
        cv.shape(sd_circle(X, Y, w / 2 + e * 5.5, h * 0.42, 3.8), '#2b2340')
    cv.shape(sd_poly(X, Y, [(w / 2 - 2, h * 0.53), (w / 2 + 2, h * 0.53), (w / 2, h * 0.49)]), '#2b2340')
    return cv.rgb


def print_stink(w, h):
    cv = Canvas(w, h, '#fff1d6')
    X, Y = cv.X, cv.Y
    frame(cv, INK, w=2.5)
    cl = sd_union(*[sd_circle(X, Y, w / 2 + dx, h * 0.45 + dy, r) for dx, dy, r in
                    ((-12, 2, 10), (0, -5, 12), (12, 2, 10), (-5, 7, 9), (6, 7, 9))])
    cv.shape(cl, '#8fd16a', outline=INK, ow=1.8)
    for e in (-1, 1):  # grossed-out face
        cv.shape(sd_segment(X, Y, w / 2 + e * 7 - 3, h * 0.4 - 3, w / 2 + e * 7 + 3, h * 0.4 + 3) - 1.1, INK)
        cv.shape(sd_segment(X, Y, w / 2 + e * 7 - 3, h * 0.4 + 3, w / 2 + e * 7 + 3, h * 0.4 - 3) - 1.1, INK)
    cv.shape(sd_ellipse(X, Y, w / 2, h * 0.53, 4, 2.6), INK)
    for k in range(3):
        x = w / 2 - 14 + k * 14
        cv.shape(sd_arc(X, Y, x, h * 0.83, 4, 180, 360, 1.0) if k % 2 else sd_arc(X, Y, x, h * 0.79, 4, 0, 180, 1.0), '#3faf6a')
    return cv.rgb


def print_pest(w, h):
    cv = Canvas(w, h, '#fff6e8')
    X, Y = cv.X, cv.Y
    cv.shape(np.abs(sd_rbox(X, Y, w / 2, h / 2, w / 2 - 3, h / 2 - 3, h / 2 - 3)) - 2.0, '#3faf7a')
    raccoon_head(cv, 22, h / 2 + 2, 13, mood='o', ow=1.2, blush=False)
    no_sign(cv, 22, h / 2, 19, ow=2.5)
    cv.text("PEST", 22 + (w - 30) / 2 + 6, h / 2 - 5, 16, '#3faf7a', max_w=w - 52, offset=0.07)
    cv.text("CONTROL", 22 + (w - 30) / 2 + 6, h / 2 + 11, 7, INK, max_w=w - 54, offset=0.05)
    return cv.rgb


def print_tank(w, h):
    cv = Canvas(w, h, '#ffd23f')
    X, Y = cv.X, cv.Y
    hz = ((X + Y) % 14) < 7
    band = (Y < 7) | (Y > h - 7)
    cv.fill((hz & band).astype(float), INK)
    raccoon_head(cv, w / 2, h / 2 + 2, 14, mood='o', ow=1.2, blush=False)
    no_sign(cv, w / 2, h / 2, 21, ow=2.5)
    return cv.rgb


def print_tie(w, h):
    cv = Canvas(w, h, '#e8283c')
    X, Y = cv.X, cv.Y
    d = np.abs(((X - Y * 0.9) % 18) - 9) - 2.6
    cv.fill(cover(d), '#2a4fb8')
    return cv.rgb


def print_hatband(w, h):
    cv = Canvas(w, h, '#ff6f91')
    X, Y = cv.X, cv.Y
    for k in range(6):
        x = (k + 0.5) * w / 6
        c = '#ffffff' if k % 2 == 0 else '#ffe066'
        ang = np.arctan2(Y - h / 2, X - x)
        pet = np.hypot(X - x, Y - h / 2) - 6.0 * (0.6 + 0.4 * np.abs(np.cos(2.5 * ang)))
        cv.shape(pet, c)
        cv.shape(sd_circle(X, Y, x, h / 2, 1.8), '#ff8a2a')
    return cv.rgb


def print_badge(w, h):
    cv = Canvas(w, h, '#ff4d5e')
    X, Y = cv.X, cv.Y
    cv.shape(sd_circle(X, Y, w / 2, h / 2, w * 0.36), '#fff1d6', outline=INK, ow=1.5)
    cv.shape(sd_star(X, Y, w / 2, h / 2 + 1, w * 0.27, w * 0.12), '#ffd23f', outline=INK, ow=1.2)
    return cv.rgb


def print_knit(w, h):
    cv = Canvas(w, h)
    X, Y = cv.X, cv.Y
    cv.fill(cover(np.abs((X % 8) - 4) - 1.2), '#c3c5d2')
    cv.fill(cover(np.abs((Y % 6) - 3) - 0.6) * 0.35, '#d5d7e0')
    return cv.rgb


def print_camera(w, h):
    cv = Canvas(w, h, '#3b3d52')
    X, Y = cv.X, cv.Y
    cv.shape(sd_circle(X, Y, w / 2, h / 2, w * 0.36), '#c7cdd8', outline=INK, ow=1.5)
    cv.shape(sd_circle(X, Y, w / 2, h / 2, w * 0.26), '#2d2d3a')
    cv.shape(sd_circle(X, Y, w / 2, h / 2, w * 0.17), '#3d7bff')
    cv.fill(cover(sd_circle(X, Y, w / 2 - 4, h / 2 - 4, w * 0.07)), '#ffffff', alpha=0.85)
    return cv.rgb


CHARS_PRINT_ART = {
    'paisley': print_paisley, 'sack': print_sack, 'apron': print_apron, 'skull': print_skull,
    'stink': print_stink, 'pest': print_pest, 'tank': print_tank, 'tie': print_tie,
    'hatband': print_hatband, 'badge': print_badge, 'knit': print_knit, 'camera': print_camera,
}


def build_atlas_chars():
    W, H = T.CHARS_W, T.CHARS_H
    img = np.ones((H, W, 3))                        # free space stays white
    for e in range(8):
        for sp, fn in (('raccoon', raccoon_face), ('human', human_face)):
            x, y = T.face_cell_px(sp, e)
            img[y:y + T.FACE_CELL, x:x + T.FACE_CELL] = np.clip(fn(e), 0, 1)
    for k in range(4):
        img[T.SHIRT_Y:T.SHIRT_Y + T.FACE_CELL, k * T.FACE_CELL:(k + 1) * T.FACE_CELL] = np.clip(shirt_pattern(k), 0, 1)
    sx, sy = T.CHARS_SWATCH_XY
    for i, hx in enumerate(T.CHARS_PALETTE.values()):
        x, y = sx + (i % 8) * T.CHARS_SWATCH_PX, sy + (i // 8) * T.CHARS_SWATCH_PX
        img[y:y + T.CHARS_SWATCH_PX, x:x + T.CHARS_SWATCH_PX] = col(hx)
    g = T.CHARS_GUTTER
    for name, fn in CHARS_PRINT_ART.items():
        x, y, w, h = T.chars_print_px(name)
        art = np.asarray(fn(w, h), np.float64)
        if art.shape != (h, w, 3):
            raise RuntimeError("%s: art shape %s != %s" % (name, art.shape, (h, w, 3)))
        img[y:y + h, x:x + w] = np.clip(art, 0, 1)
        img[y - g:y, x:x + w] = img[y:y + 1, x:x + w]                     # edge-extend the gutter
        img[y + h:y + h + g, x:x + w] = img[y + h - 1:y + h, x:x + w]
        img[y - g:y + h + g, x - g:x] = img[y - g:y + h + g, x:x + 1]
        img[y - g:y + h + g, x + w:x + w + g] = img[y - g:y + h + g, x + w - 1:x + w]
    return to_u8(img)


# =============================================================================
# contact sheet
# =============================================================================
def label(img, text, x, y, h=13, color=(43, 35, 64)):
    m = T.text_mask(text, h, offset=0.02)
    mh, mw = m.shape
    H, W = img.shape[:2]
    x1, y1 = min(W, x + mw), min(H, y + mh)
    a = m[:y1 - y, :x1 - x, None]
    img[y:y1, x:x1] = img[y:y1, x:x1] * (1 - a) + np.array(color, np.float64) * a


def contact_sheet(tiling, atlas_u8, out_png):
    cols, cw, chh = 4, 256 + 10 + 192 + 18, 256 + 34
    rows = (len(tiling) + cols - 1) // cols
    W = cols * cw + 16
    Hs = rows * chh + 16
    H = Hs + 30 + atlas_u8.shape[0] + 16
    sheet = np.full((H, W, 3), 244.0)
    for i, (name, v) in enumerate(tiling.items()):
        r, c = divmod(i, cols)
        x0, y0 = 16 + c * cw, 16 + r * chh
        S = v.shape[0]
        # 1:1 window centred on a seam crossing (2x2 copies, shifted by half a tile)
        big = np.tile(v, (2, 2))
        win = big[S // 2:S // 2 + S, S // 2:S // 2 + S] if S >= 256 else np.tile(v, (3, 3))[S // 2:S // 2 + 256, S // 2:S // 2 + 256]
        g = win[:256, :256] * 255.0
        sheet[y0:y0 + 256, x0:x0 + 256] = g[..., None]
        # "game distance" view: tinted, ~50 px per metre
        tile_px = max(8, int(round(T.TEX[name].tile_m * 50)))
        reps = int(math.ceil(192 / tile_px)) + 1
        far = resize(np.tile(v, (reps, reps)), reps * tile_px, reps * tile_px)[:192, :192]
        tint = T.srgb01(TINT[name]).astype(np.float64)
        sheet[y0:y0 + 192, x0 + 266:x0 + 266 + 192] = far[..., None] * tint * 255.0
        lin, farm = T.linear_mean(to_u8(v))
        label(sheet, "%s %dpx %gm" % (name, S, T.TEX[name].tile_m), x0, y0 + 260, 13)
        label(sheet, "lin %.2f far %.2f" % (lin, farm), x0 + 266, y0 + 200, 11)
    label(sheet, "atlas_town 1024 (1:1)", 16, Hs + 6, 15)
    ax = (W - atlas_u8.shape[1]) // 2
    sheet[Hs + 30:Hs + 30 + atlas_u8.shape[0], ax:ax + atlas_u8.shape[1]] = atlas_u8
    T.write_png(out_png, np.round(np.clip(sheet, 0, 255)).astype(np.uint8))


# =============================================================================
def clean_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.curves):
        for d in list(coll):
            coll.remove(d)


# A tinted surface takes its colour from the material (or the city's vertex colours); the map
# only adds detail. Each map is lifted to the same average linear brightness, so the textured
# town is as bright as its old flat-coloured self (within a few %): darker maps made the roads
# ~10% darker on screen.
LIN_TARGET = 0.93


def brighten(v, target=LIN_TARGET):
    lin = np.power(np.clip(v, 0.0, 1.0), 2.2)
    if lin.mean() >= target:
        return v
    k = target / lin.mean()
    for _ in range(6):                      # clamping at white loses a little: settle on the target
        out = np.clip(lin * k, 0.0, 1.0)
        k *= target / out.mean()
    return np.power(out, 1 / 2.2)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = None
    if "--only" in argv and argv.index("--only") + 1 < len(argv):
        only = set(s.strip() for s in argv[argv.index("--only") + 1].split(",") if s.strip())
    no_preview = "--no-preview" in argv
    names = [n for n in T.TEX if only is None or n in only]
    if not names:
        print("[tex] --only %s names no texture; nothing to do" % ",".join(sorted(only)))
        return
    clean_scene()
    os.makedirs(T.TEX_DIR, exist_ok=True)
    t0 = time.time()
    tiling = {}
    atlas_u8 = None
    total = 0
    for name in names:
        info = T.TEX[name]
        t1 = time.time()
        if name == 'atlas_town':
            u8, A = build_atlas_town()
            atlas_u8 = u8
            os.makedirs(os.path.dirname(ATLAS_JSON), exist_ok=True)
            with open(ATLAS_JSON, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(A.to_json(T.TEX_URI + info.file, T.PALETTE, 'swatches'), f, indent=2)
                f.write('\n')
            print("[tex] wrote", ATLAS_JSON, "(%d cells)" % (len(A.cells) - 1))
            msg = "atlas_town RGB"
        elif name == 'atlas_chars':
            u8 = build_atlas_chars()
            msg = "atlas_chars RGB (faces, shirt patterns, accessory prints)"
        elif name == 'decals':
            u8 = build_decals()
            msg = "decals RGBA (ground markings and graffiti over transparency, posters)"
        else:
            v = brighten(TILING[name](info.size))
            assert v.shape == (info.size, info.size)
            u8 = to_u8(v)
            tiling[name] = v
            msg = report(name, v)
        data = T.write_png(os.path.join(T.TEX_DIR, info.file), u8)
        total += len(data)
        print("[tex] %-11s %4dx%-4d %6.1f KB  %s  (%.1fs)" % (name, u8.shape[1], u8.shape[0], len(data) / 1024.0,
                                                             msg, time.time() - t1))
    allfiles = [f for f in os.listdir(T.TEX_DIR) if f.endswith('.png')]
    tot_all = sum(os.path.getsize(os.path.join(T.TEX_DIR, f)) for f in allfiles)
    print("[tex] %d texture(s) in %.1fs; tex/ holds %d files, %.1f KB" % (len(names), time.time() - t0,
                                                                         len(allfiles), tot_all / 1024.0))
    if len(allfiles) > T.MAX_TEXTURES:
        raise RuntimeError("more than %d texture files in %s" % (T.MAX_TEXTURES, T.TEX_DIR))
    if not no_preview and only is None:
        contact_sheet(tiling, atlas_u8, os.path.join(PREVIEWS, "textures.png"))
        print("[tex] contact sheet ->", os.path.join(PREVIEWS, "textures.png"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
