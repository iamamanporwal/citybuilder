# Roadside Vegetation & Ground-Detail Engine

**Status:** shipped (main). **Module:** `src/procgen/vegetation.ts`. **Toggle:** "🌿 Roadside greenery" (Settings), default ON.

## Motivation

Roads are the product (driving trainer / game). After the road-surface fidelity
pass (textured asphalt, polygonal junctions, elevation, traffic core), the biggest
remaining gap versus the reference driving worlds — **Slow Roads, ETS2, BeamNG,
GTA V** — was the **verge**: the strip of ground between the carriageway edge and
the buildings/land. Ours was a flat textured plane. Those worlds fringe every road
with volumetric grass tufts, weeds and low shrubs, which is most of what makes a
road read as *driven-through* rather than *drawn*.

Trees already existed but come only from sparse OSM `natural=tree` points; there
was no continuous roadside ground cover.

## What it does

A deterministic, semantic, GPU-instanced scatter of **grass tufts** and **low
shrubs** along road verges:

- **Placement gate — land cover.** A candidate is kept only where
  `ctx.landCoverAt` is `grass` or `bare`. Dense-urban `built` land (concrete
  plazas, sidewalks) gets nothing; `water`/`trees` are skipped. So greenery
  appears exactly where real ground is exposed and nowhere it shouldn't.
- **Verge band.** For each drivable road, both sides are marched at a zone-derived
  spacing; each tuft sits in a jittered lateral band starting `VERGE_INSET` (1.4 m)
  beyond the carriageway edge, out to a per-zone width. `park` verges are lush and
  wide; `commercial`/`retail` are sparse and narrow.
- **Carriageway clearance.** Every candidate is proven outside *every* drivable
  carriageway (+margin) via a grid-hashed segment index — nothing ever sprouts in
  a driving lane (a compact local copy of props.ts' `CarriagewayIndex`, kept here
  so the planner avoids the canvas-heavy props/materials import chain).
- **Grounding.** Tufts root on the terrain field (`sampleTerrain`) — this is
  off-road ground detail, so it does **not** ride the road-elevation solve and does
  **not** enter the coplanar road-surface stack. Tall meshes are exempt from the
  flat-mesh flicker lint, same as trees, so no z-fighting risk.
- **Bridges/tunnels excluded.** A deck has no verge beside the parapet.
- **Determinism.** Every attribute (position jitter, scale, yaw, tint) is seeded by
  `hash01(roadId + station)`. A global budget (26k grass / 6k shrub) truncates in a
  stable road iteration order, so the scatter is byte-identical every build.

## Rendering

- **Grass** = two crossed vertical quads (a cheap volumetric billboard) textured
  with a procedurally-generated **alpha grass-clump** canvas (a fan of tapered
  blades on transparent field), `alphaTest: 0.4` (no transparency sort), `DoubleSide`.
- **Shrub** = a flat-shaded low-poly icosahedron blob.
- Both are single `InstancedMesh`es with per-instance matrix + HSL-jittered color
  (`dry` verges tint yellow-green). Instance-aware bounding spheres so the
  spread-out batch isn't wrongly frustum-culled.
- **Distance-dither LOD.** Grass fades out with a pure in-shader stochastic discard
  (`onBeforeCompile`: view-space depth → hashed threshold, 70→135 m). Far tufts are
  culled so the verge dissolves instead of ending in a hard ring, and distant
  overdraw is cut. No uniforms, no per-frame ticker — works with the on-demand
  renderer.

## Benchmark (Lower Manhattan sample, 1829 road segments)

| Metric | Value |
| --- | --- |
| Grass instances | 2 083 |
| Shrub instances | 331 |
| **Extra draw calls** | **2** (one InstancedMesh per kind, any instance count) |
| Extra unique geometry | 1 × 8-vert quad-cross + 1 × icosahedron (shared) |
| GPU memory | ~2 414 × (mat4 + rgb) ≈ 190 KB instance buffers |
| Texture | 1 × 128² canvas (grass alpha) |

Manhattan is dense urban, so grass land is limited (the gate does its job); a park
or suburban area produces far more, still at 2 draw calls. The cost is flat in
instance count — this is the cheapest possible way to add the detail.

## Architecture notes / invariants

- **Pure planner.** `planRoadsideVegetation(roads, ctx, sampleY, budget)` is pure
  geometry (no THREE, no canvas) → unit-tested in the node env
  (`src/__tests__/roadsideVegetation.test.ts`, 7 cases: determinism, land-cover
  gate, carriageway clearance, bridge/tunnel skip, budget, grounding, zone density).
- **Canvas is lazy.** The grass texture is built inside the mesh builder, never at
  module load, so importing this file from a node test stays canvas-free (the test
  env has no DOM). Mirrors the `areas.ts` `applyLandTextures` discipline.
- **Toggle wiring** follows the terrain/road-style convention: store field
  `roadsideGreenery` + `setGreeneryEnabled` module flag, `rebuildWithGreenery`
  helper, Settings checkbox. Registry gates on `greeneryEnabled()` and adds the
  group as a locked `vegetation` scene object (`veg_roadside`).

## Follow-ups (not built)

- **Wind sway** — a subtle vertex sway on the grass top verts (needs a per-frame
  time uniform; the ocean material already has the ticker pattern to copy).
- **Wildflower / detail-mesh accents** and **road-edge gravel/debris** decals to
  break the asphalt-to-grass seam.
- **Density from a splat/park polygon** rather than the coarse land-cover sampler,
  for tighter park boundaries.
- **KTX2** the grass alpha texture in the bake pipeline (UASTC for the alpha edge).

See [[road-ground-fidelity-and-osm2streets]], `docs/aaa-improvements-plan.md`,
`docs/asset-library-evaluation.md` (vegetation packs evaluated — Quaternius/Kenney
Nature; ship no impostors, so in-engine billboards like this remain the path).
