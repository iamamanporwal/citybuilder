# CityBuilder → Blender Add-on: Technical Plan

**Goal.** Port the CityBuilder pipeline (OSM → real 3D city) into a Blender add-on so cities can be
finished with *real* modelling operations — booleans, bevels, swept profiles, PBR materials,
Cycles renders — that a browser app cannot offer, and then exported back into the game.

**Context.** The game launches next week. The browser app (this repo) already solves ingest,
semantics and layout: Overpass fetch, water whitelist, road class widths, building heights,
framed-road cross-sections, terrain, landmarks. The Blender add-on should *reuse those exact
semantics* (ported to Python) and swap the rendering layer from three.js to native Blender
geometry, where every object stays editable.

---

## 1. Why Blender (what the browser can't do)

| Need | Browser app today | Blender |
|---|---|---|
| Road surfaces with real curbs/verges | Procedural ribbon meshes, shader tricks | Curve + swept profile (Geometry Nodes "Curve to Mesh"), real curb bevels |
| Clean junctions | Polygonal junction pads | Boolean union of carriageways + limited-dissolve → one watertight surface |
| Roofs | Flat / simple caps | Roof solver, inset/bevel, `building:part` assembly |
| Manual fixes | None (regenerate only) | Grab/extrude/boolean any single building or road by hand |
| Materials | Canvas textures | Full PBR + displacement, Cycles/EEVEE preview renders |
| Export | GLB via headless bake | GLB/FBX/USD with per-object control, bake-to-texture |

## 2. Prior art (evaluated, not chosen)

- **blosm (Blender-OSM)** — mature OSM importer, but its semantics differ from our game
  (no water whitelist, different widths/heights, no framed-road contract) and the premium tier
  is paid/closed. We need parity with `unity_city.json` and our CityGraph, so a thin custom
  add-on that mirrors *our* ingest is the shorter path.
- **BlenderGIS** — great for terrain/basemaps; candidate helper for the terrain phase, not the core.

## 3. Architecture

Mirror the app's layering exactly — one adapter, one graph, many builders:

```
citybuilder_osm/            (Blender extension, pure-stdlib Python)
  blender_manifest.toml     extension manifest (Blender 4.2+ / 5.x)
  __init__.py               UI panel, operators, property group, register()
  overpass.py               ingest: query builder + mirror-failover fetch + tag→graph parse
  geom.py                   projection, ring stitching, polyline offset, shoelace area
  build.py                  builders: bmesh/mesh construction, materials, collections
```

**Data flow:** `bbox → Overpass JSON → parse() → graph dict → build_scene()`.
The intermediate **graph dict** is a Python port of `CityGraph`
(`buildings / roads / areas / trees`) so future features port 1:1 from `src/`.

**Parity with the app (ported verbatim):**

| Semantic | Source of truth in repo | Ported |
|---|---|---|
| Road classes, widths, lanes | `src/ingest/overpass.ts` `CLASS_WIDTH`/`CLASS_LANES` | v0.1 |
| Water whitelist (positive evidence only) | `waterProvenance()` + `MIN_WATER_AREA_M2` | v0.1 |
| Waterway buffering (river 30 m, canal 14 m) | `WATERWAY_WIDTH` | v0.1 |
| Multipolygon stitching (rivers/parks) | `assembleMemberRings()` | v0.1 (outer rings) |
| Building heights (`height` → `levels`×3.2 → hashed 9–25 m) | `overpass.ts:678` | v0.1 |
| Equirectangular projection (111.32·cos lat) | `overpassFetch.ts:143` | v0.1 |
| Framed roads (curb/verge/footpath cross-section) | `src/procgen/framedRoads.ts`, contract a2 | v0.2 |
| Junction consolidation, corridor elevation | `src/procgen/corridor`, §15 | v0.3 |
| Terrain field | `src/procgen/terrain` | v0.3 |
| Landmark catalog / bridges | `src/scene/landmarks.ts`, `procgen/bridges.ts` | v0.4 |

**Axes:** app is Y-up (x east, z south); Blender is Z-up. Convention here: **X = east,
Y = north, Z = up**, 1 unit = 1 m. Export back to the game flips to Y-up (GLB exporter does this).

## 4. Phased roadmap

### v0.1 — MVP (built in this folder)
- N-panel UI: lat/lon/radius, feature toggles, Build / Clear buttons.
- Overpass fetch with 3 mirror failover + client timeout (port of `overpassFetch.ts`).
- **Buildings**: closed-way footprints → extruded solids (bottom + walls + top; correct normals),
  real heights, merged into one mesh (fast) or optional one-object-per-building (editable).
- **Roads**: class-width ribbon meshes with mitred joins, per-class z-layering, tunnels skipped.
- **Water/green/sand areas**: whitelisted polygons incl. multipolygon relation outer rings,
  buffered rivers/canals; min-area filter.
- **Trees**: `natural=tree` nodes → linked-duplicate instances (real Blender instancing).
- Materials: named Principled BSDF materials + viewport solid colors; everything in a
  `CityBuilder` collection tree.
- Headless test harness (`test_headless.py`) proving fetch→build→render works with no GUI.

### v0.2 — Real roads (the reason to be in Blender)
- Roads become **curves** with a Geometry-Nodes modifier: Curve-to-Mesh sweep of the
  **framed-kit cross-section** (asphalt + curb + verge + footpath), i.e. the a2 contract done
  with real geometry. Parameters (curb height, verge width) exposed on the modifier.
- Junctions: boolean-union carriageway polygons, limited-dissolve, then re-skin — one
  continuous asphalt surface, no z-fighting ribbons.
- Lane markings via UV strip along curve length (Follow-Path UVs from the sweep).

### v0.3 — Elevation & terrain
- Terrain grid from AWS Terrain Tiles / SRTM (same source strategy as `procgen/terrain`),
  displaced plane; roads/buildings sample the field (port of corridor elevation solve,
  default-ON, one junction = one height).
- Bridges: deck + parapet sweep; simple pier placement (landmark bridges in v0.4).

### v0.4 — Buildings v2 + landmarks
- `roof:shape` (gabled/hipped/pyramidal) via straight-skeleton or bmesh inset+peak.
- `building:part` assembly; facade PBR material library keyed by the Building-Recognizer
  signal chain (port `src/recognizer`).
- Landmark catalog port: parametric Golden-Gate/stone-arch bridges as Geometry-Node groups.

### v0.5 — Game export bridge
- One-click "Export for game": GLB per chunk + `unity_city.json`-compatible manifest
  (reuse the versioned contract from `src/export`), collider meshes tagged, Draco optional.
- Round-trip: import an existing World-API export into Blender for touch-up, re-export.

## 5. Key technical decisions

1. **Pure stdlib Python, no wheels.** Overpass via `urllib`; all geometry via `bmesh`/
   `from_pydata`. Install stays a single zip, works offline-of-pip.
2. **Extension format (`blender_manifest.toml`), Blender 4.2+.** Legacy `bl_info` is gone in
   5.x; the manifest declares the `network` permission so the fetch is honest. The operator
   checks `bpy.app.online_access` and tells the user to enable *Allow Online Access*.
3. **Merged meshes by default.** One mesh per category (buildings / road class / area kind)
   → thousands of features build in seconds and the outliner stays sane. A toggle emits
   separate building objects when hand-editing is the goal (or use `P → Separate by Loose Parts`).
4. **Blocking fetch in the operator (MVP).** Overpass takes 5–30 s; acceptable for v0.1.
   v0.2 moves to a modal operator with a progress bar and the app's tiled fetch for large areas
   (12 km² cap, dedupe by element id — port `overpassFetch.ts`).
5. **Geometry Nodes for anything swept or repeated** (roads v0.2, fences, lamps): parametric,
   non-destructive, editable by the artist after generation.

## 6. Testing

- `blender --background --factory-startup --online-mode --python test_headless.py`
  registers the extension from source, builds a real city (Prague Staré Město, 300 m), asserts
  object/vert counts > 0, saves a `.blend`, and renders a Workbench PNG — CI-able smoke test.
- Golden-count regression: fixed bbox + recorded Overpass JSON fixture (offline replay) once the
  parser stabilises, mirroring the app's `npm test` water invariants.

## 7. Risks

- **Overpass rate limits / downtime** — mitigated by mirror failover; add local JSON cache in v0.2.
- **Self-intersecting / degenerate OSM rings** — dedupe + `try/except` per face; bad rings are
  skipped, never crash the build (same "positive evidence" spirit as water).
- **Relation holes (courtyards)** — MVP renders outer rings only; v0.2 adds inner rings via
  boolean or `holes_fill`.
- **Huge areas** — MVP caps radius at 1500 m; the app's tiling strategy ports in v0.2.
- **Blender API churn** — extension targets 4.2+; CI smoke test on the installed version.

## 8. Install & usage

See [README.md](README.md) — beginner-level steps (user hasn't used Blender before).
