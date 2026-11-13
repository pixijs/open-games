"""Build all vehicle / train / building GLBs for mini-gta.

Run (from the project root):
    blender -b --factory-startup --python assets-src/blender/build_vehicles_buildings.py
Optional args after `--`:
    --only car_hatch,bld_house   build just these assets (meta.json is merged)
    --no-preview                 skip preview renders
    --preview-only               re-render the previews from the existing GLBs (no build)

Previews (assets-src/previews/): vehicles / trains / buildings / trash sheets (front 3/4 +
rear view with the collision box), cars_game_view(_full).png (the game camera with
raccoon.glb sat at `seat`), cars_steering.png (steer_wheel at +-90 deg), buildings_decal_slots.png
(decal_slot_* areas as coloured plaques), bld_shop_signs.png (the shopsign_* variants).

Conventions: meters, Blender Z-up, model front = -Y (glTF +Z), left = +X.
Origin = ground contact centre of the footprint.
"""
import json
import math
import os
import struct
import sys
import traceback

import bmesh
import bpy
from mathutils import Matrix, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common_tex as T  # noqa: E402
import common_vb as C  # noqa: E402
import importlib  # noqa: E402
importlib.reload(T)
importlib.reload(C)

ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'models')
PREVIEW_DIR = os.path.join(ROOT, 'assets-src', 'previews')
META_PATH = os.path.join(OUT_DIR, 'vehicles_buildings.meta.json')


# ===========================================================================
# palette
# ===========================================================================
# Few materials per model (each one is a draw per batch): a recolourable 'Paint' / 'Wall',
# the see-through 'Glass', and ONE atlas material 'AtlasTown' for every decal AND every
# small fixed-colour part (trims, lights, tyres, seats...) via the 64 palette swatches.

def A():
    """The shared atlas material (white x atlas_town): decals + palette swatches."""
    return C.tmat('AtlasTown', '#ffffff', 'atlas_town', rough=0.6)


def SW(name):
    """uv= mode: a constant UV at the centre of palette swatch `name` (flat colour)."""
    return ('const',) + tuple(T.swatch_uv(name))


def M_glass():
    """Car glass: alphaMode BLEND (alpha 0.45), double-sided in the GLB; the game culls its
    back faces, so every pane is ONE outward-facing layer and the driver shows through."""
    m = bpy.data.materials.get('Glass')
    if m is not None:
        return m
    m = C.mat('Glass', '#a6d9f7', rough=0.15)
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Alpha'].default_value = 0.45
    m.use_backface_culling = False
    try:
        m.surface_render_method = 'BLENDED'
    except (AttributeError, TypeError):
        pass
    m.diffuse_color = (*C.hex_lin('#a6d9f7'), 0.45)
    return m


# ===========================================================================
# vehicles
# ===========================================================================
# Every car: lower body (Paint) with boolean-cut wheel arches AND a cabin cavity (so the
# seats sit low inside the tub), an open Glass greenhouse under a thin Paint roof slab whose
# top is exactly CAR_TYPES.roof, a low-poly interior, decals 2 cm off their surface, and
#   seat         empty, top-centre of the driver's cushion (+X side = model left), identity
#   steer_column empty at the wheel hub, tilted STEER_TILT deg about X (rest pose)
#   steer_wheel  mesh, child of steer_column with an IDENTITY transform: rim + spokes in its
#                local glTF XY plane, so `rotation.z` spins it about the column.  (The tilt
#                lives on the parent because @pixi/3d's glTF loader writes node rotations to
#                the quaternion only: a tilt on steer_wheel itself would read back as
#                rotation (0,0,0) and be dropped by CarView's `rotation.set(...)`.)

STEER_TILT = 35.0   # wheel plane tilted back from vertical (the column points forward-down)


def extend_top(bottom, top, z):
    """The frustum cross-section (x0, x1, y0, y1) of bottom->top, extrapolated to height z."""
    t = (z - bottom[4]) / (top[4] - bottom[4])
    return tuple(bottom[i] + (top[i] - bottom[i]) * t for i in range(4)) + (z,)


def add_wheels(root, R, width, x, yf, yb):
    """Four wheel objects with their origin at the wheel centre (axle = X).  They share ONE
    mesh datablock ("wheel", exported once): hubcaps on both faces make it symmetric."""
    a = A()
    mb = C.MeshBuilder()
    mb.cyl(R, width, (0, 0, 0), a, axis='X', seg=20, bevel=0.1, bseg=1, uv=SW('rubber'))
    for sx in (1, -1):
        face = sx * (width / 2)
        mb.cyl(R * 0.56, 0.08, (face, 0, 0), a, axis='X', seg=14, uv=SW('cloud'))
        mb.cyl(R * 0.2, 0.06, (face + sx * 0.04, 0, 0), a, axis='X', seg=8, uv=SW('charcoal'))
    shared = None
    for name, sx, y in (('wheel_fl', 1, yf), ('wheel_fr', -1, yf),
                        ('wheel_bl', 1, yb), ('wheel_br', -1, yb)):
        c = Vector((sx * x, y, R))
        if shared is None:
            ob = mb.build(name, location=(0, 0, 0), parent=root)
            ob.data.name = 'wheel'
            shared = ob.data
        else:
            ob = bpy.data.objects.new(name, shared)
            C.scene_coll().objects.link(ob)
            ob.parent = root
        ob.location = c


def carve(shell_fn, arches, arch_r, inner_x, cavities=(), windows=(), outer_x=1.6,
          liner='charcoal', inside='slate', reveal='white'):
    """shell_fn(mb) adds the solid body shells; the exact boolean then cuts the wheel arches
    (dark liners), the cabin cavities (walls + floor in swatch `inside`) and window openings
    (reveals in `reveal`).  The cut faces keep their cutter's swatch UVs.  cavities/windows:
    [(size, loc, rot_or_None)].  Returns a temp object (merge with keep_uv=True)."""
    mb = C.MeshBuilder()
    shell_fn(mb)
    ob = mb.build('_shell')
    a = A()
    cutters = []
    for (x, y, z) in arches:
        s = 1 if x > 0 else -1
        x0, x1 = s * inner_x, s * outer_x
        cm = C.MeshBuilder()
        cm.cyl(arch_r, abs(x1 - x0), ((x0 + x1) / 2, y, z), a, axis='X', seg=24, uv=SW(liner))
        cutters.append(cm.build('_cutter'))
    for boxes, sw in ((cavities, inside), (windows, reveal)):
        for size, loc, rot in boxes:
            cm = C.MeshBuilder()
            cm.box(size, loc, a, rot=rot, uv=SW(sw))
            cutters.append(cm.build('_cutter'))
    C.boolean_cut(ob, cutters)
    return ob


def merge_and_delete(mb, ob, keep_uv=False):
    mb.add_mesh_object(ob, keep_uv=keep_uv)
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(me)


def greenhouse(mb, P, bottom, top, bpillars=(), pw=0.11):
    """Open Glass greenhouse (4 outward-facing walls, no floor / lid) with Paint pillars on
    its corner edges and optional B-pillars at fractions along its length."""
    mb.frustum_shell(bottom, top, M_glass(), r=0.07, seg=2)
    bx0, bx1, by0, by1, bz = bottom
    tx0, tx1, ty0, ty1, tz = top
    for (xi, yi) in ((0, 0), (0, 1), (1, 0), (1, 1)):
        p0 = ((bx0, bx1)[xi], (by0, by1)[yi], bz - 0.02)
        p1 = ((tx0, tx1)[xi], (ty0, ty1)[yi], tz)
        mb.beam(p0, p1, pw, pw, P, r=0.03)
    for yb in bpillars:
        for side in (0, 1):
            p0 = ((bx0, bx1)[side], by0 + (by1 - by0) * yb, bz - 0.02)
            p1 = ((tx0, tx1)[side], ty0 + (ty1 - ty0) * yb, tz)
            mb.beam(p0, p1, pw, pw * 0.8, P, r=0.03)


def roof_glass(mb, P, size, loc, rim_x=0.12, front=0.14, back=0.14, r=0.035):
    """Walkable roof slab (Paint, top exactly loc.z + size.z / 2) with a big flush Glass panel:
    the top-down game camera sees the driver through it.  The opening is boolean-cut (its
    walls stay Paint); the pane sits 3 mm under the top, tucked 5 mm under the rim."""
    sx, sy, sz = size
    cx, cy, cz = loc
    sh = C.MeshBuilder()
    sh.box(size, loc, P, r=r, seg=2)
    ob = sh.build('_roof')
    ox, oy = sx - 2 * rim_x, sy - front - back
    ocy = cy - sy / 2 + front + oy / 2
    cm = C.MeshBuilder()
    cm.box((ox, oy, sz + 0.2), (cx, ocy, cz), P)
    C.boolean_cut(ob, [cm.build('_cutter')])
    merge_and_delete(mb, ob, keep_uv=True)
    mb.quad((cx, ocy, cz + sz / 2 - 0.003), (1, 0, 0), (0, 1, 0), ox + 0.01, oy + 0.01, M_glass(),
            uv=('const', 0, 0))


def car_interior(mb, seat, floor, dash, bench=None, seat_sw='cream', dash_sw='charcoal'):
    """Low-poly interior.  seat = (x, y, z): top-centre of the driver's cushion (passenger
    mirrored at -x); dash = (x_half, y0, y1, z0, z1); bench = (x_half, y_front, z_top)."""
    a = A()
    sx, sy, sz = seat
    for s in (1, -1):
        x = s * sx
        mb.box((0.46, 0.44, 0.10), (x, sy + 0.02, sz - 0.05), a, r=0.035, seg=1, uv=SW(seat_sw))
        if sz - 0.10 > floor + 0.01:  # pedestal down to the floor
            h = sz - 0.10 - floor + 0.02
            mb.box((0.34, 0.30, h), (x, sy + 0.02, floor - 0.02 + h / 2), a, uv=SW(dash_sw),
                   cull=('-Z',))
        mb.box((0.46, 0.10, 0.52), (x, sy + 0.27, sz + 0.21), a, r=0.04, seg=1, rot=(-8, 0, 0),
               uv=SW(seat_sw))
    dx, y0, y1, z0, z1 = dash
    mb.box((2 * dx, y1 - y0, z1 - z0), (0, (y0 + y1) / 2, (z0 + z1) / 2), a, r=0.04, seg=1,
           uv=SW(dash_sw))
    # gauge pod on the dash in front of the driver
    mb.box((0.30, 0.10, 0.08), (sx, y1 - 0.06, z1 + 0.03), a, r=0.03, seg=1, uv=SW('slate'))
    if bench is not None:
        bx, by, bz = bench
        mb.box((2 * bx, 0.42, 0.10), (0, by + 0.21, bz - 0.05), a, r=0.035, seg=1, uv=SW(seat_sw))
        if bz - 0.10 > floor + 0.01:
            h = bz - 0.10 - floor + 0.02
            mb.box((2 * bx - 0.1, 0.36, h), (0, by + 0.21, floor - 0.02 + h / 2), a,
                   uv=SW(dash_sw), cull=('-Z',))
        mb.box((2 * bx, 0.10, 0.44), (0, by + 0.47, bz + 0.18), a, r=0.04, seg=1, rot=(-10, 0, 0),
               uv=SW(seat_sw))


def steering(root, body, center, R=0.17, rim='ink', hub='red'):
    """`steer_column` (tilted rest pose) -> `steer_wheel` (identity; spins about local glTF
    Z = Blender local -Y).  The fixed column shaft goes into the body mesh."""
    a = A()
    t = math.radians(STEER_TILT)
    axis = Vector((0, -math.cos(t), -math.sin(t)))           # hub -> dashboard
    c = Vector(center)
    body.beam(c + axis * 0.03, c + axis * 0.26, 0.05, 0.05, a, uv=SW('charcoal'))
    col = C.empty('steer_column', tuple(c), parent=root, size=0.1, rot=(STEER_TILT, 0, 0))
    mb = C.MeshBuilder()
    # rim + spokes in the local XZ plane (= glTF local XY), spokes at 3, 9 and 6 o'clock
    mb.torus(R, 0.026, (0, 0, 0), a, seg=20, rseg=6, rot=(90, 0, 0), uv=SW(rim))
    for ang in (0.0, 180.0, 270.0):
        d = Vector((math.cos(math.radians(ang)), 0, math.sin(math.radians(ang))))
        mb.beam(d * 0.04, d * (R - 0.012), 0.04, 0.022, a, uv=SW(rim))
    mb.cyl(0.055, 0.05, (0, 0, 0), a, axis='Y', seg=12, uv=SW(rim))
    mb.cyl(0.038, 0.014, (0, 0.03, 0), a, axis='Y', seg=12, uv=SW(hub))   # horn, toward the driver
    mb.build('steer_wheel', location=(0, 0, 0), parent=col)
    return col


def headlights(mb, xs, y, z, r=0.14, depth=0.12):
    a = A()
    for x in xs:
        mb.cyl(r + 0.035, depth * 0.8, (x, y + 0.02, z), a, axis='Y', seg=14, uv=SW('chrome'))
        mb.cyl(r, depth, (x, y - 0.01, z), a, axis='Y', seg=14, uv=SW('butter'))


def plates(mb, y_face, z, cell, w=0.36, h=0.155):
    """Front (-Y) and back (+Y) licence plates on bumper faces at |y| = y_face: a dark holder
    and the plate decal 3 cm in front of the bumper (2 cm in front of the holder)."""
    a = A()
    for s, face in ((-1, '-Y'), (1, '+Y')):
        mb.box((w + 0.05, 0.03, h + 0.05), (0, s * (y_face - 0.005), z), a, uv=SW('charcoal'))
        mb.decal(face, y_face + 0.01, 0, z, w, h, cell, m=a, off=0.02)


def car_nodes(root, seat):
    C.empty('seat', seat, parent=root, size=0.15)


def build_car_hatch():
    root = C.empty('car_root')
    P = C.mat('Paint', '#ff6b6b', rough=0.4)
    a = A()
    R, TW, WX, WY = 0.37, 0.34, 0.79, 1.22
    arches = [(sx * WX, sy * WY, R) for sx in (1, -1) for sy in (1, -1)]

    def shell(mb):
        mb.box((2.0, 3.7, 0.74), (0, 0, 0.25 + 0.37), P, r=0.33, seg=3)
    # cabin tub: full length between the arches' inner faces, wider pockets between the arches
    cav = [((1.14, 2.32, 1.10), (0, 0.36, 0.31 + 0.55), None),
           ((0.25, 1.44, 1.06), (0.685, 0.0, 0.34 + 0.53), None),
           ((0.25, 1.44, 1.06), (-0.685, 0.0, 0.34 + 0.53), None)]
    body = C.MeshBuilder()
    merge_and_delete(body, carve(shell, arches, R + 0.09, 0.58, cav, inside='charcoal'), keep_uv=True)
    # glass bubble + walkable roof (top exactly 1.45)
    gb = (-0.86, 0.86, -0.85, 1.6, 0.92)
    greenhouse(body, P, gb, extend_top(gb, (-0.73, 0.73, -0.3, 1.46, 1.33), 1.37), bpillars=(0.45,))
    roof_glass(body, P, (1.62, 1.88, 0.10), (0, 0.585, 1.40))
    seat, wheel = (0.36, 0.0, 0.34), (0.36, -0.35, 0.64)
    car_interior(body, seat, 0.31, (0.56, -0.80, -0.52, 0.45, 0.95), bench=(0.55, 0.70, 0.40),
                 seat_sw='terracotta', dash_sw='slate')
    # bumpers, plates, lights, grille
    for s in (-1, 1):
        body.box((1.86, 0.24, 0.26), (0, s * 1.758, 0.38), a, r=0.1, seg=2, uv=SW('charcoal'))
    plates(body, 1.878, 0.40, 'car_plate_a')
    headlights(body, (0.6, -0.6), -1.83, 0.72)
    body.box((0.62, 0.06, 0.14), (0, -1.86, 0.56), a, r=0.05, seg=2, uv=SW('charcoal'))
    for x in (0.66, -0.66):
        body.box((0.26, 0.06, 0.16), (x, 1.85, 0.74), a, r=0.04, seg=1, uv=SW('red'))
    for s in (1, -1):  # mirrors + door handles
        body.beam((s * 0.84, -0.72, 0.98), (s * 1.0, -0.74, 1.02), 0.06, 0.06, P)
        body.box((0.08, 0.18, 0.13), (s * 1.03, -0.74, 1.06), P, r=0.035, seg=1)
        body.box((0.05, 0.16, 0.03), (s * 0.93, 0.25, 0.86), a, uv=SW('charcoal'))
    steering(root, body, wheel)
    body.build('body', parent=root)
    add_wheels(root, R, TW, WX, -WY, WY)
    car_nodes(root, seat)
    return root


SEDAN = dict(R=0.38, WX=0.79, WY=1.38, r_body=0.12,
             cab_bottom=(-0.88, 0.88, -0.95, 1.18, 0.95),
             cab_top=(-0.76, 0.76, -0.48, 0.92, 1.38),
             seat=(0.37, -0.15, 0.38), wheel=(0.37, -0.50, 0.68))


def sedan_base(P, interior='charcoal', seats='cream', handle_z=0.9, rim_front=0.14, rim_back=0.14):
    """Shared 4.2 m sedan (taxi / pest control).  Flat-ish sides (r 0.12) so door decals sit
    on a 50 cm flat band.  Roof slab top exactly 1.50."""
    s = SEDAN
    a = A()
    R, WX, WY = s['R'], s['WX'], s['WY']
    arches = [(sx * WX, sy * WY, R) for sx in (1, -1) for sy in (1, -1)]

    def shell(mb):
        mb.box((2.0, 4.06, 0.74), (0, 0, 0.27 + 0.37), P, r=s['r_body'], seg=3)
    cav = [((1.14, 2.00, 1.17), (0, 0.12, 0.33 + 0.585), None),
           ((0.25, 1.72, 1.14), (0.685, 0.0, 0.36 + 0.57), None),
           ((0.25, 1.72, 1.14), (-0.685, 0.0, 0.36 + 0.57), None)]
    body = C.MeshBuilder()
    merge_and_delete(body, carve(shell, arches, R + 0.09, 0.58, cav, inside=interior), keep_uv=True)
    greenhouse(body, P, s['cab_bottom'], extend_top(s['cab_bottom'], s['cab_top'], 1.40), bpillars=(0.5,))
    roof_glass(body, P, (1.66, 1.6, 0.12), (0, 0.22, 1.44), front=rim_front, back=rim_back)  # top 1.50
    car_interior(body, s['seat'], 0.33, (0.56, -0.88, -0.64, 0.48, 0.97), bench=(0.55, 0.52, 0.42),
                 seat_sw=seats, dash_sw='slate')
    for sgn in (-1, 1):
        body.box((1.88, 0.24, 0.26), (0, sgn * 1.958, 0.4), a, r=0.1, seg=2, uv=SW('charcoal'))
    headlights(body, (0.62, -0.62), -2.02, 0.74)
    body.box((0.7, 0.06, 0.14), (0, -2.04, 0.58), a, r=0.05, seg=2, uv=SW('charcoal'))
    for x in (0.68, -0.68):
        body.box((0.28, 0.06, 0.16), (x, 2.04, 0.76), a, r=0.04, seg=1, uv=SW('red'))
    for sgn in (1, -1):
        body.beam((sgn * 0.85, -0.78, 1.0), (sgn * 1.0, -0.8, 1.04), 0.06, 0.06, P)
        body.box((0.08, 0.18, 0.13), (sgn * 1.03, -0.8, 1.08), P, r=0.035, seg=1)
        hx = 0.985 if handle_z <= 0.9 else 0.975     # 1 cm proud of the door band
        for y in (-0.3, 0.55):
            body.box((0.05, 0.16, 0.03), (sgn * hx, y, handle_z), a, uv=SW('charcoal'))
    return body


def build_car_taxi():
    root = C.empty('car_root')
    P = C.mat('Paint', '#ffd23f', rough=0.4)
    a = A()
    s = SEDAN
    body = sedan_base(P, interior='charcoal', seats='grape', rim_front=0.30)
    plates(body, 2.078, 0.42, 'car_plate_b')
    # checker strip along both doors (flat side band z 0.39..0.89)
    for face in ('+X', '-X'):
        body.decal(face, 1.0, 0.0, 0.64, 1.6, 0.32, 'car_checker', m=a)
    # TAXI roof light near the front of the roof, lettering front and back
    body.box((0.72, 0.28, 0.04), (0, -0.43, 1.52), a, r=0.015, uv=SW('charcoal'))
    body.box((0.62, 0.22, 0.18), (0, -0.43, 1.63), a, r=0.03, seg=1, uv=SW('butter'))
    body.decal('-Y', 0.54, 0.0, 1.63, 0.40, 0.17, 'car_taxi_sign', m=a, off=0.012)
    body.decal('+Y', -0.32, 0.0, 1.63, 0.40, 0.17, 'car_taxi_sign', m=a, off=0.012)
    steering(root, body, s['wheel'])
    body.build('body', parent=root)
    add_wheels(root, s['R'], 0.34, s['WX'], -s['WY'], s['WY'])
    car_nodes(root, s['seat'])
    return root


def build_car_pest():
    """PEST CONTROL: white sedan (Paint, the game multiplies it by 0xf6f3ee), door lettering
    with the crossed-out raccoon, an A-frame roof sign and the pulsing siren bar."""
    root = C.empty('car_root')
    P = C.mat('Paint', '#f6f3ee', rough=0.4)
    a = A()
    s = SEDAN
    body = sedan_base(P, interior='charcoal', seats='leaf', handle_z=0.95, rim_front=0.34, rim_back=0.46)
    plates(body, 2.078, 0.42, 'car_plate_a')
    for face in ('+X', '-X'):
        body.decal(face, 1.0, 0.0, 0.64, 1.16, 0.54, 'car_pest_control', m=a)
    # A-frame roof sign across the rear rim: sign_pest_control facing front and back
    yc, L, hb, z0, hr = 0.79, 0.86, 0.17, 1.53, 0.28
    body.box((L + 0.10, 0.40, 0.03), (0, yc, 1.515), a, r=0.01, uv=SW('charcoal'))
    body.poly_prism([(yc - hb, z0), (yc + hb, z0), (yc, z0 + hr)], -L / 2, L / 2, a, axis='X',
                    uv=SW('leaf'))
    sl = math.hypot(hb, hr)
    for sy in (-1, 1):
        n = Vector((0, sy * hr, hb)) / sl                      # outward normal of the slope
        up = Vector((0, -sy * hb, hr)) / sl                    # up the slope, toward the ridge
        right = Vector((-sy, 0, 0))                            # viewer's right on that side
        ctr = Vector((0, yc + sy * hb / 2, z0 + hr / 2)) + n * 0.012
        h = sl - 0.025
        body.quad(ctr, right, up, h * 2.143, h, a, cell='sign_pest_control')
    # siren bar on the front rim (separate nodes, emissive materials pulsed by CarView)
    body.box((1.3, 0.30, 0.08), (0, -0.41, 1.54), a, r=0.03, seg=1, uv=SW('charcoal'))
    steering(root, body, s['wheel'])
    body.build('body', parent=root)
    blue = C.mat('SirenBlue', '#3d7bff', rough=0.35, emit='#2f6bff', strength=3.0)
    red = C.mat('SirenRed', '#ff3d4d', rough=0.35, emit='#ff2233', strength=3.0)
    for name, x, m in (('siren_l', 0.33, blue), ('siren_r', -0.33, red)):
        c = (x, -0.41, 1.65)
        mb = C.MeshBuilder()
        mb.box((0.54, 0.28, 0.17), c, m, r=0.07, seg=2)
        mb.build(name, location=c, parent=root)
    add_wheels(root, s['R'], 0.34, s['WX'], -s['WY'], s['WY'])
    car_nodes(root, s['seat'])
    return root


def build_car_van():
    root = C.empty('car_root')
    P = C.mat('Paint', '#ff9ecf', rough=0.4)
    a = A()
    R, TW, WX, WY = 0.4, 0.36, 0.86, 1.55
    arches = [(sx * WX, sy * WY, R) for sx in (1, -1) for sy in (1, -1)]
    # front face is slightly raked: y_front(z) = -1.76 + 0.13*(z-0.3)
    yf = lambda z: -1.76 + 0.13 * (z - 0.3)  # noqa: E731
    rake = -math.degrees(math.atan(0.13))

    def shell(mb):
        # pink skirt z 0.3..1.12 (Paint) + nose/hood, mint band, white upper body (flat roof 2.2)
        mb.hull_box((-1.1, 1.1, yf(0.3), 2.3, 0.3), (-1.1, 1.1, yf(1.12), 2.3, 1.12), P,
                    r=0.24, seg=2, edges='botvert')
        mb.box((2.16, 0.86, 0.88), (0, -1.97, 0.3 + 0.44), P, r=0.26, seg=2)
        mb.hull_box((-1.11, 1.11, yf(1.12) - 0.01, 2.31, 1.12), (-1.11, 1.11, yf(1.3) - 0.01, 2.31, 1.3),
                    a, r=0.24, seg=2, edges='vert', uv=SW('mint'))
        mb.hull_box((-1.1, 1.1, yf(1.3), 2.3, 1.3), (-1.1, 1.1, yf(2.2), 2.3, 2.2), a,
                    r=0.24, seg=2, edges='topvert', uv=SW('white'))
        mb.hull_box((-1.112, 1.112, yf(0.6) - 0.01, 2.0, 0.6), (-1.112, 1.112, yf(0.68) - 0.01, 2.0, 0.68),
                    a, r=0.2, seg=2, edges='vert', uv=SW('mint'))
    cab = [((1.84, 0.88, 1.18), (0, -1.06, 0.92 + 0.59), None)]   # x +-0.92, y -1.50..-0.62, z 0.92..2.10
    wins = [((0.5, 0.60, 0.54), (sx * 1.05, -1.12, 1.70), None) for sx in (1, -1)]
    wins.append(((1.64, 0.40, 0.56), (0, yf(1.68) + 0.02, 1.68), (rake, 0, 0)))
    wins.append(((1.40, 0.56, 0.30), (0, -0.99, 2.2), None))     # sunroof over the cab (flat roof part)
    body = C.MeshBuilder()
    merge_and_delete(body, carve(shell, arches, R + 0.1, 0.62, cab, wins, inside='grape', reveal='white'),
                     keep_uv=True)
    # glass panes, 1.2 cm inside the outer skin, facing out
    G = M_glass()
    for sx in (1, -1):
        body.quad((sx * 1.088, -1.12, 1.70), (0, sx, 0), (0, 0, 1), 0.60, 0.54, G, uv=('const', 0, 0))
    up = Vector((0, 0.13, 1)).normalized()
    body.quad((0, yf(1.68) + 0.012, 1.68), (1, 0, 0), up, 1.64, 0.56, G, uv=('const', 0, 0))
    body.quad((0, -0.99, 2.197), (1, 0, 0), (0, 1, 0), 1.41, 0.57, G, uv=('const', 0, 0))
    seat, wheel = (0.42, -1.0, 1.03), (0.42, -1.35, 1.33)
    car_interior(body, seat, 0.92, (0.90, -1.50, -1.36, 1.12, 1.40), bench=None,
                 seat_sw='aqua', dash_sw='charcoal')
    # serving window on the LEFT side (+X)
    body.box((0.05, 1.86, 0.86), (1.1, 0.42, 1.72), a, r=0.05, seg=1, uv=SW('white'))
    body.box((0.05, 1.66, 0.66), (1.115, 0.42, 1.74), a, r=0.03, seg=1, uv=SW('grape'))
    body.box((0.32, 1.86, 0.07), (1.2, 0.42, 1.3), a, r=0.03, seg=1, uv=SW('mint'))  # counter
    for y, scoop in ((0.05, 'pink'), (0.75, 'seafoam')):  # mini cones on the counter
        body.cyl(0.005, 0.18, (1.22, y, 1.425), a, r2=0.055, seg=8, uv=SW('tan'))
        body.sphere(0.065, (1.22, y, 1.53), a, seg=8, rings=5, uv=SW(scoop))
    n = 8   # striped awning over the serving window
    for i in range(n):
        y = 0.42 - 0.93 + (i + 0.5) * (1.86 / n)
        if i % 2 == 0:
            body.beam((1.1, y, 2.12), (1.42, y, 1.98), 1.86 / n, 0.04, P)
        else:
            body.beam((1.1, y, 2.12), (1.42, y, 1.98), 1.86 / n, 0.04, a, uv=SW('white'))
    # menu boards: next to the hatch (left) and big on the right side
    body.decal('+X', 1.1, -1.72, 1.70, 0.56, 0.56, 'car_icecream_menu', m=a)
    body.decal('-X', 1.1, 0.45, 1.64, 0.62, 0.62, 'car_icecream_menu', m=a)
    # rear: doors with windows, taillights, bumpers, plates
    for sx in (1, -1):
        body.box((0.6, 0.05, 0.45), (sx * 0.45, 2.31, 1.72), a, uv=SW('glass'))
        body.box((0.2, 0.06, 0.32), (sx * 0.86, 2.3, 0.9), a, r=0.04, seg=1, uv=SW('red'))
    body.box((0.03, 0.04, 1.5), (0, 2.31, 1.2), a, uv=SW('charcoal'))   # door seam
    for sgn in (-1, 1):
        body.box((2.0, 0.24, 0.28), (0, sgn * 2.288, 0.42), a, r=0.1, seg=1, uv=SW('charcoal'))
    plates(body, 2.408, 0.44, 'car_plate_b', w=0.38, h=0.163)
    headlights(body, (0.64, -0.64), -2.36, 0.86, r=0.15)
    body.box((0.8, 0.06, 0.16), (0, -2.4, 0.62), a, r=0.05, seg=2, uv=SW('charcoal'))
    for sx in (1, -1):  # mirrors
        body.beam((sx * 1.05, -1.6, 1.45), (sx * 1.18, -1.62, 1.5), 0.06, 0.06, a, uv=SW('white'))
        body.box((0.08, 0.2, 0.16), (sx * 1.2, -1.62, 1.55), a, r=0.035, seg=1, uv=SW('white'))
    # ---- giant ice-cream cone on the roof (rear 35%) ----
    cy = 1.62
    body.cyl(0.5, 0.16, (0, cy, 2.26), a, seg=16, bevel=0.05, uv=SW('mint'))
    body.cyl(0.32, 0.12, (0, cy, 2.36), a, seg=16, r2=0.22, uv=SW('mint'))
    body.cyl(0.08, 1.0, (0, cy, 2.32 + 0.5), a, r2=0.55, seg=16, uv=SW('tan'))
    for zz, rr in ((2.66, 0.27), (2.96, 0.43)):  # waffle bands (cone radius at zz)
        body.cyl(rr + 0.02, 0.06, (0, cy, zz), a, seg=16, caps=False, uv=SW('caramel'))
    body.sphere(0.56, (0, cy, 3.4), a, seg=14, rings=9, uv=SW('pink'))
    body.torus(0.52, 0.1, (0, cy, 3.2), a, seg=14, rseg=5, uv=SW('pink'))  # drip rim
    body.sphere(0.45, (0, cy, 3.86), a, seg=14, rings=8, uv=SW('seafoam'))
    body.sphere(0.14, (0, cy, 4.34), a, seg=10, rings=6, uv=SW('cherry'))
    body.beam((0, cy, 4.44), (0.05, cy + 0.04, 4.6), 0.03, 0.03, a, uv=SW('forest'))
    steering(root, body, wheel)
    body.build('body', parent=root)
    add_wheels(root, R, TW, WX, -WY, WY)
    car_nodes(root, seat)
    return root


# ---- the garbage truck (Garbage Day's boss vehicle) -------------------------------------
# Footprint 2.5 x 6.6, a flat walkable top at exactly GB_TOP over the cab, the compactor body
# and the tailgate (the game uses one 2.8 m box).  Blender frame here (front -Y, left +X).
GB_TOP = 2.8
GB_R, GB_TW, GB_WX, GB_WY = 0.5, 0.44, 0.99, 2.0
# side loader on the RIGHT (-X, the curb side): `lift` turns about the truck's length axis at
# its hinge on the chassis; at rotation 0 it holds the carried dumpster up against the right
# flank (bin_socket = the dumpster's bottom centre); glTF rotation.z = +GB_LIFT_LOWERED swings
# the arm out and down until a carried golden dumpster's outer bottom edge meets the street.
GB_LIFT_HINGE = Vector((-0.6, 0.8, 0.45))        # glTF (-0.6, 0.45, -0.8)
GB_BIN_SOCKET = Vector((-1.95, 0.8, 0.9))        # glTF (-1.95, 0.9, -0.8)
GB_LIFT_LOWERED = 0.42
GB_TAILGATE_HINGE = Vector((0.0, 2.235, GB_TOP))  # glTF (0, 2.8, -2.235)


def text_decal(mb, text, center, right, up, height, sw, offset=0.035, res=3, m=None):
    """Flat lettering (Blender's built-in font, thickened by `offset` font units) merged into
    `mb` as one palette swatch: centred on `center`, `height` m tall (cap to baseline of the
    glyph bounds), reading along `right` with `up` up (its faces point along right x up)."""
    m = m or A()
    cu = bpy.data.curves.new('_txt', 'FONT')
    cu.body = text
    cu.size = 1.0
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.offset = offset
    cu.extrude = 0.0
    cu.resolution_u = res
    ob = bpy.data.objects.new('_txt', cu)
    C.scene_coll().objects.link(ob)
    bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    s = height / max(max(ys) - min(ys), 1e-6)
    for l in list(me.uv_layers):          # the font mesh comes with its own "UVMap": replace it
        me.uv_layers.remove(l)
    uvl = me.uv_layers.new(name=C.UV_NAME)
    u, v = T.swatch_uv(sw)
    uvl.uv.foreach_set('vector', [u, v] * len(me.loops))
    me.materials.append(m)
    tmp = bpy.data.objects.new('_txtmesh', me)
    C.scene_coll().objects.link(tmp)
    r, up_, n = Vector(right).normalized(), Vector(up).normalized(), None
    n = r.cross(up_)
    R = Matrix((r * s, up_ * s, n)).transposed().to_4x4()
    M = Matrix.Translation(Vector(center)) @ R @ Matrix.Translation((-cx, -cy, 0.0))
    bpy.context.view_layer.update()
    mb.add_mesh_object(tmp, matrix=M, keep_uv=True)
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(me)
    w = (max(xs) - min(xs)) * s
    return w


def circle_pts(r, n, c=(0.0, 0.0), sy=1.0, phase=0.0):
    return [(c[0] + r * math.cos(2 * math.pi * k / n + phase), c[1] + sy * r * math.sin(2 * math.pi * k / n + phase))
            for k in range(n)]


def trash_logo(mb, side, y, z, R=0.33):
    """CITY WASTE badge on a body flank (side = +1 left / -1 right, flank at |x| = 1.2): a white
    disc with a dark green trash can (lid, handle, three white slots)."""
    a = A()
    x0 = side * 1.2

    def plate(pts, t0, t1, sw):
        mb.poly_prism([(y + py, z + pz) for py, pz in pts], x0 + side * t0, x0 + side * t1, a, axis='X',
                      uv=SW(sw))
    plate(circle_pts(R, 20), 0.0, 0.022, 'white')
    plate(circle_pts(R - 0.035, 20), 0.0, 0.028, 'forest')            # green ring line inside the rim
    plate(circle_pts(R - 0.06, 20), 0.0, 0.034, 'white')
    # the can (pts are (along y, up z); the logo reads the same from both sides)
    can = [(-0.105, -0.17), (0.105, -0.17), (0.125, 0.07), (-0.125, 0.07)]
    plate(can, 0.0, 0.044, 'forest')
    plate([(-0.15, 0.085), (0.15, 0.085), (0.15, 0.13), (-0.15, 0.13)], 0.0, 0.044, 'forest')   # lid
    plate([(-0.045, 0.13), (0.045, 0.13), (0.045, 0.165), (-0.045, 0.165)], 0.0, 0.044, 'forest')
    for k in (-1, 0, 1):
        dy = k * 0.06
        plate([(dy - 0.014, -0.13), (dy + 0.014, -0.13), (dy + 0.017, 0.035), (dy - 0.017, 0.035)],
              0.0, 0.05, 'white')


def roof_logo(mb, y, top, R=0.62):
    """The trash-can badge lying flat on the roof (top-down camera), at most 2.5 cm proud."""
    a = A()

    def plate(pts, t, sw):
        # poly_prism axis='Z': pts are (x, y), extruded top-0.004 .. top+t
        mb.poly_prism([(px, y + py) for px, py in pts], top - 0.004, top + t, a, axis='Z', uv=SW(sw))
    plate(circle_pts(R, 24), 0.005, 'white')
    plate(circle_pts(R - 0.06, 24), 0.01, 'forest')
    plate(circle_pts(R - 0.105, 24), 0.015, 'white')
    k = R / 0.33                                       # the flank badge's can, scaled up
    # the can stands with its lid toward the cab (-y), read by a camera behind the truck
    def P(pts):
        return [(-px * k, -pz * k) for px, pz in pts]
    plate(P([(-0.105, -0.17), (0.105, -0.17), (0.125, 0.07), (-0.125, 0.07)]), 0.02, 'forest')
    plate(P([(-0.15, 0.085), (0.15, 0.085), (0.15, 0.13), (-0.15, 0.13)]), 0.02, 'forest')
    plate(P([(-0.045, 0.13), (0.045, 0.13), (0.045, 0.165), (-0.045, 0.165)]), 0.02, 'forest')
    for j in (-1, 0, 1):
        d = j * 0.06
        plate(P([(d - 0.014, -0.13), (d + 0.014, -0.13), (d + 0.017, 0.035), (d - 0.017, 0.035)]), 0.025, 'white')


def build_car_garbage():
    """GARBAGE TRUCK, Garbage Day's boss: a white flat-faced cab-over cab, a big green compactor
    body (Paint: the game recolours it), a rear hopper `tailgate` hinged at its top front edge
    (+rotation.x swings it up), a yellow side-loader `lift` on the right flank with
    `bin_socket` at the carried dumpster's bottom centre, amber `beacon_l` / `beacon_r` on the
    cab roof (emissive 'Beacon'), CITY WASTE lettering and trash-can badges.  The top is flat at
    exactly GB_TOP from the windscreen to the tailgate's slope."""
    root = C.empty('car_root')
    P = C.mat('Paint', '#3fae5a', rough=0.4)
    a = A()
    R, TW, WX, WY, TOP = GB_R, GB_TW, GB_WX, GB_WY, GB_TOP
    arches = [(sx * WX, sy * WY, R) for sx in (1, -1) for sy in (1, -1)]
    YF = -3.2                                   # cab front face (the bumper reaches -3.3)
    YC = -1.62                                  # cab back
    YB0, YB1 = -1.5, 2.22                       # compactor body

    def shell(mb):
        # cab: white, roof exactly TOP; a Paint stripe wrapped round it under the windscreen
        mb.box((2.44, YC - YF, TOP - 0.62), (0, (YF + YC) / 2, (0.62 + TOP) / 2), a, r=0.16, seg=2,
               uv=SW('white'))
        mb.box((2.46, YC - YF + 0.02, 0.13), (0, (YF + YC) / 2, 1.44), P, r=0.17, seg=2, edges='vert')
        # compactor body
        mb.box((2.40, YB1 - YB0, TOP - 0.82), (0, (YB0 + YB1) / 2, (0.82 + TOP) / 2), P, r=0.14, seg=2)
    cab = [((2.04, 1.20, 1.43), (0, -2.45, 1.25 + 0.715), None)]   # x +-1.02, y -3.05..-1.85, z 1.25..2.68
    wins = [((2.0, 0.4, 0.92), (0, YF, 2.08), None)]               # windscreen z 1.62..2.54
    wins += [((0.5, 0.86, 0.8), (sx * 1.22, -2.5, 2.1), None) for sx in (1, -1)]   # door windows
    wins.append(((1.4, 0.92, 0.4), (0, -2.5, TOP), None))         # sunroof over both seats
    body = C.MeshBuilder()
    merge_and_delete(body, carve(shell, arches, R + 0.1, 0.62, cab, wins, inside='slate', reveal='white'),
                     keep_uv=True)
    G = M_glass()
    body.quad((0, YF + 0.012, 2.08), (1, 0, 0), (0, 0, 1), 2.0, 0.92, G, uv=('const', 0, 0))
    for sx in (1, -1):
        body.quad((sx * 1.208, -2.5, 2.1), (0, sx, 0), (0, 0, 1), 0.86, 0.8, G, uv=('const', 0, 0))
    body.quad((0, -2.5, TOP - 0.003), (1, 0, 0), (0, 1, 0), 1.41, 0.93, G, uv=('const', 0, 0))
    seat, wheel = (0.5, -2.45, 1.62), (0.5, -2.8, 1.92)
    car_interior(body, seat, 1.25, (1.0, -3.05, -2.86, 1.25, 1.8), bench=None, seat_sw='orange',
                 dash_sw='charcoal')
    # ---- cab front: grille, lights, visor, bumper, mirrors, steps ----
    body.box((1.34, 0.06, 0.5), (0, YF - 0.015, 1.03), a, r=0.04, seg=1, uv=SW('charcoal'))
    for k in range(4):
        body.box((1.24, 0.04, 0.045), (0, YF - 0.04, 0.85 + k * 0.12), a, r=0.015, seg=1, uv=SW('chrome'))
    headlights(body, (0.86, -0.86), YF + 0.04, 1.0, r=0.15)
    for sx in (1, -1):
        body.box((0.24, 0.05, 0.08), (sx * 0.86, YF - 0.01, 1.25), a, r=0.025, seg=1, uv=SW('orange'))
    body.box((2.2, 0.1, 0.07), (0, YF - 0.04, 2.6), P, r=0.03, seg=1)                     # sun visor
    body.box((2.5, 0.3, 0.38), (0, -3.15, 0.5), a, r=0.1, seg=2, uv=SW('charcoal'))        # front bumper
    body.box((1.44, 0.24, 0.3), (0, 3.18, 0.5), a, r=0.08, seg=2, uv=SW('charcoal'))       # rear bumper
    plates(body, 3.3, 0.5, 'car_plate_b')
    for sx in (1, -1):
        # mirrors on arms at the windscreen corners
        body.beam((sx * 1.16, -3.06, 2.05), (sx * 1.33, -3.13, 2.1), 0.05, 0.05, a, uv=SW('charcoal'))
        body.box((0.07, 0.16, 0.42), (sx * 1.36, -3.13, 1.9), a, r=0.03, seg=1, uv=SW('charcoal'))
        # steps under the door, a grab bar, the door seam + handle
        body.box((0.2, 0.4, 0.05), (sx * 1.13, -2.82, 0.42), a, r=0.015, seg=1, uv=SW('steel'))
        for dy in (-0.17, 0.17):
            body.box((0.03, 0.03, 0.22), (sx * 1.2, -2.82 + dy, 0.53), a, uv=SW('charcoal'))
        body.box((0.06, 0.4, 0.05), (sx * 1.235, -2.82, 0.95), a, r=0.015, seg=1, uv=SW('steel'))
        body.box((0.04, 0.04, 0.9), (sx * 1.24, -1.95, 1.55), a, r=0.015, seg=1, uv=SW('chrome'))
        body.box((0.03, 0.025, 1.7), (sx * 1.224, -2.02, 1.66), a, uv=SW('charcoal'))
        body.box((0.04, 0.15, 0.035), (sx * 1.235, -2.17, 1.56), a, r=0.01, seg=1, uv=SW('charcoal'))
        # beacon bases on the roof's front corners
        body.cyl(0.12, 0.05, (sx * 0.9, -2.9, TOP + 0.02), a, seg=12, uv=SW('charcoal'))
    # ---- chassis, tank, toolbox, mudflaps, tail lights ----
    body.box((1.1, 6.1, 0.3), (0, 0.05, 0.62), a, uv=SW('charcoal'))
    body.cyl(0.22, 1.0, (0.98, -0.6, 0.58), a, axis='Y', seg=14, bevel=0.04, uv=SW('chrome'))   # fuel tank
    for y in (-0.92, -0.28):
        body.cyl(0.225, 0.05, (0.98, y, 0.58), a, axis='Y', seg=14, caps=False, uv=SW('charcoal'))
    body.box((0.44, 0.7, 0.4), (-0.98, -0.95, 0.6), a, r=0.04, seg=1, uv=SW('steel'))          # toolbox
    body.box((0.46, 0.03, 0.06), (-0.98, -1.29, 0.72), a, uv=SW('charcoal'))
    body.box((0.62, 1.0, 0.18), (-0.62, 0.8, 0.5), a, r=0.03, seg=1, uv=SW('charcoal'))         # lift mount
    for sx in (1, -1):
        body.box((0.42, 0.03, 0.4), (sx * WX, 2.6, 0.37), a, r=0.01, seg=1, uv=SW('rubber'))  # mudflaps
        body.box((0.34, 0.14, 0.28), (sx * 0.98, 3.17, 0.5), a, r=0.03, seg=1, uv=SW('charcoal'))
        body.box((0.26, 0.06, 0.2), (sx * 0.98, 3.27, 0.5), a, r=0.03, seg=1, uv=SW('red'))   # tail light
    # ---- compactor body: ribs, the dark packer opening behind the tailgate, lettering, badges ----
    for sx in (1, -1):
        for y in (-1.15, -0.35, 0.45, 1.25):
            body.box((0.06, 0.1, 1.3), (sx * 1.2, y, 1.5), P, r=0.02, seg=1)
        body.box((0.04, 0.06, 0.3), (sx * 1.2, YB1 - 0.04, 2.45), a, r=0.01, seg=1, uv=SW('charcoal'))  # hinge blocks
        trash_logo(body, sx, -0.75, 1.5)
        # CITY WASTE along the top of each flank, reading front to back on the left (+X), back
        # to front on the right
        text_decal(body, 'CITY WASTE', (sx * 1.212, 0.35, 2.47), (0, sx, 0), (0, 0, 1), 0.27, 'white')
    body.quad((0, YB1 + 0.004, 1.8), (-1, 0, 0), (0, 0, 1), 2.0, 1.6, a, uv=SW('ink'))
    roof_logo(body, 0.35, TOP)
    steering(root, body, wheel)
    body.build('body', parent=root)

    # ---- tailgate: the rear hopper, its top front edge hinged on the body ----
    hy, hz = GB_TAILGATE_HINGE.y, GB_TAILGATE_HINGE.z
    tg = C.MeshBuilder()
    prof = [(hy, TOP), (2.98, TOP), (3.27, 1.42), (3.3, 0.66), (2.64, 0.66), (2.64, 1.14), (hy, 1.14)]
    tg.poly_prism(prof, -1.2, 1.2, P, r=0.06, seg=2, axis='X')
    tg.quad((0, hy - 0.006, 1.97), (1, 0, 0), (0, 0, 1), 2.2, 1.5, a, uv=SW('ink'))  # inside face (seen open)
    # the loading mouth: a dark recess on the lower back, a steel lip under it, the packer blade
    sl = Vector((0, 3.27 - 2.98, 1.42 - TOP)).normalized()        # down the slope
    n_sl = Vector((0, -sl.z, sl.y))                               # its outward normal (back, up)
    tg.quad((0, 3.3 + 0.012, 1.02), (-1, 0, 0), (0, 0, 1), 1.9, 0.62, a, uv=SW('ink'))
    p = Vector((0, 3.27, 1.42)) - sl * 0.32 + n_sl * 0.012
    tg.quad(tuple(p), (-1, 0, 0), tuple(-sl), 1.9, 0.6, a, uv=SW('ink'))
    tg.box((2.0, 0.08, 0.07), (0, 3.31, 0.7), a, r=0.025, seg=1, uv=SW('steel'))
    tg.box((1.9, 0.06, 0.06), (0, 3.288, 1.36), a, r=0.02, seg=1, uv=SW('steel'))
    for sx in (1, -1):    # chevrons beside the mouth
        for k in range(3):
            z0 = 0.74 + k * 0.2
            pts = [(sx * 0.98, z0), (sx * 1.14, z0 + 0.1), (sx * 1.14, z0 + 0.17), (sx * 0.98, z0 + 0.07)]
            tg.poly_prism(pts, 3.296, 3.318, a, axis='Y', uv=SW('yellow'))
    # NO RACCOONS! on the slope (the camera behind the truck sees it)
    p = Vector((0, 2.98, TOP)) + sl * 0.58 + n_sl * 0.012
    tg.quad(tuple(p), (-1, 0, 0), tuple(-sl), 0.86, 0.43, a, cell='sign_no_raccoons')
    tg.build('tailgate', location=tuple(GB_TAILGATE_HINGE), parent=root)

    # ---- side-loader lift on the right flank ----
    H, S = GB_LIFT_HINGE, GB_BIN_SOCKET
    lf = C.MeshBuilder()
    lf.cyl(0.075, 1.0, tuple(H), a, axis='Y', seg=12, uv=SW('steel'))
    for dy in (-0.4, 0.4):
        lf.beam((H.x + 0.04, H.y + dy, H.z), (-1.25, H.y + dy, 0.77), 0.12, 0.14, a, r=0.03, uv=SW('yellow'))
    lf.box((0.045, 1.5, 0.95), (-1.2625, H.y, 1.22), a, r=0.015, seg=1, uv=SW('yellow'))     # back plate
    lf.box((0.05, 1.5, 0.08), (-1.27, H.y, 1.66), a, r=0.02, seg=1, uv=SW('charcoal'))
    for dy in (-0.55, 0.55):                                                                 # fork tines
        lf.box((1.15, 0.13, 0.09), (-1.86, H.y + dy, S.z - 0.045), a, r=0.025, seg=1, uv=SW('charcoal'))
    lift = lf.build('lift', location=tuple(H), parent=root)
    C.empty('bin_socket', tuple(S - H), parent=lift, size=0.2)

    # ---- amber rotating beacons (their node at the lens centre) ----
    bc = C.mat('Beacon', '#ffb020', rough=0.35, emit='#ff9a1a', strength=3.0)
    for name, sx in (('beacon_l', 1), ('beacon_r', -1)):
        c = Vector((sx * 0.9, -2.9, TOP + 0.11))
        mb = C.MeshBuilder()
        mb.cyl(0.095, 0.14, tuple(c), bc, seg=12)
        mb.sphere(0.095, tuple(c + Vector((0, 0, 0.07))), bc, seg=12, rings=6, cut_below=0.0)
        mb.build(name, location=tuple(c), parent=root)
    add_wheels(root, R, TW, WX, -WY, WY)
    car_nodes(root, seat)
    return root


# ===========================================================================
# trains  (front -Y, rails at x = +-0.75, body ~0.35 m above ground)
# ===========================================================================
# Materials: 'Paint' (the game recolours it per car; white-ish x metal panels on the loco,
# x wooden planks on the wagons), 'Roof' (tar paper, walkable top at exactly TRAIN_ROOF
# = 3.0), 'TrainNavy' (metal running gear) and 'AtlasTown' (livery stripes, brass, lamps,
# windows, raccoon graffiti).

def M_navy():
    return C.tmat('TrainNavy', '#3d405b', 'metal', rough=0.55)


def M_tar():
    return C.tmat('Roof', '#d6cfc0', 'roof_tar', rough=0.7)   # light: grey raccoons read well on it


def train_wheel(mb, x, y, R, w, m_wheel, m_hub, seg=16, hub=True, uv_wheel=None, uv_hub=None):
    mb.cyl(R, w, (x, y, R), m_wheel, axis='X', seg=seg, bevel=0.03, bseg=1, uv=uv_wheel)
    if hub:
        s = 1 if x > 0 else -1
        mb.cyl(R * 0.36, 0.05, (x + s * (w / 2 + 0.015), y, R), m_hub, axis='X', seg=10, uv=uv_hub)


def build_train_loco():
    """Tank engine.  The sim treats the loco top as a floor at TRAIN_ROOF (3.0) over its whole
    footprint (+-1.3 x 7.5 m), so one tar-paper deck slab covers it from the nose to the rear
    coupling at exactly 3.0; side tanks hide the boiler; the chimney and the steam dome are the
    only things above the deck, each a clean concentric round column (rider obstacles):
      chimney  centre (0, -2.6) Blender = glTF (x 0, z 2.6), radius 0.41, top 3.625
      dome     centre (0, -1.0) Blender = glTF (x 0, z 1.0), radius 0.32, top 3.194"""
    root = C.empty('train_root')
    P = C.tmat('Paint', '#ff5a5f', 'metal', rough=0.4)
    N, a, Rf = M_navy(), A(), M_tar()
    G, CH = SW('gold'), SW('chrome')
    b = C.MeshBuilder()
    # ---- running gear -------------------------------------------------
    b.box((1.2, 6.9, 0.62), (0, 0.05, 0.35 + 0.31), N, r=0.05)           # frame
    for y in (-1.85, -0.7, 0.45):                                        # big drivers
        for x in (0.75, -0.75):
            train_wheel(b, x, y, 0.5, 0.16, a, N, seg=20, uv_wheel=G)
    for y in (-3.1, 2.85):                                               # pony wheels
        for x in (0.75, -0.75):
            train_wheel(b, x, y, 0.28, 0.14, a, N, seg=12, uv_wheel=G)
    for x in (0.9, -0.9):
        b.beam((x, -1.85, 0.3), (x, 0.45, 0.3), 0.05, 0.09, a, uv=CH)     # side rods
        b.cyl(0.21, 0.62, (x * 1.13, -2.45, 0.66), N, axis='Y', seg=12, bevel=0.04)  # cylinders
        b.cyl(0.12, 0.3, (x * 1.13, -2.0, 0.66), a, axis='Y', seg=8, uv=CH)
    # deck / running boards (full 2.6 width)
    b.box((2.1, 4.5, 0.16), (0, -1.2, 1.05), P, r=0.05, seg=1)
    b.box((2.6, 2.75, 0.16), (0, 2.27, 1.05), P, r=0.05, seg=1)
    # buffer beam, cow-catcher, buffers
    b.box((2.5, 0.24, 0.52), (0, -3.5, 0.86), P, r=0.06, seg=1)
    b.box((2.52, 0.03, 0.1), (0, -3.62, 0.98), a, uv=SW('yellow'))          # livery stripe
    b.poly_prism([(-3.38, 0.62), (-3.38, 0.1), (-3.74, 0.1), (-3.62, 0.62)], -0.95, 0.95, a,
                 r=0.03, seg=1, axis='X', uv=G)
    for x in (0.85, -0.85):
        b.cyl(0.09, 0.12, (x, -3.67, 0.86), a, axis='Y', seg=10, uv=CH)
        b.cyl(0.16, 0.05, (x, -3.725, 0.86), a, axis='Y', seg=12, bevel=0.015, uv=CH)
    # ---- tank body (hides the boiler), from behind the buffer beam into the cab ----------
    YF = -3.60
    b.box((2.54, 1.0 - YF, 2.82 - 1.10), (0, (YF + 1.0) / 2, (1.10 + 2.82) / 2), P, r=0.08, seg=2, edges='vert')
    for y in (-2.05, -0.35):                                                       # brass straps
        b.box((2.58, 0.09, 1.66), (0, y, 1.12 + 0.83), a, r=0.02, seg=1, uv=G)
    for x in (1.30, -1.30):                                                        # handrails
        b.beam((x, -3.3, 2.5), (x, 0.8, 2.5), 0.04, 0.04, a, uv=CH)
    # smokebox face on the front: navy disc, brass ring, door + knob; two headlamps (eyes)
    b.cyl(0.82, 0.06, (0, YF - 0.01, 1.96), N, axis='Y', seg=24)
    b.cyl(0.76, 0.03, (0, YF - 0.05, 1.96), a, axis='Y', seg=24, uv=G)
    b.cyl(0.66, 0.03, (0, YF - 0.07, 1.96), N, axis='Y', seg=24, bevel=0.01)
    b.sphere(0.07, (0, YF - 0.09, 1.96), a, seg=8, rings=6, scale=(1, 0.6, 1), uv=G)
    for x in (1.02, -1.02):
        b.cyl(0.15, 0.08, (x, YF - 0.02, 2.45), a, axis='Y', seg=12, uv=CH)
        b.cyl(0.11, 0.06, (x, YF - 0.05, 2.45), a, axis='Y', seg=12, uv=SW('butter'))
    # ---- the deck: ONE tar-paper slab, flat top exactly 3.0 from the nose (-3.70) to the
    # rear coupling end (+3.75 = LOCO_LENGTH / 2) ----------------------------------------------
    b.box((2.6, 3.75 + 3.70, 0.2), (0, (3.75 - 3.70) / 2, 2.9), Rf, r=0.03, seg=2)
    # chimney (smoke socket on top): concentric round column, radius 0.41
    CY = -2.6
    b.cyl(0.32, 0.09, (0, CY, 2.99 + 0.045), a, seg=16, uv=G)                       # collar
    b.cyl(0.26, 0.44, (0, CY, 2.99 + 0.22), N, seg=16)                              # shaft 2.99..3.43
    b.cyl(0.26, 0.18, (0, CY, 3.42 + 0.09), N, r2=0.40, seg=16)                     # flare 3.42..3.60
    b.cyl(0.41, 0.05, (0, CY, 3.6), a, seg=16, bevel=0.015, uv=G)                   # rim, top 3.625
    # low steam dome: round column, radius 0.32, top 3.194 (n-gon caps are ear-clipped)
    b.cyl(0.32, 0.065, (0, -1.0, 2.99 + 0.0325), a, seg=16, uv=G)
    b.sphere(0.32, (0, -1.0, 3.05), a, seg=16, rings=8, scale=(1, 1, 0.45), cut_below=0.0, uv=G)
    # ---- cab --------------------------------------------------------------
    b.box((2.56, 2.72, 1.72), (0, 2.3, 1.98), P, r=0.08, seg=2, edges='vert')
    # livery the whole length: brass line + cream pinstripe
    b.box((2.6, 7.28, 0.09), (0, (YF - 0.01 + 3.67) / 2, 1.86), a, r=0.08, seg=2, edges='vert', uv=SW('gold'))
    b.box((2.61, 7.29, 0.035), (0, (YF - 0.015 + 3.675) / 2, 1.78), a, r=0.08, seg=2, edges='vert', uv=SW('cream'))
    for sx in (1, -1):
        face = '+X' if sx > 0 else '-X'
        Mw = C.wall_matrix(face)
        # TRSH 01 number plate on each tank side
        b.decal(face, 1.27, 1.2 * sx, 2.25, 0.62, 0.266, 'car_plate_a', m=a)
        # side window: a raccoon engineer peeking out (u along the wall: +X wall local X = world -Y)
        u = -2.3 * sx
        for s in (-1, 1):
            b.box((0.9, 0.08, 0.08), (u, 1.28, 2.36 + s * 0.39), a, matrix=Mw, cull=('-Y',), uv=SW('cream'))
            b.box((0.08, 0.08, 0.7), (u + s * 0.41, 1.28, 2.36), a, matrix=Mw, cull=('-Y',), uv=SW('cream'))
        b.decal(face, 1.28, u, 2.36, 0.75, 0.7, 'window_raccoon', m=a)
        # raccoon paw-print tag on the lower cab side
        b.decal(face, 1.28, -2.95 * sx, 1.45, 0.52, 0.52, 'graffiti_paws', m=a)
        # rear windows + lamps
        b.box((0.62, 0.06, 0.5), (sx * 0.62, 3.66, 2.4), a, uv=SW('cream'))
        b.box((0.5, 0.06, 0.4), (sx * 0.62, 3.675, 2.4), a, uv=SW('glass'))
        b.box((0.16, 0.06, 0.16), (sx * 0.95, 3.66, 1.45), a, r=0.03, uv=SW('red'))
    # rear beam + coupler
    b.box((2.4, 0.2, 0.45), (0, 3.6, 0.85), P, r=0.05, seg=1)
    b.box((0.32, 0.2, 0.22), (0, 3.66, 0.8), N, r=0.03)
    b.build('body', parent=root)
    C.empty('smoke_socket', (0, CY, 3.63), parent=root, size=0.3)
    return root


def build_train_wagon():
    root = C.empty('train_root')
    P = C.tmat('Paint', '#2ec4b6', 'wood', rough=0.5)
    N, a, Rf = M_navy(), A(), M_tar()
    K = SW('cream')
    plank = ('box', 2.0)   # 25 cm planks
    b = C.MeshBuilder()
    # underframe, tank, bogies
    b.box((2.1, 7.4, 0.25), (0, 0, 0.6), N, r=0.04)
    b.box((1.3, 2.2, 0.32), (0, 0, 0.36), N, r=0.06)
    for by in (-2.75, 2.75):
        b.box((1.5, 0.9, 0.16), (0, by, 0.42), N)
        for x in (0.89, -0.89):
            b.box((0.1, 2.0, 0.24), (x, by, 0.32), N, r=0.04)
            for dy in (-0.62, 0.62):
                b.cyl(0.09, 0.08, (x + (0.07 if x > 0 else -0.07), by + dy, 0.3), a, axis='X', seg=8, uv=SW('chrome'))
        for dy in (-0.62, 0.62):
            for x in (0.75, -0.75):
                train_wheel(b, x, by + dy, 0.3, 0.12, N, N, seg=16, hub=False)
    # wooden body shell + tar-paper roof (flat walkable top exactly at 3.0)
    b.box((2.56, 7.6, 2.12), (0, 0, 0.66 + 1.06), P, r=0.3, seg=2, edges='botvert', uv=plank)
    b.box((2.6, 8.0, 0.24), (0, 0, 2.88), Rf, r=0.03, seg=2, edges='topvert')   # to the car ends (+-4.0)
    # livery: cream belt + top line, pink and yellow pinstripes
    b.box((2.58, 7.62, 0.1), (0, 0, 1.42), a, r=0.31, seg=2, edges='vert', uv=K)
    b.box((2.575, 7.615, 0.05), (0, 0, 1.31), a, r=0.31, seg=2, edges='vert', uv=SW('hotpink'))
    b.box((2.58, 7.62, 0.07), (0, 0, 2.62), a, r=0.31, seg=2, edges='vert', uv=K)
    b.box((2.575, 7.615, 0.035), (0, 0, 2.535), a, r=0.31, seg=2, edges='vert', uv=SW('yellow'))
    pas = Picker(606)
    pas.cells, pas.weights = ['window_curtains', 'window_raccoon', 'window_cat', 'window_plant'], [6, 2, 1, 1]
    for sx in (1, -1):
        face = '+X' if sx > 0 else '-X'
        Mw = C.wall_matrix(face)
        # two passenger windows + a big sprayed RACCOONS RULE tag where the other two were
        for y in (-1.65, -0.55):
            u = -y * sx
            for s in (-1, 1):
                b.box((0.98, 0.08, 0.08), (u, 1.30, 2.02 + s * 0.4), a, matrix=Mw, cull=('-Y',), uv=K)
                b.box((0.08, 0.08, 0.72), (u + s * 0.45, 1.30, 2.02), a, matrix=Mw, cull=('-Y',), uv=K)
            b.decal(face, 1.28, u, 2.02, 0.84, 0.74, pas(), m=a)
        b.decal(face, 1.28, -1.1 * sx, 2.0, 2.08, 0.97, 'graffiti_raccoons_rule', m=a)
        for y in (-2.85, 2.85):  # doors
            u = -y * sx
            b.box((0.84, 0.06, 1.96), (u, 1.28, 0.7 + 0.98), a, r=0.05, seg=1, matrix=Mw, uv=K)
            b.box((0.46, 0.04, 0.56), (u, 1.30, 2.12), a, r=0.05, seg=1, matrix=Mw, uv=SW('glass'))
            b.box((0.05, 0.05, 0.22), (u + 0.28, 1.33, 1.5), a, matrix=Mw, uv=SW('chrome'))
            b.box((0.9, 0.3, 0.1), (u, 1.2, 0.5), N, matrix=Mw)  # step
        # ladder near the +Y end
        lx = sx * 1.335
        for y in (3.4, 3.68):   # rails stop under the roof top (no hoops above the walkable roof)
            b.beam((lx, y, 0.62), (lx, y, 2.95), 0.05, 0.05, a, uv=SW('chrome'))
            for z in (0.9, 2.5):
                b.beam((sx * 1.27, y, z), (lx, y, z), 0.04, 0.04, a, uv=SW('chrome'))
            b.beam((sx * 1.28, y, 2.86), (lx, y, 2.86), 0.04, 0.04, a, uv=SW('chrome'))   # into the roof edge
        for i in range(7):
            z = 0.95 + i * 0.3
            b.beam((lx, 3.4, z), (lx, 3.68, z), 0.045, 0.045, a, uv=SW('chrome'))
    # ends: gangway bellows, couplers, end windows, tail lamps
    for s in (-1, 1):
        b.box((1.12, 0.22, 1.92), (0, s * 3.89, 1.72), a, r=0.07, seg=1, uv=SW('slate'))
        b.box((0.3, 0.24, 0.22), (0, s * 3.85, 0.55), N, r=0.03)
        for x in (0.85, -0.85):
            b.box((0.5, 0.06, 0.6), (x, s * 3.8, 2.05), a, r=0.05, uv=K)
            b.box((0.4, 0.06, 0.5), (x, s * 3.815, 2.05), a, r=0.04, uv=SW('glass'))
    for x in (0.95, -0.95):
        b.box((0.14, 0.06, 0.14), (x, 3.81, 1.05), a, r=0.03, uv=SW('red'))
        b.box((0.14, 0.06, 0.14), (x, -3.81, 1.05), a, r=0.03, uv=SW('butter'))
    b.build('body', parent=root)
    return root


# ===========================================================================
# buildings  (front door -Y, origin ground centre)
# ===========================================================================
# Materials per building: 'Wall' (white-ish x brick / siding / stucco; the game replaces its
# colour with a pastel tint), 'Roof' (shingle with downhill 'slope' UVs, or roof_tar on flat
# roofs) and 'AtlasTown' (windows, doors, signs, trims, plants... all one draw).
# Windows / doors are atlas pictures 2 cm in front of the wall, inside a frame ring that
# stands 6 cm proud.  `decal_slot_*` empties mark free wall areas for the game's posters:
# local glTF +Z = out of the wall, +Y = up, scale = (free width, free height, 1).

WINDOW_CELLS = ('window_curtains', 'window_blinds', 'window_plant', 'window_lamp', 'window_cat',
                'window_fishbowl', 'window_raccoon')
WINDOW_WEIGHTS = (6, 6, 5, 4, 2, 2, 1)
SLOT_ROT = {'-Y': 0.0, '+Y': 180.0, '+X': 90.0, '-X': -90.0}   # empty's local -Y -> wall normal


def _sw_rect(name, half=0.004):
    """A tiny Blender-UV rect inside a palette swatch (flat colour for a planar-mapped quad)."""
    u, v = T.swatch_uv(name)
    return (u - half, v - half, u + half, v + half)


class Picker:
    """Deterministic per-building window pictures (no two neighbours alike)."""

    def __init__(self, seed, extra=(), no_repeat=True):
        self.rng = C.seeded(seed)
        self.cells = list(WINDOW_CELLS) + [c for c, _ in extra]
        self.weights = list(WINDOW_WEIGHTS) + [w for _, w in extra]
        self.no_repeat = no_repeat
        self.last = None

    def __call__(self):
        for _ in range(8):
            c = self.rng.choices(self.cells, self.weights)[0]
            if not self.no_repeat or c != self.last:
                break
        self.last = c
        return c


def M_wall(color, tex):
    """'Wall' (recoloured per building at runtime): white-ish x a tiling texture."""
    return C.tmat('Wall', color, tex, rough=0.65)


def M_roof(color, tex):
    return C.tmat('Roof', color, tex, rough=0.55)


def win(b, face, d, u, v, w, h, cell, border=0.09, sill=True, shutters=None, frame='white',
        proud=0.06, mullion=False):
    """Atlas window: picture `cell` 2 cm off the wall plane (|.| = d), framed by a ring of four
    bars standing `proud` m out (so the picture reads as recessed glass)."""
    a = A()
    Mw = C.wall_matrix(face)
    y0, y1 = d - 0.04, d + proud
    yc, t = (y0 + y1) / 2, y1 - y0
    fw = w + 2 * border
    for s in (-1, 1):
        b.box((fw, t, border), (u, yc, v + s * (h / 2 + border / 2)), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
        b.box((border, t, h), (u + s * (w / 2 + border / 2), yc, v), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
    if mullion:
        b.box((0.07, t - 0.02, h), (u, yc - 0.01, v), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
        for s in (-1, 1):
            b.decal(face, d, u + s * (w / 4), v, w / 2 + 0.01, h + 0.01, cell[s > 0] if isinstance(cell, tuple) else cell, m=a)
    else:
        b.decal(face, d, u, v, w + 0.01, h + 0.01, cell, m=a)
    if sill:
        b.box((fw + 0.14, 0.2, 0.08), (u, d + 0.06, v - h / 2 - border - 0.03), a, matrix=Mw,
              cull=('-Y',), uv=SW(frame))
    if shutters is not None:
        sw = w * 0.42
        for s in (-1, 1):
            b.box((sw, 0.06, h + 2 * border), (u + s * (w / 2 + border + sw / 2 + 0.03), d + 0.03, v),
                  a, matrix=Mw, cull=('-Y',), uv=SW(shutters))


def round_win(b, face, d, u, v, r, cell, frame='white'):
    """Porthole: a frame disc + a picture disc (the cell's inscribed circle) 2 cm proud."""
    a = A()
    Mw = C.wall_matrix(face)
    b.cyl(r + 0.12, 0.1, (u, d + 0.01, v), a, axis='Y', seg=18, matrix=Mw, uv=SW(frame))
    R3 = Mw.to_3x3()
    o = Mw @ Vector((u + r, d + 0.07, v - r))
    rect = T.atlas_rect(cell)
    b.cyl(r, 0.04, (u, d + 0.05, v), a, axis='Y', seg=18, matrix=Mw,
          uv=('planar', o, R3 @ Vector((-1, 0, 0)), R3 @ Vector((0, 0, 1)), 2 * r, 2 * r, {'rect': rect}))


def door(b, face, d, u, w, h, cell, z0=0.0, step=0.0, canopy=0.0, canopy_m=None, canopy_uv=None,
         frame='white'):
    """Atlas door picture (door_* cells are drawn for 1:2 quads) in a 3-sided frame."""
    a = A()
    Mw = C.wall_matrix(face)
    y0, y1 = d - 0.04, d + 0.07
    yc, t = (y0 + y1) / 2, y1 - y0
    bw = 0.12
    b.box((w + 2 * bw, t, bw), (u, yc, z0 + h + bw / 2), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
    for s in (-1, 1):
        b.box((bw, t, h), (u + s * (w / 2 + bw / 2), yc, z0 + h / 2), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
    b.decal(face, d, u, z0 + h / 2, w + 0.01, h, cell, m=a)
    if step > 0:
        b.box((w + 0.7, step, 0.16), (u, d + step / 2, max(0.08, z0 - 0.08)), a, matrix=Mw,
              cull=('-Y', '-Z'), uv=SW('silver'))
    if canopy > 0:
        b.box((w + 0.9, canopy, 0.14), (u, d + canopy / 2, z0 + h + 0.32), canopy_m or a, r=0.05, seg=1,
              matrix=Mw, uv=canopy_uv if canopy_m is not None else SW('white'))


def sign(b, face, d, u, v, w, cell, frame='charcoal', proud=0.08):
    """A wall sign: a dark backing board standing `proud` out, the atlas sign 2 cm in front."""
    a = A()
    Mw = C.wall_matrix(face)
    c = T.atlas_town().cells[cell]
    h = w / c['aspect']
    b.box((w + 0.10, proud + 0.04, h + 0.10), (u, d + proud / 2 - 0.02, v), a, r=0.03, seg=1, matrix=Mw,
          cull=('-Y',), uv=SW(frame))
    b.decal(face, d + proud, u, v, w, h, cell, m=a)


def flower_box(b, face, d, u, v, w):
    a = A()
    Mw = C.wall_matrix(face)
    b.box((w, 0.3, 0.26), (u, d + 0.15, v), a, matrix=Mw, cull=('-Y',), uv=SW('terracotta'))
    n = max(2, int(w / 0.35))
    for i in range(n):
        x = u - w / 2 + (i + 0.5) * w / n
        col = ('hotpink', 'yellow')[(i // 2) % 2] if i % 2 else 'leaf'
        b.sphere(0.15, (x, d + 0.17, v + 0.2), a, seg=6, rings=4, matrix=Mw, uv=SW(col))


def slot(root, i, face, d, u, v, w, h):
    """decal_slot_<i>: free wall area w x h centred (u, v) on `face`, 2 cm in front of it."""
    Mw = C.wall_matrix(face)
    p = Mw @ Vector((u, d + 0.02, v))
    return C.empty('decal_slot_%d' % i, tuple(p), parent=root, size=0.3,
                   rot=(0, 0, SLOT_ROT[face]), scale=(w, 1.0, h))


def build_bld_house():
    W, R = M_wall('#fffaf2', 'siding'), M_roof('#f2706b', 'shingle')
    a = A()
    pick = Picker(101)
    b = C.MeshBuilder()
    D, H = 4.3, 5.2
    b.box((2 * D, 2 * D, H), (0, 0, H / 2), W, r=0.15, seg=2, edges='vert')
    b.box((2 * D + 0.16, 2 * D + 0.16, 0.4), (0, 0, 0.2), a, r=0.15, seg=2, edges='vert', uv=SW('sand'))
    b.box((2 * D + 0.1, 2 * D + 0.1, 0.14), (0, 0, 2.66), a, r=0.15, seg=2, edges='vert', uv=SW('white'))
    # attic gables + pitched roof (ridge along X); shingle rows run downhill
    b.poly_prism([(-D, H), (D, H), (0, 7.74)], -D, D, W, axis='X')
    b.poly_prism([(-4.5, 4.93), (0, 7.75), (4.5, 4.93), (4.5, 5.2), (0, 8.02), (-4.5, 5.2)],
                 -4.5, 4.5, R, axis='X', uv=('slope', T.TEX['shingle'].tile_m))
    b.cyl(0.13, 9.06, (0, 0, 8.0), a, axis='X', seg=8, uv=SW('coral'))
    # chimney
    b.box((0.7, 0.7, 1.9), (2.6, 1.8, 7.35), a, r=0.04, uv=SW('terracotta'))
    b.box((0.86, 0.86, 0.14), (2.6, 1.8, 8.33), a, r=0.03, uv=SW('silver'))
    # front (-Y)
    door(b, '-Y', D, 0, 1.15, 2.2, 'door_blue', z0=0.16, step=0.3, canopy=0.6, canopy_m=R,
         canopy_uv=('box', T.TEX['shingle'].tile_m))
    for u in (-2.6, 2.6):
        win(b, '-Y', D, u, 1.55, 1.2, 1.2, pick(), sill=False, shutters='aqua')
        flower_box(b, '-Y', D, u, 0.72, 1.4)
    for u in (-2.6, 0, 2.6):
        win(b, '-Y', D, u, 4.0, 1.05, 1.1, pick(), shutters='aqua')
    # sides + back
    for face in ('+X', '-X'):
        for u in (-1.8, 1.8):
            win(b, face, D, u, 1.6, 1.1, 1.15, pick())
            win(b, face, D, u, 4.0, 1.05, 1.1, pick())
        round_win(b, face, D, 0, 6.2, 0.33, pick())
    for u in (-2.4, 2.4):
        win(b, '+Y', D, u, 1.6, 1.1, 1.15, pick())
        win(b, '+Y', D, u, 4.0, 1.05, 1.1, pick())
    root = b.build('bld_house')
    slot(root, 0, '+X', D, 0, 1.52, 1.9, 1.8)
    slot(root, 1, '-X', D, 0, 1.52, 1.9, 1.8)
    slot(root, 2, '+Y', D, 0, 1.52, 2.4, 1.8)
    return root


def awning(b, x0, x1, y_wall, y_out, z_top, z_low, n, ca, cb, scallop=True):
    """Striped sloped awning on the -Y side (alternating swatches)."""
    a = A()
    sw = (x1 - x0) / n
    for i in range(n):
        x = x0 + (i + 0.5) * sw
        uv = SW(ca if i % 2 == 0 else cb)
        b.beam((x, y_wall, z_top), (x, y_out, z_low), sw, 0.06, a, uv=uv)
        b.box((sw, 0.05, 0.26), (x, y_out - 0.01, z_low - 0.1), a, cull=('+Y',), uv=uv)
        if scallop:
            b.cyl(sw * 0.3, 0.05, (x, y_out - 0.01, z_low - 0.23), a, axis='Y', seg=8, uv=uv)
    for x in (x0, x1):
        b.poly_prism([(y_wall, z_top), (y_out, z_low - 0.23), (y_wall, z_low - 0.23)],
                     x - 0.03, x + 0.03, a, axis='X', uv=SW(ca))


SHOP_SIGNS = ('pizza', 'burger', 'laundromat', 'trash_treasures', 'snack_shack')


def build_bld_shop():
    W, R = M_wall('#fffaf2', 'brick'), M_roof('#8c9bb5', 'roof_tar')
    a = A()
    pick = Picker(202)
    b = C.MeshBuilder()
    DX, DY, H = 5.95, 4.4, 4.6
    b.box((2 * DX, 2 * DY, H), (0, 0, H / 2), W, r=0.15, seg=2, edges='vert')
    b.box((2 * DX + 0.1, 2 * DY + 0.1, 0.38), (0, 0, 0.19), a, r=0.15, seg=2, edges='vert', uv=SW('sand'))
    b.box((12.0, 9.0, 0.34), (0, 0, H + 0.17), a, r=0.08, seg=1, uv=SW('white'))
    b.box((11.5, 8.5, 0.06), (0, 0, H + 0.36), R)
    # storefront (-Y): two picture panes per window + a glass transom, pink frames
    for u, cells in ((-3.25, ('window_lamp', 'window_plant')), (3.25, ('window_fishbowl', 'window_cat'))):
        win(b, '-Y', DY, u, 1.45, 3.3, 1.7, cells, sill=False, frame='hotpink', border=0.12, mullion=True)
        b.decal('-Y', DY, u, 2.6, 3.3, 0.38, _sw_rect('glass'), m=a)   # transom glass
        b.box((3.54, 0.1, 0.1), (u, -DY - 0.01, 2.36), a, cull=('+Y',), uv=SW('hotpink'))
        b.box((3.54, 0.1, 0.1), (u, -DY - 0.01, 2.84), a, cull=('+Y',), uv=SW('hotpink'))
    door(b, '-Y', DY, 0, 1.35, 2.5, 'door_shop', z0=0.1, step=0.35, frame='hotpink')
    for u in (-4.0, -1.35, 1.35, 4.0):
        win(b, '-Y', DY, u, 3.98, 0.72, 0.72, pick(), sill=False, border=0.08)
    awning(b, -5.6, 5.6, -DY, -5.35, 3.4, 2.92, 10, 'hotpink', 'white')
    for u in (-1.45, 1.45):  # planters by the door
        b.box((0.55, 0.5, 0.5), (u, -4.68, 0.25), a, r=0.05, uv=SW('terracotta'))
        b.sphere(0.34, (u, -4.68, 0.72), a, seg=8, rings=6, uv=SW('leaf'))
    # sides + back
    for face in ('+X', '-X'):
        for u in (-1.9, 1.9):
            win(b, face, DX, u, 1.9, 1.4, 1.3, pick())
    door(b, '+Y', DY, 2.5, 1.1, 2.2, 'door_wood', z0=0.1)
    sign(b, '+Y', DY, 4.35, 1.75, 1.05, 'sign_no_raccoons')     # by the bins out back
    for u in (-3.6, -0.6):
        win(b, '+Y', DY, u, 2.0, 1.2, 1.1, pick())
    # rooftop sign board: one of the shopsign_* pictures is shown per shop (the game picks)
    top = H + 0.39
    sy, sh_, sw_ = -3.7, 1.46, 3.12
    for u in (-1.2, 1.2):
        b.box((0.24, 0.5, 0.08), (u, sy, top + 0.04), a, uv=SW('charcoal'))
    b.box((sw_, 0.22, sh_), (0, sy, H + 1.86 - sh_ / 2), a, r=0.04, seg=1, uv=SW('charcoal'))
    # roof clutter: AC + vent
    b.box((1.3, 0.9, 0.7), (3.4, 2.1, H + 0.75), a, r=0.06, uv=SW('silver'))
    b.cyl(0.32, 0.06, (3.4, 2.1, H + 1.12), a, seg=12, uv=SW('slate'))
    b.cyl(0.18, 0.8, (-3.8, 2.6, H + 0.75), a, seg=10, uv=SW('steel'))
    root = b.build('bld_shop')
    zc = H + 1.86 - sh_ / 2
    dw, dh = sw_ - 0.14, (sw_ - 0.14) / 2.1429
    for name in SHOP_SIGNS:
        s = C.MeshBuilder()
        s.decal('-Y', -sy + 0.11, 0, zc, dw, dh, 'sign_' + name, m=a)
        s.decal('+Y', sy + 0.11, 0, zc, dw, dh, 'sign_' + name, m=a)
        s.build('shopsign_' + name, location=(0, sy, zc), parent=root)
    slot(root, 0, '+X', DX, 0, 1.9, 1.9, 2.4)
    slot(root, 1, '-X', DX, 0, 1.9, 1.9, 2.4)
    slot(root, 2, '+X', DX, 3.55, 1.9, 1.3, 2.2)
    slot(root, 3, '-X', DX, -3.55, 1.9, 1.3, 2.2)
    slot(root, 4, '+Y', DY, 0.95, 1.7, 1.5, 2.0)
    return root


def build_bld_apartment():
    W, R = M_wall('#fffaf2', 'brick'), M_roof('#9aa6bd', 'roof_tar')
    a = A()
    pick = Picker(303, extra=(('window_for_rent', 2),))
    b = C.MeshBuilder()
    DX, DY, FH, NF = 5.75, 5.45, 3.3, 4
    H = FH * NF
    b.box((2 * DX, 2 * DY, H), (0, 0, H / 2), W, r=0.2, seg=2, edges='vert')
    b.box((2 * DX + 0.16, 2 * DY + 0.16, 0.5), (0, 0, 0.25), a, r=0.2, seg=2, edges='vert', uv=SW('sand'))
    for f in range(1, NF):
        b.box((2 * DX + 0.12, 2 * DY + 0.12, 0.16), (0, 0, f * FH), a, r=0.2, seg=2, edges='vert', uv=SW('white'))
    b.box((2 * DX + 0.3, 2 * DY + 0.3, 0.42), (0, 0, H + 0.21), a, r=0.06, seg=1, uv=SW('white'))
    b.box((2 * DX - 0.2, 2 * DY - 0.2, 0.06), (0, 0, H + 0.44), R)
    for s in (-1, 1):  # parapet
        b.box((2 * DX + 0.3, 0.24, 0.32), (0, s * (DY + 0.03), H + 0.58), a, uv=SW('white'))
        b.box((0.24, 2 * DY + 0.3, 0.32), (s * (DX + 0.03), 0, H + 0.58), a, uv=SW('white'))
    # front: door, NO RACCOONS sign beside it, ground windows
    door(b, '-Y', DY, 0, 1.2, 2.4, 'door_wood', z0=0.12, step=0.42, canopy=0.5, canopy_m=a,
         canopy_uv=SW('hotpink'))
    sign(b, '-Y', DY, 1.85, 1.75, 1.2, 'sign_no_raccoons')
    for u in (-3.6, 3.6):
        win(b, '-Y', DY, u, 1.75, 1.5, 1.3, pick())
    for f in range(1, NF):
        z = f * FH
        win(b, '-Y', DY, 0, z + 1.65, 1.3, 1.35, pick())
        for u in (-3.6, 3.6):
            win(b, '-Y', DY, u, z + 1.2, 1.25, 2.1, ('window_curtains', 'window_blinds')[(f + (u > 0)) % 2], sill=False)
            # balcony (front edge flush with the 12 m footprint)
            b.box((2.7, 0.56, 0.16), (u, -DY - 0.28, z + 0.08), a, r=0.04, uv=SW('silver'))
            b.box((2.7, 0.07, 0.85), (u, -6.0 + 0.035, z + 0.58), a, cull=('-Z',), uv=SW('white'))
            for s in (-1, 1):
                b.box((0.07, 0.5, 0.85), (u + s * 1.315, -DY - 0.28, z + 0.58), a, cull=('-Z', '+Y'), uv=SW('white'))
            b.box((1.2, 0.22, 0.2), (u + 0.5, -5.78, z + 1.12), a, uv=SW('terracotta'))
            b.sphere(0.2, (u + 0.3, -5.78, z + 1.3), a, seg=6, rings=4, uv=SW('leaf'))
            b.sphere(0.17, (u + 0.75, -5.78, z + 1.28), a, seg=6, rings=4, uv=SW('hotpink'))
    # back with AC units
    for f in range(NF):
        z = f * FH
        for u in (-3.6, 0, 3.6):
            win(b, '+Y', DY, u, z + 1.75, 1.3, 1.35, pick())
        if f in (1, 2):
            b.box((0.9, 0.48, 0.6), (-3.6 if f == 1 else 3.6, DY + 0.24, z + 0.55), a, r=0.04, uv=SW('silver'))
    # sides
    for face in ('+X', '-X'):
        for f in range(NF):
            z = f * FH
            for u in (-3.3, 0, 3.3):
                win(b, face, DX, u, z + 1.75, 1.2, 1.35, pick())
    # roof: water tank + stair hut
    tx, ty, tz = 2.7, 2.4, H + 0.47
    for sx in (-0.5, 0.5):
        for sy in (-0.5, 0.5):
            b.beam((tx + sx, ty + sy, tz), (tx + sx, ty + sy, tz + 0.7), 0.12, 0.12, a, uv=SW('charcoal'))
    b.cyl(0.95, 1.25, (tx, ty, tz + 0.7 + 0.625), a, seg=14, bevel=0.06, uv=SW('sky'))
    b.cyl(1.0, 0.5, (tx, ty, tz + 1.95 + 0.25), a, r2=0.1, seg=14, uv=SW('slate'))
    for zz in (tz + 1.0, tz + 1.6):
        b.cyl(0.97, 0.06, (tx, ty, zz), a, seg=14, caps=False, uv=SW('charcoal'))
    b.box((2.2, 2.0, 1.9), (-3.0, 2.6, tz + 0.95), W, r=0.08, seg=1)
    b.box((2.4, 2.2, 0.14), (-3.0, 2.6, tz + 1.95), a, r=0.04, uv=SW('white'))
    b.decal('-Y', -1.6, 3.0, tz + 0.75, 0.75, 1.5, 'door_red', m=a)
    root = b.build('bld_apartment')
    slot(root, 0, '+X', DX, -1.65, 1.85, 1.6, 2.3)
    slot(root, 1, '+X', DX, 1.65, 1.85, 1.6, 2.3)
    slot(root, 2, '-X', DX, -1.65, 1.85, 1.6, 2.3)
    slot(root, 3, '-X', DX, 1.65, 1.85, 1.6, 2.3)
    slot(root, 4, '-Y', DY, -1.82, 1.6, 1.6, 1.9)
    slot(root, 5, '+Y', DY, -1.8, 1.85, 1.7, 2.3)
    return root


def build_bld_tower():
    W, R = M_wall('#fffaf2', 'stucco'), M_roof('#7d8bb3', 'roof_tar')
    a = A()
    pick = Picker(404)
    b = C.MeshBuilder()
    # lobby: glass box, corner columns, mullions
    b.box((12.6, 12.6, 4.2), (0, 0, 2.1), a, r=0.5, seg=2, edges='vert', uv=SW('glass'))
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((1.3, 1.3, 3.92), (sx * 6.35, sy * 6.35, 1.96), W, r=0.35, seg=2, edges='vert')
    for u in (-3.6, -1.2, 1.2, 3.6):
        for s in (-1, 1):
            b.box((0.12, 0.1, 4.2), (u, s * 6.33, 2.1), a, uv=SW('white'))
    # solid stucco piers in the lobby glass (front / back bays beside the door, mid sides):
    # the posters go on these, not on the glass
    for face, us, wp in (('-Y', (-2.4, 2.4), 2.26), ('+Y', (-2.4, 2.4), 2.26), ('+X', (0.0,), 2.4), ('-X', (0.0,), 2.4)):
        Mw = C.wall_matrix(face)
        for u in us:
            b.box((wp, 0.1, 4.0), (u, 6.32, 2.0), W, matrix=Mw, cull=('-Y',))
    # revolving door + entrance canopy + planters
    b.cyl(0.95, 2.7, (0, -6.3, 1.35), a, seg=14, uv=SW('glass'))
    b.cyl(1.05, 0.2, (0, -6.3, 2.8), a, seg=14, uv=SW('white'))
    for k in range(4):   # revolving door wings
        ang = math.radians(45 + 90 * k)
        b.beam((0, -6.3, 0.05), (0.9 * math.cos(ang), -6.3 + 0.9 * math.sin(ang), 0.05), 0.05, 0.05, a, uv=SW('slate'))
    b.box((5.0, 1.2, 0.3), (0, -6.9, 3.55), a, r=0.12, seg=2, uv=SW('hotpink'))
    for u in (-3.6, 3.6):
        b.box((1.4, 0.6, 0.55), (u, -6.62, 0.28), a, r=0.05, uv=SW('terracotta'))
        b.sphere(0.45, (u, -6.62, 0.85), a, seg=8, rings=6, scale=(1.4, 0.6, 0.8), uv=SW('leaf'))
    # shaft: glass core, white bands every 3 m, mullions, office windows (atlas pictures)
    b.box((13.4, 13.4, 18.0), (0, 0, 4.2 + 9.0), a, r=0.6, seg=2, edges='vert', uv=SW('glass'))
    for k in range(7):
        b.box((14.0, 14.0, 0.55), (0, 0, 4.2 + 3 * k), W, r=0.8, seg=2, edges='vert')
    office = Picker(405, no_repeat=False)     # an office: mostly blinds, the odd plant / cat / raccoon
    office.cells = ['window_blinds', 'window_lamp', 'window_plant', 'window_curtains', 'window_cat',
                    'window_raccoon']
    office.weights = [16, 3, 3, 1, 1, 1]
    for face in ('+X', '-X', '+Y', '-Y'):
        Mw = C.wall_matrix(face)
        for u in (-5.0, -3.0, -1.0, 1.0, 3.0, 5.0):
            b.box((0.14, 0.12, 18.0), (u, 6.7, 13.2), a, matrix=Mw, cull=('-Y',), uv=SW('white'))
        for k in range(6):
            zc = 4.2 + 3 * k + 1.5
            for u in (-4.0, -2.0, 0.0, 2.0, 4.0):
                b.decal(face, 6.7, u, zc, 1.82, 2.3, office(), m=a)
    # stepped crown
    b.box((12.6, 12.6, 1.6), (0, 0, 22.2 + 0.8), W, r=0.6, seg=2, edges='vert')
    b.box((12.9, 12.9, 0.2), (0, 0, 23.8), a, r=0.6, seg=2, edges='vert', uv=SW('white'))
    b.box((9.6, 9.6, 1.4), (0, 0, 23.8 + 0.7), R, r=0.5, seg=2, edges='vert')
    b.box((6.4, 6.4, 1.0), (0, 0, 25.2 + 0.5), W, r=0.4, seg=2, edges='topvert')
    b.box((12.72, 12.72, 0.32), (0, 0, 23.0), a, r=0.62, seg=2, edges='vert', uv=SW('hotpink'))
    b.cyl(0.07, 1.4, (0, 0, 26.2 + 0.7), a, seg=8, uv=SW('chrome'))
    b.sphere(0.2, (0, 0, 27.7), a, seg=10, rings=6, uv=SW('red'))
    for sx, sy in ((3.2, 3.2), (-3.4, 3.0)):
        b.box((1.2, 0.9, 0.6), (sx, sy, 24.1), a, r=0.05, uv=SW('silver'))
    # PEST CONTROL billboard on the crown terrace, facing the street
    bz0, bw = 23.98, 4.3
    bh = bw / 2.1429
    for u in (-1.6, 1.6):
        b.beam((u, -5.75, 23.9), (u, -5.75, bz0 + 0.3), 0.12, 0.12, a, uv=SW('charcoal'))
    b.box((bw + 0.16, 0.14, bh + 0.16), (0, -5.75, bz0 + 0.3 + bh / 2), a, r=0.04, seg=1, uv=SW('charcoal'))
    b.decal('-Y', 5.82, 0, bz0 + 0.3 + bh / 2, bw, bh, 'sign_pest_control', m=a, off=0.02)
    root = b.build('bld_tower')
    # on the stucco piers (front face at 6.37): front ones above the planters' bushes
    slot(root, 0, '-Y', 6.37, -2.4, 2.25, 1.6, 1.9)
    slot(root, 1, '-Y', 6.37, 2.4, 2.25, 1.6, 1.9)
    slot(root, 2, '+X', 6.37, 0.0, 1.9, 2.0, 2.4)
    slot(root, 3, '-X', 6.37, 0.0, 1.9, 2.0, 2.4)
    slot(root, 4, '+Y', 6.37, -2.4, 1.9, 1.6, 2.4)
    return root


def build_bld_donut():
    W, R = M_wall('#fffaf2', 'stucco'), M_roof('#8a5a44', 'roof_tar')
    a = A()
    pick = Picker(505)
    rng = C.seeded(42)
    b = C.MeshBuilder()
    D, H = 4.85, 3.8
    b.box((2 * D, 2 * D, H), (0, 0, H / 2), W, r=0.35, seg=2, edges='vert')
    b.box((2 * D + 0.16, 2 * D + 0.16, 0.35), (0, 0, 0.175), a, r=0.35, seg=2, edges='vert', uv=SW('blush'))
    b.box((10.0, 10.0, 0.45), (0, 0, H + 0.22), R, r=0.14, seg=2)       # chocolate cornice
    # chocolate drips over the front + front corners
    for i, u in enumerate((-4.3, -3.4, -2.2, -1.1, 0.0, 1.2, 2.3, 3.5, 4.4)):
        L = 0.35 + 0.35 * ((i * 7) % 5) / 4.0
        b.box((0.36, 0.14, L), (u, -5.0 + 0.04, H - L / 2 + 0.1), R, r=0.12, seg=1)
    for sx in (-1, 1):
        for y in (-3.6, -1.5):
            L = 0.5 if y < -2 else 0.3
            b.box((0.14, 0.36, L), (sx * 4.96, y, H - L / 2 + 0.1), R, r=0.12, seg=1)
    # front
    door(b, '-Y', D, 0, 1.2, 2.3, 'door_shop', z0=0.1, step=0.3, frame='pink')
    for u, cells in ((-2.75, ('window_lamp', 'window_plant')), (2.75, ('window_cat', 'window_fishbowl'))):
        win(b, '-Y', D, u, 1.75, 2.3, 1.5, cells, mullion=True, frame='pink')
        awning(b, u - 1.4, u + 1.4, -D, -5.45, 3.15, 2.85, 5, 'pink', 'white', scallop=False)
    for face in ('+X', '-X'):
        for u in (-1.8, 1.8):
            round_win(b, face, D, u, 1.9, 0.48, pick(), frame='pink')
    door(b, '+Y', D, -2.5, 1.1, 2.2, 'door_red', z0=0.1)
    win(b, '+Y', D, 1.5, 1.9, 1.3, 1.2, pick())
    # DONUTS sign on the roof's front edge, under the giant donut
    top = H + 0.45
    sw_ = 2.9
    sh_ = sw_ / 2.1429
    b.box((sw_ + 0.14, 0.16, sh_ + 0.14), (0, -4.25, top + 0.12 + sh_ / 2), a, r=0.04, seg=1, uv=SW('chocolate'))
    for u in (-1.0, 1.0):
        b.box((0.16, 0.3, 0.14), (u, -4.25, top + 0.06), a, uv=SW('chocolate'))
    b.decal('-Y', 4.33, 0, top + 0.12 + sh_ / 2, sw_, sh_, 'sign_donuts', m=a)
    b.decal('+Y', -4.17, 0, top + 0.12 + sh_ / 2, sw_, sh_, 'sign_donuts', m=a)
    # ---- giant donut on the roof (ring faces the street, -Y) ----
    b.cyl(1.1, 0.3, (0, 0.3, top + 0.15), a, seg=16, bevel=0.08, uv=SW('cream'))
    Rm, rm = 1.75, 0.85
    cz = top + 0.3 + Rm + rm - 0.12
    donut_M = C.xform((0, 0.3, cz), (90, 0, 0))   # local Z -> world -Y
    b.torus(Rm, rm, m=a, seg=26, rseg=12, matrix=donut_M, uv=SW('caramel'))
    dz = 0.35 * rm

    def fr(th, ph):
        return rm * (0.9 + 0.05 * math.sin(7 * th)), dz
    b.torus(Rm, rm, m=a, seg=26, rseg=12, minor_fn=fr, matrix=donut_M, uv=SW('pink'))
    spr = ('white', 'yellow', 'sky', 'lime')
    for i in range(44):
        th = rng.uniform(0, 2 * math.pi)
        ph = math.radians(rng.uniform(45, 135))
        rf = rm * (0.9 + 0.05 * math.sin(7 * th))
        n = Vector((math.cos(ph) * math.cos(th), math.cos(ph) * math.sin(th), math.sin(ph)))
        c = Vector(((Rm + rf * math.cos(ph)) * math.cos(th), (Rm + rf * math.cos(ph)) * math.sin(th),
                    dz + rf * math.sin(ph)))
        ax = Vector((-math.sin(th), math.cos(th), 0))
        bb = n.cross(ax)
        psi = rng.uniform(0, math.pi)
        t = ax * math.cos(psi) + bb * math.sin(psi)
        p0 = donut_M @ (c + n * 0.03 - t * 0.12)
        p1 = donut_M @ (c + n * 0.03 + t * 0.12)
        b.beam(p0, p1, 0.07, 0.07, a, uv=SW(spr[i % 4]))
    root = b.build('bld_donut')
    slot(root, 0, '+X', D, 0, 1.55, 1.4, 2.0)
    slot(root, 1, '-X', D, 0, 1.55, 1.4, 2.0)
    slot(root, 2, '+Y', D, -0.4, 1.6, 1.4, 2.0)
    return root


def build_bld_station():
    root = C.empty('bld_station')
    a = A()
    # ---- platform: solid 4 x 30 x 1.6 box (paving top) + yellow safety stripe on +X ----
    p = C.MeshBuilder()
    Pv = C.tmat('Paving', '#f1ebe1', 'paving', rough=0.7)
    p.box((3.94, 29.94, 1.48), (0, 0, 0.74), a, uv=SW('sand'))
    p.box((4.0, 30.0, 0.12), (0, 0, 1.54), Pv, r=0.03, seg=1)
    for i in range(10):   # recessed-looking panels on the track side (+X) and back (-X)
        y = -15 + (i + 0.5) * 3.0
        for sx in (1, -1):
            if (sx, i) in ((1, 4), (-1, 6)):    # these two carry pictures instead (below)
                continue
            p.box((0.03, 2.6, 1.0), (sx * 1.985, y, 0.72), a, cull=('-X' if sx > 0 else '+X',), uv=SW('tan'))
    # platform walls, where the game camera sees them: NO RACCOONS (track side), a tag (back)
    p.decal('+X', 1.97, 1.5, 0.76, 1.8, 0.84, 'sign_no_raccoons', m=a)
    p.decal('-X', 1.97, 4.5, 0.76, 1.9, 0.887, 'graffiti_trash_is_life', m=a)
    p.box((0.34, 29.9, 0.03), (1.72, 0, 1.605), a, uv=SW('yellow'))
    p.box((0.1, 29.9, 0.025), (1.94, 0, 1.6), a, uv=SW('white'))
    p.build('platform', parent=root)
    # ---- canopy: posts near -X, striped roof (+ PEST CONTROL roof ads), bunting, lamps ----
    c = C.MeshBuilder()
    PX = -1.7
    for y in (-13.5, -9.0, -4.5, 0.0, 4.5, 9.0, 13.5):
        c.cyl(0.09, 2.38, (PX, y, 1.6 + 1.19), a, seg=10, uv=SW('charcoal'))
        c.cyl(0.17, 0.1, (PX, y, 1.65), a, seg=10, uv=SW('charcoal'))
        c.beam((PX, y, 3.25), (PX + 0.95, y, 3.95), 0.07, 0.07, a, uv=SW('charcoal'))
    nseg = 10
    for i in range(nseg):   # gently peaked roof in alternating stripes
        y0 = -15 + i * 3.0
        c.poly_prism([(-2.0, 3.96), (2.0, 3.96), (2.0, 4.06), (0.0, 4.22), (-2.0, 4.06)],
                     y0, y0 + 3.0, a, axis='Y', uv=SW('aqua' if i % 2 == 0 else 'white'))
    for s in (-1, 1):  # white fascia along both long edges
        c.box((0.05, 29.96, 0.16), (s * 1.985, 0, 4.04), a, cull=('-X' if s > 0 else '+X',), uv=SW('white'))
    flags = ('hotpink', 'yellow', 'sky')
    n = 30
    for i in range(n):
        y = -15 + (i + 0.5) * 30 / n
        c.poly_prism([(y - 0.36, 3.97), (y + 0.36, 3.97), (y, 3.55)], 1.95, 1.98, a, axis='X',
                     uv=SW(flags[i % 3]))
    for y in (-11.25, -3.75, 3.75, 11.25):
        c.cyl(0.03, 0.2, (-1.25, y, 3.86), a, seg=6, uv=SW('charcoal'))
        c.cyl(0.26, 0.16, (-1.25, y, 3.72), a, r2=0.07, seg=10, uv=SW('charcoal'))
        c.sphere(0.12, (-1.25, y, 3.62), a, seg=8, rings=5, uv=SW('butter'))
    # NO RACCOONS board on the central post, facing the tracks (+X)
    c.box((0.08, 2.0, 0.98), (PX + 0.13, 0, 2.72), a, r=0.04, uv=SW('charcoal'))
    c.decal('+X', PX + 0.17, 0.0, 2.72, 1.86, 0.868, 'sign_no_raccoons', m=a)
    # clock on post y=-4.5
    c.cyl(0.32, 0.1, (PX + 0.17, -4.5, 3.3), a, axis='X', seg=16, uv=SW('charcoal'))
    c.cyl(0.27, 0.04, (PX + 0.23, -4.5, 3.3), a, axis='X', seg=16, uv=SW('white'))
    c.beam((PX + 0.26, -4.5, 3.3), (PX + 0.26, -4.5, 3.48), 0.03, 0.02, a, uv=SW('ink'))
    c.beam((PX + 0.26, -4.5, 3.3), (PX + 0.26, -4.38, 3.3), 0.03, 0.02, a, uv=SW('ink'))
    c.build('canopy', parent=root)
    # ---- roof ads: one node per slope, roofad_<i> (origin = ad centre, 2 cm over the slope,
    # local glTF +Z = the slope's outward normal, +Y = the text's up).  The game spins a node by
    # pi about its own local Z where its text would read upside down: it flips in place. ----
    sl = math.atan2(0.16, 2.0)
    for i, (sx, yc) in enumerate(((1, -7.5), (-1, 7.5))):
        n = Vector((sx * math.sin(sl), 0, math.cos(sl)))
        upv = Vector((-sx * math.cos(sl), 0, math.sin(sl)))
        right = Vector((0, sx, 0))
        ctr = Vector((sx * 1.08, yc, 4.06 + 0.92 * 0.08)) + n * 0.02
        q = C.MeshBuilder()
        q.quad((0, 0, 0), (1, 0, 0), (0, 0, 1), 1.56 * 2.1429, 1.56, a, cell='sign_pest_control')
        ad = q.build('roofad_%d' % i, location=(0, 0, 0), parent=root)
        # Blender local X -> text right, local -Y -> outward normal (glTF +Z), local Z -> text up
        R = Matrix((right, -n, upv)).transposed()
        ad.matrix_basis = Matrix.Translation(ctr) @ R.to_4x4()
    # ---- ticket booth (near -X edge, between posts) ----
    k = C.MeshBuilder()
    W = M_wall('#ffd6a5', 'siding')    # the station is not tinted by the game: keep its colour
    bx, by, bz = -1.3, 11.25, 1.6
    k.box((1.3, 1.8, 2.1), (bx, by, bz + 1.05), W, r=0.12, seg=2, edges='vert')
    k.box((1.4, 2.0, 0.16), (bx + 0.05, by, bz + 2.18), a, r=0.05, seg=1, uv=SW('hotpink'))
    Mx = C.xform((bx, by, 0))
    k.box((0.08, 1.0, 0.75), (0.65, 0, bz + 1.45), a, matrix=Mx, uv=SW('white'))
    k.decal('+X', bx + 0.69, -by, bz + 1.45, 0.86, 0.62, 'window_blinds', m=a)
    k.box((0.3, 1.1, 0.06), (0.78, 0, bz + 1.02), a, matrix=Mx, uv=SW('white'))  # counter
    k.box((0.06, 0.8, 0.22), (0.66, 0, bz + 2.0), a, matrix=Mx, uv=SW('hotpink'))
    k.decal('+Y', by + 0.9, bx, bz + 0.72, 0.7, 1.4, 'door_blue', m=a)
    k.build('booth', parent=root)
    return root


# ===========================================================================
# trash props (map.ts puts one dumpster + a bag pile in a back corner of every parking lot;
# the dumpster stands at rot = pi, so its BACK faces the camera)
# ===========================================================================

def bin_bag(mb, m, c, rx, ry, rz, sw, seed, rot=0.0, tie='yellow'):
    """Lumpy knotted bin bag; its flat bottom rests at c.z - 0.82 * rz, the knot tip is at
    about c.z + 1.12 * rz + 0.05."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=1.0)
    for v in bm.verts:
        x, y, z = v.co
        k = (1.0 + 0.06 * math.sin(4.1 * x + 2.3 * y + seed) * math.cos(3.3 * z - 1.7 * y + 0.5 * seed)
             + 0.035 * math.sin(7.0 * y + 5.0 * z + 1.3 * seed))
        if z > 0.45:                       # gathered neck
            t = (z - 0.45) / 0.55
            k *= 1.0 - 0.72 * t * t
        zz = max(z * rz * (1.12 if z > 0 else 1.0), -0.82 * rz)   # flat where it rests
        v.co = (x * k * rx, y * k * ry, zz)
    M = C.xform(c, (0, 0, rot))
    mb.add_bm(bm, m, M, uv=SW(sw))
    top = M @ Vector((0, 0, rz * 1.12))
    mb.sphere(0.05, tuple(top + Vector((0, 0, 0.01))), m, seg=8, rings=5, uv=SW(sw))       # knot
    for s in (-1, 1):                                                                 # knot ears
        mb.sphere(0.045, tuple(top + Vector((0, 0, 0.035))), m, seg=6, rings=4, scale=(1.4, 0.45, 0.6),
                  rot=(0, s * 35, rot), uv=SW(sw))
    mb.torus(0.035, 0.011, tuple(top - Vector((0, 0, 0.035))), m, seg=10, rseg=4, uv=SW(tie))  # twist tie


def build_trash_bags():
    """3-4 knotted bin bags, ~1.2 x 0.9 m, under the 0.6 m collider top (PROP_COLLIDERS)."""
    Bag = C.tmat('BinBag', '#ffffff', 'atlas_town', rough=0.28)   # shiny plastic, swatch colours
    b = C.MeshBuilder()
    bin_bag(b, Bag, (-0.27, 0.07, 0.82 * 0.26), 0.30, 0.28, 0.26, 'ink', 1.0, rot=20)
    bin_bag(b, Bag, (0.29, -0.07, 0.82 * 0.24), 0.28, 0.26, 0.24, 'forest', 2.0, rot=-30, tie='red')
    bin_bag(b, Bag, (0.02, 0.24, 0.82 * 0.18), 0.21, 0.17, 0.18, 'navy', 3.0, rot=70)
    bin_bag(b, Bag, (-0.05, -0.27, 0.82 * 0.15), 0.18, 0.15, 0.15, 'charcoal', 4.0, rot=-10, tie='red')
    # a banana peel flopped over the green bag
    c = Vector((0.40, -0.22, 0.43))
    for ang in (0, 120, 240):
        d = Vector((math.cos(math.radians(ang)), math.sin(math.radians(ang)), -0.9)).normalized()
        b.beam(c, c + d * 0.13, 0.045, 0.012, Bag, uv=SW('lemon'))
    b.sphere(0.03, tuple(c + Vector((0, 0, 0.01))), Bag, seg=6, rings=4, uv=SW('caramel'))
    return b.build('trash_bags')


def build_dumpster():
    """Chunky green dumpster (1.9 x 1.1 x 1.3 collider): one lid flipped back and hanging
    down the back, junk heaped inside, little casters, NO RACCOONS sticker + graffiti."""
    Mg = C.tmat('Dumpster', '#58c47e', 'metal', rough=0.5)
    a = A()
    b = C.MeshBuilder()
    zb, zt = 0.16, 1.12
    b.hull_box((-0.80, 0.80, -0.42, 0.42, zb), (-0.90, 0.90, -0.48, 0.48, zt), Mg, r=0.06, seg=2, edges='vert')
    # rolled rim + dark inside (trash level)
    for s in (-1, 1):
        b.box((1.86, 0.07, 0.08), (0, s * 0.48, zt + 0.03), Mg, r=0.025, seg=1)
        b.box((0.07, 0.96, 0.08), (s * 0.905, 0, zt + 0.03), Mg, r=0.025, seg=1)
    b.box((1.76, 0.90, 0.02), (0, 0, zt + 0.01), a, uv=SW('charcoal'))
    # fork sleeves
    for s in (-1, 1):
        b.box((0.06, 0.62, 0.13), (s * 0.92, 0, 0.66), a, r=0.02, uv=SW('forest'))
    # casters
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((0.10, 0.10, 0.05), (sx * 0.66, sy * 0.33, zb - 0.02), a, uv=SW('grey'))
            b.cyl(0.065, 0.05, (sx * 0.66, sy * 0.33, 0.065), a, axis='X', seg=10, uv=SW('rubber'))
    # closed lid (right half, x < 0), a NO RACCOONS sticker on top for the camera
    b.box((0.90, 1.02, 0.05), (-0.455, -0.005, zt + 0.095), a, r=0.02, seg=1, rot=(2.5, 0, 0), uv=SW('charcoal'))
    # (reads from the back: the side the game camera sees in the lots)
    b.quad((-0.46, -0.02, zt + 0.145), (-1, 0, 0), (0, -1, 0), 0.6, 0.28, a, cell='sign_no_raccoons')
    # open lid flipped back over its hinge, hanging down the back (left half, x > 0)
    b.box((0.90, 0.035, 1.0), (0.455, 0.528, zt + 0.06 - 0.5), a, r=0.015, seg=1, uv=SW('charcoal'))
    for x in (-0.6, -0.3, 0.3, 0.6):
        b.cyl(0.03, 0.12, (x, 0.50, zt + 0.07), a, axis='X', seg=8, uv=SW('grey'))
    # junk heaped in the open half
    bin_bag(b, a, (0.40, 0.10, 1.222 - 1.12 * 0.13), 0.30, 0.25, 0.13, 'ink', 5.0, rot=15)
    bin_bag(b, a, (0.70, -0.20, 1.20 - 1.12 * 0.10), 0.18, 0.16, 0.10, 'forest', 6.0, rot=-40, tie='red')
    b.box((0.36, 0.36, 0.04), (0.22, -0.24, 1.19), a, rot=(14, -8, 25), uv=SW('tan'))     # pizza box
    b.cyl(0.045, 0.12, (0.62, 0.22, 1.19), a, axis='X', seg=10, rot=(0, 0, 30), uv=SW('red'))   # soda can
    c = Vector((0.55, -0.45, 1.17))                                                      # banana peel
    for ang in (-60, 0, 60):
        d = Vector((math.sin(math.radians(ang)) * 0.6, -0.3, -0.9)).normalized()
        b.beam(c, c + d * 0.14, 0.05, 0.012, a, uv=SW('lemon'))
    # front: NO RACCOONS sticker + a NOM tag; back (camera side in the lots): RACCOONS RULE
    slope = Vector((0, -0.0625, 1)).normalized()

    def face_pt(z, front):
        return Vector((0, (-0.42 - 0.0625 * (z - zb)) if front else (0.42 + 0.0625 * (z - zb)), z))
    nf = Vector((1, 0, 0)).cross(slope)
    b.quad(face_pt(0.66, True) + Vector((-0.36, 0, 0)) + nf * 0.02, (1, 0, 0), slope, 0.84, 0.392, a,
           cell='sign_no_raccoons')
    b.quad(face_pt(0.62, True) + Vector((0.46, 0, 0)) + nf * 0.02, (1, 0, 0), slope, 0.46, 0.46, a,
           cell='graffiti_nom')
    up_b = Vector((0, 0.0625, 1)).normalized()
    nb = Vector((-1, 0, 0)).cross(up_b)
    b.quad(face_pt(0.66, False) + Vector((-0.40, 0, 0)) + nb * 0.02, (-1, 0, 0), up_b, 0.76, 0.355, a,
           cell='graffiti_raccoons_rule')
    return b.build('dumpster')


def star_pts(r_out, r_in, n=5, rot=90.0):
    return [((r_out if k % 2 == 0 else r_in) * math.cos(math.radians(rot + 180.0 * k / n)),
             (r_out if k % 2 == 0 else r_in) * math.sin(math.radians(rot + 180.0 * k / n))) for k in range(2 * n)]


# golden dumpster: half widths (x) / depths (y) of the tapered bin at its bottom and top
DG_ZB, DG_ZT = 0.16, 1.18
DG_XB, DG_XT, DG_YB, DG_YT = 0.86, 0.955, 0.50, 0.59
DG_LID_HINGE = Vector((0.0, 0.625, 1.25))      # glTF (0, 1.25, -0.625)
DG_LOCK = Vector((0.0, -0.645, 0.97))          # glTF (0, 0.97, 0.645)


def build_dumpster_gold():
    """GOLDEN DUMPSTER, the jackpot crate (2.0 x 1.3 x 1.4): gold paint ('GoldPaint' = metal x
    #ffc93c) with darker trim and ribs ('GoldTrim' = metal x #c8891a), painted-in highlights,
    the crowned raccoon on plaques (front + lid), white stars, a heap of coins inside.
    Nodes: body (at the origin), lid (on its back hinge: rotation.x < 0 opens it), lock (a fat
    padlock on the front, through the lid's hasp: the game pops it off)."""
    Gd = C.tmat('GoldPaint', '#ffc93c', 'metal', rough=0.35, metallic=0.15)
    Gt = C.tmat('GoldTrim', '#c8891a', 'metal', rough=0.4, metallic=0.15)
    a = A()
    root = C.empty('dumpster_gold')
    zb, zt = DG_ZB, DG_ZT

    def hx(z):
        return DG_XB + (DG_XT - DG_XB) * (z - zb) / (zt - zb)

    def hy(z):
        return DG_YB + (DG_YT - DG_YB) * (z - zb) / (zt - zb)
    tf = math.atan((DG_YT - DG_YB) / (zt - zb))     # front / back lean
    ts = math.atan((DG_XT - DG_XB) / (zt - zb))     # side lean
    up_f = Vector((0, -math.sin(tf), math.cos(tf)))  # up the front face
    n_f = Vector((1, 0, 0)).cross(up_f)              # its outward normal (front-down)

    def front(x, z, off=0.0):
        return Vector((x, -hy(z), z)) + n_f * off

    b = C.MeshBuilder()
    b.hull_box((-DG_XB, DG_XB, -DG_YB, DG_YB, zb), (-DG_XT, DG_XT, -DG_YT, DG_YT, zt), Gd, r=0.07, seg=2,
               edges='vert')
    # rolled rim, a band round the middle, ribs front and back, fork sleeves
    for s in (-1, 1):
        b.box((2 * DG_XT + 0.04, 0.08, 0.09), (0, s * (DG_YT + 0.005), zt + 0.02), Gt, r=0.03, seg=1)
        b.box((0.08, 2 * DG_YT + 0.04, 0.09), (s * (DG_XT + 0.005), 0, zt + 0.02), Gt, r=0.03, seg=1)
    z0, z1 = 0.22, 0.3
    b.hull_box((-hx(z0) - 0.016, hx(z0) + 0.016, -hy(z0) - 0.016, hy(z0) + 0.016, z0),
               (-hx(z1) - 0.016, hx(z1) + 0.016, -hy(z1) - 0.016, hy(z1) + 0.016, z1), Gt, r=0.08, seg=2,
               edges='vert')
    for s in (-1, 1):
        for x in (-0.62, 0.62):
            p0 = Vector((x, s * hy(zb + 0.06), zb + 0.06)) + Vector((0, s * 0.012, 0))
            p1 = Vector((x, s * hy(zt - 0.06), zt - 0.06)) + Vector((0, s * 0.012, 0))
            b.beam(p0, p1, 0.08, 0.05, Gt, r=0.015)
        b.box((0.07, 0.7, 0.15), (s * (hx(0.7) + 0.03), 0, 0.7), Gt, r=0.025, seg=1)
    # casters
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((0.12, 0.12, 0.05), (sx * 0.68, sy * 0.36, zb - 0.02), a, uv=SW('grey'))
            b.cyl(0.07, 0.055, (sx * 0.68, sy * 0.36, 0.07), a, axis='X', seg=10, uv=SW('rubber'))
    # treasure under the lid: a low heap of gold coins, a few loose coins and gems on it
    b.sphere(1.0, (0, 0, zt), a, seg=16, rings=6, scale=(0.82, 0.47, 0.055), cut_below=0.0, uv=SW('lemon'))
    rng = C.seeded(7)
    for k in range(14):
        ang = 2 * math.pi * k / 14 + rng.uniform(-0.2, 0.2)
        rr = rng.uniform(0.15, 0.6)
        cx, cy = rr * math.cos(ang), 0.55 * rr * math.sin(ang)
        h = 0.055 * math.sqrt(max(0.0, 1 - (cx / 0.82) ** 2 - (cy / 0.47) ** 2))
        b.cyl(0.055, 0.012, (cx, cy, zt + h + 0.004), a, seg=10, rot=(rng.uniform(-20, 20), rng.uniform(-20, 20), 0),
              uv=SW('brass'))
    for (gx, gy, sw) in ((-0.3, 0.1, 'cherry'), (0.25, -0.15, 'teal'), (0.55, 0.12, 'violet')):
        b.sphere(0.045, (gx, gy, zt + 0.05), a, seg=4, rings=2, scale=(1, 1, 1.3), uv=SW(sw))
    # two coins poking out from under the lid's front lip, resting on the rim
    for (x, ang) in ((-0.42, 18.0), (0.6, -12.0)):
        b.cyl(0.06, 0.013, (x, -0.66, 1.255), a, axis='Y', seg=12, rot=(70, 0, ang), uv=SW('brass'))
    # front: the crowned raccoon on a trim plaque, painted highlights, stars
    R_f = Matrix.Rotation(tf, 4, 'X')               # local -Y -> the front normal, +Z -> up the face
    pc = front(0, 0.555)
    b.box((0.5, 0.04, 0.5), (0, 0, 0), Gt, r=0.05, seg=2, matrix=Matrix.Translation(pc + n_f * 0.015) @ R_f)
    b.quad(tuple(pc + n_f * 0.047), (1, 0, 0), tuple(up_f), 0.42, 0.42, a, cell='graffiti_crown')
    # glints running up the two front corners
    for sx in (-1, 1):
        c0 = Vector((sx * (hx(0.36) - 0.0205), -(hy(0.36) - 0.0205), 0.36))
        c1 = Vector((sx * (hx(1.08) - 0.0205), -(hy(1.08) - 0.0205), 1.08))
        b.beam(c0, c1, 0.03, 0.006, a, uv=SW('butter' if sx > 0 else 'white'))
    e1 = Vector((1, 0, 0))

    def stroke(mb, c, n, e2, length, width, ang, sw):
        r = e1 * math.cos(math.radians(ang)) + e2 * math.sin(math.radians(ang))
        u = -e1 * math.sin(math.radians(ang)) + e2 * math.cos(math.radians(ang))
        mb.quad(tuple(c + n * 0.008), tuple(r), tuple(u), length, width, a, uv=SW(sw))
    stroke(b, front(-0.8, 0.86), n_f, up_f, 0.32, 0.055, 62, 'butter')
    stroke(b, front(-0.72, 1.0), n_f, up_f, 0.16, 0.035, 62, 'white')
    for (x, z, r) in ((0.45, 0.98, 0.08), (-0.45, 0.98, 0.06), (0.8, 0.62, 0.06), (-0.8, 0.45, 0.05)):
        b.poly_prism(star_pts(r, r * 0.45), 0.0, -0.016, a, axis='Y',
                     matrix=Matrix.Translation(front(x, z, 0.003)) @ R_f, uv=SW('white'))
    # sides: a big star and two little ones on each
    for s in (-1, 1):
        for (y, z, r) in ((0.16, 0.97, 0.15), (-0.32, 1.02, 0.07), (0.36, 0.5, 0.07)):
            M = Matrix.Translation((s * (hx(z) + 0.003), y, z)) @ Matrix.Rotation(s * ts, 4, 'Y')
            b.poly_prism(star_pts(r, r * 0.45), 0.0, s * 0.016, a, axis='X', matrix=M, uv=SW('white'))
    body = b.build('body', parent=root)

    # ---- lid (its hinge on the back top edge) ----
    L = C.MeshBuilder()
    L.box((2 * DG_XT + 0.05, 2 * DG_YT + 0.06, 0.06), (0, -0.005, 1.28), Gd, r=0.025, seg=1)
    L.box((1.62, 0.96, 0.05), (0, -0.02, 1.33), Gd, r=0.04, seg=2)
    L.box((2 * DG_XT + 0.03, 0.05, 0.075), (0, -DG_YT - 0.02, 1.285), Gt, r=0.02, seg=1)   # front lip
    L.box((0.13, 0.025, 0.2), (0, -DG_YT - 0.055, 1.2), Gt, r=0.01, seg=1)                 # the hasp
    L.box((0.05, 0.03, 0.07), (0, -DG_YT - 0.068, 1.15), a, uv=SW('ink'))                  # its slot
    for x in (-0.55, 0.55):
        L.cyl(0.035, 0.2, (x, DG_LID_HINGE.y, DG_LID_HINGE.z), Gt, axis='X', seg=10)
    for x in (-0.45, 0.45):                                                                 # handles
        L.beam((x - 0.12, -0.42, 1.355), (x - 0.12, -0.42, 1.385), 0.03, 0.03, Gt)
        L.beam((x + 0.12, -0.42, 1.355), (x + 0.12, -0.42, 1.385), 0.03, 0.03, Gt)
        L.beam((x - 0.135, -0.42, 1.385), (x + 0.135, -0.42, 1.385), 0.03, 0.03, Gt, r=0.01)
    L.box((0.56, 0.56, 0.012), (0, 0.04, 1.358), Gt, r=0.01, seg=1)
    L.quad((0, 0.04, 1.37), (1, 0, 0), (0, 1, 0), 0.5, 0.5, a, cell='graffiti_crown')
    Z = Matrix.Rotation(math.pi / 2, 4, 'X')     # poly_prism axis='Y' -> grows up (+Z)
    for (x, y, r) in ((-0.62, 0.22, 0.12), (0.64, 0.05, 0.1), (0.5, 0.3, 0.05), (-0.25, -0.3, 0.05)):
        L.poly_prism(star_pts(r, r * 0.45), 0.0, 0.012, a, axis='Y',
                     matrix=Matrix.Translation((x, y, 1.355)) @ Z, uv=SW('white'))
    e2 = Vector((0, 1, 0))
    for (c, ln, w, sw) in (((-0.7, -0.2), 0.3, 0.05, 'butter'), ((-0.6, -0.24), 0.16, 0.035, 'white')):
        ang = math.radians(50)
        r = e1 * math.cos(ang) + e2 * math.sin(ang)
        u = -e1 * math.sin(ang) + e2 * math.cos(ang)
        L.quad((c[0], c[1], 1.363), tuple(r), tuple(u), ln, w, a, uv=SW(sw))
    L.build('lid', location=tuple(DG_LID_HINGE), parent=root)

    # ---- the padlock (node at its body's centre) ----
    K = C.MeshBuilder()
    c = DG_LOCK
    K.box((0.3, 0.11, 0.25), tuple(c), a, r=0.05, seg=2, uv=SW('steel'))
    K.torus(0.085, 0.026, tuple(c + Vector((0, 0, 0.125))), a, seg=14, rseg=6, rot=(90, 0, 0), uv=SW('chrome'))
    K.cyl(0.042, 0.012, tuple(c + Vector((0, -0.058, 0.025))), a, axis='Y', seg=10, uv=SW('ink'))
    K.box((0.026, 0.012, 0.06), tuple(c + Vector((0, -0.058, -0.017))), a, uv=SW('ink'))
    K.box((0.24, 0.012, 0.035), tuple(c + Vector((0, -0.056, -0.093))), a, uv=SW('silver'))
    K.build('lock', location=tuple(c), parent=root)
    return root


# ===========================================================================
# ruins: the map's cartoon mishaps (src/shared/kit.json "setpieces")
# ===========================================================================
# Each model lines up with its set piece's FIXED colliders in kit.json: walkable tops (slabs,
# rubble, ramps, the wrecking ball) within ~0.15 m of the collider top, walls where the
# collider walls are.  kit.json is in the glTF frame (+z = the street side, +x = the model's
# left), so these builders think in kit coordinates: K(x, z, y) is Blender (x, -z, y).  Broken
# edges only ever stick OUT of a collider, so a walkable top never ends short of it.
# Materials: AtlasTown swatches, the tinted 'Wall' (the game recolours it), 'Roof' (shingles)
# and 'Water' (the Glass recipe, so it compiles to the very same blended program).

CHUNKS = (('grey', 4), ('silver', 3), ('terracotta', 3), ('sand', 2))
FACE_N = {'+Y': (0, 1, 0), '-Y': (0, -1, 0), '+X': (1, 0, 0), '-X': (-1, 0, 0)}


def K(x, z, y=0.0):
    """Kit point (x, z, height y) -> Blender Vector."""
    return Vector((x, -z, y))


def kbox(b, x0, x1, z0, z1, y0, y1, m, uv=None, **kw):
    """Box over the kit ranges x0..x1, z0..z1, heights y0..y1."""
    b.box((abs(x1 - x0), abs(z1 - z0), abs(y1 - y0)),
          ((x0 + x1) / 2, -(z0 + z1) / 2, (y0 + y1) / 2), m, uv=uv, **kw)


def wpick(rng, table):
    names, weights = zip(*table)
    return rng.choices(names, weights)[0]


def M_water():
    """Puddles and a burst pipe: exactly the Glass recipe (blended, untextured), so the game
    compiles no new shader program for it."""
    m = bpy.data.materials.get('Water')
    if m is not None:
        return m
    m = C.mat('Water', '#7cc8f2', rough=0.15)
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Alpha'].default_value = 0.55
    m.use_backface_culling = False
    try:
        m.surface_render_method = 'BLENDED'
    except (AttributeError, TypeError):
        pass
    m.diffuse_color = (*C.hex_lin('#7cc8f2'), 0.55)
    return m


def FU(face, plane, along):
    """(d, u) for win() / door() / decal() on the wall plane at Blender coordinate `plane` (y for
    the +-Y faces, x for the +-X faces), at Blender `along` (x, resp. y) on that plane."""
    s = {'+Y': (1, 1), '-Y': (-1, -1), '+X': (1, -1), '-X': (-1, 1)}[face]
    return s[0] * plane, s[1] * along


def wpt(face, plane, along, v, off=0.014):
    """Blender point on a wall plane (FU conventions), `off` in front of it."""
    n = FACE_N[face]
    if face in ('+Y', '-Y'):
        return Vector((along, plane + n[1] * off, v))
    return Vector((plane + n[0] * off, along, v))


def paper(b, face, plane, a0, a1, v0, v1, sw, off=0.012):
    """A flat swatch-coloured panel on a wall plane: wallpaper, tiles, a pale patch."""
    d, u = FU(face, plane, (a0 + a1) / 2)
    b.decal(face, d, u, (v0 + v1) / 2, abs(a1 - a0), v1 - v0, _sw_rect(sw), m=A(), off=off)


def _newell(cos):
    n = Vector((0.0, 0.0, 0.0))
    k = len(cos)
    for i in range(k):
        p, q = cos[i], cos[(i + 1) % k]
        n.x += (p.y - q.y) * (p.z + q.z)
        n.y += (p.z - q.z) * (p.x + q.x)
        n.z += (p.x - q.x) * (p.y + q.y)
    return n


def raw_faces(b, verts, faces, m, sws):
    """Append polygons straight into MeshBuilder `b`: `verts` in Blender coordinates, `faces`
    index lists wound counter-clockwise seen from outside, one swatch name per face (None = UV
    (0, 0), for untextured materials).  N-gons are split here with tessellate_polygon, so the
    exporter never re-triangulates anything."""
    from mathutils import geometry as MG
    off = len(b.verts)
    vs = [Vector(v) for v in verts]
    b.verts.extend(tuple(v) for v in vs)
    mi = b._mi(m)
    tris = 0
    for f, sw in zip(faces, sws):
        uv = tuple(T.swatch_uv(sw)) if sw else (0.0, 0.0)
        polys = [list(f)]
        if len(f) > 4:
            n = _newell([vs[i] for i in f])
            polys = []
            for t in MG.tessellate_polygon([[vs[i] for i in f]]):
                tri = [f[k] for k in t]
                if _newell([vs[i] for i in tri]).dot(n) < 0:
                    tri.reverse()
                polys.append(tri)
        for p in polys:
            b.faces.append([i + off for i in p])
            b.fmat.append(mi)
            b.uvs.append([uv] * len(p))
            tris += len(p) - 2
    b.log.append((tris, m.name))


def flat_poly(b, pts, normal, sw, m=None):
    """One flat polygon (Blender points, either winding) facing `normal`."""
    vs = [Vector(p) for p in pts]
    f = list(range(len(vs)))
    if _newell(vs).dot(Vector(normal)) < 0:
        f.reverse()
    raw_faces(b, vs, [f], m or A(), [sw])


def prism(b, pts, z0, z1, m, top, side=None, bottom=None, matrix=None):
    """Closed prism over the simple polygon `pts` [(x, y)] (its local plan), local z from z0 to z1,
    then `matrix` (a rotation + translation).  Swatches per face kind; bottom None = open."""
    pts = [(float(x), float(y)) for x, y in pts]
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area < 0:
        pts.reverse()
    M = matrix if matrix is not None else Matrix()
    verts = [M @ Vector((x, y, z0)) for x, y in pts] + [M @ Vector((x, y, z1)) for x, y in pts]
    faces, sws = [list(range(n, 2 * n))], [top]
    if bottom:
        faces.append(list(reversed(range(n))))
        sws.append(bottom)
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j, n + i])
        sws.append(side or top)
    raw_faces(b, verts, faces, m, sws)


def grid(b, P, m, swfn, out):
    """Quads over a 2D array of Blender points P[j][i]; one swatch per cell swfn(i, j).  The sheet
    is wound so that its summed normal points along `out` (a heightfield: up)."""
    rows, cols = len(P), len(P[0])
    verts = [Vector(p) for row in P for p in row]
    quads = [[j * cols + i, j * cols + i + 1, (j + 1) * cols + i + 1, (j + 1) * cols + i]
             for j in range(rows - 1) for i in range(cols - 1)]
    tot = Vector((0.0, 0.0, 0.0))
    for q in quads:
        tot += _newell([verts[k] for k in q])
    if tot.dot(Vector(out)) < 0:
        quads = [list(reversed(q)) for q in quads]
    raw_faces(b, verts, quads, m, [swfn(i, j) for j in range(rows - 1) for i in range(cols - 1)])


def strut(b, p0, p1, w, m, sw, t=None):
    """Open square tube p0 -> p1 (w x t, no end caps: 8 triangles): lattice bars, rebar, ropes."""
    p0, p1 = Vector(p0), Vector(p1)
    R = (p1 - p0).normalized().to_track_quat('Z', 'Y').to_matrix()
    hx, hy = w / 2, (t if t is not None else w) / 2
    ring = [R @ Vector((x, y, 0.0)) for x, y in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))]
    raw_faces(b, [p0 + c for c in ring] + [p1 + c for c in ring],
              [[i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i] for i in range(4)], m, [sw] * 4)


def hexa(b, o, e1, e2, e3, m, uv=None):
    """Parallelepiped o + [0,1]e1 + [0,1]e2 + [0,1]e3 (either handedness), wound outward."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    M = Matrix(((e1[0], e2[0], e3[0], o[0]), (e1[1], e2[1], e3[1], o[1]),
                (e1[2], e2[2], e3[2], o[2]), (0.0, 0.0, 0.0, 1.0)))
    for v in bm.verts:
        v.co = M @ (v.co + Vector((0.5, 0.5, 0.5)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b.add_bm(bm, m, None, uv=uv)


def frame(o, s_vec, w_vec):
    """Matrix whose local x = w, y = s (both normalised), z = their upward normal, origin o; if
    w x s points down, w is flipped (returns (matrix, flipped))."""
    s, w = Vector(s_vec).normalized(), Vector(w_vec).normalized()
    n = w.cross(s)
    flip = n.z < 0
    if flip:
        w, n = -w, -n
    M = Matrix.Identity(4)
    for r in range(3):
        M[r][0], M[r][1], M[r][2], M[r][3] = w[r], s[r], n[r], o[r]
    return M, flip


def jag_edge(rng, p, q, out, lo=-0.05, hi=0.28, step=(0.3, 0.7)):
    """2D points strictly between p and q, pushed along `out` (unit, away from the collider) by
    alternately small and large amounts in lo..hi: a broken edge."""
    (px, pz), (qx, qz) = p, q
    L = math.hypot(qx - px, qz - pz)
    pts, s, k, mid = [], rng.uniform(*step) * 0.6, 0, (lo + hi) / 2
    while s < L - 0.2:
        o = rng.uniform(lo, mid) if k % 2 else rng.uniform(mid, hi)
        t = s / L
        pts.append((px + (qx - px) * t + out[0] * o, pz + (qz - pz) * t + out[1] * o))
        s += rng.uniform(*step)
        k += 1
    return pts


def jag_top(rng, u0, u1, top, lo, hi, step=(0.3, 0.9), notches=(), keep=()):
    """(u, height) points from u0 to u1 (both ends included) along a broken-off wall top: brick
    courses that break off in steps (a flat run, then a drop or a rise) mixed with ragged slants,
    all within top+lo .. top+hi; V-shaped bites `notches` [(u, depth)]; `keep` [(u, h)] spots
    held at least h high (where a beam rests on it).  A step is two points at the same u."""
    sgn = 1 if u1 > u0 else -1
    L = abs(u1 - u0)

    def at(u, h):
        for nu, depth in notches:
            dd = abs(u - nu)
            if dd < 1.1:
                h -= depth * (1 - dd / 1.1)
        for ku, kh in keep:
            if abs(u - ku) < 0.45:
                h = max(h, kh)
        return (u, h)
    h = top + rng.uniform(lo, hi)
    out, s = [at(u0, h)], 0.0
    while s < L:
        s2 = min(L, s + rng.uniform(*step))
        if L - s2 < 0.25:
            s2 = L
        u = u0 + sgn * s2
        if s2 < L and rng.random() < 0.6:
            out.append(at(u, h))                       # a course runs flat, then steps
            dh = rng.uniform(0.14, 0.38) * (1 if rng.random() < 0.5 else -1)
            if not (top + lo <= h + dh <= top + hi):
                dh = -dh
            h = min(top + hi, max(top + lo, h + dh))
            out.append(at(u, h))
        else:
            h = top + rng.uniform(lo, hi)
            out.append(at(u, h))
        s = s2
    clean = [out[0]]
    for p in out[1:]:
        if abs(p[0] - clean[-1][0]) > 1e-6 or abs(p[1] - clean[-1][1]) > 0.02:
            clean.append(p)
    return clean


def wall_x(b, m, x0, x1, y0, y1, top, end0=(), end1=()):
    """Wall along Blender X (x0 < x1), Blender y0..y1 thick.  Elevation polygon: the bottom edge,
    the x1 end going up (end1 [(x, h)]), the broken top [(x, h)] from x1 back to x0, the x0 end
    going down (end0).  Box-UV'd like every other wall (poly_prism)."""
    b.poly_prism([(x0, 0.0), (x1, 0.0)] + list(end1) + list(top) + list(end0), y0, y1, m, axis='Y')


def wall_y(b, m, y0, y1, x0, x1, top, end0=(), end1=()):
    """The same along Blender Y (y0 < y1; points (y, h)), Blender x0..x1 thick."""
    b.poly_prism([(y0, 0.0), (y1, 0.0)] + list(end1) + list(top) + list(end0), x0, x1, m, axis='X')


def cut_into(b, wb, holes, reveal):
    """Build the temp builder `wb`, boolean-cut the box holes [(size, loc)] (Blender) out of it
    (the reveals take the cutter's swatch), and merge the result into `b`."""
    ob = wb.build('_walls')
    cutters = []
    for size, loc in holes:
        cm = C.MeshBuilder()
        cm.box(size, loc, A(), uv=SW(reveal))
        cutters.append(cm.build('_cutter'))
    if cutters:
        C.boolean_cut(ob, cutters)
    merge_and_delete(b, ob, keep_uv=True)


def chunk(b, rng, c, size, sw, tilt=25.0):
    """A randomly turned block of rubble centred at Blender point c."""
    b.box(size, tuple(c), A(), rot=(rng.uniform(-tilt, tilt), rng.uniform(-tilt, tilt), rng.uniform(0, 180)),
          uv=SW(sw))


def blotch(x, z, k=0.0):
    """Smooth -1.5..1.5 noise over kit (x, z): colours rubble in soft patches, not per cell."""
    return (math.sin(0.83 * x + 1.7 + k) * math.cos(0.61 * z - 0.4 + 2.0 * k)
            + 0.5 * math.sin(1.37 * (x - z) + 3.0 * k))


def patchy(P, k=0.0, base='sand', alt='silver', alt2='tan'):
    """Cell swatch function for grid(P): `base` with soft patches of `alt` (and a few `alt2`)."""
    def sw(i, j):
        c = (Vector(P[j][i]) + Vector(P[j][i + 1]) + Vector(P[j + 1][i]) + Vector(P[j + 1][i + 1])) / 4
        v = blotch(c.x, -c.y, k)
        return alt if v > 0.5 else (alt2 if v < -0.9 else base)
    return sw


def plate(b, rng, c, R, rx, ry, t, top, side, lift=0.05, n=5):
    """An irregular slab of debris (an n-sided plate, rx x ry, t thick) lying in the local plane of
    rotation R (its local z = the surface normal) at Blender point c, its top `lift` above it."""
    pts = [(math.cos(a) * rx * rng.uniform(0.55, 1.0), math.sin(a) * ry * rng.uniform(0.55, 1.0))
           for a in [2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / n for k in range(n)]]
    M = R.to_4x4()
    M.translation = Vector(c)
    prism(b, pts, lift - t, lift, A(), top, side, None, matrix=M)


DEBRIS = (('brick', 5), ('plate', 4), ('plank', 2), ('scrap', 2))


def litter(b, rng, spots, surf, Rslope, scraps=('blush', 'seafoam', 'butter', 'lavender')):
    """Debris lying flat on a surface: at each kit spot (x, z), a brick, a concrete plate, a plank
    or a scrap of wallpaper, turned at random about the surface normal (Rslope's local z), its
    top at most ~0.1 above surf(x, z)."""
    for x, z in spots:
        kind = wpick(rng, DEBRIS)
        R = Rslope @ Matrix.Rotation(rng.uniform(0, math.pi), 3, 'Z') @ Matrix.Rotation(math.radians(rng.uniform(-3, 3)), 3, 'X')
        c = K(x, z, surf(x, z))
        n = Rslope @ Vector((0.0, 0.0, 1.0))
        if kind == 'plate':
            plate(b, rng, c, R, rng.uniform(0.3, 0.55), rng.uniform(0.25, 0.4), 0.12,
                  rng.choice(('silver', 'grey', 'silver')), 'grey', lift=0.06)
        elif kind == 'brick':
            M = R.to_4x4()
            M.translation = c + n * 0.02
            b.box((0.27, 0.13, 0.1), (0, 0, 0), A(), matrix=M, uv=SW('terracotta'))
        elif kind == 'plank':
            M = R.to_4x4()
            M.translation = c + n * 0.015
            b.box((rng.uniform(0.7, 1.1), 0.13, 0.05), (0, 0, 0), A(), matrix=M, uv=SW('wood'))
        else:
            plate(b, rng, c, R, rng.uniform(0.2, 0.32), rng.uniform(0.15, 0.25), 0.02, rng.choice(scraps), 'white',
                  lift=0.03, n=5)


def flat_strip(b, pts, y, w, sw):
    """Flat quads along the kit polyline pts [(x, z)] at height y, w wide (cracks, seams)."""
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        p, q = K(x0, z0, y), K(x1, z1, y)
        d = q - p
        n = Vector((-d.y, d.x, 0.0)).normalized() * (w / 2)
        raw_faces(b, [p - n, q - n, q + n, p + n], [[0, 1, 2, 3]], A(), [sw])


def crack(rng, start, heading, n=4, seg=(0.35, 0.7), wander=0.6):
    """A random-walk crack polyline from kit point `start`, roughly along `heading` (radians)."""
    pts = [start]
    a = heading
    for _ in range(n):
        a += rng.uniform(-wander, wander)
        L = rng.uniform(*seg)
        x, z = pts[-1]
        pts.append((x + math.cos(a) * L, z + math.sin(a) * L))
    return pts


def rebar(b, rng, edge, out, y, p=0.5, reach=(0.25, 0.55)):
    """Rusty rebar sticking out of a broken concrete edge (kit points `edge`, unit kit `out`)."""
    o = Vector((out[0], -out[1], 0.0))
    for (x, z) in edge:
        if rng.random() > p:
            continue
        p0 = K(x, z, y - rng.uniform(0.0, 0.12)) - o * 0.1
        L = rng.uniform(*reach)
        p1 = p0 + o * L + Vector((rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), -rng.uniform(-0.05, 0.3) * L))
        strut(b, p0, p1, 0.035, A(), 'brown')
        if rng.random() < 0.55:
            strut(b, p1, p1 + o * 0.1 + Vector((0, 0, -rng.uniform(0.18, 0.42))), 0.035, A(), 'brown')


def soot(b, rng, face, plane, along, v0, w, hgt):
    """A soot tongue licking up a wall from the top of a burnt opening (FU conventions)."""
    def j(s):
        return rng.uniform(-s, s)
    shape = [(-0.5, 0.0), (0.5, 0.0), (0.44 + j(0.05), 0.28), (0.24 + j(0.06), 0.5), (0.3 + j(0.05), 0.66),
             (0.08 + j(0.05), 0.84), (j(0.08), 1.0), (-0.16 + j(0.05), 0.72), (-0.32 + j(0.05), 0.56),
             (-0.22 + j(0.05), 0.4), (-0.46 + j(0.04), 0.22)]
    flat_poly(b, [wpt(face, plane, along + du * w, v0 + dv * hgt) for du, dv in shape], FACE_N[face], 'ink')


def soot_band(b, rng, face, plane, top, depth=(0.25, 0.75), off=0.014):
    """A charred band under a broken wall top (`top` [(along, h)]) on one face of the wall."""
    ds = [rng.uniform(*depth) for _ in top]
    for (u0, h0), (u1, h1), d0, d1 in zip(top, top[1:], ds, ds[1:]):
        if abs(u1 - u0) < 1e-3:
            continue
        flat_poly(b, [wpt(face, plane, u0, h0 - 0.03, off), wpt(face, plane, u1, h1 - 0.03, off),
                      wpt(face, plane, u1, h1 - d1, off), wpt(face, plane, u0, h0 - d0, off)],
                  FACE_N[face], 'ink')


def framed(b, face, plane, along, v, w, h, cell, frame='wood', tilt=0.0):
    """A framed picture (atlas cell or UV rect) hung on a wall plane, crooked by `tilt` deg."""
    n = Vector(FACE_N[face])
    up = Vector((0.0, 0.0, 1.0))
    right = up.cross(n)
    if tilt:
        Rt = Matrix.Rotation(math.radians(tilt), 3, n)
        right, up = Rt @ right, Rt @ up
    c = wpt(face, plane, along, v, 0.02)
    M = Matrix((right, -n, up)).transposed().to_4x4()
    M.translation = c
    b.box((w + 0.12, 0.04, h + 0.12), (0, 0, 0), A(), matrix=M, uv=SW(frame))
    b.quad(tuple(c + n * 0.025), tuple(right), tuple(up), w, h, A(), cell=cell)


def top_at(pts, u):
    """Height of a broken wall top [(u, h)] at u (linear between its points)."""
    for (u0, h0), (u1, h1) in zip(pts, pts[1:]):
        if min(u0, u1) <= u <= max(u0, u1) and u0 != u1:
            return h0 + (h1 - h0) * (u - u0) / (u1 - u0)
    return pts[-1][1]


def cone(b, M):
    """A traffic cone (base on its local origin, axis local +Z) placed by matrix M."""
    a = A()
    b.box((0.42, 0.42, 0.04), (0, 0, 0.02), a, matrix=M, uv=SW('orange'))
    b.cyl(0.16, 0.56, (0, 0, 0.32), a, r2=0.03, seg=10, matrix=M, uv=SW('orange'))
    b.cyl(0.12, 0.1, (0, 0, 0.34), a, r2=0.105, seg=10, caps=False, matrix=M, uv=SW('white'))


# ---------------------------------------------------------------- demolition --

def build_bld_demolished():
    """Half-demolished 3-storey block (kit setpieces.demolition; at the set piece origin).  The
    back half stands up to its exposed floor slabs (tops 3.3 / 6.6 / 9.9: broken front edges,
    rebar), the party walls left standing show their wallpaper, a fridge (top 4.5) and a
    dresser (top 7.8) were left on the slabs, a rubble heap (top 1.2) lies out front, the two
    remnant walls are broken off (left to 8.4, back to 11.2, window holes) and a construction
    fence closes the street side."""
    W = M_wall('#fffaf2', 'brick')
    a = A()
    rng = C.seeded(7101)
    pick = Picker(7102)
    b = C.MeshBuilder()

    # ---- ground storey: the intact block under slab 1 (kit x -7..7, z -6..0) ----------------
    # (up to slab 1's underside: any higher, its back face shares a plane with the slab's edge)
    kbox(b, -6.9, 7.0, -5.95, -0.12, 0.0, 2.98, W, r=0.1, seg=1, edges='vert', cull=('-Z', '+Z'))
    kbox(b, -7.08, 7.08, -6.08, -5.92, 0.0, 0.42, a, uv=SW('sand'), cull=('-Z',))
    kbox(b, 6.92, 7.08, -6.0, -0.12, 0.0, 0.42, a, uv=SW('sand'), cull=('-Z',))
    kbox(b, -7.08, -6.92, -6.0, 0.75, 0.0, 0.42, a, uv=SW('sand'), cull=('-Z',))
    # exterior floor bands (back, left, +x side)
    for y, xr in ((3.3, 7.07), (6.6, 3.8), (9.9, 3.8)):
        kbox(b, -7.07, xr, -6.08, -5.98, y - 0.08, y + 0.08, a, uv=SW('white'), cull=('-Y',))
    for y, zf in ((3.3, 0.75), (6.6, 0.75), (9.9, -3.2)):
        kbox(b, -7.08, -6.98, -6.0, zf, y - 0.08, y + 0.08, a, uv=SW('white'), cull=('+X',))
    kbox(b, 6.98, 7.08, -6.0, -0.12, 3.22, 3.38, a, uv=SW('white'), cull=('-X',))

    # ---- the floor slabs: concrete, broken front edges, rebar, cracks ------------------------
    st = (0.38, 0.85)
    e1 = jag_edge(rng, (7.0, 0.0), (-6.95, 0.0), (0.0, 1.0), step=st)
    r2 = jag_edge(rng, (3.0, -5.9), (3.0, -2.0), (1.0, 0.0), step=st)
    f2 = jag_edge(rng, (3.0, -2.0), (-6.95, -2.0), (0.0, 1.0), step=st)
    r3 = jag_edge(rng, (-1.4, -5.9), (-1.4, -3.2), (1.0, 0.0), step=st)
    f3 = jag_edge(rng, (-1.4, -3.2), (-6.95, -3.2), (0.0, 1.0), step=st)
    slabs = (
        (3.3, [(-6.98, -5.95), (7.05, -5.95), (7.05, 0.06)] + e1 + [(-6.98, 0.12)]),
        (6.6, [(-6.98, -5.95), (3.05, -5.95)] + r2 + [(3.18, -1.84)] + f2 + [(-6.98, -1.9)]),
        (9.9, [(-6.98, -5.95), (-1.35, -5.95)] + r3 + [(-1.22, -3.05)] + f3 + [(-6.98, -3.1)]),
    )
    for top, poly in slabs:
        prism(b, [(x, -z) for x, z in poly], top - 0.32, top, a, 'silver', 'grey', 'grey')
    for edge, out, top in ((e1, (0, 1), 3.3), (r2, (1, 0), 6.6), (f2, (0, 1), 6.6), (r3, (1, 0), 9.9),
                           (f3, (0, 1), 9.9)):
        rebar(b, rng, edge, out, top - 0.14, p=0.3)
    for top, x0, x1, zf in ((3.3, -6.0, 6.5, 0.0), (6.6, -6.0, 2.5, -2.0), (9.9, -6.2, -1.9, -3.2)):
        for _ in range(3 if top < 9 else 2):
            flat_strip(b, crack(rng, (rng.uniform(x0, x1), zf - 0.02), -math.pi / 2, n=3, seg=(0.3, 0.6)),
                       top + 0.004, 0.045, 'grey')
    # a broken-off piece of slab 1 hanging down from its edge on its rebar
    hinge = K(1.15, 0.1, 3.17)
    Mf = Matrix.Translation(hinge) @ Matrix.Rotation(math.radians(58), 4, 'X')
    plate(b, rng, Mf @ Vector((0, -0.45, 0.0)), Mf.to_3x3(), 0.8, 0.5, 0.26, 'silver', 'grey', lift=0.0, n=6)
    for x in (0.65, 1.15, 1.6):
        strut(b, K(x, -0.05, 3.12), Mf @ Vector((x - 1.15, -0.25, -0.12)), 0.035, a, 'brown')
    # a lamp still dangling from slab 2's edge
    lx, lz = -2.7, -2.04
    strut(b, K(lx, lz, 6.28), K(lx, lz, 5.62), 0.016, a, 'ink')
    b.cyl(0.2, 0.28, tuple(K(lx, lz, 5.48)), a, r2=0.05, seg=8, uv=SW('hotpink'))
    b.sphere(0.07, tuple(K(lx, lz, 5.33)), a, seg=6, rings=4, uv=SW('butter'))

    # ---- the walls left standing (holes cut through the wall + its wallpaper together) --------
    wb = C.MeshBuilder()
    holes = []
    # back wall: kit x -7..3.8, z -6..-5.6 (Blender y 5.6..6.0), top 11.2, broken off
    btop = jag_top(rng, 3.55, -7.0, 11.2, -0.55, 0.22, notches=((-3.6, 0.55), (1.9, 0.6)))
    bend = [(3.8, 3.3), (3.62, 4.2), (3.8, 5.2), (3.58, 6.3), (3.78, 7.5), (3.6, 8.7), (3.8, 9.8), (3.6, 10.6)]
    wall_x(wb, W, -7.0, 3.8, 5.6, 6.0, btop, end1=bend)
    # left wall: kit x -7..-6.6, z -6..1 (Blender y -1..6), top 8.4; slab 3 rests on its back part
    ltop = [(6.0, 9.58), (3.2, 9.58), (2.95, 9.05)] + jag_top(rng, 2.7, -0.8, 8.4, -0.45, 0.2)
    lend = [(-0.82, 7.4), (-1.0, 6.3), (-0.8, 5.1), (-1.0, 3.9), (-0.85, 2.6), (-1.0, 1.4), (-0.82, 0.6)]
    wall_y(wb, W, -1.0, 6.0, -7.0, -6.6, ltop, end0=lend)
    # wallpaper of the rooms that fell away (the cutters go through it too)
    bmin = min(h for x, h in btop)
    for x0, x1, y0, y1, sw in ((2.9, 3.55, 3.3, 6.58, 'seafoam'), (-1.5, 3.55, 6.62, 9.88, 'apricot'),
                               (-6.6, 3.5, 9.92, bmin - 0.12, 'sky')):
        kbox(wb, x0, x1, -5.592, -5.582, y0, y1, a, uv=SW(sw))
        kbox(wb, x0, x1, -5.6, -5.57, y0, y0 + 0.12, a, uv=SW('white'))
    lmin = min(h for y, h in ltop[3:])
    for y0, y1, h0, h1, sw in ((-0.78, 0.12, 0.0, 2.98, 'butter'), (-0.78, 2.12, 3.3, 6.28, 'blush'),
                               (-0.78, 3.32, 6.6, lmin - 0.12, 'lavender')):
        kbox(wb, -6.592, -6.582, -y1, -y0, h0, h1, a, uv=SW(sw))
        kbox(wb, -6.6, -6.57, -y1, -y0, h0, h0 + 0.12, a, uv=SW('white'))
    # (sills stop at the wall's face: inside it, their tops would share a plane with the holes' bottoms)
    for x, v, w, h in ((0.55, 8.3, 1.15, 1.4), (2.55, 8.3, 1.15, 1.4), (-1.7, 10.6, 1.15, 1.1)):
        holes.append(((w, 0.8, h), (x, 5.8, v)))
        kbox(b, x - w / 2 - 0.1, x + w / 2 + 0.1, -6.2, -6.0, v - h / 2 - 0.08, v - h / 2, a, uv=SW('white'))
    for y, v, w, h in ((0.5, 5.05, 1.1, 1.3), (1.6, 7.6, 1.1, 1.2)):
        holes.append(((0.8, w, h), (-6.8, y, v)))
        kbox(b, -7.2, -7.0, -(y + w / 2 + 0.1), -(y - w / 2 - 0.1), v - h / 2 - 0.08, v - h / 2, a, uv=SW('white'))
    cut_into(b, wb, holes, 'cloud')
    # a shutter hanging off one hinge by a hole
    b.box((0.5, 0.05, 1.3), (1.32 + 0.25, 6.08, 8.3), a, rot=(0, -24, 0), uv=SW('aqua'))
    for x0, dz in ((-4.1, 0.4), (-0.6, 0.5), (2.6, 0.35), (-2.5, 0.45)):
        h0 = top_at(btop, x0)
        strut(b, (x0, 5.8, h0 - 0.2), (x0 + rng.uniform(-0.15, 0.15), 5.8 + rng.uniform(-0.2, 0.1), h0 + dz), 0.035, a, 'brown')
    for y0 in (1.2, 0.1, 2.3):
        h0 = top_at(ltop, y0)
        strut(b, (-6.8, y0, h0 - 0.2), (-6.8 + rng.uniform(-0.1, 0.2), y0 + rng.uniform(-0.15, 0.15), h0 + 0.4), 0.035, a, 'brown')

    # ---- outside: windows where rooms still stand ---------------------------------------------
    for u, v in ((-5.0, 1.75), (-1.7, 1.75), (1.6, 1.75), (-5.0, 5.05), (-1.7, 5.05), (1.6, 5.05),
                 (-5.0, 8.35), (-2.9, 8.35)):
        win(b, '+Y', *FU('+Y', 6.0, u), v, 1.25, 1.35, pick())
    win(b, '+Y', *FU('+Y', 5.95, 5.4), 1.75, 1.25, 1.35, pick())
    for zk in (-1.6, -4.4):
        win(b, '+X', *FU('+X', 7.0, -zk), 1.75, 1.25, 1.35, pick())
    for zk, v in ((-1.6, 1.75), (-4.4, 1.75), (-4.4, 5.05), (-4.6, 8.35)):
        win(b, '-X', *FU('-X', -7.0, -zk), v, 1.25, 1.35, pick())
    b.decal('+Y', 6.0, -3.3, 1.6, 0.75, 1.0, 'poster_wanted', m=a)

    # ---- inside: the papered party walls the front rooms left behind ---------------------------
    # ground storey front wall (kit z -0.12): yellow paper over a checker tile dado, a door
    paper(b, '-Y', 0.12, -6.6, 6.95, 0.0, 2.98, 'butter')
    paper(b, '-Y', 0.12, -6.6, 6.95, 0.0, 0.907, 'white', off=0.016)   # up to the checker band, on its plane
    for k in range(7):
        x0 = -6.6 + k * 1.93
        b.decal('-Y', -0.12, -(x0 + 0.965), 1.1, 1.93, 0.386, 'car_checker', m=a, off=0.016)
    door(b, '-Y', *FU('-Y', 0.12, 4.6), 1.1, 2.2, 'door_wood')
    framed(b, '-Y', 0.12, -3.0, 2.0, 0.6, 0.8, 'poster_lost_sandwich')
    b.cyl(0.26, 0.06, tuple(K(-0.6, -0.08, 2.35)), a, axis='Y', seg=10, uv=SW('ink'))
    b.cyl(0.21, 0.05, tuple(K(-0.6, -0.06, 2.35)), a, axis='Y', seg=10, uv=SW('white'))
    strut(b, K(-0.6, -0.03, 2.35), K(-0.6, -0.03, 2.5), 0.025, a, 'ink')
    strut(b, K(-0.6, -0.03, 2.35), K(-0.5, -0.03, 2.35), 0.025, a, 'ink')
    # storey 2: front wall (kit z -2.12) pink with stripes + a door to nowhere, side wall (x 2.88)
    paper(b, '-Y', 2.12, -6.6, 2.88, 3.42, 6.28, 'blush')
    for k in range(17):
        paper(b, '-Y', 2.12, -6.35 + k * 0.55, -6.23 + k * 0.55, 3.42, 6.28, 'rose', off=0.016)
    kbox(b, -6.6, 2.88, -2.16, -2.11, 3.3, 3.42, a, uv=SW('white'))   # (behind the door's picture, 2 cm out)
    door(b, '-Y', *FU('-Y', 2.12, -4.9), 1.1, 2.2, 'door_blue', z0=3.3)
    framed(b, '-Y', 2.12, -1.5, 5.0, 0.7, 0.7, 'graffiti_heart', tilt=-7)
    framed(b, '-Y', 2.12, 1.3, 4.9, 0.6, 0.8, 'poster_donut_day', tilt=4)
    paper(b, '+X', 2.88, 2.12, 5.6, 3.3, 6.28, 'seafoam')
    kbox(b, 2.86, 2.92, -5.6, -2.12, 3.3, 3.42, a, uv=SW('white'))
    framed(b, '+X', 2.88, 3.9, 5.0, 0.6, 0.6, 'graffiti_crown', tilt=6)
    # storey 3: front wall (kit z -3.32) lavender with stripes + a mirror, side wall (x -1.52)
    paper(b, '-Y', 3.32, -6.6, -1.52, 6.6, 9.58, 'lavender')
    for k in range(9):
        paper(b, '-Y', 3.32, -6.35 + k * 0.55, -6.23 + k * 0.55, 6.72, 9.58, 'lilac', off=0.016)
    kbox(b, -6.6, -1.52, -3.36, -3.3, 6.6, 6.72, a, uv=SW('white'))
    framed(b, '-Y', 3.32, -4.2, 8.2, 0.7, 0.9, _sw_rect('glass'), frame='white')
    framed(b, '-Y', 3.32, -2.4, 8.1, 0.6, 0.8, 'poster_vote_bandit', tilt=-5)
    paper(b, '+X', -1.52, 3.32, 5.6, 6.6, 9.58, 'apricot')
    kbox(b, -1.54, -1.48, -5.6, -3.32, 6.6, 6.72, a, uv=SW('white'))
    framed(b, '+X', -1.52, 4.5, 8.2, 0.6, 0.8, 'poster_yard_sale', tilt=-3)
    # what's left of the floors: a rug, bathroom tiles, floorboards (over the cracks, not level with them)
    flat_poly(b, [K(-5.3, -1.75, 3.309), K(-2.4, -1.75, 3.309), K(-2.4, -0.45, 3.309), K(-5.3, -0.45, 3.309)],
              (0, 0, 1), 'hotpink')
    flat_poly(b, [K(-5.1, -1.6, 3.314), K(-2.6, -1.6, 3.314), K(-2.6, -0.6, 3.314), K(-5.1, -0.6, 3.314)],
              (0, 0, 1), 'pink')
    for k in range(2):
        for zc in (-2.36, -2.84):
            b.quad(tuple(K(-6.5 + k * 2.4 + 1.2, zc, 6.609)), (1, 0, 0), (0, 1, 0), 2.4, 0.48, a, cell='car_checker')
    flat_poly(b, [K(-6.2, -5.5, 9.909), K(-2.2, -5.5, 9.909), K(-2.2, -3.6, 9.909), K(-6.2, -3.6, 9.909)],
              (0, 0, 1), 'teal')

    # ---- the fridge (kit box x 3.45..4.95, z -5.1..-3.7, top 4.5), lying on its back -----------
    kbox(b, 3.47, 4.93, -5.08, -3.72, 3.3, 4.47, a, uv=SW('mint'), r=0.14, seg=1)
    kbox(b, 4.38, 4.42, -5.0, -3.8, 4.4, 4.485, a, uv=SW('seafoam'))
    kbox(b, 3.62, 4.28, -3.9, -3.82, 4.44, 4.51, a, uv=SW('chrome'))
    kbox(b, 4.52, 4.82, -3.9, -3.82, 4.44, 4.51, a, uv=SW('chrome'))
    for (x, z, sw) in ((3.8, -4.6, 'red'), (4.1, -4.9, 'yellow'), (3.95, -4.2, 'blue'), (4.65, -4.45, 'hotpink')):
        flat_poly(b, [K(x - 0.05, z - 0.05, 4.474), K(x + 0.05, z - 0.05, 4.474), K(x + 0.05, z + 0.05, 4.474),
                      K(x - 0.05, z + 0.05, 4.474)], (0, 0, 1), sw)
    b.decal('-X', -3.47, 4.4, 3.88, 1.0, 0.6, _sw_rect('charcoal'), m=a, off=0.005)

    # ---- the dresser (kit box x 1.2..2.6, z -5.5..-4.3, top 7.8) -------------------------------
    kbox(b, 1.26, 2.54, -5.44, -4.36, 6.6, 7.72, a, uv=SW('wood'), r=0.04, seg=1, cull=('-Z',))
    kbox(b, 1.22, 2.58, -5.48, -4.32, 7.72, 7.8, a, uv=SW('brown'), r=0.02, seg=1)
    for row, v in enumerate((6.84, 7.18, 7.52)):
        for x in (1.58, 2.22):
            pull = 0.06 if (row, x) == (1, 2.22) else 0.0
            kbox(b, x - 0.28, x + 0.28, -4.37, -4.335 + pull, v - 0.14, v + 0.14, a, uv=SW('tan'), cull=('+Y',))
            flat_poly(b, [K(x - 0.045, -4.33 + pull, v - 0.03), K(x + 0.045, -4.33 + pull, v - 0.03),
                          K(x + 0.045, -4.33 + pull, v + 0.03), K(x - 0.045, -4.33 + pull, v + 0.03)], (0, -1, 0), 'brass')
    strut(b, K(2.3, -4.31, 7.3), K(2.34, -4.3, 6.98), 0.07, a, 'red', t=0.02)          # a sock
    strut(b, K(2.34, -4.3, 6.98), K(2.46, -4.3, 6.93), 0.07, a, 'white', t=0.02)

    # ---- rubble heap out front (kit box x 2..5, z 1.2..3.4, top 1.2) ---------------------------
    def heap_h(x, z):
        dx = max(2.0 - 0.1 - x, x - 5.0 - 0.1, 0.0)
        dz = max(1.2 - 0.1 - z, z - 3.4 - 0.1, 0.0)
        d = math.hypot(dx, dz)
        if d <= 0.0:
            return 1.2 + rng.uniform(-0.06, 0.05)
        t = min(1.0, d / 0.95)
        return max(-0.02, 1.2 * (1 - t) ** 1.6 + rng.uniform(-0.08, 0.08) * (1 - t))
    hx = [1.0, 1.45, 1.9] + [2.0 + 3.0 * i / 6 for i in range(1, 6)] + [5.1, 5.55, 6.0]
    hz = [0.2, 0.65, 1.1] + [1.2 + 2.2 * j / 4 for j in range(1, 4)] + [3.5, 3.95, 4.4]
    P = [[K(x, z, heap_h(x, z)) for x in hx] for z in hz]
    grid(b, P, a, patchy(P, 0.7, alt='tan', alt2='silver'), (0, 0, 1))
    for _ in range(10):
        ang = rng.uniform(0, 2 * math.pi)
        ex, ez = math.cos(ang), math.sin(ang)
        x, z = 3.5 + ex * rng.uniform(1.55, 1.85), 2.3 + ez * rng.uniform(1.15, 1.45)
        s = rng.uniform(0.3, 0.55)
        chunk(b, rng, K(x, z, heap_h(x, z) * 0.8), (s * 1.3, s, s * 0.55), wpick(rng, CHUNKS), tilt=30)
    litter(b, rng, [(rng.uniform(2.15, 4.85), rng.uniform(1.35, 3.25)) for _ in range(12)], lambda x, z: 1.2,
           Matrix.Identity(3))
    # a toilet that came down with it, half buried in the heap's flank
    Mt = Matrix.Translation(K(5.62, 2.6, 0.28)) @ Matrix.Rotation(math.radians(-18), 4, 'Y') @ Matrix.Rotation(math.radians(30), 4, 'Z')
    b.cyl(0.2, 0.36, (0, 0, 0.18), a, r2=0.26, seg=10, matrix=Mt, uv=SW('white'))
    b.torus(0.21, 0.05, (0, 0, 0.38), a, seg=8, rseg=3, matrix=Mt, uv=SW('cloud'))
    b.box((0.5, 0.2, 0.42), (0, 0.3, 0.55), a, matrix=Mt, uv=SW('white'))
    # bricks and planks strewn about the front yard
    for _ in range(9):
        x, z = rng.uniform(-6.5, 6.5), rng.uniform(0.4, 5.6)
        if 1.4 < x < 5.7 and 0.5 < z < 4.1:
            continue
        chunk(b, rng, K(x, z, 0.06), (0.26, 0.13, 0.09), rng.choice(('terracotta', 'terracotta', 'grey')), tilt=12)
    for (x0, z0, x1, z1) in ((-4.8, 1.6, -2.9, 2.3), (-1.2, 3.9, 0.4, 3.2)):
        b.beam(K(x0, z0, 0.07), K(x1, z1, 0.1), 0.2, 0.05, a, uv=SW('wood'))
    for _ in range(4):
        x, z = rng.uniform(-6.0, 0.8), rng.uniform(0.5, 4.5)
        chunk(b, rng, K(x, z, 0.12), (rng.uniform(0.35, 0.6), rng.uniform(0.3, 0.45), 0.24), wpick(rng, CHUNKS), tilt=15)
    for cx, cz, rx, rz in ((-3.5, 1.8, 2.4, 1.2), (1.0, 3.6, 1.8, 1.0)):
        pts = [K(cx + math.cos(t) * rx * rng.uniform(0.75, 1.0), cz + math.sin(t) * rz * rng.uniform(0.75, 1.0), 0.07)
               for t in [2 * math.pi * k / 11 for k in range(11)]]
        flat_poly(b, pts, (0, 0, 1), 'sand')

    # ---- construction fence along the street (kit z 6.6, x -7.2..-2.0 and 2.0..7.2, 2 m) -------
    for x0, x1 in ((-7.2, -2.0), (2.0, 7.2)):
        xm = (x0 + x1) / 2
        for x in (x0, xm, x1):
            kbox(b, x - 0.11, x + 0.11, 6.25, 6.95, 0.0, 0.14, a, uv=SW('grey'), cull=('-Z',))
            kbox(b, x - 0.045, x + 0.045, 6.555, 6.645, 0.14, 2.0, a, uv=SW('silver'), cull=('-Z',))
        for sx0, sx1 in ((x0, xm), (xm, x1)):
            for y0, y1 in ((0.14, 0.2), (1.93, 1.99)):
                kbox(b, sx0 + 0.045, sx1 - 0.045, 6.57, 6.63, y0, y1, a, uv=SW('silver'), cull=('-X', '+X'))
            n = int(round((sx1 - sx0) / 0.42))
            for k in range(1, n):
                x = sx0 + k * (sx1 - sx0) / n
                kbox(b, x - 0.016, x + 0.016, 6.584, 6.616, 0.2, 1.93, a, uv=SW('silver'), cull=('-Z', '+Z'))
        # hazard-striped kick board on the street side
        kbox(b, x0 + 0.06, x1 - 0.06, 6.635, 6.665, 0.22, 0.56, a, uv=SW('yellow'))
        x = x0 + 0.12
        while x + 0.36 < x1 - 0.08:
            raw_faces(b, [K(x, 6.668, 0.22), K(x + 0.14, 6.668, 0.22), K(x + 0.34, 6.668, 0.56), K(x + 0.2, 6.668, 0.56)],
                      [[0, 1, 2, 3]], a, ['ink'])
            x += 0.4
        # BEWARE poster on a board, a NO RACCOONS sign
        pc = (x0 + xm) / 2
        kbox(b, pc - 0.46, pc + 0.46, 6.64, 6.67, 0.75, 1.95, a, uv=SW('white'))
        b.quad(tuple(K(pc, 6.675, 1.35)), (1, 0, 0), (0, 0, 1), 0.78, 1.04, a, cell='poster_beware')
        sc = (xm + x1) / 2
        kbox(b, sc - 0.62, sc + 0.62, 6.64, 6.67, 1.0, 1.62, a, uv=SW('charcoal'))
        b.quad(tuple(K(sc, 6.675, 1.31)), (1, 0, 0), (0, 0, 1), 1.16, 0.54, a, cell='sign_no_raccoons')
    return b.build('bld_demolished')


CRANE_TOP = 22.0               # the mast collider's top (kit Crane box at the mast)
CRANE_HOOK = (-11.1, 2.6)      # kit (x, z) of the trolley hook / the ball, from the mast base
CRANE_HOOK_Y = 22.4            # the hook's height under the trolley (the ball node's pivot)
CRANE_BALL = (12.05, 0.75)     # wrecking ball centre height, radius (its collider top is 12.8)


def build_crane():
    """Yellow tower crane (kit setpieces.demolition stands it at (9.6, -4); origin = the mast
    base).  Nodes: `crane` (footing + lattice mast, inside +-0.45 m), its child `jib` (the
    slewing top: turntable, cab, cat head, jib toward the hook, counter-jib + counterweight;
    pivot on the mast axis at the top, identity rest pose) and the jib's child `ball` (hoist
    ropes, hook block, wrecking ball; pivot at the trolley's hook, identity rest pose).  The
    game sways `jib` about Y and swings `ball`."""
    a = A()
    Y, D = 'yellow', 'charcoal'
    b = C.MeshBuilder()
    kbox(b, -0.9, 0.9, -0.9, 0.9, 0.0, 0.2, a, uv=SW('silver'), cull=('-Z',))
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.cyl(0.06, 0.1, tuple(K(sx * 0.66, sz * 0.66, 0.25)), a, seg=6, uv=SW('steel'))
    kbox(b, -0.44, 0.44, -0.44, 0.44, 0.2, 0.34, a, uv=SW(D), cull=('-Z',))
    h0, h1, c = 0.34, 21.8, 0.37
    corners = [(c, c), (-c, c), (-c, -c), (c, -c)]
    for x, z in corners:
        strut(b, K(x, z, h0), K(x, z, h1), 0.1, a, Y)
    n = 16
    for k in range(n):
        y0 = h0 + (h1 - h0) * k / n
        y1 = h0 + (h1 - h0) * (k + 1) / n
        for f in range(4):
            p, q = corners[f], corners[(f + 1) % 4]
            if k % 2:
                p, q = q, p
            strut(b, K(p[0], p[1], y0), K(q[0], q[1], y1), 0.05, a, Y)
            if k % 2 == 0:
                strut(b, K(p[0], p[1], y0), K(q[0], q[1], y0), 0.05, a, Y)
    for f in range(4):
        p, q = corners[f], corners[(f + 1) % 4]
        strut(b, K(p[0], p[1], h1), K(q[0], q[1], h1), 0.05, a, Y)
    kbox(b, -0.45, 0.45, -0.45, 0.45, h1, CRANE_TOP, a, uv=SW(D))
    root = b.build('crane')

    # ---- jib: everything that slews ----------------------------------------------------------
    u = Vector((CRANE_HOOK[0], -CRANE_HOOK[1], 0.0)).normalized()     # Blender plan, toward the hook
    v = Vector((-u.y, u.x, 0.0))                                       # its left (the street side)
    reach = math.hypot(*CRANE_HOOK)
    yaw = math.degrees(math.atan2(u.y, u.x))

    def at(s, l, h):
        return u * s + v * l + Vector((0.0, 0.0, h))
    J = C.MeshBuilder()
    J.cyl(0.6, 0.25, (0, 0, CRANE_TOP + 0.125), a, seg=16, uv=SW(D))
    J.box((2.0, 1.5, 0.4), (0, 0, 22.45), a, rot=(0, 0, yaw), r=0.05, seg=1, uv=SW(Y))
    # cat head: four legs up to the apex, pendants down to both jibs
    apex = at(0, 0, 26.2)
    for s in (-0.55, 0.55):
        for l in (-0.5, 0.5):
            strut(J, at(s, l, 22.65), apex, 0.12, a, Y)
    for s, l, s2, l2 in ((-0.55, -0.5, 0.55, 0.5), (0.55, -0.5, -0.55, 0.5)):
        strut(J, at(s * 0.55, l * 0.55, 24.2), at(s2 * 0.55, l2 * 0.55, 24.2), 0.05, a, Y)
    J.box((0.3, 0.3, 0.25), tuple(apex + Vector((0, 0, 0.1))), a, rot=(0, 0, yaw), uv=SW(Y))
    J.sphere(0.1, tuple(apex + Vector((0, 0, 0.32))), a, seg=8, rings=5, uv=SW('red'))
    for l in (-0.07, 0.07):
        strut(J, apex + v * l, at(8.6, l, 23.65), 0.04, a, D)
        strut(J, apex + v * l, at(-5.3, l * 6, 22.95), 0.04, a, D)
    # jib: two bottom chords, one top chord, Warren bracing, 13.2 m long
    s0, s1, zb, zt = 0.8, 14.0, 22.75, 23.65
    for l in (-0.42, 0.42):
        strut(J, at(s0, l, zb), at(s1, l, zb), 0.1, a, Y)
        strut(J, at(s0, l, 22.65), at(s0, 0, zt), 0.08, a, Y)
    strut(J, at(s0, 0, zt), at(s1 - 0.6, 0, zt), 0.1, a, Y)
    npan = 12
    for k in range(npan + 1):
        s = s0 + (s1 - 0.6 - s0) * k / npan
        strut(J, at(s, -0.42, zb), at(s, 0.42, zb), 0.05, a, Y)
        if k < npan:
            s2 = s0 + (s1 - 0.6 - s0) * (k + 1) / npan
            for l in (-0.42, 0.42):
                if k % 2:
                    strut(J, at(s, 0, zt), at(s2, l, zb), 0.05, a, Y)
                else:
                    strut(J, at(s, l, zb), at(s2, 0, zt), 0.05, a, Y)
    for l in (-0.42, 0.42):
        strut(J, at(s1 - 0.6, 0, zt), at(s1, l, zb), 0.06, a, Y)
    strut(J, at(s1, -0.42, zb), at(s1, 0.42, zb), 0.06, a, Y)
    J.sphere(0.08, tuple(at(s1 + 0.05, 0, zb + 0.12)), a, seg=8, rings=5, uv=SW('red'))
    # trolley at the hook
    J.box((0.8, 1.0, 0.2), tuple(at(reach, 0, 22.57)), a, rot=(0, 0, yaw), uv=SW(D))
    for l in (-0.12, 0.12):
        J.cyl(0.11, 0.06, tuple(at(reach, l, 22.45)), a, axis='X', rot=(0, 0, yaw + 90), seg=10, uv=SW('steel'))
    # counter-jib: walkway, rails, hoist winch, counterweight
    for l in (-0.5, 0.5):
        J.box((4.9, 0.14, 0.32), tuple(at(-3.25, l, 22.81)), a, rot=(0, 0, yaw), uv=SW(Y))
    J.box((4.9, 0.86, 0.06), tuple(at(-3.25, 0, 22.7)), a, rot=(0, 0, yaw), uv=SW('grey'))
    for l in (-0.56, 0.56):
        for s in (-1.0, -2.4, -3.8):
            strut(J, at(s, l, 22.95), at(s, l, 23.85), 0.04, a, Y)
        strut(J, at(-0.9, l, 23.82), at(-4.1, l, 23.82), 0.045, a, Y)
    J.cyl(0.3, 0.7, tuple(at(-2.0, 0, 23.1)), a, axis='X', rot=(0, 0, yaw + 90), seg=12, uv=SW(D))
    J.box((0.6, 0.5, 0.45), tuple(at(-2.7, 0.0, 23.0)), a, rot=(0, 0, yaw), uv=SW('grey'))
    for k, sw in enumerate(('silver', 'grey', 'silver')):
        J.box((0.9, 1.3, 0.58), tuple(at(-5.05, 0, 21.75 + k * 0.6)), a, rot=(0, 0, yaw), uv=SW(sw))
    J.quad(tuple(at(-5.05, 0.665, 22.35)), tuple(-u), (0, 0, 1), 0.86, 0.4, a, cell='graffiti_raccoons_rule')
    # cab on the street side of the jib heel, its operator peeking out
    cc = at(0.55, 1.15, 23.43)
    J.box((1.5, 1.3, 0.1), tuple(at(0.55, 1.1, 22.62)), a, rot=(0, 0, yaw), uv=SW(D))
    J.box((1.3, 1.1, 1.5), tuple(cc), a, rot=(0, 0, yaw), r=0.06, seg=1, uv=SW(Y))
    J.box((1.42, 1.22, 0.12), tuple(cc + Vector((0, 0, 0.8))), a, rot=(0, 0, yaw), r=0.03, uv=SW('white'))
    J.box((0.06, 0.9, 0.8), tuple(cc + u * 0.64 + Vector((0, 0, 0.2))), a, rot=(0, 0, yaw), uv=SW('glass'))
    J.box((0.9, 0.06, 0.8), tuple(cc + v * 0.54 + Vector((0, 0, 0.2))), a, rot=(0, 0, yaw), uv=SW('white'))
    J.quad(tuple(cc + v * 0.58 + Vector((0, 0, 0.2))), tuple(-u), (0, 0, 1), 0.8, 0.72, a, cell='window_raccoon')
    jib = J.build('jib', location=(0, 0, CRANE_TOP), parent=root)

    # ---- ball: hoist ropes, hook block, wrecking ball (swings under the trolley) ---------------
    hook = at(reach, 0, CRANE_HOOK_Y)
    bc = Vector((hook.x, hook.y, CRANE_BALL[0]))
    Bm = C.MeshBuilder()
    for l in (-0.1, 0.1):
        strut(Bm, hook + v * l, Vector((hook.x, hook.y, 14.81)) + v * l, 0.035, a, D)
    Bm.box((0.5, 0.36, 0.62), (hook.x, hook.y, 14.5), a, rot=(0, 0, yaw), r=0.05, seg=1, uv=SW(Y))
    Bm.cyl(0.2, 0.4, (hook.x, hook.y, 14.57), a, axis='X', rot=(0, 0, yaw + 90), seg=12, uv=SW(D))
    strut(Bm, (hook.x, hook.y, 14.19), (hook.x, hook.y, 14.0), 0.07, a, D)
    Bm.torus(0.12, 0.04, (hook.x, hook.y, 13.88), a, seg=12, rseg=5, rot=(90, 0, yaw), uv=SW(D))
    strut(Bm, (hook.x, hook.y, 13.76), (hook.x, hook.y, 12.9), 0.04, a, D)
    r = CRANE_BALL[1]
    Bm.sphere(r, tuple(bc), a, seg=18, rings=10, rot=(180, 0, 0), cut_below=-0.6, uv=SW('charcoal'))
    Bm.cyl(0.52, 0.16, (bc.x, bc.y, 12.72), a, seg=16, bevel=0.03, uv=SW('slate'))
    Bm.cyl(0.1, 0.12, (bc.x, bc.y, 12.86), a, seg=8, uv=SW('slate'))
    ball = Bm.build('ball', location=tuple(hook))
    ball.parent = jib
    ball.location = hook - Vector((0.0, 0.0, CRANE_TOP))
    return root


# ---------------------------------------------------------------- collapsed --

def build_bld_collapsed():
    """A building that slumped (kit setpieces.collapsed; at the set piece origin): its rubble
    mound IS the walkable ramp (0 at z 6.5 -> 4.97 at z -3, x -3.3..2.3), a flat rubble landing on
    top (x -1.2..5.6, z -4.6..-1.8, 4.97) runs onto the roof of the shop built beside it, and two
    wall stubs stand behind (back to 7.5, left to 6.0).  A fallen roof section lies along the
    mound, a chimney lies on its side (top 0.8) and a bathtub landed upside down (top 0.6)."""
    W = M_wall('#fffaf2', 'brick')
    R = M_roof('#f2706b', 'shingle')
    a = A()
    rng = C.seeded(7301)
    pick = Picker(7302)
    b = C.MeshBuilder()
    HI, Z0, Z1 = 4.97, 6.5, -3.0

    def ramp(z):
        return HI * min(1.0, max(0.0, (Z0 - z) / (Z0 - Z1)))

    # ---- the mound (= the ramp collider, x -3.3..2.3) ----------------------------------------
    core = [-3.3 + 5.6 * i / 6 for i in range(7)]
    xs = [(-4.05, 0.0), (-3.72, 0.32), (-3.48, 0.74)] + [(x, 1.0) for x in core] + [(2.48, 0.74), (2.72, 0.32), (3.05, 0.0)]
    zs = ([(7.0, None), (6.5, 1.0)] + [(6.5 - 9.5 * k / 12, 1.0) for k in range(1, 13)]
          + [(-3.18, 0.76), (-3.42, 0.32), (-3.72, 0.0)])
    P = []
    for z, fz in zs:
        row = []
        for x, fx in xs:
            if fz is None or fx == 0.0 or fz == 0.0:
                row.append(K(x + rng.uniform(-0.08, 0.08), z + rng.uniform(-0.05, 0.05), -0.02))
                continue
            f = fx * fz
            base = ramp(min(z, 6.5)) * f
            if f >= 1.0:
                h = base + rng.uniform(-0.06, 0.05)
                dx = 0.0
            else:
                h = base + rng.uniform(-0.15, 0.12)
                dx = rng.uniform(-0.07, 0.07)
            row.append(K(x + dx, z, max(-0.02, h)))
        P.append(row)
    flank = (('terracotta', 4), ('grey', 4), ('sand', 2), ('cream', 1), ('brown', 1))
    grid(b, P, a, patchy(P, 0.2, alt='tan', alt2='cream'), (0, 0, 1))
    # what the slide left lying on it: bricks, concrete plates, planks, scraps of wallpaper
    Rs = Matrix.Rotation(math.atan2(HI, Z0 - Z1), 3, 'X')
    spots = []
    while len(spots) < 18:
        x, z = rng.uniform(-3.0, 2.0), rng.uniform(-2.6, 6.1)
        if not (x < -0.9 and 0.1 < z < 4.15):          # not under the fallen roof
            spots.append((x, z))
    litter(b, rng, spots, lambda x, z: ramp(z), Rs)
    # chunks and broken slab pieces along the mound's sides (never in the middle)
    for k in range(10):
        side = (-1, 1)[k % 2]
        z = rng.uniform(-1.5, 6.0)
        x = rng.uniform(-3.78, -3.38) if side < 0 else rng.uniform(2.38, 2.78)
        s = rng.uniform(0.3, 0.6)
        chunk(b, rng, K(x, z, ramp(z) * 0.62 + 0.05), (s * 1.3, s, s * 0.6), wpick(rng, flank))
    for x, z, ang, sw in ((-3.55, 2.6, (0, 62, 20), 'silver'), (2.55, -0.4, (0, -58, -10), 'grey'),
                          (2.5, 3.6, (10, -66, 15), 'silver')):
        hgt = ramp(z) * 0.8
        b.box((1.3, 0.9, 0.16), tuple(K(x, z, hgt)), a, rot=ang, uv=SW(sw))
        rebar(b, rng, [(x, z)], (1.0 if x > 0 else -1.0, 0.0), hgt + 0.3, p=1.0)
    for _ in range(6):
        x, z = rng.uniform(-3.0, 2.0), rng.uniform(6.55, 7.4)
        chunk(b, rng, K(x, z, 0.08), (0.3, 0.16, 0.12), wpick(rng, flank), tilt=15)
    for cx, cz, rx, rz in ((-0.5, 7.2, 3.2, 0.7), (3.4, 5.6, 1.4, 0.8)):
        pts = [K(cx + math.cos(t) * rx * rng.uniform(0.75, 1.0), cz + math.sin(t) * rz * rng.uniform(0.75, 1.0), 0.07)
               for t in [2 * math.pi * k / 11 for k in range(11)]]
        flat_poly(b, pts, (0, 0, 1), 'sand')

    # ---- the landing: flat rubble at 4.97 on the pancaked floors ------------------------------
    lx = [-1.2 + 6.82 * i / 7 for i in range(8)]
    lz = [-4.62 + 2.82 * j / 5 for j in range(6)]
    P = []
    for j, z in enumerate(lz):
        row = []
        for i, x in enumerate(lx):
            edge = i in (0, len(lx) - 1) or j in (0, len(lz) - 1)
            row.append(K(x, z, HI - 0.02 if edge else HI + rng.uniform(-0.05, 0.04)))
        P.append(row)
    grid(b, P, a, patchy(P, 1.3, alt='tan', alt2='cream'), (0, 0, 1))
    litter(b, rng, [(rng.uniform(-0.9, 5.3), rng.uniform(-4.3, -2.1)) for _ in range(7)], lambda x, z: HI,
           Matrix.Identity(3))
    # its faces: the floors pancaked into layers (crushed walls between slab edges)
    layers = [0.0, 0.7, 1.35, 1.65, 2.35, 3.05, 3.35, 4.1, 4.62, HI - 0.02]
    band = [('terracotta', 'sand'), ('sand', 'grey'), ('silver',), ('sand', 'blush', 'terracotta'),
            ('sand', 'cream', 'terracotta'), ('silver',), ('sand', 'butter', 'terracotta'), ('terracotta', 'sand'),
            ('silver',)]

    def cliff(p0, p1, out, y0, nu, bulge=True):
        o = Vector((out[0], -out[1], 0.0))
        rows = []
        for y in layers:
            if y < y0 - 0.01:
                continue
            row = []
            for i in range(nu + 1):
                t = i / nu
                q = K(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, y)
                lump = 0.0 if i in (0, nu) or y > HI - 0.1 or not bulge else rng.uniform(0.0, 0.14)
                row.append(q + o * lump)
            rows.append(row)
        nb = len(layers) - len(rows)

        def sw(i, j):
            opts = band[j + nb]
            return opts[0] if len(opts) == 1 or rng.random() < 0.5 else rng.choice(opts[1:])
        grid(b, rows, a, sw, o)
    cliff((2.1, -1.8), (5.62, -1.8), (0, 1), 0.0, 6)
    cliff((-1.2, -1.8), (2.1, -1.8), (0, 1), 4.1, 5, bulge=False)   # the step up from the ramp
    cliff((-1.2, -4.55), (-1.2, -1.8), (-1, 0), 0.0, 4)
    cliff((5.62, -4.62), (3.9, -4.62), (0, -1), 0.0, 2)
    cliff((5.62, -1.8), (5.62, -4.62), (1, 0), 0.0, 1)
    for y in (1.35, 3.05, 4.62):       # slab edges sticking out of the front face
        for x0, x1 in ((2.15, 3.4), (3.5, 4.6), (4.7, 5.6)):
            dz = rng.uniform(0.08, 0.26)
            b.box((x1 - x0, 0.5, 0.3), tuple(K((x0 + x1) / 2, -1.95 + dz, y + 0.15)), a,
                  rot=(rng.uniform(-3, 3), rng.uniform(-4, 4), rng.uniform(-3, 3)), uv=SW('silver'))
        rebar(b, rng, [(rng.uniform(2.4, 5.4), -1.8 + 0.2)], (0, 1), y + 0.2, p=1.0)

    # ---- the wall stubs (holes cut through each wall and its wallpaper) ------------------------
    wb = C.MeshBuilder()
    holes = []
    btop = jag_top(rng, 4.0, -6.0, 7.5, -0.6, 0.25, notches=((1.4, 0.6),))
    bend = [(4.0, 5.0), (3.82, 5.6), (4.0, 6.2), (3.84, 6.7)]
    wall_x(wb, W, -6.0, 4.0, 4.55, 5.05, btop, end1=bend)
    ltop = jag_top(rng, 5.0, -2.9, 6.0, -0.45, 0.28)
    lend = [(-2.9, 5.2), (-3.0, 4.2), (-2.8, 3.1), (-3.0, 2.0), (-2.82, 1.0)]
    wall_y(wb, W, -3.0, 5.0, -6.05, -5.55, ltop, end0=lend)
    bmin, lmin = min(h for x, h in btop), min(h for y, h in ltop)
    for x0, x1, y0, y1, sw in ((-5.5, -1.25, 0.0, 3.2, 'mint'), (-5.5, 3.8, 3.4, min(6.5, bmin - 0.12), 'blush')):
        kbox(wb, x0, x1, -4.542, -4.532, y0, y1, a, uv=SW(sw))
        kbox(wb, x0, x1, -4.55, -4.52, y0, y0 + 0.12, a, uv=SW('white'))
    for y0, y1, h0, h1, sw in ((-2.75, 4.5, 0.0, 3.2, 'mint'), (-2.75, 4.5, 3.4, lmin - 0.12, 'blush')):
        kbox(wb, -5.542, -5.532, -y1, -y0, h0, h1, a, uv=SW(sw))
        kbox(wb, -5.55, -5.52, -y1, -y0, h0, h0 + 0.12, a, uv=SW('white'))
    for x, v, w, h in ((-4.3, 1.75, 1.1, 1.35), (-2.3, 1.75, 1.1, 1.35), (-4.3, 5.0, 1.1, 1.3),
                       (-2.3, 5.0, 1.1, 1.3), (0.9, 5.45, 1.1, 1.2), (2.9, 5.45, 1.1, 1.2)):
        holes.append(((w, 0.9, h), (x, 4.8, v)))
        kbox(b, x - w / 2 - 0.1, x + w / 2 + 0.1, -5.25, -5.05, v - h / 2 - 0.08, v - h / 2, a, uv=SW('white'))
    for y, v in ((0.8, 4.95), (3.2, 4.95)):
        holes.append(((0.9, 1.1, 1.3), (-5.8, y, v)))
        kbox(b, -6.25, -6.05, -(y + 0.65), -(y - 0.65), v - 0.73, v - 0.65, a, uv=SW('white'))
    cut_into(b, wb, holes, 'cloud')
    for u, v in ((0.9, 1.75), (2.9, 1.75)):
        win(b, '+Y', *FU('+Y', 5.05, u), v, 1.1, 1.35, pick())
    for y, v in ((3.2, 1.75), (-1.6, 1.75), (-1.6, 4.95), (0.8, 1.75)):
        win(b, '-X', *FU('-X', -6.05, y), v, 1.1, 1.3, pick())
    kbox(b, -6.0, 4.0, -5.13, -5.03, 3.22, 3.38, a, uv=SW('white'), cull=('-Y',))
    kbox(b, -6.13, -6.03, -4.95, 2.85, 3.22, 3.38, a, uv=SW('white'), cull=('+X',))
    framed(b, '+X', -5.55, 1.9, 2.0, 0.6, 0.8, 'poster_yard_sale', tilt=9)
    framed(b, '-Y', 4.55, -3.3, 2.0, 0.66, 0.66, 'graffiti_crown', tilt=-6)
    for x0 in (-4.4, -1.0, 2.3):
        h0 = top_at(btop, x0)
        strut(b, (x0, 4.8, h0 - 0.2), (x0 + rng.uniform(-0.15, 0.15), 4.8 + rng.uniform(-0.2, 0.1), h0 + 0.45), 0.035, a, 'brown')

    # ---- a section of the pitched roof slid down the mound's left edge -----------------------
    rz0, rz1, rxr = 4.0, 0.2, -3.32
    o = K(rxr, rz0, ramp(rz0) + 0.07)
    s_vec = K(rxr, rz1, ramp(rz1) + 0.07) - o
    sh = s_vec.normalized()
    wA = Vector((2.2, 0.0, 0.0))
    nA = wA.normalized().cross(sh)
    hexa(b, o, s_vec, wA, -nA * 0.12, R, uv=('planar', tuple(o), tuple(sh), (-1, 0, 0), 2.0, 2.0))
    d = Vector((-0.5, 0.0, -0.866))
    wB = (d - sh * d.dot(sh)).normalized() * 1.25
    nB = sh.cross(wB.normalized())
    hexa(b, o, s_vec, wB, -nB * 0.12, R, uv=('planar', tuple(o), tuple(sh), tuple(-wB.normalized()), 2.0, 2.0))
    b.beam(o - sh * 0.05 + Vector((0, 0, 0.04)), o + s_vec + sh * 0.05 + Vector((0, 0, 0.04)), 0.2, 0.2, a, uv=SW('coral'))
    for k in range(3):
        p = o + s_vec + wA * (0.2 + 0.35 * k) - nA * 0.08
        strut(b, p, p + sh * rng.uniform(0.25, 0.55) - nA * 0.05, 0.08, a, 'wood')

    # ---- the chimney on its side (kit box x 3.4..5.2, z 3.6..5.0, top 0.8) --------------------
    kbox(b, 3.5, 5.1, 3.75, 4.43, 0.0, 0.68, a, uv=SW('terracotta'), cull=('-Z',))
    for x in (3.92, 4.38, 4.84):
        kbox(b, x - 0.025, x + 0.025, 3.73, 4.45, 0.0, 0.7, a, uv=SW('cream'), cull=('-Z',))
    kbox(b, 5.1, 5.24, 3.66, 4.52, 0.0, 0.79, a, uv=SW('silver'), cull=('-Z',))
    for z in (3.93, 4.25):
        b.cyl(0.11, 0.3, tuple(K(5.39, z, 0.42)), a, axis='X', seg=8, uv=SW('terracotta'))
    def brick_h(x, z):
        inside = 3.42 < x < 5.25 and z < 5.06
        return 0.72 + rng.uniform(-0.05, 0.04) if inside else max(-0.02, 0.25 * rng.random())
    bx = [3.28, 3.45, 3.9, 4.35, 4.8, 5.22, 5.42]
    bz = [4.42, 4.6, 4.82, 5.04, 5.32]
    P = [[K(x, z, brick_h(x, z)) for x in bx] for z in bz]
    grid(b, P, a, patchy(P, 2.1, base='terracotta', alt='sand', alt2='grey'), (0, 0, 1))

    # ---- the bathtub, upside down (kit box x -5.0..-3.8, z 4.1..5.1, top 0.6), and its duck ---
    kbox(b, -4.97, -3.83, 4.2, 5.0, 0.04, 0.56, a, uv=SW('white'), r=0.13, seg=1)
    kbox(b, -5.0, -3.8, 4.17, 5.03, 0.0, 0.07, a, uv=SW('cloud'), r=0.03, seg=1)
    for x in (-4.8, -4.0):
        for z in (4.34, 4.86):
            b.cyl(0.075, 0.12, tuple(K(x, z, 0.62)), a, r2=0.045, seg=6, uv=SW('gold'))
    b.cyl(0.06, 0.012, tuple(K(-4.62, 4.6, 0.562)), a, seg=8, uv=SW('chrome'))
    b.sphere(0.12, tuple(K(-3.5, 5.45, 0.1)), a, seg=8, rings=5, scale=(1.2, 1, 0.8), uv=SW('yellow'))
    b.sphere(0.075, tuple(K(-3.42, 5.45, 0.24)), a, seg=8, rings=5, uv=SW('yellow'))
    b.cyl(0.03, 0.08, tuple(K(-3.33, 5.45, 0.23)), a, axis='X', r2=0.005, seg=6, uv=SW('orange'))
    return b.build('bld_collapsed')


# ---------------------------------------------------------------- burnt shell --

def build_bld_shell():
    """A burnt-out shop (kit setpieces.shell; at the set piece origin): 12 x 10 m, no roof, walls
    0.4 thick and 4.2 tall with charred broken tops (a door gap in the front, the back left
    corner burnt through), a corner of the upper floor still hanging at the back left (3.0..3.3)
    reached by a broken slab leaning up to it, charred roof beams across the top, and debris
    inside (tops 0.9 and 0.6; (2.6, 0.6) stays clear for a trash can).  The walls are the tinted
    'Wall' (the game tints this one dark grey)."""
    W = M_wall('#fffaf2', 'brick')
    a = A()
    rng = C.seeded(7401)
    b = C.MeshBuilder()
    wb = C.MeshBuilder()
    H = 4.2
    beams = ((1.6, 4.34), (-1.9, 4.34))      # Blender y of the two beams, the height they rest at
    # front (kit z 4.6..5.0 = Blender y -5.0..-4.6) either side of the door gap
    tfl = jag_top(rng, -1.5, -6.0, H, -0.45, 0.2, step=(0.45, 1.1))
    wall_x(wb, W, -6.0, -1.5, -5.0, -4.6, tfl, end1=[(-1.62, 1.0), (-1.5, 1.9), (-1.7, 2.8), (-1.56, 3.5)])
    tfr = jag_top(rng, 6.0, 1.5, H, -0.45, 0.2, step=(0.45, 1.1))
    wall_x(wb, W, 1.5, 6.0, -5.0, -4.6, tfr, end0=[(1.66, 3.5), (1.5, 2.7), (1.72, 1.7), (1.55, 0.8)])
    # back (kit z -5.0..-4.6), x -4..6: the corner beyond it burnt through
    tbk = jag_top(rng, 6.0, -4.0, H, -0.5, 0.2, step=(0.45, 1.1))
    wall_x(wb, W, -4.0, 6.0, 4.6, 5.0, tbk, end0=[(-3.8, 3.3), (-4.0, 2.5), (-3.78, 1.6), (-3.95, 0.8)])
    # sides, full length; the beams rest on their tops
    tl = jag_top(rng, 5.0, -5.0, H, -0.45, 0.2, step=(0.45, 1.1), keep=beams)
    wall_y(wb, W, -5.0, 5.0, -6.0, -5.6, tl)
    tr = jag_top(rng, 5.0, -5.0, H, -0.45, 0.2, step=(0.45, 1.1), keep=beams)
    wall_y(wb, W, -5.0, 5.0, 5.6, 6.0, tr)
    holes = [((2.4, 0.8, 1.7), (-3.75, -4.8, 1.75)), ((2.4, 0.8, 1.7), (3.75, -4.8, 1.75)),
             ((0.8, 1.4, 1.3), (-5.8, 2.5, 1.85)), ((0.8, 1.4, 1.3), (-5.8, -2.0, 1.85)),
             ((0.8, 1.4, 1.3), (5.8, 2.5, 1.85)), ((0.8, 1.4, 1.3), (5.8, -2.0, 1.85)),
             ((1.3, 0.8, 1.2), (1.8, 4.8, 1.9)), ((1.0, 0.8, 2.25), (4.5, 4.8, 1.075))]
    cut_into(b, wb, holes, 'charcoal')
    # soot: tongues above every opening (outside and in), charred bands under the broken tops
    for (sx, sy, sz), (x, y, v) in holes:
        top = v + sz / 2
        hgt = min(1.3, 3.62 - top)
        if sy < sx:      # in a wall along X
            for face, plane in (('-Y', y - 0.2), ('+Y', y + 0.2)):
                soot(b, rng, face, plane, x, top - 0.05, sx * 0.9, hgt * rng.uniform(0.8, 1.0))
        else:
            for face, plane in (('-X', x - 0.2), ('+X', x + 0.2)):
                soot(b, rng, face, plane, y, top - 0.05, sy * 0.9, hgt * rng.uniform(0.8, 1.0))
    for top, face_planes in ((tfl, (('-Y', -5.0), ('+Y', -4.6))), (tfr, (('-Y', -5.0), ('+Y', -4.6))),
                             (tbk, (('+Y', 5.0), ('-Y', 4.6))), (tl, (('-X', -6.0), ('+X', -5.6))),
                             (tr, (('+X', 6.0), ('-X', 5.6)))):
        for face, plane in face_planes:
            soot_band(b, rng, face, plane, top)
    # charred floor + ash
    flat_poly(b, [K(-5.62, -4.62, 0.065), K(5.62, -4.62, 0.065), K(5.62, 4.62, 0.065), K(-5.62, 4.62, 0.065)],
              (0, 0, 1), 'charcoal')
    for cx, cz, rx, rz, sw in ((0.3, -2.8, 2.2, 1.3, 'slate'), (-2.4, 2.9, 1.6, 1.1, 'grey'),
                               (4.2, -0.6, 1.1, 1.6, 'slate'), (-0.8, 0.6, 1.0, 0.7, 'ink')):
        pts = [K(cx + math.cos(t) * rx * rng.uniform(0.7, 1.0), cz + math.sin(t) * rz * rng.uniform(0.7, 1.0), 0.07)
               for t in [2 * math.pi * k / 10 for k in range(10)]]
        flat_poly(b, pts, (0, 0, 1), sw)
    for _ in range(6):
        x, z = rng.uniform(-5.0, 5.0), rng.uniform(-4.0, 4.0)
        if math.hypot(x - 2.6, z - 0.6) < 1.0 or (-4.9 < x < -2.7 and -1.0 < z < 3.6):
            continue
        b.sphere(rng.uniform(0.25, 0.45), tuple(K(x, z, 0.04)), a, seg=7, rings=4, scale=(1.3, 1.0, 0.3),
                 rot=(0, 0, rng.uniform(0, 180)), cut_below=0.0, uv=SW('slate'))

    # ---- the corner of the upper floor still hanging (kit x -5.8..-1.8, z -4.8..-0.8) ---------
    rr = jag_edge(rng, (-1.8, -4.75), (-1.8, -0.8), (1.0, 0.0), lo=-0.04, hi=0.3)
    ff = jag_edge(rng, (-1.8, -0.8), (-5.75, -0.8), (0.0, 1.0), lo=-0.04, hi=0.3)
    poly = [(-5.75, -4.75), (-1.75, -4.75)] + rr + [(-1.62, -0.62)] + ff + [(-5.75, -0.7)]
    prism(b, [(x, -z) for x, z in poly], 3.0, 3.3, a, 'brown', 'ink', 'chocolate')
    for k in range(9):
        z = -4.55 + 0.42 * k
        flat_strip(b, [(-5.55, z), (-2.0, z)], 3.304, 0.035, 'chocolate')
    for z in (-1.25, -2.6, -3.95):
        kbox(b, -5.6, -1.5, z - 0.07, z + 0.07, 2.78, 3.0, a, uv=SW('ink'))
    rebar(b, rng, rr[::2], (1, 0), 3.15, p=0.6)

    # ---- the slab leaning up to it (kit ramp x -4.7..-2.9, z 3.4 (0) -> -0.8 (3.3)) ------------
    o = K(-4.7, 3.4, 0.0)
    M, _ = frame(o, K(-4.7, -0.8, 3.3) - o, (1.0, 0.0, 0.0))
    L = (K(-4.7, -0.8, 3.3) - o).length
    left = jag_edge(rng, (0.0, L), (0.0, 0.0), (-1.0, 0.0), lo=-0.03, hi=0.12)
    right = jag_edge(rng, (1.8, 0.0), (1.8, L), (1.0, 0.0), lo=-0.03, hi=0.12)
    prism(b, [(0.0, -0.12), (1.8, -0.12)] + right + [(1.8, L + 0.03), (0.0, L + 0.03)] + left,
          -0.24, 0.0, a, 'grey', 'slate', 'slate', matrix=M)
    for (w0, s0, rw, rs) in ((0.5, 1.2, 0.5, 0.9), (1.3, 3.6, 0.45, 1.1), (0.9, 4.7, 0.6, 0.5)):
        pts = [M @ Vector((w0 + math.cos(t) * rw * rng.uniform(0.6, 1.0), s0 + math.sin(t) * rs * rng.uniform(0.6, 1.0), 0.005))
               for t in [2 * math.pi * k / 8 for k in range(8)]]
        flat_poly(b, pts, M.to_3x3() @ Vector((0, 0, 1)), 'charcoal')
    for edge, out in ((left, (-1.0, 0.0)), (right, (1.0, 0.0))):
        for (w, s) in edge[1::2]:
            p0 = M @ Vector((w - out[0] * 0.08, s, -0.12))
            strut(b, p0, p0 + M.to_3x3() @ Vector((out[0] * rng.uniform(0.2, 0.4), rng.uniform(-0.1, 0.1), -0.08)),
                  0.03, a, 'brown')
    cr = [(0.1, 2.2), (0.6, 2.35), (1.0, 2.1), (1.4, 2.3), (1.75, 2.2)]
    for (w0, s0), (w1, s1) in zip(cr, cr[1:]):
        p, q = M @ Vector((w0, s0, 0.004)), M @ Vector((w1, s1, 0.004))
        dd = (q - p).normalized().cross(M.to_3x3() @ Vector((0, 0, 1))) * 0.025
        flat_poly(b, [p - dd, q - dd, q + dd, p + dd], M.to_3x3() @ Vector((0, 0, 1)), 'charcoal')
    for x, z, hgt in ((-4.3, 2.4, 0.3), (-3.3, 2.0, 0.45), (-3.9, 1.3, 0.7), (-3.2, 0.6, 0.9)):
        chunk(b, rng, K(x, z, hgt * 0.5), (0.7, 0.55, hgt), rng.choice(('grey', 'charcoal', 'slate')), tilt=12)

    # ---- debris: a burnt counter (kit x 1.7..3.3, z -2.6..-1.4, top 0.9) and a crate ----------
    kbox(b, 1.76, 3.24, -2.54, -1.46, 0.0, 0.82, a, uv=SW('chocolate'), cull=('-Z',))
    kbox(b, 1.68, 3.32, -2.62, -1.38, 0.82, 0.9, a, uv=SW('slate'), r=0.02, seg=1)
    flat_poly(b, [K(1.78, -1.45, 0.02), K(3.22, -1.45, 0.02), K(3.22, -1.45, 0.22), K(2.9, -1.45, 0.4),
                  K(2.55, -1.45, 0.26), K(2.2, -1.45, 0.5), K(1.78, -1.45, 0.3)], (0, -1, 0), 'ink')
    b.box((0.42, 0.36, 0.26), tuple(K(3.62, -2.05, 0.2)), a, rot=(0, 28, 15), uv=SW('slate'))
    kbox(b, 3.32, 4.28, 1.92, 2.88, 0.0, 0.58, a, uv=SW('brown'), r=0.03, seg=1)
    for y in (0.15, 0.43):
        kbox(b, 3.3, 4.3, 1.9, 2.9, y - 0.03, y + 0.03, a, uv=SW('chocolate'), cull=('-Z', '+Z'))
    flat_poly(b, [K(3.4, 2.0, 0.584), K(4.0, 2.0, 0.584), K(3.7, 2.4, 0.584), K(3.4, 2.6, 0.584)], (0, 0, 1), 'ink')
    for x, z in ((4.6, 2.1), (4.45, 3.3), (3.0, 3.1)):
        b.cyl(0.07, 0.18, tuple(K(x, z, 0.09)), a, axis='X', rot=(0, 0, rng.uniform(0, 180)), seg=6, uv=SW('slate'))

    # ---- charred roof beams across the top: one whole, one broken and hanging ------------------
    kbox(b, -6.0, 6.0, -1.75, -1.45, 4.34, 4.6, a, uv=SW('ink'))
    kbox(b, -1.2, 0.9, -1.77, -1.43, 4.32, 4.62, a, uv=SW('chocolate'))
    b.beam(K(5.95, 1.9, 4.47), K(0.35, 1.9, 3.35), 0.24, 0.26, a, uv=SW('ink'))
    b.beam(K(-5.95, 1.9, 4.47), K(-0.55, 1.9, 3.6), 0.24, 0.26, a, uv=SW('ink'))
    for (x, y) in ((0.35, 3.35), (-0.55, 3.6)):
        for k in range(2):
            p = K(x, 1.9 + rng.uniform(-0.08, 0.08), y + rng.uniform(-0.05, 0.08))
            strut(b, p, p + Vector((-0.3 if x > 0 else 0.3, rng.uniform(-0.1, 0.1), -rng.uniform(0.0, 0.15))), 0.06, a, 'chocolate')

    # ---- the front: a scorched sign hung crooked, the awning's bent frame ----------------------
    phi = 9.0
    rgt = Vector((math.cos(math.radians(phi)), 0.0, -math.sin(math.radians(phi))))
    upv = Vector((math.sin(math.radians(phi)), 0.0, math.cos(math.radians(phi))))
    sc = Vector((3.75, -5.06, 3.3))
    b.box((2.34, 0.08, 1.12), tuple(sc), a, rot=(0, phi, 0), uv=SW('charcoal'))
    b.quad(tuple(sc + Vector((0, -0.045, 0))), tuple(rgt), tuple(upv), 2.2, 1.03, a, cell='sign_snack_shack')
    c0 = sc + Vector((0, -0.05, 0)) - rgt * 1.1 - upv * 0.515
    flat_poly(b, [c0 - rgt * 0.02 - upv * 0.02, c0 + rgt * 0.75, c0 + rgt * 0.5 + upv * 0.3, c0 + rgt * 0.3 + upv * 0.22,
                  c0 + rgt * 0.12 + upv * 0.62], (0, -1, 0), 'ink')
    for x in (-4.85, -3.75, -2.65):
        p0, p1 = K(x, 5.0, 2.95), K(x, 5.75, 2.72)
        strut(b, p0, p1, 0.05, a, 'charcoal')
        strut(b, p1, p1 + Vector((rng.uniform(-0.1, 0.1), -0.12, -0.42)), 0.05, a, 'charcoal')
    for x0, x1, sw in ((-4.8, -4.2, 'hotpink'), (-4.2, -3.6, 'white')):
        flat_poly(b, [K(x0, 5.72, 2.72), K(x1, 5.72, 2.72), K(x1, 5.74, 2.38), K((x0 + x1) / 2 + 0.05, 5.74, 2.5),
                      K(x0, 5.73, 2.3)], (0, -1, 0), sw)
    b.decal('-X', 6.0, 0.25, 2.0, 2.2, 1.03, 'graffiti_trash_is_life', m=a)
    b.decal('+Y', 5.0, -1.2, 1.7, 1.0, 1.0, 'graffiti_bandit', m=a)
    return b.build('bld_shell')


# ---------------------------------------------------------------- sinkhole --

def build_sinkhole():
    """A sinkhole that swallowed a stretch of street (kit setpieces.sinkhole; the road runs
    along x): a 16 x 8 m pit (x -8..8, z -4..4) 2.2 m deep with a broken asphalt rim over soil
    layers, a dirt floor, a rubble ramp climbing out toward +x (x 1..8, z -2.2..2.2), asphalt
    slabs heaved up on both rims, a burst water main filling a puddle, striped jersey barriers
    (x +-10.6, z +-2.33) and cones."""
    a = A()
    Wt = M_water()
    rng = C.seeded(7501)
    b = C.MeshBuilder()
    PX, PZ, FL = 8.0, 4.0, -2.2

    # ---- the pit walls: asphalt cut, gravel bed, soil layers (the lip overhangs a little) -----
    rows = ((0.03, (-0.14, -0.04)), (-0.2, (-0.12, -0.03)), (-0.24, (-0.02, 0.08)), (-0.5, (-0.03, 0.1)),
            (-1.1, (-0.1, 0.08)), (-1.6, (-0.08, 0.12)), (FL - 0.03, (-0.05, 0.06)))
    bands = ('charcoal', 'charcoal', 'grey', 'brown', 'chocolate', 'caramel')
    corner_off = {}
    cps = [(-PX, -PZ), (PX, -PZ), (PX, PZ), (-PX, PZ)]
    for ci in range(4):
        corner_off[ci] = [rng.uniform(*o) for _, o in rows]
    edges = [(0, 1, (0.0, -1.0)), (1, 2, (1.0, 0.0)), (2, 3, (0.0, 1.0)), (3, 0, (-1.0, 0.0))]
    for c0, c1, n in edges:
        p, q = cps[c0], cps[c1]
        L = math.hypot(q[0] - p[0], q[1] - p[1])
        nc = max(2, int(math.ceil(L / 1.6)))
        offs = []
        for i in range(nc + 1):
            if i == 0:
                offs.append(('c', c0))
            elif i == nc:
                offs.append(('c', c1))
            else:
                offs.append([rng.uniform(*o) for _, o in rows])
        P = []
        for j, (y, _) in enumerate(rows):
            row = []
            for i in range(nc + 1):
                t = i / nc
                x, z = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
                if isinstance(offs[i], tuple):
                    oo = corner_off[offs[i][1]][j]
                    cx, cz = cps[offs[i][1]]
                    x, z = x + oo * (1 if cx > 0 else -1), z + oo * (1 if cz > 0 else -1)
                else:
                    x, z = x + n[0] * offs[i][j], z + n[1] * offs[i][j]
                row.append(K(x, z, y))
            P.append(row)
        grid(b, P, a, lambda i, j: bands[j] if rng.random() < 0.85 else bands[min(5, max(0, j + rng.choice((-1, 1))))],
             (-n[0], n[1], 0.0))
        # the rim under the road's edge (hidden by the road; closes any crack at the hole)
        rim = [[K(x + n[0] * 0.3, z + n[1] * 0.3, 0.03) for x, z in
                [(p[0] + (q[0] - p[0]) * i / nc, p[1] + (q[1] - p[1]) * i / nc) for i in range(nc + 1)]], P[0]]
        grid(b, rim, a, lambda i, j: 'slate', (0, 0, 1))

    # ---- dirt floor, mud, a few rocks ----------------------------------------------------------
    fx = [-PX + 0.05 + (2 * PX - 0.1) * i / 6 for i in range(7)]
    fz = [-PZ + 0.05 + (2 * PZ - 0.1) * j / 3 for j in range(4)]
    grid(b, [[K(x, z, FL + rng.uniform(-0.025, 0.015)) for x in fx] for z in fz], a, lambda i, j: 'brown', (0, 0, 1))
    for cx, cz, rx, rz in ((-3.2, -2.2, 1.8, 1.0), (-0.6, 1.9, 1.3, 0.9), (-5.6, -1.0, 1.0, 0.7)):
        pts = [K(cx + math.cos(t) * rx * rng.uniform(0.7, 1.0), cz + math.sin(t) * rz * rng.uniform(0.7, 1.0), FL + 0.03)
               for t in [2 * math.pi * k / 9 for k in range(9)]]
        flat_poly(b, pts, (0, 0, 1), 'chocolate')
    for _ in range(7):
        x, z = rng.uniform(-7.3, 0.5), rng.uniform(-3.5, 3.5)
        if math.hypot(x + 6.2, z - 1.9) < 1.8:
            continue
        chunk(b, rng, K(x, z, FL + 0.03), (rng.uniform(0.25, 0.45), rng.uniform(0.2, 0.35), 0.13),
              rng.choice(('grey', 'tan', 'slate', 'charcoal')), tilt=8)

    # ---- the rubble ramp out (kit ramp ax x: x 1..8, z -2.2..2.2, -2.2 -> 0) -------------------
    def rh(x):
        return FL + (0 - FL) * min(1.0, max(0.0, (x - 1.0) / 7.0))
    rxs = [0.45, 1.0] + [1.0 + 0.7 * k for k in range(1, 11)] + [8.3]
    rzs = [(-2.2, 0.0), (-2.15, 0.5), (-2.08, 1.0), (-1.39, 1.0), (-0.69, 1.0), (0.0, 1.0), (0.69, 1.0),
           (1.39, 1.0), (2.08, 1.0), (2.15, 0.5), (2.2, 0.0)]
    P = []
    for z, f in rzs:
        row = []
        for x in rxs:
            top = 0.0 if x > 8.0 else rh(x)
            if x < 0.9:
                h = FL + rng.uniform(0.0, 0.08)
            elif f >= 1.0:
                h = top + (rng.uniform(-0.05, 0.05) if x < 7.9 else 0.0)
            else:
                h = FL + (top - FL) * f + (rng.uniform(-0.12, 0.1) if f > 0 else 0.0)
            row.append(K(x, z, h))
        P.append(row)
    grid(b, P, a, patchy(P, 0.4, base='brown', alt='chocolate', alt2='brown'), (0, 0, 1))
    # broken road lying on it: asphalt plates (and a couple of concrete ones) down the slope
    Rs = Matrix.Rotation(-math.atan2(-FL, 7.0), 3, 'Y')
    for k in range(10):
        x = 1.5 + 6.0 * (k + rng.uniform(0.1, 0.9)) / 10
        z = rng.uniform(-1.3, 1.3)
        R = Rs @ Matrix.Rotation(rng.uniform(0, math.pi), 3, 'Z')
        conc = k in (3, 7)
        # (a lift of its own: two plates that overlap mustn't share a top)
        plate(b, rng, K(x, z, rh(x)), R, rng.uniform(0.5, 0.8), rng.uniform(0.4, 0.6), 0.14,
              'silver' if conc else 'slate', 'grey' if conc else 'charcoal', lift=0.07 + 0.004 * k)
    for k in range(5):        # flat bits of asphalt that slid off its sides onto the floor
        side = (-1, 1)[k % 2]
        x = rng.uniform(1.8, 7.4)
        plate(b, rng, K(x, side * rng.uniform(2.3, 2.5), FL), Matrix.Rotation(rng.uniform(0, math.pi), 3, 'Z'),
              rng.uniform(0.3, 0.45), rng.uniform(0.2, 0.3), 0.12, 'slate', 'charcoal', lift=0.08 + 0.004 * k)
    mc = K(4.6, 2.62, FL + (rh(4.6) - FL) * 0.5 + 0.1)
    Rm = Matrix.Rotation(math.radians(-38), 3, 'X') @ Matrix.Rotation(math.radians(20), 3, 'Z')
    ua, va, nm = Rm @ Vector((1, 0, 0)), Rm @ Vector((0, 1, 0)), Rm @ Vector((0, 0, 1))
    b.cyl(0.36, 0.07, tuple(mc), a, seg=14, rot=Rm.to_euler(), uv=('planar', tuple(mc - ua * 0.36 - va * 0.36 + nm * 0.035),
                                                              tuple(ua), tuple(va), 0.72, 0.72, {'rect': T.atlas_rect('decal_manhole')}))

    # ---- asphalt slabs heaved up on the rims (kit ramps ax x) ----------------------------------
    def heaved(x_lo, x_hi, z0, z1, h_hi):
        o = K(x_lo, z0, 0.0)
        M, flip = frame(o, K(x_hi, z0, h_hi) - o, K(x_lo, z1, 0.0) - o)
        if flip:
            o = K(x_lo, z1, 0.0)
            M, _ = frame(o, K(x_hi, z1, h_hi) - o, K(x_lo, z0, 0.0) - o)
        L = math.hypot(x_hi - x_lo, h_hi)
        Wd = abs(z1 - z0)
        pts = ([(0.0, -0.1), (Wd, -0.1)] + jag_edge(rng, (Wd, 0.0), (Wd, L), (1.0, 0.0), lo=-0.02, hi=0.14, step=(0.25, 0.5))
               + [(Wd + 0.06, L + 0.07)] + jag_edge(rng, (Wd, L), (0.0, L), (0.0, 1.0), lo=-0.02, hi=0.16, step=(0.25, 0.5))
               + [(-0.06, L + 0.05)] + jag_edge(rng, (0.0, L), (0.0, 0.0), (-1.0, 0.0), lo=-0.02, hi=0.14, step=(0.25, 0.5)))
        prism(b, pts, -0.11, 0.0, a, 'slate', 'charcoal', None, matrix=M)
        prism(b, pts, -0.3, -0.11, a, 'grey', 'grey', 'grey', matrix=M)
        R3 = M.to_3x3()
        for s0, s1 in ((0.15, L * 0.5), (L * 0.5 + 0.35, L - 0.1)):      # a piece of the edge line
            w0 = Wd * 0.5
            q = [M @ Vector((w0 - 0.07, s0, 0.004)), M @ Vector((w0 + 0.07, s0, 0.004)),
                 M @ Vector((w0 + 0.07, s1, 0.004)), M @ Vector((w0 - 0.07, s1, 0.004))]
            flat_poly(b, q, R3 @ Vector((0, 0, 1)), 'butter')
        sgn = 1.0 if x_hi > x_lo else -1.0
        xa, xb = x_hi - sgn * 0.08, x_lo + sgn * 0.5
        wedge = [(xb, -0.05), (xa, -0.05), (xa, h_hi - 0.33)]
        b.poly_prism(wedge, -max(z0, z1) + 0.1, -min(z0, z1) - 0.1, a, axis='Y', uv=SW('chocolate'))
        for _ in range(3):
            flat_strip(b, crack(rng, (x_lo + sgn * rng.uniform(0.0, 0.3), rng.uniform(min(z0, z1), max(z0, z1))),
                                math.pi if sgn > 0 else 0.0, n=3, seg=(0.3, 0.6)), 0.062, 0.05, 'ink')
    heaved(-9.9, -8.1, -3.5, -1.3, 0.6)
    heaved(9.9, 8.3, 1.8, 3.4, 0.5)

    # ---- the broken edge: shards of asphalt tipped into the hole, cracks out across the road --
    for (x0, x1, zr, nz, n) in ((-7.3, 6.8, -PZ, -1.0, 3), (-7.3, 6.8, PZ, 1.0, 3)):
        for k in range(n):
            x = x0 + (x1 - x0) * (k + rng.uniform(0.15, 0.85)) / n
            e, i0 = Vector((1.0, 0.0, 0.0)), Vector((0.0, nz, 0.0))
            th = math.radians(rng.uniform(22, 60))
            i = i0 * math.cos(th) - Vector((0, 0, 1)) * math.sin(th)
            up = e.cross(i)
            if up.z < 0:
                e = -e
                up = -up
            R = Matrix((e, i, up)).transposed() @ Matrix.Rotation(math.radians(rng.uniform(-12, 12)), 3, 'Z')
            ry = rng.uniform(0.3, 0.5)
            plate(b, rng, K(x, zr - nz * 0.04, 0.03) + i * ry * 0.85, R, rng.uniform(0.45, 0.75), ry, 0.18,
                  'slate', 'charcoal', lift=0.0, n=5)
    for zz in (-PZ, PZ):
        for _ in range(3):
            x = rng.uniform(-7.0, 7.0)
            flat_strip(b, crack(rng, (x, zz), math.pi / 2 if zz > 0 else -math.pi / 2, n=2, seg=(0.25, 0.5)),
                       0.062, 0.045, 'ink')
    for xx in (-PX, PX):
        for _ in range(4):
            z = rng.uniform(-3.6, 3.6)
            if xx > 0 and abs(z) < 2.4:
                continue
            flat_strip(b, crack(rng, (xx, z), 0.0 if xx > 0 else math.pi, n=3, seg=(0.35, 0.7)), 0.062, 0.05, 'ink')

    # ---- the burst water main, its stream and the puddle ---------------------------------------
    pz, py = 2.2, -1.05
    b.cyl(0.15, 0.9, tuple(K(-7.9, pz, py)), a, axis='X', seg=12, uv=SW('steel'))
    b.cyl(0.19, 0.1, tuple(K(-7.45, pz, py)), a, axis='X', seg=12, uv=SW('charcoal'))
    b.box((0.3, 0.2, 0.06), tuple(K(-7.32, pz + 0.05, py - 0.17)), a, rot=(20, 35, 10), uv=SW('steel'))
    prev = None
    for k in range(8):
        t = k / 7
        p = K(-7.38 + 0.85 * t, pz, py - 1.1 * t * t)
        if prev is not None:
            strut(b, prev, p, 0.13 + 0.06 * t, Wt, None)
        prev = p
    pc = (-6.2, 1.9)
    pts = [K(pc[0] + math.cos(th) * 1.5 * rng.uniform(0.8, 1.0), pc[1] + math.sin(th) * 1.0 * rng.uniform(0.8, 1.0), FL + 0.05)
           for th in [2 * math.pi * k / 16 for k in range(16)]]
    flat_poly(b, pts, (0, 0, 1), None, m=Wt)
    wet = [K(pc[0] + (p.x - pc[0]) * 1.18, pc[1] + (-p.y - pc[1]) * 1.25, FL + 0.035) for p in pts]
    flat_poly(b, wet, (0, 0, 1), 'chocolate')
    b.torus(0.2, 0.03, tuple(K(-6.53, pz, FL + 0.06)), a, seg=8, rseg=3, uv=SW('cloud'))

    # ---- jersey barriers (kit boxes x +-10.6, z +-2.33: 0.6 x 3.34, top 1.0), cones ------------
    prof = [(-0.3, 0.0), (0.3, 0.0), (0.3, 0.1), (0.24, 0.3), (0.165, 0.88), (0.16, 1.0), (-0.16, 1.0),
            (-0.165, 0.88), (-0.24, 0.3), (-0.3, 0.1)]
    for bx in (-10.6, 10.6):
        for bz in (-2.33, 2.33):
            zs_ = [bz - 1.67 + 3.34 * k / 3 for k in range(4)]
            rings = [[K(bx + px, z, py) for px, py in prof] for z in zs_]
            n = len(prof)
            verts, faces, sws = [], [], []
            for z_i, ring in enumerate(rings):
                verts.extend(ring)
            for k in range(3):
                for i in range(n):
                    j = (i + 1) % n
                    q = [k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i]
                    cen = sum((verts[t] for t in q), Vector()) / 4
                    axis = Vector((bx, cen.y, 0.5))
                    if _newell([verts[t] for t in q]).dot(cen - axis) < 0:
                        q.reverse()
                    faces.append(q)
                    sws.append(('red', 'white')[k % 2])
            faces.append(list(range(n)))
            faces.append(list(range(3 * n, 4 * n)))
            sws += ['red', 'red']
            # end caps face outward along the barrier
            for fi, outy in ((-2, 1.0), (-1, -1.0)):
                f = faces[fi]
                if _newell([verts[t] for t in f]).y * outy < 0:
                    faces[fi] = list(reversed(f))
            raw_faces(b, verts, faces, a, sws)
    for x, z in ((-11.5, 0.2), (11.4, -0.5), (-9.3, 0.9)):
        cone(b, Matrix.Translation(K(x, z, 0.0)))
    cone(b, Matrix.Translation(K(9.3, 0.3, 0.16)) @ Matrix.Rotation(math.radians(-90), 4, 'X')
         @ Matrix.Rotation(math.radians(40), 4, 'Y'))
    return b.build('sinkhole')


# ===========================================================================
# landmarks: one per district (kit.json setpieces clocktower / maple / millyard / racsign; the
# downtown lm_mast stands on a tower's roof and has no colliders)
# ===========================================================================
# Built like the ruins: kit coordinates through K() / kbox(), walkable tops on their collider
# tops, walls on the collider sides.  Materials: AtlasTown swatches, the district-tinted 'Wall' /
# 'Roof' (the game recolours both) and a few emissive flat colours (build_lamp's Glow recipe).
# Curved parts are lathes / tubes made of rows of points (sheet()): rings counter-clockwise about
# their axis, profiles bottom -> top with the solid on the left, so every face winds outward.

RXM90 = Matrix.Rotation(math.radians(-90), 4, 'X')    # local (x, y, z) -> (x, z, -y)


def M_glow(name, color, emit, strength=4.0):
    """An emissive flat colour (build_lamp's Glow recipe): neon tubes, bulbs, a beacon."""
    return C.mat(name, color, rough=0.4, emit=emit, strength=strength)


def wall_frame(face, d):
    """Matrix taking wall-local (u, y, v) to Blender: u along the wall as in win() / decal() (+u is
    the viewer's LEFT), y out of the wall from its plane (|.| = d, see FU()), v = height."""
    return C.wall_matrix(face) @ Matrix.Translation((0.0, d, 0.0))


def wprism(b, Mw, pts, y0, y1, outer, side=None, inner=None, m=None):
    """A slab on a wall (Mw from wall_frame()): the simple polygon pts [(u, v)] from y0 to y1 out of
    the wall plane.  Swatches: `outer` (the face toward +y), `side`, `inner` (toward the wall;
    None = open)."""
    prism(b, [(u, -v) for u, v in pts], y0, y1, m or A(), outer, side or outer, inner, matrix=Mw @ RXM90)


def sheet(b, rows, m, sw='white', uvf=None, uvmode=None, wrap=True):
    """Quads (triangles at single-point rows) between consecutive rows of Blender points, closing
    round if `wrap`; face (row i, column j) = [i][j], [i][j+1], [i+1][j+1], [i+1][j] as given.  UVs:
    uvf(i, j, p) per corner (j unwrapped: the closing column is n, not 0, so tiling maps stay
    seamless), else T.corner_uvs(uvmode), else the swatch `sw` (a name, or sw(i, j) per face)."""
    off = len(b.verts)
    pts, R = [], []
    for row in rows:
        R.append(list(range(len(pts), len(pts) + len(row))))
        pts.extend(Vector(p) for p in row)
    b.verts.extend(tuple(p) for p in pts)
    mi = b._mi(m)
    mode = T.norm_uv(uvmode) if uvmode is not None else None
    tris = 0
    for i in range(len(R) - 1):
        A_, B_ = R[i], R[i + 1]
        n = max(len(A_), len(B_))
        if len(A_) == 1 and len(B_) == 1:
            continue
        for j in range(n if wrap else n - 1):
            j1 = j + 1
            if len(A_) == 1:
                f = [(A_[0], i, j + 0.5), (B_[j1 % n], i + 1, j1), (B_[j], i + 1, j)]
            elif len(B_) == 1:
                f = [(A_[j], i, j), (A_[j1 % n], i, j1), (B_[0], i + 1, j + 0.5)]
            else:
                f = [(A_[j], i, j), (A_[j1 % n], i, j1), (B_[j1 % n], i + 1, j1), (B_[j], i + 1, j)]
            b.faces.append([c[0] + off for c in f])
            b.fmat.append(mi)
            if uvf is not None:
                b.uvs.append([tuple(uvf(c[1], c[2], pts[c[0]])) for c in f])
            elif mode is not None:
                cos = [pts[c[0]] for c in f]
                b.uvs.append(T.corner_uvs(mode, cos, _newell(cos).normalized()))
            else:
                s = sw(i, j) if callable(sw) else sw
                b.uvs.append([tuple(T.swatch_uv(s)) if s else (0.0, 0.0)] * len(f))
            tris += len(f) - 2
    b.log.append((tris, m.name))


def lathe_rows(profile, seg, M=None, phase=0.0):
    """Rings of a lathe: profile [(r, z)] (r = 0: a single pole point), `seg` points counter-
    clockwise about local +Z, through matrix M (a rotation + translation)."""
    M = M if M is not None else Matrix()
    rows = []
    for r, z in profile:
        if r < 1e-7:
            rows.append([M @ Vector((0.0, 0.0, z))])
        else:
            rows.append([M @ Vector((r * math.cos(phase + 2 * math.pi * j / seg),
                                     r * math.sin(phase + 2 * math.pi * j / seg), z)) for j in range(seg)])
    return rows


def tube_rows(pts, radii, sides, normal=None, closed=False, shape=None):
    """Rings of a tube along `pts` (counter-clockwise about the direction of travel).  Frames:
    parallel transport, or the fixed in-plane `normal` for a flat curve (neon outlines: no twist
    when `closed`).  Corners keep the tube's width (mitre, capped).  shape(i, k) scales ring i's
    point k (bark knots)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)

    def nb(i):
        if closed:
            return pts[(i - 1) % n], pts[(i + 1) % n]
        return pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
    tans = []
    for i in range(n):
        p0, p1 = nb(i)
        tans.append((p1 - p0).normalized())
    if normal is not None:
        N = Vector(normal).normalized()
    else:
        ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
        N = (ref - ref.dot(tans[0]) * tans[0]).normalized()
    rows = []
    for i in range(n):
        Tg = tans[i]
        N = (N - N.dot(Tg) * Tg).normalized()
        Bn = Tg.cross(N)
        mit = 1.0
        if normal is not None and (closed or 0 < i < n - 1):
            p0, p1 = nb(i)
            e0, e1 = (pts[i] - p0).normalized(), (p1 - pts[i]).normalized()
            mit = min(1.8, 1.0 / max(0.3, math.cos(e0.angle(e1, 0.0) / 2)))
        r = radii[i] if hasattr(radii, '__len__') else radii
        row = []
        for k in range(sides):
            ang = 2 * math.pi * k / sides + (math.pi / sides if normal is not None else 0.0)
            s = shape(i, k) if shape else 1.0
            row.append(pts[i] + r * s * (math.cos(ang) * N + math.sin(ang) * Bn * mit))
        rows.append(row)
    if closed:
        rows.append(list(rows[0]))
    return rows


def catmull(pts, sub, closed=False):
    """Catmull-Rom through `pts` (Vectors / tuples), `sub` segments per span."""
    P = [Vector(p) for p in pts]
    n = len(P)
    out = []
    spans = n if closed else n - 1
    for i in range(spans):
        if closed:
            p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        else:
            p0, p1, p2, p3 = P[max(i - 1, 0)], P[i], P[i + 1], P[min(i + 2, n - 1)]
            if i == 0:
                p0 = p1 * 2 - p2
            if i == n - 2:
                p3 = p2 * 2 - p1
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                              (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    if not closed:
        out.append(P[-1].copy())
    return out


def arch_outline(w, h, n=8):
    """(u, v) outline of an arched opening w wide and h tall to its crown (a half-round head on
    straight jambs), from the bottom left corner up, over and down to the bottom right."""
    r = w / 2.0
    vs = h - r
    pts = [(-r, 0.0)] if vs > 1e-6 else []
    for k in range(n + 1):
        t = math.pi * (1 - k / n)
        pts.append((r * math.cos(t), vs + r * math.sin(t)))
    if vs > 1e-6:
        pts.append((r, 0.0))
    return pts


def arch_window(b, Mw, u, v0, w, h, glass='navy', frame='sand', fw=0.16, proud=0.08, n=6, sill=True,
                key=True, bars=(), glint='sky', bar_sw='charcoal'):
    """An arched window on a wall (Mw from wall_frame()): the glass (a swatch) 1 cm off the wall in
    a frame ring fw wide standing `proud` out (its reveal reads as depth), a sill and a keystone.
    bars: muntins [('v', du) | ('h', dv)] from the opening's bottom centre."""
    a = A()
    R3 = Mw.to_3x3()
    N = R3 @ Vector((0, 1, 0))
    inner = [(u + x, v0 + z) for x, z in arch_outline(w, h, n)]
    outer = [(u + x, v0 + z) for x, z in arch_outline(w + 2 * fw, h + fw, n)]

    def P(p, y):
        return Mw @ Vector((p[0], y, p[1]))
    flat_poly(b, [P(p, 0.01) for p in inner], N, glass)
    cu, cv = u, v0 + max(h - w / 2, 0.0)
    for k in range(len(inner) - 1):
        i0, i1, o0, o1 = inner[k], inner[k + 1], outer[k], outer[k + 1]
        flat_poly(b, [P(i0, proud), P(i1, proud), P(o1, proud), P(o0, proud)], N, frame)
        mid = R3 @ Vector(((o0[0] + o1[0]) / 2 - cu, 0.0, (o0[1] + o1[1]) / 2 - cv))
        flat_poly(b, [P(o0, 0.0), P(o1, 0.0), P(o1, proud), P(o0, proud)], mid, frame)
        flat_poly(b, [P(i0, 0.012), P(i1, 0.012), P(i1, proud), P(i0, proud)], -mid, frame)
    r = w / 2.0
    vs = max(h - r, 0.0)
    for kind, o in bars:
        if kind == 'v':
            top = vs + math.sqrt(max(r * r - o * o, 0.0)) - 0.01
            q = [(u + o - 0.025, v0 + 0.01), (u + o + 0.025, v0 + 0.01), (u + o + 0.025, v0 + top), (u + o - 0.025, v0 + top)]
        else:
            hw = r if o <= vs else math.sqrt(max(r * r - (o - vs) ** 2, 0.0))
            q = [(u - hw, v0 + o - 0.025), (u + hw, v0 + o - 0.025), (u + hw, v0 + o + 0.025), (u - hw, v0 + o + 0.025)]
        flat_poly(b, [P(p, 0.018) for p in q], N, bar_sw)
    if glint:
        g0 = v0 + 0.25 * h
        flat_poly(b, [P((u + 0.55 * r, g0), 0.015), P((u + 0.3 * r, g0), 0.015),
                      P((u - 0.35 * r, g0 + 0.45 * h), 0.015), P((u - 0.1 * r, g0 + 0.45 * h), 0.015)], N, glint)
    if sill:
        b.box((w + 2 * fw + 0.14, 0.16, 0.09), (u, 0.08, v0 - 0.045), a, matrix=Mw, cull=('-Y',), uv=SW(frame))
    if key:
        top = v0 + h + fw
        wprism(b, Mw, [(u - 0.07, v0 + h - 0.03), (u + 0.07, v0 + h - 0.03), (u + 0.11, top + 0.06),
                       (u - 0.11, top + 0.06)], 0.0, proud + 0.03, frame)


def flat_ring(b, c, r0, r1, z, seg, sw, m=None):
    """A flat horizontal annulus (facing up) at height z around Blender point c."""
    rows = lathe_rows([(r1, z), (r0, z)], seg, Matrix.Translation((c[0], c[1], 0.0)))
    sheet(b, rows, m or A(), sw)


def bulb(b, m, c, n, r=0.06, h=0.07, sides=6):
    """A little cone light (apex along n) sitting on a surface at c: `sides` triangles."""
    c, n = Vector(c), Vector(n).normalized()
    t = n.orthogonal().normalized()
    s = n.cross(t)
    ring = [c + r * (math.cos(2 * math.pi * k / sides) * t + math.sin(2 * math.pi * k / sides) * s)
            for k in range(sides)]
    apex = c + n * h
    verts = ring + [apex]
    faces = []
    for k in range(sides):
        f = [k, (k + 1) % sides, sides]
        if _newell([verts[i] for i in f]).dot(sum((verts[i] for i in f), Vector()) / 3 - c) < 0:
            f.reverse()
        faces.append(f)
    raw_faces(b, verts, faces, m, [None] * sides)


# ------------------------------------------------------------- clock tower --

CT_D, CT_PLINTH, CT_TOP = 2.2, 0.4, 16.8     # shaft half-width, plinth top, shaft collider top
CT_CLOCK, CT_DIAL = 15.0, 0.14               # dial centre height, dial face out from the wall
CT_FACES = ('-Y', '+X', '+Y', '-X')          # clock i: glTF +Z (front), +X (left), -Z, -X


def build_lm_clocktower():
    """Old Town's clock tower (kit setpieces.clocktower; origin = its ground centre): a stone plinth
    (the 0.4 step, to +-3.0), the brick shaft (+-2.2, Wall) with stone quoins, a wooden door on the
    front under a fanlight, narrow arched windows, the clock stage (13.2..16.8: a clock on every
    face), the cornice (its top = the collider's 16.8), an open belfry with its bell, the spire
    (Roof) and a raccoon weather vane.  Clock hands: empties `clock_<i>` (i = 0 front +Z, 1 left
    +X, 2 back -Z, 3 right -X in glTF) sit on each dial's centre, yawed i * 90 deg about +Y so their
    local +Z points out of the face; each holds `hand_h_<i>` and `hand_m_<i>` with an identity
    local transform: a hand lies in the local XY plane pointing +Y (12 o'clock) and turns about
    local +Z (counter-clockwise for a viewer: the game turns them by negative angles)."""
    W = M_wall('#fffaf2', 'brick')
    Rf = M_roof('#c9603f', 'shingle')
    a = A()
    b = C.MeshBuilder()
    D, P = CT_D, CT_PLINTH
    ST, ST2 = 'sand', 'tan'

    # ---- plinth: the 0.4 step all round (kit box +-3.0, top 0.4), slab joints ----------------
    b.box((6.1, 6.1, P), (0, 0, P / 2), a, r=0.05, seg=1, edges='topvert', cull=('-Z',), uv=SW(ST))
    for face in CT_FACES:
        Mw = wall_frame(face, D)
        for uu in (-1.65, -0.55, 0.55, 1.65):
            flat_poly(b, [Mw @ Vector((uu - 0.02, 0.06, P + 0.004)), Mw @ Vector((uu + 0.02, 0.06, P + 0.004)),
                          Mw @ Vector((uu + 0.02, 0.8, P + 0.004)), Mw @ Vector((uu - 0.02, 0.8, P + 0.004))],
                      (0, 0, 1), ST2)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p, q = Vector((sx * (D + 0.06), sy * (D + 0.06), P + 0.004)), Vector((sx * 3.0, sy * 3.0, P + 0.004))
            dd = Vector((-sy, sx, 0)).normalized() * 0.02
            flat_poly(b, [p - dd, q - dd, q + dd, p + dd], (0, 0, 1), ST2)

    # ---- the shaft: brick, a stone base course, quoins, string course, clock-stage pilasters ---
    b.box((2 * D, 2 * D, 16.3 - P), (0, 0, (16.3 + P) / 2), W, cull=('-Z', '+Z'))
    BC = 1.05
    for face in ('+Y', '+X', '-X'):
        b.box((2 * D + 0.12, 0.12, BC - P), (0, 0.0, (BC + P) / 2), a, matrix=wall_frame(face, D),
              cull=('-Y', '-Z'), uv=SW(ST2))
    for uu in (-1.59, 1.59):
        b.box((1.34, 0.12, BC - P), (uu, 0.0, (BC + P) / 2), a, matrix=wall_frame('-Y', D), cull=('-Y', '-Z'),
              uv=SW(ST2))
    qh = 2.0 / 3.0
    for k in range(18):                       # 1.05 .. 13.05, long and short blocks alternating
        z0 = BC + k * qh
        for sx in (-1, 1):
            for sy in (-1, 1):
                lx, ly = (0.66, 0.38) if (k + (sx > 0) + (sy > 0)) % 2 == 0 else (0.38, 0.66)
                b.box((lx, ly, qh - 0.05), (sx * (D + 0.05 - lx / 2), sy * (D + 0.05 - ly / 2), z0 + qh / 2), a,
                      cull=('-Z', '+Z'), uv=SW(ST))
    b.box((2 * D + 0.16, 2 * D + 0.16, 0.26), (0, 0, 13.18), a, r=0.03, seg=1, uv=SW(ST))
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((0.56, 0.56, 16.3 - 13.31), (sx * (D + 0.06 - 0.28), sy * (D + 0.06 - 0.28), (16.3 + 13.31) / 2), a,
                  cull=('-Z', '+Z'), uv=SW(ST))
    # cornice: its top is the shaft collider's top (the belfry floor)
    b.box((2 * D + 0.24, 2 * D + 0.24, 0.2), (0, 0, 16.4), a, r=0.03, seg=1, uv=SW(ST))
    b.box((4.96, 4.96, 0.3), (0, 0, CT_TOP - 0.15), a, r=0.05, seg=1, edges='topvert', uv=SW('cream'))

    # ---- the clocks: stone panel, white dial, brass bezel, ticks (hands: separate nodes) -------
    clocks = []
    for i, face in enumerate(CT_FACES):
        Mw = wall_frame(face, D)
        R3 = Mw.to_3x3()
        N = R3 @ Vector((0, 1, 0))
        b.box((2.86, 0.05, 2.86), (0, 0.025, CT_CLOCK), a, matrix=Mw, cull=('-Y',), uv=SW(ST))
        Ml = Mw @ Matrix.Translation((0.0, 0.0, CT_CLOCK)) @ RXM90       # lathe axis = out of the wall
        flat_poly(b, lathe_rows([(1.1, CT_DIAL)], 24, Ml)[0], N, 'white')
        sheet(b, lathe_rows([(1.27, 0.05), (1.25, 0.2), (1.07, 0.18)], 24, Ml), a, 'brass')
        for t in range(12):
            ang = math.pi / 2 - 2 * math.pi * t / 12
            hw, r0 = (0.055, 0.74) if t % 3 == 0 else (0.028, 0.86)
            du, dv = math.cos(ang), math.sin(ang)
            pu, pv = -dv, du
            q = [(du * r0 - pu * hw, dv * r0 - pv * hw), (du * 1.0 - pu * hw, dv * 1.0 - pv * hw),
                 (du * 1.0 + pu * hw, dv * 1.0 + pv * hw), (du * r0 + pu * hw, dv * r0 + pv * hw)]
            flat_poly(b, [Mw @ Vector((x, CT_DIAL + 0.005, CT_CLOCK + z)) for x, z in q], N, 'ink')
        clocks.append((i, Mw @ Vector((0.0, CT_DIAL, CT_CLOCK))))

    # ---- front door under a fanlight, stone portal, lanterns -----------------------------------
    Mf = wall_frame('-Y', D)
    door(b, '-Y', D, 0.0, 1.25, 2.5, 'door_wood', z0=P, frame=ST)
    dtop = P + 2.5 + 0.12
    for uu in (-0.835, 0.835):
        b.box((0.18, 0.1, dtop - P), (uu, 0.05, (dtop + P) / 2), a, matrix=Mf, cull=('-Y',), uv=SW(ST))
    arch_window(b, Mf, 0.0, dtop, 1.49, 0.745, glass='navy', frame=ST, fw=0.18, proud=0.1, n=8, sill=False,
                bars=(('v', 0.0), ('v', -0.38), ('v', 0.38)), glint=None)
    for uu in (-1.3, 1.3):
        b.box((0.07, 0.36, 0.06), (uu, 0.18, 2.86), a, matrix=Mf, uv=SW('charcoal'))
        c = Mf @ Vector((uu, 0.34, 2.56))
        b.cyl(0.1, 0.26, tuple(c), a, seg=6, uv=SW('butter'))
        b.cyl(0.15, 0.13, tuple(c + Vector((0, 0, 0.195))), a, r2=0.02, seg=6, uv=SW('charcoal'))
        b.cyl(0.12, 0.04, tuple(c - Vector((0, 0, 0.15))), a, seg=6, uv=SW('charcoal'))

    # ---- narrow arched windows up the shaft --------------------------------------------------
    for face in CT_FACES:
        Mw = wall_frame(face, D)
        for v0 in (4.9, 7.6, 10.3):
            arch_window(b, Mw, 0.0, v0, 0.62, 1.75, glass='navy', frame=ST, fw=0.13, proud=0.07, n=6,
                        bars=(('h', 1.0),))

    # ---- open belfry: brick piers, arches, parapets, the bell on its yoke -----------------------
    F, BT, ET = CT_TOP, 19.2, 19.55          # belfry floor, top of the piers, top of the entablature
    for sx in (-1, 1):
        for sy in (-1, 1):
            c = (sx * 1.82, sy * 1.82)
            b.box((0.88, 0.88, 0.16), (c[0], c[1], F + 0.08), a, cull=('-Z',), uv=SW(ST))
            b.box((0.76, 0.76, BT - 0.14 - F - 0.16), (c[0], c[1], (BT - 0.14 + F + 0.16) / 2), W, cull=('-Z', '+Z'))
            b.box((0.9, 0.9, 0.14), (c[0], c[1], BT - 0.07), a, uv=SW(ST))
    spring, rv = 17.6, 1.2
    for face in CT_FACES:
        Mw = wall_frame(face, D)
        arc = [(1.44 * math.cos(math.pi * (1 - k / 10)), spring + rv * math.sin(math.pi * (1 - k / 10)))
               for k in range(11)]
        wprism(b, Mw, arc + [(1.44, BT), (-1.44, BT)], -0.34, 0.0, ST, ST, ST)
        b.box((2.88, 0.26, 0.4), (0, -0.15, F + 0.2), a, matrix=Mw, uv=SW(ST))
        b.box((2.88, 0.34, 0.08), (0, -0.15, F + 0.44), a, matrix=Mw, uv=SW('cream'))
    b.box((4.72, 4.72, ET - BT), (0, 0, (ET + BT) / 2), a, r=0.04, seg=1, uv=SW(ST))
    b.box((4.4, 4.4, 0.02), (0, 0, BT - 0.01), a, uv=SW('chocolate'))       # the belfry's ceiling
    # the bell: lip at 17.75, crown at 18.62, hung from a yoke between the side piers
    sheet(b, lathe_rows([(0.0, 17.8), (0.52, 17.8), (0.6, 17.76), (0.53, 17.9), (0.42, 18.12), (0.36, 18.4),
                         (0.27, 18.56), (0.12, 18.61), (0.0, 18.62)], 12),
          a, lambda i, j: 'charcoal' if i == 0 else 'brass')
    b.sphere(0.11, (0, 0, 17.66), a, seg=8, rings=5, uv=SW('charcoal'))
    b.cyl(0.03, 0.2, (0, 0, 17.8), a, seg=6, uv=SW('charcoal'))
    b.box((3.84, 0.26, 0.24), (0, 0, 19.03), a, uv=SW('brown'))         # its ends sit in the side spandrels
    b.box((0.5, 0.34, 0.32), (0, 0, 18.76), a, uv=SW('chocolate'))

    # ---- pinnacles, the spire (Roof, flared), hip ridges, the weather vane -----------------------
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * 2.12, sy * 2.12
            b.box((0.42, 0.42, 0.3), (x, y, ET + 0.15), a, cull=('-Z',), uv=SW(ST))
            b.cyl(0.29, 0.75, (x, y, ET + 0.3 + 0.375), a, r2=0.02, seg=4, rot=(0, 0, 45), uv=SW(ST))
            b.sphere(0.09, (x, y, ET + 1.08), a, seg=6, rings=4, uv=SW('brass'))
    h = math.sqrt(2.0)
    prof = [(1.72 * h, ET - 0.03), (1.8 * h, ET + 0.12), (1.48 * h, ET + 0.62), (0.07 * h, 23.02), (0.0, 23.08)]
    sheet(b, lathe_rows(prof[:2], 4, phase=math.pi / 4), a, 'charcoal')
    sheet(b, lathe_rows(prof[1:], 4, phase=math.pi / 4), Rf, uvmode=('slope', T.TEX['shingle'].tile_m))
    for k in range(4):
        ang = math.pi / 4 + k * math.pi / 2
        d = Vector((math.cos(ang), math.sin(ang), 0.0))
        p0 = d * 1.8 * h + Vector((0, 0, ET + 0.12))
        p1 = d * 1.48 * h + Vector((0, 0, ET + 0.62))
        p2 = Vector((0, 0, 23.0))
        strut(b, p0 + Vector((0, 0, 0.03)), p1 + Vector((0, 0, 0.04)), 0.11, a, 'cream')
        strut(b, p1 + Vector((0, 0, 0.04)), p2, 0.1, a, 'cream')
    b.sphere(0.16, (0, 0, 23.1), a, seg=8, rings=5, uv=SW('brass'))
    b.cyl(0.035, 1.5, (0, 0, 23.85), a, seg=6, uv=SW('charcoal'))
    b.sphere(0.12, (0, 0, 23.45), a, seg=6, rings=4, uv=SW('gold'))
    for ax in ((0.55, 0, 0), (0, 0.55, 0)):
        p = Vector(ax)
        strut(b, Vector((0, 0, 23.78)) - p, Vector((0, 0, 23.78)) + p, 0.035, a, 'charcoal')
    # the vane: an arrow with a raccoon standing on it (profile in the X-Z plane)
    b.poly_prism([(-0.62, -0.03), (0.42, -0.03), (0.42, -0.11), (0.68, 0.0), (0.42, 0.11), (0.42, 0.03),
                  (-0.62, 0.03), (-0.78, 0.16), (-0.9, 0.16), (-0.74, 0.0), (-0.9, -0.16), (-0.78, -0.16)],
                 -0.018, 0.018, a, axis='Y', matrix=Matrix.Translation((0, 0, 24.25)), uv=SW('gold'))
    coon = [(-0.3, 0.1), (-0.27, 0.0), (-0.2, 0.0), (-0.17, 0.08), (0.07, 0.08), (0.1, 0.0), (0.17, 0.0), (0.19, 0.1),
            (0.25, 0.13), (0.33, 0.14), (0.48, 0.15), (0.47, 0.19), (0.37, 0.24), (0.36, 0.31), (0.31, 0.29), (0.25, 0.32),
            (0.21, 0.26), (0.05, 0.3), (-0.15, 0.3), (-0.3, 0.23), (-0.42, 0.25), (-0.66, 0.27), (-0.78, 0.2), (-0.66, 0.12),
            (-0.42, 0.12)]
    for x in (-0.47, -0.6):
        for y in (-0.018, 0.018):
            flat_poly(b, [(x - 0.035, y * 1.1, 24.28 + 0.115), (x + 0.035, y * 1.1, 24.28 + 0.115),
                          (x + 0.035, y * 1.1, 24.28 + 0.27), (x - 0.035, y * 1.1, 24.28 + 0.27)], (0, y, 0), 'charcoal')
    b.poly_prism(coon, -0.016, 0.016, a, axis='Y', matrix=Matrix.Translation((0, 0, 24.28)), uv=SW('gold'))
    root = b.build('lm_clocktower')

    # ---- the hands: clock_<i> (yawed) holds hand_h_<i> / hand_m_<i> (identity, pointing +Z here =
    # glTF +Y, lying 1-5 cm in front of the dial = Blender local -Y) --------------------------------
    hour = ([(-0.05, -0.15), (0.05, -0.15), (0.06, 0.0), (0.04, 0.38), (-0.04, 0.38), (-0.06, 0.0)],
            [(0.0, 0.3), (0.13, 0.47), (0.0, 0.66), (-0.13, 0.47)])
    minute = ([(-0.035, -0.22), (0.035, -0.22), (0.045, 0.0), (0.022, 0.84), (0.0, 0.97), (-0.022, 0.84),
               (-0.045, 0.0)],)
    for i, clk in clocks:
        e = C.empty('clock_%d' % i, tuple(clk), parent=root, size=0.6, rot=(0, 0, 90 * i))
        for name, parts, y0, y1 in (('hand_h_%d', hour, 0.012, 0.03), ('hand_m_%d', minute, 0.036, 0.052)):
            hb = C.MeshBuilder()
            for k, pts in enumerate(parts):
                hb.poly_prism(pts, -y1 - 0.002 * k, -y0, a, axis='Y', uv=SW('ink'))
            if name.startswith('hand_m'):
                hb.cyl(0.075, 0.05, (0, -0.045, 0), a, axis='Y', seg=12, uv=SW('brass'))
            ob = hb.build(name % i)
            ob.parent = e
    return root


# ------------------------------------------------------------------ maple --

MAPLE_TOP = 0.32                 # the island's walkable top (kit slabs)
MAPLE_SWING = (2.6, 0.0, 5.2)    # kit (x, z) of the tyre swing's rope top, its height (the `swing` pivot)
MAPLE_CANOPY = 4.6               # nothing of the canopy hangs lower (players walk under it)
LEAF_SW = (('orange', 4), ('tangerine', 2), ('red', 3), ('gold', 3), ('yellow', 1), ('coral', 1), ('caramel', 1))


def blob(b, m, c, r, rng, seg=12, rings=8, lump=0.1, floor=None, top=None):
    """A lumpy foliage blob: a UV sphere (radii r) pushed in and out by a few smooth bumps, its
    underside flattened at floor(p) (a height or a function of the vertex) where it would dip
    below; faces turned to the sky take material `top` (a sunlit highlight)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    ph = [rng.uniform(0, 2 * math.pi) for _ in range(4)]
    for v in bm.verts:
        d = v.co.normalized()
        az, el = math.atan2(d.y, d.x), math.asin(max(-1.0, min(1.0, d.z)))
        k = 1.0 + lump * (math.sin(3 * az + ph[0]) * math.cos(2 * el + ph[1])
                          + 0.6 * math.sin(5 * az + 3 * el + ph[2]) + 0.4 * math.cos(2 * az - 4 * el + ph[3]))
        p = Vector(c) + Vector((d.x * r[0], d.y * r[1], d.z * r[2])) * k
        if floor is not None:
            p.z = max(p.z, floor(p) if callable(floor) else floor)
        v.co = p
    f0 = len(b.faces)
    b.add_bm(bm, m)
    if top is not None:
        mt = b._mi(top)
        for k in range(f0, len(b.faces)):
            if _newell([Vector(b.verts[i]) for i in b.faces[k]]).normalized().z > 0.6:
                b.fmat[k] = mt


def leaf(b, c, n, s, ang, sw):
    """A fallen leaf: a flat rhombus s long at Blender point c, in the plane facing n, turned by ang."""
    n = Vector(n).normalized()
    t = Vector((math.cos(ang), math.sin(ang), 0.0))
    t = (t - n * t.dot(n)).normalized()
    q = n.cross(t)
    c = Vector(c)
    flat_poly(b, [c - t * s / 2, c - q * s * 0.36, c + t * s / 2, c + q * s * 0.36], n, sw)


def build_lm_maple():
    """Maple Close's giant autumn maple on its raised round traffic island (kit setpieces.maple;
    origin = the island's ground centre): a stone kerb ring (r ~3.4, the slabs' top 0.32), grass and
    a ring of soil strewn with fallen leaves and two leaf piles, a gnarled trunk (r ~0.75, a root
    flare) forking into four big limbs at ~4.5 m, and the lumpy three-colour canopy (5..15 m, r
    ~6.5).  Nodes: `canopy` (all the foliage, Leaves / Leaves2 / Leaves3; pivot at the fork, on
    the trunk axis at 4.5 m) and `swing` (the tyre swing hanging from the low limb over kit (2.6, 0):
    pivot = the top of its ropes at 5.2 m, identity rest pose; the tyre at 0.6..1.0 m)."""
    a = A()
    rng = C.seeded(8201)
    b = C.MeshBuilder()
    TOP = MAPLE_TOP

    # ---- the island: kerb (stone blocks), grass, soil, fallen leaves, two leaf piles ------------
    seg = 36
    sheet(b, lathe_rows([(3.4, 0.0), (3.4, 0.27), (3.39, 0.305), (3.36, TOP), (3.0, TOP)], seg), a,
          lambda i, j: ('silver' if j % 2 else 'cloud') if i < 3 else 'cloud')
    flat_poly(b, lathe_rows([(3.005, TOP - 0.002)], seg)[0], (0, 0, 1), 'olive')
    soil = [Vector((math.cos(t) * r, math.sin(t) * r, TOP + 0.002)) for t, r in
            [(2 * math.pi * k / 14, rng.uniform(1.3, 1.6)) for k in range(14)]]
    flat_poly(b, soil, (0, 0, 1), 'brown')
    for k in range(104):
        r = math.sqrt(rng.uniform(1.0 ** 2, 3.3 ** 2))
        t = rng.uniform(0, 2 * math.pi)
        leaf(b, (r * math.cos(t), r * math.sin(t), TOP + 0.004 + 0.00015 * k), (0, 0, 1), rng.uniform(0.2, 0.32),
             rng.uniform(0, math.pi), wpick(rng, LEAF_SW))
    for (px, py, rx, ry, sw) in ((-1.65, 1.75, 0.82, 0.66, 'orange'), (1.15, -2.1, 0.72, 0.6, 'red')):
        hz = 0.11                 # soft: players wade through them
        b.sphere(1.0, (px, py, TOP - 0.02), a, seg=10, rings=6, scale=(rx, ry, hz + 0.02), cut_below=0.0, uv=SW(sw))
        for k in range(16):
            ang = rng.uniform(0, 2 * math.pi)
            rho = math.sqrt(rng.uniform(0.0, 0.75))
            dx, dy = rho * rx * math.cos(ang), rho * ry * math.sin(ang)
            dz = (hz + 0.02) * math.sqrt(max(0.0, 1 - rho * rho)) - 0.02
            nrm = Vector((dx / rx ** 2, dy / ry ** 2, (dz + 0.02) / (hz + 0.02) ** 2))
            leaf(b, (px + dx, py + dy, TOP + dz + 0.012), nrm, rng.uniform(0.2, 0.28), rng.uniform(0, math.pi),
                 wpick(rng, LEAF_SW))

    # ---- the trunk: gnarled rings, root buttresses, a burl with a knot hole ---------------------
    zs = [0.27, 0.34, 0.42, 0.56, 0.85, 1.3, 2.0, 2.7, 3.35, 3.9, 4.35, 4.75]
    rs = [0.98, 0.88, 0.79, 0.76, 0.75, 0.74, 0.73, 0.72, 0.72, 0.73, 0.7, 0.58]
    lobes = [1.45, 0.82, 0.3, 0.1]           # root buttresses: flat, spreading over the soil
    ph = rng.uniform(0, 2 * math.pi)
    rows = []
    for i_, (z, r) in enumerate(zip(zs, rs)):
        lob = lobes[i_] if i_ < len(lobes) else 0.0
        cx, cy = 0.06 * math.sin(1.3 * z), 0.05 * math.cos(0.9 * z + 1.0)
        row = []
        for k in range(12):
            t = 2 * math.pi * k / 12 + 0.06 * z
            rr = r * (1.0 + 0.22 * lob * max(0.0, math.cos(5 * (t - ph))) ** 2 + rng.uniform(-0.03, 0.03))
            row.append((cx + rr * math.cos(t), cy + rr * math.sin(t), z))
        rows.append(row)
    sheet(b, rows, a, lambda i, j: 'chocolate' if j % 3 == 1 and (i * 5 + j) % 7 else 'brown')
    flat_poly(b, rows[-1], (0, 0, 1), 'chocolate')
    b.sphere(1.0, (0.05, -0.7, 2.1), a, seg=8, rings=6, scale=(0.24, 0.14, 0.3), uv=SW('chocolate'))
    flat_poly(b, [Vector((0.05 + 0.1 * math.cos(t), -0.835, 2.1 + 0.15 * math.sin(t))) for t in
                  [2 * math.pi * k / 8 for k in range(8)]], (0, -1, 0), 'ink')

    # ---- limbs: four big ones up into the canopy (two branches each), the low swing limb --------
    def limb(ctrl, r0, r1, sides=7, sub=2):
        path = catmull(ctrl, sub)
        n = len(path)
        rows_ = tube_rows(path, [r0 + (r1 - r0) * i / (n - 1) for i in range(n)], sides)
        rows_.append([path[-1] + (path[-1] - path[-2]).normalized() * r1 * 1.2])
        sheet(b, rows_, a, 'brown')
        return path
    for az in (38, 142, 222, 312):
        d = Vector((math.cos(math.radians(az)), math.sin(math.radians(az)), 0.0))
        s = d.cross(Vector((0, 0, 1)))
        w = rng.uniform(-0.3, 0.3)
        ctrl = [d * 0.12 + Vector((0, 0, 4.2)), d * 1.1 + s * w * 0.5 + Vector((0, 0, 5.25)),
                d * 2.15 + s * w + Vector((0, 0, 6.6)), d * 3.0 + s * w * 0.6 + Vector((0, 0, 8.0)),
                d * 3.5 + Vector((0, 0, 9.3))]
        limb(ctrl, 0.44, 0.13)
        for base, sd, up in ((ctrl[2], 0.8, 1.0), (ctrl[3], -0.8, 1.3)):
            dd = (d + s * sd).normalized()
            limb([base, base + dd * 1.1 + Vector((0, 0, up * 0.8)), base + dd * 2.0 + Vector((0, 0, up * 1.9))],
                 0.17, 0.06, sides=5, sub=1)
    SR0, SR1 = 0.36, 0.1
    swing_path = limb([(0.35, 0.0, 3.95), (1.5, 0.12, 4.85), (2.6, 0.0, 5.42), (3.6, -0.25, 5.95), (4.5, -0.4, 6.7),
                       (5.2, -0.5, 7.7)], SR0, SR1)
    root = b.build('lm_maple')

    # ---- canopy: overlapping lumpy blobs in three autumn colours, nothing below 4.6 m -----------
    L1 = C.mat('Leaves', '#FF8A3D', rough=0.75)
    L2 = C.mat('Leaves2', '#E8503A', rough=0.75)
    L3 = C.mat('Leaves3', '#FFC23D', rough=0.75)
    sx_, sy_ = MAPLE_SWING[0], -MAPLE_SWING[1]

    def fl(p):                    # the canopy's flat underside (> MAPLE_CANOPY), lifted over the swing limb
        return 5.3 + 0.55 * max(0.0, 1.0 - math.hypot(p.x - sx_ * 0.8, p.y - sy_) / 2.4)
    cb = C.MeshBuilder()
    for k, m in enumerate((L2, L2, L1, L2, L2, L1, L2)):               # lower ring: reds
        t = math.radians(k * 360 / 7 + 12)
        blob(cb, m, (3.9 * math.cos(t), 3.9 * math.sin(t), 7.2 + rng.uniform(-0.15, 0.25)), (2.3, 2.3, 1.85), rng,
             seg=11, rings=7, lump=0.13, floor=fl, top=L1 if m is L2 else L3)
    for t in (60, 180, 300):                                           # under the middle
        t = math.radians(t)
        blob(cb, L2, (1.7 * math.cos(t), 1.7 * math.sin(t), 6.9), (1.9, 1.9, 1.5), rng, seg=9, rings=6, floor=fl)
    blob(cb, L1, (0.0, 0.0, 8.8), (3.5, 3.5, 2.8), rng, seg=10, rings=6, floor=fl)
    for k, m in enumerate((L1, L1, L3, L1, L2, L1)):                   # middle ring: oranges
        t = math.radians(k * 60 + 35)
        blob(cb, m, (3.5 * math.cos(t), 3.5 * math.sin(t), 9.6 + rng.uniform(-0.3, 0.3)), (2.6, 2.6, 2.2), rng,
             lump=0.13, floor=fl, top=L1 if m is L2 else L3)
    for k, m in enumerate((L3, L1, L3, L3, L1)):                       # upper ring: golds
        t = math.radians(k * 72 + 5)
        blob(cb, m, (2.1 * math.cos(t), 2.1 * math.sin(t), 12.0 + rng.uniform(-0.2, 0.2)), (2.3, 2.3, 2.0), rng,
             seg=11, rings=7, lump=0.13, floor=fl, top=L3)
    blob(cb, L3, (0.15, -0.1, 13.3), (2.0, 2.0, 1.7), rng, lump=0.12, floor=fl)
    cb.build('canopy', location=(0, 0, 4.5), parent=root)

    # ---- the tyre swing: two ropes from the low limb (wrapped round it), a tyre at 0.6..1.0 -----
    sb = C.MeshBuilder()
    piv = Vector(MAPLE_SWING[:1] + (-MAPLE_SWING[1], MAPLE_SWING[2]))

    def under(x):          # the limb's axis point over Blender x, its radius and direction there
        P = swing_path
        for i in range(len(P) - 1):
            if P[i].x <= x <= P[i + 1].x:
                t = (x - P[i].x) / (P[i + 1].x - P[i].x)
                r = SR0 + (SR1 - SR0) * (i + t) / (len(P) - 1)
                return P[i].lerp(P[i + 1], t), r, (P[i + 1] - P[i]).normalized()
        raise ValueError(x)
    tyre_c = Vector((piv.x, piv.y, 0.82))
    for dx in (-0.24, 0.24):
        p, r, ax = under(piv.x + dx)
        top = Vector((p.x, p.y, p.z - r + 0.03))
        bot = tyre_c + Vector((dx * 1.5, 0.0, 0.12))
        strut(sb, top, bot, 0.045, a, 'tan')
        sb.cyl(r + 0.025, 0.09, tuple(p), a, seg=8, caps=False,
               rot=Vector((0, 0, 1)).rotation_difference(ax).to_euler(), uv=SW('tan'))
    sb.torus(0.36, 0.13, tuple(tyre_c), a, seg=14, rseg=7, rot=(0, 6, 0), uv=SW('rubber'))
    sb.build('swing', location=tuple(piv), parent=root)
    return root


# --------------------------------------------------------------- mill yard --

def crate(b, x0, x1, z0, z1, y0, y1, brace=None, label=None):
    """A wooden crate over the kit ranges x0..x1, z0..z1, y0..y1: a planked body under darker edge
    boards (the top boards at y1, the collider's top), an optional diagonal brace on its front
    ('z') or left ('x') face, an optional label on the other."""
    a = A()
    t = 0.09
    kbox(b, x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02, y0, y1 - 0.02, a, uv=SW('wood'), cull=('-Z',))
    for xa, xb in ((x0, x0 + t), (x1 - t, x1)):
        for za, zb in ((z0, z0 + t), (z1 - t, z1)):
            kbox(b, xa, xb, za, zb, y0, y1, a, uv=SW('brown'), cull=('-Z',))
    for ya, yb in ((y0, y0 + t), (y1 - t, y1)):
        for za, zb in ((z0, z0 + t), (z1 - t, z1)):
            kbox(b, x0 + t, x1 - t, za, zb, ya, yb, a, uv=SW('brown'), cull=('-X', '+X'))
        for xa, xb in ((x0, x0 + t), (x1 - t, x1)):
            kbox(b, xa, xb, z0 + t, z1 - t, ya, yb, a, uv=SW('brown'), cull=('-Y', '+Y'))
    h = y1 - y0
    for f in (1 / 3, 2 / 3):       # plank seams on the four sides
        yy = y0 + h * f
        for (p, q, nrm) in (((x0 + t, z1 - 0.025), (x1 - t, z1 - 0.025), (0, -1, 0)),
                            ((x0 + t, z0 + 0.025), (x1 - t, z0 + 0.025), (0, 1, 0)),
                            ((x1 - 0.025, z0 + t), (x1 - 0.025, z1 - t), (1, 0, 0)),
                            ((x0 + 0.025, z0 + t), (x0 + 0.025, z1 - t), (-1, 0, 0))):
            flat_poly(b, [K(p[0], p[1], yy - 0.012), K(q[0], q[1], yy - 0.012), K(q[0], q[1], yy + 0.012),
                          K(p[0], p[1], yy + 0.012)], nrm, 'brown')
    if brace == 'z':
        o = K(x0 + t, z1 - 0.02, y0 + t)
        hexa(b, o, K(x1 - t - 0.11, z1 - 0.02, y1 - t) - o, Vector((0.11, 0, 0)), Vector((0, -0.025, 0)), a, uv=SW('brown'))
    elif brace == 'x':
        o = K(x1 - 0.02, z0 + t, y0 + t)
        hexa(b, o, K(x1 - 0.02, z1 - t - 0.11, y1 - t) - o, Vector((0, -0.11, 0)), Vector((0.025, 0, 0)), a, uv=SW('brown'))
    if label == 'z':
        b.quad(tuple(K((x0 + x1) / 2, z1 - 0.008, y0 + h * 0.5)), (1, 0, 0), (0, 0, 1), 0.56, 0.28, a, cell='label_beans')
    elif label == 'x':
        b.quad(tuple(K(x1 - 0.008, (z0 + z1) / 2, y0 + h * 0.5)), (0, 1, 0), (0, 0, 1), 0.56, 0.28, a, cell='label_beans')


def build_lm_millyard():
    """Millside's old mill yard (kit setpieces.millyard; origin = the set piece origin), every part
    on its kit box: the brick boiler house (centre (-3, -1), 12 x 9, Wall) with big arched windows,
    a rusty corrugated sliding door over the concrete loading dock (top 1.0, a yellow edge) and a
    flat tar roof (Roof; the walkable 4.6), the round brick chimney behind it (r 1.3 -> 0.95 at 24,
    dark bands, a sooty rim; empty `smoke` at its mouth, 24.2), the water tower (four steel legs to
    10.5, X-braced, a ladder, a catwalk) with its faded teal tank (10.5..14.2) and cone roof, two
    crates (steps up to the roof) and a pallet stack.  Its two oil drums are `drum` props (kit models),
    which cars knock flying."""
    W = M_wall('#fffaf2', 'brick')
    Rf = M_roof('#8c9bb5', 'roof_tar')
    a = A()
    rng = C.seeded(8301)
    b = C.MeshBuilder()
    X0, X1, Z0, Z1, HW, TOP = -9.0, 3.0, -5.5, 3.5, 4.36, 4.6

    # ---- boiler house: brick shell, concrete base course, coping, the tar roof (top 4.6) --------
    kbox(b, X0, X1, Z0, Z1, 0.0, HW, W, cull=('-Z', '+Z'))
    kbox(b, X0 - 0.05, X1 + 0.05, Z0 - 0.05, Z1 + 0.05, 0.0, 0.45, a, uv=SW('grey'), cull=('-Z', '+Z'))
    co = 0.1
    for xa, xb, za, zb in ((X0 - co, X1 + co, Z1 - 0.32, Z1 + co), (X0 - co, X1 + co, Z0 - co, Z0 + 0.32),
                           (X0 - co, X0 + 0.32, Z0 + 0.32, Z1 - 0.32), (X1 - 0.32, X1 + co, Z0 + 0.32, Z1 - 0.32)):
        kbox(b, xa, xb, za, zb, HW, TOP + 0.04, a, uv=SW('silver'))
    kbox(b, X0 + 0.32, X1 - 0.32, Z0 + 0.32, Z1 - 0.32, TOP - 0.1, TOP, Rf, cull=('-Z',))
    for xc, zc in ((-6.2, -1.0), (-3.0, -1.0), (0.2, -1.0)):           # flush skylights on the roof
        flat_poly(b, [K(xc - 1.3, zc - 0.75, TOP + 0.004), K(xc + 1.3, zc - 0.75, TOP + 0.004),
                      K(xc + 1.3, zc + 0.75, TOP + 0.004), K(xc - 1.3, zc + 0.75, TOP + 0.004)], (0, 0, 1), 'charcoal')
        for k in range(3):
            x = xc - 1.2 + k * 0.8
            flat_poly(b, [K(x + 0.04, zc - 0.65, TOP + 0.008), K(x + 0.76, zc - 0.65, TOP + 0.008),
                          K(x + 0.76, zc + 0.65, TOP + 0.008), K(x + 0.04, zc + 0.65, TOP + 0.008)], (0, 0, 1),
                      'glass' if (k + int(xc)) % 3 else 'sky')
    # brick piers: the four corners and between the window bays
    PO = 0.12
    for x, z in ((X0, Z0), (X0, Z1), (X1, Z0), (X1, Z1)):
        xo, xi = (x + PO, x - 0.45) if x == X1 else (x - PO, x + 0.45)
        zo, zi = (z + PO, z - 0.45) if z == Z1 else (z - PO, z + 0.45)
        kbox(b, min(xo, xi), max(xo, xi), min(zo, zi), max(zo, zi), 0.45, HW, W, cull=('-Z', '+Z'))
    for z in (-2.43, 0.44):
        kbox(b, X1 - 0.05, X1 + PO, z - 0.25, z + 0.25, 0.45, HW, W, cull=('-Z', '+Z'))
        kbox(b, X0 - PO, X0 + 0.05, z - 0.25, z + 0.25, 0.45, HW, W, cull=('-Z', '+Z'))
    for x in (-5.9, -3.0, -0.1):
        kbox(b, x - 0.25, x + 0.25, Z0 - PO, Z0 + 0.05, 0.45, HW, W, cull=('-Z', '+Z'))

    # ---- big arched windows (multi-pane, a few panes broken), the side door ---------------------
    def mill_win(face, plane, along):
        d, u = FU(face, plane, along)
        Mw = wall_frame(face, d)
        arch_window(b, Mw, u, 1.5, 1.7, 2.35, glass='glass', frame='sand', fw=0.2, proud=0.1, n=8,
                    bars=(('v', -0.43), ('v', 0.0), ('v', 0.43), ('h', 0.6), ('h', 1.2), ('h', 1.8)), glint=None)
        for _ in range(rng.choice((1, 2))):
            col, row = rng.randrange(4), rng.randrange(3)
            u0, v0_ = u - 0.85 + col * 0.43 + 0.04, 1.5 + row * 0.6 + 0.04
            flat_poly(b, [Mw @ Vector((u0, 0.014, v0_)), Mw @ Vector((u0 + 0.35, 0.014, v0_)),
                          Mw @ Vector((u0 + 0.35, 0.014, v0_ + 0.52)), Mw @ Vector((u0, 0.014, v0_ + 0.52))],
                      Mw.to_3x3() @ Vector((0, 1, 0)), 'slate')
    for x in (-6.7, 0.7):
        mill_win('-Y', -3.5, x)
    for y in (3.87, 1.0):
        mill_win('+X', 3.0, y)
    for y in (3.87, 1.0, -1.87):
        mill_win('-X', -9.0, y)
    for x in (-4.45, -1.55, 1.35):
        mill_win('+Y', 5.5, x)
    door(b, '+X', *FU('+X', 3.0, -1.87), 1.1, 2.2, 'door_red', frame='grey')
    b.decal('-Y', 3.5, 5.24, 2.15, 0.6, 0.8, 'poster_wanted', m=a)

    # ---- the corrugated sliding door (slid half a metre open), its track, the dark gap ----------
    yw, dx0, dx1 = -3.5, -4.2, -0.8
    n = 20
    for z0, z1, sw in ((1.0, 1.45, 'brown'), (1.45, 4.0, 'copper')):
        pts = [(dx0, yw - 0.02)] + [(dx0 + k * (dx1 - dx0) / n, yw - (0.05 if k % 2 == 0 else 0.11))
                                    for k in range(n + 1)] + [(dx1, yw - 0.02)]
        b.poly_prism(pts, z0, z1, a, axis='Z', uv=SW(sw))
    flat_poly(b, [(-4.7, yw - 0.012, 1.0), (-4.2, yw - 0.012, 1.0), (-4.2, yw - 0.012, 4.0), (-4.7, yw - 0.012, 4.0)],
              (0, -1, 0), 'ink')
    for x in (-4.78, -1.22):
        b.box((0.1, 0.08, 3.06), (x, yw - 0.04, 2.53), a, cull=('+Y',), uv=SW('grey'))
    for z in (1.62, 3.52):
        b.box((dx1 - dx0, 0.04, 0.1), ((dx0 + dx1) / 2, yw - 0.13, z), a, uv=SW('slate'))
    b.box((5.2, 0.14, 0.16), (-2.6, yw - 0.1, 4.12), a, uv=SW('charcoal'))
    for x in (dx0 + 0.4, dx1 - 0.4):
        b.cyl(0.08, 0.06, (x, yw - 0.17, 4.06), a, axis='Y', seg=8, uv=SW('steel'))
    b.box((0.05, 0.05, 0.75), (dx0 + 0.28, yw - 0.2, 2.45), a, uv=SW('charcoal'))
    sign(b, '-Y', -yw + 0.11, 2.5, 2.75, 1.4, 'sign_no_raccoons', proud=0.03)

    # ---- the loading dock: concrete, yellow edge, hazard band, rubber bumpers ------------------
    kbox(b, -7.0, 1.0, 3.5, 5.3, 0.0, 1.0, a, uv=SW('silver'), cull=('-Z',))
    flat_poly(b, [K(-7.0, 5.08, 1.004), K(1.0, 5.08, 1.004), K(1.0, 5.3, 1.004), K(-7.0, 5.3, 1.004)], (0, 0, 1), 'yellow')
    for xa, xb in ((-7.0, -6.8), (0.8, 1.0)):
        flat_poly(b, [K(xa, 3.5, 1.004), K(xb, 3.5, 1.004), K(xb, 5.08, 1.004), K(xa, 5.08, 1.004)], (0, 0, 1), 'yellow')
    flat_poly(b, [K(-7.0, 5.304, 0.74), K(1.0, 5.304, 0.74), K(1.0, 5.304, 0.98), K(-7.0, 5.304, 0.98)], (0, -1, 0), 'yellow')
    x = -6.9
    while x + 0.36 < 0.95:
        flat_poly(b, [K(x, 5.308, 0.74), K(x + 0.14, 5.308, 0.74), K(x + 0.3, 5.308, 0.98), K(x + 0.16, 5.308, 0.98)],
                  (0, -1, 0), 'ink')
        x += 0.42
    for x in (-5.8, -3.0, -0.2):
        kbox(b, x - 0.16, x + 0.16, 5.3, 5.42, 0.18, 0.66, a, uv=SW('rubber'), r=0.03, seg=1)

    # ---- pipes up the left wall (one with a valve), a flue into the chimney ---------------------
    for z, r, sw in ((0.94, 0.09, 'copper'), (2.8, 0.12, 'grey')):
        x = X1 + 0.12 + r
        b.cyl(r, 4.0, tuple(K(x, z, 2.0)), a, seg=8, uv=SW(sw))
        b.cyl(r, x - X1 + 0.02, tuple(K((X1 + x) / 2, z, 4.0 + r)), a, axis='X', seg=8, uv=SW(sw))
        b.sphere(r * 1.15, tuple(K(x, z, 4.0)), a, seg=8, rings=4, uv=SW(sw))
        for yy in (1.2, 2.8):
            b.box((x - X1, 0.05, 0.06), tuple(K((X1 + x) / 2, z, yy)), a, uv=SW('charcoal'))
    b.torus(0.2, 0.03, tuple(K(X1 + 0.48, 2.8, 3.0)), a, seg=10, rseg=4, rot=(0, 90, 0), uv=SW('red'))
    b.cyl(0.03, 0.14, tuple(K(X1 + 0.41, 2.8, 3.0)), a, axis='X', seg=6, uv=SW('red'))
    kbox(b, -8.15, -6.85, -5.95, -5.45, 2.3, 3.4, W)

    # ---- the chimney: concrete foot, tapered brick (tiled), dark bands, soot, corbelled rim ------
    cx, cz = -7.5, -7.0
    Mc = Matrix.Translation(K(cx, cz, 0.0))

    def rch(z):
        return 1.3 + (0.95 - 1.3) * z / 24.0
    seg = 20
    sheet(b, lathe_rows([(1.36, 0.0), (1.36, 0.92), (rch(1.0), 1.0)], seg, Mc), a, 'grey')
    zs = [1.0, 5.0, 9.0, 13.0, 17.0, 21.0, 23.2]
    tile = T.TEX['brick'].tile_m
    sheet(b, lathe_rows([(rch(z), z) for z in zs], seg, Mc), W,
          uvf=lambda i, j, p: (j / seg * 2 * math.pi * rch(zs[i]) / tile, zs[i] / tile))
    for zb in (7.5, 13.5, 19.0):
        sheet(b, lathe_rows([(rch(zb), zb), (rch(zb) + 0.06, zb + 0.06), (rch(zb + 0.4) + 0.06, zb + 0.34),
                             (rch(zb + 0.4), zb + 0.4)], seg, Mc), a, 'charcoal')
    low = [Mc @ Vector(((rch(21.5) + 0.012) * math.cos(2 * math.pi * j / seg), (rch(21.5) + 0.012) * math.sin(2 * math.pi * j / seg),
                        rng.uniform(21.2, 22.3))) for j in range(seg)]
    for p in low:
        rr = rch(p.z) + 0.012
        d = Vector((p.x - Mc.translation.x, p.y - Mc.translation.y, 0.0)).normalized()
        p.x, p.y = Mc.translation.x + d.x * rr, Mc.translation.y + d.y * rr
    sheet(b, [low, lathe_rows([(rch(23.2) + 0.012, 23.2)], seg, Mc)[0]], a, 'charcoal')
    sheet(b, lathe_rows([(rch(23.2), 23.2), (1.13, 23.36), (1.13, 23.84), (1.06, 24.0), (0.8, 24.0), (0.76, 23.8),
                         (0.0, 23.8)], seg, Mc), a, lambda i, j: 'charcoal' if i < 3 else 'ink')

    # ---- the water tower: footings, steel legs, X-braces, catwalk, tank, roof, ladders ----------
    TX, TZ = 7.0, -4.4
    legs = [(4.8, -2.2), (9.2, -2.2), (4.8, -6.6), (9.2, -6.6)]
    for x, z in legs:
        kbox(b, x - 0.36, x + 0.36, z - 0.36, z + 0.36, 0.0, 0.3, a, uv=SW('grey'), r=0.04, seg=1, edges='topvert', cull=('-Z',))
        kbox(b, x - 0.17, x + 0.17, z - 0.17, z + 0.17, 0.3, 10.36, a, uv=SW('slate'), cull=('-Z', '+Z'))
        kbox(b, x - 0.25, x + 0.25, z - 0.25, z + 0.25, 0.3, 0.42, a, uv=SW('slate'), cull=('-Z',))
    for (xa, za), (xb, zb) in ((legs[0], legs[1]), (legs[2], legs[3]), (legs[0], legs[2]), (legs[1], legs[3])):
        for t0, t1 in ((0.9, 5.6), (5.6, 10.3)):
            strut(b, K(xa, za, t0), K(xb, zb, t1), 0.07, a, 'steel')
            strut(b, K(xb, zb, t0), K(xa, za, t1), 0.07, a, 'steel')
        strut(b, K(xa, za, 5.6), K(xb, zb, 5.6), 0.11, a, 'slate')
    tc = K(TX, TZ, 0.0)
    Mt = Matrix.Translation(tc)
    b.cyl(3.4, 0.14, tuple(K(TX, TZ, 10.43)), a, seg=24, uv=SW('grey'))
    for k in range(12):
        t = 2 * math.pi * (k + 0.5) / 12
        p = tc + Vector((3.32 * math.cos(t), 3.32 * math.sin(t), 0.0))
        strut(b, p + Vector((0, 0, 10.5)), p + Vector((0, 0, 11.45)), 0.05, a, 'steel')
    for zr in (10.98, 11.45):
        b.cyl(3.32, 0.05, tuple(K(TX, TZ, zr)), a, seg=24, caps=False, uv=SW('steel'))
    sheet(b, lathe_rows([(2.7, 10.5), (2.7, 11.3), (2.7, 13.5), (2.7, 14.2)], 24, Mt), a,
          lambda i, j: 'mint' if ((j * 7 + i * 13) * 2654435761) % 100 < 16 else 'aqua')
    for zb in (11.3, 13.5):
        sheet(b, lathe_rows([(2.7, zb - 0.07), (2.735, zb - 0.04), (2.735, zb + 0.04), (2.7, zb + 0.07)], 24, Mt), a, 'slate')
    for k in range(8):           # rust streaks under the hoops and the roof (not over the graffiti)
        t = math.radians(rng.choice((-30, -10, 15, 40, 70, 110, 150, 175, 200, 300)) + rng.uniform(-6, 6))
        z0 = rng.choice((11.23, 13.43, 14.18))
        L = rng.uniform(0.35, 0.95)
        e = Vector((math.cos(t), math.sin(t), 0.0))
        tg = Vector((-e.y, e.x, 0.0))
        c = tc + e * 2.708
        flat_poly(b, [c + tg * 0.06 + Vector((0, 0, z0)), c - tg * 0.06 + Vector((0, 0, z0)),
                      c - tg * 0.02 + Vector((0, 0, z0 - L)), c + tg * 0.02 + Vector((0, 0, z0 - L))], e,
                  rng.choice(('brown', 'copper')))
    # RACCOONS RULE sprayed on the tank's front
    u0, v0, u1, v1 = T.atlas_rect('graffiti_raccoons_rule')
    ng, rg, am, span = 8, 2.712, math.radians(-104), 3.0 / 2.712
    fr = [tc + Vector((2.706 * math.cos(am + (k / ng - 0.5) * 3.2 / 2.706), 2.706 * math.sin(am + (k / ng - 0.5) * 3.2 / 2.706), z))
          for z in (11.55, 13.25) for k in range(ng + 1)]
    sheet(b, [fr[:ng + 1], fr[ng + 1:]], a, 'chocolate', wrap=False)
    off = len(b.verts)
    for z in (11.65, 13.15):
        for k in range(ng + 1):
            t = am + (k / ng - 0.5) * span
            b.verts.append(tuple(tc + Vector((rg * math.cos(t), rg * math.sin(t), z))))
    mi = b._mi(a)
    for k in range(ng):
        b.faces.append([off + k, off + k + 1, off + ng + 2 + k, off + ng + 1 + k])
        b.fmat.append(mi)
        b.uvs.append([(u0 + (u1 - u0) * k / ng, v0), (u0 + (u1 - u0) * (k + 1) / ng, v0),
                      (u0 + (u1 - u0) * (k + 1) / ng, v1), (u0 + (u1 - u0) * k / ng, v1)])
    b.log.append((2 * ng, 'AtlasTown'))
    sheet(b, lathe_rows([(2.7, 14.2), (2.86, 14.15), (2.9, 14.27), (0.24, 15.74), (0.0, 15.78)], 24, Mt), a, 'teal')
    b.cyl(0.07, 0.3, tuple(K(TX, TZ, 15.88)), a, seg=8, uv=SW('steel'))
    b.sphere(0.13, tuple(K(TX, TZ, 16.1)), a, seg=8, rings=5, uv=SW('steel'))
    # the ladder up the front-left leg's outside, on up the tank
    e = Vector((0.7071, -0.7071, 0.0))       # Blender plan direction from the tank axis to leg (9.2, -2.2)
    tg = Vector((-e.y, e.x, 0.0))
    lc = K(9.2, -2.2, 0.0) + e * 0.48
    for s in (-1, 1):
        strut(b, lc + tg * 0.22 * s, lc + tg * 0.22 * s + Vector((0, 0, 11.4)), 0.05, a, 'steel')
    for k in range(26):
        z = 0.4 + 0.4 * k
        strut(b, lc - tg * 0.22 + Vector((0, 0, z)), lc + tg * 0.22 + Vector((0, 0, z)), 0.035, a, 'steel')
    for z in (2.5, 5.0, 7.5, 10.0):
        strut(b, lc + Vector((0, 0, z)), K(9.2, -2.2, z), 0.04, a, 'steel')
    tl = tc + e * 2.86
    for s in (-1, 1):
        strut(b, tl + tg * 0.2 * s + Vector((0, 0, 10.5)), tl + tg * 0.2 * s + Vector((0, 0, 14.35)), 0.045, a, 'steel')
    for k in range(9):
        z = 10.9 + 0.4 * k
        strut(b, tl - tg * 0.2 + Vector((0, 0, z)), tl + tg * 0.2 + Vector((0, 0, z)), 0.03, a, 'steel')

    # ---- crates (kit (4.0, 2.4) 1.2 x 1.2 x 1.2; (4.0, 1.0) 1.2 x 1.4, two stacked to 2.4) ------
    crate(b, 3.4, 4.6, 1.8, 3.0, 0.0, 1.2, brace='x', label='z')
    crate(b, 3.4, 4.6, 0.3, 1.7, 0.0, 1.2, brace='z', label='x')
    crate(b, 3.4, 4.6, 0.3, 1.7, 1.2, 2.4, brace='x')

    # ---- the pallet stack (1.2 x 1.0 x 0.8) --------------------------------------------------------
    px, pz = -10.2, 5.4
    for k in range(5):
        y0 = k * 0.16
        jx, jz = (rng.uniform(-0.025, 0.025), rng.uniform(-0.025, 0.025)) if k < 4 else (0.0, 0.0)
        ins = 0.03 if k < 4 else 0.0
        x0, x1, z0, z1 = px - 0.6 + ins + jx, px + 0.6 - ins + jx, pz - 0.5 + ins + jz, pz + 0.5 - ins + jz
        kbox(b, x0, x1, z0, z1, y0 + 0.12, y0 + 0.16, a, uv=SW('wood'))
        for zc in (z0 + 0.06, (z0 + z1) / 2, z1 - 0.06):
            kbox(b, x0 + 0.02, x1 - 0.02, zc - 0.06, zc + 0.06, y0, y0 + 0.12, a, uv=SW('tan'))
    for k in range(4):
        x = px - 0.6 + 0.24 * (k + 1)
        flat_poly(b, [K(x - 0.015, z0, 0.804), K(x + 0.015, z0, 0.804), K(x + 0.015, z1, 0.804), K(x - 0.015, z1, 0.804)],
                  (0, 0, 1), 'brown')
    root = b.build('lm_millyard')
    C.empty('smoke', tuple(K(cx, cz, 24.2)), parent=root, size=0.5)
    return root


# ------------------------------------------------------------ raccoon sign --

def mirror_half(half):
    """A closed counter-clockwise outline from its right half [(x >= 0, z)], listed from the bottom
    centre round to the top centre (both on x = 0): the left half is the mirror image."""
    return list(half) + [(-x, z) for x, z in reversed(half[1:-1])]


def offset_poly(pts, d):
    """A closed counter-clockwise polygon [(x, z)] offset by d (> 0 outward), capped mitres."""
    P = [Vector(p) for p in pts]
    n = len(P)
    out = []
    for i in range(n):
        e0 = (P[i] - P[i - 1]).normalized()
        e1 = (P[(i + 1) % n] - P[i]).normalized()
        n0, n1 = Vector((e0.y, -e0.x)), Vector((e1.y, -e1.x))
        m = n0 + n1
        m = m.normalized() if m.length > 1e-6 else n0
        out.append(P[i] + m * (d / max(0.4, m.dot(n0))))
    return [tuple(p) for p in out]


def resample(pts, step, closed=True):
    """Points every `step` along a polyline (closed: back to the start)."""
    P = [Vector(p) for p in pts] + ([Vector(pts[0])] if closed else [])
    L = sum((P[i + 1] - P[i]).length for i in range(len(P) - 1))
    n = max(2, int(round(L / step)))
    out, seg, acc = [], 0, 0.0
    for k in range(n if closed else n + 1):
        s = L * k / n
        while seg < len(P) - 2 and acc + (P[seg + 1] - P[seg]).length < s:
            acc += (P[seg + 1] - P[seg]).length
            seg += 1
        ll = (P[seg + 1] - P[seg]).length
        out.append(P[seg].lerp(P[seg + 1], (s - acc) / ll if ll > 1e-9 else 0.0))
    return out


RS_POLE, RS_TOP = 8.5, 14.0
RS_HEAD = mirror_half([(0.0, 9.42), (0.62, 9.47), (1.22, 9.62), (1.78, 9.86), (2.28, 10.12), (3.18, 10.18), (2.72, 10.52),
                       (3.2, 10.84), (2.86, 11.12), (3.04, 11.5), (3.0, 11.9), (2.86, 12.28), (2.62, 12.62), (2.7, 13.0),
                       (2.66, 13.4), (2.5, 13.72), (2.25, 13.93), (1.95, 14.0), (1.65, 13.92), (1.4, 13.7), (1.24, 13.42),
                       (1.12, 13.18), (0.75, 13.12), (0.38, 13.08), (0.0, 13.07)])
RS_MASK = mirror_half([(0.0, 11.4), (0.45, 11.2), (1.0, 10.98), (1.6, 10.98), (2.12, 11.1), (2.6, 11.38), (2.76, 11.66),
                       (2.47, 11.92), (1.9, 12.12), (1.2, 12.16), (0.62, 12.02), (0.2, 11.88), (0.0, 11.88)])
RS_ARROW = [(-3.1, 8.5), (2.25, 8.5), (3.2, 9.0), (2.25, 9.5), (-3.1, 9.5), (-2.62, 9.0)]


def build_lm_racsign():
    """Raccoon Run's roadside pylon sign (kit setpieces.racsign; origin = the pole's foot): a dark
    purple steel pole (0.6 square, to 8.5) and, above it, `board`: a double-sided raccoon head cut
    out of a 0.7 m deep can (6.4 wide, ears to 14.0: grey face, white cheeks and brows, black mask,
    pink nose) over an arrow, the same on both faces.  Its children (identity transforms, pivot =
    the board's, the pole top): `neon_a` (NeonA, hot pink: the head's outline), `neon_b` (NeonB,
    cyan: the mask and the smile) and `bulbs` (Bulbs, warm chaser bulbs round the arrow)."""
    a = A()
    NA = M_glow('NeonA', '#FF7AC0', '#FF3D9E', 5.0)
    NB = M_glow('NeonB', '#8AF6FF', '#2EE8FF', 5.0)
    BU = M_glow('Bulbs', '#FFEDB0', '#FFC94D', 4.0)
    b = C.MeshBuilder()
    # ---- pole: concrete footing, purple steel, a collar, tags --------------------------------
    b.box((1.2, 1.2, 0.3), (0, 0, 0.15), a, r=0.05, seg=1, edges='topvert', cull=('-Z',), uv=SW('silver'))
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.cyl(0.04, 0.06, (sx * 0.42, sy * 0.42, 0.33), a, seg=6, uv=SW('steel'))
    b.box((0.76, 0.76, 0.1), (0, 0, 0.35), a, uv=SW('ink'))
    b.box((0.6, 0.6, RS_POLE - 0.4), (0, 0, (RS_POLE + 0.4) / 2), a, r=0.06, seg=1, edges='vert', cull=('-Z', '+Z'),
          uv=SW('grape'))
    b.box((0.72, 0.72, 0.18), (0, 0, RS_POLE - 0.09), a, uv=SW('ink'))
    b.decal('-Y', 0.3, 0.0, 1.75, 0.46, 0.46, 'graffiti_bandit', m=a)
    b.decal('+Y', 0.3, 0.0, 1.6, 0.46, 0.46, 'graffiti_nom', m=a)
    root = b.build('lm_racsign')

    # ---- the board: head + arrow cans, the face painted on both sides ------------------------
    bb = C.MeshBuilder()
    prism(bb, RS_HEAD, -0.35, 0.35, a, 'raccoon', 'grape', 'raccoon', matrix=Matrix.Rotation(math.radians(90), 4, 'X'))
    prism(bb, RS_ARROW, -0.3, 0.3, a, 'purple', 'grape', 'purple', matrix=Matrix.Rotation(math.radians(90), 4, 'X'))
    white = mirror_half([(0.0, 9.64), (0.72, 9.7), (1.38, 9.88), (1.95, 10.16), (2.45, 10.38), (2.9, 10.43), (2.6, 10.67),
                         (2.94, 10.95), (2.66, 11.2), (2.8, 11.46), (2.0, 11.2), (1.2, 11.05), (0.5, 11.15), (0.0, 11.25)])
    brow = [(0.55, 12.12), (1.2, 12.3), (1.95, 12.27), (2.5, 12.04), (2.05, 12.42), (1.2, 12.5), (0.5, 12.32)]
    stripe = [(-0.2, 12.0), (0.2, 12.0), (0.32, 12.6), (0.18, 13.0), (-0.18, 13.0), (-0.32, 12.6)]
    ear_rim = [(1.3, 13.2), (2.56, 13.12), (2.6, 13.42), (2.44, 13.72), (2.2, 13.9), (1.92, 13.95), (1.62, 13.86),
               (1.4, 13.62)]
    ear = [(1.55, 13.24), (2.36, 13.2), (2.38, 13.48), (2.22, 13.72), (1.96, 13.8), (1.7, 13.68)]

    def ell(cx, cz, rx, rz, n=10):
        return [(cx + rx * math.cos(2 * math.pi * k / n), cz + rz * math.sin(2 * math.pi * k / n)) for k in range(n)]
    nose = [(-0.4, 11.12), (0.4, 11.12), (0.32, 10.9), (0.0, 10.7), (-0.32, 10.9)]
    for sg in (-1, 1):
        def F(pts, off):
            return [Vector((x, sg * (0.35 + off), z)) for x, z in pts]
        N = (0, sg, 0)
        flat_poly(bb, F(white, 0.006), N, 'white')
        for mx in (1, -1):
            flat_poly(bb, F([(mx * x, z) for x, z in brow], 0.006), N, 'white')
            flat_poly(bb, F([(mx * x, z) for x, z in ear_rim], 0.004), N, 'white')
            flat_poly(bb, F([(mx * x, z) for x, z in ear], 0.008), N, 'raccoon_dark')
        flat_poly(bb, F(stripe, 0.006), N, 'raccoon_dark')
        flat_poly(bb, F(RS_MASK, 0.012), N, 'ink')
        for mx in (1, -1):
            flat_poly(bb, F(ell(mx * 1.4, 11.56, 0.36, 0.33), 0.018), N, 'white')
            flat_poly(bb, F(ell(mx * 1.4, 11.5, 0.2, 0.21, 8), 0.024), N, 'ink')
            flat_poly(bb, F(ell(mx * 1.47, 11.6, 0.065, 0.065, 6), 0.03), N, 'white')
        flip = Matrix.Rotation(math.radians(90), 4, 'X') if sg < 0 else RXM90
        prism(bb, nose if sg < 0 else [(x, -z) for x, z in nose], 0.0, 0.09, a, 'hotpink', 'hotpink', None,
              matrix=Matrix.Translation((0, sg * 0.36, 0)) @ flip)
        flat_poly(bb, F(ell(-0.12 if sg < 0 else 0.12, 11.0, 0.08, 0.05, 6), 0.105), N, 'white')
    board = bb.build('board', location=(0, 0, RS_POLE), parent=root)

    # ---- neon: pink round the head, cyan round the mask + the smile; bulbs round the arrow ------
    def tube(mb, m, pts2, sg, closed, r=0.05):
        pts3 = [Vector((p[0], sg * 0.41, p[1])) for p in pts2]
        rows = tube_rows(pts3, r, 4, normal=(0, sg, 0), closed=closed)
        sheet(mb, rows, m, None)
    na, nbm, bu = C.MeshBuilder(), C.MeshBuilder(), C.MeshBuilder()
    head_in = offset_poly(RS_HEAD, -0.16)
    mask_out = offset_poly(RS_MASK, 0.06)
    for sg in (-1, 1):
        tube(na, NA, head_in, sg, True)
        tube(nbm, NB, mask_out, sg, True)
        tube(nbm, NB, [(-0.72, 10.45), (-0.36, 10.2), (0.0, 10.4), (0.36, 10.2), (0.72, 10.45)], sg, False)
        tube(nbm, NB, [(0.0, 10.66), (0.0, 10.4)], sg, False)
        for p in resample(offset_poly(RS_ARROW, -0.17), 0.34):
            bulb(bu, BU, (p.x, sg * 0.3, p.y), (0, sg, 0))
    for mb, name in ((na, 'neon_a'), (nbm, 'neon_b'), (bu, 'bulbs')):
        ob = mb.build(name, location=(0, 0, RS_POLE))
        ob.parent = board
        ob.location = (0, 0, 0)
    return root


# -------------------------------------------------------------------- mast --

def build_lm_mast():
    """A downtown rooftop radio mast (no colliders; origin = the base plate's underside centre): a
    triangular steel lattice 14 m tall (1.0 a side at the base -> 0.4), red / white bands every 2 m,
    a railed platform at 9 m, two dish antennas, three panel antennas near the top and `beacon`
    (Beacon, emissive red; its node at the lamp's centre) on top of a 1.4 x 1.4 base plate."""
    a = A()
    BC = M_glow('Beacon', '#FF5A5A', '#FF2A2A', 5.0)
    b = C.MeshBuilder()
    H, B0, S0, S1 = 14.0, 0.1, 1.0, 0.4
    b.box((1.4, 1.4, B0), (0, 0, B0 / 2), a, r=0.03, seg=1, edges='topvert', cull=('-Z',), uv=SW('grey'))
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.cyl(0.04, 0.05, (sx * 0.58, sy * 0.58, B0 + 0.025), a, seg=6, uv=SW('steel'))

    def R(z):
        return (S0 + (S1 - S0) * (z - B0) / (H - B0)) / math.sqrt(3)
    angs = [math.radians(90 + 120 * k) for k in range(3)]

    def L(k, z, out=0.0):
        r = R(z) + out
        return Vector((r * math.cos(angs[k % 3]), r * math.sin(angs[k % 3]), z))
    for k in range(3):
        b.box((0.2, 0.2, 0.05), tuple(L(k, B0 + 0.025)), a, rot=(0, 0, math.degrees(angs[k])), uv=SW('slate'))
    n = 14
    zs = [B0 + (H - B0) * s / n for s in range(n + 1)]
    for k in range(3):
        strut(b, L(k, zs[0]), L(k + 1, zs[0]), 0.04, a, 'red')
    for s in range(n):
        z0, z1 = zs[s], zs[s + 1]
        sw = 'red' if int(((z0 + z1) / 2) // 2) % 2 == 0 else 'white'
        for k in range(3):
            strut(b, L(k, z0), L(k, z1), 0.075 - 0.03 * s / n, a, sw)
            strut(b, L(k, z1), L(k + 1, z1), 0.035, a, sw)
            if s % 2 == 0:
                strut(b, L(k, z0), L(k + 1, z1), 0.03, a, sw)
            else:
                strut(b, L(k + 1, z0), L(k, z1), 0.03, a, sw)
    # platform at 9 m: a grating with a yellow rail
    pr = R(9.0) + 0.5
    tri = [(pr * math.cos(t), pr * math.sin(t)) for t in angs]
    prism(b, tri, 8.95, 9.0, a, 'grey', 'charcoal', 'charcoal')
    corners = [Vector((x, y, 9.0)) for x, y in tri]
    for k in range(3):
        p, q = corners[k], corners[(k + 1) % 3]
        for t in (0.0, 0.5):
            c = p.lerp(q, t)
            strut(b, c, c + Vector((0, 0, 0.95)), 0.04, a, 'yellow')
        strut(b, p + Vector((0, 0, 0.95)), q + Vector((0, 0, 0.95)), 0.04, a, 'yellow')
        strut(b, p + Vector((0, 0, 0.5)), q + Vector((0, 0, 0.5)), 0.03, a, 'yellow')

    # dishes: closed lathes (back pole -> rim -> front pole), feed horn on three struts
    def dish(c, nrm, rr=0.45, f=0.32, seg=12):
        M = Matrix.Translation(c) @ Vector((0, 0, 1)).rotation_difference(Vector(nrm).normalized()).to_matrix().to_4x4()
        dep = rr * rr / (4 * f)
        prof = [(0.0, -0.07), (0.17, -0.055), (0.33, -0.01), (rr + 0.02, dep - 0.015), (rr, dep), (0.3, 0.09 / (4 * f)),
                (0.15, 0.0225 / (4 * f)), (0.0, 0.0)]
        sheet(b, lathe_rows(prof, seg, M), a, lambda i, j: 'cloud' if i < 3 else 'white')
        fp = M @ Vector((0, 0, f))
        for k in range(3):
            t = 2 * math.pi * k / 3 + 0.5
            strut(b, M @ Vector((rr * 0.95 * math.cos(t), rr * 0.95 * math.sin(t), dep)), fp, 0.018, a, 'grey')
        b.box((0.09, 0.09, 0.12), tuple(fp), a, rot=Vector((0, 0, 1)).rotation_difference(Vector(nrm)).to_euler(),
              uv=SW('grey'))
        return M @ Vector((0, 0, -0.07))
    for k, z, yaw, tilt in ((2, 11.0, 0.0, -6.0), (1, 7.2, 25.0, 4.0)):
        d = Vector((math.cos(angs[k]), math.sin(angs[k]), 0.0))
        d = Matrix.Rotation(math.radians(yaw), 3, 'Z') @ d
        nrm = (d + Vector((0, 0, math.tan(math.radians(tilt))))).normalized()
        back = dish(L(k, z) + d * 0.62, nrm)
        strut(b, back, L(k, z), 0.05, a, 'grey')
        strut(b, back - Vector((0, 0, 0.02)), L(k, z - 0.5), 0.03, a, 'grey')
    # panel antennas on the three faces near the top
    for k in range(3):
        p, q = L(k, 13.1), L(k + 1, 13.1)
        mid = (p + q) / 2
        o = Vector((mid.x, mid.y, 0.0)).normalized()
        b.box((0.26, 0.09, 0.95), tuple(mid + o * 0.16), a, rot=(0, 0, math.degrees(math.atan2(o.y, o.x)) - 90),
              r=0.02, seg=1, uv=SW('white'))
        for zz in (12.8, 13.4):
            strut(b, Vector((mid.x, mid.y, zz)), mid + o * 0.12 + Vector((0, 0, zz - 13.1)), 0.03, a, 'grey')
    # cap plate + beacon base (the lamp itself is the `beacon` node)
    capr = R(H) + 0.1
    prism(b, [(capr * math.cos(t), capr * math.sin(t)) for t in angs], H, H + 0.05, a, 'charcoal', 'charcoal', 'charcoal')
    b.cyl(0.15, 0.1, (0, 0, H + 0.1), a, seg=10, uv=SW('charcoal'))
    b.cyl(0.05, 0.04, (0, 0, H + 0.55), a, seg=8, uv=SW('charcoal'))
    root = b.build('lm_mast')
    bb = C.MeshBuilder()
    sheet(bb, lathe_rows([(0.0, H + 0.15), (0.18, H + 0.15), (0.2, H + 0.28), (0.175, H + 0.42), (0.095, H + 0.51),
                          (0.0, H + 0.535)], 10), BC, None)
    bb.build('beacon', location=(0, 0, H + 0.33), parent=root)
    return root


# ===========================================================================
# registry
# ===========================================================================

# name: (builder, category, collision (w, l, h))
ASSETS = {
    'car_hatch': (build_car_hatch, 'vehicles', (2.0, 3.8, 1.45)),
    'car_taxi': (build_car_taxi, 'vehicles', (2.0, 4.2, 1.5)),
    'car_pest': (build_car_pest, 'vehicles', (2.0, 4.2, 1.5)),
    'car_van': (build_car_van, 'vehicles', (2.2, 4.8, 2.2)),
    'car_garbage': (build_car_garbage, 'vehicles', (2.5, 6.6, 2.8)),
    'train_loco': (build_train_loco, 'trains', (2.6, 7.5, 3.0)),
    'train_wagon': (build_train_wagon, 'trains', (2.6, 8.0, 3.0)),
    'bld_house': (build_bld_house, 'buildings', (9.0, 9.0, 8.0)),
    'bld_shop': (build_bld_shop, 'buildings', (12.0, 9.0, 6.0)),
    'bld_apartment': (build_bld_apartment, 'buildings', (12.0, 12.0, 14.0)),
    'bld_tower': (build_bld_tower, 'buildings', (14.0, 14.0, 26.0)),
    'bld_donut': (build_bld_donut, 'buildings', (10.0, 10.0, 5.0)),
    'bld_station': (build_bld_station, 'buildings', (4.0, 30.0, 4.2)),
    'dumpster': (build_dumpster, 'trash', (1.9, 1.1, 1.3)),
    'dumpster_gold': (build_dumpster_gold, 'trash', (2.0, 1.3, 1.4)),
    'trash_bags': (build_trash_bags, 'trash', (1.2, 0.9, 0.6)),
    'bld_demolished': (build_bld_demolished, 'ruins', (14.4, 13.4, 11.2)),
    'crane': (build_crane, 'ruins', (0.9, 0.9, 22.0)),
    'bld_collapsed': (build_bld_collapsed, 'ruins', (12.0, 12.0, 7.5)),
    'bld_shell': (build_bld_shell, 'ruins', (12.0, 10.0, 4.2)),
    'sinkhole': (build_sinkhole, 'ruins', (21.8, 8.0, 1.0)),
    'lm_clocktower': (build_lm_clocktower, 'landmarks', (6.0, 6.0, 16.8)),
    'lm_maple': (build_lm_maple, 'landmarks', (6.1, 6.1, 6.0)),
    'lm_millyard': (build_lm_millyard, 'landmarks', (21.6, 16.6, 24.0)),
    'lm_racsign': (build_lm_racsign, 'landmarks', (6.4, 0.7, 14.0)),
    'lm_mast': (build_lm_mast, 'landmarks', (1.4, 1.4, 14.0)),
}


# ===========================================================================
# export / verification / previews
# ===========================================================================

def b2g(v):
    """Blender Z-up -> glTF Y-up (front -Y -> +Z)."""
    return [v[0], v[2], -v[1]]


def read_glb_json(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, length = struct.unpack_from('<III', data, 0)
    clen, ctype = struct.unpack_from('<II', data, 12)
    return json.loads(data[20:20 + clen].decode('utf-8'))


def verify_glb(name, path, spec):
    """Re-import the GLB in a fresh scene, print nodes/bounds, return meta."""
    C.reset_scene()
    bpy.ops.import_scene.gltf(filepath=path)
    objs = list(bpy.context.scene.objects)
    meshes = [o for o in objs if o.type == 'MESH']
    mn, mx = C.world_bounds(meshes)
    tris = sum(C.tri_count(o) for o in meshes)
    gj = read_glb_json(path)
    node_names = [n.get('name', '') for n in gj.get('nodes', [])]
    mat_names = [m.get('name', '') for m in gj.get('materials', [])]
    print(f"[verify] {name}: {len(objs)} objects, tris={tris}")
    print(f"         bounds blender min={tuple(round(c, 3) for c in mn)} max={tuple(round(c, 3) for c in mx)}")
    nodes = []
    for o in sorted(objs, key=lambda o: o.name):
        wl = o.matrix_world.translation
        info = {'name': o.name, 'type': o.type.lower(),
                'parent': o.parent.name if o.parent else None,
                'position': [round(c, 4) for c in b2g(wl)]}
        line = f"         node {o.name:14s} {o.type:6s} parent={info['parent']} pos(gltf)={info['position']}"
        if o.type == 'MESH':
            bmn, bmx = C.world_bounds([o])
            lc = (bmn + bmx) / 2 - wl
            info['tris'] = C.tri_count(o)
            line += f" tris={info['tris']} localCenterOffset={tuple(round(c, 3) for c in lc)}"
        print(line)
        nodes.append(info)
    w, l, h = spec
    gmin = [mn.x, mn.z, -mx.y]
    gmax = [mx.x, mx.z, -mn.y]
    meta = {
        'name': name,
        'file': os.path.basename(path),
        'bboxMin': [round(c, 4) for c in gmin],
        'bboxMax': [round(c, 4) for c in gmax],
        'size': [round(gmax[i] - gmin[i], 4) for i in range(3)],
        'collisionSpec': {'width_x': w, 'length_z': l, 'height_y': h},
        'triangles': tris,
        'nodes': node_names,
        'nodeInfo': nodes,
        'materials': mat_names,
    }
    return meta, (mn, mx)


# ---------------------------------------------------------------- previews --

def setup_render(res=(560, 420)):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    try:
        sc.eevee.taa_render_samples = 24
    except Exception:
        pass
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    world = bpy.data.worlds.new('PreviewWorld')
    sc.world = world
    if world.node_tree is None:  # 5.x creates the tree already; use_nodes is deprecated
        world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (*C.hex_lin('#cfe6fa'), 1.0)
    bg.inputs['Strength'].default_value = 0.75
    sun_d = bpy.data.lights.new('Sun', 'SUN')
    sun_d.energy = 2.6
    sun_d.angle = math.radians(8)
    sun = bpy.data.objects.new('Sun', sun_d)
    sun.rotation_euler = (math.radians(40), math.radians(-10), math.radians(-35))
    sc.collection.objects.link(sun)



def _tmp_png(tag):
    import tempfile
    d = bpy.app.tempdir or tempfile.gettempdir()
    return os.path.join(d, 'vb_%s_%d.png' % (tag, os.getpid()))


def _place(tmp, dst):
    import shutil
    import time
    for attempt in range(10):
        try:
            shutil.copyfile(tmp, dst)
            os.remove(tmp)
            return
        except OSError as e:
            if attempt == 9:
                raise
            print("   [preview] %s busy (%s), retrying" % (os.path.basename(dst), e))
            time.sleep(1.0 + attempt)


def render_png(dst):
    tmp = _tmp_png('render')
    bpy.context.scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    _place(tmp, dst)


PREVIEW_HOLES = {'sinkhole': (-8.0, 8.0, -4.0, 4.0)}   # Blender x0, x1, y0, y1 of a pit in the preview ground


def preview_tile(name, spec, bounds, out_png, view='front', show_box=False):
    mn, mx = bounds
    w, l, h = spec
    sc = bpy.context.scene
    # ground
    g = C.MeshBuilder()
    size = max(w, l, h) * 4 + 10
    gm = C.mat('_Ground', '#b9d9c2', rough=0.8)
    hole = PREVIEW_HOLES.get(name)
    if hole is None:
        g.box((size, size, 0.02), (0, 0, -0.011), gm)
    else:   # the model goes below the ground there (the sinkhole): leave it a hole
        x0, x1, y0, y1 = hole
        s = size / 2
        for bx0, bx1, by0, by1 in ((-s, x0, -s, s), (x1, s, -s, s), (x0, x1, -s, y0), (x0, x1, y1, s)):
            g.box((bx1 - bx0, by1 - by0, 0.02), ((bx0 + bx1) / 2, (by0 + by1) / 2, -0.011), gm)
    gob = g.build('_ground')
    tmp = [gob]
    # footprint outline on the ground always; full collision box optionally
    wire = C.mat('_Wire', '#ff2fa0', rough=0.5, emit='#ff2fa0', strength=1.0)
    t = max(0.02, max(w, l) * 0.004)
    b = C.MeshBuilder()
    corners = [(-w / 2, -l / 2), (w / 2, -l / 2), (w / 2, l / 2), (-w / 2, l / 2)]
    zs = (0.005, h) if show_box else (0.005,)
    for z in zs:
        for i in range(4):
            a, c = corners[i], corners[(i + 1) % 4]
            b.beam((a[0], a[1], z), (c[0], c[1], z), t, t, wire)
    if show_box:
        for a in corners:
            b.beam((a[0], a[1], 0), (a[0], a[1], h), t, t, wire)
    tmp.append(b.build('_wire'))
    # camera
    lo = Vector((min(mn.x, -w / 2), min(mn.y, -l / 2), 0))
    hi = Vector((max(mx.x, w / 2), max(mx.y, l / 2), max(mx.z, h)))
    center = (lo + hi) / 2
    cam_d = bpy.data.cameras.new('Cam')
    cam_d.lens = 50
    cam = bpy.data.objects.new('Cam', cam_d)
    sc.collection.objects.link(cam)
    if view == 'front':
        d = Vector((0.62, -1.0, 0.55)).normalized()
    else:
        d = Vector((-0.62, 1.0, 0.6)).normalized()
    q = (-d).to_track_quat('-Z', 'Y')
    right = q @ Vector((1, 0, 0))
    up = q @ Vector((0, 1, 0))
    th = 18 / 50
    tv = th * sc.render.resolution_y / sc.render.resolution_x
    dist = 0.0
    for cx in (lo.x, hi.x):
        for cy in (lo.y, hi.y):
            for cz in (lo.z, hi.z):
                p = Vector((cx, cy, cz)) - center
                dist = max(dist, abs(p.dot(right)) / th + p.dot(d), abs(p.dot(up)) / tv + p.dot(d))
    cam.location = center + d * dist * 1.06
    cam.rotation_euler = q.to_euler()
    sc.camera = cam
    render_png(out_png)
    for o in tmp + [cam]:
        bpy.data.objects.remove(o, do_unlink=True)


def contact_sheet(tiles, cols, out_png):
    import numpy as np
    imgs = []
    for p in tiles:
        im = bpy.data.images.load(p)
        w, h = im.size
        arr = np.empty(w * h * 4, dtype=np.float32)
        im.pixels.foreach_get(arr)
        imgs.append(arr.reshape(h, w, 4))
        bpy.data.images.remove(im)
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.ones((rows * h, cols * w, 4), dtype=np.float32)
    for i, a in enumerate(imgs):
        r, c = divmod(i, cols)
        # image rows are bottom-up; place first row at the top
        rr = rows - 1 - r
        sheet[rr * h:(rr + 1) * h, c * w:(c + 1) * w] = a
    out = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    tmp = _tmp_png('sheet')
    out.filepath_raw = tmp
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    _place(tmp, out_png)



# ------------------------------------------------------- extra previews --
RACCOON_GLB = os.path.join(OUT_DIR, 'raccoon.glb')
# CarView / Animator "sit" pose (radians about each node's local glTF X = Blender X)
SIT_POSE = {'leg_l': -1.45, 'leg_r': -1.45, 'foot_l': 1.3, 'foot_r': 1.3, 'arm_l': -1.2,
            'arm_r': -1.2, 'forearm_l': -0.5, 'forearm_r': -0.5, 'ear_l': 0.4, 'ear_r': 0.4,
            'tail_0': -0.4}
CARS = ('car_hatch', 'car_taxi', 'car_pest', 'car_van', 'car_garbage')


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def base(o):
    return o.name.split('.')[0]


def find_obj(objs, name):
    return next((o for o in objs if base(o) == name), None)


def seat_raccoon(seat):
    """raccoon.glb on the `seat` node exactly as CarView.setDriver does it (scale 0.92, feet
    (0.34 - 0.07) * scale below the seat node), in the Animator's sit pose."""
    from mathutils import Matrix, Quaternion
    objs = import_glb(RACCOON_GLB)
    root = next(o for o in objs if o.parent is None)
    for o in objs:
        if base(o).startswith('acc_') and base(o) != 'acc_bandana':
            o.hide_render = True
        if base(o) in SIT_POSE:
            o.rotation_mode = 'QUATERNION'
            o.rotation_quaternion = o.rotation_quaternion @ Quaternion((1, 0, 0), SIT_POSE[base(o)])
    s = 0.92
    root.parent = seat
    root.matrix_parent_inverse = Matrix.Identity(4)
    root.location = (0, 0, -(0.34 - 0.07) * s)
    root.rotation_mode = 'QUATERNION'
    root.rotation_quaternion = (1, 0, 0, 0)
    root.scale = (s, s, s)
    return objs


def game_camera(focus, height_m=None, dist=25.0, pitch=0.88, fov_deg=36.0, name='GameCam'):
    """The game's camera (CameraRig: pitch 0.88 rad, 25 m, 36 deg vertical FOV, looking
    north = glTF -Z = Blender +Y).  height_m: crop to that many metres of view height at the
    focus (same viewpoint and direction, i.e. a zoomed crop of the game frame)."""
    cam_d = bpy.data.cameras.new(name)
    cam_d.sensor_fit = 'VERTICAL'
    cam_d.angle_y = (2 * math.atan(height_m / 2 / dist)) if height_m else math.radians(fov_deg)
    cam_d.clip_start = 1.0
    cam_d.clip_end = 400.0
    cam = bpy.data.objects.new(name, cam_d)
    bpy.context.scene.collection.objects.link(cam)
    d = Vector((0, math.cos(pitch), -math.sin(pitch)))
    cam.location = Vector(focus) - d * dist
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    return cam


def ground(size=80.0, color='#b9d9c2'):
    g = C.MeshBuilder()
    g.box((size, size, 0.02), (0, 0, -0.011), C.mat('_Ground', color, rough=0.8))
    return g.build('_ground')


def render_to(path):
    render_png(path)



# preview-only wall tints (the game picks one of map.ts WALL_TINTS per building)
PREVIEW_TINT = {'bld_house': '#ffe8a3', 'bld_shop': '#a8e6cf', 'bld_apartment': '#ffb3c7',
                'bld_tower': '#a0d8ff', 'bld_donut': '#fff5e1',
                'bld_demolished': '#a0d8ff', 'bld_collapsed': '#ffe8a3', 'bld_shell': '#8a8494',
                'lm_clocktower': '#f2a283', 'lm_millyard': '#e3907a'}


def tint_material(name, hexcol):
    """Set an imported material's base colour factor (Mix-multiply A colour / BSDF colour)."""
    m = bpy.data.materials.get(name)
    if m is None or m.node_tree is None:
        return
    col = (*C.hex_lin(hexcol), 1.0)
    for n in m.node_tree.nodes:
        if n.type == 'MIX' and getattr(n, 'blend_type', '') == 'MULTIPLY':
            for sock in n.inputs:
                if sock.type == 'RGBA' and not sock.is_linked:
                    sock.default_value = col
        elif n.type == 'BSDF_PRINCIPLED' and not n.inputs['Base Color'].is_linked:
            n.inputs['Base Color'].default_value = col
        elif n.type == 'RGB':
            n.outputs[0].default_value = col


def show_one_shopsign(keep='shopsign_pizza'):
    for o in bpy.context.scene.objects:
        if base(o).startswith('shopsign_'):
            o.hide_render = base(o) != keep


def draw_slots():
    """Coloured plaques on every decal_slot_* empty (unit square in its local XZ plane, so
    the empty's (w, 1, h) scale gives the free area)."""
    cols = ['#ff2fa0', '#2f8cff', '#ffa020', '#18c060', '#a040ff', '#ff4020']
    out = []
    for o in list(bpy.context.scene.objects):
        if base(o).startswith('decal_slot'):
            i = int(base(o).split('_')[-1])
            m = C.mat('_Slot%d' % (i % 6), cols[i % 6], emit=cols[i % 6], strength=0.5)
            mb = C.MeshBuilder()
            mb.box((1.0, 0.01, 1.0), (0, 0, 0), m)
            ob = mb.build('_slot%d' % i)
            ob.matrix_world = o.matrix_world
            out.append(ob)
    return out


def preview_shop_signs(out_png, tile_dir):
    """The shop's rooftop board with each shopsign_* variant (game camera angle, cropped)."""
    tiles = []
    for name in SHOP_SIGNS:
        C.reset_scene()
        setup_render((480, 300))
        import_glb(os.path.join(OUT_DIR, 'bld_shop.glb'))
        tint_material('Wall', PREVIEW_TINT['bld_shop'])
        show_one_shopsign('shopsign_' + name)
        ground()
        game_camera((0, -3.0, 4.2), height_m=7.5)
        p = os.path.join(tile_dir, 'bld_shop_sign_%s.png' % name)
        render_to(p)
        tiles.append(p)
    contact_sheet(tiles, 5, out_png)
    print(f"[preview] {os.path.basename(out_png)}")


def preview_car_gameview(names, out_png, tile_dir):
    """Rows = cars, columns = headings (front toward the camera, driver side, 3/4, rear), each a
    crop of the game camera's view with raccoon.glb sat at `seat`: the driver must show
    through the Glass.  Plus one uncropped 36 deg frame of all four parked in a row."""
    tiles = []
    for name in names:
        path = os.path.join(OUT_DIR, name + '.glb')
        for yaw in (0, -90, -40, 180):
            C.reset_scene()
            setup_render((480, 360))
            objs = import_glb(path)
            root = next(o for o in objs if o.parent is None)
            seat_raccoon(find_obj(objs, 'seat'))
            root.rotation_mode = 'XYZ'
            root.rotation_euler = (0, 0, math.radians(yaw))
            ground()
            van = name == 'car_van'
            if name == 'car_garbage':
                game_camera((0, 0, 1.5), height_m=8.4)
            else:
                game_camera((0, 0, 1.2 if van else 0.8), height_m=6.2 if van else 4.6)
            p = os.path.join(tile_dir, f'{name}_game_{yaw}.png')
            render_to(p)
            tiles.append(p)
    contact_sheet(tiles, 4, out_png)
    print(f"[preview] {os.path.basename(out_png)}")
    # true game framing (36 deg, 25 m): the four cars parked side by side, drivers aboard
    C.reset_scene()
    setup_render((1280, 720))
    for i, name in enumerate(names):
        objs = import_glb(os.path.join(OUT_DIR, name + '.glb'))
        root = next(o for o in objs if o.parent is None)
        seat_raccoon(find_obj(objs, 'seat'))
        root.location = ((i - (len(names) - 1) / 2) * 5.4, 0, 0)
        root.rotation_mode = 'XYZ'
        root.rotation_euler = (0, 0, math.radians((0, -90, -40, 180)[i % 4]))
    ground(120)
    game_camera((0, 0, 0.0))
    full = out_png.replace('.png', '_full.png')
    render_to(full)
    print(f"[preview] {os.path.basename(full)}")


def preview_steering(names, out_png, tile_dir):
    """steer_wheel alone, seen down its column from the driver, at glTF rotation.z = +90, 0,
    -90 deg (what CarView sets for steer = -0.98, 0, +0.98).  The magenta ring + tick are
    fixed at the rest pose: the rim must spin in place inside the ring."""
    from mathutils import Matrix, Quaternion
    tiles = []
    for name in names:
        for phi in (90, 0, -90):
            C.reset_scene()
            setup_render((360, 360))
            bg = bpy.context.scene.world.node_tree.nodes['Background']
            bg.inputs['Color'].default_value = (1, 1, 1, 1)
            objs = import_glb(os.path.join(OUT_DIR, name + '.glb'))
            sw = find_obj(objs, 'steer_wheel')
            col = sw.parent
            for o in objs:
                if o.type == 'MESH' and o is not sw:
                    o.hide_render = True
            sw.rotation_mode = 'QUATERNION'
            sw.rotation_quaternion = Quaternion((0, -1, 0), math.radians(phi))   # glTF +Z = Blender -Y
            bpy.context.view_layer.update()
            M = col.matrix_world.normalized()
            R3 = M.to_3x3()
            c = M.translation
            ref = C.MeshBuilder()
            rm = C.mat('_Ref', '#ff2fa0', emit='#ff2fa0', strength=1.0)
            ref.torus(0.205, 0.006, (0, 0, 0), rm, seg=48, rseg=4, rot=(90, 0, 0))
            ref.beam((0, 0.06, 0.20), (0, 0.06, 0.24), 0.012, 0.012, rm)   # 12 o'clock tick
            rob = ref.build('_ref')
            rob.matrix_world = M
            cam_d = bpy.data.cameras.new('SteerCam')
            cam_d.type = 'ORTHO'
            cam_d.ortho_scale = 0.56
            cam = bpy.data.objects.new('SteerCam', cam_d)
            bpy.context.scene.collection.objects.link(cam)
            zc = (R3 @ Vector((0, 1, 0))).normalized()        # toward the driver
            yc = (R3 @ Vector((0, 0, 1))).normalized()        # the column's up = glTF local +Y
            xc = yc.cross(zc).normalized()
            rot = Matrix((xc, yc, zc)).transposed().to_4x4()
            cam.matrix_world = Matrix.Translation(c + zc * 1.5) @ rot
            bpy.context.scene.camera = cam
            p = os.path.join(tile_dir, f'{name}_steer_{phi}.png')
            render_to(p)
            tiles.append(p)
    contact_sheet(tiles, 3, out_png)
    print(f"[preview] {os.path.basename(out_png)}")


# ===========================================================================
# main
# ===========================================================================

def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = None
    preview = True
    preview_only = False
    i = 0
    while i < len(argv):
        if argv[i] == '--only':
            only = argv[i + 1].split(',')
            i += 1
        elif argv[i] == '--no-preview':
            preview = False
        elif argv[i] == '--preview-only':   # re-render previews from the existing GLBs
            preview_only = True
        i += 1
    return only, preview, preview_only


def main():
    only, preview, preview_only = parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    names = [n for n in ASSETS if only is None or n in only]
    metas = {}
    if only is not None and os.path.exists(META_PATH):
        with open(META_PATH) as f:
            for a in json.load(f).get('assets', []):
                metas[a['name']] = a
    built = {}
    for name in names:
        fn, cat, spec = ASSETS[name]
        if preview_only:
            built[name] = (os.path.join(OUT_DIR, name + '.glb'), cat, spec)
            continue
        C.reset_scene()
        root = fn()
        bpy.context.view_layer.update()
        objs = C.hierarchy(root)
        tris = sum(C.tri_count(o) for o in objs)
        mn, mx = C.world_bounds(objs)
        print(f"[build] {name}: tris={tris} min={tuple(round(c, 3) for c in mn)} max={tuple(round(c, 3) for c in mx)}")
        path = os.path.join(OUT_DIR, name + '.glb')
        C.export_glb(root, path)
        built[name] = (path, cat, spec)

    # verification (fresh scene per GLB) + previews
    tile_dir = os.path.join(PREVIEW_DIR, 'tiles')
    os.makedirs(tile_dir, exist_ok=True)
    for name, (path, cat, spec) in built.items():
        meta, bounds = verify_glb(name, path, spec)
        metas[name] = meta
        if preview:
            setup_render()
            if name in PREVIEW_TINT:
                tint_material('Wall', PREVIEW_TINT[name])
            show_one_shopsign()
            preview_tile(name, spec, bounds, os.path.join(tile_dir, f'{name}_front.png'), 'front')
            preview_tile(name, spec, bounds, os.path.join(tile_dir, f'{name}_back.png'), 'back', show_box=True)
            if cat == 'buildings' and name != 'bld_station':
                plaques = draw_slots()
                preview_tile(name, spec, bounds, os.path.join(tile_dir, f'{name}_slots_front.png'), 'front')
                preview_tile(name, spec, bounds, os.path.join(tile_dir, f'{name}_slots_back.png'), 'back')
                for ob in plaques:
                    bpy.data.objects.remove(ob, do_unlink=True)

    order = list(ASSETS.keys())
    with open(META_PATH, 'w') as f:
        json.dump({'units': 'meters', 'axes': 'glTF: +Y up, model front = +Z, model left = +X',
                   'assets': [metas[n] for n in order if n in metas]}, f, indent=2)
    print(f"[meta] wrote {META_PATH}")

    if preview:
        cats = {}
        for n in order:
            cats.setdefault(ASSETS[n][1], []).append(n)
        for cat, ns in cats.items():
            if only is not None and not any(n in built for n in ns):
                continue    # a partial build leaves the other categories' sheets alone
            fronts = [os.path.join(tile_dir, f'{n}_front.png') for n in ns]
            backs = [os.path.join(tile_dir, f'{n}_back.png') for n in ns]
            if not all(os.path.exists(p) for p in fronts + backs):
                continue
            # rows of front 3/4 views first, then rear views with the collision box
            cols = len(ns) if len(ns) <= 4 or cat == 'vehicles' else 3
            contact_sheet(fronts + backs, cols, os.path.join(PREVIEW_DIR, f'{cat}.png'))
            print(f"[preview] {cat}.png")
        slot_bld = [n for n in order if ASSETS[n][1] == 'buildings' and n != 'bld_station']
        tiles = [os.path.join(tile_dir, f'{n}_slots_{v}.png') for v in ('front', 'back') for n in slot_bld]
        if all(os.path.exists(p) for p in tiles) and (only is None or any(n in built for n in slot_bld)):
            contact_sheet(tiles, len(slot_bld), os.path.join(PREVIEW_DIR, 'buildings_decal_slots.png'))
            print("[preview] buildings_decal_slots.png")
        if 'bld_shop' in built:
            preview_shop_signs(os.path.join(PREVIEW_DIR, 'bld_shop_signs.png'), tile_dir)
        # the car sheets always show every car on disk (a partial build doesn't drop rows)
        cars = [n for n in CARS if os.path.exists(os.path.join(OUT_DIR, n + '.glb'))]             if any(n in built for n in CARS) else []
        if cars:
            preview_car_gameview(cars, os.path.join(PREVIEW_DIR, 'cars_game_view.png'), tile_dir)
            preview_steering(cars, os.path.join(PREVIEW_DIR, 'cars_steering.png'), tile_dir)
    print("[done] all assets built OK")


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
