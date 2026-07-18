# Modular Road Asset System — Procedural, Data-Conforming Road Generation

**Status:** Design reference · **Owner:** rendering/procgen · **Scope:** the complete asset catalogue for an OSM-driven driving-training simulator (React + Three.js / WebGL)

> **Architectural decision (fixed by the project owner):** the road asset library is a set of **procedural module generators** — parametric `THREE.BufferGeometry` emitted at build time to conform to arbitrary OSM widths, curves and intersections — **not** a Blender GLB road kit. Fixed-width GLB tiles cannot conform to real OSM geometry (variable width, curvature, N-way junctions, superelevation), so they are rejected as the primary path. Curated GLB is used **only** for detail props (guardrails, signs, lamps, benches, bins, bollards) placed by the existing placement engine (`src/procgen/props.ts`, `signMath.ts`). This document specifies how every asset category is generated procedurally against a road **centerline + cross-section**, and how the detail-prop GLB layer snaps onto it.

This is the concrete asset-catalogue companion to two existing plans that must be read first:
- `docs/road-corridor-redesign.md` — the elevation solve, the layer/depth conventions, the staged corridor pipeline (E0–E7), junction consolidation (§15), road-width scaling (§14).
- `docs/aaa-improvements-plan.md` — the flicker/marking fix, InstancedMesh2 for variation/LOD, the "road-kit tiles can't conform" verdict (which this document formalizes).

---

## 1. Philosophy & constraints

### 1.1 Conform-to-data, not tile-to-grid

The engine reconstructs roads from OSM polylines in local ENU meters (`RoadSegment.points`, `types.ts`). Widths (`widthM`), lane counts (`lanes`), curvature and junction valence are all continuous, data-derived values. A GLB kit tile is a discrete, fixed-width mesh; snapping tiles to a 12 m arterial that narrows to 7 m across a curve and forks into a 5-arm junction produces seams, width mismatches and impossible corners. Therefore **every road-surface asset is generated as a swept/lofted `BufferGeometry` parameterized by the same reference centerline and a per-class cross-section** — the method already implemented in `src/procgen/roads.ts` and `src/procgen/geometry.ts`.

The core generation primitives already exist and are the building blocks for the whole catalogue:

| Primitive | File · function | What it produces |
|---|---|---|
| Reference-line smoothing | `geometry.ts` · `smoothPolyline` | centripetal Catmull-Rom resample at 4 m spacing, endpoints pinned (OpenDRIVE-style evaluator seam) |
| Densification | `geometry.ts` · `densifyPolyline` | inserts points so no segment exceeds `maxSpacing` (bridges use 8 m) so 2-point OSM ways sample their elevation hump |
| Lateral offset | `geometry.ts` · `offsetPolyline` | miter-clamped parallel line at any signed offset; collapses fold-overs at sharp corners |
| Flat ribbon | `geometry.ts` · `ribbonGeometry` | strip between two edge polylines at a constant Y **or** a per-point Y profile |
| Raised slab | `geometry.ts` · `raisedRibbonGeometry` | top face + vertical skirts (curbs, sidewalks, plazas), with a per-point `base` profile so it rides a lifted road |
| Vertical wall | `geometry.ts` · `wallGeometry` | fascia, parapet, retaining wall, spandrel — polyline extruded between two Y profiles |
| Merge / weld | `geometry.ts` · `mergeGeometries` + `three` `mergeVertices` | one draw call per material, coincident-vertex dedup |

Everything below is expressed in terms of these primitives so it drops into the existing build with no new geometry framework.

### 1.2 WebGL / Three.js budget realities

- **Draw calls are the hard limit**, not triangles. The renderer already merges all sidewalks/curbs into one mesh, all white markings into one, all bridge structure into one per-material mesh, and instances furniture (`buildRoads` / `buildFurniture`). Every new category must merge-per-material or instance.
- **Depth precision is load-bearing.** The flat paint stack (road → markings → decals → junction → crosswalk → sidewalk) lives inside a compressed vertical band resolved by a **logarithmic depth buffer** (`editor/depthConfig.ts` `DEPTH_CONFIG.logarithmicDepthBuffer`, `LAYER_CONVENTION`, `MIN_SEPARATION = 0.004`). `polygonOffset` is silently ignored under log-depth; layers must be separated by real millimetric Y and/or the `planarUvXZ` idempotent-overdraw trick. Any new flat surface must claim a layer in `LAYER_CONVENTION` and pass `flickerInvariants`.
- **No per-frame allocation.** Generation is a build-time step; the scene is otherwise static. Determinism (`hash01`, `seededRandom`) is mandatory — no `Math.random`, no wall-clock.

### 1.3 Driver-training fidelity, not arcade

The output feeds a **driving-training simulator**: geometry and semantics must be *correct*, not merely pretty. This drives several rules that an arcade kit would ignore:
- Grade-limited longitudinal profiles by class (`corridor/config.ts` `GRADE_CAPS`) so ramps are drivable.
- Region-correct markings, sign faces, driving side, speed units (`resolver`, `signMath.ts` `speedUnitFor`/`displaySpeed`/`effectiveSpeed`).
- Curbside/clearance placement so no device or prop ever stands in a live lane (`CarriagewayIndex`, `curbsideDevicePosition`).
- One elevation source shared by renderer, colliders and semantics (`corridor/index.ts` `buildRoadElevation`) so what the learner sees is what the physics enforces.

### 1.4 OSM tags drive generation

Generation reads only the resolved `CityGraph` (`RoadSegment`) plus the `RoadResolution` cross-section from the Context Resolver. The tag → parameter mapping is the contract:

| OSM / resolved field | Drives |
|---|---|
| `roadClass` | width defaults, marking pattern, grade cap, furniture eligibility, surface set |
| `widthM` | ribbon half-width, junction disc radius, offsets for every lateral asset |
| `lanes`, `oneway` | centerline vs lane-line markings, turn arrows, stop-line lateral extent |
| `turnLanes` | per-lane guidance arrows (`pushTurnArrow`) |
| `bridge`, `tunnel`, `layer` | structure generation, deck elevation (`BRIDGE_LAYER_H`), portal frames |
| `roundabout` | roundabout meshing (see §3.3) |
| `maxspeedKmh` | sign face value (`effectiveSpeed`) |
| `structure` / `wikidata` | landmark bridge recognition (`buildSuspensionBridge`, `buildArchBridge`) |
| `RoadResolution.surface` | PBR material set (`roadMaterial`) |
| `RoadResolution.marking` | center color/pattern, crosswalk style |
| `RoadResolution.crossSection` | `sidewalks`, `sidewalkWidth`, `curbHeight` |

---

## 2. Canonical dimensions & average-size table

All values are **local ENU meters**, **Y-up** (the whole procgen system works in the XZ plane with Y up; see `geometry.ts` header). The road/paint stack Y-heights are the compressed layer convention (`editor/depthConfig.ts` `LAYER_CONVENTION`); they are surface-relative once the elevation solve lifts a road (`surfaceElevSampler` in `roads.ts`).

### 2.1 Anchor / orientation conventions (apply to every asset)

| Convention | Rule |
|---|---|
| **Up-axis** | +Y everywhere. GLB detail props must be Y-up (aaa-plan P2 "detect non-Y-up GLBs"). |
| **Swept-asset pivot** | the **road centerline at grade** (`RoadSegment.points`, smoothed by `smoothPolyline`). Every lateral asset is defined by a signed lateral offset from this line and a Y taken from the road's solved elevation profile. |
| **Point-prop pivot** | base center on the ground (`translate` puts the geometry's origin at the mount point; e.g. lamp pole `translate(0, 3.7, 0)` so origin sits at grade). |
| **Default orientation** | props face local **+Z**; `deviceHeading(near, faceOncoming)` (`signMath.ts`) yaws +Z to the road tangent; signs rotate 180° to confront oncoming traffic, signal heads align with travel. |
| **Placement Y** | `Placement.y` (`props.ts`) = road-surface elevation at the station (0 = grade); furniture on a curbed sidewalk adds `CURB_H` (0.22 m). |

### 2.2 Master dimension table

| Asset | Real-world average | Local ENU value | Pivot / anchor | Source in code |
|---|---|---|---|---|
| Lane width | 3.0–3.65 m | `widthM / lanes` | centerline | `roads.ts` (`r.widthM / r.lanes`) |
| Carriageway (2-lane) | ~7 m | `widthM` from resolver | centerline | `RoadSegment.widthM` |
| Road surface Y | flush | `Y_ROAD = 0.05` | centerline @ grade | `roads.ts` |
| Path surface Y | flush | `Y_PATH = 0.046` | centerline @ grade | `roads.ts` |
| Lane markings Y | paint | `Y_MARK = 0.055` (+5 mm) | rides surface | `roads.ts`, `LAYER_CONVENTION` |
| Lane line width | 0.10–0.15 m | ±0.08 m half (0.16 m) | offset from line | `dashedLine`, solid marking |
| Double-yellow gap | ~0.10 m | offsets ±0.18 m, ±0.06 m | centerline | `roads.ts` double-solid |
| Wear decal Y | on surface | `Y_DECAL = 0.06` | rides surface | `roads.ts` |
| Junction disc Y | on surface | `Y_DISC = 0.065` | node @ solved elev | `roads.ts` |
| Crosswalk Y | on junction | `Y_CROSSWALK = 0.07` | rides surface | `roads.ts` |
| Crosswalk stripe | 0.5–0.6 m wide, 2.2 m long | half 0.3–0.4 m, halfLen 1.1 m, pitch 1.6 m | approach mouth | `roads.ts` crosswalk loop |
| Stop line | 0.3–0.6 m bar | halfLen 0.3 m, set back `STOP_LINE_DIST = 3.15` m | approach | `roads.ts` |
| **Curb height** | **0.15 m** (std); engine 0.22 | `curbHeight` (resolver) / `CURB_H = 0.22` | road edge, base rides surface | `raisedRibbonGeometry`, `props.ts` |
| Sidewalk width | 1.5–3.0 m | `sidewalkWidth` (resolver) | offset `half+0.05` → `half+sw` | `roads.ts`, `CrossSectionSpec` |
| Sidewalk top Y | real curb | `0.22` | above road | `LAYER_CONVENTION` |
| Plaza curb slab | ~0.14 m raised | `PLAZA_CURB_H = 0.14` | plaza edge | `roads.ts` |
| Lamp (cobra) | 7–9 m pole | pole 7.4 m (`translate 0,3.7,0`), arm at 7.3 m, +2.0 m reach | base @ ground | `props.ts` `lampGeometry` |
| Lamp (heritage) | ~4 m | lantern at 7.6 m in same pole (heritage variant) | base @ ground | `props.ts` |
| Traffic signal | pole ~4.6 m, head 0.3×1.0×0.26 m | pole 4.6 m (`y=2.3`), head at 4.4 m | base @ ground | `props.ts` `buildTrafficSignal` |
| Signal lamp | Ø ~0.3 m | sphere r=0.09, ±0.3 m spacing | on head | `props.ts` |
| Sign plate (EU circle) | Ø 0.6–0.9 m | cylinder r=0.38, at 2.6 m | pole top | `props.ts` `signGeometry` |
| Sign plate (US rect) | 0.6×0.75 m | box 0.6×0.75×0.04 m at 2.6 m | pole top | `props.ts` |
| Sign pole | ~2.5 m | cylinder 2.6 m (`y=1.3`) | base @ ground | `props.ts` |
| Bench | 1.5–1.8 m | 1.7 m seat @ 0.45 m, back @ 0.75 m | base @ ground | `props.ts` `benchGeometry` |
| Bin | ~0.9 m tall, Ø 0.5 m | cyl 0.85 m, r 0.24–0.28 | base @ ground | `props.ts` `binGeometry` |
| **Guardrail / barrier** | **0.75–0.9 m** | rail top ~0.8 m (new) | curb line offset | §3.14 (new) |
| Bollard | 0.9–1.1 m, Ø 0.1–0.3 m | ~1.0 m (new) | curb/edge | §3.20 (new) |
| Median (raised) | 1.0–4.0 m wide | resolver-driven (new) | centerline | §3.11 (new) |
| Bridge deck layer | grade separation | `BRIDGE_LAYER_H = 6.5` m × `layer` | centerline | `roadNetwork.ts` |
| Bridge fascia | ~0.9 m below deck | `deck − 0.9` | deck edge | `roads.ts` |
| Bridge rail top | ~1.05 m above deck | `deck + 1.05` | deck edge | `roads.ts` |
| Bridge pier | Ø ~1.7–2.0 m | cyl r 0.85→1.0, every 22 m, only if deck > 3.5 m | station point | `roads.ts` |
| Suspension tower | span-scaled | `clamp(L*0.16, 24, 130)` m | 30%/70% span | `bridges.ts` |
| Arch span pitch | ~28 m | `clamp(round(L/28), 3, 20)` spans | centerline | `bridges.ts` `buildArchBridge` |
| Arch parapet | ~1.05 m | `parapetH = 1.05`, `deckThk = 0.7` | deck edge | `bridges.ts` |
| Tunnel portal | jamb 0.9 m, height 5.4 m | boxes at ±(half+0.5), lintel `width+1.9` | end node | `roads.ts` `portalGeometry` |
| Tree (broadleaf) | 6–12 m | trunk 2.6 m × scale, canopy icosahedron | base @ ground | `props.ts` `speciesGeometry` |
| Manhole | Ø ~0.6 m | quad half 0.45 m | on surface | `roads.ts` |

### 2.3 The three placement-engine rules (cross-reference)

Every lateral/point asset obeys the placement engine's three invariants; new categories must too:

1. **Curbside offset** — a device mapped on the carriageway is moved perpendicular to the driving side, just past the curb (`curbsideDevicePosition`, `signMath.ts`): `off = half + 0.7`. Generated furniture offsets to `half + margin` (`props.ts`: lamps `half+1.1`, benches `half+1.6`, bins `half+0.9`, signs `half+0.8`).
2. **Network clearance** — no generated placement may stand inside *any* drivable carriageway, not just its own road: `CarriagewayIndex.insideCarriageway(p, margin, excludeId?)` (`props.ts`) proves clearance against the whole network via a uniform spatial grid.
3. **Elevation-riding** — every prop takes `Placement.y` from the shared elevation seam (`buildRoadElevation().profileFor`) so it stands on ramps/decks, plus `sidewalkCurb(r)` (0.22 m) when it sits on a curbed band. OSM props on a dropped bridge sidewalk clamp onto the nearest drivable deck edge (`placeOsm` in `props.ts`).

---

## 3. Asset catalogue

Each subsection states: **inputs**, **generation rule**, **standardized dimensions**, **connector interface**, **slope/curvature constraints**, **UV convention**, **PBR material**, **LOD**, **instancing**, **collision**, **regional variants**. Categories marked **[built]** exist today; **[new]** are specified against the same primitives.

### 3.1 Road segments & lane variations **[built]**

- **Inputs:** `RoadSegment` (`points`, `widthM`, `lanes`, `oneway`, `roadClass`), `RoadResolution.surface`.
- **Generation:** `segCenterline(r)` → `smoothPolyline` (+`densifyPolyline` for bridges); `left/right = offsetPolyline(surfacePts, ±half)`; `ribbonGeometry(left, right, profile)` where `profile` is a scalar Y (flat fast-path) or per-point (elevated). Trimmed at junctions to the cluster patch boundary or `junctionRadius*0.72`.
- **Dimensions:** width `widthM`; lane width `widthM/lanes`; Y `Y_ROAD`/`Y_PATH`.
- **Connector:** shares the smoothed centerline; neighbours snap because trims stop at the same junction patch; UVs in meters (`w`, arc-length `dist`) so texture flows along the segment.
- **Slope/curvature:** longitudinal grade from the elevation solve (per-class caps, `config.ts`); a flat segment keeps the exact up-normal fast path; the `offsetPolyline` miter clamp (≤2.2) prevents ribbon spikes at sharp curves; fold-over collapse protects tight radii.
- **UV:** arc-length swept (`ribbonGeometry` bakes meters); paths use world-planar `planarUvXZ` so overlapping plaza polylines paint identical texels.
- **PBR:** `roadMaterial(set, uvSeed)` with `withMacroVariation` (world-position brightness noise to kill 6 m tiling) + per-segment UV offset via `clone()`.
- **LOD:** merge candidate; distant tiers can drop normal/roughness maps. Future: mesh decimation on straight runs.
- **Instancing:** no (unique geometry); merged per-material where possible.
- **Collision:** road collider reads the same `edgeProfile`/centerline (`physics/colliders.ts`, redesign §5).
- **Regional:** surface set (`asphalt-*`, `cobble`, `pavers`, `gravel`) from resolver; arcade vs realistic via `setRoadStyle`.

**Lane variations** (per-class cross-section) are the natural extension point for the corridor-mesh sweep (redesign Stage 5): `[shoulder | lane×N | shoulder]` today is implicit in `widthM`; a swept cross-section template makes each strip explicit (see §4).

### 3.2 Intersections **[built]**

- **Inputs:** `analyzeRoadNodes` (drivable, non-tunnel node valence + max width), arm directions.
- **Generation:** for each junction node, mesh the **convex hull of arm mouths** (`junctionArmHull` → `convexHull` → `junctionPatchGeometry`) — a polygon that hugs the roads rather than a fat disc bulging into grass. Arms trim back with a **bell-mouth-style setback** = `junctionRadius(p)*0.72 - 0.6`. Consolidated clusters (redesign §15) union member discs (`polygon-clipping`) into **one merged patch at one solved height**.
- **Dimensions:** disc radius `discRadius(maxWidth) = maxWidth*0.58`; setback ~`0.72×` that.
- **Connector:** patch sits at `nodeElevation(k) + Y_DISC`; arms trim to the patch boundary (`clusterExitTrim`) so ribbon and patch meet without co-planar overlap.
- **Corner fillets / curb-return radii:** today approximated by the hull + setback; **[new]** kerb-return arcs (arc radius by turn geometry) are redesign E5 (`corridor/junction.ts`), stitched to arm end-rings.
- **Slope:** C⁰ at the node (all arms share the solved height); C¹ grade-matching is E5.
- **UV:** `planarUvXZ` (idempotent overdraw for overlapping discs).
- **PBR:** `roadMaterial('asphalt-worn')`.
- **Collision:** intersection collider at the aliased node height (redesign §15 consistency note).
- **Regional:** crosswalk/stop-line rules gate by class and region.

### 3.3 Roundabouts **[new — spec]**

- **Inputs:** `RoadSegment.roundabout` (OSM `junction=roundabout|mini_roundabout`, implicitly oneway).
- **Generation:** a roundabout way is a **closed centerline loop**; build the annular carriageway by `offsetPolyline(loop, ±half)` and `ribbonGeometry` on the closed ring (wrap the index). The central island is a `raisedRibbonGeometry` (curb slab) filling the inner offset, planted with vegetation. Approach arms trim to the outer ring exactly like junction arms (`clusterExitTrim` analogue).
- **Dimensions:** island Ø from loop radius; truck apron ~1–2 m as a flush inner annulus; entry deflection from arm geometry.
- **Connector:** shared loop centerline; each entry/exit snaps to the ring station where its centerline meets the loop.
- **Slope:** flat or single-plane cross-fall; grade continuous with approaches via the solve.
- **UV / PBR:** swept arc-length along the ring; asphalt + a solid or dashed circulatory edge line (yellow/white per region).
- **Collision:** ring collider + island collider.
- **Regional:** direction of circulation follows `drivingSide`; mini-roundabouts render as a painted dome (flush decal) rather than a raised island.

### 3.4 Elevation transitions (ramps, grade limits) **[built]**

- **Inputs:** solved `edgeProfile` / `rampSpecFor` (`roadNetwork.ts`), `MAX_RAMP_GRADE = 0.06`, class caps (`config.ts`).
- **Generation:** per-point Y profile fed to `ribbonGeometry`; bridge approaches use an eased ramp `ease()` distributing climb over `rampLen = clamp(fullElev/MAX_RAMP_GRADE, 40, …)`; `shortSpanElevCap = grade·L/π` prevents absurd spikes on short spans.
- **Dimensions:** ramp length from grade cap; deck target `BRIDGE_LAYER_H × layer`.
- **Connector:** C¹ through degree-2 joints (shared tangent), C⁰ at junctions.
- **Slope:** the whole point — every drivable edge stays ≤ its class cap where geometry allows.
- **Collision:** collider reads the same profile.

### 3.5 Cuttings & embankments **[new — spec, redesign Stage 4]**

- **Inputs:** where corridor `z(s)` diverges from terrain `H`; right-of-way width by class.
- **Generation:** a **batter slope** `wallGeometry`/ribbon skirt from the shoulder edge down/up to terrain (fill ≈ 1:2, cut ≈ 1:1.5), welded to the terrain heightfield seam. Where |Δh| exceeds the slope budget → flag a retaining wall (§3.9) instead.
- **Connector:** outer batter edge shares terrain boundary vertices (welded seam → no z-fight by construction).
- **UV:** swept arc-length; grass/rock material blended by slope.
- **Collision:** part of the terrain heightfield collider.

### 3.6 Bridges — modular components **[partly built]**

Bridges are the priority "break into modular components" category. The generic drivable bridge today emits deck ribbon + fascia + rails + piers inline in `buildRoads`; landmark bridges use dedicated generators (`bridges.ts`). The table below decomposes a bridge into the component modules a driver-training bridge needs, each with dimensions, pivot, connector and slope rule. Components marked **[built]** exist; **[new]** are specified against the same `wallGeometry`/`ribbonGeometry`/`boxAt`/`extrudeTri` primitives.

| Component | Inputs | Generation rule | Dimensions | Pivot | Connector | Slope rule |
|---|---|---|---|---|---|---|
| **Approach embankment** [new] | `z(s)` vs `H`, rampSpec | batter skirt from deck-foot to grade | fill 1:2 | shoulder edge | welds to at-grade ribbon + terrain | grade-capped ramp |
| **Abutment** [new] | deck end station, `z(s)` | `wallGeometry` end wall + wing walls | deck width + wings | deck end node | carries deck onto embankment | vertical face |
| **Pier** [built] | station every 22 m, `elevHere` | `CylinderGeometry(0.85,1.0,elevHere-0.35,10)` when deck > 3.5 m | Ø ~1.7 m, height = clearance | station point on centerline | stands under deck at `z(s)` | vertical; height from `elevHere` |
| **Bearing** [new] | pier top + deck soffit | small `boxAt` cap block between pier and deck | ~0.6×0.4 m | pier top | transfers deck to pier | flat cap |
| **Deck** [built] | `surfacePts`, `profile` | `ribbonGeometry(left, right, profile)` per segment (or unified for arch landmarks) | `widthM`, Y = `BRIDGE_LAYER_H·layer + Y_ROAD` | centerline | part of corridor mesh (deck↔approach continuous) | per-point profile |
| **Expansion joint** [new] | deck segment boundaries | thin transverse `pushQuad` decal band | ~0.1 m wide | station | marks deck-segment seams | rides deck |
| **Parapet / fascia** [built] | deck edge, `deck` profile | `wallGeometry(left, deck-0.9, deck+1.05)` — only where deck > 0.8 m above grade (consolidation fix) | fascia 0.9 m down, rail 1.05 m up | deck edge | runs along deck edges | follows deck profile |
| **Railing** [built via fascia+rail] | deck edge | top edge of the fascia wall = rail; **[new]** open baluster railing as instanced posts | rail top ~1.05 m | deck edge | continuous along run | follows deck |
| **Arch** [built] | span pitch, rise | segmental barrel soffit + spandrel `wallGeometry` (`buildArchBridge`) | pitch `clamp(round(L/28),3,20)`, rise `clamp(openHalf*0.72,…)` | pier spring points | soffit closes between piers | arch geometry |
| **Cable** [built] | tower tops, sag | `TubeGeometry` catenary main cable + `CylinderGeometry` suspenders (`buildSuspensionBridge`) | radius `max(0.35, half*0.045)`, sag `towerH*0.86` | tower tops | anchors at deck ends | parabolic |
| **Truss** [new] | deck edges, panel pitch | instanced diagonal `boxAt` members along `wallGeometry` chord lines | panel ~6–8 m | deck edge | repeats along span | follows deck |
| **Ramp** [built] | rampSpec | eased approach profile (see §3.4) | `rampLen` | centerline | joins deck to grade | grade-capped |
| **Transition piece** [new] | deck end ↔ approach | short blended ribbon matching deck width to approach width | ~5 m | deck end | C¹ width/height blend | matches both grades |

- **Standardized dimensions & pivots:** deck at centerline @ `BRIDGE_LAYER_H·layer + Y_ROAD`; every superstructure component is defined by a lateral offset from the deck edge (`crossAt` in `bridges.ts` gives `left`/`right` edges) and a Y relative to the deck.
- **Connector interface:** all components share the deck centerline sampled by `crossAt(pts, station, half)`; contiguous OSM bridge ways are chained into one centerline by `chainCenterlines` (45 m tolerance) so a bridge split across ways builds one structure.
- **Slope/curvature:** fascia/rails only along genuinely elevated runs (`deck[i]-yBase > 0.8`) so walls never knife through a junction area; decks trim to bridgehead cluster patches (redesign §15).
- **UV:** `wallGeometry` bakes (dist, height) meters; deck arc-length like any ribbon.
- **PBR:** generic structure `#9d9e97` **DoubleSide** (rails are single-quad walls — DoubleSide is load-bearing so they read from the deck side); landmark structure/cable/stone materials from `bridges.ts`.
- **LOD:** cables/suspenders/truss members are the first to drop at distance; deck+fascia persist.
- **Instancing:** piers, suspenders, truss members, balusters are ideal `InstancedMesh` candidates.
- **Collision:** deck + rails from structure output; piers as static colliders.
- **Regional:** landmark opt-in (`scene/landmarks.ts`) chooses suspension vs cable-stayed vs stone-arch; colour (e.g. Golden Gate International Orange).

### 3.7 Tunnels & portals **[built]**

- **Inputs:** `RoadSegment.tunnel`, end nodes with surface transitions.
- **Generation:** no surface ribbon (`continue` in `buildRoads`); a **portal frame** at each end where it meets open air — two jambs + a lintel (`portalGeometry`: boxes 0.9×5.4×1.2 at ±(half+0.5), lintel `width+1.9`).
- **Connector:** portal placed at `pointAlong(r.points, 0.5)` direction; bore interior surface still exists for physics/drive.
- **[new] Bore & liner:** a swept tube (`wallGeometry` ring or half-pipe) for visible tunnel interior; portal-station computed from terrain crossing (redesign Stage 7) rather than "end of segment".
- **PBR:** portal `#8c8d86` roughness 0.95.
- **Collision:** interior surface collider retained.

### 3.8 Retaining walls **[new — spec, redesign Stage 7]**

- **Inputs:** batter cells flagged where slope > budget (§3.5).
- **Generation:** `wallGeometry(edgeLine, terrainY, roadEdgeY)` — a vertical wall from road edge/shoulder to terrain, welded to both.
- **Dimensions:** height = |Δh| at the station; capped by right-of-way.
- **Connector:** shares road-edge and terrain vertices.
- **UV/PBR:** concrete/stone, world-planar or swept.
- **Collision:** static wall collider.

### 3.9 Curbs **[built]**

- **Inputs:** `RoadResolution.crossSection.curbHeight`, `sidewalks`.
- **Generation:** `raisedRibbonGeometry(inner, outer, curbHeight, base)` where `base` rides the road elevation so curbs never float on a grade; inner at `half+0.05`, outer at `half+sidewalkWidth`.
- **Dimensions:** curb 0.15 m (resolver `curbHeight`) / 0.22 m (`CURB_H`, furniture band); sidewalk top Y 0.22.
- **Connector:** curb + sidewalk are one slab; base profile from `layerProfile(walkPts, 0)`.
- **[new] Curb-return wraps** at corners → §3.10.
- **UV:** top face `planarUvXZ` (overlapping corner slabs paint identical texels); skirts (dist,height).
- **PBR:** `sidewalkMaterial` / `mats.curb`.

### 3.10 Sidewalks & corner wraps **[built + new]**

- **Inputs:** cross-section `sidewalks`, `sidewalkWidth`; trimmed at junctions.
- **Generation:** `raisedRibbonGeometry(inner, outer, curbHeight, base)` per side; trimmed back `junctionRadius + sidewalkWidth` (or `clusterExitTrim + sw`).
- **[new] Corner wraps:** at a junction, fill the gap between two arms' sidewalk ends with a filleted corner slab (arc from `junctionArmHull` corners) so the pedestrian surface is continuous around the corner — the sidewalk analogue of the kerb-return fillet (E5).
- **Connector:** shares curb line offset from centerline; corner wrap snaps to both arms' sidewalk end rings.
- **UV:** `planarUvXZ` top so parallel-arm and corner slabs overlap safely.
- **PBR:** `sidewalkMaterial` (2.4 m tile period).
- **Instancing:** merged into one "Sidewalks & curbs" mesh.

### 3.11 Medians & islands **[new — spec]**

- **Inputs:** dual-carriageway detection (parallel drivable ways) or a resolver median flag; refuge islands at wide crossings.
- **Generation:** raised median = `raisedRibbonGeometry` down the centerline gap (curb + optional planting); painted median = a hatched decal band; splitter/refuge island at an approach = a small hull slab.
- **Dimensions:** raised median 1.0–4.0 m wide, curb 0.15 m.
- **Connector:** median centerline offset from the two carriageway centerlines; nose tapers at ends.
- **Collision:** raised median gets a low collider (drive-training: hitting it matters).

### 3.12 Shoulders **[new — spec, redesign Stage 5]**

- **Inputs:** class-based shoulder width (motorway/trunk) in the cross-section template.
- **Generation:** an outer lane strip of the swept ring, same material as carriageway or a distinct shoulder set, edge-marked with an edge line.
- **Connector:** contiguous with the carriageway ribbon (shared boundary).
- **UV/PBR:** swept; edge line as a solid marking (§3.15).

### 3.13 Markings & decals **[built]**

- **Inputs:** `RoadResolution.marking` (centerColor, centerPattern, crosswalk), `lanes`, `oneway`, `turnLanes`, `decalDensity`, region driving side.
- **Generation:** center lines via `ribbonGeometry` of offset polylines (double-solid ±0.18/±0.06, solid ±0.08, dashed via `dashedLine`); lane lines for oneway multi-lane; **crosswalks** as `pushQuad` stripe fans at real junctions only (`realJunction`); **stop lines** on through-classes at `STOP_LINE_DIST`; **turn arrows** (`pushTurnArrow` shaft + head bent by `turnAngle`); **wear decals** (crack/stain/patch/manhole) placed by `DecalPlanner` non-overlap.
- **Dimensions:** see §2.2; all ride the surface via `markElev`/`surfElev` on elevated roads.
- **Connector:** every marking samples the same `markPts` (trimmed centerline).
- **UV:** markings carry **no UV** (merged UV-less mesh; wear comes from `withPaintWear` world-position shader). Decals carry world-planar UV for their texture.
- **PBR:** `mats.markingWhite`/`markingYellow` with `withPaintWear` (world-keyed scuff, live-tunable via `setPaintWear`); `decalMaterials` transparent, `depthWrite:false`, real 30 mm above road (log-depth resolves it — no `polygonOffset`).
- **Collision:** none (paint).
- **Regional:** yellow vs white center, ladder/zebra/continental crosswalk, driving-side stop-line lateral.

### 3.14 Barriers / guardrails / parapets **[new — spec; GLB detail-prop layer]**

- **Inputs:** OSM `barrier=guard_rail`, motorway/embankment edges, bridge parapets (bridge parapet is §3.6 procedural).
- **Generation:** two paths — **(a) continuous procedural** W-beam/cable rail = a swept low `wallGeometry` (rail 0.75–0.9 m) along the road-edge offset line, posts as an `InstancedMesh` at ~2–4 m pitch; **(b) GLB detail prop** for close-up W-beam sections instanced along the same edge line via the placement engine.
- **Dimensions:** guardrail height 0.75–0.9 m; post pitch 2–4 m.
- **Connector:** edge line = `offsetPolyline(centerline, ±(half + shoulder))`; rides `Placement.y` + curb.
- **Slope:** follows the road profile; posts vertical.
- **Instancing:** posts and GLB sections instanced; rail beam merged.
- **Collision:** rail collider (drive-training: barriers must stop the car) — a thin box swept along the edge.
- **Regional:** W-beam vs cable vs concrete Jersey barrier by region/class.

### 3.15 Drainage (gutters, inlets, manholes) **[partly built]**

- **Inputs:** curb line, junction nodes (manholes today).
- **Generation:** **manholes [built]** = `pushQuad` decal at seeded junction nodes (`decalMaterials.manhole`, non-overlap via `DecalPlanner`). **[new]** gutter = a thin flush strip at the curb toe (`ribbonGeometry` at `half` offset, slightly recessed); **inlet** = a small grated decal quad at low points near curbs.
- **Dimensions:** manhole Ø 0.6 m (quad half 0.45); gutter ~0.3 m.
- **UV:** decal world-planar; gutter swept.
- **PBR:** `decalMaterials.manhole`; metal grate material for inlets.
- **Collision:** none (flush).

### 3.16 Signs **[built]**

- **Inputs:** OSM regulatory/speed nodes; generated near segment ends at junctions (probabilistic, seeded); `maxspeedKmh` → face value (`effectiveSpeed`); region `signShape`.
- **Generation:** `signGeometry(shape)` — pole (Ø 0.045→0.055, 2.6 m) + plate (`us-rect` box 0.6×0.75 or circle Ø 0.38) at 2.6 m.
- **Placement:** `curbsideDevicePosition` (past curb, driving side), `deviceHeading(near, faceOncoming=true)` (confronts traffic), clearance via `CarriagewayIndex`, elevation-riding `Placement.y`.
- **Dimensions / pivot:** base at ground, plate at 2.6 m.
- **Instancing:** `addInstanced` (signs stay procedural — no GLB yet).
- **PBR:** `signMat` `#c8cccf`.
- **Regional:** `us-rect` / `eu-circle` / `jp-mix`; speed unit mph vs km/h (`speedUnitFor`, `displaySpeed`).
- **Semantics:** the same `signMath` values feed `export/semantics.ts` so face == enforced limit.

### 3.17 Traffic lights **[built]**

- **Inputs:** OSM `highway=traffic_signals` nodes.
- **Generation:** `buildTrafficSignal` — pole (Ø 0.09→0.11, 4.6 m) + head (0.34×1.0×0.26 at 4.4 m) + 3 emissive lamp spheres (r 0.09, ±0.3 m).
- **Placement:** curbside + heading (aligned with travel, `faceOncoming=false`).
- **Pivot:** base at ground; head at 4.4 m.
- **[new] Mast-arm variant:** cantilever arm over the carriageway for arterials (extend the pole with an arm `boxAt` like the cobra lamp).
- **PBR:** `mats.signalPole/Head`; bulbs emissive (survive day/night + bloom, not unlit).
- **Instancing:** grouped; heads emissive so instancing must preserve per-state color if animated.
- **Regional:** head layout (horizontal vs vertical) by region.

### 3.18 Street lighting **[built]**

- **Inputs:** OSM `highway=street_lamp` (authoritative) + generated on `FURNITURE_ROADS` by `rules.lampSpacing` (zone-aware), alternating sides with seeded jitter.
- **Generation:** `lampGeometry(style)` — `cobra` (pole 7.4 m + 2.2 m arm + head) or `euro-post`/`heritage` (top lantern).
- **Placement:** offset `half+1.1` (or `half-0.55` **inside** the deck edge on bridges so lamps hug the parapet); clearance + `nearExistingLamp` dedup; `Placement.y = elevAt + sidewalkCurb`.
- **Instancing:** `InstancedMesh` per kind; `instanceKindVaried` picks a GLB variant per position when a pool is loaded (aaa-plan P2 multi-template).
- **PBR:** `mats.signalPole`.
- **Regional:** `region.lampStyle`.

### 3.19 Utilities (poles, wires) **[new — spec]**

- **Inputs:** OSM `power=pole`/`line`, telecom.
- **Generation:** pole = tapered `CylinderGeometry` (instanced); wire = catenary `TubeGeometry` between pole tops (reuse the `buildCable` catenary math from `bridges.ts`).
- **Connector:** wires span consecutive pole placements.
- **LOD:** wires drop first at distance; poles persist.
- **Instancing:** poles instanced; wires merged.
- **Collision:** none (overhead) except pole base.

### 3.20 Vegetation **[built]**

- **Inputs:** OSM tree nodes; species mix from GBIF/climate resolver (`resolveTree`); `landCoverAt != water`.
- **Generation:** `speciesGeometry()` — 5 species (broadleaf/columnar/conifer/palm/acacia) as trunk `CylinderGeometry` + canopy primitive; per-instance scale, seeded yaw, HSL tint jitter.
- **Instancing:** `InstancedMesh` per species (trunk + canopy), `setColorAt` per instance; GLB variants via `instanceKindVaried('tree', …)` when pooled.
- **Pivot:** base at ground; canopy stacked on trunk height.
- **LOD:** billboard/impostor at distance (future).
- **Regional:** species mix by climate.

### 3.21 Road furniture (benches, bins, bollards) **[built + new]**

- **Benches [built]:** `benchGeometry` (1.7 m), social zones, sidewalk offset `half+1.6`, faces the street (`rotY+π`).
- **Bins [built]:** `binGeometry` (0.85 m), offset `half+0.9`.
- **Bollards [new]:** Ø 0.1–0.3 m, ~1.0 m tall `CylinderGeometry`, instanced along pedestrian-zone edges / crossing approaches, clearance-checked.
- **All:** OSM-authoritative where mapped (`placeOsm`), else generated by density; `InstancedMesh` per kind + GLB variant path; `Placement.y = elevAt + sidewalkCurb`.

### 3.22 Terrain transitions **[new — spec, redesign Stage 4]**

- Batter/weld/seam between corridor and terrain heightfield (see §3.5). The corridor's outer edge and terrain share boundary vertices → one manifold, no coplanar overlap. Water carving stays whitelist-only (`terrainCarve.test.ts`).

### 3.23 Collision meshes **[built + spec]**

- **Strategy:** colliders are built from **semantics, not mesh clones** (`physics/colliders.ts`), with a versioned `ColliderDescriptor`. Road/sidewalk/junction colliders read the same `edgeProfile`/centerline as the visual (parity-tested). Terrain → `heightfield` collider (redesign §5). Barriers/medians/piers get explicit static colliders. See §7 for the on-thread/off-thread split.

### 3.24 LODs **[spec]**

See §7.3. Every merged mesh gets 2–3 tiers; instanced props use InstancedMesh2 per-instance LOD.

### 3.25 Regional variants **[built]**

Driven by the `RegionPack` (`drivingSide`, `centerline`, `crosswalk`, `signShape`, `lampStyle`) + surface/species resolvers. Every category above lists its regional lever.

---

## 4. Connector & snapping conventions

The unifying contract is **"cross-section at station"**: every asset is a function of a shared reference line and a lateral station. This is what lets procedural modules snap without seams where a GLB kit cannot.

### 4.1 The reference line

- **Reference line = the smoothed road centerline** (`smoothPolyline(RoadSegment.points)`, densified for bridges via `segCenterline`). It is endpoint-pinned so junction topology is untouched, and is the *same* line the collider builder and semantics exporter use — one source of truth.
- Sampling: `pointAlong(pts, d)` → `{p, dir}`; `crossAt(pts, d, half)` → `{p, dir, left, right}` (used by bridges); `cumulative(pts)` → per-point stations.

### 4.2 Lateral offsets (the cross-section stations)

At any station `s`, the cross-section is a set of signed lateral offsets from the reference line, each produced by `offsetPolyline(centerline, offset)`:

| Station | Offset | Asset |
|---|---|---|
| centerline | 0 | center marking, median |
| lane lines | `-half + (widthM/lanes)·k` | lane markings, turn arrows |
| carriageway edge | `±half` | edge line, gutter |
| curb line | `±(half + 0.05)` | curb inner |
| sidewalk outer | `±(half + sidewalkWidth)` | sidewalk outer edge |
| furniture band | `±(half + margin)` | lamps `1.1`, benches `1.6`, bins `0.9`, signs `0.8` |
| barrier line | `±(half + shoulder)` | guardrail |

Because every module offsets from the *same* centerline, two neighbouring modules (curb + sidewalk, deck + fascia, lane + shoulder) share exact boundary geometry and cannot gap or z-fight.

### 4.3 Vertical snapping

- **Pivot at centerline-grade:** the reference line is at grade (Y from the elevation solve, 0 = grade). Every layer adds its convention offset (`Y_ROAD`, `Y_MARK`, curb height) *relative to the surface* via `surfaceElevSampler`/`layerProfile` (`roads.ts`) and `raisedRibbonGeometry`'s per-point `base`. On a flat road the sampler returns 0, so legacy global-Y constants are reproduced byte-for-byte.
- **Junctions:** discs/patches sit at `nodeElevation(k) + Y_DISC`; arms trim to the patch boundary so surfaces meet without co-planar overlap.

### 4.4 Metadata each generated object carries

Every emitted mesh/group carries `userData.objectId` for selection, semantics and collider correlation (e.g. road mesh `userData.objectId = r.id`; merged meshes `net_intersections`, `net_sidewalks`, `net_markings`, `net_bridges`, `net_portals`; furniture `furn_all`). A generated module should carry, at minimum:

| Field | Meaning |
|---|---|
| `objectId` | stable id (segment id, or synthesized `kind:x,z` for generated props — see `instanceKindVaried` seed) |
| `kind` | asset category |
| station range | `[sStart, sEnd]` along its reference line (for LOD/streaming/semantics) |
| side | `+1`/`-1`/`center` (which side of the centerline) |

Generated furniture positions are additionally side-channeled to the collider builder via `furniturePlacements.current` (a module ref) so `userData` never leaks into the exported GLB.

---

## 5. Slope / curvature / dimensional constraints

| Constraint | Value | Source |
|---|---|---|
| Max sustained grade — motorway/trunk | 4% | `config.ts` `GRADE_CAPS` |
| Max grade — primary/secondary | 6% | `GRADE_CAPS` |
| Max grade — tertiary | 7% | `GRADE_CAPS` |
| Max grade — residential/service/unclassified/living_street | 8% | `GRADE_CAPS` |
| Max grade — pedestrian/footway | 12% | `GRADE_CAPS` |
| Max grade — cycleway | 10% | `GRADE_CAPS` |
| Ramp grade cap | 6% (`MAX_RAMP_GRADE`) | `roadNetwork.ts` |
| Short-span elevation cap | `grade·L/π` | `shortSpanElevCap` |
| Min corner-return radius | by road class / turn geometry (E5) | redesign Stage 6 |
| Superelevation | `e ≈ clamp(v²/(g·R) − f, 0, e_max)`, `e_max ≈ 6–8%` | redesign Stage 3 (E4b, not yet built) |
| Crown/camber (straights) | ~2% fall to gutters | redesign Stage 5 (E4b) |
| Miter clamp (offset spikes) | scale ≤ 2.2, `cosHalf ≥ 0.45` | `offsetPolyline` |
| Centerline smoothing | centripetal Catmull-Rom, 4 m spacing | `smoothPolyline` |
| Densification spacing | 8 m for bridges | `segCenterline` → `densifyPolyline` |
| Junction disc radius | `maxWidth × 0.58` | `discRadius` |
| Bridge layer height | 6.5 m × layer | `BRIDGE_LAYER_H` |

**Superelevation note:** banking is the *curve* case (rotate the swept cross-section by `e(s)` about the centerline); crown is the *straight* case (~2% each way); they blend across the transition. Both are E4b and require the cross-section sweep (Stage 5) — today the carriageway is laterally flat, longitudinal grade only.

---

## 6. UV & PBR conventions

### 6.1 UV strategies

| Strategy | When | Function |
|---|---|---|
| **Arc-length swept** `(w, dist)` in meters | road ribbons, decks, walls, fascia | `ribbonGeometry`, `wallGeometry` (bake `dist` cumulatively) |
| **World-planar XZ** `(x, -z)` in meters | any coplanar surfaces that may overlap at one layer (junction discs, sidewalk tops, plazas, paths) | `planarUvXZ` |
| **World-position shader** (no UV) | merged UV-less marking mesh; macro variation | `withPaintWear`, `withMacroVariation` |
| **Per-instance UV offset** | break tiling between adjacent road segments | `roadMaterial(set, uvSeed)` clone with seeded offset |

**Why world-planar for overlap:** overlapping coplanar surfaces that share a material sample identical texels at identical world points, so whichever triangle wins the depth tie paints the same pixel — overdraw is idempotent and z-fighting cannot show (`planarUvXZ` doc comment). This is how junction discs, parallel-arm sidewalks and plaza-over-plaza paths stay flicker-free.

### 6.2 PBR conventions

- **Unlit-authored metallic-roughness** only — no emissive hacks (except signal bulbs, deliberately emissive), no baked light. The editor previews lit; export carries clean PBR (`materials/library.ts` header).
- **World-position macro variation** (`withMacroVariation`): multi-sine brightness modulation keyed to world position kills the 6 m asphalt tile repeat and stays continuous across segment seams (it ignores the per-segment UV offset).
- **Worn-paint shader** (`withPaintWear`): world-keyed scuff/fade so lane lines and crosswalks read as aged paint, not crisp stickers; shared uniform `uPaintWear` (1 = worn/realistic, 0 = crisp/arcade), live-tunable via `setPaintWear`, no rebuild.
- **Texel density targets:** asphalt/road normal + albedo tile to `ROAD_TILE_M` (6 m period, albedo and normal share the period so aggregate stays registered); sidewalk 2.4 m; facade `FACADE_TILE_M`; roof 4 m.
- **The compressed paint-layer stack** (`LAYER_CONVENTION`, `MIN_SEPARATION = 0.004`): road 0.05 → markings 0.055 → decals 0.06 → junction 0.065 → crosswalks 0.07 → sidewalk 0.22. Paint sits ~5 mm above the road so tires don't clip it; log-depth resolves the gaps; `polygonOffset` is ignored under log-depth so real Y + `planarUvXZ` are the only tools.

---

## 7. Optimization

### 7.1 Instancing

- **Repeated furniture → `InstancedMesh`** (`buildFurniture` `addInstanced`): lamps, benches, bins, signs, trees (per species, `setColorAt` per instance). Piers, suspenders, truss members, guardrail posts, bollards, utility poles are all instancing candidates.
- **InstancedMesh2 (agargaro, MIT)** — per-instance frustum cull + LOD + per-instance color/scale (aaa-plan "Best things to borrow"). This is the target for the whole prop layer: multi-template per kind (`instanceKindVaried` already picks a GLB variant per position/id), per-instance LOD, and culling for large cities.

### 7.2 Merged geometry per material

- **One mesh per material** via `mergeGeometries` + `mergeVertices(…, 1e-3)` (weld coincident vertices). Already done for intersections, sidewalks+curbs, white markings, yellow markings, bridge structure (per material), piers, portals, decal group (per decal kind).
- Markings merge **UV-less** (`mergeNoUv`) since wear is shader-driven.

### 7.3 LOD tiers

- **Tier 0 (near):** full geometry + normal/roughness maps + detail props (guardrail sections, balusters, wires).
- **Tier 1 (mid):** drop detail props, keep merged surfaces + simplified structure (deck+fascia, no cables/truss).
- **Tier 2 (far):** albedo-only materials, decimated straight runs, instanced-prop cull.
- Trees → impostor/billboard at far range.

### 7.4 Draw-call budget

Target: keep a city under the current merged-mesh call count. The merge-per-material + instance-per-kind discipline already collapses thousands of segments into a handful of draws (road-per-segment is the main remaining unmerged set — merge-per-material or per-tile is the next win).

### 7.5 On-thread vs off-thread build

Generation is currently on-thread (build-time). The redesign's known perf risk (swept corridors + stamped heightfield) and the large-area work point to an **off-thread / merged-geometry build** as TODO (large-area memory note). The generation functions are pure and deterministic, so they port to a worker cleanly; the seam to preserve is `buildRoadElevation` memoization (one solve per build) and the `furniturePlacements` side-channel.

---

## 8. Procedural generation rules / assembly algorithm

End-to-end, referencing the real pipeline stages:

```
1. OSM INGEST            → CityGraph (RoadSegment[] in ENU meters, resolved tags)
                           [cached raw_osm.json; deterministic]
2. CONTEXT RESOLVE       → RoadResolution per segment (surface, marking, crossSection,
                           decalDensity) + RegionPack  [resolver/resolve.ts]
3. (optional) ROAD SCALE → scaleRoadNetwork(pristine, k): widen carriageways + displace
                           non-road features out of widened corridors  [roadScale.ts, redesign §14]
4. CENTERLINE            → segCenterline(r) = smoothPolyline (+ densifyPolyline for bridges)
5. NODE ANALYSIS         → analyzeRoadNodes: junction valence, max width, hasSurface
6. ELEVATION SOLVE       → buildRoadElevation(roads): network Gauss-Seidel node relaxation
                           + per-edge C¹ profile; one source of truth for renderer/colliders/semantics
                           [corridor/index.ts, elevation.ts, config.ts]
7. JUNCTION CONSOLIDATION→ cluster (union-find) → contract → re-solve → one patch/one height;
                           pass-through joints; cluster-aware trims  [redesign §15]
8. PER-CATEGORY MODULES  → for each segment: trim → offset edges → ribbon/raisedRibbon/wall
                           surface, sidewalks, markings, crosswalks, stop lines, turn arrows,
                           decals; bridge structure (fascia/rail/pier or landmark generator);
                           tunnel portals  [buildRoads]
9. INTERSECTION SURFACES → arm-hull patch or merged cluster patch + manholes  [buildRoads]
10. PLACEMENT ENGINE     → buildFurniture: OSM-authoritative + generated lamps/benches/bins/signs,
                           curbside offset, CarriagewayIndex clearance, elevation-riding y  [props.ts]
                           traffic devices: curbsideDevicePosition + deviceHeading  [signMath.ts]
11. MERGE / INSTANCE     → mergeGeometries + mergeVertices per material; InstancedMesh per prop kind
12. COLLIDERS + SEMANTICS→ built from the SAME elevation seam + centerlines (parity-tested);
                           terrain → heightfield  [physics/colliders.ts, export/semantics.ts]
13. EXPORT               → GLB (unlit PBR) + city_semantics.json (semanticsVersion 3)
```

Each stage is deterministic (`hash01`/`seededRandom`, fixed iteration budgets, key-sorted traversal). `npm test` (flicker, terrainCarve, roadElevation parity, coplanarOverdraw, junctionConsolidation, roadScale) gates every change to ingest/layers/depth.

---

## 9. Roadmap (phased, driver-training priorities)

Marked **[exists]** where the code is in the tree, **[new]** where this document specifies work. Priorities follow the owner's immediate focus: **junctions, sidewalks, bridge embankments, building-clipping.**

| Phase | Scope | Status | Priority |
|---|---|---|---|
| **P0 — Foundation** | centerline smoothing/densify, offset/ribbon/wall/raisedRibbon primitives, per-point elevation, merge/weld | **[exists]** `geometry.ts` | shipped |
| **P0 — Elevation & consolidation** | network solve as single source of truth (E0–E4, default-on); junction consolidation (§15); surface-riding layers | **[exists]** `corridor/*`, `roads.ts` | shipped |
| **P0 — Placement engine** | curbside/clearance/elevation-riding for all props; OSM-authoritative + generated | **[exists]** `props.ts`, `signMath.ts` | shipped |
| **P0 — Bridges (generic + landmark)** | deck/fascia/rail/pier inline; suspension + arch generators; chaining; consolidation-aware fascia | **[exists]** `roads.ts`, `bridges.ts` | shipped |
| **P1 — Real junction meshes** | `corridor/junction.ts`: kerb-return fillets, arm-ring blending, stitched surfaces, corner sidewalk wraps (§3.2, §3.10) | **[new]** (redesign E5) | **immediate** |
| **P1 — Sidewalk continuity** | corner wraps at junctions; sidewalk network continuity around blocks | **[new]** (§3.10) | **immediate** |
| **P1 — Bridge embankments & modular components** | approach embankment, abutment, bearing, expansion joint, transition piece; batter skirts (§3.5, §3.6) | **[new]** | **immediate** |
| **P1 — Building-clipping** | extend penetration-resolution displacement (`roadScale.ts` §14) to always clear widened corridors + junction patches; buildings never overlap roads/junctions | **[new/extend]** | **immediate** |
| **P2 — Cross-section sweep** | `corridor/crossSection.ts` + `mesh.ts`: explicit `[shoulder|lane×N|curb|walk|batter]` template; crown/camber + superelevation (E4b) | **[new]** (redesign Stage 5) | high |
| **P2 — Barriers/guardrails/medians** | procedural swept rail + instanced posts (§3.14); raised/painted medians + refuge islands (§3.11); shoulders (§3.12) | **[new]** | high (driver-training safety geometry) |
| **P2 — Roundabouts** | closed-loop annulus + island + entry deflection (§3.3) | **[new]** | high |
| **P3 — Terrain conform** | heightfield stamp + welded seam + cuttings/embankments + retaining walls (§3.5, §3.8, §3.22) | **[new]** (redesign Stage 4, optional) | medium |
| **P3 — Drainage, utilities, tunnel bore** | gutters/inlets (§3.15), poles/wires (§3.19), tunnel liner (§3.7) | **[new]** | medium |
| **P4 — Optimization** | InstancedMesh2 (per-instance cull/LOD), merged road-per-material, LOD tiers, off-thread build | **[new/extend]** | ongoing |
| **P4 — GLB detail-prop library** | curated guardrail/sign/lamp/bench GLB variants via `instanceKindVaried`; multi-template per kind, height-aware fit | **[partly exists]** (aaa-plan P2) | ongoing |

**Guiding rule:** new categories are geometry + unlit PBR + semantics; rendering (lighting/shadows/reflections/post) lives in the game engine and must never be baked in. AAA fidelity comes from the *geometry* (grade-limited profiles, real junctions, banked curves, modular bridge components, welded terrain), exactly as `road-corridor-redesign.md` §10 argues.
