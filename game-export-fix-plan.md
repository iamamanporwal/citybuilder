# Game-Export Fix Plan — carving CityBuilder output for the car game

This is the response to `game-engine-output-review.md`. The engine team gave us six
concrete signals. Below: what each one means in plain words, why it happens in our
code, and the exact change that fixes it. Ordered by impact.

Legend: **What the engine saw** → **Why (our code)** → **The fix**.

---

## 1. Files are 55 MB and choke the dev server  ⭐ biggest win

**What the engine saw:** 31 MB scene + 24 MB collider = huge downloads, slow loads,
mobile VRAM crashes.

**Why:** `src/export/exporter.ts` calls `GLTFExporter.parse(..., { binary: true })`
and nothing else. No geometry compression (Draco), no texture compression (KTX2/Basis).
Raw float vertex positions + PNG-ish textures are the whole file. The browser's
`GLTFExporter` **cannot** emit Draco or KTX2 — those need a native encoder.

**The fix:** add a Node post-export bake tool `tools/bake-glb.mjs` using
`@gltf-transform` (Draco for geometry, KTX2/Basis for textures, plus `dedup` + `prune`
+ `weld`). New npm script `npm run bake`. The engine already decodes both, and our
`textures_manifest.json` already names the KTX2 codecs — so this is the one bake step
that was missing. Expected 4–8× smaller.

> Two-stage pipeline: the **browser** exports clean GLBs (with the optimizations in
> §2–§4 baked in), then **`npm run bake`** compresses them. Draco/KTX2 can't run in the
> browser, so they stay a Node step — but everything else moves upstream so the raw
> export is already game-shaped.

## 2. 2,217 materials → draw-call storm  ⭐ the lead's flag

**What the engine saw:** thousands of materials = thousands of draw calls = jank.

**Why:** `facadeMaterial()` and `wallMaterialFor()` mint a **brand-new material per
building** (per-tint + per-instance UV offset), and `roadMaterial()` clones per road
segment. Every clone becomes its own material and its own mesh → its own draw call.

**The fix:** new `src/export/optimizeScene.ts`, run right before export:
1. **Dedup materials** by visual signature (type + color + roughness + metalness +
   texture identity + transparency + side). The only per-instance difference is the
   anti-tiling UV *offset*, which is cosmetic — we drop it so identical looks collapse
   to one shared material. Thousands → a few dozen.
2. **Merge geometry** per shared material into batched meshes (opaque batches; glass /
   decals kept separate so transparency still sorts right). Thousands of meshes →
   a few dozen draw calls.

Safe because the visual GLB is just render + raycast source; gameplay identity lives in
`city_semantics.json`, which is untouched.

## 3. Collider is merged at load (runtime cost / freeze risk)

**What the engine saw:** they merge our collider at load time; the rule is
"1 collider = no freeze."

**Why:** `colliderGroup()` emits **one GLB node per collider** — every road, sidewalk,
building, barrier box. Thousands of nodes the engine has to merge on the main thread.

**The fix:** `colliderGlb.ts` gains `colliderGroupMerged()` — pre-merge trimeshes into a
**handful of nodes grouped by physics behaviour** (drivable asphalt vs. sidewalk vs.
building walls vs. water trigger …). Primitive boxes/cylinders are converted to geometry
and folded into their group. Per-node `extras` (friction, sensor, drivable, class) are
preserved so the engine's loader still reads them — it just gets ~10 nodes, not 5,000.
`formatVersion` bumps 1 → 2 with a `merged: true` flag (coordinated breaking change).

## 4. No spawn point, no minimap → hand-picked by the engine dev

**What the engine saw:** had to hand-pick the spawn from semantics; minimap falls back
to the full surface.

**Why:** we export scene + collision + semantics + texture manifest — but no spawn and
no dedicated minimap.

**The fix:** `src/export/spawn.ts` + two more export files, auto-derived from data we
already have:
- `citymap_spawn.json` — a wide, drivable, non-bridge road near the city centre, with a
  start `position [x,y,z]` and `heading` (radians) down its centerline.
- `citymap_minimap.glb` — a flat, roads-only mesh (thin ribbons colored by road class),
  tiny, for the top-down map.

New map = zero code edits, just files.

## 5. `KHR_materials_unlit` → won't react to day/night

**What the engine saw:** the extension is present, so (parts of) the city render
fullbright and ignore the game's lighting.

**Why:** buildings and roads are already lit `MeshStandardMaterial` (good). But road
**markings** and **traffic-signal bulbs** are `MeshBasicMaterial`, and `GLTFExporter`
emits `MeshBasicMaterial` as `KHR_materials_unlit`. That's the only source of the
extension.

**The fix:** in `src/procgen/materials.ts`, convert markings to a plain lit
`MeshStandardMaterial` (they should catch daylight) and signal bulbs to
`MeshStandardMaterial` with `emissive` (they should still glow, and now also react to
bloom in the engine). Result: **no `KHR_materials_unlit` anywhere** — fully day/night
reactive, still "clean PBR, no baked light."

## 6. Node 20 vs. required 22+ (environment)

**What the engine saw:** `npm run dev:full` silently crashes on Node 20 serving big GLBs.

**Why:** not a code bug — the toolchain wants Node ≥ 22.12.

**The fix:** add `engines.node >= 22.12` to `package.json` and a `.nvmrc` so the version
is pinned and `nvm use` just works. (§1 also removes the "big GLB" trigger.)

---

## Files touched

| File | Change |
|---|---|
| `src/procgen/materials.ts` | markings/signals off `MeshBasicMaterial` (§5) |
| `src/export/optimizeScene.ts` | **new** — material dedup + geometry merge (§2) |
| `src/export/colliderGlb.ts` | `colliderGroupMerged()` (§3) |
| `src/export/spawn.ts` | **new** — spawn + minimap builders (§4) |
| `src/export/exporter.ts` | wire optimizer, merged collider, emit spawn + minimap |
| `tools/bake-glb.mjs` | **new** — Draco + KTX2 bake step (§1) |
| `package.json` | `bake` script, `engines`, bake devDeps |
| `.nvmrc` | Node 22 pin (§6) |

## Verification

- `npm test` (collider/flicker/water/recognizer invariants must stay green).
- `.claude/skills/verify` Playwright drive/export probe: build a city, export, confirm
  6 files download, material count is small, collider node count is small, no
  `KHR_materials_unlit` in the scene GLB, spawn point sits on a drivable road.
- Self-review pass for bugs, then fix.
