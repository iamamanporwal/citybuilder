"""Junction meshes: asphalt pad, corner curb/footpath bands, crosswalks, stop lines.

Implements the SPEC.md `junctions.py` contract using the "Lego rule" / kit
corner-arc method from specs/framed-roads.md §5. Pure module — no bpy; consumes
a roadnet JunctionDesc and returns MeshData. Coordinates: metres, X=east,
Y=north, Z=up (app spec is Y-up; already translated here).
"""
import math

try:
    from . import geom
except ImportError:  # direct `python3 junctions.py` run
    import geom

# ---- vertical stack (specs/framed-roads.md §1) ----------------------------
PAD_LIFT = 0.015        # pad sits above trimmed road ends → no z-fight
MARK_LIFT = 0.07        # Y_CROSSWALK: crosswalks AND stop lines paint height
CURB_H = 0.16           # FRAME_CURB_H — curb top and footpath top are flush
FOUNDATION = 0.35       # outer skirt runs down to z − 0.35 (never floats)

# ---- corner band (kit arc method, §5) --------------------------------------
BAND_CURB_W = 0.4       # junction bands use fixed curbW=0.4 / footW=2.4
BAND_FOOT_W = 2.4
BAND_GAP_MAX = 2.7      # arms further apart than this (rad) get no band
ARC_SEGS = 6            # kit arcs are swept with 6 segments
CORNER_CLEAR = 0.05     # mouth-corner lateral clearance; also arc radius bump
MOUTH_DEPTH = 4.0       # arm mouth rectangle depth used for band rejection
HULL_INSET = 0.25       # pad hull deflation for the "band on asphalt" test
FILLET_SEGS = 4         # round_polygon bezier subdivisions per corner

# ---- markings (specs/framed-roads.md §4) -----------------------------------
CROSSWALK_IN = 1.6      # zebra band centre, metres into the arm from the mouth
CROSSWALK_SPACING = 1.6  # lateral stripe pitch (0.8 stripe + 0.8 gap)
STRIPE_ALONG = 2.2      # stripe length along travel
STRIPE_WIDE = 0.8       # stripe width across travel
STOP_IN = 3.15          # stop-line centre, metres into the arm
STOP_THICK = 0.6
STOP_CLASSES = ("trunk", "primary", "secondary", "tertiary")


def _perp(d):
    """Right-hand side of travel for a unit dir (dir points AWAY from junction)."""
    return (d[1], -d[0])


def convex_hull(pts):
    """Andrew's monotone chain → CCW hull, collinear points dropped.

    Returns fewer than 3 points when the input is degenerate (caller falls
    back to an octagon pad in that case).
    """
    pts = sorted(set((float(x), float(y)) for x, y in pts))
    if len(pts) <= 2:
        return list(pts)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 1e-12:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 1e-12:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def round_polygon(ring, r, segs=FILLET_SEGS):
    """Fillet every vertex: pull back r along both edges, quadratic bezier arc.

    Pull-back is clamped to just under half of each adjacent edge so
    neighbouring fillets never overlap; degenerate corners pass through.
    """
    n = len(ring)
    if n < 3 or r <= 1e-9:
        return list(ring)
    out = []
    for i in range(n):
        p_prev, v, p_next = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
        e0 = (p_prev[0] - v[0], p_prev[1] - v[1])
        e1 = (p_next[0] - v[0], p_next[1] - v[1])
        l0 = math.hypot(e0[0], e0[1])
        l1 = math.hypot(e1[0], e1[1])
        if l0 < 1e-9 or l1 < 1e-9:
            out.append(v)
            continue
        d = min(r, 0.5 * l0 - 1e-6, 0.5 * l1 - 1e-6)
        if d <= 1e-6:
            out.append(v)
            continue
        a = (v[0] + e0[0] / l0 * d, v[1] + e0[1] / l0 * d)
        b = (v[0] + e1[0] / l1 * d, v[1] + e1[1] / l1 * d)
        for k in range(segs + 1):
            t = k / segs
            omt = 1.0 - t
            # quadratic bezier A→V→B (V is the control point)
            out.append((omt * omt * a[0] + 2 * omt * t * v[0] + t * t * b[0],
                        omt * omt * a[1] + 2 * omt * t * v[1] + t * t * b[1]))
    return geom.dedupe_ring(out)


def point_in_polygon(p, ring):
    """Even-odd ray cast; boundary points are not guaranteed either way."""
    x, y = p
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < xin:
                inside = not inside
    return inside


def _inset_convex(ring_ccw, d):
    """Deflate a convex CCW ring by d (inward edge offset + line intersection).

    Returns None when the ring collapses — callers then treat the deflated
    hull as empty (nothing can be inside it).
    """
    n = len(ring_ccw)
    if n < 3:
        return None
    lines = []  # (point on offset line, unit edge direction)
    for i in range(n):
        ax, ay = ring_ccw[i]
        bx, by = ring_ccw[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        ln = math.hypot(ex, ey)
        if ln < 1e-9:
            continue
        ex, ey = ex / ln, ey / ln
        # left of a CCW edge is the interior → inward normal
        nx, ny = -ey, ex
        lines.append(((ax + nx * d, ay + ny * d), (ex, ey)))
    m = len(lines)
    if m < 3:
        return None
    out = []
    for i in range(m):
        p1, (e1x, e1y) = lines[i - 1]
        p2, (e2x, e2y) = lines[i]
        den = e1x * e2y - e1y * e2x
        if abs(den) < 1e-12:
            return None  # near-parallel consecutive edges — give up safely
        t = ((p2[0] - p1[0]) * e2y - (p2[1] - p1[1]) * e2x) / den
        out.append((p1[0] + e1x * t, p1[1] + e1y * t))
    if geom.ring_area_signed(out) <= 0:
        return None
    return out


def _in_mouth_rect(q, arm):
    """Is q inside this arm's mouth rectangle (p ± perp·width/2, depth 4 m)?

    Lateral test is strict so mouth corners (at width/2 + 0.05) stay outside.
    """
    px, py = arm["p"]
    dx, dy = arm["dir"]
    rx, ry = _perp(arm["dir"])
    s = (q[0] - px) * dx + (q[1] - py) * dy
    t = (q[0] - px) * rx + (q[1] - py) * ry
    return 0.0 <= s <= MOUTH_DEPTH and abs(t) < arm["width"] / 2.0


# ---- MeshData emit helpers (one face = its own verts; Blender merges later) --

def _add_face(md, pts3, mat, uv):
    base = len(md["verts"])
    md["verts"].extend(pts3)
    md["faces"].append(list(range(base, base + len(pts3))))
    md["mats"].append(mat)
    md["uvs"].append(uv)


def _add_top_quad(md, quad, z, mat):
    """Horizontal quad with planar world UVs (u,v = x,y metres), +Z winding."""
    if geom.ring_area_signed(quad) < 0:
        quad = quad[::-1]
    _add_face(md, [(x, y, z) for x, y in quad],
              mat, [(x, y) for x, y in quad])


def _wall(md, pts, z0, z1, mat, inward):
    """Vertical wall along a polyline. UV: u = metres along, v = z metres.

    inward=True flips winding so the normal faces the junction centre
    (polylines here are CCW arcs around the centre).
    """
    cum = geom.arc_lengths(pts)
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        u0, u1 = cum[i], cum[i + 1]
        if inward:
            face = [(bx, by, z0), (ax, ay, z0), (ax, ay, z1), (bx, by, z1)]
            uv = [(u1, z0), (u0, z0), (u0, z1), (u1, z1)]
        else:
            face = [(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)]
            uv = [(u0, z0), (u1, z0), (u1, z1), (u0, z1)]
        _add_face(md, face, mat, uv)


def _annulus(md, inner, outer, z, mat):
    """Flat band between two parallel CCW arcs, planar UVs, normals +Z."""
    for i in range(len(inner) - 1):
        quad = [inner[i], outer[i], outer[i + 1], inner[i + 1]]
        _add_top_quad(md, quad, z, mat)


# ---- pad --------------------------------------------------------------------

def _mouth_corners(arm):
    """Left/right carriageway mouth corners: p ± perp·(width/2 + 0.05)."""
    px, py = arm["p"]
    rx, ry = _perp(arm["dir"])
    h = arm["width"] / 2.0 + CORNER_CLEAR
    return ((px - rx * h, py - ry * h),   # left  (= −perp side)
            (px + rx * h, py + ry * h))   # right (= +perp side)


def _wedge_corner(a, b, center, max_reach):
    """osm2streets wedge corner between CCW-adjacent arms a → b: intersect a's
    LEFT edge line with b's RIGHT edge line (edges run along each arm's dir).
    None when the arms are near-parallel (through pair) or the intersection
    shoots past max_reach (shallow angles) — callers fall back to a straight
    edge / midpoint."""
    la = _mouth_corners(a)[0]
    rb = _mouth_corners(b)[1]
    da, db = a["dir"], b["dir"]
    cross = da[0] * db[1] - da[1] * db[0]
    if abs(cross) < 0.09:  # < ~5°: collinear through-pair → straight edge
        return None
    # solve la + t·da = rb + u·db
    ex, ey = rb[0] - la[0], rb[1] - la[1]
    t = (ex * db[1] - ey * db[0]) / cross
    wx, wy = la[0] + da[0] * t, la[1] + da[1] * t
    if math.hypot(wx - center[0], wy - center[1]) > max_reach:
        return ((la[0] + rb[0]) / 2.0, (la[1] + rb[1]) / 2.0)  # shallow wedge
    return (wx, wy)


def _pad_rings(j):
    """(rounded pad ring, raw ring) — osm2streets-style walk (PLAN §3.2):
    arms CCW by angle; per arm append [right corner, left corner], then the
    wedge corner toward the next arm. Non-convex T/Y pads come out correctly
    (the old convex hull ballooned them). Octagon fallback when < 2 arms."""
    arms = sorted(j["arms"],
                  key=lambda a: math.atan2(a["dir"][1], a["dir"][0]))
    if len(arms) < 2:
        cx, cy = j["center"]
        rad = max(j["radius"], 2.0)
        ring = [(cx + rad * math.cos(k * math.pi / 4.0),
                 cy + rad * math.sin(k * math.pi / 4.0)) for k in range(8)]
        return round_polygon(ring, 1.5, FILLET_SEGS), ring

    mouth_reach = max(math.hypot(a["p"][0] - j["center"][0],
                                 a["p"][1] - j["center"][1]) + a["width"]
                      for a in arms)
    ring = []
    n = len(arms)
    for k in range(n):
        a, b = arms[k], arms[(k + 1) % n]
        la, ra = _mouth_corners(a)
        ring.append(ra)
        ring.append(la)
        w = _wedge_corner(a, b, j["center"], mouth_reach * 2.2)
        if w is not None:
            ring.append(w)
    # dedupe near-coincident walk points (< 0.1 m)
    ring = [p for i, p in enumerate(ring)
            if math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 0.1]
    if len(ring) < 3:
        return _pad_rings({**j, "arms": []})
    if geom.ring_area_signed(ring) < 0:
        ring.reverse()
    # small curb-radius fillet on the wedge corners (the ring IS the shape now,
    # unlike the hull era where the fillet had to fake the corners)
    minw = min((a["width"] for a in j["arms"]), default=5.0)
    fillet = max(1.0, min(3.5, minw * 0.25))
    return round_polygon(ring, fillet, FILLET_SEGS), ring


# ---- corner curb + footpath bands (kit arc method) ---------------------------

def _corner_bands(md, j, hull):
    arms = sorted(j["arms"], key=lambda a: math.atan2(a["dir"][1], a["dir"][0]))
    n = len(arms)
    if n < 2:
        return
    cx, cy = j["center"]
    z = j["z"]
    # one kit radius per junction: just past the farthest mouth corner
    rmax = 0.0
    for a in j["arms"]:
        for q in _mouth_corners(a):
            rmax = max(rmax, math.hypot(q[0] - cx, q[1] - cy))
    r_in = rmax + CORNER_CLEAR
    inset_hull = _inset_convex(hull, HULL_INSET)
    two_pi = 2.0 * math.pi

    for i in range(n):
        a, b = arms[i], arms[(i + 1) % n]
        ang_a = math.atan2(a["dir"][1], a["dir"][0])
        ang_b = math.atan2(b["dir"][1], b["dir"][0])
        gap = (ang_b - ang_a) % two_pi
        if gap <= 1e-6 or gap > BAND_GAP_MAX:
            continue  # 180°-ish through pair (or duplicate dir): no corner
        # arc spans the wedge from a's LEFT mouth corner to b's RIGHT corner
        ca = _mouth_corners(a)[0]
        cb = _mouth_corners(b)[1]
        th0 = math.atan2(ca[1] - cy, ca[0] - cx)
        sweep = (math.atan2(cb[1] - cy, cb[0] - cx) - th0) % two_pi
        # corner sweep is always < arm gap (≤ 2.7 < π); ≥ π means the mouths
        # overlap and the corner has inverted — drop it
        if sweep <= 1e-6 or sweep >= math.pi:
            continue

        def arc(rad):
            return [(cx + rad * math.cos(th0 + sweep * k / ARC_SEGS),
                     cy + rad * math.sin(th0 + sweep * k / ARC_SEGS))
                    for k in range(ARC_SEGS + 1)]

        ring0 = arc(r_in)                              # curb inner edge
        ring1 = arc(r_in + BAND_CURB_W)                # curb / footpath seam
        ring2 = arc(r_in + BAND_CURB_W + BAND_FOOT_W)  # footpath outer edge

        # rejection 1: inner points must stay OUTSIDE the deflated pad hull
        if inset_hull is not None and \
                any(point_in_polygon(q, inset_hull) for q in ring0):
            continue
        # rejection 2: no band point may sit in any arm's mouth rectangle
        if any(_in_mouth_rect(q, arm)
               for q in ring0 + ring1 + ring2 for arm in j["arms"]):
            continue

        _wall(md, ring0, z + PAD_LIFT, z + CURB_H, "curb", inward=True)
        _annulus(md, ring0, ring1, z + CURB_H, "curb")          # curb top
        _annulus(md, ring1, ring2, z + CURB_H, "sidewalk")      # footpath top
        _wall(md, ring2, z - FOUNDATION, z + CURB_H, "concrete", inward=False)


# ---- crosswalks + stop lines --------------------------------------------------

def _quad_local(p, d, s0, s1, t0, t1):
    """Rectangle in arm-local coords (s along dir, t along perp) → world XY."""
    r = _perp(d)

    def w(s, t):
        return (p[0] + d[0] * s + r[0] * t, p[1] + d[1] * s + r[1] * t)

    return [w(s0, t0), w(s1, t0), w(s1, t1), w(s0, t1)]


def _markings(md, j):
    zm = j["z"] + MARK_LIFT
    for a in j["arms"]:
        p, d, w = a["p"], a["dir"], a["width"]
        if a.get("crosswalk"):
            # zebra: stripe count max(3, floor((w−2)/1.6)), centred laterally,
            # band centre 1.6 m into the arm (clears the 3.15 m stop line)
            n = max(3, int(math.floor((w - 2.0) / CROSSWALK_SPACING)))
            for k in range(n):
                t = (k - (n - 1) / 2.0) * CROSSWALK_SPACING
                quad = _quad_local(p, d,
                                   CROSSWALK_IN - STRIPE_ALONG / 2.0,
                                   CROSSWALK_IN + STRIPE_ALONG / 2.0,
                                   t - STRIPE_WIDE / 2.0, t + STRIPE_WIDE / 2.0)
                _add_top_quad(md, quad, zm, "marking_white")
        if a.get("cls") in STOP_CLASSES:
            # driving-side half bar (right-hand traffic): approaching cars are
            # on the −perp(dir) half because dir points AWAY from the junction
            halfw = w / 4.0 - 0.1
            if halfw > 0.02:
                quad = _quad_local(p, d,
                                   STOP_IN - STOP_THICK / 2.0,
                                   STOP_IN + STOP_THICK / 2.0,
                                   -w / 4.0 - halfw, -w / 4.0 + halfw)
                _add_top_quad(md, quad, zm, "marking_white")


# ---- public entry -------------------------------------------------------------

def build_junction(j):
    """JunctionDesc → MeshData (pad, corner bands, crosswalks, stop lines)."""
    md = geom.new_meshdata()
    md["uvs"] = []

    pad, hull = _pad_rings(j)
    zp = j["z"] + PAD_LIFT
    verts2d, tris = geom.tessellate(pad)
    base = len(md["verts"])
    md["verts"].extend((x, y, zp) for x, y in verts2d)
    for t in tris:
        md["faces"].append([base + t[0], base + t[1], base + t[2]])
        md["mats"].append("asphalt_old")
        # planar world UVs: u,v = x,y metres
        md["uvs"].append([(verts2d[i][0], verts2d[i][1]) for i in t])

    _corner_bands(md, j, hull)
    _markings(md, j)
    return md


# ==============================================================================
if __name__ == "__main__":
    EPS = 1e-6

    def mk(dirs, widths, cls="secondary", z=3.0):
        """Build a JunctionDesc the way roadnet.py does (trim/radius rules)."""
        maxw = max(widths)
        radius = 0.58 * maxw
        arms = []
        for k, (d, w) in enumerate(zip(dirs, widths)):
            trim = max(radius * 0.72, 0.55 * w)
            arms.append({"p": (d[0] * trim, d[1] * trim), "dir": d,
                         "width": float(w), "cls": cls, "seg_idx": k, "end": 0,
                         "crosswalk": cls != "motorway" and w >= 5.0})
        return {"center": (0.0, 0.0), "z": z, "radius": radius,
                "arms": arms, "degree": len(arms)}

    def check_basic(md):
        assert len(md["verts"]) > 0 and len(md["faces"]) > 0
        assert len(md["mats"]) == len(md["faces"])
        assert md["uvs"] is not None and len(md["uvs"]) == len(md["faces"])
        for f, uv in zip(md["faces"], md["uvs"]):
            assert uv is not None and len(uv) == len(f)
        for v in md["verts"]:
            assert all(math.isfinite(c) for c in v), v

    def face_pts(md, fi):
        return [md["verts"][vi] for vi in md["faces"][fi]]

    def face_area(md, fi):
        return geom.ring_area_m2([(p[0], p[1]) for p in face_pts(md, fi)])

    def centroid(md, fi):
        pts = face_pts(md, fi)
        return (sum(p[0] for p in pts) / len(pts),
                sum(p[1] for p in pts) / len(pts))

    # ---- helper unit tests ---------------------------------------------------
    h = convex_hull([(0, 0), (4, 0), (4, 4), (0, 4), (2, 2), (1, 3)])
    assert len(h) == 4 and geom.ring_area_signed(h) > 0, h
    assert point_in_polygon((2, 2), h) and not point_in_polygon((5, 2), h)
    ih = _inset_convex(h, 0.25)
    assert ih is not None and abs(geom.ring_area_m2(ih) - 3.5 * 3.5) < 1e-6
    rp = round_polygon([(0, 0), (10, 0), (10, 10), (0, 10)], 2.0, 4)
    assert len(rp) == 4 * (FILLET_SEGS + 1)
    a_sq = geom.ring_area_m2(rp)
    assert 100 - 4 * 2.0 < a_sq < 100, a_sq  # bezier trims < d²/2 per corner

    # ---- 4-arm 90° junction, widths 7 ---------------------------------------
    j4 = mk([(1, 0), (0, 1), (-1, 0), (0, -1)], [7, 7, 7, 7])
    md = build_junction(j4)
    check_basic(md)
    assert md == build_junction(j4), "determinism"
    z = j4["z"]

    pad_faces = [i for i, m in enumerate(md["mats"]) if m == "asphalt_old"]
    pad_area = sum(face_area(md, i) for i in pad_faces)
    assert 40.0 <= pad_area <= 400.0, pad_area
    for i in pad_faces:  # pad flat at z + 0.015
        assert all(abs(p[2] - (z + PAD_LIFT)) < EPS for p in face_pts(md, i))

    band = [i for i, m in enumerate(md["mats"])
            if m in ("curb", "sidewalk", "concrete")]
    assert len(band) == 4 * 4 * ARC_SEGS, len(band)  # 4 corners × 4 strips × 6
    curb_lo = math.inf
    for i in band:
        zs = [p[2] for p in face_pts(md, i)]
        assert min(zs) >= z - FOUNDATION - EPS and max(zs) <= z + CURB_H + EPS
        if max(zs) - min(zs) < EPS:  # flat band tops sit in [pad z, curb top]
            assert z + PAD_LIFT - EPS <= zs[0] <= z + CURB_H + EPS
            assert abs(zs[0] - (z + CURB_H)) < EPS  # both tops flush at +0.16
        if md["mats"][i] == "curb":
            curb_lo = min(curb_lo, min(zs))
    assert abs(curb_lo - (z + PAD_LIFT)) < EPS  # curb inner wall starts at pad z

    marks = [i for i, m in enumerate(md["mats"]) if m == "marking_white"]
    n_stripes = max(3, int(math.floor((7 - 2) / 1.6)))  # = 3
    assert len(marks) == 4 * n_stripes + 4, len(marks)  # + 4 stop lines
    for a in j4["arms"]:
        r = _perp(a["dir"])
        stripes, stops = 0, 0
        for i in marks:
            cx_, cy_ = centroid(md, i)
            s = (cx_ - a["p"][0]) * a["dir"][0] + (cy_ - a["p"][1]) * a["dir"][1]
            t = (cx_ - a["p"][0]) * r[0] + (cy_ - a["p"][1]) * r[1]
            if abs(t) > a["width"] / 2.0:
                continue
            if 0.3 <= s <= 2.9:
                stripes += 1
                assert all(abs(p[2] - (z + MARK_LIFT)) < EPS
                           for p in face_pts(md, i))
            elif 2.9 < s <= 3.5:
                stops += 1
                assert t < 0.0, "stop line on driving side (−perp)"
        assert stripes >= 3, stripes
        assert stops == 1, stops

    # ---- 3-arm T junction: the 180° through pair gets no corner band --------
    jt = mk([(1, 0), (0, 1), (-1, 0)], [7, 7, 7])
    mdt = build_junction(jt)
    check_basic(mdt)
    bandt = [m for m in mdt["mats"] if m in ("curb", "sidewalk", "concrete")]
    assert len(bandt) == 2 * 4 * ARC_SEGS, len(bandt)
    assert mdt["mats"].count("marking_white") == 3 * n_stripes + 3

    # ---- motorway arms: no crosswalks, no stop lines -------------------------
    jm = mk([(1, 0), (0, 1), (-1, 0), (0, -1)], [9, 9, 9, 9], cls="motorway")
    mdm = build_junction(jm)
    check_basic(mdm)
    assert mdm["mats"].count("marking_white") == 0

    # ---- armless junction → octagon pad fallback -----------------------------
    j0 = {"center": (5.0, -3.0), "z": 1.0, "radius": 4.0, "arms": [],
          "degree": 0}
    md0 = build_junction(j0)
    check_basic(md0)
    assert all(m == "asphalt_old" for m in md0["mats"])
    area0 = sum(face_area(md0, i) for i in range(len(md0["faces"])))
    # regular octagon R=4 has area 2·√2·R² ≈ 45.25; fillets shave a little
    assert 30.0 <= area0 <= 2.0 * math.sqrt(2.0) * 16.0 + EPS, area0

    print("junctions.py self-tests OK")
    print("  4-arm: pad area %.1f m², %d band faces, %d marking faces"
          % (pad_area, len(band), len(marks)))
    print("  T-junction: %d band faces (2 corners), octagon pad %.1f m²"
          % (len(bandt), area0))

    # 6. wedge corners (osm2streets walk): 4-arm 90° w=7 → raw ring has the
    # four inner wedge points at (±3.55, ±3.55) and mouths beyond them
    j = mk([(1, 0), (0, 1), (-1, 0), (0, -1)], [7, 7, 7, 7])
    _pad, raw = _pad_rings(j)
    h = 7 / 2.0 + CORNER_CLEAR
    wedges = [p for p in raw
              if abs(abs(p[0]) - h) < 0.01 and abs(abs(p[1]) - h) < 0.01]
    assert len(wedges) == 4, (len(wedges), raw)
    assert len(raw) == 12, len(raw)  # 2 mouth corners + 1 wedge per arm
    # T-junction: through pair contributes a straight edge (no wedge point)
    jt = mk([(1, 0), (-1, 0), (0, 1)], [7, 7, 7])
    _padt, rawt = _pad_rings(jt)
    assert len(rawt) == 8, (len(rawt), rawt)  # 6 mouths + 2 wedges only
    print("test 6 OK (wedge corners exact on 4-arm; T through-pair straight)")
