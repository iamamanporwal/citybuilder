"""profile.py — road cross-section sweeps, lane markings, bridge piers.

Pure module (no bpy): SegDesc in -> MeshData out (SPEC.md "profile.py").
Ports the app's framed-roads System 1 cross-section (specs/framed-roads.md
§1-2, §4, §6-7) to Blender Z-up: X=east, Y=north, Z=up (the app's y /
elevation axis becomes our z).

Per side, from the centreline outward (framed classes):

    asphalt half | 0.05 reveal | curb top (+0.16) | tree-lawn (+0.04)
    | footpath (+0.16) | outer skirt down to elev-0.35

Frameless classes (motorway/trunk/service/paths) get asphalt + short side
skirts only; bridge segments swap the frame for a 0.7 m deck slab, fascia
walls and 1.05 m solid parapets.

Construction: every band edge is one `geom.offset_polyline` of the segment
centreline, so all bands share the station count and seams are exact.
"""
import math
from bisect import bisect_right

try:
    from . import geom
except ImportError:  # running `python3 profile.py` outside the package
    import geom

# --- spec constants (specs/framed-roads.md unless noted) ---------------------
CROWN_SLOPE = 0.02          # §6 centre lift = 0.02 * half * (1 - ln^2)
SUPERELEV_MAX = 0.06        # §6 max 6 % bank ...
SUPERELEV_FULL_CURV = 0.02  # §6 ... reached at curvature 0.02/m (~50 m radius)
TAPER_M = 6.0               # §6 crown/bank fade to 0 within 6 m of each end
REVEAL_W = 0.05             # §1 5 cm reveal between asphalt edge and curb face
CURB_H = 0.16               # §1 FRAME_CURB_H — curb top AND footpath top
VERGE_H = 0.04              # §1 FRAME_VERGE_H — tree-lawn trough
FOUNDATION = 0.35           # §1 SIDEWALK_FOUNDATION — skirts run to elev-0.35
Y_MARK = 0.055              # §1 stack — marking strips ride surface +0.055
DASH_LEN = 3.0              # §4 dash 3 m ...
DASH_STEP = 9.0             # §4 ... every 9 m (6 m gap)
DASH_FIRST = 2.0            # §4 first dash at 2 m along
DASH_W = 0.16               # §4 dashed / single-solid centre width
EDGE_LINE_W = 0.10          # §4 motorway/trunk edge line width
EDGE_LINE_INSET = 0.3       # edge lines at ±(half - 0.3)
DOUBLE_SOLID_OFF = 0.18     # §4 double-solid ribbons at lateral ±0.18 ...
DOUBLE_SOLID_W = 0.12       # ... each 0.12 wide
DECK_T = 0.7                # bridge deck slab underside 0.7 below the surface
PARAPET_H = 1.05            # solid parapet height
PARAPET_W = 0.35            # solid parapet width
PIER_SPACING = 24.0         # SPEC.md bridge_piers: every ~24 m ...
PIER_MIN_CLEAR = 3.5        # ... where deck - ground > 3.5 m
PIER_ALONG = 0.45           # column plan 0.45 (along) x width*0.5 (across)
PIER_EMBED = 1.0            # column from ground-1 up to deck-0.7

# §2 per-class presets: class -> (curbW, tree-lawn vergeW, footW)
_PRESETS = {
    "primary": (0.45, 1.0, 2.4),
    "secondary": (0.42, 1.2, 2.2),
    "tertiary": (0.40, 1.3, 2.0),
    "unclassified": (0.40, 1.3, 2.0),
    "residential": (0.40, 1.6, 1.8),
    "living_street": (0.40, 1.6, 1.8),
}
_PRESET_DEFAULT = (0.40, 1.3, 2.0)

# Frameless classes: shoulders/skirts only (bridges are handled separately)
_FRAMELESS = {"motorway", "trunk", "service", "footway", "path", "cycleway",
              "pedestrian", "steps", "track", "bridleway"}

_PAVER_SURFACES = {"cobble", "cobblestone", "paving_stones", "sett"}


# ============================================================================
# Per-segment context: shared station arrays every band/marking samples
# ============================================================================

def _curvatures(pts):
    """Signed curvature (1/m) per station; + = left turn. Endpoints get
    0.5x their neighbour (§6 'endpoints 0.5x neighbour')."""
    n = len(pts)
    ks = [0.0] * n
    for i in range(1, n - 1):
        ax, ay = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
        bx, by = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
        if la < 1e-9 or lb < 1e-9:
            continue
        dth = math.atan2(ax * by - ay * bx, ax * bx + ay * by)
        ks[i] = dth / (0.5 * (la + lb))
    if n >= 3:
        ks[0] = 0.5 * ks[1]
        ks[-1] = 0.5 * ks[-2]
    return ks


def _seg_ctx(seg):
    pts = list(seg.get("pts") or [])
    n = len(pts)
    elev = [float(z) for z in (seg.get("elev") or [])][:n]
    if len(elev) < n:  # defensive: contract says aligned, pad if not
        elev += [elev[-1] if elev else 0.0] * (n - len(elev))
    cum = geom.arc_lengths(pts)
    length = cum[-1] if cum else 0.0
    half = max(0.5, float(seg.get("width") or 7.0) / 2.0)
    # §6 crossFade: crown/bank ramp to 0 within TAPER_M of each segment end
    fade = [geom.smoothstep(min(c, length - c) / TAPER_M) for c in cum]
    # §6 bank = SUPERELEV_MAX at |curvature| >= 0.02, sign = -sign(curvature)
    bank = [-SUPERELEV_MAX * max(-1.0, min(1.0, k / SUPERELEV_FULL_CURV))
            for k in _curvatures(pts)]
    return {"pts": pts, "n": n, "elev": elev, "cum": cum, "length": length,
            "half": half, "fade": fade, "bank": bank,
            "crown": CROWN_SLOPE * half, "offs": {}}


def _off(ctx, d):
    """Cached offset polyline at signed lateral d (+ = left of travel)."""
    key = round(d, 6)
    poly = ctx["offs"].get(key)
    if poly is None:
        poly = list(ctx["pts"]) if abs(d) < 1e-9 else \
            geom.offset_polyline(ctx["pts"], d)
        ctx["offs"][key] = poly
    return poly


def _surf_z(ctx, i, ln):
    """Carriageway surface at station i, ln in [-1,+1] (0 = centre). §6:
    crown 0.02*half*(1-ln^2) + superelevation bank*half*ln, both faded at
    segment ends; crown is 0 at kerbs so the frame is centreline-relative."""
    return ctx["elev"][i] + ctx["fade"][i] * (
        ctx["crown"] * (1.0 - ln * ln) + ctx["bank"][i] * ctx["half"] * ln)


def _locate(ctx, s):
    """Arc position s -> (station index k, fraction t in segment k..k+1)."""
    cum = ctx["cum"]
    k = min(max(bisect_right(cum, s) - 1, 0), ctx["n"] - 2)
    span = cum[k + 1] - cum[k]
    t = 0.0 if span < 1e-9 else max(0.0, min(1.0, (s - cum[k]) / span))
    return k, t


# ============================================================================
# Mesh emitters (all winding rules assume tops CCW from +Z, walls outward)
# ============================================================================

def _top_strip(md, ctx, d_a, z_a, d_b, z_b, mat, up=True):
    """Ribbon between two band-edge laterals with per-station heights.
    UV: u = lateral metres from centreline, v = arc metres."""
    if d_b < d_a:
        d_a, d_b, z_a, z_b = d_b, d_a, z_b, z_a
    pa, pb = _off(ctx, d_a), _off(ctx, d_b)
    cum, n = ctx["cum"], ctx["n"]
    base = len(md["verts"])
    md["verts"].extend((pa[i][0], pa[i][1], z_a[i]) for i in range(n))
    md["verts"].extend((pb[i][0], pb[i][1], z_b[i]) for i in range(n))
    for i in range(n - 1):
        a0, a1, b0, b1 = base + i, base + i + 1, base + n + i, base + n + i + 1
        if up:  # lower lateral runs first along travel -> CCW from +Z
            md["faces"].append([a0, a1, b1, b0])
            uv = [(d_a, cum[i]), (d_a, cum[i + 1]),
                  (d_b, cum[i + 1]), (d_b, cum[i])]
        else:
            md["faces"].append([b0, b1, a1, a0])
            uv = [(d_b, cum[i]), (d_b, cum[i + 1]),
                  (d_a, cum[i + 1]), (d_a, cum[i])]
        md["mats"].append(mat)
        md["uvs"].append(uv)


def _wall(md, ctx, d, zb, zt, mat, face_dir):
    """Vertical wall along lateral d between per-station heights zb..zt.
    face_dir +1 -> normal toward increasing lateral (left-normal side).
    UV: u = metres along, v = height (z)."""
    p = _off(ctx, d)
    cum, n = ctx["cum"], ctx["n"]
    base = len(md["verts"])
    md["verts"].extend((p[i][0], p[i][1], zb[i]) for i in range(n))
    md["verts"].extend((p[i][0], p[i][1], zt[i]) for i in range(n))
    for i in range(n - 1):
        b0, b1, t0, t1 = base + i, base + i + 1, base + n + i, base + n + i + 1
        if face_dir > 0:
            md["faces"].append([b1, b0, t0, t1])
            uv = [(cum[i + 1], zb[i + 1]), (cum[i], zb[i]),
                  (cum[i], zt[i]), (cum[i + 1], zt[i + 1])]
        else:
            md["faces"].append([b0, b1, t1, t0])
            uv = [(cum[i], zb[i]), (cum[i + 1], zb[i + 1]),
                  (cum[i + 1], zt[i + 1]), (cum[i], zt[i])]
        md["mats"].append(mat)
        md["uvs"].append(uv)


def _end_cap(md, ctx, d_lo, zt_lo, d_hi, zt_hi, zb_lo, zb_hi, mat, end):
    """Close one band's cross-section at a segment end (junction trim / dead
    end) so solids never show hollow interiors. Faces -travel at the start,
    +travel at the end."""
    if abs(d_hi - d_lo) < 1e-9:
        return
    if d_hi < d_lo:
        d_lo, d_hi, zt_lo, zt_hi, zb_lo, zb_hi = \
            d_hi, d_lo, zt_hi, zt_lo, zb_hi, zb_lo
    i = ctx["n"] - 1 if end else 0
    lo, hi = _off(ctx, d_lo)[i], _off(ctx, d_hi)[i]
    ztl, zth, zbl, zbh = zt_lo[i], zt_hi[i], zb_lo[i], zb_hi[i]
    if abs(ztl - zbl) < 1e-9 and abs(zth - zbh) < 1e-9:
        return
    base = len(md["verts"])
    md["verts"].extend([(lo[0], lo[1], zbl), (hi[0], hi[1], zbh),
                        (hi[0], hi[1], zth), (lo[0], lo[1], ztl)])
    if end:
        md["faces"].append([base, base + 1, base + 2, base + 3])
        uv = [(d_lo, zbl), (d_hi, zbh), (d_hi, zth), (d_lo, ztl)]
    else:
        md["faces"].append([base + 1, base, base + 3, base + 2])
        uv = [(d_hi, zbh), (d_lo, zbl), (d_lo, ztl), (d_hi, zth)]
    md["mats"].append(mat)
    md["uvs"].append(uv)


# ============================================================================
# Cross-section assembly
# ============================================================================

def _frame_side(md, ctx, s, curb_w, verge_w, foot_w, caps):
    """One framed side (§1-2). s = +1 left of travel, -1 right. Every band
    is surface-relative to the centreline elevation (§7: crown is 0 at the
    kerb, superelevation is absorbed by the 5 cm reveal ramp)."""
    n, half, elev = ctx["n"], ctx["half"], ctx["elev"]
    z_edge = [_surf_z(ctx, i, 1.0 if s > 0 else -1.0) for i in range(n)]
    z_curb = [e + CURB_H for e in elev]
    z_lawn = [e + VERGE_H for e in elev]
    z_found = [e - FOUNDATION for e in elev]

    e0 = s * half
    e1 = s * (half + REVEAL_W)
    e2 = s * (half + REVEAL_W + curb_w)
    e3 = s * (half + REVEAL_W + curb_w + verge_w)
    e4 = s * (half + REVEAL_W + curb_w + verge_w + foot_w)

    # 5 cm reveal: gutter strip at road level, part of the curb piece (§1)
    _top_strip(md, ctx, e0, z_edge, e1, list(elev), "curb")
    caps.append((e0, z_edge, e1, list(elev)))
    # curb inner face: road surface up to +0.16, extended down to the -0.35
    # foundation so it never floats (§1 SIDEWALK_FOUNDATION, §3 inner face)
    _wall(md, ctx, e1, z_found, z_curb, "curb", -s)
    _top_strip(md, ctx, e1, z_curb, e2, z_curb, "curb")
    caps.append((e1, z_curb, e2, z_curb))
    outer_d, outer_top = e2, z_curb
    if verge_w > 1e-6:
        _wall(md, ctx, e2, z_lawn, z_curb, "curb", s)       # step down 0.16->0.04
        _top_strip(md, ctx, e2, z_lawn, e3, z_lawn, "grass")
        caps.append((e2, z_lawn, e3, z_lawn))
        outer_d, outer_top = e3, z_lawn
    if foot_w > 1e-6:
        if verge_w > 1e-6:
            _wall(md, ctx, e3, z_lawn, z_curb, "sidewalk", -s)  # step back up
        _top_strip(md, ctx, e3, z_curb, e4, z_curb, "sidewalk")
        caps.append((e3, z_curb, e4, z_curb))
        outer_d, outer_top = e4, z_curb
    # outer skirt: band top down to elev-0.35
    _wall(md, ctx, outer_d, z_found, outer_top, "concrete", s)


def _bridge_extras(md, ctx, caps):
    """Bridge deck extras: slab underside 0.7 down, fascia walls, and solid
    1.05 x 0.35 parapets flush with both deck edges."""
    n, half = ctx["n"], ctx["half"]
    z_bot = [e - DECK_T for e in ctx["elev"]]
    _top_strip(md, ctx, -half, z_bot, half, z_bot, "concrete", up=False)
    for s in (1.0, -1.0):
        ln = 1.0 if s > 0 else -1.0
        z_edge = [_surf_z(ctx, i, ln) for i in range(n)]
        # fascia: deck edge down to the slab underside
        _wall(md, ctx, s * half, z_bot, z_edge, "concrete", s)
        # parapet: outer wall shares the fascia seam at the deck edge; inner
        # wall follows the (crowned) deck surface at its own lateral
        d_in = s * (half - PARAPET_W)
        ln_in = d_in / half
        z_in = [_surf_z(ctx, i, ln_in) for i in range(n)]
        z_top = [z + PARAPET_H for z in z_edge]
        _wall(md, ctx, d_in, z_in, z_top, "concrete", -s)
        _wall(md, ctx, s * half, z_edge, z_top, "concrete", s)
        _top_strip(md, ctx, d_in, z_top, s * half, z_top, "concrete")
        for end in (0, 1):
            _end_cap(md, ctx, d_in, z_top, s * half, z_top,
                     z_in, z_edge, "concrete", end)


def sweep_road(seg, opts=None):
    """SegDesc -> MeshData ribbon: framed cross-section (framed-roads.md
    §1-2, §6-7) with crown/superelevation, frameless skirts, or a bridge
    deck. opts: {"framed": bool (default True; False forces frameless),
    "end_caps": bool (default True; caps at junction trims/dead ends)}."""
    o = {"framed": True, "end_caps": True}
    if opts:
        o.update(opts)
    md = geom.new_meshdata()
    md["uvs"] = []
    pts = seg.get("pts") or []
    if seg.get("internal") or len(pts) < 2:
        return md  # internal segs emit no ribbon (junction pad covers them)
    ctx = _seg_ctx(seg)
    if ctx["length"] < 0.5:
        return md
    n, half, elev = ctx["n"], ctx["half"], ctx["elev"]
    cls = seg.get("cls") or "residential"
    bridge = bool(seg.get("bridge"))
    paver = (seg.get("surface") or "") in _PAVER_SURFACES
    road_mat = "paver" if paver else "asphalt"

    z_found = [e - FOUNDATION for e in elev]
    cap_bot = [e - DECK_T for e in elev] if bridge else z_found
    caps = []  # (d_lo, ztop_lo, d_hi, ztop_hi) bands, capped at both ends

    # carriageway: 5 lateral samples per station (edges+quarters+centre, §6)
    lats = [-half, -half / 2.0, 0.0, half / 2.0, half]
    ztab = [[_surf_z(ctx, i, d / half) for i in range(n)] for d in lats]
    for j in range(4):
        _top_strip(md, ctx, lats[j], ztab[j], lats[j + 1], ztab[j + 1], road_mat)
        caps.append((lats[j], ztab[j], lats[j + 1], ztab[j + 1]))

    if bridge:
        _bridge_extras(md, ctx, caps)
    elif cls in _FRAMELESS or not o["framed"]:
        for s in (1.0, -1.0):  # short side skirts down to elev-0.35
            edge = ztab[4] if s > 0 else ztab[0]
            _wall(md, ctx, s * half, z_found, edge, "concrete", s)
    else:
        curb_w, verge_w, foot_w = _PRESETS.get(cls, _PRESET_DEFAULT)
        if paver:
            verge_w, foot_w = 0.0, 1.5  # §2 cobble: no lawn, 1.5 m footpath
        for s in (1.0, -1.0):
            _frame_side(md, ctx, s, curb_w, verge_w, foot_w, caps)

    if o["end_caps"]:
        for d_lo, zt_lo, d_hi, zt_hi in caps:
            for end in (0, 1):
                _end_cap(md, ctx, d_lo, zt_lo, d_hi, zt_hi,
                         cap_bot, cap_bot, "concrete", end)
    return md


# ============================================================================
# Lane markings (§4) — flat quads riding surface + 0.055, following the
# centreline (dashes subdivided at stations)
# ============================================================================

def _mark_strip(md, ctx, d, w, s0, s1, mat):
    """One painted ribbon at lateral d, width w, arc range [s0, s1]."""
    s0, s1 = max(0.0, s0), min(s1, ctx["length"])
    if s1 - s0 < 0.05:
        return
    cum, half = ctx["cum"], ctx["half"]
    edges = [(d - w / 2.0, _off(ctx, d - w / 2.0)),
             (d + w / 2.0, _off(ctx, d + w / 2.0))]
    params = [s0] + [c for c in cum if s0 + 1e-6 < c < s1 - 1e-6] + [s1]
    base = len(md["verts"])
    for s in params:
        k, t = _locate(ctx, s)
        e = geom.lerp(ctx["elev"][k], ctx["elev"][k + 1], t)
        f = geom.lerp(ctx["fade"][k], ctx["fade"][k + 1], t)
        b = geom.lerp(ctx["bank"][k], ctx["bank"][k + 1], t)
        for dd, poly in edges:
            x = geom.lerp(poly[k][0], poly[k + 1][0], t)
            y = geom.lerp(poly[k][1], poly[k + 1][1], t)
            ln = max(-1.0, min(1.0, dd / half))
            z = e + f * (ctx["crown"] * (1.0 - ln * ln)
                         + b * half * ln) + Y_MARK
            md["verts"].append((x, y, z))
    d_lo, d_hi = edges[0][0], edges[1][0]
    for i in range(len(params) - 1):
        lo0 = base + 2 * i
        md["faces"].append([lo0, lo0 + 2, lo0 + 3, lo0 + 1])  # CCW from +Z
        md["mats"].append(mat)
        md["uvs"].append([(d_lo, params[i]), (d_lo, params[i + 1]),
                          (d_hi, params[i + 1]), (d_hi, params[i])])


def _mark_dashes(md, ctx, d, w, mat):
    """§4 dashed line: 3 m dash / 9 m step, first dash at 2 m along."""
    s = DASH_FIRST
    while s < ctx["length"] - 0.3:
        _mark_strip(md, ctx, d, w, s, s + DASH_LEN, mat)
        s += DASH_STEP


def markings(seg):
    """SegDesc -> MeshData of painted strips (framed-roads.md §4). Class
    rules: motorway/trunk edge lines; primary double-solid yellow (US-style
    arterial); secondary solid white; tertiary/residential/unclassified
    dashed white; oneway >= 2 lanes gets dashed lane separators instead of
    a centre line. Cobble/paver streets get no markings (§2)."""
    md = geom.new_meshdata()
    md["uvs"] = []
    pts = seg.get("pts") or []
    if seg.get("internal") or len(pts) < 2:
        return md
    if (seg.get("surface") or "") in _PAVER_SURFACES:
        return md
    ctx = _seg_ctx(seg)
    if ctx["length"] < DASH_FIRST + 1.0:
        return md
    cls = seg.get("cls") or "residential"
    half = ctx["half"]
    width = half * 2.0
    lanes = max(1, int(seg.get("lanes") or 1))
    oneway = bool(seg.get("oneway"))

    if cls in ("motorway", "trunk"):
        for s in (1.0, -1.0):
            _mark_strip(md, ctx, s * (half - EDGE_LINE_INSET), EDGE_LINE_W,
                        0.0, ctx["length"], "marking_white")
    if oneway and lanes >= 2:
        # §4 lane separators at -half + k*width/lanes, k = 1..min(lanes,4)-1
        for k in range(1, min(lanes, 4)):
            _mark_dashes(md, ctx, k * width / lanes - half, DASH_W,
                         "marking_white")
    elif not oneway:
        if cls == "primary":
            for d in (DOUBLE_SOLID_OFF, -DOUBLE_SOLID_OFF):
                _mark_strip(md, ctx, d, DOUBLE_SOLID_W, 0.0, ctx["length"],
                            "marking_yellow")
        elif cls == "secondary":
            _mark_strip(md, ctx, 0.0, DASH_W, 0.0, ctx["length"],
                        "marking_white")
        elif cls in ("tertiary", "residential", "unclassified"):
            _mark_dashes(md, ctx, 0.0, DASH_W, "marking_white")
    return md


# ============================================================================
# Bridge piers (SPEC.md)
# ============================================================================

def bridge_piers(seg, ground_z):
    """Rectangular concrete columns (plan 0.45 x width*0.5) under a bridge
    SegDesc, spaced ~24 m, only where deck - ground > 3.5 m; each runs from
    ground-1 up to deck-0.7 (the slab underside). ground_z: (x, y) -> z."""
    md = geom.new_meshdata()
    pts = seg.get("pts") or []
    if not seg.get("bridge") or seg.get("internal") or len(pts) < 2:
        return md
    ctx = _seg_ctx(seg)
    length = ctx["length"]
    if length < 1.0:
        return md
    width = ctx["half"] * 2.0
    n_spans = max(1, int(round(length / PIER_SPACING)))
    for k in range(1, n_spans):
        s = length * k / n_spans
        i, t = _locate(ctx, s)
        px = geom.lerp(pts[i][0], pts[i + 1][0], t)
        py = geom.lerp(pts[i][1], pts[i + 1][1], t)
        deck = geom.lerp(ctx["elev"][i], ctx["elev"][i + 1], t)
        g = float(ground_z(px, py))
        if deck - g <= PIER_MIN_CLEAR:
            continue
        top, bot = deck - DECK_T, g - PIER_EMBED
        if top - bot < 0.2:
            continue
        dx, dy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        dl = math.hypot(dx, dy) or 1.0
        tx, ty = dx / dl, dy / dl
        nx, ny = -ty, tx
        ha = PIER_ALONG / 2.0        # half extent along travel
        hc = width * 0.5 / 2.0       # half extent across (column is width*0.5)
        ring = [(px + tx * ha + nx * hc, py + ty * ha + ny * hc),
                (px - tx * ha + nx * hc, py - ty * ha + ny * hc),
                (px - tx * ha - nx * hc, py - ty * ha - ny * hc),
                (px + tx * ha - nx * hc, py + ty * ha - ny * hc)]
        geom.add_prism(md, ring, bot, top, "concrete", mat_top="concrete")
    return md


# ============================================================================
# Self-tests — python3 profile.py (no bpy)
# ============================================================================
if __name__ == "__main__":
    def mk(pts, elev=None, cls="residential", width=8.0, lanes=2,
           oneway=False, bridge=False, surface=None, internal=False):
        return {"road_idx": 0, "cls": cls, "width": width, "lanes": lanes,
                "oneway": oneway, "bridge": bridge,
                "layer": 1 if bridge else 0, "name": None, "surface": surface,
                "pts": pts,
                "elev": list(elev) if elev is not None else [0.0] * len(pts),
                "j_start": None, "j_end": None, "internal": internal}

    def check(md, label):
        assert len(md["mats"]) == len(md["faces"]), f"{label}: mats!=faces"
        if md["uvs"] is not None:
            assert len(md["uvs"]) == len(md["faces"]), f"{label}: uvs!=faces"
            for f, uv in zip(md["faces"], md["uvs"]):
                assert uv is None or len(uv) == len(f), f"{label}: uv corners"
        nv = len(md["verts"])
        for v in md["verts"]:
            assert all(math.isfinite(c) for c in v), f"{label}: NaN/inf vert"
        for f in md["faces"]:
            assert all(0 <= i < nv for i in f), f"{label}: index range"

    def face_area(verts, f):
        ax, ay, az = verts[f[0]]
        s = 0.0
        for i in range(1, len(f) - 1):
            bx, by, bz = verts[f[i]]
            cx, cy, cz = verts[f[i + 1]]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            crx, cry, crz = (uy * vz - uz * vy, uz * vx - ux * vz,
                             ux * vy - uy * vx)
            s += 0.5 * math.sqrt(crx * crx + cry * cry + crz * crz)
        return s

    def runs(md):
        """Count contiguous painted runs (dashes/solids) per lateral group."""
        groups = {}
        for uv in md["uvs"]:
            us = [c[0] for c in uv]
            vs = [c[1] for c in uv]
            key = round(sum(us) / len(us), 3)
            groups.setdefault(key, []).append((min(vs), max(vs)))
        total = 0
        for spans in groups.values():
            spans.sort()
            end = -1e18
            for lo, hi in spans:
                if lo > end + 1e-4:
                    total += 1
                end = max(end, hi)
        return total

    # --- 1. straight 100 m residential, flat ------------------------------
    pts = [(float(x), 0.0) for x in range(0, 101, 4)]
    seg = mk(pts)  # width 8 -> half 4
    md = sweep_road(seg)
    check(md, "residential sweep")
    assert len(md["verts"]) > 0 and len(md["faces"]) > 0
    zset = {round(v[2], 6) for v in md["verts"]}
    for want in (0.0, 0.04, 0.16):
        assert want in zset, f"band level {want} missing: {sorted(zset)[:8]}"
    assert round(-FOUNDATION, 6) in zset, "skirt bottom missing"
    # crown: centre stations at mid-length lifted by exactly 0.02*half
    centre = [v for v in md["verts"]
              if abs(v[1]) < 1e-9 and abs(v[0] - 48.0) < 1e-6]
    assert centre and all(abs(v[2] - 0.02 * 4.0) < 1e-9 for v in centre), \
        "crown != 0.02*half at centre"
    # crown is 0 at kerbs (mid-span edge verts stay at base elevation)
    kerb = [v for v in md["verts"]
            if abs(abs(v[1]) - 4.0) < 1e-9 and 10.0 < v[0] < 90.0]
    assert kerb and all(abs(v[2]) < 1e-9 for v in kerb), \
        "kerb seam moved by crown"
    # UV v monotonic along the first carriageway strip
    n_st = len(pts)
    vlo = [min(c[1] for c in uv) for uv in md["uvs"][:n_st - 1]]
    assert all(vlo[i + 1] > vlo[i] for i in range(len(vlo) - 1)), \
        "UV v not monotonic"
    have = set(md["mats"])
    assert {"asphalt", "curb", "grass", "sidewalk", "concrete"} <= have, have
    print(f"residential: {len(md['verts'])} verts {len(md['faces'])} faces "
          f"mats={sorted(have)}")

    # --- 2. dashed centre marking count -----------------------------------
    mm = markings(seg)
    check(mm, "residential markings")
    want_dashes = math.floor((100.0 - DASH_FIRST) / DASH_STEP) + 1
    assert runs(mm) == want_dashes == 11, (runs(mm), want_dashes)
    assert set(mm["mats"]) == {"marking_white"}
    mz = [v[2] for v in mm["verts"]]
    assert min(mz) >= Y_MARK - 1e-9 and max(mz) <= Y_MARK + 0.08 + 1e-9
    print(f"residential markings: {runs(mm)} dashes (expected {want_dashes})")

    # --- 3. class rules ----------------------------------------------------
    pseg = mk(pts, cls="primary", width=10.0)
    pm = markings(pseg)
    check(pm, "primary markings")
    assert set(pm["mats"]) == {"marking_yellow"} and runs(pm) == 2
    sseg = mk(pts, cls="secondary", width=9.0)
    sm = markings(sseg)
    check(sm, "secondary markings")
    assert set(sm["mats"]) == {"marking_white"} and runs(sm) == 1
    mseg = mk(pts, cls="motorway", width=12.0, lanes=3, oneway=True)
    mmk = markings(mseg)
    check(mmk, "motorway markings")
    # 2 edge lines + 2 dashed separators (k=1,2) x 11 dashes
    assert runs(mmk) == 2 + 2 * 11, runs(mmk)
    msw = sweep_road(mseg)
    check(msw, "motorway sweep")
    assert set(msw["mats"]) <= {"asphalt", "concrete"}, set(msw["mats"])
    svc = sweep_road(mk(pts, cls="service", width=5.0))
    check(svc, "service sweep")
    assert set(svc["mats"]) <= {"asphalt", "concrete"}
    cob = mk(pts, surface="cobble")
    csw = sweep_road(cob)
    check(csw, "cobble sweep")
    assert "paver" in csw["mats"] and "grass" not in csw["mats"]
    assert "sidewalk" in csw["mats"]  # §2 cobble keeps a 1.5 m footpath
    assert not markings(cob)["faces"], "cobble must have no markings"
    print(f"class rules ok (motorway runs={runs(mmk)}, "
          f"cobble mats={sorted(set(csw['mats']))})")

    # --- 4. curved quarter circle: no NaN, no degenerate faces ------------
    cpts = [(40.0 * math.cos(math.radians(a)), 40.0 * math.sin(math.radians(a)))
            for a in range(0, 91, 3)]
    cseg = mk(cpts, cls="secondary", width=7.0)
    cmd = sweep_road(cseg)
    check(cmd, "curved sweep")
    tiny = sum(1 for f in cmd["faces"] if face_area(cmd["verts"], f) < 1e-4)
    assert tiny / len(cmd["faces"]) <= 0.01, \
        f"{tiny}/{len(cmd['faces'])} near-zero faces"
    cm = markings(cseg)
    check(cm, "curved markings")
    assert cm["faces"]
    # superelevation banked the mid-span cross-section (curvature 1/40 > 0.02)
    mid_edge_z = [v[2] for v in cmd["verts"]
                  if abs(math.hypot(v[0], v[1]) - 43.5) < 0.6
                  and abs(math.atan2(v[1], v[0]) - math.radians(45)) < 0.02]
    assert mid_edge_z and max(mid_edge_z) > 0.05, "no superelevation on curve"
    print(f"curved: {len(cmd['faces'])} faces, degenerate={tiny}, "
          f"outer-edge bank max z={max(mid_edge_z):.3f}")

    # --- 5. bridge: parapets, slab, piers ----------------------------------
    bpts = [(float(x), 0.0) for x in range(0, 61, 5)]
    bseg = mk(bpts, elev=[8.0] * 13, cls="secondary", width=8.0, bridge=True)
    bmd = sweep_road(bseg)
    check(bmd, "bridge sweep")
    bz = [v[2] for v in bmd["verts"]]
    assert abs(max(bz) - (8.0 + PARAPET_H)) < 1e-9, \
        f"parapet top {max(bz)} != deck+1.05"
    assert abs(min(bz) - (8.0 - DECK_T)) < 1e-9, "slab underside missing"
    assert set(bmd["mats"]) <= {"asphalt", "concrete"}
    piers = bridge_piers(bseg, lambda x, y: 0.0)
    check(piers, "piers")
    assert piers["faces"], "expected 1 pier on a 60 m span"
    pz = [v[2] for v in piers["verts"]]
    assert abs(min(pz) - (-PIER_EMBED)) < 1e-9      # ground(0) - 1
    assert abs(max(pz) - (8.0 - DECK_T)) < 1e-9    # deck - 0.7
    assert set(piers["mats"]) == {"concrete"}
    none = bridge_piers(bseg, lambda x, y: 6.0)     # clearance 2 m < 3.5 m
    assert not none["faces"], "piers must skip low clearance"
    assert not bridge_piers(mk(pts), lambda x, y: 0.0)["faces"], \
        "piers only for bridge segs"
    print(f"bridge: max z={max(bz):.2f} (deck+{PARAPET_H}), "
          f"pier faces={len(piers['faces'])}")

    # --- 6. internal / degenerate segs emit nothing ------------------------
    iseg = mk(pts, internal=True)
    assert not sweep_road(iseg)["faces"] and not markings(iseg)["faces"]
    assert not sweep_road(mk([(0.0, 0.0)]))["faces"]

    # --- 7. framed:false opt forces frameless ------------------------------
    ff = sweep_road(seg, {"framed": False})
    check(ff, "framed:false")
    assert set(ff["mats"]) <= {"asphalt", "concrete"}

    print("ALL PROFILE TESTS PASSED")
