"""Pure geometry helpers — no bpy imports, unit-testable outside Blender.

Ports of src/procgen/geometry.ts + src/ingest helpers. Coordinates are metres,
X = east, Y = north (Blender Z-up scenes use these directly as x/y).
"""
import math

M_PER_DEG_LAT = 111_320.0


def make_projector(center_lat: float, center_lon: float):
    """Equirectangular projection around the scene center (same as overpassFetch.ts)."""
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(center_lat))

    def to_xy(lat: float, lon: float):
        return ((lon - center_lon) * m_per_deg_lon, (lat - center_lat) * M_PER_DEG_LAT)

    return to_xy


def bbox_around(lat: float, lon: float, radius_m: float):
    """(south, west, north, east) of a radius_m half-size box around a point."""
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / (M_PER_DEG_LAT * max(0.01, math.cos(math.radians(lat))))
    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)


def ring_area_m2(ring) -> float:
    """Unsigned shoelace area of a ring of (x, y) points."""
    return abs(ring_area_signed(ring))


def ring_area_signed(ring) -> float:
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def dedupe_ring(ring, eps=1e-6):
    """Drop consecutive duplicates and a closing point equal to the first."""
    out = []
    for p in ring:
        if not out or abs(p[0] - out[-1][0]) > eps or abs(p[1] - out[-1][1]) > eps:
            out.append(p)
    if len(out) >= 2 and abs(out[0][0] - out[-1][0]) <= eps and abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def offset_polyline(pts, d: float):
    """Offset a polyline sideways by d (positive = left of travel), mitred joins.

    Port of procgen/geometry.ts offsetPolyline — miter length clamped to 2×|d|
    so hairpin joins don't explode.
    """
    n = len(pts)
    if n < 2:
        return list(pts)
    dirs = []
    for i in range(n - 1):
        dx = pts[i + 1][0] - pts[i][0]
        dy = pts[i + 1][1] - pts[i][1]
        ln = math.hypot(dx, dy) or 1.0
        dirs.append((dx / ln, dy / ln))
    out = []
    for i in range(n):
        if i == 0:
            tx, ty = dirs[0]
        elif i == n - 1:
            tx, ty = dirs[-1]
        else:
            ax, ay = dirs[i - 1]
            bx, by = dirs[i]
            tx, ty = ax + bx, ay + by
            ln = math.hypot(tx, ty)
            if ln < 1e-9:  # 180° reversal — fall back to one segment's direction
                tx, ty = bx, by
            else:
                tx, ty = tx / ln, ty / ln
        # left normal of the joined tangent
        nx, ny = -ty, tx
        # miter scale: 1 / cos(half-angle), clamped
        if 0 < i < n - 1:
            ax, ay = dirs[i - 1]
            cos_half = tx * ax + ty * ay
            scale = min(2.0, 1.0 / max(0.5, cos_half))
        else:
            scale = 1.0
        out.append((pts[i][0] + nx * d * scale, pts[i][1] + ny * d * scale))
    return out


def buffer_polyline(pts, width: float):
    """Centerline → closed ring of full `width` (waterways, simple ribbons)."""
    if len(pts) < 2:
        return None
    left = offset_polyline(pts, width / 2.0)
    right = offset_polyline(pts, -width / 2.0)
    return left + list(reversed(right))


def stitch_member_rings(members, role: str):
    """Stitch multipolygon member ways of one role into closed rings (lat/lon space).

    Port of assembleMemberRings (src/ingest/overpass.ts). `members` are raw OSM
    relation members with .get('geometry') lists of {lat, lon}. Rings that fail
    to close are dropped — positive evidence only.
    """
    def key(g):
        return f"{g['lat']:.7f},{g['lon']:.7f}"

    segs = []
    for m in members:
        r = m.get('role') or 'outer'
        geom = m.get('geometry') or []
        if m.get('type') == 'way' and r == role and len(geom) >= 2:
            segs.append(list(geom))

    rings = []
    while segs:
        chain = segs.pop()
        closed = key(chain[0]) == key(chain[-1])
        progress = True
        while not closed and progress:
            progress = False
            end_k = key(chain[-1])
            start_k = key(chain[0])
            for i, s in enumerate(segs):
                s_k, e_k = key(s[0]), key(s[-1])
                if s_k == end_k:
                    chain = chain + s[1:]
                elif e_k == end_k:
                    chain = chain + list(reversed(s))[1:]
                elif e_k == start_k:
                    chain = s + chain[1:]
                elif s_k == start_k:
                    chain = list(reversed(s)) + chain[1:]
                else:
                    continue
                segs.pop(i)
                progress = True
                break
            closed = key(chain[0]) == key(chain[-1])
        if closed and len(chain) >= 4:
            chain.pop()  # drop closing duplicate
            rings.append(chain)
    return rings


def hash01(seed: int) -> float:
    """Deterministic [0,1) hash from an OSM id (stable across runs)."""
    return ((seed * 2654435761) % 4294967296) / 4294967296.0


# ============================================================================
# v2 shared helpers — MeshData, tessellation, spatial index, polyline utils
# (see SPEC.md; pure stdlib so every generator module is python3-testable)
# ============================================================================

def new_meshdata():
    return {"verts": [], "faces": [], "mats": [], "uvs": None, "attrs": {}}


def merge_meshdata(dst, src):
    """Append src into dst (uvs/attrs merged; missing uvs padded with None)."""
    if not src or not src["faces"]:
        return dst
    base = len(dst["verts"])
    dst["verts"].extend(src["verts"])
    dst["faces"].extend([i + base for i in f] for f in src["faces"])
    dst["mats"].extend(src["mats"])
    if src.get("uvs") is not None or dst.get("uvs") is not None:
        if dst.get("uvs") is None:
            dst["uvs"] = [None] * (len(dst["faces"]) - len(src["faces"]))
        src_uvs = src.get("uvs") or [None] * len(src["faces"])
        dst["uvs"].extend(src_uvs)
    all_keys = set(dst["attrs"]) | set(src.get("attrs") or {})
    n_dst = len(dst["faces"]) - len(src["faces"])
    for k in all_keys:
        d = dst["attrs"].get(k, [0.0] * n_dst)
        if len(d) < n_dst:
            d = d + [0.0] * (n_dst - len(d))
        s = (src.get("attrs") or {}).get(k, [0.0] * len(src["faces"]))
        dst["attrs"][k] = d + s
    return dst


def _point_in_tri(p, a, b, c, eps=1e-9):
    """STRICT interior test — points on an edge/vertex do not count (bridge
    duplicates from hole-joining sit exactly on ear edges and must not block)."""
    d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
    d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
    d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
    return (d1 < -eps and d2 < -eps and d3 < -eps) or (d1 > eps and d2 > eps and d3 > eps)


def _earclip(ring):
    """Ear-clip a simple CCW polygon → triangle index lists. O(n²), robust enough."""
    n = len(ring)
    if n < 3:
        return []
    idx = list(range(n))
    if ring_area_signed(ring) < 0:
        idx.reverse()
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        ear_found = False
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = ring[i0], ring[i1], ring[i2]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 1e-12:
                continue  # reflex or degenerate
            if any(_point_in_tri(ring[j], a, b, c)
                   for j in idx
                   if j not in (i0, i1, i2) and ring[j] not in (a, b, c)):
                continue
            tris.append([i0, i1, i2])
            idx.pop(k)
            ear_found = True
            break
        if not ear_found:  # degenerate leftovers — fan and bail
            break
    if len(idx) >= 3:
        for k in range(1, len(idx) - 1):
            tris.append([idx[0], idx[k], idx[k + 1]])
    return tris


def _bridge_holes(outer, holes):
    """Connect holes to the outer ring (rightmost-vertex bridge) → one simple ring."""
    ring = list(outer) if ring_area_signed(outer) > 0 else list(reversed(outer))
    for hole in sorted(holes, key=lambda h: -max(p[0] for p in h)):
        h = list(hole) if ring_area_signed(hole) < 0 else list(reversed(hole))  # CW holes
        hi = max(range(len(h)), key=lambda i: h[i][0])
        hp = h[hi]
        # nearest outer vertex to the right of the hole vertex (simple, works for OSM data)
        cands = [i for i in range(len(ring)) if ring[i][0] >= hp[0]] or list(range(len(ring)))
        oi = min(cands, key=lambda i: (ring[i][0] - hp[0]) ** 2 + (ring[i][1] - hp[1]) ** 2)
        ring = (ring[:oi + 1] + [h[(hi + k) % len(h)] for k in range(len(h) + 1)]
                + [ring[oi]] + ring[oi + 1:])
    return ring


def tessellate(outer, holes=()):
    """(outer ring, hole rings) → (verts2d, tri index lists). Uses mathutils inside
    Blender, pure ear-clip elsewhere. Triangles are CCW (+Z normals)."""
    holes = [h for h in (holes or ()) if len(h) >= 3]
    try:
        from mathutils.geometry import tessellate_polygon
        polys = [[(x, y, 0.0) for x, y in outer]] + [[(x, y, 0.0) for x, y in h] for h in holes]
        tris = [list(t) for t in tessellate_polygon(polys)]
        verts = [p for ring in [outer] + holes for p in ring]
        fixed = []
        for t in tris:
            a, b, c = verts[t[0]], verts[t[1]], verts[t[2]]
            cw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0
            fixed.append([t[0], t[2], t[1]] if cw else t)
        return verts, fixed
    except ImportError:
        pass
    if holes:
        ring = _bridge_holes(outer, holes)
        return ring, _earclip(ring)
    ring = list(outer)
    return ring, _earclip(ring)


def add_prism(md, ring, z0, z1, mat_side, mat_top=None, mat_bottom=None,
              holes=(), uv_walls=True):
    """Extruded polygon with optional courtyard holes into MeshData.

    Walls for outer ring + hole rings (reversed winding), tessellated top and
    bottom caps. Wall UVs: u = metres along the wall loop, v = metres up.
    """
    outer = dedupe_ring(ring)
    if len(outer) < 3:
        return md
    if ring_area_signed(outer) < 0:
        outer = list(reversed(outer))
    hole_rings = []
    for h in holes or ():
        h = dedupe_ring(h)
        if len(h) >= 3:
            hole_rings.append(list(reversed(h)) if ring_area_signed(h) > 0 else h)

    if md["uvs"] is None and uv_walls:
        md["uvs"] = [None] * len(md["faces"])

    def walls(loop, flip):
        n = len(loop)
        base = len(md["verts"])
        for x, y in loop:
            md["verts"].append((x, y, z0))
        for x, y in loop:
            md["verts"].append((x, y, z1))
        u = 0.0
        for i in range(n):
            j = (i + 1) % n
            seg = math.hypot(loop[j][0] - loop[i][0], loop[j][1] - loop[i][1])
            if flip:
                md["faces"].append([base + j, base + i, base + n + i, base + n + j])
                uv = [(u + seg, z0), (u, z0), (u, z1), (u + seg, z1)]
            else:
                md["faces"].append([base + i, base + j, base + n + j, base + n + i])
                uv = [(u, z0), (u + seg, z0), (u + seg, z1), (u, z1)]
            md["mats"].append(mat_side)
            if md["uvs"] is not None:
                md["uvs"].append(uv if uv_walls else None)
            u += seg

    walls(outer, flip=False)
    for h in hole_rings:
        walls(h, flip=False)  # hole rings are CW, same face rule flips them outward

    def cap(z, mat, up):
        verts2d, tris = tessellate(outer, hole_rings)
        base = len(md["verts"])
        md["verts"].extend((x, y, z) for x, y in verts2d)
        for t in tris:
            md["faces"].append([base + t[0], base + t[1], base + t[2]] if up
                               else [base + t[2], base + t[1], base + t[0]])
            md["mats"].append(mat)
            if md["uvs"] is not None:
                md["uvs"].append(None)

    if mat_top:
        cap(z1, mat_top, up=True)
    if mat_bottom:
        cap(z0, mat_bottom, up=False)
    return md


class SpatialGrid:
    """Uniform grid over 2D AABBs — the app's displacement-field trick, generalised."""

    def __init__(self, cell=32.0):
        self.cell = max(1.0, float(cell))
        self.buckets = {}

    def _cells(self, minx, miny, maxx, maxy):
        c = self.cell
        for cx in range(int(math.floor(minx / c)), int(math.floor(maxx / c)) + 1):
            for cy in range(int(math.floor(miny / c)), int(math.floor(maxy / c)) + 1):
                yield (cx, cy)

    def insert(self, minx, miny, maxx, maxy, payload):
        for key in self._cells(minx, miny, maxx, maxy):
            self.buckets.setdefault(key, []).append(payload)

    def insert_segment(self, a, b, payload, pad=0.0):
        self.insert(min(a[0], b[0]) - pad, min(a[1], b[1]) - pad,
                    max(a[0], b[0]) + pad, max(a[1], b[1]) + pad, payload)

    def query(self, x, y, pad=0.0):
        seen, out = set(), []
        for key in self._cells(x - pad, y - pad, x + pad, y + pad):
            for p in self.buckets.get(key, ()):
                pid = id(p)
                if pid not in seen:
                    seen.add(pid)
                    out.append(p)
        return out


def seg_point_dist(p, a, b):
    """Distance from p to segment ab, plus the closest point and t."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    l2 = abx * abx + aby * aby
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2))
    cx, cy = a[0] + abx * t, a[1] + aby * t
    return math.hypot(p[0] - cx, p[1] - cy), (cx, cy), t


def arc_lengths(pts):
    """Cumulative arc length per point (starts at 0)."""
    out = [0.0]
    for i in range(1, len(pts)):
        out.append(out[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    return out


def densify_polyline(pts, max_step, extra=None):
    """Insert points so no segment exceeds max_step. `extra` = parallel per-point
    lists (e.g. elevations) interpolated alongside. Returns (pts, extras)."""
    if len(pts) < 2:
        return list(pts), [list(e) for e in (extra or [])]
    out = [pts[0]]
    outx = [[e[0]] for e in (extra or [])]
    for i in range(1, len(pts)):
        ax, ay = pts[i - 1]
        bx, by = pts[i]
        d = math.hypot(bx - ax, by - ay)
        steps = max(1, int(math.ceil(d / max_step)))
        for s in range(1, steps + 1):
            t = s / steps
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            for ei, e in enumerate(extra or []):
                outx[ei].append(e[i - 1] + (e[i] - e[i - 1]) * t)
    return out, outx


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def clip_ring_to_rect(ring, minx, miny, maxx, maxy):
    """Sutherland–Hodgman clip of a polygon ring to an axis-aligned rect.
    Port of the app's clipRingToRect — keeps relations (rivers, big parks)
    from dragging kilometres of out-of-scene geometry along. Returns [] when
    fully outside."""
    def clip_edge(pts, inside, intersect):
        out = []
        n = len(pts)
        for i in range(n):
            cur, prev = pts[i], pts[i - 1]
            cin, pin = inside(cur), inside(prev)
            if cin:
                if not pin:
                    out.append(intersect(prev, cur))
                out.append(cur)
            elif pin:
                out.append(intersect(prev, cur))
        return out

    def ix(p, q, x):
        t = (x - p[0]) / ((q[0] - p[0]) or 1e-12)
        return (x, p[1] + (q[1] - p[1]) * t)

    def iy(p, q, y):
        t = (y - p[1]) / ((q[1] - p[1]) or 1e-12)
        return (p[0] + (q[0] - p[0]) * t, y)

    pts = list(ring)
    for inside, inter in (
        (lambda p: p[0] >= minx, lambda p, q: ix(p, q, minx)),
        (lambda p: p[0] <= maxx, lambda p, q: ix(p, q, maxx)),
        (lambda p: p[1] >= miny, lambda p, q: iy(p, q, miny)),
        (lambda p: p[1] <= maxy, lambda p, q: iy(p, q, maxy)),
    ):
        pts = clip_edge(pts, inside, inter)
        if len(pts) < 3:
            return []
    return dedupe_ring(pts)
