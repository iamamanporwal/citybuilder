"""Headless integration matrix for the CityBuilder OSM extension (v0.5).

Run one scenario:
  blender --background --factory-startup --online-mode --python test_headless.py -- \
      <scenario> <outdir>

Scenarios: prague (hills terrain, dense old town, framed roads, river),
           goldengate (real DEM, suspension landmark, water),
           quick (small Prague radius, flat — fast smoke).

Each run: fetch → build → assert counts → save .blend → render overview PNG +
road-level PNG (1.6 m above a drivable road — the game camera angle).
"""
import json
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SCENARIO = argv[0] if argv else "quick"
OUT = argv[1] if len(argv) > 1 else HERE
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, HERE)

SCENARIOS = {
    "prague": dict(lat=50.0870, lon=14.4208, radius=500, terrain="HILLS",
                   quality="MED", name="Prague — Staré Město"),
    "goldengate": dict(lat=37.8145, lon=-122.4775, radius=700, terrain="DEM",
                       quality="MED", name="San Francisco — Golden Gate"),
    "london": dict(lat=51.5055, lon=-0.0754, radius=600, terrain="HILLS",
                   quality="MED", name="London — Tower Bridge"),
    "quick": dict(lat=50.0870, lon=14.4208, radius=300, terrain="FLAT",
                  quality="LOW", name="Prague quick"),
}
cfg = SCENARIOS[SCENARIO]

import citybuilder_osm  # noqa: E402

citybuilder_osm.register()

scene = bpy.context.scene
p = scene.citybuilder
p.preset = "CUSTOM"
p.lat, p.lon, p.radius = cfg["lat"], cfg["lon"], cfg["radius"]
p.terrain_mode = cfg["terrain"]
p.quality = cfg["quality"]
p.city_name = cfg["name"]

t0 = time.time()
result = bpy.ops.citybuilder.build()
assert result == {"FINISHED"}, f"build operator returned {result}"
print(f"[matrix] {SCENARIO}: built in {time.time() - t0:.1f}s")


def coll_verts(sub):
    coll = bpy.data.collections.get(f"CityBuilder {sub}")
    if not coll:
        return 0
    return sum(len(o.data.vertices) for o in coll.objects if o.type == "MESH")


stats = {s: coll_verts(s) for s in
         ("Ground", "Roads", "Junctions", "Areas", "Buildings", "Landmarks", "Props", "Trees")}
print(f"[matrix] verts: {stats}")
assert stats["Roads"] > 1000, "road sweep produced too little geometry"
assert stats["Buildings"] > 1000, "buildings missing"
assert stats["Ground"] > 100, "terrain missing"
assert stats["Junctions"] > 0, "no junction pads"
if SCENARIO in ("goldengate", "london"):
    assert stats["Landmarks"] > 500, f"landmark bridge missing in {SCENARIO}"

export_data = json.loads(scene["cb_export"])
assert export_data["roads"], "cb_export has no roads"

# ---- cameras + render ----------------------------------------------------------


def make_cam(name, loc, look_at, lens=28):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.clip_end = 20000
    cam = bpy.data.objects.new(name, cam_data)
    scene.collection.objects.link(cam)
    cam.location = loc
    from mathutils import Vector
    direction = Vector(look_at) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return cam


sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 3.5
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (math.radians(45), 0, math.radians(35))
scene.collection.objects.link(sun)
if scene.world is None:
    scene.world = bpy.data.worlds.new("World")
scene.world.use_nodes = True
bg = scene.world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (0.55, 0.7, 0.9, 1.0)
    bg.inputs[1].default_value = 0.7

# road-level camera: midpoint of the longest drivable non-bridge road
best = max((r for r in export_data["roads"] if r["drivable"] and not r["bridge"]),
           key=lambda r: r["length_m"], default=None)
road_cam = None
if best:
    cl = best["centerline"]
    mid = cl[len(cl) // 2]
    nxt = cl[min(len(cl) // 2 + 1, len(cl) - 1)]
    # game coords [x, z_up, -y] → blender (x, y, z)
    mx, my, mz = mid[0], -mid[2], mid[1]
    dx, dy = nxt[0] - mid[0], -(nxt[2] - mid[2])
    dl = math.hypot(dx, dy) or 1.0
    dx, dy = dx / dl, dy / dl
    road_cam = make_cam("RoadCam",
                        (mx - dx * 4, my - dy * 4, mz + 1.6),
                        (mx + dx * 40, my + dy * 40, mz + 1.2), lens=32)

r = cfg["radius"]
over_cam = make_cam("OverCam", (r * 0.75, -r * 0.8, r * 0.7), (0, 0, 0), lens=30)

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000


def render(cam, path):
    scene.camera = cam
    scene.render.filepath = path
    try:
        bpy.ops.render.render(write_still=True)
        return True
    except Exception as e:
        print(f"[matrix] EEVEE failed ({e}); falling back to Workbench")
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        bpy.ops.render.render(write_still=True)
        return True


render(over_cam, os.path.join(OUT, f"{SCENARIO}_over.png"))
if road_cam:
    render(road_cam, os.path.join(OUT, f"{SCENARIO}_road.png"))

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f"{SCENARIO}.blend"))
print(f"[matrix] {SCENARIO} OK — {OUT}")