"""Headless smoke test for the CityBuilder OSM extension.

Run:  blender --background --factory-startup --online-mode --python test_headless.py -- [outdir]

Registers the extension from source (no install needed), builds a real city
around Prague Staré Město (300 m), asserts non-trivial output, saves a .blend
and renders a Workbench overview PNG into [outdir] (default: this folder).
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else HERE
sys.path.insert(0, HERE)

import citybuilder_osm  # noqa: E402

citybuilder_osm.register()

scene = bpy.context.scene
p = scene.citybuilder
p.lat, p.lon, p.radius = 50.0870, 14.4208, 300

result = bpy.ops.citybuilder.build()
assert result == {"FINISHED"}, f"operator returned {result}"

root = bpy.data.collections.get("CityBuilder")
assert root, "CityBuilder collection missing"


def count(sub):
    coll = bpy.data.collections.get(f"CityBuilder {sub}")
    return len(coll.objects) if coll else 0


def verts(sub):
    coll = bpy.data.collections.get(f"CityBuilder {sub}")
    return sum(len(o.data.vertices) for o in coll.objects if o.type == "MESH") if coll else 0


print(f"objects  — buildings:{count('Buildings')} roads:{count('Roads')} "
      f"areas:{count('Areas')} trees:{count('Trees')}")
print(f"vertices — buildings:{verts('Buildings')} roads:{verts('Roads')} areas:{verts('Areas')}")
assert verts("Buildings") > 100, "suspiciously few building vertices"
assert verts("Roads") > 50, "suspiciously few road vertices"

# camera + sun for an overview render
cam_data = bpy.data.cameras.new("TestCam")
cam = bpy.data.objects.new("TestCam", cam_data)
scene.collection.objects.link(cam)
r = p.radius
cam.location = (r * 0.9, -r * 0.9, r * 0.95)
from mathutils import Vector  # noqa: E402
direction = Vector((0, 0, 0)) - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
cam_data.lens = 24
cam_data.clip_end = 10000
scene.camera = cam

sun_data = bpy.data.lights.new("Sun", "SUN")
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.filepath = os.path.join(OUT, "test_render.png")
bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "test_city.blend"))
print("OK — saved", scene.render.filepath)
