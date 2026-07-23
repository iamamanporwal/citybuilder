"""Overpass ingest — query builder, mirror-failover fetch, tag → Graph v2 parse.

Python port of src/ingest/overpass.ts + overpassFetch.ts. Same semantics:
class widths, water whitelist (positive evidence only), waterway buffering,
multipolygon stitching (outer + inner holes), building height fallback chain.
Emits the Graph v2 contract from SPEC.md.
"""
import json
import sys
import urllib.request
import urllib.parse

try:
    from . import geom
except ImportError:  # direct python3 execution
    import geom

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
CLASS_LANES = {
    "motorway": 4, "trunk": 3, "primary": 3, "secondary": 2, "tertiary": 2,
    "residential": 2, "unclassified": 2, "living_street": 1, "pedestrian": 0,
    "service": 1, "footway": 0, "cycleway": 0,
}
NON_DRIVABLE = {"pedestrian", "footway", "cycleway"}

WATER_BODY_SUBTAGS = {
    "lake", "pond", "reservoir", "river", "canal", "oxbow", "lagoon", "harbour", "bay",
}
MIN_WATER_AREA_M2 = 150.0
WATERWAY_WIDTH = {"river": 30.0, "canal": 14.0}

LEVEL_M = 3.2

ROOF_SHAPES = {"flat", "gabled", "hipped", "pyramidal", "skillion", "dome"}
BUILDING_KIND = {
    "apartments": "residential", "house": "residential", "residential": "residential",
    "detached": "residential", "terrace": "residential", "semidetached_house": "residential",
    "commercial": "commercial", "retail": "commercial", "office": "commercial",
    "hotel": "commercial", "supermarket": "commercial",
    "industrial": "industrial", "warehouse": "industrial", "factory": "industrial",
    "church": "church", "cathedral": "church", "chapel": "church", "mosque": "church",
    "synagogue": "church", "temple": "church",
}

NODE_PROP_KINDS = {
    ("highway", "street_lamp"): "lamp",
    ("highway", "traffic_signals"): "signal",
    ("highway", "bus_stop"): "bus_stop",
    ("highway", "stop"): "stop",
    ("highway", "give_way"): "give_way",
    ("highway", "crossing"): "crossing",
}

# landuse polygons kept as ZONES (recognizer + vegetation), never rendered
ZONE_KINDS = frozenset(("residential", "commercial", "retail", "industrial"))

# man_made features built as parametric structures (landmarks_gen)
STRUCTURE_KINDS = frozenset(("water_tower", "chimney"))


def zone_kind(tags):
    lu = tags.get("landuse")
    return lu if lu in ZONE_KINDS else None


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
    if tags.get("landuse") in ("grass", "meadow", "village_green") \
            or tags.get("natural") == "grassland" \
            or tags.get("leisure") == "pitch" or tags.get("natural") == "wetland":
        return "grass"
    if tags.get("natural") in ("beach", "sand"):
        return "sand"
    if (tags.get("highway") == "pedestrian" and tags.get("area") == "yes") \
            or tags.get("place") == "square":
        return "plaza"
    return None


def build_query_ways(south, west, north, east, trees=True, props=True):
    """The mandatory request: ways + nodes only (fast even on heavy scenes)."""
    bbox = f"({south:.6f},{west:.6f},{north:.6f},{east:.6f})"
    hw = "|".join(ROAD_CLASSES)
    parts = [
        f'way["building"]{bbox};',
        f'way["building:part"]{bbox};',
        f'way["highway"~"^({hw})$"]{bbox};',
        f'way["railway"="rail"]{bbox};',
        f'way["natural"~"^(water|wood|grassland|wetland|beach|sand)$"]{bbox};',
        f'way["waterway"~"^(riverbank|river|canal)$"]{bbox};',
        f'way["landuse"~"^(grass|meadow|forest|reservoir|village_green'
        f'|residential|commercial|retail|industrial)$"]{bbox};',
        f'way["leisure"~"^(park|garden|playground|pitch)$"]{bbox};',
        f'way["place"="square"]{bbox};',
        f'way["man_made"~"^(water_tower|chimney)$"]{bbox};',
        f'node["man_made"~"^(water_tower|chimney)$"]{bbox};',
    ]
    if trees:
        parts.append(f'node["natural"="tree"]{bbox};')
    if props:
        parts.append(
            f'node["highway"~"^(street_lamp|bus_stop|traffic_signals|stop|give_way|crossing)$"]{bbox};')
    return f"[out:json][timeout:120];({''.join(parts)});out body geom;"


def build_query_relations(south, west, north, east):
    """The optional request: multipolygon relations (rivers, parks, courtyard
    buildings). Giant protected-area relations can 502 this — callers treat a
    failure as 'no relation areas' rather than a failed build."""
    bbox = f"({south:.6f},{west:.6f},{north:.6f},{east:.6f})"
    parts = [
        f'relation["building"]{bbox};',
        f'relation["natural"~"^(water|wood)$"]{bbox};',
        f'relation["leisure"="park"]{bbox};',
        f'relation["landuse"="forest"]{bbox};',
    ]
    return f"[out:json][timeout:90];({''.join(parts)});out body geom;"


def _post(query, timeout_s):
    body = ("data=" + urllib.parse.quote(query)).encode()
    last_err = None
    for url in MIRRORS:
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "citybuilder-blender/0.5 (aman@aganastudios.com)",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8")).get("elements", [])
        except Exception as e:  # try the next mirror
            last_err = e
            print(f"[citybuilder] mirror failed {url}: {e}", file=sys.stderr)
    raise RuntimeError(f"All Overpass mirrors failed: {last_err}")


def fetch(south, west, north, east, trees=True, props=True, timeout_s=150):
    """Two-request fetch: ways+nodes (mandatory) then relations (best-effort).

    Heavy scenes (e.g. boxes touching national-park relations) used to 502 the
    whole build; now they just lose the giant relation polygons.
    """
    elements = _post(build_query_ways(south, west, north, east, trees, props), timeout_s)
    try:
        rel = _post(build_query_relations(south, west, north, east), timeout_s=110)
        seen = {(e.get("type"), e.get("id")) for e in elements}
        elements.extend(e for e in rel if (e.get("type"), e.get("id")) not in seen)
    except Exception as e:
        print(f"[citybuilder] relations fetch failed — continuing without: {e}",
              file=sys.stderr)
    return elements


# ---- tag helpers -------------------------------------------------------------

def _float_tag(v):
    if v is None:
        return None
    try:
        return float(str(v).replace("m", "").replace(",", ".").strip())
    except ValueError:
        return None


def building_height(tags, oid):
    """height tag → levels × 3.2 → deterministic 9–25 m fallback."""
    h = _float_tag(tags.get("height") or tags.get("building:height"))
    if h and h > 0:
        return max(2.5, h)
    lv = _float_tag(tags.get("building:levels"))
    if lv and lv > 0:
        return lv * LEVEL_M
    return 9.0 + round(geom.hash01(oid) * 5) * LEVEL_M


def _building_rec(tags, oid, ring, holes, part=False):
    b_tag = tags.get("building") or tags.get("building:part") or "yes"
    if b_tag == "yes" and part:
        b_tag = tags.get("building:part", "yes")
    shape = tags.get("roof:shape", "auto")
    if shape not in ROOF_SHAPES:
        shape = "auto"
    min_h = _float_tag(tags.get("min_height")) or 0.0
    if not min_h:
        min_lv = _float_tag(tags.get("building:min_level"))
        min_h = min_lv * LEVEL_M if min_lv else 0.0
    return {
        "ring": ring,
        "holes": holes,
        "height": building_height(tags, oid),
        "min_height": min_h,
        "levels": _float_tag(tags.get("building:levels")),
        "roof_shape": shape,
        "roof_height": _float_tag(tags.get("roof:height")),
        "kind": BUILDING_KIND.get(b_tag, "auto"),
        "id": oid,
        "name": tags.get("name"),
        # Buildings v3 recognizer signals
        "part": part,
        "btype": b_tag,
        "architecture": tags.get("building:architecture"),
        "material": (tags.get("building:material")
                     or tags.get("building:facade:material") or tags.get("material")),
        "wikidata": tags.get("wikidata"),
        "height_tagged": bool(tags.get("height") or tags.get("building:height")
                              or tags.get("building:levels")),
    }


def _maxspeed_kmh(tags):
    v = tags.get("maxspeed")
    if not v:
        return None
    v = v.strip().lower()
    try:
        if v.endswith("mph"):
            return round(float(v[:-3].strip()) * 1.60934)
        return round(float(v))
    except ValueError:
        return None


def _road_rec(tags, oid, pts, node_ids, cls):
    width = CLASS_WIDTH[cls]
    lanes_tag = _float_tag(tags.get("lanes"))
    lanes = int(lanes_tag) if lanes_tag and lanes_tag > 0 else CLASS_LANES[cls]
    w_tag = _float_tag(tags.get("width"))
    if w_tag and 2.0 <= w_tag <= 40.0:
        width = w_tag
    elif lanes_tag and lanes_tag > 0:
        width = max(width, lanes_tag * 3.0)
    oneway = tags.get("oneway") in ("yes", "1", "true") \
        or tags.get("junction") in ("roundabout", "circular")
    return {
        "class": cls, "width": width, "lanes": max(lanes, 1 if cls not in NON_DRIVABLE else 0),
        "oneway": oneway,
        "roundabout": tags.get("junction") in ("roundabout", "circular"),
        "pts": pts, "node_ids": node_ids,
        "bridge": bool(tags.get("bridge") and tags["bridge"] != "no"),
        "tunnel": bool(tags.get("tunnel") and tags["tunnel"] != "no"),
        "layer": int(_float_tag(tags.get("layer")) or 0),
        "id": oid,
        "name": tags.get("name"),
        "surface": tags.get("surface"),
        "structure": tags.get("bridge:structure") or tags.get("structure"),
        "wikidata": tags.get("wikidata"),
        "maxspeed": _maxspeed_kmh(tags),
        "elev": None,
    }


def _assign_holes(outers, inners):
    """Attach each inner ring (hole) to the outer ring containing its first point."""
    result = [{"ring": o, "holes": []} for o in outers]

    def inside(p, ring):
        x, y = p
        n = len(ring)
        c = False
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
                c = not c
        return c

    for h in inners:
        for rec in result:
            if inside(h[0], rec["ring"]):
                rec["holes"].append(h)
                break
    return result


def parse(elements, to_xy, center=None):
    """Raw Overpass elements → Graph v2 dict (see SPEC.md)."""
    graph = {"buildings": [], "roads": [], "rails": [], "areas": [],
             "trees": [], "props": [], "zones": [], "structures": [],
             "center": center or {}}

    def project_ring(latlon_ring):
        ring = geom.dedupe_ring([to_xy(g["lat"], g["lon"]) for g in latlon_ring])
        return ring if len(ring) >= 3 else None

    for el in elements:
        tags = el.get("tags") or {}
        etype = el.get("type")

        if etype == "node":
            if "lat" not in el:
                continue
            if tags.get("natural") == "tree":
                graph["trees"].append({"pos": to_xy(el["lat"], el["lon"]), "id": el["id"]})
                continue
            if tags.get("man_made") in STRUCTURE_KINDS:
                graph["structures"].append(
                    {"kind": tags["man_made"], "pos": to_xy(el["lat"], el["lon"]),
                     "height": _float_tag(tags.get("height")), "id": el["id"]})
                continue
            for (k, v), kind in NODE_PROP_KINDS.items():
                if tags.get(k) == v:
                    graph["props"].append(
                        {"kind": kind, "pos": to_xy(el["lat"], el["lon"]), "id": el["id"]})
                    break
            continue

        if etype == "relation":
            members = el.get("members") or []
            outers = [project_ring(r) for r in geom.stitch_member_rings(members, "outer")]
            outers = [r for r in outers if r]
            if not outers:
                continue
            inners = [project_ring(r) for r in geom.stitch_member_rings(members, "inner")]
            inners = [r for r in inners if r]

            if "building" in tags:
                for rec in _assign_holes(outers, inners):
                    if geom.ring_area_m2(rec["ring"]) < 4:
                        continue
                    graph["buildings"].append(
                        _building_rec(tags, el["id"], rec["ring"], rec["holes"]))
                continue

            kind = area_kind(tags)
            if not kind:
                continue
            for rec in _assign_holes(outers, inners):
                if kind == "water" and geom.ring_area_m2(rec["ring"]) < MIN_WATER_AREA_M2:
                    continue
                graph["areas"].append(
                    {"kind": kind, "ring": rec["ring"], "holes": rec["holes"]})
            continue

        # ---- ways ----
        pts_geo = el.get("geometry") or []
        if len(pts_geo) < 2:
            continue
        closed = (pts_geo[0]["lat"] == pts_geo[-1]["lat"]
                  and pts_geo[0]["lon"] == pts_geo[-1]["lon"])

        if tags.get("man_made") in STRUCTURE_KINDS and closed:
            ring = project_ring(pts_geo)
            if ring:
                cx = sum(p[0] for p in ring) / len(ring)
                cy = sum(p[1] for p in ring) / len(ring)
                graph["structures"].append(
                    {"kind": tags["man_made"], "pos": (cx, cy),
                     "height": _float_tag(tags.get("height")), "id": el["id"]})
            continue

        if "building" in tags and closed:
            ring = project_ring(pts_geo)
            if ring and geom.ring_area_m2(ring) >= 4:
                graph["buildings"].append(_building_rec(tags, el["id"], ring, []))
            continue

        if tags.get("building:part", "no") != "no" and closed:
            ring = project_ring(pts_geo)
            if ring and geom.ring_area_m2(ring) >= 4:
                graph["buildings"].append(
                    _building_rec(tags, el["id"], ring, [], part=True))
            continue

        hw = tags.get("highway")
        if hw in CLASS_WIDTH and not (hw == "pedestrian" and tags.get("area") == "yes"):
            pts = [to_xy(g["lat"], g["lon"]) for g in pts_geo]
            node_ids = el.get("nodes") or []
            graph["roads"].append(_road_rec(tags, el["id"], pts, node_ids, hw))
            continue

        if tags.get("railway") == "rail":
            if tags.get("tunnel") and tags["tunnel"] != "no":
                continue
            pts = [to_xy(g["lat"], g["lon"]) for g in pts_geo]
            graph["rails"].append({
                "pts": pts, "node_ids": el.get("nodes") or [],
                "bridge": bool(tags.get("bridge") and tags["bridge"] != "no"),
                "layer": int(_float_tag(tags.get("layer")) or 0), "id": el["id"],
            })
            continue

        kind = area_kind(tags)
        if kind and closed:
            ring = project_ring(pts_geo)
            if not ring:
                continue
            if kind == "water" and geom.ring_area_m2(ring) < MIN_WATER_AREA_M2:
                continue
            graph["areas"].append({"kind": kind, "ring": ring, "holes": []})
            continue

        zk = zone_kind(tags)
        if zk and closed:
            ring = project_ring(pts_geo)
            if ring:
                graph["zones"].append({"kind": zk, "ring": ring, "holes": []})
            continue

        ww = tags.get("waterway")
        if ww in WATERWAY_WIDTH and not closed:
            if tags.get("tunnel") and tags["tunnel"] != "no":
                continue
            pts = [to_xy(g["lat"], g["lon"]) for g in pts_geo]
            ring = geom.buffer_polyline(pts, WATERWAY_WIDTH[ww])
            if ring and len(ring) >= 3:
                graph["areas"].append({"kind": "water", "ring": ring, "holes": []})

    return graph


if __name__ == "__main__":
    # offline self-test: synthetic Overpass elements through parse()
    def xy(lat, lon):
        return (lon * 100000.0, lat * 100000.0)

    def g(pts):
        return [{"lat": p[1], "lon": p[0]} for p in pts]

    sq = [(0, 0), (0.001, 0), (0.001, 0.001), (0, 0.001), (0, 0)]
    elements = [
        {"type": "way", "id": 1, "tags": {"building": "apartments", "building:levels": "5",
                                          "roof:shape": "gabled"}, "geometry": g(sq)},
        {"type": "way", "id": 2, "tags": {"highway": "primary", "lanes": "4", "oneway": "yes",
                                          "maxspeed": "50", "bridge": "yes", "layer": "1"},
         "geometry": g([(0, 0), (0.01, 0)]), "nodes": [10, 11]},
        {"type": "way", "id": 3, "tags": {"leisure": "swimming_pool"}, "geometry": g(sq)},
        {"type": "way", "id": 4, "tags": {"natural": "water", "water": "lake"},
         "geometry": g([(0, 0), (0.01, 0), (0.01, 0.01), (0, 0.01), (0, 0)])},
        {"type": "node", "id": 5, "lat": 0.5, "lon": 0.5,
         "tags": {"highway": "street_lamp"}},
        {"type": "way", "id": 7, "tags": {"landuse": "residential"}, "geometry": g(sq)},
        {"type": "way", "id": 8,
         "tags": {"building:part": "yes", "min_height": "12",
                  "height": "30", "building:material": "glass"},
         "geometry": g(sq)},
        {"type": "node", "id": 9, "lat": 0.2, "lon": 0.2,
         "tags": {"man_made": "chimney", "height": "45"}},
        {"type": "way", "id": 12, "tags": {"man_made": "water_tower"}, "geometry": g(sq)},
        {"type": "relation", "id": 6, "tags": {"building": "yes"}, "members": [
            {"type": "way", "role": "outer",
             "geometry": g([(0, 0), (0.002, 0), (0.002, 0.002), (0, 0.002), (0, 0)])},
            {"type": "way", "role": "inner",
             "geometry": g([(0.0005, 0.0005), (0.0015, 0.0005), (0.0015, 0.0015),
                            (0.0005, 0.0015), (0.0005, 0.0005)])},
        ]},
    ]
    gr = parse(elements, xy)
    assert len(gr["buildings"]) == 3
    b = gr["buildings"][0]
    assert b["height"] == 5 * LEVEL_M and b["roof_shape"] == "gabled" and b["kind"] == "residential"
    assert b["btype"] == "apartments" and b["height_tagged"] and not b["part"]
    r = gr["roads"][0]
    assert r["width"] == 12.0 and r["oneway"] and r["bridge"] and r["layer"] == 1 \
        and r["maxspeed"] == 50 and r["lanes"] == 4
    kinds = {a["kind"] for a in gr["areas"]}
    assert kinds == {"water"}, kinds  # pool rejected by whitelist
    assert gr["props"][0]["kind"] == "lamp"
    # buildings v3: parts, zones, structures
    part = next(x for x in gr["buildings"] if x["part"])
    assert part["min_height"] == 12.0 and part["height"] == 30.0 \
        and part["material"] == "glass" and part["height_tagged"]
    hole_b = next(x for x in gr["buildings"] if x["holes"])
    assert len(hole_b["holes"]) == 1
    assert gr["zones"] == [{"kind": "residential", "ring": gr["zones"][0]["ring"],
                            "holes": []}]
    skinds = sorted(s["kind"] for s in gr["structures"])
    assert skinds == ["chimney", "water_tower"], skinds
    chim = next(s for s in gr["structures"] if s["kind"] == "chimney")
    assert chim["height"] == 45.0
    q = build_query_ways(50.0, 14.0, 50.01, 14.01)
    qr = build_query_relations(50.0, 14.0, 50.01, 14.01)
    assert "street_lamp" in q and "railway" in q and 'relation["building"]' in qr
    assert "building:part" in q and "water_tower|chimney" in q \
        and "residential|commercial|retail|industrial" in q
    print("overpass v2 self-tests OK")