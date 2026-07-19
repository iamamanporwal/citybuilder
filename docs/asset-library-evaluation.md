# Open-Source 3D Asset & Texture Library Evaluation

**For:** CityBuilder — browser-native (Three.js / WebGL) procedural driving-city renderer.
**Target formats:** GLB/glTF for geometry, KTX2 (Basis Universal) for textures.
**Date:** 2026-07-19
**Scope:** Evaluate permissively-licensed sources across 6 asset categories; prioritize CC0 and commercially-usable. Flag non-commercial / viral (GPL/AGPL/share-alike) licenses as blockers.

> **How to read this doc.** CityBuilder generates road/ground geometry procedurally to conform to real OSM widths and curves. So for most categories the question is not "can we drop this model in?" but "is this a tiling material / point-prop we can attach to procedural geometry, or a fixed-length modular mesh that will fight our splines?" Each entry notes **Drop-in** vs **Procedural-conform needed**.

---

## Executive Summary — Recommended shortlist per category

Best CC0 pick listed first. All picks below are CC0 or fully commercial-safe unless noted.

| # | Category | Recommended (best CC0 first) | Why |
|---|----------|------------------------------|-----|
| 1 | Road/ground PBR materials | **ambientCG** → Poly Haven → cgbookcase | True CC0, 4K–8K, PNG maps, has road/asphalt/concrete/gravel/dirt + a Decal type. Poly Haven for hero surfaces. |
| 2 | Road decals | **ambientCG (Decal type, e.g. AsphaltDamageSet001)** → 3DTexel → 3DTextures.me | CC0 alpha decals (cracks, potholes, manholes, oil, markings) projectable onto road mesh. |
| 3 | Guardrails / barriers / curbs / sidewalks | **Procedural extrusion** (primary) + KayKit / Kenney as reference profiles | No good CC0 modular kit conforms to arbitrary OSM curves; extrude a cross-section along the road spline instead. |
| 4 | Traffic signs / poles / lights / bollards | **Kenney City Kit + KayKit City Builder Bits** → Quaternius | CC0 low-poly point props, tiny GLBs, instanced at procedural positions. Best drop-in fit of all categories. |
| 5 | Trees / bushes / grass / vegetation | **Quaternius (Ultimate/Stylized Nature)** → Kenney Nature Kit → KayKit | CC0, GLB, tiny, instancing-friendly. Impostors/billboards must be generated (none ship them). |
| 6 | Bridge & tunnel kits | **Procedural** (already in codebase) + Kenney/Eclair props as detail | Modular CC0 bridge/tunnel kits won't span real OSM geometry; keep procedural, borrow railings/detail meshes. |

**Single highest-value acquisitions:** ambientCG (materials + decals, one CC0 source covers categories 1 & 2), Quaternius Ultimate Nature (category 5), and the Kenney City Kit / KayKit City Builder Bits pair (category 4). Categories 3 and 6 are best solved procedurally, which matches the codebase's existing direction.

**Do NOT use: 3DStreet.** Its 3D assets are **CC-BY-NC 4.0** (non-commercial) and its code is **AGPL-3.0** (viral). Both are hard blockers for this project. See "Licensing blockers" below.

---

## 1. PBR Road / Ground Materials & Textures

Tiling seamless PBR sets (albedo/basecolor, normal, roughness, AO, displacement/height) for asphalt, concrete, gravel, dirt.

| Option | URL | License | Res / maps | Formats | Browser suitability | Conform |
|--------|-----|---------|-----------|---------|---------------------|---------|
| **ambientCG** | https://ambientcg.com/ ([Road001](https://ambientcg.com/view?id=Road001), [concrete list](https://ambientcg.com/list?q=concrete)) | **CC0** (public domain) | Up to 8K; Color/Normal/Roughness/AO/Displacement/Metalness | PNG + JPG (maps), some EXR/TIFF displacement; also ships Atlas & Decal types and a few glTF models | Excellent. Download 1–2K PNG for web, convert to KTX2. 2000+ materials. | **Drop-in** as tiling material on procedural road mesh (UV/triplanar). |
| **Poly Haven** | https://polyhaven.com/textures ([Asphalt 02](https://polyhaven.com/a/asphalt_02), [Gravel Ground 01](https://polyhaven.com/a/gravel_ground_01), [Worn Asphalt](https://polyhaven.com/a/worn_asphalt)) | **CC0** ([license](https://polyhaven.com/license)) | Up to 8K, physically-scaled (e.g. Asphalt 02 = 3 m wide); Diffuse/Normal/Rough/Displacement/AO | EXR (HDR maps) + JPG/PNG | Excellent for hero surfaces; scanned/scale-accurate. EXR must be downscaled + converted; use JPG/PNG variants → KTX2. | **Drop-in** tiling material; real-world scale helps UV sizing. |
| **cgbookcase** | https://www.cgbookcase.com/textures | **CC0** | Up to 8K; full PBR map set | PNG | Good. Smaller catalog than ambientCG but genuinely CC0. | **Drop-in** tiling material. |
| **ShareTextures** | https://www.sharetextures.com/ ([road](https://www.sharetextures.com/textures/road), [license](https://www.sharetextures.com/p/license)) | **"Custom CC0-based"** — free personal/commercial, **but redistribution restricted** (no re-hosting/bundling in plugins) | ~1K–4K; full PBR | PNG/JPG | Good, but the redistribution clause means it is *not* pure CC0 — fine to ship in a rendered app, avoid re-hosting the raw files. | **Drop-in** tiling material. |

**Category verdict:** ambientCG is the workhorse (largest true-CC0 catalog, one stop for asphalt/concrete/gravel/dirt). Add a couple of Poly Haven scanned asphalts for hero close-ups. Treat ShareTextures as usable-but-not-redistributable. All are drop-in tiling materials — no geometry conforming required, they attach to CityBuilder's procedural road/ground meshes via UVs.

---

## 2. Road Decals (cracks, patches, oil, skid marks, manholes)

Alpha-masked overlays projected onto the road surface (Three.js `DecalGeometry` or projected quads). Placement is procedural; the asset itself is just an RGBA + optional normal map.

| Option | URL | License | Res / maps | Formats | Browser suitability | Conform |
|--------|-----|---------|-----------|---------|---------------------|---------|
| **ambientCG — Decal type** | https://ambientcg.com/list?type=Material,Atlas,Decal ([AsphaltDamageSet001](https://ambientcg.com/view?id=AsphaltDamageSet001)) | **CC0** | Up to 4K; Color + Opacity + Normal + Roughness | PNG (with alpha) | Excellent. Purpose-built decal type with opacity maps. Potholes/road damage sets. Convert to KTX2 (UASTC for alpha edges). | **Drop-in** decal texture; projected procedurally. |
| **3DTexel — Decals** | https://3dtexel.com/decals/ | **CC0** (280+ decals) | Full PBR maps + alpha; cracks, leaks, oil, road markings, grime | PNG | Excellent. Alpha channel included for clean projection. | **Drop-in** decal texture. |
| **3DTextures.me** | https://3dtextures.me/tag/road/ | **CC0** | Seamless PBR incl. manhole covers; Diffuse/Normal/Displacement/Rough/AO | PNG | Good. Some are tiling (manhole cover) rather than alpha decals — use as small textured quads. | **Drop-in** texture; manhole = small quad, others = projected decal. |
| **TextureCan — Decals** | https://www.texturecan.com/category/Decals/ | Free PBR, "free for commercial use" (site's own terms — **verify per-asset**, not explicitly CC0) | ~1K–2K; PBR + alpha | PNG | Good, but confirm license per download before shipping. | **Drop-in** decal texture. |

**Category verdict:** ambientCG's Decal type + 3DTexel cover cracks, potholes, oil, skid, and road-marking decals under clean CC0. Manhole covers come from 3DTextures.me (as a textured disc/quad rather than a projected decal). All drop-in — CityBuilder decides *where* to stamp them procedurally.

---

## 3. Guardrails, Barriers, Curbs, Sidewalks (modular)

**This is the category where "asset library" fits worst.** Guardrails, curbs, and sidewalks are continuous features that must follow arbitrary OSM road curvature and length. Fixed-length modular meshes (e.g. a 4 m barrier segment) tile poorly on curves and create seams/z-fighting.

| Option | URL | License | Poly / detail | Formats | Browser suitability | Conform |
|--------|-----|---------|---------------|---------|---------------------|---------|
| **Procedural extrusion (recommended)** | n/a (in-engine) | n/a | Author a 2D cross-section (curb, sidewalk slab, W-beam barrier profile), sweep it along the road spline | GLB generated at runtime | Best fit; conforms exactly to OSM widths/curves, no seams, instancing not needed. | **Native procedural** — this is the correct approach. |
| **KayKit City Builder Bits** | https://kaylousberg.itch.io/city-builder-bits · https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0 | **CC0** | Low-poly, single atlas | OBJ / FBX / glTF | Tiny GLBs. Use pieces as **reference profiles** or for straight/short segments; won't conform to curves. | **Procedural-conform needed** (kit is straight modules). |
| **Kenney City Kit (Roads/Suburban)** | https://kenney.nl/assets/city-kit-roads | **CC0** | 70 pieces, low-poly, shared texture atlas | OBJ / FBX / glTF | Tiny. Includes some curb/sidewalk-edged road tiles, but they are fixed grid tiles — mismatched to OSM geometry. | **Procedural-conform needed.** |
| **Eclair "City Roads GLB Pack"** | https://eclair-assets.itch.io/city-roads-glb-pack-72-free-cc0-3d-models | **CC0** (72 GLB, repackaging of Kenney-style road/sidewalk/barrier props) | Low-poly | **GLB** (ready) | Convenient GLB-native drop, but same grid-tile limitation. Good source of barrier/cone/cistruction props. | **Procedural-conform needed** for continuous features; **drop-in** for discrete props (cones, temp barriers). |

**Category verdict:** Extrude curbs/sidewalks/guardrails procedurally along the road spline — it's the only thing that conforms to real OSM curves, and the codebase already extrudes road corridors. Use KayKit/Kenney/Eclair only for **discrete** barrier props (traffic cones, water-filled barriers, jersey-barrier short runs) which *are* drop-in point instances.

---

## 4. Traffic Signs, Poles, Lights, Bollards

**Best drop-in fit of all six categories.** These are discrete point props placed at procedurally-computed positions (curbside offset, intersection corners). No conforming needed — just position + rotation + instancing.

| Option | URL | License | Poly / texture | Formats | Browser suitability | Conform |
|--------|-----|---------|----------------|---------|---------------------|---------|
| **Kenney City Kit (Roads / Suburban / Urban)** | https://kenney.nl/assets/city-kit-roads | **CC0** | Hundreds–~2k tris each; single shared colormap atlas PNG | OBJ / FBX / glTF (Embedded + Binary) | Excellent. GLBs are a few KB–tens of KB; one atlas texture for the whole kit → one draw call with instancing. Includes street lights, signs, poles. | **Drop-in** instanced point prop. |
| **KayKit City Builder Bits** | https://kaylousberg.itch.io/city-builder-bits · [GitHub](https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0) | **CC0** (no attribution required) | Low-poly, shared atlas; traffic lights, lamps, bollards, signs | OBJ / FBX / glTF | Excellent. Stylized look (matches CityBuilder's arcade road-kit toggle). Tiny files. | **Drop-in** instanced point prop. |
| **Quaternius (city/utility packs)** | https://quaternius.com/ · [poly.pizza](https://poly.pizza/) | **CC0** | Low-poly, textured variants with normal maps | FBX + **GLB** / glTF | Excellent. GLB-native, instancing-friendly. | **Drop-in** instanced point prop. |
| **Eclair "City Roads GLB Pack"** | https://eclair-assets.itch.io/city-roads-glb-pack-72-free-cc0-3d-models | **CC0** | Low-poly, includes street lights + props | **GLB** (ready) | Excellent — GLB-native, no conversion of format needed (still convert textures to KTX2). | **Drop-in** instanced point prop. |

**Aggregator tip:** [poly.pizza](https://poly.pizza/) hosts the CC0 Kenney/Quaternius catalogs with per-model GLB download and search — fastest way to cherry-pick individual signs/lights/bollards.

**Category verdict:** Kenney City Kit + KayKit City Builder Bits together cover signs, poles, traffic lights, and bollards under CC0 with tiny GLBs and shared atlases (ideal for `InstancedMesh`). Pick one visual style (Kenney and KayKit are both stylized; matches CityBuilder's arcade toggle) to keep the look coherent. Fully drop-in.

---

## 5. Trees, Bushes, Grass, Roadside Vegetation

Instanced scatter props at procedurally-computed positions along roadsides / in green areas.

| Option | URL | License | Poly / texture | Formats | Browser suitability | Conform |
|--------|-----|---------|----------------|---------|---------------------|---------|
| **Quaternius — Ultimate Nature / Stylized Nature MegaKit** | https://quaternius.com/packs/ultimatestylizednature.html · https://quaternius.com/packs/stylizednaturemegakit.html | **CC0** | 60+ assets, low-poly, seamless textures + normal maps | FBX + **GLB** / glTF | Excellent. GLB-native, tiny, instancing-friendly. Birch/maple/dead trees, bushes, flowers, grass, palms. | **Drop-in** instanced scatter. |
| **Kenney Nature Kit** | https://kenney.nl/assets/nature-kit · [Eclair GLB repack](https://eclair-assets.itch.io/nature-kit-glb-pack-329-free-cc0-3d-models) | **CC0** | 330 assets, low-poly, shared atlas | OBJ / FBX / glTF; **GLB** via Eclair repack (329 models) | Excellent. Extremely small, single atlas → one draw call. | **Drop-in** instanced scatter. |
| **KayKit (nature/city bits)** | https://kaylousberg.itch.io/kaykit-complete | **CC0** | Low-poly, atlas | OBJ / FBX / glTF | Excellent, stylized, consistent with KayKit props. | **Drop-in** instanced scatter. |
| **Poly Haven — Plants/Trees models** | https://polyhaven.com/models/trees · https://polyhaven.com/models/plants | **CC0** | **High-poly / photoscanned** (realistic) | glTF / FBX / USD / blend | Realistic but heavy — **needs decimation/LOD** before browser use. Use sparingly for hero trees. | **Drop-in** but requires poly reduction. |

**Impostors / billboards:** None of these packs ship billboard/impostor variants. For distant-vegetation performance you must **generate** impostors yourself — either classic cross-quad billboards from a rendered atlas, or octahedral impostors baked from the GLB. Near/mid-range: instance the low-poly GLBs directly (Kenney/Quaternius are cheap enough to instance in the thousands).

**Category verdict:** Quaternius Ultimate Nature (CC0, GLB, normal-mapped) is the primary pick; Kenney Nature Kit (via Eclair's GLB repack) as a second stylistic option and for its single-atlas draw-call efficiency. Poly Haven only for occasional realistic hero trees after decimation. All drop-in as instanced scatter; impostors are a build step you own.

---

## 6. Bridge & Tunnel Modular Kits

Like category 3, bridges/tunnels must span real OSM geometry (arbitrary length, elevation profile, curvature). **CityBuilder already generates bridges procedurally** (Golden Gate suspension, Charles Bridge stone-arch per project memory), which is the right call — no CC0 kit will conform to real spans.

| Option | URL | License | Detail | Formats | Browser suitability | Conform |
|--------|-----|---------|--------|---------|---------------------|---------|
| **Procedural (recommended, already in codebase)** | n/a | n/a | Deck/arch/suspension solved to OSM span + elevation | GLB at runtime | Best fit; conforms to span and road elevation solve. | **Native procedural.** |
| **Eclair "City Roads GLB Pack"** | https://eclair-assets.itch.io/city-roads-glb-pack-72-free-cc0-3d-models | **CC0** | Includes modular bridge/road/construction props | **GLB** | Good for **detail props** (railings, pillars, deck sections) to dress procedural bridges. | **Procedural-conform needed** for spans; drop-in for detail props. |
| **Kenney City Kit / building kits** | https://kenney.nl/assets/city-kit-roads | **CC0** | Some elevated-road / ramp tiles | OBJ / FBX / glTF | Fixed-grid ramps — reference only. | **Procedural-conform needed.** |
| **Meshy free tunnel models** | https://www.meshy.ai/tags/tunnel | Stated **CC0** on the tag page (AI-generated; **verify per-asset**, quality varies) | Varies | STL/FBX/GLB/OBJ/USDZ | Mixed quality; useful as a starting mesh to modify, not production drop-in. | **Procedural-conform needed.** |

**Avoid:** Most Sketchfab / CGTrader "modular bridge/tunnel" results are **not** CC0 — they carry per-model CC-BY, CC-BY-NC, or paid/royalty-free-with-restrictions terms. Check each model's license tab; do not assume.

**Category verdict:** Keep bridges/tunnels procedural. Harvest CC0 kits (Eclair, Kenney) only for reusable **detail meshes** (guardrails, lamp posts, pillar caps) that instance onto the procedural deck.

---

## Licensing Blockers to Avoid

Flag these clearly — they cannot ship in a commercial browser product without legal exposure or forced source disclosure.

| Source / license | Type | Why it's a blocker |
|------------------|------|--------------------|
| **3DStreet — 3D assets** | **CC-BY-NC 4.0** | **Non-commercial.** Confirmed current: the repo states "Assets such as 3D models, textures, and audio are offered under the Creative Commons By Attribution Non-Commercial License." Commercial use requires a separate paid license (kieran@3dstreet.org). **Do not use the assets.** ([repo](https://github.com/3DStreet/3dstreet)) |
| **3DStreet — code** | **AGPL-3.0** | **Viral / network-copyleft.** Linking or deriving from the code obligates you to release your entire app's source under AGPL, including for network (SaaS) use. Hard blocker for a proprietary product. |
| **CC-BY-SA (share-alike)** | Copyleft | Requires derivative *assets* be relicensed under the same SA terms. Acceptable for a rendered scene, risky if you modify/redistribute the asset files. Avoid for anything you re-export. (Some Sketchfab/community models use this.) |
| **CC-BY-NC / NC-anything** | Non-commercial | Any "NC" tag bars commercial use. Common on Sketchfab, Daz, CGTrader "free" tiers. Always check the license tab. |
| **GPL / LGPL geometry** | Copyleft code license misapplied to assets | Rare but appears; treat like AGPL if it governs code you link. |
| **"Free" marketplace tiers (CGTrader, TurboSquid, Daz, Sketchfab default)** | Custom / royalty-free-with-restrictions | "Free" ≠ CC0. Many forbid redistribution, resale, or require attribution; some are personal-use only. Verify per asset. |
| **ShareTextures redistribution clause** | Custom CC0-based | Use in your app is fine (commercial OK, no attribution), but you **may not re-host or bundle the raw files**. Not a blocker for shipping renders; a blocker for redistributing source textures. |
| **TextureCan / Meshy / other "free for commercial"** | Site-specific terms | Usable but **not** verified pure CC0 — confirm the exact per-asset license before shipping. |

**Green-light (safe, CC0, no attribution required):** ambientCG, Poly Haven, cgbookcase, Quaternius, Kenney, KayKit, Eclair Assets GLB packs, 3DTextures.me, 3DTexel, OpenGameArt items filtered to CC0.

---

## Browser-Integration Notes (KTX2 / Draco / meshopt)

CityBuilder targets GLB + KTX2. None of the CC0 sources above ship KTX2 or compressed GLB — expect a conversion step. Recommended pipeline (all via [`gltf-transform`](https://gltf-transform.dev/) CLI + `toktx`/`basisu`):

**Textures (all raster sources → KTX2 / Basis Universal):**
- Download the **smallest sufficient** resolution (1K–2K for road tiling; 4K only for hero surfaces). 8K PNG/EXR is wasteful for WebGL.
- **EXR → PNG/JPG first** (Poly Haven ships EXR HDR maps). Displacement/height is often unnecessary in-browser — prefer normal + AO; use parallax only if needed.
- Encode to **KTX2**: use **UASTC** for normal maps and alpha decals (preserves edges), **ETC1S** for albedo/roughness/AO (smaller). Generate mipmaps.
- Load with Three.js `KTX2Loader` (needs the Basis transcoder wasm). KTX2 gives GPU-native compressed textures → lower VRAM and no decode stall vs PNG.

**Geometry (GLB):**
- **Kenney / Quaternius / KayKit / Eclair GLBs are already tiny** (few KB–tens of KB, single shared atlas). Draco often adds little; **meshopt** (`gltf-transform meshopt`) is a safe, fast default and decodes cheaply in-browser.
- **Poly Haven models are high-poly / photoscanned** — decimate + generate LODs (`gltf-transform simplify`) before use, or you'll blow the frame budget.
- Merge each prop kit's atlas + geometry so a kit renders in **one draw call**; use `InstancedMesh` for repeated props (signs, lights, trees, bollards).
- Loaders needed: `GLTFLoader` + `DRACOLoader` (if Draco) or `meshopt_decoder` (if meshopt) + `KTX2Loader`.

**Format conversions required by source:**
- ambientCG / cgbookcase (PNG) → resize → KTX2. *(textures only, no geometry)*
- Poly Haven textures (EXR/PNG) → EXR→PNG→KTX2. Poly Haven models (glTF/FBX) → decimate → meshopt GLB → KTX2 textures.
- Quaternius / Kenney / KayKit (FBX/OBJ/glTF) → **prefer the glTF/GLB variant** (or Eclair's GLB repacks) → meshopt → KTX2 atlas. Avoid FBX where a glTF exists.
- Decals (PNG+alpha) → KTX2 (UASTC).

**Procedural vs drop-in summary (for planning integration work):**

| Category | Integration model |
|----------|-------------------|
| 1. Road/ground materials | **Drop-in** tiling PBR on procedural mesh. Lowest effort. |
| 2. Decals | **Drop-in** textures; procedural *placement* (projection). Low effort. |
| 3. Guardrails/curbs/sidewalks | **Procedural extrusion** along spline. Kits = reference profiles + discrete props only. |
| 4. Signs/poles/lights/bollards | **Drop-in** instanced point props. Best ROI. |
| 5. Vegetation | **Drop-in** instanced scatter; **impostors must be generated** for distance. |
| 6. Bridges/tunnels | **Procedural** (already done). Kits = detail props only. |

---

## Source Index (every URL cited)

- ambientCG — https://ambientcg.com/ · Road001 https://ambientcg.com/view?id=Road001 · Decal/Atlas list https://ambientcg.com/list?type=Material,Atlas,Decal · AsphaltDamageSet001 https://ambientcg.com/view?id=AsphaltDamageSet001
- Poly Haven — https://polyhaven.com/ · license https://polyhaven.com/license · textures https://polyhaven.com/textures · Asphalt 02 https://polyhaven.com/a/asphalt_02 · Gravel Ground 01 https://polyhaven.com/a/gravel_ground_01 · Worn Asphalt https://polyhaven.com/a/worn_asphalt · models https://polyhaven.com/models · trees https://polyhaven.com/models/trees · plants https://polyhaven.com/models/plants
- cgbookcase — https://www.cgbookcase.com/textures
- ShareTextures — https://www.sharetextures.com/ · road https://www.sharetextures.com/textures/road · license https://www.sharetextures.com/p/license
- 3DTexel decals — https://3dtexel.com/decals/
- 3DTextures.me — https://3dtextures.me/tag/road/
- TextureCan decals — https://www.texturecan.com/category/Decals/
- Quaternius — https://quaternius.com/ · Ultimate Stylized Nature https://quaternius.com/packs/ultimatestylizednature.html · Stylized Nature MegaKit https://quaternius.com/packs/stylizednaturemegakit.html
- Kenney — City Kit (Roads) https://kenney.nl/assets/city-kit-roads · Nature Kit https://kenney.nl/assets/nature-kit
- KayKit — City Builder Bits https://kaylousberg.itch.io/city-builder-bits · GitHub https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0 · Complete https://kaylousberg.itch.io/kaykit-complete
- Eclair Assets (CC0 GLB repacks) — City Roads https://eclair-assets.itch.io/city-roads-glb-pack-72-free-cc0-3d-models · Nature Kit GLB https://eclair-assets.itch.io/nature-kit-glb-pack-329-free-cc0-3d-models
- poly.pizza (CC0 aggregator) — https://poly.pizza/
- Meshy (verify per-asset) — https://www.meshy.ai/tags/tunnel
- 3DStreet (BLOCKER) — https://github.com/3DStreet/3dstreet · assets dist https://assets.3dstreet.app/
- gltf-transform (tooling) — https://gltf-transform.dev/
</content>
</invoke>
