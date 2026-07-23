"""Parallel-way merge pre-pass (osm2streets-inspired, PLAN.md §3.2 step 1).

OSM maps one physical street as several ways: dual carriageways are two
opposite oneways, protected cycle tracks and sidewalks are separate parallel
ways. Swept independently they overlap or leave slivers (the Cable Street
bug). This pure module rewrites graph["roads"] BEFORE the elevation solve:

- **Sidepath absorption**: a cycleway/footway running parallel to a drivable
  road is removed; cycleways annotate the host with
  `sidepaths: [{"side": +1|-1, "kind", "width"}]` (profile.py renders a cycle
  band inside the frame), footways just vanish (the framed sidewalk already
  provides the walk).
- **Dual-carriageway clamp**: paired opposite oneways get their widths clamped
  so the inner edges stop short of the shared median, and `median_side` marks
  the inner side (profile.py renders curb-only there, no sidewalk into the
  median).

Detection (PLAN §5.2): sampled every SAMPLE_STEP m; a pair matches when
bearing aligns within BEARING_TOL, the gap is inside the class-dependent
bound, and coverage ≥ COVERAGE.
"""
import math

try:
    from . import geom
except ImportError:
    import geom

SAMPLE_STEP = 10.0     # m between probe stations along the candidate way
COVERAGE = 0.6         # fraction of stations that must match the same host
BEARING_TOL_DEG = 20.0 # |angle between ways| tolerance
SIDE_CONSIST = 0.8     # fraction of matching stations on the majority side
SIDEPATH_EXTRA = 6.0   # max verge gap between host edge and sidepath edge (m)
DUAL_GAP_FACTOR = 0.8  # dual match when centreline gap < (wA+wB) * this
MEDIAN_CLEAR = 0.3     # each clamped edge stops this short of the median (m)
MIN_CARRIAGEWAY = 4.5  # never clamp a carriageway narrower than this (m)

_PATH_CLASSES = {"cycleway", "footway"}
_COS_TOL = math.cos(math.radians(BEARING_TOL_DEG))


def _stations(pts, step=SAMPLE_STEP):
    """(point, unit direction) samples along a polyline, ~step m apart."""
    cum = geom.arc_lengths(pts)
    total = cum[-1]
    if total < 1e-6:
        return []
    n = max(2, int(total / step) + 1)
    out = []
    j = 1
    for k in range(n):
        s = total * k / (n - 1)
        while j < len(cum) - 1 and cum[j] < s:
            j += 1
        span = cum[j] - cum[j - 1]
        t = 0.0 if span <= 0 else (s - cum[j - 1]) / span
        x = pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t
        y = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t
        dx, dy = pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]
        ln = math.hypot(dx, dy) or 1.0
        out.append(((x, y), (dx / ln, dy / ln)))
    return out


def _build_index(roads, idxs):
    grid = geom.SpatialGrid(cell=32.0)
    for ri in idxs:
        pts = roads[ri].get("pts") or []
        for i in range(len(pts) - 1):
            grid.insert_segment(pts[i], pts[i + 1],
                                (ri, pts[i], pts[i + 1]), pad=30.0)
    return grid


def _nearest_on(grid, p, exclude_ri):
    """Nearest indexed segment to p: (road_idx, dist, seg direction, side).

    side = +1 when p lies LEFT of the segment's travel direction.
    """
    best = None
    for (ri, a, b) in grid.query(p[0], p[1], pad=30.0):
        if ri == exclude_ri:
            continue
        dist, _close, _t = geom.seg_point_dist(p, a, b)
        if best is None or dist < best[1]:
            dx, dy = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(dx, dy) or 1.0
            d = (dx / ln, dy / ln)
            cross = d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])
            best = (ri, dist, d, 1 if cross >= 0 else -1)
    return best


def _match(roads, src_ri, grid, gap_fn, anti_parallel=False):
    """Probe src road against the index. Returns (host_ri, side, mean_gap)
    when one host matches with enough coverage and side consistency."""
    src = roads[src_ri]
    stations = _stations(src["pts"])
    if len(stations) < 3:
        return None
    votes = {}
    for p, d in stations:
        hit = _nearest_on(grid, p, src_ri)
        if hit is None:
            continue
        ri, dist, hd, side = hit
        dot = d[0] * hd[0] + d[1] * hd[1]
        aligned = (-dot if anti_parallel else abs(dot)) > _COS_TOL
        if not aligned or dist > gap_fn(src, roads[ri]):
            continue
        rec = votes.setdefault(ri, {"n": 0, "gap": 0.0, "sides": 0})
        rec["n"] += 1
        rec["gap"] += dist
        rec["sides"] += side
    if not votes:
        return None
    host_ri, rec = max(votes.items(), key=lambda kv: kv[1]["n"])
    if rec["n"] / len(stations) < COVERAGE:
        return None
    if abs(rec["sides"]) / rec["n"] < SIDE_CONSIST * 2 - 1:
        return None
    # side of the HOST that the src runs along: src left-of-host => host's left
    host_side = 1 if rec["sides"] >= 0 else -1
    return host_ri, host_side, rec["gap"] / rec["n"]


def preprocess(roads):
    """roads -> (roads2, info). roads2 preserves dict shape; absorbed sidepaths
    removed, hosts annotated with `sidepaths`, dual halves annotated with
    `median_side` + clamped `width`. Deterministic, id-order stable."""
    drivable = [i for i, r in enumerate(roads)
                if r["class"] not in _PATH_CLASSES and r["class"] != "pedestrian"
                and not r.get("tunnel") and len(r.get("pts") or []) >= 2]
    grid = _build_index(roads, drivable)
    info = {"absorbed": {}, "duals": []}

    # ---- pass 1: dual carriageways (opposite oneways, same class or name) ----
    seen_pairs = set()
    for ai in drivable:
        a = roads[ai]
        if not a.get("oneway") or a.get("bridge"):
            continue
        m = _match(roads, ai, grid,
                   lambda s, h: (s["width"] + h["width"]) * DUAL_GAP_FACTOR,
                   anti_parallel=True)
        if not m:
            continue
        bi, side, gap = m
        b = roads[bi]
        if not b.get("oneway") or b.get("bridge"):
            continue
        if not (a["class"] == b["class"]
                or (a.get("name") and a.get("name") == b.get("name"))):
            continue
        pair = (min(ai, bi), max(ai, bi))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        # clamp both halves so inner edges stop MEDIAN_CLEAR short of the median
        for ri, s in ((ai, side), (bi, -side if side else -1)):
            r = roads[ri]
            new_w = max(MIN_CARRIAGEWAY, min(r["width"], gap - 2 * MEDIAN_CLEAR))
            r["width"] = new_w
            r["median_side"] = s
        # the OTHER half's side: recompute properly from its own perspective
        mb = _match(roads, bi, grid,
                    lambda s, h: (s["width"] + h["width"]) * DUAL_GAP_FACTOR,
                    anti_parallel=True)
        if mb and mb[0] == ai:
            roads[bi]["median_side"] = mb[1]
        info["duals"].append({"a": a["id"], "b": b["id"],
                              "gap": round(gap, 2), "width": roads[ai]["width"]})

    # ---- pass 2: sidepath absorption (after clamping, edges are honest) ----
    removed = set()
    for pi, p in enumerate(roads):
        if p["class"] not in _PATH_CLASSES or p.get("bridge") or p.get("tunnel"):
            continue
        m = _match(roads, pi, grid,
                   lambda s, h: h["width"] / 2 + s["width"] / 2 + SIDEPATH_EXTRA)
        if not m:
            continue
        host_ri, side, gap = m
        host = roads[host_ri]
        # don't absorb into the median side of a dual (track runs outside)
        if host.get("median_side") == side:
            continue
        removed.add(pi)
        info["absorbed"][p["id"]] = host["id"]
        if p["class"] == "cycleway":
            host.setdefault("sidepaths", []).append(
                {"side": side, "kind": "cycleway",
                 "width": max(1.5, min(3.5, p["width"]))})

    roads2 = [r for i, r in enumerate(roads) if i not in removed]
    info["removed"] = len(removed)
    return roads2, info


# ---- self-tests -----------------------------------------------------------------

if __name__ == "__main__":
    def road(id, pts, cls="secondary", width=9.0, oneway=False, name=None):
        return {"id": id, "class": cls, "width": width, "lanes": 2,
                "oneway": oneway, "roundabout": False, "pts": pts,
                "node_ids": [], "bridge": False, "tunnel": False, "layer": 0,
                "name": name, "surface": None, "structure": None,
                "wikidata": None, "maxspeed": None, "elev": None}

    # 1. cycleway parallel on the left (+y) of a secondary → absorbed w/ band
    roads = [
        road(1, [(0, 0), (200, 0)]),
        road(2, [(0, 7), (200, 7)], cls="cycleway", width=3.0),
    ]
    r2, info = preprocess(roads)
    assert len(r2) == 1 and info["absorbed"] == {2: 1}, info
    sp = r2[0].get("sidepaths")
    assert sp and sp[0]["side"] == 1 and sp[0]["kind"] == "cycleway", sp
    print("test 1 OK (cycleway absorbed, left side)")

    # 2. footway absorbed silently (no band); far footway kept
    roads = [
        road(1, [(0, 0), (200, 0)]),
        road(2, [(200, -6), (0, -6)], cls="footway", width=2.0),
        road(3, [(0, 40), (200, 40)], cls="footway", width=2.0),
    ]
    r2, info = preprocess(roads)
    ids = {r["id"] for r in r2}
    assert ids == {1, 3} and not r2[0].get("sidepaths"), (ids, r2[0])
    print("test 2 OK (footway absorbed, distant one kept)")

    # 3. dual carriageway: opposite oneways 8 m apart, widths 9 → clamped
    roads = [
        road(1, [(0, 0), (300, 0)], oneway=True, name="Cable Street"),
        road(2, [(300, 8), (0, 8)], oneway=True, name="Cable Street"),
    ]
    r2, info = preprocess(roads)
    assert len(info["duals"]) == 1, info
    wa, wb = r2[0]["width"], r2[1]["width"]
    assert abs(wa - 7.4) < 0.05 and abs(wb - 7.4) < 0.05, (wa, wb)
    # inner edges: a top edge at w/2=3.7 < 8-3.7=4.3 → no overlap, 0.6 m median
    assert r2[0]["median_side"] == 1 and r2[1]["median_side"] == 1, \
        (r2[0]["median_side"], r2[1]["median_side"])
    print(f"test 3 OK (dual clamped to {wa:.2f} m, median sides set)")

    # 4. perpendicular road untouched; diverging diagonal kept; a SHORT track
    #    fully alongside the host is legitimately absorbed (coverage is
    #    measured along the candidate path)
    roads = [
        road(1, [(0, 0), (200, 0)]),
        road(2, [(100, -100), (100, 100)]),                    # crosses at 90°
        road(3, [(0, 6), (150, 80)], cls="cycleway", width=2),  # bearing ~26°
        road(4, [(50, 6), (90, 6)], cls="cycleway", width=2),   # short, parallel
    ]
    r2, info = preprocess(roads)
    ids = {r["id"] for r in r2}
    assert ids == {1, 2, 3} and info["absorbed"] == {4: 1} and not info["duals"], \
        (ids, info)
    print("test 4 OK (perpendicular/diagonal untouched, short parallel absorbed)")

    # 5. deterministic
    roads_a = [road(1, [(0, 0), (200, 0)]),
               road(2, [(0, 7), (200, 7)], cls="cycleway", width=3.0)]
    roads_b = [road(1, [(0, 0), (200, 0)]),
               road(2, [(0, 7), (200, 7)], cls="cycleway", width=3.0)]
    assert preprocess(roads_a)[0] == preprocess(roads_b)[0]
    print("test 5 OK (deterministic)")
    print("ALL roadmerge self-tests passed")