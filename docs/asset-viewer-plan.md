# Asset Library + Viewer Upgrade — Plan

**Goal.** Turn the downloaded CC0 3D content into a curated, system-consumable
asset library; give artists live control over 3D quality and materials; and make
the editor viewport feel light. Written to match the *actual* codebase (viewer =
`src/editor/`, assets = `src/scene/` + `tools/build-asset-manifest.mjs`, state =
`src/state/store.ts`, materials = `src/materials/`).

Guiding lens: **PM** (ship value in testable increments, keep defaults safe),
**designer** (controls belong where the artist already looks; nothing surprising),
**engineer** (respect the load-bearing invariants — log-depth buffer, flicker
layer convention, manifest contract tests, pick determinism).

---

## Workstream 1 — Curate the ToxSam CC0 pack (FOCUS)

**Problem.** 991 CC0 GLBs sit in a standalone `asset-library/` folder the pipeline
doesn't read. Filenames are cryptic (`Bench_01_Art.glb`, `GodAnubis_Art.glb`) and
content is stylized/mixed, so a raw dump would inject bizarre assets into cities.

**The scanner already gives us the contract** (`tools/build-asset-manifest.mjs`):
it reads `assets/library/<pack>/{gltf,glb}/`, plus a `LICENSE.txt` and an
**authoritative `labels.json`** keyed by filename. Labels override the filename
lexicon — so we control classification without renaming being load-bearing.

**Plan.**
1. `tools/curate-toxsam.mjs` — reads the ToxSam registry + downloaded GLBs, keeps
   only city-relevant categories (Architecture, Nature, Lighting, Furniture/Park
   Furniture, Signage, Water Feature, Statue/Monument, Infrastructure, Vehicle),
   copies them into `assets/library/toxsam-polygonal-mind/glb/` under **clean
   semantic names** (`bench_01.glb`, `street_lamp_03.glb`, `fountain_02.glb`, …),
   and writes:
   - `labels.json` — per file `{semantic, role, style, osmTags[], license:'CC0',
     attribution, source, sourceUrl}` mapping ToxSam category → the resolver's OSM
     tag vocabulary (bench→`amenity=bench`, lamp→`highway=street_lamp`,
     fountain→`amenity=fountain`, tree→`natural=tree`, sign→`traffic_sign`,
     statue→`historic=memorial`, building→`building=*`).
   - `LICENSE.txt` (CC0 1.0) and `NOTICE.md` (Polygonal Mind / ToxSam attribution).
2. Re-run `node tools/build-asset-manifest.mjs` → folds the pack into `manifest.json`
   pools + coverage report. Category→tag mapping fills the exact coverage gaps.
3. `npm test` — `assetManifest.test.ts` gates schema, pool integrity, scale sanity,
   pick determinism. Fix any flags (high-poly → excluded automatically).
4. Keep `useLibraryAssets` **OFF by default** (unchanged) — this pack is an opt-in
   pool, not a default look. Curation makes it *available and correct*, not forced.

**Why not rename all 991?** Most are metaverse filler. We curate the usable subset
and leave the rest in `asset-library/` (git-ignored) for later review. Honest scope.

---

## Workstream 2 — Viewer performance (make it feel light)

The viewer renders **every frame always** and **never disposes GPU resources on
rebuild**. Those two are the heaviness. Fix in risk order (safe first):

1. **Dispose on rebuild (memory leak, safe, high value).** `buildScene` clears the
   registry Maps but never `.dispose()`s old geometries/materials/textures
   (`src/scene/registry.ts:88-95`). Add a `disposeSceneResources()` that walks the
   old variants and disposes before `.clear()`. Every toggle (library, road scale,
   corridor elevation) currently leaks — this alone stops the slow-down over a session.
2. **On-demand rendering.** No `frameloop` set → R3F renders continuously
   (`src/editor/Viewport.tsx`). Move to `frameloop="demand"` and `invalidate()` on
   camera change / selection / gizmo drag / sun-time change, BUT keep `"always"`
   while `cameraMode !== 'orbit'` (fly/drive need continuous integration) and while a
   gizmo is dragging or the ocean shader is animating. Gate the idle `useFrame`
   loops (ocean uniform, selection-box recompute, shadow-frustum follow) so they
   don't force frames when idle. This is the single biggest FPS/thermal win for the
   common case (artist inspecting a static city).
3. **Cheaper shadows.** 2048² shadow map re-rendered every frame + per-frame
   shadow-camera follow. With on-demand this mostly resolves; also expose shadow res
   via the quality control (WS3).
4. **Deferred / lower-priority:** cross-building geometry merge per tile, `THREE.LOD`,
   and spatial culling/streaming — larger changes, tracked but not in this pass.

Invariants to preserve: **`logarithmicDepthBuffer: true`** stays (flicker linter
depends on it); don't touch the vertical layer convention.

---

## Workstream 3 — 3D quality toggle/slider

**Design.** A single "3D Quality" control in the ⚙ Settings popover
(`src/ui/Toolbar.tsx` `SettingsMenu`), 3 presets — **Performance / Balanced /
High** — plus it drives asset LOD. View-only store field `quality3d` (mirrors the
`fxPreview`/`sunTime` pattern in `store.ts`; no scene rebuild for render knobs).

**What each preset controls:**
| Knob | Performance | Balanced | High |
|---|---|---|---|
| `dpr` cap (`DprController`) | 1.0 | 1.5 | 2.0 |
| shadow map (`shadowRes`) | 1024 | 2048 | 4096 |
| shadows enabled | off | on | on |
| asset LOD bias | LOD2/low | LOD1 | LOD0 |

**Asset LOD.** The manifest already carries a `lods[]` field but it's inert and the
runtime loader flattens all meshes. Two-part fix: (a) pre-generate LOD chains +
Draco compression for library GLBs with the **existing `@gltf-transform` tooling**
(already used in `src/headless/bake.ts`); (b) wire a `DRACOLoader` + `MeshoptDecoder`
into the runtime `GLTFLoader` in `src/scene/libraryTemplates.ts` (currently plain,
so compressed GLBs would fail) and select the LOD mesh by the `quality3d` bias.
Ships behind the library toggle, so default procedural scenes are unaffected.

---

## Workstream 4 — Texture packs (variety)

**Acquire** (all CC0, from prior research): Poly Haven + ambientCG tileable PBR
metallic-roughness sets for the surfaces in `src/materials/` — asphalt/road, cobble,
pavers, concrete/sidewalk, brick, stucco, roof tile/metal, glass. Store under
`assets/textures/<surface>/` with a small `textures.json` (codec, colorspace, tiling).

**Integrate.** Today all textures are **procedurally canvas-generated** at module
load (`src/materials/textures.ts`) — elegant but limited variety. Add an *optional*
runtime-loaded texture path: `library.ts` material factories (`facadeMaterial`,
`roadMaterial`, `roofMaterial`) gain a variant that loads a real PBR set when present
and falls back to the procedural texture. Keeps determinism (seeded pick among
available real sets) and the unlit metallic-roughness authoring rule.

---

## Workstream 5 — Texture changer (in-editor)

**Design.** In the Inspector's single-object view (`src/ui/Inspector.tsx`,
`ReplacePanel.tsx`), add a **"Material"** section: for a selected building/road,
show its current `FacadeSet`/`RoofSet`/`RoofSet`/`RoadSurfaceSet` (from
`resolver/types.ts`) as a thumbnail swatch grid; clicking a swatch swaps the
material live. Includes the new WS4 real texture sets alongside procedural ones.

**Engineering.** No material-edit action exists today. Add a new `Command` kind
`'material'` (`store.ts` `Command` union + `applyCommand`) with before/after so it's
undoable, and an action `setObjectMaterial(id, {facade?, roof?, tint?})` that mutates
the object's `BuildingResolution` and re-applies via `facadeMaterial(...)` on the
live registered `Object3D` (fast path) or rebuilds that one node. Participates in
undo/redo like `swapAsset`/`commitTransform`.

---

## Sequencing & risk

1. **WS1 curation** — isolated, testable, the focus. Ship first.
2. **WS2 disposal + on-demand** — high value, addresses "feels heavy". Test drive/fly/orbit.
3. **WS3 quality toggle** — builds on WS2 knobs.
4. **WS4 texture packs** — acquire + optional runtime path.
5. **WS5 texture changer** — builds on WS4.

Every phase ends with `npm test` (contract + recognizer + flicker invariants) and,
for viewer changes, the `verify` skill (headless Playwright drive-through). Defaults
stay safe: library OFF, procedural look unchanged, quality = Balanced (≈ today).

---

## Status (delivered vs. follow-on)

**Delivered + tested (172 tests green, TSC clean):**
- **WS1** — 117 CC0 props curated into `assets/library/toxsam-polygonal-mind/`
  (`tools/curate-toxsam.mjs`), labeled to OSM tags, folded into `assets/manifest.json`.
  Coverage 10/24 → **20/24** pipeline tags. Heavy GLBs git-ignored (reproducible).
- **WS2** — GPU disposal on rebuild (`registry.ts` snapshot→build→dispose-orphaned,
  protecting template/cache resources) + on-demand `frameloop` in orbit
  (`Viewport.tsx`, `Invalidator`).
- **WS3** — 3D Quality preset (Performance / Balanced / High) in ⚙ Settings →
  DPR + shadow-map res + shadow casting (`types.ts` `QUALITY_PRESETS`, `store.ts`,
  `Viewport.tsx`).
- **WS5** — Texture changer in the Inspector: live facade/roof/tint swap on a
  procedural building, undoable (`'material'` command).

**Scoped follow-ons (deliberately not half-built):**
- **WS3 asset LOD / Draco** — pre-generate LOD chains + Draco-compress library GLBs
  with the existing `@gltf-transform` tooling (`src/headless/bake.ts` pattern), and
  wire a `DRACOLoader` + `MeshoptDecoder` into the runtime loader
  (`src/scene/libraryTemplates.ts:189`, currently plain `GLTFLoader`). Blocked only
  by needing to serve the Draco decoder wasm to the browser (copy
  `three/examples/jsm/libs/draco/` into a served path). This also shrinks the 481 MB
  ToxSam pack to a committable size and lets the quality preset bias asset LOD.
- **WS4 real PBR texture packs** — download CC0 sets and expand the material library:
  - Road/asphalt/cobble/pavers/concrete: **ambientCG** (https://ambientcg.com/),
    **Poly Haven** (https://polyhaven.com/textures, road: /textures/road) — both CC0.
  - Brick/stucco/roof/glass: **3DTextures.me** (https://3dtextures.me/, CC0, full
    ORM map sets), **TextureCan** (https://www.texturecan.com/, CC0).
  - Seam: store under `assets/textures/<surface>/` + `textures.json`; add a real-
    texture branch to `facadeMaterial`/`roadMaterial`/`roofMaterial`
    (`src/materials/library.ts`) that loads a PBR set when present and falls back to
    the procedural canvas texture (`src/materials/textures.ts`). The texture changer
    (WS5) then lists the new sets automatically.
