"""vegetation.py — roadside verge tufts/shrubs + forest/park tree fill.

Pure module (stdlib + geom only, no bpy). Port of the app's
src/procgen/vegetation.ts planner, verbatim semantics (PLAN.md §3.3):

  zone rules (grass spacing m / shrub-every-N / band m):
    park 1.1/5/5.0 · residential 1.6/7/3.6 · none 1.4/6/4.5
    · retail 2.8/0/2.4 · commercial 2.9/0/2.4 · industrial 2.2/9/3.0
  offset = half + 1.4 + hash·band, both sides, land-cover gated (grass/bare),
  carriageway rejection margin 0.3 (shrub 0.4), dry-tuft drop at hash > 0.55.
  Budgets: 26 000 grass, 6 000 shrubs.

Deviation from the app (documented in SPEC.md): the plugin's terrain reads as
grass everywhere (one splatted ground plane), so the land-cover fallback is
"grass", not "built" — buildings/plazas/water are indexed and win first. The
app fell back to "built" because its ground was untextured.

Forest/park interior fill: hash scatter on a world-aligned grid — forest one
tree per ~90 m² (cell 9.5), park one per ~240 m² (cell 15.5), cap 3 000 total,
species picked by hash from (tree 0.5, tree_broad 0.3, tree_columnar 0.2).

Coordinates: metres, X=east, Y=north, Z=up. Determinism: FNV-1a string hash
(the app's resolver hash01) — no random, no time.
"""
import math

try:
    from . import geom
except ImportError:  # direct python3 execution for self-tests
    import geom

__all__ = ["hash01s", "make_context", "plan_roadside", "plan_area_trees",
           "grass_meshdata", "shrub_meshdata", "pick_species",
           "VERGE_RULES", "BUDGET_GRASS", "BUDGET_SHRUB", "AREA_TREE_CAP"]

# ---------------------------------------------------------------------------
# Constants (app parity)
# ---------------------------------------------------------------------------
BUDGET_GRASS = 26000
BUDGET_SHRUB = 6000
AREA_TREE_CAP = 3000
VERGE_INSET = 1.4          # verge starts just beyond a typical sidewalk
GRASS_MARGIN = 0.3         # carriageway rejection margin for tufts
SHRUB_MARGIN = 0.4         # ... and shrubs
DRY_DROP = 0.55            # bare-cover tufts dropped at hash > 0.55
MIN_ROAD_LEN = 12.0

# zone -> (grass spacing m, shrub every N stations, band m)
VERGE_RULES = {
    "park":        (1.1, 5, 5.0),
    "residential": (1.6, 7, 3.6),
    "none":        (1.4, 6, 4.5),
    "retail":      (2.8, 0, 2.4),
    "commercial":  (2.9, 0, 2.4),
    "industrial":  (2.2, 9, 3.0),
}

NON_DRIVABLE = frozenset(("pedestrian", "footway", "cycleway"))

# forest/park fill grid cells (m): 9.5² ≈ 90 m²/tree, 15.5² ≈ 240 m²/tree
FILL_CELL = {"forest": 9.5, "park": 15.5}

# species pool (cumulative weights) — hash < 0.5 broadleaf, < 0.8 broad, else columnar
_SPECIES = (("tree", 0.5), ("tree_broad", 0.8), ("tree_columnar", 1.0))


def pick_species(h):
    """hash in [0,1) → template name from the 3-species pool."""
    for name, cum in _SPECIES:
        if h < cum:
            return name
    return _SPECIES[-1][0]


def hash01s(key):
    """FNV-1a 32-bit of a string → [0,1) (the app resolver's hash01)."""
    h = 2166136261
    for ch in str(key):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h / 4294967296.0


# ---------------------------------------------------------------------------
# Context: land cover + zoning samplers from Graph v2
# ---------------------------------------------------------------------------
def _ring_aabb(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _in_ring(p, ring):
    x, y = p
    n = len(ring)
    c = False
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            c = not c
    return c


class _PolyIndex:
    """SpatialGrid-backed point → class sampler over polygon rings (+holes).
    First inserted entry wins on overlap (precedence = insertion order)."""

    def __init__(self, cell=48.0):
        self.grid = geom.SpatialGrid(cell=cell)
        self._n = 0

    def add(self, ring, holes, cls):
        if len(ring) < 3:
            return
        minx, miny, maxx, maxy = _ring_aabb(ring)
        self.grid.insert(minx, miny, maxx, maxy,
                         (self._n, ring, holes or (), cls))
        self._n += 1

    def sample(self, x, y, default):
        best = None
        for order, ring, holes, cls in self.grid.query(x, y):
            if best is not None and order >= best[0]:
                continue
            if _in_ring((x, y), ring) and not any(_in_ring((x, y), h) for h in holes):
                best = (order, cls)
        return best[1] if best else default


# area kind → land-cover class (precedence: buildings first, then this order)
_COVER_ORDER = (("water", "water"), ("plaza", "built"), ("sand", "bare"),
                ("forest", "trees"), ("park", "grass"), ("grass", "grass"))


def make_context(graph):
    """Graph v2 → {"land_cover_at": f(x,y)->cls, "zone_at": f(x,y)->zone}.

    Land cover: built | water | trees | grass | bare — buildings win, water/
    plaza/sand/forest/park/grass polygons next, fallback "grass" (plugin
    deviation, see module docstring). Zone: landuse polygons (graph["zones"])
    + leisure parks, fallback "none".
    """
    cover = _PolyIndex()
    for b in graph.get("buildings") or ():
        cover.add(b["ring"], (), "built")
    areas = graph.get("areas") or ()
    for want, cls in _COVER_ORDER:
        for a in areas:
            if a["kind"] == want:
                cover.add(a["ring"], a.get("holes"), cls)

    zones = _PolyIndex()
    for z in graph.get("zones") or ():
        if z["kind"] in VERGE_RULES:
            zones.add(z["ring"], z.get("holes"), z["kind"])
    for a in areas:
        if a["kind"] == "park":
            zones.add(a["ring"], a.get("holes"), "park")

    return {
        "land_cover_at": lambda x, y: cover.sample(x, y, "grass"),
        "zone_at": lambda x, y: zones.sample(x, y, "none"),
    }


# ---------------------------------------------------------------------------
# Carriageway occupancy index (the app's DrivableIndex)
# ---------------------------------------------------------------------------
class DrivableIndex:
    def __init__(self, roads, cell=24.0):
        self.grid = geom.SpatialGrid(cell=cell)
        for r in roads:
            if r["class"] in NON_DRIVABLE or r.get("tunnel"):
                continue
            pts = r.get("pts") or ()
            if len(pts) < 2:
                continue
            half = float(r["width"]) / 2.0
            for i in range(len(pts) - 1):
                self.grid.insert_segment(pts[i], pts[i + 1],
                                         (pts[i], pts[i + 1], half),
                                         pad=half + 1.0)

    def inside(self, x, y, margin):
        for a, b, half in self.grid.query(x, y):
            d, _, _ = geom.seg_point_dist((x, y), a, b)
            if d < half + margin:
                return True
        return False


def _along_with_dir(pts, cum, dist):
    """((x, y), unit dir) at arc length dist (app alongWithDir)."""
    for i in range(1, len(pts)):
        seg = cum[i] - cum[i - 1]
        if cum[i] >= dist and seg > 0:
            t = (dist - cum[i - 1]) / seg
            dx = pts[i][0] - pts[i - 1][0]
            dy = pts[i][1] - pts[i - 1][1]
            return ((pts[i - 1][0] + dx * t, pts[i - 1][1] + dy * t),
                    (dx / seg, dy / seg))
    dx = pts[-1][0] - pts[-2][0]
    dy = pts[-1][1] - pts[-2][1]
    ln = math.hypot(dx, dy) or 1.0
    return (pts[-1][0], pts[-1][1]), (dx / ln, dy / ln)


# ---------------------------------------------------------------------------
# Planner — verbatim port of planRoadsideVegetation
# ---------------------------------------------------------------------------
def plan_roadside(roads, ctx, sample_z, budget=(BUDGET_GRASS, BUDGET_SHRUB)):
    """roads: graph["roads"] (post-merge) → deterministic verge instances.

    Returns [{"x","y","z","scale","rot","tint","dry","kind"}] in a stable
    order so the global budget truncates identically every build. kind is
    "grass" | "shrub"; tint in [−1, 1]; z = sample_z(x, y).
    """
    budget_grass, budget_shrub = budget
    index = DrivableIndex(roads)
    cover_at = ctx["land_cover_at"]
    zone_at = ctx["zone_at"]
    out = []
    n_grass = n_shrub = 0

    for r in roads:
        # a verge needs solid ground beside the road: no bridges/tunnels,
        # only roads with a real carriageway
        if r.get("bridge") or r.get("tunnel") or r["class"] in NON_DRIVABLE:
            continue
        pts = r.get("pts") or ()
        if len(pts) < 2:
            continue
        cum = geom.arc_lengths(pts)
        length = cum[-1]
        if length < MIN_ROAD_LEN:
            continue
        mid = pts[len(pts) // 2]
        spacing, shrub_every, band = VERGE_RULES.get(zone_at(mid[0], mid[1]),
                                                     VERGE_RULES["none"])
        half = float(r["width"]) / 2.0
        rid = r.get("id")

        for side in (-1, 1):
            step = 0
            d = spacing * 0.5
            while d < length:
                if n_grass >= budget_grass:
                    break
                (px, py), (dx, dy) = _along_with_dir(pts, cum, d)
                ax, ay = -dy * side, dx * side       # across = side × left normal
                off = half + VERGE_INSET + hash01s(f"{rid}:vo{side}{step}") * band
                gx, gy = px + ax * off, py + ay * off
                cov = cover_at(gx, gy)
                if cov in ("grass", "bare") and not index.inside(gx, gy, GRASS_MARGIN):
                    dry = cov == "bare"
                    # thin bare/dry verges so they read scrubby, not lush
                    if not (dry and hash01s(f"{rid}:vd{side}{step}") > DRY_DROP):
                        out.append({
                            "x": gx, "y": gy, "z": sample_z(gx, gy),
                            "scale": 0.72 + hash01s(f"{rid}:vs{side}{step}") * 0.6,
                            "rot": hash01s(f"{rid}:vr{side}{step}") * math.pi,
                            "tint": hash01s(f"{rid}:vt{side}{step}") * 2.0 - 1.0,
                            "dry": dry, "kind": "grass",
                        })
                        n_grass += 1
                        # a shrub occasionally at the same station, pushed out
                        if (not dry and shrub_every > 0 and step % shrub_every == 0
                                and n_shrub < budget_shrub):
                            soff = off + 0.8 + hash01s(f"{rid}:sh{side}{step}") * 1.2
                            sx, sy = px + ax * soff, py + ay * soff
                            if (cover_at(sx, sy) == "grass"
                                    and not index.inside(sx, sy, SHRUB_MARGIN)):
                                out.append({
                                    "x": sx, "y": sy, "z": sample_z(sx, sy),
                                    "scale": 0.55 + hash01s(f"{rid}:ss{side}{step}") * 0.6,
                                    "rot": hash01s(f"{rid}:sr{side}{step}") * math.tau,
                                    "tint": hash01s(f"{rid}:st{side}{step}") * 2.0 - 1.0,
                                    "dry": False, "kind": "shrub",
                                })
                                n_shrub += 1
                d += spacing
                step += 1
        if n_grass >= budget_grass and n_shrub >= budget_shrub:
            break
    return out


# ---------------------------------------------------------------------------
# Forest / park interior fill
# ---------------------------------------------------------------------------
def plan_area_trees(areas, ctx, sample_z, roads=None, cap=AREA_TREE_CAP):
    """Hash scatter of tree instances inside forest/park rings.

    World-aligned grid (one candidate per cell, jittered by hash) so results
    are stable under refetch and overlapping polygons dedupe by cell. Rejects
    points on carriageways, buildings and water. Returns
    [{"x","y","z","species","scale","rot","area_kind"}], capped.
    """
    index = DrivableIndex(roads or ())
    cover_at = ctx["land_cover_at"]
    out = []
    seen = set()
    for a in areas:
        kind = a.get("kind")
        cell = FILL_CELL.get(kind)
        if not cell:
            continue
        ring = a["ring"]
        holes = a.get("holes") or ()
        minx, miny, maxx, maxy = _ring_aabb(ring)
        for ix in range(int(math.floor(minx / cell)), int(math.floor(maxx / cell)) + 1):
            if len(out) >= cap:
                return out
            for iy in range(int(math.floor(miny / cell)), int(math.floor(maxy / cell)) + 1):
                if len(out) >= cap:
                    return out
                key = (kind, ix, iy)
                if key in seen:
                    continue
                seen.add(key)
                x = (ix + hash01s(f"fx{ix},{iy}")) * cell
                y = (iy + hash01s(f"fy{ix},{iy}")) * cell
                if not _in_ring((x, y), ring) or any(_in_ring((x, y), h) for h in holes):
                    continue
                if cover_at(x, y) in ("built", "water"):
                    continue
                if index.inside(x, y, 1.0):
                    continue
                out.append({
                    "x": x, "y": y, "z": sample_z(x, y),
                    "species": pick_species(hash01s(f"fs{ix},{iy}")),
                    "scale": 0.7 + hash01s(f"fc{ix},{iy}") * 0.7,
                    "rot": hash01s(f"fr{ix},{iy}") * math.tau,
                    "area_kind": kind,
                })
    return out


# ---------------------------------------------------------------------------
# Mesh builders (pure — realised as ONE merged object per kind in build.py)
# ---------------------------------------------------------------------------
def grass_meshdata(instances):
    """Grass tufts → crossed alpha-card quads (2 faces / 8 verts each).

    Card: unit square UVs; width = scale·0.8, height = scale·(0.42 +
    (tint+1)·0.09) (app numbers). attrs: tint = (tint+1)/2, dry = 0|1.
    """
    md = geom.new_meshdata()
    md["uvs"] = []
    tints, drys = [], []
    uv = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    for e in instances:
        w = e["scale"] * 0.8
        h = e["scale"] * (0.42 + (e["tint"] + 1.0) * 0.09)
        cr, sr = math.cos(e["rot"]), math.sin(e["rot"])
        x, y, z = e["x"], e["y"], e["z"]
        for dx, dy in ((cr, sr), (-sr, cr)):     # two crossed vertical quads
            hx, hy = dx * w / 2.0, dy * w / 2.0
            base = len(md["verts"])
            md["verts"].extend(((x - hx, y - hy, z), (x + hx, y + hy, z),
                                (x + hx, y + hy, z + h), (x - hx, y - hy, z + h)))
            md["faces"].append([base, base + 1, base + 2, base + 3])
            md["mats"].append("grass_card")
            md["uvs"].append(uv)
            tints.append((e["tint"] + 1.0) / 2.0)
            drys.append(1.0 if e.get("dry") else 0.0)
    md["attrs"]["tint"] = tints
    md["attrs"]["dry"] = drys
    return md


# octahedron subdivided once (18 verts / 32 tris) — the shrub blob
_OCTA_V = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
_OCTA_F = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4),
           (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]


def _blob(md, cx, cy, cz, rx, ry, rz, mat, tint, tints):
    verts = [tuple(v) for v in _OCTA_V]
    mids = {}
    faces = []

    def mid(i, j):
        key = (i, j) if i < j else (j, i)
        if key not in mids:
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
        md["faces"].append([base + i for i in f])
        md["mats"].append(mat)
        if md["uvs"] is not None:
            md["uvs"].append(None)
        tints.append(tint)
    return md


def shrub_meshdata(instances):
    """Verge shrubs → one merged blob mesh (32 tris each, mat leaves).

    App transform: radius = scale, vertical radius ·0.82, centre 0.7·scale
    above ground. attrs: tint = (tint+1)/2 per face.
    """
    md = geom.new_meshdata()
    md["uvs"] = []
    tints = []
    for e in instances:
        r = e["scale"]
        _blob(md, e["x"], e["y"], e["z"] + r * 0.7, r, r, r * 0.82,
              "leaves", (e["tint"] + 1.0) / 2.0, tints)
    md["attrs"]["tint"] = tints
    return md


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # hash01s: FNV-1a reference values + range
    assert hash01s("") == 2166136261 / 4294967296.0
    assert 0.0 <= hash01s("way/1:vo-10") < 1.0
    assert hash01s("a") != hash01s("b")
    assert hash01s("road_1:vo11") == hash01s("road_1:vo11")

    def road(rid, pts, cls="residential", width=7.0, bridge=False, tunnel=False):
        return {"id": rid, "class": cls, "width": width, "pts": pts,
                "bridge": bridge, "tunnel": tunnel}

    flat_z = lambda x, y: 0.0
    all_grass = {"land_cover_at": lambda x, y: "grass",
                 "zone_at": lambda x, y: "none"}

    # -- 1. straight 200 m residential road, everything grass ---------------
    r200 = road(1, [(0.0, 0.0), (200.0, 0.0)])
    inst = plan_roadside([r200], all_grass, flat_z)
    grass = [i for i in inst if i["kind"] == "grass"]
    shrubs = [i for i in inst if i["kind"] == "shrub"]
    # zone none: spacing 1.4 → ~142 stations per side
    assert 270 <= len(grass) <= 290, len(grass)
    assert len(shrubs) > 20, len(shrubs)
    half = 3.5
    for g in grass:
        off = abs(g["y"])
        assert half + VERGE_INSET - 1e-9 <= off <= half + VERGE_INSET + 4.5 + 1e-9
        assert off > half + GRASS_MARGIN            # never in the carriageway
        assert 0.72 <= g["scale"] <= 1.32 and -1.0 <= g["tint"] <= 1.0
        assert not g["dry"]
    for s in shrubs:
        assert abs(s["y"]) > half + VERGE_INSET + 0.8 - 1e-9
    assert plan_roadside([r200], all_grass, flat_z) == inst  # deterministic
    print(f"  straight 200 m: {len(grass)} tufts, {len(shrubs)} shrubs, offsets OK")

    # -- 2. zone table drives density ----------------------------------------
    park_ctx = {"land_cover_at": lambda x, y: "grass",
                "zone_at": lambda x, y: "park"}
    retail_ctx = {"land_cover_at": lambda x, y: "grass",
                  "zone_at": lambda x, y: "retail"}
    n_park = len([i for i in plan_roadside([r200], park_ctx, flat_z)
                  if i["kind"] == "grass"])
    n_retail = [i["kind"] for i in plan_roadside([r200], retail_ctx, flat_z)]
    assert n_park > 340, n_park                     # spacing 1.1
    assert n_retail.count("grass") < 150            # spacing 2.8
    assert n_retail.count("shrub") == 0             # shrubEvery 0
    print(f"  zones: park {n_park} tufts, retail {n_retail.count('grass')} + 0 shrubs")

    # -- 3. land-cover gates --------------------------------------------------
    built_ctx = {"land_cover_at": lambda x, y: "built",
                 "zone_at": lambda x, y: "none"}
    assert plan_roadside([r200], built_ctx, flat_z) == []
    bare_ctx = {"land_cover_at": lambda x, y: "bare",
                "zone_at": lambda x, y: "none"}
    dry = plan_roadside([r200], bare_ctx, flat_z)
    assert dry and all(i["dry"] and i["kind"] == "grass" for i in dry)
    n_all = len([i for i in plan_roadside([r200], all_grass, flat_z)
                 if i["kind"] == "grass"])
    assert len(dry) < 0.62 * n_all                  # dry thinning at 0.55
    print(f"  cover gates: built → 0, bare → {len(dry)} dry (thinned from {n_all})")

    # -- 4. bridges/tunnels/non-drivable skipped; budget truncates -----------
    assert plan_roadside([road(2, [(0, 0), (100, 0)], bridge=True)],
                         all_grass, flat_z) == []
    assert plan_roadside([road(3, [(0, 0), (100, 0)], tunnel=True)],
                         all_grass, flat_z) == []
    assert plan_roadside([road(4, [(0, 0), (100, 0)], cls="footway")],
                         all_grass, flat_z) == []
    tiny = plan_roadside([r200], all_grass, flat_z, budget=(10, 2))
    assert len([i for i in tiny if i["kind"] == "grass"]) == 10
    assert len([i for i in tiny if i["kind"] == "shrub"]) <= 2
    print("  gates + budget truncation OK")

    # -- 5. context samplers --------------------------------------------------
    g = {"buildings": [{"ring": [(0, 0), (10, 0), (10, 10), (0, 10)]}],
         "areas": [{"kind": "water", "ring": [(20, 0), (40, 0), (40, 20), (20, 20)]},
                   {"kind": "park", "ring": [(50, 0), (100, 0), (100, 50), (50, 50)],
                    "holes": [[(70, 10), (80, 10), (80, 20), (70, 20)]]},
                   {"kind": "forest", "ring": [(-100, -100), (-50, -100),
                                               (-50, -50), (-100, -50)]}],
         "zones": [{"kind": "retail", "ring": [(0, 100), (50, 100), (50, 150), (0, 150)]}]}
    ctx = make_context(g)
    lc, zn = ctx["land_cover_at"], ctx["zone_at"]
    assert lc(5, 5) == "built"          # building wins
    assert lc(30, 10) == "water"
    assert lc(60, 30) == "grass"        # park
    assert lc(75, 15) == "grass"        # park hole → falls through to default
    assert lc(-75, -75) == "trees"
    assert lc(500, 500) == "grass"      # plugin fallback
    assert zn(60, 30) == "park" and zn(25, 120) == "retail" and zn(500, 500) == "none"
    print("  context: cover precedence + zone sampling OK")

    # -- 6. forest/park fill ---------------------------------------------------
    forest = [{"kind": "forest", "ring": [(0, 0), (95, 0), (95, 95), (0, 95)]}]
    trees = plan_area_trees(forest, all_grass, flat_z)
    # 95×95 m at one candidate / 9.5 m cell ≈ 100 candidates, most inside
    assert 60 <= len(trees) <= 110, len(trees)
    assert {t["species"] for t in trees} == {"tree", "tree_broad", "tree_columnar"}
    assert all(t["area_kind"] == "forest" for t in trees)
    park = [{"kind": "park", "ring": [(0, 0), (95, 0), (95, 95), (0, 95)]}]
    ptrees = plan_area_trees(park, all_grass, flat_z)
    assert len(ptrees) < 0.6 * len(trees), (len(ptrees), len(trees))  # sparser
    # overlapping duplicate polygon dedupes by cell
    assert len(plan_area_trees(forest + forest, all_grass, flat_z)) == len(trees)
    # road through the forest carves a gap
    rd = road(9, [(0.0, 47.0), (95.0, 47.0)], width=10.0)
    with_road = plan_area_trees(forest, all_grass, flat_z, roads=[rd])
    assert len(with_road) < len(trees)
    for t in with_road:
        d, _, _ = geom.seg_point_dist((t["x"], t["y"]), (0.0, 47.0), (95.0, 47.0))
        assert d >= 6.0 - 1e-9, t
    assert len(plan_area_trees(forest, all_grass, flat_z, cap=10)) == 10
    print(f"  fill: forest {len(trees)}, park {len(ptrees)}, road gap + cap OK")

    # -- 7. mesh builders -------------------------------------------------------
    gmd = grass_meshdata(grass[:100])
    assert len(gmd["faces"]) == 200 and len(gmd["verts"]) == 800
    assert all(len(f) == 4 for f in gmd["faces"])
    assert gmd["mats"] == ["grass_card"] * 200
    assert len(gmd["uvs"]) == 200 and all(u is not None for u in gmd["uvs"])
    assert len(gmd["attrs"]["tint"]) == 200 and len(gmd["attrs"]["dry"]) == 200
    assert all(0.0 <= t <= 1.0 for t in gmd["attrs"]["tint"])
    e0 = grass[0]
    exp_h = e0["scale"] * (0.42 + (e0["tint"] + 1.0) * 0.09)
    got_h = max(v[2] for v in gmd["verts"][:8]) - e0["z"]
    assert abs(got_h - exp_h) < 1e-9
    smd = shrub_meshdata(shrubs[:10])
    assert len(smd["faces"]) == 320 and len(smd["attrs"]["tint"]) == 320
    s0 = shrubs[0]
    assert abs(max(v[2] for v in smd["verts"][:18])
               - (s0["z"] + s0["scale"] * 0.7 + s0["scale"] * 0.82)) < 1e-9
    merged = geom.merge_meshdata(geom.new_meshdata(), gmd)
    merged = geom.merge_meshdata(merged, smd)
    assert len(merged["attrs"]["tint"]) == len(merged["faces"])
    print(f"  meshes: {len(gmd['faces'])} card faces, {len(smd['faces'])} blob faces")

    print("vegetation self-tests OK")
