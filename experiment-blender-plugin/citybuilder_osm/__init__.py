"""CityBuilder OSM — build real 3D cities from OpenStreetMap data.

Blender extension (4.2+/5.x). UI lives in the 3D-viewport N-panel, tab "CityBuilder".
"""
import traceback

import bpy

from . import build, geom, overpass


class CityBuilderProps(bpy.types.PropertyGroup):
    lat: bpy.props.FloatProperty(
        name="Latitude", default=50.0870, min=-85.0, max=85.0, precision=6,
        description="Scene center latitude (default: Prague Staré Město)")
    lon: bpy.props.FloatProperty(
        name="Longitude", default=14.4208, min=-180.0, max=180.0, precision=6,
        description="Scene center longitude")
    radius: bpy.props.IntProperty(
        name="Radius (m)", default=400, min=100, max=1500,
        description="Half-size of the fetched square, in metres")
    do_trees: bpy.props.BoolProperty(name="Trees", default=True)
    separate_buildings: bpy.props.BoolProperty(
        name="Separate building objects", default=False,
        description="One object per building (editable one-by-one, slower) "
                    "instead of a single merged mesh")


class CITYBUILDER_OT_build(bpy.types.Operator):
    """Fetch OpenStreetMap data around the given point and build the city"""
    bl_idname = "citybuilder.build"
    bl_label = "Build City"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        p = context.scene.citybuilder
        if not bpy.app.online_access:
            self.report({"ERROR"},
                        "Online access is disabled. Enable it in "
                        "Preferences > System > Network > Allow Online Access.")
            return {"CANCELLED"}

        try:
            south, west, north, east = geom.bbox_around(p.lat, p.lon, p.radius)
            elements = overpass.fetch(south, west, north, east, trees=p.do_trees)
            to_xy = geom.make_projector(p.lat, p.lon)
            graph = overpass.parse(elements, to_xy)
            build.clear_city(context)
            counts = build.build_scene(
                context, graph, p.radius, separate_buildings=p.separate_buildings)
        except Exception as e:
            traceback.print_exc()
            self.report({"ERROR"}, f"Build failed: {e}")
            return {"CANCELLED"}

        self.report({"INFO"},
                    f"Built {counts['buildings']} buildings, {counts['roads']} roads, "
                    f"{counts['areas']} areas, {counts['trees']} trees")
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
        col = layout.column(align=True)
        col.prop(p, "lat")
        col.prop(p, "lon")
        col.prop(p, "radius")
        layout.prop(p, "do_trees")
        layout.prop(p, "separate_buildings")
        layout.operator("citybuilder.build", icon="MOD_BUILD")
        layout.operator("citybuilder.clear", icon="TRASH")
        layout.label(text="Fetch takes 5-30 s (Overpass API)", icon="INFO")


classes = (
    CityBuilderProps,
    CITYBUILDER_OT_build,
    CITYBUILDER_OT_clear,
    CITYBUILDER_PT_panel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.citybuilder = bpy.props.PointerProperty(type=CityBuilderProps)


def unregister():
    del bpy.types.Scene.citybuilder
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
