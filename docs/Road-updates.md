# Road Pipeline — CityBuilder Driving-Training Arena

**Status:** Plan v0.1 — companion to the CityBuilder PRD (§8 Roads, §7A–§7C, §14/§14A)
**Scope:** How we build **drivable, AAA-grade, procedurally-generated roads** for a **car-driving training simulator**, using only open data and open-source libraries. No paid generative-AI is used anywhere in the road path.

> **Read this first.** The map is a *learning environment*, not a flythrough. That single fact sets our fidelity policy (§1). Roads stay procedural-from-data and locked (PRD §8.1); the click-to-author/AI-generation flow never touches them.

---

## 1. Fidelity policy — the rule that drives every decision

Because a learner forms driving habits from what they see, we split the world into two tiers with **different accuracy bars**:

| Tier | Elements | Bar | Source of truth |
|---|---|---|---|
| **FAITHFUL** (must match the real city) | Road geometry & topology, lane count & direction, lane markings, road signs, traffic signals, speed limits, right-of-way / turn rules, crossings, stop lines | Correct or clearly flagged. **Never silently invented.** | OSM + Overture + Mapillary detections |
| **BELIEVABLE** (approximate is fine) | Terrain relief (hills/valleys), embankments, scenery, buildings, vegetation, ambient props, surface wear | "Looks real from the driver's seat." Deliberately smoothed/stylized. | DEM (smoothed), context resolver, texture libs |

**Consequence:** where faithful data is missing (e.g. a road with no speed-limit tag), we fall back to a **region default AND flag it low-confidence** in the ingestion/coverage report, so a human verifies before that city is used for training. This is already the shape of your Context Resolver's confidence + fallback chain (PRD §7A) — we just make traffic elements a first-class, audited category.

---

## 2. Open data sources

### 2.1 Faithful tier (traffic + road network)
- **OpenStreetMap (via Overpass)** — topology backbone. Carries `lanes`, `lanes:forward/backward`, `turn:lanes`, `oneway`, `maxspeed`, `surface`, `width`, `sidewalk`, `cycleway`, `crossing`, `highway=traffic_signals`, `traffic_sign=*`, and `layer` for bridge/tunnel stacking. License: **ODbL** (share-alike on derived data — see §11).
- **Overture Maps — Transportation** — the cleaned, QA'd, monthly version of the same network. Segments (centerlines + physical props: surface, width) + connectors (topology), with **linear referencing** (a speed limit can apply to the first 500 m of a segment), **speed limits, access restrictions, turn restrictions**, and stable **GERS** IDs for re-syncing. Latest release `2026-01-21.0`, schema `1.15.0`. Distributed as **GeoParquet** (DuckDB bbox query). Prefer this over raw Overpass as the default road source.
- **Mapillary** — the "read attributes off imagery" layer, **already computed for you**. CC BY-SA 4.0, 2B+ street-level images across 190+ countries. Its CV pipeline exposes, via API as vector geometries: **traffic signs** (~1,500 classes, 100 countries, with **type + location + facing direction**), **road markings** (lane lines, crosswalks), and **street furniture** (poles, lights, benches). This is how we fill the gaps OSM leaves in signs/markings.

### 2.2 Believable tier (terrain + surfaces)
- **Copernicus GLO-30** — free global **30 m DSM** (TanDEM-X), Cloud-Optimized GeoTIFFs on the AWS Open Data registry; bbox fetch via OpenTopography API. Note it's a *surface* model (includes buildings/trees), so we treat it as a **low-frequency landscape trend** and smooth hard (§4).
- **USGS 3DEP** — **1–10 m LiDAR** bare-earth DEM for the US (The National Map). Use where available; far better than GLO-30 for terrain relief. Global fallbacks: SRTM, ASTER GDEM, AW3D30, NASADEM.
- **OpenCRG** *(optional, ceiling)* — free/open format for high-precision **road-surface micro-relief + friction** along a reference line; integrates with OpenDRIVE. Gives a subtle tarmac detail + realistic per-surface friction for the vehicle physics (a nice "trainer feel" upgrade, not required for MVP).
- **ESA WorldCover (10 m)** / OSM landuse — context for which surface/vegetation to place.

### 2.3 Texture & model libraries (CC0)
- **ambientCG** — 2,000+ seamless PBR materials, **CC0 public domain** (no attribution, commercial OK), full map sets (albedo + metallic-roughness + normal/height). Has asphalt/concrete/road.
- **Poly Haven** — hundreds of **CC0** PBR texture sets (dedicated `asphalt` / `road` / `concrete` categories), plus HDRIs and models. No login.
- **cc0-textures.com** — additional CC0 PBR materials.
- **Kenney / Quaternius / Poly Pizza** — CC0 model packs (props, some street furniture). **Sketchfab** for permissive (CC0/CC-BY/CC-BY-SA) props — already wired in PRD §7E.
- **Traffic-sign artwork:** US **MUTCD** sign designs are **public domain**; Wikimedia Commons hosts national sign sets for many regions (verify per-file license). Used to build the region-keyed sign-face atlas (§8.1).

---

## 3. Open-source libraries / toolchain

| Job | Library | Notes |
|---|---|---|
| **Lane geometry + intersection solving (browser)** | **osm2streets** (Rust + JS/wasm + Python) | Trims road centerlines back from junctions, generates clean **intersection polygons**, handles dual carriageways / dog-legs, emits **lane-marking geometry** to GeoJSON. Runs in-browser. *The intersection solver.* |
| **HD road model (bake)** | **OpenDRIVE** (`.xodr`) via **SUMO `netconvert`** (wrappers: `osm-to-xodr`, `bhmt/osm2odr`) or **CARLA `Osm2Odr`** | netconvert imports lane widths, sidewalks, bike lanes, crossings, roundabouts, ramps, **traffic lights**, turn lanes. Clothoid-smooth reference lines + per-lane cross-sections + junctions + road marks come free. |
| **Mesh from OpenDRIVE** | **libOpenDRIVE** (C++, also via GDAL XODR driver) / **esmini** (MPL-2.0) | libOpenDRIVE parses `.xodr` and generates 3D lane/roadmark meshes + a routing graph. esmini auto-generates a basic road model from `.xodr`. |
| **Ambient traffic + signal phasing** *(bonus for a trainer)* | **SUMO** (TraCI / libsumo) | The netconvert network *is* a microsimulation network — drive AI vehicles and traffic-light phases through it. Huge for a driving trainer (see §9). |
| **Optimize / compress** | **gltf-transform**, **meshoptimizer / gltfpack** | Draco geometry, KTX2/Basis textures, LOD chains. You already use gltf-transform in the bake step. |
| **Server procedural (optional)** | **Houdini + PDG** (industry benchmark) or **Blender Geometry Nodes** (open) | Only if/when the bake service needs heavier road/terrain solving. |
| **Index of the rest** | **awesome-openx** | OpenRoadEd, ODDLOT, LaneMaker, Unreal OpenDRIVE plugin, Blender Driving Scenario Creator. |

**Benchmark / prior art:** *RoadRunner* (MathWorks, commercial) is the industry-standard HD-road authoring tool and exports OpenDRIVE — essentially the proprietary thing we're building an open, data-driven, city-scale equivalent of. *Police Simulator: Patrol Officers* (Houdini + UE4) ships this exact architecture: a road generator producing all ground meshes (roads, sidewalks, curbs) **plus** a directed traffic node-graph carrying speed limits and signal markup, with meshes refined by decals + vertex colors for wear.

---

## 4. Terrain deformation — "believable, not accurate"

**Goal:** deform the flat ground plane so hills rise and low areas sink, enough to make the roads read as real — *not* a survey-accurate DTM.

**Method:**
1. Fetch the DEM tile(s) for the city bbox (GLO-30 COG via OpenTopography; USGS 3DEP where in the US).
2. Resample to the tile grid and **smooth aggressively** — a Gaussian / Laplacian pass, or downsample-then-upsample — so buildings/trees in the DSM don't spike and so the surface is gentle enough to drive across. Optionally **exaggerate or soften** the vertical scale for readability (this is a knob, not a fact).
3. Build the terrain as a heightfield mesh in the **local ENU meter frame** (small coordinates, consistent with your existing frame), tagged and locked like the road network.
4. Apply the ground material via the Context Resolver (grass/soil/rock/urban) using WorldCover/OSM landuse.

**Key principle: terrain provides the *low-frequency landscape*; roads carry their *own* smooth profile; the terrain conforms to the roads, never the reverse (§5).** This is what prevents the two classic failures: roads that float above the ground, and roads that bump/dive because they were draped on noisy elevation.

**Caveat to document in the coverage report:** GLO-30 at 30 m is coarse and is a DSM. It's fine for gentle regional relief; it will not capture small dips or berms. That's acceptable under the believable tier.

---

## 5. Roads level on terrain — corridor grading (cut & fill)

This is **the single most important step for making roads look real on deformed terrain.** A road must be smooth and drivable regardless of the terrain under it.

**Per road (extends your existing centerline evaluator `evaluate(s) → {pos, dir, elevation}`):**
1. **Longitudinal profile:** compute a **grade-limited, smoothed elevation** along the centerline (target max grade per road class, e.g. ≤ 6–8%), sampling the terrain only as a loose guide. The road's `elevation(s)` comes from this profile, *not* from raw DEM sampling. Straights stay flat; hills become gentle ramps.
2. **Cross-section:** sweep the per-class section (lanes + curb + sidewalk) along the centerline with correct **crossfall / superelevation** (a slight lateral tilt so it sheds water and reads real).
3. **Cut & fill the terrain to meet the road ("corridor"):** for every terrain vertex inside the road corridor (carriageway + shoulder), **snap it to the road surface**; then ramp back to natural ground over a short **embankment/verge slope** on each side. Result: where terrain was above the road → it's cut down to meet it; where below → it's filled up. No floating, no submerged roads, no bumps.
   - **In-editor (now):** a synchronous "flatten-corridor" pass over terrain vertices in the corridor band, plus your documented vertical **layer convention** (PRD §7C) so nothing z-fights.
   - **In the bake service (later):** the trimesh boolean carve of roads/water into terrain you already planned (PRD §7C), or OpenDRIVE + terrain-conform.
4. **Junctions:** the intersection surface (from osm2streets polygons) is flattened as one graded patch so all approaching roads meet at a consistent level.

**Lint (extend your flicker/consistency linters):** assert no road vertex is more than a small tolerance from its corridor terrain, no grade exceeds the class max, and no coplanar road/terrain faces exist.

---

## 6. Bridges, tunnels & grade separation

Bridges are **roads with an elevation profile** (PRD §7C) — the same evaluator, just lifted.

- **Level deck:** the span itself is kept flat/planar (or a single gentle grade); **approach ramps are grade-limited** (≤ ~6%) so the car eases up and down. Never let the deck inherit terrain noise.
- **Clearance:** raise per OSM `layer` (a fixed clearance per layer step, e.g. ≥ 4.5 m over a crossed road) so grade separation is correct and drivable.
- **Structure:** parameterized **deck fascia + continuous rails + piers**, welded into one mesh (vertex-dedup, 1 mm tol).
- **Terrain under the span:** carve/hide terrain beneath the deck so the ground never pokes through; ramp terrain up to meet the abutments at each end.
- **Tunnels:** portal + bore; keep terrain over the top; light as a tunnel in-engine (not baked).
- **Consistency lint (you have this):** flag width jumps > 60% between connected same-class segments, endpoint seams (0.15–0.8 m), bridges too short to reach their layer height at ≤ 10% grade, and bridges with < 4.5 m clearance.

---

## 7. Textures & materials

All output stays **unlit PBR metallic-roughness** — the engine lights it at runtime (PRD non-goals). We author clean surfaces + decals only.

**Road-surface set (from ambientCG / Poly Haven, CC0):**
- Asphalt: new / worn / patched; concrete slab; cobblestone; pavers; gravel.
- Sidewalk concrete; curb stone.
- Full PBR maps: albedo + metallic-roughness (glTF G/B packing) + normal/height where relief matters (cobble, pavers).

**Application rules (extends PRD §7B):**
- **World-space UV mapping** so texel density is constant regardless of segment length — critical so a long straight and a short link look identical up close.
- **Seeded per-segment UV offset** so adjacent segments don't visibly tile.
- **Markings and crosswalks are DECAL GEOMETRY, not baked into the albedo** — this keeps them crisp *and* lets them be region-correct and data-driven (essential for a trainer: the paint must be right, not a generic texture). Driven by the region pack + Mapillary marking detections.
- **Wear decals** (cracks, oil, patches, manholes) as seeded alpha quads placed by wear-density rules — believable tier, cosmetic only.
- **Packaging:** per your `textures_manifest.json` — **KTX2/Basis** (ETC1S albedo, UASTC normals), color space + mip chain declared, per-LOD budgets. Encode in the bake service.

**Attribution:** ambientCG / Poly Haven / cc0-textures are CC0 → no attribution required. (Sketchfab CC-BY models still require the NOTICE.md attribution you already generate.)

---

## 8. Traffic infrastructure — the faithful core

This is where a driving trainer lives or dies. Everything here is placed **from data, oriented to face traffic, and shipped in the semantic export** so the trainer's logic reads the same data that built the scene.

### 8.1 Road signs
- **Placement + type:** OSM `traffic_sign` / `maxspeed` + **Mapillary sign detections** (type, location, **facing direction**). Mapillary's ~1,500 classes give you the actual sign present.
- **Geometry:** procedural **pole + plate** (cheap, many instances) — do *not* rely on generated meshes.
- **Sign face:** a **region-keyed sign-face texture atlas** mapped to the detected sign class. US = public-domain MUTCD artwork; other regions from Wikimedia sign sets (verify license). This gives faithful, correct sign faces — the thing a learner must read.
- Region pack sets shape/color conventions.

### 8.2 Traffic signals
- **Placement:** OSM `highway=traffic_signals` nodes; CARLA `Osm2Odr` / netconvert can generate signal objects at junctions.
- **Geometry:** procedural signal head (housing + emissive bulbs — `MeshStandardMaterial` with `emissive`, never unlit, per PRD §14A).
- **Phasing/timing:** for a trainer, use **SUMO's traffic-light logic (tls)** from the netconvert network (§9) rather than inventing timings.

### 8.3 Road markings
- **Geometry:** from lane data — **osm2streets emits lane-marking geometry**; supplement with Mapillary marking detections where lanes are unmarked in data.
- **Correctness:** region-correct center-line color/pattern (yellow vs white), crosswalk style, **stop lines**, lane arrows (`turn:lanes`). These are decals (§7), so they stay sharp and swappable per region.

### 8.4 Speed limits & rules
- **Speed limits:** OSM `maxspeed` / Overture `speed_limits` → attached to the lane graph → **shown on signs AND available to the trainer** for feedback ("you exceeded 50").
- **Right-of-way / turns:** OSM `turn:lanes` + Overture **turn restrictions** → into the semantic lane graph.
- **Crossings:** OSM `crossing=*` (signalized / zebra / unmarked) → placed + tagged.

### 8.5 Semantic export (single source the trainer consumes)
Everything above ships in `city_semantics.json` (and, in the bake path, the **`.xodr` itself** as a standards-based lane graph). The trainer reads speed limits, signal phases, lane connectivity, and right-of-way from the same artifact that generated the geometry — so what the learner sees and what the sim enforces can never disagree.

**Audit gate:** low-confidence or defaulted traffic elements (missing speed limit, ambiguous signal) are flagged in the coverage report. A city isn't "training-ready" until its faithful-tier elements pass review.

---

## 9. Ambient traffic & live signals (bonus, high value for a trainer)

Because the OpenDRIVE path already runs OSM through **SUMO `netconvert`**, you get a full **traffic microsimulation network for free**. Via **TraCI / libsumo** you can drive:
- ambient AI vehicles obeying lanes, right-of-way, and signals,
- real **traffic-light phase timing**,

giving learners live traffic to merge into, yield to, and stop for. This turns a static city into an interactive driving scenario with no extra data. Slot it in once the OpenDRIVE/SUMO bake path lands.

---

## 10. The pipeline (staged, two paths)

```
OSM (Overpass) ── Overture (segments/connectors) ── Mapillary (signs/markings) ── DEM (GLO-30 / 3DEP)
        │                     │                              │                          │
        ▼                     ▼                              ▼                          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │                              CITY GRAPH (truth)                                        │
   │  road topology · lanes · signals · signs · markings · speed · turns · elevation grid   │
   └───────────────┬───────────────────────────────────────────────────┬───────────────────┘
                   │                                                     │
        PATH A (NOW, in-browser)                          PATH B (LATER, bake service)
                   │                                                     │
   ┌───────────────▼───────────────┐               ┌─────────────────────▼─────────────────────┐
   │ osm2streets-js                 │               │ SUMO netconvert / CARLA Osm2Odr → .xodr     │
   │  → lane geometry               │               │ libOpenDRIVE / esmini → lane+roadmark mesh  │
   │  → intersection polygons       │               │ (clothoid ref lines, superelevation, junc.) │
   │  → lane-marking geometry       │               │ + SUMO network for ambient traffic (§9)     │
   └───────────────┬───────────────┘               └─────────────────────┬─────────────────────┘
                   │                                                     │
                   ▼                                                     ▼
   ┌───────────────────────────── SHARED ─────────────────────────────────────────┐
   │ cross-section sweep + crossfall · corridor cut/fill onto terrain (§5) ·         │
   │ bridges/tunnels (§6) · PBR materials + marking/wear decals (§7) ·               │
   │ signs/signals from data (§8) · collision mesh · LODs                            │
   └───────────────────────────────┬───────────────────────────────────────────────┘
                                    ▼
         Export: visual GLB · collision GLB · semantics (JSON / .xodr) · minimap · manifest
```

**Recommendation:** ship **Path A now** (osm2streets retires your #1 risk — intersection quality — with a mature browser library and needs no backend), then adopt **Path B in the bake service** as the HD upgrade + standards-based semantic export + ambient traffic. This is exactly your PRD §8.3/§19 "in-editor evaluator now, OpenDRIVE bake-service later" plan, now with specific tools attached.

---

## 11. Legal / licensing (verify before wide distribution)

- **OSM / Overture:** ODbL — share-alike implications for a *derived database*. Track per your existing licensing gate (PRD §6.3); report at export.
- **Mapillary:** imagery CC BY-SA 4.0 — attribution + share-alike; **verify terms for the derived detections** you consume, and record attribution.
- **Copernicus GLO-30:** free, but requires the DLR/Airbus attribution notice when distributing/adapting.
- **Textures (ambientCG / Poly Haven / cc0-textures):** CC0 — no attribution, commercial OK.
- **Signs:** MUTCD (US) public domain; other regions verify per-file.
- Keep all of this in the per-object provenance you already stamp, so the export's license report is complete.

---

## 12. Integration checklist

**Phase A — osm2streets in the browser (biggest quality win, no backend)**
- [ ] Add `osm2streets-js` (wasm) to the client build; feed it the OSM XML you already fetch via Overpass.
- [ ] Set driving side from the region pack before import.
- [ ] Consume its **intersection polygons** as your junction surfaces (replace hand-rolled corner solving).
- [ ] Consume its **lane geometry** to drive the cross-section sweep; consume its **lane-marking GeoJSON** for marking decals.
- [ ] Run corridor cut/fill (§5) so the new geometry sits level on the deformed terrain.
- [ ] Re-run the flicker/consistency linters; add the corridor + grade asserts.

**Phase B — terrain + surfaces + signs (faithful-tier completeness)**
- [ ] Wire GLO-30 (COG via OpenTopography) → smoothed heightfield; 3DEP where US.
- [ ] Build the road-surface material set from ambientCG/Poly Haven; world-space UV + seeded offset.
- [ ] Place signs (procedural plate + region sign-face atlas), signals, and markings from OSM + Mapillary; orient to traffic.
- [ ] Attach speed limits / turn rules to the lane graph; ship in `city_semantics.json`.
- [ ] Add the "training-ready" audit gate to the coverage report.

**Phase C — bake service (HD + interactive)**
- [ ] OSM/Overture → OpenDRIVE (SUMO netconvert / CARLA Osm2Odr); mesh via libOpenDRIVE/esmini.
- [ ] Ship `.xodr` as the semantic lane graph.
- [ ] Terrain boolean carve; KTX2 encode; LOD chains; per-tile budget gate.
- [ ] SUMO/TraCI ambient traffic + live signal phasing (§9).
- [ ] (Optional) OpenCRG micro-relief + friction for tarmac feel + physics.

---

## 13. Open decisions
- DEM vertical scale / smoothing strength (readability vs. subtlety) — a tuning knob.
- How faithful must signal *timing* be for training vs. just phase order?
- Which regions ship first (drives which sign-face sets + region packs to build)?
- Editor engine confirmed (R3F today) vs. game runtime (PlayCanvas candidate) — affects the OpenDRIVE consumer on the game side.

---

## 14. Sources / further reading
- osm2streets — https://github.com/a-b-street/osm2streets
- OpenDRIVE conversion (SUMO netconvert wrapper) — https://github.com/das-rise/osm-to-xodr ; CARLA Osm2Odr — https://carla.readthedocs.io/en/latest/tuto_G_openstreetmap/
- libOpenDRIVE — https://github.com/rnshah9/libopendrive ; GDAL XODR driver — https://gdal.org/en/stable/drivers/vector/xodr.html
- esmini — https://github.com/esmini/esmini ; OpenX tool index — https://github.com/benediktschwab/awesome-openx
- Overture Transportation — https://docs.overturemaps.org/guides/transportation/
- OSM lanes — https://wiki.openstreetmap.org/wiki/Key:lanes
- Mapillary API (signs/markings) — https://www.mapillary.com/developer/api-documentation
- Copernicus GLO-30 — https://registry.opendata.aws/copernicus-dem/ ; USGS 3DEP via https://portal.opentopography.org
- OpenCRG — https://github.com/asam-ev/OpenCRG
- Textures — https://ambientcg.com ; https://polyhaven.com/textures ; https://cc0-textures.com
- SUMO — https://eclipse.dev/sumo/