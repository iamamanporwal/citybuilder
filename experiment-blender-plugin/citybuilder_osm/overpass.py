"""Overpass ingest — query builder, mirror-failover fetch, tag → graph parse.

Python port of src/ingest/overpass.ts + overpassFetch.ts. Same semantics:
class widths, water whitelist ("positive evidence only"), waterway buffering,
multipolygon stitching, building height fallback chain.
"""
import json
import urllib.request
import urllib.parse

from . import geom

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

ROAD_CLASSES = [
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
    "unclassified", "living_street", "pedestrian", "service", "footway", "cycleway",
]

# default full carriageway width (m) per class — mirror of CLASS_WIDTH
CLASS_WIDTH = {
    "motorway": 14, "trunk": 12, "primary": 11, "secondary": 9, "tertiary": 8,
    "residential": 7, "unclassified": 7, "living_street": 5.5, "pedestrian": 5,
    "service": 4, "footway": 2, "cycleway": 2.5,
}

# whitelist of natural=water sub-tags accepted as real water bodies
WATER_BODY_SUBTAGS = {
    "lake", "pond", "reservoir", "river", "canal", "oxbow", "lagoon", "harbour", "bay",
}
MIN_WATER_AREA_M2 = 150.0
WATERWAY_WIDTH = {"river": 30.0, "canal": 14.0}

LEVEL_M = 3.2


def water_provenance(tags):
    """Whitelist rule admitting these tags as a water AREA, or None (= land)."""
    if tags.get("amenity") == "fountain":
        return None
    if tags.get("leisure") in ("swimming_pool", "water_park"):
        return None
    if tags.get("natural") == "wetland" or tags.get("wetland"):
        return None
    if tags.get("water") and tags["water"] not in WATER_BODY_SUBTAGS:
        return None
    if (tags.get("tunnel") and tags["tunnel"] != "no") or tags.get("covered") == "yes" \
            or tags.get("location") == "underground":
        return None
    if tags.get("natural") == "water":
        return "natural=water"
    if tags.get("waterway") == "riverbank":
        return "waterway=riverbank"
    if tags.get("landuse") == "reservoir":
        return "landuse=reservoir"
    return None


def area_kind(tags):
    if water_provenance(tags):
        return "water"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        return "forest"
    if tags.get("leisure") in ("park", "garden", "playground"):
        return "park"
    if tags.get("landuse") in ("grass", "meadow") or tags.get("natural") == "grassland" \
            or tags.get("leisure") == "pitch" or tags.get("natural") == "wetland":
        return "grass"
    if tags.get("natural") in ("beach", "sand"):
        return "sand"
    return None


def build_query(south, west, north, east, trees=True):
    bbox = f"({south:.6f},{west:.6f},{north:.6f},{east:.6f})"
    hw = "|".join(ROAD_CLASSES)
    parts = [
        f'way["building"]{bbox};',
        f'way["highway"~"^({hw})$"]{bbox};',
        f'way["natural"~"^(water|wood|grassland|wetland|beach|sand)$"]{bbox};',
        f'way["waterway"~"^(riverbank|river|canal)$"]{bbox};',
        f'way["landuse"~"^(grass|meadow|forest|reservoir)$"]{bbox};',
        f'way["leisure"~"^(park|garden|playground|pitch)$"]{bbox};',
        f'relation["natural"~"^(water|wood)$"]{bbox};',
        f'relation["leisure"="park"]{bbox};',
        f'relation["landuse"="forest"]{bbox};',
    ]
    if trees:
        parts.append(f'node["natural"="tree"]{bbox};')
    return f"[out:json][timeout:50];({''.join(parts)});out body geom;"


def fetch(south, west, north, east, trees=True, timeout_s=60):
    """POST the query to each mirror in turn; return parsed element list."""
    body = ("data=" + urllib.parse.quote(build_query(south, west, north, east, trees))).encode()
    last_err = None
    for url in MIRRORS:
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "citybuilder-blender/0.1 (aman@aganastudios.com)",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8")).get("elements", [])
        except Exception as e:  # try the next mirror
            last_err = e
    raise RuntimeError(f"All Overpass mirrors failed: {last_err}")


def building_height(tags, oid):
    """height tag → levels × 3.2 → deterministic 9–25 m fallback (overpass.ts:678)."""
    h = tags.get("height") or tags.get("building:height")
    if h:
        try:
            return max(2.5, float(str(h).replace("m", "").strip()))
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            lvf = float(lv)
            if lvf > 0:
                return lvf * LEVEL_M
        except ValueError:
            pass
    return 9.0 + round(geom.hash01(oid) * 5) * LEVEL_M


def parse(elements, to_xy):
    """Raw Overpass elements → graph dict (the Python CityGraph).

    Returns {'buildings': [{'ring', 'height', 'id'}],
             'roads':     [{'class', 'width', 'pts', 'id'}],
             'areas':     [{'kind', 'ring'}],
             'trees':     [{'pos', 'id'}]}
    """
    graph = {"buildings": [], "roads": [], "areas": [], "trees": []}

    def project_ring(latlon_ring):
        ring = geom.dedupe_ring([to_xy(g["lat"], g["lon"]) for g in latlon_ring])
        return ring if len(ring) >= 3 else None

    for el in elements:
        tags = el.get("tags") or {}
        etype = el.get("type")

        if etype == "node":
            if tags.get("natural") == "tree" and "lat" in el:
                graph["trees"].append({"pos": to_xy(el["lat"], el["lon"]), "id": el["id"]})
            continue

        if etype == "relation":
            kind = area_kind(tags)
            if not kind:
                continue
            for latlon_ring in geom.stitch_member_rings(el.get("members") or [], "outer"):
                ring = project_ring(latlon_ring)
                if not ring:
                    continue
                if kind == "water" and geom.ring_area_m2(ring) < MIN_WATER_AREA_M2:
                    continue
                graph["areas"].append({"kind": kind, "ring": ring})
            continue

        # ways
        pts_geo = el.get("geometry") or []
        if len(pts_geo) < 2:
            continue
        closed = (pts_geo[0]["lat"] == pts_geo[-1]["lat"]
                  and pts_geo[0]["lon"] == pts_geo[-1]["lon"])

        if "building" in tags and closed:
            ring = project_ring(pts_geo)
            if ring:
                graph["buildings"].append({
                    "ring": ring,
                    "height": building_height(tags, el["id"]),
                    "id": el["id"],
                })
            continue

        hw = tags.get("highway")
        if hw in CLASS_WIDTH:
            if tags.get("tunnel") and tags["tunnel"] != "no":
                continue  # underground — never painted (same rule as water)
            if tags.get("area") == "yes":
                continue  # pedestrian plazas need polygon treatment (v0.2)
            pts = [to_xy(g["lat"], g["lon"]) for g in pts_geo]
            width = CLASS_WIDTH[hw]
            if tags.get("lanes"):
                try:
                    width = max(width, float(tags["lanes"]) * 3.0)
                except ValueError:
                    pass
            graph["roads"].append({"class": hw, "width": width, "pts": pts, "id": el["id"]})
            continue

        kind = area_kind(tags)
        if kind and closed:
            ring = project_ring(pts_geo)
            if not ring:
                continue
            if kind == "water" and geom.ring_area_m2(ring) < MIN_WATER_AREA_M2:
                continue
            graph["areas"].append({"kind": kind, "ring": ring})
            continue

        # large flowing waterways as centerlines → buffered surface
        ww = tags.get("waterway")
        if ww in WATERWAY_WIDTH and not closed:
            if tags.get("tunnel") and tags["tunnel"] != "no":
                continue
            pts = [to_xy(g["lat"], g["lon"]) for g in pts_geo]
            ring = geom.buffer_polyline(pts, WATERWAY_WIDTH[ww])
            if ring and len(ring) >= 3:
                graph["areas"].append({"kind": "water", "ring": ring})

    return graph
