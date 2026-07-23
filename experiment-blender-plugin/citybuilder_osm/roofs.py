"""roofs.py — building bodies + roof shapes (Buildings v3).

Contract: SPEC.md "roofs.py" + specs/elevation-terrain.md §D (BASE_SINK 0.4,
cornice numbers). Pure module (stdlib + geom only, no bpy — the optional
straight-skeleton path uses vendored bpypolyskel, which needs mathutils and
therefore only activates inside Blender). Coordinates: metres, X = east,
Y = north, Z = up.

Walls are one geom.add_prism from base_z − BASE_SINK to base_z + height with
courtyard holes honoured. Roof by shape:
  flat      — prism top cap (roof_flat) + parapet (h ≥ 12) or cornice band
  gabled    — 2 slope quads + 2 vertical gable tris (wall material)
  hipped    — bpypolyskel straight skeleton (true hips, concave OK); falls
              back to the v0.5 inset-ridge approximation without mathutils
  pyramidal — centroid peak fan
  dome      — flat cap + squashed hemisphere (roof:shape=dome/onion), roof_dome
Complex low footprints (auto, ≤ 14 verts, no holes) also try the skeleton
before falling back to flat; unknown tags (skillion, ...) fall back to flat.

Buildings v3 (recognizer-driven, all optional via b["look"], default = v0.5):
  look.facade plaster|brick|panel|glass → wall material family
  look.roof   tile|metal                → pitched-roof material
  look.tint   0..1                      → facade palette selector
  look.storefront                       → 4.2 m dark-glass ground band
  look.balconies                        → hash-gated slab+rail boxes on the
                                          longest facade (residential ≥ 4 fl)

Facade UVs: u = metres along the wall loop (from add_prism), v = metres up
FROM the wall base (add_prism writes absolute z; we shift by −z0 after).
Roof/cap faces get planar-metre UVs. attrs["tint"] = look.tint (else
geom.hash01(id)) on ALL faces.
"""
import math

try:
    from . import geom
except ImportError:  # direct `python3 roofs.py` execution
    import geom

# straight-skeleton backend: vendored bpypolyskel (GPL-3, see vendor/) —
# imports mathutils, so it is None in plain-python3 self-test runs
try:
    from .vendor.bpypolyskel import bpypolyskel as _POLYSKEL
except Exception:
    try:
        from vendor.bpypolyskel import bpypolyskel as _POLYSKEL
    except Exception:
        _POLYSKEL = None

# --- specs/elevation-terrain.md §D constants ---------------------------------
BASE_SINK = 0.4         # building base sits 0.4 m below sampled ground
CORNICE_BAND = 0.7      # cornice band height, straddles the roofline (m)
CORNICE_OVERHANG = 0.4  # cornice sticks out ~0.4 m all round
CORNICE_SCALE_MAX = 1.06
CORNICE_SCALE_MIN = 1.01
CORNICE_MIN_R = 3.0     # skip cornice if footprint half-extent < 3 m

# --- SPEC.md roofs.py constants ----------------------------------------------
FLAT_MIN_H = 12.0       # auto: h >= 12 → flat; flat h >= 12 → parapet
PARAPET_H = 0.5         # parapet band height (m)
PARAPET_W = 0.3         # parapet thickness, inward (m)
HIP_SHRINK = 0.28       # ridge shrunk 28% from each end (SPEC table says 30%)
GABLE_SHARE = 0.6       # hash01(id) < 0.6 → gabled else hipped (quasi-rect auto)
ROOF_H_MIN = 1.2        # auto roof height clamp (m)
ROOF_H_MAX = 4.5
ROOF_H_FRAC = 0.35      # auto roof height = 0.35 × shorter OBB extent

MAT_WALL = "building_wall"
MAT_FLAT = "roof_flat"
MAT_TILE = "roof_tile"
MAT_METAL = "roof_metal"
MAT_DOME = "roof_dome"
MAT_STOREFRONT = "storefront"
MAT_BALCONY = "concrete"
MAT_RAIL = "metal_dark"

# recognizer facade family → wall material key
FACADE_MAT = {"plaster": "building_wall", "brick": "building_wall_brick",
              "panel": "building_panel", "glass": "curtain_wall"}

STOREFRONT_H = 4.2       # §3.4 ground-floor dark-glass band height (m)
SKELETON_MAX_VERTS = 24  # bpypolyskel guard: bigger rings fall back to flat
BALCONY_W = 1.9          # slab width along the facade (m)
BALCONY_D = 0.92         # slab depth outward (m)
BALCONY_STEP = 4.6       # spacing between balcony columns (m)
BALCONY_MAX_FLOORS = 6

_KNOWN_SHAPES = ("flat", "gabled", "hipped", "pyramidal", "dome")


# =============================================================================
# small helpers
# =============================================================================

def _id_int(v):
    """OSM ids are ints; hash arbitrary ids (e.g. 'way/123') via FNV-1a."""
    if isinstance(v, int):
        return v
    h = 2166136261
    for ch in str(v):
        h = ((h ^ ord(ch)) * 16777619) % 4294967296
    return h


def _centroid(ring):
    """Area centroid (falls back to vertex mean for degenerate rings)."""
    a = geom.ring_area_signed(ring)
    n = len(ring)
    if abs(a) < 1e-9:
        return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
    cx = cy = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        w = x1 * y2 - x2 * y1
        cx += (x1 + x2) * w
        cy += (y1 + y2) * w
    return (cx / (6.0 * a), cy / (6.0 * a))


def _scale_ring(ring, s, about=None):
    """Scale a ring about a point (default: its own area centroid)."""
    cx, cy = about if about is not None else _centroid(ring)
    return [(cx + (x - cx) * s, cy + (y - cy) * s) for x, y in ring]


def _half_extent(ring):
    """Half of the larger AABB extent — the app's cornice 'r'."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys)) / 2.0


def _is_convex(ring, eps=1e-9):
    n = len(ring)
    pos = neg = False
    for i in range(n):
        ax, ay = ring[i]
        bx, by = ring[(i + 1) % n]
        cx, cy = ring[(i + 2) % n]
        cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if cr > eps:
            pos = True
        elif cr < -eps:
            neg = True
    return not (pos and neg)


def _hull_area(ring):
    """Convex hull area (Andrew's monotone chain)."""
    pts = sorted(set((float(x), float(y)) for x, y in ring))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and cross(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    lower = half(pts)
    upper = half(reversed(pts))
    hull = lower[:-1] + upper[:-1]
    if len(hull) < 3:
        return 0.0
    return abs(geom.ring_area_signed(hull))


def _quasi_rect(ring):
    """4-vert convex footprint with opposite side lengths within 25%."""
    if len(ring) != 4 or not _is_convex(ring):
        return False
    e = [math.hypot(ring[(i + 1) % 4][0] - ring[i][0],
                    ring[(i + 1) % 4][1] - ring[i][1]) for i in range(4)]
    if min(e) < 1e-6:
        return False
    return (min(e[0], e[2]) / max(e[0], e[2]) >= 0.75
            and min(e[1], e[3]) / max(e[1], e[3]) >= 0.75)


def _frame(ring):
    """Dominant-axis frame from the longest edge.

    Returns (ex, ey, u0, u1, v0, v1, k): unit axis (ex, ey), footprint extents
    in that frame (u along axis, v across), and the longest-edge index k.
    Reconstruction: p = u*(ex, ey) + v*(-ey, ex).
    """
    n = len(ring)
    best = -1.0
    k = 0
    for i in range(n):
        j = (i + 1) % n
        d2 = (ring[j][0] - ring[i][0]) ** 2 + (ring[j][1] - ring[i][1]) ** 2
        if d2 > best:
            best, k = d2, i
    ax, ay = ring[k]
    bx, by = ring[(k + 1) % n]
    ln = math.hypot(bx - ax, by - ay) or 1.0
    ex, ey = (bx - ax) / ln, (by - ay) / ln
    us = [p[0] * ex + p[1] * ey for p in ring]
    vs = [-p[0] * ey + p[1] * ex for p in ring]
    return ex, ey, min(us), max(us), min(vs), max(vs), k


def _roof_h(b, ring):
    """roof_height tag wins; else clamp(0.35 × shorter OBB extent, 1.2, 4.5)."""
    rh = b.get("roof_height")
    if rh:
        try:
            return max(0.3, float(rh))
        except (TypeError, ValueError):
            pass
    _, _, u0, u1, v0, v1, _ = _frame(ring)
    return min(ROOF_H_MAX, max(ROOF_H_MIN, ROOF_H_FRAC * min(u1 - u0, v1 - v0)))


# =============================================================================
# shape decision — tiny and deterministic
# =============================================================================

def _auto_shape(b, ring, holes, h):
    n = len(ring)
    area = geom.ring_area_m2(ring)
    hull = _hull_area(ring)
    strongly_concave = hull > 1e-9 and area < 0.6 * hull
    if h >= FLAT_MIN_H or holes or n > 8 or strongly_concave:
        return "flat"
    if n == 4 and _quasi_rect(ring):
        # 60/40 gabled/hipped so streets of row houses don't look uniform
        return "gabled" if geom.hash01(_id_int(b.get("id", 0))) < GABLE_SHARE else "hipped"
    if n <= 6:
        return "hipped"
    return "flat"


def _guard_shape(shape, ring, holes):
    """Safety net (applies to explicit tags too): footprints the pitched
    builders can't roof cleanly fall back to flat."""
    if shape == "flat":
        return shape
    if holes:
        return "flat"
    n = len(ring)
    area = geom.ring_area_m2(ring)
    hull = _hull_area(ring)
    if hull <= 1e-9 or area < 1e-6:
        return "flat"
    if shape == "gabled":
        return "gabled" if (n == 4 and _is_convex(ring)) else "flat"
    if shape == "hipped":
        # 0.9 gate: near-convex only — an L-shape (ratio ~0.82) would get hip
        # planes crossing its notch, so it must demote to flat
        return "hipped" if (n <= 6 and area >= 0.9 * hull) else "flat"
    if shape == "dome":
        _, _, u0, u1, v0, v1, _ = _frame(ring)
        return "dome" if min(u1 - u0, v1 - v0) >= 2.0 else "flat"
    return "pyramidal" if (n <= 8 and area >= 0.7 * hull) else "flat"


def _pick_shape(b, ring, holes, h):
    """(shape, skeleton_wanted) — shape is guard-safe for the v0.5 builders;
    skeleton_wanted marks footprints where the bpypolyskel path should try a
    true hipped roof FIRST (explicit hipped tags, and complex low auto-flats)."""
    tag = str(b.get("roof_shape") or "auto").strip().lower()
    if tag == "onion":
        tag = "dome"
    if tag in _KNOWN_SHAPES:
        shape = tag                      # explicit tag wins over the h>=12 rule
    elif tag != "auto":
        shape = "flat"                   # skillion / ... → flat
    else:
        shape = _auto_shape(b, ring, holes, h)
    n = len(ring)
    skeleton_wanted = (not holes and n <= SKELETON_MAX_VERTS and (
        shape == "hipped"
        or (tag == "auto" and shape == "flat" and h < FLAT_MIN_H and n > 4)))
    return _guard_shape(shape, ring, holes), skeleton_wanted


# =============================================================================
# MeshData face helpers
# =============================================================================

def _newell(pts):
    nx = ny = nz = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1, z1 = pts[i]
        x2, y2, z2 = pts[(i + 1) % n]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return nx, ny, nz


def _add_face(md, pts, mat, uv):
    """Append one 3D face with its own vertices (winding as given)."""
    nx, ny, nz = _newell(pts)
    if math.hypot(math.hypot(nx, ny), nz) < 1e-8:
        return  # degenerate sliver — skip
    if md["uvs"] is None:
        md["uvs"] = [None] * len(md["faces"])
    base = len(md["verts"])
    md["verts"].extend(pts)
    md["faces"].append(list(range(base, base + len(pts))))
    md["mats"].append(mat)
    md["uvs"].append(uv)


def _roof_uv(pts):
    """Planar metres in the roof plane: u along the eave edge (pts[0]→pts[1]),
    v = metres up the slope (plan distance from eave line + rise, combined)."""
    ax, ay, az = pts[0]
    bx, by, _ = pts[1]
    ex, ey = bx - ax, by - ay
    ln = math.hypot(ex, ey)
    ex, ey = (ex / ln, ey / ln) if ln > 1e-9 else (1.0, 0.0)
    out = []
    for x, y, z in pts:
        u = (x - ax) * ex + (y - ay) * ey
        left = ex * (y - ay) - ey * (x - ax)  # signed plan distance off the eave
        out.append((u, math.hypot(left, z - az)))
    return out


def _gable_uv(pts, z0):
    """Vertical gable wall triangle: u = metres along the top edge,
    v = metres up from the wall base (matches facade shader convention)."""
    ax, ay, _ = pts[0]
    bx, by, _ = pts[1]
    ex, ey = bx - ax, by - ay
    ln = math.hypot(ex, ey)
    ex, ey = (ex / ln, ey / ln) if ln > 1e-9 else (1.0, 0.0)
    return [((x - ax) * ex + (y - ay) * ey, z - z0) for x, y, z in pts]


def _shift_wall_v(md, f0, z0):
    """add_prism writes wall uv v as ABSOLUTE z; the contract wants metres up
    from the base — shift every uv'd face added since f0 by −z0."""
    if md["uvs"] is None:
        return
    for i in range(f0, len(md["faces"])):
        uv = md["uvs"][i]
        if uv is not None:
            md["uvs"][i] = [(u, v - z0) for u, v in uv]


def _fill_planar_uvs(md, f0):
    """Cap faces come out of add_prism with uv None — fill with plan metres."""
    if md["uvs"] is None:
        return
    for i in range(f0, len(md["faces"])):
        if md["uvs"][i] is None:
            md["uvs"][i] = [(md["verts"][vi][0], md["verts"][vi][1])
                            for vi in md["faces"][i]]


# =============================================================================
# roof builders (ring is CCW, deduped; roof sits on the wall-top loop at z=top)
# =============================================================================

def _roof_gabled(md, ring, top, rh, z0_wall, mat=MAT_TILE, wall_mat=MAT_WALL):
    """Exact gable for a convex quad: 2 slope quads + 2 vertical gable tris.

    Longest edge pair = eaves; ridge spans the midpoints of the two end edges
    at top + rh. Winding follows the wall pattern (along edge, then up) so all
    faces read CCW from outside.
    """
    _, _, _, _, _, _, k = _frame(ring)
    a, b, c, d = (ring[k], ring[(k + 1) % 4], ring[(k + 2) % 4], ring[(k + 3) % 4])
    rz = top + rh
    r1 = ((b[0] + c[0]) / 2.0, (b[1] + c[1]) / 2.0, rz)  # above end edge b→c
    r0 = ((d[0] + a[0]) / 2.0, (d[1] + a[1]) / 2.0, rz)  # above end edge d→a
    at, bt = (a[0], a[1], top), (b[0], b[1], top)
    ct, dt = (c[0], c[1], top), (d[0], d[1], top)
    for quad in ([at, bt, r1, r0], [ct, dt, r0, r1]):
        _add_face(md, quad, mat, _roof_uv(quad))
    for tri in ([bt, ct, r1], [dt, at, r0]):
        _add_face(md, tri, wall_mat, _gable_uv(tri, z0_wall))


def _roof_hipped(md, ring, top, rh, mat=MAT_TILE):
    """Inset-ridge hip: project each footprint edge onto a ridge shrunk
    HIP_SHRINK from each end. Rectangles get 2 trapezoids + 2 hip triangles
    exactly; 5–6-vert convex footprints get the same construction with quads
    split into triangles (they may be slightly non-planar)."""
    ex, ey, u0, u1, v0, v1, _ = _frame(ring)
    vm = (v0 + v1) / 2.0
    shrink = HIP_SHRINK * (u1 - u0)
    ru0, ru1 = u0 + shrink, u1 - shrink
    if ru1 < ru0:  # over-shrunk → degenerate to a centre peak (pyramid-like)
        ru0 = ru1 = (u0 + u1) / 2.0
    rz = top + rh

    def ridge_pt(u):
        uc = min(max(u, ru0), ru1)
        return (uc * ex - vm * ey, uc * ey + vm * ex, rz)

    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        qa = ridge_pt(a[0] * ex + a[1] * ey)
        qb = ridge_pt(b[0] * ex + b[1] * ey)
        at, bt = (a[0], a[1], top), (b[0], b[1], top)
        if math.hypot(qa[0] - qb[0], qa[1] - qb[1]) < 1e-6:
            tri = [at, bt, qa]
            _add_face(md, tri, mat, _roof_uv(tri))
        elif n == 4:
            quad = [at, bt, qb, qa]
            _add_face(md, quad, mat, _roof_uv(quad))
        else:
            for tri in ([at, bt, qb], [at, qb, qa]):
                _add_face(md, tri, mat, _roof_uv(tri))


def _roof_pyramidal(md, ring, top, rh, mat=MAT_TILE):
    """Centroid peak fan — one triangle per footprint edge."""
    cx, cy = _centroid(ring)
    peak = (cx, cy, top + rh)
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        tri = [(a[0], a[1], top), (b[0], b[1], top), peak]
        _add_face(md, tri, mat, _roof_uv(tri))


def _roof_skeleton(md, ring, top, rh, mat):
    """True hipped/complex roof via the vendored bpypolyskel straight
    skeleton (PLAN.md §3.4). Raises on any failure — callers fall back to the
    v0.5 approximation. Only available inside Blender (mathutils)."""
    if _POLYSKEL is None:
        raise ImportError("bpypolyskel unavailable (no mathutils)")
    from mathutils import Vector
    verts = [Vector((float(x), float(y), float(top))) for x, y in ring]
    faces = _POLYSKEL.polygonize(verts, 0, len(ring), None, float(rh), 0.0, [])
    if not faces:
        raise ValueError("skeleton produced no roof faces")
    added = 0
    for f in faces:
        pts = []
        for i in f:
            p = (verts[i].x, verts[i].y, verts[i].z)
            if not pts or (abs(p[0] - pts[-1][0]) > 1e-9
                           or abs(p[1] - pts[-1][1]) > 1e-9
                           or abs(p[2] - pts[-1][2]) > 1e-9):
                pts.append(p)
        if len(pts) < 3:
            continue
        for x, y, z in pts:
            if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
                raise ValueError("skeleton emitted non-finite vertex")
            if z < top - 1e-6 or z > top + rh + 1e-6:
                raise ValueError("skeleton z out of range")
        _add_face(md, pts, mat, _roof_uv(pts))
        added += 1
    if not added:
        raise ValueError("skeleton faces all degenerate")


DOME_SQUASH = 0.85   # dome height = 0.85 × inscribed radius
_DOME_SEGS = 12
_DOME_RINGS = 5


def _roof_dome(md, ring, top):
    """Squashed hemisphere over the footprint centroid (roof:shape=dome/onion),
    radius = half the shorter oriented extent. Sits on the flat cap."""
    cx, cy = _centroid(ring)
    _, _, u0, u1, v0, v1, _ = _frame(ring)
    r = 0.5 * min(u1 - u0, v1 - v0)
    zs = top + r * DOME_SQUASH
    rows = []
    for k in range(_DOME_RINGS):
        th = (k / _DOME_RINGS) * (math.pi / 2.0)
        rr = r * math.cos(th)
        z = top + r * DOME_SQUASH * math.sin(th)
        rows.append([(cx + rr * math.cos(a), cy + rr * math.sin(a), z)
                     for a in (j * math.tau / _DOME_SEGS for j in range(_DOME_SEGS))])
    for k in range(_DOME_RINGS - 1):
        lo, hi = rows[k], rows[k + 1]
        for j in range(_DOME_SEGS):
            j2 = (j + 1) % _DOME_SEGS
            quad = [lo[j], lo[j2], hi[j2], hi[j]]
            _add_face(md, quad, MAT_DOME,
                      [(p[0], p[1]) for p in quad])
    apex = (cx, cy, zs)
    for j in range(_DOME_SEGS):
        j2 = (j + 1) % _DOME_SEGS
        tri = [rows[-1][j], rows[-1][j2], apex]
        _add_face(md, tri, MAT_DOME, [(p[0], p[1]) for p in tri])


# =============================================================================
# balconies (Buildings v3)
# =============================================================================

def _balconies(md, ring, base_z, h, bid):
    """Slab + front-rail boxes on the longest facade edge: one column every
    BALCONY_STEP m (max 2), floors 1..min(levels−1, 6), slab top at the window
    sill (v = 3.2·f + 0.99 from the base), hash-gated per box."""
    n = len(ring)
    _, _, _, _, _, _, k = _frame(ring)
    ax, ay = ring[k]
    bx, by = ring[(k + 1) % n]
    elen = math.hypot(bx - ax, by - ay)
    if elen < BALCONY_W + 2.4:
        return
    ex, ey = (bx - ax) / elen, (by - ay) / elen
    ox, oy = ey, -ex                        # outward normal of a CCW ring edge
    floors = min(int(h / 3.2) - 1, BALCONY_MAX_FLOORS)
    if floors < 1:
        return
    cols = min(2, max(1, int((elen - 2.4) // BALCONY_STEP)))
    span = cols * BALCONY_W + (cols - 1) * (BALCONY_STEP - BALCONY_W)
    t_start = (elen - span) / 2.0
    seed = _id_int(bid)
    for ci in range(cols):
        t0 = t_start + ci * BALCONY_STEP
        p0 = (ax + ex * t0, ay + ey * t0)
        p1 = (ax + ex * (t0 + BALCONY_W), ay + ey * (t0 + BALCONY_W))
        for f in range(1, floors + 1):
            if geom.hash01(seed * 8191 + ci * 127 + f * 31) > 0.8:
                continue  # a skipped box here and there reads lived-in
            sill = base_z + f * 3.2 + 0.99
            slab = [p0, p1,
                    (p1[0] + ox * BALCONY_D, p1[1] + oy * BALCONY_D),
                    (p0[0] + ox * BALCONY_D, p0[1] + oy * BALCONY_D)]
            geom.add_prism(md, slab, sill - 0.14, sill, MAT_BALCONY,
                           mat_top=MAT_BALCONY, mat_bottom=MAT_BALCONY,
                           uv_walls=False)
            rail = [(p0[0] + ox * (BALCONY_D - 0.06), p0[1] + oy * (BALCONY_D - 0.06)),
                    (p1[0] + ox * (BALCONY_D - 0.06), p1[1] + oy * (BALCONY_D - 0.06)),
                    (p1[0] + ox * BALCONY_D, p1[1] + oy * BALCONY_D),
                    (p0[0] + ox * BALCONY_D, p0[1] + oy * BALCONY_D)]
            geom.add_prism(md, rail, sill, sill + 0.95, MAT_RAIL,
                           mat_top=MAT_RAIL, uv_walls=False)


# =============================================================================
# public API
# =============================================================================

def build_building(b, base_z):
    """graph["buildings"] dict + seat elevation → MeshData (SPEC.md roofs.py).

    Walls run base_z − BASE_SINK → base_z + height (or from base_z +
    min_height for floating parts like building:part decks); courtyard holes
    honoured. Roof per _pick_shape (+ bpypolyskel skeleton path in Blender).
    b["look"] (recognizer) drives wall/roof materials, tint, storefront band
    and balconies; absent look = exact v0.5 behaviour.
    """
    md = geom.new_meshdata()
    ring = geom.dedupe_ring([(float(x), float(y)) for x, y in (b.get("ring") or [])])
    if len(ring) < 3:
        return md
    if geom.ring_area_signed(ring) < 0:
        ring = list(reversed(ring))
    holes = []
    for raw in b.get("holes") or []:
        hr = geom.dedupe_ring([(float(x), float(y)) for x, y in raw])
        if len(hr) >= 3:
            holes.append(hr)

    h = max(1.0, float(b.get("height") or 8.0))
    minh = max(0.0, min(float(b.get("min_height") or 0.0), h - 0.5))
    z0 = (base_z + minh) if minh > 0 else (base_z - BASE_SINK)
    top = base_z + h
    shape, skeleton_wanted = _pick_shape(b, ring, holes, h)

    look = b.get("look") or {}
    wall_mat = FACADE_MAT.get(look.get("facade"), MAT_WALL)
    roof_mat = MAT_METAL if look.get("roof") == "metal" else MAT_TILE
    glass = wall_mat == "curtain_wall"
    if glass:
        shape, skeleton_wanted = "flat", False  # towers stay flat masses

    # skeleton path FIRST (true hips, concave OK); silently falls back
    roof_done = False
    if skeleton_wanted:
        pre = (len(md["verts"]), len(md["faces"]))
        try:
            _roof_skeleton(md, ring, top, _roof_h(b, ring), roof_mat)
            roof_done = True
            shape = "skeleton"
        except Exception:
            del md["verts"][pre[0]:]      # roll back partial skeleton output
            del md["faces"][pre[1]:]
            del md["mats"][pre[1]:]
            if md["uvs"] is not None:
                del md["uvs"][pre[1]:]
            if shape == "skeleton":
                shape = "flat"

    # --- body: walls (+ flat cap when the roof IS the cap) -------------------
    storefront = (bool(look.get("storefront")) and minh <= 0.0
                  and h >= STOREFRONT_H + 1.2 and not glass)
    cap = MAT_FLAT if shape in ("flat", "dome") else None
    if storefront:
        fs = len(md["faces"])
        geom.add_prism(md, ring, z0, base_z + STOREFRONT_H, MAT_STOREFRONT,
                       holes=holes)
        _shift_wall_v(md, fs, z0)
        f0 = len(md["faces"])
        geom.add_prism(md, ring, base_z + STOREFRONT_H, top, wall_mat,
                       mat_top=cap, holes=holes)
        _shift_wall_v(md, f0, base_z + STOREFRONT_H)  # window rows restart
        _fill_planar_uvs(md, f0)
    else:
        f0 = len(md["faces"])
        geom.add_prism(md, ring, z0, top, wall_mat, mat_top=cap, holes=holes)
        _shift_wall_v(md, f0, z0)   # facade v = metres up from wall base
        _fill_planar_uvs(md, f0)    # flat cap → plan-metre UVs

    # --- roof ----------------------------------------------------------------
    if roof_done:
        pass
    elif shape == "gabled":
        _roof_gabled(md, ring, top, _roof_h(b, ring), z0, roof_mat, wall_mat)
    elif shape == "hipped":
        _roof_hipped(md, ring, top, _roof_h(b, ring), roof_mat)
    elif shape == "pyramidal":
        _roof_pyramidal(md, ring, top, _roof_h(b, ring), roof_mat)
    elif shape == "dome":
        _roof_dome(md, ring, top)
    else:
        r = _half_extent(ring)
        if h >= FLAT_MIN_H:
            # parapet ring: 0.5 h × 0.3 w inward along the outer rim
            if r >= 2.0:  # too thin → inner ring would collapse
                inner = _scale_ring(ring, max(0.5, 1.0 - PARAPET_W / r))
                fp = len(md["faces"])
                geom.add_prism(md, ring, top, top + PARAPET_H, wall_mat,
                               mat_top=MAT_FLAT, holes=[inner])
                _shift_wall_v(md, fp, top)
                _fill_planar_uvs(md, fp)
        elif r >= CORNICE_MIN_R and not glass:
            # §D cornice: 0.7 band straddling the roofline, ~0.4 overhang via
            # scale about the outer centroid (holes scaled with the SAME
            # transform so the courtyard stays open and nothing goes coplanar)
            s = min(CORNICE_SCALE_MAX,
                    max(CORNICE_SCALE_MIN, 1.0 + CORNICE_OVERHANG / r))
            c = _centroid(ring)
            band = _scale_ring(ring, s, about=c)
            band_holes = [_scale_ring(hr, s, about=c) for hr in holes]
            fp = len(md["faces"])
            geom.add_prism(md, band, top - CORNICE_BAND / 2.0,
                           top + CORNICE_BAND / 2.0, MAT_FLAT,
                           mat_top=MAT_FLAT, mat_bottom=MAT_FLAT,
                           holes=band_holes)
            _shift_wall_v(md, fp, top - CORNICE_BAND / 2.0)
            _fill_planar_uvs(md, fp)

    # --- balconies (residential ≥ 4 storeys, recognizer hash-gated) ----------
    if look.get("balconies") and minh <= 0.0 and not glass:
        fb = len(md["faces"])
        _balconies(md, ring, base_z, h, b.get("id", 0))
        _fill_planar_uvs(md, fb)  # concrete/rail ignore UVs; contract wants them

    tint = look["tint"] if "tint" in look else geom.hash01(_id_int(b.get("id", 0)))
    md["attrs"]["tint"] = [tint] * len(md["faces"])
    return md


# =============================================================================
# self-tests
# =============================================================================

if __name__ == "__main__":
    EPS = 1e-6

    def check(md, label):
        assert len(md["faces"]) > 0 and len(md["verts"]) > 0, label
        assert len(md["mats"]) == len(md["faces"]), label
        assert md["uvs"] is not None and len(md["uvs"]) == len(md["faces"]), label
        for f, uv in zip(md["faces"], md["uvs"]):
            assert len(f) >= 3 and len(set(f)) == len(f), label
            assert all(0 <= i < len(md["verts"]) for i in f), label
            assert uv is not None and len(uv) == len(f), label
            for u, v in uv:
                assert math.isfinite(u) and math.isfinite(v), label
        for vert in md["verts"]:
            assert all(math.isfinite(c) for c in vert), label
        t = md["attrs"]["tint"]
        assert len(t) == len(md["faces"]) and len(set(t)) == 1, label

    def maxz(md):
        return max(v[2] for v in md["verts"])

    def minz(md):
        return min(v[2] for v in md["verts"])

    rect = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)]
    base = 5.0

    # ---- 1. 20×10 rect h=8 explicit gabled ---------------------------------
    b = {"ring": rect, "height": 8.0, "roof_shape": "gabled", "id": 42}
    md = build_building(b, base)
    check(md, "gabled rect")
    rh = 0.35 * 10.0  # shorter extent 10 → 3.5, inside [1.2, 4.5]
    assert abs(maxz(md) - (base + 8.0 + rh)) < EPS, "ridge z"
    assert abs(minz(md) - (base - BASE_SINK)) < EPS, "base sink"
    assert len(md["faces"]) == 4 + 4, "walls + 2 slope quads + 2 gable tris"
    assert md["mats"].count(MAT_TILE) == 2 and md["mats"].count(MAT_WALL) == 6
    assert MAT_FLAT not in md["mats"]
    assert md["attrs"]["tint"][0] == geom.hash01(42)
    # ridge verts sit on the end-edge midpoints
    ridge = sorted({(round(v[0], 6), round(v[1], 6))
                    for v in md["verts"] if abs(v[2] - (base + 8.0 + rh)) < EPS})
    assert ridge == [(0.0, 5.0), (20.0, 5.0)], ridge
    # slope quads face upward, walls' uv v spans 0..h+BASE_SINK
    for f, m in zip(md["faces"], md["mats"]):
        if m == MAT_TILE:
            assert _newell([md["verts"][i] for i in f])[2] > 0, "roof faces up"
    # prism walls (reach down to the sunk base) have facade v in 0..h+BASE_SINK;
    # gable end tris (also building_wall) continue up to ridge − z0 = 11.9
    wall_v = [v for f, uv, m in zip(md["faces"], md["uvs"], md["mats"])
              if m == MAT_WALL and any(md["verts"][i][2] < base for i in f)
              for _, v in uv]
    assert abs(min(wall_v)) < EPS and abs(max(wall_v) - 8.4) < 1e-3, "facade v metres"
    gable_v = [v for f, uv, m in zip(md["faces"], md["uvs"], md["mats"])
               if m == MAT_WALL and all(md["verts"][i][2] >= base + 8.0 - EPS for i in f)
               for _, v in uv]
    assert abs(max(gable_v) - 11.9) < 1e-3, "gable v continues in base metres"

    # ---- 2. auto 60/40 gabled/hipped on quasi-rect --------------------------
    r2 = [(0.0, 0.0), (10.0, 0.0), (10.0, 6.0), (0.0, 6.0)]
    md_g = build_building({"ring": r2, "height": 6.0, "id": 2}, 0.0)   # hash .236 → gabled
    md_h = build_building({"ring": r2, "height": 6.0, "id": 1}, 0.0)   # hash .618 → hipped
    check(md_g, "auto gabled")
    check(md_h, "auto hipped")
    assert md_g["mats"].count(MAT_TILE) == 2, "gabled: 2 slope quads"
    assert md_h["mats"].count(MAT_TILE) == 4, "hipped: 2 trapezoids + 2 hip tris"
    assert md_h["mats"].count(MAT_WALL) == 4, "hipped: no gable end walls"
    rh2 = 0.35 * 6.0
    assert abs(maxz(md_h) - (6.0 + rh2)) < EPS
    ridge2 = sorted({(round(v[0], 6), round(v[1], 6))
                     for v in md_h["verts"] if abs(v[2] - (6.0 + rh2)) < EPS})
    assert ridge2 == [(2.8, 3.0), (7.2, 3.0)], f"hip ridge shrunk 28%: {ridge2}"
    for f, m in zip(md_h["faces"], md_h["mats"]):
        if m == MAT_TILE:
            assert _newell([md_h["verts"][i] for i in f])[2] > 0

    # ---- 3. L-shape h=20 → flat + parapet, no roof_tile ---------------------
    lshape = [(0.0, 0.0), (20.0, 0.0), (20.0, 8.0), (8.0, 8.0), (8.0, 16.0), (0.0, 16.0)]
    md = build_building({"ring": lshape, "height": 20.0, "id": 7}, base)
    check(md, "L flat+parapet")
    assert MAT_TILE not in md["mats"]
    assert abs(maxz(md) - (base + 20.0 + PARAPET_H)) < EPS, "parapet crown"
    top = base + 20.0
    parapet_walls = [f for f, m in zip(md["faces"], md["mats"])
                     if m == MAT_WALL and all(md["verts"][i][2] >= top - EPS for i in f)]
    assert len(parapet_walls) >= 12, "parapet ring walls (outer + inner loops)"
    assert MAT_FLAT in md["mats"]

    # ---- 4. courtyard (ring + hole) → flat, hole walls present --------------
    outer = [(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)]
    hole = [(6.0, 6.0), (14.0, 6.0), (14.0, 14.0), (6.0, 14.0)]
    md_c = build_building({"ring": outer, "holes": [hole], "height": 6.0, "id": 9}, 0.0)
    md_n = build_building({"ring": outer, "height": 6.0, "roof_shape": "flat", "id": 9}, 0.0)
    check(md_c, "courtyard")
    check(md_n, "no-hole flat")
    assert MAT_TILE not in md_c["mats"], "holes force flat"
    assert len(md_c["faces"]) > len(md_n["faces"]), "hole wall faces present"
    body_walls = [f for f, m in zip(md_c["faces"], md_c["mats"])
                  if m == MAT_WALL and any(md_c["verts"][i][2] < 0 for i in f)]
    assert len(body_walls) == 8, "4 outer + 4 courtyard walls"
    # h<12 → cornice band straddling roofline, scaled 1.04 about centroid (10,10)
    assert abs(maxz(md_c) - (6.0 + CORNICE_BAND / 2.0)) < EPS
    assert abs(max(v[0] for v in md_c["verts"]) - 20.4) < 1e-3, "0.4 overhang at r=10"
    # courtyard stays open: cornice hole ring scaled by the same transform
    band_top = [v for v in md_c["verts"] if abs(v[2] - (6.0 + 0.35)) < EPS]
    assert any(abs(v[0] - (10.0 + (6.0 - 10.0) * 1.04)) < 1e-3 for v in band_top)

    # ---- 5. skillion/gambrel → flat fallback; dome/onion → hemisphere -------
    for tag in ("skillion", "gambrel"):
        md = build_building({"ring": rect, "height": 8.0, "roof_shape": tag, "id": 3}, 0.0)
        check(md, tag)
        assert MAT_TILE not in md["mats"], tag
        assert abs(maxz(md) - (8.0 + CORNICE_BAND / 2.0)) < EPS, tag  # cornice (r=10)
    for tag in ("dome", "onion"):
        md = build_building({"ring": rect, "height": 8.0, "roof_shape": tag, "id": 3}, 0.0)
        check(md, tag)
        assert MAT_DOME in md["mats"], tag
        assert MAT_FLAT in md["mats"], tag + " cap under the dome"
        # r = half shorter extent (5), squash 0.85 → apex at 8 + 4.25
        assert abs(maxz(md) - (8.0 + 5.0 * DOME_SQUASH)) < EPS, tag
    dome_faces = [f for f, m in zip(md["faces"], md["mats"]) if m == MAT_DOME]
    assert len(dome_faces) == _DOME_SEGS * _DOME_RINGS, len(dome_faces)
    # tiny footprint: dome demotes to flat
    md = build_building({"ring": [(0, 0), (3, 0), (3, 1.5), (0, 1.5)],
                         "height": 6.0, "roof_shape": "dome", "id": 3}, 0.0)
    assert MAT_DOME not in md["mats"]

    # ---- 6. explicit pyramidal on a square ----------------------------------
    sq = [(0.0, 0.0), (8.0, 0.0), (8.0, 8.0), (0.0, 8.0)]
    md = build_building({"ring": sq, "height": 6.0, "roof_shape": "pyramidal", "id": 11}, 0.0)
    check(md, "pyramidal")
    assert md["mats"].count(MAT_TILE) == 4
    peak = [v for v in md["verts"] if abs(v[2] - (6.0 + 0.35 * 8.0)) < EPS]
    assert peak and all(abs(v[0] - 4.0) < EPS and abs(v[1] - 4.0) < EPS for v in peak)

    # ---- 7. small flat footprint: no cornice (r < 3) ------------------------
    tiny = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]
    md = build_building({"ring": tiny, "height": 8.0, "roof_shape": "flat", "id": 5}, 0.0)
    check(md, "tiny flat")
    assert abs(maxz(md) - 8.0) < EPS, "no cornice, no parapet"

    # ---- 8. min_height part starts above the seat, no base sink -------------
    md = build_building({"ring": rect, "height": 8.0, "min_height": 3.0,
                         "roof_shape": "flat", "id": 6}, base)
    check(md, "min_height")
    assert abs(minz(md) - (base + 3.0)) < EPS

    # ---- 9. explicit tag wins over h>=12; roof_height tag honoured ----------
    md = build_building({"ring": rect, "height": 15.0, "roof_shape": "gabled",
                         "roof_height": 2.0, "id": 8}, 0.0)
    check(md, "tall gabled")
    assert md["mats"].count(MAT_TILE) == 2
    assert abs(maxz(md) - 17.0) < EPS, "tagged roof_height 2.0"

    # ---- 10. guards: concave / many-vert / string id -------------------------
    # (plain python3 has no mathutils → the skeleton path falls back and the
    # v0.5 guards apply verbatim; inside Blender these get true hips instead)
    assert _POLYSKEL is None, "run module self-tests with python3, not Blender"
    dart = [(0.0, 0.0), (10.0, 6.0), (20.0, 0.0), (10.0, 10.0)]  # area < 0.6×hull
    md = build_building({"ring": dart, "height": 6.0, "id": 12}, 0.0)
    check(md, "concave auto")
    assert MAT_TILE not in md["mats"]
    md = build_building({"ring": lshape, "height": 6.0, "roof_shape": "hipped",
                         "id": "way/123"}, 0.0)  # L is concave → guard to flat
    check(md, "hipped guard + string id")
    assert MAT_TILE not in md["mats"]
    assert md["attrs"]["tint"][0] == geom.hash01(_id_int("way/123"))
    ngon = [(10 * math.cos(i * math.pi / 6), 10 * math.sin(i * math.pi / 6))
            for i in range(12)]
    md = build_building({"ring": ngon, "height": 6.0, "id": 13}, 0.0)
    check(md, "12-gon auto flat")
    assert MAT_TILE not in md["mats"], ">8 verts → flat"
    # skeleton candidates are flagged where they should be
    assert _pick_shape({"roof_shape": "hipped"}, lshape, [], 6.0) == ("flat", True)
    assert _pick_shape({}, ngon, [], 6.0) == ("flat", True)      # low complex auto
    assert _pick_shape({}, ngon, [], 20.0) == ("flat", False)    # tall → stays flat
    assert _pick_shape({}, ngon, [hole], 6.0) == ("flat", False)  # holes → never

    # ---- 12. Buildings v3: look-driven materials -----------------------------
    look_brick = {"facade": "brick", "roof": "tile", "tint": 0.63}
    md = build_building({"ring": rect, "height": 8.0, "roof_shape": "gabled",
                         "id": 21, "look": look_brick}, 0.0)
    check(md, "brick look")
    assert "building_wall_brick" in md["mats"] and MAT_WALL not in md["mats"]
    assert md["mats"].count(MAT_TILE) == 2
    assert md["attrs"]["tint"][0] == 0.63
    md = build_building({"ring": rect, "height": 8.0, "roof_shape": "gabled", "id": 21,
                         "look": {"facade": "panel", "roof": "metal", "tint": 0.2}}, 0.0)
    assert "building_panel" in md["mats"]
    assert md["mats"].count(MAT_METAL) == 2 and MAT_TILE not in md["mats"]

    # ---- 13. curtain wall towers stay flat masses ----------------------------
    md = build_building({"ring": rect, "height": 48.0, "roof_shape": "gabled",
                         "id": 22, "look": {"facade": "glass", "roof": "flat",
                                            "tint": 0.5}}, 0.0)
    check(md, "curtain wall")
    assert "curtain_wall" in md["mats"] and MAT_TILE not in md["mats"]
    assert abs(maxz(md) - (48.0 + PARAPET_H)) < EPS  # parapet, no pitched roof

    # ---- 14. storefront band --------------------------------------------------
    md_sf = build_building({"ring": rect, "height": 12.0, "roof_shape": "flat",
                            "id": 23, "look": {"facade": "plaster", "roof": "flat",
                                               "tint": 0.4, "storefront": True}}, base)
    check(md_sf, "storefront")
    assert MAT_STOREFRONT in md_sf["mats"] and MAT_WALL in md_sf["mats"]
    sf_top = max(v[2] for f, m in zip(md_sf["faces"], md_sf["mats"])
                 if m == MAT_STOREFRONT for v in (md_sf["verts"][i] for i in f))
    assert abs(sf_top - (base + STOREFRONT_H)) < EPS, "band ends at base+4.2"
    # upper walls restart their v at the band top (window rows re-anchored)
    up_v = [vv for f, uv, m in zip(md_sf["faces"], md_sf["uvs"], md_sf["mats"])
            if m == MAT_WALL and uv for _, vv in uv]
    assert abs(min(up_v)) < EPS
    # min_height parts and too-low buildings never get the band
    md = build_building({"ring": rect, "height": 12.0, "min_height": 3.0,
                         "roof_shape": "flat", "id": 23,
                         "look": {"facade": "plaster", "roof": "flat",
                                  "tint": 0.4, "storefront": True}}, base)
    assert MAT_STOREFRONT not in md["mats"]

    # ---- 15. balconies ---------------------------------------------------------
    md_b = build_building({"ring": rect, "height": 19.2, "roof_shape": "flat",
                           "id": 24, "look": {"facade": "plaster", "roof": "flat",
                                              "tint": 0.4, "balconies": True}}, 0.0)
    check(md_b, "balconies")
    assert MAT_BALCONY in md_b["mats"] and MAT_RAIL in md_b["mats"]
    md_nb = build_building({"ring": rect, "height": 19.2, "roof_shape": "flat",
                            "id": 24, "look": {"facade": "plaster", "roof": "flat",
                                               "tint": 0.4}}, 0.0)
    assert len(md_b["faces"]) > len(md_nb["faces"])
    assert MAT_RAIL not in md_nb["mats"]
    # balcony rails hang OUTSIDE the footprint (longest edge y=0, outward −y)
    rail_y = [v[1] for f, m in zip(md_b["faces"], md_b["mats"])
              if m == MAT_RAIL for v in (md_b["verts"][i] for i in f)]
    assert min(rail_y) < -0.5 and max(rail_y) < 0.01, (min(rail_y), max(rail_y))
    # no look → exact v0.5 output (regression fence)
    md_v05 = build_building({"ring": rect, "height": 8.0, "roof_shape": "gabled",
                             "id": 42}, base)
    assert md_v05["mats"].count(MAT_WALL) == 6 and md_v05["mats"].count(MAT_TILE) == 2

    # ---- 11. merge compatibility (uvs/attrs stay aligned) --------------------
    merged = geom.merge_meshdata(geom.new_meshdata(), md_g)
    merged = geom.merge_meshdata(merged, md_c)
    assert len(merged["faces"]) == len(md_g["faces"]) + len(md_c["faces"])
    assert len(merged["uvs"]) == len(merged["faces"])
    assert len(merged["attrs"]["tint"]) == len(merged["faces"])

    print(f"gabled rect: {len(md_g['verts'])} verts / {len(md_g['faces'])} faces; "
          f"hipped: {md_h['mats'].count(MAT_TILE)} tile faces; "
          f"courtyard: {len(md_c['faces'])} faces (> {len(md_n['faces'])} no-hole)")
    print("ALL ROOFS SELF-TESTS PASSED")
