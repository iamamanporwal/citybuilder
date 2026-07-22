"""terrain.py — conformed ground mesh grid.

Contract: SPEC.md "terrain.py" + specs/elevation-terrain.md §C (road conform +
ground mesh). Pure module (stdlib + geom only, no bpy). Coordinates: metres,
X = east, Y = north, Z = up (app spec is Y-up with (x, z) ground — spec z → our
y, spec elevation y → our z).

The road elevation solve samples the NATURAL field; this module samples the
CONFORMED field: ground vertices are pulled flat under road corridors so the
terrain never pokes through carriageways, with a cubic-smoothstep shoulder
blending back to the natural field. Blend rule: LARGEST corridor weight wins
(no averaging across corridors), then lerp against field.sample.
"""
import math

try:
    from . import geom
except ImportError:  # direct `python3 terrain.py` execution
    import geom

# --- specs/elevation-terrain.md §C road-conform constants -------------------
SHOULDER = 14.0        # blend falloff width beyond the paved apron (m)
DEFAULT_PAVE = 4.0     # flat apron beyond half-width when a corridor omits "pave"
CONFORM_CELL = 24.0    # spatial-hash cell for bucketing corridor segments (m)

# --- SPEC.md terrain.py grid constants ---------------------------------------
CELL_BY_QUALITY = {"high": 4.0, "med": 6.0, "low": 10.0}  # grid cell size (m)
EXTENT_FACTOR = 1.25       # grid half-extent = radius * 1.25
UV_METRES_PER_TILE = 8.0   # planar UVs at metres/8 → an 8 m texture tile
ROCK_SLOPE_NORM = 0.7      # rock = clamp(max |dz| across face / (cell*0.7), 0, 1)
MAT_TERRAIN = "terrain"


def _cell_for(quality):
    """Grid cell size for a quality key; tolerant of 'High'/'medium' spellings."""
    q = str(quality).lower()
    if q in CELL_BY_QUALITY:
        return CELL_BY_QUALITY[q]
    for k, v in CELL_BY_QUALITY.items():  # prefix fallback: h/m/l
        if q[:1] == k[:1]:
            return v
    return CELL_BY_QUALITY["med"]


def make_conform_sampler(field, corridors):
    """Return sample(x, y) -> z: field.sample blended flat under road corridors.

    corridors: [{"pts": [(x, y)], "elev": [z per pt], "half": width/2,
                 "pave": 4.0}] — from non-bridge, non-internal SegDescs.
    Per §C: segments bucketed in a 24 m SpatialGrid padded by the full reach
    (half + pave + SHOULDER); at a query point, w = 1 inside half+pave, cubic
    smoothstep falloff over the 14 m shoulder, the LARGEST w wins and carries
    its segment elevation (lerped by closest-point t).
    """
    grid = geom.SpatialGrid(cell=CONFORM_CELL)
    for c in corridors or ():
        pts = c["pts"]
        elev = c["elev"]
        if len(pts) < 2 or len(elev) != len(pts):
            continue  # malformed corridor — roadnet guarantees aligned lists
        half = float(c["half"])
        pave = float(c.get("pave", DEFAULT_PAVE))
        reach = half + pave + SHOULDER
        for i in range(len(pts) - 1):
            payload = (pts[i], pts[i + 1], elev[i], elev[i + 1], half, pave)
            grid.insert_segment(pts[i], pts[i + 1], payload, pad=reach)

    def sample(x, y):
        hb = field.sample(x, y)
        best_w = 0.0
        best_e = 0.0
        for a, b, e0, e1, half, pave in grid.query(x, y):
            d, _cp, t = geom.seg_point_dist((x, y), a, b)
            flat = half + pave
            if d <= flat:
                w = 1.0
            elif d < flat + SHOULDER:
                w = geom.smoothstep((flat + SHOULDER - d) / SHOULDER)
            else:
                continue
            if w > best_w:  # strict > keeps the first at exact ties (deterministic)
                best_w = w
                best_e = geom.lerp(e0, e1, t)
                if best_w >= 1.0:
                    break  # nothing can beat a flat-apron hit
        return best_e * best_w + hb * (1.0 - best_w)

    return sample


def build_terrain(field, radius, corridors, quality):
    """Ground grid MeshData: quad faces, conformed z, rock attr, planar UVs.

    Grid cell by quality {high: 4, med: 6, low: 10} m; extent ±radius*1.25
    (snapped outward so spacing is exactly `cell`). Vertex z from the conformed
    sampler; attrs["rock"] per face = clamp((max z − min z of corners) /
    (cell * 0.7), 0, 1); UVs planar at metres/8; every face mat "terrain".
    Faces over water are NOT skipped — the riverbed shows through (§C note).
    """
    cell = _cell_for(quality)
    sample = make_conform_sampler(field, corridors)

    half_extent = float(radius) * EXTENT_FACTOR
    n = max(1, int(math.ceil((2.0 * half_extent) / cell)))  # cells per side
    half = n * cell / 2.0  # span [-half, +half] covers ±radius*1.25 exactly-or-more
    nv = n + 1             # vertices per side

    md = geom.new_meshdata()
    verts = md["verts"]
    for j in range(nv):
        y = -half + j * cell
        for i in range(nv):
            x = -half + i * cell
            verts.append((x, y, sample(x, y)))

    md["uvs"] = []
    rock = []
    inv_norm = 1.0 / (cell * ROCK_SLOPE_NORM)
    inv_uv = 1.0 / UV_METRES_PER_TILE
    for j in range(n):
        row0 = j * nv
        row1 = (j + 1) * nv
        for i in range(n):
            # CCW seen from +Z: E, then N, back W, then S
            quad = [row0 + i, row0 + i + 1, row1 + i + 1, row1 + i]
            md["faces"].append(quad)
            md["mats"].append(MAT_TERRAIN)
            md["uvs"].append([(verts[k][0] * inv_uv, verts[k][1] * inv_uv)
                              for k in quad])
            zs = [verts[k][2] for k in quad]
            rock.append(min(1.0, max(0.0, (max(zs) - min(zs)) * inv_norm)))
    md["attrs"]["rock"] = rock
    return md


if __name__ == "__main__":
    # ---------------------------------------------------------------- fixtures
    class StubField:
        """Flat-ish natural field: gentle ramp z = x * 0.05."""
        mode = "flat"

        def sample(self, x, y):
            return x * 0.05

        def base_sample(self, x, y):
            return self.sample(x, y)

    field = StubField()
    HALF_W = 5.0   # corridor half-width → flat apron = half + pave = 9 m
    PAVE = 4.0
    FLAT = HALF_W + PAVE            # 9 m
    REACH = FLAT + SHOULDER         # 23 m
    corridor = {"pts": [(0.0, -1000.0), (0.0, 1000.0)],
                "elev": [2.0, 2.0], "half": HALF_W, "pave": PAVE}

    # ------------------------------------------------ build (med quality, r=100)
    radius = 100.0
    md = build_terrain(field, radius, [corridor], "med")
    cell = 6.0
    n = int(math.ceil(2 * radius * EXTENT_FACTOR / cell))   # 42
    nv = n + 1
    assert len(md["verts"]) == nv * nv, (len(md["verts"]), nv * nv)
    assert len(md["faces"]) == n * n
    assert len(md["verts"]) > 0 and len(md["faces"]) > 0
    assert len(md["mats"]) == len(md["faces"])
    assert all(m == MAT_TERRAIN for m in md["mats"])
    assert md["uvs"] is not None and len(md["uvs"]) == len(md["faces"])
    assert all(len(uv) == len(f) == 4 for uv, f in zip(md["uvs"], md["faces"]))
    for v in md["verts"]:
        assert all(math.isfinite(c) for c in v), f"non-finite vert {v}"

    # UVs are planar metres/8 and aligned corner-for-corner with faces
    for f, uv in zip(md["faces"], md["uvs"]):
        for k, (u, vv) in zip(f, uv):
            assert abs(u - md["verts"][k][0] / 8.0) < 1e-12
            assert abs(vv - md["verts"][k][1] / 8.0) < 1e-12

    # quads are CCW seen from +Z (positive signed area in xy)
    for f in md["faces"][:50]:
        ring = [(md["verts"][k][0], md["verts"][k][1]) for k in f]
        assert geom.ring_area_signed(ring) > 0

    # ------------------------------------------------------- conform invariants
    checked_on = checked_far = checked_mid = 0
    for (x, y, z) in md["verts"]:
        d = abs(x)  # corridor runs along the y-axis at x=0
        hb = field.sample(x, y)
        if d <= FLAT:                       # ON corridor (within half + pave)
            assert abs(z - 2.0) <= 1e-6, (x, y, z)
            checked_on += 1
        elif d >= REACH:                    # beyond half + pave + SHOULDER
            assert z == hb, (x, y, z, hb)   # untouched natural field
            checked_far += 1
        else:                               # shoulder: exact smoothstep blend
            w = geom.smoothstep((REACH - d) / SHOULDER)
            expect = 2.0 * w + hb * (1.0 - w)
            assert abs(z - expect) <= 1e-9, (x, y, z, expect)
            checked_mid += 1
    assert checked_on and checked_far and checked_mid, \
        (checked_on, checked_far, checked_mid)

    # blend weight is monotone non-increasing with distance along one row
    row = sorted((x, z) for (x, y, z) in md["verts"] if y == 0.0 and 0 <= x)
    ws = []
    for x, z in row:
        hb = x * 0.05
        denom = 2.0 - hb  # z = 2w + hb(1-w)  →  w = (z - hb) / (2 - hb)
        if abs(denom) > 1e-6:
            ws.append((z - hb) / denom)
    for a, b in zip(ws, ws[1:]):
        assert b <= a + 1e-9, (a, b)

    # rock attr: aligned, in [0,1], nonzero on the shoulder step, zero far away
    rock = md["attrs"]["rock"]
    assert len(rock) == len(md["faces"])
    assert all(0.0 <= r <= 1.0 for r in rock)
    assert max(rock) > 0.0
    # exact spot-check: face spanning x∈[6,12], y∈[0,6] (shoulder gradient)
    for f, r in zip(md["faces"], rock):
        xs = [md["verts"][k][0] for k in f]
        ys = [md["verts"][k][1] for k in f]
        if min(xs) == 6.0 and max(xs) == 12.0 and min(ys) == 0.0:
            zs = [md["verts"][k][2] for k in f]
            expect = min(1.0, max(0.0, (max(zs) - min(zs)) / (cell * 0.7)))
            assert abs(r - expect) <= 1e-12
            assert r > 0.0
            break
    else:
        raise AssertionError("spot-check face not found")

    # ------------------------------------------- largest-w wins across corridors
    other = {"pts": [(-1000.0, 40.0), (1000.0, 40.0)],  # E-W corridor at y=40
             "elev": [5.0, 5.0], "half": HALF_W, "pave": PAVE}
    s2 = make_conform_sampler(field, [corridor, other])
    # on corridor A, inside B's shoulder → A's w=1 must win outright (no mixing)
    assert abs(s2(0.0, 20.0) - 2.0) <= 1e-9
    # on corridor B, inside A's shoulder: (20, 40) has d_A=20 (w<1), d_B=0 (w=1)
    assert abs(s2(20.0, 40.0) - 5.0) <= 1e-9

    # elevation lerps along the segment by closest-point t
    ramp = {"pts": [(-50.0, 500.0), (50.0, 500.0)], "elev": [0.0, 10.0],
            "half": HALF_W, "pave": PAVE}
    s3 = make_conform_sampler(field, [ramp])
    assert abs(s3(0.0, 500.0) - 5.0) <= 1e-9      # t=0.5 → lerp(0,10)=5
    assert abs(s3(25.0, 500.0) - 7.5) <= 1e-9     # t=0.75
    assert s3(0.0, 560.0) == 0.0 * 0.05           # far away → natural field

    # ------------------------------------------------- no corridors, low quality
    md2 = build_terrain(field, 50.0, [], "low")
    n2 = int(math.ceil(2 * 50.0 * EXTENT_FACTOR / 10.0))  # 13
    assert len(md2["verts"]) == (n2 + 1) ** 2
    assert len(md2["faces"]) == n2 * n2
    assert all(v[2] == v[0] * 0.05 for v in md2["verts"])  # pure natural field
    assert len(md2["attrs"]["rock"]) == len(md2["faces"])

    # ------------------------------------------------------ quality → cell size
    md3 = build_terrain(field, 20.0, [], "high")
    xs3 = sorted({v[0] for v in md3["verts"]})
    assert abs((xs3[1] - xs3[0]) - 4.0) < 1e-9      # high → 4 m spacing
    assert _cell_for("Medium") == 6.0 and _cell_for("LOW") == 10.0
    assert _cell_for("unknown") == 6.0

    # grid covers at least ±radius*1.25
    assert min(v[0] for v in md3["verts"]) <= -20.0 * 1.25
    assert max(v[1] for v in md3["verts"]) >= 20.0 * 1.25

    # merge_meshdata compatibility (attrs/uvs stay aligned)
    merged = geom.merge_meshdata(geom.new_meshdata(), md2)
    merged = geom.merge_meshdata(merged, md3)
    assert len(merged["faces"]) == len(md2["faces"]) + len(md3["faces"])
    assert len(merged["attrs"]["rock"]) == len(merged["faces"])
    assert len(merged["uvs"]) == len(merged["faces"])

    print(f"terrain med grid: {len(md['verts'])} verts, {len(md['faces'])} quads "
          f"(on={checked_on}, mid={checked_mid}, far={checked_far}), "
          f"rock max={max(rock):.3f}")
    print("ALL TERRAIN SELF-TESTS PASSED")
