"""roadnet.py — road-network topology for the CityBuilder OSM Blender add-on.

Pure module (no bpy): consumes ``graph["roads"]`` plus an elevation ``Solve``
(elevation.py contract) and emits the SegDesc / JunctionDesc lists that every
downstream mesh generator builds against (SPEC.md "roadnet.py" section; trim /
radius numbers from specs/framed-roads.md §5).

Coordinates: metres, X = east, Y = north, Z = up. Deterministic: no random,
no time — canonical keys are visited in sorted order, roads in index order.
"""
import math

try:
    from . import geom
except ImportError:  # direct `python3 roadnet.py` execution
    import geom

# ---- SPEC.md / specs/framed-roads.md §5 constants --------------------------
DISC_RADIUS_FACTOR = 0.58   # JunctionDesc radius = 0.58 * max incident width
TRIM_RADIUS_FACTOR = 0.72   # ribbons trim back to radius * 0.72 ("Lego rule")
ARM_WIDTH_FACTOR = 0.55     # ...but never closer than 0.55 * the arm's width
CLUSTER_TRIM_PAD = 0.4      # extra margin past a cluster member node (m)
PASS_THROUGH_DOT = -0.866   # cos 150°: away-dirs this anti-parallel = through-road
PASS_THROUGH_RATIO = 1.35   # max width ratio for a pass-through joint
DENSIFY_STEP = 8.0          # max station spacing after trim (2-pt OSM bridges rely on it)
MIN_REMAIN = 1.0            # remaining length under this after trims → internal
CROSSWALK_MIN_W = 5.0       # arm crosswalk: cls != motorway and width >= 5
LANE_W = 3.4                # nominal lane width (framed-roads §1), lanes fallback


def node_key(p):
    """Half-metre-snap node key — the SPEC-global key everyone shares."""
    return f"{round(p[0] * 2)},{round(p[1] * 2)}"


def _end_dir(pts, end):
    """Unit vector at endpoint `end` (0|1) pointing away from it, into the line."""
    seq = pts if end == 0 else pts[::-1]
    ox, oy = seq[0]
    for q in seq[1:]:  # skip coincident points until a real direction appears
        dx, dy = q[0] - ox, q[1] - oy
        ln = math.hypot(dx, dy)
        if ln > 1e-9:
            return (dx / ln, dy / ln)
    return (1.0, 0.0)  # degenerate polyline — any unit vector


def _point_at(pts, cum, d):
    """Interpolated point at arc distance d along the polyline."""
    d = max(0.0, min(cum[-1], d))
    for i in range(1, len(cum)):
        if cum[i] >= d:
            span = cum[i] - cum[i - 1]
            t = 0.0 if span <= 1e-12 else (d - cum[i - 1]) / span
            ax, ay = pts[i - 1]
            bx, by = pts[i]
            return (ax + (bx - ax) * t, ay + (by - ay) * t)
    return pts[-1]


def _trim_polyline(pts, t0, t1):
    """Arc-length trim: cut t0 off the start and t1 off the end, interpolating
    the cut points (never just dropping vertices). Caller guarantees enough
    length remains (MIN_REMAIN check happens before this)."""
    cum = geom.arc_lengths(pts)
    d0, d1 = t0, cum[-1] - t1
    out = [_point_at(pts, cum, d0)]
    for i in range(len(pts)):  # keep originals strictly between the cuts
        if d0 + 1e-6 < cum[i] < d1 - 1e-6:
            out.append(pts[i])
    out.append(_point_at(pts, cum, d1))
    return out


def build_network(roads, solve):
    """roads (graph["roads"]) + elevation Solve → {"segments": [SegDesc],
    "junctions": [JunctionDesc]} per SPEC.md. segments[i] corresponds to
    roads[i] (seg_idx == road_idx), internal ones flagged, never dropped."""
    # ---- 1. node → incident map from segment ENDPOINTS ONLY ----------------
    incidents = {}   # canonical key -> [endpoint record]
    pts_of = []      # cached float-tuple polylines per road
    for road_idx, road in enumerate(roads):
        pts = [(float(p[0]), float(p[1])) for p in (road.get("pts") or [])]
        pts_of.append(pts)
        if len(pts) < 2:
            continue  # degenerate — cannot form an arm
        w = float(road.get("width") or 7.0)
        for end in (0, 1):
            p = pts[0] if end == 0 else pts[-1]
            incidents.setdefault(solve.key_of(p), []).append({
                "road_idx": road_idx, "end": end, "pos": p,
                "raw": node_key(p), "width": w,
                "cls": road.get("class") or "residential",
                "dir": _end_dir(pts, end),   # away from the node (pre-trim)
            })

    # canonical keys that are consolidation clusters (derived from solve.alias)
    clusters = {canon for raw, canon in (solve.alias or {}).items() if raw != canon}

    # ---- 2. junction detection + per-arm trim distances ---------------------
    junctions = []
    trims = {}  # (road_idx, end) -> (junction index, trim metres)
    for canon in sorted(incidents):
        recs = incidents[canon]
        degree = len(recs)
        is_cluster = canon in clusters
        if not is_cluster:
            if degree < 2:
                continue  # dead end: no junction, no trim
            if degree == 2:
                # pass-through joint: nearly anti-parallel away-dirs and
                # similar widths → the road just continues, no junction.
                a, b = recs
                dot = a["dir"][0] * b["dir"][0] + a["dir"][1] * b["dir"][1]
                wa, wb = a["width"], b["width"]
                ratio = max(wa, wb) / max(1e-6, min(wa, wb))
                if dot <= PASS_THROUGH_DOT and ratio <= PASS_THROUGH_RATIO:
                    continue
        # junction center = mean of member node positions; members are
        # reconstructed from endpoints sharing the canonical key, deduped by
        # raw half-metre key so a busy node doesn't outweigh a quiet one.
        by_raw = {}
        for r in recs:
            by_raw.setdefault(r["raw"], []).append(r["pos"])
        members = [(sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps))
                   for ps in by_raw.values()]
        cx = sum(m[0] for m in members) / len(members)
        cy = sum(m[1] for m in members) / len(members)
        radius = DISC_RADIUS_FACTOR * max(r["width"] for r in recs)
        jz = solve.node_z.get(canon)
        if jz is None:
            jz = solve.z_at(recs[0]["pos"])
        j_index = len(junctions)
        for r in recs:
            if is_cluster:
                # framed-roads §5 cluster rule: centroid→member distance
                # + 0.4 m pad + arm-width share (arc-walked from the endpoint)
                t = (math.hypot(r["pos"][0] - cx, r["pos"][1] - cy)
                     + CLUSTER_TRIM_PAD + ARM_WIDTH_FACTOR * r["width"])
            else:
                t = max(radius * TRIM_RADIUS_FACTOR, ARM_WIDTH_FACTOR * r["width"])
            trims[(r["road_idx"], r["end"])] = (j_index, t)
        junctions.append({"center": (cx, cy), "z": float(jz), "radius": radius,
                          "arms": [], "degree": degree})

    # ---- 3. segments: trim → densify → elevation profile → arms ------------
    segments = []
    for road_idx, road in enumerate(roads):
        pts = pts_of[road_idx]
        w = float(road.get("width") or 7.0)
        cls = road.get("class") or "residential"
        lanes = road.get("lanes") or max(1, int(round(w / LANE_W)))
        j0, t0 = trims.get((road_idx, 0), (None, 0.0))
        j1, t1 = trims.get((road_idx, 1), (None, 0.0))
        seg = {
            "road_idx": road_idx, "cls": cls, "width": w, "lanes": int(lanes),
            "oneway": bool(road.get("oneway")), "bridge": bool(road.get("bridge")),
            "layer": int(road.get("layer") or 0), "name": road.get("name"),
            "surface": road.get("surface"),
            "pts": pts, "elev": [],
            "j_start": j0, "j_end": j1,
            "internal": road_idx in solve.internal,
        }
        segments.append(seg)
        if len(pts) < 2:
            seg["internal"] = True
            seg["elev"] = [float(solve.z_at(p)) for p in pts]
            continue
        total = geom.arc_lengths(pts)[-1]
        if not seg["internal"] and total - t0 - t1 < MIN_REMAIN:
            seg["internal"] = True  # trims consume it — the pad is its surface
        if seg["internal"]:
            final, _ = geom.densify_polyline(pts, DENSIFY_STEP)
            seg["pts"] = final
            seg["elev"] = list(solve.profile(road_idx, geom.arc_lengths(final)))
            continue  # no ribbon → no arms
        trimmed = _trim_polyline(pts, t0, t1)
        final, _ = geom.densify_polyline(trimmed, DENSIFY_STEP)
        seg["pts"] = final
        # profile expects cum over the FINAL (trimmed + densified) pts
        seg["elev"] = list(solve.profile(road_idx, geom.arc_lengths(final)))
        for end, jidx in ((0, j0), (1, j1)):
            if jidx is None:
                continue
            p = final[0] if end == 0 else final[-1]
            junctions[jidx]["arms"].append({
                "p": p,                       # trimmed mouth ON the centerline
                "dir": _end_dir(final, end),  # unit, away from the junction
                "width": w, "cls": cls,
                "seg_idx": road_idx, "end": end,
                "crosswalk": cls != "motorway" and w >= CROSSWALK_MIN_W,
            })
    return {"segments": segments, "junctions": junctions}


# ============================================================================
# Self-tests — python3 roadnet.py (no bpy, no elevation.py dependency)
# ============================================================================
if __name__ == "__main__":
    class StubSolve:
        """Minimal Solve: flat z=0, identity alias unless told otherwise,
        profile returns zeros and records what cum it was handed."""

        def __init__(self, alias=None, internal=None):
            self.alias = dict(alias or {})
            self.internal = set(internal or ())
            self.node_z = {}
            self.calls = []  # (road_idx, cum tuple)

        def key_of(self, pt):
            k = node_key(pt)
            return self.alias.get(k, k)

        def z_at(self, pt):
            return 0.0

        def profile(self, road_idx, cum):
            self.calls.append((road_idx, tuple(cum)))
            return [0.0] * len(cum)

    def road(pts, width=7.0, cls="residential", **kw):
        r = {"class": cls, "width": width, "pts": pts, "id": len(pts)}
        r.update(kw)
        return r

    SEG_KEYS = ("road_idx", "cls", "width", "lanes", "oneway", "bridge", "layer",
                "name", "surface", "pts", "elev", "j_start", "j_end", "internal")
    ARM_KEYS = ("p", "dir", "width", "cls", "seg_idx", "end", "crosswalk")
    J_KEYS = ("center", "z", "radius", "arms", "degree")

    def check_invariants(net, roads):
        segs, js = net["segments"], net["junctions"]
        assert len(segs) == len(roads), "one SegDesc per road, in order"
        for si, s in enumerate(segs):
            for k in SEG_KEYS:
                assert k in s, f"SegDesc missing {k}"
            assert s["road_idx"] == si
            assert len(s["elev"]) == len(s["pts"]), "elev aligned with pts"
            for (x, y), z in zip(s["pts"], s["elev"]):
                assert all(math.isfinite(v) for v in (x, y, z)), "NaN/inf leak"
            if len(s["pts"]) >= 2:  # densify invariant (internal segs too)
                for a, b in zip(s["pts"], s["pts"][1:]):
                    assert math.hypot(b[0] - a[0], b[1] - a[1]) <= DENSIFY_STEP + 1e-6
            for jk in ("j_start", "j_end"):
                assert s[jk] is None or 0 <= s[jk] < len(js)
        for j in js:
            for k in J_KEYS:
                assert k in j, f"JunctionDesc missing {k}"
            assert math.isfinite(j["z"]) and j["radius"] > 0
            for a in j["arms"]:
                for k in ARM_KEYS:
                    assert k in a, f"arm missing {k}"
                dl = math.hypot(a["dir"][0], a["dir"][1])
                assert abs(dl - 1.0) < 1e-6, "arm dir must be unit length"
                vx = a["p"][0] - j["center"][0]
                vy = a["p"][1] - j["center"][1]
                assert a["dir"][0] * vx + a["dir"][1] * vy > 0, "dir points away"
                s = segs[a["seg_idx"]]
                mouth = s["pts"][0] if a["end"] == 0 else s["pts"][-1]
                assert mouth == a["p"], "arm mouth sits on the centerline end"

    def seg_len(s):
        return geom.arc_lengths(s["pts"])[-1]

    # ---- test 1: + junction of four width-7 roads --------------------------
    roads1 = [
        road([(0, 0), (60, 0)]),               # end 0 at junction
        road([(0, 0), (-60, 0)]),              # end 0 at junction
        road([(0, 60), (0, 0)]),               # end 1 at junction
        road([(0, 0), (0, -60)], cls="motorway"),  # crosswalk must be False
    ]
    sv = StubSolve()
    net = build_network(roads1, sv)
    check_invariants(net, roads1)
    assert len(net["junctions"]) == 1, "four endpoints at one node = 1 junction"
    j = net["junctions"][0]
    assert j["degree"] == 4 and len(j["arms"]) == 4
    assert abs(j["radius"] - 0.58 * 7) < 1e-9
    assert abs(j["center"][0]) < 1e-9 and abs(j["center"][1]) < 1e-9
    trim = max(0.58 * 7 * 0.72, 7 * 0.55)  # = 3.85 (width term wins)
    for si, s in enumerate(net["segments"]):
        assert not s["internal"]
        assert abs(seg_len(s) - (60 - trim)) < 1e-6, "shortened by exactly the trim"
    for a in j["arms"]:
        assert abs(math.hypot(*a["p"]) - trim) < 1e-6, "mouth at trim distance"
    assert [a["crosswalk"] for a in j["arms"]].count(False) == 1  # the motorway
    # profile got cum over the FINAL pts: starts at 0, ends at trimmed length
    for ri, cum in sv.calls:
        assert cum[0] == 0.0 and abs(cum[-1] - (60 - trim)) < 1e-6
        assert all(b > a for a, b in zip(cum, cum[1:])), "cum monotone"
    print("test 1 (+ junction, 4 arms, trim 3.85) OK")

    # ---- test 2: straight 2-way chain through a shared node = no junction --
    roads2 = [
        road([(-50, 0), (0, 0)]),
        road([(0, 0), (50, 0)]),
        road([(200, 0), (300, 0)], bridge=True),  # isolated 2-pt bridge
    ]
    net = build_network(roads2, StubSolve())
    check_invariants(net, roads2)
    assert len(net["junctions"]) == 0, "pass-through joint is not a junction"
    for s in net["segments"][:2]:
        assert s["j_start"] is None and s["j_end"] is None
        assert abs(seg_len(s) - 50) < 1e-9, "no trim at a pass-through"
    assert net["segments"][0]["pts"][0] == (-50.0, 0.0)
    assert net["segments"][1]["pts"][-1] == (50.0, 0.0)
    br = net["segments"][2]
    assert br["bridge"] and len(br["pts"]) >= 13, "2-pt bridge densified to <=8 m"
    print("test 2 (chain pass-through + bridge densify) OK")

    # ---- test 2b: degree-2 width mismatch (14 vs 5) IS a junction ----------
    roads2b = [
        road([(-60, 0), (0, 0)], width=14, cls="primary"),
        road([(0, 0), (60, 0)], width=5),
    ]
    net = build_network(roads2b, StubSolve())
    check_invariants(net, roads2b)
    assert len(net["junctions"]) == 1, "ratio 2.8 > 1.35 breaks pass-through"
    assert net["junctions"][0]["degree"] == 2
    print("test 2b (width-mismatch joint becomes junction) OK")

    # ---- test 3: T, wide 14 through + narrow 5 — trim respects max width ---
    roads3 = [
        road([(-60, 0), (0, 0)], width=14, cls="primary"),
        road([(0, 0), (60, 0)], width=14, cls="primary"),
        road([(0, 0), (0, 60)], width=5),
    ]
    net = build_network(roads3, StubSolve())
    check_invariants(net, roads3)
    assert len(net["junctions"]) == 1
    j = net["junctions"][0]
    assert abs(j["radius"] - 0.58 * 14) < 1e-9
    wide_trim = max(0.58 * 14 * 0.72, 14 * 0.55)   # 7.7 (own width wins)
    narrow_trim = max(0.58 * 14 * 0.72, 5 * 0.55)  # 5.8464 (max width wins)
    s_narrow = net["segments"][2]
    assert abs(s_narrow["pts"][0][0]) < 1e-9
    assert abs(s_narrow["pts"][0][1] - narrow_trim) < 1e-6, "narrow trim uses radius"
    assert abs(seg_len(net["segments"][0]) - (60 - wide_trim)) < 1e-6
    narrow_arm = [a for a in j["arms"] if a["seg_idx"] == 2][0]
    assert narrow_arm["crosswalk"] is True  # width 5 >= 5, not motorway
    print(f"test 3 (T 14/5: wide trim {wide_trim}, narrow trim {narrow_trim:.4f}) OK")

    # ---- test 4: 3 m stub between two junctions → internal ------------------
    roads4 = [
        road([(0, 0), (-60, 0)]),
        road([(0, 0), (0, 60)]),
        road([(0, 0), (0, -60)]),
        road([(3, 0), (63, 0)]),
        road([(3, 0), (3, 60)]),
        road([(3, 0), (3, -60)]),
        road([(0, 0), (3, 0)]),        # the stub: 3 m, trims eat 7.7 m
        {"class": "service", "width": 4.0, "pts": [(100, 100)], "id": 9},  # degenerate
    ]
    net = build_network(roads4, StubSolve())
    check_invariants(net, roads4)
    assert len(net["junctions"]) == 2
    stub = net["segments"][6]
    assert stub["internal"] is True, "remaining < 1 m after trims → internal"
    assert stub["j_start"] is not None and stub["j_end"] is not None
    assert stub["j_start"] != stub["j_end"]
    for j in net["junctions"]:
        assert j["degree"] == 4, "stub still counts toward degree"
        assert len(j["arms"]) == 3, "but contributes no mouth arm"
    assert net["segments"][7]["internal"] is True, "1-pt road → internal"
    print("test 4 (3 m stub internal between two junctions) OK")

    # ---- test 5: cluster via alias — centroid center, cluster trim rule ----
    # nodes (0,0) and (6,0) aliased into one cluster (canonical "0,0")
    sv5 = StubSolve(alias={"12,0": "0,0"}, internal={4})
    sv5.node_z["0,0"] = 2.5
    roads5 = [
        road([(0, 0), (0, 60)]),
        road([(0, 0), (-60, 0)]),
        road([(6, 0), (66, 0)]),
        road([(6, 0), (6, 60)]),
        road([(0, 0), (6, 0)]),   # cluster-internal edge (solve.internal)
    ]
    net = build_network(roads5, sv5)
    check_invariants(net, roads5)
    assert len(net["junctions"]) == 1, "cluster collapses to one junction"
    j = net["junctions"][0]
    assert abs(j["center"][0] - 3.0) < 1e-9 and abs(j["center"][1]) < 1e-9, \
        "center = mean of member node positions"
    assert j["z"] == 2.5 and j["degree"] == 6
    assert len(j["arms"]) == 4, "internal edge contributes no arms"
    cluster_trim = 3.0 + 0.4 + 0.55 * 7  # centroid→member + pad + width share
    assert abs(net["segments"][0]["pts"][0][1] - cluster_trim) < 1e-6
    assert abs(net["segments"][2]["pts"][0][0] - (6 + cluster_trim)) < 1e-6
    assert net["segments"][4]["internal"] is True
    print(f"test 5 (cluster: center (3,0), trim {cluster_trim}) OK")

    print("ALL roadnet.py self-tests passed")
