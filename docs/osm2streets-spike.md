# osm2streets integration spike

**Verdict: feasible — GO.** `osm2streets` (a-b-street/osm2streets, **Apache-2.0**) can
produce lane-accurate street geometry and proper intersection polygons from our
existing OSM data, headless, via a **prebuilt WASM** — no Rust toolchain, no
build step. This is the data foundation for a lane-level road renderer that would
replace the ribbon + junction-disc geometry in `procgen/roads.ts`.

Reproduce: `node tools/osm2streets-spike.mjs` (uses the bundled Lower Manhattan
sample; `--dump out.geojson` writes the lane polygons).

## What was proven

Package: **`osm2streets-js@0.1.4`** (npm). Ships `osm2streets_js.js` (wasm-bindgen
"web" glue) + `osm2streets_js_bg.wasm` (~1.9 MB) + `.d.ts`. Apache-2.0.

On the real **Lower Manhattan** sample (2,762 ways, 17,065 nodes, 2.25 MB OSM XML):

| output | count | build time |
|---|---|---|
| lane polygons | **1,575** (407 Driving, 415 Sidewalk, 587 Footway, 51 Biking, 41 Bus, 28 SharedUse, 27 Shoulder, 19 Construction) | **~590 ms** |
| lane markings | 11,184 | |
| intersection polygons | 246 | |

Each lane polygon carries `{ type, direction, width, index, road, osm_way_ids,
speed_limit, allowed_turns, layer }` — enough to mesh driving lanes, raised
sidewalks, bike/bus lanes and turn markings directly, and intersections come as
real polygons (the osm2streets right-angle junction solve — the fix for our
"stamped disc" look).

## API (what we call)

```js
import { initSync, JsStreetNetwork } from 'osm2streets-js/osm2streets_js.js' // no main/exports field → import the file
initSync(new WebAssembly.Module(wasmBytes))                                  // headless; in Vite use default init()
const net = new JsStreetNetwork(osmXml, clipGeoJson /* '' = whole input */, options)
net.toLanePolygonsGeojson()        // lane surfaces (GeoJSON polygons, lon/lat)
net.toLaneMarkingsGeojson()        // dashed/solid lane lines
net.toIntersectionMarkingsGeojson()// junction polygons + crossings
net.toGeojsonPlain()               // road centerlines + intersections
```

`options` must be the **full `ImportOptions` struct** or the constructor throws
`missing field ...`:
```js
{ debug_each_step:false, dual_carriageway_experiment:false,
  sidepath_zipping_experiment:false, inferred_sidewalks:true,
  inferred_kerbs:true, osm2lanes:false }
```

## Gotchas found

- **Input is OSM XML, not Overpass JSON.** Our ingest keeps Overpass JSON. The
  spike converts it (`overpassToOsmXml` in the tool). Ways in "out geom" mode
  reference node ids with no standalone element — every referenced node must be
  synthesised from the index-aligned `way.geometry`, or osm2streets reports
  "intersection with no roads" and yields almost nothing (144 ways → 55 lanes vs
  the correct 1,575).
- **Coordinates are lon/lat.** Outputs must be projected into our local ENU
  metres (we already have the lat/lng→local projection in ingest).
- Benign warnings on real data ("Road trimmed into oblivion", "degenerate
  intersection") — osm2streets drops those roads; not fatal.

## Integration plan (the bigger build — needs its own go-ahead)

This is an **alternative road pipeline**, parallel to `procgen/roads.ts`, best
landed behind an experimental flag / in the headless World API first:

1. **Input** — fetch OSM XML alongside Overpass JSON (or convert JSON→XML as the
   spike does). The World API already has the OSM in hand.
2. **Run** — load the WASM (Vite: `init()` with the `.wasm` as an asset; headless:
   `initSync`), build once per area (~0.6 s for a Manhattan tile).
3. **Project** — GeoJSON lon/lat → local ENU metres via the existing projection.
4. **Mesh** — driving lanes flat at road height; sidewalk/footway lanes as raised
   slabs (reuse `raisedRibbonGeometry`); intersection polygons as the junction
   surface (replaces the convex-hull disc); lane + intersection markings as
   painted quads. Reuse the current material library + flicker layer convention.
5. **Colliders / semantics / export** — regenerate from the lane polygons; keep
   the versioned export contracts.

**Effort:** medium-large (a new renderer module + OSM-XML input + projection +
meshing + colliders). **Risk:** isolated behind a flag; the current improved
procedural pipeline stays the default until the lane renderer reaches parity.
**Payoff:** genuine lane-level roads (turn lanes, bike/bus lanes, real junction
polygons) — the step-change the current ribbon system can't reach.
