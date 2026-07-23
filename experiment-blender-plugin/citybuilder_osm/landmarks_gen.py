"""landmarks_gen.py — recognizable bridge landmarks from tagged OSM bridge ways.

Pure module (no bpy). `detect()` classifies chains of bridge road segments into
suspension / stone-arch landmark spans (wikidata QID -> name regex -> structure
tag -> span-length fallback), `build_suspension()` / `build_arch()` emit
MeshData with the exact proportions from specs/export-landmarks-props.md §B.

Coordinates: metres, X=east, Y=north, Z=up (the app spec doc is Y-up: spec
y/elevation -> our z, spec ground z -> our y). Deterministic: no random/time.
"""
import bisect
import math
import re

try:
    from . import geom
except ImportError:  # direct `python3 landmarks_gen.py` execution
    import geom

# --- material keys ------------------------------------------------------------
MAT_STEEL = "landmark_steel"  # suspension towers/cables/girder (dedicated per SPEC)
MAT_STONE = "stone"           # arch masonry (spandrels, soffit, parapet, towers)
MAT_PIER = "concrete"         # arch piers + cutwaters
MAT_DECK = "asphalt"          # drivable deck top
MAT_ROOF = "roof_tile"        # gate-tower cone roofs

COLOR_SUSPENSION_GENERIC = "#9a9ea3"  # structure-tag / length fallback (spec §B)
COLOR_SANDSTONE = "#b8a883"

JOIN_TOL = 45.0        # m — endpoint tolerance when chaining bridge segments
SUSPENDER_STEP = 16.0  # m — hanger spacing between suspension towers
GIRDER_TOP = 1.2       # girder/railing wall extents relative to deck z (spec §B)
GIRDER_BOT = -1.6

# wikidata QID -> (kind, color, gate towers). Colors per spec seeds; Q391137 /
# Q460655 / Q188507 are catalog extras without spec colors (see module notes).
_CATALOG = {
    "Q44440": ("suspension", "#c0362c", False),   # Golden Gate — Intl Orange
    "Q123067": ("suspension", "#9a8c78", False),  # Brooklyn Bridge
    "Q391137": ("suspension", "#c0362c", False),  # 25 de Abril — GG-orange twin
    "Q460655": ("suspension", COLOR_SUSPENSION_GENERIC, False),
    "Q204871": ("arch", COLOR_SANDSTONE, True),   # Charles Bridge — gate towers
    "Q188507": ("arch", COLOR_SANDSTONE, True),
    "Q83125": ("suspension", "#5f6fa0", False),   # Tower Bridge — blue-gray
}

_NAME_RULES = [
    (re.compile(r"karl[uů]v|charles", re.IGNORECASE),
     ("arch", COLOR_SANDSTONE, True)),
    (re.compile(r"golden\s*gate", re.IGNORECASE),
     ("suspension", "#c0362c", False)),
]


# --- small helpers --------------------------------------------------------------
def _clamp(v, lo, hi):
    if hi < lo:  # degenerate bounds (e.g. very low deck over water) — lo wins
        hi = lo
    return lo if v < lo else hi if v > hi else v


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _dist3(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _mag(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


class _Path:
    """Arc-length parametrised 2D centerline with per-point deck elevations."""

    def __init__(self, pts, elevs):
        self.pts = [(float(p[0]), float(p[1])) for p in pts]
        self.cum = geom.arc_lengths(self.pts)
        self.length = self.cum[-1]
        elevs = list(elevs) if elevs else [0.0] * len(self.pts)
        if len(elevs) < len(self.pts):  # defensive pad — contract says aligned
            elevs += [elevs[-1] if elevs else 0.0] * (len(self.pts) - len(elevs))
        self.elevs = [float(e) for e in elevs]

    def at(self, s):
        """station s (m) -> ((x, y), unit dir (dx, dy), deck z)."""
        s = _clamp(s, 0.0, self.length)
        i = bisect.bisect_right(self.cum, s) - 1
        i = max(0, min(i, len(self.pts) - 2))
        a, b = self.pts[i], self.pts[i + 1]
        seg = self.cum[i + 1] - self.cum[i]
        t = 0.0 if seg <= 1e-9 else (s - self.cum[i]) / seg
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1.0
        return ((geom.lerp(a[0], b[0], t), geom.lerp(a[1], b[1], t)),
                (dx / ln, dy / ln),
                geom.lerp(self.elevs[i], self.elevs[i + 1], t))


def _add_face(md, idxs, mat, uv=None):
    md["faces"].append(list(idxs))
    md["mats"].append(mat)
    if uv is not None and md["uvs"] is None:
        md["uvs"] = [None] * (len(md["faces"]) - 1)
    if md["uvs"] is not None:
        md["uvs"].append(uv)


def _quad_strip(md, line_a, line_b, mat, uvs=None):
    """Quads [a_i, a_i+1, b_i+1, b_i] between two equal-length 3D polylines.

    Winding rule (X=east,Y=north,Z=up): with a running along travel dir T and
    (b_i − a_i) = D, face normal ∝ T × D. Callers order lines accordingly:
    top surface: a=right edge, b=left edge; wall facing left-normal +n:
    a=top, b=bottom; wall facing −n: a=bottom, b=top.
    """
    base = len(md["verts"])
    md["verts"].extend(line_a)
    md["verts"].extend(line_b)
    n = len(line_a)
    for i in range(n - 1):
        if _dist3(line_a[i], line_a[i + 1]) < 1e-9 and _dist3(line_b[i], line_b[i + 1]) < 1e-9:
            continue  # degenerate slice
        _add_face(md, [base + i, base + i + 1, base + n + i + 1, base + n + i],
                  mat, uv=(uvs[i] if uvs else None))


def _box_ring(c, t, n, len_along, len_across):
    """CCW rectangle ring centred at c, oriented by unit tangent t / left normal n."""
    ha, hc = len_along / 2.0, len_across / 2.0
    return [
        (c[0] + t[0] * ha + n[0] * hc, c[1] + t[1] * ha + n[1] * hc),
        (c[0] - t[0] * ha + n[0] * hc, c[1] - t[1] * ha + n[1] * hc),
        (c[0] - t[0] * ha - n[0] * hc, c[1] - t[1] * ha - n[1] * hc),
        (c[0] + t[0] * ha - n[0] * hc, c[1] + t[1] * ha - n[1] * hc),
    ]


def sweep_tube(path_pts_3d, radius, segs=6, mat=MAT_STEEL):
    """Sweep a circular (polygonal) tube along a 3D path -> fresh MeshData.

    Parallel-transport-lite: one reference up vector for the whole path (Z, or
    X for near-vertical paths), per-point frame side=norm(up×t), u2=t×side —
    right-handed, so quads and end caps wind CCW outward. Fine for the mostly
    planar/vertical cable, suspender and brace paths used here.
    """
    pts = []
    for p in path_pts_3d:
        q = (float(p[0]), float(p[1]), float(p[2]))
        if not pts or _dist3(pts[-1], q) > 1e-6:
            pts.append(q)
    md = geom.new_meshdata()
    if len(pts) < 2 or radius <= 0.0:
        return md
    n = len(pts)
    tangents = []
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        d = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        ln = _mag(d) or 1.0
        tangents.append((d[0] / ln, d[1] / ln, d[2] / ln))
    avg = (sum(t[0] for t in tangents), sum(t[1] for t in tangents),
           sum(t[2] for t in tangents))
    ln = _mag(avg) or 1.0
    up = (0.0, 0.0, 1.0) if abs(avg[2] / ln) < 0.9 else (1.0, 0.0, 0.0)
    for i in range(n):
        t = tangents[i]
        side = _cross(up, t)
        sl = _mag(side)
        if sl < 1e-6:  # tangent parallel to reference — pick another axis
            side = _cross((0.0, 1.0, 0.0), t)
            sl = _mag(side) or 1.0
        side = (side[0] / sl, side[1] / sl, side[2] / sl)
        u2 = _cross(t, side)  # unit: t ⊥ side, both unit
        p = pts[i]
        for j in range(segs):
            a = 2.0 * math.pi * j / segs
            ca, sa = math.cos(a) * radius, math.sin(a) * radius
            md["verts"].append((p[0] + side[0] * ca + u2[0] * sa,
                                p[1] + side[1] * ca + u2[1] * sa,
                                p[2] + side[2] * ca + u2[2] * sa))
    for i in range(n - 1):
        for j in range(segs):
            j2 = (j + 1) % segs
            _add_face(md, [i * segs + j, i * segs + j2,
                           (i + 1) * segs + j2, (i + 1) * segs + j], mat)
    _add_face(md, list(range(segs - 1, -1, -1)), mat)              # start cap (−t)
    _add_face(md, [(n - 1) * segs + j for j in range(segs)], mat)  # end cap (+t)
    return md


def _suspender_stations(length):
    """Hanger stations (m from span start): every 16 m between the towers."""
    s1, s2 = 0.30 * length, 0.70 * length
    count = int(math.floor((s2 - s1) / SUSPENDER_STEP)) + 1
    return [s1 + SUSPENDER_STEP * k for k in range(count)]


def _arch_params(length):
    """(n_spans, span_pitch, pier_half, open_half) per spec §B arch numbers."""
    n_spans = int(_clamp(math.floor(length / 28.0 + 0.5), 3, 20))  # JS-style round
    pitch = length / n_spans
    pier_half = _clamp(pitch * 0.13, 1.4, 3.2)
    open_half = max(pitch / 2.0 - pier_half, 2.0)
    return n_spans, pitch, pier_half, open_half


# --- detection ------------------------------------------------------------------
def _compat(a, b):
    """Chainable pair: same (non-empty) name, else same class."""
    na, nb = a.get("name") or "", b.get("name") or ""
    if na and nb:
        return na.casefold() == nb.casefold()
    return (a.get("class") or "") == (b.get("class") or "")


def _classify(members, length):
    """(kind, color, towers) for a chained span, or None to skip (plain deck)."""
    for r in members:
        wd = (r.get("wikidata") or "").strip()
        if wd in _CATALOG:
            return _CATALOG[wd]
    name = next((r.get("name") for r in members if r.get("name")), None)
    if name:
        for rx, res in _NAME_RULES:
            if rx.search(name):
                return res
    for r in members:
        st = (r.get("structure") or "").strip().lower().replace("_", "-")
        if st in ("suspension", "cable-stayed"):
            return "suspension", COLOR_SUSPENSION_GENERIC, False
        if st == "arch":
            return "arch", COLOR_SANDSTONE, False
    if length >= 180.0:
        return "suspension", COLOR_SUSPENSION_GENERIC, False
    if length >= 120.0:
        return "arch", COLOR_SANDSTONE, False
    return None  # short untagged bridge — the plain road deck is enough


def detect(roads):
    """Find landmark bridge spans in graph["roads"].

    Chains contiguous bridge=True segments of the same name (or class) whose
    endpoints join within 45 m, ordered by connectivity. Returns
    [{"kind": "suspension"|"arch", "road_idxs": [int], "color": "#rrggbb",
      "towers": bool}] — road_idxs let the caller suppress duplicate deck
    parapets for these segments.
    """
    bridge_idxs = [i for i, r in enumerate(roads)
                   if r.get("bridge") and len(r.get("pts") or ()) >= 2]
    used = set()
    out = []
    for seed in bridge_idxs:
        if seed in used:
            continue
        used.add(seed)
        chain = [seed]
        start = roads[seed]["pts"][0]
        end = roads[seed]["pts"][-1]
        total = geom.arc_lengths(roads[seed]["pts"])[-1]
        grew = True
        while grew:
            grew = False
            for j in bridge_idxs:  # ascending index — deterministic
                if j in used:
                    continue
                pts = roads[j]["pts"]
                a, b = pts[0], pts[-1]
                seg_len = geom.arc_lengths(pts)[-1]
                if _compat(roads[chain[-1]], roads[j]):
                    d = _dist(end, a)
                    if d <= JOIN_TOL:
                        chain.append(j); used.add(j); end = b
                        total += d + seg_len; grew = True; break
                    d = _dist(end, b)
                    if d <= JOIN_TOL:
                        chain.append(j); used.add(j); end = a
                        total += d + seg_len; grew = True; break
                if _compat(roads[chain[0]], roads[j]):
                    d = _dist(start, b)
                    if d <= JOIN_TOL:
                        chain.insert(0, j); used.add(j); start = a
                        total += d + seg_len; grew = True; break
                    d = _dist(start, a)
                    if d <= JOIN_TOL:
                        chain.insert(0, j); used.add(j); start = b
                        total += d + seg_len; grew = True; break
        res = _classify([roads[i] for i in chain], total)
        if res:
            kind, color, towers = res
            out.append({"kind": kind, "road_idxs": chain,
                        "color": color, "towers": towers})
    return out


# --- suspension bridge ------------------------------------------------------------
def build_suspension(centerline, elevs, width, color):
    """Suspension bridge (towers + parabolic cables + hangers + girder deck).

    centerline: [(x, y)] plan points; elevs: deck z per point; width: deck m.
    Returns MeshData (empty if span < 45 m). Extra key "color" carries the
    catalog tint for build.py; attrs["tint"] = 0 on every face.
    """
    md = geom.new_meshdata()
    if len(centerline) < 2:
        return md
    path = _Path(centerline, elevs)
    length = path.length
    if length < 45.0:
        return md
    half = max(width / 2.0, 4.0)
    tower_h = _clamp(length * 0.16, 24.0, 130.0)
    sag = 0.86 * tower_h
    s1, s2 = 0.30 * length, 0.70 * length      # tower stations
    leg_w = max(2.0, half * 0.16)
    cable_r = max(0.35, half * 0.045)

    # -- deck slab + girder/railing walls (deckZ−1.6 .. +1.2) --
    pts_d, extras = geom.densify_polyline(path.pts, 6.0, [path.elevs])
    elev_d = extras[0]
    cums = geom.arc_lengths(pts_d)
    left2 = geom.offset_polyline(pts_d, half)
    right2 = geom.offset_polyline(pts_d, -half)

    def line(p2, dz):
        return [(p[0], p[1], elev_d[i] + dz) for i, p in enumerate(p2)]

    ldk, lt, lb = line(left2, 0.0), line(left2, GIRDER_TOP), line(left2, GIRDER_BOT)
    rdk, rt, rb = line(right2, 0.0), line(right2, GIRDER_TOP), line(right2, GIRDER_BOT)
    wdt = 2.0 * half
    deck_uvs = [[(0.0, cums[i]), (0.0, cums[i + 1]), (wdt, cums[i + 1]), (wdt, cums[i])]
                for i in range(len(pts_d) - 1)]
    _quad_strip(md, rdk, ldk, MAT_DECK, uvs=deck_uvs)  # deck top (+Z)
    _quad_strip(md, lb, rb, MAT_STEEL)                 # girder underside (−Z)
    _quad_strip(md, lt, lb, MAT_STEEL)                 # left wall outer (+n)
    _quad_strip(md, lb, lt, MAT_STEEL)                 # left wall inner (−n)
    _quad_strip(md, rb, rt, MAT_STEEL)                 # right wall outer (−n)
    _quad_strip(md, rt, rb, MAT_STEEL)                 # right wall inner (+n)
    for i, flip in ((0, True), (len(pts_d) - 1, False)):  # girder end caps
        b0 = len(md["verts"])
        md["verts"].extend([lb[i], lt[i], rt[i], rb[i]])
        idx = [b0, b0 + 1, b0 + 2, b0 + 3]  # forward = +T (end); reversed = −T
        _add_face(md, list(reversed(idx)) if flip else idx, MAT_STEEL)

    # -- towers at 30% / 70%: legs straddling deck edges + two cross-braces --
    for st in (s1, s2):
        pos, t, z = path.at(st)
        n = (-t[1], t[0])
        for lat in (half, -half):
            c = (pos[0] + n[0] * lat, pos[1] + n[1] * lat)
            geom.add_prism(md, _box_ring(c, t, n, leg_w, leg_w),
                           z + GIRDER_BOT, z + tower_h,
                           MAT_STEEL, MAT_STEEL, MAT_STEEL)
        for f in (0.62, 0.92):  # cross-brace fractions of towerH (spec §B)
            zc = z + tower_h * f
            geom.add_prism(md, _box_ring(pos, t, n, leg_w * 0.7, 2.0 * half + leg_w),
                           zc - 0.45 * leg_w, zc + 0.45 * leg_w,
                           MAT_STEEL, MAT_STEEL, MAT_STEEL)

    # -- main cables (octagonal tubes) + suspenders per side --
    z_t1, z_t2 = path.at(s1)[2], path.at(s2)[2]
    top1, top2 = z_t1 + tower_h, z_t2 + tower_h

    def cable_z(t):  # parabola between towers: sag 0.86·towerH at midspan
        u = 2.0 * t - 1.0
        return geom.lerp(z_t1, z_t2, t) + tower_h - sag * (1.0 - u * u)

    z_a = path.at(2.0)[2] + 1.0             # anchorage: 2 m from ends, deck+1
    z_b = path.at(length - 2.0)[2] + 1.0
    for lat in (half, -half):
        def at_lat(s, z, _lat=lat):
            pos, t, _ = path.at(s)
            n = (-t[1], t[0])
            return (pos[0] + n[0] * _lat, pos[1] + n[1] * _lat, z)

        pth = []
        for k in range(9):  # back stay: anchor -> tower 1
            f = k / 8.0
            pth.append(at_lat(geom.lerp(2.0, s1, f), geom.lerp(z_a, top1, f)))
        for k in range(1, 32):  # main span parabola
            f = k / 32.0
            pth.append(at_lat(geom.lerp(s1, s2, f), cable_z(f)))
        for k in range(9):  # back stay: tower 2 -> anchor
            f = k / 8.0
            pth.append(at_lat(geom.lerp(s2, length - 2.0, f), geom.lerp(top2, z_b, f)))
        geom.merge_meshdata(md, sweep_tube(pth, cable_r, segs=8))

        for s in _suspender_stations(length):
            f = (s - s1) / (s2 - s1)
            zc = cable_z(f)
            base = path.at(s)[2] + 1.2  # hanger foot on the railing top
            if zc - base < 0.5:
                continue
            geom.merge_meshdata(
                md, sweep_tube([at_lat(s, base), at_lat(s, zc)], 0.18, segs=6))

    md["attrs"]["tint"] = [0.0] * len(md["faces"])
    md["color"] = color  # convenience for build.py tinting (ignored by merge)
    return md


# --- stone arch bridge --------------------------------------------------------------
def build_arch(centerline, elevs, width, color, water_y=-1.2, towers=False):
    """Multi-span stone arch bridge with circular soffits, piers and cutwaters.

    water_y: water surface z the piers stand in (our Z-up = spec waterY).
    towers=True adds Charles-style gate towers at 5% / 95% of the span.
    Returns MeshData (empty if span < 40 m).
    """
    md = geom.new_meshdata()
    if len(centerline) < 2:
        return md
    path = _Path(centerline, elevs)
    length = path.length
    if length < 40.0:
        return md
    half = max(width / 2.0, 2.5)
    parapet_h = 1.05
    deck_thk = 0.7
    n_spans, pitch, pier_half, open_half = _arch_params(length)
    crown = min(path.elevs) - deck_thk  # arch crown = lowest deck − deck thickness
    rise = _clamp(open_half * 0.72, 1.5, max(1.5, crown - water_y - 1.6))
    spring_z = crown - rise
    arch_rad = (open_half * open_half + rise * rise) / (2.0 * rise)
    circle_cz = crown - arch_rad
    node_s = [k * pitch for k in range(n_spans + 1)]     # piers + both abutments
    mid_s = [(k + 0.5) * pitch for k in range(n_spans)]  # opening centres

    def under_z(s):
        d = min(abs(s - ps) for ps in node_s)
        if d <= pier_half:            # over a pier/abutment: drop to water
            return water_y
        m = min(abs(s - ms) for ms in mid_s)
        if m <= open_half:            # circular soffit
            return circle_cz + math.sqrt(max(0.0, arch_rad * arch_rad - m * m))
        return spring_z               # haunch shelf (only when openHalf clamped)

    # stations: 1.5 m grid + pier-edge pairs so pier faces are crisp verticals
    st = set()
    k = 0
    while k * 1.5 < length:
        st.add(round(k * 1.5, 4))
        k += 1
    st.add(round(length, 4))
    eps = 1e-3
    for ps in node_s:
        for e in (ps - pier_half, ps + pier_half):
            for q in (e - eps, e + eps):
                if 0.0 < q < length:
                    st.add(round(q, 4))
    stations = sorted(st)

    plan = [path.at(s) for s in stations]
    pts2 = [p[0] for p in plan]
    deck_z = [p[2] for p in plan]
    top_z = [z + parapet_h for z in deck_z]
    uz = [under_z(s) for s in stations]
    cums = geom.arc_lengths(pts2)
    out_l = geom.offset_polyline(pts2, half)
    out_r = geom.offset_polyline(pts2, -half)
    in_l = geom.offset_polyline(pts2, half - 0.45)   # parapet thickness 0.45
    in_r = geom.offset_polyline(pts2, -(half - 0.45))

    def line(p2, zz):
        return [(p[0], p[1], zz[i]) for i, p in enumerate(p2)]

    ol_u, ol_t = line(out_l, uz), line(out_l, top_z)
    or_u, or_t = line(out_r, uz), line(out_r, top_z)
    il_d, il_t = line(in_l, deck_z), line(in_l, top_z)
    ir_d, ir_t = line(in_r, deck_z), line(in_r, top_z)

    _quad_strip(md, ol_u, or_u, MAT_STONE)  # soffit (faces down)
    _quad_strip(md, ol_t, ol_u, MAT_STONE)  # left spandrel/parapet outer (+n)
    _quad_strip(md, or_u, or_t, MAT_STONE)  # right spandrel/parapet outer (−n)
    _quad_strip(md, il_d, il_t, MAT_STONE)  # left parapet inner (−n)
    _quad_strip(md, ir_t, ir_d, MAT_STONE)  # right parapet inner (+n)
    _quad_strip(md, il_t, ol_t, MAT_STONE)  # left parapet cap (up)
    _quad_strip(md, or_t, ir_t, MAT_STONE)  # right parapet cap (up)
    wdt = 2.0 * (half - 0.45)
    deck_uvs = [[(0.0, cums[i]), (0.0, cums[i + 1]), (wdt, cums[i + 1]), (wdt, cums[i])]
                for i in range(len(pts2) - 1)]
    _quad_strip(md, ir_d, il_d, MAT_DECK, uvs=deck_uvs)  # deck top (up)
    for i, flip in ((0, True), (len(stations) - 1, False)):  # abutment end caps
        b0 = len(md["verts"])
        md["verts"].extend([ol_u[i], ol_t[i], or_t[i], or_u[i]])
        idx = [b0, b0 + 1, b0 + 2, b0 + 3]
        _add_face(md, list(reversed(idx)) if flip else idx, MAT_STONE)

    # -- piers (box, slightly wider than deck) + triangular cutwaters --
    pier_top = max(spring_z, water_y + 0.5)
    for kk in range(1, n_spans):
        s = node_s[kk]
        pos, t, _z = path.at(s)
        n = (-t[1], t[0])
        geom.add_prism(md, _box_ring(pos, t, n, 2.0 * pier_half, 2.0 * half + 0.4),
                       water_y, pier_top, MAT_PIER, MAT_PIER, MAT_PIER)
        cw = pier_half * 1.6  # cutwater nose length (spec §B)
        for side in (1.0, -1.0):
            e = half + 0.2
            tri = [
                (pos[0] + t[0] * pier_half + n[0] * e * side,
                 pos[1] + t[1] * pier_half + n[1] * e * side),
                (pos[0] - t[0] * pier_half + n[0] * e * side,
                 pos[1] - t[1] * pier_half + n[1] * e * side),
                (pos[0] + n[0] * (e + cw) * side, pos[1] + n[1] * (e + cw) * side),
            ]
            geom.add_prism(md, tri, water_y, pier_top, MAT_PIER, MAT_PIER, MAT_PIER)

    # -- Charles-style gate towers at 5% / 95% (gate 5.5, body 13, cone 7) --
    if towers:
        gate_h, body_h, cone_h = 5.5, 13.0, 7.0
        for fs in (0.05, 0.95):
            pos, t, z = path.at(fs * length)
            n = (-t[1], t[0])
            for side in (1.0, -1.0):  # gate legs flanking the deck
                c = (pos[0] + n[0] * (half + 0.8) * side,
                     pos[1] + n[1] * (half + 0.8) * side)
                geom.add_prism(md, _box_ring(c, t, n, 4.0, 1.6),
                               z, z + gate_h, MAT_STONE, MAT_STONE, MAT_STONE)
            body = _box_ring(pos, t, n, 4.0, 2.0 * half + 3.2)
            z0, z1 = z + gate_h, z + gate_h + body_h
            geom.add_prism(md, body, z0, z1, MAT_STONE, MAT_STONE, MAT_STONE)
            b0 = len(md["verts"])  # 4-sided cone roof (base ring is CCW)
            md["verts"].extend((p[0], p[1], z1) for p in body)
            apex = len(md["verts"])
            md["verts"].append((pos[0], pos[1], z1 + cone_h))
            for i in range(4):
                _add_face(md, [b0 + i, b0 + (i + 1) % 4, apex], MAT_ROOF)

    md["attrs"]["tint"] = [0.0] * len(md["faces"])
    md["color"] = color  # convenience for build.py tinting (ignored by merge)
    return md


# --- vertical structures (Buildings v3, PLAN.md §3.5) ------------------------------
# Church spires, water towers and industrial chimneys — pure parametric
# builders called by build.py (churches from building kind, the rest from
# graph["structures"] man_made nodes/ways). All deterministic, tint attr 0.

SPIRE_MAT_BODY = "stone"
SPIRE_MAT_ROOF = "roof_tile"
SPIRE_MAT_CROSS = "metal"


def _frame_ring(ring):
    """Dominant-axis frame (longest edge): (ex, ey, u0, u1, v0, v1)."""
    n = len(ring)
    best, k = -1.0, 0
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
    return ex, ey, min(us), max(us), min(vs), max(vs)


def _ring_stack_at(md, cx, cy, rings, mat, segs=8, cap_top=True):
    """Loft circular rings [(z, r), ...] around (cx, cy); CCW from outside."""
    base = len(md["verts"])
    for z, r in rings:
        for k in range(segs):
            a = (k / segs) * math.tau
            md["verts"].append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    for i in range(len(rings) - 1):
        lo, hi = base + i * segs, base + (i + 1) * segs
        for k in range(segs):
            k2 = (k + 1) % segs
            _add_face(md, [lo + k, lo + k2, hi + k2, hi + k], mat)
    if cap_top:
        top = base + (len(rings) - 1) * segs
        _add_face(md, [top + k for k in range(segs)], mat)
    return md


def build_spire(ring, base_z, top_z):
    """Church tower + pyramidal spire + cross, seated at the 'west front'
    (~18% along the longest footprint axis). Tower side = clamp(0.5 × shorter
    extent, 2.5, 7); tower rises 45% of the body height (min 4 m) above the
    roofline; spire height = 1.5 × side; cross 1.6 m. Empty for slivers."""
    md = geom.new_meshdata()
    ring = [(float(x), float(y)) for x, y in ring]
    if len(ring) < 3:
        return md
    ex, ey, u0, u1, v0, v1 = _frame_ring(ring)
    e_min = min(u1 - u0, v1 - v0)
    if e_min < 4.0 or top_z - base_z < 3.0:
        return md
    s = _clamp(0.5 * e_min, 2.5, 7.0)
    uc = max(u0 + s / 2.0 + 0.3, u0 + 0.18 * (u1 - u0))
    vc = (v0 + v1) / 2.0
    cx, cy = uc * ex - vc * ey, uc * ey + vc * ex
    tower_top = top_z + max(4.0, 0.45 * (top_z - base_z))
    half = s / 2.0
    sq = [(cx + ex * a * half + -ey * b * half, cy + ey * a * half + ex * b * half)
          for a, b in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
    geom.add_prism(md, sq, base_z, tower_top, SPIRE_MAT_BODY,
                   mat_top=SPIRE_MAT_BODY, uv_walls=False)
    apex_z = tower_top + 1.5 * s
    base_i = len(md["verts"])
    md["verts"].extend((p[0], p[1], tower_top) for p in sq)
    apex = len(md["verts"])
    md["verts"].append((cx, cy, apex_z))
    for i in range(4):
        _add_face(md, [base_i + i, base_i + (i + 1) % 4, apex], SPIRE_MAT_ROOF)
    # cross: vertical post + horizontal arm (thin prisms)
    post = [(cx - 0.06, cy - 0.06), (cx + 0.06, cy - 0.06),
            (cx + 0.06, cy + 0.06), (cx - 0.06, cy + 0.06)]
    geom.add_prism(md, post, apex_z, apex_z + 1.6, SPIRE_MAT_CROSS,
                   mat_top=SPIRE_MAT_CROSS, uv_walls=False)
    arm_z = apex_z + 1.05
    arm = [(cx + ex * a * 0.5 + -ey * b * 0.06, cy + ey * a * 0.5 + ex * b * 0.06)
           for a, b in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
    geom.add_prism(md, arm, arm_z, arm_z + 0.12, SPIRE_MAT_CROSS,
                   mat_top=SPIRE_MAT_CROSS, mat_bottom=SPIRE_MAT_CROSS,
                   uv_walls=False)
    if md["uvs"] is not None:
        md["uvs"] += [None] * (len(md["faces"]) - len(md["uvs"]))
    md["attrs"]["tint"] = [0.0] * len(md["faces"])
    return md


def build_water_tower(pos, ground_z, height=None):
    """Classic 4-leg steel water tower: legs to a 62% platform, riser tube,
    tank cylinder 62–94% + cone cap. height tag clamped to [12, 60], default 25."""
    md = geom.new_meshdata()
    x, y = float(pos[0]), float(pos[1])
    h = _clamp(float(height or 25.0), 12.0, 60.0)
    z0 = ground_z
    z_plat, z_tank = z0 + 0.62 * h, z0 + 0.94 * h
    tank_r = _clamp(h * 0.13, 2.2, 4.5)
    leg_r = tank_r * 0.72
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        geom.merge_meshdata(md, sweep_tube(
            [(x + sx * leg_r, y + sy * leg_r, z0 - 0.5),
             (x + sx * leg_r * 0.75, y + sy * leg_r * 0.75, z_plat)],
            0.16, segs=6, mat="metal"))
    geom.merge_meshdata(md, sweep_tube([(x, y, z0 - 0.5), (x, y, z_plat)],
                                       0.3, segs=6, mat="metal"))
    geom.merge_meshdata(md, sweep_tube([(x, y, z_plat), (x, y, z_tank)],
                                       tank_r, segs=10, mat="metal"))
    _ring_stack_at(md, x, y, [(z_tank, tank_r), (z0 + h, 0.15)], "metal",
                   segs=10)
    md["attrs"]["tint"] = [0.0] * len(md["faces"])
    return md


def build_chimney(pos, ground_z, height=None):
    """Industrial stack: tapered 10-seg cone r1.8→1.1 + dark collar at 92%.
    height tag clamped to [15, 120], default 35."""
    md = geom.new_meshdata()
    x, y = float(pos[0]), float(pos[1])
    h = _clamp(float(height or 35.0), 15.0, 120.0)
    z0 = ground_z
    _ring_stack_at(md, x, y,
                   [(z0 - 0.5, 1.8), (z0 + 0.55 * h, 1.4), (z0 + h, 1.1)],
                   "concrete", segs=10)
    _ring_stack_at(md, x, y,
                   [(z0 + 0.92 * h, 1.24), (z0 + 0.97 * h, 1.2)],
                   "metal_dark", segs=10, cap_top=False)
    md["attrs"]["tint"] = [0.0] * len(md["faces"])
    return md


# --- self-tests ------------------------------------------------------------------
if __name__ == "__main__":
    def check_mesh(md, label, tint=True):
        assert len(md["verts"]) > 0 and len(md["faces"]) > 0, label
        assert len(md["mats"]) == len(md["faces"]), label
        if md.get("uvs") is not None:
            assert len(md["uvs"]) == len(md["faces"]), label + " uvs"
        nv = len(md["verts"])
        for v in md["verts"]:
            assert len(v) == 3 and all(math.isfinite(c) for c in v), label + " NaN"
        for f in md["faces"]:
            assert len(f) >= 3 and all(0 <= i < nv for i in f), label + " idx"
        if tint:
            t = md["attrs"].get("tint")
            assert t is not None and len(t) == len(md["faces"]), label + " tint"
            assert all(x == 0.0 for x in t), label + " tint=0"

    # --- sweep_tube ---
    tube = sweep_tube([(0, 0, 0), (10, 0, 0)], 1.0, segs=6)
    check_mesh(tube, "tube", tint=False)
    assert len(tube["verts"]) == 12 and len(tube["faces"]) == 6 + 2
    for v in tube["verts"]:
        assert abs(math.hypot(v[1], v[2]) - 1.0) < 1e-6  # on the r=1 cylinder
    vert_tube = sweep_tube([(3, 4, 0), (3, 4, 5)], 0.18, segs=6)  # vertical path
    check_mesh(vert_tube, "vtube", tint=False)
    assert len(vert_tube["verts"]) == 12
    for v in vert_tube["verts"]:
        assert abs(math.hypot(v[0] - 3, v[1] - 4) - 0.18) < 1e-6
    print("sweep_tube ok:", len(tube["verts"]), "verts,", len(tube["faces"]), "faces")

    # --- suspension: 300 m straight, flat deck 6.55, width 8 ---
    sus = build_suspension([(0.0, 0.0), (300.0, 0.0)], [6.55, 6.55], 8.0, "#c0362c")
    check_mesh(sus, "suspension")
    assert sus["color"] == "#c0362c"
    zs = [v[2] for v in sus["verts"]]
    tower_top = 6.55 + _clamp(300.0 * 0.16, 24.0, 130.0)
    assert abs(tower_top - 54.55) < 1e-9
    assert any(abs(z - tower_top) < 0.01 for z in zs), "tower top missing"
    assert max(zs) <= tower_top + 0.36  # only cable tube surface above tower top
    assert abs(min(zs) - (6.55 - 1.6)) < 0.01  # girder/leg bottom
    sag = 0.86 * 48.0
    exp_cable_min = 6.55 + 48.0 - sag  # 13.27
    mid = [v[2] for v in sus["verts"] if 147.0 <= v[0] <= 153.0 and v[2] > 9.0]
    assert mid and abs(min(mid) - (exp_cable_min - 0.35)) < 0.35, min(mid)
    stns = _suspender_stations(300.0)
    assert len(stns) == int(120.0 / 16.0) + 1 == 8
    assert MAT_DECK in sus["mats"] and MAT_STEEL in sus["mats"]
    assert build_suspension([(0, 0), (30, 0)], [0, 0], 8.0, None)["faces"] == []
    # sloped deck: no NaN, tower tops follow local deck z
    sus2 = build_suspension([(0.0, 0.0), (150.0, 150.0), (300.0, 300.0)],
                            [5.0, 6.5, 8.0], 12.0, "#9a9ea3")
    check_mesh(sus2, "suspension sloped")
    print("suspension ok:", len(sus["verts"]), "verts,", len(sus["faces"]),
          "faces; tower top", round(max(zs), 2), "cable min", round(min(mid), 2))

    # --- arch: 150 m straight, flat deck 6.55, width 10, water −1.2 ---
    arch = build_arch([(0.0, 0.0), (150.0, 0.0)], [6.55, 6.55], 10.0,
                      "#b8a883", water_y=-1.2)
    check_mesh(arch, "arch")
    ns, pitch, ph, oh = _arch_params(150.0)
    assert ns == 5 and abs(pitch - 30.0) < 1e-9
    assert abs(ph - 3.2) < 1e-9 and abs(oh - 11.8) < 1e-9
    # 4 piers × (box 8 faces + 2 cutwaters × 5 faces) = 72 concrete faces
    assert arch["mats"].count(MAT_PIER) == 4 * 18, arch["mats"].count(MAT_PIER)
    azs = [v[2] for v in arch["verts"]]
    assert abs(min(azs) - (-1.2)) < 1e-6      # piers/soffit reach water level
    assert abs(max(azs) - (6.55 + 1.05)) < 1e-6  # parapet top
    assert MAT_DECK in arch["mats"] and MAT_STONE in arch["mats"]
    archt = build_arch([(0.0, 0.0), (150.0, 0.0)], [6.55, 6.55], 10.0,
                       "#b8a883", water_y=-1.2, towers=True)
    check_mesh(archt, "arch towers")
    assert abs(max(v[2] for v in archt["verts"]) - (6.55 + 5.5 + 13.0 + 7.0)) < 1e-6
    assert MAT_ROOF in archt["mats"]
    assert build_arch([(0, 0), (30, 0)], [0, 0], 8.0, None)["faces"] == []
    print("arch ok:", len(arch["verts"]), "verts,", len(arch["faces"]),
          "faces; piers", arch["mats"].count(MAT_PIER) // 18)

    # --- detect ---
    def rd(pts, name=None, cls="secondary", bridge=True, structure=None,
           wikidata=None, rid=1):
        return {"class": cls, "width": 8.0, "lanes": 2, "oneway": False,
                "pts": pts, "node_ids": [], "bridge": bridge, "layer": 1,
                "id": rid, "name": name, "structure": structure,
                "wikidata": wikidata}

    karluv = [rd([(0, 0), (80, 0)], name="Karlův most", rid=10),
              rd([(80, 0), (160, 0)], name="Karlův most", rid=11),
              rd([(200, 50), (300, 50)], bridge=False, rid=12)]
    det = detect(karluv)
    assert len(det) == 1, det
    assert det[0]["kind"] == "arch" and det[0]["towers"] is True
    assert det[0]["road_idxs"] == [0, 1] and det[0]["color"] == COLOR_SANDSTONE
    # connectivity ordering: seed mid-segment, extend front and back
    gg = [rd([(100, 0), (200, 0)], name="Golden Gate Bridge"),
          rd([(0, 0), (100, 0)], name="Golden Gate Bridge"),
          rd([(200, 0), (300, 0)], name="Golden Gate Bridge")]
    dg = detect(gg)
    assert len(dg) == 1 and dg[0]["kind"] == "suspension"
    assert dg[0]["color"] == "#c0362c" and dg[0]["road_idxs"] == [1, 0, 2]
    # wikidata beats everything
    dw = detect([rd([(0, 0), (250, 0)], wikidata="Q44440")])
    assert dw[0]["kind"] == "suspension" and dw[0]["color"] == "#c0362c"
    dt = detect([rd([(0, 0), (100, 0)], wikidata="Q204871")])
    assert dt[0]["kind"] == "arch" and dt[0]["towers"] is True
    # structure tag (even short spans)
    ds = detect([rd([(0, 0), (100, 0)], structure="suspension")])
    assert ds[0]["kind"] == "suspension" and ds[0]["color"] == COLOR_SUSPENSION_GENERIC
    dcs = detect([rd([(0, 0), (100, 0)], structure="cable_stayed")])
    assert dcs and dcs[0]["kind"] == "suspension"
    da = detect([rd([(0, 0), (100, 0)], structure="arch")])
    assert da[0]["kind"] == "arch" and da[0]["towers"] is False
    # length fallback: ≥180 suspension, 120–180 arch, <120 skip
    assert detect([rd([(0, 0), (200, 0)])])[0]["kind"] == "suspension"
    d150 = detect([rd([(0, 0), (150, 0)])])
    assert d150[0]["kind"] == "arch" and d150[0]["color"] == COLOR_SANDSTONE
    assert detect([rd([(0, 0), (80, 0)])]) == []
    # join tolerance: 60 m gap must NOT chain (two 100 m spans -> both skipped)
    far = [rd([(0, 0), (100, 0)]), rd([(160, 0), (260, 0)])]
    assert detect(far) == []
    # 40 m gap chains: 100+40+100 = 240 -> suspension by length
    near = [rd([(0, 0), (100, 0)]), rd([(140, 0), (240, 0)])]
    dn = detect(near)
    assert len(dn) == 1 and dn[0]["kind"] == "suspension" and dn[0]["road_idxs"] == [0, 1]
    # determinism
    assert detect(karluv) == detect(karluv)
    sus_again = build_suspension([(0.0, 0.0), (300.0, 0.0)], [6.55, 6.55], 8.0, "#c0362c")
    assert sus_again["verts"] == sus["verts"] and sus_again["faces"] == sus["faces"]
    arch_again = build_arch([(0.0, 0.0), (150.0, 0.0)], [6.55, 6.55], 10.0,
                            "#b8a883", water_y=-1.2)
    assert arch_again["verts"] == arch["verts"]
    print("detect ok:", len(det), "landmark span(s)")

    # --- vertical structures (v3) ---
    church = [(0.0, 0.0), (30.0, 0.0), (30.0, 12.0), (0.0, 12.0)]
    sp = build_spire(church, 2.0, 14.0)   # body base 2, roofline 14
    check_mesh(sp, "spire")
    assert SPIRE_MAT_BODY in sp["mats"] and SPIRE_MAT_ROOF in sp["mats"] \
        and SPIRE_MAT_CROSS in sp["mats"]
    # side = clamp(0.5·12, 2.5, 7) = 6; tower top = 14 + max(4, 0.45·12) = 19.4;
    # apex = 19.4 + 9; cross top = apex + 1.6
    spz = [v[2] for v in sp["verts"]]
    assert abs(max(spz) - (19.4 + 9.0 + 1.6)) < 1e-6, max(spz)
    assert abs(min(spz) - 2.0) < 1e-6
    # tower sits toward the front (u≈0.18·30=5.4 > s/2+0.3=3.3), inside footprint
    body_x = [v[0] for f, m in zip(sp["faces"], sp["mats"])
              if m == SPIRE_MAT_BODY for v in (sp["verts"][i] for i in f)]
    assert 0.0 <= min(body_x) and max(body_x) <= 12.0, (min(body_x), max(body_x))
    assert build_spire([(0, 0), (3, 0), (3, 2), (0, 2)], 0.0, 8.0)["faces"] == []
    assert build_spire(church, 2.0, 14.0) == sp  # deterministic

    wt = build_water_tower((100.0, 50.0), 3.0)
    check_mesh(wt, "water tower")
    wz = [v[2] for v in wt["verts"]]
    assert abs(max(wz) - (3.0 + 25.0)) < 1e-6      # default h=25
    assert min(wz) < 3.0                            # legs buried 0.5
    assert set(wt["mats"]) == {"metal"}
    wt2 = build_water_tower((0.0, 0.0), 0.0, height=200.0)
    assert abs(max(v[2] for v in wt2["verts"]) - 60.0) < 1e-6  # clamp

    ch = build_chimney((0.0, 0.0), 1.0)
    check_mesh(ch, "chimney")
    cz = [v[2] for v in ch["verts"]]
    assert abs(max(cz) - (1.0 + 35.0)) < 1e-6
    assert "concrete" in ch["mats"] and "metal_dark" in ch["mats"]
    top_r = max(math.hypot(v[0], v[1]) for v in ch["verts"] if abs(v[2] - 36.0) < 1e-6)
    assert abs(top_r - 1.1) < 1e-6                  # taper reaches r=1.1
    assert abs(max(v[2] for v in build_chimney((0, 0), 0.0, height=8.0)["verts"])
               - 15.0) < 1e-6                       # clamp low

    print("structures ok: spire/water tower/chimney; all landmarks_gen self-tests passed")
