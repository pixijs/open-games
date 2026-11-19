"""Build the Trash Panda Royale characters (raccoon.glb players, human.glb townsfolk), the
junk weapons, the pickups (loot_can, food_pizza, food_donut, coffee, tombstone, crown) and the street
props.

Faces / shirt patterns / accessory prints come from tex/atlas_chars.png (build_textures.py
--only atlas_chars; layout in common_tex: FACE_PROJ, CHARS_PRINTS, CHARS_PALETTE).
Rigs and accessory node names follow assets-src/contract.json; test poses for the previews
live in assets-src/poses.json.  Previews: raccoon_lineup / raccoon_back / human_lineup /
human_back / expressions / poses_* / weapons_held* / weapons_side / pickups / game_view* /
atlas_chars_layout, props_small / props_large / props_grid.

Run headless (from the project root):
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      --python assets-src/blender/build_characters_props.py
Optional args after `--`:
  --only name1,name2   build only these assets (still writes the meta file for them)
  --no-preview         skip verification re-import + preview renders

Outputs:
  public/assets/models/<asset>.glb
  public/assets/models/characters_props.meta.json
  assets-src/previews/*.png

Conventions: metres, Blender Z-up (exported +Y up), FRONT = Blender -Y (glTF +Z),
model's RIGHT = -X, LEFT = +X, origin = ground contact centre unless stated.
"""
import json
import math
import os
import sys
import traceback

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common_cp as C  # noqa: E402
from common_cp import MB, mat, tmat, empty, D2R, align_z  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
MODELS = os.path.join(ROOT, "public", "assets", "models")
PREVIEWS = os.path.join(ROOT, "assets-src", "previews")


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def wa(p):
    """wrap degrees to -180..180"""
    return ((p + 180.0) % 360.0) - 180.0


# =============================================================================
# WEAPONS  (origin = grip, barrel toward -Y, up +Z)
# =============================================================================
def _trigger(mb, dark, y0=0.0, uv=None):
    guard = [(0, y0 - 0.012, 0.04), (0, y0 - 0.014, 0.008), (0, y0 - 0.03, -0.01),
             (0, y0 - 0.055, -0.01), (0, y0 - 0.07, 0.008), (0, y0 - 0.072, 0.04)]
    mb.tube(guard, 0.0065, dark, sides=4, uv=uv)
    mb.capsule((0, y0 - 0.038, 0.012), (0, y0 - 0.033, 0.042), 0.0075, dark, segs=5, hemi=1, uv=uv)


# =============================================================================
# PROPS (origin = ground centre, front -Y)
# =============================================================================
def flower(mb, c, normal, r, petal_mat, center_mat, center_col=None, lobes=5, thick=0.022, uv_petal=None,
           uv_center=None):
    """Flat lobed flower head + dome centre, facing `normal`."""
    R = align_z(normal)
    pts_t, pts_b = [], []
    n = lobes * 2
    for k in range(n):
        a = 2 * math.pi * k / n
        rr = r * (1.0 if k % 2 == 0 else 0.7)
        pts_t.append((rr * math.cos(a), rr * math.sin(a), thick / 2))
        pts_b.append((rr * 0.92 * math.cos(a), rr * 0.92 * math.sin(a), -thick / 2))
    M = C.xform(c, R)
    mb.grid([[M @ Vector((0, 0, -thick / 2))], [M @ Vector(p) for p in pts_b],
             [M @ Vector(p) for p in pts_t], [M @ Vector((0, 0, thick / 2 + 0.004))]],
            petal_mat, recalc=True, uv=uv_petal)
    mb.sphere(Vector(c) + Vector(normal).normalized() * (thick * 0.6), (r * 0.36, r * 0.36, r * 0.24),
              center_mat, segs=5, rings=3, rot=R, uv=uv_center)


def build_tree_round():
    Trunk = mat("Trunk", "#A0694A", 0.75)
    Leaves = mat("Leaves", "#6CCB6A", 0.7)
    mb = MB()
    mb.lathe([(0, 0), (0.25, 0), (0.21, 0.07), (0.16, 0.28), (0.145, 1.2), (0.13, 2.3), (0, 2.4)],
             Trunk, segs=8)
    for c, r in (((0, 0.02, 2.85), (1.15, 1.12, 1.08)),
                 ((0.78, 0.18, 2.42), (0.78, 0.76, 0.72)),
                 ((-0.78, -0.08, 2.5), (0.8, 0.78, 0.74)),
                 ((0.05, -0.62, 2.4), (0.74, 0.7, 0.68)),
                 ((0.1, 0.05, 3.55), (0.62, 0.6, 0.58))):
        mb.sphere(c, r, Leaves, segs=12, rings=8)
    ob = mb.to_object("tree_round", (0, 0, 0))
    return ob


def build_tree_pine():
    Trunk = mat("Trunk", "#A0694A", 0.75)
    Pine = mat("PineLeaves", "#3FAF7A", 0.7)
    mb = MB()
    mb.lathe([(0, 0), (0.2, 0), (0.17, 0.08), (0.14, 0.4), (0.12, 1.0), (0, 1.05)], Trunk, segs=8)
    for zb, R, H in ((0.55, 1.3, 1.55), (1.4, 1.06, 1.45), (2.2, 0.82, 1.35), (2.95, 0.56, 1.55)):
        mb.lathe([(0, zb + 0.22), (R * 0.74, zb + 0.02), (R * 0.95, zb + 0.03), (R, zb + 0.13),
                  (R * 0.62, zb + H * 0.42), (R * 0.26, zb + H * 0.78), (0, zb + H)],
                 Pine, segs=12, phase=zb)
    return mb.to_object("tree_pine", (0, 0, 0))


def build_bush():
    Bush = mat("Bush", "#5FC46A", 0.7)
    Flower = mat("Flower", "#FF8FC0", 0.6)
    Center = mat("FlowerCenter", "#FFD84A", 0.6)
    mb = MB()
    blobs = (((0, 0, 0.44), (0.5, 0.47, 0.44)),
             ((0.34, 0.1, 0.32), (0.32, 0.32, 0.32)),
             ((-0.34, -0.04, 0.33), (0.33, 0.33, 0.33)),
             ((0.04, -0.3, 0.3), (0.3, 0.3, 0.3)),
             ((-0.08, 0.3, 0.34), (0.3, 0.3, 0.3)))
    for c, r in blobs:
        mb.sphere(c, r, Bush, segs=10, rings=7)
    for (bi, az, el) in ((0, -30, 40), (0, 60, 55), (0, 200, 45), (1, 20, 30), (2, -110, 35),
                         (3, -10, 25)):
        c, r = blobs[bi]
        d = Vector((math.sin(az * D2R) * math.cos(el * D2R), -math.cos(az * D2R) * math.cos(el * D2R),
                    math.sin(el * D2R)))
        p = Vector(c) + Vector((d.x * r[0], d.y * r[1], d.z * r[2])) * 0.985
        flower(mb, p, d, 0.07, Flower, Center)
    return mb.to_object("bush", (0, 0, 0))


def build_lamp():
    """A breakaway lamp post: a car knocks `lamp_post` off its stub (`lamp_base`); the game
    tips it over about its origin, the break."""
    Post = tmat("LampPost", "#4D6A8C", "metal", 0.55)
    Glow = mat("Glow", "#FFE9A8", 0.4, emit="#FFD27A", strength=4.0)
    root = empty("lamp", (0, 0, 0))
    brk = 0.28
    mb = MB()
    mb.lathe([(0, 0), (0.22, 0), (0.22, 0.08), (0.17, 0.14), (0.11, brk), (0, brk)], Post, segs=10)
    mb.to_object("lamp_base", (0, 0, 0), root)
    mb = MB()
    mb.lathe([(0, brk), (0.11, brk), (0.08, 0.45),
              (0.07, 1.0), (0.09, 1.03), (0.09, 1.1), (0.07, 1.13), (0.065, 3.6), (0, 3.62)],
             Post, segs=10)
    arm = [(0, 0, 3.45), (0, 0, 3.86), (0, -0.05, 4.01), (0, -0.18, 4.11), (0, -0.36, 4.14),
           (0, -0.54, 4.09), (0, -0.66, 3.98)]
    mb.tube(arm, 0.055, Post, sides=8)
    hc = Vector((0, -0.7, 0))
    mb.lathe([(0, 3.76), (0.24, 3.76), (0.29, 3.735), (0.29, 3.77), (0.25, 3.83), (0.16, 3.92),
              (0.07, 3.97), (0, 3.98)], Post, segs=12, c=hc)
    mb.sphere(hc + Vector((0, 0, 3.69)), (0.17, 0.17, 0.14), Glow, segs=10, rings=7)
    post = mb.to_object("lamp_post", (0, 0, brk), root)
    empty("lamp_light", hc + Vector((0, 0, 3.66)), post, size=0.1)
    return root


# the billboards' sizes: src/shared/town.ts BILLBOARD (contract.json pins the panel's middle)
BOARD_W, BOARD_H, BOARD_D = 8.3, 4.3, 0.4      # the frame
AD_W, AD_H = 8.0, 4.0                           # the picture on each side (2:1, the poster's shape)
BOARD_BASE = {"billboard": 5.45, "billboard_roof": 1.45}   # the frame's underside


def build_billboard(name):
    """A billboard: a frame with the poster on both sides (`Ad`: the game paints it, see
    src/client/gfx/Billboard.ts), three gooseneck lamps over the front. `billboard` stands on a
    pole with a catwalk under the front face, out of jump reach; `billboard_roof` on two legs
    and kickers, for a roof (room to walk under it)."""
    roof = name == "billboard_roof"
    Steel = tmat("BoardSteel", "#4D6A8C", "metal", 0.55)
    Frame = tmat("BoardFrame", "#3A3350", "metal", 0.6)
    Grate = tmat("BoardGrate", "#6E7F99", "metal", 0.6)
    Glow = mat("Glow", "#FFE9A8", 0.4, emit="#FFD27A", strength=4.0)
    Ad = mat("Ad", "#FFFFFF", 0.8)
    h0 = BOARD_BASE[name]
    h1 = h0 + BOARD_H
    yf, yb = -BOARD_D / 2, BOARD_D / 2          # front (-Y = glTF +Z) and back faces of the frame
    mb = MB()
    mb.box((0, 0, h0 + BOARD_H / 2), (BOARD_W, BOARD_D, BOARD_H), Frame, bevel=0.06, bseg=2)
    # the picture, a hair proud of the frame on both sides (UV 0..1 over it, read the right way
    # round from either side: the back's u runs the other way)
    az0 = h0 + (BOARD_H - AD_H) / 2
    for y, sgn in ((yf - 0.012, 1), (yb + 0.012, -1)):
        rows = [[(-sgn * AD_W / 2, y, az0), (sgn * AD_W / 2, y, az0)],
                [(-sgn * AD_W / 2, y, az0 + AD_H), (sgn * AD_W / 2, y, az0 + AD_H)]]
        mb.surface(rows, [Ad], centre=(0, 0, az0 + AD_H / 2), closed=False,
                   uv_fn=lambda i, co, r, u, j, s=sgn: ((s * co.x + AD_W / 2) / AD_W, (co.z - az0) / AD_H))
    # a ridge cap along the top
    mb.box((0, 0, h1 + 0.05), (BOARD_W + 0.1, BOARD_D + 0.16, 0.1), Steel, bevel=0.03, bseg=1)
    if roof:
        # two legs on foot plates, kickers back to the roof
        for x in (-2.6, 2.6):
            mb.box((x, 0, h0 / 2), (0.24, 0.24, h0 + 0.02), Steel, bevel=0.03, bseg=1)
            mb.box((x, 0, 0.03), (0.5, 0.5, 0.06), Steel, bevel=0.015, bseg=1)
            mb.tube([(x, yb + 0.05, h0 + BOARD_H * 0.55), (x, yb + 1.15, 0.05)], 0.06, Steel, sides=8)
            mb.box((x, yb + 1.15, 0.03), (0.34, 0.34, 0.06), Steel, bevel=0.015, bseg=1)
    else:
        # the pole, a cross-beam under the frame, struts out to its ends
        mb.lathe([(0, 0), (0.46, 0), (0.46, 0.1), (0.38, 0.18), (0.32, 0.34), (0.26, h0 - 0.4),
                  (0.3, h0 - 0.3), (0.3, h0 - 0.2), (0, h0 - 0.2)], Steel, segs=14)
        mb.box((0, 0, h0 - 0.12), (BOARD_W - 0.4, 0.3, 0.26), Steel, bevel=0.04, bseg=1)
        for x in (-2.7, 2.7):
            mb.tube([(0, 0, h0 - 1.9), (x, 0, h0 - 0.22)], 0.07, Steel, sides=8)
        # the catwalk under the front face: grating, brackets, a railing
        cy = yf - 0.45
        mb.box((0, cy, h0 - 0.03), (BOARD_W, 0.84, 0.06), Grate, bevel=0.015, bseg=1)
        for x in (-3.6, -1.2, 1.2, 3.6):
            mb.tube([(x, -0.12, h0 - 0.2), (x, cy - 0.3, h0 - 0.06)], 0.035, Steel, sides=6)
        ry = cy - 0.38
        posts = [-4.0, -2.0, 0.0, 2.0, 4.0]
        for x in posts:
            mb.tube([(x, ry, h0), (x, ry, h0 + 0.85)], 0.03, Steel, sides=6)
        mb.tube([(posts[0], ry, h0 + 0.85), (posts[-1], ry, h0 + 0.85)], 0.035, Steel, sides=6)
        mb.tube([(posts[0], ry, h0 + 0.45), (posts[-1], ry, h0 + 0.45)], 0.025, Steel, sides=6)
    # gooseneck lamps over the front, shining down onto the picture
    for x in (-2.8, 0.0, 2.8):
        mb.tube([(x, -0.05, h1 + 0.08), (x, -0.05, h1 + 0.42), (x, -0.32, h1 + 0.62), (x, -0.7, h1 + 0.62),
                 (x, -0.92, h1 + 0.5)], 0.04, Steel, sides=6)
        hc = Vector((x, -0.95, h1 + 0.44))
        # (the hood's dome turned away from the picture, its glow on the open side, toward it)
        mb.lathe([(0, 0.0), (0.2, 0.0), (0.23, 0.04), (0.16, 0.13), (0.06, 0.17), (0, 0.18)], Steel,
                 segs=10, c=hc, rot=align_z((0, -0.45, 1)))
        mb.sphere(hc + Vector((0, 0.03, -0.05)), (0.12, 0.12, 0.08), Glow, segs=8, rings=5)
    ob = mb.to_object(name, (0, 0, 0))
    empty("billboard_panel", (0, 0, h0 + BOARD_H / 2), ob, size=0.2)
    return ob


def build_hydrant():
    Red = tmat("HydrantRed", "#FF5C5C", "metal", 0.55)
    Cap = tmat("HydrantCap", "#FFF2DF", "metal", 0.5)
    mb = MB()
    mb.lathe([(0, 0, Cap), (0.18, 0, Cap), (0.18, 0.055, Cap), (0.15, 0.075, Red), (0.13, 0.1, Red),
              (0.125, 0.47, Cap), (0.155, 0.49, Cap), (0.155, 0.54, Red), (0.125, 0.56, Red),
              (0.11, 0.615, Red), (0.06, 0.655, Cap), (0.038, 0.66, Cap), (0.038, 0.7, Cap),
              (0, 0.7)], Red, segs=14)
    for s in (1, -1):
        mb.cylinder((s * 0.1, 0, 0.36), (s * 0.18, 0, 0.36), 0.045, Red, segs=10)
        mb.cylinder((s * 0.17, 0, 0.36), (s * 0.2, 0, 0.36), 0.055, Cap, segs=10, bevel=0.01)
    mb.cylinder((0, -0.1, 0.32), (0, -0.19, 0.32), 0.058, Red, segs=10)
    mb.cylinder((0, -0.18, 0.32), (0, -0.215, 0.32), 0.07, Cap, segs=10, bevel=0.012)
    return mb.to_object("hydrant", (0, 0, 0))


def build_bench():
    Wood = tmat("BenchWood", "#F2A877", "wood", 0.65)
    Frame = mat("BenchFrame", "#4E5D7A", 0.5)
    mb = MB()
    for y in (-0.165, -0.01, 0.145):
        mb.box((0, y, 0.4275), (1.8, 0.14, 0.045), Wood, bevel=0.018, bseg=2)
    mb.box((0, 0.262, 0.62), (1.8, 0.045, 0.14), Wood, bevel=0.018, bseg=2, rot=(-12, 0, 0))
    mb.box((0, 0.297, 0.8), (1.8, 0.045, 0.14), Wood, bevel=0.018, bseg=2, rot=(-12, 0, 0))
    for x in (-0.78, 0.78):
        mb.box((x, -0.18, 0.2), (0.065, 0.065, 0.4), Frame, bevel=0.015, bseg=1)
        mb.box((x, 0.27, 0.46), (0.065, 0.065, 0.9), Frame, bevel=0.015, bseg=1, rot=(-10, 0, 0))
        mb.box((x, 0.03, 0.385), (0.065, 0.5, 0.05), Frame, bevel=0.015, bseg=1)
        mb.box((x, 0.03, 0.665), (0.08, 0.46, 0.045), Frame, bevel=0.015, bseg=1)
        mb.box((x, -0.17, 0.545), (0.05, 0.05, 0.25), Frame, bevel=0.012, bseg=1)
        mb.box((x, -0.05, 0.03), (0.09, 0.5, 0.06), Frame, bevel=0.015, bseg=1)
    return mb.to_object("bench", (0, 0, 0))


def build_drum():
    """An oil drum (r 0.35, h 0.95: town.ts PROP_COLLIDERS.drum): two rolled hoops, the chime round
    its recessed lid, a bung, a rust drip down its front.  The game paints "DrumPaint" per drum."""
    Paint = tmat("DrumPaint", "#D9A62E", "metal", 0.5)
    Band = tmat("DrumBand", "#3A3A44", "metal", 0.5)
    Rust = mat("DrumRust", "#7A4A26", 0.8)
    mb = MB()
    mb.lathe([(0.0, 0.0, Band), (0.34, 0.0, Band), (0.35, 0.015, Paint),
              (0.35, 0.3, Band), (0.362, 0.31, Band), (0.362, 0.35, Band), (0.35, 0.36, Paint),
              (0.35, 0.61, Band), (0.362, 0.62, Band), (0.362, 0.66, Band), (0.35, 0.67, Paint),
              (0.35, 0.915, Band), (0.358, 0.93, Band), (0.358, 0.95, Band), (0.33, 0.95, Band),
              (0.32, 0.93, Paint), (0.0, 0.93)], Paint, segs=18)
    mb.cylinder((0.16, 0.08, 0.93), (0.16, 0.08, 0.955), 0.05, Band, segs=8)
    mb.box((0.0, -0.353, 0.75), (0.1, 0.012, 0.3), Rust)
    mb.box((0.025, -0.353, 0.53), (0.04, 0.012, 0.2), Rust)
    return mb.to_object("drum", (0, 0, 0))


def build_cone():
    Orange = mat("ConeOrange", "#FF8A2A", 0.55)
    White = mat("ConeStripe", "#FFFFFF", 0.5)
    mb = MB()
    mb.box((0, 0, 0.02), (0.42, 0.42, 0.04), Orange, bevel=0.015, bseg=2)

    def r(z):
        return 0.16 - (z - 0.04) * 0.22
    mb.lathe([(0.165, 0.035, Orange), (r(0.25), 0.25, White), (r(0.37), 0.37, Orange),
              (r(0.56), 0.56, Orange), (0.03, 0.592, Orange), (0.016, 0.6, Orange), (0, 0.602)],
             Orange, segs=14)
    return mb.to_object("cone", (0, 0, 0))


BIN_H = 1.0   # the rim (map.ts BIN_H); the collider is the square round r = 0.42 (BIN_R)


def build_trashcan():
    """A street trash can a raccoon can hide in: ribbed, a little tapered, two side handles,
    open at the top with trash 0.2 m down (seen once its lid has been knocked off).
    `lid` (pivot: the middle of the rim) lifts off. `peek` (pivot on the can's axis, just over
    the rim) is a hider's head under a lifted lid: dark mask, big eyes. The game hides it unless
    you're the one in the can, and turns it about Y: it looks along its glTF +Z."""
    Body = tmat("BinBody", "#79CBA6", "metal", 0.6)
    Trim = tmat("BinLid", "#4D9E80", "metal", 0.55)
    A = town_mat()
    H = BIN_H
    root = empty("trashcan", (0, 0, 0))
    mb = MB()
    # up the outside (three raised ribs, a rolled lip), over the rim, down the inside to the trash
    mb.lathe([(0.0, 0.0, Trim), (0.33, 0.0, Trim), (0.352, 0.025, Body), (0.354, 0.06, Body),
              (0.362, 0.2, Trim), (0.378, 0.215, Trim), (0.378, 0.245, Trim), (0.366, 0.26, Body),
              (0.38, 0.56, Trim), (0.396, 0.575, Trim), (0.396, 0.605, Trim), (0.384, 0.62, Body),
              (0.396, 0.955, Trim), (0.414, 0.968, Trim), (0.418, H, Trim), (0.392, H, Body),
              (0.374, H - 0.02, Body), (0.366, 0.8, A), (0.0, 0.8)],
             Body, segs=18, uv={"AtlasTown": town_uv('charcoal')})
    # side handles
    for s in (1, -1):
        mb.tube([(s * 0.372, -0.1, 0.7), (s * 0.425, -0.085, 0.73), (s * 0.446, 0.0, 0.738),
                 (s * 0.425, 0.085, 0.73), (s * 0.372, 0.1, 0.7)], 0.017, Trim, sides=6)
    # the trash: crumpled paper, a soda can, a banana peel, a fish bone
    for c, r in (((0.13, 0.1, 0.83), 0.07), ((-0.16, -0.06, 0.825), 0.06), ((0.02, 0.2, 0.82), 0.05)):
        mb.sphere(c, r, A, segs=6, rings=4, deform=lambda v: v * (1 + 0.18 * math.sin(9 * v.x + 7 * v.y + 5 * v.z)),
                  uv=town_uv('cloud'))
    mb.cylinder((-0.02, -0.2, 0.835), (0.11, -0.13, 0.835), 0.034, A, segs=8, uv=town_uv('red'))
    for a in (-35, 10, 55):
        d = Vector((math.sin(a * D2R), math.cos(a * D2R), 0.25)).normalized()
        mb.capsule(Vector((-0.12, 0.12, 0.83)), Vector((-0.12, 0.12, 0.83)) + d * 0.11, 0.022, A, segs=5, hemi=1,
                   uv=town_uv('lemon'))
    fb, fd = Vector((0.08, -0.02, 0.82)), Vector((1, 0.35, 0)).normalized()
    mb.cylinder(fb - fd * 0.1, fb + fd * 0.1, 0.008, A, segs=5, uv=town_uv('cloud'))
    side = fd.cross(Vector((0, 0, 1)))
    for k in range(3):
        c = fb + fd * (-0.05 + 0.045 * k)
        mb.cylinder(c - side * 0.045, c + side * 0.045, 0.006, A, segs=4, uv=town_uv('cloud'))
    mb.to_object("can_body", (0, 0, 0), root)

    # the lid: a skirt over the rim, a low dome, a handle
    lb = MB()
    lb.lathe([(0.0, H - 0.03), (0.428, H - 0.03), (0.434, H - 0.008), (0.428, H + 0.016), (0.37, H + 0.05),
              (0.22, H + 0.082), (0.0, H + 0.09)], Trim, segs=18)
    lb.tube([(-0.1, 0, H + 0.07), (-0.085, 0, H + 0.13), (0, 0, H + 0.15), (0.085, 0, H + 0.13), (0.1, 0, H + 0.07)],
            0.018, Trim, sides=6)
    lb.to_object("lid", (0, 0, H), root)

    # a hider peeking out (front = -Y): the top of a grey head, the dark mask, glowing eyes
    Eye = mat("PeekEye", "#ffffff", 0.4, emit="#ffffff", strength=0.35)
    pb = MB()
    pb.sphere((0, -0.05, H - 0.06), (0.24, 0.21, 0.13), A, segs=10, rings=5, uv=town_uv('grey'))
    pb.sphere((0, -0.165, H + 0.03), (0.2, 0.1, 0.055), A, segs=10, rings=4, uv=town_uv('charcoal'))
    for s in (1, -1):
        e = Vector((s * 0.08, -0.25, H + 0.04))
        pb.sphere(e, (0.055, 0.03, 0.048), Eye, segs=8, rings=5)
        pb.sphere(e + Vector((0, -0.027, -0.005)), (0.025, 0.01, 0.028), A, segs=6, rings=3, uv=town_uv('ink'))
    pb.to_object("peek", (0, 0, H + 0.04), root)
    return root


def build_crossing_sign():
    Post = mat("SignPost", "#E9E9F0", 0.5)
    Conc = mat("Concrete", "#CFC8BC", 0.8)
    Red = mat("SignRed", "#F2434F", 0.5)
    White = mat("SignWhite", "#FFFFFF", 0.5)
    Black = mat("SignBlack", "#2F2F3A", 0.5)
    LightL = mat("LightL", "#FF3B3B", 0.35, emit="#FF2A2A", strength=3.0)
    LightR = mat("LightR", "#FF3B3B", 0.35, emit="#FF2A2A", strength=3.0)
    mb = MB()
    mb.box((0, 0, 0.06), (0.38, 0.38, 0.12), Conc, bevel=0.025, bseg=2)
    mb.lathe([(0, 0.1), (0.06, 0.1), (0.055, 2.7), (0.04, 2.74), (0, 2.75)], Post, segs=10)
    cz = 2.5
    for ang in (45, -45):
        mb.box((0, -0.075, cz), (1.2, 0.03, 0.22), Red, bevel=0.012, bseg=1, rot=(0, ang, 0))
        mb.box((0, -0.075, cz), (1.13, 0.036, 0.15), White, bevel=0.006, bseg=1, rot=(0, ang, 0))
    mb.cylinder((0, -0.06, cz), (0, -0.105, cz), 0.03, Black, segs=8, bevel=0.008)
    # light backboard + visors
    lz = 1.9
    mb.box((0, 0, lz), (0.95, 0.05, 0.34), Black, bevel=0.03, bseg=2)
    for x in (0.3, -0.3):
        for yy in (-1, 1):
            mb.box((x, yy * 0.075, lz + 0.125), (0.25, 0.11, 0.022), Black, bevel=0.008, bseg=1,
                   rot=(yy * -18, 0, 0))
    ob = mb.to_object("crossing_sign", (0, 0, 0))
    for name, x, m in (("light_l", 0.3, LightL), ("light_r", -0.3, LightR)):
        lb = MB()
        lb.lathe([(0, -0.05), (0.08, -0.05), (0.1, -0.035), (0.1, 0.035), (0.08, 0.05), (0, 0.05)],
                 m, segs=12, c=(x, 0, lz), rot=align_z((0, 1, 0)))
        lb.to_object(name, (x, 0, lz), ob)
    return ob


def build_crossing_barrier():
    Post = mat("BarrierPost", "#FFD447", 0.55)
    Dark = mat("BarrierDark", "#3E4256", 0.5)
    Red = mat("BarrierRed", "#FF4B5C", 0.5)
    White = mat("BarrierWhite", "#FFFFFF", 0.5)
    root = empty("crossing_barrier", (0, 0, 0))
    mb = MB()
    mb.box((0, 0, 0.05), (0.46, 0.46, 0.1), Dark, bevel=0.03, bseg=2)
    mb.box((0, 0, 0.55), (0.28, 0.28, 0.92), Post, bevel=0.05, bseg=2)
    mb.box((0, 0, 0.99), (0.34, 0.34, 0.07), Dark, bevel=0.025, bseg=2)
    for yy in (-1, 1):
        mb.box((0, yy * 0.165, 1.09), (0.18, 0.03, 0.2), Dark, bevel=0.012, bseg=1)
    mb.to_object("barrier_base", (0, 0, 0), root)
    hinge = Vector((0, 0, 1.1))
    mb = MB()
    mb.cylinder(hinge + Vector((0, -0.145, 0)), hinge + Vector((0, 0.145, 0)), 0.085, Dark, segs=12,
                bevel=0.015)
    n = 10
    seg = 5.0 / n
    for i in range(n):
        x0 = 0.04 + i * seg if i == 0 else i * seg
        x1 = (i + 1) * seg
        mb.box(hinge + Vector(((x0 + x1) / 2, 0, 0)), (x1 - x0, 0.07, 0.12),
               Red if i % 2 == 0 else White, bevel=0.012, bseg=1)
    mb.to_object("barrier_arm", hinge, root)
    return root


def build_fountain():
    Stone = mat("FountainStone", "#EBDDC8", 0.7)
    Trim = mat("FountainTrim", "#A9C4E8", 0.6)
    Water = mat("Water", "#7FD6FF", 0.15, emit="#5CC8FF", strength=0.25)
    mb = MB()
    mb.lathe([(2.42, 0.0, Stone), (2.5, 0.08, Stone), (2.5, 0.42, Trim), (2.48, 0.5, Trim),
              (2.4, 0.55, Trim), (2.3, 0.55, Trim), (2.22, 0.5, Trim), (2.2, 0.42, Stone),
              (2.2, 0.3, Stone), (0, 0.3)], Stone, segs=20)
    mb.lathe([(0, 0.36), (2.215, 0.36), (2.215, 0.4), (0, 0.4)], Water, segs=20)
    mb.lathe([(0, 0.3), (0.42, 0.3), (0.4, 0.42), (0.28, 0.52), (0.22, 0.72), (0.22, 0.92),
              (0.5, 0.98, Trim), (0.82, 1.1, Trim), (0.86, 1.18, Trim), (0.8, 1.22, Stone),
              (0.72, 1.17, Stone), (0.16, 1.14), (0.12, 1.3), (0.12, 1.5), (0.3, 1.55, Trim),
              (0.46, 1.64, Trim), (0.47, 1.7, Trim), (0.42, 1.72, Stone), (0.36, 1.68, Stone),
              (0.1, 1.66), (0.075, 1.76), (0.11, 1.84), (0.075, 1.93), (0, 1.95)],
             Stone, segs=12)
    mb.lathe([(0, 1.13), (0.745, 1.13), (0.745, 1.165), (0, 1.165)], Water, segs=12)
    mb.lathe([(0, 1.65), (0.38, 1.65), (0.38, 1.675), (0, 1.675)], Water, segs=12)
    mb.sphere((0, 0, 1.97), (0.09, 0.09, 0.07), Water, segs=8, rings=5)
    return mb.to_object("fountain", (0, 0, 0))


def build_flowerbed():
    Planter = tmat("Planter", "#F0A47C", "wood", 0.7)
    Soil = mat("Soil", "#6E4B3A", 0.9)
    Leaves = mat("FlowerLeaves", "#6BC46B", 0.7)
    cols = [mat("FlowerPink", "#FF8FC0", 0.6), mat("FlowerYellow", "#FFE066", 0.6),
            mat("FlowerPurple", "#B795FF", 0.6), mat("FlowerWhite", "#FFFFFF", 0.6)]
    Center = mat("FlowerCenter", "#FFC23A", 0.6)
    Center2 = mat("FlowerCenterW", "#FF9F45", 0.6)
    mb = MB()
    mb.box((0, 0, 0.2), (3.0, 1.0, 0.4), Planter, bevel=0.06, bseg=2)
    mb.box((0, 0, 0.405), (2.84, 0.84, 0.02), Soil)
    for x in (-0.95, 0.0, 0.95):
        mb.sphere((x, 0, 0.42), (0.55, 0.36, 0.17), Leaves, segs=10, rings=6)
    k = 0
    for x in (-0.95, 0.0, 0.95):
        for (dx, dy, dz) in ((-0.28, -0.12, 0.0), (0.05, 0.13, 0.03), (0.3, -0.1, -0.01)):
            c = (x + dx, dy, 0.6 + dz)
            nrm = Vector((dx * 0.6, dy * 1.2 - 0.25, 1.0))
            fm = cols[k % 4]
            flower(mb, c, nrm, 0.12, fm, Center2 if fm.name == "FlowerYellow" else Center)
            k += 1
    return mb.to_object("flowerbed", (0, 0, 0))


def build_fx_star():
    Star = mat("Star", "#FFD84D", 0.4, emit="#FFC83A", strength=0.6)
    mb = MB()
    mb.puffy_star((0, 0, 0), 0.125, 0.058, 0.05, Star)
    return mb.to_object("fx_star", (0, 0, 0))


# =============================================================================
# TRASH PANDA ROYALE CHARACTERS: chibi raccoon (players) + chibi people (townsfolk)
#
# Rigs follow assets-src/contract.json: every joint is a node with identity rest rotation
# whose origin is the pivot; meshes hang off their joint so rotating it moves them
# naturally.  Left/right parts that are symmetric about their own pivot share one mesh
# (one instanced draw).  Faces: the head mesh's own polygons inside a designed outline use
# the `Face` material, UV-projected from the front into the species' neutral atlas_chars
# cell (T.FACE_PROJ); the game swaps expressions by shifting those UVs by whole cells.
# =============================================================================
import common_tex as T  # noqa: E402


def frame_x(ax, up=(0, 0, 1)):
    """3x3 rotation whose local +X is `ax` (local Z as close to `up` as possible)."""
    x = Vector(ax).normalized()
    z = Vector(up)
    z = (z - x * z.dot(x)).normalized()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed()


def surface_y(sdf, x, z, y0=0.0, y1=-1.0):
    """y where the SDF crosses zero along the line (x, y0 -> y1, z) (front surface)."""
    lo, hi = y0, y1
    for _ in range(40):
        mid = (lo + hi) / 2
        if sdf(Vector((x, mid, z))) < 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def axis_lathe(mb, p0, p1, prof, segs=10, phase=0.0):
    """Lathe along the axis p0 -> p1.  prof: [(s, r, mat)] with s = distance along the
    axis from p0 (the material applies from that point on)."""
    p0, p1 = Vector(p0), Vector(p1)
    mb.lathe([(r, s, m) for (s, r, m) in prof], prof[0][2], segs=segs, c=p0, rot=align_z(p1 - p0),
             phase=phase)


def share(src, name, pivot, parent):
    """A second node using `src`'s mesh (the left/right twin of a symmetric part)."""
    ob = bpy.data.objects.new(name, src.data)
    bpy.context.scene.collection.objects.link(ob)
    if ob.name != name:
        raise RuntimeError("object name clash %s" % ob.name)
    C.place(ob, Vector(pivot), parent)
    return ob


def const_uv(name):
    """uv mode: constant at an atlas_chars swatch."""
    return ('const',) + tuple(T.chars_swatch_uv(name))


def print_uv(name, mode='planar', *args):
    """uv mode remapped into an atlas_chars print's content rect."""
    return (mode,) + tuple(args) + ({'rect': T.chars_print_rect(name)},)


# ---- raccoon ------------------------------------------------------------------
R_HIPS = (0.0, 0.0, 0.36)
R_NECK = (0.0, 0.0, 0.74)
R_EAR = (0.19, 0.02, 1.22)
R_ARM = (0.21, 0.0, 0.66)
R_ELBOW = (0.22, 0.0, 0.51)
R_HAND = (0.22, -0.03, 0.34)
R_LEGS = (0.0, 0.0, 0.34)
R_LEG = (0.11, 0.0, 0.34)
R_FOOT = (0.11, -0.01, 0.08)
R_TAIL = [(0.0, 0.17, 0.40), (0.0, 0.36, 0.47), (0.0, 0.52, 0.58)]
R_HC = Vector((0.0, 0.0, 1.01))           # head centre
HIPS_FRONT_INSET = 0.012                  # m, at the front of the hips (QA: belly / hips layers)


def raccoon_head_sdf(p):
    q = Vector(p) - R_HC
    d = C.sd_ellipsoid(q, (0, 0, 0), (0.30, 0.255, 0.27))
    d = C.smin(d, C.sd_ellipsoid(q, (0, -0.16, -0.085), (0.125, 0.105, 0.08)), 0.07)       # muzzle
    for s in (1, -1):                                                                       # cheek ruffs
        R = frame_x((s * 0.92, -0.2, -0.36))
        d = C.smin(d, C.sd_ellipsoid(q, (s * 0.25, -0.06, -0.095), (0.13, 0.06, 0.05), R), 0.05)
    return d


# face plate outline (degrees from the front axis by azimuth): white brows with the grey
# forehead stripe coming down between them (the notch at 90), the mask out to the sides,
# pointed cheek ruffs at -22 / 202, the muzzle and chin below.
_R_FACE_KEYS = [(-90, 64), (-60, 70), (-40, 79), (-22, 88), (-8, 84), (12, 77), (30, 62), (45, 52),
                (60, 48), (74, 44), (82, 30), (90, 13)]
R_FACE_OUTLINE = C.periodic_spline(sorted(
    [(-90, 64)] + [k for k in _R_FACE_KEYS if k[0] > -90] + [(180 - a, b) for a, b in _R_FACE_KEYS if -90 < a < 90]))
R_FACE_THETAS = [-90, -72, -55, -40, -30, -22, -14, -4, 8, 22, 36, 50, 62, 72, 80, 86, 90, 94, 100, 108, 118,
                 130, 144, 158, 172, 184, 194, 202, 210, 220, 235, 252]


def raccoon_head_shape():
    return C.PolarShape(R_HC, raccoon_head_sdf, outline=R_FACE_OUTLINE, smax_=0.6)


def face_uv_fn(species, centre, bands):
    """uv_fn for MB.surface: planar front projection for bands < `bands`, else (0, 0)."""
    def fn(i, co, r=0, u=0.0, j=0):
        if i < bands:
            return T.face_uv(species, co.x - centre.x, co.z - centre.z)
        return (0.0, 0.0)
    return fn


def check_face_uvs(name, species, rows, centre):
    """Every face-patch vertex must project inside its cell's safe inner area."""
    bx, by = T.FACE_BLOCK[species]
    xs, ys = [], []
    for row in rows:
        for p in row:
            px, py = T.face_px(species, p.x - centre.x, p.z - centre.z)
            xs.append(px - bx)
            ys.append(py - by)
    lo, hi = T.FACE_MARGIN, T.FACE_CELL - T.FACE_MARGIN
    print("  %s face patch px: x %.1f..%.1f  y %.1f..%.1f (inner %d..%d)" % (name, min(xs), max(xs), min(ys), max(ys), lo, hi))
    if min(xs) < lo or max(xs) > hi or min(ys) < lo or max(ys) > hi:
        raise RuntimeError("%s: face patch leaves the cell's inner area" % name)


def raccoon_torso_sdf(p):
    d = C.sd_ellipsoid(p, (0, 0.01, 0.43), (0.172, 0.172, 0.172))
    d = C.smin(d, C.sd_ellipsoid(p, (0, 0.015, 0.62), (0.142, 0.128, 0.15)), 0.08)
    d = C.smin(d, C.sd_ellipsoid(p, (0, -0.04, 0.44), (0.142, 0.145, 0.15)), 0.05)     # round belly
    for s in (1, -1):                                                                   # shoulders
        d = C.smin(d, C.sd_ellipsoid(p, (s * 0.165, 0.005, 0.635), (0.075, 0.07, 0.075)), 0.05)
    return d


def cushion_rows(centre, W, H, rings, thetas, taper=0.0):
    """Rows of a flat 'cushion' (an ear, a patch): each ring is (f, y) = a scaled copy of
    the outline oval (half width W, half height H in the XZ plane, narrower toward the top
    by `taper`) at depth y (Blender Y; front = -Y).  f = 0 gives a pole."""
    c = Vector(centre)
    out = []
    for f, y in rings:
        if f <= 0.0:
            out.append([c + Vector((0, y, 0))])
            continue
        row = []
        for th in thetas:
            a = th * D2R
            sz = math.sin(a)
            x = W * math.cos(a) * (1.0 - taper * max(0.0, sz) ** 1.5)
            row.append(c + Vector((f * x, y, f * H * sz)))
        out.append(row)
    return out


def raccoon_materials():
    return dict(
        Fur=mat("Fur", "#9a96a3", 0.85),
        FurDark=mat("FurDark", "#5c5770", 0.85),
        Belly=mat("Belly", "#f3ead8", 0.85),
        Face=tmat("Face", "#f3ead8", "atlas_chars", rough=0.85),
        Acc=tmat("Acc", "#ff5d8f", "atlas_chars", rough=0.6),
        AccTrim=tmat("AccTrim", "#ffffff", "atlas_chars", rough=0.6),
        Gold=mat("Gold", "#ffc94d", 0.3, metallic=0.35),
        Ink=mat("Ink", "#2b2340", 0.35),
    )


def build_raccoon():
    M = raccoon_materials()
    Fur, FurDark, Belly, Face, Ink = M['Fur'], M['FurDark'], M['Belly'], M['Face'], M['Ink']
    root = empty("raccoon", (0, 0, 0))

    # ---- hips (seat of the pear; the tail hangs off it) --------------------------
    mb = MB()
    # the front is pulled in (HIPS_FRONT_INSET at the front pole) so the hips' surface stays
    # clear of the torso's lower belly instead of running through it at a grazing angle
    mb.sphere((0, 0.02, 0.35), (0.172, 0.158, 0.118), Fur, segs=10, rings=5,
              deform=lambda v: (v.x, v.y * (1.0 - HIPS_FRONT_INSET / 0.158 * max(0.0, -v.y)), v.z))
    hips = mb.to_object("hips", R_HIPS, root)

    # ---- torso: pear with a cream belly patch (its own polygons) -------------------
    sh = C.PolarShape((0, 0, 0.48), raccoon_torso_sdf, front=(0, -1, -0.25),
                      outline=C.periodic_spline([(0, 44), (90, 40), (180, 44), (270, 50)]), smax_=0.6)
    th = [20.0 * k for k in range(18)]
    ts = [0, 0.36, 0.7, 1.0, 1.2, 1.45, 1.7, 1.88, 2.0]
    mb = MB()
    mb.surface(sh.rows(th, ts), [Belly] * 3 + [Fur] * 5, centre=sh.c)
    torso = mb.to_object("torso", R_HIPS, hips)

    # ---- head: face plate (Face, atlas UVs) + fur, Ink nose ---------------------------
    hs = raccoon_head_shape()
    ts_face = [0, 0.22, 0.45, 0.66, 0.84, 1.0]
    ts_back = [1.1, 1.26, 1.48, 1.74, 2.0]
    rows = hs.rows(R_FACE_THETAS, ts_face + ts_back)
    check_face_uvs("raccoon", 'raccoon', rows[:len(ts_face)], R_HC)
    mb = MB()
    nb = len(ts_face) - 1
    mb.surface(rows, [Face] * nb + [Fur] * len(ts_back), uv_fn=face_uv_fn('raccoon', R_HC, nb), centre=hs.c)
    nz = R_HC.z - 0.045
    ny = surface_y(raccoon_head_sdf, 0.0, nz)
    mb.sphere((0, ny + 0.004, nz), (0.044, 0.03, 0.031), Ink, segs=10, rings=6)
    head = mb.to_object("head", R_NECK, torso)

    # ---- ears (one mesh, two nodes): cream inner ear in a dished front, dark back ----
    eth = [30.0 * k for k in range(12)]
    ec = Vector(R_EAR) + Vector((0, 0.0, 0.122))
    erows = cushion_rows(ec, 0.096, 0.128, [(0.0, 0.004), (0.42, 0.0), (0.74, -0.012), (0.92, -0.024),
                                            (1.0, -0.006), (0.86, 0.03), (0.45, 0.042), (0.0, 0.044)], eth, taper=0.42)
    mb = MB()
    mb.surface(erows, [Belly, Belly, Fur, Fur, FurDark, FurDark, FurDark], centre=ec + Vector((0, 0.022, 0)))
    ear_l = mb.to_object("ear_l", R_EAR, head)
    share(ear_l, "ear_r", (-R_EAR[0], R_EAR[1], R_EAR[2]), head)

    # ---- arms: furry upper arm, dark "glove" forearm + paw ------------------------
    sx = R_ARM[0]
    mb = MB()
    mb.capsule((sx, 0, R_ELBOW[2]), R_ARM, 0.054, Fur, r1=0.06, segs=8, hemi=2)
    arm_l = mb.to_object("arm_l", R_ARM, torso)
    arm_r = share(arm_l, "arm_r", (-R_ARM[0], R_ARM[1], R_ARM[2]), torso)
    ex = R_ELBOW[0]
    mb = MB()
    mb.capsule((ex, -0.018, 0.385), (ex, 0, R_ELBOW[2]), 0.049, FurDark, r1=0.046, segs=8, hemi=2)
    mb.superellipsoid((ex, -0.03, 0.335), (0.062, 0.058, 0.06), FurDark, segs=8, rings=6, e_lat=0.85)
    fore_l = mb.to_object("forearm_l", R_ELBOW, arm_l)
    fore_r = share(fore_l, "forearm_r", (-R_ELBOW[0], R_ELBOW[1], R_ELBOW[2]), arm_r)
    empty("hand_l_socket", R_HAND, fore_l, size=0.05)
    empty("hand_r_socket", (-R_HAND[0], R_HAND[1], R_HAND[2]), fore_r, size=0.05)

    # ---- legs -------------------------------------------------------------------------
    legs = empty("legs", R_LEGS, root)
    lx = R_LEG[0]
    mb = MB()
    mb.capsule((lx, -0.01, 0.1), R_LEG, 0.06, FurDark, r1=0.08, segs=8, hemi=2, bands=[(0.48, Fur, 0.004)])
    leg_l = mb.to_object("leg_l", R_LEG, legs)
    leg_r = share(leg_l, "leg_r", (-R_LEG[0], R_LEG[1], R_LEG[2]), legs)
    mb = MB()
    mb.superellipsoid((lx, -0.055, 0.0297), (0.07, 0.112, 0.054), FurDark, segs=10, rings=5, e_lat=0.8,
                      extra=lambda q: (q.x, q.y, q.z if q.z > 0 else q.z * 0.55))
    for dx in (-0.034, 0.0, 0.034):
        mb.sphere((lx + dx, -0.148, 0.022), (0.024, 0.026, 0.022), FurDark, segs=6, rings=3)
    foot_l = mb.to_object("foot_l", R_FOOT, leg_l)
    share(foot_l, "foot_r", (-R_FOOT[0], R_FOOT[1], R_FOOT[2]), leg_r)

    # ---- tail: three bushy segments, ringed --------------------------------------------
    P0, P1, P2 = [Vector(p) for p in R_TAIL]
    tip_dir = Vector((0, math.cos(15 * D2R), math.sin(15 * D2R)))
    profs = [
        [(-0.04, 0.0, Fur), (-0.032, 0.04, Fur), (-0.01, 0.06, Fur), (0.06, 0.082, FurDark), (0.13, 0.098, Fur),
         (0.2, 0.104, Fur), (0.245, 0.08, Fur), (0.27, 0.0, Fur)],
        [(-0.06, 0.0, Fur), (-0.048, 0.06, Fur), (-0.02, 0.1, Fur), (0.045, 0.118, FurDark), (0.115, 0.126, Fur),
         (0.19, 0.124, Fur), (0.24, 0.092, Fur), (0.265, 0.0, Fur)],
        [(-0.06, 0.0, Fur), (-0.048, 0.07, Fur), (-0.02, 0.112, Fur), (0.03, 0.132, FurDark), (0.1, 0.122, Fur),
         (0.155, 0.104, FurDark), (0.215, 0.076, FurDark), (0.255, 0.04, FurDark), (0.272, 0.0, FurDark)],
    ]
    ends = [P1, P2, P2 + tip_dir]
    starts = [P0, P1, P2]
    parent = hips
    for k in range(3):
        mb = MB()
        axis_lathe(mb, starts[k], ends[k], profs[k], segs=9, phase=0.1)
        parent = mb.to_object("tail_%d" % k, starts[k], parent)

    build_raccoon_accessories(M, dict(head=head, torso=torso, hs=hs, sh=sh))
    return root


# ---- accessory helpers ------------------------------------------------------------
UP = Vector((0, 0, 1))
# the loot sack's offset from its first design (Blender axes): 5 cm to the model's right
# (-X), 7 cm down (QA: gallop / taunt head clearance) and 2.5 mm back so it rests on the
# back as before without sinking in.  The acc_sack node itself stays at the torso pivot.
SACK_OFFSET = Vector((-0.05, 0.0025, -0.07))


def head_dir(phi, e):
    """phi: azimuth from the FRONT (-Y), counter-clockwise seen from above (90 = +X, the
    model's left); e: elevation; degrees."""
    p, ee = phi * D2R, e * D2R
    return Vector((math.sin(p) * math.cos(ee), -math.cos(p) * math.cos(ee), math.sin(ee)))


def shell_rows(shape, phis, specs, top_add):
    """Rows hugging a PolarShape (a hat / hair shell): specs = [fn(phi) -> (elevation,
    offset)], from the rim up, plus a pole at the top."""
    rows = [[shape.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in phis] for sp in specs]
    rows.append([shape.point(UP, top_add)])
    return rows


def uvf_const(name):
    uv = tuple(T.chars_swatch_uv(name))
    return lambda i, co, r, u, j: uv


def uvf_cyl(rect, nrows):
    """u around the rings, v along the rows, into an atlas rect (Blender UV)."""
    u0, v0, u1, v1 = rect
    return lambda i, co, r, u, j: (u0 + (u1 - u0) * u, v0 + (v1 - v0) * r / max(nrows - 1, 1))


def uvf_planar(rect, origin, ax_u, ax_v, w, h):
    o, au, av = Vector(origin), Vector(ax_u).normalized(), Vector(ax_v).normalized()
    u0, v0, u1, v1 = rect

    def fn(i, co, r, u, j):
        a = max(0.0, min(1.0, (co - o).dot(au) / w))
        b = max(0.0, min(1.0, (co - o).dot(av) / h))
        return (u0 + (u1 - u0) * a, v0 + (v1 - v0) * b)
    return fn


def visor(mb, m, root_pt, out_dir, W, L, uvmode, droop=0.07, pitch=6.0, thick=0.008):
    """Curved cap bill: an elliptical slab centred on `root_pt` (half inside the head),
    pointing along the horizontal `out_dir`; the sides and the tip droop."""
    out = Vector(out_dir).normalized()
    side = out.cross(Vector((0, 0, 1))).normalized()
    R = Matrix((side, out, Vector((0, 0, 1)))).transposed() @ Matrix.Rotation(pitch * D2R, 3, 'X')
    rows = [[(0, 0, -thick)]]
    for f, hgt in ((0.6, -thick), (1.0, -thick * 0.2), (1.0, thick * 0.6), (0.6, thick * 1.4)):
        ring = []
        for k in range(12):
            a = 2 * math.pi * k / 12
            x, y = f * W * math.cos(a), f * L * math.sin(a)
            ring.append((x, y, hgt - droop * (x / W) ** 2 - 0.02 * max(0.0, y / L) ** 2))
        rows.append(ring)
    rows.append([(0, 0, thick * 1.5)])
    mb.grid(rows, m, recalc=True, M=Matrix.Translation(Vector(root_pt)) @ R.to_4x4(), uv=uvmode)


def crown_geom(mb, gold, gem, base, r=0.09, h=0.055, spike=0.06, points=5, segs=15, gem_r=0.016,
               gem_names=('red', 'sky', 'leaf', 'red', 'purple'), wall=0.012):
    """Zig-zag gold crown band (closed, with thickness and a rolled lower rim) + a gem on
    every point + a big front gem."""
    base = Vector(base)
    rows = [[], [], [], [], []]
    for k in range(segs):
        a = 2 * math.pi * k / segs
        ph = (a * points / (2 * math.pi)) % 1.0
        tri = 1.0 - abs(ph - 0.5) * 2.0          # 0 at the notches, 1 at the points
        flare = 1.0 + 0.1 * tri
        top = h + spike * tri
        dv = Vector((math.sin(a), -math.cos(a), 0))
        up = Vector((0, 0, 1))
        rows[0].append(base + dv * (r - wall * 0.5) + up * 0.0)
        rows[1].append(base + dv * (r + wall * 0.7) + up * (h * 0.22))
        rows[2].append(base + dv * (r * flare) + up * top)
        rows[3].append(base + dv * (r * flare - wall) + up * (top - 0.004))
        rows[4].append(base + dv * (r - wall) + up * (h * 0.22))
    mb.grid(rows, gold, wrap=True, wrap_rows=True, recalc=True)
    for k in range(points):
        a = 2 * math.pi * (k + 0.5) / points
        dv = Vector((math.sin(a), -math.cos(a), 0))
        c = base + dv * (r * 1.1) + Vector((0, 0, h + spike + 0.004))
        mb.sphere(c, gem_r, gem, segs=6, rings=3, uv=const_uv(gem_names[k % len(gem_names)]))
    front = base + Vector((0, -1, 0)) * (r + 0.006) + Vector((0, 0, h * 0.55))
    mb.sphere(front, (gem_r * 1.4, gem_r * 0.8, gem_r * 1.6), gem, segs=6, rings=3, uv=const_uv('red'))


def build_raccoon_accessories(M, J):
    Acc, AccTrim, Gold = M['Acc'], M['AccTrim'], M['Gold']
    head, torso, hs, sh = J['head'], J['torso'], J['hs'], J['sh']
    white = uvf_const('white')
    phis = [360.0 * k / 16 for k in range(16)]

    # ---- bandana: neckerchief with a paisley flap on the chest, knot at the back ----
    mb = MB()
    paisley = T.chars_print_rect('paisley')
    ring = []
    for k in range(12):
        a = 2 * math.pi * k / 12
        ring.append(Vector((0.148 * math.sin(a), -0.138 * math.cos(a) + 0.01, 0.712 + 0.012 * math.cos(a))))
    mb.tube(ring, 0.03, Acc, sides=5, closed=True, uv=('cyl', {'rect': paisley}))
    flap = []
    for z, hw, n in ((0.722, 0.15, 5), (0.655, 0.11, 5), (0.585, 0.06, 5), (0.525, 0.0, 1)):
        row = []
        for k in range(n):
            x = -hw + 2 * hw * k / max(n - 1, 1) if n > 1 else 0.0
            y = surface_y(raccoon_torso_sdf, x, z, y0=0.0) - 0.014 - 0.012 * (1 - abs(x) / 0.16)
            row.append(Vector((x, y, z)))
        flap.append(row)
    mb.surface(flap, [Acc] * 3, uv_fn=uvf_planar(paisley, (-0.16, 0, 0.5), (1, 0, 0), (0, 0, 1), 0.32, 0.24),
               centre=(0, 0.05, 0.6), closed=False)
    knot = Vector((0.0, 0.158, 0.716))
    mb.sphere(knot, (0.04, 0.032, 0.034), Acc, segs=8, rings=5, uv=const_uv('white'))
    for s_ in (1, -1):
        mb.sphere(knot + Vector((s_ * 0.05, 0.03, -0.045)), (0.03, 0.014, 0.06), Acc, segs=6, rings=4,
                  rot=(0, s_ * 30, 0), uv=const_uv('white'))
    mb.to_object("acc_bandana", R_HIPS, torso)

    # ---- beanie: knit, folded cuff, pompom; the ears come through ----------------------
    def e_cuff(p):
        return 33 + 9 * math.cos(p * D2R)

    def e_up(p, t):
        e0 = e_cuff(p) + 11.5
        return e0 + (90 - e0) * t
    specs = [lambda p: (e_cuff(p) - 3, -0.014), lambda p: (e_cuff(p), 0.042), lambda p: (e_cuff(p) + 10, 0.046),
             lambda p: (e_cuff(p) + 11.5, 0.03), lambda p: (e_up(p, 0.42), 0.058), lambda p: (e_up(p, 0.76), 0.088)]
    rows = shell_rows(hs, phis, specs, 0.1)
    mb = MB()
    mb.surface(rows, [Acc] * 6, uv_fn=uvf_cyl(T.chars_print_rect('knit'), len(rows)), centre=hs.c)
    mb.sphere(hs.point(UP, 0.1 + 0.042), 0.06, AccTrim, segs=8, rings=5, uv=const_uv('cream'))
    mb.to_object("acc_beanie", R_NECK, head)

    # ---- cap, worn backwards: the bill points back --------------------------------
    def e_rim(p):
        return 36 + 6 * math.cos(p * D2R)            # front 42 (above the brows), back 30
    specs = [lambda p: (e_rim(p) - 3, -0.014), lambda p: (e_rim(p), 0.032),
             lambda p: (e_rim(p) + (90 - e_rim(p)) * 0.38, 0.046), lambda p: (e_rim(p) + (90 - e_rim(p)) * 0.74, 0.052)]
    rows = shell_rows(hs, phis, specs, 0.053)
    mb = MB()
    mb.surface(rows, [Acc] * 4, uv_fn=white, centre=hs.c)
    mb.sphere(hs.point(UP, 0.056), (0.028, 0.028, 0.014), AccTrim, segs=8, rings=4, uv=const_uv('white'))
    bp = hs.point(head_dir(180, e_rim(180)), 0.026)
    visor(mb, AccTrim, bp + Vector((0, -0.05, -0.004)), (0, 1, 0), 0.17, 0.215, const_uv('cloud'), pitch=4.0,
          thick=0.01, droop=0.05)
    mb.to_object("acc_cap", R_NECK, head)

    # ---- pirate hat: black crown, standing front flap with skull & crossbones, gold trim
    def e_p(p):
        return 30 + 8 * math.cos(p * D2R)
    specs = [lambda p: (e_p(p) - 3, -0.014), lambda p: (e_p(p), 0.04), lambda p: (e_p(p) + 14, 0.064),
             lambda p: (e_p(p) + (90 - e_p(p)) * 0.55, 0.08), lambda p: (e_p(p) + (90 - e_p(p)) * 0.82, 0.086)]
    rows = shell_rows(hs, phis, specs, 0.088)
    mb = MB()
    mb.surface(rows, [AccTrim] * 5, uv_fn=uvf_const('ink'), centre=hs.c)
    fph = [-64 + 128 * k / 8 for k in range(9)]
    skull = T.chars_print_rect('skull')
    fr_rows = []
    zs = []
    for ph in fph:
        b = hs.point(head_dir(ph, e_p(ph) + 3), 0.05)
        t = (ph / 64.0)
        hgt = 0.075 + 0.17 * (1 - t * t)
        n = Vector((math.sin(ph * D2R), -math.cos(ph * D2R), 0))
        top = b + Vector((0, 0, hgt)) - n * 0.03
        fr_rows.append((b, top, n))
        zs.append(b.z)
    zmin = min(zs)
    # thick flap: per azimuth sample a closed section (front-bottom, front-top, back-top, back-bottom)
    sec = []
    for b, top, n in fr_rows:
        th_ = n * 0.009
        sec.append([b + th_, top + th_, top - th_, b - th_])
    cap0 = sum(sec[0], Vector((0, 0, 0))) / 4
    cap1 = sum(sec[-1], Vector((0, 0, 0))) / 4

    def flap_uv(i, co, r, u, j):
        if j == 0:   # the front face: skull print, planar from the front
            a = max(0.0, min(1.0, (co.x + 0.25) / 0.5))
            b = max(0.0, min(1.0, (co.z - zmin + 0.01) / 0.27))
            return (skull[0] + (skull[2] - skull[0]) * a, skull[1] + (skull[3] - skull[1]) * b)
        return tuple(T.chars_swatch_uv('ink'))
    mb.surface([[cap0]] + sec + [[cap1]], [AccTrim] * (len(sec) + 1), uv_fn=flap_uv,
               centre=hs.c + Vector((0, 0.1, 0.0)))
    mb.tube([top for b, top, n in fr_rows], 0.012, AccTrim, sides=4, uv=const_uv('gold'))
    mb.to_object("acc_pirate", R_NECK, head)

    # ---- top hat: tiny and dapper, perched between the ears -------------------------
    base = hs.point(UP, -0.006)
    tilt = Matrix.Rotation(-9 * D2R, 3, 'X')
    mb = MB()
    mb.lathe([(0, -0.004), (0.098, -0.004), (0.106, 0.004), (0.1, 0.011), (0.068, 0.012), (0.068, 0.05),
              (0.075, 0.19), (0.07, 0.2), (0, 0.2)], Acc, segs=12, c=base, rot=tilt, uv=const_uv('white'))
    mb.lathe([(0.0735, 0.012), (0.0755, 0.015), (0.0755, 0.047), (0.0735, 0.05)], AccTrim, segs=12, c=base,
             rot=tilt, uv=const_uv('ink'))
    mb.to_object("acc_tophat", R_NECK, head)

    # ---- loot sack on the back (burlap + patch), strap across the chest ------------------
    # Sits low on the back-right, clear of the head when the gallop pitches the torso and tips
    # the head back, and of the face in the taunt's over-the-shoulder look.
    SO = SACK_OFFSET

    def sack_sdf(p):
        d = C.sd_ellipsoid(p, Vector((-0.08, 0.29, 0.57)) + SO, (0.19, 0.145, 0.185))
        return C.smin(d, C.sd_capsule3(p, Vector((-0.12, 0.26, 0.7)) + SO, Vector((-0.15, 0.22, 0.815)) + SO,
                                       0.065, 0.036), 0.05)
    ss = C.PolarShape(Vector((-0.09, 0.29, 0.6)) + SO, sack_sdf, front=(0, 1, 0), smax_=0.5, outline=lambda th: 90.0)
    srows = ss.rows([36.0 * k for k in range(10)], [0, 0.3, 0.6, 0.85, 1.0, 1.25, 1.5, 1.75, 2.0])
    sackr = T.chars_print_rect('sack')
    mb = MB()
    mb.surface(srows, [AccTrim] * 8,
               uv_fn=uvf_planar(sackr, Vector((0.13, 0, 0.37)) + SO, (-1, 0, 0), (0, 0, 1), 0.42, 0.46), centre=ss.c)
    tie = Vector((-0.148, 0.222, 0.81)) + SO
    mb.lathe([(0.0, -0.022), (0.044, -0.02), (0.048, 0.0), (0.044, 0.02), (0.0, 0.022)], AccTrim, segs=6, c=tie,
             rot=align_z((-0.25, -0.25, 1.0)), uv=const_uv('brown'))
    mb.sphere(tie + Vector((-0.018, -0.01, 0.052)), (0.052, 0.042, 0.044), AccTrim, segs=7, rings=4,
              uv=const_uv('straw'))
    strap = [tie + Vector((0.0, -0.05, -0.02))]
    for d_, a_ in (((-0.55, -0.15, 0.82), 0.022), ((-0.45, -0.8, 0.4), 0.02), ((-0.05, -1.0, 0.05), 0.02),
                   ((0.5, -0.85, -0.2), 0.02), ((0.9, -0.1, -0.35), 0.02), ((0.55, 0.75, -0.3), 0.02),
                   ((0.1, 1.0, -0.2), 0.02)):
        strap.append(sh.point(Vector(d_).normalized(), a_))
    mb.tube(strap, 0.017, Acc, sides=4, uv=const_uv('white'))
    mb.to_object("acc_sack", R_HIPS, torso)

    # ---- crown (the reigning champion) --------------------------------------------
    mb = MB()
    crown_geom(mb, Gold, AccTrim, hs.point(UP, -0.012), r=0.088, h=0.05, spike=0.055)
    mb.to_object("acc_crown", R_NECK, head)

    build_raccoon_outfit_accessories(M, J)


# The eyes' centres on the face texture (head-local metres from R_HC; build_textures.py's
# R_EYE_X / R_EYE_Z): the face is projected straight from the front, so a point of the face
# at (x, z) shows the texture at (x, z - R_HC.z).
R_EYE_X, R_EYE_Z = 0.106, 0.03


def raccoon_face_point(x, z, add=0.0):
    """The front of the raccoon's head at (x, z), pushed `add` along the surface normal."""
    p = Vector((x, surface_y(raccoon_head_sdf, x, z), z))
    e = 1e-3
    g = Vector([raccoon_head_sdf(p + d) - raccoon_head_sdf(p - d)
                for d in (Vector((e, 0, 0)), Vector((0, e, 0)), Vector((0, 0, e)))]).normalized()
    return p + g * add


def build_raccoon_outfit_accessories(M, J):
    """The start screen's extra outfit pieces: shades, a bow tie, headphones, a traffic cone.
    Only the shared Acc / AccTrim materials (nothing new to compile in the game)."""
    Acc, AccTrim = M['Acc'], M['AccTrim']
    head, torso, hs, sh = J['head'], J['torso'], J['hs'], J['sh']

    # ---- shades: two dark lenses over the mask, a frame in the accessory colour, arms back
    # along the sides of the head (they end in the fur, well below the ears)
    mb = MB()
    ez = R_HC.z + R_EYE_Z
    LW, LH, LN = 0.075, 0.06, 2.6              # lens half width / height, superellipse power

    def lens_pt(s, a, f, add):
        c, sn = math.cos(a), math.sin(a)
        x = LW * f * math.copysign(abs(c) ** (2 / LN), c)
        z = LH * f * math.copysign(abs(sn) ** (2 / LN), sn)
        z += 0.008 * (x / LW)                  # the outer corner a touch higher: cool, not sad
        return raccoon_face_point(s * (R_EYE_X + x), ez + z, add)
    n = 24
    angles = [2 * math.pi * k / n for k in range(n)]
    for s in (1, -1):
        rows = [[raccoon_face_point(s * R_EYE_X, ez, 0.016)]]
        for f in (0.4, 0.75, 1.0):
            rows.append([lens_pt(s, a, f, 0.016) for a in angles])
        mb.surface(rows, [AccTrim] * 3, uv_fn=uvf_const('ink'), centre=hs.c, closed=True)
        mb.tube([lens_pt(s, a, 1.0, 0.017) for a in angles], 0.011, Acc, sides=5, closed=True, uv=const_uv('white'))
        # a glint on the upper outer part of the lens
        mb.tube([lens_pt(s, 0.35 * math.pi, 0.62, 0.02), lens_pt(s, 0.12 * math.pi, 0.78, 0.02)], 0.0045, AccTrim,
                sides=4, uv=const_uv('cloud'))
        # the arm: from the frame's outer edge round the side of the head, sinking into the fur
        e = math.degrees(math.asin(R_EYE_Z / 0.27)) + 1.0
        arm = [lens_pt(s, 0.0, 1.0, 0.017)]
        for phi, add in ((52, 0.014), (66, 0.014), (80, 0.013), (94, 0.004), (102, -0.012)):
            arm.append(hs.point(head_dir(s * phi, e), add))
        mb.tube(arm, 0.009, Acc, sides=5, uv=const_uv('white'))
    # the bridge, arched over the nose
    xi = R_EYE_X - LW + 0.004
    bridge = [raccoon_face_point(xi, ez + 0.012, 0.019), raccoon_face_point(0.0, ez + 0.022, 0.021),
              raccoon_face_point(-xi, ez + 0.012, 0.019)]
    mb.tube(bridge, 0.01, Acc, sides=5, uv=const_uv('white'))
    mb.to_object("acc_shades", R_NECK, head)

    # ---- bow tie: under the chin, on a thin band round the neck -----------------------
    mb = MB()
    band = []
    for k in range(16):
        a = 2 * math.pi * k / 16
        d = Vector((0.125 * math.sin(a), -0.115 * math.cos(a), 0.715 - sh.c.z))
        band.append(sh.point(d, 0.01))
    mb.tube(band, 0.011, Acc, sides=5, closed=True, uv=const_uv('white'))
    # (big enough to read from the game's camera, 25 m up)
    bz = 0.672
    by = surface_y(raccoon_torso_sdf, 0.0, bz)
    for s in (1, -1):
        # each wing flares from the knot out to its tip (taller at the tip), turned back
        # round the chest
        mb.superellipsoid((s * 0.064, by - 0.016, bz), (0.066, 0.022, 0.052), Acc, segs=10, rings=6, e_lat=0.7,
                          rot=(0, 0, s * 17), extra=lambda q, s=s: (q.x, q.y, q.z * (0.55 + 0.45 * (1 + s * q.x) / 2)),
                          uv=const_uv('white'))
    mb.sphere((0.0, by - 0.028, bz), (0.028, 0.022, 0.032), Acc, segs=8, rings=5, uv=const_uv('white'))
    mb.to_object("acc_bowtie", R_HIPS, torso)

    # ---- headphones: a band over the crown, tipped forward so it passes in front of the
    # ears, and cups on the sides of the head (rubber cushions, shells in the colour)
    mb = MB()
    tilt = 18 * D2R
    cup_e = 9 * D2R

    def band_dir(b):
        return Vector((math.sin(b), -math.sin(tilt) * math.cos(b), math.cos(tilt) * math.cos(b)))
    pts = [hs.point(band_dir(k * D2R), 0.022) for k in range(-78, 79, 12)]
    mb.tube(pts, 0.016, Acc, sides=6, uv=const_uv('white'))
    uvd = {Acc.name: const_uv('white'), AccTrim.name: const_uv('rubber')}
    for s in (1, -1):
        d = Vector((s * math.cos(cup_e), 0.0, math.sin(cup_e)))
        base_pt = hs.point(d, -0.006)
        mb.lathe([(0.0, 0.0, AccTrim), (0.056, 0.0, AccTrim), (0.064, 0.012, AccTrim), (0.062, 0.026, Acc),
                  (0.07, 0.032, Acc), (0.068, 0.052, Acc), (0.05, 0.064, Acc), (0.0, 0.066, Acc)],
                 Acc, segs=12, c=base_pt, rot=align_z(d), uv=uvd)
    mb.to_object("acc_headphones", R_NECK, head)

    # ---- traffic cone, worn as a hat: a rubber base, orange, stripes in the colour --------
    mb = MB()
    base_pt = hs.point(UP, -0.006)
    rot = Matrix.Rotation(-8 * D2R, 3, 'X') @ Matrix.Rotation(6 * D2R, 3, 'Y')
    mb.lathe([(0.0, -0.004), (0.086, -0.004), (0.09, 0.005), (0.086, 0.016), (0.0, 0.016)], AccTrim, segs=8, c=base_pt,
             rot=rot, phase=math.pi / 8, uv=const_uv('rubber'))
    H = 0.25

    def r_at(z):
        return 0.07 + (0.012 - 0.07) * (z - 0.016) / (H - 0.016)
    prof = []
    for z0, z1, m in ((0.016, 0.082, AccTrim), (0.082, 0.118, Acc), (0.118, 0.164, AccTrim), (0.164, 0.192, Acc), (0.192, H, AccTrim)):
        prof.append((r_at(z0), z0, m))
    prof.append((r_at(H), H, AccTrim))
    prof.append((0.0, H + 0.004, AccTrim))
    mb.lathe(prof, AccTrim, segs=12, c=base_pt, rot=rot,
             uv={Acc.name: const_uv('white'), AccTrim.name: const_uv('orange')})
    mb.to_object("acc_cone", R_NECK, head)


# ---- people ---------------------------------------------------------------------
H_HIPS = (0.0, 0.0, 0.66)
H_NECK = (0.0, 0.0, 1.16)
H_ARM = (0.29, 0.0, 1.08)
H_ELBOW = (0.30, 0.0, 0.87)
H_HAND = (0.30, -0.03, 0.68)
H_LEGS = (0.0, 0.0, 0.62)
H_LEG = (0.13, 0.0, 0.62)
H_FOOT = (0.13, -0.02, 0.08)
H_HC = Vector((0.0, 0.0, 1.505))        # head centre


def human_head_sdf(p):
    q = Vector(p) - H_HC
    d = C.sd_ellipsoid(q, (0, 0, 0), (0.355, 0.33, 0.345))
    d = C.smin(d, C.sd_ellipsoid(q, (0, -0.035, -0.115), (0.318, 0.29, 0.235)), 0.07)      # cheeks / jaw
    d = C.smin(d, C.sd_ellipsoid(q, (0, -0.322, -0.058), (0.04, 0.034, 0.038)), 0.028)    # button nose
    return d


H_FACE_OUTLINE = C.periodic_spline([(-90, 56), (-45, 60), (0, 60), (45, 50), (90, 36), (135, 50), (180, 60),
                                    (225, 60)])


def human_head_shape():
    return C.PolarShape(H_HC, human_head_sdf, outline=H_FACE_OUTLINE, smax_=0.7)


def shirt_rect(x0, y0, x1, y1):
    """Blender UV rect of a pixel rect inside shirt pattern cell 0 (cell-relative px)."""
    X0, Y0 = 0, T.SHIRT_Y
    return (T.chars_uv(X0 + x0, Y0 + y1)[0], T.chars_uv(X0 + x0, Y0 + y1)[1],
            T.chars_uv(X0 + x1, Y0 + y0)[0], T.chars_uv(X0 + x1, Y0 + y0)[1])


# shirt UV layout inside pattern cell 0 (px, cell-relative): the torso wraps once round the
# full inner width (patterns are periodic over it); sleeves sit below at the same scale.
SHIRT_TORSO_PX = (T.SHIRT_INNER, T.SHIRT_INNER, T.FACE_CELL - T.SHIRT_INNER, 62)
SHIRT_SLEEVE_PX = (T.SHIRT_INNER, 70, 52, 100)


def human_materials():
    return dict(
        Face=tmat("Face", "#ffd9b8", "atlas_chars", rough=0.7),
        Skin=mat("Skin", "#ffd9b8", 0.7),
        Hair=mat("Hair", "#6b4226", 0.75),
        Shirt=tmat("Shirt", "#ffffff", "atlas_chars", rough=0.8),
        Pants=mat("Pants", "#3d5a80", 0.8),
        Shoes=mat("Shoes", "#ffffff", 0.6),
        AccTrim=tmat("AccTrim", "#ffffff", "atlas_chars", rough=0.6),
    )


def human_torso_rows(segs=20):
    """Rounded body rings (z, half width, half depth, y offset) from the hem to the neck."""
    prof = [(0.6, 0.0, 0.0, 0.0), (0.6, 0.205, 0.16, 0.0), (0.66, 0.222, 0.172, -0.004), (0.76, 0.228, 0.178, -0.01),
            (0.87, 0.232, 0.176, -0.008), (0.97, 0.236, 0.168, 0.0), (1.04, 0.236, 0.158, 0.004),
            (1.1, 0.214, 0.146, 0.006), (1.15, 0.165, 0.122, 0.006), (1.19, 0.095, 0.08, 0.004), (1.205, 0.0, 0.0, 0.0)]
    rows = []
    for z, rx, ry, oy in prof:
        if rx <= 0:
            rows.append([Vector((0, oy, z))])
            continue
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs + math.pi / 2          # start at the back (+Y): the UV seam
            ca, sa = math.cos(a), math.sin(a)
            # squarish cross-section (superellipse) so the shirt reads as a chunky body
            px = math.copysign(abs(ca) ** 0.8, ca) * rx
            py = math.copysign(abs(sa) ** 0.8, sa) * ry
            ring.append(Vector((px, py + oy, z)))
        rows.append(ring)
    return rows


def build_human():
    M = human_materials()
    Face, Skin, Shirt, Pants, Shoes = M['Face'], M['Skin'], M['Shirt'], M['Pants'], M['Shoes']
    root = empty("human", (0, 0, 0))

    # ---- hips: the top of the trousers ------------------------------------------------
    mb = MB()
    mb.superellipsoid((0, 0.0, 0.66), (0.212, 0.168, 0.13), Pants, segs=12, rings=6, e_lat=0.8)
    hips = mb.to_object("hips", H_HIPS, root)

    # ---- torso: shirt, UVs wrapped once round pattern cell 0 -------------------------
    rows = human_torso_rows()
    tx0, ty0, tx1, ty1 = SHIRT_TORSO_PX
    rect = shirt_rect(tx0, ty0, tx1, ty1)
    mb = MB()
    mb.grid(rows, Shirt, wrap=True, recalc=True, uv=('cyl', {'rect': rect}))
    torso = mb.to_object("torso", H_HIPS, hips)

    # ---- head: skin with the face patch ---------------------------------------------------
    hs = human_head_shape()
    th = [360.0 * k / 28 - 90 for k in range(28)]
    ts_face = [0, 0.24, 0.48, 0.7, 0.87, 1.0]
    ts_back = [1.12, 1.3, 1.5, 1.72, 2.0]
    rows = hs.rows(th, ts_face + ts_back)
    check_face_uvs("human", 'human', rows[:len(ts_face)], H_HC)
    mb = MB()
    nb = len(ts_face) - 1
    mb.surface(rows, [Face] * nb + [Skin] * len(ts_back), uv_fn=face_uv_fn('human', H_HC, nb), centre=hs.c)
    head = mb.to_object("head", H_NECK, torso)

    # ---- arms: short sleeve over a skin arm; mitten hands ------------------------------
    sx = H_ARM[0]
    srect = shirt_rect(*SHIRT_SLEEVE_PX)
    mb = MB()
    mb.capsule((sx, 0, H_ELBOW[2]), H_ARM, 0.056, Skin, r1=0.06, segs=8, hemi=2)
    mb.lathe([(0.072, -0.13), (0.077, -0.125), (0.08, -0.04), (0.078, 0.0), (0.066, 0.045), (0.036, 0.072),
              (0.0, 0.08)], Shirt, segs=10, c=H_ARM, uv=('cyl', {'rect': srect}))
    arm_l = mb.to_object("arm_l", H_ARM, torso)
    arm_r = share(arm_l, "arm_r", (-H_ARM[0], H_ARM[1], H_ARM[2]), torso)
    ex = H_ELBOW[0]
    mb = MB()
    mb.capsule((ex, -0.02, 0.73), (ex, 0, H_ELBOW[2]), 0.05, Skin, r1=0.052, segs=8, hemi=2)
    mb.superellipsoid((ex, -0.03, 0.675), (0.062, 0.056, 0.074), Skin, segs=8, rings=6, e_lat=0.85)
    fore_l = mb.to_object("forearm_l", H_ELBOW, arm_l)
    fore_r = share(fore_l, "forearm_r", (-H_ELBOW[0], H_ELBOW[1], H_ELBOW[2]), arm_r)
    hl = empty("hand_l_socket", H_HAND, fore_l, size=0.05)
    hr = empty("hand_r_socket", (-H_HAND[0], H_HAND[1], H_HAND[2]), fore_r, size=0.05)

    # ---- legs + shoes ---------------------------------------------------------------------
    legs = empty("legs", H_LEGS, root)
    lx = H_LEG[0]
    mb = MB()
    mb.capsule((lx, -0.02, 0.12), H_LEG, 0.072, Pants, r1=0.092, segs=10, hemi=2)
    leg_l = mb.to_object("leg_l", H_LEG, legs)
    leg_r = share(leg_l, "leg_r", (-H_LEG[0], H_LEG[1], H_LEG[2]), legs)
    mb = MB()
    mb.superellipsoid((lx, -0.06, 0.032), (0.088, 0.135, 0.064), Shoes, segs=10, rings=6, e_lat=0.75,
                      extra=lambda q: (q.x, q.y, q.z if q.z > 0 else q.z * 0.5))
    foot_l = mb.to_object("foot_l", H_FOOT, leg_l)
    share(foot_l, "foot_r", (-H_FOOT[0], H_FOOT[1], H_FOOT[2]), leg_r)

    build_human_accessories(M, dict(head=head, torso=torso, hs=hs, hand_l=hl, hand_r=hr, fore_l=fore_l))
    return root


# ---- hair -----------------------------------------------------------------------------
def hair_specs_h(emin, thick, rings, tuck_de=-3.0, tuck_add=-0.02):
    specs = [lambda p: (emin(p) + tuck_de, tuck_add)]
    for i in range(rings):
        t = 1.0 - i / rings
        specs.append(lambda p, t=t: (90.0 - t * (90.0 - emin(p)), thick(p, t)))
    return specs


def human_hair(M, hs, head):
    Hair = M['Hair']

    # hair_0: short tousled crop, zig-zag fringe, a little cowlick on top
    def emin0(p):
        a = wa(p)
        e = 9 + 27 * math.cos(p * D2R) - 4 * math.cos(2 * p * D2R) - 34 * smoothstep(100, 180, abs(a))
        if abs(a) <= 66.01 and round(a / 11) % 2 == 0:
            e -= 6 * math.cos(min(abs(a) / 70, 1) * math.pi / 2)
        return e

    def thick0(p, t):
        return 0.03 + 0.045 * (1 - t) + 0.01 * math.sin(p * D2R * 5) * 4 * t * (1 - t)
    phis0 = [-66 + 11 * k for k in range(13)] + [66 + 228 * k / 8 for k in range(1, 8)]
    mb = MB()
    mb.surface(shell_rows(hs, phis0, hair_specs_h(emin0, thick0, 4), thick0(0, 0)), [Hair] * 5, centre=hs.c)
    top = hs.point(UP, thick0(0, 0))
    mb.tube([top + Vector(v) for v in ((0, -0.03, -0.035), (0, -0.05, 0.035), (0, -0.02, 0.09), (0, 0.03, 0.1),
                                        (0, 0.06, 0.07))], [0.026, 0.022, 0.016, 0.01, 0.004], Hair, sides=5)
    mb.to_object("hair_0", H_NECK, head)

    # hair_1: side-swept fringe + a ponytail at the back
    def emin1(p):
        a = wa(p)
        e = 10 + 24 * math.cos(p * D2R) - 30 * smoothstep(100, 180, abs(a))
        x = a + 22
        if abs(x) < 40:
            e -= 9 * math.cos(x / 40 * math.pi / 2) ** 2
        return e

    def thick1(p, t):
        return 0.03 + 0.03 * (1 - t)
    phis1 = [360.0 * j / 18 for j in range(18)]
    mb = MB()
    mb.surface(shell_rows(hs, phis1, hair_specs_h(emin1, thick1, 4), thick1(0, 0)), [Hair] * 5, centre=hs.c)
    tie = hs.point(head_dir(180, 18), 0.05)
    mb.sphere(tie, (0.05, 0.04, 0.05), Hair, segs=8, rings=5)
    tail = [tie + Vector((0, 0.03, 0.0)), tie + Vector((0, 0.1, -0.06)), tie + Vector((0, 0.12, -0.18)),
            tie + Vector((0, 0.08, -0.3))]
    mb.tube(tail, [0.06, 0.075, 0.06, 0.02], Hair, sides=7)
    mb.to_object("hair_1", H_NECK, head)

    # hair_2: bob with scalloped bangs, full at the sides, curling under
    def side2(p):
        return smoothstep(42, 60, abs(wa(p)))

    def emin2(p):
        a = abs(wa(p))
        front = 29.0 - (3.0 if (a <= 40.01 and round(a / 10) % 2 == 0) else 0.0)
        back = -40.0 - 6.0 * smoothstep(90, 180, a)
        s_ = side2(p)
        return front * (1 - s_) + back * s_

    def thick2(p, t):
        return 0.034 + 0.02 * 4 * t * (1 - t) + 0.05 * side2(p) * t * t
    phis2 = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60] + [60 + 240 * k / 9 for k in range(1, 9)]
    specs2 = [lambda p: (emin2(p) - 1.0, -0.025),
              lambda p: (emin2(p) - 0.5, thick2(p, 1.0) * 0.55),
              lambda p: (emin2(p) + 3.0, thick2(p, 1.0))]
    for i in range(1, 4):
        t = 1.0 - i / 4.0
        specs2.append(lambda p, t=t: (90.0 - t * (90.0 - emin2(p) - 3.0), thick2(p, t)))
    mb = MB()
    mb.surface(shell_rows(hs, phis2, specs2, thick2(0, 0)), [Hair] * 6, centre=hs.c)
    mb.to_object("hair_2", H_NECK, head)

    # hair_3: granny's curly perm + a round bun
    def emin3(p):
        return 14 + 14 * math.cos(p * D2R) - 34 * smoothstep(90, 180, abs(wa(p)))

    def thick3(p, t):
        return 0.045 + 0.02 * (1 - t) + 0.012 * math.sin(p * D2R * 9) * (0.4 + t)
    phis3 = [360.0 * j / 24 for j in range(24)]
    specs3 = [lambda p: (emin3(p) - 3.0, -0.02), lambda p: (emin3(p), thick3(p, 1.0) * 0.8)]
    for i in range(1, 4):
        t = 1.0 - i / 4.0
        specs3.append(lambda p, t=t: (90.0 - t * (90.0 - emin3(p)), thick3(p, t)))
    mb = MB()
    mb.surface(shell_rows(hs, phis3, specs3, thick3(0, 0)), [Hair] * 5, centre=hs.c)
    mb.sphere(hs.point(head_dir(180, 58), 0.1), (0.11, 0.1, 0.1), Hair, segs=10, rings=6)
    mb.sphere(hs.point(head_dir(180, 58), 0.1) + Vector((0, 0.0, 0.0)), (0.118, 0.06, 0.03), M['AccTrim'],
              segs=8, rings=3, rot=(-35, 0, 0), uv=const_uv('lilac'))
    mb.to_object("hair_3", H_NECK, head)


def face_point(hs, X, Z, add=0.0):
    """Point on the head's front surface at head-local (X, Z) (+ `add` outward along -Y)."""
    y = surface_y(hs.sdf, hs.c.x + X, hs.c.z + Z, y0=hs.c.y)
    return Vector((hs.c.x + X, y - add, hs.c.z + Z))


def build_human_accessories(M, J):
    Hair, AccTrim = M['Hair'], M['AccTrim']
    head, torso, hs = J['head'], J['torso'], J['hs']
    human_hair(M, hs, head)
    phis = [360.0 * k / 18 for k in range(18)]
    tsdf = None

    # ---- acc_cap: the kid's cap (bill forward), with hair poking out under it ----------
    def e_rim(p):
        return 21 + 9 * math.cos(p * D2R)
    specs = [lambda p: (e_rim(p) - 3, -0.02), lambda p: (e_rim(p), 0.035),
             lambda p: (e_rim(p) + (90 - e_rim(p)) * 0.4, 0.05), lambda p: (e_rim(p) + (90 - e_rim(p)) * 0.75, 0.056)]
    mb = MB()
    mb.surface(shell_rows(hs, phis, specs, 0.058), [AccTrim] * 4, uv_fn=uvf_const('sky'), centre=hs.c)
    mb.sphere(hs.point(UP, 0.062), (0.032, 0.032, 0.016), AccTrim, segs=8, rings=4, uv=const_uv('yellow'))
    bp = hs.point(head_dir(0, e_rim(0)), 0.03)
    visor(mb, AccTrim, bp + Vector((0, 0.06, -0.004)), (0, -1, 0), 0.2, 0.24, const_uv('yellow'), pitch=10.0,
          thick=0.01)
    # tufts of hair under the cap at the sides and back
    hphis = [40 + 280 * k / 12 for k in range(13)]
    hspecs = [lambda p: (e_rim(p) - 22, -0.012), lambda p: (e_rim(p) - 12, 0.03), lambda p: (e_rim(p) + 2, 0.026)]
    hrows = [[hs.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in hphis] for sp in hspecs]
    mb.surface(hrows, [Hair] * 2, centre=hs.c, closed=False)
    mb.to_object("acc_cap", H_NECK, head)

    # ---- acc_chef_hat: tall puffy toque on a band, sideburns of hair below ------------------
    def e_band(p):
        return 30 + 5 * math.cos(p * D2R)
    specs = [lambda p: (e_band(p) - 3, -0.02), lambda p: (e_band(p), 0.035), lambda p: (e_band(p) + 18, 0.04)]
    mb = MB()
    rows = [[hs.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in phis] for sp in specs]
    top_c = hs.point(UP, 0.0) + Vector((0, 0.01, 0.2))
    puff = []
    for f, dz in ((1.08, 0.06), (1.3, 0.13), (1.34, 0.21), (1.15, 0.27), (0.7, 0.305)):
        ring = []
        for k, p in enumerate(phis):
            b = rows[-1][k]
            rad = Vector((b.x - top_c.x, b.y - top_c.y, 0))
            wob = 1.0 + 0.06 * math.cos(6 * p * D2R)
            ring.append(Vector((top_c.x, top_c.y, 0)) + rad * f * wob + Vector((0, 0, rows[-1][k].z + dz)))
        puff.append(ring)
    allrows = rows + puff + [[top_c + Vector((0, 0, 0.12))]]
    mb.surface(allrows, [AccTrim] * (len(allrows) - 1), uv_fn=uvf_const('white'), centre=hs.c + Vector((0, 0, 0.25)))
    hphis = [55 + 250 * k / 10 for k in range(11)]
    hspecs = [lambda p: (e_band(p) - 26, -0.012), lambda p: (e_band(p) - 14, 0.028), lambda p: (e_band(p) + 1, 0.026)]
    mb.surface([[hs.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in hphis] for sp in hspecs], [Hair] * 2,
               centre=hs.c, closed=False)
    mb.to_object("acc_chef_hat", H_NECK, head)

    # ---- acc_sunhat: wide straw hat with a flowery band (over any hair) --------------------
    def e_s(p):
        return 26 + 6 * math.cos(p * D2R)
    band = T.chars_print_rect('hatband')
    specs = [lambda p: (e_s(p) - 2, 0.0), lambda p: (e_s(p), 0.085), lambda p: (e_s(p) + 9, 0.095)]
    sphis = [360.0 * k / 16 for k in range(16)]
    rows = [[hs.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in sphis] for sp in specs]
    crown = [[hs.point(head_dir(p, e_s(p) + 30), 0.11) for p in sphis], [hs.point(head_dir(p, 74), 0.115) for p in sphis]]
    allrows = rows + crown + [[hs.point(UP, 0.11)]]
    nrow = len(allrows)

    def sun_uv(i, co, r, u, j):
        if i == 1:
            return (band[0] + (band[2] - band[0]) * u, band[1] if r == 1 else band[3])
        return tuple(T.chars_swatch_uv('straw'))
    mb = MB()
    mb.surface(allrows, [AccTrim] * (nrow - 1), uv_fn=sun_uv, centre=hs.c)
    # the brim: a closed loop of rings (under side out, rolled edge, top side back in)
    brim_in = rows[1]

    def out_(b, f, dz, p):
        d = Vector((b.x - hs.c.x, b.y - hs.c.y, 0)).normalized()
        return b + d * f + Vector((0, 0, dz - 0.028 * math.cos(2 * p * D2R) * min(1.0, f / 0.2)))
    brim = []
    for f, dz in ((0.0, -0.006), (0.12, -0.022), (0.235, -0.06), (0.25, -0.046), (0.235, -0.036), (0.12, -0.004),
                  (0.0, 0.012)):
        brim.append([out_(brim_in[k], f, dz, p) for k, p in enumerate(sphis)])
    mb.grid(brim, AccTrim, wrap=True, wrap_rows=True, recalc=True, uv=const_uv('straw'))
    mb.to_object("acc_sunhat", H_NECK, head)

    # ---- acc_sweatband: terry band round the forehead, over the hair ------------------------
    def e_w(p):
        return 25 + 3 * math.cos(p * D2R)
    specs = [lambda p: (e_w(p) - 5, 0.04), lambda p: (e_w(p) - 6, 0.068), lambda p: (e_w(p) + 6, 0.072),
             lambda p: (e_w(p) + 7, 0.045)]
    mb = MB()
    rows = [[hs.point(head_dir(p, sp(p)[0]), sp(p)[1]) for p in phis] for sp in specs]
    mb.grid(rows, AccTrim, wrap=True, wrap_rows=True, recalc=True, uv=const_uv('red'))
    mb.to_object("acc_sweatband", H_NECK, head)

    # ---- acc_glasses: round frames, bridge, temples ------------------------------------------
    mb = MB()
    for s_ in (1, -1):
        c = face_point(hs, s_ * 0.122, -0.012, 0.03)
        ring = [c + Vector((0.074 * math.cos(2 * math.pi * k / 14), 0.008 * abs(math.cos(2 * math.pi * k / 14)) * s_ * 0,
                            0.068 * math.sin(2 * math.pi * k / 14))) for k in range(14)]
        mb.tube(ring, 0.011, AccTrim, sides=4, closed=True, uv=const_uv('ink'))
        side = face_point(hs, s_ * 0.2, 0.0, 0.02)
        ear = hs.point(head_dir(s_ * 84, 2), 0.012)
        mb.tube([c + Vector((s_ * 0.074, 0.0, 0.01)), side + Vector((s_ * 0.04, 0.05, 0.01)), ear], 0.008, AccTrim, sides=4,
                uv=const_uv('ink'))
    b0, b1 = face_point(hs, 0.05, 0.0, 0.03), face_point(hs, -0.05, 0.0, 0.03)
    mb.tube([b0, (b0 + b1) / 2 + Vector((0, -0.012, 0.012)), b1], 0.009, AccTrim, sides=4, uv=const_uv('ink'))
    mb.to_object("acc_glasses", H_NECK, head)

    # ---- acc_mustache: big curly handlebar (hair colour) --------------------------------------
    mb = MB()
    for s_ in (1, -1):
        pts = []
        rads = []
        for k in range(7):
            t = k / 6.0
            X = s_ * (0.012 + 0.13 * t)
            Z = -0.098 - 0.03 * math.sin(t * math.pi) + 0.06 * max(0.0, t - 0.65) ** 1.5 * 6
            pts.append(face_point(hs, X, Z, 0.01 + 0.01 * (1 - t)))
            rads.append(0.042 * (1 - 0.7 * t) + 0.01)
        mb.tube(pts, rads, Hair, sides=6)
        tip = pts[-1]
        mb.sphere(tip + Vector((s_ * 0.008, 0.0, 0.02)), 0.017, Hair, segs=6, rings=4)
    mb.to_object("acc_mustache", H_NECK, head)

    # ---- acc_gasmask: hood, goggles, respirator with two filter cans ------------------------
    mb = MB()

    def e_h(p):
        return 32 - 52 * smoothstep(60, 120, abs(wa(p)))
    specs = [lambda p: (e_h(p) - 2, -0.02), lambda p: (e_h(p), 0.03), lambda p: (e_h(p) + (90 - e_h(p)) * 0.4, 0.04),
             lambda p: (e_h(p) + (90 - e_h(p)) * 0.75, 0.045)]
    hphis = [360.0 * k / 12 for k in range(12)]
    mb.surface(shell_rows(hs, hphis, specs, 0.046), [AccTrim] * 4, uv_fn=uvf_const('orange'), centre=hs.c)
    for s_ in (1, -1):
        c = face_point(hs, s_ * 0.122, -0.012, 0.03)
        ring = [c + Vector((0.08 * math.cos(2 * math.pi * k / 8), 0.0, 0.075 * math.sin(2 * math.pi * k / 8)))
                for k in range(8)]
        mb.tube(ring, 0.02, AccTrim, sides=4, closed=True, uv=const_uv('charcoal'))
    strap = [hs.point(head_dir(p, 2 + 4 * math.cos(p * D2R)), 0.03) for p in range(40, 330, 36)]
    mb.tube(strap, 0.016, AccTrim, sides=3, uv=const_uv('charcoal'))
    muz = face_point(hs, 0.0, -0.13, 0.0)
    mb.lathe([(0.0, -0.02), (0.13, -0.02), (0.125, 0.03), (0.085, 0.075), (0.0, 0.085)], AccTrim, segs=8,
             c=muz + Vector((0, 0.03, 0)), rot=align_z((0, -1, -0.25)), uv=const_uv('slate'))
    for s_ in (1, -1):
        cc = muz + Vector((s_ * 0.105, -0.045, -0.02))
        mb.cylinder(cc, cc + Vector((s_ * 0.06, -0.035, -0.02)), 0.045, AccTrim, segs=6,
                    uv=const_uv('yellow'))
    mb.to_object("acc_gasmask", H_NECK, head)

    # ---- torso accessories ------------------------------------------------------------------
    trows = human_torso_rows(24)

    def body_pt(z, ang, add):
        """Point on the torso surface at height z, azimuth ang (deg, 0 = front, 90 = left),
        pushed `add` metres outward (horizontally)."""
        zs = [r[0].z for r in trows]
        zr = [r[0].z for r in trows if len(r) > 1]
        z = min(max(z, min(zr)), max(zr))
        for k in range(len(trows) - 1):
            if zs[k] - 1e-5 <= z <= zs[k + 1] + 1e-5 and len(trows[k]) > 1 and len(trows[k + 1]) > 1:
                t = (z - zs[k]) / max(zs[k + 1] - zs[k], 1e-9)
                n = len(trows[k])
                f = ((ang + 180.0) % 360.0) / 360.0 * n      # rings start at the back
                j0 = int(math.floor(f)) % n
                j1 = (j0 + 1) % n
                w = f - math.floor(f)
                a = trows[k][j0].lerp(trows[k][j1], w)
                b = trows[k + 1][j0].lerp(trows[k + 1][j1], w)
                p = a.lerp(b, t)
                d = Vector((p.x, p.y, 0))
                return p + d.normalized() * add if d.length > 1e-6 else p
        raise ValueError(z)

    # acc_tie: knot + blade with stripes, white collar points
    mb = MB()
    tie = T.chars_print_rect('tie')
    blade = []
    for z, hw in ((1.12, 0.03), (1.06, 0.045), (0.94, 0.06), (0.86, 0.064)):
        blade.append([body_pt(z, a, 0.012) for a in (-hw * 250, 0.0, hw * 250)])
    blade.append([body_pt(0.81, 0.0, 0.012)])
    mb.surface(blade, [AccTrim] * 4, uv_fn=uvf_planar(tie, (-0.07, 0, 0.8), (1, 0, 0), (0, 0, 1), 0.14, 0.33),
               centre=(0, 0.1, 0.95), closed=False)
    knot = body_pt(1.14, 0.0, 0.03)
    mb.sphere(knot, (0.042, 0.03, 0.036), AccTrim, segs=8, rings=5, uv=const_uv('red'))
    for s_ in (1, -1):
        col_ = [[body_pt(1.17, s_ * 3, 0.02), body_pt(1.17, s_ * 28, 0.018)], [body_pt(1.07, s_ * 12, 0.02)]]
        mb.surface(col_, [AccTrim, AccTrim], uv_fn=uvf_const('white'), centre=(0, 0.1, 1.0), closed=False)
    mb.to_object("acc_tie", H_HIPS, torso)

    # acc_apron: chef's apron with neck strap and waist ties
    mb = MB()
    ap = T.chars_print_rect('apron')
    rows = []
    for z, hw in ((1.1, 34), (1.02, 40), (0.9, 52), (0.78, 58), (0.66, 60), (0.6, 60)):
        rows.append([body_pt(z, a, 0.016 + 0.01 * (1.1 - z)) for a in [-hw + 2 * hw * k / 6 for k in range(7)]])
    mb.surface(rows, [AccTrim] * 5, uv_fn=uvf_planar(ap, (-0.24, 0, 0.58), (1, 0, 0), (0, 0, 1), 0.48, 0.55),
               centre=(0, 0.1, 0.9), closed=False)
    neck = [body_pt(1.1, -34, 0.016), body_pt(1.18, -60, 0.01), body_pt(1.2, 180, 0.0), body_pt(1.18, 60, 0.01),
            body_pt(1.1, 34, 0.016)]
    mb.tube(neck, 0.012, AccTrim, sides=4, uv=const_uv('white'))
    waist = [body_pt(0.8, a, 0.012) for a in range(58, 303, 35)]
    mb.tube(waist, 0.012, AccTrim, sides=4, uv=const_uv('white'))
    bow = body_pt(0.8, 180, 0.03)
    for s_ in (1, -1):
        mb.sphere(bow + Vector((s_ * 0.04, 0.01, 0.0)), (0.04, 0.012, 0.025), AccTrim, segs=6, rings=4,
                  rot=(0, s_ * 20, 0), uv=const_uv('white'))
    mb.to_object("acc_apron", H_HIPS, torso)

    # acc_overalls: bib + straps + PEST CONTROL patch + buttons
    mb = MB()
    pest = T.chars_print_rect('pest')
    rows = []
    for z, hw in ((1.06, 36), (0.96, 40), (0.84, 46), (0.72, 52), (0.64, 56)):
        rows.append([body_pt(z, a, 0.014) for a in [-hw + 2 * hw * k / 6 for k in range(7)]])
    mb.surface(rows, [AccTrim] * 4, uv_fn=uvf_const('olive'), centre=(0, 0.1, 0.9), closed=False)
    patch = [[body_pt(0.99, a, 0.022) for a in (-26, -9, 9, 26)], [body_pt(0.9, a, 0.022) for a in (-28, -9, 9, 28)]]
    mb.surface(patch, [AccTrim], uv_fn=uvf_planar(pest, (-0.13, 0, 0.885), (1, 0, 0), (0, 0, 1), 0.26, 0.115),
               centre=(0, 0.1, 0.94), closed=False)
    for s_ in (1, -1):
        st = [body_pt(1.06, s_ * 30, 0.014), body_pt(1.13, s_ * 50, 0.02), body_pt(1.12, s_ * 95, 0.03),
              body_pt(1.06, s_ * 140, 0.018), body_pt(0.84, s_ * 165, 0.014), body_pt(0.72, s_ * 175, 0.014)]
        mb.tube(st, 0.02, AccTrim, sides=4, uv=const_uv('olive'))
        mb.sphere(body_pt(1.04, s_ * 30, 0.03), 0.018, AccTrim, segs=6, rings=4, uv=const_uv('yellow'))
    mb.to_object("acc_overalls", H_HIPS, torso)

    # acc_tank: spray tank on the back, harness straps, hose
    mb = MB()
    tk = T.chars_print_rect('tank')
    tc = Vector((0.0, 0.31, 0.9))
    mb.lathe([(0.0, -0.21), (0.1, -0.21), (0.13, -0.18), (0.13, 0.17), (0.1, 0.2), (0.0, 0.21)], AccTrim, segs=12,
             c=tc, uv=('cyl', {'rect': tk}))
    mb.cylinder(tc + Vector((0, 0, 0.2)), tc + Vector((0, 0, 0.27)), 0.03, AccTrim, segs=8, bevel=0.008,
                uv=const_uv('steel'))
    mb.sphere(tc + Vector((0, 0, 0.285)), (0.05, 0.05, 0.02), AccTrim, segs=8, rings=3, uv=const_uv('red'))
    for s_ in (1, -1):
        st = [tc + Vector((s_ * 0.08, -0.1, 0.16)), body_pt(1.13, s_ * 120, 0.02), body_pt(1.13, s_ * 60, 0.025),
              body_pt(0.98, s_ * 35, 0.02), body_pt(0.8, s_ * 50, 0.018), tc + Vector((s_ * 0.1, -0.1, -0.14))]
        mb.tube(st, 0.018, AccTrim, sides=4, uv=const_uv('charcoal'))
    hose = [tc + Vector((-0.06, 0.0, -0.2)), tc + Vector((-0.14, -0.02, -0.3)), body_pt(0.66, -120, 0.08),
            body_pt(0.7, -95, 0.07)]
    mb.tube(hose, 0.018, AccTrim, sides=5, uv=const_uv('charcoal'))
    mb.to_object("acc_tank", H_HIPS, torso)

    # acc_backpack: the kid's backpack with a star badge pocket
    mb = MB()
    bc = Vector((0.0, 0.27, 0.88))

    def bp_sdf(p):
        return C.sd_ellipsoid(p, bc, (0.19, 0.11, 0.2))
    bs = C.PolarShape(bc + Vector((0, -0.02, 0)), bp_sdf, front=(0, 1, 0), smax_=0.4, outline=lambda th: 90.0)
    brows = bs.rows([36.0 * k for k in range(10)], [0, 0.4, 0.8, 1.2, 1.6, 2.0])
    mb.surface(brows, [AccTrim] * 5, uv_fn=uvf_const('red'), centre=bs.c)
    badge = T.chars_print_rect('badge')
    pc = bc + Vector((0, 0.1, -0.06))
    mb.superellipsoid(pc, (0.11, 0.045, 0.09), AccTrim, segs=10, rings=5, e_lat=0.6,
                      uv=('planar', pc - Vector((0.11, 0, 0.09)), (1, 0, 0), (0, 0, 1), 0.22, 0.18, {'rect': badge}))
    for s_ in (1, -1):
        st = [bc + Vector((s_ * 0.1, -0.08, 0.16)), body_pt(1.13, s_ * 110, 0.02), body_pt(1.12, s_ * 55, 0.024),
              body_pt(0.95, s_ * 40, 0.02), body_pt(0.8, s_ * 60, 0.018), bc + Vector((s_ * 0.12, -0.08, -0.15))]
        mb.tube(st, 0.017, AccTrim, sides=4, uv=const_uv('navy'))
    mb.to_object("acc_backpack", H_HIPS, torso)

    # acc_camera: tourist camera on the chest + neck strap
    mb = MB()
    cc = body_pt(0.95, 0.0, 0.055)
    mb.box(cc, (0.17, 0.07, 0.11), AccTrim, bevel=0.02, bseg=2, uv=const_uv('charcoal'))
    cam = T.chars_print_rect('camera')
    lens0 = cc + Vector((0, -0.035, -0.005))
    mb.cylinder(lens0, lens0 + Vector((0, -0.05, 0)), 0.042, AccTrim, segs=12, bevel=0.008,
                uv=('planar', lens0 - Vector((0.05, 0, 0.05)), (1, 0, 0), (0, 0, 1), 0.1, 0.1, {'rect': cam}))
    mb.box(cc + Vector((0.05, 0.0, 0.065)), (0.04, 0.04, 0.025), AccTrim, bevel=0.008, bseg=1, uv=const_uv('red'))
    strap = [cc + Vector((-0.08, 0.0, 0.03)), body_pt(1.12, -45, 0.012), body_pt(1.19, -110, 0.0), body_pt(1.2, 180, 0.0),
             body_pt(1.19, 110, 0.0), body_pt(1.12, 45, 0.012), cc + Vector((0.08, 0.0, 0.03))]
    mb.tube(strap, 0.011, AccTrim, sides=4, uv=const_uv('red'))
    mb.to_object("acc_camera", H_HIPS, torso)

    # ---- hand-held ----------------------------------------------------------------------------
    hand_l, hand_r = Vector(H_HAND), Vector((-H_HAND[0], H_HAND[1], H_HAND[2]))
    # acc_briefcase (left hand): handle in the fist, case hanging below
    mb = MB()
    cb = hand_l + Vector((0.0, 0.01, -0.2))
    mb.box(cb, (0.1, 0.36, 0.26), AccTrim, bevel=0.025, bseg=2, uv=const_uv('brown'))
    mb.tube([cb + Vector((0, -0.07, 0.13)), hand_l + Vector((0, -0.05, -0.02)), hand_l + Vector((0, 0.05, -0.02)),
             cb + Vector((0, 0.07, 0.13))], 0.014, AccTrim, sides=4, uv=const_uv('chocolate'))
    for s_ in (1, -1):
        mb.box(cb + Vector((s_ * 0.052, -0.09, 0.08)), (0.012, 0.04, 0.03), AccTrim, bevel=0.004, bseg=1,
               uv=const_uv('gold'))
        mb.box(cb + Vector((s_ * 0.052, 0.09, 0.08)), (0.012, 0.04, 0.03), AccTrim, bevel=0.004, bseg=1,
               uv=const_uv('gold'))
    mb.to_object("acc_briefcase", H_HAND, J['hand_l'])

    # acc_handbag (left hand): granny's purse
    mb = MB()
    hb = hand_l + Vector((0.0, 0.0, -0.17))
    mb.superellipsoid(hb, (0.075, 0.15, 0.11), AccTrim, segs=10, rings=6, e_lat=0.7, taper=0.15,
                      uv=const_uv('purple'))
    mb.tube([hb + Vector((0, -0.09, 0.09)), hand_l + Vector((0, -0.04, 0.0)), hand_l + Vector((0, 0.04, 0.0)),
             hb + Vector((0, 0.09, 0.09))], 0.012, AccTrim, sides=4, uv=const_uv('purple'))
    mb.sphere(hb + Vector((0.0, 0.0, 0.11)), (0.022, 0.05, 0.016), AccTrim, segs=6, rings=4, uv=const_uv('gold'))
    mb.to_object("acc_handbag", H_HAND, J['hand_l'])

    # acc_sprayer (right hand): spray wand pointing forward, nozzle, hose stub
    mb = MB()
    g0 = hand_r
    mb.cylinder(g0 + Vector((0, 0.05, 0.0)), g0 + Vector((0, -0.07, 0.0)), 0.026, AccTrim, segs=8, bevel=0.006,
                uv=const_uv('yellow'))
    mb.cylinder(g0 + Vector((0, -0.07, 0.0)), g0 + Vector((0, -0.52, -0.06)), 0.013, AccTrim, segs=6,
                uv=const_uv('steel'))
    nz = g0 + Vector((0, -0.52, -0.06))
    mb.cylinder(nz, nz + Vector((0, -0.07, -0.01)), 0.022, AccTrim, segs=8, r1=0.034, uv=const_uv('red'))
    mb.box(g0 + Vector((0, -0.03, -0.045)), (0.02, 0.05, 0.05), AccTrim, bevel=0.006, bseg=1, uv=const_uv('charcoal'))
    mb.tube([g0 + Vector((0, 0.05, 0.0)), g0 + Vector((0, 0.13, -0.05)), g0 + Vector((0.02, 0.17, -0.16))], 0.016,
            AccTrim, sides=4, uv=const_uv('charcoal'))
    mb.to_object("acc_sprayer", (-H_HAND[0], H_HAND[1], H_HAND[2]), J['hand_r'])

    # acc_balloon (right hand): string up to a balloon ~1 m above the hand, out to the side
    mb = MB()
    top = hand_r + Vector((-0.24, 0.05, 0.98))
    string = [hand_r + Vector((0, 0, 0.02)), hand_r + Vector((-0.05, 0.02, 0.3)), hand_r + Vector((-0.15, 0.03, 0.6)),
              top + Vector((0, 0, -0.02))]
    mb.tube(string, 0.006, AccTrim, sides=3, uv=const_uv('white'))
    bc_ = top + Vector((0, 0, 0.2))
    mb.sphere(bc_, (0.17, 0.17, 0.2), AccTrim, segs=12, rings=8, uv=const_uv('red'),
              deform=lambda v: (v.x * (1 - 0.18 * max(0.0, -v.z)), v.y * (1 - 0.18 * max(0.0, -v.z)), v.z))
    mb.lathe([(0.0, 0.0), (0.03, 0.01), (0.012, 0.035), (0.0, 0.04)], AccTrim, segs=6, c=top + Vector((0, 0, -0.02)),
             uv=const_uv('red'))
    mb.sphere(bc_ + Vector((-0.07, -0.1, 0.07)), (0.035, 0.02, 0.05), AccTrim, segs=6, rings=3, rot=(20, 0, 25),
              uv=const_uv('white'))
    mb.to_object("acc_balloon", (-H_HAND[0], H_HAND[1], H_HAND[2]), J['hand_r'])


# =============================================================================
# JUNK WEAPONS (origin = grip, barrel toward -Y = glTF +Z, top +Z = glTF +Y) + PICKUPS
# One AtlasTown material per gun: palette swatches + the soda / caps / tape / beans labels.
# =============================================================================
def town_mat():
    return tmat('AtlasTown', '#ffffff', 'atlas_town', rough=0.6)


def town_uv(name):
    return ('const',) + tuple(T.swatch_uv(name))


def town_rect(cell):
    return T.atlas_rect(cell)


def build_pistol():
    """Cork POP-GUN: wooden grip, candy-striped barrel, a cork on a string."""
    A = town_mat()
    mb = MB()
    mb.box((0, 0.016, -0.004), (0.044, 0.06, 0.125), A, bevel=0.016, bseg=1, rot=(12, 0, 0), uv=town_uv('wood'))
    mb.box((0, -0.03, 0.07), (0.054, 0.15, 0.072), A, bevel=0.022, bseg=1, uv=town_uv('teal'))
    mb.sphere((0, 0.05, 0.075), (0.03, 0.022, 0.03), A, segs=8, rings=4, uv=town_uv('red'))      # plunger knob
    for k in range(3):                                                                            # striped barrel
        y0 = -0.1 - k * 0.037
        mb.cylinder((0, y0, 0.072), (0, y0 - 0.037, 0.072), 0.022, A, segs=8,
                    uv=town_uv('white' if k % 2 else 'red'))
    mb.cylinder((0, -0.21, 0.072), (0, -0.226, 0.072), 0.029, A, segs=8, uv=town_uv('red'))
    mb.cylinder((0, -0.218, 0.072), (0, -0.258, 0.072), 0.02, A, segs=8, r1=0.025, uv=town_uv('caramel'))
    mb.tube([(0.0, -0.25, 0.052), (0.0, -0.236, 0.03), (0.0, -0.19, 0.018), (0.0, -0.13, 0.024), (0.0, -0.085, 0.035)],
            0.0045, A, sides=4, uv=town_uv('white'))                                                  # the string
    mb.box((0, -0.168, 0.112), (0.012, 0.018, 0.016), A, bevel=0.004, bseg=1, uv=town_uv('ink'))
    _trigger(mb, A, 0.0, uv=town_uv('ink'))
    ob = mb.to_object("wpn_pistol", (0, 0, 0))
    empty("muzzle", (0, -0.258, 0.072), ob, size=0.04)
    return ob


def build_smg():
    """BOTTLE-CAP BLASTER: a soda can receiver, a straw barrel, a crank and a hopper of caps."""
    A = town_mat()
    mb = MB()
    fizz = town_rect('label_fizz')
    caps = town_rect('label_caps')
    can0, can1 = Vector((0, 0.085, 0.078)), Vector((0, -0.12, 0.078))
    mb.lathe([(0.0, 0.0), (0.04, 0.0), (0.046, 0.008), (0.046, 0.197), (0.04, 0.205), (0.0, 0.205)], A, segs=10,
             c=can0, rot=align_z(can1 - can0), uv=('cyl', {'rect': fizz}))
    mb.cylinder((0, -0.118, 0.078), (0, -0.3, 0.078), 0.016, A, segs=6, uv=town_uv('yellow'))         # straw barrel
    mb.cylinder((0, -0.285, 0.078), (0, -0.31, 0.078), 0.022, A, segs=8, uv=town_uv('red'))
    hop = Vector((0, -0.015, 0.118))
    mb.lathe([(0.0, 0.0), (0.024, 0.0), (0.046, 0.06), (0.05, 0.066), (0.044, 0.066), (0.02, 0.008), (0.0, 0.008)], A,
             segs=7, c=hop, uv=town_uv('steel'))
    for k, (dx, dy, dz, rx, ry) in enumerate(((0.004, -0.004, 0.056, -15, 10), (-0.01, 0.012, 0.074, 22, -18))):
        c = hop + Vector((dx, dy, dz))
        R = C.rotmat((rx, ry, 0))
        mb.lathe([(0.0, 0.0), (0.022, 0.0), (0.022, 0.008), (0.0, 0.008)], A, segs=8, c=c, rot=R,
                 uv=('planar', c - R @ Vector((0.022, 0.022, 0)), R @ Vector((1, 0, 0)), R @ Vector((0, 1, 0)), 0.044,
                     0.044, {'rect': caps}))
    ax = Vector((-0.046, 0.0, 0.078))                                                              # crank
    mb.cylinder(ax, ax + Vector((-0.026, 0, 0)), 0.008, A, segs=6, uv=town_uv('steel'))
    mb.box(ax + Vector((-0.03, 0.0, -0.024)), (0.01, 0.014, 0.06), A, bevel=0.004, bseg=1, uv=town_uv('steel'))
    mb.sphere(ax + Vector((-0.046, 0.0, -0.05)), 0.016, A, segs=6, rings=4, uv=town_uv('red'))
    mb.box((0, 0.008, -0.01), (0.044, 0.056, 0.115), A, bevel=0.016, bseg=1, rot=(10, 0, 0), uv=town_uv('purple'))
    mb.box((0, -0.175, 0.0), (0.036, 0.04, 0.1), A, bevel=0.014, bseg=1, rot=(-8, 0, 0), uv=town_uv('purple'))
    mb.box((0, -0.175, 0.052), (0.05, 0.05, 0.022), A, uv=town_uv('steel'))
    _trigger(mb, A, -0.002, uv=town_uv('ink'))
    ob = mb.to_object("wpn_smg", (0, 0, 0))
    empty("muzzle", (0, -0.31, 0.078), ob, size=0.04)
    empty("grip_l", (0, -0.175, -0.01), ob, size=0.04)
    return ob


def build_shotgun():
    """TRASH BLUNDERBUSS: plank stock, pipe barrel, duct tape, a bean-can bell mouth with a
    fork sticking out."""
    A = town_mat()
    mb = MB()
    tape = town_rect('label_tape')
    beans = town_rect('label_beans')
    mb.box((0, 0.13, 0.045), (0.05, 0.22, 0.075), A, bevel=0.012, bseg=1, rot=(-10, 0, 0), uv=town_uv('wood'))
    mb.box((0, 0.24, 0.026), (0.054, 0.03, 0.11), A, rot=(-10, 0, 0), uv=town_uv('brown'))
    mb.box((0, 0.028, -0.012), (0.042, 0.056, 0.11), A, bevel=0.015, bseg=1, rot=(14, 0, 0), uv=town_uv('wood'))
    mb.box((0, -0.03, 0.066), (0.056, 0.12, 0.06), A, bevel=0.016, bseg=1, uv=town_uv('wood'))
    mb.cylinder((0, 0.02, 0.078), (0, -0.39, 0.078), 0.021, A, segs=8, uv=town_uv('steel'))      # pipe
    for y0, y1 in ((0.03, -0.01), (-0.17, -0.235)):                                                # duct tape
        mb.cylinder((0, y0, 0.078), (0, y1, 0.078), 0.029, A, segs=8,
                    uv=('cyl', {'rect': tape}))
    mb.box((0, -0.2, 0.036), (0.034, 0.05, 0.05), A, uv=town_uv('steel'))                          # fore-grip clamp
    b0 = Vector((0, -0.37, 0.078))
    mb.lathe([(0.026, 0.0), (0.04, 0.03), (0.06, 0.08), (0.077, 0.13), (0.082, 0.136), (0.072, 0.136),
              (0.055, 0.09), (0.03, 0.03), (0.02, 0.01)], A, segs=9, c=b0, rot=align_z((0, -1, 0)),
             uv=('cyl', {'rect': beans}))
    mb.tube([b0 + Vector((0.083 * math.cos(2 * math.pi * k / 9), -0.134, 0.083 * math.sin(2 * math.pi * k / 9)))
             for k in range(9)], 0.006, A, sides=3, closed=True, uv=town_uv('silver'))
    fk = Vector((0.03, -0.47, 0.11))                                                               # the fork
    d = Vector((0.15, -1.0, 0.35)).normalized()
    mb.cylinder(fk - d * 0.07, fk + d * 0.03, 0.007, A, segs=5, uv=town_uv('chrome'))
    side = d.cross(Vector((0, 0, 1))).normalized()
    for k in range(3):
        o = side * (0.013 * (k - 1))
        mb.cylinder(fk + d * 0.03 + o, fk + d * 0.1 + o, 0.0035, A, segs=4, uv=town_uv('chrome'))
    _trigger(mb, A, -0.012, uv=town_uv('ink'))
    ob = mb.to_object("wpn_shotgun", (0, 0, 0))
    empty("muzzle", (0, -0.506, 0.078), ob, size=0.04)
    empty("grip_l", (0, -0.2, 0.01), ob, size=0.04)
    return ob


def build_grenade():
    """STINK BOMB: a green glass bottle, cork, a little stink-cloud label, wisps of stink."""
    G = tmat('StinkBomb', '#ffffff', 'atlas_chars', rough=0.35)
    mb = MB()
    mb.lathe([(0.0, -0.105), (0.05, -0.105), (0.058, -0.096), (0.06, -0.08), (0.06, 0.015), (0.052, 0.042),
              (0.03, 0.064), (0.022, 0.07), (0.022, 0.088), (0.027, 0.091), (0.027, 0.099), (0.02, 0.1), (0.0, 0.1)],
             G, segs=14, uv=const_uv('bottle'))
    mb.cylinder((0, 0, 0.09), (0, 0, 0.128), 0.021, G, segs=10, r1=0.026, bevel=0.004, uv=const_uv('cork'))
    stink = T.chars_print_rect('stink')
    rows = []
    for z in (-0.068, -0.02, 0.0):
        rows.append([Vector((0.063 * math.sin(a * D2R), -0.063 * math.cos(a * D2R), z)) for a in range(-60, 61, 15)])
    mb.surface(rows, [G] * 2, uv_fn=uvf_planar(stink, (-0.056, 0, -0.068), (1, 0, 0), (0, 0, 1), 0.112, 0.068),
               centre=(0, 0, -0.03), closed=False)
    mb.sphere((-0.03, -0.042, 0.0), (0.012, 0.008, 0.03), G, segs=6, rings=4, rot=(0, -20, 30), uv=const_uv('white'))
    for s_, ph in ((1, 0.0), (-1, 1.3)):
        pts = []
        for k in range(6):
            t = k / 5.0
            pts.append((s_ * (0.012 + 0.03 * math.sin(t * 4 + ph)), 0.0, 0.132 + 0.09 * t))
        mb.tube(pts, [0.009, 0.01, 0.009, 0.008, 0.006, 0.003], G, sides=4, uv=const_uv('leaf'))
    ob = mb.to_object("wpn_grenade", (0, 0, 0))
    empty("muzzle", (0, 0, 0), ob, size=0.04)
    return ob


def build_loot_can():
    """Battle-royale loot: a dented metal trash can; the `lid` flips open about X round its
    back hinge; a "?" sticker on the front, a fish bone poking out."""
    Metal = tmat('CanMetal', '#b6c8dc', 'metal', rough=0.45)
    A = town_mat()
    root = empty("loot_can", (0, 0, 0))
    mb = MB()
    prof = [(0, 0), (0.205, 0), (0.22, 0.02), (0.222, 0.06), (0.23, 0.07), (0.23, 0.09), (0.224, 0.1),
            (0.236, 0.32), (0.244, 0.33), (0.244, 0.35), (0.238, 0.36), (0.25, 0.58), (0.258, 0.59), (0.258, 0.61),
            (0.25, 0.62), (0.254, 0.665), (0.0, 0.665)]
    segs = 18
    rows = []
    for r, z in prof:
        if r < 1e-6:
            rows.append([(0.0, 0.0, z)])
            continue
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            dent = 1.0 - 0.07 * math.exp(-((a - 2.1) ** 2) / 0.12) * math.exp(-((z - 0.45) ** 2) / 0.012) \
                - 0.05 * math.exp(-((a - 4.6) ** 2) / 0.08) * math.exp(-((z - 0.2) ** 2) / 0.01)
            ring.append((r * dent * math.sin(a), -r * dent * math.cos(a), z))
        rows.append(ring)
    mb.grid(rows, Metal, wrap=True, recalc=True, uv=('box', 0.6))
    # "?" sticker on the front: a curved patch following the can (+4 mm)
    q = town_rect('loot_q')
    def can_r(z):
        for (r0, z0), (r1, z1) in zip(prof, prof[1:]):
            if z0 <= z <= z1 and z1 > z0:
                return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
        return 0.25
    srows = []
    for z in (0.39, 0.52):
        rr = can_r(z) + 0.005
        srows.append([Vector((rr * math.sin(a * D2R), -rr * math.cos(a * D2R), z)) for a in (-16, -8, 0, 8, 16)])
    mb.surface(srows, [A], uv_fn=uvf_planar(q, (-0.066, 0, 0.39), (1, 0, 0), (0, 0, 1), 0.132, 0.13),
               centre=(0, 0, 0.45), closed=False)
    # fish bone poking out under the lid (part of the can: stays put when the lid flips)
    fb = Vector((0.16, -0.12, 0.665))
    d = Vector((0.75, -0.55, 0.36)).normalized()
    mb.cylinder(fb - d * 0.05, fb + d * 0.2, 0.008, A, segs=5, uv=town_uv('cloud'))
    side = d.cross(Vector((0, 0, 1))).normalized()
    up = side.cross(d).normalized()
    for k in range(4):
        c = fb + d * (0.04 + 0.035 * k)
        L = 0.05 - 0.007 * k
        for sgn in (1, -1):
            mb.cylinder(c, c + up * L * sgn - d * 0.015, 0.0045, A, segs=4, uv=town_uv('cloud'))
    tail = fb - d * 0.05
    mb.lathe([(0.0, 0.0), (0.03, 0.035), (0.0, 0.03)], A, segs=4, c=tail, rot=align_z(-d), uv=town_uv('cloud'))
    head = fb + d * 0.22
    mb.sphere(head, (0.035, 0.022, 0.03), A, segs=8, rings=5, rot=d.to_track_quat('X', 'Z').to_matrix(),
              uv=town_uv('cloud'))
    mb.sphere(head + d * 0.012 + up * 0.012 + side * 0.012, 0.007, A, segs=5, rings=3, uv=town_uv('ink'))
    mb.to_object("can_body", (0, 0, 0), root)
    # the lid (pivot on the back edge of the rim)
    hinge = Vector((0.0, 0.262, 0.665))
    mb = MB()
    mb.lathe([(0.0, 0.66), (0.262, 0.66), (0.27, 0.672), (0.262, 0.685), (0.2, 0.72), (0.1, 0.742), (0.0, 0.746)],
             Metal, segs=18, uv=('box', 0.6))
    mb.tube([(-0.07, 0, 0.73), (-0.06, 0, 0.775), (0, 0, 0.795), (0.06, 0, 0.775), (0.07, 0, 0.73)], 0.016, Metal,
            sides=6, uv=('box', 0.6))
    mb.to_object("lid", hinge, root)
    return root


def build_food_pizza():
    """A pizza slice (~0.35 m long), flat, centred on its middle so it spins in place."""
    A = town_mat()
    mb = MB()
    tip = Vector((0, -0.2, 0.0))
    L, W = 0.33, 0.27
    pts = [tip]
    back = []
    for k in range(9):
        a = -1 + 2 * k / 8
        back.append(Vector((a * W / 2, -0.2 + L - 0.035 * (1 - a * a), 0.0)))
    # cheese top + under-crust: a thin slab
    top = [[tip + Vector((0, 0, 0.012))]] + [[b * t + tip * (1 - t) + Vector((0, 0, 0.012 + 0.006 * math.sin(t * 7 + k)))
                                               for k, b in enumerate(back)] for t in (0.35, 0.7, 1.0)]
    bot = [[b + Vector((0, 0, -0.012)) for b in back], [tip + Vector((0, 0, -0.012))]]
    mb.surface(top, [A] * 3, uv_fn=lambda i, co, r, u, j: tuple(T.swatch_uv('lemon')), centre=(0, 0, -0.1), closed=False)
    mb.surface(bot, [A], uv_fn=lambda i, co, r, u, j: tuple(T.swatch_uv('caramel')), centre=(0, 0, 0.1), closed=False)
    for sgn in (1, -1):
        e = [tip + Vector((0, 0, 0.012)), back[0 if sgn < 0 else -1] + Vector((0, 0, 0.012))]
        side = [[e[0], e[1]], [e[0] - Vector((0, 0, 0.024)), e[1] - Vector((0, 0, 0.024))]]
        mb.surface(side, [A], uv_fn=lambda i, co, r, u, j: tuple(T.swatch_uv('apricot')),
                   centre=(-sgn * 0.3, 0.0, 0.0), closed=False)
    mb.tube([b + Vector((0, 0.01, 0.006)) for b in back], 0.03, A, sides=6, uv=town_uv('caramel'))     # crust
    for (x, y, r) in ((-0.045, 0.04, 0.03), (0.05, 0.02, 0.028), (0.0, -0.06, 0.024), (-0.02, 0.085, 0.022),
                      (0.065, 0.075, 0.02)):
        mb.cylinder((x, y, 0.014), (x, y, 0.024), r, A, segs=9, bevel=0.003, uv=town_uv('red'))
    mb.sphere((0.03, -0.12, 0.0), (0.012, 0.012, 0.03), A, segs=6, rings=4, uv=town_uv('lemon'))   # cheese drip
    return mb.to_object("food_pizza", (0, 0, 0))


def build_food_donut():
    """A pink-frosted donut with sprinkles (~0.3 m)."""
    A = town_mat()
    mb = MB()
    R, r = 0.105, 0.052
    rows = []
    for i in range(10):
        b = 2 * math.pi * i / 10
        rows.append([(math.cos(a) * (R + r * math.cos(b)), math.sin(a) * (R + r * math.cos(b)), r * math.sin(b) * 0.85)
                     for a in [2 * math.pi * k / 18 for k in range(18)]])
    mb.grid(rows, A, wrap=True, wrap_rows=True, recalc=True, uv=town_uv('tan'))
    # frosting: a shell over the top half with a wavy edge
    frows = []
    for i, b in enumerate((-0.15, 0.25, 0.8, 1.57, 2.35, 2.95, 3.3)):
        ring = []
        for k in range(18):
            a = 2 * math.pi * k / 18
            wav = 0.12 * math.sin(5 * a) * (1 if i in (0, 6) else 0)
            bb = b + (wav if i == 0 else (-wav if i == 6 else 0.0))
            rr = r + 0.008
            ring.append((math.cos(a) * (R + rr * math.cos(bb)), math.sin(a) * (R + rr * math.cos(bb)), rr * math.sin(bb) * 0.85))
        frows.append(ring)
    mb.grid(frows, A, wrap=True, recalc=False, uv=town_uv('hotpink'))
    rng_ = [0.37, 0.81, 0.13, 0.66, 0.29, 0.94, 0.52, 0.08, 0.71, 0.45, 0.19, 0.88, 0.6, 0.33, 0.77, 0.02]
    cols = ('white', 'yellow', 'sky', 'lime', 'violet')
    for k in range(16):
        a = 2 * math.pi * (k + rng_[k] * 0.6) / 16
        rr = R + r * (rng_[(k + 5) % 16] - 0.5) * 1.1
        c = Vector((math.cos(a) * rr, math.sin(a) * rr, r * 0.86 + 0.006))
        d = Vector((math.cos(a * 3 + k), math.sin(a * 3 + k), 0.0))
        mb.cylinder(c - d * 0.011, c + d * 0.011, 0.0045, A, segs=4, uv=town_uv(cols[k % 5]))
    return mb.to_object("food_donut", (0, 0, 0))


def build_coffee():
    """A coffee to go (~0.25 m, the zoomies): white paper cup, loud orange sleeve, dark lid with
    a sip slot, and three cartoon puffs of steam. Centred on its middle so it spins in place."""
    A = town_mat()
    mb = MB()
    # the cup tapers to its base; the lid's rim overhangs the top
    cup = [(0.0, -0.12), (0.06, -0.12), (0.064, -0.114), (0.083, 0.088), (0.086, 0.09)]
    mb.lathe(cup, A, segs=18, uv=town_uv('white'))
    r_at = lambda z: 0.064 + (z + 0.114) / 0.202 * 0.019
    mb.lathe([(r_at(-0.062) + 0.005, -0.062), (r_at(0.034) + 0.005, 0.034)], A, segs=18, uv=town_uv('orange'))
    lid = [(0.08, 0.084), (0.092, 0.088), (0.093, 0.1), (0.078, 0.111), (0.05, 0.118), (0.0, 0.12)]
    mb.lathe(lid, A, segs=18, uv=town_uv('chocolate'))
    mb.box((0, -0.06, 0.112), (0.034, 0.012, 0.012), A, bevel=0.004, bseg=1, rot=(-14, 0, 0), uv=town_uv('ink'))
    # steam: three puffs winding up off the lid
    for (x, y, z, r) in ((0.012, 0.01, 0.16, 0.026), (-0.016, 0.0, 0.205, 0.021), (0.01, -0.006, 0.243, 0.016)):
        mb.sphere((x, y, z), (r, r, r * 0.9), A, segs=8, rings=6, uv=town_uv('white'))
    return mb.to_object("coffee", (0, 0, 0))


def build_tombstone():
    """~0.8 m cartoon gravestone: R.I.P. plaque, a dirt mound, a flower, and a ringed
    raccoon tail poking out from behind (it's fine, he's fine)."""
    Stone = tmat('Stone', '#b9b3cc', 'stucco', rough=0.8)
    A = town_mat()
    mb = MB()
    W, D, H = 0.5, 0.13, 0.62
    prof = []
    for k in range(9):
        a = math.pi * k / 8
        prof.append((W / 2 * math.cos(a), 0.17 + H - W / 2 + (W / 2) * math.sin(a)))
    outline = [(W / 2, 0.12)] + prof + [(-W / 2, 0.12)]
    rows = []
    for y, s_ in ((-D / 2, 0.97), (-D / 2 - 0.0, 1.0), (D / 2, 1.0), (D / 2, 0.97)):
        rows.append([Vector((x * s_, y, (z - 0.12) * s_ + 0.12)) for x, z in outline])
    fr = [Vector((x * 0.94, -D / 2 - 0.012, (z - 0.12) * 0.94 + 0.12)) for x, z in outline]
    bk = [Vector((x * 0.94, D / 2 + 0.012, (z - 0.12) * 0.94 + 0.12)) for x, z in outline]
    cf = sum(fr, Vector((0, 0, 0))) / len(fr)
    cb = sum(bk, Vector((0, 0, 0))) / len(bk)
    mb.surface([[cf], fr] + rows + [bk, [cb]], [Stone] * 7, centre=(0, 0, 0.45),
               uv_fn=lambda i, co, r, u, j: ((co.x + 0.3) / 0.6, (co.z - 0.1) / 0.6))
    plaque = town_rect('rip_plaque')
    pz, pw, ph = 0.47, 0.34, 0.17
    prow = [[Vector((x, -D / 2 - 0.016, pz - ph / 2)) for x in (-pw / 2, pw / 2)],
            [Vector((x, -D / 2 - 0.016, pz + ph / 2)) for x in (-pw / 2, pw / 2)]]
    mb.surface(prow, [A], uv_fn=uvf_planar(plaque, (-pw / 2, 0, pz - ph / 2), (1, 0, 0), (0, 0, 1), pw, ph),
               centre=(0, 0.2, pz), closed=False)
    mb.superellipsoid((0, -0.02, 0.05), (0.42, 0.3, 0.12), A, segs=14, rings=6, e_lat=0.7, uv=town_uv('chocolate'),
                      extra=lambda q: (q.x, q.y, max(q.z, -0.4)))
    mb.cylinder((0.27, -0.2, 0.08), (0.27, -0.2, 0.25), 0.008, A, segs=4, uv=town_uv('leaf'))
    flower(mb, (0.27, -0.205, 0.26), (0, -0.4, 1), 0.05, A, A, thick=0.015, uv_petal=town_uv('hotpink'),
           uv_center=town_uv('yellow'))
    # bushy ringed tail sticking up out of the mound behind the stone: ONE closed tube (rings
    # are bands of its own faces, no stacked end caps that could z-fight)
    ctrl = [Vector((-0.2, 0.12, 0.05)), Vector((-0.34, 0.09, 0.18)), Vector((-0.43, 0.02, 0.33)),
            Vector((-0.42, -0.06, 0.47)), Vector((-0.34, -0.11, 0.56))]
    path = C.catmull_path(ctrl, 3)
    nrm = len(path)
    rad = [0.05 + 0.03 * math.sin(math.pi * min(1.0, k / (nrm - 1) * 1.15)) for k in range(nrm)]
    rows = C.tube_rows(path, rad, 9)
    t0 = path[0] - (path[1] - path[0]).normalized() * 0.03
    t1 = path[-1] + (path[-1] - path[-2]).normalized() * 0.045
    rows = [[t0]] + rows + [[t1]]
    ring_cols = []
    for i in range(len(rows) - 1):
        k = max(0, min(nrm - 2, i - 1))
        ring_cols.append('raccoon_dark' if (k // 2) % 2 == 1 or i >= len(rows) - 3 else 'silver')
    mb.surface(rows, [A] * (len(rows) - 1), recalc=True,
               uv_fn=lambda i, co, r, u, j: tuple(T.swatch_uv(ring_cols[i])))
    return mb.to_object("tombstone", (0, 0, 0))


def build_crown():
    """HUD / pickup crown (~0.25 m), the same look as the raccoon's acc_crown."""
    Gold = mat("Gold", "#ffc94d", 0.3, metallic=0.35)
    AccTrim = tmat("AccTrim", "#ffffff", "atlas_chars", rough=0.6)
    mb = MB()
    crown_geom(mb, Gold, AccTrim, (0, 0, 0.0), r=0.115, h=0.075, spike=0.08, gem_r=0.022, segs=20, wall=0.016)
    return mb.to_object("crown", (0, 0, 0))


# =============================================================================
# GULL (knocked-out players fly around as one) + MANHOLE (the sewer's doors)
# Both use the one AtlasTown material (palette swatch UVs); the manhole's hole adds 'SewerHole'
# (the same atlas recipe, a green-grey factor).  Authored in glTF coordinates (+Y up, +Z =
# the model's front, +X = its left): gv() converts to Blender.
# =============================================================================
def gv(x, y, z):
    """glTF (x, y, z) -> Blender Vector (x, -z, y)."""
    return Vector((x, -z, y))


def swatch_rows(mb, rows, m, col, closed=True, wrap_rows=False, centre=None):
    """Faces between consecutive rows of points (one-point rows = poles; `closed` wraps each
    row, `wrap_rows` joins the last row to the first), every face a constant atlas_town
    palette swatch: col = a swatch name, or col(i, j) -> name for band i, face column j.
    Faces point away from `centre` (Blender point; the surface must be star-shaped round it),
    else bmesh orients them (closed surfaces)."""
    tb = bmesh.new()
    uvl = tb.loops.layers.uv.new(C.UV_NAME)
    vrows = [[tb.verts.new(Vector(p)) for p in row] for row in rows]
    cache = {}

    def uv(i, j):
        name = col if isinstance(col, str) else col(i, j)
        if name not in cache:
            cache[name] = tuple(T.swatch_uv(name))
        return cache[name]
    c = Vector(centre) if centre is not None else None
    nr = len(vrows)
    for i in list(range(nr - 1)) + ([nr - 1] if wrap_rows else []):
        A_, B_ = vrows[i], vrows[(i + 1) % nr]
        n = max(len(A_), len(B_))
        for j in range(n if closed else n - 1):
            j1 = (j + 1) % n
            if len(A_) == 1 and len(B_) == 1:
                continue
            if len(A_) == 1:
                vs = [A_[0], B_[j1], B_[j]]
            elif len(B_) == 1:
                vs = [A_[j], A_[j1], B_[0]]
            else:
                vs = [A_[j], A_[j1], B_[j1], B_[j]]
            if c is not None:
                cos = [v.co for v in vs]
                nrm = Vector((0, 0, 0))
                for k in range(len(cos)):
                    nrm += cos[k].cross(cos[(k + 1) % len(cos)])
                mid = sum(cos, Vector((0, 0, 0))) / len(cos)
                if nrm.dot(mid - c) < 0:
                    vs.reverse()
            try:
                f = tb.faces.new(vs)
            except ValueError:
                continue
            for l in f.loops:
                l[uvl].uv = uv(i, j)
    mb._commit(tb, m, None, True, centre is None, uv_pre=True)


def lathe_rows(prof, segs, M=None, phase=0.0):
    """Rings of a lathe (local Z axis) for profile [(r, z)] (r = 0: a pole), transformed by M."""
    M = M or Matrix.Identity(4)
    out = []
    for r, z in prof:
        if r < 1e-7:
            out.append([M @ Vector((0.0, 0.0, z))])
        else:
            out.append([M @ Vector((r * math.cos(2 * math.pi * k / segs + phase),
                                    r * math.sin(2 * math.pi * k / segs + phase), z)) for k in range(segs)])
    return out


def surface_frame(n):
    """3x3 rotation taking local -Y to the outward normal n (Blender) and local +Z as close to
    world up as possible: ellipsoids / domes sitting on a curved surface."""
    n = Vector(n).normalized()
    yl = -n
    zl = Vector((0, 0, 1)) - n * n.z
    zl = zl.normalized() if zl.length > 1e-6 else Vector((0, 1, 0))
    xl = yl.cross(zl)
    return Matrix((xl, yl, zl)).transposed()


# rig pivots (glTF, contract.json)
GULL_BODY = (0.0, 0.32, 0.0)
GULL_NECK = (0.0, 0.44, 0.2)
GULL_SHOULDER = (0.13, 0.38, 0.02)
GULL_ELBOW = (0.5, 0.39, 0.0)
GULL_TAIL = (0.0, 0.33, -0.24)
GULL_HIP = (0.07, 0.2, 0.0)
GULL_CARRY = (0.0, 0.0, 0.05)
GULL_HEAD_C = Vector((0.0, 0.575, 0.13))     # head centre / radii (glTF)
GULL_HEAD_R = (0.15, 0.145, 0.15)
# airfoil chord stations, leading edge (0) -> trailing edge (1); top surface then bottom
GULL_U = (0.0, 0.035, 0.12, 0.27, 0.46, 0.66, 0.84, 1.0)
GULL_U_TIP = (0.0, 0.08, 0.35, 0.7, 1.0)
_HNORM = 1.0 / max(math.sqrt(u / 400.0) * (1 - u / 400.0) ** 0.6 for u in range(401))


def _ring_order(us):
    return [(u, 1) for u in us] + [(u, -1) for u in reversed(us[1:-1])]


def airfoil_ring(x, le, te, yc, th, camber, us):
    """A wing section at span x (glTF): chord from z = le to te, mid-height yc, half
    thickness th (rounded leading edge, thin trailing edge), arched by `camber`."""
    pts = []
    for u, s in _ring_order(us):
        h = th * _HNORM * math.sqrt(u) * (1 - u) ** 0.6
        pts.append(gv(x, yc + camber * 4 * u * (1 - u) + s * h, le - u * (le - te)))
    return pts


def ring_umid(us):
    """Chord position (0..1) of each face column of an airfoil ring."""
    o = _ring_order(us)
    return [(o[j][0] + o[(j + 1) % len(o)][0]) / 2 for j in range(len(o))]


def gull_wing(side):
    """Inner wing (shoulder -> elbow) and wing tip rows for side +1 (left, +X) / -1."""
    us = GULL_U
    inner = []
    xs = (0.08, 0.13, 0.2, 0.28, 0.36, 0.43, 0.49, 0.52)
    for x in xs:
        t = (x - 0.08) / 0.44
        le = 0.118 - 0.038 * t + 0.012 * math.sin(math.pi * t)       # a soft bulge toward the wrist
        te = -0.215 + 0.065 * t - 0.012 * math.sin(math.pi * t)      # the arm's trailing edge curves
        inner.append(airfoil_ring(side * x, le, te, 0.38 + 0.01 * t, 0.042 - 0.019 * t, 0.012, us))
    t = 1.0
    root = gv(side * 0.06, 0.38, -0.045)
    end = gv(side * 0.535, 0.39, -0.035)
    inner = [[root]] + inner + [[end]]
    # wing tip: grey hand, then black primaries ending in three rounded feather tips
    tip = []
    xs_t = (0.49, 0.53, 0.57, 0.605, 0.621, 0.637, 0.653, 0.669, 0.685, 0.701, 0.717, 0.733, 0.749, 0.765, 0.781,
            0.795)
    sec = []
    for x in xs_t:
        s = max(0.0, (x - 0.5) / 0.31)
        mid = -0.035 - 0.085 * s ** 1.6
        chord = 0.226 * (1.0 - 0.7 * s ** 1.5) * math.sqrt(max(0.0, 1.0 - s * s))
        bump = 0.0
        if x > 0.6:                     # three primaries, their rounded ends sticking out behind
            ph = ((x - 0.605) / 0.064) % 1.0
            bump = math.sin(math.pi * ph) ** 0.8
        le, te = mid + chord / 2, mid - chord / 2 - 0.02 * bump
        th = 0.021 - 0.011 * s
        yc = 0.39 - 0.01 * s * s
        tip.append(airfoil_ring(side * x, le, te, yc, th, 0.006, GULL_U_TIP))
        sec.append((x, le, te, yc, th))
    tip = [[gv(side * 0.47, 0.39, -0.035)]] + tip + [[gv(side * 0.812, 0.38, -0.12)]]
    return inner, tip, sec


def build_gull():
    """Cartoon chibi SEAGULL (~0.7 m beak to tail, 1.6 m span, wings spread flat in a glide):
    a round white body, a big head with mischievous eyes under cross brows, a thick yellow beak
    with the red spot, grey wings with black feather tips (white spots), a white tail with a grey
    edge, orange webbed feet.  Rig (glTF pivots in contract.json): body > head, wing_l >
    wingtip_l, wing_r > wingtip_r, tail, leg_l, leg_r (one mesh), carry_socket.  Wings and tips
    flap / fold about their local Z (rotation.z > 0 lifts the left wing, < 0 the right)."""
    A = town_mat()
    sw = town_uv
    root = empty("gull", (0, 0, 0))

    # ---- body: a round white egg, tapering up into the tail -----------------------------
    def body_deform(v):
        x, y, z = v.x, v.y, v.z           # unit sphere, Blender (+y = back)
        if y > 0:
            k = 1.0 - 0.3 * y * y
            return (x * k, y, z * k + 0.25 * y * y)
        k = 1.0 + 0.05 * y * y
        return (x * k, y, z * k)
    mb = MB()
    mb.sphere(gv(0, 0.33, -0.035), (0.175, 0.235, 0.165), A, segs=16, rings=10, deform=body_deform, uv=sw('white'))
    body = mb.to_object("body", gv(*GULL_BODY), root)

    # ---- head: big white ball, eyes, brows, beak -----------------------------------------
    Hc, HR = GULL_HEAD_C, GULL_HEAD_R

    def hdir(az, el):          # glTF unit direction from the head centre (az > 0 toward +X)
        a, e = math.radians(az), math.radians(el)
        return Vector((math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)))

    def hsurf(az, el, add=0.0):
        d = hdir(az, el)
        p = Hc + Vector((d.x * HR[0], d.y * HR[1], d.z * HR[2]))
        return gv(*(p + d * add)), gv(*d) - gv(0, 0, 0)
    mb = MB()
    mb.sphere(gv(*Hc), (HR[0], HR[2], HR[1]), A, segs=14, rings=9, uv=sw('white'))
    for s in (1, -1):
        # eye: an ink rim (eyeliner) round a white ball, a big pupil glancing to the gull's
        # left (shifty), a shine dot
        p, n = hsurf(s * 30, 13)
        R = surface_frame(n)
        ec = p - n * 0.016
        mb.sphere(ec, (0.058, 0.03, 0.071), A, segs=10, rings=7, rot=R, uv=sw('ink'))
        mb.sphere(ec, (0.052, 0.036, 0.065), A, segs=10, rings=7, rot=R, uv=sw('white'))
        u, v = 0.014, 0.004
        dz = 0.036 * math.sqrt(max(0.0, 1 - (u / 0.052) ** 2 - (v / 0.065) ** 2))
        pc = ec + R @ Vector((u, 0, v)) + n * (dz - 0.007)
        mb.sphere(pc, (0.026, 0.013, 0.033), A, segs=8, rings=5, rot=R, uv=sw('ink'))
        mb.sphere(pc + n * 0.011 + R @ Vector((-0.01, 0, 0.014)), (0.009, 0.004, 0.009), A, segs=5, rings=3, rot=R,
                  uv=sw('white'))
        # brow: thick ink bar, its inner end pulled down (cross / up to no good); the right
        # one (s < 0) a touch higher on the outside: a sly, lopsided scowl
        p0, _ = hsurf(s * 8, 30, 0.004)
        p1, _ = hsurf(s * 47, 39 + (4 if s < 0 else 0), 0.002)
        mb.capsule(p0, p1, 0.019, A, r1=0.015, segs=6, hemi=2, uv=sw('ink'))
    # beak: upper mandible (a slightly flattened cone, hooked tip), lower one with the red spot
    def beak(b0, b1, prof, scale, cols):
        d = (gv(*b1) - gv(*b0))
        L = d.length
        M = C.xform(gv(*b0), align_z(d), scale)
        rows = lathe_rows([(r, z * L) for r, z in prof], 12, M)
        swatch_rows(mb, rows, A, lambda i, j: cols[min(i, len(cols) - 1)], centre=gv(*b0) + d * 0.4)
    beak((0, 0.55, 0.21), (0, 0.515, 0.405),
         [(0.0, 0.0), (0.062, 0.02), (0.066, 0.2), (0.057, 0.45), (0.041, 0.7), (0.025, 0.88), (0.012, 0.96), (0.0, 1.0)],
         (1.0, 0.86, 1.0), ['yellow'])
    mb.sphere(gv(0, 0.5, 0.387), (0.019, 0.024, 0.025), A, segs=8, rings=5, uv=sw('yellow'))     # the hook
    beak((0, 0.506, 0.215), (0, 0.49, 0.37),
         [(0.0, 0.0), (0.05, 0.03), (0.05, 0.3), (0.043, 0.58), (0.037, 0.66), (0.03, 0.86), (0.015, 0.95), (0.0, 1.0)],
         (1.0, 0.7, 1.0), ['yellow'])
    for s in (1, -1):                                                 # the red spot, both sides
        mb.sphere(gv(s * 0.027, 0.481, 0.34), (0.008, 0.017, 0.011), A, segs=8, rings=4, uv=sw('red'))
    head = mb.to_object("head", gv(*GULL_NECK), body)

    # ---- wings + tips -------------------------------------------------------------------
    umid = ring_umid(GULL_U)
    umid_t = ring_umid(GULL_U_TIP)
    wing_nodes = {}
    for side, sfx in ((1, "l"), (-1, "r")):
        inner, tip, sec = gull_wing(side)
        mb = MB()
        nin = len(inner) - 1
        swatch_rows(mb, inner, A, lambda i, j: 'white' if (0 < i < nin - 1 and umid[j % len(umid)] > 0.83) else 'steel')
        sh = (side * GULL_SHOULDER[0], GULL_SHOULDER[1], GULL_SHOULDER[2])
        wing = mb.to_object("wing_" + sfx, gv(*sh), body)
        mb = MB()
        xs_t = [s_[0] for s_ in sec]

        def tip_col(i, j, xs_t=xs_t):
            # band i lies between rows i and i+1 (row 0 = the root pole)
            x = xs_t[min(max(i - 1, 0), len(xs_t) - 1)] if i > 0 else 0.0
            if i == 0 or x < 0.6:
                return 'white' if (i > 0 and umid_t[j % len(umid_t)] > 0.8) else 'steel'
            return 'ink'
        swatch_rows(mb, tip, A, tip_col)
        # white "mirror" spots on two black feathers, top and bottom
        for (x, r) in ((0.701, 0.018), (0.765, 0.02)):
            k = min(range(len(sec)), key=lambda q: abs(sec[q][0] - x))
            _, le, te, yc, th = sec[k]
            z = (le + te) / 2 + 0.01
            h = th * _HNORM * math.sqrt(0.5) * 0.5 ** 0.6
            for sgn in (1, -1):
                yy = yc + 0.006 + sgn * (h - 0.0015)
                mb.sphere(gv(side * x, yy, z), (r, r * 0.9, 0.0045), A, segs=8, rings=3, uv=sw('white'))
        el = (side * GULL_ELBOW[0], GULL_ELBOW[1], GULL_ELBOW[2])
        tipob = mb.to_object("wingtip_" + sfx, gv(*el), wing)
        wing_nodes[sfx] = (wing, tipob)

    # ---- tail: a white fan with a grey edge ------------------------------------------------
    zs = (-0.15, -0.205, -0.26, -0.3, -0.33, -0.352)
    ws = (0.05, 0.085, 0.11, 0.12, 0.112, 0.08)
    ts = (0.045, 0.034, 0.024, 0.017, 0.013, 0.01)
    ys = (0.31, 0.33, 0.345, 0.355, 0.36, 0.364)
    rows = [[gv(0, 0.3, -0.12)]]
    for z, w, t, y in zip(zs, ws, ts, ys):
        rows.append([gv(w * math.cos(2 * math.pi * k / 12), y + t * math.sin(2 * math.pi * k / 12), z) for k in range(12)])
    rows.append([gv(0, 0.366, -0.364)])
    mb = MB()
    swatch_rows(mb, rows, A, lambda i, j: 'steel' if i >= 4 else 'white')
    mb.to_object("tail", gv(*GULL_TAIL), body)

    # ---- legs: orange stick + webbed foot (one mesh, both legs) ---------------------------
    lx = GULL_HIP[0]
    mb = MB()
    mb.capsule(gv(lx, 0.03, 0.012), gv(lx, 0.215, 0.0), 0.02, A, r1=0.022, segs=7, hemi=2, uv=sw('orange'))
    toes = [(0, -0.03), (0.024, -0.02), (0.045, 0.025), (0.062, 0.07), (0.058, 0.09), (0.042, 0.083),
            (0.026, 0.066), (0.01, 0.092), (0, 0.105), (-0.01, 0.092), (-0.026, 0.066), (-0.042, 0.083),
            (-0.058, 0.09), (-0.062, 0.07), (-0.045, 0.025), (-0.024, -0.02)]
    cz = 0.02
    frows = []
    for s_, y in ((0.0, 0.0), (0.93, 0.004), (1.0, 0.011), (0.82, 0.02), (0.0, 0.024)):
        if s_ <= 0:
            frows.append([gv(lx, y, cz)])
        else:
            frows.append([gv(lx + x * s_, y, cz + (z - cz) * s_) for x, z in toes])
    swatch_rows(mb, frows, A, 'orange', centre=gv(lx, 0.012, cz))
    leg_l = mb.to_object("leg_l", gv(*GULL_HIP), body)
    share(leg_l, "leg_r", gv(-GULL_HIP[0], GULL_HIP[1], GULL_HIP[2]), body)
    empty("carry_socket", gv(*GULL_CARRY), body, size=0.05)
    return root


MANHOLE_HOLE_Y = 0.005


def build_manhole():
    """Street manhole, flush with the road: `frame` (iron ring r 0.44..0.52, 2 cm), `hole` (a
    disc at y 0.005 painted as a shaft going down: green-grey rings darkening to black, the top
    rungs of a ladder on the far side, 'SewerHole' = the atlas recipe x a green-grey factor; the
    game shows it only while the lid is off) and `lid` (cast iron r 0.45, y 0.008..0.047, its
    node at the centre of its underside): a worn raised rim, a ring of studs, a raccoon paw."""
    A = town_mat()
    Sewer = tmat("SewerHole", "#b0d0a0", "atlas_town", rough=0.9)
    sw = town_uv
    root = empty("manhole", (0, 0, 0))
    # frame: closed ring profile (r, y)
    prof = [(0.44, 0.0), (0.44, 0.014), (0.452, 0.02), (0.505, 0.02), (0.52, 0.007), (0.52, 0.0)]
    cols = ['rubber', 'charcoal', 'slate', 'charcoal', 'rubber', 'rubber']
    mb = MB()
    swatch_rows(mb, lathe_rows(prof, 20), A, lambda i, j: cols[i], wrap_rows=True)
    mb.to_object("frame", (0, 0, 0), root)
    # hole: concentric bands, lit wall at the rim down to black
    y = MANHOLE_HOLE_Y
    radii = (0.44, 0.405, 0.35, 0.28, 0.19, 0.09, 0.0)
    hcols = ('grey', 'slate', 'charcoal', 'rubber', 'ink', 'ink')
    mb = MB()
    swatch_rows(mb, lathe_rows([(r, y) for r in radii], 20), Sewer, lambda i, j: hcols[i], centre=(0, 0, -1))
    # the ladder on the far side (Blender +Y = glTF -Z, north: where the game camera looks)
    yy = y + 0.004

    def flat(pts, swn):
        swatch_rows(mb, [[Vector((pts[0][0], pts[0][1], yy)), Vector((pts[1][0], pts[1][1], yy))],
                         [Vector((pts[3][0], pts[3][1], yy)), Vector((pts[2][0], pts[2][1], yy))]],
                    Sewer, swn, closed=False, centre=(0, 0, -1))

    def rail_x(r):                       # rails converge as they go down
        return 0.105 - (0.43 - r) * (0.035 / 0.23)
    for sx in (1, -1):
        for (r0, r1, c_) in ((0.43, 0.31, 'silver'), (0.31, 0.2, 'slate')):
            x0, x1 = rail_x(r0), rail_x(r1)
            w0, w1 = 0.011, 0.008
            flat([(sx * (x0 - w0), r0), (sx * (x0 + w0), r0), (sx * (x1 + w1), r1), (sx * (x1 - w1), r1)], c_)
    for (r, t, c_) in ((0.395, 0.024, 'silver'), (0.325, 0.019, 'grey'), (0.268, 0.015, 'slate'),
                       (0.224, 0.012, 'charcoal')):
        hw = rail_x(r) + 0.012
        flat([(-hw, r - t / 2), (hw, r - t / 2), (hw, r + t / 2), (-hw, r + t / 2)], c_)
    mb.to_object("hole", (0, 0, 0), root)
    # lid
    lid_y = 0.008
    prof = [(0.0, lid_y), (0.43, lid_y), (0.45, 0.016), (0.45, 0.038), (0.444, 0.046), (0.40, 0.046), (0.392, 0.041),
            (0.0, 0.041)]
    lcols = ['rubber', 'charcoal', 'charcoal', 'slate', 'slate', 'charcoal', 'rubber']
    mb = MB()
    swatch_rows(mb, lathe_rows(prof, 20), A, lambda i, j: lcols[i])
    for k in range(10):                                    # a ring of studs
        a = 2 * math.pi * (k + 0.5) / 10
        c = Vector((0.325 * math.cos(a), 0.325 * math.sin(a), 0.0))
        rows = lathe_rows([(0.024, 0.039), (0.018, 0.05), (0.0, 0.054)], 6, Matrix.Translation(c))
        swatch_rows(mb, rows, A, 'grey', centre=c + Vector((0, 0, 0.03)))
    # the paw: a big pad and four toe beans (toes to the front, glTF +Z = Blender -Y)
    pads = [((0.0, 0.035), 0.092, 0.076, 0.012)] + \
        [((x, -yv), 0.04, 0.045, 0.011) for x, yv in ((-0.118, 0.048), (-0.046, 0.112), (0.046, 0.112), (0.118, 0.048))]
    for (px, py), rx, ry, h in pads:
        c = Vector((px, py, 0.0))
        M = Matrix.Translation(c) @ Matrix.Diagonal((rx, ry, 1.0, 1.0))
        rows = lathe_rows([(1.0, 0.039), (0.82, 0.041 + h * 0.8), (0.0, 0.041 + h * 1.08)], 9, M)
        swatch_rows(mb, rows, A, 'grey', centre=c + Vector((0, 0, 0.03)))
    for sx in (1, -1):                                     # pry slots in the rim
        mb.box((sx * 0.422, 0, 0.0465), (0.04, 0.014, 0.004), A, uv=sw('ink'))
    mb.to_object("lid", (0, 0, lid_y), root)
    return root


ASSETS = [
    ("raccoon", build_raccoon),
    ("human", build_human),
    ("wpn_pistol", build_pistol),
    ("wpn_smg", build_smg),
    ("wpn_shotgun", build_shotgun),
    ("wpn_grenade", build_grenade),
    ("tree_round", build_tree_round),
    ("tree_pine", build_tree_pine),
    ("bush", build_bush),
    ("lamp", build_lamp),
    ("billboard", lambda: build_billboard("billboard")),
    ("billboard_roof", lambda: build_billboard("billboard_roof")),
    ("hydrant", build_hydrant),
    ("bench", build_bench),
    ("drum", build_drum),
    ("cone", build_cone),
    ("trashcan", build_trashcan),
    ("crossing_sign", build_crossing_sign),
    ("crossing_barrier", build_crossing_barrier),
    ("fountain", build_fountain),
    ("flowerbed", build_flowerbed),
    ("fx_star", build_fx_star),
    ("loot_can", build_loot_can),
    ("food_pizza", build_food_pizza),
    ("food_donut", build_food_donut),
    ("coffee", build_coffee),
    ("tombstone", build_tombstone),
    ("crown", build_crown),
    ("gull", build_gull),
    ("manhole", build_manhole),
]

BUDGET = {"raccoon": 4500, "human": 9000, "wpn_": 600}


def budget_for(name):
    if name == "raccoon":
        # most of it is accessories, and only the few a look wears are drawn
        return 7000
    if name == "human":
        return 9000
    if name.startswith("wpn_"):
        return 600
    if name == "trashcan":   # a hiding place: lid, trash inside, the peeking hider
        return 1800
    if name.startswith("billboard"):   # the frame, a pole or legs, a catwalk, three lamps
        return 2500
    if name == "gull":   # a flying player (about a raccoon's worth): lofted wings, eyes, beak, webbed feet
        return 3500
    return 1200


# =============================================================================
# VERIFICATION + PREVIEWS
# =============================================================================
import_glb = C.import_glb  # shared with build_icons.py (lives in common_cp)


def base(o):
    return o.name.split('.')[0]


CONTRACT_PATH = os.path.join(ROOT, "assets-src", "contract.json")
POSES_PATH = os.path.join(ROOT, "assets-src", "poses.json")
SHARED_PAIRS = {"raccoon": [("ear_l", "ear_r"), ("arm_l", "arm_r"), ("forearm_l", "forearm_r"), ("leg_l", "leg_r"),
                            ("foot_l", "foot_r")],
                "human": [("arm_l", "arm_r"), ("forearm_l", "forearm_r"), ("leg_l", "leg_r"), ("foot_l", "foot_r")]}


def g2b(p):
    """glTF (x, y, z) -> Blender (x, -z, y)."""
    return Vector((p[0], -p[2], p[1]))


def verify(names):
    """Re-import every exported GLB: contract nodes + pivots (assets-src/contract.json, 1 mm),
    identity rest rotation / unit scale on every node, shared left/right meshes, and no
    acc_* / hair_* names below an accessory node."""
    print("\n=== VERIFY: re-import exported GLBs ===")
    contract = {}
    if os.path.isfile(CONTRACT_PATH):
        with open(CONTRACT_PATH, encoding="utf-8") as f:
            contract = json.load(f).get("models", {})
    ok = True
    for name in names:
        C.reset_scene()
        path = os.path.join(MODELS, name + ".glb")
        new, roots = import_glb(path)
        bpy.context.view_layer.update()
        lo, hi = C.gltf_bounds(new)
        print("[%s] roots=%s nodes=%d tris=%d bbox(glTF) min=%s max=%s" % (
            name, [r.name for r in roots], len(new), C.tri_count(new), lo, hi))
        byname = {}
        for o in new:
            byname.setdefault(base(o), o)
        want = contract.get(name, {})
        if len(roots) != 1:
            print("  !! expected one root node, got", [r.name for r in roots])
            ok = False
        req = list(want.get("nodes", []))
        for r in req:
            if r not in byname:
                print("  !! missing node", r)
                ok = False
        for k, v in want.get("pivots", {}).items():
            if k in byname:
                w = byname[k].matrix_world.translation
                if (w - g2b(v)).length > 1e-3:
                    print("  !! pivot mismatch %s: %s != contract %s" % (k, tuple(round(c, 4) for c in w), v))
                    ok = False
        for o in new:
            M3 = o.matrix_world.to_3x3()
            if max(abs(M3[i][j] - (1.0 if i == j else 0.0)) for i in range(3) for j in range(3)) > 1e-4:
                print("  !! non-identity rest rotation/scale on", o.name)
                ok = False
        for a, b in SHARED_PAIRS.get(name, []):
            if a in byname and b in byname and byname[a].data != byname[b].data:
                print("  !! %s / %s do not share one mesh" % (a, b))
                ok = False
        for o in new:
            if base(o).startswith(("acc_", "hair_")):
                for d in o.children_recursive:
                    if base(d).startswith(("acc_", "hair_")):
                        print("  !! accessory %s has a child named %s" % (base(o), base(d)))
                        ok = False
    print("=== VERIFY %s ===\n" % ("OK" if ok else "FAILED"))
    return ok


def _scene(res):
    C.reset_scene()
    for w in list(bpy.data.worlds):
        pass
    sc = C.setup_render(res)
    C.add_sun((-0.45, 0.75, -1.0), 3.2)
    C.add_ground()
    return sc


def preview_props():
    big = ["tree_round", "tree_pine", "lamp", "crossing_sign", "crossing_barrier", "fountain"]
    small = ["bush", "hydrant", "bench", "drum", "cone", "trashcan", "flowerbed", "fx_star"]
    for group, fname, res, vd in ((big, "props_large.png", (1600, 760), (0.25, 1, -0.4)),
                                  (small, "props_small.png", (1600, 640), (0.25, 1, -0.5))):
        _scene(res)
        allobjs = []
        x = 0.0
        for nm in group:
            new, roots = import_glb(os.path.join(MODELS, nm + ".glb"))
            bpy.context.view_layer.update()
            lo, hi = C.gltf_bounds(new)
            wx = hi[0] - lo[0]
            for r in roots:
                r.location.x += x - lo[0]
                if nm == "fx_star":
                    r.location.z += 0.5
                if nm == "crossing_barrier":
                    r.location.y += 0.8
            x += wx + 0.35
            allobjs += new
            if nm == "crossing_barrier":
                # second copy with the arm raised (rotation about the hinge axis)
                new2, roots2 = import_glb(os.path.join(MODELS, nm + ".glb"))
                for r in roots2:
                    r.location.x = x - lo[0]
                    r.location.y += 2.0
                for o in new2:
                    if base(o) == "barrier_arm":
                        o.rotation_euler.y = -80 * D2R
                allobjs += new2
                x += 0.8
        bpy.context.view_layer.update()
        C.frame_camera(allobjs, vd, res, margin=1.06)
        C.render_to(os.path.join(PREVIEWS, fname))


def preview_billboards():
    """Both billboards from the front and from behind (the picture is painted by the game, so the
    faces are plain white here)."""
    for fname, vd in (("billboards.png", (0.35, 1, -0.3)), ("billboards_back.png", (-0.35, -1, -0.3))):
        _scene((1600, 760))
        allobjs = []
        x = 0.0
        for nm in ("billboard", "billboard_roof"):
            new, roots = import_glb(os.path.join(MODELS, nm + ".glb"))
            bpy.context.view_layer.update()
            lo, hi = C.gltf_bounds(new)
            for r in roots:
                r.location.x += x - lo[0]
            x += hi[0] - lo[0] + 1.5
            allobjs += new
        bpy.context.view_layer.update()
        C.frame_camera(allobjs, vd, (1600, 760), margin=1.06)
        C.render_to(os.path.join(PREVIEWS, fname))


def load_model(name, loc=(0, 0, 0), rz=0.0, scale=1.0, pose=None, colors=None, show=(), expr=0,
               body=None, pattern=0):
    """Import a model for a preview: show only the accessories in `show`, recolour its
    materials (like the game), shift the Face UVs to an expression, pose the joints with
    game-side Euler rotations (glTF frame), and place it (rz = yaw in degrees).
    body: {'rot': [x, y, z], 'y': lift} = the game's whole-body transform (lying, ...)."""
    new, roots = import_glb(os.path.join(MODELS, name + ".glb"))
    root = roots[0]
    byname = {}
    for o in new:
        byname.setdefault(base(o), o)
    for o in new:
        b = base(o)
        if (b.startswith("acc_") or b.startswith("hair_")) and b not in show:
            for d in [o] + list(o.children_recursive):
                d.hide_render = True
    if colors:
        C.recolor_objects(new, colors)
    if expr:
        C.shift_material_uvs(new, "Face", (expr % 4) * 0.125, (expr // 4) * 0.25)
    if pattern:
        C.shift_material_uvs(new, "Shirt", pattern * 0.125, 0.0)
    for j, rot in (pose or {}).items():
        if j in byname:
            C.set_game_rotation(byname[j], rot)
    root.rotation_mode = 'QUATERNION'
    q = Matrix.Rotation(rz * D2R, 3, 'Z').to_quaternion()
    lift = 0.0
    if body:
        q = q @ C.game_euler_to_bl(*body.get('rot', (0, 0, 0)))
        lift = body.get('y', 0.0)
    root.rotation_quaternion = q
    root.location = Vector(loc) + Vector((0, 0, lift * scale))
    root.scale = (scale, scale, scale)
    return new, root


def _label(text, loc, size=0.12):
    cu = bpy.data.curves.new("lbl_" + text, 'FONT')
    cu.body = text
    cu.size = size
    cu.align_x = 'CENTER'
    ob = bpy.data.objects.new("lbl_" + text, cu)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    m = bpy.data.materials.new("_lbl")
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (0.05, 0.05, 0.08, 1)
    cu.materials.append(m)
    return ob


def preview_grid(names, fname, cols, res, vd=(0.0, 1, -0.32)):
    """Each asset normalised to a ~1 unit cell (for detail inspection), labelled."""
    C.reset_scene()
    C.setup_render(res)
    C.add_sun((-0.45, 0.75, -1.0), 3.2)
    allobjs = []
    for i, nm in enumerate(names):
        new, roots = import_glb(os.path.join(MODELS, nm + ".glb"))
        bpy.context.view_layer.update()
        lo, hi = C.gltf_bounds(new)
        size = max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
        k = 1.0 / size
        cx, cz = (i % cols) * 1.6, -(i // cols) * 1.75
        for r in roots:
            r.scale = (k, k, k)
            r.rotation_euler.z = (-60 if nm.startswith("wpn_") else -25) * D2R
        bpy.context.view_layer.update()
        lo, hi = C.gltf_bounds(new)
        for r in roots:
            r.location.x += cx - (lo[0] + hi[0]) / 2
            r.location.y += (lo[2] + hi[2]) / 2
            r.location.z += cz - lo[1]
        lbl = _label(nm, (cx, -0.6, cz - 0.28), size=0.13)
        lbl.rotation_euler.x = 90 * D2R
        allobjs += new + [lbl]
    bpy.context.view_layer.update()
    C.frame_camera(allobjs, vd, res, margin=1.05)
    C.render_to(os.path.join(PREVIEWS, fname))


# ---- Trash Panda Royale previews --------------------------------------------------
INK_HEX = 0x2b2340


def hexs(v):
    return "#%06x" % v


def mixc(a, b, t):
    ch = [round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) for s in (16, 8, 0)]
    return (ch[0] << 16) | (ch[1] << 8) | ch[2]


def raccoon_colors(fur, belly=0xf3ead8, acc=0xff5d8f):
    """Like looks.ts raccoonLook(): FurDark = fur mixed 55 % toward ink; Face takes the belly."""
    return {"Fur": hexs(fur), "FurDark": hexs(mixc(fur, INK_HEX, 0.55)), "Belly": hexs(belly),
            "Face": hexs(belly), "Acc": hexs(acc)}


RACCOON_FURS = [0x9a96a3, 0x8d8a96, 0xa69888, 0x8f7f72, 0xb08a68, 0x6f6875, 0xc9bfb0, 0xff9ec7]
RACCOON_ACCS = [0xff5d8f, 0xffd23f, 0x3ec1ff, 0x7cff6b, 0xb084ff, 0xff9f43, 0xffffff, 0x2b2340]
RACCOON_HATS = ["", "acc_bandana", "acc_beanie", "acc_cap", "acc_pirate", "acc_tophat", "acc_sack", "acc_crown"]

# one representative look per role (accessories, colours, shirt pattern, scale from looks.ts humanLook)
HUMAN_ROLES = [
    ("jogger", ("hair_0", "acc_sweatband"), 1, 1.0,
     dict(Face=0xf1c08f, Skin=0xf1c08f, Hair=0x3b2416, Shoes=0xffffff, Shirt=0x7cff6b, Pants=0x3d5a80)),
    ("office", ("hair_1", "acc_tie", "acc_briefcase", "acc_glasses"), 0, 1.0,
     dict(Face=0xd99a6c, Skin=0xd99a6c, Hair=0x1e1e1e, Shoes=0x2b2340, Shirt=0xdbe8ff, Pants=0x2b2d42)),
    ("chef", ("acc_chef_hat", "acc_apron", "acc_mustache"), 0, 1.05,
     dict(Face=0xffd9b8, Skin=0xffd9b8, Hair=0xb5523b, Shoes=0x2b2340, Shirt=0xffffff, Pants=0x2b2d42)),
    ("granny", ("hair_3", "acc_glasses", "acc_handbag"), 0, 0.9,
     dict(Face=0xffe3cf, Skin=0xffe3cf, Hair=0xdcdce4, Shoes=0xff5d8f, Shirt=0xb084ff, Pants=0x6d597a)),
    ("kid", ("acc_cap", "acc_backpack", "acc_balloon"), 2, 0.72,
     dict(Face=0xa86b45, Skin=0xa86b45, Hair=0x6b4226, Shoes=0xffffff, Shirt=0xff5d8f, Pants=0x4a7c59)),
    ("pest", ("acc_overalls", "acc_gasmask", "acc_tank", "acc_sprayer"), 0, 1.05,
     dict(Face=0xf1c08f, Skin=0xf1c08f, Hair=0x3b2416, Shoes=0x2b2340, Shirt=0xff9f43, Pants=0xff9f43)),
    ("tourist", ("hair_2", "acc_sunhat", "acc_camera"), 3, 1.0,
     dict(Face=0x7a4a2c, Skin=0x7a4a2c, Hair=0xd9a441, Shoes=0xff5d8f, Shirt=0x3ec1ff, Pants=0x264653)),
]


def human_kwargs(role):
    for name, show, pattern, scale, cols in HUMAN_ROLES:
        if name == role:
            return dict(show=show, pattern=pattern, scale=scale, colors={k: hexs(v) for k, v in cols.items()})
    raise KeyError(role)


def load_poses():
    with open(POSES_PATH, encoding="utf-8") as f:
        return json.load(f)["poses"]


def pose_for(poses, name, extra=None):
    p = dict(poses[name]["joints"])
    if extra:
        p.update(extra)
    return p, poses[name].get("body")


def _studio(res, ground=True, sun=(-0.45, 0.75, -1.0)):
    C.reset_scene()
    sc = C.setup_render(res)
    C.add_sun(sun, 3.2)
    if ground:
        C.add_ground()
    return sc


def _flat_label(text, loc, size=0.11):
    lb = _label(text, loc, size)
    lb.rotation_euler = (0, 0, 0)
    return lb


def _row(specs, gap=0.3, y=0.0, labels=True, label_size=0.1):
    """Import and place models left to right by their bounding boxes.  specs: list of
    (label, model, load_model kwargs).  Returns all objects (incl. labels)."""
    objs = []
    x = 0.0
    for lbl, model, kw in specs:
        new, root = load_model(model, **kw)
        bpy.context.view_layer.update()
        vis = [o for o in new if not o.hide_render]
        lo, hi = C.gltf_bounds(vis)
        root.location.x += x - lo[0]
        root.location.y += y
        cx = x + (hi[0] - lo[0]) / 2
        x += (hi[0] - lo[0]) + gap
        objs += vis
        if labels and lbl:
            objs.append(_flat_label(lbl, (cx, y - 0.62, 0.005), label_size))
    return objs


def preview_raccoon_lineup():
    poses = load_poses()
    idle, _ = pose_for(poses, "idle")
    specs = []
    for i, a in enumerate(RACCOON_HATS):
        specs.append((a or "bare", "raccoon", dict(rz=-22, pose=idle, show=(a,),
                                                   colors=raccoon_colors(RACCOON_FURS[i], acc=RACCOON_ACCS[i]))))
    _studio((2400, 760))
    objs = _row(specs, gap=0.32)
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0.0, 1, -0.32), (2400, 760), margin=1.03)
    C.render_to(os.path.join(PREVIEWS, "raccoon_lineup.png"))
    # backs: the tail (rest + game idle pose), the sack, hats from behind
    specs = [("rest pose", "raccoon", dict(rz=165, colors=raccoon_colors(RACCOON_FURS[0]))),
             ("idle (tail up)", "raccoon", dict(rz=165, pose=idle, colors=raccoon_colors(RACCOON_FURS[0]))),
             ("side, idle", "raccoon", dict(rz=90, pose=idle, colors=raccoon_colors(RACCOON_FURS[3]))),
             ("acc_sack", "raccoon", dict(rz=165, pose=idle, show=("acc_sack",), colors=raccoon_colors(RACCOON_FURS[4], acc=0x3ec1ff))),
             ("acc_cap", "raccoon", dict(rz=200, pose=idle, show=("acc_cap",), colors=raccoon_colors(RACCOON_FURS[1], acc=0xffd23f))),
             ("acc_pirate", "raccoon", dict(rz=150, pose=idle, show=("acc_pirate",), colors=raccoon_colors(RACCOON_FURS[5])))]
    _studio((2200, 760))
    objs = _row(specs, gap=0.4)
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0.0, 1, -0.4), (2200, 760), margin=1.03)
    C.render_to(os.path.join(PREVIEWS, "raccoon_back.png"))


def preview_raccoon_outfits():
    """The start screen's outfit pieces, alone and worn together: front 3/4, side, back, and
    the poses that bring the head closest to them (gallop, knocked out)."""
    poses = load_poses()
    idle, _ = pose_for(poses, "idle")
    looks = [("acc_shades", ("acc_shades",), 0x9a96a3, 0xff5d8f), ("acc_bowtie", ("acc_bowtie",), 0xb08a68, 0x3ec1ff),
             ("acc_headphones", ("acc_headphones",), 0x6f6875, 0x7cff6b), ("acc_cone", ("acc_cone",), 0xc9bfb0, 0xffffff),
             ("cone shades bowtie", ("acc_cone", "acc_shades", "acc_bowtie"), 0x8fe3c8, 0x2b2340),
             ("phones shades sack", ("acc_headphones", "acc_shades", "acc_sack"), 0xff9ec7, 0xffd23f),
             ("crown shades", ("acc_crown", "acc_shades"), 0x8d8a96, 0xb084ff)]
    for stem, rz, vd in (("raccoon_outfits", -24, (0.0, 1, -0.3)), ("raccoon_outfits_side", 90, (0.0, 1, -0.2)),
                         ("raccoon_outfits_back", 160, (0.0, 1, -0.35))):
        specs = [(lbl, "raccoon", dict(rz=rz, pose=idle, show=show, colors=raccoon_colors(fur, acc=acc)))
                 for lbl, show, fur, acc in looks]
        _studio((2600, 640))
        objs = _row(specs, gap=0.3)
        bpy.context.view_layer.update()
        C.frame_camera(objs, vd, (2600, 640), margin=1.03)
        C.render_to(os.path.join(PREVIEWS, stem + ".png"))
    # the poses: gallop (head up, torso pitched), knocked out, sitting in a car
    specs = []
    for pn in ("gallop", "ko_lying", "sit_drive", "arms_up_panic"):
        joints, body = pose_for(poses, pn)
        for lbl, show, fur, acc in looks[4:6]:
            specs.append(("%s: %s" % (pn.replace("_", " "), lbl), "raccoon",
                          dict(rz=60, pose=joints, body=body, show=show, colors=raccoon_colors(fur, acc=acc))))
    _studio((2600, 640))
    objs = _row(specs, gap=0.25, label_size=0.07)
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0.0, 1, -0.25), (2600, 640), margin=1.03)
    C.render_to(os.path.join(PREVIEWS, "raccoon_outfits_poses.png"))


def preview_human_lineup():
    hid = {"forearm_l": (-0.25, 0, 0), "forearm_r": (-0.25, 0, 0), "arm_l": (0, 0, 0.1), "arm_r": (0, 0, -0.1)}
    for fname, rz, vd in (("human_lineup.png", -18, (0.0, 1, -0.25)), ("human_back.png", 162, (0.0, 1, -0.35))):
        specs = []
        for role, show, pattern, scale, cols in HUMAN_ROLES:
            pose = dict(hid)
            if role == "granny":
                pose["torso"] = (0.3, 0, 0)
            kw = human_kwargs(role)
            specs.append(("%s x%g" % (role, scale) if scale != 1 else role, "human", dict(rz=rz, pose=pose, **kw)))
        _studio((2400, 820))
        objs = _row(specs, gap=0.35)
        bpy.context.view_layer.update()
        C.frame_camera(objs, vd, (2400, 820), margin=1.03)
        C.render_to(os.path.join(PREVIEWS, fname))


def preview_expressions():
    """Both species' heads with each of the 8 faces, the Face UVs shifted like the game."""
    _studio((2400, 820), ground=False)
    objs = []
    looks = [("raccoon", raccoon_colors(RACCOON_FURS[0]), ()),
             ("human", human_kwargs("office")["colors"], ("hair_1",)),
             ("human", human_kwargs("tourist")["colors"], ("hair_2",))]
    for row, (model, cols, hair) in enumerate(looks):
        keep = ("head", "ear_l", "ear_r") + hair
        for e in range(8):
            new, root = load_model(model, rz=-12, show=hair, expr=e, colors=cols)
            for o in new:
                if base(o) not in keep and base(o) != model:
                    o.hide_render = True
            bpy.context.view_layer.update()
            vis = [o for o in new if not o.hide_render]
            lo, hi = C.gltf_bounds(vis)
            root.location += Vector((e * 0.95 - (lo[0] + hi[0]) / 2, 0, -row * 0.95 - lo[1]))
            objs += vis
            if row == 0:
                lb = _label("%d %s" % (e, T.EXPRESSIONS[e]), (e * 0.95, -0.4, 0.98), 0.12)
                objs.append(lb)
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0, 1, -0.18), (2400, 820), margin=1.03)
    C.render_to(os.path.join(PREVIEWS, "expressions.png"))


def preview_poses():
    """Every test pose of assets-src/poses.json on both species, a 3/4 front view and a side
    view (separate images), to judge pivots, gaps and interpenetration."""
    poses = load_poses()
    names = list(poses)
    for model, kw, stem in (("raccoon", dict(colors=raccoon_colors(RACCOON_FURS[2], acc=0x3ec1ff)), "poses_raccoon"),
                            ("human", human_kwargs("jogger"), "poses_human")):
        for view, rz, vd in (("", -35, (0, 1, -0.4)), ("_side", 90, (0, 1, -0.25))):
            step = (1.15 if model == "raccoon" else 1.4) * (1.45 if view else 1.0)
            _studio((2600, 700))
            objs = []
            for i, pn in enumerate(names):
                joints, body = pose_for(poses, pn)
                new, root = load_model(model, loc=(i * step, 0, 0), rz=rz, pose=joints, body=body, **kw)
                objs += [o for o in new if not o.hide_render]
                objs.append(_flat_label(pn.replace("_", " "), (i * step, -0.75, 0.005), 0.09))
            bpy.context.view_layer.update()
            C.frame_camera(objs, vd, (2600, 700), margin=1.03)
            C.render_to(os.path.join(PREVIEWS, stem + view + ".png"))


def _mount_weapon(char_objs, wname):
    sock = next(o for o in char_objs if base(o) == "hand_r_socket")
    wnew, wroots = import_glb(os.path.join(MODELS, wname + ".glb"))
    w = wroots[0]
    w.parent = sock
    w.matrix_parent_inverse = Matrix.Identity(4)
    w.location = (0, 0, 0)
    C.set_game_rotation(w, (math.pi / 2, 0, 0))      # CharacterView.setWeapon: barrel along the arm
    return wnew


def preview_weapons():
    poses = load_poses()
    names = [("wpn_pistol", "aim"), ("wpn_smg", "aim_two_handed"), ("wpn_shotgun", "aim_two_handed"),
             ("wpn_grenade", "throw_windup")]
    res = (2200, 760)
    for fname, rz, vd in (("weapons_held.png", -50, (0.15, 1, -0.4)), ("weapons_held_side.png", 90, (0.0, 1, -0.2))):
        _studio(res)
        objs = []
        for i, (wn, pn) in enumerate(names):
            joints, body = pose_for(poses, pn)
            new, root = load_model("raccoon", loc=(i * 1.5, 0, 0), rz=rz, pose=joints,
                                   colors=raccoon_colors(RACCOON_FURS[i], acc=RACCOON_ACCS[i]),
                                   show=(("acc_cap", "acc_bandana", "acc_beanie", "acc_pirate")[i],))
            objs += [o for o in new if not o.hide_render] + _mount_weapon(new, wn)
            objs.append(_flat_label("%s (%s)" % (wn[4:], pn.replace("_", " ")), (i * 1.5, -0.85, 0.005), 0.085))
        bpy.context.view_layer.update()
        C.frame_camera(objs, vd, res, margin=1.04)
        C.render_to(os.path.join(PREVIEWS, fname))
    # pure side profiles, barrel to the left (seen from the weapon's right, +X... from -X)
    _studio((2000, 560), ground=False)
    objs = []
    for i, (wn, _) in enumerate(names):
        new, roots = import_glb(os.path.join(MODELS, wn + ".glb"))
        roots[0].location = (0, -i * 0.75, 1.0)
        objs += new
        lb = _label(wn, (0.3, -i * 0.75 + 0.02, 0.86), 0.05)
        lb.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
        objs.append(lb)
    bpy.context.view_layer.update()
    C.frame_camera(objs, (1, 0, 0), (2000, 560), margin=1.1)
    C.render_to(os.path.join(PREVIEWS, "weapons_side.png"))


def preview_pickups():
    res = (2200, 760)
    _studio(res)
    specs = [("loot_can", "loot_can", dict(rz=-25)),
             ("loot_can (lid open)", "loot_can", dict(rz=-25, pose={"lid": (-1.9, 0, 0)})),
             ("food_pizza x1.6", "food_pizza", dict(rz=-30, scale=1.6)),
             ("food_donut x1.6", "food_donut", dict(rz=0, scale=1.6)),
             ("coffee x1.6", "coffee", dict(rz=-20, scale=1.6)),
             ("tombstone", "tombstone", dict(rz=-25)),
             ("crown", "crown", dict(rz=-20, scale=1.5))]
    objs = _row(specs, gap=0.35)
    for o in objs:
        if base(o) in ("food_pizza", "food_donut", "coffee", "crown") and o.parent is None:
            o.location.z += 0.6
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0.0, 1, -0.55), res, margin=1.04)
    C.render_to(os.path.join(PREVIEWS, "pickups.png"))


def preview_trashcan():
    """The trash can a raccoon hides in, as the game shows it: shut (what everyone else sees),
    the hider's own view (lid lifted, eyes peeking out), the lid knocked off (trash inside, the
    lid on the ground), and a raccoon beside it for size."""
    res = (1800, 760)
    _studio(res)
    objs = []
    for k, state in enumerate(("shut", "peek", "lid off")):
        new, roots = import_glb(os.path.join(MODELS, "trashcan.glb"))
        root = roots[0]
        root.location.x = k * 1.35
        root.rotation_euler.z = -20 * D2R
        for o in new:
            nm = base(o)
            if nm == "peek":
                o.hide_render = state != "peek"
                o.rotation_euler.z = 25 * D2R
            if nm == "lid" and state == "peek":
                o.location.z += 0.14
                o.rotation_euler = (-0.25, -0.08, 0)
            if nm == "lid" and state == "lid off":
                o.location = (0.55, -0.6, 0.15)   # upside down on the ground (its handle 0.15 under the pivot)
                o.rotation_euler = (math.pi, 0.4, 0)
        objs += [o for o in new if not o.hide_render]
        objs.append(_flat_label(state, (k * 1.35, -0.75, 0.005), 0.1))
    new, root = load_model("raccoon", loc=(3 * 1.35 + 0.1, 0.0, 0), rz=-20, colors=raccoon_colors(RACCOON_FURS[0]))
    objs += [o for o in new if not o.hide_render]
    objs.append(_flat_label("raccoon", (3 * 1.35 + 0.1, -0.75, 0.005), 0.1))
    bpy.context.view_layer.update()
    C.frame_camera(objs, (0.0, 1, -0.55), res, margin=1.06)
    C.render_to(os.path.join(PREVIEWS, "trashcan.png"))


def preview_gull_manhole():
    """The seagull (rest = wings spread in a glide, wings up, wings down, side view) next to a
    raccoon for size, then the manhole shut (hole hidden, as the game draws it) and with its
    lid off and lying beside it."""
    res = (2600, 760)
    _studio(res)
    up = {"wing_l": (0, 0, 0.7), "wing_r": (0, 0, -0.7), "wingtip_l": (0, 0, 0.35), "wingtip_r": (0, 0, -0.35)}
    down = {"wing_l": (0, 0, -0.55), "wing_r": (0, 0, 0.55), "wingtip_l": (0, 0, -0.3), "wingtip_r": (0, 0, 0.3)}
    specs = [("gull (rest)", "gull", dict(rz=-30)), ("wings up", "gull", dict(rz=-30, pose=up)),
             ("wings down", "gull", dict(rz=-30, pose=down)), ("side", "gull", dict(rz=90)),
             ("raccoon", "raccoon", dict(rz=-20, colors=raccoon_colors(RACCOON_FURS[0])))]
    objs = _row(specs, gap=0.35)
    bpy.context.view_layer.update()
    x = C.gltf_bounds(objs)[1][0] + 0.9
    for k, label in enumerate(("manhole", "lid off")):
        new, root = load_model("manhole", loc=(x + 0.55, 0.0, 0.0))
        by = {base(o): o for o in new}
        if k == 0:
            by["hole"].hide_render = True
        else:
            by["lid"].location = (0.5, 0.6, 0.0)
            by["lid"].rotation_euler = (0.0, 0.0, 0.5)
        objs += [o for o in new if not o.hide_render]
        objs.append(_flat_label(label, (x + 0.55, -0.85, 0.005), 0.1))
        x += 1.5
    bpy.context.view_layer.update()
    C.frame_camera([o for o in objs if not o.hide_render], (0.0, 1, -0.45), res, margin=1.04)
    C.render_to(os.path.join(PREVIEWS, "gull_manhole.png"))


def _render_pixels(path):
    """Render to `path` and return the image as float RGB (rows top-down)."""
    C.render_to(path)
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)[::-1, :, :3]


def preview_game_view():
    """Both species from the game camera (pitch 0.88 rad, 25 m, 36 deg vertical FOV, 1280 x 720)
    next to a car-sized box; plus a 3x pixel zoom of the middle."""
    poses = load_poses()
    idle, _ = pose_for(poses, "idle")
    walk, _ = pose_for(poses, "walk_left_step")
    aim, _ = pose_for(poses, "aim")
    res = (1280, 720)
    _studio(res)
    for i, role in enumerate([r[0] for r in HUMAN_ROLES]):
        kw = human_kwargs(role)
        pose = dict({"forearm_l": (-0.25, 0, 0), "forearm_r": (-0.25, 0, 0)}, **(walk if i % 3 == 1 else {}))
        load_model("human", loc=((i - 3) * 1.45, 1.6, 0), rz=(0, 35, 180, 0, 90, -35, 0)[i], pose=pose, **kw)
    for i in range(8):
        pose = (idle, walk, aim, idle, idle, walk, idle, idle)[i]
        load_model("raccoon", loc=((i - 3.5) * 1.3, -1.2, 0), rz=(0, 30, -20, 180, 90, -45, 160, 0)[i], pose=pose,
                   show=(RACCOON_HATS[i],), colors=raccoon_colors(RACCOON_FURS[i], acc=RACCOON_ACCS[i]))
    load_model("loot_can", loc=(-6.2, -1.0, 0), rz=0)
    load_model("food_pizza", loc=(-6.2, -1.0, 1.05), rz=30, scale=1.6)
    load_model("tombstone", loc=(-6.0, 1.4, 0), rz=10)
    me = bpy.data.meshes.new("car_box")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    car = bpy.data.objects.new("car_box", me)
    bpy.context.scene.collection.objects.link(car)
    car.location = (7.0, 0.2, 0.75)
    car.scale = (1.8, 4.0, 1.5)
    m = bpy.data.materials.new("_car")
    next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (0.9, 0.4, 0.3, 1)
    me.materials.append(m)
    cd = bpy.data.cameras.new("game_cam")
    cd.sensor_fit = 'VERTICAL'
    cd.angle = math.radians(36)
    cam = bpy.data.objects.new("game_cam", cd)
    bpy.context.scene.collection.objects.link(cam)
    pitch, dist = 0.88, 25.0
    focus = Vector((0, 0.2, 0.6))
    cam.location = focus + Vector((0, -math.cos(pitch) * dist, math.sin(pitch) * dist))
    cam.rotation_euler = (focus - cam.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    full = _render_pixels(os.path.join(PREVIEWS, "game_view.png"))
    h, w = full.shape[:2]
    cw, ch = w // 3, h // 3
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    zoom = np.repeat(np.repeat(full[y0:y0 + ch, x0:x0 + cw], 3, 0), 3, 1)
    T.write_png(os.path.join(PREVIEWS, "game_view_zoom.png"), T.to_u8(zoom))


def preview_atlas_layout():
    """atlas_chars at 2x with the actual face-patch outlines drawn into every expression cell
    (they must frame the art identically) and the shirt UV rects."""
    path = T.tex_path('atlas_chars')
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    img = px.reshape(h, w, 4)[::-1, :, :3].astype(np.float64)
    # stored values are sRGB already (image not colour managed for foreach_get of PNG bytes)
    S = 2
    big = np.repeat(np.repeat(img, S, 0), S, 1)

    def dot(x, y, c, r=1):
        xi, yi = int(round(x * S)), int(round(y * S))
        big[max(0, yi - r):yi + r + 1, max(0, xi - r):xi + r + 1] = c

    def line(a, b, c):
        n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) * S * 2) + 2
        for k in range(n + 1):
            t = k / n
            dot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, c, 0)
    for species, shape, thetas in (('raccoon', raccoon_head_shape(), R_FACE_THETAS),
                                   ('human', human_head_shape(), [360.0 * k / 28 - 90 for k in range(28)])):
        ring = shape.rows(thetas, [1.0])[0]
        pts = [T.face_px(species, p.x - shape.c.x, p.z - shape.c.z) for p in ring]
        bx, by = T.FACE_BLOCK[species]
        for e in range(8):
            cx, cy = T.face_cell_px(species, e)
            q = [(x - bx + cx, y - by + cy) for x, y in pts]
            for a, b in zip(q, q[1:] + q[:1]):
                line(a, b, (1.0, 0.1, 0.6))
            line((cx + T.FACE_MARGIN, cy + T.FACE_MARGIN), (cx + T.FACE_CELL - T.FACE_MARGIN, cy + T.FACE_MARGIN), (0.2, 0.6, 1.0))
            line((cx + T.FACE_MARGIN, cy + T.FACE_CELL - T.FACE_MARGIN), (cx + T.FACE_CELL - T.FACE_MARGIN, cy + T.FACE_CELL - T.FACE_MARGIN), (0.2, 0.6, 1.0))
            line((cx + T.FACE_MARGIN, cy + T.FACE_MARGIN), (cx + T.FACE_MARGIN, cy + T.FACE_CELL - T.FACE_MARGIN), (0.2, 0.6, 1.0))
            line((cx + T.FACE_CELL - T.FACE_MARGIN, cy + T.FACE_MARGIN), (cx + T.FACE_CELL - T.FACE_MARGIN, cy + T.FACE_CELL - T.FACE_MARGIN), (0.2, 0.6, 1.0))
    for (x0, y0, x1, y1) in (SHIRT_TORSO_PX, SHIRT_SLEEVE_PX):
        line((x0, T.SHIRT_Y + y0), (x1, T.SHIRT_Y + y0), (0.1, 0.8, 0.3))
        line((x0, T.SHIRT_Y + y1), (x1, T.SHIRT_Y + y1), (0.1, 0.8, 0.3))
        line((x0, T.SHIRT_Y + y0), (x0, T.SHIRT_Y + y1), (0.1, 0.8, 0.3))
        line((x1, T.SHIRT_Y + y0), (x1, T.SHIRT_Y + y1), (0.1, 0.8, 0.3))
    T.write_png(os.path.join(PREVIEWS, "atlas_chars_layout.png"), T.to_u8(big))


# =============================================================================
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = None
    if "--only" in argv:
        only = set(argv[argv.index("--only") + 1].split(","))
    no_preview = "--no-preview" in argv

    os.makedirs(MODELS, exist_ok=True)
    os.makedirs(PREVIEWS, exist_ok=True)
    meta_path = os.path.join(MODELS, "characters_props.meta.json")
    meta = {"generator": "assets-src/blender/build_characters_props.py",
            "axes": "glTF: +Y up, +Z = model front, -X = model right; metres",
            "assets": []}
    built = []
    for name, fn in ASSETS:
        if only and name not in only:
            continue
        C.reset_scene()
        root = fn()
        info = C.export_glb(root, os.path.join(MODELS, name + ".glb"))
        bad = [o for o in info["node_names"] if "." in o]
        if bad:
            raise RuntimeError("unexpected suffixed names: %s" % bad)
        lim = budget_for(name)
        flag = "OK" if info["triangles"] < lim else "OVER BUDGET"
        print("built %-17s tris=%5d/%d %s size(x,y,z glTF)=%s" % (
            name, info["triangles"], lim, flag, info["size"]))
        meta["assets"].append(info)
        built.append(name)
    if only is not None and os.path.isfile(meta_path):
        # a partial build: update just those assets' entries, keep the rest
        with open(meta_path, encoding="utf-8") as f:
            old = json.load(f)
        fresh = {a["name"]: a for a in meta["assets"]}
        meta["assets"] = [fresh.pop(a["name"], a) for a in old.get("assets", [])] + list(fresh.values())
    C.write_json(meta_path, meta)
    print("wrote", meta_path)
    if not no_preview:
        ok = verify(built)
        bset = set(built)
        chars = {"raccoon", "human"}
        junk = {"wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade"}
        pickups = {"loot_can", "food_pizza", "food_donut", "coffee", "tombstone", "crown"}
        gm = {"gull", "manhole"}
        have = lambda n: os.path.isfile(os.path.join(MODELS, n + ".glb"))
        if bset & chars and have("raccoon") and have("human"):
            preview_raccoon_lineup()
            preview_raccoon_outfits()
            preview_human_lineup()
            preview_expressions()
            preview_poses()
            preview_game_view()
            preview_atlas_layout()
        if bset & (junk | {"raccoon"}) and have("raccoon"):
            preview_weapons()
        if bset & pickups:
            preview_pickups()
        if "trashcan" in bset and have("raccoon"):
            preview_trashcan()
        boards = {"billboard", "billboard_roof"}
        if bset & boards:
            preview_billboards()
        if bset & gm and have("gull") and have("manhole") and have("raccoon"):
            preview_gull_manhole()
        if bset - chars - junk - pickups - boards - gm:
            preview_props()
            preview_grid(["tree_round", "tree_pine", "bush", "lamp", "hydrant", "bench", "drum", "cone",
                          "trashcan", "crossing_sign", "crossing_barrier", "fountain", "flowerbed",
                          "fx_star", "loot_can", "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade"],
                          "props_grid.png", 5, (1500, 1300))
        if not ok:
            raise RuntimeError("verification failed (see above)")
    print("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
