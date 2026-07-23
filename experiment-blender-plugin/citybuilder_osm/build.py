"""Scene orchestrator — Graph v2 → Blender scene (the only geometry↔bpy bridge).

Pipeline: field → elevation solve → network → terrain → junctions → road sweeps
→ areas → buildings → landmarks → props/trees → cb_export scene data.
"""
import json
import math

import bpy

import os

from . import (elevation, geom, junctions, landmarks_gen, matlib, overpass,
               profile, props_gen, roadnet, roofs, terrain, texcache)

ROOT_NAME = "CityBuilder"
SUBS = ("Ground", "Roads", "Junctions", "Areas", "Buildings", "Landmarks", "Props", "Trees")

WATER_SURFACE_Z = -1.2
AREA_Z = {"sand": 0.037, "grass": 0.022, "park": 0.032, "forest": 0.042}
AREA_MAT = {"water": "water", "park": "grass", "grass": "grass",
            "forest": "forest_floor", "sand": "sand", "plaza": "paver"}
SURFACE_EXPORT = {
    "motorway": "asphalt-new", "trunk": "asphalt-new", "primary": "asphalt-worn",
    "secondary": "asphalt-worn", "tertiary": "asphalt-worn", "residential": "asphalt-worn",
    "unclassified": "asphalt-worn", "living_street": "pavers", "pedestrian": "pavers",
    "service": "asphalt-worn", "footway": "pavers", "cycleway": "asphalt-new",
}


# ---- collections / clear -----------------------------------------------------

def clear_city(context):
    root = bpy.data.collections.get(ROOT_NAME)
    if not root:
        return

    def wipe(coll):
        for child in list(coll.children):
            wipe(child)
        for obj in list(coll.objects):
            mesh = obj.data if obj.type == "MESH" else None
            bpy.data.objects.remove(obj, do_unlink=True)
            if mesh and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        bpy.data.collections.remove(coll)

    wipe(root)


def ensure_collections(context):
    root = bpy.data.collections.get(ROOT_NAME)
    if not root:
        root = bpy.data.collections.new(ROOT_NAME)
        context.scene.collection.children.link(root)
    subs = {}
    for name in SUBS:
        coll = bpy.data.collections.get(f"{ROOT_NAME} {name}")
        if not coll:
            coll = bpy.data.collections.new(f"{ROOT_NAME} {name}")
            root.children.link(coll)
        subs[name] = coll
    return subs


# ---- MeshData → bpy ----------------------------------------------------------

def meshdata_to_object(name, md, coll):
    """Realise a MeshData dict as a mesh object with material slots, UVs, attrs."""
    if not md or not md["faces"]:
        return None
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(md["verts"], [], md["faces"])
    mesh.update()

    # material slots — one per unique key, faces indexed
    keys = []
    key_index = {}
    for k in md["mats"]:
        if k not in key_index:
            key_index[k] = len(keys)
            keys.append(k)
    for k in keys:
        mesh.materials.append(matlib.get(k))
    if len(mesh.polygons) == len(md["mats"]):
        mesh.polygons.foreach_set("material_index", [key_index[k] for k in md["mats"]])

    # UVs (per-face per-corner; None faces → zeros)
    uvs = md.get("uvs")
    if uvs is not None and len(uvs) == len(md["faces"]):
        layer = mesh.uv_layers.new(name="UVMap")
        flat = []
        for fi, poly in enumerate(mesh.polygons):
            fuv = uvs[fi]
            n = poly.loop_total
            if fuv and len(fuv) == n:
                for u, v in fuv:
                    flat.extend((u, v))
            else:
                flat.extend([0.0] * (2 * n))
        layer.data.foreach_set("uv", flat)

    # per-face float attributes
    for aname, values in (md.get("attrs") or {}).items():
        if len(values) == len(mesh.polygons):
            attr = mesh.attributes.new(name=aname, type="FLOAT", domain="FACE")
            attr.data.foreach_set("value", [float(v) for v in values])

    mesh.validate()
    # smooth shading with sharp creases: flat-shaded crown facets Fresnel-mirror
    # the sky at grazing angles (navy stripes on roads); smoothing interpolates
    # normals while >30° edges (curbs, walls) stay crisp
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    try:
        mesh.set_sharp_from_angle(angle=math.radians(30))
    except AttributeError:
        pass  # pre-4.1 fallback: flat shading
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    return obj


# ---- small local generators ---------------------------------------------------

def _subdivided_area(ring, holes, z_of, max_edge=25.0, rounds=2):
    """Tessellate an area ring (+holes) and midpoint-subdivide so faces follow terrain."""
    verts2d, tris = geom.tessellate(ring, holes)
    verts = [list(p) for p in verts2d]
    for _ in range(rounds):
        if not tris:
            break
        long_edge = max(
            max(math.hypot(verts[t[i]][0] - verts[t[(i + 1) % 3]][0],
                           verts[t[i]][1] - verts[t[(i + 1) % 3]][1]) for i in range(3))
            for t in tris)
        if long_edge <= max_edge:
            break
        new_tris = []
        cache = {}

        def midpoint(a, b):
            k = (min(a, b), max(a, b))
            if k not in cache:
                cache[k] = len(verts)
                verts.append([(verts[a][0] + verts[b][0]) / 2,
                              (verts[a][1] + verts[b][1]) / 2])
            return cache[k]

        for a, b, c in tris:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            new_tris += [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]
        tris = new_tris
    return [(x, y, z_of(x, y)) for x, y in verts], tris


def _rail_meshdata(rails, field):
    """Simple but effective rail lines: ballast ribbon + two steel strips."""
    md = geom.new_meshdata()

    def strip(pts, offset, half_w, z_off, mat):
        left = geom.offset_polyline(pts, offset + half_w)
        right = geom.offset_polyline(pts, offset - half_w)
        base = len(md["verts"])
        n = len(pts)
        for i in range(n):
            z = field.sample(pts[i][0], pts[i][1]) + z_off
            md["verts"].append((left[i][0], left[i][1], z))
            md["verts"].append((right[i][0], right[i][1], z))
        for i in range(n - 1):
            l0, r0 = base + 2 * i, base + 2 * i + 1
            l1, r1 = base + 2 * i + 2, base + 2 * i + 3
            md["faces"].append([l0, r0, r1, l1])
            md["mats"].append(mat)

    for r in rails:
        pts, _ = geom.densify_polyline(r["pts"], 12.0)
        if len(pts) < 2:
            continue
        strip(pts, 0.0, 1.5, 0.065, "gravel")
        for side in (-0.7175, 0.7175):
            strip(pts, side, 0.035, 0.18, "metal")
    if md["uvs"] is None:
        md["uvs"] = [None] * len(md["faces"])
    return md


def _pier_prism(md, ring):
    """Concrete pier for an over-water building: cap at grade 0, skirt to −3."""
    geom.add_prism(md, ring, -3.0, 0.0, "concrete", mat_top="concrete")


def _water_fraction(ring, water_areas):
    if not water_areas:
        return 0.0

    def inside(p, rec):
        def in_ring(pt, r):
            x, y = pt
            c = False
            for i in range(len(r)):
                x1, y1 = r[i]
                x2, y2 = r[(i + 1) % len(r)]
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
                    c = not c
            return c
        return in_ring(p, rec["ring"]) and not any(in_ring(p, h) for h in rec.get("holes", []))

    hits = sum(1 for v in ring if any(inside(v, w) for w in water_areas))
    return hits / max(1, len(ring))


# ---- photo textures -------------------------------------------------------------

def texture_cache_dir():
    """Persistent per-user texture cache: the extension user dir when installed,
    ~/.cache fallback when running from source (headless tests)."""
    try:
        return bpy.utils.extension_path_user(__package__, path="textures", create=True)
    except Exception:
        d = os.path.expanduser("~/.cache/citybuilder_osm/textures")
        os.makedirs(d, exist_ok=True)
        return d


def prepare_textures(enabled, quality="med", progress=None):
    """Fetch/load the photo-PBR set and arm matlib. Never raises; empty maps =
    procedural fallback (fully offline)."""
    if not enabled:
        matlib.set_textures({})
        return 0
    res = "1K" if str(quality).lower().startswith("l") else "2K"
    try:
        maps = texcache.ensure(texture_cache_dir(), res=res, progress=progress)
    except Exception as e:
        print(f"[citybuilder] texture pipeline failed ({e}) — procedural fallback")
        maps = {}
    matlib.set_textures(maps)
    return len(maps)


# ---- orchestrator --------------------------------------------------------------

def build_scene(context, graph, params, progress=None):
    """params: dict(radius, terrain_mode, quality, seed, do_buildings, do_props,
    do_landmarks, do_trees, separate_buildings, framed)."""
    def tick(pct, label):
        if progress:
            progress(pct, label)

    # arm the material library (photo PBR or procedural) BEFORE any mesh is built
    tick(2, "textures")
    n_tex = prepare_textures(params.get("photo_textures", True),
                             params.get("quality", "med"),
                             progress=lambda f, label: tick(2 + f * 3, label))
    counts_tex = n_tex

    subs = ensure_collections(context)
    counts = {"textured_keys": counts_tex}
    radius = params["radius"]

    # clip area rings to the scene rect — relations (rivers, big parks) drag
    # kilometres of out-of-scene geometry otherwise (app: clipRingToRect)
    ext = radius * 1.25
    clipped = []
    for a in graph["areas"]:
        ring = geom.clip_ring_to_rect(a["ring"], -ext, -ext, ext, ext)
        if len(ring) < 3:
            continue
        holes = [h for h in (geom.clip_ring_to_rect(h, -ext, -ext, ext, ext)
                             for h in a.get("holes", [])) if len(h) >= 3]
        clipped.append({**a, "ring": ring, "holes": holes})
    graph["areas"] = clipped
    water_areas = [a for a in graph["areas"] if a["kind"] == "water"]

    # 1. elevation field + corridor solve
    tick(5, "elevation field")
    field = elevation.build_field(
        params["terrain_mode"], radius, water_areas, seed=params.get("seed", 0),
        center_lat=graph["center"].get("lat"), center_lon=graph["center"].get("lon"))
    tick(12, "corridor solve")
    solve = elevation.solve(graph["roads"], field)
    tick(20, "road network")
    network = roadnet.build_network(graph["roads"], solve)
    segs = network["segments"]
    juncs = network["junctions"]
    counts["junctions"] = len(juncs)

    # 2. terrain (conformed ground)
    tick(28, "terrain")
    corridors = [{"pts": s["pts"], "elev": s["elev"], "half": s["width"] / 2, "pave": 4.0}
                 for s in segs if not s["bridge"] and not s["internal"] and len(s["pts"]) >= 2]
    ter_md = terrain.build_terrain(field, radius, corridors, params.get("quality", "med"))
    meshdata_to_object("Terrain", ter_md, subs["Ground"])
    # ground height as the terrain mesh sees it (roads burned in) — one sampler reused
    # by areas and props so nothing pokes through the conformed ground
    conformed_z = terrain.make_conform_sampler(field, corridors)

    # 3. junction pads
    tick(38, "junctions")
    jm = geom.new_meshdata()
    for j in juncs:
        geom.merge_meshdata(jm, junctions.build_junction(j))
    meshdata_to_object("Junctions", jm, subs["Junctions"])

    # 4. road sweeps + markings + piers
    tick(48, "roads")
    road_md = geom.new_meshdata()
    mark_md = geom.new_meshdata()
    n_swept = 0
    for s in segs:
        if s["internal"] or len(s["pts"]) < 2:
            continue
        if graph["roads"][s["road_idx"]].get("tunnel"):
            continue  # underground — never rendered (app parity)
        road_md_i = profile.sweep_road(s, {"framed": params.get("framed", True)})
        geom.merge_meshdata(road_md, road_md_i)
        geom.merge_meshdata(mark_md, profile.markings(s))
        if s["bridge"]:
            geom.merge_meshdata(road_md, profile.bridge_piers(s, field.sample))
        n_swept += 1
    counts["roads"] = n_swept
    meshdata_to_object("Roads", road_md, subs["Roads"])
    meshdata_to_object("Markings", mark_md, subs["Roads"])

    if graph.get("rails"):
        meshdata_to_object("Rails", _rail_meshdata(graph["rails"], field), subs["Roads"])

    # 5. areas (draped) + water
    tick(60, "areas")
    area_md = geom.new_meshdata()
    water_md = geom.new_meshdata()
    for a in graph["areas"]:
        kind = a["kind"]
        try:
            if kind == "water":
                verts3, tris = _subdivided_area(a["ring"], a.get("holes", []),
                                                lambda x, y: WATER_SURFACE_Z, rounds=0)
                target, mat = water_md, "water"
            elif kind == "plaza":
                geom.add_prism(area_md, a["ring"], 0.0, 0.14, "curb", mat_top="paver",
                               holes=a.get("holes", []))
                continue
            else:
                z_off = AREA_Z.get(kind, 0.03)
                verts3, tris = _subdivided_area(
                    a["ring"], a.get("holes", []),
                    lambda x, y, zo=z_off: conformed_z(x, y) + zo)
                target, mat = area_md, AREA_MAT.get(kind, "grass")
        except Exception:
            continue  # one bad ring never kills the build
        base = len(target["verts"])
        target["verts"].extend(verts3)
        for t in tris:
            target["faces"].append([base + t[0], base + t[1], base + t[2]])
            target["mats"].append(mat)
    counts["areas"] = len(graph["areas"])
    meshdata_to_object("Areas", area_md, subs["Areas"])
    meshdata_to_object("Water", water_md, subs["Areas"])

    # 6. buildings
    tick(72, "buildings")
    n_b = 0
    if params.get("do_buildings", True):
        pier_md = geom.new_meshdata()
        merged = geom.new_meshdata()
        for b in graph["buildings"]:
            cx = sum(p[0] for p in b["ring"]) / len(b["ring"])
            cy = sum(p[1] for p in b["ring"]) / len(b["ring"])
            if _water_fraction(b["ring"], water_areas) >= 0.5:
                base_z = 0.0
                _pier_prism(pier_md, b["ring"])
            else:
                base_z = field.sample(cx, cy)
            try:
                bmd = roofs.build_building(b, base_z)
            except Exception:
                continue
            if params.get("separate_buildings"):
                meshdata_to_object(f"Building {b['id']}", bmd, subs["Buildings"])
            else:
                geom.merge_meshdata(merged, bmd)
            n_b += 1
        if not params.get("separate_buildings"):
            meshdata_to_object("Buildings", merged, subs["Buildings"])
        meshdata_to_object("Piers", pier_md, subs["Buildings"])
    counts["buildings"] = n_b

    # 7. landmarks
    tick(84, "landmarks")
    n_lm = 0
    if params.get("do_landmarks", True):
        seg_by_road = {}
        for s in segs:
            seg_by_road.setdefault(s["road_idx"], s)
        for lm in landmarks_gen.detect(graph["roads"]):
            pts, elevs = [], []
            for ri in lm["road_idxs"]:
                s = seg_by_road.get(ri)
                if not s:
                    continue
                pts.extend(s["pts"] if not pts else s["pts"][1:])
                elevs.extend(s["elev"] if not elevs else s["elev"][1:])
            if len(pts) < 2:
                continue
            width = max(graph["roads"][ri]["width"] for ri in lm["road_idxs"])
            try:
                if lm["kind"] == "suspension":
                    md = landmarks_gen.build_suspension(pts, elevs, width, lm.get("color"))
                else:
                    md = landmarks_gen.build_arch(pts, elevs, width, lm.get("color"),
                                                  water_y=WATER_SURFACE_Z,
                                                  towers=lm.get("towers", False))
            except Exception:
                continue
            if md and md["faces"]:
                meshdata_to_object(f"Landmark {lm['kind']} {n_lm}", md, subs["Landmarks"])
                n_lm += 1
    counts["landmarks"] = n_lm

    # 8. props + trees (instanced)
    tick(92, "props")
    n_props = 0
    if params.get("do_props", True) or params.get("do_trees", True):
        def road_z(seg, station):
            cum = geom.arc_lengths(seg["pts"])
            if not cum or cum[-1] <= 0:
                return seg["elev"][0] if seg["elev"] else 0.0
            station = max(0.0, min(cum[-1], station))
            for i in range(1, len(cum)):
                if cum[i] >= station:
                    t = (station - cum[i - 1]) / max(1e-9, cum[i] - cum[i - 1])
                    return geom.lerp(seg["elev"][i - 1], seg["elev"][i], t)
            return seg["elev"][-1]

        placements = props_gen.place_props(
            graph, network, road_z, field.sample,
            {"props": params.get("do_props", True), "trees": params.get("do_trees", True)})
        template_meshes = {}
        for p in placements:
            tname = p["template"]
            if tname not in template_meshes:
                tmd = props_gen.TEMPLATES[tname]()
                tobj = meshdata_to_object(f"CBT {tname}", tmd, subs["Props"])
                if tobj is None:
                    continue
                tobj.hide_viewport = True
                tobj.hide_render = True
                template_meshes[tname] = tobj.data
            coll = subs["Trees"] if tname in ("tree", "shrub") else subs["Props"]
            obj = bpy.data.objects.new(f"{tname}", template_meshes[tname])
            obj.location = p["pos"]
            obj.rotation_euler = (0, 0, p.get("rot_z", 0.0))
            s = p.get("scale", 1.0)
            obj.scale = (s, s, s)
            coll.objects.link(obj)
            n_props += 1
    counts["props"] = n_props

    # 9. export payload on the scene
    tick(97, "export data")
    context.scene["cb_export"] = json.dumps(
        _export_payload(graph, solve, radius), separators=(",", ":"))
    return counts


def _export_payload(graph, solve, radius):
    roads_out = []
    for i, r in enumerate(graph["roads"]):
        cum = geom.arc_lengths(r["pts"])
        try:
            prof = solve.profile(i, cum)
        except Exception:
            prof = [0.0] * len(r["pts"])
        drivable = r["class"] not in overpass.NON_DRIVABLE
        roads_out.append({
            "id": f"road_{r['id']}", "name": r.get("name"), "class": r["class"],
            "drivable": drivable, "width_m": round(r["width"], 2),
            "lanes": r.get("lanes") or 0,
            "oneway": bool(r.get("oneway")), "roundabout": bool(r.get("roundabout")),
            "bridge": bool(r.get("bridge")), "tunnel": bool(r.get("tunnel")),
            "maxspeed": r.get("maxspeed"),
            "surface": r.get("surface") or SURFACE_EXPORT.get(r["class"], "asphalt-worn"),
            "length_m": round(cum[-1] if cum else 0.0, 2),
            "centerline": [[round(p[0], 2), round(z, 2), round(-p[1], 2)]
                           for p, z in zip(r["pts"], prof)],
        })
    buildings_out = []
    for b in graph["buildings"]:
        cx = sum(p[0] for p in b["ring"]) / len(b["ring"])
        cy = sum(p[1] for p in b["ring"]) / len(b["ring"])
        tier = "landmark" if (b["height"] >= 70 or b.get("name")) else "standard"
        buildings_out.append({"id": f"bld_{b['id']}", "name": b.get("name"),
                              "tier": tier, "position": [round(cx, 2), 0, round(-cy, 2)]})
    return {
        "city": graph["center"].get("name") or "OSM City",
        "origin": {"lat": graph["center"].get("lat"), "lon": graph["center"].get("lon")},
        "bounds": {"minX": -radius, "maxX": radius, "minZ": -radius, "maxZ": radius},
        "radius": radius,
        "roads": roads_out,
        "buildings": buildings_out,
        "devices": [],  # filled by props placement in a later pass
    }