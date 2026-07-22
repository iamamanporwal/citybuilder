"""Parametric prop templates + deterministic prop placement.

Pure module (no bpy). TEMPLATES maps a name to a zero-arg builder returning a
MeshData at the origin: z = 0 is ground level and the prop faces +Y — the
placement's rot_z spins it into the world later. place_props() consumes the
parsed Graph v2 + roadnet Network and emits Placement dicts per SPEC.md
"props_gen.py" and specs/export-landmarks-props.md §C.

Coordinates: metres, X=east, Y=north, Z=up (the app spec is Y-up with (x,z)
ground; ported here as spec z → our y, spec y/elevation → our z).
Determinism: geom.hash01 only — no random, no time.
"""
import math

try:
    from . import geom
except ImportError:  # direct python3 execution for self-tests
    import geom

__all__ = ["TEMPLATES", "place_props"]

# ---------------------------------------------------------------------------
# Placement constants (specs/export-landmarks-props.md §C)
# ---------------------------------------------------------------------------
LAMP_CLASSES = frozenset((
    "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified", "living_street"))
# any class a car can occupy — used for the carriageway rejection grid and for
# snapping OSM device nodes to their street
DRIVABLE_CLASSES = LAMP_CLASSES | frozenset((
    "motorway", "service", "motorway_link", "trunk_link",
    "primary_link", "secondary_link", "tertiary_link"))

LAMP_SPACING = 30.0        # m between generated lamps (module contract)
LAMP_LATERAL = 1.1         # m beyond half-width — lamp stands on the verge
LAMP_BRIDGE_INSET = 0.55   # bridge decks: hug the parapet at half − 0.55
BRIDGE_LAMP_MIN_W = 8.0    # narrower decks have no room for lamps
LAMP_JITTER = 3.0          # ± along-station jitter (0 on bridges)
LAMP_MIN_GAP = 8.0         # min 2D distance between any two lamps
LAMP_MIN_SEG = 20.0        # skip stubs shorter than this
LAMP_MARGIN = 0.35         # carriageway rejection margin (edge + 0.35)
LAMP_STATION_PAD = 2.0     # station clamped to [2, L−2]
CURB_PUSH = 0.7            # OSM device push-out: half + 0.7 (driving side)
KEEP_RAW_PAD = 0.2         # farther than half + 0.2 from a road → keep raw pos
ROAD_ELEV_REACH = 8.0      # within half + 8 → seat on road elevation, else terrain
CURB_LIFT = 0.22           # framed kerb top sits +0.22 above the lane surface

# Category caps (lamps 3000, signals+signs 1000 combined, trees 4000,
# other furniture 1000 each).
_CAPS = {"lamp": 3000, "sign": 1000, "tree": 4000, "bus_stop": 1000, "bench": 1000}
_SIGN_TEMPLATES = frozenset(("signal", "stop_sign", "give_way", "speed_sign"))

# OSM prop kind → template ("crossing" is semantics-only: no 3D prop)
KIND_TO_TEMPLATE = {
    "lamp": "lamp", "street_lamp": "lamp",
    "signal": "signal", "traffic_signal": "signal", "traffic_signals": "signal",
    "stop": "stop_sign", "stop_sign": "stop_sign",
    "give_way": "give_way",
    "speed_sign": "speed_sign", "speed_limit": "speed_sign",
    "bus_stop": "bus_stop",
    "bench": "bench",
}


# ---------------------------------------------------------------------------
# Small mesh builders
# ---------------------------------------------------------------------------
def _add_face(md, idxs, mat):
    md["faces"].append(list(idxs))
    md["mats"].append(mat)
    if md["uvs"] is not None:
        md["uvs"].append(None)


def _ring_stack(md, rings, mat, segs=8, cap_top=True):
    """Loft circular rings [(z, r), ...] around the origin into an open
    cylinder (octagonal-ish at segs=8) plus optional flat top cap.
    Faces CCW seen from outside."""
    n = segs
    base = len(md["verts"])
    for z, r in rings:
        for k in range(n):
            a = (k / n) * math.tau
            md["verts"].append((r * math.cos(a), r * math.sin(a), z))
    for i in range(len(rings) - 1):
        lo = base + i * n
        hi = lo + n
        for k in range(n):
            k2 = (k + 1) % n
            _add_face(md, [lo + k, lo + k2, hi + k2, hi + k], mat)
    if cap_top:
        top = base + (len(rings) - 1) * n
        _add_face(md, [top + k for k in range(n)], mat)
    return md


def _beam(md, p0, p1, w, h, mat):
    """Oriented box between two 3D points: w = horizontal width, h = depth
    perpendicular to the axis (used for the tilted lamp arm)."""
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    ln = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    d = (dx / ln, dy / ln, dz / ln)
    sx, sy = d[1], -d[0]                       # side = d × Z (horizontal)
    sl = math.hypot(sx, sy) or 1.0
    s = (sx / sl, sy / sl, 0.0)
    u = (s[1] * d[2] - s[2] * d[1],            # up = s × d
         s[2] * d[0] - s[0] * d[2],
         s[0] * d[1] - s[1] * d[0])
    hw, hh = w / 2.0, h / 2.0
    base = len(md["verts"])
    for p in (p0, p1):
        for cs, cu in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            md["verts"].append((p[0] + s[0] * hw * cs + u[0] * hh * cu,
                                p[1] + s[1] * hw * cs + u[1] * hh * cu,
                                p[2] + s[2] * hw * cs + u[2] * hh * cu))
    # winding verified: outward normals for −u/+u/+s/−s/−d/+d
    for f in ((0, 4, 5, 1), (3, 2, 6, 7), (1, 5, 6, 2),
              (0, 3, 7, 4), (0, 1, 2, 3), (4, 7, 6, 5)):
        _add_face(md, [base + i for i in f], mat)
    return md


# octahedron (6 verts / 8 CCW-outward tris) — subdiv-1 gives the "icosphere-ish"
# 18-vert / 32-tri blob used for tree crowns and shrubs
_OCTA_V = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
_OCTA_F = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4),
           (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]


def _sphere(md, cx, cy, cz, rx, ry, rz, mat):
    """Octahedron subdivided once, projected to the unit sphere and scaled per
    axis (ellipsoid support lets the shrub sit exactly on the ground)."""
    verts = [tuple(v) for v in _OCTA_V]
    mids = {}
    faces = []

    def mid(i, j):
        key = (i, j) if i < j else (j, i)
        k = mids.get(key)
        if k is not None:
            return k
        ax, ay, az = verts[i]
        bx, by, bz = verts[j]
        mx, my, mz = (ax + bx) / 2.0, (ay + by) / 2.0, (az + bz) / 2.0
        ln = math.sqrt(mx * mx + my * my + mz * mz) or 1.0
        verts.append((mx / ln, my / ln, mz / ln))
        mids[key] = len(verts) - 1
        return mids[key]

    for a, b, c in _OCTA_F:
        ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
        faces += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
    base = len(md["verts"])
    for x, y, z in verts:
        md["verts"].append((cx + x * rx, cy + y * ry, cz + z * rz))
    for f in faces:
        _add_face(md, [base + i for i in f], mat)
    return md


def _plate(md, angles, radius, zc, y, mat):
    """Flat sign plate in the XZ plane at depth y, normal −Y (confronts the
    driver once placement rotates stop/give-way by dir+π). Increasing angles
    yield the −Y-facing winding."""
    base = len(md["verts"])
    for a in angles:
        md["verts"].append((radius * math.cos(a), y, zc + radius * math.sin(a)))
    _add_face(md, list(range(base, base + len(angles))), mat)
    return md


def _sign_pole(md):
    """2.6 m sign pole, mat metal."""
    return _ring_stack(md, [(0.0, 0.05), (2.6, 0.05)], "metal", segs=6)


def _rect(cx0, cy0, cx1, cy1):
    """CCW rectangle ring for add_prism."""
    return [(cx0, cy0), (cx1, cy0), (cx1, cy1), (cx0, cy1)]


# ---------------------------------------------------------------------------
# Templates — z=0 ground, +Y forward (rot_z applied by the placement)
# ---------------------------------------------------------------------------
def _tpl_lamp():
    md = geom.new_meshdata()
    # 8-seg tapered pole r0.14 → r0.09 over 7.4 m via ring stack (mid ring keeps
    # the taper "octagonal-ish" rather than a plain cone)
    _ring_stack(md, [(0.0, 0.14), (3.7, 0.115), (7.4, 0.09)], "metal_dark")
    # 2.2 m arm at 7.3, tilted up 0.25 toward the tip, reaching over the road (+Y)
    _beam(md, (0.0, 0.0, 7.3), (0.0, 2.2, 7.55), 0.09, 0.09, "metal_dark")
    # luminaire head under the arm tip: 0.5 long × 0.25 wide × 0.18 tall, emissive
    geom.add_prism(md, _rect(-0.125, 1.95, 0.125, 2.45), 7.33, 7.51, "lamp_head",
                   mat_top="lamp_head", mat_bottom="lamp_head", uv_walls=False)
    return md


def _tpl_signal():
    md = geom.new_meshdata()
    # 4.6 m pole; spec "r0.09→0.11" read as (radiusTop, radiusBottom) → taper up
    _ring_stack(md, [(0.0, 0.11), (4.6, 0.09)], "metal_dark")
    # head box 0.34 wide × 0.26 deep × 1.0 tall centred at 4.4
    geom.add_prism(md, _rect(-0.17, -0.13, 0.17, 0.13), 3.9, 4.9, "metal_dark",
                   mat_top="metal_dark", mat_bottom="metal_dark", uv_walls=False)
    # 3 lens quads (r0.09 → 0.18 squares) at 4.4 ± 0.3 on the −Y face; drivers
    # approach travelling +Y and see the lit face
    for zc in (4.1, 4.4, 4.7):
        base = len(md["verts"])
        for x, z in ((-0.09, zc - 0.09), (0.09, zc - 0.09),
                     (0.09, zc + 0.09), (-0.09, zc + 0.09)):
            md["verts"].append((x, -0.135, z))
        _add_face(md, [base, base + 1, base + 2, base + 3], "lamp_head")
    return md


def _tpl_stop_sign():
    md = geom.new_meshdata()
    _sign_pole(md)
    # octagon plate r0.38 at 2.6, flat top/bottom (π/8 offset), red material
    _plate(md, [math.pi / 8 + k * math.pi / 4 for k in range(8)],
           0.38, 2.6, -0.06, "sign_red")
    return md


def _tpl_give_way():
    md = geom.new_meshdata()
    _sign_pole(md)
    # point-down triangle plate (vertex at −π/2), white with red border in matlib
    _plate(md, [-math.pi / 2, math.pi / 6, 5 * math.pi / 6],
           0.38, 2.6, -0.06, "sign_white")
    return md


def _tpl_speed_sign():
    md = geom.new_meshdata()
    _sign_pole(md)
    # circular plate approximated by a 16-gon, r0.38
    _plate(md, [k * math.tau / 16 for k in range(16)], 0.38, 2.6, -0.06, "sign_white")
    return md


def _tpl_bus_stop():
    md = geom.new_meshdata()
    # shelter 3 × 1.4 × 2.5: two front posts + roof slab + glass back wall;
    # opening faces +Y (the road, after rot_z)
    for sx in (-1.35, 1.35):
        geom.add_prism(md, _rect(sx - 0.04, 0.51, sx + 0.04, 0.59), 0.0, 2.42,
                       "metal_dark", mat_top="metal_dark", uv_walls=False)
    geom.add_prism(md, _rect(-1.5, -0.7, 1.5, 0.7), 2.42, 2.5, "metal_dark",
                   mat_top="metal_dark", mat_bottom="metal_dark", uv_walls=False)
    geom.add_prism(md, _rect(-1.5, -0.68, 1.5, -0.62), 0.05, 2.42,
                   "building_glass", mat_top="building_glass", uv_walls=False)
    return md


def _tpl_bench():
    md = geom.new_meshdata()
    for sx in (-0.71, 0.71):  # two leg boxes
        geom.add_prism(md, _rect(sx - 0.04, -0.21, sx + 0.04, 0.21), 0.0, 0.39,
                       "wood", uv_walls=False)
    # seat slab 1.7 × 0.5 with its top at 0.45
    geom.add_prism(md, _rect(-0.85, -0.25, 0.85, 0.25), 0.39, 0.45, "wood",
                   mat_top="wood", mat_bottom="wood", uv_walls=False)
    # backrest along the −Y edge (occupant faces the road at +Y)
    geom.add_prism(md, _rect(-0.85, -0.25, 0.85, -0.19), 0.45, 0.92, "wood",
                   mat_top="wood", uv_walls=False)
    return md


def _tpl_tree():
    md = geom.new_meshdata()
    # 8-seg tapered trunk h2.2 r0.18 (top pinched to 0.11)
    _ring_stack(md, [(0.0, 0.18), (2.2, 0.11)], "bark")
    # two stacked icosphere-ish crowns, main r1.6 centred at 3.2
    _sphere(md, 0.0, 0.0, 3.2, 1.6, 1.6, 1.6, "leaves")
    _sphere(md, 0.0, 0.0, 4.35, 1.15, 1.15, 1.05, "leaves")
    return md


def _tpl_shrub():
    md = geom.new_meshdata()
    # r0.8 blob centred at 0.56 — vertical radius squashed to 0.56 so the
    # bottom sits exactly at z=0 instead of dipping below ground
    _sphere(md, 0.0, 0.0, 0.56, 0.8, 0.8, 0.56, "leaves")
    return md


TEMPLATES = {
    "lamp": _tpl_lamp,
    "signal": _tpl_signal,
    "stop_sign": _tpl_stop_sign,
    "give_way": _tpl_give_way,
    "speed_sign": _tpl_speed_sign,
    "bus_stop": _tpl_bus_stop,
    "bench": _tpl_bench,
    "tree": _tpl_tree,
    "shrub": _tpl_shrub,
}


# ---------------------------------------------------------------------------
# Placement helpers
# ---------------------------------------------------------------------------
def _wrap(a):
    """Wrap an angle to [−π, π)."""
    return (a + math.pi) % math.tau - math.pi


def _rot_facing(fx, fy):
    """rot_z that turns the template's +Y forward onto the unit-ish (fx, fy)."""
    return _wrap(math.atan2(fy, fx) - math.pi / 2)


def _cum(cums, seg):
    """Cached arc lengths of a SegDesc's pts."""
    c = cums.get(id(seg))
    if c is None:
        c = geom.arc_lengths(seg["pts"])
        cums[id(seg)] = c
    return c


def _carriageway_grid(segments):
    """SpatialGrid over drivable carriageway pieces. One (seg, half) payload
    tuple per seg, inserted for every polyline piece, so query()'s id-dedupe
    collapses multi-piece hits to a single candidate."""
    grid = geom.SpatialGrid(cell=24.0)
    for seg in segments:
        if seg.get("cls") not in DRIVABLE_CLASSES:
            continue
        pts = seg.get("pts") or []
        if len(pts) < 2:
            continue
        half = float(seg.get("width") or 7.0) * 0.5
        payload = (seg, half)
        for i in range(len(pts) - 1):
            grid.insert_segment(pts[i], pts[i + 1], payload, pad=half + 2.0)
    return grid


def _closest_on_seg(seg, cums, p):
    """(dist, closest_pt, station, unit_dir) of p against a SegDesc polyline
    — the station_of helper."""
    pts = seg["pts"]
    cum = _cum(cums, seg)
    best_d = math.inf
    best = ((pts[0][0], pts[0][1]), 0.0, (0.0, 0.0))
    for i in range(len(pts) - 1):
        d, cp, t = geom.seg_point_dist(p, pts[i], pts[i + 1])
        if d < best_d:
            dx = pts[i + 1][0] - pts[i][0]
            dy = pts[i + 1][1] - pts[i][1]
            ln = math.hypot(dx, dy) or 1.0
            best_d = d
            best = (cp, cum[i] + t * (cum[i + 1] - cum[i]), (dx / ln, dy / ln))
    return (best_d,) + best


def _nearest_drivable(grid, cums, p):
    """Nearest drivable seg via expanding grid queries.
    Returns (dist, closest_pt, station, dir, seg, half) or None."""
    best = None
    for pad in (16.0, 48.0, 144.0):
        for seg, half in grid.query(p[0], p[1], pad):
            d, cp, station, dirv = _closest_on_seg(seg, cums, p)
            if best is None or d < best[0]:
                best = (d, cp, station, dirv, seg, half)
        if best is not None and best[0] <= pad:
            return best
    return best


def _inside_carriageway(grid, cums, p, margin, exclude_idx=None, layer=None):
    """True if p lies within (half + margin) of any drivable carriageway.
    The host seg is excluded (bridge lamps at half−0.55 must survive) and, when
    a layer is given, only same-layer segs reject (roads under a deck don't)."""
    for seg, half in grid.query(p[0], p[1], pad=2.0):
        if exclude_idx is not None and seg.get("road_idx") == exclude_idx:
            continue
        if layer is not None and int(seg.get("layer") or 0) != layer:
            continue
        lim = half + margin
        pts = seg["pts"]
        for i in range(len(pts) - 1):
            d, _, _ = geom.seg_point_dist(p, pts[i], pts[i + 1])
            if d < lim:
                return True
    return False


def _near_lamp(lamp_grid, x, y):
    for lx, ly in lamp_grid.query(x, y, pad=LAMP_MIN_GAP):
        if math.hypot(lx - x, ly - y) < LAMP_MIN_GAP:
            return True
    return False


def _point_at_station(pts, cum, s):
    """((x, y), unit_dir) at arc-length station s along a polyline."""
    s = max(0.0, min(cum[-1], s))
    for i in range(len(pts) - 1):
        if s <= cum[i + 1] or i == len(pts) - 2:
            span = cum[i + 1] - cum[i]
            t = 0.0 if span <= 0 else (s - cum[i]) / span
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            dx, dy = bx - ax, by - ay
            ln = math.hypot(dx, dy) or 1.0
            return (ax + dx * t, ay + dy * t), (dx / ln, dy / ln)
    return (pts[-1][0], pts[-1][1]), (0.0, 0.0)


def _cat(template):
    """Cap category for a template."""
    if template in _SIGN_TEMPLATES:
        return "sign"
    if template in ("tree", "shrub"):
        return "tree"
    return template  # lamp, bus_stop, bench


# ---------------------------------------------------------------------------
# place_props
# ---------------------------------------------------------------------------
def place_props(graph, network, road_z, ground_z, opts=None):
    """Graph + Network → [{"template", "pos": (x,y,z), "rot_z", "scale"}].

    road_z(seg, station) -> z on a SegDesc; ground_z(x, y) -> terrain z.
    opts (all default True): "props" gates OSM props + generated lamps (the
    build.py toggle); "osm_props"/"lamps" are finer sub-toggles; "trees" gates
    graph["trees"]; "lamp_spacing" overrides the 30 m default.
    """
    opts = opts or {}
    do_street = opts.get("props", True)
    do_osm = do_street and opts.get("osm_props", True)
    do_lamps = do_street and opts.get("lamps", True)
    do_trees = opts.get("trees", True)

    segments = (network or {}).get("segments") or []
    cums = {}
    grid = _carriageway_grid(segments)
    lamp_grid = geom.SpatialGrid(cell=16.0)
    counts = {}
    out = []

    def emit(template, pos, rot_z, scale=1.0):
        cat = _cat(template)
        if counts.get(cat, 0) >= _CAPS.get(cat, 1000):
            return False
        counts[cat] = counts.get(cat, 0) + 1
        out.append({"template": template,
                    "pos": (float(pos[0]), float(pos[1]), float(pos[2])),
                    "rot_z": _wrap(rot_z), "scale": float(scale)})
        return True

    # -- (1) OSM-tagged props: curb-push + orientation per §C ---------------
    if do_osm:
        for prop in graph.get("props") or []:
            template = KIND_TO_TEMPLATE.get(prop.get("kind"))
            if template is None:
                continue
            px, py = float(prop["pos"][0]), float(prop["pos"][1])
            pid = int(prop.get("id") or 0)
            hit = _nearest_drivable(grid, cums, (px, py))
            if hit is None:
                # nowhere near a road: keep the surveyed spot on the terrain
                pos = (px, py, ground_z(px, py))
                rot = geom.hash01(pid * 7 + 3) * math.tau
            else:
                dist, cp, station, dirv, seg, half = hit
                if dist > half + KEEP_RAW_PAD:
                    x, y = px, py  # position authoritative
                else:
                    # push onto the kerb, driving side (right of travel, s=−1)
                    x = cp[0] + dirv[1] * (half + CURB_PUSH)
                    y = cp[1] - dirv[0] * (half + CURB_PUSH)
                z = (road_z(seg, station) if dist <= half + ROAD_ELEV_REACH
                     else ground_z(x, y))
                if template == "signal":
                    fx, fy = dirv                      # aligns WITH travel
                elif template in ("stop_sign", "give_way", "speed_sign"):
                    fx, fy = -dirv[0], -dirv[1]        # confronts the driver
                else:
                    # lamps/shelters/benches face the road they serve
                    fx, fy = cp[0] - x, cp[1] - y
                    ln = math.hypot(fx, fy)
                    if ln < 1e-9:
                        fx, fy = -dirv[1], dirv[0]
                pos = (x, y, z)
                rot = _rot_facing(fx, fy)
            if emit(template, pos, rot) and template == "lamp":
                lamp_grid.insert(pos[0], pos[1], pos[0], pos[1],
                                 (pos[0], pos[1]))

    # -- (2) generated street lamps -----------------------------------------
    if do_lamps:
        spacing = float(opts.get("lamp_spacing", LAMP_SPACING))
        for seg in segments:
            if counts.get("lamp", 0) >= _CAPS["lamp"]:
                break
            cls = seg.get("cls")
            if cls not in LAMP_CLASSES or seg.get("internal") or seg.get("tunnel"):
                continue
            pts = seg.get("pts") or []
            if len(pts) < 2:
                continue
            cum = _cum(cums, seg)
            length = cum[-1]
            if length < LAMP_MIN_SEG:
                continue
            bridge = bool(seg.get("bridge"))
            width = float(seg.get("width") or 7.0)
            half = width * 0.5
            if bridge:
                if width < BRIDGE_LAMP_MIN_W:
                    continue
                lateral = half - LAMP_BRIDGE_INSET  # hug the parapet
            else:
                lateral = half + LAMP_LATERAL
            # framed drivable non-bridge kerb sits +0.22 above the lane surface
            lift = 0.0 if bridge else CURB_LIFT
            layer = int(seg.get("layer") or 0)
            ridx = int(seg.get("road_idx") or 0)
            for i in range(int(length // spacing)):
                station = (i + 0.5) * spacing
                if not bridge:  # deterministic ±3 m along-jitter
                    station += (geom.hash01(ridx * 8191 + i * 127 + 11) - 0.5) \
                        * 2.0 * LAMP_JITTER
                station = min(max(station, LAMP_STATION_PAD),
                              length - LAMP_STATION_PAD)
                (x0, y0), dirv = _point_at_station(pts, cum, station)
                side = 1.0 if i % 2 == 0 else -1.0    # alternate sides
                nx, ny = -dirv[1], dirv[0]            # left normal
                x = x0 + nx * side * lateral
                y = y0 + ny * side * lateral
                if _inside_carriageway(grid, cums, (x, y), LAMP_MARGIN,
                                       exclude_idx=seg.get("road_idx"),
                                       layer=layer):
                    continue
                if _near_lamp(lamp_grid, x, y):
                    continue
                z = road_z(seg, station) + lift
                rot = _rot_facing(-nx * side, -ny * side)  # arm over the road
                if not emit("lamp", (x, y, z), rot):
                    break
                lamp_grid.insert(x, y, x, y, (x, y))

    # -- (3) OSM trees on the terrain ----------------------------------------
    if do_trees:
        for t in graph.get("trees") or []:
            if counts.get("tree", 0) >= _CAPS["tree"]:
                break
            x, y = float(t["pos"][0]), float(t["pos"][1])
            tid = int(t.get("id") or 0)
            emit("tree", (x, y, ground_z(x, y)),
                 geom.hash01(tid * 3 + 1) * math.tau,
                 0.8 + geom.hash01(tid) * 0.5)

    return out


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # -- 1. every template is a valid MeshData ------------------------------
    def check_md(name, md):
        assert md["verts"] and md["faces"], name
        assert len(md["mats"]) == len(md["faces"]), name
        if md["uvs"] is not None:
            assert len(md["uvs"]) == len(md["faces"]), name
        nv = len(md["verts"])
        for v in md["verts"]:
            assert len(v) == 3 and all(math.isfinite(c) for c in v), name
        assert min(v[2] for v in md["verts"]) >= -0.01, \
            (name, min(v[2] for v in md["verts"]))
        for f in md["faces"]:
            assert len(f) >= 3 and all(0 <= i < nv for i in f), name

    for _name in sorted(TEMPLATES):
        _md = TEMPLATES[_name]()
        check_md(_name, _md)
        print(f"  template {_name:10s} verts={len(_md['verts']):3d} "
              f"faces={len(_md['faces']):3d}")

    _lamp = TEMPLATES["lamp"]()
    assert 7.3 < max(v[2] for v in _lamp["verts"]) < 7.8
    assert "lamp_head" in _lamp["mats"] and "metal_dark" in _lamp["mats"]
    _sig = TEMPLATES["signal"]()
    assert _sig["mats"].count("lamp_head") == 3          # 3 lens quads
    assert abs(max(v[2] for v in _sig["verts"]) - 4.9) < 1e-6
    _stop = TEMPLATES["stop_sign"]()
    assert any(len(f) == 8 and m == "sign_red"
               for f, m in zip(_stop["faces"], _stop["mats"]))
    _gw = TEMPLATES["give_way"]()
    assert any(len(f) == 3 and m == "sign_white"
               for f, m in zip(_gw["faces"], _gw["mats"]))
    _sp = TEMPLATES["speed_sign"]()
    assert any(len(f) == 16 and m == "sign_white"
               for f, m in zip(_sp["faces"], _sp["mats"]))
    _tree = TEMPLATES["tree"]()
    assert "bark" in _tree["mats"] and "leaves" in _tree["mats"]
    assert abs(min(v[2] for v in TEMPLATES["shrub"]()["verts"])) < 1e-9
    # sign plates confront −Y
    for _tpl in ("stop_sign", "give_way", "speed_sign"):
        _md = TEMPLATES[_tpl]()
        _f = next(fc for fc, m in zip(_md["faces"], _md["mats"])
                  if m.startswith("sign_"))
        _a, _b, _c = (_md["verts"][i] for i in _f[:3])
        _e1 = tuple(_b[i] - _a[i] for i in range(3))
        _e2 = tuple(_c[i] - _a[i] for i in range(3))
        assert _e1[2] * _e2[0] - _e1[0] * _e2[2] < 0, _tpl  # normal_y < 0
    print("  template invariants OK")

    # -- 2. generated lamps on a straight 200 m residential seg -------------
    def seg_stub(**kw):
        s = {"road_idx": 0, "cls": "residential", "width": 7.0, "lanes": 2,
             "oneway": False, "bridge": False, "layer": 0, "name": None,
             "surface": None, "pts": [(0.0, 0.0), (200.0, 0.0)],
             "elev": [0.0, 0.0], "j_start": None, "j_end": None,
             "internal": False}
        s.update(kw)
        return s

    flat_road_z = lambda seg, station: 0.0
    flat_ground = lambda x, y: 0.0
    empty_graph = {"props": [], "trees": []}
    net = {"segments": [seg_stub()], "junctions": []}

    ps = place_props(empty_graph, net, flat_road_z, flat_ground, {})
    lamps = [p for p in ps if p["template"] == "lamp"]
    assert len(ps) == len(lamps) and len(lamps) == 6, len(lamps)  # ~200/30
    half = 3.5
    for p in lamps:
        assert abs(abs(p["pos"][1]) - (half + LAMP_LATERAL)) < 1e-6
        assert abs(p["pos"][1]) > half + LAMP_MARGIN   # never in carriageway
        assert abs(p["pos"][2] - CURB_LIFT) < 1e-9     # kerb lift
        assert 2.0 <= p["pos"][0] <= 198.0             # station clamp
    _sides = [1 if p["pos"][1] > 0 else -1 for p in lamps]
    assert all(_sides[i] != _sides[i + 1] for i in range(len(_sides) - 1)), \
        "sides must alternate"
    for p in lamps:  # arm faces the road: left side → −Y (±π), right → +Y (0)
        if p["pos"][1] > 0:
            assert abs(abs(p["rot_z"]) - math.pi) < 1e-6
        else:
            assert abs(p["rot_z"]) < 1e-6
    for i in range(len(lamps)):
        for j in range(i + 1, len(lamps)):
            assert math.hypot(lamps[i]["pos"][0] - lamps[j]["pos"][0],
                              lamps[i]["pos"][1] - lamps[j]["pos"][1]) \
                >= LAMP_MIN_GAP
    print(f"  straight seg: {len(lamps)} lamps, alternating, clear of asphalt")

    # -- 3. bridge lamps hug the parapet; narrow bridges get none -----------
    net_b = {"segments": [seg_stub(bridge=True, width=9.0)], "junctions": []}
    lb = [p for p in place_props(empty_graph, net_b, flat_road_z, flat_ground, {})
          if p["template"] == "lamp"]
    assert lb and all(abs(abs(p["pos"][1]) - (4.5 - LAMP_BRIDGE_INSET)) < 1e-6
                      for p in lb)
    assert all(abs(p["pos"][2]) < 1e-9 for p in lb)  # no kerb lift on decks
    net_nb = {"segments": [seg_stub(bridge=True, width=7.0)], "junctions": []}
    assert not place_props(empty_graph, net_nb, flat_road_z, flat_ground, {})
    print(f"  bridge: {len(lb)} parapet lamps at ±3.95; width<8 → none")

    # -- 4. OSM props: curb push, orientation, elevation source -------------
    g = {"props": [{"kind": "signal", "pos": (100.0, 2.0), "id": 41},
                   {"kind": "stop", "pos": (50.0, 1.0), "id": 42},
                   {"kind": "bench", "pos": (500.0, 500.0), "id": 43},
                   {"kind": "crossing", "pos": (60.0, 0.0), "id": 46}],
         "trees": [{"pos": (10.0, 30.0), "id": 7},
                   {"pos": (60.0, -25.0), "id": 8}]}
    road_z_c = lambda seg, station: 1.5
    ps2 = place_props(g, net, road_z_c, flat_ground, {"lamps": False})
    assert not any(p["template"] not in TEMPLATES for p in ps2)
    _sigp = next(p for p in ps2 if p["template"] == "signal")
    assert abs(_sigp["pos"][0] - 100.0) < 1e-6
    assert abs(_sigp["pos"][1] - (-4.2)) < 1e-6      # pushed to half+0.7, right
    assert abs(_sigp["pos"][2] - 1.5) < 1e-6         # seated on road elevation
    assert abs(_sigp["rot_z"] - (-math.pi / 2)) < 1e-6  # aligns with +X travel
    _stopp = next(p for p in ps2 if p["template"] == "stop_sign")
    assert abs(_stopp["pos"][1] - (-4.2)) < 1e-6
    assert abs(_stopp["rot_z"] - math.pi / 2) < 1e-6    # confronts oncoming
    _benchp = next(p for p in ps2 if p["template"] == "bench")
    assert _benchp["pos"] == (500.0, 500.0, 0.0)     # far from roads: raw+terrain
    _trees = [p for p in ps2 if p["template"] == "tree"]
    assert len(_trees) == 2
    assert all(0.8 <= p["scale"] < 1.3 for p in _trees)
    # kept-raw prop beyond half+8 falls back to terrain elevation
    g2 = {"props": [{"kind": "give_way", "pos": (100.0, 13.0), "id": 44}],
          "trees": []}
    _p3 = place_props(g2, net, road_z_c, flat_ground, {"lamps": False})[0]
    assert _p3["pos"] == (100.0, 13.0, 0.0)
    print("  OSM props: signal pushed (100, -4.2) z=road, stop faces oncoming, "
          "far bench kept raw")

    # -- 5. generated lamps keep 8 m from OSM lamps -------------------------
    g3 = {"props": [{"kind": "lamp", "pos": (15.0, 4.0), "id": 45}], "trees": []}
    ps4 = place_props(g3, net, flat_road_z, flat_ground, {})
    _lamps4 = [p for p in ps4 if p["template"] == "lamp"]
    assert len(_lamps4) >= 5
    for i in range(len(_lamps4)):
        for j in range(i + 1, len(_lamps4)):
            assert math.hypot(
                _lamps4[i]["pos"][0] - _lamps4[j]["pos"][0],
                _lamps4[i]["pos"][1] - _lamps4[j]["pos"][1]) >= LAMP_MIN_GAP
    print(f"  OSM lamp respected: {len(_lamps4)} lamps total, all >= 8 m apart")

    # -- 6. determinism ------------------------------------------------------
    _a = place_props(g, net, road_z_c, flat_ground, {})
    _b = place_props(g, net, road_z_c, flat_ground, {})
    assert _a == _b and _a
    # opts gating
    assert not place_props(g, net, road_z_c, flat_ground,
                           {"props": False, "trees": False})
    print("  deterministic across runs; opts gating OK")

    print("props_gen self-tests OK")
