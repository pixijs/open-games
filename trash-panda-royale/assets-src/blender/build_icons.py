"""Bake the HUD / UI icons for Trash Panda Royale (Blender 5.2, headless, EEVEE).

Every icon is a tiny 3D scene rendered with an orthographic camera and a transparent
film.  Game objects are rendered straight from public/assets/models/*.glb (so icons
always match the game); the rest are icon-only meshes built here with common_cp.MB.
The raccoon gets the game's default look (looks.ts raccoonLook: fur #9a96a3, FurDark =
fur mixed 55 % toward ink, cream belly / face, pink accessory), its Face UVs shifted to an
expression cell of tex/atlas_chars.png and its joints posed in the game's glTF frame.
Each render is post-processed in numpy:
  1. a round ink (#2b2340) sticker outline is dilated from the soft alpha
     (disc kernel, anti-aliased) and composited UNDER the render (straight alpha);
  2. the image is box-filtered down by SS (4x supersampling) on premultiplied colour;
  3. it is written as an 8-bit RGBA sRGB PNG (straight alpha; fully transparent pixels
     carry the ink colour so straight-alpha bilinear sampling never fringes).

Run (from the project root):
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      --python assets-src/blender/build_icons.py
Optional args after `--`:
  --only a,b,c   rebuild only some icons.  A name selects an icon when it IS the icon's
                 name (`heart`), names a model GLB the icon is rendered from (`raccoon` ->
                 raccoon, raccoon_dizzy, ride; `car_hatch` -> car_hatch, ride; `fx_star` ->
                 star, raccoon_dizzy) or a texture such a model references (`atlas_chars` ->
                 every icon showing the raccoon's face, the crown, the stink bomb).  Names that
                 match nothing are ignored, so the shared `--only` list build-assets.mjs
                 forwards to every script is safe; if nothing matches, no icon is rebuilt (the
                 script says so and exits 0).
  --no-preview   skip the contact sheet.

Outputs:
  public/assets/icons/<name>.png   192x192 (keycap_wide: 384x128), RGBA 8-bit sRGB
  assets-src/previews/icons.png    contact sheet (sky / grey checker / ink panels),
                                   rebuilt from every icon PNG on disk.
  public/assets/icons/outfit.png   the start screen's pictures of the hats and extras
  public/assets/icons/outfit.json  (see OUTFIT_ITEMS; `--only outfit` rebuilds just these)
  assets-src/previews/outfit.png   each of them in every gear colour.
A full run also deletes the PNGs of retired icons (RETIRED below).

car_pest is rendered from car_pest.glb; until that model exists it falls back to
car_police.glb and the log says so (it switches over by itself once the GLB is there).

Facing conventions in the images: guns point their barrel to the RIGHT; cars and the
train are seen 3/4 from above-front with their nose toward the lower RIGHT.
"""
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import traceback

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common_cp as C  # noqa: E402
from common_cp import MB, mat, D2R, align_z  # noqa: E402
from common_tex import dilate_disc, write_png  # noqa: E402  (PNG: IHDR/IDAT/IEND only)

ROOT = os.path.dirname(os.path.dirname(HERE))
MODELS = os.path.join(ROOT, "public", "assets", "models")
ICONS_DIR = os.path.join(ROOT, "public", "assets", "icons")
PREVIEWS = os.path.join(ROOT, "assets-src", "previews")

ICON_PX = 192          # final square icon size
SS = 4                 # supersampling factor (render = SS x final)
OUTLINE_PX = 4.25      # ink outline radius in final pixels
EDGE_PX = 1.75         # extra empty border beyond the outline (final pixels)
SAMPLES = 48           # EEVEE TAA render samples
INK = "#2b2340"

# icons this script used to make (Tiny Town Mayhem): a full run deletes their PNGs
RETIRED = ["player", "dizzy", "fist", "crate", "car_police", "bullet", "shell"]


def srgb01(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def base(o):
    return o.name.split('.')[0]


def glb(name):
    return os.path.join(MODELS, name + ".glb")


def glb_textures(name):
    """Texture names (tex/<name>.png) that public/assets/models/<name>.glb references."""
    try:
        with open(glb(name), 'rb') as f:
            head = f.read(20)
            n, kind = struct.unpack_from('<I4s', head, 12)
            js = json.loads(f.read(n)) if kind == b'JSON' else {}
    except (OSError, ValueError, struct.error):
        return set()
    return {os.path.splitext(os.path.basename(im.get("uri") or im.get("name") or ""))[0]
            for im in js.get("images", [])} - {""}


def import_glb(name, tries=4):
    """Import public/assets/models/<name>.glb -> (new objects, roots).  Retries a few
    times: a GLB that another build is rewriting can fail to load for a moment."""
    for k in range(tries):
        before = set(bpy.data.objects)
        try:
            return C.import_glb(glb(name))
        except Exception as e:  # noqa: BLE001
            for o in set(bpy.data.objects) - before:
                bpy.data.objects.remove(o, do_unlink=True)
            if k == tries - 1:
                raise
            print("[icon] loading %s.glb failed (%s); retrying" % (name, e))
            time.sleep(2.0)


# =============================================================================
# scene helpers
# =============================================================================
def cam_basis(view):
    vd = Vector(view).normalized()
    R = vd.to_track_quat('-Z', 'Y').to_matrix()
    return vd, R.col[0].copy(), R.col[1].copy()


def face_camera_rot(view, spin=0.0):
    """Rotation whose local -Y faces the camera and local +Z is the image's up
    (spin: extra roll in degrees about the view axis)."""
    vd, right, up = cam_basis(view)
    M = Matrix((right, vd, up)).transposed()
    if spin:
        M = M @ C.rotmat((0, spin, 0))
    return M


def normal_frame(n, roll=0.0):
    """Rotation whose local -Y is the (outward) normal n and local +Z is as close to
    world up as possible (decals / features sitting on a surface)."""
    n = Vector(n).normalized()
    yl = -n
    zl = Vector((0, 0, 1)) - n * n.z
    zl = zl.normalized() if zl.length > 1e-6 else Vector((0, 1, 0))
    xl = yl.cross(zl)
    R = Matrix((xl, yl, zl)).transposed()
    if roll:
        R = R @ C.rotmat((0, roll, 0))
    return R


def light_rig(view, key=2.6, fill=0.65, rim=1.6):
    """Key from the camera's upper-left, soft fill from the right, rim from behind."""
    vd, right, up = cam_basis(view)

    def sun(name, toward, energy, shadow, angle):
        ld = bpy.data.lights.new(name, 'SUN')
        ld.energy = energy
        ld.angle = angle * D2R
        ld.use_shadow = shadow
        ob = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(ob)
        ob.rotation_euler = (-toward.normalized()).to_track_quat('-Z', 'Y').to_euler()

    sun("Key", -vd + up * 1.15 - right * 0.75, key, True, 6.0)
    sun("Fill", -vd + right * 1.1 - up * 0.2, fill, False, 25.0)
    sun("Rim", vd + up * 0.8 + right * 0.45, rim, False, 10.0)


def ray_hit(ob, origin, direction=(0, 1, 0)):
    """First hit on `ob` (identity transform) -> (location, normal)."""
    deps = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(ob, deps)
    loc, nrm, _i, _d = bvh.ray_cast(Vector(origin), Vector(direction).normalized())
    if loc is None:
        raise RuntimeError("ray missed %s from %s" % (ob.name, tuple(origin)))
    return loc, nrm


def ray_hit_world(objs, origin, direction):
    """Nearest hit over posed / parented mesh objects -> (location, normal) in world
    space, or None."""
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    o, d = Vector(origin), Vector(direction).normalized()
    best = None
    for ob in objs:
        if ob.type != 'MESH' or ob.hide_render:
            continue
        mw = ob.matrix_world
        inv = mw.inverted()
        bvh = BVHTree.FromObject(ob, deps)
        loc, nrm, _i, _d = bvh.ray_cast(inv @ o, (inv.to_3x3() @ d).normalized())
        if loc is None:
            continue
        wl = mw @ loc
        dist = (wl - o).length
        if best is None or dist < best[0]:
            best = (dist, wl, (inv.to_3x3().transposed() @ nrm).normalized())
    return None if best is None else (best[1], best[2])


def world_points(objs):
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    pts = []
    for ob in objs:
        if ob.type != 'MESH' or ob.hide_render:
            continue
        oe = ob.evaluated_get(deps)
        me = oe.to_mesh()
        mw = oe.matrix_world.copy()
        pts += [mw @ v.co for v in me.vertices]
        oe.to_mesh_clear()
    return pts


def smooth_path(pts, sub=4):
    """Catmull-Rom resample of a polyline (keeps the end points)."""
    P = [Vector(p) for p in pts]
    out = []
    for i in range(len(P) - 1):
        p0, p1, p2, p3 = P[max(i - 1, 0)], P[i], P[i + 1], P[min(i + 2, len(P) - 1)]
        for k in range(sub):
            t = k / sub
            out.append(0.5 * ((2 * p1) + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
                              (3 * p1 - p0 - 3 * p2 + p3) * t * t * t))
    out.append(P[-1])
    return out


def lerp_list(a, b, n):
    return [a + (b - a) * i / max(1, n - 1) for i in range(n)]


def puffy(mb, outline, m, depth, c=(0, 0, 0), rot=None, center=(0.0, 0.0), steps=7, expo=0.75,
          round_in=0.0):
    """Pillow-like solid from a star-shaped outline [(x, z)] in local XZ, bulging toward
    -Y (front) and +Y by `depth`.  round_in>0 lets the inner rings relax toward a
    circle (so dimples / tips of the outline don't crease the whole face)."""
    cx, cz = center
    rad = [math.hypot(x - cx, z - cz) for x, z in outline]
    rmean = sum(rad) / len(rad)

    def ring(phi, sign):
        s = math.cos(phi) ** expo
        d = math.sin(phi) ** expo
        w = round_in * (phi / (0.5 * math.pi)) ** 0.8
        out = []
        for (x, z), r in zip(outline, rad):
            k = (1 - w) + w * rmean / max(r, 1e-6)
            out.append((cx + (x - cx) * k * s, sign * depth * d, cz + (z - cz) * k * s))
        return out
    phis = [0.5 * math.pi * k / steps for k in range(steps)]
    rows = [[(cx, depth, cz)]]
    rows += [ring(p, 1) for p in reversed(phis[1:])]
    rows.append(ring(0.0, 0))
    rows += [ring(p, -1) for p in phis[1:]]
    rows.append([(cx, -depth, cz)])
    mb.grid(rows, m, recalc=True, M=C.xform(c, rot))


def rrect(hx, hy, r, nc=6):
    """Rounded rectangle, CCW around +Z, always 4*(nc+1) points."""
    r = max(0.005, min(r, hx - 1e-4, hy - 1e-4))
    pts = []
    for sx, sy, a0 in ((1, -1, -90), (1, 1, 0), (-1, 1, 90), (-1, -1, 180)):
        cx, cy = sx * (hx - r), sy * (hy - r)
        for k in range(nc + 1):
            a = (a0 + 90.0 * k / nc) * D2R
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def resample_closed(pts, n):
    """Closed polyline -> n points evenly spaced by arc length."""
    P = [Vector(p) for p in pts]
    seg = [(P[(i + 1) % len(P)] - P[i]).length for i in range(len(P))]
    total = sum(seg)
    out, i, acc = [], 0, 0.0
    for k in range(n):
        target = total * k / n
        while acc + seg[i] < target:
            acc += seg[i]
            i += 1
        t = (target - acc) / max(seg[i], 1e-9)
        out.append(P[i].lerp(P[(i + 1) % len(P)], t))
    return out


def smooth_closed(pts, iters, f=0.5):
    P = [Vector(p) for p in pts]
    for _ in range(iters):
        P = [P[i] * (1 - f) + (P[i - 1] + P[(i + 1) % len(P)]) * (f / 2) for i in range(len(P))]
    return P


def node_mat(name, rough=0.6, metallic=0.0):
    """Empty Principled material for hand-built node trees -> (material, nodes, links, bsdf)."""
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metallic
    m.roughness = rough
    return m, nt.nodes, nt.links, p


def _in(node, ident):
    return next(s for s in node.inputs if s.identifier == ident)


def _out(node, ident):
    return next(s for s in node.outputs if s.identifier == ident)


def speckle_mat(name, col, col2, pore, rough=0.75, scale=6.0, pore_scale=28.0, pore_size=0.16):
    """Cork-like material: low-frequency colour variation (col..col2) plus dark pores,
    from object-space noise / voronoi (icon meshes carry no real UVs)."""
    m, nodes, links, p = node_mat(name, rough)
    tc = nodes.new('ShaderNodeTexCoord')
    nz = nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = scale
    nz.inputs['Detail'].default_value = 3.0
    links.new(tc.outputs['Object'], nz.inputs['Vector'])
    ra = nodes.new('ShaderNodeValToRGB')
    ra.color_ramp.elements[0].position = 0.35
    ra.color_ramp.elements[0].color = (*C.hexcol(col), 1)
    ra.color_ramp.elements[1].position = 0.7
    ra.color_ramp.elements[1].color = (*C.hexcol(col2), 1)
    links.new(nz.outputs['Fac'], ra.inputs['Fac'])
    vo = nodes.new('ShaderNodeTexVoronoi')
    vo.inputs['Scale'].default_value = pore_scale
    links.new(tc.outputs['Object'], vo.inputs['Vector'])
    rb = nodes.new('ShaderNodeValToRGB')
    rb.color_ramp.elements[0].position = pore_size * 0.55
    rb.color_ramp.elements[0].color = (1, 1, 1, 1)
    rb.color_ramp.elements[1].position = pore_size
    rb.color_ramp.elements[1].color = (0, 0, 0, 1)
    links.new(_out(vo, 'Distance'), rb.inputs['Fac'])
    mx = nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    links.new(rb.outputs['Color'], _in(mx, 'Factor_Float'))
    links.new(ra.outputs['Color'], _in(mx, 'A_Color'))
    _in(mx, 'B_Color').default_value = (*C.hexcol(pore), 1)
    links.new(_out(mx, 'Result_Color'), p.inputs['Base Color'])
    m.diffuse_color = (*C.hexcol(col), 1)
    return m


# =============================================================================
# the raccoon (game look, expressions, poses)
# =============================================================================
INK_HEX = 0x2b2340
FUR_HEX = 0x9a96a3


def hexs(v):
    return "#%06x" % v


def mix_hex(a, b, t):
    ch = [round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) for s in (16, 8, 0)]
    return (ch[0] << 16) | (ch[1] << 8) | ch[2]


# looks.ts raccoonLook() defaults: FurDark = fur mixed 55 % toward ink, Face takes the belly
RACCOON_LOOK = {"Fur": hexs(FUR_HEX), "FurDark": hexs(mix_hex(FUR_HEX, INK_HEX, 0.55)),
                "Belly": "#f3ead8", "Face": "#f3ead8", "Acc": "#ff5d8f"}
EXPR_NEUTRAL, EXPR_BLINK, EXPR_HAPPY, EXPR_OUCH, EXPR_KO, EXPR_PANIC, EXPR_DETERMINED, \
    EXPR_MISCHIEF = range(8)
GLTF_TO_BL = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))   # glTF (x, y, z) -> Blender (x, -z, y)


def set_base_color(m, hexcolor):
    """Base colour factor of an imported glTF material.  Textured ones keep the texture
    and multiply it by the colour (like the game), so the face keeps its ink features."""
    lin = (*C.hexcol(hexcolor), 1.0)
    m.diffuse_color = lin
    nt = m.node_tree
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if p is None:
        return
    sock = p.inputs['Base Color']
    if not sock.is_linked:
        sock.default_value = lin
        return
    src = sock.links[0].from_node
    if src.type == 'MIX' and src.blend_type == 'MULTIPLY':
        for ident in ('B_Color', 'A_Color'):
            s = _in(src, ident)
            if s.enabled and not s.is_linked:
                s.default_value = lin
                return
    if src.type == 'TEX_IMAGE':
        mx = nt.nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        _in(mx, 'Factor_Float').default_value = 1.0
        _in(mx, 'B_Color').default_value = lin
        nt.links.new(src.outputs['Color'], _in(mx, 'A_Color'))
        nt.links.new(_out(mx, 'Result_Color'), sock)
        return
    raise RuntimeError("can't tint material %s (base colour from %s)" % (m.name, src.type))


def recolor(objs, colors):
    """colors: {material base name: '#rrggbb'} applied to the materials these objects use."""
    done = set()
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for slot in ob.material_slots:
            m = slot.material
            if m is None or m.name in done:
                continue
            b = m.name.split('.')[0]
            if b in colors:
                set_base_color(m, colors[b])
                done.add(m.name)


def set_expression(objs, expr):
    """Shift the Face UVs by whole cells of the species' 4x2 expression block (like the
    game): glTF (+col/8, +row/4) with v down = Blender (+col/8, -row/4)."""
    du, dv = (expr % 4) * 0.125, (expr // 4) * 0.25
    for ob in objs:
        if ob.type != 'MESH':
            continue
        me = ob.data
        idx = {i for i, m in enumerate(me.materials) if m is not None and m.name.split('.')[0] == "Face"}
        if not idx:
            continue
        if me.users > 1:
            ob.data = me = me.copy()
        uvl = me.uv_layers.active.data
        for poly in me.polygons:
            if poly.material_index in idx:
                for li in poly.loop_indices:
                    u, v = uvl[li].uv
                    uvl[li].uv = (u + du, v - dv)


def set_game_rotation(ob, rot):
    """A joint rotation as the game sets it: Euler XYZ (three.js order) in glTF axes."""
    Rg = (Matrix.Rotation(rot[0], 3, 'X') @ Matrix.Rotation(rot[1], 3, 'Y') @
          Matrix.Rotation(rot[2], 3, 'Z'))
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = (GLTF_TO_BL @ Rg @ GLTF_TO_BL.transposed()).to_quaternion()


def import_raccoon(expr=EXPR_NEUTRAL, pose=None, show=()):
    """raccoon.glb in the default look, accessories hidden (except `show`), Face set to
    `expr`, joints posed with game-side rotations -> (objects, root, {base name: object})."""
    new, roots = import_glb("raccoon")
    by = {}
    for o in new:
        by.setdefault(base(o), o)
    for o in new:
        b = base(o)
        if b.startswith("acc_") and b not in show:
            o.hide_render = True
    recolor(new, RACCOON_LOOK)
    if expr:
        set_expression(new, expr)
    for j, rot in (pose or {}).items():
        set_game_rotation(by[j], rot)
    return new, roots[0], by


def only_parts(objs, keep):
    """Hide every object whose base name isn't in keep; returns the visible ones."""
    vis = []
    for o in objs:
        if base(o) in keep and not o.hide_render:
            vis.append(o)
        else:
            o.hide_render = True
    return vis


HEAD_PARTS = {"head", "ear_l", "ear_r"}
HEAD_VIEW = (0.42, 1.0, -0.14)


def icon_raccoon():
    new, root, by = import_raccoon(EXPR_NEUTRAL, pose={"ear_l": (0, 0, 0.08), "ear_r": (0, 0, -0.08)})
    vis = only_parts(new, HEAD_PARTS)
    set_game_rotation(by["head"], (0.0, 0.0, -0.06))
    return dict(objs=vis, view=HEAD_VIEW)


def icon_raccoon_dizzy():
    new, root, by = import_raccoon(EXPR_KO, pose={"ear_l": (0.1, 0, -0.35), "ear_r": (0.1, 0, 0.35)})
    vis = only_parts(new, HEAD_PARTS)
    set_game_rotation(by["head"], (0.0, 0.0, 0.12))
    view = (0.3, 1.0, -0.2)
    bpy.context.view_layer.update()
    centre = Vector((0.0, 0.0, 1.38))
    for k, (ang, spin, sc) in enumerate(((-28, -18, 1.15), (95, 12, 1.05), (200, 30, 1.15))):
        a = ang * D2R
        sn, sr = import_glb("fx_star")
        s = sr[0]
        s.location = centre + Vector((0.46 * math.cos(a), 0.38 * math.sin(a), 0.1 * math.sin(a)))
        s.rotation_mode = 'XYZ'
        s.rotation_euler = face_camera_rot(view, spin=spin).to_euler()
        s.scale = (sc, sc, sc)
        vis += sn
    return dict(objs=vis, view=view)


def roof_top(objs, flat=0.9, band=0.05, n=41, area=0.05):
    """World point in the middle of a vehicle's roof: the highest level of upward-facing
    surface (rays shot straight down on an n x n grid) that holds at least `area` of all
    such hits, so an antenna or a small roof bump never wins."""
    pts = world_points(objs)
    x0, x1 = min(p.x for p in pts), max(p.x for p in pts)
    y0, y1 = min(p.y for p in pts), max(p.y for p in pts)
    ztop = max(p.z for p in pts) + 1.0
    hits = []
    for i in range(n):
        for j in range(n):
            x = x0 + (x1 - x0) * (i + 0.5) / n
            y = y0 + (y1 - y0) * (j + 0.5) / n
            h = ray_hit_world(objs, (x, y, ztop), (0, 0, -1))
            if h is not None and h[1].z > flat:
                hits.append(h[0])
    hits.sort(key=lambda p: -p.z)
    need = max(8, int(len(hits) * area))
    k = 0
    for i, h in enumerate(hits):
        while k < len(hits) and hits[k].z > h.z - band:
            k += 1
        if k - i >= need:
            top = hits[i:k]
            c = sum(top, Vector((0, 0, 0))) / len(top)
            return Vector((c.x, c.y, h.z))
    raise RuntimeError("no roof found")


# surfing stance, game-side joint rotations (glTF frame: +X = the raccoon's left):
# legs apart, arms out for balance, head turned to the camera, tail swung out sideways
RIDE_POSE = {
    "leg_l": (0.0, 0.0, 0.5), "foot_l": (0.0, 0.0, -0.5),
    "leg_r": (0.0, 0.0, -0.5), "foot_r": (0.0, 0.0, 0.5),
    "arm_l": (0.0, 0.0, 2.15), "forearm_l": (0.0, 0.0, 0.25),
    "arm_r": (0.0, 0.0, -1.05), "forearm_r": (0.0, 0.0, -0.2),
    "torso": (0.1, 0.0, 0.16), "head": (-0.05, 0.5, -0.1),
    "ear_l": (0.0, 0.0, 0.15), "ear_r": (0.0, 0.0, -0.15),
    "tail_0": (0.1, -1.35, 0.0), "tail_1": (0.35, -0.2, 0.0), "tail_2": (0.35, -0.1, 0.0),
}


def icon_ride(car="car_hatch"):
    cn, cr = import_glb(car)
    top = roof_top(cn)
    rn, root, by = import_raccoon(EXPR_HAPPY, pose=RIDE_POSE)
    k = 2.0                                   # readability: the raccoon up-scaled vs the car
    root.scale = (k, k, k)
    root.rotation_mode = 'XYZ'
    root.rotation_euler = (0, 0, -70 * D2R)   # side-on surf stance, face toward the camera
    root.location = top
    vis = [o for o in rn if not o.hide_render]
    return dict(objs=cn + vis, view=CAR_VIEW)


# =============================================================================
# icons rendered from the game's GLBs
# =============================================================================
WEAPON_VIEW = (1.0, 0.3, -0.45)        # barrel (-Y) -> image right, a little from above
CAR_VIEW = (1.0, 1.0, -0.8)            # 3/4 front from above, nose -> lower right


def icon_weapon(name, tilt=0.0, view=WEAPON_VIEW):
    new, roots = import_glb(name)
    roots[0].rotation_euler.x = -tilt * D2R        # +tilt raises the barrel
    return dict(objs=new, view=view)


def icon_grenade():
    new, roots = import_glb("wpn_grenade")
    roots[0].rotation_euler = (0, 14 * D2R, 0)
    return dict(objs=new, view=(-0.35, 1.0, -0.3))


def icon_vehicle(name, view=CAR_VIEW):
    new, roots = import_glb(name)
    return dict(objs=new, view=view)


def car_pest_model():
    if os.path.exists(glb("car_pest")):
        return "car_pest"
    print("[icon] WARNING: %s missing; car_pest is a PLACEHOLDER rendered from car_police.glb"
          % glb("car_pest"))
    return "car_police"


def icon_car_pest():
    return icon_vehicle(car_pest_model())


def icon_star():
    new, roots = import_glb("fx_star")
    roots[0].rotation_euler = (0, -8 * D2R, 0)
    return dict(objs=new, view=(0.2, 1.0, -0.14))


def icon_loot_can():
    new, roots = import_glb("loot_can")               # rest pose = lid closed
    roots[0].rotation_euler = (0, 0, -4 * D2R)        # the "?" sticker faces the camera
    return dict(objs=new, view=(0.3, 1.0, -0.38))


def icon_bin():
    """A trash can with a raccoon peeking out from under its lifted lid (hiding)."""
    new, roots = import_glb("trashcan")
    for o in new:
        n = o.name.split('.')[0]
        if n == "lid":
            o.location.z += 0.16
            o.rotation_euler = (-0.3, 0, 0)       # lifted on the front side, where the eyes are
        if n == "peek":
            o.hide_render = False
    roots[0].rotation_euler = (0, 0, -12 * D2R)
    return dict(objs=new, view=(0.22, 1.0, -0.3))


def icon_crown():
    new, roots = import_glb("crown")
    roots[0].rotation_euler = (0, 0, 15 * D2R)
    return dict(objs=new, view=(0.15, 1.0, -0.3))


def icon_tombstone():
    new, roots = import_glb("tombstone")
    return dict(objs=new, view=(0.34, 1.0, -0.3))


def icon_food():
    """A pizza slice (tip down-left, toppings to the camera) with a donut behind it."""
    pn, pr = import_glb("food_pizza")
    dn, dr = import_glb("food_donut")
    p, d = pr[0], dr[0]
    p.rotation_euler = (62 * D2R, 24 * D2R, 0)      # crust is +Y, tip -Y: stand it up
    p.location = (-0.03, -0.06, 0.0)
    d.rotation_euler = (66 * D2R, -14 * D2R, 0)
    d.location = (0.13, 0.12, 0.1)
    return dict(objs=pn + dn, view=(0.15, 1.0, -0.3))


def icon_coffee():
    """The zoomies: the coffee to go, its orange sleeve to the camera and the lid tipped toward it."""
    new, roots = import_glb("coffee")
    roots[0].rotation_euler = (-10 * D2R, 0, 0)
    return dict(objs=new, view=(0.25, 1.0, -0.32))


def icon_gull():
    """The seagull a knocked-out player flies as: three-quarter view, wings raised in a V, its
    head turned a little toward the camera, feet tucked back."""
    new, roots = import_glb("gull")
    by = {base(o): o for o in new}
    for j, rot in (("wing_l", (0, 0, 0.62)), ("wing_r", (0, 0, -0.62)), ("wingtip_l", (0, 0, 0.3)),
                   ("wingtip_r", (0, 0, -0.3)), ("head", (0.06, 0.3, 0.05)), ("leg_l", (0.5, 0, 0)),
                   ("leg_r", (0.5, 0, 0)), ("tail", (0.15, 0, 0))):
        set_game_rotation(by[j], rot)
    return dict(objs=new, view=(-0.55, 1.0, -0.28))


def icon_manhole():
    """The manhole cover in its frame, seen from above at an angle (the hole hidden: lid on)."""
    new, roots = import_glb("manhole")
    for o in new:
        if base(o) == "hole":
            o.hide_render = True
    roots[0].rotation_euler = (0, 0, 8 * D2R)
    return dict(objs=new, view=(0.12, 0.62, -1.0))


def sparkle(mb, m, c, r, view, spin=0.0, depth=0.035):
    """A puffy four-point sparkle facing the camera."""
    pts = []
    for k in range(64):
        a = 2 * math.pi * k / 64
        # an astroid-like 4-point star with soft concave sides
        rr = r * (0.22 + 0.78 * abs(math.cos(2 * a)) ** 6)
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    puffy(mb, smooth_closed(pts, 2), m, depth, c=c, rot=face_camera_rot(view, spin=spin), steps=5, round_in=0.3)


def icon_dumpster_gold():
    """The golden dumpster (jackpot crate), lid and padlock to the camera, with sparkles."""
    view = (0.38, 1.0, -0.42)
    new, roots = import_glb("dumpster_gold")
    roots[0].rotation_euler = (0, 0, -6 * D2R)
    Sp = mat("Sparkle", "#fffdf2", 0.3, emit="#fff4c8", strength=0.9)
    mb = MB()
    sparkle(mb, Sp, (-0.92, -0.62, 1.42), 0.3, view, spin=0)
    sparkle(mb, Sp, (1.02, -0.5, 0.95), 0.19, view, spin=12)
    sparkle(mb, Sp, (-0.55, 0.2, 1.75), 0.13, view, spin=-10)
    ob = mb.to_object("sparkles", sharp_angle=None)
    return dict(objs=new + [ob], view=view)


def splat_outline(n=120):
    """A bird dropping's splash: a lumpy round body with a few short splash tongues."""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        r = 0.4 * (1 + 0.08 * math.sin(5 * t + 0.7) + 0.05 * math.sin(9 * t + 2.1))
        for a0, w, h in ((0.35, 0.16, 0.22), (2.3, 0.14, 0.16), (3.6, 0.12, 0.2), (5.55, 0.15, 0.14)):
            d = math.atan2(math.sin(t - a0), math.cos(t - a0))
            r += h * math.exp(-(d / w) ** 2)
        pts.append((r * math.cos(t), r * math.sin(t)))
    return [(p.x, p.y) for p in smooth_closed(resample_closed(pts, n), 3)]


def icon_splat():
    """A gull dropping (what a gull's poop leaves on you): a white splat with drips running down,
    a creamy-grey swirl and a dark speck in the middle, a wet shine."""
    White = mat("Splat", "#fbf8ef", 0.3)
    Cream = mat("SplatCream", "#e2dccb", 0.4)
    Dark = mat("SplatDark", "#857c6c", 0.45)
    Shine = mat("Shine", "#ffffff", 0.3, emit="#ffffff", strength=0.9)
    mb = MB()
    puffy(mb, splat_outline(), White, 0.13, c=(0, 0, 0.05), steps=7, round_in=0.6)
    # drips running down, each ending in a fat drop
    for (x, z0, z1, r, rd) in ((-0.17, -0.2, -0.66, 0.055, 0.085), (0.13, -0.24, -0.52, 0.045, 0.068),
                               (0.33, -0.12, -0.36, 0.034, 0.05)):
        mb.capsule((x, 0.03, z0), (x + 0.01, 0.03, z1), r * 1.25, White, r1=r, segs=16, hemi=4)
        mb.sphere((x + 0.012, 0.0, z1 - rd * 0.55), (rd, rd * 0.75, rd * 1.12), White, segs=18, rings=10)
    # splash droplets round it
    for (x, z, r) in ((0.62, 0.36, 0.06), (-0.66, 0.22, 0.05), (0.66, -0.1, 0.035), (-0.5, 0.56, 0.035)):
        mb.sphere((x, 0.0, z), (r, r * 0.7, r), White, segs=14, rings=8)
    body = mb.to_object("splat", sharp_angle=None)
    mb = MB()
    # an off-centre lumpy grey dollop with a creamy rim, and a few dark specks
    dollop, rim = [], []
    for k in range(72):
        t = 2 * math.pi * k / 72
        r = 0.115 * (1 + 0.22 * math.sin(3 * t + 0.4) + 0.1 * math.sin(5 * t + 1.9))
        dollop.append((r * math.cos(t), r * math.sin(t) * 0.8))
        rim.append((1.45 * r * math.cos(t + 0.2), 1.45 * r * math.sin(t + 0.2) * 0.8))
    loc, n = ray_hit(body, (0.08, -5, 0.04))
    puffy(mb, rim, Cream, 0.03, c=loc + n * 0.002, rot=normal_frame(n, roll=-25), steps=4, round_in=0.4)
    loc, n = ray_hit(body, (0.08, -5, 0.04))
    puffy(mb, dollop, Dark, 0.05, c=loc + n * 0.02, rot=normal_frame(n, roll=-25), steps=5, round_in=0.3)
    for (x, z, r) in ((-0.12, 0.2, 0.026), (0.26, 0.2, 0.02), (-0.06, -0.14, 0.018)):
        l2, n2 = ray_hit(body, (x, -5, z))
        mb.sphere(l2 + n2 * 0.003, (r, 0.008, r * 0.8), Dark, segs=10, rings=6, rot=normal_frame(n2))
    loc, n = ray_hit(body, (-0.25, -5, 0.3))
    mb.sphere(loc + n * 0.002, (0.075, 0.016, 0.035), Shine, segs=14, rings=8, rot=normal_frame(n, roll=35))
    loc, n = ray_hit(body, (-0.17, -5, -0.47))
    mb.sphere(loc + n * 0.002, (0.022, 0.01, 0.03), Shine, segs=10, rings=6, rot=normal_frame(n))
    feats = mb.to_object("splat_feats", sharp_angle=None)
    return dict(objs=[body, feats], view=(0.1, 1.0, -0.12))


# =============================================================================
# icon-only procedural meshes
# =============================================================================
PINK_PAD = "#ff9bbb"
PAW_GREY = "#77718a"     # the game's FurDark, lifted a little so it reads against the ink


def icon_paw():
    """Paw Slap: a chunky raccoon paw, palm (pink pads) toward the viewer."""
    Paw = mat("Paw", PAW_GREY, 0.8)
    Pad = mat("PawPad", PINK_PAD, 0.38)
    Shine = mat("PadShine", "#ffffff", 0.3, emit="#ffffff", strength=0.6)
    mb = MB()
    mb.superellipsoid((0, 0, 0), (0.37, 0.23, 0.32), Paw, segs=36, rings=22, e_lat=0.8, e_lon=0.85)
    toes = []
    for ang, r, s in ((-52, 0.37, 0.9), (-18, 0.43, 1.0), (18, 0.43, 1.0), (52, 0.37, 0.9)):
        a = ang * D2R
        c = Vector((r * math.sin(a), -0.03, 0.04 + r * math.cos(a)))
        toes.append((c, s, ang))
        mb.sphere(c, (0.135 * s, 0.16 * s, 0.145 * s), Paw, segs=28, rings=16, rot=(0, ang * 0.6, 0))
    # short wrist
    mb.capsule((0, 0.06, -0.18), (0, 0.1, -0.42), 0.22, Paw, r1=0.2, segs=28, hemi=5)
    paw = mb.to_object("paw", sharp_angle=None)
    mb = MB()
    # big palm pad: rounded, wider at the top, three soft lobes along the bottom
    out = []
    for k in range(120):
        t = 2 * math.pi * k / 120
        lobes = 0.06 * max(0.0, -math.sin(t)) * math.cos(3 * (t + math.pi / 2))
        rr = 0.17 * (1 + lobes) * (1 + 0.1 * math.sin(t))
        out.append((rr * math.cos(t) * 1.22, rr * math.sin(t)))
    loc, n = ray_hit(paw, (0.0, -5, -0.05))
    puffy(mb, out, Pad, 0.055, c=loc + n * 0.012, rot=normal_frame(n), steps=6, round_in=0.4)
    l2, n2 = ray_hit(paw, (-0.09, -5, 0.03))
    mb.sphere(l2 + n2 * 0.062, (0.05, 0.012, 0.028), Shine, segs=12, rings=6, rot=normal_frame(n2, roll=-25))
    for c, s, ang in toes:
        loc, n = ray_hit(paw, (c.x, -5, c.z))
        R = normal_frame(n, roll=ang * 0.6)
        mb.sphere(loc + n * 0.006, (0.083 * s, 0.032, 0.09 * s), Pad, segs=20, rings=10, rot=R)
        mb.sphere(loc + n * 0.036 + R @ Vector((-0.025, 0, 0.032)) * s, (0.022, 0.008, 0.017), Shine,
                  segs=10, rings=6, rot=R)
    pads = mb.to_object("paw_pads", sharp_angle=None)
    for o in (paw, pads):
        o.rotation_euler = (0, -14 * D2R, 0)
    return dict(objs=[paw, pads], view=(0.22, 1.0, -0.16))


def icon_cork():
    Cork = speckle_mat("Cork", "#e2ad73", "#c98f55", "#8a5a32", scale=5.0, pore_scale=26.0)
    Top = speckle_mat("CorkTop", "#ecc08c", "#d9a670", "#9a6a3e", scale=5.0, pore_scale=30.0, pore_size=0.13)
    Wine = mat("Wine", "#9b2f5e", 0.55)
    H, r0, r1, e = 0.62, 0.21, 0.26, 0.045
    prof = [(0, 0, Wine), (r0 - e, 0, Wine), (r0 - e * 0.3, e * 0.3, Cork), (r0, e, Cork),
            (r1, H - e, Cork), (r1 - e * 0.3, H - e * 0.3, Top), (r1 - e, H, Top), (0, H, Top)]
    mb = MB()
    mb.lathe(prof, Cork, segs=40, rot=(0, 34, 0), c=(0, 0, -0.3))
    ob = mb.to_object("cork", sharp_angle=50)
    return dict(objs=[ob], view=(0.15, 1.0, -0.38))


def bottle_cap(mb, Top, Side, Inner, c=(0, 0, 0), rot=None, scale=1.0, n_crimp=21, Ring=None):
    """Crown cork: slightly domed top, rounded shoulder, fluted skirt flaring out."""
    segs = n_crimp * 8

    def crimp(j):
        return 0.5 + 0.5 * math.cos(2 * math.pi * n_crimp * j / segs)

    def ring(r, z, flare=0.0):
        pts = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            rr = r + flare * crimp(j)
            pts.append((rr * math.cos(a), rr * math.sin(a), z))
        return pts
    rows, rm = [], []
    rows.append([(0, 0, 0.03)]); rm.append(Inner)
    rows.append(ring(0.46, 0.03)); rm.append(Inner)
    rows.append(ring(0.52, 0.0, 0.075)); rm.append(Side)
    rows.append(ring(0.53, 0.045, 0.08)); rm.append(Side)
    rows.append(ring(0.52, 0.1, 0.05)); rm.append(Side)
    rows.append(ring(0.5, 0.145, 0.016)); rm.append(Side)
    rows.append(ring(0.485, 0.175)); rm.append(Side)
    rows.append(ring(0.455, 0.193)); rm.append(Top)
    if Ring is not None:
        rows.append(ring(0.36, 0.201)); rm.append(Ring)
        rows.append(ring(0.29, 0.204)); rm.append(Top)
    rows.append(ring(0.2, 0.206)); rm.append(Top)
    rows.append([(0, 0, 0.208)]); rm.append(Top)
    mb.grid(rows, Side, row_mats=rm, recalc=True, M=C.xform(c, rot, scale))


def icon_cap():
    """Cap blaster ammo: a crimped bottle cap, a little shiny."""
    Red = mat("CapRed", "#ff4d5e", 0.28, metallic=0.25)
    Ring = mat("CapRing", "#fff3e0", 0.35, metallic=0.1)
    Inner = mat("CapInner", "#c9c6d8", 0.3, metallic=0.5)
    mb = MB()
    bottle_cap(mb, Red, Red, Inner, Ring=Ring)
    ob = mb.to_object("cap", sharp_angle=None)
    return dict(objs=[ob], view=(0.25, 1.0, -0.8))


def crumpled_tin(mb, Tin, Label, Stripe, Hole, c=(0, 0, 0), rot=None, R=0.19, H=0.56):
    """A crushed soda tin (local +Z up, dented toward -Y): accordion folds buckled into
    the middle, the top half bent sideways, a drinking hole in the lid."""
    M = C.xform(c, rot)
    rows, rm = [[(0.0, 0.0, 0.0)]], [Tin]
    nz, segs = 40, 48
    ztop = None
    for i in range(nz + 1):
        t = i / nz
        mid = max(0.0, math.sin(math.pi * (t - 0.12) / 0.76)) if 0.12 < t < 0.88 else 0.0
        taper = 1.0 - 0.1 * max(0.0, (t - 0.9) / 0.1) - 0.08 * max(0.0, (0.06 - t) / 0.06)
        bend = 0.07 * (3 * t * t - 2 * t * t * t)          # the upper half kinks sideways (+X)
        zt = H * t - 0.06 * max(0.0, t - 0.5) * 2
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            side = 0.35 + 0.65 * (0.5 - 0.5 * math.sin(a)) ** 1.5   # deepest dents on -Y
            folds = 0.5 + 0.5 * math.cos(2 * math.pi * 3.0 * t + 0.6 * math.cos(3 * a))
            rr = R * taper * (1 - 0.3 * mid * side * folds)
            ring.append((bend + rr * math.cos(a), rr * math.sin(a), zt - 0.035 * t * math.cos(a)))
        rows.append(ring)
        ztop = zt
        rm.append(Tin if (t < 0.07 or t > 0.9) else (Stripe if 0.44 < t < 0.56 else Label))
    rows.append([(0.07 * 1.0, 0.0, ztop - 0.012)])
    mb.grid(rows, Tin, row_mats=rm, recalc=True, M=M)
    # drinking hole in the (tilted) lid
    tilt = math.atan2(0.035, R * 0.9) / D2R
    mb.sphere(M @ Vector((0.07 + 0.075, 0.0, ztop - 0.019)), (0.05, 0.034, 0.012), Hole, segs=16, rings=6,
              rot=M.to_3x3() @ C.rotmat((0, tilt, 0)))


def hex_bolt(mb, Steel, c=(0, 0, 0), rot=None, L=0.46):
    """Hex head + threaded shank along local +Z (head at the origin)."""
    mb.lathe([(0.0, 0.0), (0.14, 0.0), (0.145, 0.02), (0.145, 0.085), (0.13, 0.105), (0.0, 0.11)],
             Steel, segs=6, c=c, rot=rot, smooth=False)
    prof = [(0.0, 0.1), (0.066, 0.1)]
    z = 0.12
    while z < L - 0.03:
        prof += [(0.066, z), (0.078, z + 0.018)]
        z += 0.04
    prof += [(0.066, L - 0.02), (0.05, L), (0.0, L)]
    mb.lathe(prof, Steel, segs=18, c=c, rot=rot)


def icon_junk():
    """Blunderbuss ammo: a little heap of junk (crumpled tin, bolt, bottle cap)."""
    Steel = mat("Steel", "#c9ccd8", 0.3, metallic=0.45)
    Green = mat("CapGreen", "#57d36b", 0.28, metallic=0.25)     # not red: that's the cap ammo
    Ring = mat("CapRing", "#fff3e0", 0.35, metallic=0.1)
    Inner = mat("CapInner", "#c9c6d8", 0.3, metallic=0.5)
    Tin = mat("Tin", "#d9dde8", 0.3, metallic=0.4)
    Label = mat("TinLabel", "#3ec1ff", 0.45)
    Stripe = mat("TinStripe", "#fff3e0", 0.45)
    Hole = mat("TinHole", "#2b2340", 0.5)
    mb = MB()
    crumpled_tin(mb, Tin, Label, Stripe, Hole, c=(-0.15, 0.12, 0.0), rot=(0, -14, 20))
    hex_bolt(mb, Steel, c=(-0.36, -0.3, 0.14), rot=(0, 85, 22))
    bottle_cap(mb, Green, Green, Inner, c=(0.3, -0.12, 0.13), rot=(58, 0, 30), scale=0.38, Ring=Ring)
    ob = mb.to_object("junk", sharp_angle=50)
    return dict(objs=[ob], view=(0.1, 1.0, -0.5))


def blob(name, puffs, m, stiffness=4.0, threshold=0.6, res=0.012):
    """Spheres [(x, y, z, r)] merged smoothly (a metaball, converted to a mesh).  r is the
    radius a lone puff would have; the element radius is scaled to match."""
    k = 1.0 / math.sqrt(1.0 - (threshold / stiffness) ** (1.0 / 3.0))
    mbd = bpy.data.metaballs.new(name + "_mb")
    mbd.resolution = mbd.render_resolution = res
    mbd.threshold = threshold
    for x, y, z, r in puffs:
        e = mbd.elements.new()
        e.co = (x, y, z)
        e.radius = r * k
        e.stiffness = stiffness
    ob = bpy.data.objects.new(name + "_mb", mbd)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.metaballs.remove(mbd)
    me.name = name
    me.materials.clear()
    me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    mo = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(mo)
    return mo


def icon_fumes():
    """The fumigation gas: a puffy purple cloud with a skull's hollow eyes, sickly green
    puffs behind it and stink squiggles rising."""
    Purple = mat("Fume", "#9b6bff", 0.6)
    Green = mat("FumeGreen", "#a6e05a", 0.6)
    Hole = mat("FumeHole", "#2b2340", 0.45)
    Tooth = mat("FumeTooth", "#efe6ff", 0.5)
    cloud = blob("fumes", [(0.0, 0.0, 0.0, 0.42), (-0.36, 0.02, 0.28, 0.27), (0.02, 0.02, 0.4, 0.29),
                           (0.38, 0.02, 0.27, 0.26), (-0.6, 0.04, 0.0, 0.25), (0.62, 0.04, 0.0, 0.25),
                           (-0.4, 0.0, -0.25, 0.24), (0.0, 0.0, -0.3, 0.26), (0.42, 0.0, -0.25, 0.24),
                           (-0.78, 0.08, -0.22, 0.15), (0.8, 0.08, -0.2, 0.15)], Purple, stiffness=9.0)
    green = blob("fumes_green", [(-0.6, 0.26, 0.3, 0.2), (0.62, 0.26, 0.28, 0.19), (-0.2, 0.3, 0.55, 0.18),
                                 (0.26, 0.3, 0.55, 0.17), (-0.62, 0.1, -0.36, 0.17), (0.64, 0.1, -0.35, 0.16)],
                 Green, stiffness=9.0)
    mb = MB()
    # a hint of a skull: hollow eyes, a little nose, a few teeth
    for s in (1, -1):
        loc, n = ray_hit(cloud, (s * 0.18, -5, 0.1))
        mb.sphere(loc + n * 0.012, (0.12, 0.045, 0.135), Hole, segs=20, rings=12, rot=normal_frame(n, roll=s * 16))
    loc, n = ray_hit(cloud, (0, -5, -0.08))
    tri = []
    for k in range(36):
        a = 2 * math.pi * k / 36
        rr = 0.045 * (1 + 0.22 * math.cos(3 * (a - math.pi / 2)))
        tri.append((rr * math.cos(a), -rr * math.sin(a) * 0.9))
    puffy(mb, tri, Hole, 0.016, c=loc + n * 0.004, rot=normal_frame(n), steps=4)
    loc, n = ray_hit(cloud, (0, -5, -0.24))
    mb.box(loc, (0.24, 0.05, 0.085), Hole, bevel=0.03, bseg=3, rot=normal_frame(n))
    for x in (-0.07, 0.0, 0.07):
        l2, n2 = ray_hit(cloud, (x, -5, -0.235))
        mb.box(l2 + n2 * 0.008, (0.05, 0.05, 0.065), Tooth, bevel=0.016, bseg=2, rot=normal_frame(n2))
    # stink squiggles rising
    for x0, z0, h, ph in ((-0.36, 0.56, 0.4, 0.0), (0.04, 0.68, 0.42, 1.7), (0.42, 0.55, 0.38, 3.1)):
        pts = [Vector((x0 + 0.065 * math.sin(ph + 8.5 * t), 0.08, z0 + h * t)) for t in lerp_list(0.0, 1.0, 24)]
        mb.tube(pts, 0.042, Green, sides=12)
        mb.sphere(pts[-1], 0.042, Green, segs=12, rings=6)
    feats = mb.to_object("fumes_face", sharp_angle=None)
    return dict(objs=[cloud, green, feats], view=(0.12, 1.0, -0.12))


def icon_eye():
    White = mat("EyeWhite", "#fff8ef", 0.35)
    Pupil = mat("Pupil", "#2b2340", 0.3)
    Shine = mat("EyeShine", "#ffffff", 0.3, emit="#ffffff", strength=1.0)
    mb = MB()
    mb.sphere((0, 0, 0), (0.36, 0.26, 0.46), White, segs=40, rings=24)
    ball = mb.to_object("eye", sharp_angle=None)
    mb = MB()
    loc, n = ray_hit(ball, (0.07, -5, 0.02))
    R = normal_frame(n)
    mb.sphere(loc - n * 0.03, (0.19, 0.07, 0.23), Pupil, segs=32, rings=16, rot=R)
    mb.sphere(loc + n * 0.035 + R @ Vector((-0.07, 0, 0.08)), (0.06, 0.02, 0.07), Shine, segs=16, rings=8, rot=R)
    mb.sphere(loc + n * 0.035 + R @ Vector((0.06, 0, -0.08)), (0.026, 0.01, 0.026), Shine, segs=10, rings=6, rot=R)
    feats = mb.to_object("eye_pupil", sharp_angle=None)
    return dict(objs=[ball, feats], view=(0.16, 1.0, -0.1))


def heart_outline(n=128):
    """Classic heart curve, evenly resampled; the cusp and the tip get a small fillet so
    the puffed surface has a soft valley / ridge instead of a hard crease."""
    pts = []
    for k in range(720):
        t = 2 * math.pi * k / 720
        x = 16 * math.sin(t) ** 3
        z = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((x / 17.0, z / 17.0))
    return [(p.x, p.y) for p in smooth_closed(resample_closed(pts, n), 10)]


def icon_heart():
    Red = mat("Heart", "#ff4d6d", 0.28)
    Shine = mat("Shine", "#ffffff", 0.3, emit="#ffffff", strength=1.0)
    mb = MB()
    puffy(mb, heart_outline(), Red, 0.36, center=(0.0, 0.08), steps=10, expo=0.7, round_in=0.85)
    heart = mb.to_object("heart", sharp_angle=None)
    mb = MB()
    loc, n = ray_hit(heart, (-0.47, -5, 0.42))
    mb.sphere(loc - n * 0.006, (0.13, 0.022, 0.07), Shine, segs=16, rings=8,
              rot=normal_frame(n, roll=40))
    loc, n = ray_hit(heart, (-0.26, -5, 0.6))
    mb.sphere(loc - n * 0.004, (0.04, 0.016, 0.04), Shine, segs=10, rings=6, rot=normal_frame(n))
    shine = mb.to_object("heart_shine", sharp_angle=None)
    return dict(objs=[heart, shine], view=(0.24, 1.0, -0.14))


def icon_skull():
    Bone = mat("Bone", "#f6f0e4", 0.5)
    Hole = mat("Socket", "#2b2340", 0.45)
    Shine = mat("Shine", "#ffffff", 0.3, emit="#ffffff", strength=0.9)
    mb = MB()
    mb.sphere((0, 0, 0.1), (0.5, 0.46, 0.46), Bone, segs=32, rings=20)
    mb.superellipsoid((0, -0.07, -0.21), (0.34, 0.32, 0.22), Bone, segs=28, rings=16,
                      e_lat=0.7, e_lon=0.85)
    skull = mb.to_object("skull", sharp_angle=None)
    mb = MB()
    for s in (1, -1):
        loc, n = ray_hit(skull, (s * 0.2, -5, 0.04))
        R = normal_frame(n, roll=s * 10)
        mb.sphere(loc + n * 0.012, (0.14, 0.05, 0.155), Hole, segs=20, rings=12, rot=R)
        sp = loc + n * 0.052 + R @ Vector((-0.045, 0.0, 0.06))
        mb.sphere(sp, (0.032, 0.012, 0.032), Shine, segs=10, rings=6, rot=R)
    # nose: rounded upside-down triangle
    loc, n = ray_hit(skull, (0, -5, -0.15))
    tri = []
    for k in range(36):
        a = 2 * math.pi * k / 36
        rr = 0.06 * (1 + 0.22 * math.cos(3 * (a - math.pi / 2)))
        tri.append((rr * math.cos(a), rr * math.sin(a) * 0.9))
    puffy(mb, [(x, -z) for x, z in tri], Hole, 0.02, c=loc + n * 0.004,
          rot=normal_frame(n), steps=4)
    # teeth on a dark mouth band
    loc, n = ray_hit(skull, (0, -5, -0.31))
    mb.box(loc - n * 0.0, (0.33, 0.06, 0.12), Hole, bevel=0.035, bseg=3, rot=normal_frame(n))
    for x in (-0.108, -0.036, 0.036, 0.108):
        l2, n2 = ray_hit(skull, (x, -5, -0.31))
        mb.box(l2 + n2 * 0.006, (0.062, 0.06, 0.1), Bone, bevel=0.02, bseg=2, rot=normal_frame(n2))
    feats = mb.to_object("skull_face", sharp_angle=None)
    return dict(objs=[skull, feats], view=(0.3, 1.0, -0.2))


def icon_signal():
    G = mat("Signal", "#49dd84", 0.45)
    mb = MB()
    w, gap = 0.27, 0.11
    for i, h in enumerate((0.42, 0.7, 0.98)):
        x = (i - 1) * (w + gap)
        mb.box((x, 0, h / 2), (w, w, h), G, bevel=0.075, bseg=3)
    ob = mb.to_object("signal", sharp_angle=60)
    return dict(objs=[ob], view=(0.42, 1.0, -0.36))


def burst(n, r_out, r_in, phase, jit):
    pts = []
    for k in range(n):
        a = (phase + 360.0 * k / n) * D2R
        b = a + math.pi / n
        ro = r_out * (1 + jit[k % len(jit)])
        ri = r_in * (1 - 0.5 * jit[(k + 3) % len(jit)])
        pts.append((ro * math.cos(a), ro * math.sin(a)))
        pts.append((ri * math.cos(b), ri * math.sin(b)))
    return pts


def icon_boom():
    Red = mat("BoomRed", "#ff4a3d", 0.5, emit="#ff3b2e", strength=0.25)
    Orange = mat("BoomOrange", "#ff9a2e", 0.5, emit="#ff8a1e", strength=0.3)
    Yellow = mat("BoomYellow", "#ffe14a", 0.5, emit="#ffd23f", strength=0.35)
    Core = mat("BoomCore", "#fff8e0", 0.5, emit="#fff4c8", strength=0.6)
    Smoke = mat("Smoke", "#cfc6e2", 0.8)
    jit = [0.0, -0.13, 0.06, -0.07, 0.09, -0.15, 0.03, -0.05, 0.07, -0.11, 0.04]
    mb = MB()
    puffy(mb, burst(11, 1.0, 0.6, 96, jit), Red, 0.16, c=(0, 0.0, 0), steps=5, center=(0, 0))
    puffy(mb, burst(10, 0.74, 0.46, 78, jit[3:] + jit[:3]), Orange, 0.15, c=(0, -0.08, 0), steps=5)
    puffy(mb, burst(9, 0.5, 0.32, 104, jit[5:] + jit[:5]), Yellow, 0.13, c=(0, -0.15, 0), steps=5)
    circ = [(0.21 * math.cos(2 * math.pi * k / 32), 0.21 * math.sin(2 * math.pi * k / 32))
            for k in range(32)]
    puffy(mb, circ, Core, 0.1, c=(0.02, -0.21, 0.02), steps=5)
    for (x, z, r) in ((-0.66, -0.62, 0.2), (-0.36, -0.8, 0.25), (0.04, -0.86, 0.24),
                      (0.42, -0.76, 0.23), (0.7, -0.55, 0.17)):
        mb.sphere((x, 0.14, z), r, Smoke, segs=20, rings=12)
    ob = mb.to_object("boom", sharp_angle=None)
    return dict(objs=[ob], view=(0.12, 1.0, -0.12))


KEY_TOP = "#f2ebe1"     # renders as ~#fff8ef (cream) under the icon light rig
KEY_SIDE = "#d6cde8"
KEY_VIEW = (0.0, 0.42, -1.0)


def keycap_mesh(hx, hy, H=0.5, taper=0.075, e=0.065, rb=0.14, nc=6):
    Top = mat("KeyTop", KEY_TOP, 0.55)
    Side = mat("KeySide", KEY_SIDE, 0.6)
    rows, rm = [], []

    def ring(inset, z):
        r = rb - inset * 0.55
        return [(x, y, z) for x, y in rrect(hx - inset, hy - inset, r, nc)]
    rows.append(ring(0.0, 0.0)); rm.append(Side)
    rows.append(ring(taper * 0.5, (H - e) * 0.5)); rm.append(Side)
    rows.append(ring(taper, H - e)); rm.append(Side)
    for k in range(1, 5):
        th = 0.5 * math.pi * k / 4
        rows.append(ring(taper + e * (1 - math.cos(th)), H - e + e * math.sin(th)))
        rm.append(Side if k < 2 else Top)
    rows.append(ring(taper + e + 0.05, H - 0.006)); rm.append(Top)
    rows.append([(0.0, 0.0, H - 0.009)]); rm.append(Top)
    mb = MB()
    mb.grid(rows, Side, row_mats=rm, cap_first=True, recalc=True)
    ob = mb.to_object("keycap", sharp_angle=None)
    inner = (hx - taper - e, hy - taper - e)
    return ob, H, inner


def icon_keycap(wide=False):
    hx = 1.5 if wide else 0.5
    ob, H, (ix, iy) = keycap_mesh(hx, 0.5)
    corners = [(sx * ix, sy * iy, H) for sx in (-1, 1) for sy in (-1, 1)]
    return dict(objs=[ob], view=KEY_VIEW, center=(0.0, 0.0, H), top_corners=corners,
                size=(ICON_PX * 2, ICON_PX * 2 // 3) if wide else (ICON_PX, ICON_PX))


def icon_mouse():
    Body = mat("MouseBody", "#fff8ef", 0.45)
    Btn = mat("MouseBtn", "#ff5d8f", 0.45)
    Ink = mat("MouseInk", "#2b2340", 0.45)
    RX, RY, RZ, Z0 = 0.38, 0.56, 0.3, 0.06

    def shell(v):
        x, y, z = v
        w = 1.0 + 0.1 * y
        zz = z * (1 + 0.16 * y) if z > 0 else z * 0.3
        return Vector((x * w * RX, y * RY, zz * RZ + Z0))

    def surf(v, out=0.0):
        p = shell(Vector(v).normalized())
        q = shell(Vector(v).normalized() * 1.001)
        return p + (q - p).normalized() * out if out else p
    tb = bmesh.new()
    bmesh.ops.create_uvsphere(tb, u_segments=64, v_segments=40, radius=1.0)
    tb.verts.index_update()
    orig = [v.co.copy() for v in tb.verts]
    fm = []
    for f in tb.faces:
        c = sum((orig[v.index] for v in f.verts), Vector()) / len(f.verts)
        if c.y < -0.1 and c.z > 0.18:
            fm.append((f, Btn if c.x > 0 else Body))
    for v in tb.verts:
        v.co = shell(orig[v.index])
    mb = MB()
    mb._commit(tb, Body, None, True, False, fm)
    # seams between / behind the buttons
    a0, a1 = math.asin(0.18), math.acos(0.1)
    seam = [surf((0, -math.cos(a), math.sin(a)), 0.004) for a in lerp_list(a0 + 0.02, a1, 14)]
    mb.tube(seam, 0.016, Ink, sides=8)
    rho = math.sqrt(1 - 0.01)
    b0 = math.asin(0.18 / rho)
    back = [surf((rho * math.cos(b), -0.1, rho * math.sin(b)), 0.004)
            for b in lerp_list(b0, math.pi - b0, 24)]
    mb.tube(back, 0.016, Ink, sides=8)
    # scroll wheel
    p = surf((0, -0.5, 0.866))
    nrm = (surf((0, -0.5, 0.866), 0.01) - p).normalized()
    wc = p - nrm * 0.03
    mb.cylinder(wc + Vector((-0.04, 0, 0)), wc + Vector((0.04, 0, 0)), 0.075, Ink, segs=20, bevel=0.018)
    # short wiggly cable leaving the front
    tip = surf((0, -1, 0.05))
    cab = smooth_path([tip + Vector((0, 0.03, 0)), tip + Vector((0, -0.1, -0.01)),
                       tip + Vector((0.06, -0.21, -0.03)), tip + Vector((0.0, -0.32, -0.04)),
                       tip + Vector((-0.07, -0.41, -0.04))], 4)
    mb.tube(cab, 0.026, Ink, sides=8)
    mb.sphere(cab[-1], 0.026, Ink, segs=8, rings=6)
    ob = mb.to_object("mouse", sharp_angle=None)
    # seen from behind/above (the user's side): left button (+X) on the image's left
    return dict(objs=[ob], view=(0.24, -0.55, -1.0))


def icon_speaker_off():
    Body = mat("SpkBody", "#6ec3ff", 0.45)
    Inner = mat("SpkInner", "#3b78c8", 0.6)
    Cap = mat("SpkCap", "#2b2340", 0.4)
    Red = mat("MuteX", "#ff4d5e", 0.4, emit="#ff4d5e", strength=0.15)
    view = (1.0, 0.45, -0.34)
    vd, right, up = cam_basis(view)
    mb = MB()
    mb.box((0, 0.22, 0), (0.56, 0.4, 0.62), Body, bevel=0.11, bseg=3)
    prof = [(0.17, -0.06, Body), (0.21, 0.04, Body), (0.33, 0.2, Body), (0.47, 0.36, Body),
            (0.53, 0.44, Body), (0.53, 0.49, Body), (0.49, 0.515, Inner), (0.45, 0.48, Inner),
            (0.2, 0.2, Inner), (0.14, 0.18, Cap), (0.12, 0.24, Cap), (0.07, 0.275, Cap),
            (0, 0.285, Cap)]
    mb.lathe(prof, Body, segs=36, rot=align_z((0, -1, 0)))
    # X kept clear of the speaker (overlaps would get no outline of their own), placed
    # up-right so the icon's bounding box stays squarish and everything renders larger
    xc = Vector((0, -0.35, 0.0)) + right * 0.84 + up * 0.36
    for d in (right + up, right - up):
        d = d.normalized() * 0.27
        mb.capsule(xc - d, xc + d, 0.095, Red, segs=14, hemi=4)
    ob = mb.to_object("speaker_off", sharp_angle=None)
    return dict(objs=[ob], view=view)


# =============================================================================
# registry (order = contact-sheet order)
# (name, builder, model GLBs it is rendered from: `--only` selects an icon by its name, one
#  of these models, or a texture one of these models uses)
# =============================================================================
ICONS = [
    ("raccoon", icon_raccoon, ["raccoon"]),
    ("raccoon_dizzy", icon_raccoon_dizzy, ["raccoon", "fx_star"]),
    ("tombstone", icon_tombstone, ["tombstone"]),
    ("gull", icon_gull, ["gull"]),
    ("splat", icon_splat, []),
    ("crown", icon_crown, ["crown"]),
    ("eye", icon_eye, []),
    ("fumes", icon_fumes, []),
    ("skull", icon_skull, []),
    ("paw", icon_paw, []),
    ("wpn_pistol", lambda: icon_weapon("wpn_pistol", tilt=4), ["wpn_pistol"]),
    ("wpn_smg", lambda: icon_weapon("wpn_smg", tilt=8), ["wpn_smg"]),
    ("wpn_shotgun", lambda: icon_weapon("wpn_shotgun", tilt=32), ["wpn_shotgun"]),
    ("wpn_grenade", icon_grenade, ["wpn_grenade"]),
    ("cork", icon_cork, []),
    ("cap", icon_cap, []),
    ("junk", icon_junk, []),
    ("loot_can", icon_loot_can, ["loot_can"]),
    ("bin", icon_bin, ["trashcan"]),
    ("dumpster_gold", icon_dumpster_gold, ["dumpster_gold"]),
    ("manhole", icon_manhole, ["manhole"]),
    ("food", icon_food, ["food_pizza", "food_donut"]),
    ("coffee", icon_coffee, ["coffee"]),
    ("heart", icon_heart, []),
    ("star", icon_star, ["fx_star"]),
    ("car_hatch", lambda: icon_vehicle("car_hatch"), ["car_hatch"]),
    ("car_taxi", lambda: icon_vehicle("car_taxi"), ["car_taxi"]),
    ("car_pest", icon_car_pest, ["car_pest", "car_police"]),
    ("car_van", lambda: icon_vehicle("car_van"), ["car_van"]),
    ("car_garbage", lambda: icon_vehicle("car_garbage"), ["car_garbage"]),
    ("train_loco", lambda: icon_vehicle("train_loco"), ["train_loco"]),
    ("ride", icon_ride, ["raccoon", "car_hatch"]),
    ("boom", icon_boom, []),
    ("signal", icon_signal, []),
    ("keycap", lambda: icon_keycap(False), []),
    ("keycap_wide", lambda: icon_keycap(True), []),
    ("mouse", icon_mouse, []),
    ("speaker_off", icon_speaker_off, []),
]


# =============================================================================
# image post-processing (numpy only)
# =============================================================================
def load_rgba(path):
    """PNG -> float32 (H, W, 4), rows bottom-up, raw sRGB values, straight alpha."""
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    a = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(h, w, 4)


def postprocess(rgba, ss=SS, radius=OUTLINE_PX):
    """Outline + downsample.  Returns uint8 (h, w, 4), rows top-down."""
    rgb, a = rgba[..., :3], rgba[..., 3]
    ys, xs = np.nonzero(a > 0)
    pad = int(math.ceil(radius * ss)) + 2
    y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + pad + 1)
    o = np.zeros_like(a)
    o[y0:y1, x0:x1] = dilate_disc(a[y0:y1, x0:x1], radius * ss)
    ink = srgb01(INK)
    under = o * (1.0 - a)
    out_a = a + under
    prem = rgb * a[..., None] + ink * under[..., None]
    H, W = a.shape
    h, w = H // ss, W // ss
    prem = prem[:h * ss, :w * ss].reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    al = out_a[:h * ss, :w * ss].reshape(h, ss, w, ss).mean(axis=(1, 3))
    col = np.where(al[..., None] > 1e-6, prem / np.maximum(al, 1e-6)[..., None], ink)
    res = np.concatenate([np.clip(col, 0, 1), np.clip(al, 0, 1)[..., None]], axis=2)[::-1]
    u8 = np.round(res * 255.0).astype(np.uint8)
    u8[u8[..., 3] == 0, :3] = np.round(ink * 255).astype(np.uint8)
    return u8


# =============================================================================
# rendering
# =============================================================================
def clean_scene():
    C.reset_scene()
    for im in list(bpy.data.images):
        if im.type != 'RENDER_RESULT':
            bpy.data.images.remove(im)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def render_icon(name, spec, tmpdir):
    ow, oh = spec.get("size", (ICON_PX, ICON_PX))
    rw, rh = ow * SS, oh * SS
    C.setup_render_transparent((rw, rh), samples=SAMPLES, world_color=(0.93, 0.94, 1.0),
                               world_strength=0.32)
    light_rig(spec["view"], **spec.get("light", {}))
    pad = (OUTLINE_PX + EDGE_PX) * SS
    cam, project = C.frame_camera_tight(spec["objs"], spec["view"], (rw, rh), pad_px=pad,
                                        center=spec.get("center"))
    raw = os.path.join(tmpdir, name + ".png")
    C.render_to(raw)
    img = postprocess(load_rgba(raw))
    path = os.path.join(ICONS_DIR, name + ".png")
    write_png(path, img)
    print("[icon] %-13s %dx%d  %5.1f KB" % (name, img.shape[1], img.shape[0],
                                             os.path.getsize(path) / 1024.0))
    if "top_corners" in spec:
        pts = [project(p) for p in spec["top_corners"]]
        x0 = min(p[0] for p in pts) / SS
        x1 = max(p[0] for p in pts) / SS
        y0 = min(p[1] for p in pts) / SS
        y1 = max(p[1] for p in pts) / SS
        cx0, cx1 = int(x0 + (x1 - x0) * 0.3), int(x1 - (x1 - x0) * 0.3)
        cy0, cy1 = int(y0 + (y1 - y0) * 0.3), int(y1 - (y1 - y0) * 0.3)
        c = img[cy0:cy1, cx0:cx1, :3].reshape(-1, 3).mean(axis=0)
        print("[icon] %-13s top face rect x=%.1f y=%.1f w=%.1f h=%.1f (px, top-left origin), "
              "centre (%.1f, %.1f), rendered colour #%02x%02x%02x" % (
                  name, x0, y0, x1 - x0, y1 - y0, (x0 + x1) / 2, (y0 + y1) / 2, *[int(round(v)) for v in c]))
    return img


# =============================================================================
# contact sheet (with a tiny 5x7 bitmap font for labels)
# =============================================================================
FONT = {
    'a': "01110 10001 10001 11111 10001 10001 10001", 'b': "11110 10001 10001 11110 10001 10001 11110",
    'c': "01110 10001 10000 10000 10000 10001 01110", 'd': "11110 10001 10001 10001 10001 10001 11110",
    'e': "11111 10000 10000 11110 10000 10000 11111", 'f': "11111 10000 10000 11110 10000 10000 10000",
    'g': "01110 10001 10000 10111 10001 10001 01111", 'h': "10001 10001 10001 11111 10001 10001 10001",
    'i': "01110 00100 00100 00100 00100 00100 01110", 'j': "00111 00010 00010 00010 00010 10010 01100",
    'k': "10001 10010 10100 11000 10100 10010 10001", 'l': "10000 10000 10000 10000 10000 10000 11111",
    'm': "10001 11011 10101 10101 10001 10001 10001", 'n': "10001 10001 11001 10101 10011 10001 10001",
    'o': "01110 10001 10001 10001 10001 10001 01110", 'p': "11110 10001 10001 11110 10000 10000 10000",
    'q': "01110 10001 10001 10001 10101 10010 01101", 'r': "11110 10001 10001 11110 10100 10010 10001",
    's': "01111 10000 10000 01110 00001 00001 11110", 't': "11111 00100 00100 00100 00100 00100 00100",
    'u': "10001 10001 10001 10001 10001 10001 01110", 'v': "10001 10001 10001 10001 10001 01010 00100",
    'w': "10001 10001 10001 10101 10101 10101 01010", 'x': "10001 10001 01010 00100 01010 10001 10001",
    'y': "10001 10001 01010 00100 00100 00100 00100", 'z': "11111 00001 00010 00100 01000 10000 11111",
    '_': "00000 00000 00000 00000 00000 00000 11111",
}


def draw_text(img, text, x, y, color, scale=2):
    for ch in text:
        g = FONT.get(ch)
        if g:
            for r, row in enumerate(g.split()):
                for c, bit in enumerate(row):
                    if bit == '1':
                        img[y + r * scale:y + (r + 1) * scale, x + c * scale:x + (c + 1) * scale] = color
        x += 6 * scale


def read_icon(name):
    a = load_rgba(os.path.join(ICONS_DIR, name + ".png"))[::-1]
    return np.round(a * 255).astype(np.uint8)


def contact_sheet(out_png):
    names = [n for n, _f, _d in ICONS if os.path.exists(os.path.join(ICONS_DIR, n + ".png"))]
    cols, cw, chh, pad = 7, ICON_PX + 16, ICON_PX + 36, 8
    cells, k = [], 0
    for n in names:
        span = 2 if n == "keycap_wide" else 1
        if k % cols + span > cols:
            k += cols - k % cols
        cells.append((n, k, span))
        k += span
    rows = (k + cols - 1) // cols
    pw, ph = cols * cw, rows * chh
    panels = []
    yy, xx = np.mgrid[0:ph, 0:pw]
    checker = np.where(((yy // 16 + xx // 16) % 2)[..., None] == 0,
                       np.array([138, 138, 146]), np.array([164, 164, 172]))
    for bg, txt in ((np.broadcast_to(np.round(srgb01("#6ec3ff") * 255), (ph, pw, 3)), INK),
                    (checker, INK),
                    (np.broadcast_to(np.round(srgb01(INK) * 255), (ph, pw, 3)), "#fff8ef")):
        panel = np.array(bg, dtype=np.float32)
        tcol = np.round(srgb01(txt) * 255)
        for n, cell, span in cells:
            ic = read_icon(n).astype(np.float32)
            h, w = ic.shape[:2]
            r, c = divmod(cell, cols)
            x = c * cw + (span * cw - w) // 2
            y = r * chh + pad + (ICON_PX - h) // 2
            al = ic[..., 3:4] / 255.0
            panel[y:y + h, x:x + w] = ic[..., :3] * al + panel[y:y + h, x:x + w] * (1 - al)
            tx = c * cw + (span * cw - len(n) * 12) // 2
            draw_text(panel, n, tx, r * chh + pad + ICON_PX + 6, tcol)
        panels.append(panel)
    gap = np.full((6, pw, 3), 255.0, np.float32)
    sheet = np.concatenate([panels[0], gap, panels[1], gap, panels[2]], axis=0)
    write_png(out_png, np.round(sheet).astype(np.uint8))
    print("[icon] contact sheet ->", out_png, "%dx%d" % (sheet.shape[1], sheet.shape[0]))


# =============================================================================
# outfit thumbnails (the start screen's hat and extras pickers)
# =============================================================================
# Every wearable accessory of raccoon.glb, alone, seen from where it reads best (view
# directions as for the icons: the raccoon faces -Y).  Its `Acc` material takes the
# player's gear colour, so each is rendered twice, Acc black and Acc white: light is linear
# in the albedo, so the item in a colour c is  black + c * (white - black)  in linear light,
# which the menu works out per pixel (src/client/outfitThumbs.ts) for whatever colour you
# pick.  Out: public/assets/icons/outfit.png, a column per item, its base (Acc black, with
# the ink outline) on top and its tint (white - black) below; outfit.json names the columns.
OUTFIT_ITEMS = [
    ("acc_beanie", (0.42, 1.0, -0.2)),
    ("acc_cap", (1.0, 0.1, -0.3)),
    ("acc_pirate", (0.3, 1.0, -0.22)),
    ("acc_tophat", (0.4, 1.0, -0.3)),
    ("acc_headphones", (0.5, 1.0, -0.12)),
    ("acc_cone", (0.4, 1.0, -0.22)),
    ("acc_shades", (0.15, 1.0, -0.05)),
    ("acc_bandana", (0.25, 1.0, -0.15)),
    ("acc_bowtie", (0.1, 1.0, -0.04)),
    ("acc_sack", (0.7, -1.0, -0.28)),
]
OUTFIT_PX = 192
OUTFIT_PNG = os.path.join(ICONS_DIR, "outfit.png")


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def outfit_postprocess(black, white, ss=SS, radius=OUTLINE_PX):
    """The two renders of an item (float (H, W, 4), straight sRGB, rows bottom-up) -> (base,
    tint), uint8 (h, w, 4) rows top-down.  Like postprocess(), but filtered in linear light
    (so a colour mixed in later matches one rendered).  base: Acc black over the ink
    outline, straight alpha.  tint: white - black in linear light over base's alpha,
    sRGB-encoded, and opaque: a browser canvas keeps no colour in see-through pixels."""
    a = black[..., 3]
    ys, xs = np.nonzero(a > 0)
    pad = int(math.ceil(radius * ss)) + 2
    y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + pad + 1)
    o = np.zeros_like(a)
    o[y0:y1, x0:x1] = dilate_disc(a[y0:y1, x0:x1], radius * ss)
    ink = srgb_to_lin(srgb01(INK))
    under = o * (1.0 - a)
    out_a = a + under
    pb = srgb_to_lin(black[..., :3]) * a[..., None]
    pw = srgb_to_lin(white[..., :3]) * white[..., 3:4]
    base_p = pb + ink * under[..., None]
    tint_p = np.maximum(pw - pb, 0.0)
    H, W = a.shape
    h, w = H // ss, W // ss

    def down(x):
        return x[:h * ss, :w * ss].reshape(h, ss, w, ss, *x.shape[2:]).mean(axis=(1, 3))
    al = down(out_a)
    inv = np.where(al > 1e-6, 1.0 / np.maximum(al, 1e-6), 0.0)[..., None]
    base = np.where(al[..., None] > 1e-6, lin_to_srgb(down(base_p) * inv), srgb01(INK))
    tint = lin_to_srgb(down(tint_p) * inv)
    base = np.concatenate([base, np.clip(al, 0, 1)[..., None]], axis=2)[::-1]
    tint = np.concatenate([tint, np.ones_like(al)[..., None]], axis=2)[::-1]
    return np.round(base * 255).astype(np.uint8), np.round(tint * 255).astype(np.uint8)


def acc_colors():
    """The gear colours of src/shared/outfit.ts (ACC_COLORS), for the preview sheet."""
    import re
    try:
        with open(os.path.join(ROOT, "src", "shared", "outfit.ts"), encoding="utf-8") as f:
            src = f.read()
        block = src[src.index("export const ACC_COLORS"):]
        block = block[:block.index("];")]
        return ["#" + h for h in re.findall(r"color: 0x([0-9a-fA-F]{6})", block)]
    except (OSError, ValueError):
        return ["#ff5d8f", "#ffd23f", "#3ec1ff", "#7cff6b"]


def outfit_sheet(cells, out_png):
    """Every thumbnail in every gear colour (mixed like the menu does), on the menu's sheet
    colour: a check of the black / white split."""
    cols = acc_colors()
    n, px, gap = len(cells), OUTFIT_PX, 8
    sheet = np.empty((n * (px + gap) + gap, len(cols) * (px + gap) + gap, 3), np.float32)
    sheet[:] = np.array([26, 20, 48], np.float32)
    for r, (base, tint) in enumerate(cells):
        b = srgb_to_lin(base[..., :3] / 255.0)
        t = srgb_to_lin(tint[..., :3] / 255.0)
        al = base[..., 3:4] / 255.0
        for c, hx in enumerate(cols):
            rgb = lin_to_srgb(b + srgb_to_lin(srgb01(hx)) * t) * 255.0
            y, x = gap + r * (px + gap), gap + c * (px + gap)
            sheet[y:y + px, x:x + px] = rgb * al + sheet[y:y + px, x:x + px] * (1 - al)
    write_png(out_png, np.round(sheet).astype(np.uint8))
    print("[icon] outfit sheet ->", out_png, "%dx%d" % (sheet.shape[1], sheet.shape[0]))


def build_outfit(tmpdir, no_preview=False):
    rw = rh = OUTFIT_PX * SS
    cells = []
    for node, view in OUTFIT_ITEMS:
        t1 = time.time()
        clean_scene()
        new, _root, _by = import_raccoon(show=(node,))
        vis = only_parts(new, {node})
        if not vis:
            raise RuntimeError("raccoon.glb has no %s" % node)
        bpy.context.view_layer.update()
        C.setup_render_transparent((rw, rh), samples=SAMPLES, world_color=(0.93, 0.94, 1.0),
                                   world_strength=0.32)
        light_rig(view)
        C.frame_camera_tight(vis, view, (rw, rh), pad_px=(OUTLINE_PX + EDGE_PX) * SS)
        shots = []
        for tag, col in (("black", "#000000"), ("white", "#ffffff")):
            recolor(vis, {"Acc": col})
            raw = os.path.join(tmpdir, "%s_%s.png" % (node, tag))
            C.render_to(raw)
            shots.append(load_rgba(raw))
        cells.append(outfit_postprocess(*shots))
        print("[icon] outfit %-15s done in %.1fs" % (node, time.time() - t1))
    atlas = np.zeros((2 * OUTFIT_PX, len(cells) * OUTFIT_PX, 4), np.uint8)
    for k, (base, tint) in enumerate(cells):
        atlas[:OUTFIT_PX, k * OUTFIT_PX:(k + 1) * OUTFIT_PX] = base
        atlas[OUTFIT_PX:, k * OUTFIT_PX:(k + 1) * OUTFIT_PX] = tint
    write_png(OUTFIT_PNG, atlas)
    C.write_json(os.path.join(ICONS_DIR, "outfit.json"),
                 {"px": OUTFIT_PX, "items": [node for node, _v in OUTFIT_ITEMS]})
    print("[icon] outfit atlas %dx%d  %5.1f KB" % (atlas.shape[1], atlas.shape[0],
                                                  os.path.getsize(OUTFIT_PNG) / 1024.0))
    if not no_preview:
        outfit_sheet(cells, os.path.join(PREVIEWS, "outfit.png"))


# =============================================================================
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = None
    if "--only" in argv and argv.index("--only") + 1 < len(argv):
        only = set(s.strip() for s in argv[argv.index("--only") + 1].split(",") if s.strip())
    no_preview = "--no-preview" in argv

    def wanted(name, models):
        if only is None or name in only or only & set(models):
            return True
        return any(only & glb_textures(m) for m in models)
    todo = [(n, fn) for n, fn, models in ICONS if wanted(n, models)]
    # the outfit thumbnails: `--only outfit` (or anything that rebuilds the raccoon's icons)
    outfit = wanted("outfit", ["raccoon"])
    if not todo and not outfit:
        print("[icon] --only %s matches no icon (nor a model / texture an icon is rendered from); "
              "nothing to do" % ",".join(sorted(only)))
        return
    os.makedirs(ICONS_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="mini_gta_icons_")
    t0 = time.time()
    try:
        for name, fn in todo:
            t1 = time.time()
            clean_scene()
            spec = fn()
            bpy.context.view_layer.update()
            render_icon(name, spec, tmp)
            print("[icon] %-13s done in %.1fs" % (name, time.time() - t1))
        if outfit:
            build_outfit(tmp, no_preview)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if only is None:
        for n in RETIRED:
            p = os.path.join(ICONS_DIR, n + ".png")
            if os.path.exists(p):
                os.remove(p)
                print("[icon] removed retired icon", n + ".png")
    if not no_preview:
        contact_sheet(os.path.join(PREVIEWS, "icons.png"))
    total = sum(os.path.getsize(os.path.join(ICONS_DIR, f)) for f in os.listdir(ICONS_DIR)
                if f.endswith(".png"))
    print("[icon] %d icon(s) in %.1fs; public/assets/icons total %.1f KB" % (
        len(todo), time.time() - t0, total / 1024.0))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
