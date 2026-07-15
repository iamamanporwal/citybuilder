# Road Corridor Redesign — Civil-Engineering Road Generation

**Status:** Proposed · **Owner:** rendering/procgen · **Supersedes:** flat-ribbon road extrusion in `src/procgen/roads.ts`

> Goal: replace flat OSM ribbon extrusion with a continuous, grade-limited **road corridor system** — spline centerlines, a network-wide elevation solve, terrain that conforms to the road, procedural junctions, and structures (bridges/tunnels/ramps/retaining walls) generated as one continuous network with **no height discontinuities, no z-fighting, and no broken transitions** — producing AAA-quality drivable roads (Forza/GTA/NFS class) while staying **deterministic and fully procedural**.

> **⚑ Re-scope note (v3 — the plan being executed).** A hard critique of v2 (below) found it was an excellent *diagnosis* bundled with an over-scoped *rewrite*. The reported defect — *"bridges/tunnels/ramps/segments with inconsistent heights and broken transitions"* — is a **topology + elevation** problem, fixed by the graph + network elevation solve (old P0+P1) **alone**. Everything downstream (DEM, cross-section sweep, terrain weld, junction meshes, structures, clothoids) is AAA *quality*, not the *bug*, and the two hardest of those (the elevation solve and the terrain weld) were the *least* specified while the well-understood cross-section work was over-detailed. So v3 **re-cuts the roadmap around the actual defect and the make-or-break risk**:
>
> 1. **Ship the elevation solve first** (this document's implementation). It is the highest-leverage change, it is self-contained (elevation only — no mesh rewrite, no DEM, no network dependency), and it retires the project's single biggest unknown: *does a deterministic network elevation solve converge and stay grade-limited?* Until that is proven on real cities, nothing built on top of it is safe to fund.
> 2. **Demote the DEM (old P3).** At 30 m GLO-30/FABDEM — our reality for India and most non-EU targets — a DEM gives *"a hill exists,"* not eye-level relief, while adding a fetch, decode, geoid handling, snapshot bloat and a new failure mode. Geometry (crown/camber + banking + real junctions) is the dominant realism lever and needs no DEM. The DEM moves *below* junctions/structures and is explicitly optional. The Stage-2 solve is written to accept a per-node base height so a DEM is a **drop-in later**, not a rewrite.
> 3. **Gate on convergence, not on 8 phases.** Each phase stays test-gated and reversible behind a flag (the codebase's own `useLibraryAssets` pattern). The elevation solve ships **behind a flag, default-off**, fully wired into all three consumers (renderer, colliders, semantics) with a new invariant suite, so it is instant-A/B and zero-regression before it is ever defaulted on.
>
> The v2 content below is retained as the long-horizon vision. §6a (Executed roadmap) and §13 (Implementation status) are the authoritative record of what is actually built.

> **Reconciliation note (v2).** This revision folds in an external review plus the PRD's own scope. Critically, **PRD §8.3 already specifies this exact method** — "build a road graph → clean topology (merge nodes, resolve grade separation, normalize roundabouts) → assign smoothed elevation → sweep a per-class cross-section (lanes + curb + sidewalk) along each centerline → solve intersection surfaces → place marking decals" — so this document is the **concrete in-editor implementation of §8.3**, not a new direction. The PRD also commits to a **DEM terrain adapter** (Copernicus GLO-30 baseline + opportunistic high-res LiDAR, §6.2), an **OpenDRIVE evaluator seam + bake milestone** (`osm2opendrive → libOpenDRIVE/esmini`, §7C), **trimesh boolean carving of roads/water into terrain** in the bake service (§7C), **spatial tiling** (§10.4, "a whole city cannot live in a browser tab"), and a **server-side procedural engine** (Houdini recommended, §12). This document is therefore split into two horizons: **(A) what ships in-editor now** — the geometric contract, real terrain, and reconciliation, all client-side and deterministic — and **(B) the bake-service graduation** for full-city AAA scale. The biggest concrete change from v1 is Stage 4: v1 punted on the elevation source ("flat/synthetic base now"); v2 wires a **real, free, CORS-friendly DEM** and snapshots it into the graph so determinism is preserved. See §10–§12 for the added content-quality, scale, and prior-art sections.

---

## 1. Why the current pipeline fails

The current generator (`src/procgen/roads.ts` + `src/procgen/roadNetwork.ts`) is a **per-segment flat extruder**:

1. **No continuous elevation.** Each `RoadSegment` is smoothed and offset into a ribbon at a fixed `Y_ROAD = 0.05`. The *only* vertical relief is bridges, whose height comes from `elevationProfile()` — an eased ramp from `0` to `layer × BRIDGE_LAYER_H (6.5 m)` computed **independently per segment**. Continuity across a shared node is only approximated by a binary heuristic (`node.hasSurface ? 0 : fullElev`, `roadNetwork.ts:72-76`). Two segments meeting at a node agree on height only by luck of that heuristic; **grade (slope) is never matched**, so bridge↔approach and segment↔segment transitions kink.
2. **Terrain is a flat plane.** `buildTerrain()` (`areas.ts:102`) is a single `ShapeGeometry` at `y=0` with water holes. There is **no DEM, no heightfield, no displacement** (confirmed: no `srtm|dem|heightmap|noise` anywhere). Roads float on a table; nothing conforms.
3. **Junctions are a paint trick, not geometry.** Ribbons are *trimmed back* near junctions and a flat `CircleGeometry` "disc" is dropped one layer up (`roads.ts:133-140, 284-312`). Overlaps are hidden with `planarUvXZ` (identical-texel overdraw), not solved. On any slope this breaks.
4. **The vertical stack is load-bearing and fragile.** `LAYER_CONVENTION` (`editor/depthConfig.ts:37`) fixes every surface class to a constant Y (road .05, decals .08, disc .11, markings .16, crosswalk .175, sidewalk .22). Markings/decals/discs render *above* the road by fixed **global-Y** offsets. This only works because everything is flat — **on a real slope or a banked curve, a global-Y offset no longer sits "above" the surface** and either floats or z-fights.
5. **No civil geometry.** No arc/clothoid transitions, no vertical curves, no superelevation, no cut/fill, no retaining walls, no shoulders. Bridges are fascia+rail+pier cosmetics; tunnels are just portal frames with the surface deleted.

**What's already good and must be preserved:**
- Deterministic RNG (`hash01`, `seededRandom`) — no `Math.random` in generation.
- A clean semantic split: `CityGraph` (data) → resolver (`RoadResolution`) → geometry, and a **separate collider pipeline** (`physics/colliders.ts`) built from semantics, not mesh clones, with a versioned `ColliderDescriptor` contract (`heightfield` kind already reserved, `types.ts:11`).
- `ribbonGeometry` already accepts a **per-point Y profile** — per-vertex elevation is plumbed end-to-end today (used only for bridges).
- `smoothPolyline` is explicitly framed as a swappable "OpenDRIVE-style reference line" evaluator (`geometry.ts:202-221`).
- Invariant tests: `flickerInvariants`, `terrainCarve`, `roadElevation` (incl. **renderer↔math parity**), `coplanarOverdraw`. These are the contract; the redesign extends them, never bypasses them.

---

## 2. Target architecture

Model the road network the way a civil-engineering / OpenDRIVE toolchain does: a **reference line (plan) + elevation profile (vertical) + lateral cross-section (super) + a network solve that guarantees continuity at every junction.** Then **conform the terrain to the corridor** so road and ground are one welded manifold.

```
CityGraph.roads (OSM polylines, ENU meters)
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 0. TOPOLOGY        RoadGraph: nodes (junction/joint/endpoint) + edges │
│                    routes through degree-2 joints; grade-sep groups   │
├─────────────────────────────────────────────────────────────────────┤
│ 1. PLAN GEOMETRY   per-edge C² reference spline (arc-length param):   │
│                    station s, heading θ(s), curvature κ(s)            │
├─────────────────────────────────────────────────────────────────────┤
│ 2. ELEVATION SOLVE network-wide z(node) + per-edge z(s):              │
│                    C⁰ at junctions, C¹ through joints, grade-limited,  │
│                    vertical-curve-limited, terrain-preferring          │
├─────────────────────────────────────────────────────────────────────┤
│ 3. SUPERELEVATION  bank e(s) into curves; blended through transitions │
├─────────────────────────────────────────────────────────────────────┤
│ 4. TERRAIN CONFORM heightfield stamped to corridor; batter slopes;    │
│                    retaining walls where slope > max; welded seam      │
├─────────────────────────────────────────────────────────────────────┤
│ 5. CORRIDOR MESH   sweep cross-section (lanes+curb+walk+shoulder)     │
│                    along spline; markings baked in corridor UV         │
├─────────────────────────────────────────────────────────────────────┤
│ 6. JUNCTION MESH   trim arms, blend to common node elevation,         │
│                    kerb-return fillets, stitched (shared rings)        │
├─────────────────────────────────────────────────────────────────────┤
│ 7. STRUCTURES      bridge/viaduct, tunnel/cut, ramp, retaining wall — │
│                    emitted where corridor z diverges from terrain      │
└─────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
   Visual meshes (scene/registry)     Colliders (physics/colliders)
                                      terrain → heightfield collider
```

**One elevation source, three consumers.** The elevation solve (Stage 2) is the single source of truth. The renderer, the collider builder, and the semantics exporter all read the *same* `z(s)` — exactly as `roadNetwork.ts` is shared today, but generalized from "bridge ramps" to "the whole network." The `roadElevation.test.ts` parity test generalizes to *every* segment, not just bridges.

---

## 3. Stage-by-stage design

### Stage 0 — Topology: `RoadGraph`

New module `src/procgen/corridor/graph.ts`. Build a real graph from `CityGraph.roads`:

- **Node**: snapped position (reuse `nodeKey` half-meter snap), incident half-edges, degree, `grade-separation group` (from OSM `layer`/`bridge`/`tunnel`).
- **Edge**: the `RoadSegment`, its two end nodes, direction.
- **Classification**:
  - degree ≥ 3 → **junction** (needs a junction mesh + common elevation).
  - degree == 2 with compatible class/width → **joint**: chain edges into a **route** so the spline and elevation flow *through* it with C¹ continuity (this is what removes the segment-to-segment kinks).
  - degree == 1 → **endpoint** (free elevation, follows terrain).
- Replaces/absorbs `analyzeRoadNodes()`. Output is deterministic (nodes sorted by key).

**Deliverable:** `buildRoadGraph(roads): RoadGraph` with `{nodes, edges, routes, junctions}`. No visual change yet.

### Stage 1 — Plan geometry: reference splines

New `src/procgen/corridor/spline.ts`. Per edge/route, produce an **arc-length-parameterized reference line** sampled at adaptive stations (denser in curves):

- Keep the current **centripetal Catmull-Rom** as the baseline (already good, deterministic, endpoint-pinned).
- Add **G¹/G² tangent continuity through joints** so a route is smooth end-to-end (feed neighbor tangents into the curve).
- Expose `refLine(s) → { p, heading θ, curvature κ }`. Curvature drives superelevation and junction fillet radii.
- **P6 upgrade (AAA):** optional **clothoid/Euler-spiral transitions** between tangents and arcs (constant-rate curvature change) — the single biggest "feels like Forza" lever for steering. Behind a flag; the Catmull-Rom path stays the default and the fallback.

Endpoints remain pinned to node positions so junction topology is untouched. This is the swap point the existing comment anticipates (`osm2opendrive → libOpenDRIVE` could later replace the evaluator with zero downstream change).

### Stage 2 — Elevation solve (the core)

New `src/procgen/corridor/elevation.ts` — generalizes `roadNetwork.ts`. This is a **known problem with a known shape** — the AV-simulation and procedural-terrain literature converges on the same three steps, which is exactly the pipeline below: **(1) sample per-vertex DEM heights along the centerline → (2) apply gradient-constraint smoothing that enforces physically reasonable grades while preserving DEM fidelity → (3) enforce continuity at junctions.** (Refs: Galin et al., *Procedural Generation of Roads* — road profile + blending-region cut/fill; AV-sim "deformation lattice" terrain-to-road alignment; OSM2World's terrain-refinement roadmap. See §12.) Two passes:

**2a. Node elevations (global relaxation).**
- **Pins (hard constraints):** grade-separated groups get target heights — bridge nodes at `layer × BRIDGE_LAYER_H`, tunnel nodes below terrain by clearance, at-grade nodes seeded from the base terrain height (flat 0 until Stage 4 introduces a DEM).
- **Relax** free node heights with a **projected Gauss-Seidel / Laplacian smoothing** under the constraint that every incident edge's mean grade ≤ `maxGrade(class)`. Deterministic: fixed iteration budget, nodes visited in key order, convergence tolerance logged. This is the network generalization of today's per-segment ramp.
- **Grade caps by class** (design values): motorway/trunk 4%, primary/secondary 6%, residential/service 8%, ramps 6%, paths 12%. Stored next to the class table.

**2b. Per-edge vertical profile `z(s)`.**
- Given endpoint elevations **and endpoint grades** (from adjacent edges through joints), fit a **grade-limited profile with vertical curves**: piecewise **parabolic crest/sag curves** (min K-value → bounded vertical curvature → no visible kink, comfortable to drive) joined by constant-grade tangents. This is `elevationAt()` generalized from a single ease to a real vertical alignment.
- Guarantees: **C⁰** at junctions (all arms share the node elevation), **C¹** through joints (grades match), `|dz/ds| ≤ maxGrade` everywhere, `|d²z/ds²|` bounded.

**Output contract:** `edgeProfile(edgeId) → z(s)` sampled at the same stations as the spline. Every downstream consumer (mesh, collider, exporter) reads this. `rampSpecFor`/`elevationProfile` become special cases.

### Stage 3 — Superelevation (banking)

In `elevation.ts`: compute cross-slope `e(s)` from curvature and a design speed per class: `e ≈ clamp(v²/(g·R) − f, 0, e_max)` with `e_max ≈ 6–8%`. Blend `e` in/out across the spiral/transition length so banking ramps smoothly (no instant tilt). The cross-section sweep (Stage 5) rotates the template by `e(s)` about the centerline. Optional and class-gated (motorways/primaries only); residential stays flat. This is what makes fast curves read as designed rather than extruded.

### Stage 4 — Terrain conforming

New `src/procgen/corridor/terrain.ts` + `src/ingest/dem.ts`; upgrades `areas.ts`. **Terrain conforms to the road**, not vice-versa. Two parts: **get real elevation data** (4a) and **reconcile the network to it** (4b).

#### 4a. Real DEM (client-side, free, deterministic-by-snapshot)

Do **not** build a DEM pipeline — consume existing free tiles. A ≤4 km² city is tiny.

- **Source: Mapterhorn** (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, **terrarium** encoding, free/CORS-friendly). Global GLO-30 baseline blended with high-res national LiDAR where available. Decode per-pixel: `elevation_m = (R*256 + G + B/256) - 32768`. Alternative: **Re:Earth Terrain** (built on Mapterhorn) adds a **point-query endpoint** `GET /heights.json?points=lon,lat;lon,lat` — sample road/building bases without decoding tiles yourself — and blends the **EGM2008 geoid**.
- **Prefer a bare-earth DTM over a DSM.** **FABDEM** (global, buildings+vegetation *removed*) is the right base for roads — a raw DSM bakes rooftops and tree canopy into the "ground." GLO-30/FABDEM at 30 m is a *world apart* from a flat plane for a driving game; we're not modeling curbs from it, just the landform. (Reality check: for **India** and most non-EU targets we're on 30 m GLO-30/FABDEM, not LiDAR — and that's fine.)
- **Geoid offset:** DEMs publish heights above sea level (geoid), not the ellipsoid. Over a single ≤4 km² AOI the geoid is **near-constant**, so it's an (ignorable) constant bias on the local landform — low priority for a local scene; matters only for absolute global correctness. Use Re:Earth's corrected tiles if we want it for free.
- **Determinism rule (critical):** remote tiles fetched at runtime would break the "same city → same output on any machine" contract. So **sample the DEM once at ingest and snapshot per-vertex heights into the `CityGraph`** (extend `RoadSegment.points` to carry a sampled `y`, and store a coarse heightfield alongside), exactly as `public/data/raw_osm.json` snapshots OSM. Generation then stays fully offline/deterministic; the network fetch is an ingest-time step, cached like Overpass.
- **Client libs (reference/lift, don't necessarily add):** `w3reality/three-geo` and `tentone/geo-three` already implement terrarium→mesh with LOD; `gkjohnson/three-mesh-bvh` gives cheap terrain raycasting for elevation sampling. We can lift the ~30-line decode-and-displace and point it at Mapterhorn rather than take a dependency.

#### 4b. Reconcile the network to the terrain

- **Heightfield** `H(x,z)` over the scene rect (grid ~2 m, finer near corridors), seeded from the snapshotted DEM (§4a). This is a *new capability* — today's terrain is flat `ShapeGeometry`.
- **Stamp corridors into the heightfield.** For each corridor, rasterize a right-of-way band:
  - cells under carriageway+shoulder → forced to road-edge elevation `z(s)` (with cross-slope);
  - cells in the **batter zone** beyond the shoulder → blended from road-edge height back to natural `H` over a fill/cut slope (fill ≈ 1:2, cut ≈ 1:1.5), capped by right-of-way width;
  - where required |Δh| over the batter exceeds the slope budget → mark for a **retaining wall** (Stage 7) instead of a slope;
  - where road is far *above* terrain → **bridge** span (Stage 7), no fill; far *below* → **tunnel/cut**.
- **Weld the seam.** The corridor mesh's outer edge and the terrain share the *same* boundary vertices (stitched skirt) so the road↔terrain join is one manifold — **no coplanar overlap, therefore no z-fighting by construction**, and no gaps. This replaces the "layer-gap + planar-UV overdraw" tricks for the road/ground boundary.
- Water carving stays exactly as-is (whitelist-only, `terrainCarve.test.ts` must keep passing). Corridors that cross water become bridges.

Determinism: the DEM is snapshotted at ingest (§4a) and rasterization runs on a fixed grid — fully deterministic, no runtime network dependency.

### Stage 5 — Corridor mesh (cross-section sweep)

New `src/procgen/corridor/crossSection.ts` + `mesh.ts`; replaces the per-segment ribbon block in `roads.ts`.

- Define a **cross-section template** from `RoadResolution.crossSection` + lane count: `[batter/verge | sidewalk | curb+gutter | shoulder | lane×N | shoulder | curb+gutter | sidewalk | batter]`. Each strip is a set of (offset, height, material) points.
- **Road crown/camber (default cross-slope).** On straights, the carriageway is very slightly center-high (≈2% fall to each gutter) — cheap, sheds water, and reads as *real* to a driver (a dead-flat ribbon looks fake at eye level). Superelevation (Stage 3) is the **curve** case that rotates the whole section; crown is the **straight** case. They blend: crown → banked → crown across each transition. This is a top PRD "AAA reference" ask ("flat, smooth drivable surface", not a flat plane).
- **Sweep/loft** the template along the reference spline, sampling at spline stations. At each station: place the ring at `refLine(s).p`, elevate by `z(s)`, tilt by `e(s)`, orient across `heading(s)`. Connect consecutive rings into a strip → a continuous, terrain-following, banked corridor mesh.
- **Weld rings at joints** (adjacent edges in a route share the boundary ring) → zero discontinuity.
- **UVs:** `(s, t)` = (station, lateral offset). Correct texture flow on slopes and through curves.
- **Markings baked into corridor UV** (or offset **along the surface normal**, not global +Y). This is the fix for the fragile Y-layer stack: on a bank/slope, a normal-offset (or an in-material marking mask) keeps markings glued to the surface with no z-fight. Recommend a per-corridor **marking mask** channel so lane lines are literally the same surface — impossible to z-fight or float.
- Curbs/sidewalks/shoulders come *free* as strips of the same swept ring (no separate `raisedRibbonGeometry` pass, no separate trim logic).

### Stage 6 — Junction mesh

New `src/procgen/corridor/junction.ts`; replaces the disc + trim hack.

- Trim each incident arm back by a junction radius (curvature/width-derived), as today — but now record each arm's **end cross-section ring** (position, elevation, cross-slope).
- Build the junction surface as a mesh that **interpolates between the arm end rings at the common node elevation** (all arms already share it from Stage 2), with **kerb-return fillets** (arc radius from turn geometry) between adjacent arms.
- **Stitch** the junction mesh to each arm's end ring (shared vertices) → matching height *and* slope at every arm → no steps, no discontinuity.
- Crosswalks/stop-lines become marking-mask features on the junction surface (surface-riding, not floating discs).
- P2: turn-lane connectors / channelization; P3: signalized-intersection channelizing islands.

### Stage 7 — Structures (unified, from the solve)

New `src/procgen/corridor/structures.ts`; unifies bridges/tunnels/ramps/walls. All are derived from **where corridor `z(s)` diverges from terrain `H`** — one rule, many outputs:

- **Bridge / viaduct**: `z(s) − H > clearance` over a span → deck edge fascia + railings (rides the swept edge rings) + **piers at intervals**, pier height = `z(s) − H(pier)` sampled from the heightfield (not a hard-coded `>3.5`). Deck is part of the corridor mesh, so deck↔approach is continuous.
- **Tunnel / cut**: `H − z(s) > depth` → bore + **portal frames at the exact terrain-crossing stations** (computed from `H`, not "end of segment"). Surface still exists inside for physics/drive; visibility handled by the bore.
- **Ramp**: an edge/route in the graph with its own grade-limited profile connecting a grade-separated route to a surface route. Interchange topology (motorway on/off ramps) is P3.
- **Retaining wall**: where Stage 4 flagged slope > budget → vertical wall from road edge/shoulder down/up to terrain, welded to both. Replaces uncontrolled batter.

Because every structure reads the same `z(s)` and the same `H`, transitions between at-grade → embankment → bridge → tunnel are continuous by construction.

---

## 4. Determinism, invariants & tests

Every stage stays deterministic (keyed `hash01`/`seededRandom`, fixed iteration counts, key-sorted traversal — no `Math.random`, no wall-clock). **The DEM is the one external input**: it is fetched and sampled **at ingest**, then snapshotted into the `CityGraph` (§4a), so generation itself has zero network dependency and reproduces bit-for-bit anywhere — same discipline as the cached `raw_osm.json`. The redesign is gated by **extending the existing invariant suite**, never bypassing it:

| Invariant | Test | Change |
|---|---|---|
| Bridge ramp grade cap + no NaN | `roadElevation.test.ts` | **Generalize** to network solve: grade cap on *every* edge |
| Renderer ↔ elevation-math parity | `roadElevation.test.ts` | **Generalize**: mesh vertex Y == `edgeProfile(s)` for all segments |
| **NEW** C⁰ junction continuity | new | all arms at a node share elevation (< ε) |
| **NEW** C¹ joint continuity | new | grade matches through degree-2 joints (< ε) |
| **NEW** vertical-curve smoothness | new | `|d²z/ds²|` ≤ K-limit (no kinks) |
| **NEW** road↔terrain weld | extend `terrainCarve.test.ts` | corridor edge vertices coincide with terrain vertices (no gap, no coplanar pair) |
| Water carved, no coplanar ground | `terrainCarve.test.ts` | **must stay green** (water untouched) |
| Log-depth resolves all layer gaps | `flickerInvariants.test.ts` | **must stay green**; markings move to surface-normal/mask, so fewer global-Y layers to defend |
| Decal non-overlap | `coplanarOverdraw.test.ts` | preserved for surface decals |
| Collider ↔ visual height parity | `colliders.test.ts` | terrain → `heightfield`; road collider reads `edgeProfile` |

**Run `npm test` before and after every stage** (memory invariant: never touch ingest/layers/depth without the suite). Use the `verify` skill to drive the app after visual stages.

---

## 5. Physics & export impact

- **Terrain collider → `heightfield`.** `colliders.ts:329` already anticipates this: "swap kind to `heightfield` here, nothing else changes." The `heightfield` `ColliderKind` is reserved (`types.ts:11`) and `colliderGlb.ts:108` already skips heightfields in the merge. Feed it the Stage-4 heightfield.
- **Road/sidewalk/junction colliders read `edgeProfile`** instead of `Y_ROAD_COL` constants — mirroring visual heights exactly (the current parity comment in `colliders.ts:32-38` stays true, now for real elevation).
- **Bridge rails / portals** read structure output from Stage 7 rather than recomputing ramp math independently.
- **`city_semantics.json` is the third consumer.** `export/semantics.ts` (`RoadSemanticsEntry`, `semanticsVersion 2`) already emits **3-component centerlines in true meters** (y = grade, includes bridge elevation) — it reads the same `roadNetwork.ts` math today. It simply reads `edgeProfile` after the redesign, and **`semanticsVersion` bumps to 3** since the y channel is now a full network solve, not just bridge ramps.
- **Bump the collider/export contract version** (`ColliderDescriptor` / GLB semantics) since geometry semantics change; keep the exporter's grouping/merge intact.

---

## 6a. Executed roadmap (v3 — authoritative)

Re-cut around the actual defect. **Bold = shipped in this change.** The elevation solve is the whole game; everything after it is quality that depends on it and is deferred until the solve is proven on real cities.

| Phase | Scope | Status | Exit criteria |
|---|---|---|---|
| **E0 — Topology graph** | `corridor/graph.ts`: nodes (endpoint/joint/junction), edges, grade-sep pins, per-class grade caps; generalizes `analyzeRoadNodes` | **✅ shipped** | Deterministic graph (key-sorted); classification unit-tested; no visual change |
| **E1 — Network elevation solve** | `corridor/elevation.ts`: projected Gauss-Seidel node relaxation (pins + base-pull + grade projection) → per-edge C¹ profile with joint-shared grades; bridge/tunnel ramp shaping folded in | **✅ shipped** | C⁰-at-junction, C¹-at-joint, grade-cap-everywhere, curvature-bounded, determinism + NaN-safety invariants green; convergence residual logged |
| **E2 — Consumer wiring** | `roads.ts` / `colliders.ts` / `export/semantics.ts` all read the solve via one seam, behind a default-off flag; store toggle | **✅ shipped** | Flag-off ⇒ byte-identical legacy (full suite green); flag-on ⇒ new suite green; single source of truth for the y-channel |
| **E4 — Markings-on-surface** | `roads.ts`: markings, sidewalks/curbs, wear decals, crosswalks and junction discs ride the solved elevation (surface-relative offset via `surfaceElevSampler` + `nodeElevation` seam), replacing the fixed global-Y stack; flat roads stay byte-identical | **✅ shipped** | On a lifted at-grade road no layer floats; flat network byte-identical (flag on == off); flicker/coplanar suites green |
| **E3 — Default-on + visual QA** | flip default (config + store) after driving real cities in the `verify` skill; bump `semanticsVersion` → 3 | **✅ shipped** | Drove Lower Manhattan flag-on: continuous roads, markings glued to the surface, drive preview smooth at eye level; 128/128 tests + `tsc` + prod build green; export contract bumped |
| E4b — Crown/camber + banking | cross-slope in the swept ring (no DEM needed) — the top no-DEM realism lever | ⏳ next | Straights crown ~2%, curves bank e(s) |
| E5 — Real junction meshes | `corridor/junction.ts`: arm blending + kerb returns, stitched to arm rings | ⏳ deferred | No steps at any junction |
| E6 — Terrain conform (**optional**) | `ingest/dem.ts` snapshot + heightfield stamp + welded seam — gated on E3–E5 proving the geometry first | ⏳ optional | Only if 30 m relief earns its cost on real targets |
| E7 — Structures / clothoids / superelevation | unified from `z(s)` vs `H`; AAA polish | ⏳ deferred | Post-geometry polish |

The old §6 table (below) is the v2 vision; §6a supersedes its sequencing.

---

## 6. Phased roadmap (v2 vision — superseded by §6a for sequencing)

Each phase is independently shippable, test-gated, and reversible. New code lives under `src/procgen/corridor/`; the old `roads.ts` path stays behind a flag until Phase 5 so we can A/B and roll back.

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Topology** | `graph.ts`: nodes/edges/routes/junctions; absorb `analyzeRoadNodes` | Graph built for sample cities; unit tests on classification; **no visual change** |
| **P1 — Elevation solve** | `elevation.ts`: node relaxation + per-edge vertical curves; replace `rampSpecFor`/`elevationProfile` as special cases | C⁰/C¹/grade/curvature invariant tests green; parity test generalized; bridges still correct |
| **P2 — Corridor mesh** | `spline.ts` (G¹ routes) + `crossSection.ts` + `mesh.ts`; swept corridors; markings on surface (mask/normal-offset) | Roads render with real cross-sections; markings ride slopes; flicker suite green |
| **P3 — Terrain conform** | `ingest/dem.ts` (Mapterhorn/FABDEM sample + snapshot) → `terrain.ts`: heightfield + corridor stamping + batter + welded seam; retaining-wall flags. Ship behind a **flat-vs-real toggle** (like the library-asset toggle) for instant A/B | Real terrain under roads; road↔terrain weld test green; water suite still green; deterministic from snapshot |
| **P4 — Junctions** | `junction.ts`: arm blending, kerb returns, stitched surfaces | No steps at any junction; crosswalks surface-riding |
| **P5 — Structures** | `structures.ts`: bridge/tunnel/ramp/wall unified from `z(s)` vs `H`; retire flag on old path | Continuous at-grade↔embankment↔bridge↔tunnel; old `roads.ts` removed |
| **P6 — AAA polish** | clothoid transitions, superelevation on, lane connectors, LOD/mesh-decimation, material passes | Drives like a modern open-world map; perf budget met |
| **P7 — Physics/export** | heightfield collider, `edgeProfile`-driven colliders, contract version bump | Collider parity tests green; GLB export + `bake` pipeline intact; drive preview smooth |

**Horizon B — bake service (P1 investment, out of the in-editor critical path; see §11).** Once P0–P7 deliver the geometric contract client-side, graduate the heavy work server-side: OpenDRIVE-grade lane-accurate junctions, trimesh boolean carving of roads/water into terrain, KTX2 encode, auto-LOD, and **spatial tiling** (the PRD's survival requirement — a whole high-fidelity city can't live in a browser tab). This is the PRD's existing server-side procedural milestone; it does **not** block the redesign above.

---

## 7. Key risks & mitigations

- **Perf (runtime, in-browser).** Swept corridors + stamped heightfield are heavier than flat ribbons. Mitigate: adaptive station density (dense only in curves/junctions), heightfield grid coarse away from roads, merge by material (existing `mergeGeometries`/`mergeVertices`), LOD in P6. Budget: keep a target city under current frame cost.
- **Elevation solve non-convergence / nondeterminism.** Fixed iteration budget + key-ordered projected Gauss-Seidel + tolerance logging. Never early-exit on a float compare that could differ across machines.
- **OSM data is noisy** (missing/bad `layer`, self-overlapping ways, degenerate junctions). Reuse existing guards (`ringIsSimple`, fold-over collapse in `offsetPolyline`, miter clamp) and add per-stage fallbacks that degrade to the previous stage's output rather than crash.
- **Breaking the flicker/water invariants.** These are the project's hard-won correctness contracts. The redesign *reduces* reliance on the global-Y stack (markings→surface), but must keep water carving and log-depth exactly. `npm test` gates every commit.
- **DEM quality/coverage.** Non-EU targets (incl. India) are on 30 m GLO-30/FABDEM — coarse but *far* better than flat for a driving landform. Use a **bare-earth DTM (FABDEM)** so roofs/canopy aren't baked into the ground. If a tile 404s or a city sits outside coverage, fall back to a flat base at the mean sampled height — the pipeline degrades, never crashes.
- **DEM as a runtime dependency.** Fetching tiles live would break determinism and add a network failure mode inside generation. Mitigated by the **ingest-time snapshot** (§4a): generation reads only the cached graph.
- **Geoid vs ellipsoid mismatch.** Real but near-constant over a small AOI (a fixed bias, not a landform distortion). Low priority; use Re:Earth's geoid-corrected tiles if we want it handled for free.

---

## 8. New module layout

```
src/ingest/
  dem.ts           # Stage 4a: sample Mapterhorn/FABDEM at ingest; snapshot heights into CityGraph
src/procgen/corridor/
  graph.ts         # Stage 0: RoadGraph (nodes, edges, routes, junctions)
  spline.ts        # Stage 1: arc-length reference line; G¹ routes; (P6) clothoids
  elevation.ts     # Stage 2+3: network z-solve, vertical curves, superelevation
  terrain.ts       # Stage 4: heightfield, corridor stamping, batter, seam weld
  crossSection.ts  # Stage 5: cross-section templates from RoadResolution
  mesh.ts          # Stage 5: cross-section sweep → corridor mesh + marking mask
  junction.ts      # Stage 6: arm blending, kerb returns, stitched surfaces
  structures.ts    # Stage 7: bridge/tunnel/ramp/retaining-wall from z(s) vs H
  index.ts         # buildCorridors(graph, ctx, resolutions) → CorridorBuildResult
```

`roadNetwork.ts` generalizes into `elevation.ts` (contracts kept for the parity test). `geometry.ts` helpers (`offsetPolyline`, `ribbonGeometry`, `wallGeometry`, ring math) are reused throughout. `scene/registry.ts` swaps `buildRoads` → `buildCorridors`; `physics/colliders.ts` reads `edgeProfile` + heightfield.

---

## 9. Open decisions (recommendations in **bold**)

1. **DEM source:** **Mapterhorn terrarium tiles for the base + FABDEM for bare-earth, sampled and snapshotted at ingest** (`src/ingest/dem.ts`). Re:Earth `heights.json` point-query as the low-effort sampler and free geoid correction. (v1 said "flat/synthetic now" — superseded.)
2. **Markings:** **per-corridor marking mask baked into the surface material** (zero z-fight) vs. normal-offset decal ribbons. Recommend mask; keep normal-offset as fallback.
3. **Reference line:** **centripetal Catmull-Rom default + G¹ routes now**, clothoids as a P6 flag.
4. **Elevation solver:** **projected Gauss-Seidel relaxation** (simple, deterministic, debuggable) over a full least-squares/QP solve.
5. **Old path:** keep `roads.ts` behind a flag through P4; **remove at P5**.
6. **Backend:** **stay client-side for the redesign (Horizon A); plan the bake service as the P1 graduation** (§11). Whether that service is Python (GDAL + trimesh + gltf-transform) or the PRD's Houdini+PDG is a separate call — the client-side geometric contract is identical either way.

---

## 10. What "AAA" means for our output (content quality, not rendering)

Per the PRD scope note, **rendering lives in the game engine** — lighting, shadows, reflections, post are never ours. So "Forza/GTA/NFS-quality roads" for CityBuilder is entirely a **content-quality** target, and the levers are concrete and mostly already half-built:

- **The corridor geometry itself** (Stages 1–7) is the dominant lever: smooth grade-limited profiles, banked curves, crown/camber, real junctions, structures that fit the terrain. A flat gray ribbon reads as fake no matter how good the material.
- **High-res tiling PBR asphalt + a detail/normal map at close range** so the surface has micro-relief at eye level, not a flat plane. (Material library exists, `materials/library.ts`; add a detail-normal pass.)
- **Surface variants by class** — highway vs residential asphalt, cobble/pavers in old town — already resolved (`RoadSurfaceSet`), just wired to more classes.
- **Density-driven wear** (cracks, patches, oil, manholes) rather than uniform — the `DecalPlanner` already does non-overlap placement; keep it, ride it on the 3D surface.
- **Seeded per-instance UV offsets** so adjacent segments don't visibly tile — already done (`hash01(r.id+':uv')`); preserve it in the swept UV.
- The wet-look, bloom on markings, sky reflections, etc. are **deliberately out of scope** (engine-side) and must never be baked in.

The point: we can hit "AAA drivable" without a renderer upgrade, because our job is geometry + unlit PBR + semantics, and the geometry redesign is where the realism actually comes from.

---

## 11. Horizon A (client, now) vs Horizon B (bake service, later)

The honest scale story, aligned with the PRD's own architecture (§10.4 tiling, §12 server-side procedural):

**Horizon A — in-editor, client-side, ships now (this document, P0–P7).**
Delivers the geometric contract: real terrain, grade-limited continuous profiles, terrain-conforming corridors, procedural junctions, structures — deterministic, offline-reproducible, drivable in the Rapier preview. This alone fixes the reported problem (bridges/tunnels/ramps/segments with inconsistent heights and broken transitions). **Highest leverage; no backend required.** The `evaluate(s) → {pos, dir, elevation}` seam the PRD already defines (and `smoothPolyline`'s "swappable evaluator" comment) means nothing built here is throwaway when Horizon B lands.

**Horizon B — server-side bake, the P1 graduation.**
A browser tab cannot hold a whole high-fidelity city; the PRD flags **tiling as a survival requirement, not polish** (§10.4). The bake service is where these move:
- **OpenDRIVE-grade roads/junctions** — `osm2opendrive`/`osm2xodr` → `libOpenDRIVE` (Apache-2.0 C++ mesh gen) / `esmini` (RoadManager). Replaces the in-editor evaluator behind the same seam.
- **True boolean terrain carving** (roads/water into terrain via trimesh CSG) — the exact operation the PRD says is a bake-service boolean (in-editor we use the welded-seam + layer convention as the working equivalent).
- **KTX2 encode + auto-LOD + 3D-Tiles tiling** — per the existing `textures_manifest.json` and LOD budgets.
- **Implementation choice:** the PRD names **Houdini + PDG**; the external review proposes a lighter **Python stack (GDAL + trimesh + gltf-transform)**. Either satisfies the same output contract — decide on team/ops grounds, not architecture. `gltf-transform` (already planned for dedup/Draco/KTX2/LOD) is common to both.

**Rule:** build Horizon A against the OpenDRIVE-shaped seam so Horizon B is a swap, not a rewrite.

---

## 12. Prior art & references

External work this design leans on (validate endpoints/licenses before depending on any):

**Terrain data (client-side, free):**
- **Mapterhorn** — free global terrain tiles, terrarium-encoded (`tiles.mapterhorn.com`); GLO-30 baseline + national LiDAR blend. Primary DEM source.
- **Re:Earth Terrain** — built on Mapterhorn; adds `heights.json` point-query + EGM2008 geoid correction.
- **FABDEM** (Univ. Bristol) — global **bare-earth DTM** (buildings/veg removed); the right base for roads.
- **Copernicus GLO-30** — 30 m global DSM baseline (PRD §6.2 terrain adapter).

**OSM → 3D & road-on-terrain technique:**
- **Galin et al., *Procedural Generation of Roads*** — road profile + blending-region cut/fill theory (the Stage-2/4 basis).
- **OSM2World** — mature OSM+terrain→3D; its terrain-refinement reasoning ("OSM knowledge must refine the terrain; interpolate-and-place looks implausible") is our thesis.
- AV-sim pipeline (parse OSM → per-vertex DEM heights → gradient-constraint smoothing → deformation-lattice terrain alignment) — the runtime formalization of Stage 2/4.
- `PolsCommits/procedural-roads` (Unity) — a concrete end-to-end road/terrain reconciliation to read.

**OpenDRIVE toolchain (Horizon B):**
- `libOpenDRIVE` (Apache-2.0 C++, mesh gen), `esmini` (RoadManager), `osm2opendrive` / `osm2xodr` (OSM→xodr), `pyoscx/scenariogeneration` (Python authoring), `benediktschwab/awesome-openx` (ecosystem index).

**Browser terrain rendering / sampling:**
- `w3reality/three-geo`, `tentone/geo-three` — terrarium/RGB-DEM → three.js mesh + LOD (reference/lift).
- `gkjohnson/three-mesh-bvh` — fast terrain raycasting for elevation sampling.

**Bake/optimize:**
- `donmccurdy/glTF-Transform`, `zeux/meshoptimizer` (gltfpack) — dedup/Draco/KTX2/auto-LOD.

> Asset-library sourcing (Kenney / KayKit / Quaternius / Megascans, impostor baking for vegetation) is a **separate concern** with its own pipeline (see the asset-library manifest/pools system and the Building Recognizer). It intersects this doc only at the shared Horizon-B bake service; it is intentionally out of scope here.

---

## 13. Implementation status (authoritative — E0–E4 shipped, default-ON)

**Shipped: the network elevation solve as the single source of truth for the road y-channel, wired into all three consumers, with every surface layer riding the solved elevation, now DEFAULT-ON.** This is §6a E0–E4 — the actual defect fix, the make-or-break risk, and the default-on blocker (markings-on-surface), all retired.

**Update (E3 + E4).** The elevation solve is now default-on (`config.ts` + `state/store.ts`), verified end-to-end by driving Lower Manhattan in the `verify` skill (continuous roads, markings/sidewalks/crosswalks/decals glued to the surface at eye level, smooth drive preview). `semanticsVersion` bumped to **3**. `roads.ts` gained `surfaceElevSampler` (projects any surface-layer vertex onto the centerline to read the road's added elevation) and a `layerProfile` helper; `geometry.ts:raisedRibbonGeometry` takes a per-point `base` profile (sidewalk slabs ride the lift); the elevation seam (`corridor/index.ts`) exposes `nodeElevation(key)` so junction discs sit on the solved node height. Flat roads keep the exact legacy global-Y constants (byte-identical). 128/128 tests, `tsc --noEmit`, and prod `vite build` all green.

### What's built

| File | Role |
|---|---|
| `src/procgen/corridor/config.ts` | Feature flag (`isCorridorElevationEnabled`, default **off**), per-class grade caps, solver tuning, `withCorridorElevation` test helper |
| `src/procgen/corridor/graph.ts` | **E0** `buildRoadGraph` — nodes (endpoint/joint/junction), edges, grade-sep pins; scope mirrors `analyzeRoadNodes` (drivable, non-tunnel); drops self-loops/paths |
| `src/procgen/corridor/elevation.ts` | **E1** `solveNetworkElevation` — 2a node relaxation (projected Gauss-Seidel) + 2b per-edge C¹ profile; bridge eased-ramp shaping reading solved feet |
| `src/procgen/corridor/index.ts` | **E2** `buildRoadElevation` seam — network solve when on, byte-identical legacy adapter when off; memoised per (roads array, flag) so one build = one solve |
| `roads.ts` / `physics/colliders.ts` / `export/semantics.ts` | All read the seam; flat segments keep the scalar-height fast path (legacy parity), relief promotes to a per-point profile |
| `state/store.ts` · `app/buildCity.ts` · `ui/Toolbar.tsx` | `useCorridorElevation` state + `rebuildWithCorridorElevation` in-place rebuild + "🛣️ Road elevation" toolbar toggle |
| `src/__tests__/corridorElevation.test.ts` | 13-test invariant suite (below) |

### Design decisions (as executed)

1. **Node solve = projected Gauss-Seidel** (config §9.4): pins for grade-separated structure nodes, Laplacian pull toward base + neighbours, then projection into the intersection of incident grade-cap intervals. Empty interval ⇒ deterministic midpoint compromise (infeasible geometry never crashes/diverges). Fixed 80-iteration budget, key-sorted traversal.
2. **Per-edge profile = C¹ cubic Hermite** between solved node heights. At a **degree-2 joint** both edges share one through-tangent (finite-difference of the far-neighbour heights) ⇒ **C¹**. At a **degree-≥3 junction** every arm meets the shared node height ⇒ **C⁰**. Grades clamped to the class cap.
3. **Bridges keep the eased ramp/hump shape** but read the *solved* foot elevations, so a viaduct's interior nodes pin high and the climb **distributes back across the approach chain** — the concrete fix for over-grade ramps forced into one short segment.
4. **DEM deferred, seam left open.** `baseHeight(key)` returns 0 today; a snapshotted DEM sample plugs in there with zero downstream change (old P3 → E6, optional).
5. **Default-off**, mirroring `useLibraryAssets`: flag-off reproduces legacy elevation exactly (whole suite green), so the feature is instant-A/B and zero-regression.

### Verification

- **105/105 tests green**, `tsc --noEmit` clean, production `vite build` clean.
- **Real-city solve** (Lower Manhattan `raw_osm.json`): `stats.converged === true`, **0 grade violations**, every road profile finite, and **bit-for-bit reproducible** across runs — the convergence/determinism gate the re-scope demanded before funding anything downstream.
- Invariants proven: determinism, grade-cap-on-every-at-grade-edge (≤1.6× cap, matching the legacy eased-ramp allowance), C¹-at-joint, C⁰-at-junction, bounded vertical curvature, bridge deck reaches layer height, short-bridge climb distributes to the approach, and renderer↔math parity **generalised to elevated at-grade roads** (not just bridges).

### Resolved (E4) and remaining gaps

- **✅ Markings / sidewalks / surface decals / crosswalks / junction discs now ride the solved surface** (E4). Each surface-layer vertex reads the road's added elevation via `surfaceElevSampler` (project-to-centerline) and keeps its former offset *relative to the road* — the §1.4 "global-Y stops meaning *above* on a slope" failure is fixed. Flat roads return a constant 0 from the sampler, so the legacy global-Y constants are reproduced byte-for-byte. Bridge **decks** still skip markings in this pass (decks are elevated but unpainted — a small follow-up, not a default-on blocker).
- Junctions are still **C⁰ only** (shared height, not matched grade) — correct for intersections; real junction meshes with kerb returns are **E5**. Discs now sit on the solved node height (were pinned to the legacy `bridgeElev`).
- Bridge↔approach transitions are **C⁰ with a best-effort eased on-ramp** (the ease starts at grade 0); full C¹ across structure boundaries rides on E5.
- No crown/camber or superelevation yet (**E4b**) — the carriageway is laterally flat; longitudinal grade is solved and continuous.

**Next:** E4b (crown/camber + banking, no DEM needed) or E5 (real junction meshes) — the top remaining no-DEM realism levers. Separately, the *faithful traffic core* (signs, signals, speed-limit semantics per Road-updates.md §8) is the highest-value product work now that continuous roads are on.

---

## 14. Road Width Scaling — the car-game "stretch roads" trigger  ✅ SHIPPED

**Status:** built, tested (13-case suite + real-city robustness), and verified end-to-end in the app (drivable roads widen, buildings set back, drive preview works at eye level). Files: `src/procgen/roadScale.ts`, wired through `app/buildCity.ts` (pristine-graph + `rebuildWithRoadScale`), `state/store.ts` (`roadScale`), `ui/Toolbar.tsx` ("↔️ Road width" slider, 1–3×, commit-on-release).

**Goal (product).** Roads are the real product of this app. A car game needs *wide* roads — more room for the car, more interesting driving. Give the user a **trigger (a slider / number)** that widens the drivable carriageways by a multiplier `k`, and have the city **make room** for the wider roads so the result stays aesthetic (no buildings buried under asphalt). Only **roads** change *size*; everything else keeps its size and is *displaced* just enough to accommodate. Bridges are handled too.

### 14.1 What is a road (and what is not)

The City Graph already separates concerns, so "what is a road" is answered by the data model, not a guess:
- **Roads** = `CityGraph.roads`. For the car-game trigger the *widened* set is the **drivable** roads (`!NON_DRIVABLE` → excludes `footway`/`cycleway`/`pedestrian`). Footpaths keep their width — a 3× footpath looks wrong and isn't the point.
- **Not roads, keep their size, may be displaced:** `buildings`, `points` (trees/lamps/props), `barriers`.
- **Not roads, untouched:** `areas` (grass/park/**water**) and terrain. Asphalt spilling onto grass reads as natural, and leaving water alone keeps the whitelist/carve invariants (`terrainCarve.test.ts`) intact.

### 14.2 Algorithm — width scale + a penetration-resolution displacement field

A pure, deterministic transform `scaleRoadNetwork(graph, k) → CityGraph` (identity at `k = 1`), applied at build time so the renderer, colliders, semantics and drive preview all consume the same scaled graph:

1. **Widen carriageways.** For every drivable road, `widthM ← k · widthM`. Centerlines are **unchanged** — roads get fatter in place, they don't move or lengthen. Because every downstream geometry (lanes, markings, curbs/sidewalk offsets, junction-disc radius, bridge deck/fascia/rails/piers, road & rail colliders) is derived from `widthM`/`half` in `roads.ts` and `colliders.ts`, the scale propagates for free — including **bridges**.

2. **Displace non-road features out of the widened corridors.** The precise, minimal, good-looking transform is **penetration resolution**: move a feature only if a widened road now overlaps it, and only by the amount needed to sit back at the new road edge.
   - For a query point `p`, for each nearby **at-grade drivable** road edge `i` with new half-width `h′ᵢ = k·widthMᵢ/2`: let `rᵢ` = perpendicular distance from `p` to the edge's centerline (clamped to the edge span, rounded caps at endpoints) and `n̂ᵢ` = unit outward normal (centerline→`p`). The push is `n̂ᵢ · max(0, h′ᵢ + margin − rᵢ)`.
   - `d(p) = Σᵢ pushᵢ(p)`. Far features (`rᵢ > h′ᵢ`) get **zero** push → they don't move (unlike a global scale, which drags the whole map). Roadside features get set back exactly to the new curb + margin. This *is* the "city expands where the roads got wider" behaviour, done locally and precisely.
   - **Buildings** translate **rigidly** by the largest-magnitude `d(v)` over their footprint vertices (the most-encroached corner dictates the setback), so footprints keep their shape and the whole building clears the road it faces. **Points/barriers** move by `d(position)`.

3. **Bridges are excluded from the displacement field** (they still widen in step 1). An elevated deck passes *over* ground features, so shoving a building away from a bridge's ground projection would be wrong. Widen the deck; leave what's underneath. Tunnels likewise contribute no displacement.

**Performance.** Non-road-point × road-edge is O(N·M); at interactive slider rates that's too much. Road edges are binned into a **uniform spatial grid** (cell ≈ max influence radius); a query gathers only edges from its cell + 8 neighbours → near-O(1) per point. Fully deterministic (no RNG, fixed traversal).

### 14.3 Integration & controls

- **Pristine graph.** `buildCity` keeps the un-scaled ingested graph; every rebuild path (library assets, corridor elevation, road scale) derives its working graph as `scaleRoadNetwork(pristine, roadScale)` so scaling **composes** with the other toggles and never compounds.
- **Trigger UI.** A Toolbar slider (`k` from 1.0× to 3.0×, step 0.25) + reset, committing the rebuild on release (scene rebuild is heavy). Store: `roadScale` (default 1) + `setRoadScale`; `rebuildWithRoadScale(k)` rebuilds in place.
- **Tests** (`roadScale.test.ts`): drivable widths scale and paths don't; bridges widen; roadside buildings/props displace out of the widened ribbon while far ones stay put; no building overlaps a widened drivable road after transform; features under a bridge stay; water/areas untouched; `k = 1` is identity; deterministic.

### 14.4 Known limits (v1)

- Penetration resolution is **per-road-superposed**, not a full collision relaxation, so in an unusually narrow block two opposite setbacks can bring buildings close; a light building-vs-building relax pass is a follow-up.
- Displacement uses 2-D centerline distance; correct for at-grade roads (bridges already excluded).
- `lat/lng` on displaced features become slightly stale (metres); appearance/recognizer already resolved pre-scale, so this is cosmetic.
