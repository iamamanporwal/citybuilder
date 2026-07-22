"""Headless test for export_game.py — run with:

  /opt/homebrew/bin/blender --background --factory-startup \
      --python test_export.py

Builds a fake CityBuilder scene (2 cubes in the collection tree + a synthetic
scene["cb_export"] payload), checks write_unity_json output against the §A
schema, then drives the CITYBUILDER_OT_export_game operator and checks the
GLB it writes. Exits non-zero on any failure.
"""
import json
import math
import os
import shutil
import sys
import tempfile
import traceback

import bpy

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
MODULE_DIR = os.path.join(PLUGIN_DIR, "citybuilder_osm")
sys.path.insert(0, MODULE_DIR)

import export_game  # noqa: E402  (standalone import; falls back to `import geom`)


def make_cube(name, coll, origin=(0.0, 0.0, 0.0), size=2.0):
    """Plain bpy cube mesh (no ops — reliable in --factory-startup background)."""
    h = size / 2.0
    ox, oy, oz = origin
    verts = [(ox + sx * h, oy + sy * h, oz + sz * h)
             for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
             (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    return obj


def build_payload():
    """3 synthetic roads (one bridge, one maxspeed-tagged) / 1 device /
    2 buildings / bounds / city name — game/glTF coords [x, z_up, -y_north]."""
    return {
        "city": "Fakeville",
        "origin": {"lat": 50.087, "lon": 14.4208},
        "bounds": {"minX": -400, "maxX": 400, "minZ": -400, "maxZ": 400},
        "radius": 400,
        "roads": [
            # best spawn: primary through the centre, wide + long
            {"id": "road_100", "name": "Hlavni", "class": "primary", "drivable": True,
             "width_m": 11.0, "lanes": 4, "oneway": False, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": None,
             "surface": "asphalt-worn", "length_m": 180.0,
             "centerline": [[-90.0, 0.0, 0.0], [90.0, 0.0, 0.0]]},
            # residential AT +X with an OSM maxspeed tag → source "tag"
            {"id": "road_200", "name": None, "class": "residential", "drivable": True,
             "width_m": 6.0, "lanes": 2, "oneway": False, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": 30,
             "surface": "asphalt-worn", "length_m": 80.0,
             "centerline": [[150.0, 0.5, -40.0], [150.0, 0.5, 40.0]]},
            # bridge — excluded from spawn no matter how well it scores
            {"id": "road_300", "name": "Most", "class": "primary", "drivable": True,
             "width_m": 12.0, "lanes": 4, "oneway": False, "roundabout": False,
             "bridge": True, "tunnel": False, "maxspeed": None,
             "surface": "asphalt-new", "length_m": 250.0,
             "centerline": [[-125.0, 7.0, 5.0], [125.0, 7.0, 5.0]]},
        ],
        "devices": [
            {"id": "sig_1", "kind": "traffic_signal", "position": [12.0, 3.0, -6.0],
             "heading_rad": 0.5, "sign_type": None, "speed_limit_kmh": None},
        ],
        "buildings": [
            {"id": "bld_10", "name": "Radnice", "tier": "landmark",
             "position": [60.0, 0.0, -25.0]},
            {"id": "bld_11", "name": None, "tier": "standard",
             "position": [-45.0, 0.0, 30.0]},
        ],
    }


def main():
    scene = bpy.context.scene

    # --- fake CityBuilder scene: root collection + sub, 2 cube objects
    root = bpy.data.collections.new("CityBuilder")
    scene.collection.children.link(root)
    sub = bpy.data.collections.new("CityBuilder Roads")
    root.children.link(sub)
    make_cube("cb_cube_a", root, origin=(0.0, 0.0, 1.0))
    make_cube("cb_cube_b", sub, origin=(10.0, 5.0, 1.0))

    payload = build_payload()
    scene["cb_export"] = json.dumps(payload, separators=(",", ":"))

    out_dir = tempfile.mkdtemp(prefix="test_export_", dir=PLUGIN_DIR)
    try:
        # ---------- pure JSON writer ----------
        path = export_game.write_unity_json(payload, out_dir)
        with open(path, encoding="utf-8") as f:
            city = json.load(f)

        # exact top-level schema keys (§A)
        assert list(city.keys()) == [
            "format", "formatVersion", "city", "attribution", "bounds",
            "coordinateSystem", "spawn", "stats", "roads", "traffic_devices",
            "buildings"], f"schema keys wrong: {list(city.keys())}"
        assert city["format"] == "citybuilder-unity-city"
        assert city["formatVersion"] == 1
        assert city["city"] == "Fakeville"
        assert city["attribution"] == "© OpenStreetMap contributors (ODbL 1.0)"

        # spawn picked the best road: road_100 (centre + class + width + length)
        sdoc_path = export_game.write_spawn_json(payload, out_dir)
        with open(sdoc_path, encoding="utf-8") as f:
            sdoc = json.load(f)
        assert sdoc["spawnVersion"] == 1
        assert sdoc["spawn"]["road_id"] == "road_100", sdoc["spawn"]
        # midpoint (0, 0, 0) at elev + 0.5; unity copy X-negated (0 stays 0)
        assert city["spawn"]["position"] == [0.0, 0.5, 0.0], city["spawn"]
        assert city["spawn"]["heading_rad"] == 0.0

        # X negation applied: road_200 lives at x=+150 → exported at −150
        by_id = {r["id"]: r for r in city["roads"]}
        xs = {p[0] for p in by_id["road_200"]["centerline"]}
        assert xs == {-150.0}, f"X not negated: {xs}"
        assert [p[2] for p in by_id["road_200"]["centerline"]] == [-40.0, 40.0]  # Z kept
        # device too: +12 → −12, heading 0.5 → −0.5
        dev = city["traffic_devices"][0]
        assert dev["position"] == [-12.0, 3.0, -6.0] and dev["heading_rad"] == -0.5

        # speed_limit_source correct: untagged primary → default 60, tag → 30
        assert by_id["road_100"]["speed_limit_kmh"] == 60
        assert by_id["road_100"]["speed_limit_source"] == "default"
        assert by_id["road_200"]["speed_limit_kmh"] == 30
        assert by_id["road_200"]["speed_limit_source"] == "tag"

        assert city["stats"]["roads"] == 3
        assert city["stats"]["drivable_roads"] == 3
        assert city["stats"]["buildings"] == 2 and city["stats"]["traffic_devices"] == 1
        assert all(math.isfinite(p[i]) for r in city["roads"]
                   for p in r["centerline"] for i in range(3))

        # ---------- operator ----------
        export_game.register()
        export_game.register()  # double-register must be a no-op, not an error

        # missing cb_export → error report (bpy.ops surfaces it as RuntimeError)
        del scene["cb_export"]
        try:
            bpy.ops.citybuilder.export_game(directory=out_dir)
            raise AssertionError("operator should have errored without cb_export")
        except RuntimeError as e:
            assert "cb_export" in str(e), e
        scene["cb_export"] = json.dumps(payload, separators=(",", ":"))

        op_dir = os.path.join(out_dir, "op")
        result = bpy.ops.citybuilder.export_game(directory=op_dir)
        assert result == {"FINISHED"}, f"operator failed: {result}"

        for name in ("unity_city.json", "citymap_spawn.json", "city_scene.glb"):
            p = os.path.join(op_dir, name)
            assert os.path.isfile(p), f"missing {name}"
        glb = os.path.join(op_dir, "city_scene.glb")
        size = os.path.getsize(glb)
        assert size > 1024, f"city_scene.glb too small: {size} B"
        with open(glb, "rb") as f:
            assert f.read(4) == b"glTF", "not a GLB file"

        # operator's unity_city.json parses and matches the pure writer's output
        with open(os.path.join(op_dir, "unity_city.json"), encoding="utf-8") as f:
            assert json.load(f) == city

        export_game.unregister()
        export_game.unregister()  # double-unregister must also be safe

        print("test_export.py: ALL TESTS PASSED "
              f"(city_scene.glb {size} B, spawn {sdoc['spawn']['road_id']})")
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
