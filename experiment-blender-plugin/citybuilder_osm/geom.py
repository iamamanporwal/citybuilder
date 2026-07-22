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
