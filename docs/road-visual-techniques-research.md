# Road Visual-Quality Techniques — Deep Research & Top 25

**Scope:** techniques that dramatically improve the *visual quality* of our procedural
OSM roads **without changing the core road network graph**. Asset-library sourcing is
out of scope (see `docs/asset-library-evaluation.md`). Target stack: **Three.js r169 /
WebGL2** (browser-native, deterministic, GPU-instanced), eye toward WebGPU.

**Method & evidence tiers.** This merges a fan-out/adversarial deep-research pass (5
search angles → 19 sources fetched → 86 claims extracted → 25 verified by 3-vote
adversarial verification → 24 confirmed, 1 refuted → 7 synthesized high-confidence
findings) with principal-engineer / technical-art-director assessment for the areas the
research pass did **not** corroborate. Each technique is tagged:

- **[Verified]** — survived adversarial fact-checking with primary sources (papers, Epic/Unity docs, dev post-mortems, authoritative repos). High confidence.
- **[Expert]** — standard, well-established real-time rendering practice; my assessment, not independently re-verified in this pass. Treat as strong-but-unverified.

> **Research caveat (verbatim from the pass):** verified claims cluster on (a) stochastic/hex texture-tiling, (b) Slow Roads' LOD + terrain-road blend, (c) osm2streets geometry, (d) InstancedMesh2. Topics that produced *no surviving verified claim* — road wear/decals, SDF lane markings, cross-section engineering profiles, bridge/tunnel gen, virtual texturing, trim sheets, meshopt streaming, and all atmospheric/post (GTAO, SSR, TAA, aerial perspective, motion blur, DoF) — are **under-evidenced here, not unimportant**. One claim (edge-only manipulation to make a non-tileable texture tileable) was **refuted**. All techniques below are WebGL2-viable today unless flagged; none *strictly* require WebGPU.

Scores are **Visual impact 1–10** and **Difficulty 1–10** (for *our* codebase). "Browser" =
WebGL2-today / needs-care / WebGPU-preferred.

---

## Baseline — what we already ship (so recommendations go deeper)

Textured procedural asphalt with world-position macro-variation shaders; polygonal
junction meshing (flared arm-hull pads); corridor road-elevation solve + junction
consolidation; procedural lane markings (worn-paint shader); flat-quad surface decals
(crack/stain/patch/manhole) with a non-overlap planner; a terrain field the roads
follow; and instanced roadside grass/shrub billboards with an in-shader distance-dither
LOD. The recommendations below assume all of that and push past it.

---

## 1. Texture repetition removal (the single biggest asphalt win)

Our asphalt already has macro brightness variation, but the albedo/normal *tile* still
repeats at close range and reads as a pattern. This is the highest impact-to-effort area.

### 1.1 Practical Real-Time Hex-Tiling — **[Verified]** · Visual 8 · Diff 4 · WebGL2-today
Mikkelsen (JCGT 2022). Tiles texture space on an equilateral-triangle/hex lattice; each
hex samples the source at a random offset, blended by barycentric weights. **Key
advantage: samples the ORIGINAL texture directly — no precompute textures — so it drops
into any existing shader.** Cost ~3 taps/fragment. Trade-off: no histogram/contrast
preservation (mild softening). *Apply:* wrap our `withMacroVariation` asphalt + grass +
future gravel/terrain materials in a hex-tile sampler via `onBeforeCompile`. Lowest-friction
repetition killer. Refs: jcgt.org/published/0011/03/05, arxiv.org/pdf/2502.13945 (Laplacian
follow-up), Godot shader port.

### 1.2 Heitz–Deliot histogram-preserving blending — **[Verified]** · Visual 9 · Diff 6 · WebGL2-today
Heitz & Neyret 2018 (HPG best paper), shipped in Unity. Restores the variance naive
blending washes out → no contrast loss. ~3 taps + 1 small LUT fetch/fragment. Works on
stochastic naturals (asphalt aggregate, gravel, sand, moss, granite) but **fails on
precise geometric shapes (lane markings, brick)** — keep markings on a separate path.
*Apply:* the quality ceiling for hero surfaces where hex-tiling's softening shows; needs a
one-time LUT precompute per texture. Refs: eheitzresearch.wordpress.com/738-2, Unity
"Procedural Stochastic Texturing" blog + runnable demo.

### 1.3 Multi-scale detail normals (macro/meso/micro) — **[Expert]** · Visual 7 · Diff 3 · WebGL2-today
Blend a high-frequency detail normal tiled at ~0.3–0.6 m on top of the base normal so the
surface holds up when the camera is 1 m off the deck (drive cam). Near-free (one extra
normal sample). Pairs with 1.1. *Apply:* add a `uDetailNormal` sample to the road/ground
fragment shader, strength fading with distance.

### 1.4 Height-blend material blending — **[Expert]** · Visual 6 · Diff 3 · WebGL2-today
Blend two PBR layers by `max(hA+wA, hB+wB)` instead of linear lerp → crisp, natural
transitions (asphalt↔patch↔gravel↔dirt). Trivial in-shader. Foundation for wear masks (§4).

---

## 2. Road cross-section & engineering profiles

Currently the carriageway is effectively flat across its width. Real roads are shaped, and
a driving camera reads the shape strongly.

### 2.1 Crown / camber — **[Expert]** · Visual 6 · Diff 3 · WebGL2-today
Raise the centerline ~1.5–2.5% above the edges (parabolic crown) so water sheds and the
surface catches light like a real road. Pure ribbon-geometry change in `raisedRibbonGeometry`
(offset each cross-section vertex by `crown·(1-(u)²)`). Compounds with normals for specular.

### 2.2 Gutter / kerb / shoulder cross-section — **[Expert]** · Visual 6 · Diff 4 · WebGL2-today
Author the cross-section as an ordered lane list with a gutter pan + raised kerb + verge
strip (we already have a 0.22 m curb). Adds the shoulder/verge that reads as "engineered."
Mirrors osm2streets' left-to-right lane list (§6). *Apply:* extend the ribbon generator's
lateral profile table.

### 2.3 Superelevation (banking curves) — **[Expert]** · Visual 5 · Diff 5 · WebGL2-today
Tilt the cross-section into curves proportional to curvature × design-speed². Big "feel"
win in drive mode on highway ramps; subtle top-down. Needs curvature from the centerline
and a clamp so it doesn't fight junctions.

---

## 3. Terrain–road integration

### 3.1 Proximity height-blend skirts (Landscape-Spline style) — **[Verified]** · Visual 8 · Diff 4 · WebGL2-today
The single most-cited integration technique. Slow Roads: *"using proximity to the road
midline, near-grid heights are interpolated between the road height and the underlying
environment height for a seamless transition."* Unreal formalizes it as Landscape Splines:
heightmap raised/lowered to fit the spline with a **cosine-blended falloff** per control
point (width + falloff), plus "Scale to Width" for spline meshes. *Apply:* in our terrain
field, pull corridor-grid vertices toward the solved road profile with a cosine falloff
over ~road-half-width + verge — kills the floating-ribbon and terrain-poking-through
artifacts. Directly composes with our corridor-elevation solve. Refs:
anslo.medium.com/slow-roads-tl-dr, dev.epicgames.com Landscape Splines.

### 3.2 Triplanar mapping on embankments/cuts — **[Expert]** · Visual 5 · Diff 3 · WebGL2-today
Where the skirt gets steep (road cuts/fills, bridge abutments) UV-stretch shows; triplanar
projection removes it. ~3× texture cost, so gate to steep normals only.

---

## 4. Procedural road wear, decals & aging

We have flat single-quad decals; AAA roads layer *wear* into the material itself plus
richer projected decals.

### 4.1 Splat / wear-mask material (RoadPainter approach) — **[Expert]** · Visual 8 · Diff 6 · WebGL2-today
An RGBA mask along the road (procedural from lane geometry + traffic semantics) drives
per-fragment blends: darkened wheel-path polishing, oil-stained centerline, lighter
aggregate at edges, tar-seam repairs, patched sections. This is what makes GTA V / ETS2
asphalt read as *driven*. *Apply:* generate a low-res per-segment mask (or derive
analytically from lane-space `v` coordinate + `hash01`), blend wear tiers we already
author (`asphalt` wear 0/1/2) via height-blend (§1.4). Deterministic, no new textures.

### 4.2 Mesh-decal atlas with normals — **[Expert]** · Visual 7 · Diff 5 · WebGL2-today
Upgrade our flat albedo quads to a **decal atlas** carrying albedo+normal+roughness, so
cracks/patches/manholes/skids catch light and have depth. Keep the non-overlap planner;
add skid marks near junctions (from stop-line/turn semantics) and oil at signals.
`THREE.DecalGeometry` clips to the road mesh; or instanced quads with a small polygon-offset
(mind log-depth — we bias by physical height today). WebGL2-fine; watch overdraw.

### 4.3 Parallax-occlusion mapping (POM) on hero surfaces — **[Expert]** · Visual 7 · Diff 6 · WebGL2-today (costly)
Per-fragment heightfield ray-march gives cobbles/cracks/potholes real parallax depth
without geometry. Expensive (8–32 steps); reserve for close-up cobble/crosswalk/pothole
tiles and fade to normal-mapping by distance. Great for the historic-cobble look.

### 4.4 Deferred decals — **[Expert]** · Visual 7 · Diff 9 · **WebGPU-preferred / not native**
The AAA standard (project decals into a G-buffer) needs a deferred pipeline; Three.js is
forward-rendered. Not worth it in WebGL2 — use §4.2 mesh decals instead. Revisit only if we
move to a WebGPU deferred path.

---

## 5. Lane markings (crisp, non-repeating)

Stochastic tiling explicitly **fails** on markings (§1.2), so they need their own path.

### 5.1 SDF / analytic shader-drawn markings — **[Expert]** · Visual 7 · Diff 6 · WebGL2-today
Draw markings analytically in lane-space in the road shader: dashes via `fract(v·k)`, edge
lines, stop bars, arrows from an SDF glyph atlas. Resolution-independent, crisp at any
distance, zero tiling, no z-fight (they're part of the surface, not a floating quad). *Apply:*
extend our marking pass to a lane-space UV + SDF sampler; pairs with our worn-paint shader.
This also fixes distant marking shimmer better than any AA.

---

## 6. Intersections & junction meshing

Task excludes graph changes, so these are **geometry/meshing** references only.

### 6.1 osm2streets/A-B-Street lane-thickening + perpendicular-trim — **[Verified]** · Visual 7 · Diff 7 · WebGL2-today (CPU)
Ordered left-to-right lane list → thicken centerline by 90°-offset projection (miter joins,
bevel fallback past a max) → intersection polygon at road-overlap collisions, trimming each
road back to where a perpendicular from the collision meets its centerline. Pure CPU
geometry. *Apply:* a more principled junction polygon than our arm-hull hull, with true
lane-count-aware widths. Ref: a-b-street.github.io/docs/tech/map/geometry.

### 6.2 Classified junction consolidation (IntersectionComplexity) — **[Verified]** · Visual 6 · Diff 8 · WebGL2-today (CPU)
The maintainer candidly documents the generic consolidation algorithm as unreliable —
*"sometimes produces something half-reasonable ... often it does not"* — motivating a
redesign that **classifies** junctions and specializes geometry per class. *Lesson for us:*
complex multi-way junctions deserve a classified approach, not one generic algorithm (we
already consolidate clusters; classification is the next refinement). Ref: osm2streets #62.

---

## 7. Vegetation & roadside clutter placement

We ship instanced billboards; these deepen distribution realism and scale.

### 7.1 InstancedMesh2 (per-instance cull + BVH + LOD) — **[Verified]** · Visual 7 · Diff 4 · WebGL2-today
`agargaro/instanced-mesh`: per-instance frustum culling, dynamic BVH (raycast + cull),
per-instance distance LOD (`addLOD`) + separate `addShadowLOD`. "Works very well if
instances are mostly static and scattered in world space" — exactly our roadside scatter.
*Apply:* migrate grass/shrub (and future 3D clutter — bollards, debris, signs) onto it for
true culling + cross-fade LOD instead of our single static InstancedMesh. Ref:
github.com/agargaro/instanced-mesh.

### 7.2 Blue-noise / Poisson-disk scatter — **[Expert]** · Visual 5 · Diff 4 · WebGL2-today (CPU)
Our verge scatter is grid+hash; a blue-noise/Poisson distribution looks more natural (no
grid artifacts, even spacing). Deterministic tiled blue-noise keeps it seeded. Modest win.

### 7.3 Density/biome fields — **[Expert]** · Visual 5 · Diff 4 · WebGL2-today
Drive species/density from land-cover + climate + moisture fields rather than per-road
rules — richer transitions (we partly do this via land-cover gating). 

### 7.4 Octahedral impostors for distant trees — **[Expert]** · Visual 6 · Diff 6 · WebGL2-today
Bake tree meshes to an octahedral impostor atlas; swap 3D→impostor by distance for dense
tree fields at near-zero cost. Enables forests along rural roads. Pairs with 7.1 LOD.

### 7.5 Wind sway — **[Expert]** · Visual 5 · Diff 3 · WebGL2-today
Vertex sway on grass/canopy tops via a time uniform (copy the ocean-material ticker). Cheap;
adds life. Already flagged as our next vegetation follow-up.

---

## 8. LOD, streaming & batching

### 8.1 Corridor-resolution LOD budgeting — **[Verified]** · Visual 7 (enabler) · Diff 5 · WebGL2-today
Slow Roads proves an infinite browser driving world with **no WebGPU** via nested
multi-resolution grids: coarse 5×5 @10 m out to 1 km, a finer 5×5 grid *marched along the
road midline* (the high-detail corridor), plus a 3×3 near-vehicle grid. *Apply:* spend our
detail budget in the corridor flanking the route; drop distant environment resolution. This
is the enabler that lets every other technique here stay in frame budget. Refs:
anslo.medium.com/slow-roads-tl-dr, web.dev/case-studies/slow-roads.

### 8.2 KTX2 (Basis) + meshoptimizer bake — **[Expert]** · Visual 3 (perf enabler) · Diff 4 · WebGL2-today
We have `@gltf-transform`; wire meshopt compression + KTX2 (UASTC for normals/alpha, ETC1S
for albedo) into the bake path. Cuts VRAM/load, enabling larger areas + more detail. Prereq
for scaling the other techniques, not a look win itself.

### 8.3 Trim sheets & atlases — **[Expert]** · Visual 5 · Diff 4 · WebGL2-today
One trim-sheet atlas for all linear profile detail (kerbs, guardrails, barriers, tunnel
liners) → fewer draw calls + materials, consistent look. Standard AAA workflow.

### 8.4 Virtual texturing — **[Expert]** · Visual 6 · Diff 9 · **WebGPU-preferred**
Megatexture-style feedback + streaming. Heroic in WebGL2 (needs a feedback pass + tile
cache); realistically a WebGPU project. **Not recommended near-term** — §1 (repetition kill)
+ §8.2 (KTX2) get most of the benefit far cheaper.

---

## 9. Atmosphere, lighting & post-processing (grounding + mood)

This is where a scene stops looking "CG-flat." All via `postprocessing`/`@react-three/postprocessing`
(we already depend on both). **None are in the verified set** — treat as expert-tier.

### 9.1 Ground-truth ambient occlusion (GTAO / N8AO / HBAO) — **[Expert]** · Visual 8 · Diff 3 · WebGL2-today
The biggest single grounding win: contact darkening where kerbs meet road, under cars, at
tree bases, in cracks. `N8AO`/`GTAOEffect` are near drop-in. Cost ~1–2 ms. **Top pick.**

### 9.2 Aerial perspective / height fog — **[Expert]** · Visual 7 · Diff 3 · WebGL2-today
Distance + height-based fog with sun-tinted scattering → depth and mood, and it hides the
LOD/streaming edge. Cheap fragment fog. Huge for open roads (ETS2/Forza signature).

### 9.3 Filmic tonemapping (ACES) + exposure + bloom — **[Expert]** · Visual 6 · Diff 2 · WebGL2-today
If not already ACES, switch; add mild bloom on speculars/lights and auto-exposure. Cheapest
"looks like a game" upgrade.

### 9.4 Contact shadows — **[Expert]** · Visual 6 · Diff 4 · WebGL2-today
Short-range grounding shadows for props/veg/cars that cascade shadow maps miss up close.

### 9.5 TAA (temporal AA) — **[Expert]** · Visual 6 · Diff 6 · WebGL2-today (care)
Stabilizes marking/foliage shimmer and enables cheap stochastic effects; needs velocity +
reprojection and can ghost under fast camera motion — tune carefully for drive mode.

### 9.6 Wetness / puddle system — **[Expert]** · Visual 8 · Diff 6 · WebGL2-today
Dynamic roughness↓ + darkening + a puddle mask (pools in low spots via the height/wear
mask) + reflections (planar or SSR). A wet road is one of the highest-impact "wow" states
for driving. Compose puddle mask with §4.1.

### 9.7 Screen-space reflections (SSR) — **[Expert]** · Visual 7 · Diff 7 · WebGL2-today (costly/noisy)
Wet-road and window reflections. `postprocessing` SSR exists but is expensive and noisy in
WebGL2; pair with TAA. Reserve for a "wet" quality tier; consider planar reflection for the
road plane as a cheaper alternative.

### 9.8 Camera-level tricks (FOV-with-speed, subtle motion blur, CAS sharpen) — **[Expert]** · Visual 5 · Diff 3 · WebGL2-today
Speed-scaled FOV + light per-object motion blur sell velocity; contrast-adaptive sharpening
restores crispness after TAA. DoF is low-value for driving (Visual 3) — skip.

---

## Top 25 — ranked by impact-to-effort (browser-friendly)

Ranked for *our* stack: high visual return, low-to-moderate effort, WebGL2-viable, and
composes with what we already have. **V** = visual impact, **D** = difficulty (both /10),
**Tier** = evidence tier.

| # | Technique | V | D | Browser | Tier | How it applies to our stack |
|---|-----------|---|---|---------|------|------------------------------|
| 1 | GTAO/N8AO ambient occlusion | 8 | 3 | WebGL2 | Expert | Drop-in postprocessing; grounds kerbs, cracks, tree/prop bases — biggest grounding win |
| 2 | Hex-tiling repetition kill | 8 | 4 | WebGL2 | **Verified** | Wrap asphalt/grass/gravel shaders; no precompute, drops into `onBeforeCompile` |
| 3 | Terrain–road skirt (cosine height-blend) | 8 | 4 | WebGL2 | **Verified** | Pull corridor-grid verts to road profile; kills floating ribbon + terrain poke-through |
| 4 | Aerial perspective / height fog | 7 | 3 | WebGL2 | Expert | Cheap fog shader; depth + mood, hides LOD edge |
| 5 | Multi-scale detail normals | 7 | 3 | WebGL2 | Expert | One extra normal tap; holds up under the 1 m drive cam |
| 6 | ACES tonemap + exposure + bloom | 6 | 2 | WebGL2 | Expert | Cheapest "looks like a game" pass |
| 7 | Splat/wear-mask asphalt (RoadPainter) | 8 | 6 | WebGL2 | Expert | Wheel-path polish, oil centerline, tar seams from lane+traffic semantics |
| 8 | Road crown/camber cross-section | 6 | 3 | WebGL2 | Expert | Parabolic offset in `raisedRibbonGeometry`; real specular shaping |
| 9 | InstancedMesh2 (cull+BVH+LOD) | 7 | 4 | WebGL2 | **Verified** | Migrate grass/shrub/clutter → true culling + cross-fade LOD |
| 10 | Height-blend material blending | 6 | 3 | WebGL2 | Expert | Crisp asphalt↔patch↔gravel; foundation for #7 |
| 11 | Heitz–Deliot histogram tiling | 9 | 6 | WebGL2 | **Verified** | Quality ceiling for hero surfaces where hex-tiling softens; needs LUT precompute |
| 12 | Mesh-decal atlas w/ normals | 7 | 5 | WebGL2 | Expert | Cracks/patches/skids/oil catch light; add skids at junctions from semantics |
| 13 | SDF/analytic lane markings | 7 | 6 | WebGL2 | Expert | Lane-space shader draw; crisp at all distances, no tiling, no shimmer |
| 14 | Wetness/puddle system | 8 | 6 | WebGL2 | Expert | Roughness↓ + puddle mask (from height/wear) + reflections; top "wow" state |
| 15 | Corridor-resolution LOD budgeting | 7 | 5 | WebGL2 | **Verified** | Spend detail in the route corridor; the enabler for everything else in-budget |
| 16 | Contact shadows | 6 | 4 | WebGL2 | Expert | Close-up grounding CSM misses |
| 17 | Gutter/kerb/shoulder cross-section | 6 | 4 | WebGL2 | Expert | Extend lateral profile table; reads as "engineered" |
| 18 | osm2streets lane-thickening junctions | 7 | 7 | WebGL2(CPU) | **Verified** | Lane-count-aware junction polygons vs current arm-hull |
| 19 | Wind sway on vegetation | 5 | 3 | WebGL2 | Expert | Vertex sway via time uniform (ocean ticker) — already our next veg step |
| 20 | Octahedral tree impostors | 6 | 6 | WebGL2 | Expert | Dense rural tree fields at near-zero cost; pairs with #9 |
| 21 | TAA | 6 | 6 | WebGL2 | Expert | Kills marking/foliage shimmer; tune for fast camera |
| 22 | Superelevation (curve banking) | 5 | 5 | WebGL2 | Expert | Curvature-driven tilt; strong drive-cam feel on ramps |
| 23 | KTX2 + meshopt bake | 3 | 4 | WebGL2 | Expert | Perf enabler for scaling area + detail (not a look win itself) |
| 24 | Camera FOV-with-speed + motion blur + CAS | 5 | 3 | WebGL2 | Expert | Sells velocity in drive mode; DoF skipped |
| 25 | SSR for wet roads | 7 | 7 | WebGL2(costly) | Expert | "Wet" quality tier; consider planar road reflection as cheaper alt |

### Flagged: WebGPU-preferred or not browser-viable near-term
- **Deferred decals** (§4.4) — needs a G-buffer; Three.js is forward. Use mesh decals (#12).
- **Virtual texturing** (§8.4) — feedback + tile streaming; realistically a WebGPU project. #2 + #23 capture most of the value cheaper.
- **Nanite-style micropolygon geometry / Lumen GI** — not viable in-browser; approximate with LOD/impostors (#9,#20) and baked light + SSAO/SSGI.

### Refuted (excluded)
- Histogram-preserving blending making a *non-tileable* texture tileable by edge-only manipulation — **refuted** in verification. (HPB blends *between tiled* stochastic samples; it does not fix an inherently non-tileable source.)

---

## Recommended phased roadmap (impact-first, composes with current code)

1. **Post FX pass (fast, huge):** #1 GTAO + #4 aerial fog + #6 ACES/bloom + #16 contact shadows. Days, near drop-in via our `postprocessing` dep. Instantly grounds and moods the whole scene. **✅ SHIPPED** — `FxPreview` in `src/editor/Viewport.tsx` now runs N8AO (GTAO-quality AO; log-depth auto-detected, fog-aware; half-res while driving — folds in #16 contact shadows), sun-tinted `FogExp2` aerial haze (`AerialFog`, preview-gated), a subtle saturation grade, and keeps renderer ACES (no double-tonemap). Editor look-dev only — never baked/exported. Behind the existing **FX preview** toggle (default off; flip to see the grade).
2. **Asphalt fidelity:** #2 hex-tiling + #5 detail normals + #10 height-blend + #8 crown. The road surface itself stops reading procedural. **✅ SHIPPED (3/4)** — all in `src/materials/library.ts`, applied only to realistic stochastic asphalt (cobble/pavers/markings excluded — hex-tiling & aggregate wear fail on structured textures; arcade stays clean):
   - **#2 hex-tiling** — `HEX_TILING_GLSL` (Mikkelsen offset-only, `textureGrad` explicit-gradient, contrast-sharpened barycentric blend) kills the ~6 m albedo repeat.
   - **#5 detail normals** — `makeDetailNormal()` (fine grain → `heightToNormal`) blended into the tangent-space normal *before* the TBN transform, tiled at ~0.5 m, distance-faded (18→45 m) so far asphalt stays clean and the drive cam gets micro-relief.
   - **#10 height-blend** — `cbHeightBlend` (Unreal-style crisp height-lerp) lays oily/sealed patches that follow the aggregate contours rather than a soft sine; foundation for the Phase 3 wear mask.
   - **#8 crown/camber + #22 superelevation — SHIPPED** as the coordinated road-geometry pass. New `src/procgen/crossSection.ts` is the single source of truth: `crossOffset(ln, half, bank)` raises the centre ~2% (crown, edges stay at grade so the kerb/grass seam is untouched) and banks the OUTER edge on curves (superelevation, `bankProfile` from centreline curvature, verified outer-edge-up); `crossFade` ramps it to 0 within 6 m of each end so a crowned mid-block meets a flat junction disc with **no seam**. `crownedRibbonGeometry` (geometry.ts) subdivides the ribbon into `CROSS_K` lateral samples and carries `aLane`. `roads.ts` surface + `surfaceElevSampler` (markings/decals/crosswalks/turn-arrows) + `colliders.ts` all read the SAME `crossOffset` at the SAME station, so every riding layer tracks the crown and the car rides what it sees. Flag-gated (`CROSS_SECTION.enabled`, default OFF → all parity/flicker/collider tests byte-identical; interactive app enables it via `buildScene` + the "🛣️ Road crown & banking" toggle). Verified: flickerLint PASSES (912 surfaces), colliderAudit green, 0 shader errors, `crossSection.test.ts` (6 cases) + bank-direction check.
3. **Wear & markings:** #7 splat/wear mask + #12 decal atlas + #13 SDF markings. The "driven-in" look. **◐ IN PROGRESS (2/3)** —
   - **#7 SHIPPED** — lane-space wear in the asphalt shader (`src/materials/library.ts`) driven by an `aLane` (−1 kerb→+1 kerb) + `aWear` gate attribute set on carriageway ribbons in `roads.ts`. Polished wheel tracks + oily centerline (both lower roughness) + dusty kerb edge (higher roughness), along-road modulation. Gated by `aWear` so junction patches / paths / cobble are untouched.
   - **#12 SHIPPED (decal normals)** — decals now carry a normal map derived from their alpha coverage (`decalTexture(name, relief, draw)` in `textures.ts`): cracks recess into grooves (`relief -1`), manhole/patch relief is raised (`+0.6`/`+0.35`), stains stay flat (`0`). Wired via `decalMat` (the decal quads already have up-normals + UVs, so three derives the TBN). *Skid marks deferred* (placement plumbing) alongside #13.
   - **#13 SDF/analytic lane markings — DEFERRED** to a dedicated pass. Markings are currently a flicker-load-bearing merged geometry layer (`mats.markingWhite/Yellow` + the `withPaintWear` shader) sitting +5 mm on the paint stack; replacing them with shader-drawn SDF markings is a rewrite of that layer and must be re-verified against `flickerLint`. Same discipline as #8 crown — not rushed.
4. **Integration & scale:** #3 terrain skirts + #15 corridor LOD + #9 InstancedMesh2 + #23 KTX2 bake. Makes it hold together and scale. **◐** — **#3 terrain skirts ALREADY SATISFIED** by the existing `conformTerrainToRoads` (`procgen/terrain/field.ts`): it flattens terrain under the carriageway (`w=1` within `half+pave`) then `smoothstep`-blends to natural terrain over a `SHOULDER` band — exactly the Landscape-Splines / Slow-Roads proximity height-blend skirt #3 describes. #15 corridor LOD (large; partial via existing large-area tiling + drive bubble), #9 InstancedMesh2 (new dep + vegetation migration; perf/scale), #23 KTX2/meshopt bake (offline; KTX2 needs the toktx binary) — each a focused pass.
5. **Wow tier:** #14 wetness/puddles (+ #25 SSR/planar), #20 impostors, #21 TAA, #22 superelevation. **◐ IN PROGRESS** — #14 wetness SHIPPED: a Dry/Wet weather toggle (`setWetness`/`CB_WET` shared uniform in `library.ts`, `weather` store field, 🌧️ Settings toggle, live via the Invalidator — no rebuild). Wet darkens the asphalt (−19% measured) + drops roughness so the sun glints off it; a world-space puddle mask pools near-mirror water. No SSR/env-map needed. #25 SSR/#20 impostors/#21 TAA/#22 superelevation still to come.

> **Correctness fix landed alongside #14:** `roadMaterial()` cloned the base asphalt per segment, but `THREE.Material.copy()` does not carry `onBeforeCompile`/`customProgramCacheKey` — so every per-segment ROAD ribbon silently dropped `withMacroVariation`, meaning **hex-tiling (#2), detail normals (#5), height-blend (#10) and wear (#7) were only reaching junctions/paths (the uncloned base), never the actual road clones.** The clone now re-attaches both, so all of Phase 2/3's asphalt work is genuinely live on roads (verified: dry road-band luminance shifted 63→55 once the shader actually applied).

## Open questions the research pass flagged
1. Best browser-viable road-wear pipeline (runtime decals vs splat masks) and its overdraw cost without WebGPU.
2. Crisp resolution-independent lane markings given stochastic tiling fails on geometric shapes → SDF is the lead candidate (§5.1).
3. Which post stack gives the most AAA-per-millisecond in WebGL2, and where the WebGPU cutoff is.
4. Whether classified (IntersectionComplexity-style) junction meshing beats one generic algorithm for our OSM junctions.

## Primary sources
- Heitz & Neyret 2018, histogram-preserving blending — eheitzresearch.wordpress.com/738-2 ; Unity "Procedural Stochastic Texturing" + demo (unity-grenoble.github.io).
- Mikkelsen 2022, "Practical Real-Time Hex-Tiling" — jcgt.org/published/0011/03/05 ; arxiv.org/pdf/2502.13945.
- Slow Roads dev post-mortem — anslo.medium.com/slow-roads-tl-dr ; web.dev/case-studies/slow-roads.
- Unreal Landscape Splines — dev.epicgames.com/documentation/en-us/unreal-engine/landscape-splines-in-unreal-engine.
- A-B-Street / osm2streets geometry — a-b-street.github.io/docs/tech/map/geometry ; github.com/a-b-street/osm2streets/issues/62.
- InstancedMesh2 — github.com/agargaro/instanced-mesh.

_See also `docs/aaa-improvements-plan.md`, `docs/asset-library-evaluation.md`, `docs/roadside-vegetation-engine.md`._
