# AAA Improvements Plan — flicker, roads, asset variation, textures

Grounded in three investigations (flicker/markings, asset-variation/buildings, and
research on MetaDrive + comparable OSS). Ordered by the priorities you set:
**flicker → roads → asset variation/dimensions → textures.**

## Base-level assessment — what we're doing wrong today

1. **Markings float because we dodge z-fighting with physical height, not compositing.**
   The paint stack uses big vertical gaps (road 0.05 → wear 0.08 → junction 0.11 →
   markings **0.16** → crosswalks **0.175**). Markings sit **110–125 mm above** the
   road; the car drives on a collider at 0.05, so the lower edge of every 0.35 m
   tire slices through the paint — exactly your "tires go through the markings" bug.
   The log-depth buffer only needs **4 mm** gaps, so the stack is ~25× taller than
   necessary. (And polygon-offset — the usual decal trick — is silently ignored
   under log-depth, which is why the code reached for physical height.)

2. **Only one model per kind.** The library loads exactly ONE template per prop kind
   (`libraryTemplates.ts`: `Map<PropKind, AssetTemplate>`, picked via a *fixed*
   `libtemplate:<kind>` id) and instances that single mesh everywhere. Your 4 trees /
   7 lamps are pooled but never used. Buildings already vary (per-building pick);
   instanced props don't.

3. **Buildings squash/vanish because `fitToSlot` ignores real height.** It scales a
   library GLB by *footprint* only (`slotExtent/modelExtent`), never `b.heightM`. A
   40 m tower on a small footprint collapses to a ~6 m stub ("disappears" among
   neighbors); a degenerate/empty GLB bbox yields a `-Infinity` transform (truly
   invisible — no guard).

4. **Asphalt reads as flat/repetitive.** Procedural road textures tile visibly with
   no stochastic variation, splat/wear blending, or detail maps — a big part of "roads
   look bad."

5. **Junctions overlap instead of being meshed as one polygon**, so they need the
   height step that causes the crosswalk clip. AAA approach: trim incident roads to
   the junction boundary and mesh one coplanar polygon.

6. **Data variance.** OSM lane counts/widths are patchy; some road inconsistency is
   upstream data, not geometry. Overture/premium data is the real fix there.

## MetaDrive verdict
**Skip it as engine/assets.** It's Python/Panda3D (no web/Three.js path, Apache-2.0)
and ships no reusable road art — roads are abstract RL lane-graph geometry. Worth
borrowing only the *concept* of a lane-graph + Frenet coordinate model, which our
traffic core already has.

## Best things to borrow (permissive licenses)
- **OSM2World** (MIT) — OSM-tag→road/curb/sidewalk/marking rules + openly-licensed
  textures. Best single reference for road geometry from tags.
- **three.js InstancedMesh2 / agargaro instanced-mesh** (MIT) — per-instance frustum
  cull + LOD + per-instance color/scale — directly powers asset variation + LOD.
- **Godot Road Generator** (MIT, technique ref) — spline roads, N-way intersection
  meshing, markings as a transparent overlay on tiling asphalt.
- **CARLA / RoadRunner ideas** — OpenDRIVE→mesh recipe; "Road Painter" splat map for
  asphalt wear variation.
- Stochastic/hex-tile texturing (Heitz–Deliot) to kill asphalt tiling.

---

## Workstreams (prioritized)

### P0 — Flicker + flush markings  ✅ (doing now)
Compress the paint stack from 110–125 mm to ~5–20 mm while keeping ≥4 mm log-depth
gaps: road 0.05, **lane markings 0.055**, wear 0.06, junction 0.065, **crosswalks
0.07**, sidewalk 0.22 (real curb). Lane lines become ~5 mm (visually flush, no tire
clip); crosswalks ~20 mm (down from 125). Update `depthConfig.ts` + `roads.ts`
constants; flicker lint + tests must stay green.

### P1 — Roads (biggest visual win)
- **Asphalt variation**: stochastic/hex-tile sampling + large-scale grunge/splat
  blend so the surface stops tiling; per-segment UV jitter already exists — extend it.
- **Junction-polygon meshing**: trim incident roads to the junction boundary, mesh
  one coplanar surface → removes the junction height step and the crosswalk clip.
- **Road-kit A/B toggle** (separate from Library assets): lets you compare the
  procedural road against Kenney City Kit road tiles. *Assessment: the kit tiles are
  fixed-width grid pieces that can't conform to real OSM widths/curves/intersections,
  so they're a look reference, not a shipping path — but the toggle makes the tradeoff
  visible.* Pending your call (see questions).
- Curb/sidewalk seam sharing; continuous spline-swept UVs (partly done).

### P2 — Asset variation + dimensions + disappearing buildings
- **Multi-template per kind**: hold many templates per `PropKind`, pick per-instance
  via `pickAssetFor(tag, featureId)`, emit one InstancedMesh group per chosen variant
  (synthesize stable ids for generated props). Trees/lamps/benches vary across the city.
- **Fix `fitToSlot`**: make it height-aware (use `b.heightM`, allow mild non-uniform
  scale) + guard empty/degenerate bbox → fall back to procedural (kills the vanish).
- **Dimensions**: verify per-kind canonical heights; detect non-Y-up GLBs.

### P3 — Textures (realism)
- Generate/source better PBR for the worst surfaces (asphalt ×3 wear, sidewalk,
  cobble, brick, stucco, roof, glass) and wire a runtime texture-load path into the
  material factories (the deferred hook). I'll supply image-gen prompts OR source CC0.

Each phase ends with `npm test` + the flicker lint + an in-browser verify.
