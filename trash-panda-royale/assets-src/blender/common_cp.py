"""Shared helpers for build_characters_props.py (Blender 5.2, headless).

Mesh building is done procedurally with bmesh so every asset is fully
reproducible.  Conventions (see build script): metres, Z-up, front = -Y,
right = -X, left = +X.

Every mesh gets exactly one UV map ("UVMap"): each MB primitive takes an optional
`uv=` mode (see common_tex: 'const' / 'box' / 'slope' / 'cyl' / 'sphere' / 'planar',
optionally remapped into an atlas rect).  Without `uv=`, faces whose material was made
with tmat() (a texture) get ('box', tile_m), all others the constant (0, 0).
"""
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common_tex as T  # noqa: E402
from common_tex import tmat  # noqa: E402,F401  (re-exported for the build scripts)

D2R = math.pi / 180.0
UV_NAME = "UVMap"


# ---------------------------------------------------------------------------
# colours / materials
# ---------------------------------------------------------------------------
def _srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h):
    h = h.lstrip('#')
    return tuple(_srgb2lin(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


_MATS = {}


def mat(name, color, rough=0.6, emit=None, strength=0.0, metallic=0.0):
    """Create (or reuse within the current asset) a Principled BSDF material."""
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    if m.name != name:
        raise RuntimeError("material name clash: %s -> %s" % (name, m.name))
    if m.node_tree is None:
        m.use_nodes = True
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    lin = hexcol(color) if isinstance(color, str) else tuple(color)
    p.inputs['Base Color'].default_value = (*lin, 1.0)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = rough
    if emit is not None:
        e = hexcol(emit) if isinstance(emit, str) else tuple(emit)
        p.inputs['Emission Color'].default_value = (*e, 1.0)
        p.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = (*lin, 1.0)
    m.roughness = rough
    m.metallic = metallic
    _MATS[name] = m
    return m


# ---------------------------------------------------------------------------
# scene management
# ---------------------------------------------------------------------------
def reset_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.curves):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    _MATS.clear()


def V(*a):
    if len(a) == 1:
        return Vector(a[0])
    return Vector(a)


def rotmat(rot):
    """rot: None | (rx,ry,rz) degrees XYZ euler | 3x3 Matrix."""
    if rot is None:
        return Matrix.Identity(3)
    if isinstance(rot, Matrix):
        return rot.to_3x3()
    from mathutils import Euler
    return Euler([r * D2R for r in rot], 'XYZ').to_matrix()


def xform(loc=(0, 0, 0), rot=None, scale=(1, 1, 1)):
    if not hasattr(scale, '__len__'):
        scale = (scale, scale, scale)
    S = Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    return Matrix.Translation(Vector(loc)) @ rotmat(rot).to_4x4() @ S


def align_z(direction):
    """3x3 rotation taking +Z to `direction`."""
    return Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized()).to_matrix()


def spow(a, p):
    return math.copysign(abs(a) ** p, a)


# ---------------------------------------------------------------------------
# mesh builder
# ---------------------------------------------------------------------------
class MB:
    """Accumulates primitives (each with its own material) into one bmesh.
    Per-corner UVs live in the bmesh loop layer "UVMap" and survive the merges."""

    def __init__(self):
        self.bm = bmesh.new()
        self.bm.loops.layers.uv.new(UV_NAME)
        self.mats = []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    # -- internal: merge a temp bmesh -------------------------------------
    def _commit(self, tb, m, M=None, smooth=True, recalc=False, face_mats=None, uv=None,
                uv_pre=False):
        """Merge tb.  UVs are computed after the transform (builder frame) unless the
        primitive already wrote them (uv_pre, e.g. 'cyl' rows)."""
        idx = self.mi(m)
        uvl = tb.loops.layers.uv.get(UV_NAME) or tb.loops.layers.uv.new(UV_NAME)
        for f in tb.faces:
            f.material_index = idx
            f.smooth = smooth
        if face_mats:
            for f, fm in face_mats:
                f.material_index = self.mi(fm)
        if M is not None:
            bmesh.ops.transform(tb, matrix=M, verts=tb.verts)
            if M.to_3x3().determinant() < 0:
                bmesh.ops.reverse_faces(tb, faces=tb.faces)
        if recalc:
            bmesh.ops.recalc_face_normals(tb, faces=tb.faces)
        if not uv_pre:
            permat = isinstance(uv, dict)          # {material name: uv mode} per face material
            mode = None if permat else T.norm_uv(uv)
            tb.normal_update()
            for f in tb.faces:
                fm_ = self.mats[f.material_index]
                fmode = (T.norm_uv(uv.get(fm_.name)) if permat else mode) or T.default_uv(fm_)
                for l, co in zip(f.loops, T.corner_uvs(fmode, [l.vert.co for l in f.loops], f.normal)):
                    l[uvl].uv = co
        me = bpy.data.meshes.new("_tmp")
        tb.to_mesh(me)
        tb.free()
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

    # -- primitives ---------------------------------------------------------
    def sphere(self, c, r, m, segs=12, rings=8, rot=None, smooth=True, deform=None, uv=None):
        tb = bmesh.new()
        res = bmesh.ops.create_uvsphere(tb, u_segments=segs, v_segments=rings, radius=1.0)
        if deform:
            for v in res['verts']:
                v.co = Vector(deform(v.co.copy()))
        if not hasattr(r, '__len__'):
            r = (r, r, r)
        self._commit(tb, m, xform(c, rot, r), smooth, uv=uv)

    def superellipsoid(self, c, r, m, segs=12, rings=8, e_lat=1.0, e_lon=1.0,
                       taper=0.0, rot=None, smooth=True, extra=None, uv=None):
        """Rounded box-ish blob. taper>0 widens the bottom (xy scale 1+taper*-z)."""
        def deform(v):
            z = max(-1.0, min(1.0, v.z))
            lat = math.asin(z)
            lon = math.atan2(v.y, v.x)
            cl = math.cos(lat)
            x = spow(cl, e_lat) * spow(math.cos(lon), e_lon)
            y = spow(cl, e_lat) * spow(math.sin(lon), e_lon)
            zz = spow(math.sin(lat), e_lat)
            t = 1.0 + taper * (-zz)
            p = Vector((x * t, y * t, zz))
            if extra:
                p = Vector(extra(p))
            return p
        self.sphere(c, r, m, segs, rings, rot, smooth, deform, uv=uv)

    def grid(self, rows, m, wrap=True, wrap_rows=False, smooth=True, cap_first=False,
             cap_last=False, row_mats=None, recalc=False, M=None, uv=None):
        """rows: list of lists of points (a single-point row is a pole).
        Rows ordered so that (bottom->top, CCW around +Z) gives outward normals.
        uv=('cyl',): u = j / n around the rows (wrap corner at 1.0), v = arc length along
        the rows / total; written while the faces are created.  A dict (material name -> mode)
        is handed on to _commit as is (no 'cyl' among them)."""
        mode = None if isinstance(uv, dict) else T.norm_uv(uv)
        cyl = mode is not None and mode[0] == 'cyl'
        rect = mode[2] if cyl else None
        tb = bmesh.new()
        uvl = tb.loops.layers.uv.new(UV_NAME)
        vrows = [[tb.verts.new(Vector(p)) for p in row] for row in rows]
        fm = []
        nrows = len(vrows)
        vpar = T.row_params(rows, wrap_rows) if cyl else None

        def put(f, uvs):
            if cyl:
                for l, c in zip(f.loops, uvs):
                    l[uvl].uv = T.remap_rect(c, rect)
        pairs = list(range(nrows - 1)) + ([nrows - 1] if wrap_rows else [])
        for i in pairs:
            A, B = vrows[i], vrows[(i + 1) % nrows]
            rm = row_mats[i] if row_mats else None
            n = max(len(A), len(B))
            den = float(n if wrap else max(n - 1, 1))
            va = vpar[i] if cyl else 0.0
            vb = (vpar[i + 1] if i + 1 < nrows else 1.0) if cyl else 0.0
            jr = range(n) if wrap else range(n - 1)
            for j in jr:
                j1 = (j + 1) % n
                u0, u1, um = j / den, (j + 1) / den, (j + 0.5) / den
                if len(A) == 1 and len(B) == 1:
                    continue
                if len(A) == 1:
                    vs = (A[0], B[j1], B[j])
                    uvs = ((um, va), (u1, vb), (u0, vb))
                elif len(B) == 1:
                    vs = (A[j], A[j1], B[0])
                    uvs = ((u0, va), (u1, va), (um, vb))
                else:
                    vs = (A[j], A[j1], B[j1], B[j])
                    uvs = ((u0, va), (u1, va), (u1, vb), (u0, vb))
                try:
                    f = tb.faces.new(vs)
                except ValueError:
                    continue
                put(f, uvs)
                if rm is not None:
                    fm.append((f, rm))
        if cap_first and len(vrows[0]) > 2:
            n0 = len(vrows[0])
            f = tb.faces.new(list(reversed(vrows[0])))
            put(f, [(k / n0, 0.0) for k in reversed(range(n0))])
            if row_mats:
                fm.append((f, row_mats[0]))
        if cap_last and len(vrows[-1]) > 2:
            n1 = len(vrows[-1])
            f = tb.faces.new(vrows[-1])
            put(f, [(k / n1, vpar[-1] if cyl else 0.0) for k in range(n1)])
            if row_mats:
                fm.append((f, row_mats[-1]))
        self._commit(tb, m, M, smooth, recalc, fm, uv=uv, uv_pre=cyl)

    def lathe(self, profile, m, segs=12, c=(0, 0, 0), rot=None, smooth=True,
              closed=False, scale=(1, 1, 1), phase=0.0, uv=None):
        """profile: [(r, z) or (r, z, mat)] bottom->top (solid on the left).
        Band i (between point i and i+1) uses point i's material."""
        rows, rmats = [], []
        for p in profile:
            r, z = p[0], p[1]
            rmats.append(p[2] if len(p) > 2 else m)
            if r < 1e-7:
                rows.append([(0.0, 0.0, z)])
            else:
                rows.append([(r * math.cos(2 * math.pi * j / segs + phase),
                              r * math.sin(2 * math.pi * j / segs + phase), z)
                             for j in range(segs)])
        cap_first = (not closed) and profile[0][0] > 1e-7
        cap_last = (not closed) and profile[-1][0] > 1e-7
        self.grid(rows, m, wrap=True, wrap_rows=closed, smooth=smooth,
                  cap_first=cap_first, cap_last=cap_last, row_mats=rmats,
                  recalc=True, M=xform(c, rot, scale), uv=uv)

    def cylinder(self, p0, p1, r, m, segs=12, r1=None, bevel=0.0, smooth=True, uv=None):
        """Cylinder between two points (optionally tapered / bevelled ends)."""
        p0, p1 = Vector(p0), Vector(p1)
        L = (p1 - p0).length
        r0 = r
        r1 = r if r1 is None else r1
        if bevel > 0:
            b = bevel
            prof = [(0, 0), (r0 - b, 0), (r0, b), (r1, L - b), (r1 - b, L), (0, L)]
        else:
            prof = [(0, 0), (r0, 0), (r1, L), (0, L)]
        self.lathe(prof, m, segs, c=p0, rot=align_z(p1 - p0), smooth=smooth, uv=uv)

    def capsule(self, p0, p1, r0, m, r1=None, segs=8, hemi=3, bands=None, smooth=True,
                hemi0=None, uv=None):
        """Capsule from p0 (radius r0) to p1 (radius r1).
        bands: list of (t, mat, dr) inserted along the shaft (t in 0..1 from p0),
        material applies from that point upward; dr adds radius (hem)."""
        p0, p1 = Vector(p0), Vector(p1)
        r1 = r0 if r1 is None else r1
        L = (p1 - p0).length
        prof = []
        cur = m
        h0 = hemi if hemi0 is None else hemi0
        for k in range(h0 + 1):
            a = -math.pi / 2 + (math.pi / 2) * k / h0
            prof.append([r0 * math.cos(a), r0 * math.sin(a), cur])
        for (t, bm_, dr) in (bands or []):
            rr = r0 + (r1 - r0) * t
            cur = bm_
            prof.append([rr, L * t, cur])
            prof.append([rr + dr, L * t, cur])
        for k in range(hemi + 1):
            a = (math.pi / 2) * k / hemi
            prof.append([r1 * math.cos(a), L + r1 * math.sin(a), cur])
        prof = [tuple(p) for p in prof]
        self.lathe(prof, m, segs, c=p0, rot=align_z(p1 - p0), smooth=smooth, uv=uv)

    def box(self, c, size, m, bevel=0.0, bseg=2, rot=None, smooth=True, uv=None):
        tb = bmesh.new()
        res = bmesh.ops.create_cube(tb, size=1.0)
        for v in res['verts']:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        if bevel > 0:
            bmesh.ops.bevel(tb, geom=list(tb.edges), offset=bevel, offset_type='OFFSET',
                            profile_type='SUPERELLIPSE', segments=bseg, profile=0.5,
                            affect='EDGES', clamp_overlap=True, material=-1)
        self._commit(tb, m, xform(c, rot), smooth, recalc=True, uv=uv)

    def tube(self, pts, radius, m, sides=6, closed=False, caps=True, smooth=True, uv=None):
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rads = radius if hasattr(radius, '__len__') else [radius] * n
        tans = []
        for i in range(n):
            if closed:
                t = pts[(i + 1) % n] - pts[(i - 1) % n]
            else:
                t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
            tans.append(t.normalized())
        ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
        N = (ref - ref.dot(tans[0]) * tans[0]).normalized()
        rows = []
        for i in range(n):
            T = tans[i]
            N = (N - N.dot(T) * T).normalized()
            B = T.cross(N)
            rows.append([pts[i] + rads[i] * (math.cos(2 * math.pi * k / sides) * N +
                                             math.sin(2 * math.pi * k / sides) * B)
                         for k in range(sides)])
        self.grid(rows, m, wrap=True, wrap_rows=closed, smooth=smooth,
                  cap_first=caps and not closed, cap_last=caps and not closed, recalc=True,
                  uv=uv)

    def surface(self, rows, band_mats, uv_fn=None, centre=None, smooth=True, closed=True, recalc=False):
        """Bands of quads between consecutive rings (single-point rows = poles).
        band_mats[i] is the material of the band between rows i and i+1.
        uv_fn(i, co, r, u, j) returns the Blender UV of a corner of band i: co = position,
        r = its row index, u = its column parameter (the closing column of a ring gets 1.0,
        so wrapping maps stay seamless), j = the face's column; default: the constant (0, 0).
        Every face is oriented with its normal pointing away from `centre` (the surface
        must be star-shaped around it), so the row / azimuth order does not matter.
        closed=False leaves the rings open (strips, j = 0 .. n-2).  recalc=True (closed
        surfaces that are not star-shaped, e.g. a bent tube) lets bmesh orient the faces."""
        tb = bmesh.new()
        uvl = tb.loops.layers.uv.new(UV_NAME)
        vrows = [[tb.verts.new(Vector(p)) for p in row] for row in rows]
        c = Vector(centre) if centre is not None else None
        fm = []
        for i in range(len(vrows) - 1):
            A, B = vrows[i], vrows[i + 1]
            n = max(len(A), len(B))
            den = float(n if closed else max(n - 1, 1))
            m = band_mats[i]
            for j in range(n if closed else n - 1):
                j1 = (j + 1) % n
                u0, u1, um = j / den, (j + 1) / den, (j + 0.5) / den
                if len(A) == 1 and len(B) == 1:
                    continue
                if len(A) == 1:
                    cs = [(A[0], i, um), (B[j], i + 1, u0), (B[j1], i + 1, u1)]
                elif len(B) == 1:
                    cs = [(A[j], i, u0), (A[j1], i, u1), (B[0], i + 1, um)]
                else:
                    cs = [(A[j], i, u0), (A[j1], i, u1), (B[j1], i + 1, u1), (B[j], i + 1, u0)]
                if c is not None:
                    pts = [cc[0].co for cc in cs]
                    nrm = Vector((0, 0, 0))
                    for k in range(len(pts)):
                        nrm += pts[k].cross(pts[(k + 1) % len(pts)])
                    mid = sum(pts, Vector((0, 0, 0))) / len(pts)
                    if nrm.dot(mid - c) < 0:
                        cs.reverse()
                try:
                    f = tb.faces.new([cc[0] for cc in cs])
                except ValueError:
                    continue
                for l, cc in zip(f.loops, cs):
                    l[uvl].uv = uv_fn(i, cc[0].co, cc[1], cc[2], j) if uv_fn else (0.0, 0.0)
                fm.append((f, m))
        self._commit(tb, band_mats[0], None, smooth, recalc, fm, uv_pre=True)

    def star_prism(self, c, r_out, r_in, depth, m, rot=None, points=5, smooth=False, uv=None):
        """Flat star (in local XZ plane, extruded along Y, front face at -Y)."""
        outline = []
        for k in range(points * 2):
            a = math.pi / 2 + math.pi * k / points
            rr = r_out if k % 2 == 0 else r_in
            outline.append((rr * math.cos(a), rr * math.sin(a)))
        tb = bmesh.new()
        front = [tb.verts.new((x, -depth / 2, z)) for x, z in outline]
        back = [tb.verts.new((x, depth / 2, z)) for x, z in outline]
        tb.faces.new(front)
        tb.faces.new(list(reversed(back)))
        n = len(outline)
        for k in range(n):
            k1 = (k + 1) % n
            tb.faces.new((front[k], back[k], back[k1], front[k1]))
        self._commit(tb, m, xform(c, rot), smooth, recalc=True, uv=uv)

    def puffy_star(self, c, r_out, r_in, depth, m, rot=None, points=5, uv=None):
        """Rounded 'puffy' star in local XZ plane, bulging toward -Y and +Y."""
        outline = []
        for k in range(points * 2):
            a = math.pi / 2 + math.pi * k / points
            rr = r_out if k % 2 == 0 else r_in
            outline.append(Vector((rr * math.cos(a), 0.0, rr * math.sin(a))))
        levels = [(1.0, 0.0), (0.9, 0.5), (0.68, 0.82), (0.38, 0.97)]
        rows = []
        # back side (+Y) from centre pole outward, then front side inward
        rows.append([Vector((0, depth, 0))])
        for s, d in reversed(levels[1:]):
            rows.append([Vector((p.x * s, depth * d, p.z * s)) for p in outline])
        rows.append([Vector((p.x, 0, p.z)) for p in outline])
        for s, d in levels[1:]:
            rows.append([Vector((p.x * s, -depth * d, p.z * s)) for p in outline])
        rows.append([Vector((0, -depth, 0))])
        self.grid(rows, m, recalc=True, M=xform(c, rot), uv=uv)

    # -- output -------------------------------------------------------------
    def to_object(self, name, pivot=(0, 0, 0), parent=None, sharp_angle=48.0):
        pivot = Vector(pivot)
        bmesh.ops.translate(self.bm, vec=-pivot, verts=self.bm.verts)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        if len(me.uv_layers) != 1 or me.uv_layers[0].name != UV_NAME:
            raise RuntimeError("%s: expected exactly one UV map %r, got %s" % (
                name, UV_NAME, [l.name for l in me.uv_layers]))
        for m in self.mats:
            me.materials.append(m)
        if sharp_angle:
            me.set_sharp_from_angle(angle=sharp_angle * D2R)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        place(ob, pivot, parent)
        return ob


# ---------------------------------------------------------------------------
# objects / hierarchy
# ---------------------------------------------------------------------------
def place(ob, world_pivot, parent=None):
    """Parent `ob` (identity rotation/scale) so its origin sits at world_pivot."""
    ob["_pivot"] = list(world_pivot)
    if parent is not None:
        ob.parent = parent
        pp = Vector(parent["_pivot"])
        ob.location = Vector(world_pivot) - pp
    else:
        ob.location = Vector(world_pivot)


def empty(name, pivot=(0, 0, 0), parent=None, size=0.1):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = size
    bpy.context.scene.collection.objects.link(ob)
    place(ob, Vector(pivot), parent)
    if ob.name != name:
        raise RuntimeError("object name clash %s" % ob.name)
    return ob


def hierarchy(root):
    out = [root]
    for ch in sorted(root.children, key=lambda o: o.name):
        out += hierarchy(ch)
    return out


# ---------------------------------------------------------------------------
# export & stats
# ---------------------------------------------------------------------------
def tri_count(objs):
    t = 0
    for ob in objs:
        if ob.type == 'MESH':
            t += sum(len(p.vertices) - 2 for p in ob.data.polygons)
    return t


def gltf_bounds(objs):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for ob in objs:
        if ob.type != 'MESH':
            continue
        mw = ob.matrix_world
        for v in ob.data.vertices:
            w = mw @ v.co
            g = (w.x, w.z, -w.y)  # Blender Z-up -> glTF Y-up, front -Y -> +Z
            for i in range(3):
                lo[i] = min(lo[i], g[i])
                hi[i] = max(hi[i], g[i])
    return [round(x, 4) + 0.0 for x in lo], [round(x, 4) + 0.0 for x in hi]


def export_glb(root, path):
    bpy.context.view_layer.update()
    objs = hierarchy(root)
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = root
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_animations=False, export_materials='EXPORT',
        export_cameras=False, export_lights=False, export_extras=False)
    T.externalize_images(path)
    nodes = []
    for ob in objs:
        l = ob.location
        nodes.append({
            "name": ob.name,
            "type": "mesh" if ob.type == 'MESH' else "empty",
            "parent": ob.parent.name if ob.parent else None,
            "local_translation_gltf": [round(l.x, 4) + 0.0, round(l.z, 4) + 0.0,
                                       round(-l.y, 4) + 0.0],
            "materials": [m.name for m in ob.data.materials] if ob.type == 'MESH' else [],
            "tris": tri_count([ob]),
        })
    lo, hi = gltf_bounds(objs)
    return {
        "name": os.path.splitext(os.path.basename(path))[0],
        "file": os.path.basename(path),
        "bbox_min": lo, "bbox_max": hi,
        "size": [round(hi[i] - lo[i], 4) for i in range(3)],
        "triangles": tri_count(objs),
        "node_names": [o.name for o in objs],
        "nodes": nodes,
    }


# ---------------------------------------------------------------------------
# preview rendering
# ---------------------------------------------------------------------------
def setup_render(res=(1000, 600), engine='BLENDER_EEVEE'):
    sc = bpy.context.scene
    try:
        sc.render.engine = engine
    except Exception:
        sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    try:
        sc.view_settings.view_transform = 'Standard'
    except Exception:
        pass
    if sc.render.engine == 'BLENDER_EEVEE':
        try:
            sc.eevee.taa_render_samples = 32
        except Exception:
            pass
    w = sc.world or bpy.data.worlds.new("World")
    sc.world = w
    if w.node_tree is None:
        w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.78, 0.86, 0.95, 1.0)
    bg.inputs[1].default_value = 0.9
    return sc


def add_sun(direction=(-0.5, 0.7, -1.0), strength=3.0):
    ld = bpy.data.lights.new("Sun", 'SUN')
    ld.energy = strength
    ld.angle = 8 * D2R
    ob = bpy.data.objects.new("Sun", ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = Vector(direction).to_track_quat('-Z', 'Y').to_euler()
    return ob


def add_ground(size=200, color=(0.62, 0.7, 0.62)):
    me = bpy.data.meshes.new("Ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2)
    bm.to_mesh(me)
    bm.free()
    m = bpy.data.materials.new("_ground")
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = 0.9
    me.materials.append(m)
    ob = bpy.data.objects.new("Ground", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def frame_camera(objs, view_dir, res, margin=1.12, name="Cam"):
    """Orthographic camera looking along view_dir (from camera toward scene)."""
    pts = []
    for ob in objs:
        if ob.type in ('MESH', 'FONT') and not ob.hide_render:
            mw = ob.matrix_world
            pts += [mw @ Vector(c) for c in ob.bound_box]
    vd = Vector(view_dir).normalized()
    q = vd.to_track_quat('-Z', 'Y')
    R = q.to_matrix()
    right, up = R.col[0], R.col[1]
    xs = [p.dot(right) for p in pts]
    ys = [p.dot(up) for p in pts]
    zs = [p.dot(vd) for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    center = right * cx + up * cy + vd * min(zs)
    cd = bpy.data.cameras.new(name)
    cd.type = 'ORTHO'
    cd.ortho_scale = max(w, h * res[0] / res[1]) * margin
    cd.clip_start = 0.01
    cd.clip_end = 1000
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center - vd * 50
    cam.rotation_euler = q.to_euler()
    bpy.context.scene.camera = cam
    return cam


def render_to(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def import_glb(path):
    """Import a .glb into the current scene -> (new_objects, root_objects)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        o.rotation_mode = 'XYZ'
    roots = [o for o in new if o.parent is None]
    return new, roots


def setup_render_transparent(res, samples=48, world_color=(1.0, 1.0, 1.0), world_strength=0.3,
                             engine='BLENDER_EEVEE'):
    """Like setup_render() but with a transparent film and RGBA 8-bit PNG output.

    The world never shows (film is transparent) but still lights the scene, so keep
    `world_strength` low to avoid washing colours out.  View transform is 'Standard'
    so base colours come out as authored (sRGB)."""
    sc = bpy.context.scene
    try:
        sc.render.engine = engine
    except Exception:
        sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    im = sc.render.image_settings
    im.file_format = 'PNG'
    im.color_mode = 'RGBA'
    im.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    if sc.render.engine == 'BLENDER_EEVEE':
        sc.eevee.taa_render_samples = samples
    w = bpy.data.worlds.get("_IconWorld") or bpy.data.worlds.new("_IconWorld")
    sc.world = w
    if w.node_tree is None:
        w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (*world_color, 1.0)
    bg.inputs[1].default_value = world_strength
    return sc


def frame_camera_tight(objs, view_dir, res, pad_px=0.0, center=None, name="Cam"):
    """Orthographic camera fitted to the projected *vertices* of the visible (evaluated)
    MESH/FONT/CURVE objects, leaving `pad_px` empty pixels on every side.  If `center`
    (world point) is given the camera is centred on it instead of on the extents.
    Returns (camera, project) where project(world_pt) -> (px, py), pixel coordinates
    measured from the image's top-left corner."""
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    vd = Vector(view_dir).normalized()
    q = vd.to_track_quat('-Z', 'Y')
    R = q.to_matrix()
    right, up = R.col[0].copy(), R.col[1].copy()
    xs, ys, zs = [], [], []
    for ob in objs:
        if ob.type not in ('MESH', 'FONT', 'CURVE') or ob.hide_render:
            continue
        oe = ob.evaluated_get(deps)
        me = oe.to_mesh()
        mw = oe.matrix_world.copy()
        for v in me.vertices:
            p = mw @ v.co
            xs.append(p.dot(right))
            ys.append(p.dot(up))
            zs.append(p.dot(vd))
        oe.to_mesh_clear()
    if center is None:
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    else:
        cx, cy = Vector(center).dot(right), Vector(center).dot(up)
    hw = max(abs(x - cx) for x in xs)
    hh = max(abs(y - cy) for y in ys)
    W, H = res
    need_w = 2 * hw * W / max(1.0, W - 2 * pad_px)
    need_h = 2 * hh * H / max(1.0, H - 2 * pad_px)
    world_w = max(need_w, need_h * W / H)
    world_h = world_w * H / W
    cd = bpy.data.cameras.new(name)
    cd.type = 'ORTHO'
    cd.sensor_fit = 'AUTO'
    cd.ortho_scale = world_w if W >= H else world_h
    cd.clip_start = 0.01
    cd.clip_end = 1000
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = right * cx + up * cy + vd * min(zs) - vd * 50
    cam.rotation_euler = q.to_euler()
    bpy.context.scene.camera = cam

    def project(p):
        p = Vector(p)
        return ((p.dot(right) - cx) / world_w * W + W / 2,
                H / 2 - (p.dot(up) - cy) / world_h * H)
    return cam, project


def write_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# signed distance shapes + star-shaped "polar" surfaces (characters)
# ---------------------------------------------------------------------------
def sd_ellipsoid(p, c, r, R=None):
    """Approximate signed distance to an ellipsoid (centre c, radii r, optional 3x3
    rotation R taking the ellipsoid's local axes to the frame).  Exact sign; good
    enough near the surface for ray-casting and smooth blends."""
    q = Vector(p) - Vector(c)
    if R is not None:
        q = R.transposed() @ q
    k0 = math.sqrt((q.x / r[0]) ** 2 + (q.y / r[1]) ** 2 + (q.z / r[2]) ** 2)
    k1 = math.sqrt((q.x / (r[0] * r[0])) ** 2 + (q.y / (r[1] * r[1])) ** 2 + (q.z / (r[2] * r[2])) ** 2)
    if k1 < 1e-12:
        return -min(r)
    return k0 * (k0 - 1.0) / k1


def sd_capsule3(p, a, b, ra, rb=None):
    """Round cone from a (radius ra) to b (radius rb)."""
    p, a, b = Vector(p), Vector(a), Vector(b)
    rb = ra if rb is None else rb
    ba = b - a
    h = max(0.0, min(1.0, (p - a).dot(ba) / max(ba.dot(ba), 1e-12)))
    return (p - (a + ba * h)).length - (ra + (rb - ra) * h)


def smin(a, b, k):
    """Polynomial smooth minimum (blend radius k)."""
    if k <= 0:
        return min(a, b)
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def periodic_spline(keys, period=360.0):
    """keys: [(x, y), ...] sorted by x within one period -> smooth periodic function
    (Catmull-Rom through the keys)."""
    xs = [k[0] for k in keys]
    ys = [k[1] for k in keys]
    n = len(keys)

    def f(x):
        x = (x - xs[0]) % period + xs[0]
        i = 0
        while i < n - 1 and xs[i + 1] <= x:
            i += 1
        x0 = xs[i]
        x1 = xs[i + 1] if i + 1 < n else xs[0] + period
        t = (x - x0) / max(x1 - x0, 1e-9)
        p0, p1, p2, p3 = ys[(i - 1) % n], ys[i], ys[(i + 1) % n], ys[(i + 2) % n]
        t2, t3 = t * t, t * t * t
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    return f


class PolarShape:
    """A closed surface given by an SDF, star-shaped around `centre`, meshed in rings
    around a `front` axis:  t = 0 is the front pole, t = 1 the outline alpha_out(theta)
    (degrees away from the front axis), t = 2 the back pole.  theta is the azimuth around
    the front axis, measured from `left` toward `up` (counter-clockwise for a viewer in
    front).  Material regions are bands of rings, so a patch bounded by the outline is a
    clean set of the mesh's own polygons (no decal shell, nothing to z-fight)."""

    def __init__(self, centre, sdf, front=(0, -1, 0), up=(0, 0, 1), outline=None, smax_=1.2):
        self.c = Vector(centre)
        self.sdf = sdf
        f = Vector(front).normalized()
        u = Vector(up)
        u = (u - f * u.dot(f)).normalized()
        self.f, self.u = f, u
        self.l = u.cross(f)
        self.outline = outline or (lambda th: 90.0)
        self.smax = smax_

    def direction(self, alpha, theta):
        a, t = alpha * D2R, theta * D2R
        return (self.f * math.cos(a) + (self.l * math.cos(t) + self.u * math.sin(t)) * math.sin(a)).normalized()

    def radius(self, d):
        """Distance from the centre to the outermost surface crossing along unit d."""
        s = self.smax
        step = 0.01
        while s > 0 and self.sdf(self.c + d * s) > 0:
            s -= step
        lo, hi = max(s, 0.0), s + step
        for _ in range(30):
            mid = (lo + hi) / 2
            if self.sdf(self.c + d * mid) > 0:
                hi = mid
            else:
                lo = mid
        return (lo + hi) / 2

    def point(self, d, add=0.0):
        d = Vector(d).normalized()
        return self.c + d * (self.radius(d) + add)

    def alpha(self, t, theta):
        a0 = self.outline(theta)
        if t <= 1.0:
            return t * a0
        return a0 + (t - 1.0) * (180.0 - a0)

    def rows(self, thetas, ts, add=0.0):
        """Rings for each t in ts (t = 0 / 2 give a single pole point)."""
        out = []
        for t in ts:
            if t <= 0.0:
                out.append([self.point(self.f, add)])
            elif t >= 2.0:
                out.append([self.point(-self.f, add)])
            else:
                out.append([self.point(self.direction(self.alpha(t, th), th), add) for th in thetas])
        return out


def catmull_path(pts, sub):
    """Catmull-Rom through `pts` (Vectors), `sub` segments per span -> list of Vectors."""
    P = [Vector(p) for p in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                              (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-2].copy())
    return out


def tube_rows(pts, radius, sides):
    """Rings of a tube along `pts` (parallel-transport frames, like MB.tube)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    rads = radius if hasattr(radius, '__len__') else [radius] * n
    tans = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    N = (ref - ref.dot(tans[0]) * tans[0]).normalized()
    rows = []
    for i in range(n):
        Tg = tans[i]
        N = (N - N.dot(Tg) * Tg).normalized()
        B = Tg.cross(N)
        rows.append([pts[i] + rads[i] * (math.cos(2 * math.pi * k / sides) * N + math.sin(2 * math.pi * k / sides) * B)
                     for k in range(sides)])
    return rows


# ---------------------------------------------------------------------------
# preview helpers (imported GLBs)
# ---------------------------------------------------------------------------
GLTF_TO_BL = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))   # glTF (x, y, z) -> Blender (x, -z, y)


def game_euler_to_bl(rx, ry, rz):
    """Quaternion (Blender frame) of a game-side rotation.set(x, y, z): @pixi/3d composes
    Euler XYZ like three.js, R = Rx @ Ry @ Rz in glTF axes."""
    Rg = (Matrix.Rotation(rx, 3, 'X') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rz, 3, 'Z'))
    Rb = GLTF_TO_BL @ Rg @ GLTF_TO_BL.transposed()
    return Rb.to_quaternion()


def set_game_rotation(ob, rot):
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = game_euler_to_bl(*rot)


def base_name(name):
    return name.split('.')[0]


def material_set_color(m, hexcolor):
    """Set the base colour factor of an imported glTF material (flat or textured)."""
    lin = (*hexcol(hexcolor), 1.0)
    nt = m.node_tree
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if p is None:
        return
    sock = p.inputs['Base Color']
    if not sock.is_linked:
        sock.default_value = lin
        return
    src = sock.links[0].from_node
    if src.type == 'MIX':        # factor x texture
        for s in src.inputs:
            if s.identifier in ('A_Color', 'B_Color') and s.enabled and not s.is_linked:
                s.default_value = lin
                return
    if src.type == 'MIX_RGB':
        for s in src.inputs[1:3]:
            if not s.is_linked:
                s.default_value = lin
                return
    if src.type == 'TEX_IMAGE':  # factor was white: insert a multiply
        mx = nt.nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        for s in mx.inputs:
            if s.identifier == 'Factor_Float':
                s.default_value = 1.0
            if s.identifier == 'A_Color':
                s.default_value = lin
        nt.links.new(src.outputs['Color'], next(s for s in mx.inputs if s.identifier == 'B_Color'))
        nt.links.new(next(s for s in mx.outputs if s.identifier == 'Result_Color'), sock)


def recolor_objects(objs, colors):
    """colors: {material base name: '#rrggbb'}; the materials are copied for these objects."""
    done = {}
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for slot in ob.material_slots:
            m = slot.material
            if m is None:
                continue
            bn = base_name(m.name)
            if bn not in colors:
                continue
            if m.name not in done:
                done[m.name] = m.copy()
                material_set_color(done[m.name], colors[bn])
            slot.link = 'OBJECT'
            slot.material = done[m.name]


def shift_material_uvs(objs, mat_base, du, dv):
    """Offset the UVs of every face using material `mat_base` (glTF: du right, dv down)."""
    for ob in objs:
        if ob.type != 'MESH':
            continue
        me = ob.data
        idx = [i for i, m in enumerate(me.materials) if m is not None and base_name(m.name) == mat_base]
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
