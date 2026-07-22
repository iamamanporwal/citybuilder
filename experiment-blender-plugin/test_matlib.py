"""matlib.py acceptance test — run inside Blender:

    /opt/homebrew/bin/blender --background --factory-startup --python test_matlib.py

Builds every material via matlib.get(), checks node-graph invariants, then
Workbench-renders a grid of spheres (one per material) to matlib_test.png.
Registers nothing — plain module import, no add-on machinery.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "citybuilder_osm"))

# empty scene FIRST (materials created after this survive)
bpy.ops.wm.read_factory_settings(use_empty=True)

import matlib  # noqa: E402

# ---- every key builds and carries a Principled node graph ----------------------
keys = list(matlib.MATERIALS)
for k in keys:
    m = matlib.get(k)
    assert m.name == f"CB {k}", m.name
    assert m.node_tree is not None, k
    assert any(n.type == "BSDF_PRINCIPLED" for n in m.node_tree.nodes), k
    assert all(math.isfinite(c) for c in m.diffuse_color), k

# ---- facade invariants ----------------------------------------------------------
w = matlib.get("building_wall")
assert any(n.type == "ATTRIBUTE" and n.attribute_name == "tint"
           for n in w.node_tree.nodes), "building_wall: no tint Attribute node"
wb = next(n for n in w.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
assert wb.inputs["Emission Strength"].is_linked, "building_wall: no emission link"

# ---- grid of material spheres ---------------------------------------------------
COLS = 6
SPACING = 2.4
for i, k in enumerate(keys):
    x = (i % COLS) * SPACING
    y = -(i // COLS) * SPACING
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=24, ring_count=16,
                                         location=(x, y, 1.0))
    ob = bpy.context.active_object
    ob.name = f"sph_{k}"
    me = ob.data
    # scale UVs so metre-based patterns (bricks, facade grid) show on a unit sphere
    uv = me.uv_layers.active
    if uv is not None:
        for d in uv.data:
            d.uv = (d.uv[0] * 8.0, d.uv[1] * 8.0)
    # per-face float attrs the shaders read (tint palette, terrain rock splat)
    for aname in ("tint", "rock"):
        attr = me.attributes.new(aname, "FLOAT", "FACE")
        vals = [((fi * 37) % 101) / 101.0 for fi in range(len(me.polygons))]
        attr.data.foreach_set("value", vals)
    me.materials.append(matlib.get(k))

rows = (len(keys) + COLS - 1) // COLS
center = Vector(((COLS - 1) * SPACING / 2.0, -(rows - 1) * SPACING / 2.0, 1.0))

# ---- camera + sun ---------------------------------------------------------------
scene = bpy.context.scene
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
cam.location = center + Vector((0.0, -18.0, 14.0))
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (0.9, 0.15, 0.6)
scene.collection.objects.link(sun)

# ---- Workbench render -----------------------------------------------------------
# (dynamic enum: Workbench is registered but absent from bl_rna's static items)
scene.render.engine = "BLENDER_WORKBENCH"
assert scene.render.engine == "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"   # shows mat.diffuse_color
scene.render.resolution_x = scene.render.resolution_y = 800
out_path = os.path.join(HERE, "matlib_test.png")
scene.render.filepath = out_path
bpy.ops.render.render(write_still=True)

assert os.path.exists(out_path) and os.path.getsize(out_path) > 10_000, out_path
print(f"test_matlib OK — {len(keys)} materials, render at {out_path}")
