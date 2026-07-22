"""Terrain field + road corridor elevation solve.

Port of specs/elevation-terrain.md:
  §A  two-pass projected Gauss-Seidel road elevation solve (`solve`)
  §B  junction consolidation / clustering (inside `solve`)
  §C  terrain height field: fBm hills, riverbed/shore water compositing,
      bake grid + bilinear sample (`build_field`)
plus AWS Terrain Tiles "terrarium" DEM mode with a minimal stdlib PNG decoder.

Coordinates: metres, X=east, Y=north, Z=up (the app spec is Y-up with (x, z)
ground — its ground z maps to our y, its elevation y maps to our z).

Pure module: stdlib + geom only — testable with plain python3.
Determinism: no random/time; geom.hash01 plus the spec's own FNV-1a string
hash for the terrain lattice (§C defines it explicitly, so it is ported
verbatim rather than reusing geom.hash01, which is an int Knuth hash).

Ease-function gotcha (§E): road profiles use COSINE ease, terrain blending
uses CUBIC smoothstep (geom.smoothstep). They are intentionally distinct.
"""
import math
import struct
import sys
import zlib

try:
    from . import geom
except ImportError:  # plain `python3 elevation.py`
    import geom


# ---------------------------------------------------------------------------
# §A constants — road corridor solve
# ---------------------------------------------------------------------------

NON_DRIVABLE = {"pedestrian", "footway", "cycleway"}

# Grade caps by class (fraction rise/run).
GRADE_CAPS = {
    "motorway": 0.04, "trunk": 0.04,
    "primary": 0.06, "secondary": 0.06,
    "tertiary": 0.07,
    "residential": 0.08, "unclassified": 0.08, "living_street": 0.08,
    "service": 0.08,
    "pedestrian": 0.12, "footway": 0.12,
    "cycleway": 0.10,
}
DEFAULT_GRADE = 0.08          # unknown class

MAX_ITERATIONS = 80
TOLERANCE = 1e-4              # convergence on max per-iteration node move (m)
BASE_WEIGHT = 0.25            # pull toward natural-terrain base height
BRIDGE_LAYER_H = 6.5          # deck height per bridge layer (m)
MAX_RAMP_GRADE = 0.06         # app tuning constant, ported for parity
                              # (§A3 ramp lengths use each edge's own cap)

# ---------------------------------------------------------------------------
# §B constants — junction consolidation
# ---------------------------------------------------------------------------

INTERNAL_EDGE_FACTOR = 1.5    # edge contraction: length <= 1.5*(radA+radB)
PROXIMITY_FACTOR = 1.0        # disc overlap: dist <= 1.0*(radA+radB)
Z_GATE_EDGE = 2.0             # max |dz| (m) to contract an internal edge
Z_GATE_PROXIMITY = 1.2        # max |dz| (m) to merge overlapping discs
MAX_SPAN_M = 45.0             # max cluster bbox diagonal incl. disc radii
CLUSTER_CELL = 18.0           # spatial-hash cell (m) for proximity pairs
DISC_RADIUS_FACTOR = 0.58     # disc radius = widest incident width * 0.58

# ---------------------------------------------------------------------------
# §C constants — terrain field
# ---------------------------------------------------------------------------

BAKE_CELL = 12.0              # bake-grid resolution (m)
RELIEF_AMP = 2.6              # peak macro relief away from water (± m)
RELIEF_WAVELENGTH = 230.0     # base wavelength of octave 0 (m)
RELIEF_OCTAVES = 3            # each 1/2 amplitude, 2x frequency
WATER_SURFACE_Z = -1.2        # water plane height (rendered elsewhere)
RIVERBED_Z = -3.0             # ground under water
SHORE_Z = -0.85               # bank lip at water's edge
VALLEY_WIDTH = 150.0          # bank rises shore -> base grade over this
WATER_FLATTEN = 45.0          # within this of water, macro relief flattened

# ---------------------------------------------------------------------------
# DEM (AWS Terrain Tiles, terrarium encoding)
# ---------------------------------------------------------------------------

DEM_ZOOM = 14
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEM_TIMEOUT_S = 20
DEM_MAX_TILES = 12            # bbox should need 2-4 tiles at z14; hard cap
DEM_USER_AGENT = "citybuilder-osm-blender/0.5"


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------

def node_key(p):
    """Half-metre snap node key — SPEC.md: f"{round(x*2)},{round(y*2)}"."""
    return f"{round(p[0] * 2)},{round(p[1] * 2)}"


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _ease_cos(t):
    """COSINE ease for road profiles/ramps (§E). NOT smoothstep."""
    return 0.5 - 0.5 * math.cos(math.pi * _clamp(t, 0.0, 1.0))


def _hermite(t, z0, z1, m0, m1):
    """Cubic Hermite; m0/m1 are tangents scaled by segment length (§A3.4)."""
    t2 = t * t
    t3 = t2 * t
    return ((2 * t3 - 3 * t2 + 1) * z0 + (t3 - 2 * t2 + t) * m0
            + (-2 * t3 + 3 * t2) * z1 + (t3 - t2) * m1)


def _max_grade(cls):
    return GRADE_CAPS.get(cls or "", DEFAULT_GRADE)


def _fnv_hash01(s):
    """FNV-1a string hash -> [0,1) — §C determinism hash, ported verbatim."""
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h / 4294967296.0


# ---------------------------------------------------------------------------
# §C — terrain field
# ---------------------------------------------------------------------------

def _make_fbm(seed):
    """3-octave value-noise fBm in [-1,1]; lattice = FNV-1a of "ix:iy:octave"
    (seed=0 matches the app exactly; a non-zero seed prefixes the key)."""
    cache = {}

    def lattice(ix, iy, octave):
        k = (ix, iy, octave)
        v = cache.get(k)
        if v is None:
            s = (f"{ix}:{iy}:{octave}" if seed == 0
                 else f"{seed}|{ix}:{iy}:{octave}")
            v = _fnv_hash01(s)
            cache[k] = v
        return v

    def value_noise(x, y, wavelength, octave):
        fx = x / wavelength
        fy = y / wavelength
        ix = math.floor(fx)
        iy = math.floor(fy)
        tx = geom.smoothstep(fx - ix)   # cubic blend (terrain only, §E)
        ty = geom.smoothstep(fy - iy)
        a = geom.lerp(lattice(ix, iy, octave), lattice(ix + 1, iy, octave), tx)
        b = geom.lerp(lattice(ix, iy + 1, octave), lattice(ix + 1, iy + 1, octave), tx)
        return geom.lerp(a, b, ty) * 2.0 - 1.0   # map [0,1) -> [-1,1)

    def fbm(x, y):
        total = 0.0
        norm = 0.0
        amp = 1.0
        wl = RELIEF_WAVELENGTH
        for o in range(RELIEF_OCTAVES):
            total += amp * value_noise(x, y, wl, o)
            norm += amp
            amp *= 0.5
            wl *= 0.5
        return total / norm

    return fbm


def _point_in_ring(p, ring):
    """Even-odd raycast point-in-polygon."""
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


def _prep_waters(water_areas):
    """Clean rings, compute bboxes, index all shoreline segments spatially."""
    waters = []
    # Query pad: beyond VALLEY_WIDTH + WATER_FLATTEN the valley term is 0 and
    # the relief mask saturates at 1, so distances past this are equivalent.
    pad = VALLEY_WIDTH + WATER_FLATTEN + 1.0
    grid = geom.SpatialGrid(cell=48.0)
    for a in water_areas or []:
        ring = geom.dedupe_ring(a.get("ring") or [])
        if len(ring) < 3:
            continue
        holes = [geom.dedupe_ring(h) for h in (a.get("holes") or [])]
        holes = [h for h in holes if len(h) >= 3]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        waters.append({"ring": ring, "holes": holes,
                       "bbox": (min(xs), min(ys), max(xs), max(ys))})
        for loop in [ring] + holes:
            n = len(loop)
            for i in range(n):
                grid.insert_segment(loop[i], loop[(i + 1) % n],
                                    (loop[i], loop[(i + 1) % n]))
    return waters, grid, pad


def _inside_water(p, w):
    """In outer ring and not in any hole."""
    if not _point_in_ring(p, w["ring"]):
        return False
    for h in w["holes"]:
        if _point_in_ring(p, h):
            return False
    return True


def _height_at(x, y, waters, edge_grid, edge_pad, relief):
    """§C heightAt — riverbed / shore valley / masked relief composition."""
    reach = VALLEY_WIDTH + 4.0
    p = (x, y)
    near = []
    for w in waters:
        bx0, by0, bx1, by1 = w["bbox"]
        if bx0 - reach <= x <= bx1 + reach and by0 - reach <= y <= by1 + reach:
            near.append(w)
    for w in near:
        if _inside_water(p, w):
            return RIVERBED_Z
    if near:
        # min point-to-segment distance to ring/hole edges (spatially pruned;
        # if nothing within edge_pad both valley and mask are saturated, so
        # substituting d=edge_pad is exact).
        d = edge_pad
        for a, b in edge_grid.query(x, y, pad=edge_pad):
            dd = geom.seg_point_dist(p, a, b)[0]
            if dd < d:
                d = dd
        valley = SHORE_Z + (0.0 - SHORE_Z) * geom.smoothstep(d / VALLEY_WIDTH)
        mask = geom.smoothstep((d - WATER_FLATTEN) / VALLEY_WIDTH)
        return valley + relief(x, y) * mask
    # Outside every water bbox+reach: farFromWater=True, valley=0 (§C).
    return relief(x, y)


def _bake_sampler(height_at, extent):
    """Bake a grid at BAKE_CELL over ±extent; bilinear sample, clamped edges."""
    cell = BAKE_CELL
    n = max(2, int(math.ceil((2.0 * extent) / cell)) + 1)
    x0 = -extent
    y0 = -extent
    rows = []
    for j in range(n):
        y = y0 + j * cell
        rows.append([height_at(x0 + i * cell, y) for i in range(n)])

    def sample(x, y):
        fx = _clamp((x - x0) / cell, 0.0, n - 1.0)
        fy = _clamp((y - y0) / cell, 0.0, n - 1.0)
        i = min(int(fx), n - 2)
        j = min(int(fy), n - 2)
        tx = fx - i
        ty = fy - j
        r0 = rows[j]
        r1 = rows[j + 1]
        return geom.lerp(geom.lerp(r0[i], r0[i + 1], tx),
                         geom.lerp(r1[i], r1[i + 1], tx), ty)

    return sample


class Field:
    """Elevation field: .sample(x, y) -> z (m), .mode in flat|hills|dem.

    base_sample is identical to sample — this is the NATURAL field; the
    road-conformed field lives in terrain.py (SPEC.md ElevationField rule).
    """
    __slots__ = ("mode", "_sample")

    def __init__(self, mode, sample_fn):
        self.mode = mode
        self._sample = sample_fn

    def sample(self, x, y):
        return self._sample(x, y)

    def base_sample(self, x, y):
        return self._sample(x, y)


def build_field(mode, radius, water_areas, seed=0, center_lat=None,
                center_lon=None, to_xy=None):
    """Build the scene elevation field (SPEC.md `elevation.py` contract).

    mode: "flat" | "hills" | "dem".  water_areas: rendered water only,
    [{"ring": [(x,y)], "holes": [rings]}].  `to_xy` is accepted for contract
    parity (the DEM inverse projection uses the same equirectangular math as
    geom.make_projector directly).

    DEM mode fetches AWS terrarium tiles; ANY network/decode failure logs to
    stderr and falls back to hills — never raises.  DEM/flat modes keep the
    §C water compositing; only the fbm relief term is replaced (dem) or
    zeroed (flat).
    """
    if mode not in ("flat", "hills", "dem"):
        print(f"[elevation] unknown field mode {mode!r}; using flat",
              file=sys.stderr)
        mode = "flat"
    waters, edge_grid, edge_pad = _prep_waters(water_areas)
    # Cover the terrain grid (±radius*1.25 per SPEC terrain.py) plus margin;
    # clamped-edge sampling extends beyond.
    extent = radius * 1.25 + 2.0 * BAKE_CELL

    relief = None
    if mode == "dem":
        if center_lat is None or center_lon is None:
            print("[elevation] DEM mode needs center_lat/lon; "
                  "falling back to hills", file=sys.stderr)
            mode = "hills"
        else:
            try:
                relief = _dem_relief(center_lat, center_lon, extent)
            except Exception as exc:  # noqa: BLE001 — contract: never raise
                print(f"[elevation] DEM fetch failed ({exc}); "
                      "falling back to hills", file=sys.stderr)
                mode = "hills"
    if mode == "hills":
        fbm = _make_fbm(seed)
        relief = (lambda x, y: fbm(x, y) * RELIEF_AMP)
    elif mode == "flat":
        relief = (lambda x, y: 0.0)

    if mode == "flat" and not waters:
        return Field("flat", lambda x, y: 0.0)   # nothing to bake

    sample = _bake_sampler(
        lambda x, y: _height_at(x, y, waters, edge_grid, edge_pad, relief),
        extent)
    return Field(mode, sample)


# ---------------------------------------------------------------------------
# Minimal stdlib PNG decoder (8-bit RGB/RGBA, non-interlaced, filters 0-4)
# ---------------------------------------------------------------------------

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _png_decode(data):
    """PNG bytes -> (width, height, channels, pixel bytes row-major).

    Supports exactly what terrarium tiles use: 8-bit RGB/RGBA truecolor,
    non-interlaced, all five scanline filter types. Raises ValueError on
    anything else (caller falls back to hills mode).
    """
    if data[:8] != _PNG_SIG:
        raise ValueError("not a PNG")
    pos = 8
    w = h = ch = None
    idat = bytearray()
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length            # length + type + data + CRC
        if ctype == b"IHDR":
            w, h, depth, color, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", body)
            if depth != 8 or color not in (2, 6) or comp != 0 or filt != 0 \
                    or interlace != 0:
                raise ValueError(
                    f"unsupported PNG depth={depth} color={color} "
                    f"interlace={interlace}")
            ch = 3 if color == 2 else 4
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
    if w is None or ch is None or not idat:
        raise ValueError("truncated PNG")
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    if len(raw) < h * (stride + 1):
        raise ValueError("short PNG scanline data")
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for row in range(h):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if f == 0:
            pass
        elif f == 1:                                     # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif f == 2:                                     # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:                                     # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:                                     # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                c = prev[i - ch] if i >= ch else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        else:
            raise ValueError(f"bad PNG filter {f}")
        out[row * stride:(row + 1) * stride] = line
        prev = line
    return w, h, ch, bytes(out)


# ---------------------------------------------------------------------------
# DEM sampling (terrarium tiles)
# ---------------------------------------------------------------------------

def _terrarium_elev(r, g, b):
    """Terrarium RGB -> metres: (R*256 + G + B/256) - 32768."""
    return r * 256.0 + g + b / 256.0 - 32768.0


def _lonlat_to_tile(lat, lon, z=DEM_ZOOM):
    """Fractional slippy tile coordinates (x east, y south from N pole)."""
    n = float(1 << z)
    xt = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    yt = (1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n
    return xt, yt


def _dem_relief(center_lat, center_lon, extent_m):
    """Fetch terrarium tiles covering the bbox; return relief(x, y) -> metres
    normalised so the scene centre sits at 0. Raises on any failure."""
    import urllib.request

    south, west, north, east = geom.bbox_around(center_lat, center_lon,
                                                extent_m)
    xa, ya = _lonlat_to_tile(north, west)
    xb, yb = _lonlat_to_tile(south, east)
    tx0, tx1 = int(math.floor(min(xa, xb))), int(math.floor(max(xa, xb)))
    ty0, ty1 = int(math.floor(min(ya, yb))), int(math.floor(max(ya, yb)))
    count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    if count > DEM_MAX_TILES:
        raise ValueError(f"bbox needs {count} tiles (> {DEM_MAX_TILES})")

    tiles = {}
    tile_px = None
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            url = DEM_URL.format(z=DEM_ZOOM, x=tx, y=ty)
            req = urllib.request.Request(
                url, headers={"User-Agent": DEM_USER_AGENT})
            with urllib.request.urlopen(req, timeout=DEM_TIMEOUT_S) as resp:
                blob = resp.read()
            w, h, ch, px = _png_decode(blob)
            if w != h or (tile_px is not None and w != tile_px):
                raise ValueError(f"unexpected tile size {w}x{h}")
            tile_px = w
            tiles[(tx, ty)] = (ch, px)

    t = tile_px
    px_min, px_max = tx0 * t, (tx1 + 1) * t - 1
    py_min, py_max = ty0 * t, (ty1 + 1) * t - 1

    def pixel(ix, iy):
        ch, px = tiles[(ix // t, iy // t)]
        off = ((iy % t) * t + (ix % t)) * ch
        return _terrarium_elev(px[off], px[off + 1], px[off + 2])

    def elev_ll(lat, lon):
        xt, yt = _lonlat_to_tile(lat, lon)
        # global pixel coords, sampling at pixel centres, clamped to mosaic
        gx = _clamp(xt * t - 0.5, px_min, px_max)
        gy = _clamp(yt * t - 0.5, py_min, py_max)
        ix = min(int(math.floor(gx)), px_max - 1)
        iy = min(int(math.floor(gy)), py_max - 1)
        fx = gx - ix
        fy = gy - iy
        v0 = geom.lerp(pixel(ix, iy), pixel(ix + 1, iy), fx)
        v1 = geom.lerp(pixel(ix, iy + 1), pixel(ix + 1, iy + 1), fx)
        return geom.lerp(v0, v1, fy)

    center_h = elev_ll(center_lat, center_lon)
    m_per_lon = geom.M_PER_DEG_LAT * math.cos(math.radians(center_lat))

    def relief(x, y):
        # inverse of geom.make_projector (equirectangular around centre)
        lat = center_lat + y / geom.M_PER_DEG_LAT
        lon = center_lon + x / m_per_lon
        return elev_ll(lat, lon) - center_h

    return relief


# ---------------------------------------------------------------------------
# §A — road graph build + node relaxation + edge grades
# ---------------------------------------------------------------------------

def _build_graph(roads, alias):
    """§A graph build. Returns (nodes, edges, internal_road_idxs).

    nodes[key] = {"p", "inc": [{"edge", "end", "far", "length"}],
                  "has_surface", "b_elev", "pin"}
    edges[road_idx] = {"start", "end", "length", "max_grade", "bridge",
                       "b_elev", "width"}
    """
    nodes = {}
    edges = {}
    internal = set()
    for idx, r in enumerate(roads):
        pts = r.get("pts") or []
        cls = r.get("class")
        if cls in NON_DRIVABLE or r.get("tunnel") or len(pts) < 2:
            continue   # falls through to legacy profile (§A6)
        raw_s = node_key(pts[0])
        raw_e = node_key(pts[-1])
        ks = alias.get(raw_s, raw_s)
        ke = alias.get(raw_e, raw_e)
        if ks == ke:
            if raw_s != raw_e:
                internal.add(idx)   # junction-interior link (cluster collapse)
            continue                # degenerate self-loop → skip
        length = geom.arc_lengths(pts)[-1]
        if length < 1e-3:
            continue
        bridge = bool(r.get("bridge"))
        b_elev = max(r.get("layer") or 0, 1) * BRIDGE_LAYER_H if bridge else 0.0
        edges[idx] = {
            "start": ks, "end": ke, "length": length,
            "max_grade": _max_grade(cls), "bridge": bridge,
            "b_elev": b_elev, "width": float(r.get("width") or 0.0),
        }
        for key, p, far, end in ((ks, pts[0], ke, 0), (ke, pts[-1], ks, 1)):
            nd = nodes.get(key)
            if nd is None:
                nd = nodes[key] = {"p": p, "inc": [], "has_surface": False,
                                   "b_elev": 0.0}
            nd["inc"].append({"edge": idx, "end": end, "far": far,
                              "length": length})
            nd["has_surface"] = nd["has_surface"] or not bridge
            nd["b_elev"] = max(nd["b_elev"], b_elev)
    # Pin: a node touched only by bridge edges sits at deck height; any
    # at-grade edge frees it.
    for nd in nodes.values():
        nd["pin"] = (nd["b_elev"]
                     if nd["b_elev"] > 0 and not nd["has_surface"] else None)
    return nodes, edges, internal


def _relax(nodes, edges, field):
    """§A1 projected Gauss-Seidel. Returns (z, iterations, converged)."""
    base = {}
    z = {}
    for key, nd in nodes.items():
        base[key] = field.sample(nd["p"][0], nd["p"][1]) if field else 0.0
        z[key] = nd["pin"] if nd["pin"] is not None else base[key]
    keys = sorted(nodes)
    it = 0
    converged = False
    for it in range(1, MAX_ITERATIONS + 1):
        max_move = 0.0
        for key in keys:
            nd = nodes[key]
            if nd["pin"] is not None:
                continue
            num = BASE_WEIGHT * base[key]
            den = BASE_WEIGHT
            lo = -math.inf
            hi = math.inf
            for inc in nd["inc"]:
                zj = z[inc["far"]]
                w = 1.0 / inc["length"]
                num += w * zj
                den += w
                span = edges[inc["edge"]]["max_grade"] * inc["length"]
                lo = max(lo, zj - span)
                hi = min(hi, zj + span)
            target = num / den
            nxt = _clamp(target, lo, hi) if lo <= hi else (lo + hi) / 2.0
            move = abs(nxt - z[key])
            if move > max_move:
                max_move = move
            z[key] = nxt
        if max_move < TOLERANCE:
            converged = True
            break
    return z, it, converged


def _edge_grades(nodes, edges, z):
    """§A2 — per-edge {start, end} grades (dz/ds measured start→end)."""
    out = {key: {} for key in nodes}
    for key in sorted(nodes):
        inc = nodes[key]["inc"]
        if len(inc) == 2 and inc[0]["edge"] != inc[1]["edge"]:
            # joint: shared through-tangent (C1 across the pair)
            a, b = inc
            m = (z[b["far"]] - z[a["far"]]) / (a["length"] + b["length"])
            cap_a = edges[a["edge"]]["max_grade"]
            cap_b = edges[b["edge"]]["max_grade"]
            out[key][a["edge"]] = _clamp(-m, -cap_a, cap_a)
            out[key][b["edge"]] = _clamp(m, -cap_b, cap_b)
        else:
            for i in inc:
                cap = edges[i["edge"]]["max_grade"]
                g = (z[i["far"]] - z[key]) / i["length"]
                out[key][i["edge"]] = _clamp(g, -cap, cap)
    grades = {}
    for eid, e in edges.items():
        grades[eid] = {"start": out[e["start"]].get(eid, 0.0),
                       "end": -(out[e["end"]].get(eid, 0.0))}
    return grades


# ---------------------------------------------------------------------------
# §B — junction consolidation
# ---------------------------------------------------------------------------

def _cluster_junctions(nodes, edges, z):
    """§B — union-find clustering. Returns (alias, clusters)."""
    # Disc radius per node from widest incident edge.
    rad = {}
    for key, nd in nodes.items():
        maxw = 0.0
        for i in nd["inc"]:
            w = edges[i["edge"]]["width"]
            if w > maxw:
                maxw = w
        rad[key] = maxw * DISC_RADIUS_FACTOR

    parent = {k: k for k in nodes}
    boxes = {k: (nodes[k]["p"][0] - rad[k], nodes[k]["p"][1] - rad[k],
                 nodes[k]["p"][0] + rad[k], nodes[k]["p"][1] + rad[k])
             for k in nodes}

    def find(k):
        root = k
        while parent[root] != root:
            root = parent[root]
        while parent[k] != root:       # path compression
            parent[k], k = root, parent[k]
        return root

    def try_union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        ba, bb = boxes[ra], boxes[rb]
        box = (min(ba[0], bb[0]), min(ba[1], bb[1]),
               max(ba[2], bb[2]), max(ba[3], bb[3]))
        if math.hypot(box[2] - box[0], box[3] - box[1]) > MAX_SPAN_M:
            return                     # cluster would sprawl — reject
        root, child = (ra, rb) if ra < rb else (rb, ra)   # lexicographic
        parent[child] = root
        boxes[root] = box

    cands = []
    # Rule 1 — internal-edge contraction.
    for eid in sorted(edges):
        e = edges[eid]
        a, b = e["start"], e["end"]
        if (len(nodes[a]["inc"]) >= 2 and len(nodes[b]["inc"]) >= 2
                and e["length"] <= INTERNAL_EDGE_FACTOR * (rad[a] + rad[b])
                and abs(z[a] - z[b]) <= Z_GATE_EDGE):
            lo, hi = (a, b) if a < b else (b, a)
            cands.append((e["length"], lo, hi))
    # Rule 2 — proximity between junction-degree (>=3) nodes.
    cells = {}
    for key in sorted(nodes):
        if len(nodes[key]["inc"]) >= 3:
            px, py = nodes[key]["p"]
            cell = (int(math.floor(px / CLUSTER_CELL)),
                    int(math.floor(py / CLUSTER_CELL)))
            cells.setdefault(cell, []).append(key)
    seen = set()
    for (cx, cy) in sorted(cells):
        for a in cells[(cx, cy)]:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for b in cells.get((cx + dx, cy + dy), ()):
                        if b <= a:
                            continue
                        if (a, b) in seen:
                            continue
                        pa, pb = nodes[a]["p"], nodes[b]["p"]
                        d = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
                        if (d <= PROXIMITY_FACTOR * (rad[a] + rad[b])
                                and abs(z[a] - z[b]) <= Z_GATE_PROXIMITY):
                            seen.add((a, b))
                            cands.append((d, a, b))

    cands.sort()
    for _, a, b in cands:
        try_union(a, b)

    groups = {}
    for k in sorted(nodes):
        groups.setdefault(find(k), []).append(k)
    alias = {}
    clusters = {}
    for root, members in groups.items():
        if len(members) >= 2:
            clusters[root] = sorted(members)
            for m in members:
                if m != root:
                    alias[m] = root
    return alias, clusters


# ---------------------------------------------------------------------------
# Solve object + driver
# ---------------------------------------------------------------------------

class Solve:
    """Result of the two-pass road elevation solve (SPEC.md contract)."""

    def __init__(self, roads, node_z, alias, clusters, internal, edges,
                 grades, grounded, stats):
        self._roads = roads
        self.node_z = node_z       # {canonical_key: z}
        self.alias = alias         # {raw_key: canonical_key}
        self.clusters = clusters   # {canonical: [member keys]}
        self.internal = internal   # set(road_idx)
        self.stats = stats         # {"iterations", "converged", "clusters"}
        self._edges = edges
        self._grades = grades
        self._grounded = grounded  # raw endpoint keys of at-grade ways

    def key_of(self, pt):
        k = node_key(pt)
        return self.alias.get(k, k)

    def z_at(self, pt):
        return self.node_z.get(self.key_of(pt), 0.0)

    def profile(self, road_idx, cum):
        """Per-station elevation along a road; cum = geom.arc_lengths(pts)
        of THAT road's (possibly densified) pts."""
        r = self._roads[road_idx]
        pts = r.get("pts") or []
        n = len(cum)
        if road_idx in self.internal:
            # §A3.1 — flat at cluster height, the junction pad is its surface
            return [self.z_at(pts[0])] * n
        e = self._edges.get(road_idx)
        if e is None:
            return self._legacy_profile(r, cum)          # §A6
        L = cum[-1]
        z0 = self.node_z[e["start"]]
        z1 = self.node_z[e["end"]]
        if e["bridge"]:
            # §A3.3 — eased hump/deck, COSINE ease
            full = e["b_elev"]
            ramp = min(max(full / e["max_grade"], 40.0), max(L * 0.45, 20.0))
            out = []
            for d in cum:
                up = z0 + (full - z0) * _ease_cos(d / ramp)
                down = z1 + (full - z1) * _ease_cos((L - d) / ramp)
                out.append(min(up, down))
            return out
        # §A3.4 — C1 cubic Hermite between solved node heights
        g = self._grades.get(road_idx, {"start": 0.0, "end": 0.0})
        m0 = g["start"] * L
        m1 = g["end"] * L
        if L <= 0:
            return [z0] * n
        return [_hermite(d / L, z0, z1, m0, m1) for d in cum]

    def _base_along(self, pts, cum):
        """NATURAL terrain sampled at each cum distance along the raw polyline.

        The app composes every surface as terrain + added elevation; a flat-0
        path floats above hills and buries below valleys (the Cable Street
        cycle-track bug), so the fallback must ride the field.
        """
        field = getattr(self, "_field", None)
        if field is None or len(pts) < 2:
            return [0.0] * len(cum)
        raw = geom.arc_lengths(pts)
        out = []
        j = 1
        for d in cum:
            while j < len(raw) - 1 and raw[j] < d:
                j += 1
            span = raw[j] - raw[j - 1]
            t = 0.0 if span <= 0 else max(0.0, min(1.0, (d - raw[j - 1]) / span))
            x = pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t
            y = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t
            out.append(field.sample(x, y))
        return out

    def _legacy_profile(self, r, cum):
        """§A6 legacy per-segment ramp fallback (paths/tunnels/degenerate),
        terrain-relative: at-grade paths follow the ground; path bridges ramp
        from their grounded end heights up to base + deck."""
        n = len(cum)
        L = cum[-1] if cum else 0.0
        pts = r.get("pts") or []
        base = self._base_along(pts, cum) if pts else [0.0] * n
        if not r.get("bridge") or L <= 0 or len(pts) < 2:
            return base
        cap = _max_grade(r.get("class"))
        # short spans cannot reach full deck height at legal grade
        added = min(max(r.get("layer") or 0, 1) * BRIDGE_LAYER_H,
                    cap * L / math.pi)
        full = max(base[0], base[-1]) + added
        ramp = min(max(added / cap, 40.0), max(L * 0.45, 20.0))
        s0 = base[0] if node_key(pts[0]) in self._grounded else full
        s1 = base[-1] if node_key(pts[-1]) in self._grounded else full
        out = []
        for i, d in enumerate(cum):
            up = s0 + (full - s0) * _ease_cos(d / ramp)
            down = s1 + (full - s1) * _ease_cos((L - d) / ramp)
            out.append(max(min(up, down), base[i]))
        return out


def solve(roads, field):
    """Two-pass road elevation solve (§A + §B) against the NATURAL field.

    Pass 1 solves on the raw graph, clustering then judges junction merges at
    solved heights (§B), and if any clusters formed the graph is rebuilt with
    the alias map and re-solved so each bridgehead sits at ONE height.
    """
    nodes1, edges1, internal1 = _build_graph(roads, {})
    z1, it1, conv1 = _relax(nodes1, edges1, field)
    alias, clusters = _cluster_junctions(nodes1, edges1, z1)
    if alias:
        nodes, edges, internal = _build_graph(roads, alias)
        z, it, conv = _relax(nodes, edges, field)
    else:
        nodes, edges, internal = nodes1, edges1, internal1
        z, it, conv = z1, it1, conv1
    grades = _edge_grades(nodes, edges, z)

    # Grounded raw keys — endpoints of any at-grade (non-bridge, non-tunnel)
    # way; used by the legacy ramp fallback (§A6).
    grounded = set()
    for r in roads:
        pts = r.get("pts") or []
        if len(pts) >= 2 and not r.get("bridge") and not r.get("tunnel"):
            grounded.add(node_key(pts[0]))
            grounded.add(node_key(pts[-1]))

    stats = {"iterations": it, "converged": conv, "clusters": len(clusters)}
    out = Solve(roads, z, alias, clusters, internal, edges, grades,
                grounded, stats)
    out._field = field  # legacy path profiles ride the terrain field
    return out


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    def _finite(v):
        return not (math.isnan(v) or math.isinf(v))

    # ------------------------------------------------------------------ (1)
    # Hills field: deterministic, |z| <= RELIEF_AMP away from water,
    # exactly RIVERBED_Z inside a water ring; flat mode composites water too.
    water = [{"ring": [(-60, -60), (60, -60), (60, 60), (-60, 60)],
              "holes": []}]
    f1 = build_field("hills", 400, water)
    f2 = build_field("hills", 400, water)
    assert f1.mode == "hills"
    probes = [(x, y) for x in range(-480, 481, 37) for y in range(-480, 481, 41)]
    for p in probes:
        a = f1.sample(*p)
        assert _finite(a), f"NaN/inf at {p}"
        assert a == f2.sample(*p), f"non-deterministic at {p}"
        assert a == f1.base_sample(*p)
    assert f1.sample(0.0, 0.0) == RIVERBED_Z, "centre of water must be riverbed"
    assert f1.sample(15.0, -20.0) == RIVERBED_Z
    # far from water (>= bbox 60 + reach 154 + bilinear cell 12)
    for p in [(300, 300), (-350, 280), (410, -60), (-90, -400), (460, 0)]:
        v = f1.sample(*p)
        assert abs(v) <= RELIEF_AMP + 1e-9, f"relief bound broken at {p}: {v}"
    # relief actually varies (not degenerate)
    far_vals = {round(f1.sample(200 + 31 * i, -300 - 17 * i), 6) for i in range(8)}
    assert len(far_vals) > 1, "hills relief is constant?"
    # seed changes the field
    g0 = build_field("hills", 200, [], seed=0)
    g7 = build_field("hills", 200, [], seed=7)
    assert any(g0.sample(*p) != g7.sample(*p)
               for p in [(10, 10), (50, -80), (-120, 60)])
    # flat mode: water compositing without relief
    ff = build_field("flat", 400, water)
    assert ff.mode == "flat"
    assert ff.sample(0, 0) == RIVERBED_Z
    assert ff.sample(300, 300) == 0.0
    shore = ff.sample(0, 66)   # just outside the bank — inside valley blend
    assert SHORE_Z - 1e-9 <= shore <= 0.0, shore
    assert build_field("flat", 400, []).sample(123, -456) == 0.0
    print("test 1 OK  (hills/flat field: determinism, bounds, riverbed)")

    # ------------------------------------------------------------------ (2)
    # Synthetic + junction of 4 roads on hills: converged, grade caps held.
    hills = build_field("hills", 400, [])
    plus_roads = [
        {"class": "residential", "width": 8, "pts": [(0, 0), (120, 0)]},
        {"class": "residential", "width": 8, "pts": [(0, 0), (-120, 0)]},
        {"class": "residential", "width": 8, "pts": [(0, 0), (0, 120)]},
        {"class": "residential", "width": 8, "pts": [(0, 0), (0, -120)]},
    ]
    sv = solve(plus_roads, hills)
    assert sv.stats["converged"] is True
    assert sv.stats["iterations"] <= MAX_ITERATIONS
    assert sv.stats["clusters"] == 0
    assert len(sv._edges) == 4
    for eid, e in sv._edges.items():
        dz = abs(sv.node_z[e["start"]] - sv.node_z[e["end"]])
        assert dz / e["length"] <= e["max_grade"] + 1e-3, \
            f"edge {eid} grade {dz / e['length']:.5f} > cap {e['max_grade']}"
    for i, r in enumerate(plus_roads):
        cum = geom.arc_lengths(r["pts"])
        prof = sv.profile(i, cum)
        assert len(prof) == len(cum)
        assert all(_finite(v) for v in prof)
        assert abs(prof[0] - sv.z_at(r["pts"][0])) < 1e-9
        assert abs(prof[-1] - sv.z_at(r["pts"][-1])) < 1e-9
        g = sv._grades[i]
        cap = sv._edges[i]["max_grade"]
        assert abs(g["start"]) <= cap + 1e-12 and abs(g["end"]) <= cap + 1e-12
    # joint (degree 2) C1 continuity: end grade of A == start grade of B
    chain = [
        {"class": "tertiary", "width": 7, "pts": [(-180, 20), (0, 0)]},
        {"class": "tertiary", "width": 7, "pts": [(0, 0), (170, -30)]},
    ]
    svc = solve(chain, hills)
    assert svc.stats["converged"] is True
    assert abs(svc._grades[0]["end"] - svc._grades[1]["start"]) < 1e-12
    print("test 2 OK  (+ junction on hills: converged, caps, C1 joints)")

    # ------------------------------------------------------------------ (3)
    # 2-point bridge road (layer 1): profile peaks at 6.5 m, symmetric.
    flatf = build_field("flat", 400, [])
    br_roads = [
        {"class": "residential", "width": 8, "pts": [(-150, 0), (150, 0)],
         "bridge": True, "layer": 1},
        {"class": "residential", "width": 8, "pts": [(-200, 0), (-150, 0)]},
        {"class": "residential", "width": 8, "pts": [(200, 0), (150, 0)]},
    ]
    svb = solve(br_roads, flatf)
    assert svb.stats["converged"] is True
    dpts, _ = geom.densify_polyline(br_roads[0]["pts"], 8.0)  # §A5 bridge 8 m
    cum = geom.arc_lengths(dpts)
    prof = svb.profile(0, cum)
    assert all(_finite(v) for v in prof)
    assert abs(max(prof) - BRIDGE_LAYER_H) < 1e-9, max(prof)
    npf = len(prof)
    for i in range(npf):
        assert abs(prof[i] - prof[npf - 1 - i]) < 1e-9, "asymmetric hump"
    assert abs(prof[0]) < 1e-9 and abs(prof[-1]) < 1e-9
    assert prof[1] > prof[0], "ramp should rise off the abutment"
    # lone bridge (no at-grade touch): ends pinned to deck height, flat 6.5
    sv_lone = solve([br_roads[0]], flatf)
    prof_lone = sv_lone.profile(0, cum)
    assert max(prof_lone) == min(prof_lone) == BRIDGE_LAYER_H
    # legacy fallback: a footway bridge is not a corridor edge, grounded ends
    leg = [{"class": "footway", "width": 2,
            "pts": [(0, 0), (60, 0)], "bridge": True, "layer": 1},
           {"class": "residential", "width": 6, "pts": [(0, 0), (0, -50)]},
           {"class": "residential", "width": 6, "pts": [(60, 0), (60, 50)]}]
    svl = solve(leg, flatf)
    assert 0 not in svl._edges                     # footway → legacy path
    lcum = geom.arc_lengths(geom.densify_polyline(leg[0]["pts"], 8.0)[0])
    lprof = svl.profile(0, lcum)
    cap_ = GRADE_CAPS["footway"]
    full_ = min(BRIDGE_LAYER_H, cap_ * lcum[-1] / math.pi)  # short-span cap
    assert abs(max(lprof) - full_) < 1e-9
    assert abs(lprof[0]) < 1e-9 and abs(lprof[-1]) < 1e-9
    print("test 3 OK  (bridge hump 6.5 m symmetric; pinned deck; legacy ramp)")

    # ------------------------------------------------------------------ (4)
    # Two junction nodes 8 m apart cluster to one canonical key.
    cl_roads = [
        {"class": "residential", "width": 8, "pts": [(0, 0), (8, 0)]},   # link
        {"class": "residential", "width": 8, "pts": [(0, 0), (-60, 0)]},
        {"class": "residential", "width": 8, "pts": [(0, 0), (0, 60)]},
        {"class": "residential", "width": 8, "pts": [(0, 0), (0, -60)]},
        {"class": "residential", "width": 8, "pts": [(8, 0), (68, 0)]},
        {"class": "residential", "width": 8, "pts": [(8, 0), (8, 60)]},
        {"class": "residential", "width": 8, "pts": [(8, 0), (8, -60)]},
    ]
    svk = solve(cl_roads, flatf)
    assert svk.stats["clusters"] == 1
    assert svk.key_of((0, 0)) == svk.key_of((8, 0)) == "0,0"
    assert svk.alias == {"16,0": "0,0"}
    assert svk.clusters == {"0,0": ["0,0", "16,0"]}
    assert svk.internal == {0}, svk.internal       # link collapsed → internal
    zc = svk.node_z["0,0"]
    iprof = svk.profile(0, geom.arc_lengths(cl_roads[0]["pts"]))
    assert iprof == [zc, zc]                       # flat at cluster height
    assert svk.z_at((8, 0)) == zc
    # far apart junctions must NOT merge (16 m > radA+radB = 9.28)
    far_roads = [dict(r) for r in cl_roads]
    far_roads[0] = {"class": "residential", "width": 8, "pts": [(0, 0), (16, 0)]}
    for r in far_roads[4:]:
        r["pts"] = [(p[0] + 8, p[1]) for p in r["pts"]]
    svf = solve(far_roads, flatf)
    assert svf.stats["clusters"] == 0 and svf.alias == {}
    print("test 4 OK  (8 m junction pair clusters; internal link; 16 m does not)")

    # ------------------------------------------------------------------ (5)
    # PNG decoder round-trip (encoder built here; exercises filters 0-4)
    # and terrarium decode. No network in tests.
    def _encode_png(w, h, ch, pix, filters):
        stride = w * ch
        raw = bytearray()
        prev = bytes(stride)
        for row in range(h):
            f = filters[row % len(filters)]
            line = pix[row * stride:(row + 1) * stride]
            raw.append(f)
            if f == 0:
                raw += line
            elif f == 1:
                raw += bytes((line[i] - (line[i - ch] if i >= ch else 0)) & 0xFF
                             for i in range(stride))
            elif f == 2:
                raw += bytes((line[i] - prev[i]) & 0xFF for i in range(stride))
            elif f == 3:
                raw += bytes((line[i] - (((line[i - ch] if i >= ch else 0)
                                          + prev[i]) >> 1)) & 0xFF
                             for i in range(stride))
            else:
                raw += bytes((line[i] - _paeth(line[i - ch] if i >= ch else 0,
                                               prev[i],
                                               prev[i - ch] if i >= ch else 0))
                             & 0xFF for i in range(stride))
            prev = line

        def chunk(ctype, body):
            return (struct.pack(">I", len(body)) + ctype + body
                    + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF))

        ihdr = struct.pack(">IIBBBBB", w, h, 8, 2 if ch == 3 else 6, 0, 0, 0)
        return (_PNG_SIG + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(bytes(raw)))
                + chunk(b"IEND", b""))

    for (w_, h_, ch_) in [(8, 7, 3), (6, 5, 4), (1, 1, 3)]:
        pix = bytes(int(geom.hash01(i * 7 + 1) * 256) & 0xFF
                    for i in range(w_ * h_ * ch_))
        blob = _encode_png(w_, h_, ch_, pix, filters=[0, 1, 2, 3, 4])
        dw, dh, dch, dpix = _png_decode(blob)
        assert (dw, dh, dch) == (w_, h_, ch_)
        assert dpix == pix, f"round-trip failed for {w_}x{h_}x{ch_}"
    # unsupported flavours must raise (caller falls back to hills)
    try:
        _png_decode(b"not a png at all")
        raise AssertionError("decoder accepted garbage")
    except ValueError:
        pass
    # terrarium decode: (R*256 + G + B/256) - 32768
    assert _terrarium_elev(128, 0, 0) == 0.0
    assert _terrarium_elev(128, 1, 128) == 1.5
    assert _terrarium_elev(0, 0, 0) == -32768.0
    # slippy tile math sanity: lon 0 at z14 → tile x = 8192 boundary
    xt, yt = _lonlat_to_tile(0.0, 0.0)
    assert abs(xt - 8192.0) < 1e-9 and abs(yt - 8192.0) < 1e-9
    # the two ease functions are distinct (§E) and hit their anchors
    assert _ease_cos(0.0) == 0.0 and _ease_cos(1.0) == 1.0
    assert abs(_ease_cos(0.5) - 0.5) < 1e-12
    assert abs(_ease_cos(0.25) - geom.smoothstep(0.25)) > 1e-3
    print("test 5 OK  (PNG round-trip all filters, terrarium decode, eases)")

    print("ALL ELEVATION SELF-TESTS PASSED")
