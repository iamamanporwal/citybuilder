# CityBuilder OSM v0.5 "production" — Module Contracts

Target: AAA-looking game city from the driver's camera. Not a digital twin — plausible,
clean, editable. This file is the integration contract; every module is built against it.

## Architecture rule

**Only `build.py`, `matlib.py`, `export_game.py`, `__init__.py` may import `bpy`.**
Every other module is pure Python (stdlib + `geom.py`) and emits `MeshData`, so it can be
developed and tested with plain `python3`.

## Core data contracts

### MeshData (what every generator returns)

```python
MeshData = {
    "verts": [(x, y, z), ...],          # metres; X=east, Y=north, Z=up
    "faces": [[i0, i1, i2, ...], ...],  # ngons ok; CCW seen from outside/+Z
    "mats":  ["asphalt", ...],          # material KEY per face (len == len(faces))
    "uvs":   [[(u, v), ...], ...] | None,  # per-face per-corner, aligned with faces
    "attrs": {"tint": [float per face]} | {},  # per-face float attrs (shader variation)
}
```

Helpers in `geom.py`: `new_meshdata()`, `merge_meshdata(dst, src)`, `add_prism(md, ring, z0, z1, mat, holes=None)`.
`build.py` converts MeshData → bpy mesh: material slots created per unique key from
`matlib.MATERIALS`, uvs → "UVMap" layer, attrs → per-face float attributes.

### Graph v2 (output of `overpass.parse`)

```python
{
  "buildings": [{"ring", "holes": [rings], "height", "min_height": 0.0, "levels",
                 "roof_shape": "flat|gabled|hipped|pyramidal|skillion|dome|auto",
                 "roof_height": float|None, "kind": "residential|commercial|industrial|church|auto",
                 "id", "name": str|None}],
  "roads":     [{"class", "width", "lanes", "oneway": bool, "pts": [(x,y)],
                 "node_ids": [int], "bridge": bool, "layer": int, "id",
                 "elev": [z per pt] | None}],            # elev filled by elevation solve
  "rails":     [{"pts", "node_ids", "bridge", "id"}],
  "areas":     [{"kind": "water|park|grass|forest|sand|plaza", "ring", "holes": [rings]}],
  "trees":     [{"pos", "id"}],
  "props":     [{"kind": "lamp|signal|bus_stop|crossing|stop", "pos", "id"}],
  "center":    {"lat", "lon", "radius"},
}
```

### ElevationField

`elevation.build_field(...)` returns an object with `.sample(x, y) -> z` (metres) and
`.mode` (`"flat"|"hills"|"dem"`). All consumers (roads solve, terrain grid, building
seating, prop seating) sample the SAME field — one source of truth (terrain-system rule).

## Modules and owners

| File | Pure? | Contract |
|---|---|---|
| `geom.py` | ✅ | (exists) + `add_prism`, meshdata helpers, `tessellate(outer, holes)` ear-clip with hole bridging, spatial grid index class |
| `roadnet.py` | ✅ | `build_network(roads) -> Network`: junction detection by shared OSM node ids (fallback: coord key), cluster junctions < 12 m apart (§15), trim incident roads back from junction, per-junction pad polygon from incident cross-section corners + convex hull; returns `{junctions: [{center, z, pad_ring, incident}], segments: [trimmed roads]}` |
| `elevation.py` | ✅* | AWS terrarium DEM fetch (z14-15, stdlib PNG decode) + fBm hills fallback + `solve_road_elevations(network, field)`: one height per junction, grade clamp per class, smoothing passes, bridge decks linear + min 5.5 m clearance, densify long segments (*urllib only) |
| `profile.py` | ✅ | `sweep_road(pts, elevs, cls, width, opts) -> MeshData`: framed cross-section (asphalt+gutter+curb+verge+sidewalk per class), crown camber, along-length UV (v = metres), end-caps at junction trims; `markings(pts, elevs, cls, width, lanes, oneway) -> MeshData` (geometry strips: centre dash 3 m/9 m gap 0.12 m wide, edge lines 0.10 m, worn-white) |
| `junctions.py` | ✅ | `build_junction(j) -> MeshData`: pad polygon (asphalt) + curb ring segments between road mouths + crosswalk zebra strips across each mouth (0.5 m bars, 0.4 m gap) + sidewalk corner fills |
| `terrain.py` | ✅ | `build_terrain(field, radius, network, areas, quality) -> MeshData`: grid (2/4/8 m), vertices blended flat under road corridors (falloff 1.5×width), water areas depressed −1.5 m, splat by slope stored in `attrs["rock"]` |
| `roofs.py` | ✅ | `build_building(b, base_z) -> MeshData`: walls with courtyard holes (tessellated floors/ceilings), roof by shape: flat+parapet (h≥12 m), gabled (rect-fit ridge), hipped (straight-skeleton if vendored lib ok, else inset-ridge approximation), pyramidal; facade UV: u = metres along wall, v = metres up (shader window grid depends on this); per-building `tint` attr from hash |
| `props_gen.py` | ✅ | Parametric templates (lamp 6 m single+double arm, traffic light, bus shelter, bench, hydrant, EU/US sign posts) as MeshData + `place_props(graph, network, field) -> [{template, pos, rot_z, scale}]`: curbside offset = half-width + 0.8 m, lamp spacing 28 m on ≥ tertiary, signals at junction corners of ≥ secondary×secondary |
| `landmarks_gen.py` | ✅ | Suspension bridge (towers+parabolic main cables+hangers+deck) & stone arch bridge from tagged bridge ways ≥ 120 m over water; proportions per spec doc |
| `matlib.py` | bpy | `MATERIALS` registry: key → builder. Procedural node materials: asphalt (wear noise, darker centre seam), marking-white/yellow (rough 0.6), curb concrete, sidewalk pavers (brick tex), facade (window grid from UV metres: floor 3.2 m, window 1.5×1.2 m, lit-window random emission using tint attr), glass, water (glossy+wave bump), grass/forest floor, terrain (grass/rock slope splat via attrs), metal, wood |
| `export_game.py` | bpy | Operator: export `city.glb` (or per-category GLBs) + `unity_city.json` manifest matching the app contract (origin lat/lon, bounds, semantics per object, spawn points on roads), Y-up handled by glTF exporter |
| `build.py` | bpy | Orchestrator: graph→network→elevation→terrain→meshes→objects/collections; wm.progress updates |
| `__init__.py` | bpy | UI v2: location presets dropdown, terrain mode (Flat/Hills/Real DEM), quality (Low/Med/High), feature toggles, seed, Build/Clear/Export |

## Testing rule

Every pure module ships `if __name__ == "__main__":` self-tests (asserts on vert counts,
manifold-ness where relevant, no NaNs, UV ranges) runnable with `python3 modulename.py`.
Integration: `test_headless.py` matrix — Prague (flat, dense old town), San Francisco
Golden Gate 37.8199,-122.4783 (suspension bridge + water + hills, DEM), and a hills-mode
run; each asserts counts and renders a PNG including a **road-level camera** (1.4 m above
a road point — the game's angle).

## Material keys (fixed vocabulary)

`asphalt, asphalt_old, marking_white, marking_yellow, curb, sidewalk, paver, gravel,
building_wall, building_glass, roof_flat, roof_tile, roof_metal, water, grass, forest_floor,
sand, terrain, bark, leaves, metal, metal_dark, wood, concrete, stone`

---

# v0.5 Inter-module interfaces (authoritative — agents implement EXACTLY these)

Node key everywhere: `node_key(p) = f"{round(p[0]*2)},{round(p[1]*2)}"` (half-metre snap).
Roads are referenced by index `road_idx` into `graph["roads"]` (stable order).

## elevation.py

```python
build_field(mode, radius, water_areas, seed=0, center_lat=None, center_lon=None,
            to_xy=None) -> Field
# mode: "flat" | "hills" | "dem"
# water_areas: [{"ring": [(x,y)], "holes": [rings]}] — rendered water only
# Field.sample(x, y) -> z  (conforms to specs/elevation-terrain.md §C: riverbed −3.0,
#   shore −0.85, valley 150 m, relief fbm amp 2.6 wavelength 230 3 octaves — in hills
#   mode; dem mode replaces fbm with terrarium DEM but KEEPS water compositing;
#   flat mode: fbm term = 0, water compositing still applies)
# Field.mode; Field.base_sample(x, y) -> z  (same as sample — the NATURAL field;
#   conform lives in terrain.py)

solve(roads, field) -> Solve
# Implements specs/elevation-terrain.md §A (two-pass Gauss-Seidel) + §B (clustering).
# roads: graph["roads"] dicts (uses pts, class, width, bridge, layer, and "tunnel" key
#   if present). Solve attributes:
#   .node_z: {canonical_key: z}
#   .alias:  {raw_key: canonical_key}
#   .key_of(pt) -> canonical key (alias applied)
#   .z_at(pt) -> float (0 if unknown)
#   .profile(road_idx, cum) -> [z]   # cum = geom.arc_lengths(pts) of THAT road's pts
#   .internal: set(road_idx)
#   .clusters: {canonical: [member keys]}
#   .stats: {"iterations": int, "converged": bool, "clusters": int}
```

## roadnet.py

```python
build_network(roads, solve) -> {"segments": [SegDesc], "junctions": [JunctionDesc]}

SegDesc = {
  "road_idx", "cls", "width", "lanes", "oneway", "bridge", "layer", "name", "surface",
  "pts": [(x,y)],   # trimmed at junction ends, then densified (max step 8 m; bridges always)
  "elev": [z],      # solve.profile sampled on the FINAL pts
  "j_start": int|None, "j_end": int|None,   # index into junctions list
  "internal": bool,  # solve.internal roads → emit no ribbon
}

JunctionDesc = {
  "center": (x,y),        # mean of member node positions
  "z": float,             # solve node height
  "radius": float,        # 0.58 * max incident width
  "arms": [{"p": (x,y),   # trimmed mouth point ON the segment centerline
            "dir": (dx,dy),  # unit vector pointing AWAY from the junction
            "width", "cls", "seg_idx": int, "end": 0|1,
            "crosswalk": bool}],  # cls != motorway and width >= 5
  "degree": int,
}

# Rules: junction = canonical node with degree >= 3, or any cluster; degree-2 nodes are
# junctions ONLY if NOT a pass-through joint (pass-through: dot(dirA, dirB) <= −0.866 and
# width ratio <= 1.35 → no junction, no trim). Trim distance from node center =
# max(radius * 0.72, width_of_arm * 0.55); clusters: distance from cluster centroid to
# member node + 0.4 + arm width*0.55. Dead ends: no trim. If a segment is shorter than
# its total trims, mark internal (pad covers it).
```

## profile.py

```python
sweep_road(seg: SegDesc, opts=None) -> MeshData
# Framed cross-section per specs/framed-roads.md §1–2, §6–7: asphalt (with crown 2%,
# superelevation, 6 m end fade), 0.05 reveal, curb (top +0.16, faces down to −0.35),
# tree-lawn (+0.04), footpath (+0.16), outer skirt. Frameless classes: asphalt +
# side skirts only. Bridge segs: no frame; deck slab (thickness 0.7) + fascia walls +
# parapets (1.05 m) instead. UVs: v = metres along, u = metres across strip.
# Materials: asphalt|asphalt_old (surface=cobble → paver), curb, grass (lawn),
# sidewalk (footpath), concrete (skirts/fascia).

markings(seg: SegDesc) -> MeshData
# Per specs/framed-roads.md §4 at +0.055 above surface: centre dashed 3/9 m 0.16 wide
# (or double-solid ±0.18 × 0.12 for primary/trunk/motorway), lane lines for oneway
# multi-lane, edge lines 0.10 for motorway/trunk. Stop lines for trunk/primary/
# secondary/tertiary arms handled in junctions.py. mats: marking_white|marking_yellow.

bridge_piers(seg: SegDesc, ground_z) -> MeshData
# ground_z: callable (x,y)->z. Piers every ~24 m where deck − ground > 3.5 m:
# rectangular column (0.45×width·0.5) from ground−1 to deck−0.7. mat: concrete.
```

## junctions.py

```python
build_junction(j: JunctionDesc) -> MeshData
# Pad: convex hull of arm mouth corners (each arm: p ± normal(dir)·(width/2 + 0.05)),
# rounded fillet clamp(maxW*0.45, 2, 7) (geom.round_polygon-style, implement locally),
# at z + 0.015 (above road ends so no z-fight), mat asphalt_old.
# Corner curb+sidewalk bands between adjacent arms (kit arc method, 6 segs, skip when
# arms > 2.7 rad apart): curb strip (0.4 w, +0.16) then footpath (2.4 w, +0.16), skirt
# down −0.35, mats curb/sidewalk. Skip band if any point lands inside an arm mouth.
# Crosswalks per arm where arm.crosswalk: zebra stripes 1.6 m inward from mouth,
# spacing 1.6, stripe 2.2×0.8, at z+0.07, mat marking_white.
# Stop lines on trunk/primary/secondary/tertiary arms: 3.15 m in, 0.6 thick, half width
# (driving side, right-hand traffic), z+0.07.
```

## terrain.py

```python
build_terrain(field, radius, corridors, quality) -> MeshData
# corridors: [{"pts", "elev", "half", "pave": 4.0}] from non-bridge non-internal SegDescs.
# Grid cell by quality: high 4, med 6, low 10 (m); extent ±radius*1.25.
# Vertex z = conform(field.sample) per specs §C road-conform (SHOULDER 14, cubic
# smoothstep, largest-w wins). attrs["rock"] per face = clamp(slope/0.7, 0, 1).
# mat terrain. Skip faces fully inside water rings is NOT needed (riverbed shows through).
```

## roofs.py

```python
build_building(b, base_z) -> MeshData
# b: graph["buildings"] dict. Walls from base_z − 0.4 (BASE_SINK) to base_z + height,
# courtyard holes honoured (geom.add_prism). Roof at top by shape:
#   flat (default h≥12 or roof_shape=flat): cap + parapet 0.5 h × 0.3 w if h≥12,
#     else plain cap + cornice band (0.7 h, 0.4 overhang) — mat roof_flat
#   gabled (roof_shape=gabled, or auto: h<12, 4–6 vert quasi-rect footprint):
#     ridge along longest axis, roof_height = tag or 0.35*min(w,10) — mat roof_tile,
#     gable end walls mat building_wall
#   hipped: like gabled but ridge shrunk 30% from both ends, hip planes — roof_tile
#   pyramidal: centroid peak — roof_tile
# Complex/concave footprints always fall back to flat. Facade UVs: u = metres along
# wall loop, v = metres up FROM BASE. attrs["tint"] = geom.hash01(b["id"]) on all faces.
# mats: building_wall walls, roof_* roofs.
```

## props_gen.py

```python
TEMPLATES: {name: () -> MeshData}   # built at origin, +Y forward, z=0 ground:
# "lamp" (pole 7.4, arm 2.2 @7.3, head box, mat metal_dark + emissive head separate mat
#   "lamp_head"), "signal" (pole 4.6, head 0.34×0.26×1.0 @4.4, 3 lenses), "stop_sign",
#   "give_way", "speed_sign", "bus_stop" (shelter 3×1.4×2.5), "bench", "tree" (existing
#   style: trunk+icosphere, mats bark/leaves), "shrub" (icosphere r0.8 @0.56)

place_props(graph, network, road_z, ground_z, opts) -> [Placement]
# Placement = {"template": str, "pos": (x,y,z), "rot_z": float, "scale": float}
# road_z(seg, station) -> z along a SegDesc; ground_z(x,y) -> terrain z.
# Rules per specs/export-landmarks-props.md §C: OSM lamps/signals curb-pushed
# (offset half+0.7, elevation from road if within half+8); generated lamps spacing 30 m
# alternating sides offset half+1.1 (bridge half−0.55, width≥8) on classes primary..
# living_street+trunk, jitter ±3 m, reject within 8 m of another lamp or inside any
# carriageway (use geom.SpatialGrid); signals at junction arms of secondary+ crossings;
# trees from graph + verge tufts NOT here (vegetation optional later). Deterministic
# via geom.hash01(id-ish ints). Global cap: lamps 3000, others 1000 each.
```

## landmarks_gen.py

```python
detect(roads) -> [{"kind": "suspension"|"arch", "road_idxs": [..], "color": hex|None,
                   "towers": bool}]
# structure tag / name regex / wikidata per specs §B; chain contiguous bridge segments
# of same road name/class (join tolerance 45 m).
build_suspension(centerline, elevs, width, color) -> MeshData   # specs §B numbers
build_arch(centerline, elevs, width, color, water_y=-1.2, towers=False) -> MeshData
# mats: metal (towers/cables tinted via attrs["tint"]=0? no—use dedicated mats
# "landmark_steel" and "stone"), deck asphalt on top.
```

## build.py orchestration (integration, not an agent)

Order: fetch → parse → field → solve → network → terrain → junction meshes → road sweeps
+ markings → buildings (base_z = field.sample at centroid; over-water ≥50% verts → base 0
+ pier skirt) → landmarks (replace plain deck for detected spans' extra structure) →
props → trees. Every category one merged object; collections as v0.1.

## Scene export contract (for export_game.py)

build.py stores `scene["cb_export"] = json.dumps({...})` with:
`{"city": str, "bounds": {...}, "origin": {"lat","lon"}, "roads": [{id, name, class,
drivable, width_m, lanes, oneway, bridge, tunnel, length_m, centerline [[x,y,z] Y-up
GAME coords: (x, z_up, −y_north) → glTF]}], "devices": [{id, kind, position, heading_rad}],
"buildings": [{id, name, tier, position}], "spawn": {...}}`.
export_game.py: operator reads it, writes unity_city.json (schema per
specs/export-landmarks-props.md §A, formatVersion 1) + exports CityBuilder collection to
city_scene.glb (bpy.ops.export_scene.gltf, use_selection off, collection filter) +
citymap_spawn.json. Spawn scoring per spec.
