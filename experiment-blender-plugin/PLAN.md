# CityBuilder → Blender Add-on: Production Plan (v2)

**Goal (sharpened).** Not a digital twin — a *plausible, AAA-looking game city*, judged from
the **driver's camera**. Roads are the hero: curbs, sidewalks, junctions, markings, camber,
elevation. Everything else (buildings, terrain, props, landmarks) supports that read.
Output feeds the car game via the app's own export contract (`unity_city.json` + GLBs).

Status: **v0.1 MVP shipped** (flat extrusions, ribbon roads — commit 394d03f).
**v0.5 "production" in progress** — this document is its blueprint.
Detailed engineering specs extracted from the app source live in [specs/](specs/):
[framed-roads.md](specs/framed-roads.md) · [elevation-terrain.md](specs/elevation-terrain.md) ·
[export-landmarks-props.md](specs/export-landmarks-props.md). Module interfaces: [SPEC.md](SPEC.md).

---

## 1. Research outcome — what we adopt from the ecosystem (licenses verified)

| Source | License | How we use it |
|---|---|---|
| **blosm** (github.com/vvoovv/blosm) | GPL-3 | Same license as us — port code/ideas freely (roof shapes, cladding tints, window-emission ColorRamp). Richest prior art. |
| **bpypolyskel** (prochitecture) | GPL-3 | Vendor later for true straight-skeleton hipped roofs (99.99% success on 320k roofs). v0.5 ships our ridge-approximation; vendor in v0.6. API: `polygonize(verts, firstVertIndex, numVerts, holesInfo, height, tan, faces)`; wrap in try/except (can raise on spikes). |
| **osm2streets** (A/B Street) | Apache-2.0 | Port the trim-back junction algorithm (§3 below) — v0.6 upgrade over our convex-hull pads. |
| **building_tools** (ranjian0) | MIT | Mine parametric facade/balcony ops later. |
| **AWS Terrain Tiles** (terrarium) | open data, attribution req. | Real DEM: `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, decode `R·256+G+B/256−32768`, z13–14, disk cache. Attribution: "Terrain tiles: Mapzen/Tilezen via AWS Open Data; SRTM/3DEP courtesy USGS". Optional (flat/hills modes work offline — extension ToS requires no mandatory downloads). |
| **ambientCG** | **CC0** | PBR textures (asphalt/paving/facade/roof) fetched at runtime + cached; explicitly OK to bundle and ship in commercial games. API: `ambientcg.com/api/v2/full_json?q=...&include=downloadData`; get: `ambientcg.com/get?file={AssetID}_{Res}-{Fmt}.zip`. |
| **Poly Haven** | CC0 (via API only) | Secondary texture source; resolve URLs via `api.polyhaven.com/files/{id}`, unique User-Agent. |
| **KayKit City Builder Bits** | CC0 | Street props (streetlight, traffic light, hydrant, bench) + 5 cars — bundleable GLBs, stable raw.githubusercontent URLs. v0.6: replace our parametric props where the kit looks better. |
| **Kenney city kits / Quaternius** | CC0 | Bundle-only (no stable URLs). Extra buildings/props variety. |
| **MUTCD / UK TSM Ch.5** | public domain / OGL | Marking dimension tables embedded (see checklist §4). |
| Buildify | free but NOT redistributable | **Avoid** the asset; the collection-instancing *technique* is reimplemented with CC0 kits. |
| SceneCity, 3DStreet | closed / NC | Avoid. |

Packaging policy from research: geometry-node groups (when we add them) ship as a bundled
`.blend` appended via `bpy.data.libraries.load` — never Python-generated (API churn).
Pure-Python wheels only. Network use declared in manifest; every network feature optional.

## 2. Architecture (v0.5)

```
citybuilder_osm/
  geom.py           shared pure geometry: MeshData, tessellate(+holes), SpatialGrid, offsets
  overpass.py       ingest → Graph v2 (holes, roof tags, props, rails, maxspeed, structure)
  elevation.py      terrain field (flat/hills/DEM terrarium) + corridor solve (Gauss-Seidel,
                    grade caps, junction clustering §15, cosine bridge ramps) — app parity
  roadnet.py        junction detection/cluster → trimmed+densified SegDescs + JunctionDescs
  profile.py        framed cross-section sweep (curb .16/lawn .04/footpath .16/skirt −.35,
                    crown 2%, superelevation, 6 m fades) + markings + bridge decks/piers
  junctions.py      pad polygon (hull+fillet), corner curb/sidewalk arcs, crosswalks, stop lines
  terrain.py        conformed ground grid (roads burn in, 14 m shoulders), rock splat attr
  roofs.py          buildings v2: courtyard holes, gabled/hipped/pyramidal/flat+parapet/cornice
  props_gen.py      parametric lamp/signal/signs/bench/bus stop/tree + placement rules
  landmarks_gen.py  suspension + stone-arch bridges (catalog: wikidata/name/structure)
  matlib.py         procedural PBR node materials incl. facade window-grid + lit windows
  build.py          orchestrator (bpy): MeshData→meshes, collections, cb_export scene data
  export_game.py    unity_city.json + citymap_spawn.json + city_scene.glb (app contract v1)
  __init__.py       UI v2: presets, terrain mode, quality, toggles, Build/Clear/Export
```

Rule: only build/matlib/export/__init__ import bpy; everything else is python3-testable
with inline self-tests. All numeric constants ported 1:1 from the app (specs/).

## 3. The junction upgrade path (v0.6)

Port osm2streets exactly (Apache-2.0, ~300 lines): thicken incident centerlines ±w/2 →
intersect adjacent edge pairs across each wedge → corner points → trim each centerline by
the MAX perpendicular-line intersection → pad ring = walk [right-end, corner, left-end]
around the node. Pre-pass: collapse degree-2 nodes, two-pass merge of <15 m interior links.
Invariant: roads meet the pad at right angles — perfect stop lines, zero overlap.

## 4. Road-realism checklist (embedded numbers, MUTCD/EN-1436-anchored)

- Crown 2% each side, 0 at kerbs; superelevation up to 6% on curves; fades 6 m at ends.
- Curb 15–16 cm vertical face; gutter shadow line; sidewalk 1.8–2.4 m at +16 cm, 1.5 m score joints (texture).
- Lines: 10 cm urban/15 cm highway; US broken 3.05/9.14 m; UK 2/7 m; stop bar 45 cm deep;
  continental crosswalk bars 40 cm/gap 60 cm, 2.4–3 m long.
- **Worn white** sRGB ≈ (150,148,140) rough 0.75 — never pure white. Worn yellow ≈ (190,150,45).
- New asphalt sRGB ≈ (52,52,54) rough 0.9; aged ≈ (95–110) — asphalt lightens, paint darkens.
- Wheel-path wear bands ±0.9 m from lane centre (+10% luminance), oil band at lane centre
  (−20%), intensified near stop bars (shader layer, v0.6 with ambientCG textures).

## 5. Delivery phases

### v0.5 (NOW — this build)
Everything in §2: framed roads + junctions + markings + elevation/terrain/DEM + buildings v2
+ props + landmarks + procedural materials + game export + UI v2 + headless test matrix
(Prague flat · Golden Gate DEM/suspension · hills mode · road-level render).

### v0.6 (quality pass)
- ambientCG texture pipeline (fetch+cache+material upgrade), wheel-wear shader layer.
- osm2streets junction port (§3); roundabout + cul-de-sac specials.
- bpypolyskel vendored → true hipped/complex roofs; building_tools facade details.
- KayKit prop GLBs bundled; cars as set dressing.
- Modal (non-blocking) build with progress bar; tiled fetch for >1.5 km radius.

### v0.7 (game bridge complete)
- city_collision.glb (collider extras contract v2) + citymap_minimap.glb + semantics v3 JSON.
- Chunked exports for streaming; Draco; KTX2 bake via Cycles.
- Import an existing World-API export for touch-up → re-export.

## 6. Risks

- **Junction visual quality** is the make-or-break; convex-hull pads may look blobby on
  skewed crossings → v0.6 osm2streets port is the insurance.
- Overpass variability (missing lanes/height tags) — all fallbacks deterministic via hash01.
- Perf at radius 1500 m: merged meshes per category keep object counts low; terrain grid
  capped by quality setting; caps on props.
- Blender API churn — extension targets 4.2+; CI smoke test pinned to installed version.

## 7. Attribution shipped in UI/docs

OSM (ODbL) in every export (`attribution` field, app parity) · Mapzen/Tilezen+USGS for DEM ·
"Assets from ambientCG/Poly Haven (CC0)" when textures fetched. All embedded license notices
kept in vendored files.
