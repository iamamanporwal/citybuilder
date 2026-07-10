# CityBuilder — Product Requirements Document

**Status:** Draft v0.1
**Owner:** (you)
**Last updated:** July 2026

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

Four content-correctness guarantees, each enforced by generation rules **and** an automatic linter. All output stays geometry + textures; rendering remains the engine's job.

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
- Water renders as a **tagged flat water surface at sea level** with a water material, placed on its own layer below roads and slightly overlapping shore seams; terrain carving is a bake-service boolean (layer convention prevents coplanarity in-editor).

**4 — Common props.**
- A **prop library mapped by OSM tag through the Context Resolver**: fountains (`amenity=fountain`), statues/memorials (`historic=memorial|monument`, `tourism=artwork`), bus stops (`highway=bus_stop`), benches, bins, lamps, playgrounds, and fences/walls (`barrier=*`) — all with **seeded per-instance variety** (variant choice, proportions, rotation).
- Ships with procedural CC0-style stand-ins; real **CC0 packs (Kenney / Quaternius / Poly Pizza)** drop into `/public/props/` and take precedence per kind. Surface materials follow the §7B library (ambientCG/Poly Haven swap-ins at bake), packaged per the KTX2 manifest.
- **Wikidata-linked props route to AI generation**: statues/fountains carrying a `wikidata` tag register a generation slot in the gateway — the same replace/approve/cache flow buildings use.

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

**Bulk auto-placement (planned).** Pooled library/Sketchfab assets are selectable deterministically today via `pickAssetFor(osmTag, featureId)` (the resolver decision layer) and placeable on demand through the Replace flow. Automatic build-time placement of pooled props (loading GLB instances for every street-lamp / tree / signal during `buildScene`) is the next step — it needs async GLB instancing and canonical per-role sizing, and will land behind a toggle so the deterministic procedural scene stays the default.

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
- Orbit camera for overview; **WASD/fly camera** for mid-level navigation.
- **Drive preview mode** — one key drops the camera to ~1.5 m eye level with simple car-like movement, so the user validates the city *from the road* (directly serves the #1 requirement). Not the full game — a validation camera.
- Grid, ground plane, adjustable sun/time-of-day for lighting checks.

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

**Export deliverable:** a 3D Tiles quadtree of compressed GLB + KTX2 textures + a separate collision layer + the semantic lane/rules data + a license/provenance report.

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

### P0 — Prove the core loop (MVP)
- Ingest one well-mapped city (via Overture + OSM adapters).
- Procedural roads to driving-grade + generic building placeholders + terrain, as separated tagged objects.
- Web editor: viewport, selection, transform gizmos, hierarchy, undo/redo, locked roads.
- **Drive preview mode.**
- Click-to-replace with **two providers**: keep-procedural + **self-hosted Trellis from reference image**, fit-to-slot, cached.
- Reference photo + map link per building.
- Basic export: glTF tiles + collision.
- **Success criterion:** load a city, drive it, upgrade 10 landmarks cheaply, export, and drive the export in a minimal web player.

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