"""Cycles beauty renders from a saved test-matrix .blend.

  blender --background <city.blend> --python showcase.py -- <outprefix> [bridge]

Shots: overview (high 3/4), road (driver camera on an asphalt street with
markings), and optionally bridge (looking along the landmark span).
"""
import json
import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["shot"]
PREFIX = os.path.abspath(argv[0])
WANT_BRIDGE = len(argv) > 1 and argv[1] == "bridge"

scene = bpy.context.scene

# --- Cycles setup (GPU if available, denoised) ---------------------------------
scene.render.engine = "CYCLES"
scene.cycles.samples = 96
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
    print("[showcase] Cycles on Metal GPU")
except Exception as e:
    print(f"[showcase] GPU unavailable ({e}); CPU render")
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080

# --- sky + sun ------------------------------------------------------------------
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
sky = nt.nodes.new("ShaderNodeTexSky")
bgn = nt.nodes.new("ShaderNodeBackground")
out = nt.nodes.new("ShaderNodeOutputWorld")
try:
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(38)
    sky.sun_rotation = math.radians(60)
    sky.sun_intensity = 0.4
except Exception:
    pass
bgn.inputs[1].default_value = 0.55
scene.view_settings.exposure = -0.35
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass
nt.links.new(sky.outputs[0], bgn.inputs[0])
nt.links.new(bgn.outputs[0], out.inputs[0])
for o in list(scene.objects):
    if o.type == "LIGHT":
        bpy.data.objects.remove(o, do_unlink=True)


def make_cam(name, loc, look_at, lens=30):
    from mathutils import Vector
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.clip_end = 30000
    cam = bpy.data.objects.new(name, cam_data)
    scene.collection.objects.link(cam)
    cam.location = loc
    direction = Vector(look_at) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return cam


def render(cam, path):
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"[showcase] saved {path}")


export = json.loads(scene["cb_export"])
radius = export.get("radius", 500)

# overview
render(make_cam("SC_Over", (radius * 0.7, -radius * 0.75, radius * 0.55), (0, 0, 20), 32),
       f"{PREFIX}_over.png")

# driver camera: longest asphalt road with a centre marking (tertiary/residential/secondary)
MARKED = {"secondary", "tertiary", "residential", "unclassified"}
roads = [r for r in export["roads"]
         if r["drivable"] and not r["bridge"] and r["class"] in MARKED
         and (r.get("surface") or "").startswith("asphalt") and r["length_m"] > 80]
roads.sort(key=lambda r: -r["length_m"])
if roads:
    cl = roads[0]["centerline"]
    i = len(cl) // 2
    mid, nxt = cl[i], cl[min(i + 1, len(cl) - 1)]
    mx, my, mz = mid[0], -mid[2], mid[1]
    dx, dy = nxt[0] - mid[0], -(nxt[2] - mid[2])
    dl = math.hypot(dx, dy) or 1.0
    dx, dy = dx / dl, dy / dl
    render(make_cam("SC_Road", (mx - dx * 2 + dy * 1.7, my - dy * 2 - dx * 1.7, mz + 1.5),
                    (mx + dx * 45, my + dy * 45, mz + 0.8), 30),
           f"{PREFIX}_road.png")

# bridge shot
if WANT_BRIDGE:
    spans = [r for r in export["roads"] if r["bridge"] and r["length_m"] > 150]
    spans.sort(key=lambda r: -r["length_m"])
    if spans:
        cl = spans[0]["centerline"]
        mid = cl[len(cl) // 2]
        mx, my, mz = mid[0], -mid[2], mid[1]
        a, b = cl[0], cl[-1]
        dx, dy = b[0] - a[0], -(b[2] - a[2])
        dl = math.hypot(dx, dy) or 1.0
        dx, dy = dx / dl, dy / dl
        side = max(90.0, dl * 0.35)
        render(make_cam("SC_Bridge",
                        (mx + dy * side, my - dx * side, mz + 30),
                        (mx, my, mz + 18), 35),
               f"{PREFIX}_bridge.png")
print("[showcase] done")