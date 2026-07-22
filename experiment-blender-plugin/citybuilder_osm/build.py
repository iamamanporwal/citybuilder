"""Scene builders — graph dict → Blender objects (collections, meshes, materials)."""
import bmesh
import bpy

from . import geom

ROOT_NAME = "CityBuilder"

# z-layering (m): keeps coplanar surfaces from fighting; ground plane sits at 0
Z_AREA = {"sand": 0.02, "grass": 0.03, "park": 0.04, "forest": 0.05, "water": 0.08}
Z_ROAD_BASE = 0.10
ROAD_Z_RANK = {  # bigger roads lower, paths on top (mirrors app layering)
    "motorway": 0, "trunk": 0, "primary": 1, "secondary": 1, "tertiary": 2,
    "residential": 2, "unclassified": 2, "living_street": 3, "service": 3,
    "pedestrian": 4, "cycleway": 5, "footway": 6,
}

COLORS = {
    "ground":   (0.30, 0.32, 0.28, 1.0),
    "building": (0.75, 0.71, 0.65, 1.0),
    "water":    (0.09, 0.30, 0.48, 1.0),
    "park":     (0.24, 0.42, 0.20, 1.0),
    "grass":    (0.33, 0.47, 0.24, 1.0),
    "forest":   (0.16, 0.32, 0.15, 1.0),
    "sand":     (0.78, 0.70, 0.50, 1.0),
    "asphalt":  (0.14, 0.14, 0.15, 1.0),
    "path":     (0.52, 0.48, 0.42, 1.0),
    "trunk":    (0.30, 0.20, 0.12, 1.0),
    "leaves":   (0.13, 0.35, 0.12, 1.0),
}
PATH_CLASSES = {"footway", "cycleway", "pedestrian", "living_street"}


def get_material(name, color, roughness=0.85):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = color  # viewport solid mode
    return mat


def clear_city(context):
    """Delete the CityBuilder collection tree and its data blocks."""
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
    for name in ("Buildings", "Roads", "Areas", "Trees", "Ground"):
        coll = bpy.data.collections.get(f"{ROOT_NAME} {name}")
        if not coll:
            coll = bpy.data.collections.new(f"{ROOT_NAME} {name}")
            root.children.link(coll)
        subs[name] = coll
    return subs


def new_object(name, mesh, coll, mat):
    obj = bpy.data.objects.new(name, mesh)
    if mat:
        mesh.materials.append(mat)
    coll.objects.link(obj)
    return obj


def ccw(ring):
    return ring if geom.ring_area_signed(ring) > 0 else list(reversed(ring))


# ---- meshes -----------------------------------------------------------------

def mesh_from_rings(name, rings, z):
    """One mesh of flat ngon faces (areas). Degenerate rings are skipped."""
    verts, faces = [], []
    for ring in rings:
        ring = geom.dedupe_ring(ring)
        if len(ring) < 3:
            continue
        ring = ccw(ring)
        base = len(verts)
        verts.extend((x, y, z) for x, y in ring)
        faces.append(list(range(base, base + len(ring))))
    if not faces:
        return None
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def mesh_prisms(name, prisms):
    """Extruded footprints: list of (ring, height) → one closed-solid mesh."""
    verts, faces = [], []
    for ring, h in prisms:
        ring = geom.dedupe_ring(ring)
        if len(ring) < 3:
            continue
        ring = ccw(ring)
        n = len(ring)
        base = len(verts)
        verts.extend((x, y, 0.0) for x, y in ring)
        verts.extend((x, y, h) for x, y in ring)
        faces.append(list(range(base + n - 1, base - 1, -1)))       # bottom (down)
        faces.append(list(range(base + n, base + 2 * n)))           # top (up)
        for i in range(n):                                          # walls
            j = (i + 1) % n
            faces.append([base + i, base + j, base + n + j, base + n + i])
    if not faces:
        return None
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    # closed solids → recalc guarantees consistent outward normals
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def mesh_ribbons(name, ribbons, z):
    """Road ribbons: list of (pts, width) → one flat quad-strip mesh."""
    verts, faces = [], []
    for pts, width in ribbons:
        pts = geom.dedupe_ring(pts) if len(pts) > 2 else pts
        if len(pts) < 2:
            continue
        left = geom.offset_polyline(pts, width / 2.0)
        right = geom.offset_polyline(pts, -width / 2.0)
        base = len(verts)
        n = len(pts)
        for i in range(n):
            verts.append((left[i][0], left[i][1], z))
            verts.append((right[i][0], right[i][1], z))
        for i in range(n - 1):
            l0, r0 = base + 2 * i, base + 2 * i + 1
            l1, r1 = base + 2 * i + 2, base + 2 * i + 3
            faces.append([l0, r0, r1, l1])  # CCW → +Z normal
    if not faces:
        return None
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def tree_template():
    """Trunk + crown in one mesh (two material slots); built once, instanced."""
    mesh = bpy.data.meshes.get("CB Tree")
    if mesh:
        return mesh
    bm = bmesh.new()
    trunk = bmesh.ops.create_cone(
        bm, cap_ends=True, segments=6, radius1=0.18, radius2=0.14, depth=2.2)
    for v in trunk["verts"]:
        v.co.z += 1.1
    crown = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.6)
    for v in crown["verts"]:
        v.co.z += 3.2
    crown_faces = {f.index for v in crown["verts"] for f in v.link_faces}
    mesh = bpy.data.meshes.new("CB Tree")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_material("CB Trunk", COLORS["trunk"]))
    mesh.materials.append(get_material("CB Leaves", COLORS["leaves"]))
    for poly in mesh.polygons:
        poly.material_index = 1 if poly.index in crown_faces else 0
    return mesh


# ---- top-level --------------------------------------------------------------

def build_scene(context, graph, radius_m, separate_buildings=False, max_trees=2000):
    """Build the whole graph into the CityBuilder collection. Returns counts."""
    subs = ensure_collections(context)
    counts = {"buildings": 0, "roads": 0, "areas": 0, "trees": 0}

    # ground plane
    r = radius_m * 1.25
    ground = mesh_from_rings("CB Ground", [[(-r, -r), (r, -r), (r, r), (-r, r)]], 0.0)
    if ground:
        new_object("Ground", ground, subs["Ground"], get_material("CB Ground", COLORS["ground"]))

    # buildings
    mat_b = get_material("CB Building", COLORS["building"], roughness=0.9)
    prisms = [(b["ring"], b["height"]) for b in graph["buildings"]]
    counts["buildings"] = len(prisms)
    if separate_buildings:
        for b in graph["buildings"]:
            mesh = mesh_prisms(f"CB Building {b['id']}", [(b["ring"], b["height"])])
            if mesh:
                new_object(f"Building {b['id']}", mesh, subs["Buildings"], mat_b)
    elif prisms:
        mesh = mesh_prisms("CB Buildings", prisms)
        if mesh:
            new_object("Buildings", mesh, subs["Buildings"], mat_b)

    # roads — one mesh per class, layered by rank
    by_class = {}
    for road in graph["roads"]:
        by_class.setdefault(road["class"], []).append((road["pts"], road["width"]))
        counts["roads"] += 1
    for cls, ribbons in by_class.items():
        z = Z_ROAD_BASE + ROAD_Z_RANK.get(cls, 3) * 0.01
        mesh = mesh_ribbons(f"CB Roads {cls}", ribbons, z)
        if mesh:
            color = COLORS["path"] if cls in PATH_CLASSES else COLORS["asphalt"]
            mat = get_material(f"CB Road {cls}", color, roughness=0.95)
            new_object(f"Roads {cls}", mesh, subs["Roads"], mat)

    # areas — one mesh per kind
    by_kind = {}
    for area in graph["areas"]:
        by_kind.setdefault(area["kind"], []).append(area["ring"])
        counts["areas"] += 1
    for kind, rings in by_kind.items():
        mesh = mesh_from_rings(f"CB Area {kind}", rings, Z_AREA.get(kind, 0.02))
        if mesh:
            rough = 0.15 if kind == "water" else 0.9
            mat = get_material(f"CB {kind.capitalize()}", COLORS[kind], roughness=rough)
            new_object(f"Areas {kind}", mesh, subs["Areas"], mat)

    # trees — linked-duplicate instances of one template mesh
    template = None
    for i, t in enumerate(graph["trees"]):
        if i >= max_trees:
            break
        if template is None:
            template = tree_template()
        obj = bpy.data.objects.new(f"Tree {t['id']}", template)
        obj.location = (t["pos"][0], t["pos"][1], 0.0)
        s = 0.8 + geom.hash01(t["id"]) * 0.5
        obj.scale = (s, s, s)
        subs["Trees"].objects.link(obj)
        counts["trees"] += 1

    return counts
