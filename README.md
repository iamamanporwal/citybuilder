# CityBuilder — MVP

Web-based 3D city editor that turns real map data into an editable, semantically-separated
3D scene, with a click-to-author upgrade flow for buildings. See `citybuilder-prd.md` for the
full product spec; this MVP implements the **P0 core loop**.

## Run it

```bash
npm install
npm run dev        # open http://localhost:5173
```

No API keys required.

**Pick any city in the world**: the app opens on a map — search a place (Nominatim), drag/resize
the selection rectangle (max 4 km², live dimensions), choose data layers, and *Build this area*.
Data is fetched live from Overpass (with mirror fallback) and the last city is cached in
localStorage for instant reload. A bundled sample slice of **Lower Manhattan** (373 buildings —
278 with real heights; 423 road segments; 59 signals; 1,187 trees) at
`public/data/raw_osm.json` works fully offline.

## What works (P0)

- **Area picker**: full-screen Leaflet map (CARTO basemap), place search, draggable/resizable
  selection rectangle with km dimension labels and an area cap, layer toggles, live Overpass
  fetch with progress + error recovery (`src/ui/AreaPicker.tsx`, `src/app/buildCity.ts`).
- **Ingestion → City Graph**: Overpass/OSM adapter (`src/ingest/overpass.ts`) normalizes raw OSM
  into the internal City Graph schema (local ENU meter frame). Other adapters (Overture, premium
  HD-map) plug into the same contract.
- **Procedural base scene**: deterministic road system (per-segment carriageways, raised
  sidewalks + curbs, double-yellow / dashed-white markings, crosswalks, intersection surfaces),
  extruded buildings with window facades, traffic signals, instanced street trees. Every object
  is separate, tagged, and selectable. **Roads are locked** and never part of the replace flow.
- **Editor**: orbit / fly / **drive preview** (press `D` — eye-level validation camera), click &
  shift-click selection, move/rotate/scale gizmos with snapping, hierarchy grouped by type with
  provenance dots + search + review filter, inspector with numeric transforms, full undo/redo.
- **Click-to-replace (the heart)**: select a building → see its real-world reference (Wikidata
  photo, map + Street View links) → choose a provider:
  - *Keep procedural* — always free, always available
  - *Generate 3D (Trellis)* — async job with progress, result cached by slot hash
    (identical footprints generate once), approve/revert review flow. **Simulated locally**
    until a GPU endpoint is configured — see below.
  - *Upload .glb* — real: parsed, auto-scaled, grounded and centered into the slot.
  - *Meshy / Sketchfab* — stubbed in the gateway, disabled until keys are provided.
- **Export**: `city_scene.glb` (visual), `city_collision.glb` (roads/ground as-is + building
  boxes — separate lightweight collision layer), `city_semantics.json` (road centerlines,
  widths, lanes, oneway + per-object provenance/license) — the data a car game's traffic AI
  consumes.

## Wiring real generation (needs from you)

The generation gateway (`src/gateway/providers.ts`) is provider-agnostic. To go live:

1. **Trellis (self-hosted, default)** — a GPU endpoint URL that accepts a reference image and
   returns a GLB. Replace the simulated worker in `runGeneration()` with the HTTP call; the job
   queue, progress UI, caching, slot-fitting and review flow are already in place.
2. **Meshy (premium)** — a Meshy API key; flip `available: true` on the provider entry and add
   the API call.
3. **Sketchfab library** — a Sketchfab OAuth token for in-panel search + download.

## Architecture map

```
src/ingest/       adapters → City Graph (source of truth)
src/procgen/      deterministic geometry: roads, buildings, props, materials
src/scene/        registry: object id → mesh variants, generation cache
src/state/        zustand store: objects, selection, undo/redo, jobs
src/gateway/      provider menu + generation jobs + upload fit-to-slot
src/editor/       R3F viewport, cameras (orbit/fly/drive), gizmos, picking
src/ui/           toolbar, hierarchy, inspector, replace panel, help
src/export/       GLB + collision + semantics export
```

## Known MVP limits (per PRD roadmap)

- Generation is simulated (deterministic enhanced procedural variant) until a GPU/API is wired.
- No tiling/LOD streaming yet (P1) — this slice renders fully; a whole city needs 3D Tiles.
- Terrain is flat (no DEM), no bridges/tunnels rendering, trees aren't individually selectable.
- Licensing: bundled data is ODbL (attribution shown in-app and stamped into exports).

Data © OpenStreetMap contributors (ODbL 1.0).
