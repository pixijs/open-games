"""Shared helpers for build_vehicles_buildings.py (Blender 5.2, headless).

Geometry is accumulated in a lightweight MeshBuilder (plain vertex/face lists
with per-face material indices) and turned into a single mesh object at the
end, so every named part of an asset is one clean object with identity
rotation/scale and its origin exactly where we want the pivot.

Every built mesh has exactly one UV map ("UVMap"): each primitive takes an optional
`uv=` mode (see common_tex: 'const' / 'box' / 'slope' / 'cyl' / 'sphere' / 'planar',
optionally remapped into an atlas rect); per-corner UVs are kept in a list parallel to
`faces`.  Without `uv=`, faces whose material was made with tmat() get
('box', tile_m), all others the constant (0, 0).
"""
import math
import os
import random
import sys

import bmesh
import bpy
import mathutils
from mathutils import Matrix, Vector, Euler

if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common_tex as T  # noqa: E402
from common_tex import tmat  # noqa: E402,F401  (re-exported for the build scripts)

DEBUG_TRIS = True  # print per-material triangle breakdown for every built part
UV_NAME = "UVMap"

# ---------------------------------------------------------------------------
# scene / data management
# ---------------------------------------------------------------------------


def reset_scene():
    """Remove every object and every datablock we might have created so that
    names never get .001 suffixes and assets are built from a clean slate."""
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.images, bpy.data.curves,
                 bpy.data.worlds):
        ids = list(coll)
        if ids:
            bpy.data.batch_remove(ids)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    bpy.data.orphans_purge(do_recursive=True)


def scene_coll():
    return bpy.context.scene.collection


# ---------------------------------------------------------------------------
# materials
# ---------------------------------------------------------------------------


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def hex_lin(h):
    return tuple(srgb_to_lin(c) for c in hex_rgb(h))


def mat(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0):
    """Get or create a Principled BSDF material.  `color`/`emit` are sRGB hex."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    if m.node_tree is None:  # Blender 5.x creates the node tree already (use_nodes deprecated)
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    lin = hex_lin(color)
    bsdf.inputs['Base Color'].default_value = (*lin, 1.0)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*hex_lin(emit), 1.0)
        bsdf.inputs['Emission Strength'].default_value = strength
    # viewport / workbench colour
    m.diffuse_color = (*lin, 1.0)
    m.roughness = rough
    m.metallic = metal
    return m


# ---------------------------------------------------------------------------
# transforms
# ---------------------------------------------------------------------------


def xform(loc=(0, 0, 0), rot=None):
    """Matrix = T(loc) @ R(rot), rot = euler degrees (XYZ) or a Matrix/Quaternion."""
    M = Matrix.Translation(Vector(loc))
    if rot is None:
        return M
    if isinstance(rot, (tuple, list)):
        R = Euler([math.radians(a) for a in rot], 'XYZ').to_matrix().to_4x4()
    elif hasattr(rot, 'to_matrix'):
        R = rot.to_matrix().to_4x4()
    else:
        R = rot.to_4x4()
    return M @ R


# rotation that maps local +Y (outward wall normal) to the given world axis
WALL_ROT = {'+Y': 0.0, '-Y': 180.0, '+X': -90.0, '-X': 90.0}


def wall_matrix(face):
    return Matrix.Rotation(math.radians(WALL_ROT[face]), 4, 'Z')


# ---------------------------------------------------------------------------
# mesh builder
# ---------------------------------------------------------------------------


def _edge_filter(bm, mode):
    if mode == 'all':
        return list(bm.edges)
    out = []
    zmax = max(v.co.z for v in bm.verts)
    zmin = min(v.co.z for v in bm.verts)
    for e in bm.edges:
        a, b = e.verts[0].co, e.verts[1].co
        d = (b - a)
        L = d.length or 1.0
        vertical = abs(d.z) / L > 0.7
        top = abs(a.z - zmax) < 1e-5 and abs(b.z - zmax) < 1e-5
        bottom = abs(a.z - zmin) < 1e-5 and abs(b.z - zmin) < 1e-5
        if mode == 'vert' and vertical:
            out.append(e)
        elif mode == 'top' and top:
            out.append(e)
        elif mode == 'topvert' and (top or vertical):
            out.append(e)
        elif mode == 'botvert' and (bottom or vertical):
            out.append(e)
        elif mode == 'nobottom' and not bottom:
            out.append(e)
        elif mode == 'notop' and not top:
            out.append(e)
        elif mode == 'horiz' and not vertical:
            out.append(e)
    return out


def _bevel(bm, edges, r, seg, profile=0.5):
    if r <= 0 or not edges:
        return
    bmesh.ops.bevel(bm, geom=edges, offset=r, offset_type='OFFSET',
                    profile_type='SUPERELLIPSE', segments=seg, profile=profile,
                    affect='EDGES', clamp_overlap=True)


def _cyl_loop_uvs(bm, r1, r2, h, rect, seg):
    """'cyl' UVs for a create_cone() bmesh in its local frame (axis Z, z in -h/2..h/2):
    u = segment index / seg (vertex angles snapped to the segment grid, seam corner at 1.0),
    v = arc length along the profile (bottom cap -> side -> top cap) / total."""
    uvl = bm.loops.layers.uv.get(UV_NAME) or bm.loops.layers.uv.new(UV_NAME)
    side = math.hypot(r2 - r1, h)
    L = max(r1 + side + r2, 1e-9)
    bm.normal_update()
    for f in bm.faces:
        us, vs = [], []
        for l in f.loops:
            p = l.vert.co
            rho = math.hypot(p.x, p.y)
            a = (math.atan2(p.y, p.x) / (2 * math.pi)) % 1.0
            us.append((round(a * seg) % seg) / seg)
            if f.normal.z < -0.7:
                vs.append(rho / L)
            elif f.normal.z > 0.7:
                vs.append((r1 + side + (r2 - rho)) / L)
            else:
                vs.append((r1 + side * (p.z + h / 2) / max(h, 1e-9)) / L)
        if abs(f.normal.z) <= 0.7:
            us = T._seam_fix(us)
        for l, u, v in zip(f.loops, us, vs):
            l[uvl].uv = T.remap_rect((u, v), rect)


class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.fmat = []
        self.uvs = []  # per face: [(u, v)] per corner, parallel to self.faces
        self.mats = []
        self.log = []  # (tris, material) per primitive, for budget debugging

    # -- low level -------------------------------------------------------
    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def add_bm(self, bm, m, matrix=None, uv=None, uv_pre=False):
        """Append a bmesh (freed).  Corner UVs are computed after `matrix` (builder frame)
        from `uv` (or the material's default); uv_pre = use the bmesh's own "UVMap" loop
        layer (written by the primitive in its local frame, e.g. 'cyl').
        N-gons (> 4 corners: cylinder caps, filled loops) are triangulated here by ear
        clipping, so the exported triangles never depend on the exporter's tessellation."""
        if matrix is not None:
            bm.transform(matrix)
        ngons = [f for f in bm.faces if len(f.verts) > 4]
        if ngons:
            bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='EAR_CLIP')
        mi = self._mi(m)
        bm.verts.index_update()
        bm.normal_update()
        off = len(self.verts)
        self.log.append((sum(len(f.verts) - 2 for f in bm.faces), m.name if m else '-'))
        self.verts.extend(tuple(v.co) for v in bm.verts)
        if uv_pre:
            uvl = bm.loops.layers.uv[UV_NAME]
        else:
            mode = T.norm_uv(uv) or T.default_uv(m)
        for f in bm.faces:
            self.faces.append([v.index + off for v in f.verts])
            self.fmat.append(mi)
            if uv_pre:
                self.uvs.append([tuple(l[uvl].uv) for l in f.loops])
            else:
                self.uvs.append(T.corner_uvs(mode, [v.co for v in f.verts], f.normal))
        bm.free()

    def add_mesh_object(self, ob, matrix=None, keep_uv=False):
        """Merge an existing mesh object (modifiers evaluated) keeping its materials.
        keep_uv: take the corner UVs from the object's "UVMap" (a boolean result keeps the
        UVs of both operands: cut faces get the cutter's); otherwise UVs are recomputed
        (material default mode per polygon).  N-gons are ear-clipped (deterministic)."""
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        M = (matrix if matrix is not None else Matrix()) @ ob.matrix_world
        bm = bmesh.new()
        bm.from_mesh(me)
        ev.to_mesh_clear()
        ngons = [f for f in bm.faces if len(f.verts) > 4]
        if ngons:
            bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='EAR_CLIP')
        bm.verts.index_update()
        off = len(self.verts)
        for v in bm.verts:
            self.verts.append(tuple(M @ v.co))
        slot_map = [self._mi(s.material) for s in ob.material_slots] or [self._mi(None)]
        uvl = bm.loops.layers.uv.get(UV_NAME) if keep_uv else None
        if keep_uv and uvl is None:
            raise RuntimeError("%s: keep_uv but no %s layer" % (ob.name, UV_NAME))
        tris = 0
        seen = set()
        for f in bm.faces:
            idx = [v.index + off for v in f.verts]
            key = frozenset(idx)
            if len(key) < len(idx) or key in seen:   # degenerate / duplicate (boolean seams)
                continue
            seen.add(key)
            mi = slot_map[min(f.material_index, len(slot_map) - 1)]
            self.faces.append(idx)
            self.fmat.append(mi)
            tris += len(idx) - 2
            if uvl is not None:
                self.uvs.append([tuple(l[uvl].uv) for l in f.loops])
            else:
                cos = [Vector(self.verts[i]) for i in idx]
                nrm = mathutils.geometry.normal(cos) if len(cos) >= 3 else Vector((0, 0, 1))
                self.uvs.append(T.corner_uvs(T.default_uv(self.mats[mi]), cos, nrm))
        self.log.append((tris, 'merged:' + ob.name))
        bm.free()

    # -- primitives ------------------------------------------------------
    def box(self, size, loc=(0, 0, 0), m=None, r=0.0, seg=1, rot=None,
            edges='all', taper=None, profile=0.5, matrix=None, cull=None, uv=None):
        """Box centred at loc.  cull = local face normals to drop, e.g. ('-Y', '-Z')
        for faces hidden against a wall / floor (saves triangles)."""
        sx, sy, sz = size
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co.x *= sx
            v.co.y *= sy
            v.co.z *= sz
            if taper is not None and v.co.z > 0:
                v.co.x *= taper[0]
                v.co.y *= taper[1]
        if cull:
            axes = {'+X': (1, 0, 0), '-X': (-1, 0, 0), '+Y': (0, 1, 0),
                    '-Y': (0, -1, 0), '+Z': (0, 0, 1), '-Z': (0, 0, -1)}
            bm.normal_update()
            dead = [f for f in bm.faces
                    if any(f.normal.dot(Vector(axes[c])) > 0.99 for c in cull)]
            bmesh.ops.delete(bm, geom=dead, context='FACES_ONLY')
        _bevel(bm, _edge_filter(bm, edges), r, seg, profile)
        M = xform(loc, rot)
        if matrix is not None:
            M = matrix @ M
        self.add_bm(bm, m, M, uv=uv)

    def hull_box(self, bottom, top, m, r=0.0, seg=1, edges='all', matrix=None, uv=None):
        """Frustum-like box. bottom/top = (xmin, xmax, ymin, ymax, z)."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=2.0)
        for v in bm.verts:
            src = top if v.co.z > 0 else bottom
            v.co.x = src[1] if v.co.x > 0 else src[0]
            v.co.y = src[3] if v.co.y > 0 else src[2]
            v.co.z = src[4]
        _bevel(bm, _edge_filter(bm, edges), r, seg)
        self.add_bm(bm, m, matrix, uv=uv)

    def frustum_shell(self, bottom, top, m, r=0.0, seg=1, matrix=None, uv=None):
        """The 4 side walls of a hull_box (open top and bottom, outward normals) with the
        corner edges rounded: a car's glass greenhouse under its roof slab."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=2.0)
        for v in bm.verts:
            src = top if v.co.z > 0 else bottom
            v.co.x = src[1] if v.co.x > 0 else src[0]
            v.co.y = src[3] if v.co.y > 0 else src[2]
            v.co.z = src[4]
        bm.normal_update()
        caps = [f for f in bm.faces if abs(f.normal.z) > 0.999]
        bmesh.ops.delete(bm, geom=caps, context='FACES_ONLY')
        if r > 0:
            _bevel(bm, [e for e in bm.edges if len(e.link_faces) == 2], r, seg)
        self.add_bm(bm, m, matrix, uv=uv)

    def quad(self, center, right, up, w, h, m, cell=None, uv=None, matrix=None, flip_u=False):
        """One flat w x h quad centred at `center`, spanned by the `right` / `up` directions
        (its front face, normal = right x up, faces the viewer for whom `right` is right).
        UVs: planar over the quad, filling the atlas cell `cell` (name or Blender-UV rect),
        unless `uv` is given.  `matrix` transforms the whole quad (and its UV frame)."""
        c, rv, upv = Vector(center), Vector(right).normalized(), Vector(up).normalized()
        if matrix is not None:
            R3 = matrix.to_3x3()
            c, rv, upv = matrix @ c, (R3 @ rv).normalized(), (R3 @ upv).normalized()
        hw, hh = rv * (w / 2.0), upv * (h / 2.0)
        corners = [c - hw - hh, c + hw - hh, c + hw + hh, c - hw + hh]
        bm = bmesh.new()
        bm.faces.new([bm.verts.new(p) for p in corners])
        if uv is None:
            rect = T.atlas_rect(cell) if isinstance(cell, str) else tuple(cell)
            if flip_u:
                rect = (rect[2], rect[1], rect[0], rect[3])
            uv = ('planar', corners[0], rv, upv, w, h, {'rect': rect})
        self.add_bm(bm, m, None, uv=uv)

    def poly_prism(self, pts, x0, x1, m, r=0.0, seg=1, axis='X', matrix=None, uv=None):
        """Extrude a closed 2D profile.  axis='X': pts are (y, z), extruded x0..x1.
        axis='Y': pts are (x, z) extruded along y.  axis='Z': pts (x, y) along z."""
        bm = bmesh.new()

        def P(p, t):
            a, b = p
            if axis == 'X':
                return (t, a, b)
            if axis == 'Y':
                return (a, t, b)
            return (a, b, t)
        v0 = [bm.verts.new(P(p, x0)) for p in pts]
        v1 = [bm.verts.new(P(p, x1)) for p in pts]
        n = len(pts)
        bm.faces.new(v0)
        bm.faces.new(list(reversed(v1)))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((v0[i], v0[j], v1[j], v1[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        _bevel(bm, list(bm.edges), r, seg)
        self.add_bm(bm, m, matrix, uv=uv)

    def cyl(self, r, h, loc=(0, 0, 0), m=None, axis='Z', seg=16, r2=None,
            bevel=0.0, bseg=1, rot=None, matrix=None, caps=True, uv=None):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg,
                              radius1=r, radius2=(r if r2 is None else r2), depth=h)
        if bevel > 0 and caps:
            eds = [e for e in bm.edges
                   if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
            _bevel(bm, eds, bevel, bseg)
        mode = T.norm_uv(uv)
        pre = mode is not None and mode[0] == 'cyl'
        if pre:  # in the local frame: axis = Z, z in [-h/2, h/2]
            _cyl_loop_uvs(bm, r, (r if r2 is None else r2), h, mode[2], seg)
        R = Matrix()
        if axis == 'X':
            R = Matrix.Rotation(math.radians(90), 4, 'Y')
        elif axis == 'Y':
            R = Matrix.Rotation(math.radians(90), 4, 'X')
        M = xform(loc, rot) @ R
        if matrix is not None:
            M = matrix @ M
        self.add_bm(bm, m, M, uv=uv, uv_pre=pre)

    def sphere(self, r, loc=(0, 0, 0), m=None, seg=16, rings=8, scale=(1, 1, 1),
               rot=None, matrix=None, cut_below=None, uv=None):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
        for v in bm.verts:
            v.co.x *= scale[0]
            v.co.y *= scale[1]
            v.co.z *= scale[2]
        if cut_below is not None:  # keep only the upper part (dome)
            geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
            res = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5,
                                         plane_co=(0, 0, cut_below), plane_no=(0, 0, 1),
                                         clear_inner=True)
            edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
            if edges:
                bmesh.ops.edgeloop_fill(bm, edges=edges)
        M = xform(loc, rot)
        if matrix is not None:
            M = matrix @ M
        self.add_bm(bm, m, M, uv=uv)

    def beam(self, p0, p1, w, t, m, r=0.0, seg=1, up=(0, 0, 1), uv=None):
        """Box from p0 to p1 with cross-section w (local x) by t (local y)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        L = d.length
        q = d.normalized().to_track_quat('Z', 'Y')
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co.x *= w
            v.co.y *= t
            v.co.z *= L
        _bevel(bm, list(bm.edges), r, seg)
        self.add_bm(bm, m, Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4(), uv=uv)

    def decal(self, face, d, u, v, w, h, cell, m=None, off=0.02):
        """Flat quad on a wall plane (face/d/u as in window(): u runs along the wall's local
        X, v = centre height), `off` (2 cm) in front of the wall, w x h metres, with planar
        UVs filling an atlas_town cell (`cell` = cell name or a Blender-UV rect).  The image
        reads left-to-right for a viewer facing the wall.  Default material: 'AtlasTown'
        (white x atlas_town)."""
        if m is None:
            m = T.tmat('AtlasTown', '#ffffff', 'atlas_town', rough=0.6)
        rect = T.atlas_rect(cell) if isinstance(cell, str) else tuple(cell)
        Mw = wall_matrix(face)
        y = d + off
        corners = [(u + w / 2, y, v - h / 2), (u - w / 2, y, v - h / 2),
                   (u - w / 2, y, v + h / 2), (u + w / 2, y, v + h / 2)]
        bm = bmesh.new()
        bm.faces.new([bm.verts.new(c) for c in corners])
        R3 = Mw.to_3x3()
        mode = ('planar', Mw @ Vector(corners[0]), R3 @ Vector((-1, 0, 0)), R3 @ Vector((0, 0, 1)),
                w, h, {'rect': rect})
        self.add_bm(bm, m, Mw, uv=mode)

    def torus(self, R, r, loc=(0, 0, 0), m=None, seg=24, rseg=12, rot=None,
              minor_fn=None, matrix=None, uv=None):
        """Torus around local Z.  minor_fn(theta, phi) -> (radial_offset, z_offset, rr)
        lets callers deform the tube (frosting etc).  uv=('cyl',): u = around the ring,
        v = around the tube."""
        mode = T.norm_uv(uv)
        pre = mode is not None and mode[0] == 'cyl'
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new(UV_NAME)
        rows = []
        for i in range(seg):
            th = 2 * math.pi * i / seg
            ct, st = math.cos(th), math.sin(th)
            row = []
            for j in range(rseg):
                ph = 2 * math.pi * j / rseg
                cp, sp = math.cos(ph), math.sin(ph)
                rr, dz = r, 0.0
                if minor_fn is not None:
                    rr, dz = minor_fn(th, ph)
                rad = R + rr * cp
                row.append(bm.verts.new((rad * ct, rad * st, rr * sp + dz)))
            rows.append(row)
        for i in range(seg):
            a, b = rows[i], rows[(i + 1) % seg]
            for j in range(rseg):
                k = (j + 1) % rseg
                f = bm.faces.new((a[j], b[j], b[k], a[k]))
                if pre:
                    for l, c in zip(f.loops, ((i / seg, j / rseg), ((i + 1) / seg, j / rseg),
                                              ((i + 1) / seg, (j + 1) / rseg), (i / seg, (j + 1) / rseg))):
                        l[uvl].uv = T.remap_rect(c, mode[2])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        M = xform(loc, rot)
        if matrix is not None:
            M = matrix @ M
        self.add_bm(bm, m, M, uv=uv, uv_pre=pre)

    # -- output ----------------------------------------------------------
    def build(self, name, location=(0, 0, 0), smooth_angle=50.0, parent=None):
        """Create the mesh object.  Vertices are given in WORLD space; the object
        origin is placed at `location` (pivot) and verts are offset accordingly.
        The UV map "UVMap" is filled from the per-corner list (validate() must not have
        dropped or reordered anything: checked)."""
        loc = Vector(location)
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(Vector(v) - loc) for v in self.verts], [], self.faces)
        for mm in self.mats:
            me.materials.append(mm)
        if self.fmat:
            me.polygons.foreach_set('material_index', self.fmat)
        me.validate(clean_customdata=False)
        flat_idx = [i for f in self.faces for i in f]
        got = [0] * len(me.loops)
        me.loops.foreach_get('vertex_index', got)
        if len(me.polygons) != len(self.faces) or got != flat_idx:
            print("   [uv] %s: validate() changed the topology (%d -> %d polygons, %d -> %d loops); "
                  "primitive log:" % (name, len(self.faces), len(me.polygons), len(flat_idx), len(got)))
            for t, mn in self.log:
                print("        %5d tris  %s" % (t, mn))
            raise RuntimeError("%s: mesh validation dropped/reordered faces; UVs would misalign" % name)
        uvl = me.uv_layers.new(name=UV_NAME)
        uvl.uv.foreach_set('vector', [c for face in self.uvs for uv in face for c in uv])
        if len(me.uv_layers) != 1:
            raise RuntimeError("%s: expected exactly one UV map" % name)
        me.update()
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth_angle))
        ob = bpy.data.objects.new(name, me)
        scene_coll().objects.link(ob)
        ob.location = loc
        if DEBUG_TRIS and self.log and not name.startswith('_'):
            per = {}
            for t, mn in self.log:
                per[mn] = per.get(mn, 0) + t
            top = sorted(per.items(), key=lambda kv: -kv[1])[:8]
            print(f"   [tris] {name}: {sum(per.values())} by material {top}")
        if parent is not None:
            ob.parent = parent
        return ob


def empty(name, loc=(0, 0, 0), parent=None, size=0.3, kind='PLAIN_AXES', rot=None, scale=None):
    """Empty node; loc/rot (euler degrees, XYZ)/scale are LOCAL to `parent` (no parent
    inverse is set, so the exported glTF node TRS is exactly these values, axis-converted)."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = kind
    ob.empty_display_size = size
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = [math.radians(a) for a in rot]
    if scale is not None:
        ob.scale = scale
    scene_coll().objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def boolean_cut(ob, cutters, solver='EXACT'):
    """Apply DIFFERENCE booleans with temporary cutter objects; cutters are removed."""
    for i, c in enumerate(cutters):
        mod = ob.modifiers.new(f"cut{i}", 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = solver
        mod.material_mode = 'TRANSFER'  # cut faces take the cutter's material
        if solver == 'EXACT':
            mod.use_self = True  # input shells may overlap each other
        mod.object = c
        c.hide_render = True
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    new_me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = new_me
    bpy.data.meshes.remove(old)
    for c in cutters:
        me = c.data
        bpy.data.objects.remove(c, do_unlink=True)
        bpy.data.meshes.remove(me)
    return ob


def tri_count(ob):
    if ob.type != 'MESH':
        return 0
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def hierarchy(root):
    return [root] + list(root.children_recursive)


def world_bounds(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for v in ob.data.vertices:
            w = ob.matrix_world @ v.co
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return mn, mx


def export_glb(root, path):
    bpy.context.view_layer.update()
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    for ob in hierarchy(root):
        ob.select_set(True)
    bpy.context.view_layer.objects.active = root
    # another process (dev server, a reader) can hold the file for a moment on Windows: retry
    import time
    for attempt in range(10):
        try:
            bpy.ops.export_scene.gltf(
                filepath=path, export_format='GLB', use_selection=True,
                export_apply=True, export_yup=True, export_animations=False,
                export_materials='EXPORT', export_cameras=False, export_lights=False,
                export_extras=False)
            T.externalize_images(path)
            return
        except (RuntimeError, OSError) as e:
            if attempt == 9 or 'Errno' not in str(e):
                raise
            print("   [export] %s busy (%s), retrying" % (os.path.basename(path), str(e).splitlines()[-1][:80]))
            time.sleep(1.0 + attempt)


def seeded(seed):
    return random.Random(seed)
