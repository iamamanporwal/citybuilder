# CityBuilder Blender Plugin — Full Technical Plan (v3)

**Product statement.** The Blender plugin *is* the CityBuilder product, rebuilt on a real
3D kernel. The web app proved the pipeline (OSM → game city) but hits browser ceilings:
no real booleans/bevels, canvas-only textures, no hand-editing, fragile large scenes.
The plugin must reach **full feature parity with the web app**, then exceed it where
Blender is stronger (photo PBR, real modelling ops, Cycles showcase renders, artist
touch-up), and feed the car game through the existing export contracts.

**North star for every decision:** the city must look *showcase-good* — first from the
driver camera (roads are the core product), second in aerial beauty shots.

Current state: **v0.5 shipped** (commit 30b2e2a) — framed roads, junction pads,
elevation solve + flat/hills/DEM terrain, buildings v2, landmark bridges, props,
29 procedural materials, unity_city.json + GLB export, headless test matrix, installed
in Blender 5.1.2. This plan defines everything from here to v1.0.

Reference docs: [SPEC.md](SPEC.md) (module contracts) · [specs/](specs/) (algorithms
extracted verbatim from the app source) · [README.md](README.md) (usage).

---

## 1. Feature parity matrix (web app → plugin)

Every subsystem the web app has, its plugin status, and where it lands. "App source"
names the file(s) whose semantics we port 1:1.

| # | Web-app subsystem | App source | Plugin v0.5 status | Target |
|---|---|---|---|---|
| 1 | Overpass ingest, water whitelist, multipolygons | `src/ingest/overpass.ts` | ✅ ported (split ways/relations fetch) | — |
| 2 | Coastline assembly (sea = complement of land) | `overpass.ts` coastline §, docs | ❌ missing (SF Bay renders as land) | v0.7 |
| 3 | Tiled fetch + 12 km² cap (large areas) | `overpassFetch.ts` | ❌ radius ≤ 1.5 km, single request | v0.8 |
| 4 | Framed roads (curb/lawn/footpath, a2) | `framedRoads.ts`, `roads.ts` | ✅ ported + crown/superelevation | — |
| 5 | Lane markings, crosswalks, stop lines | `roads.ts` | ✅ geometry strips | v0.6: wear pass |
| 6 | Polygonal junctions ("Lego rule") | `roads.ts` §5 | ⚠️ convex hull + corner arcs | v0.6: osm2streets port |
| 7 | Parallel-way handling (dual carriageways, cycle tracks) | (app: coplanar overdraw) | ❌ overlapping surfaces | v0.6: merge pre-pass |
| 8 | Corridor elevation solve + §15 junction clustering | `procgen/corridor/` | ✅ ported (two-pass Gauss-Seidel) | — |
| 9 | Terrain field (fbm/riverbed/valley) + road conform | `procgen/terrain/` | ✅ ported + real DEM | — |
| 10 | Road-kit textures (asphalt/paver albedo+normals) | `materials/library.ts` | ⚠️ procedural nodes only | **v0.6: photo PBR (NOW)** |
| 11 | Building Recognizer (facade/roof/tint fusion) | `src/recognizer/` | ⚠️ tag-only kind heuristic | v0.7 |
| 12 | Roofs (shapes, cornices) | `buildings.ts` | ⚠️ gabled/hip approx | v0.7: bpypolyskel |
| 13 | Landmark catalog (wikidata → template) | `scene/landmarks.ts` | ✅ bridges only | v0.7: towers/domes |
| 14 | Placement engine (lamps/signs/benches, clearance) | `props.ts`, `signMath.ts` | ✅ lamps/signals/signs | v0.7: benches/bins/zones |
| 15 | Roadside vegetation (grass tufts, shrubs, verges) | `vegetation.ts` | ❌ missing | v0.6 |
| 16 | Trees (instanced, land-cover gated) | `props.ts` | ✅ basic instancing | v0.6: variety + forests fill |
| 17 | Over-water buildings → piers | `areas.ts`, `registry.ts` | ✅ ported | — |
| 18 | Plazas (raised paver slabs) | `roads.ts` PLAZA_CURB_H | ✅ prisms +0.14 | — |
| 19 | Road width scaling ("stretch roads" ×k) | `roadScale.ts` | ❌ missing | v0.8 |
| 20 | Traffic semantics (speed, signs, devices, audit) | `export/semantics.ts` | ⚠️ roads only, devices=[] | v0.8 |
| 21 | Collider GLB (formatVersion 2, extras contract) | `export/colliderGlb.ts` | ❌ missing | v0.8 |
| 22 | Minimap GLB, spawn v1, semantics v3 JSON | `export/bundle.ts` | ⚠️ spawn ✅, others missing | v0.8 |
| 23 | Asset library (Sketchfab/CC0 curated GLBs) | `asset-library/` | ❌ missing | v0.9: KayKit props |
| 24 | Screenshot-audit QA loop | `__cb` bridge + Playwright | ⚠️ render matrix exists | v0.6: pixel asserts |

---

## 2. Architecture (unchanged core, three additions)

The v0.5 architecture holds: **pure-Python generator modules emit `MeshData`** (python3-
testable, inline self-tests), only `build/matlib/textures/export_game/__init__` touch
`bpy`. All numeric semantics come from `specs/*.md`. Additions:

```
citybuilder_osm/
  texcache.py        NEW (pure): ambientCG download → disk cache → {key: PBR map paths}
  matlib.py          UPGRADE: photo-PBR node builders w/ procedural fallback per key
  vegetation.py      NEW (pure): verge tuft/shrub planner (app vegetation.ts port)
  roadmerge.py       NEW (pure): osm2streets pre-pass — parallel-way merge, short-link
                     collapse, then trim-back junction polygons
  recognizer.py      NEW (pure): building look fusion (tags → zone → hash fallback chain)
  colliders.py       NEW (bpy): collision GLB with extras contract v2
```

**Texture policy (the showcase requirement):** photographic CC0 PBR from ambientCG
(verified live 2026-07-23), fetched on first build into the extension user directory
(`bpy.utils.extension_path_user`), cached forever, loaded as image materials. If the
download fails or the user disables it → v0.5 procedural nodes (nothing breaks offline).
CC0 = redistributable in the game with zero obligations.

---

## 3. Subsystem deep-dives

### 3.1 Photo-PBR texture pipeline (v0.6 — building now)

- **Source**: `https://ambientcg.com/get?file={AssetID}_{Res}-JPG.zip`; 2K default
  (≈4–8 MB/asset), 1K on Low quality. Zip members: `*_Color.jpg`, `*_NormalGL.jpg`,
  `*_Roughness.jpg`, `*_AmbientOcclusion.jpg` (some), `*_Displacement.jpg` (unused).
- **Curated set** (API-verified asset IDs → material keys):
  | key | asset | physical size |
  |---|---|---|
  | asphalt / asphalt_old | `Asphalt031` (old = −18% value multiply) | 4.0 m |
  | sidewalk | `PavingStones151` (concrete slabs) | 2.4 m |
  | paver (plazas, cobble streets) | `PavingStones138` | 2.0 m |
  | curb + concrete + stone | `Concrete034` | 3.0 m |
  | building_wall (plaster) | `PaintedPlaster017` | 3.2 m (1 storey) |
  | building_wall_brick | `Bricks104` | 2.8 m |
  | roof_tile | `RoofingTiles013A` | 2.0 m |
  | grass / terrain base | `Grass004` | 3.0 m |
  | terrain rock (slope splat) | `Rock058` | 4.0 m |
  | gravel (rail ballast) | `Gravel023` | 2.0 m |
- **Node graph per textured key**: UV → Mapping(scale 1/size_m) → Color(sRGB)
  ×AO(0.75 mix)×tint-variation → Base Color; Roughness(Non-Color) → Roughness;
  NormalGL(Non-Color) → Normal Map(strength 1.0; 0.6 for facades). UVs are already
  metres everywhere (v0.5 invariant), so mapping scale = 1/physical-size — no per-mesh
  work. Water/markings/metal/glass/lamp stay procedural (they read better).
- **Facades**: photo plaster/brick base + the existing procedural window grid mixed ON
  TOP (windows cut into the photo wall, lit-window emission kept). Brick vs plaster
  chosen per building by `tint` attr threshold (~35% brick) until the recognizer lands.
- **Terrain**: grass photo base, rock photo mixed by the existing per-face `rock` attr
  + high-frequency noise breakup at the blend edge.
- **Wear layer (same milestone)**: multiply onto asphalt — wheel-path bands ±0.9 m from
  lane centres (+10% value), centre oil band (−18%), noise-masked; worn-white markings
  sRGB(150,148,140) rough 0.75 (EN-1436 anchored, never pure white).
- Attribution UI footer: "Textures: ambientCG (CC0)".

### 3.2 Road network v2 (v0.6) — the osm2streets port (Apache-2.0)

Replaces the convex-hull pads and fixes parallel ways. Exact steps (from
`geometry/general_case.rs` + docs, licence-verified):
1. **Pre-pass** (`roadmerge.py`): (a) collapse degree-2 nodes joining same-class ways;
   (b) two-pass short-link merge: run trim once, delete internal links < 15 m between
   junction clusters, re-solve merged node at averaged centre; (c) **parallel-way merge**:
   detect sidepaths/dual carriageways (parallel within 1.2×(w₁+w₂)/2 for > 60% of length,
   same bearing ±15°) → absorb cycleway/footway into the host road's cross-section as
   extra bands; dual carriageways keep two ways but clamp widths so edges meet at the
   median (no overlap, one shared median band).
2. **Thicken** each incident centerline ±width/2 (miter, bevel past 2× miter limit).
3. **Corners**: for each cyclically-adjacent road pair around the node, intersect right
   edge of k with left edge of k+1 on the halves nearest the node → wedge corner point.
4. **Trim**: per road, perpendicular line through each corner ∩ centerline; trim by the
   **max** distance (guarantees no overlap).
5. **Pad ring**: walk roads clockwise appending [right-end, corner, left-end]; dedupe
   < 0.1 m; ear-clip. Roads meet the pad at right angles → stop lines/crosswalks perfect.
6. Degenerates: 1 road → semicircular cap; 2 roads → connecting quad; roundabouts
   (`junction=roundabout`) → island + circulating band (kit numbers: island R6, ring +7).
7. Lane graph for markings/wear: lane i centre = offset of trimmed centerline at
   (i+0.5)·lane_width − half.

### 3.3 Roadside vegetation (v0.6) — port `vegetation.ts` verbatim

Zone rules (spacing m / shrub-every-N / band m): park 1.1/5/5.0 · residential 1.6/7/3.6
· none 1.4/6/4.5 · retail 2.8/0/2.4 · commercial 2.9/0/2.4 · industrial 2.2/9/3.0.
Offset = half + 1.4 + hash·band, both sides, land-cover gated (grass/bare only), reject
inside carriageway (margin 0.3), dry-tuft drop at hash > 0.55. Budgets: 26 000 grass,
6 000 shrubs. Blender realisation: 3 grass-clump template meshes (crossed quads,
alpha-tested card texture generated procedurally) + shrub icospheres, **instanced via
`collection_instance` or geometry-nodes scatter on a per-road curve** — one object per
road side, not 26 000 objects. Forest/park fill: poisson-ish hash scatter of tree
instances inside forest rings (1 per ~90 m², cap 3 000).

### 3.4 Buildings v3 (v0.7)

- **bpypolyskel vendored** (GPL-3, pin ≥ 2026-03-13 commit): true straight-skeleton
  hipped/complex roofs; `polygonize(verts, firstVertIndex, numVerts, holesInfo, height,
  tan, faces)`; wrap in try/except (spike-loop raise) → fall back to current approx.
- **Recognizer port** (`src/recognizer` chain): explicit tags → landuse zone → era/
  region heuristics → deterministic hash. Output per building: `{facade: plaster|brick|
  glass|panel, roof: tile|flat|metal, tint}`. Drives material slot + window style.
  Glass-tower path: curtain-wall material (photo glass + mullion grid) for h ≥ 40 m
  commercial.
- `building:part` assembly (min_height stacking — parser already keeps min_height).
- Cornices/parapets kept; add balconies (inset boxes on residential ≥ 4 storeys, hash-
  gated) and ground-floor storefront band (darker glass, 4.2 m) on commercial streets.

### 3.5 Landmarks & assets (v0.7 → v0.9)

- Keep parametric suspension/arch bridges. Add: church towers/spires (building kind
  church → pyramidal spire + cross), domes (`roof:shape=dome` → UV-sphere cap), water
  towers, chimneys (industrial). Catalog stays wikidata/name/structure keyed.
- v0.9: KayKit City Builder Bits (CC0, bundleable GLBs) replace parametric lamps/
  signals/benches where higher fidelity is wanted; `bpy.data.libraries.load` from a
  bundled `.blend` (research: never Python-generate node groups / heavy assets).

### 3.6 Water & coastline (v0.7)

Port the app's coastline assembly: `natural=coastline` ways stitched into runs; land is
LEFT of way direction; close each open run along the scene-rect boundary on its land
side; union → sea = rect minus land. Sea surface at −1.2 with the same shore/riverbed
compositing. Fixes SF Bay/oceanfront cities. Also: `water=river` relation holes
(islands) already work — add flow-aligned ripple anisotropy later (nice-to-have).

### 3.7 Export bridge completion (v0.8)

Match `bundle.ts` artifact-for-artifact: `city_collision.glb` (merged colliders,
`formatVersion:2`, node extras `{collider:{kind,halfExtents,…}, semantics:{class,
featureId,roadClass,drivable,bridge,sensor,static,merged}, physicsMaterial:{friction,
restitution,surfaceTag}}`, groupKey merge rule, 12-seg cylinders) · `city_surface.glb`
(drivable subset) · `citymap_minimap.glb` (flat y=0 class-colored ribbons, `mm_<hex>`
meshes) · `city_semantics.json` (semanticsVersion 3, traffic_audit, cross_section,
elevation blocks) · devices array filled from placed props (signals/signs with
heading_rad). Then Draco compression toggle and KTX2 bake (Cycles bake → basisu) last.

### 3.8 Scale & UX (v0.8)

- **Tiled Overpass fetch** (port `overpassFetch.ts`): ~1 km² tiles, dedupe by element
  id, per-tile mirror failover, 12 km² cap; relations fetched once at full bbox.
- **Modal build operator**: fetch on a worker thread, `wm.event_timer` pump, progress
  bar + cancel; UI never freezes.
- Disk cache of Overpass JSON per (bbox, contract-hash) → instant rebuilds, offline demos.
- Road width scaling ×k (port `roadScale.ts` displacement field) as a UI slider.
- Perf: keep one merged mesh per material family; target ≤ 60 s for r=800 m Med.

### 3.9 QA (continuous)

- Module self-tests (`python3 module.py`) — 12/12 green stays mandatory.
- Headless matrix: quick/prague/london/goldengate + **texture smoke** (all textured
  materials load, image count ≥ N) + **pixel asserts** on renders (mean-brightness bands
  per region: sky/road/facade — catches the "navy stripe" class of bug automatically).
- Golden Overpass fixtures (recorded JSON) for offline deterministic regression, same
  philosophy as the app's water invariants.

---

## 4. What is already built (v0.5 inventory — verified, shipped, installed)

Every item below is committed (`30b2e2a`), self-tested, and exercised by the headless
matrix on Blender 5.1.2. This is the foundation the roadmap builds on — none of it is
speculative.

**Modules (12 green, `python3 module.py` self-tests + Blender-side tests):**

| Module | What works today | How it was verified |
|---|---|---|
| `geom.py` | MeshData kit, hole-aware tessellation (ear-clip fallback), miter offsets, spatial grid, ring clipping (Sutherland–Hodgman), prisms w/ courtyard holes | unit self-tests (area-exact tessellation, clip areas) |
| `overpass.py` | Graph v2 ingest: water whitelist, building holes via multipolygons, roof/lanes/maxspeed/oneway/layer/structure tags, rails, prop nodes; split ways/relations fetch, 3-mirror failover | self-tests + live Prague/London fetches |
| `elevation.py` | Terrain field (flat/hills/**real DEM** via AWS terrarium + stdlib PNG decoder), two-pass Gauss-Seidel corridor solve, grade caps/class, §15 junction clustering, cosine bridge ramps, terrain-following path fallback | 5 self-tests + live DEM check (96.6 m relief at Golden Gate, centre-normalised, deterministic) |
| `roadnet.py` | Junction detection/clustering, arm trimming (arc-length interpolated cuts), densify, pass-through joint rule, SegDesc/JunctionDesc contracts | 5 self-tests (+, T, chain, stub, cluster) |
| `profile.py` | Framed sweep (curb .16 / lawn .04 / footpath .16 / foundation −.35), crown 2% + superelevation + 6 m fades, class markings (dash 3/9, double-yellow, edge lines), bridge decks + parapets + piers, along-metres UVs | self-tests (band z-levels exact, dash counts, curved no-NaN) |
| `junctions.py` | Pad hull + fillet, corner curb/footpath arc bands, zebra crosswalks, stop lines | self-tests (4-arm, T) |
| `terrain.py` | Conformed ground grid (roads burn in, 14 m cubic shoulders), rock-slope attr, `make_conform_sampler` reused by areas/props | self-tests + 62 k-quad perf check (0.7 s) |
| `roofs.py` | Walls w/ courtyards, gabled/hipped-approx/pyramidal/flat+parapet/cornice, facade UV metres, per-building tint attr | self-tests (ridge z exact, courtyard face counts) |
| `props_gen.py` | Lamp/signal/signs/bus stop/bench/tree/shrub templates; curbside push (half+0.7), lamp spacing/jitter/dedupe, carriageway clearance via grid | self-tests (counts, alternation, clearance) |
| `landmarks_gen.py` | Catalog (wikidata/name/structure) → suspension (towers 30/70 %, parabolic cables, hangers/16 m) + stone arch (spans, cutwaters, gate towers) | self-tests + Tower Bridge live over the Thames |
| `matlib.py` | 29 procedural materials incl. facade window-grid w/ ~18 % lit windows + tint attr, terrain splat, water ripple | headless render grid test |
| `export_game.py` | `unity_city.json` (formatVersion 1, X-negation, spawn scoring, default speeds), `citymap_spawn.json`, `city_scene.glb` | headless contract test |

**Integration (build.py/UI):** field → solve → network → terrain → junctions → sweeps →
areas (draped, subdivided) → buildings (over-water piers) → landmarks → instanced props
→ `cb_export` payload. UI presets, terrain modes, quality, seed. Cycles-on-Metal
showcase renderer. Test matrix: quick (10 s), Prague 500 m (≈2 min, 1137 buildings/312
junctions), London 600 m (Thames + 4 landmark spans).

**Hard-won fixes already banked** (don't re-learn these): relation rings must be clipped
to the scene rect; flat crown facets Fresnel-mirror the sky → smooth + sharp-from-angle
30°; legacy path profiles must ride the terrain field; giant park relations 504 → split
ways/relations fetch; Blender 5.x enum/manifest quirks.

## 5. In pipeline — partially built or known-broken (with the exact workaround needed)

Ordered by showcase impact:

1. **Textures (IN PROGRESS — Phase 0).** `texcache.py` written + self-tested; ambientCG
   IDs verified live. Remaining: matlib photo builders (§3.1 node graph), facade photo
   base under the window grid, terrain splat photo pair, asphalt wear layer, UI toggle,
   texture smoke test. *Everything else about materials already works — UVs are metres
   everywhere, so this is purely a matlib upgrade.*
2. **Parallel-way overlap** (dual carriageways, Cable-St cycle tracks): surfaces
   overlap at slightly different z. Workaround shipped (paths follow terrain), real fix
   is the `roadmerge.py` pre-pass (§3.2 step 1) — detection is straightforward
   (bearing ±15°, gap < 1.2×Σhalf, >60 % length overlap); absorb-or-clamp then feeds the
   existing sweep unchanged.
3. **Junction pads are hulls** — fine at 90° crossings, blobby on skew/Y junctions.
   The osm2streets trim-back (§3.2 steps 2–7) replaces `junctions.py` pad math only;
   corner bands/crosswalks/stop lines keep their current code (they take arm mouths as
   input either way).
4. **Golden Gate scenario blocked by Overpass mirror load** (ways query itself 504s
   at peak). DEM + landmark code paths are individually verified; needs the tiled fetch
   (Phase 5) or an off-peak CI run. Not a code defect.
5. **Hipped roofs are ridge approximations**; complex/concave → flat. bpypolyskel
   vendoring (Phase 3) supersedes; keep approx as the exception fallback.
6. **Facade window scale** reads oversized on low/long buildings (grid derives from
   UV metres — correct — but storefronts/attics aren't differentiated). Recognizer +
   storefront band (Phase 3) fixes the read.
7. **`devices: []` in unity_city.json** — placements exist in build.py but aren't
   serialised with headings yet (Phase 5, ~50 lines: thread placements into
   `_export_payload`).
8. **Tree-lawn doesn't taper at junction mouths** (needs per-station variable offsets —
   `offsetPolylineVar` port, Phase 1).
9. **No benches/bins/vegetation/forest fill; single tree species** (Phase 2, pure ports
   of `vegetation.ts`/zone tables — specs already extracted).
10. **UI blocks during fetch; 1.5 km cap; no fetch cache** (Phase 5).
11. **Coastline seas missing** (SF Bay = land); algorithm spec'd in §3.6 (Phase 4).
12. **Collider/minimap/semantics exports missing** (Phase 5; contracts fully spec'd in
    specs/export-landmarks-props.md — mechanical port).

## 6. Execution roadmap — phases to v1.0

Each phase = one shippable version: matrix green + showcase renders + repackage/
reinstall + commit/push. Dependencies are listed so phases can't silently reorder.

### Phase 0 — "Showcase textures" → v0.6a  *(started; ~1 session)*
- [x] Verify ambientCG API + pin curated asset IDs (done, live-checked)
- [x] `texcache.py` download/cache module + offline self-tests (done)
- [x] `matlib.py`: `set_textures(maps)` + photo-PBR builder (Color×AO → Base, Rough,
      NormalGL → Normal Map; Mapping = 1/size_m); textured variants cached as `CB <key> T`
- [x] Composite builders: facade = photo plaster/brick base + existing window grid on
      top (brick vs plaster by tint threshold); terrain = photo grass/rock by `rock` attr
- [x] Asphalt wear layer (oil band + wheel paths from |lateral-UV|, noise-masked)
- [x] `__init__.py` toggle "Photo textures (ambientCG CC0)" default ON; build.py fetches
      to `extension_path_user` (source-run fallback ~/.cache) with progress; attribution label
- [x] Matrix + texture smoke (10 textured materials, 34 images) + offline-fallback proof
      (CB_NO_TEXTURES=1 run builds procedurally)
- Exit: driver-cam render with photographic asphalt/sidewalk/facades; offline build
  still works (procedural fallback proven by a no-network test run).

### Phase 1 — "Roads v2" → v0.6  *(the core-product phase; ~2 sessions)*
Depends on: nothing (parallel-safe with Phase 0, but ship after it).
- [x] `roadmerge.py` pre-pass: parallel-way detection (absorb cycle tracks as
      cross-section bands, footways silently; clamp dual-carriageway widths to a
      0.6 m median) — pure module, 5 self-tests (degree-2 collapse/short-link merge
      already covered by the elevation §B clustering)
- [x] osm2streets junction polygons in `junctions.py`: wedge-corner ring walk
      (left-edge × right-edge intersections, through-pair straight edges, shallow-
      wedge midpoint fallback) + curb-radius fillet; roundabout special DEFERRED
- [x] `profile.py`: `offset_polyline_var` port → tree-lawn tapers to 0 within 4 m of
      junction mouths; median side renders curb-only; absorbed cycle band at
      footpath level
- [~] Markings consistent via merged widths (post-clamp lanes); full lane-graph
      markings + per-lane wear deferred to the wear pass
- Exit: Cable Street renders as ONE cross-section (road + median + cycle track + walk);
  skewed junctions read clean; before/after renders in `renders/`.

### Phase 2 — "Living streets" → v0.6b  *(~1 session)*
Depends on: Phase 0 (grass card textures), Phase 1 (verge geometry stable).
- [ ] `vegetation.py`: verge tuft/shrub planner (zone table §3.3, budgets 26 k/6 k),
      geometry-nodes or collection-instance scatter per road side (≤ 1 object/side)
- [ ] Grass card material (procedurally generated alpha texture, no downloads)
- [ ] Forest/park interior fill (hash scatter, 1/90 m², cap 3 k) + 3 tree species
      templates (existing + columnar + broad) picked by hash
- Exit: residential street render shows populated verges; park/forest areas no longer
  empty green polygons.

### Phase 3 — "Buildings v3" → v0.7  *(~2 sessions)*
Depends on: Phase 0 (photo facades).
- [ ] Vendor `bpypolyskel` (GPL-3, pinned ≥ 2026-03-13; keep headers) → true hipped/
      complex roofs behind try/except with current approx as fallback
- [ ] `recognizer.py`: fusion chain (explicit tags → landuse zone → era/region → hash)
      emitting {facade, roof, tint}; drives brick/plaster/glass/panel + roof material
- [ ] Curtain-wall material + mullion grid for h ≥ 40 m commercial; storefront band
      (4.2 m dark glass) on commercial ground floors; hash-gated balconies
- [ ] `building:part` stacking (min_height already parsed)
- [ ] Church spires/domes/water towers/chimneys in `landmarks_gen.py`
- Exit: Prague old town vs Manhattan midtown renders read visibly different; named
  churches get spires.

### Phase 4 — "Water everywhere" → v0.7b  *(~1 session)*
- [ ] Coastline assembly (§3.6: stitch runs, close along rect on land side, union,
      sea = complement) in `overpass.py` + fixture test (recorded SF coastline JSON)
- [ ] Beach/sand banding at sea shores; keep riverbed compositing
- Exit: Golden Gate scenario (off-peak) or recorded-fixture build shows the bay as water
  with the suspension bridge over it.

### Phase 5 — "Game bridge complete + scale" → v0.8  *(~2 sessions)*
- [ ] `colliders.py`: collision GLB (extras contract v2: collider/semantics/
      physicsMaterial, groupKey merge, 12-seg cylinders) + `city_surface.glb` subset
- [ ] `citymap_minimap.glb` (flat class-colored ribbons, `mm_<hex>`) +
      `city_semantics.json` v3 (cross_section, elevation, traffic_audit) + devices
      array from placed props (id/kind/position/heading_rad)
- [ ] Tiled Overpass fetch (~1 km² tiles, id-dedupe, relations once) + disk cache keyed
      (bbox, contract) + golden fixtures for offline CI
- [ ] Modal build operator (worker thread + timer pump + cancel); radius cap → 3.5 km
- [ ] Road width scaling ×k slider (port `roadScale.ts` displacement field)
- Exit: the car game loads a plugin export with zero loader changes (diff unity_city.json
  field-by-field against an app export of the same bbox); 12 km² build completes.

### Phase 6 — "Assets & publish" → v0.9 → v1.0  *(~2 sessions)*
- [ ] Bundle KayKit City Builder Bits (CC0) lamps/signals/hydrants/benches via packed
      `.blend` + `bpy.data.libraries.load`; keep parametric as fallback
- [ ] Draco toggle; KTX2 bake path (Cycles bake → basisu) for the game
- [ ] Extension-platform submission pass (manifest lint, docs, screenshots), artist
      how-to docs, style presets (EU old town / US downtown / JP dense), demo video
      script
- Exit: publishable listing; v1.0 showcase package.

**Standing rules for every phase:** module self-tests stay green (12/12+); matrix runs
before commit; new algorithms come with numbers in SPEC.md first, code second; every
visual defect found in renders becomes a named fix in §5 before it's patched.

## 7. Risks & mitigations

- **ambientCG single-maintainer service** → aggressive disk caching; assets also mirror-
  able into the repo (CC0 allows committing them) if the API ever dies.
- **osm2streets port complexity** → land it behind a toggle; convex-hull path stays as
  fallback; port incrementally (pre-pass first — it alone fixes the worst artifact).
- **Overpass instability** (seen live: 502/504 storms) → tiling + disk cache + fixtures.
- **GPL-3 obligations** — plugin is GPL-3 already; vendored bpypolyskel/blosm-derived
  code keeps headers; game assets (GLB/JSON outputs) are NOT GPL (generated data).
- **Blender API churn** — extension pinned ≥ 4.2; matrix runs on the installed 5.1.2.

## 8. Attribution (ship in UI + game credits)

© OpenStreetMap contributors (ODbL) · Terrain: Mapzen/Tilezen via AWS Open Data,
SRTM/3DEP courtesy USGS · Textures: ambientCG (CC0) · Props (v0.9): KayKit (CC0).
