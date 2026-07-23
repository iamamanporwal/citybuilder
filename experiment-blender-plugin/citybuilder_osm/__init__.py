"""CityBuilder OSM — build real, game-ready 3D cities from OpenStreetMap data.

Blender extension (4.2+/5.x). UI: 3D-viewport N-panel, tab "CityBuilder".
v0.7: photo-PBR textures, roads v2 (parallel-way merge + osm2streets junctions),
living streets (verge grass/shrubs, forest fill, 3 tree species), buildings v3
(recognizer looks, straight-skeleton roofs, curtain walls, storefronts,
balconies, domes, building:part), church spires + water towers + chimneys,
elevation solve + terrain (flat/hills/real DEM), landmark bridges, street
props, game export (unity_city.json + GLB).
"""
import time
import traceback

import bpy

from . import build, export_game, geom, overpass

PRESETS = [
    ("PRAGUE", "Prague — Staré Město", 50.0870, 14.4208, 500),
    ("SF_GG", "San Francisco — Golden Gate", 37.8199, -122.4783, 900),
    ("MANHATTAN", "New York — Midtown", 40.7580, -73.9855, 600),
    ("LONDON", "London — Tower Bridge", 51.5055, -0.0754, 700),
    ("TOKYO", "Tokyo — Shibuya", 35.6595, 139.7005, 600),
]
PRESET_ITEMS = [(p[0], p[1], "") for p in PRESETS] + [("CUSTOM", "Custom", "")]


def _apply_preset(self, context):
    for pid, label, lat, lon, radius in PRESETS:
        if self.preset == pid:
            self.lat, self.lon, self.radius = lat, lon, radius
            self.city_name = label
            break


class CityBuilderProps(bpy.types.PropertyGroup):
    preset: bpy.props.EnumProperty(
        name="Location", items=PRESET_ITEMS, default="PRAGUE", update=_apply_preset)
    city_name: bpy.props.StringProperty(name="City name", default="Prague — Staré Město")
    lat: bpy.props.FloatProperty(name="Latitude", default=50.0870, min=-85, max=85, precision=6)
    lon: bpy.props.FloatProperty(name="Longitude", default=14.4208, min=-180, max=180, precision=6)
    radius: bpy.props.IntProperty(
        name="Radius (m)", default=500, min=100, max=1500,
        description="Half-size of the fetched square")
    terrain_mode: bpy.props.EnumProperty(
        name="Terrain", default="HILLS",
        items=[("FLAT", "Flat", "No relief (fastest, offline-safe)"),
               ("HILLS", "Gentle hills", "Procedural relief, riverbeds carved"),
               ("DEM", "Real elevation", "AWS Terrain Tiles (network; falls back to hills)")])
    quality: bpy.props.EnumProperty(
        name="Quality", default="MED",
        items=[("LOW", "Low", "Coarse terrain, fast"),
               ("MED", "Medium", "Balanced"),
               ("HIGH", "High", "Dense terrain grid")])
    framed: bpy.props.BoolProperty(
        name="Framed roads (curbs + sidewalks)", default=True)
    photo_textures: bpy.props.BoolProperty(
        name="Photo textures (ambientCG CC0)", default=True,
        description="Download photographic PBR textures on first build "
                    "(cached on disk; disable for fully-offline builds)")
    do_buildings: bpy.props.BoolProperty(name="Buildings", default=True)
    do_props: bpy.props.BoolProperty(name="Street props", default=True)
    do_trees: bpy.props.BoolProperty(name="Trees", default=True)
    do_landmarks: bpy.props.BoolProperty(name="Landmark bridges", default=True)
    do_vegetation: bpy.props.BoolProperty(
        name="Greenery (verges + forests)", default=True,
        description="Roadside grass tufts and shrubs on verges, plus tree "
                    "fill inside forest and park polygons")
    separate_buildings: bpy.props.BoolProperty(
        name="Separate building objects", default=False,
        description="One object per building (hand-editable, slower)")
    seed: bpy.props.IntProperty(name="Seed", default=0, min=0)


class CITYBUILDER_OT_build(bpy.types.Operator):
    """Fetch OpenStreetMap data and build the city (blocks for 10-60 s)"""
    bl_idname = "citybuilder.build"
    bl_label = "Build City"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        p = context.scene.citybuilder
        if not bpy.app.online_access:
            self.report({"ERROR"}, "Enable Preferences > System > Network > Allow Online Access")
            return {"CANCELLED"}
        wm = context.window_manager
        t0 = time.time()
        wm.progress_begin(0, 100)
        try:
            south, west, north, east = geom.bbox_around(p.lat, p.lon, p.radius)
            wm.progress_update(2)
            elements = overpass.fetch(south, west, north, east,
                                      trees=p.do_trees, props=p.do_props)
            to_xy = geom.make_projector(p.lat, p.lon)
            graph = overpass.parse(elements, to_xy,
                                   center={"lat": p.lat, "lon": p.lon,
                                           "radius": p.radius, "name": p.city_name})
            build.clear_city(context)
            counts = build.build_scene(
                context, graph,
                {"radius": p.radius,
                 "terrain_mode": p.terrain_mode.lower(),
                 "quality": p.quality.lower(),
                 "seed": p.seed,
                 "framed": p.framed,
                 "photo_textures": p.photo_textures,
                 "do_buildings": p.do_buildings,
                 "do_props": p.do_props,
                 "do_trees": p.do_trees,
                 "do_landmarks": p.do_landmarks,
                 "do_vegetation": p.do_vegetation,
                 "separate_buildings": p.separate_buildings},
                progress=lambda pct, label: wm.progress_update(int(pct)))
        except Exception as e:
            traceback.print_exc()
            self.report({"ERROR"}, f"Build failed: {e}")
            return {"CANCELLED"}
        finally:
            wm.progress_end()
        self.report(
            {"INFO"},
            f"Built {counts.get('buildings', 0)} buildings, {counts.get('roads', 0)} roads, "
            f"{counts.get('junctions', 0)} junctions, {counts.get('props', 0)} props, "
            f"{counts.get('landmarks', 0)} landmarks, {counts.get('grass_tufts', 0)} tufts, "
            f"{counts.get('spires', 0)} spires in {time.time() - t0:.0f} s")
        return {"FINISHED"}


class CITYBUILDER_OT_clear(bpy.types.Operator):
    """Remove everything the add-on built"""
    bl_idname = "citybuilder.clear"
    bl_label = "Clear City"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        build.clear_city(context)
        return {"FINISHED"}


class CITYBUILDER_PT_panel(bpy.types.Panel):
    bl_label = "CityBuilder OSM"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "CityBuilder"

    def draw(self, context):
        layout = self.layout
        p = context.scene.citybuilder
        layout.prop(p, "preset")
        col = layout.column(align=True)
        col.prop(p, "lat")
        col.prop(p, "lon")
        col.prop(p, "radius")
        layout.prop(p, "terrain_mode")
        layout.prop(p, "quality")
        box = layout.box()
        box.prop(p, "framed")
        box.prop(p, "photo_textures")
        row = box.row()
        row.prop(p, "do_buildings")
        row.prop(p, "do_trees")
        row = box.row()
        row.prop(p, "do_props")
        row.prop(p, "do_landmarks")
        box.prop(p, "do_vegetation")
        box.prop(p, "separate_buildings")
        layout.operator("citybuilder.build", icon="MOD_BUILD")
        layout.operator("citybuilder.clear", icon="TRASH")
        layout.separator()
        layout.operator("citybuilder.export_game", icon="EXPORT")
        layout.label(text="Fetch + build takes 10-60 s", icon="INFO")
        layout.label(text="Data © OSM · Textures: ambientCG (CC0)")


classes = (
    CityBuilderProps,
    CITYBUILDER_OT_build,
    CITYBUILDER_OT_clear,
    CITYBUILDER_PT_panel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    export_game.register()
    bpy.types.Scene.citybuilder = bpy.props.PointerProperty(type=CityBuilderProps)


def unregister():
    del bpy.types.Scene.citybuilder
    export_game.unregister()
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)