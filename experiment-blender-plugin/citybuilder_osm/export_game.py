"""Game export — unity_city.json + citymap_spawn.json + city_scene.glb.

Reads the ``scene["cb_export"]`` payload written by build.py (Scene export
contract, SPEC.md) and emits the Unity bundle matching the app's
tools/unity-export.mjs post-processor:

* JSON positions are GAME coords [x, z_up, -y_north] (glTF Y-up) with X
  negated for Unity's left-handed import (glTFast negates X the same way),
  so unity_city.json lines up 1:1 with the imported GLB.
* Headings are yaw about +Y (0 = +X, CCW); the X-flip mirrors the world,
  which negates yaw, so headings are negated with it.
* Positions rounded to 2 dp, headings to 4 dp.

The JSON writers are PURE (no bpy) so this file's core is python3-testable;
only the operator below touches Blender.
"""
import json
import math
import os

try:
    from . import geom
except ImportError:  # plain python3 run (tests)
    import geom

try:
    import bpy
except ImportError:  # pure-python context — JSON writers still work
    bpy = None

ATTRIBUTION = "© OpenStreetMap contributors (ODbL 1.0)"  # exact ODbL credit
ROOT_NAME = "CityBuilder"  # collection tree exported to city_scene.glb

# Spawn scoring (specs/export-landmarks-props.md §A): classes outside this
# table rank 1, matching the app's `CLASS_RANK[r.class] ?? 1`.
CLASS_RANK = {"primary": 5, "secondary": 4, "tertiary": 3, "residential": 2, "service": 1}

# Default speeds km/h when OSM has no maxspeed tag (§A).
DEFAULT_SPEED_KMH = {
    "motorway": 100, "trunk": 90, "primary": 60,
    "secondary": 50, "tertiary": 50, "unclassified": 40,
    "residential": 30, "living_street": 20, "service": 20, "pedestrian": 10,
}
FALLBACK_SPEED_KMH = 40  # unknown drivable class (mirrors app effectiveSpeed)


# ---- rounding ------------------------------------------------------------------

def _r(v, dp=2):
    """Round and normalise -0.0 → 0.0 (the X-flip loves to mint -0.0)."""
    out = round(float(v), dp)
    return 0.0 if out == 0 else out


def _num(v):
    """Coerce OSM maxspeed-ish values to a finite float, else None."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ---- spawn selection (game/glTF coords, pre-flip) -------------------------------

def compute_spawn(export_data):
    """Best spawn per §A over drivable, non-bridge, non-tunnel roads >= 20 m.

    score = centre*0.4 + class*0.25 + width*0.2 + length*0.15
    Position = road midpoint at solved elevation + 0.5 m; heading faces down
    the centerline: atan2(-dz, dx) in game coords. Returns None if no road
    qualifies. Result is glTF-handed (pre-Unity-flip), like citymap_spawn.json.
    """
    bounds = export_data.get("bounds") or {}
    cx = (bounds.get("minX", 0.0) + bounds.get("maxX", 0.0)) / 2.0
    cz = (bounds.get("minZ", 0.0) + bounds.get("maxZ", 0.0)) / 2.0
    radius = _num(export_data.get("radius"))
    if not radius or radius <= 0:
        radius = max(bounds.get("maxX", 0.0) - bounds.get("minX", 0.0),
                     bounds.get("maxZ", 0.0) - bounds.get("minZ", 0.0)) / 2.0 or 1.0

    best = None
    best_score = -1.0
    for r in export_data.get("roads") or []:
        if not r.get("drivable") or r.get("bridge") or r.get("tunnel"):
            continue
        line = r.get("centerline") or []
        if len(line) < 2:
            continue
        cum = geom.arc_lengths([(p[0], p[2]) for p in line])  # ground-plane length
        length = cum[-1]
        if length < 20.0:  # need room to accelerate
            continue

        # midpoint by arc length (position + local direction)
        half_len = length / 2.0
        i = len(cum) - 2
        for k in range(len(cum) - 1):
            if cum[k + 1] >= half_len:
                i = k
                break
        t = (half_len - cum[i]) / max(1e-9, cum[i + 1] - cum[i])
        a, b = line[i], line[i + 1]
        mx, my, mz = (geom.lerp(a[0], b[0], t), geom.lerp(a[1], b[1], t),
                      geom.lerp(a[2], b[2], t))
        dx, dz = b[0] - a[0], b[2] - a[2]
        mag = math.hypot(dx, dz) or 1.0
        dx, dz = dx / mag, dz / mag

        centre_score = max(0.0, min(1.0, 1.0 - math.hypot(mx - cx, mz - cz) / radius))
        class_score = CLASS_RANK.get(r.get("class"), 1) / 5.0
        width_score = min(1.0, (_num(r.get("width_m")) or 0.0) / 12.0)
        length_score = min(1.0, length / 120.0)
        score = (centre_score * 0.4 + class_score * 0.25
                 + width_score * 0.2 + length_score * 0.15)
        if score > best_score:
            best_score = score
            best = {
                "position": [mx, my + 0.5, mz],
                "forward": [dx, 0.0, dz],
                "heading_rad": math.atan2(-dz, dx),  # yaw about +Y, 0=+X, CCW
                "road_id": r.get("id"),
                "road_class": r.get("class"),
                "width_m": r.get("width_m"),
                "note": "Auto-selected: widest drivable non-bridge road nearest the map centre.",
            }
    return best


# ---- unity_city.json (formatVersion 1) ------------------------------------------

def _polyline_length_3d(line):
    total = 0.0
    for i in range(1, len(line)):
        total += math.hypot(line[i][0] - line[i - 1][0],
                            line[i][1] - line[i - 1][1],
                            line[i][2] - line[i - 1][2])
    return total


def _flip_point(p):
    """Game/glTF point → Unity point: negate X, round 2 dp."""
    return [_r(-p[0]), _r(p[1]), _r(p[2])]


def write_unity_json(export_data, out_dir):
    """PURE: cb_export dict → <out_dir>/unity_city.json (schema per spec §A).

    Returns the written file path. Coordinates arrive as game/glTF Y-up
    [x, z_up, -y_north]; this negates X + negates headings for Unity.
    """
    spawn = compute_spawn(export_data)

    roads = []
    for r in export_data.get("roads") or []:
        line = r.get("centerline") or []
        lanes = int(r.get("lanes") or 0)
        width = _num(r.get("width_m")) or 0.0
        drivable = bool(r.get("drivable"))
        tagged = _num(r.get("maxspeed"))
        if not drivable:
            speed, speed_src = None, None
        elif tagged is not None:
            speed, speed_src = tagged, "tag"
        else:
            speed = DEFAULT_SPEED_KMH.get(r.get("class"), FALLBACK_SPEED_KMH)
            speed_src = "default"
        roads.append({
            "id": r.get("id"),
            "name": r.get("name"),
            "class": r.get("class"),
            "drivable": drivable,
            "width_m": width,
            "lanes": lanes,
            "lane_width_m": _r(width / lanes) if lanes > 0 else None,
            "oneway": bool(r.get("oneway")),
            "speed_limit_kmh": speed,
            "speed_limit_source": speed_src,
            "turn_lanes": r.get("turn_lanes"),
            "roundabout": bool(r.get("roundabout")),
            "bridge": bool(r.get("bridge")),
            "tunnel": bool(r.get("tunnel")),
            "surface": r.get("surface"),
            "length_m": _r(_polyline_length_3d(line)),
            "centerline": [_flip_point(p) for p in line],
        })

    devices = []
    for d in export_data.get("devices") or []:
        devices.append({
            "id": d.get("id"),
            "kind": d.get("kind"),
            "position": _flip_point(d.get("position") or (0, 0, 0)),
            "heading_rad": _r(-(d.get("heading_rad") or 0.0), 4),
            "sign_type": d.get("sign_type"),
            "speed_limit_kmh": d.get("speed_limit_kmh"),
        })

    buildings = []
    for b in export_data.get("buildings") or []:
        buildings.append({
            "id": b.get("id"),
            "name": b.get("name"),
            "tier": b.get("tier"),
            "position": _flip_point(b.get("position") or (0, 0, 0)),
            "look": b.get("look"),
        })

    # km by class — accumulate with per-step rounding like unity-export.mjs
    km_by_class = {}
    for r in roads:
        km_by_class[r["class"]] = _r(km_by_class.get(r["class"], 0.0)
                                     + r["length_m"] / 1000.0)

    doc = {
        "format": "citybuilder-unity-city",
        "formatVersion": 1,
        "city": export_data.get("city") or "OSM City",
        "attribution": ATTRIBUTION,
        "bounds": export_data.get("bounds"),
        "coordinateSystem": {
            "up": "Y",
            "units": "meters",
            "handedness": "left (Unity, X negated to match glTFast import)",
            "origin": "area center",
        },
        "spawn": {
            "position": _flip_point(spawn["position"]),
            "heading_rad": _r(-spawn["heading_rad"], 4),
        } if spawn else None,
        "stats": {
            "roads": len(roads),
            "drivable_roads": sum(1 for r in roads if r["drivable"]),
            "road_km_by_class": km_by_class,
            "total_road_km": _r(sum(km_by_class.values())),
            "buildings": len(buildings),
            "traffic_devices": len(devices),
        },
        "roads": roads,
        "traffic_devices": devices,
        "buildings": buildings,
    }

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "unity_city.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    return path


def write_spawn_json(export_data, out_dir):
    """PURE: <out_dir>/citymap_spawn.json (spawnVersion 1, glTF coords like the
    app bundle — unity_city.json carries the Unity-flipped copy). Returns path."""
    spawn = compute_spawn(export_data)
    doc = {
        "generator": "CityBuilder OSM (Blender)",
        "spawnVersion": 1,
        "city": export_data.get("city") or "OSM City",
        "spawn": spawn,
    }
    if not spawn:
        doc["note"] = "No drivable road found for auto-spawn; place manually."
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "citymap_spawn.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    return path


# ---- Blender operator ------------------------------------------------------------

if bpy is not None:

    def _collect_meshes(coll, out):
        """All MESH objects in a collection tree (depth-first)."""
        for obj in coll.objects:
            if obj.type == "MESH":
                out.append(obj)
        for child in coll.children:
            _collect_meshes(child, out)

    class CITYBUILDER_OT_export_game(bpy.types.Operator):
        """Export unity_city.json + citymap_spawn.json + city_scene.glb"""
        bl_idname = "citybuilder.export_game"
        bl_label = "Export Game Bundle"
        bl_options = {"REGISTER"}

        directory: bpy.props.StringProperty(
            name="Output folder", subtype="DIR_PATH",
            description="Folder receiving unity_city.json, citymap_spawn.json, city_scene.glb")

        def invoke(self, context, event):
            context.window_manager.fileselect_add(self)
            return {"RUNNING_MODAL"}

        def execute(self, context):
            raw = context.scene.get("cb_export")
            if not raw:
                self.report({"ERROR"},
                            "No export data on the scene — run Build City first "
                            "(scene['cb_export'] missing)")
                return {"CANCELLED"}
            try:
                data = json.loads(raw)
            except Exception as e:
                self.report({"ERROR"}, f"scene['cb_export'] is not valid JSON: {e}")
                return {"CANCELLED"}
            out_dir = bpy.path.abspath(self.directory) if self.directory else ""
            if not out_dir:
                self.report({"ERROR"}, "Choose an output folder")
                return {"CANCELLED"}

            write_unity_json(data, out_dir)
            write_spawn_json(data, out_dir)
            n_objects = self._export_glb(context, os.path.join(out_dir, "city_scene.glb"))

            self.report(
                {"INFO"},
                f"Exported {len(data.get('roads') or [])} roads, "
                f"{len(data.get('buildings') or [])} buildings, "
                f"{len(data.get('devices') or [])} devices, "
                f"{n_objects} scene objects → {out_dir}")
            return {"FINISHED"}

        def _export_glb(self, context, filepath):
            """GLB of the CityBuilder collection tree only, via selection filter.
            glTF exporter handles Z-up → Y-up. Returns exported object count."""
            root = bpy.data.collections.get(ROOT_NAME)
            targets = []
            if root:
                _collect_meshes(root, targets)
            if not targets:
                self.report({"WARNING"},
                            f"No mesh objects in the '{ROOT_NAME}' collection — "
                            "skipped city_scene.glb")
                return 0

            wanted = {obj.name for obj in targets}
            selected = 0
            for obj in context.view_layer.objects:
                try:
                    if obj.name in wanted:
                        obj.select_set(True)
                        selected += 1
                    else:
                        obj.select_set(False)
                except RuntimeError:
                    pass  # hidden template objects can't be (de)selected — skip
            if selected == 0:
                self.report({"WARNING"}, "No selectable CityBuilder meshes — skipped GLB")
                return 0

            kwargs = dict(filepath=filepath, export_format="GLB", use_selection=True,
                          export_yup=True, export_apply=True)
            try:
                bpy.ops.export_scene.gltf(**kwargs)
            except TypeError:  # older/newer exporter — drop optional kwargs
                bpy.ops.export_scene.gltf(filepath=filepath, export_format="GLB",
                                          use_selection=True)
            return selected

    _classes = (CITYBUILDER_OT_export_game,)
else:
    _classes = ()


def register():
    for cls in _classes:
        if getattr(bpy.types, cls.__name__, None) is None:  # guard double-register
            bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(_classes):
        if getattr(bpy.types, cls.__name__, None) is not None:
            bpy.utils.unregister_class(cls)


# ---- self-test (pure python3 — no bpy needed) -------------------------------------

if __name__ == "__main__":
    import shutil
    import tempfile

    def _walk_numbers(node):
        if isinstance(node, dict):
            for v in node.values():
                yield from _walk_numbers(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                yield from _walk_numbers(v)
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            yield node

    export_data = {
        "city": "Testville",
        "origin": {"lat": 50.0, "lon": 14.4},
        "bounds": {"minX": -500, "maxX": 500, "minZ": -500, "maxZ": 500},
        "radius": 500,
        "roads": [
            # Best spawn: primary, 200 m, dead-centre, 12 m wide → score 1.0
            {"id": "road_1", "name": "Main St", "class": "primary", "drivable": True,
             "width_m": 12.0, "lanes": 4, "oneway": False, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": None, "surface": "asphalt-worn",
             "length_m": 200.0,
             "centerline": [[-100.0, 0.0, 0.0], [100.0, 0.0, 0.0]]},
            # Offset residential heading -Z with a maxspeed tag → source "tag"
            {"id": "road_2", "name": None, "class": "residential", "drivable": True,
             "width_m": 6.0, "lanes": 2, "oneway": False, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": 40, "surface": "asphalt-worn",
             "length_m": 120.0,
             "centerline": [[200.0, 1.0, 60.0], [200.0, 1.0, -60.0]]},
            # Bridge — must be excluded from spawn even though it scores well
            {"id": "road_3", "name": "Span", "class": "primary", "drivable": True,
             "width_m": 12.0, "lanes": 4, "oneway": False, "roundabout": False,
             "bridge": True, "tunnel": False, "maxspeed": None, "surface": "asphalt-new",
             "length_m": 300.0,
             "centerline": [[-150.0, 8.0, 10.0], [150.0, 8.0, 10.0]]},
            # Non-drivable → speed null/null, never spawn
            {"id": "road_4", "name": None, "class": "footway", "drivable": False,
             "width_m": 2.0, "lanes": 0, "oneway": False, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": None, "surface": "pavers",
             "length_m": 50.0,
             "centerline": [[0.0, 0.0, 30.0], [0.0, 0.0, 80.0]]},
            # Too short (< 20 m) → never spawn
            {"id": "road_5", "name": None, "class": "service", "drivable": True,
             "width_m": 4.0, "lanes": 1, "oneway": True, "roundabout": False,
             "bridge": False, "tunnel": False, "maxspeed": None, "surface": "asphalt-worn",
             "length_m": 10.0,
             "centerline": [[5.0, 0.0, 5.0], [5.0, 0.0, 15.0]]},
        ],
        "devices": [
            {"id": "dev_1", "kind": "traffic_signal", "position": [10.0, 2.0, 5.0],
             "heading_rad": 1.0, "sign_type": None, "speed_limit_kmh": None},
        ],
        "buildings": [
            {"id": "bld_1", "name": "Town Hall", "tier": "landmark",
             "position": [50.0, 0.0, -20.0]},
            {"id": "bld_2", "name": None, "tier": "standard",
             "position": [-30.0, 0.0, 40.0]},
        ],
    }

    tmp = tempfile.mkdtemp(prefix="cb_export_selftest_")
    try:
        # --- compute_spawn (pre-flip, glTF coords)
        spawn = compute_spawn(export_data)
        assert spawn is not None and spawn["road_id"] == "road_1", spawn
        assert spawn["position"] == [0.0, 0.5, 0.0], spawn["position"]  # midpoint + 0.5
        assert abs(spawn["heading_rad"]) < 1e-12  # +X travel → yaw 0
        assert spawn["forward"] == [1.0, 0.0, 0.0]

        # heading convention: -Z travel → atan2(+1, 0) = +pi/2
        solo = dict(export_data, roads=[export_data["roads"][1]])
        s2 = compute_spawn(solo)
        assert abs(s2["heading_rad"] - math.pi / 2) < 1e-9, s2["heading_rad"]

        # no eligible roads → None
        assert compute_spawn(dict(export_data, roads=[export_data["roads"][2]])) is None

        # --- write_unity_json
        path = write_unity_json(export_data, tmp)
        assert os.path.basename(path) == "unity_city.json" and os.path.isfile(path)
        with open(path, encoding="utf-8") as f:
            city = json.load(f)

        # exact top-level schema keys (§A)
        assert list(city.keys()) == [
            "format", "formatVersion", "city", "attribution", "bounds",
            "coordinateSystem", "spawn", "stats", "roads", "traffic_devices",
            "buildings"], list(city.keys())
        assert city["format"] == "citybuilder-unity-city" and city["formatVersion"] == 1
        assert city["attribution"] == "© OpenStreetMap contributors (ODbL 1.0)"
        assert city["coordinateSystem"]["handedness"].startswith("left (Unity")
        assert list(city["stats"].keys()) == [
            "roads", "drivable_roads", "road_km_by_class", "total_road_km",
            "buildings", "traffic_devices"]
        assert city["stats"]["roads"] == 5 and city["stats"]["drivable_roads"] == 4
        assert city["stats"]["buildings"] == 2 and city["stats"]["traffic_devices"] == 1
        assert city["stats"]["road_km_by_class"]["primary"] == 0.5  # 200 + 300 m

        # exact per-road schema keys
        road_keys = ["id", "name", "class", "drivable", "width_m", "lanes",
                     "lane_width_m", "oneway", "speed_limit_kmh", "speed_limit_source",
                     "turn_lanes", "roundabout", "bridge", "tunnel", "surface",
                     "length_m", "centerline"]
        by_id = {r["id"]: r for r in city["roads"]}
        assert all(list(r.keys()) == road_keys for r in city["roads"])

        # X negation on centerlines (road_2 sits at x=+200 → -200), Z unchanged
        assert by_id["road_2"]["centerline"][0] == [-200.0, 1.0, 60.0]
        assert by_id["road_1"]["centerline"] == [[100.0, 0.0, 0.0], [-100.0, 0.0, 0.0]]

        # speed limits: default / tag / non-drivable null
        assert by_id["road_1"]["speed_limit_kmh"] == 60
        assert by_id["road_1"]["speed_limit_source"] == "default"
        assert by_id["road_2"]["speed_limit_kmh"] == 40
        assert by_id["road_2"]["speed_limit_source"] == "tag"
        assert by_id["road_4"]["speed_limit_kmh"] is None
        assert by_id["road_4"]["speed_limit_source"] is None
        assert by_id["road_5"]["speed_limit_source"] == "default"  # service default 20
        assert by_id["road_5"]["speed_limit_kmh"] == 20
        assert by_id["road_1"]["lane_width_m"] == 3.0
        assert by_id["road_4"]["lane_width_m"] is None
        assert by_id["road_1"]["length_m"] == 200.0

        # spawn flipped: x negated (0 stays 0, never -0.0), heading negated
        assert city["spawn"]["position"] == [0.0, 0.5, 0.0]
        assert city["spawn"]["heading_rad"] == 0.0
        assert not math.copysign(1, city["spawn"]["heading_rad"]) < 0  # no -0.0

        # device flip: position X negated, heading negated, 4 dp
        dev = city["traffic_devices"][0]
        assert dev["position"] == [-10.0, 2.0, 5.0] and dev["heading_rad"] == -1.0
        assert list(dev.keys()) == ["id", "kind", "position", "heading_rad",
                                    "sign_type", "speed_limit_kmh"]

        # buildings flipped, look null passthrough
        bld = {b["id"]: b for b in city["buildings"]}
        assert bld["bld_1"]["position"] == [-50.0, 0.0, -20.0]
        assert bld["bld_1"]["look"] is None
        assert list(bld["bld_1"].keys()) == ["id", "name", "tier", "position", "look"]

        # no NaN/inf anywhere
        assert all(math.isfinite(v) for v in _walk_numbers(city))

        # --- citymap_spawn.json (glTF coords, spawnVersion 1)
        spath = write_spawn_json(export_data, tmp)
        with open(spath, encoding="utf-8") as f:
            sdoc = json.load(f)
        assert sdoc["spawnVersion"] == 1 and sdoc["city"] == "Testville"
        assert sdoc["spawn"]["road_id"] == "road_1"
        assert sdoc["spawn"]["position"][0] == 0.0  # NOT flipped here

        # --- determinism: byte-identical on re-run
        with open(path, "rb") as f:
            first = f.read()
        write_unity_json(export_data, tmp)
        with open(path, "rb") as f:
            assert f.read() == first

        # empty-city degenerate input still writes valid JSON
        p_empty = write_unity_json({"city": "Empty"}, tmp)
        with open(p_empty, encoding="utf-8") as f:
            empty = json.load(f)
        assert empty["spawn"] is None and empty["stats"]["roads"] == 0

        print("export_game.py self-test: ALL ASSERTIONS PASSED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
