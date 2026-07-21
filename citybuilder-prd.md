# CityBuilder — Product Requirements Document

**Status:** Draft v0.3 — MVP (P0) implemented client-side; headless World API live (CLI + Vercel); server-side bake pipeline still vision
**Owner:** (you)
**Last updated:** 21 July 2026

> **How to read this doc.** Sections tagged *(implemented in MVP)* describe code that exists and is tested today (§7A–§7H, §8.5–§8.8, §14A–§14B). Everything else is the target architecture. §19 is the authoritative **PRD-vs-codebase gap map** — read it to know exactly what is real versus aspirational before planning work. §20 is the **repository & file structure map** — a one-line description of every source file, for locating a subsystem in the tree.

---

## 1. Summary

CityBuilder is a **web-based 3D city editor** that turns structured map data into a fully editable, semantically-separated 3D scene of a real city, and then lets a human upgrade any object in place — by generating it with AI, pulling it from an asset library, or uploading a custom model — without touching the parts that are already good enough.

The product's core belief is that a real city is best built as **data first, geometry second**. We ingest authoritative map data (building dimensions, statue placements, road widths, sign and billboard positions, orientations), generate a correct base scene where **every object is its own tagged 3D node**, and give the user a click-to-author workflow to raise the fidelity of exactly the objects that matter.

The **roads are the product**. This is tooling for building a car game where the city must look good *from the road, at human eye level*. Therefore roads, curbs, sidewalks, lane markings, and intersections are generated **procedurally from data to a driving-grade standard by default** — never from a generative-3D model — while buildings, landmarks, and props are the things the click-to-author system exists to improve.

> **Scope note — rendering lives in the game engine.** CityBuilder produces **city elements and textures only**: clean, unlit, engine-ready PBR (metallic-roughness) glTF plus collision and semantics. Lighting, shadows, motion blur, post-processing, reflections, and sky are the game engine's responsibility at runtime and are **never baked into the output**. The editor does provide preview lighting and an optional **"FX preview" toggle** (bloom/grade/vignette approximating the engine's post stack) strictly for look-dev while authoring — preview state never touches the exported content.

---

## 2. Problem & vision

Building a recognizable real city by hand takes an art team months. Fully automatic generation (Google-Genie-style "cook a playable world from a prompt") produces something that looks plausible in a flythrough but is a black box: no clean lanes, no separable objects, no collision you'd trust a car on, and nothing you can edit. Neither extreme fits a studio that wants to ship **many** drivable cities cheaply.

CityBuilder sits in the middle, deliberately:

- **Automatic where automation is reliable** — the road network, terrain, generic buildings, and prop placement come out of the data with no human input.
- **Human-in-the-loop where it isn't** — landmarks and hero buildings get upgraded object-by-object through a fast, cheap, in-editor authoring flow.
- **Everything stays editable and semantic** — because a car game needs lanes, speed limits, signals, and collision, not just a pretty mesh.

**Vision statement:** *Point CityBuilder at a city's data, get a correct drivable base in minutes, then spend an afternoon clicking the 30 buildings that make it feel like that city — and export a web-optimized scene the game can stream.*

---

## 3. Product principles

Drawn partly from what makes Unity AI's in-editor generation feel effortless, adapted to our domain.

1. **The base is never blank.** Every object exists from the first load as a correct-but-generic placeholder with real dimensions and position. The user's job is to *upgrade*, never to *place from scratch*.
2. **Generation is in-context, not a side trip.** Selecting an object and generating a replacement happens inside the editor. No exporting, no separate web tool, no re-importing.
3. **One object, many sources.** Any object can be filled from a menu of interchangeable providers — keep procedural, generate (Trellis / Meshy / others), pull from a library (Sketchfab), or upload. The provider is a per-object choice, routed through a **generation gateway** so we're never locked to one model.
4. **Non-destructive and reversible.** Every replacement is undoable. The original procedural version is always retained; swapping providers is instant because prior results are cached.
5. **Provenance is tracked.** Each object records where its current mesh came from (procedural / AI model X / Sketchfab / upload), its license, and its real-world reference (map link + image). This is essential for review and for legal safety.
6. **Roads are sacred and separate.** The drivable surface is generated to a fixed quality bar and is not part of the "replace me" flow. You don't regenerate a road from a prompt.
7. **Cheap by default, expensive on demand.** The default generator is self-hosted and effectively free per call so the team can explore hundreds of buildings; premium paid generators are an opt-in quality upgrade.
8. **Validate from the driver's seat.** A one-key "drive preview" drops the camera to eye level so the user judges the city the way the player will — from the road, not from the sky.

---

## 4. Core concept: the semantic scene + click-to-author model

The mental model has three layers:

**Layer 1 — The City Graph (data).** A normalized, structured description of the city: roads (centerlines, widths, lanes, one-way, speed), buildings (footprint, height, orientation, roof type), landmarks (which buildings are notable + references), signs/signals/billboards (type + exact position + facing), vegetation, terrain. Source-agnostic (see §6). This is the source of truth.

**Layer 2 — The Scene (geometry).** A 3D scene generated from the City Graph in which **every meaningful thing is a separate, named, tagged object** with its own transform, not baked into one mesh. A building is an object. A statue is an object. A traffic light is an object. A billboard is an object. The road network is a set of objects (per-segment or per-tile), tagged and locked.

**Layer 3 — The Editor + Authoring (interaction).** The web UI where the user selects objects, transforms them with gizmos, and upgrades them through the generation/replacement system.

The magic moment: **click a building → a panel appears showing its real-world reference photo and a "View on map" link → choose "Generate from Trellis" → an upgraded model streams into that exact slot with the right footprint, height, and orientation, replacing the placeholder.** Repeat for the buildings that matter. Export.

---

## 5. Users & primary workflows

**Primary user:** a technical artist / level designer / small-studio dev producing drivable cities for a web car game. Comfortable with 3D concepts (transforms, LODs) but wants to avoid manual modeling.

**Secondary user:** an art reviewer approving which AI/library replacements are good enough to ship.

### Key user stories

- *As a designer,* I load a city's data and get a correct, drivable base scene within minutes so I can immediately drive it.
- *As a designer,* I click any building and see its real-world photo and a map link so I know what it should look like.
- *As a designer,* I generate a replacement for a landmark from a reference image with one click, cheaply, and it lands in the right place at the right size.
- *As a designer,* I try three different providers for the same building and keep the best, with instant switching.
- *As a designer,* I drag a prop into the scene, and move/rotate it with gizmos with snapping.
- *As a designer,* I never worry that editing a building will break the roads.
- *As a reviewer,* I filter the scene to "AI-generated, not yet approved" and step through them.
- *As a designer,* I export a web-optimized package (with LODs, compressed textures, collision, and the lane/semantic data) that the game engine can stream.

---

## 6. The data layer (ingestion)

### 6.1 What "good" data gives us

The vision assumes a **rich, authoritative dataset** — referred to loosely as "Jio-style" premium data — that provides what open sources often lack:

- Building **dimensions** (footprint + explicit height), **orientation**, and roof form
- Statue / monument dimensions and exact placement
- **Road dimensions** (carriageway width, lane count), classification, and network topology
- Exact **billboard**, **road sign**, and **traffic signal** positions and facing
- Real-world **location** (lat/lng) per feature, for map links and reference imagery

Explicit dimensions and orientation are the single biggest reason to prefer a premium source over raw OpenStreetMap: OSM gives footprints and *sometimes* heights but rarely reliable orientation or sign facing, and its lane data is patchy. A dataset that carries these fields directly removes an entire class of guessing.

### 6.2 Source-agnostic ingestion (adapter pattern)

We do **not** hardwire one provider. Ingestion is built as a set of **adapters** that each map an external source into our internal City Graph schema:

- **Premium adapter** (e.g. Jio / commercial HD-map / government GIS) — highest priority where available.
- **Overture Maps adapter** — the strong open default: normalized, QA'd, monthly, global, with stable feature IDs (GERS) for re-syncing. Buildings carry heights where derivable.
- **OpenStreetMap adapter** (via Overpass) — for the long tail of tags Overture doesn't yet carry well (signals, crossings, some lane/turn data).
- **Terrain adapter** — a global DEM (Copernicus GLO-30) as baseline, with opportunistic high-res LiDAR (USGS 3DEP, national programs) where present.
- **Imagery adapter** — Mapillary (open, with ML sign detections) and aerial ortho, used both as reference imagery and to *detect* features (signs, crosswalks, lane lines) where structured data is missing.
- **Reference adapter** — Wikidata/Wikimedia links per landmark to auto-fetch reference photos, plus a map-link builder (lat/lng → Google Maps / Street View URL).

The pipeline uses the best available source per field and falls back gracefully. Coverage and quality vary by city; the ingestion report should surface completeness (e.g. "78% of buildings have heights; lane data missing on 40% of roads") so the user knows what to expect.

> **Note on "Jio special data":** treat this as a configurable premium adapter. If such a licensed dataset is available to the team, it becomes the top-priority source; if not, Overture + OSM + imagery is the working default and the app behaves identically — only the base fidelity differs.

### 6.3 Licensing gate

Every source carries license metadata into the City Graph. OSM/Overture data is ODbL, which has share-alike implications for derived databases; premium data has its own terms; reference imagery has its own. The export step (§14) must be able to report and respect these. **This is a real constraint, flagged early on purpose.**

---

## 7. The generated base scene

### 7.1 Object taxonomy

Everything the user might select or upgrade is a separate object with a semantic type:

- **Road network:** road segments, intersections, sidewalks, curbs, medians, lane-marking decals, bridges, tunnels. *(Locked by default — see §8.)*
- **Buildings:** generic buildings (Tier 2), notable buildings (Tier 1), hero landmarks (Tier 0).
- **Street furniture:** traffic signals, road signs, billboards, streetlights, benches, bins, bus stops, bollards.
- **Vegetation:** street trees, park/green scatter.
- **Terrain:** ground surface, water bodies.

### 7.2 The object data model

Each scene object carries a record like this (illustrative):

```json
{
  "id": "bld_00particle_4821",
  "type": "building",
  "tier": "landmark",              // generic | notable | landmark
  "transform": {
    "position": [x, y, z],         // local ENU meters
    "rotation": [rx, ry, rz],      // from source orientation
    "scale": [1, 1, 1]
  },
  "footprint": [[x,z], ...],       // ground polygon
  "dimensions": { "height_m": 96.0, "levels": 24 },
  "realworld": {
    "lat": 50.0875, "lng": 14.4213,
    "map_url": "https://maps.google.com/?q=50.0875,14.4213",
    "streetview_url": "...",
    "reference_images": ["https://.../ref1.jpg", "..."],
    "wikidata": "Q1234567",
    "name": "Old Town Hall"
  },
  "asset": {
    "state": "procedural",         // procedural | generated | library | uploaded
    "provider": null,              // trellis | meshy | rodin | sketchfab | upload
    "mesh_ref": "proc://bld_00particle_4821",
    "license": "generated-internal",
    "approved": false,
    "lod_refs": { "lod0": "...", "lod1": "...", "lod2": "..." },
    "cache_key": "hash(footprint+height+refimg+provider)"
  },
  "source_provenance": { "adapter": "overture", "gers_id": "...", "confidence": 0.9 }
}
```

Key design points:

- **The slot is stable.** Position, footprint, dimensions, and orientation come from data and stay fixed when you swap the mesh. This is what makes "generate this building" land correctly — the generator fills a known slot, it doesn't decide where the building goes.
- **`asset.state` + `provider` = provenance**, driving the review workflow and license reporting.
- **`cache_key`** makes provider switching instant and re-runs cheap (§11).
- **Multiple LODs** are attached per object as they're baked (§14).

### 7.3 Generic building generation (the 95%)

Tier-2 buildings are generated procedurally: extrude the footprint to the known height, add a roof form, and apply a **regionally-appropriate facade** (window grid, materials, ground-floor storefront) chosen by a style rule pack or a lightweight AI facade pass. These are never individually authored; they exist to fill the city believably at eye level and at distance. They *can* still be clicked and upgraded, but usually aren't.

---

## 7A. Context Resolver & Content Matrix *(implemented in MVP)*

The **Context Resolver** is the single authority that decides every object's **mesh AND material**. It is a declarative, versioned **content matrix** keyed by:

```
(region × feature-type × OSM tags × land-cover × climate)
   → { asset pool, material set, road cross-section, marking style, prop rules }
```

**Design properties:**

- **Declarative & inspectable.** Rules are ordered data (predicates, not code): the first matching rule wins, and every decision records a **provenance chain** ("facade rule: eu-south-residential → picked stucco-warm / tile-red, seeded by id") plus a **confidence score**. The full matrix exports as versioned JSON (`content_matrix_<version>.json`) for diffing and tuning; per-object provenance is visible in the Inspector and shipped in the semantic export.
- **Weighted, seeded asset pools.** Every pick — tree species, facade set, tint, road-surface variant, lamp style, sign shape — draws from a weighted pool via `hash(object_id + salt)`: **varied but fully deterministic**. Same city in, same city out, on any machine.
- **Confidence & fallback chain.** Exact tag match → region/climate rule → feature-type default → generic fallback, each step lowering confidence. Missing data never blocks a build; it only lowers fidelity and is reported.
- **Context adapters** (each with graceful fallback, source recorded):
  - **Region** — Nominatim reverse geocode → country → region pack (driving side, center-line color/pattern, crosswalk style, sign shape, lamp style). ~9 packs cover the target markets.
  - **Climate** — Köppen-style classification (heuristic adapter today; pluggable for a real Köppen raster).
  - **Species** — **GBIF** occurrence facets near the site, blended with the climate prior, mapped to tree archetypes (broadleaf / columnar / conifer / palm / acacia).
  - **Land cover** — **ESA WorldCover / Dynamic World** slot; OSM-derived polygons (landuse/natural/leisure) are the working classifier until the raster pipeline lands in the bake service.
  - **CLIP** *(optional, P2)* — neighborhood style classification from street imagery via an inference endpoint.
- **Zoning-aware density.** Land-use polygons drive prop rules per zone: streetlight spacing, bench/bin density, street-tree spacing (retail ≠ residential ≠ industrial ≠ park).
- **Variety linter.** After every build, an automatic pass flags monotony: dominant variants (>55% one facade), adjacent buildings sharing facade+tint, single-surface road networks, and low-confidence clusters. Warnings surface in the editor's Build Context panel.

## 7B. Material & Texture System *(implemented in MVP)*

All output materials are **PBR metallic-roughness, authored unlit** — no baked lighting, shadows or AO gradients; the engine lights the city at runtime.

- **Surface library by surface × region:** asphalt in three wear states (new / worn / patched), cobblestone, pavers, gravel, sidewalk concrete; brick (red/brown), stucco (warm/cool), concrete panel, office glass ribbon, dark curtainwall, storefront; roof bitumen / clay tile / standing-seam metal / pale concrete. Each set carries albedo + metallic-roughness (glTF G/B packing), and height-derived **normal maps** where relief matters (cobble, pavers, brick roof tile).
- **Facade trim-sheet rows.** Facade styles are authored as tileable window-bay rows (one bay ≈ 3.6 × 3.2 m); at bake time rows pack into a trim-sheet atlas. Buildings map walls in world-space meters so texel density stays consistent regardless of footprint.
- **Seeded per-instance variation.** Every building gets a seeded tint from its facade set's palette and a seeded UV offset; road segments get seeded UV shifts so adjacent segments don't visibly tile; trees get per-instance hue/scale variation via instanced colors.
- **Decals are content, not post-FX:** cracks, oil stains, asphalt patches and manholes are seeded mesh quads with alpha textures placed by the resolver's wear-density rules; lane markings and crosswalks are marking-decal geometry driven by the region pack. All of it exports as regular geometry.
- **Packaging policy (KTX2/Basis).** The editor previews raw textures; the export ships a **`textures_manifest.json`** declaring, per texture: codec (ETC1S for albedo, UASTC for normals), color space, mip chain, and **texel density**, plus global per-LOD texture budgets (LOD0 24 MB → LOD2 2 MB per tile). The bake service (P1) encodes to KTX2 per this manifest.

## 7C. Robustness: Roads, Water, Flicker, Props *(implemented in MVP)*

Five content-correctness guarantees, each enforced by generation rules **and** an automatic linter. All output stays geometry + textures; rendering remains the engine's job.

**1 — Zero z-fighting.**
- Everything lives in a **local ENU meter frame** (small coordinates, tight camera depth range).
- A **documented vertical layer convention** replaces ad-hoc offsets: terrain 0 < water 0.012 < green 0.016 < road 0.03 < wear decals 0.05 < junction surfaces 0.07 < markings 0.12 < crosswalks 0.135 < sidewalk tops 0.18 — minimum 8 mm separation between any two flat layers. Markings/decals additionally carry polygon-offset as the tagged decal-layer depth-bias convention.
- **Building bases are seated 0.4 m below grade** — no coplanar base/terrain face can exist. Bridges clear crossed roads per OSM `layer` (6.5 m per layer step).
- **Coincident geometry is welded**: merged network meshes (sidewalks, intersections, bridge structures, barriers) pass through vertex deduplication (1 mm tolerance) before registration. (Server-side bake will extend this with trimesh boolean carving of roads/water into the terrain; in-editor the layer convention is the working equivalent.)
- **Flicker linter**: after every build and again as an **export gate**, a pass (a) asserts the layer convention's separations, and (b) scans all flat meshes for near-coplanar XZ-overlapping pairs (< 8 mm apart), reporting offenders by name.

**2 — Consistent roads + bridges.**
- Road centerlines are evaluated as **continuous reference lines**: a centripetal Catmull-Rom is fitted through the OSM polyline and resampled at even arc length, endpoints preserved — no faceted "draped polyline" corners. The evaluator is isolated behind the same `evaluate(s) → {pos, dir, elevation}` shape OpenDRIVE uses, so the planned server-side **osm2opendrive → libOpenDRIVE/esmini** import path replaces the evaluator without touching corridor meshing. *(Full OpenDRIVE adoption is a bake-service milestone; the in-editor evaluator delivers the geometric contract today.)*
- **Bridges are roads with an elevation profile**: grade-limited approach ramps (≤ 6 % target), parameterized deck fascia + continuous rails + piers, welded into single structures.
- **Consistency linter**: flags width jumps > 60 % between connected same-class segments, near-miss endpoint seams (0.15–0.8 m), bridges too short to reach their layer height at ≤ 10 % grade, and bridges with < 4.5 m clearance over crossed roads.

**3 — Water.**
- Lakes from `natural=water` polygons; **rivers/canals/streams from buffered `waterway` centerlines** (tagged width or class defaults); **sea assembled from `natural=coastline` ways** using the OSM water-on-the-right convention — chains are stitched, closed around the data bounds both ways, and the closure containing the fewest buildings is kept (buildings are land). ESA WorldCover remains the supplementary source in the bake service, as does OSMCoastline/osmdata prebuilt polygons for whole-coast fidelity.
- Water renders as a **tagged flat water surface at sea level** with a water material, placed on its own layer below roads and slightly overlapping shore seams; terrain carving is a bake-service boolean (layer convention prevents coplanarity in-editor). Multipolygon water relations are assembled with proper holes.
- **Waterfront buildings are reseated, not deleted.** A building with ≥ 50 % of its footprint *vertices* over water (a vertex-fraction test — a centroid test misclassifies long piers) is reseated to grade and given a **concrete pier deck** under its footprint (all decks merge into one draw call); `historic=ship` features are dropped entirely — a boat is not a building.

**4 — Common props.**
- A **prop library mapped by OSM tag through the Context Resolver**: fountains (`amenity=fountain`), statues/memorials (`historic=memorial|monument`, `tourism=artwork`), bus stops (`highway=bus_stop`), benches, bins, lamps, playgrounds, and fences/walls (`barrier=*`) — all with **seeded per-instance variety** (variant choice, proportions, rotation).
- Ships with procedural CC0-style stand-ins; real **CC0 packs (Kenney / Quaternius / Poly Pizza)** drop into `/public/props/` and take precedence per kind. Surface materials follow the §7B library (ambientCG/Poly Haven swap-ins at bake), packaged per the KTX2 manifest.
- **Wikidata-linked props route to AI generation**: statues/fountains carrying a `wikidata` tag register a generation slot in the gateway — the same replace/approve/cache flow buildings use.

**5 — Prop & building placement engine.**
- Every street prop (lamps, signals, signs, benches, bins, bus stops, curbside devices) obeys shared **curbside placement rules**: offset outside the carriageway with per-kind clearance, snapped to the road's solved elevation, and **deck-riding on bridges** (props on a bridge sit on the deck, not the water below). Rails and fences render DoubleSide so they never vanish from behind.
- A **penetration-based road-clearance test** keeps building geometry out of the carriageway (offenders are nudged or culled) — penetration depth, not centroid distance, is what catches long thin footprints.
- **QA loop:** a `__cb` debug bridge exposes build/lint/camera state to Playwright, so headless **screenshot audits** can drive the camera to any coordinate and visually verify placements (used by the project's verify skill).

## 7D. Asset Library & Labeling *(implemented in MVP)*

The downloaded asset library lives in **`assets/library/<pack>/`** — one folder per source pack, with a fixed internal layout: `gltf/` (canonical format, self-contained with its texture copies), `fbx/unity/` + `fbx/unreal/` (engine exports of the same models), `textures/` (source texture set), `previews/`, and `LICENSE.txt`. First pack: **Quaternius Downtown City MegaKit** (CC0 1.0) — 153 models: 3 complete buildings, 116 modular facade-kit pieces (brick / metal-glass / painted-trim / slate families), 15 road tiles, 17 marking decals, 7 sidewalk tiles, and 5 street props.

**Scanner → manifest.** `node tools/build-asset-manifest.mjs` (re-runnable, zero deps) parses every glTF in the library and writes **`assets/manifest.json`**. Per asset it extracts *measured* geometry — world-space bounding box in meters (POSITION accessor min/max through the node transform hierarchy), triangle count, material/texture lists, LOD detection (`_LOD<n>` naming; this pack ships LOD0 only) — and *classified* semantics from an ordered keyword lexicon: `semantic` (building, building_module, road_module, road_decal, sidewalk_module, street_furniture, rooftop_prop), `role` (window, cornice, bollard, crosswalk…), `style` (brick-red, metal-glass, slate, asphalt-us…), mapped **OSM tags** (`building=commercial`, `barrier=bollard`, `man_made=manhole`, `highway=crossing`…), `internalTags` for pipeline stages with no mainstream OSM equivalent (lane arrows → `turn:lanes~*`), plus `source` and `license` read from the pack's LICENSE file.

**Review flags.** Assets that are `unclassified`, `oversized` (per-semantic dimension caps), `high-poly` (per-semantic triangle budgets), or geometry-less are flagged in the manifest and **excluded from pools** — they appear in the coverage report's review table instead. Current pack: 0 flagged.

**Weighted pools & deterministic pick.** Unflagged assets group into pools keyed by **(OSM tag × style)**. The resolver (`src/resolver/assetPools.ts`) picks with the pipeline's existing determinism contract — `pickWeighted(pool.entries, hash01(featureId + '|' + poolKey))` — so a feature always gets the same asset while neighbors vary. Weights: 1.0 default, 0.5 for `_noWear` clean duplicates, and building pools weight size classes per tag (large favored for `building=office`, small for `building=retail|residential`). Road/sidewalk tile pools are marked **`referenceOnly`** and are never picked — CityBuilder roads stay procedural and locked (§8); the tiles exist for engine export workflows.

**Scale normalization & grounding.** The kit is authored at true world scale (28 m large building, 0.89 m bollard, 3 m sidewalk tile), so placement normalizes rather than guesses: `normalizeScale(asset, {x, y, z})` returns per-axis scale = feature dimension / measured asset dimension, clamped to [0.25, 4] so mis-tagged OSM features can't produce absurd geometry, with unknown axes inheriting the mean known scale to preserve proportions; `groundOffset()` seats the scaled bbox min at grade. This is the same fit-to-slot philosophy the upload flow uses (§9).

**Coverage report.** The scanner also writes **`assets/coverage-report.md`**: pipeline-consumed OSM tags vs. library supply. Currently 10/24 tags covered; the acquisition priority list for the missing ones is explicit — trees, street lights, benches, traffic signals, signs, hydrants, bus stops, fences, fountains, vehicles — each of which falls back to §7C's procedural stand-ins until a pack covers it. Tests (`src/__tests__/assetManifest.test.ts`) gate the contract: schema completeness, pool referential integrity, real-world-scale sanity, pick determinism/variety, and clamp behavior.

**Labeling roadmap (P1+).** The lexicon is deterministic and auditable but filename-bound. Planned upgrades, in order: (1) **gltf-transform** (open source) in the scan step for mesh dedup/Draco/KTX2 and automatic LOD chain generation; (2) **open-vocabulary labeling** — render each asset's turntable thumbnail and score it against the OSM tag vocabulary with an open CLIP model (e.g. `open_clip`), replacing the lexicon for packs with uninformative filenames (the resolver's `CLIP_ADAPTER` slot in §7A is reserved for exactly this); (3) per-asset **thumbnail previews** in the Replace panel so the library doubles as a browsable catalog.

## 7E. Sketchfab library integration *(implemented in MVP)*

The asset library is not limited to bundled packs — it plugs into **Sketchfab's Data API v3** for both offline curation and an in-editor search-and-replace flow. All access is keyed by a `SKETCHFAB_API_TOKEN` that stays **server-side** (see the security note below).

**Curation → catalog (offline).** `node tools/sketchfab-curate.mjs` searches Sketchfab for each coverage gap (§7D) under three constraints — **downloadable**, **permissive license** (CC0 / CC-BY / CC-BY-SA only; NC and ND are excluded by construction, ND because it forbids the scale-to-slot fitting we depend on), and a **per-semantic polygon budget** tuned for a dense drivable city (street furniture must stay cheap since many instances share the screen; hero props may be richer). It scores candidates (license permissiveness · budget fit · popularity), labels each with the same resolver vocabulary as the local manifest (`semantic · style · osmTag`), and writes **`assets/sketchfab-catalog.json`** — a labeled, license-audited *index* (no meshes bundled). The public API intermittently rate-limits, so all calls retry with backoff.

**Fetch → library (offline).** `node tools/sketchfab-fetch.mjs [osm-tag …]` downloads the top-scored candidate per gap into `assets/library/sketchfab-curated/glb/`, records explicit per-file labels in `labels.json` (authoritative — Sketchfab filenames are arbitrary, so the keyword lexicon is bypassed) and attributions in `NOTICE.md`, then the manifest scanner folds them into pools. The scanner parses **binary GLB** (JSON-chunk extraction) as well as text glTF, and honors the `labels.json` sidecar. Downloaded models arrive at wildly inconsistent authoring scales (metric to ~1000×); the scanner flags out-of-scale assets **`oversized`** but, because every placement path normalizes scale to the feature's real dimensions, that flag is *advisory* (the asset stays pooled with a `normalizeScale` hint) rather than disqualifying. Genuine disqualifiers (`unclassified`, `no-geometry`, `high-poly`) still exclude from pools.

**In-editor search & replace (the interactive path).** The Replace panel (§9) gains a **"Search Sketchfab library"** provider alongside *keep procedural* / *generate* / *upload*. Selecting it opens a live search — query seeded from the object's type/kind, filtered to downloadable + permissive + under the object's poly budget — rendered as a thumbnail grid (name · poly count · license · author). Picking a result downloads the GLB, fits it into the slot (`fitToSlot` for buildings by footprint; fit-to-bounds for props), and swaps it in with `state: 'library'`, `provider: 'sketchfab'`, and the license + author string recorded as provenance (carried into exports). This lets a user upgrade a placeholder by **searching a real model library** instead of only generating or uploading — the workflow users actually reach for.

**Security & deployment.** The token is never in the client bundle. In development the Vite server proxies `/api/sketchfab/*` to the API with the `Authorization` header injected server-side, and streams model downloads via a `/api/sketchfab-dl` fetch middleware (a path-rewriting proxy corrupts AWS presigned-URL signatures, so the signed URL is passed through byte-for-byte). A static production build has no dev server, so the feature needs an equivalent backend/serverless proxy; until then it **degrades gracefully** — the provider probes `/api/sketchfab/me` and disables itself with an explanatory message if the proxy is absent.

**Licensing.** Only CC0 / CC-BY / CC-BY-SA models are surfaced or fetched. CC-BY / CC-BY-SA attribution is recorded in `NOTICE.md`, stamped into the asset manifest, and carried into every scene export's per-object provenance.

**Build-time auto-placement *(implemented in MVP)*.** The 2D→3D build now places library GLBs directly, not just on demand. Before `buildScene` runs, `loadLibraryTemplates()` (`src/scene/libraryTemplates.ts`) resolves one representative pooled asset per point kind present (`pickAssetFor(kindTag, kind)`), loads its GLB, and normalizes it to a canonical real-world height per role (a non-metric 1000× tree or a metric picnic table both land at believable street scale), centered on X/Z with its base at y=0. The synchronous prop builders then consume those templates:

- **Instanced kinds** — trees, street lamps, benches, bins — reuse their existing seeded placement math (`buildTrees` / `buildFurniture`) but swap the procedural geometry for `InstancedMesh`es built from the template parts (one per GLB mesh/material), so thousands of real models render cheaply.
- **Individually-selectable kinds** — traffic signals, bus stops — clone the template per feature in `buildScene`.
- Any kind without a pooled GLB (or on a load error) falls back to the procedural generator per-kind — the scene never breaks.

**Buildings** auto-place too: `buildingSceneFor(b)` picks a pooled building model per footprint (`pickAssetFor`), and `fitToSlot` scales it uniformly to the footprint, centers it on the centroid, and sinks its base below grade (same `BASE_SINK` as procedural, so no bottom face is coplanar with the terrain — verified: the flicker linter stays clean). Library buildings are gated to low/mid-rise (`heightM ≤ 45`): fitToSlot scales uniformly, so dropping a short model into a tall-tower slot would squash it — towers keep their procedural mass, low/mid-rise gets real models, giving a believable mix.

Both text `.gltf` (Quaternius, with sibling `.bin`/textures) and self-contained `.glb` (Sketchfab) load directly: `GLTFLoader` resolves relative resources against the `.gltf` URL, which the `/assetlib/**` dev middleware serves — so no offline GLB-packing step is needed. Library files are served from the repo at `/assetlib/**` (kept out of `/public` to avoid duplicating ~250 MB); a static production build must publish `assets/library` alongside `dist`.

**In-app Curation Studio *(implemented in MVP)*.** Curation is no longer only an offline script: a visual **Curate Asset Library** studio (`src/ui/CurationStudio.tsx`) lets the user hand-pick the model variants used per kind (tree, lamp, bench, signal, …) from live 3D previews. Picks persist in a zustand store (`src/state/curation.ts`) that the build path reads directly — no JSON download/re-import round-trip — and a baked selection (33 hand-picked models) ships as the default. The **Kenney City Kit Roads** pack was added alongside the Quaternius MegaKit (road tiles remain reference-only; roads stay procedural).

A **Library assets** toolbar toggle rebuilds the current scene in place (`rebuildWithLibraryAssets`, reusing the cached City Graph + context) so procedural and library looks can be compared instantly. **As of §7F it defaults OFF** — the Building Recognizer drives appearance by default, and the local library is one (opt-in) branch of its fallback chain. The toggle and every function above stay intact for re-enabling and improving later. Any feature with no pooled asset (or a load error) falls back to procedural per-kind — the scene never breaks.

## 7F. Building Recognizer & Appearance Pipeline *(implemented in MVP)*

**Problem.** No global dataset labels architectural style. A building's `building=*` value tells you *use*, not *look*; height and levels tell you *mass*, not *material*. The only signal that actually carries appearance is **imagery** — but imagery is sparse, noisy, and expensive to reason over at city scale. So the recognizer treats **imagery as the primary signal, grounded by structured data**, and degrades gracefully to structured-only when no image exists. It decides *how each building looks* and *what fills its slot*, caching both the descriptor and the result per building.

**Signal fusion (Stage 1 — structured priors).** For every building, `src/recognizer/priors.ts` gathers a `BuildingPriors` record from data already in hand: the OSM `building` type, `building:architecture`, `roof:shape` (normalized to a buildable `RoofForm`), `roof:material` and `building:material`/`building:facade:material`; the country→region **style prior** (the resolver's region pack, §7A); height/levels with a confidence flag (measured vs. estimated); climate and zone; and, for wikidata-linked landmarks, the **Wikidata architectural style** (property **P149**, label-resolved) plus a **reference photo** (**P18**). These last two are network-bound, so an async prepass (`prefetchRecognizerData`, run in `buildCity.ts` right after context resolution) fetches them for the handful of wikidata-linked buildings and caches them, keeping the synchronous scene build non-blocking. The record also names the **massing source** — today `osm-extrusion`; **LoD2 roof shape (PLATEAU / 3D BAG)** and **GlobalBuildingAtlas / OpenBuildingMap** massing are documented milestones that land with the bake service and slot into the same field.

**Signal fusion (Stage 2 — the descriptor).** Priors (and, when present, the photo) resolve to a structured **`BuildingDescriptor`**: `style` (one of ten canonical `ArchStyle`s), `material` class, `roofForm`, `floors`, `era`, distinctive `features` (cornice, setbacks, storefront, columns, balconies, dome…), a concise **text prompt**, and a `confidence`. Two implementations sit behind one shape:
- **`describeWithVlm(priors)`** — the real seam. POSTs `{imageUrl, priors}` to a **vision-language model** and returns the descriptor JSON. Off until `VITE_VLM_ENDPOINT` is configured (`VLM.available`), mirroring the generation gateway's "a real endpoint is config, not code" posture (§9/§11) and the resolver's `CLIP_ADAPTER` slot (§7A).
- **`describeFromPriors(priors)`** — the deterministic default. Fuses the architecture/material/roof tags, Wikidata style, height, region and climate into a descriptor + prompt with **no network and no randomness** beyond a `hash01(id)` tie-break, so the same building always recognizes the same way. `confidence` is **evidence-weighted**: 0.9 with a Wikidata style, 0.8 with a `building:architecture` tag, rising from a ~0.4 floor as material/roof/type/measured-height tags accumulate.

**The fallback chain.** Per building, `recognizeBuilding` (`src/recognizer/recognizer.ts`) produces an `AppearancePlan`:
1. **Structured priors** gathered (Stage 1).
2. **Photo + VLM → descriptor** when a photo exists and the endpoint is wired; otherwise the descriptor is **synthesized from priors** (Stage 2). The plan records which happened and, when a photo exists but no VLM is configured, flags the building for a **photo-grounded upgrade**.
3. **Fill the slot.** The descriptor's prompt seeds (a) a **Sketchfab search** via the existing Data-API flow (§7E) — the Replace panel's query is now the recognizer's `style + type` string — and/or (b) **image-to-3D generation** (Trellis/Meshy, §9) conditioned on the same prompt + reference photo; the result is fit to the slot's footprint/height/orientation. Both are the **recommended on-demand upgrade** surfaced by a one-click **✨ Auto-fill** button (generate-from-photo when a photo exists, else find-a-match-on-Sketchfab).
4. **No photo / no match → a procedural facade driven by the descriptor** (the build-time default). When the descriptor's evidence is strong (`confidence ≥ 0.6`) it **overrides** the generic resolver pick: `material → FacadeSet`, `roofForm + material + climate → RoofSet`, seeded tint — and for low/mid-rise (`≤ 25 m`) it adds real **roof geometry** (`buildRoofCap`: hip/pyramid/gable/mansard/skillion tent forms, or a scaled hemisphere for domes) that fully covers the flat extrusion top so no coplanar face is exposed (the flicker invariants stay clean). Weak evidence keeps the resolver's baseline look, so untagged stock never regresses.

**Caching.** Descriptors and plans are cached per building (`descriptorCache` / `planCache`, cleared at the top of each `buildScene`); Wikidata style/photo lookups are cached separately because they survive rebuilds (network cost). The recognizer's resolution replaces the resolver's in `buildingResolutions`, so the variety linter, the inspector's provenance trail, and the semantics export all reflect its decision. The generation cache key folds in the descriptor `style`, so two visually distinct recognitions of the same footprint cache as distinct results (§11.2).

**Provenance & UI.** Every plan carries a human-readable trail — `recognizer: <style> / <material> / <roof> / <floors> / <era>`, the descriptor **source** (VLM vs. structured priors, with a note when a photo is available for upgrade), the **signals** consulted, the chosen appearance, and the build path + recommended upgrade — shown in the inspector's *Content resolution* section. The Replace panel gains a **🔎 Building Recognizer** block: the descriptor summary, confidence, prompt, and the Auto-fill action.

**Asset-library toggle (OFF by default).** The local asset library (§7D/§7E) is now behind the `useLibraryAssets` store flag, **defaulting off**. When off, buildings render via the recognizer's descriptor-facade path; when a user flips the **Library assets** toolbar toggle on, the recognizer's *library-match* branch is enabled and low/mid-rise buildings (and street props) are filled from the bundled/curated GLB pools exactly as before. The flag flip is the only behavioral change — `loadLibraryTemplates`, `buildingSceneFor`, `pickAssetFor`, the manifest pipeline and the toggle are all intact, so the library can be re-enabled and improved later without rework.

**Tests.** `src/__tests__/recognizer.test.ts` pins the contract: roof:shape normalization, deterministic per-building descriptors that vary between buildings, style inference from `building:architecture` / Wikidata style / structure, valid `FacadeSet`/`RoofSet` mapping, the fallback-chain path selection (library-vs-descriptor, tall-building exclusion, photo-vs-no-photo upgrade), per-building plan caching, and the library flag defaulting off.

**Roadmap.** (1) Wire a real VLM endpoint (`VITE_VLM_ENDPOINT`) and a street-level photo source (**Mapillary**, aerial tiles) so `hasPhoto` extends past Wikidata landmarks; (2) LoD2/GlobalBuildingAtlas massing in the bake service to replace flat extrusions where available; (3) neighborhood-level style smoothing so a recognized block reads as a coherent street, not independent guesses.

## 7G. Terrain relief system *(implemented in MVP)*

Ground is no longer an implicit flat plane: a **deterministic, hydrology-aware terrain height field** (`src/procgen/terrain/field.ts`) is the single elevation authority that every consumer samples — visual ground mesh, physics collider, building seating, prop grounding, vegetation roots, and the road corridor solve's `baseHeight` (§8.5) all read the same field, so nothing floats or sinks.

- **One field, many consumers.** `sampleTerrain(x, z)` is pure and seeded; the visual terrain and the physics collider are built from the *same* geometry (`terrain/mesh.ts`), so the car always drives the ground it sees.
- **Hydrology-aware.** Water bodies depress the field (riverbed depressions), so rivers sit in real channels rather than being painted on a plane; `conformTerrainToRoads` blends the ground to meet road corridors (this satisfies the terrain-skirt requirement from the §8.6 roadmap).
- **Flag-gated.** The "⛰️ Terrain relief" toolbar toggle flips it for instant A/B; the module flag (`terrain/config.ts`) defaults **OFF** (flat world) so every parity/flicker/collider test stays byte-identical.
- Tests: `terrainField`, `terrainCarve`, `terrainIntegration`.

## 7H. Landmark catalog *(implemented in MVP)*

Named / wikidata-tagged OSM features route through a **landmark catalog** (`src/scene/landmarks.ts`) that maps recognizable real-world structures to bespoke procedural (or glTF) treatments instead of generic extrusions:

- **Procedural bridge superstructures** (`src/procgen/bridges.ts`): suspension / cable-stayed (towers, catenary main cables, hangers, girder — the Golden Gate class) and **stone-arch** (the Charles Bridge class), built over the same road-deck corridor the traffic drives on.
- A prefetched **Prague Staré Město** sample (`public/data/prague_osm.json`) ships as the landmark/bridge showcase alongside Lower Manhattan; the `pragueBuild` and `landmarkBridge` tests pin it.

---

## 8. Roads & the drivable surface

**This section is deliberately strict because it is the product's core requirement.**

### 8.1 Roads are procedural-from-data, not generative-3D

Roads, curbs, sidewalks, intersections, lane markings, bridges, and tunnels are generated by a **deterministic procedural system** driven by the road data. They are **not** produced by Trellis, Meshy, Sketchfab, or any generative-3D or asset-library source, and they are **not** part of the click-to-replace flow. Reasons:

- Generative-3D meshes have no clean, flat, drivable surface, no defined curb height, no lane semantics, and no trustworthy collision. A car game cannot drive on them.
- We already have the road data (widths, lanes), so procedural generation is both higher quality *and* cheaper than generating road geometry.

When the vision says "roads should be AI-generated," the correct reading is: **AI is used only to *extract road attributes* from imagery** (detecting lane counts, crosswalk positions, markings where structured data is missing) — the geometry itself is then built procedurally from those attributes. No generative mesh touches the road.

### 8.2 Quality bar ("good enough for driving, no wasted polygons")

- Flat, smooth drivable surface with grade-limited vertical profiles (no bumpy DEM-draped roads).
- Proper raised curbs and sidewalks as separate meshes.
- Correct lane markings as **decals or baked into the road texture** (cheap; regionally correct — e.g. yellow vs white center lines, local crosswalk styles).
- Clean intersections with corner radii, stop lines, and crosswalks.
- Correct bridges (deck + rails + piers) and tunnels (portal + bore) using `layer` ordering for grade separation.
- **A separate lightweight collision mesh** — the car never collides against the visual mesh.
- Minimal tessellation: straight segments are low-poly; curves get just enough segments to read smoothly. No decorative geometry on the road.

### 8.3 Generation method (summary)

Build a road graph from the data → clean topology (merge nodes, resolve grade separation, normalize roundabouts) → assign smoothed elevation → sweep a per-class cross-section (lanes + curb + sidewalk) along each centerline → solve intersection surfaces → place marking decals and signage → emit tagged, locked road objects + collision. (This is the standard procedural-road approach; Houdini is the recommended engine for it in the backend — see §12.)

### 8.4 Regional rule packs

Road markings, sign shapes/colors, driving side, and furniture spacing differ by country. A per-region rule pack drives these. Building a handful (≈15–30) covers most target cities and is what makes each city feel locally correct rather than generically American.

### 8.5 Road geometry system *(implemented in MVP)*

The in-browser road engine solves true 3D geometry, not draped 2D ribbons:

- **Network elevation solve (default ON).** A corridor graph (`src/procgen/corridor/`) runs a Gauss-Seidel node relaxation with grade-limited edges over the whole network, giving every road a continuous, drivable vertical profile; bridges ramp to their `layer` height and back. Renderer, colliders, markings, and semantics all read the road y-channel through one seam (`corridor/index.ts`).
- **Junction consolidation — one junction, one height.** Osm2streets-style clustering contracts dense node piles (dual carriageways, slip lanes, bridgeheads) into single junctions before the solve, killing the "pancake pile" artifact (`corridor/cluster.ts`).
- **Polygonal junction surfaces.** Intersections are dedicated polygon pads with rounded, flared arm-hulls (no circle-union blobs). Pedestrian plazas are raised onto a real curb slab, not flush paint.
- **Crown, camber & superelevation (flag, OFF by default).** `crossSection.ts` crowns the carriageway (2 % centre-raise, kerbs stay at grade) and banks curves up to 6 %, fading to flat near junctions so a crowned mid-block meets a flat junction disc with no seam step. The surface mesh, the marking/decal elevation sampler, and the physics collider share the same offset function — the car rides exactly what it sees.
- **Framed roads (flag; default ON for World API/headless, OFF in the editor toggle).** `framedRoads.ts` + the band-based `framedKit/` engine wrap the carriageway in a raised concrete curb-frame → grass verge → footpath cross-section with per-road-class presets (motorway/trunk stay frameless — expressways have shoulders, not sidewalks). Bands *partition* the width with exact shared seams, so coplanar z-fighting is structurally impossible. Opt-out per API request (`framedRoads: false`) or CLI (`--no-framed-roads`); the GLB kit + `npm run experiment:roads` harness remain the design reference.
- **osm2streets spike (GO).** Lane-level geometry from our OSM via osm2streets-js (WASM) is proven feasible (`docs/osm2streets-spike.md`) — the planned path to true per-lane rendering.

### 8.6 Road surface, weather & look-dev fidelity *(implemented in MVP)*

Executed from a deep-research **Top-25 road visual-techniques roadmap** (`docs/road-visual-techniques-research.md`); Phases 1–3 and part of Phase 5 are shipped:

- **Anti-tiling asphalt:** hex-tiling of the albedo fetch (Mikkelsen, JCGT 2022) plus world-position macro variation kill the visible texture repeat; **detail normals** add meso-scale aggregate; **height-blend** transitions between asphalt wear states with real contrast.
- **Driven-in wear:** a splat/wear-mask darkens wheel paths; a **worn-paint** world-position shader ages lane lines and crosswalks; wear decals (cracks, patches, manholes) carry **normal maps** so they catch light.
- **Weather (live uniform, no rebuild):** a wet/dry toggle darkens the asphalt, drops roughness so the sun glints off it, and pools near-mirror **puddles** in a world-space mask — no SSR or env map needed. Default wet.
- **Stone relief** for cobble/pavers: domed albedo + stronger stone normals (hex-tiling is deliberately *not* applied to structured patterns — it breaks them).
- **Road-kit A/B:** a "realistic" (textured aggregate) vs "arcade" (clean kit look) surface-style toggle.
- **FX-preview post stack:** N8AO ambient occlusion (log-depth- and fog-aware) + exponential aerial fog + bloom / grade / vignette / SMAA — strictly look-dev, never exported (`GLTFExporter` ignores scene fog; materials stay clean unlit-authored PBR).

### 8.7 Roadside vegetation *(implemented in MVP)*

Slow-Roads / ETS2-style verges (`src/procgen/vegetation.ts`): instanced **grass tufts + low shrubs** scattered along the strip beside the carriageway wherever the land cover is grass/bare. Deterministic (seeded by road id + station), land-cover- and zoning-aware, rooted on the terrain field (§7G), GPU-instanced (one `InstancedMesh` per kind) with distance-dither LOD and per-instance hue/scale jitter (drier and yellower on bare ground). The planner is pure geometry — no THREE, no canvas — so it is unit-testable (`roadsideVegetation` test); the canvas-touching mesh builder loads lazily. "🌿 Roadside greenery" toggle, ON by default.

### 8.8 Traffic core & road semantics *(implemented in MVP)*

A faithful traffic layer generated from data and exported for the game's traffic AI:

- **Speed limits** (tagged or class-default, region-correct units), **traffic signals**, **region-keyed signs** (procedural pole + canvas plate face), **stop lines**, and **turn-lane arrows** — all placed by the §7C placement rules, with pure shared math (`signMath.ts`) so the renderer and the export always agree on orientation and effective limits.
- Everything lands in **`city_semantics.json` v3** (3-component centerlines in true meters + per-device records) — the same data that built the city drives runtime traffic (§14). Gated by the `trafficIngest` / `trafficSemantics` / `signPlacement` tests.

---

## 9. The object replacement & generation system (the heart)

This is the feature that defines CityBuilder. It applies to **buildings, landmarks, and props — never roads.**

### 9.1 Selection → context panel

Clicking an object opens an inspector panel showing:

- Its **real-world reference**: name, a reference photo (auto-fetched via Wikidata/imagery), and a **"View on map" / "Street View"** link so the user can see the real building.
- Its current **asset state** and provider.
- The **replacement options** menu.

### 9.2 Replacement options (the provider menu)

A per-object menu, routed through the **generation gateway** so providers are pluggable:

1. **Keep procedural** — the default placeholder (always available, always free).
2. **Generate from reference image (AI)** — the primary flow. The object's reference photo (or a user-supplied image / prompt) is sent to an image-to-3D provider. Providers are interchangeable:
   - **Trellis (self-hosted)** — the **default, cheap** option (see §11). Good for notable buildings and props.
   - **Meshy / Rodin / Tripo / Hunyuan3D (paid API)** — opt-in **quality upgrade** for hero assets; better topology/textures at a per-call cost.
3. **Pick from library (Sketchfab)** — search a model library in-panel and drop a matching downloadable, appropriately-licensed model into the slot. Good for generic, reusable props (benches, lamps, common street furniture).
4. **Upload custom** — drag in a glTF/FBX for hero landmarks the team modeled or bought.

Whichever source is chosen, the result is **fit to the slot**: auto-scaled to the known dimensions, aligned to the known orientation, and grounded on the footprint. The user can then fine-tune with gizmos.

### 9.3 Generation job flow (async)

Generation is not instant, so it's a background job:

1. User picks a provider → a job is queued (object marked "generating," showing a spinner in-scene over the placeholder).
2. A worker calls the provider (self-hosted Trellis on a GPU, or a paid API via the gateway).
3. Result mesh + textures are post-processed: normalize scale/orientation, center on footprint, auto-LOD, compress.
4. Result is **cached by `cache_key`** and swapped into the slot. The placeholder is retained.
5. User approves or rejects. Rejecting reverts to the previous state; the cached result is kept for instant re-try.

Because results are cached per `cache_key`, **switching providers or re-opening a city is instant**, and identical buildings across a city (or across cities) are generated **once** and reused.

### 9.4 Provenance & review

Every replacement stamps `provider`, `license`, and `approved`. The scene can be filtered by these (e.g. "show all Sketchfab assets," "show unapproved AI assets"), enabling a fast review pass and a clean license report at export.

---

## 10. The editor (web-based 3D app)

A real 3D scene editor, in the browser. Required capabilities:

### 10.1 Viewport & camera
- Orbit camera for overview; **fly camera with CS-style noclip controls** *(implemented in MVP)* — pointer lock, smooth acceleration, scroll-wheel speed.
- **Drive preview mode** *(implemented in MVP)* — one key spawns a physics car (Rapier `DynamicRayCastVehicleController`, raycast wheels) at the nearest road point and drops the camera to a chase view, so the user validates the city *from the road* (directly serves the #1 requirement). Deliberately **arcade**: chassis pitch and roll are locked (`enabledRotations` = yaw only) so the car can never flip on braking, cornering, or collisions; braking is gentled and damping tuned so stops don't pitch the body. The car is a procedural silhouette (lower body + cabin + slanted windshield + four wheels that **roll with speed and steer up front**). Not the full game — a validation camera on a real collider.
- **Camera coordinate HUD** *(implemented in MVP)* — a live XYZ (local ENU meters) + lat/lon readout in every mode (orbit / fly / drive), so any spot can be cited, screenshotted, and revisited exactly.
- Grid, ground plane, adjustable sun/time-of-day for lighting checks. Quality presets drive shadow resolution, and the **shadow frustum follows the view and scales with zoom** *(implemented in MVP)* so large cities stay sharp without one giant static shadow map.

### 10.2 Selection & transforms
- Click-select, box-select, multi-select, select-by-type (e.g. "all billboards").
- **Transform gizmos:** translate / rotate / scale, with **snapping** (grid, angle, and surface snapping so objects sit on the ground/road).
- **Drag-and-drop:** drag assets from the asset panel into the scene; drag objects to reposition; drag to re-parent in the hierarchy.
- Numeric transform entry in the inspector for precision.
- **Measurement readout** (distance/size) — useful when validating dimensions against real data.

### 10.3 Scene management
- **Hierarchy / outliner** grouped by type and by tile/district.
- **Inspector** (properties + the replacement panel from §9).
- **Undo / redo** across all edits and replacements; copy/paste/duplicate.
- **Locking & visibility** per object and per layer. **Roads are locked by default** so they can't be accidentally moved or deleted.
- Search/filter by name, type, provider, approval state.

### 10.4 Streaming & scale
- The city is loaded as **spatial tiles**; the editor streams only nearby tiles at full detail and shows distant tiles at low LOD. A whole city cannot live in a browser tab at once — the editor and the export format share the same tiling model (§14).

---

## 11. AI & cost strategy

The explicit requirement: **cheap enough to explore hundreds of buildings and many cities**, with paid quality available when wanted. LLM budget exists but should be spent carefully.

### 11.1 3D generation: self-host the default, pay for the premium

- **Default generator: self-hosted Trellis** (open source, MIT-licensed, runs on a single ~24 GB GPU, outputs glTF with PBR and built-in multi-LOD). Running it on **spot/preemptible GPU instances** makes the marginal cost per generation ≈ raw compute — cents, not dollars — and it can be **batched** (queue many buildings, process on one warm GPU). This is what makes wide exploration affordable.
- **Premium generators (opt-in): Meshy / Rodin / Tripo / Hunyuan3D** via paid credit APIs, used only for hero assets where topology/texture quality justifies the per-call cost. Selected per object through the gateway; usage is visible so spend is controlled.
- **Library (Sketchfab)** for reusable generic props avoids generating the same bench 500 times.

### 11.2 Caching is the biggest cost lever

- **Cache every generated result by `cache_key`.** Identical buildings (same footprint/height/reference/provider) generate **once** and are reused across the whole city and across cities.
- A **shared prop/asset library** grows over time — the more cities you build, the less you generate.
- Provider switching and city reloads hit cache, not the API.

### 11.3 Keep LLM usage cheap and structured

LLMs are for **orchestration and metadata**, not for anything per-vertex or per-frame:

- Style/era classification of neighborhoods (batched, cached).
- Building the region rule packs (one-off, human-reviewed).
- Optional natural-language editor commands ("select all billboards facing the highway") via an agent.
- Optional automated QA (a vision model screenshots the city and flags broken intersections / z-fighting).

Guidelines: prefer a **cheap/fast model tier** for routine calls, reserve a frontier model for genuinely hard reasoning, **cache aggressively**, and batch. A **model gateway** (mirroring Unity AI's approach of routing to third-party models rather than hardcoding one) lets us pick the cheapest model that's good enough per task and swap as prices change.

### 11.4 Rough cost posture

- Base scene generation (procedural, no AI mesh): compute-only, effectively free.
- Per-building AI generation on self-hosted Trellis (batched, spot GPU): cents each; a whole city's landmarks for a few dollars.
- Premium API generations: priced per call, used sparingly on hero assets.
- LLM orchestration: kept to structured, cached calls — a minor line item.

The design intent is that **exploring a new city should cost single-digit dollars**, with premium spend as a deliberate choice.

---

## 12. Architecture

```
                        ┌─────────────────────────────────────┐
                        │            WEB FRONTEND               │
                        │  3D editor (viewport, gizmos, panels) │
                        │  streaming tile loader • inspector    │
                        └───────────────┬───────────────────────┘
                                        │ REST / WebSocket
                        ┌───────────────┴───────────────────────┐
                        │              BACKEND API               │
                        │  scene/project service • auth • jobs   │
                        └───┬───────────┬────────────┬───────────┘
                            │           │            │
              ┌─────────────┘   ┌───────┘     ┌──────┴────────────┐
              │                 │             │                   │
   ┌──────────┴─────────┐ ┌─────┴───────┐ ┌───┴──────────┐ ┌──────┴────────┐
   │ INGESTION SERVICE  │ │ PROCEDURAL  │ │ GENERATION    │ │ OPTIMIZE/BAKE │
   │ adapters →         │ │ ENGINE      │ │ GATEWAY       │ │ LOD • KTX2 •  │
   │ City Graph         │ │ (Houdini/   │ │ Trellis(self) │ │ meshopt •     │
   │ (roads, buildings, │ │  PDG) roads,│ │ Meshy/Rodin   │ │ collision •   │
   │  signs, refs)      │ │ terrain,    │ │ Sketchfab     │ │ tiling        │
   │                    │ │ generic bld │ │ upload        │ │               │
   └─────────┬──────────┘ └──────┬──────┘ └──────┬────────┘ └──────┬────────┘
             │                   │               │                 │
             └───────────────────┴───────┬───────┴─────────────────┘
                                          │
                              ┌───────────┴────────────┐
                              │        STORAGE          │
                              │ City Graph DB (spatial) │
                              │ asset/mesh store (S3)   │
                              │ generation cache        │
                              │ tile store (3D Tiles)   │
                              └─────────────────────────┘
```

**Flow:** ingestion builds the City Graph → the procedural engine emits the base scene (roads/terrain/generic buildings) as tiled objects → the frontend streams tiles and lets the user edit → replacement requests hit the generation gateway (cheap self-hosted default, paid opt-in) → results are post-processed, cached, and swapped into slots → export runs the optimize/bake stage → the game consumes the packaged tiles + semantics.

**Notes:**
- The **procedural engine runs server-side** (Houdini + PDG is the recommended core for road/intersection/terrain solving and batch orchestration across cities). The frontend consumes its output; it does not run Houdini.
- The **generation gateway** abstracts providers so adding/removing a generator is config, not code.
- **Storage separates the City Graph (truth) from geometry (derived)** and from the generation cache (cost lever).

---

## 13. Tech stack (opinionated)

### Frontend / editor runtime
- **Recommended: React Three Fiber (Three.js) or Babylon.js.**
  - **Three.js / R3F** — largest ecosystem, mature `TransformControls` gizmos and helpers (drei), easy React UI integration for panels/inspector, zero-config WebGPU renderer with WebGL2 fallback. Best if you want maximum control and a custom editor UI. *Recommended default for an editor.*
  - **Babylon.js** — batteries-included (built-in GizmoManager, picking, physics, scene graph), strong WebGPU path. Best if you want more out of the box and less assembly.
  - **PlayCanvas** — smallest runtime and the most mature WebGPU path; excellent for the *game*, but its editor is a hosted product, so less natural for a *custom* editor app. Strong candidate for the **game runtime** even if the editor is R3F/Babylon.
- **WebGPU with WebGL2 fallback** — WebGPU is now supported across all major browsers; default to it via the engine's automatic fallback.
- **Physics (for drive preview + game):** Rapier (Rust/wasm) or Jolt (wasm).

### Backend
- **API/services:** your choice (Node/TypeScript or Python) — Python pairs naturally with the geo + Houdini side.
- **Procedural engine:** **Houdini + PDG/TOPs** for road/intersection/terrain/generic-building generation and batch orchestration across cities. (Blender Geometry Nodes is a cheaper alternative but weaker at topological road solving and batch scale.)
- **Geo processing:** GDAL, geopandas, DuckDB (reads Overture GeoParquet directly), PostGIS for the spatial City Graph store.
- **Generation:** self-hosted **Trellis** on GPU workers (spot instances) + paid provider APIs behind the gateway.
- **Optimize/bake:** Simplygon or meshoptimizer/gltfpack (mesh + LOD), basisu/toktx (KTX2/Basis textures).
- **Storage:** PostGIS (City Graph), S3-compatible object store (meshes, textures, cache, tiles).
- **Tiling/streaming:** **3D Tiles** (OGC standard) as the tile format for both editor streaming and game export; render with a 3D-Tiles-capable loader.

### Where Cesium fits (you asked)
- Use the **3D Tiles format/streaming pattern** (which Cesium popularized) for your **own baked tiles** — this is Cesium's real value here.
- Cesium's globe/geospatial framing is **overkill for the editor**: a single city fits comfortably in a **local ENU (east-north-up) meter frame**, which is simpler for gizmos, physics, and a game. Use a local frame for the play space.
- Cesium (or `3DTilesRendererJS` / `three-geospatial`) is worth keeping in mind only if you later want a **streamed distant backdrop** beyond the play area — and remember that streaming Google's photorealistic tiles carries attribution and no-caching terms, so a self-baked low-detail skyline is usually the cleaner choice.

---

## 14. Optimization & export

Optimization is **built into the pipeline**, not a manual cleanup pass. The city is generated *at* the target budget rather than decimated down to it.

- **Tiled from the start** — the scene is a spatial quadtree of streamable tiles (3D Tiles). Editor and game share this.
- **Automatic LODs per object** — buildings: full → simplified → textured box → merged block impostor; roads: reduced tessellation + markings baked into texture at distance; trees: mesh → billboard impostor. Trellis outputs multi-LOD natively; generic buildings and roads get LODs during bake.
- **Textures** — atlas aggressively (draw calls matter more than polycount on the web), bake far-LOD building blocks to single textured boxes, compress with **KTX2/Basis Universal** (GPU-native, transcodes per device).
- **Meshes** — quantize + compress with meshopt/Draco; export **glTF/GLB**.
- **Lighting** — bake offline (lightmaps / vertex AO); reserve dynamic lights for headlights and signals. No runtime GI in the browser.
- **Collision** — export a **separate lightweight collision mesh**, never the visual mesh.
- **Semantics ship to the game** — export the **lane graph, speed limits, and signal data** alongside the geometry, so the same data that built the city drives its **traffic AI and gameplay** at runtime.
- **Budget gate** — a per-tile budget (verts, draw calls, texture memory) is validated automatically at export; over-budget tiles are flagged or auto-simplified.

**Export deliverable (target):** a 3D Tiles quadtree of compressed GLB + KTX2 textures + a separate collision layer + the semantic lane/rules data + a license/provenance report.

**Export deliverable (MVP today, §14A):** a flat (un-tiled) **7-file set** — `city_scene.glb` (draw-call-optimized visual), `city_collision.glb` (pre-merged trimesh colliders), `city_surface.glb` (the drivable-only collider subset the game raycasts for wheel contact/grip), `citymap_minimap.glb` (roads-only top-down mesh), `city_semantics.json` (lane graph + traffic devices + per-object provenance, v3), `citymap_spawn.json` (auto drivable spawn), `textures_manifest.json` (KTX2 packaging spec). An alternate one-click export builds a single self-contained **`city_designer.glb`** (visual + textures + collider collection in one file) for hand-off to a 3D designer in Blender/Maya. A separate `npm run bake` step Draco-compresses the GLBs; KTX2 texture encode is still deferred to the bake service.

---

## 14A. Game-engine export hardening *(implemented in MVP)*

The car-game engine team consumed a real CityBuilder export and returned six concrete signals (`game-engine-output-review.md`); the response (`game-export-fix-plan.md`) is implemented and tested (`src/__tests__/exportOptimize.test.ts`). This section documents what the export actually does today. Everything stays content-only (clean PBR geometry + textures); gameplay identity lives in `city_semantics.json`, so the visual GLB can be flattened freely.

**1 — Draw-call optimizer (`src/export/optimizeScene.ts`).** The live editor mints a fresh material per building (per-tint + per-instance UV jitter) and per road segment — thousands of one-off materials/meshes (a real export hit ~2,217 materials). Right before export, a throwaway clone is optimized in two passes: **(a) material dedup** by visual signature (type · color · emissive · roughness · metalness · transparency · side · texture identity + repeat), dropping only the cosmetic per-instance UV *offset*, collapsing thousands → dozens; **(b) geometry batch-merge** — every geometry sharing a material merges into one mesh (glass/decals kept separate so transparency still sorts). Multi-material meshes are passed through with baked world transforms. Never drops geometry (falls back to unmerged on a merge failure). The export toast reports before→after counts.

**2 — Pre-merged collider GLB (`colliderGroupMerged` in `src/export/colliderGlb.ts`).** Instead of one node per collider (thousands the engine had to merge on the main thread → freeze risk), colliders are pre-merged into **a handful of trimesh nodes grouped by physics behaviour** (sensor-vs-solid · class · drivable · surface tag · friction · restitution). Box/cylinder primitives are baked to geometry and folded in; per-node `extras` (friction/sensor/drivable/class/surfaceTag) are preserved so the existing Rapier/Jolt loader still reads them — it just gets ~10 nodes, not ~5,000. `formatVersion` bumps **1 → 2** with a `merged: true` flag (coordinated breaking change).

**3 — Auto spawn + minimap (`src/export/spawn.ts`).** Derived from the road semantics we already export, so a new map needs zero code edits: **`citymap_spawn.json`** picks the widest drivable non-bridge road nearest the map centre with room to accelerate and emits `position [x,y,z]` + `heading_rad` down its centerline; **`citymap_minimap.glb`** is a tiny roads-only flat mesh, ribbons colored + merged by road class, for the top-down map.

**4 — No `KHR_materials_unlit` (`src/procgen/materials.ts`).** Lane markings and traffic-signal bulbs were `MeshBasicMaterial`, which `GLTFExporter` emits as `KHR_materials_unlit` — fullbright, ignoring the engine's day/night. Markings are now lit `MeshStandardMaterial`; signal bulbs are `MeshStandardMaterial` with `emissive` (still glow, now bloom-reactive). Result: **zero unlit materials** in the export, still clean PBR with no baked light.

**5 — Draco bake step (`tools/bake-glb.mjs`, `npm run bake`).** The browser's `GLTFExporter` can't emit Draco or KTX2 (native encoders). A Node post-export step using **`@gltf-transform`** runs `weld → dedup → prune → join` then Draco-compresses geometry (`join` is skipped on the collider so per-node physics extras survive); registers `ALL_EXTENSIONS` so `KHR_texture_transform`/unlit round-trip cleanly. Typical 4–8× smaller. **KTX2/Basis texture encode** (via `toktx` + `textures_manifest.json`) remains the downstream bake-service step.

**6 — Semantics v2→v3 + environment.** `city_semantics.json` bumped to `semanticsVersion: 2` — road centerlines became `[x, y, z]` with `y` = true elevation in meters (breaking vs v1) — and has since bumped to **v3** with the traffic core (§8.8): per-road speed limits plus signal / sign / turn-arrow device records. The toolchain is pinned to **Node ≥ 22.12** (`package.json` `engines` + `.nvmrc`) because Vite 8's dev server crashes on Node 20 serving large GLBs.

**Still deferred (bake service):** 3D-Tiles quadtree tiling/streaming, native KTX2/Basis encode, per-object auto-LOD chains, per-tile budget auto-simplification, and texture atlasing beyond material dedup. See §19.

---

## 14B. World API — headless generation service *(implemented in MVP)*

The same pipeline that powers the editor runs **without a browser**: `src/headless/generate.ts` mirrors `buildCity.ts` (with minimal DOM/canvas shims) and produces the full §14A export bundle in-process, including the Draco bake. Two consumption paths:

- **CLI:** `npm run generate` (`tools/generate-city.ts`) — bbox in, 7-file export out, written locally.
- **REST (Vercel):** `POST /api/v1/maps` requests a map for a bbox and returns a deterministic cache-keyed job id; `GET /api/v1/maps/:id` polls until ready. Artifacts and the manifest live in **Vercel Blob** — the manifest is written last, so job status is derived from which blobs exist (no separate job DB); stale jobs restart after 15 minutes. Built so the car game fetches cities on demand.
- **Deterministic contract & cache.** The job key folds in an output-contract version — currently **`w1.s3.c2.a2`** (world-api manifest v1 · semantics v3 · collider format v2 · visual asset revision a2) — so bumping any part invalidates cached maps when the output changes (a1: stone relief for cobble/pavers; a2: framed roads default-ON). Per-request options: `trees`, `signals`, `roadScale`, `corridorElevation`, `framedRoads`, `bake`.
- Endpoints are esbuild-pre-bundled into `api/` (`npm run build:api`, Draco wasm included) and sized to fit Vercel Hobby limits. KTX2 encode and 3D-Tiles tiling remain bake-service milestones (§19.2).

---

## 15. Non-goals

- **Not a full game engine.** CityBuilder builds and exports the city; the car game (traffic, physics tuning, gameplay) is a separate runtime that consumes the export.
- **Not a renderer.** Runtime rendering — lighting, shadows, motion blur, post-processing, reflections, sky — is the game engine's job. CityBuilder outputs clean unlit PBR content and textures only; its in-editor lighting and FX toggle are look-dev previews that never enter the export.
- **Not photogrammetry-based.** We don't build the drivable world from Google 3D Tiles or Gaussian splats — they lack semantics and clean collision, and carry usage restrictions. (Photogrammetry/splats are only ever a distant backdrop or a modeling reference.)
- **Not a black-box world generator.** Unlike Genie-style "prompt → playable stream" tools, everything here is separable, editable, and semantic — because a car game needs that.
- **Not AAA hero fidelity (yet).** Target is "looks good from the road" (a solid Level 2), not a hand-crafted GTA/Forza recreation.
- **Roads are not user-editable geometry** and not part of the generation menu.

---

## 16. Phased roadmap

### P0 — Prove the core loop (MVP) — ✅ *substantially implemented client-side*
- ✅ Ingest a well-mapped city — but via **OSM/Overpass live fetch + a Leaflet area picker** (Nominatim search + draggable rectangle, **≤12 km²**; large areas fetch as a few big Overpass tiles at low concurrency and merge), not the Overture GeoParquet adapter. Prefetched Lower Manhattan + Prague Staré Město samples ship in `public/data/`.
- ✅ Procedural roads (smoothed centerlines, curbs, sidewalks, intersections, bridges), generic buildings, terrain, water, props — all separated tagged objects, driven by the Context Resolver (§7A) — plus the road geometry system (§8.5: corridor elevation solve, junction consolidation, crown/superelevation, framed roads), road surface/weather fidelity (§8.6), roadside vegetation (§8.7), the traffic core (§8.8), terrain relief (§7G), and the landmark catalog (§7H).
- ✅ Web editor: viewport, selection, transform gizmos, hierarchy, inspector, undo/redo, locked roads, first-run help overlay.
- ✅ **Drive preview mode** — Rapier physics car (§10.1).
- ⚠️ Click-to-replace with keep-procedural + generate + Sketchfab-search + upload, fit-to-slot, cached — but **AI generation is *simulated*** (`runGeneration()` returns a deterministic procedural variant; the job queue / progress / cache / review UI is real and ready for a live endpoint). See §19.
- ✅ Reference photo (Wikidata P18) + map/Street-View link per building; Building Recognizer descriptors (§7F).
- ✅ Export: 7-file GLB/JSON set (+ single designer GLB) + Draco bake (§14A) — **flat, not 3D-Tiles-tiled**.
- ✅ **World API** (§14B): the same pipeline headless — `npm run generate` CLI + Vercel `/api/v1/maps` endpoints — so the car game fetches cities without the editor.
- **Success criterion status:** load a city, drive it, replace landmarks (procedural/library/upload; AI simulated), export, verified end-to-end headlessly (`.claude/skills/verify`; 238 tests across 27 files). Not yet met: *cheap real AI upgrade* and *tiled streaming*.

### P1 — Make it good and cheap at scale
- Add providers: **Meshy/Rodin (paid, opt-in)** and **Sketchfab library**; **upload custom**.
- Provenance + review workflow + license reporting.
- Auto-LOD, KTX2, budget gate in export.
- Signs / signals / billboards placed from data + imagery detection.
- Region rule packs (first 3–5 countries).
- Generation cache + shared prop library across cities.
- Batch generation on spot GPUs.

### P2 — Breadth & polish
- Many-city batch pipeline (PDG orchestration) with completeness reporting.
- AI facade generation for generic buildings; style classification.
- Vegetation from tree inventories + land-cover scatter.
- Optional natural-language editor commands + automated visual QA.
- Distant backdrop (self-baked skyline) option.

---

## 17. Risks & open questions

**Technical risks (biggest first):**
1. **Intersection geometry quality** — the hardest procedural problem; the top visual-failure risk for roads.
2. **Road data completeness variance** — lane/sign data is patchy; imagery detection and gap-filling must cover it, and poorly-mapped cities will be rougher.
3. **AI mesh quality for landmarks** — Trellis is great for notable buildings/props but hero landmarks may still need paid providers or manual modeling; the "fully automatic" promise has a fidelity ceiling.
4. **Web performance ceiling** — download size and browser memory constrain hard; tiling + aggressive LOD + KTX2 are survival requirements, not polish.
5. **Slot-fitting generated meshes** — auto-scaling/orienting arbitrary AI output to a known footprint without it looking wrong is fiddly; needs good normalization + easy manual gizmo fix-up.
6. **Editing at city scale in a browser** — streaming/LOD in the *editor* (not just the game) is required from day one.

**Open questions:**
- Is a licensed premium dataset ("Jio-style") actually available to the team, or is Overture+OSM the working baseline? (Changes base fidelity, not architecture.)
- Which engine for the editor — R3F (max control) vs Babylon (batteries included)? Recommend prototyping selection+gizmos in both quickly.
- Same engine for editor and game, or R3F/Babylon editor + PlayCanvas game? (PlayCanvas is the stronger *game* runtime.)
- Time-of-day: fixed baked lighting, or a small set of baked times? (Affects the lighting bake.)
- What's the licensing posture for shipping (ODbL share-alike on derived data; Sketchfab model licenses; reference-image usage)? Needs a legal read before wide distribution.

---

## 18. Appendix

### Prior art & references
- **Unity AI** (Unity 6.2+, replaced the deprecated Muse) — in-editor agent + generators on third-party models (incl. Gemini), 3D Object Generator makes mesh prefabs from text/image, model gateway, auto Mesh LOD, AI-asset tagging, undoable/non-destructive. **The UX bar to match** for in-context, provider-agnostic generation.
- **CityGen3D** — Unity asset that turns OSM into a separated 3D scene (roads, buildings, props). Prior art for the data-to-editable-scene idea, without the AI upgrade loop.
- **Cesium / 3D Tiles** — the tiling/streaming standard to adopt for our own baked tiles; the globe framing is unnecessary for a single-city play space.
- **Google Genie-style world tools** — the black-box "prompt → playable stream" approach; the anti-pattern for our controllable-semantic requirements.

### Glossary
- **City Graph** — normalized structured description of the city; the source of truth.
- **Slot** — an object's fixed position/footprint/dimensions/orientation from data; generated meshes fill slots.
- **Provider / generation gateway** — the pluggable source of an object's mesh (Trellis / Meshy / Sketchfab / upload) and the abstraction routing to it.
- **Provenance** — the recorded origin, license, and approval state of each object's current mesh.
- **LOD** — level of detail; multiple mesh resolutions per object for distance-based rendering.
- **KTX2 / Basis** — GPU-native compressed texture format for the web.
- **ENU frame** — local east-north-up meter coordinate system for the play space.
- **3D Tiles** — OGC standard for streaming large 3D scenes; our tile/export format.

---

## 19. Implementation status — PRD vs codebase *(authoritative gap map)*

This section is the single source of truth for **what is real in the codebase today versus what this PRD describes as the target**. The MVP is a **fully client-side app** (Vite + React 18 + React-Three-Fiber + three 0.169 + zustand + Rapier; no backend server). Everything the PRD frames as a server-side service (§12) is currently done in-browser or not yet built.

### 19.1 What is built and real (in the codebase)

- **Ingestion:** live **OSM/Overpass** fetch with a Leaflet **area picker** (Nominatim search, draggable **≤12 km²** rectangle — large areas split into a few big tiles fetched at low concurrency and merged; mirror fallback, localStorage cache) + prefetched Lower Manhattan and Prague samples. `src/ingest/`.
- **Procedural engine (in-browser TypeScript, not Houdini):** roads with smoothed Catmull-Rom centerlines, curbs, sidewalks, intersections, bridges/tunnels from OSM `layer`; generic building extrusion; water (lakes/rivers/coastline-assembled sea); terrain; props. `src/procgen/`.
- **Road geometry system** (§8.5): corridor elevation solve (default ON) + junction consolidation; crown/superelevation and framed-road cross-sections behind flags. `src/procgen/corridor/`, `crossSection.ts`, `framedRoads.ts`, `framedKit/`.
- **Road look & weather** (§8.6): hex-tiled / detail-normal / height-blend / wear-mask asphalt, worn paint, normal-mapped decals, live wet/puddle uniform, stone relief for cobble/pavers; N8AO + aerial-fog FX preview. `src/materials/`, `src/editor/Viewport.tsx`.
- **Terrain relief** (§7G, flag OFF by default) and **roadside vegetation** (§8.7, ON by default). `src/procgen/terrain/`, `src/procgen/vegetation.ts`.
- **Traffic core** (§8.8): speed limits, signals, region-keyed signs, stop lines, turn arrows → `city_semantics.json` v3. `src/procgen/signs.ts`, `signMath.ts`, `src/export/semantics.ts`.
- **Landmark catalog** (§7H): procedural suspension + stone-arch bridge superstructures; Prague showcase sample. `src/scene/landmarks.ts`, `src/procgen/bridges.ts`.
- **World API** (§14B): headless pipeline (CLI + Vercel `/api/v1/maps`), deterministic contract-keyed cache (`w1.s3.c2.a2`). `src/headless/`, `src/server/`, `api/`.
- **Context Resolver + content matrix** (§7A), **material/texture system** (§7B), **robustness linters** (§7C) — all real, versioned, tested.
- **Asset library pipeline** (§7D/§7E): manifest scanner, weighted deterministic pools, Quaternius MegaKit, Sketchfab **curation/fetch tools + in-editor search-replace** (via Vite dev proxy). *Library assets default OFF* (§7F).
- **Building Recognizer** (§7F): structured-prior descriptor fallback chain, Wikidata P149/P18 prepass, descriptor-driven procedural facades/roofs.
- **Editor:** viewport, selection, transform gizmos, hierarchy, inspector, undo/redo, locked roads, help overlay, FX-preview toggle (N8AO + fog + bloom/grade), CS-style noclip fly mode, camera coordinate HUD (XYZ + lat/lon in all modes), in-app Curation Studio, and the rebuild-toggle set (library assets · corridor elevation · terrain relief · framed roads · greenery · crown · weather wet/dry · road style realistic/arcade · road scale). `src/editor/`, `src/ui/`.
- **Drive preview:** Rapier physics car, arcade-locked (§10.1).
- **Physics colliders:** descriptor pipeline + collider lint + GLB export with per-node `extras`. `src/physics/`.
- **Export:** the 7-file set (+ single designer GLB) + draw-call optimizer + pre-merged colliders + auto spawn/minimap + Draco bake (§14A).
- **Tests:** 238 cases across 27 files gating the invariants above (`npm test`).

### 19.2 Documented in the PRD but NOT in the codebase (the gap)

| PRD section | Documented as | Reality in codebase |
|---|---|---|
| §9, §11, §16-P0 | **Self-hosted Trellis / Meshy / Rodin / Tripo / Hunyuan** AI generation from a reference image | **Simulated.** `runGeneration()` (`src/gateway/providers.ts`) fakes a GPU job with progress ticks and returns a deterministic "enhanced" procedural variant. The job queue, progress, cache-by-slot-hash, and approve/reject review UI are real and endpoint-ready. **No real 3D-generation provider is wired.** |
| §7F | **VLM** photo→descriptor recognition | Off. `describeWithVlm` exists but `VLM.available` is false until `VITE_VLM_ENDPOINT` is set; the deterministic `describeFromPriors` path runs instead. |
| §12 | **Backend API / job service / auth**, server-side procedural engine | None. App is 100% client-side; the only server is the Vite dev proxy (Sketchfab token injection). A static production build has **no backend**, so Sketchfab degrades gracefully. |
| §12, §13 | **Houdini + PDG** procedural core; **PostGIS / S3 / generation-cache server / tile store** | Not present. Procedural generation is browser TypeScript; caching is in-memory/localStorage; no databases or object store. |
| §6.2 | **Overture Maps adapter** (GeoParquet via DuckDB), **premium "Jio" adapter**, terrain DEM (Copernicus/LiDAR), Mapillary imagery detection | Not implemented. Only OSM/Overpass is wired. Terrain/climate/species/land-cover use **heuristics or single live API probes** (Nominatim, GBIF), not the raster pipelines described. |
| §10.4, §14 | **3D-Tiles quadtree tiling + streaming** in editor and export | Not implemented. The whole city loads at once; export is a **flat GLB set**, not tiled. This is the biggest scale gap. |
| §7B, §14, §14A | **KTX2/Basis texture encode**, per-object **auto-LOD chains**, far-LOD impostors, per-tile **budget auto-simplification**, aggressive texture **atlasing** | Partially. `textures_manifest.json` *specifies* KTX2 and the bake step does **Draco geometry only**; KTX2 encode, LOD generation, and atlasing are deferred to a not-yet-built **bake service**. Material dedup (§14A) is the only atlasing-adjacent step. |
| §8.3, §7C, §7F | **OpenDRIVE** (osm2opendrive/libOpenDRIVE) roads, server-side **trimesh boolean carving** of roads/water into terrain, **LoD2 / GlobalBuildingAtlas** massing, WorldCover raster, CLIP labeling, real Köppen raster | All documented as **bake-service milestones**; in-editor equivalents (the layer convention, OSM-extrusion massing, keyword lexicon) stand in today. |
| §11.4 | **Cost posture** (cents per building on spot GPUs) | Moot until real generation is wired — currently $0 because nothing calls a paid/GPU API. |

### 19.3 The one thing to wire next

Per the owner's standing note ("let me know if you need API keys"): the highest-leverage gap is **real 3D generation**. The entire async job pipeline, caching, provenance, and review UI already exist around the simulated worker — replacing `runGeneration()` with a live self-hosted **Trellis** GPU endpoint (or a **Meshy** API key) is the single change that turns the "upgrade a landmark cheaply" promise real. Everything else in §19.2 is scale/fidelity hardening that the current client-side MVP proves out but does not yet ship.

---

## 20. Repository & file structure *(codebase map)*

This section maps the actual repository so a new contributor can locate any subsystem from §7–§14 in the tree. Every source file gets a one-line description of what it holds. It reflects the code as it exists today (the client-side MVP + headless/World-API path); binary asset packs are summarized at the folder level rather than listed file-by-file.

**Status labels.** Every file listed below **exists in the repo** — this is a map of real code, not a wishlist. The labels distinguish *how complete the feature behind the file is*, cross-referenced to the §19 gap map:

- **✅ real** — implemented and tested; the default. Unlabeled entries are ✅.
- **⚠️ seam** — real, endpoint-ready code that currently runs a **simulated or stubbed** path; the plan is to wire a live backend into it (no rewrite needed). See §19.2.
- **📋 plan** — described in the PRD (§6–§14) but **has no file yet**; listed here only where a reserved slot/field points at it, so you know it's deliberately absent.

Purely aspirational architecture (Houdini/PDG engine, PostGIS/S3, 3D-Tiles tiling, KTX2 encode, Overture/premium adapters) has **no entry below** — it lives in §12–§14 and the §19.2 gap table, not the tree.

### 20.1 Top level

```
citybuilder/
├── index.html                  Vite entry HTML; mounts the React app at #root
├── package.json                Deps + scripts (dev/build/test/bake/generate); Node ≥22.12 engine pin
├── package-lock.json           Locked dependency tree
├── tsconfig.json               TypeScript compiler config
├── vite.config.ts              Vite config + the dev-only Sketchfab proxy (/api/sketchfab/*) and /assetlib/** static middleware
├── vercel.json                 Vercel deploy config for the World API (api/v1/maps)
├── .nvmrc                      Node version pin (22.12) — Vite 8 crashes serving large GLBs on Node 20
├── .env / .env.example / .env.local   Secrets + seams: SKETCHFAB_API_TOKEN, VITE_VLM_ENDPOINT, provider keys (never bundled client-side)
├── .gitignore
├── README.md                   Project overview, setup, and run instructions
├── citybuilder-prd.md          This document — the product requirements + gap map
├── src/                        The app (see §20.2)
├── tools/                      Node/CLI build & curation scripts (see §20.3)
├── api/                        Generated Vercel serverless functions (see §20.4)
├── assets/                     Consumed asset library + generated manifests (see §20.5)
├── asset-library/              Raw downloaded asset packs, pre-curation (see §20.5)
├── docs/                       Design docs & RCAs (see §20.6)
├── public/                     Static assets served as-is (see §20.6)
├── dist/                       Vite production build output (generated)
└── .claude/skills/verify/      Headless end-to-end verify skill (build → launch → drive → screenshot)
```

### 20.2 `src/` — the application

**App shell & entry**
- `main.tsx` — React DOM bootstrap; renders `<App>` into `#root`.
- `App.tsx` — top-level layout wiring viewport + toolbar + hierarchy + inspector panels together.
- `types.ts` — the **City Graph** schema (Layer 1): roads, buildings, points, water, the `SceneObject` model — the source-of-truth data types.
- `styles.css` — global editor styles.
- `vite-env.d.ts` — Vite env typings + the recognizer/gateway env seams (all optional).

**`app/` — build orchestration**
- `buildCity.ts` — the build conductor: fetch/reuse OSM → City Graph → 3D scene; owns the pristine-graph + rebuild-toggle composition and the shared lint gate.

**`ingest/` — data layer (§6)**
- `overpassFetch.ts` — live Overpass fetch for a bbox with mirror fallback + localStorage cache.
- `overpass.ts` — OSM→City Graph adapter (the contract other adapters like Overture/premium would implement).

**`resolver/` — Context Resolver & content matrix (§7A)**
- `types.ts` — resolver types: regions, climate zones, weighted variants, resolution records.
- `matrix.ts` — the declarative, versioned **content matrix**: ordered region packs + rules; first match wins.
- `resolve.ts` — deterministic seeding (`hash01`, `pickWeighted`) — same city in, same city out.
- `adapters.ts` — external context adapters (region/Nominatim, climate/Köppen heuristic, species/GBIF, land-cover) each with graceful fallback.
- `assetPools.ts` — bridges `assets/manifest.json` into the resolver as weighted, deterministically-picked pools.
- `lints.ts` — aggregated post-build/export lint gate (flicker, water, road consistency).
- `varietyLint.ts` — monotony linter (dominant variants, identical neighbors).
- `waterAudit.ts` — water over-classification regression gate (buildings are land).

**`recognizer/` — Building Recognizer (§7F)**
- `types.ts` — descriptor/appearance-plan/arch-style types.
- `priors.ts` — Stage 1: gather structured priors (OSM tags + region + massing) — pure, synchronous.
- `prepass.ts` — async prepass fetching Wikidata style (P149) + reference photo (P18) for landmarks, cached.
- `descriptor.ts` — Stage 2: priors(+photo)→descriptor. `describeFromPriors` (deterministic default) is **✅ real**; `describeWithVlm` is a **⚠️ seam** — off until `VITE_VLM_ENDPOINT` is set (§19.2).
- `recognizer.ts` — the orchestrator: runs the fallback chain, emits one `AppearancePlan` per building, caches it.

**`procgen/` — procedural engine (§7B, §7C, §8)**
- `roads.ts` — the deterministic procedural road system (surfaces, markings, wear, bridges/tunnels); locked in the editor.
- `roadNetwork.ts` — shared road-network + bridge-elevation math (true-meter profiles) used by renderer, colliders, semantics.
- `roadScale.ts` — the "stretch roads" transform: widen carriageways + displace non-road features, deterministically.
- `crossSection.ts` — crown/camber + superelevation vertical profile shared by surface mesh, marking sampler, and colliders (flag, §8.5).
- `framedRoads.ts` — framed-road flag + per-class cross-section presets (curb-frame / grass verge / footpath; §8.5).
- `framedKit/kit.ts` — band-based cross-section engine: ordered surface bands partition the width with exact shared seams (zero coplanar overlap), material-agnostic output.
- `framedKit/catalog.ts` — the framed-kit band catalog (the design reference the experiment tools render).
- `vegetation.ts` — roadside vegetation engine: pure seeded planner + lazy instanced-mesh builder (§8.7).
- `geometry.ts` — polyline/ribbon helpers (XZ-plane, Y-up).
- `buildings.ts` — footprint→slot building extrusion (position/footprint/height stay stable across providers).
- `bridges.ts` — procedural suspension/cable-stayed superstructures (towers, catenary cables, girder) for landmark bridges.
- `areas.ts` — land-cover polygons + terrain/water surface; water carves real holes so it never z-fights ground.
- `props.ts` — street furniture & vegetation, seeded by object id, zoning-aware density.
- `propLibrary.ts` — common-prop library mapped from OSM tags; procedural CC0 stand-ins, prefers real packs in `/public/props/`.
- `signs.ts` — faithful region-keyed traffic signs (procedural pole + canvas plate face).
- `signMath.ts` — pure traffic-device math (orientation, speed units, effective limit) shared by renderer + semantics.
- `materials.ts` — shared procedural facade textures (grayscale so per-building tint works).
- `decalPlan.ts` — wear-decal placement with a global non-overlap guarantee (rejection-sampled, deterministic).
- `sanity.ts` — pre-geometry City Graph sanity validation + auto-remediation (impossible placements removed/clamped).
- `corridor/graph.ts` — Stage 0: builds the road topology graph from the City Graph.
- `corridor/elevation.ts` — Stage 2: the network elevation solve (Gauss-Seidel node relaxation + grade-limited edges).
- `corridor/index.ts` — the single consumer seam: renderer/colliders/semantics read the road y-channel through here.
- `corridor/config.ts` — corridor-elevation feature flag + design constants (default-ON, reversible).
- `corridor/cluster.ts` — junction consolidation (osm2streets-style cluster→contract) killing the "pancake pile" artifact.
- `terrain/field.ts` — the deterministic, hydrology-aware terrain height field; one field every consumer samples.
- `terrain/mesh.ts` — the single terrain geometry shared by visual ground + physics collider.
- `terrain/config.ts` — terrain relief feature flag + constants.

**`materials/` — material & texture system (§7B)**
- `library.ts` — PBR metallic-roughness material library (unlit-authored) + world-position anti-tiling shader tricks.
- `textures.ts` — procedural PBR texture generation (albedo/height→normal/metallic-roughness), clean + unlit, seeded.
- `packaging.ts` — texel-density + per-LOD budget policy and the KTX2 packaging manifest spec. The manifest is ✅ real; the **KTX2/Basis encode it specifies is 📋 plan** (deferred to the bake service, §14A/§19.2).

**`scene/` — scene assembly & registries**
- `registry.ts` — maps object id → three.js mesh variants (objects live outside React state).
- `libraryTemplates.ts` — pre-loads library GLBs into per-kind templates the synchronous prop builders instance/clone.
- `landmarks.ts` — landmark catalog: named/wikidata OSM features → recognizable procedural or glTF treatments.
- `geometryLint.ts` — render-visibility lint (stale bounds / zero-length normals that cause frustum-cull or black faces).

**`editor/` — the 3D editor (§10)**
- `Viewport.tsx` — the R3F canvas, look-dev FX-preview composer, and the drive-mode code-split boundary + QA camera bridge.
- `SceneContent.tsx` — renders scene objects + transform gizmos; handles picking/selection.
- `CameraRig.tsx` — orbit + fly camera (CS-style noclip: pointer lock, smooth accel, scroll speed); publishes the orbit target for drive spawn.
- `CoordTracker.tsx` — publishes the live camera position (ENU XYZ + lat/lon) to the HUD store in every mode.
- `actions.ts` — editor actions (e.g. frame camera on objects).
- `bus.ts` — tiny event bus for one-shot camera-framing requests.
- `input.ts` — global key state shared by fly mode + drive sim.
- `depthConfig.ts` — single source of truth for depth-buffer config + the vertical **layer convention** (flickerLint reads the same constants).
- `driving/Car.tsx` — the arcade physics car (Rapier raycast-wheel vehicle controller, pitch/roll locked).
- `driving/DriveSim.tsx` — lazy-mounted drive-preview physics world (carries the ~2 MB Rapier wasm chunk).

**`physics/` — colliders & drive physics (§8.2, §10.1)**
- `types.ts` — the shared collider contract (produced from semantic data, never from visual mesh).
- `colliders.ts` — collider generation from City Graph + resolutions (surfaces mirror visual layer heights).
- `buildColliders.ts` — descriptors → imperative static Rapier colliders (water → sensors).
- `registryColliders.ts` — live-scene collider assembly from registry+store, with a spawn-radius cook cap for big cities.
- `colliderLint.ts` — export-gate collider lint (lane intrusions, junction steps), pure/testable.
- `materials.ts` — per-surface/class friction & restitution hints (carried in GLB extras).

**`gateway/` — generation & library providers (§9, §11)**
- `providers.ts` — **⚠️ seam**: the pluggable generation gateway; `runGeneration()` is a **simulated** GPU worker (returns a deterministic procedural variant). The queue/progress/cache/review UI around it is ✅ real and endpoint-ready — swapping in Trellis/Meshy is config, not code (§19.3).
- `sketchfab.ts` — **⚠️ seam**: in-app Sketchfab search + drop-into-slot. Fully working in dev via the Vite proxy; a static production build has no proxy, so it degrades gracefully until a serverless proxy exists (§7E).

**`export/` — export & bake (§14, §14A)**
- `bundle.ts` — environment-agnostic artifact builder (in-memory buffers); one code path for browser + headless.
- `exporter.ts` — browser export sink: turns buffers into file downloads.
- `optimizeScene.ts` — the draw-call optimizer (material dedup + geometry batch-merge) run on a throwaway clone.
- `colliderGlb.ts` — collider set → GLB group with machine-readable `extras` per node.
- `semantics.ts` — `city_semantics.json` (v3): 3-component road centerlines in true meters + per-object provenance.
- `spawn.ts` — auto spawn point + roads-only minimap derived from road semantics (zero per-map code).

**`headless/` — no-browser pipeline (CLI + API)**
- `generate.ts` — headless bbox/OSM → export bundle; mirrors `buildCity.ts` without UI.
- `bake.ts` — in-process Draco bake for headless exports (in-memory buffers). ✅ real for **Draco geometry only**; KTX2 texture encode is the 📋 plan bake-service step.
- `shims.ts` — minimal DOM/canvas shims so procgen texture code runs in Node (import first).
- `draco3dgltf.d.ts` — type shim for the Draco encoder module.

**`server/` — World API logic (§ world-api)**
- `world.ts` — shared plumbing: job state + artifacts in Vercel Blob; status derived from which blobs exist.
- `mapsPost.ts` — `POST /api/v1/maps`: request a map for a bbox, returns a deterministic cache-key job id.
- `mapsGet.ts` — `GET /api/v1/maps/:id`: poll a job; ready responses embed the CDN-cached manifest.
- `runJob.ts` — the generation worker: run headless pipeline → upload artifacts → write manifest last.

**`state/` — app state (zustand)**
- `store.ts` — the main editor store (selection, filters, toggles, context info).
- `driveHud.ts` — drive-preview HUD state (speed etc.).
- `cameraHud.ts` — camera-position HUD state (XYZ + lat/lon).
- `curation.ts` — persisted in-app asset-library curation state read live by the build path.

**`ui/` — panels & overlays (§10)**
- `Toolbar.tsx` — top toolbar (build, export, drive, and the toggle set: FX preview · library assets · corridor elevation · terrain relief · framed roads · greenery · crown · weather · road style · road scale).
- `Hierarchy.tsx` — outliner grouped by type/tile; double-click to frame.
- `Inspector.tsx` — property inspector + live procedural facade/roof/tint re-skinner.
- `ReplacePanel.tsx` — the object replacement panel (§9): keep/generate/Sketchfab-search/upload + recognizer block.
- `AreaPicker.tsx` — full-screen Leaflet location picker (search + draggable ≤12 km² rectangle; large areas fetch as tiled Overpass queries).
- `CurationStudio.tsx` — visual studio to hand-pick library model variants per kind.
- `LoadingScreen.tsx` — watchable build loader (animated skyline + real-phase checklist + timer).
- `HelpOverlay.tsx` — first-run help/controls overlay.
- `StatusBar.tsx` — bottom status/info bar.
- `CoordHud.tsx` — always-on camera coordinate readout (XYZ + lat/lon, every mode).

**`__tests__/` — 238 cases across 27 files (`npm test`)**
- Correctness gates including: `flickerInvariants` / `coplanarOverdraw` / `geometryLint` (z-fighting + visibility), `roadElevation` / `corridorElevation` / `junctionConsolidation` / `roadGrounding` / `roadScale` / `crossSection` (roads), `terrainField` / `terrainCarve` / `terrainIntegration` (terrain), `roadsideVegetation` (vegetation), `waterClassification` (water), `colliders` / `colliderAudit` (physics), `recognizer` (appearance), `assetManifest` (library pools), `signMath` / `signPlacement` (signs), `trafficIngest` / `trafficSemantics` (semantics), `exportOptimize` (export), `landmarkBridge`, `sanity`, plus `pragueBuild` / `headlessExport` integration tests.

### 20.3 `tools/` — Node/CLI scripts

- `generate-city.ts` — headless city export CLI (same pipeline as the World API, writing locally). `npm run generate`.
- `bake-glb.mjs` — Draco-compress + clean up exported GLBs (weld→dedup→prune→join). `npm run bake`. ✅ real for Draco; KTX2 encode is 📋 plan (§14A).
- `build-api.mjs` — esbuild-bundle each `src/server` endpoint into self-contained `api/` functions. `npm run build:api`.
- `build-asset-manifest.mjs` — scan the asset library → `assets/manifest.json` + `assets/coverage-report.md`.
- `sketchfab-lib.mjs` — shared Sketchfab Data API v3 client (token from env, retry/backoff).
- `sketchfab-curate.mjs` — search Sketchfab per coverage gap → labeled, license-audited `assets/sketchfab-catalog.json`.
- `sketchfab-fetch.mjs` — download vetted catalog models into the library so they become pooled assets.
- `curate-kenney-roads.mjs` — catalog the Kenney City-Kit road tiles as **reference-only** (roads stay procedural/locked).
- `curate-toxsam.mjs` — curate the ToxSam/Polygonal Mind CC0 pack into the library format.
- `osm2streets-spike.mjs` — feasibility spike proving lane-accurate geometry from our OSM via osm2streets-js (WASM).
- `experiment-roads.ts` / `experiment-roads-check.mjs` / `experiment-roads-preview.mjs` — the framed-road GLB experiment kit (`npm run experiment:roads`): build → invariant check → preview render.
- `framed-kit.ts` — renders the whole framed-kit catalog to standalone GLBs + a preview contact sheet (`npm run framed-kit`).
- `framed-network.ts` — Lego-connected framed-road network experiment: proves the shared-pad-radius connection rule (segment ↔ junction seams register with no gap).

### 20.4 `api/` — generated Vercel functions

- `v1/maps/index.mjs` — **generated** bundle of `mapsPost` (POST) — edit `src/server/*`, not this.
- `v1/maps/[id].mjs` — **generated** bundle of `mapsGet` (GET) — edit `src/server/*`, not this.

### 20.5 Asset directories

- `assets/manifest.json` — the scanned, classified library manifest (weighted pools) the resolver consumes.
- `assets/coverage-report.md` — pipeline-consumed OSM tags vs. library supply + acquisition priorities.
- `assets/sketchfab-catalog.json` — labeled, license-audited Sketchfab candidate index (no meshes bundled).
- `assets/curation-selection.json` — exported curation picks.
- `assets/library/<pack>/` — consumed packs in the fixed layout (`gltf/`, `fbx/unity|unreal/`, `textures/`, `previews/`, `LICENSE.txt`); served at `/assetlib/**`.
- `asset-library/` — raw downloaded packs pre-curation (Quaternius Downtown City MegaKit, Kenney city-kit-roads, ToxSam/Polygonal Mind) + `build-manifest.mjs` + `README.md`.

### 20.6 Docs & static

- `docs/Road-updates.md` — traffic/road semantics & sign spec.
- `docs/road-corridor-redesign.md` — the corridor elevation + junction consolidation design.
- `docs/modular-road-asset-system.md` — modular road asset design notes.
- `docs/water-and-flicker-rca.md` — root-cause analysis behind the depth/layer-convention invariants.
- `docs/osm2streets-spike.md` (+ `osm2streets-preview.png`) — the lane-level geometry spike writeup.
- `docs/world-api.md` — the headless World API design.
- `docs/aaa-improvements-plan.md` — road/ground fidelity improvement plan.
- `docs/road-visual-techniques-research.md` — deep-research report: the Top-25 road visual-quality techniques driving §8.6.
- `docs/roadside-vegetation-engine.md` — roadside vegetation engine design + CC0 vegetation-asset research.
- `docs/asset-library-evaluation.md` — external asset-pack/repo evaluation (ToxSam CC0, 3DStreet, CARLA, PLATEAU, OSM2World).
- `docs/asset-viewer-plan.md` — asset viewer/catalog plan.
- `docs/screenshots/` — reference/QA screenshots.
- `public/data/raw_osm.json` — prefetched Lower Manhattan sample city.
- `public/data/prague_osm.json` — prefetched Prague Staré Město sample (landmark/bridge showcase).