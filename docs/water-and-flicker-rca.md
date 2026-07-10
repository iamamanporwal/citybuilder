# Root-cause analysis: over-classified water & surface flicker

Date: 2026-07-10. Both bugs were reproduced and measured on the shipped sample
data (`public/data/raw_osm.json`, Lower Manhattan) before fixing.

---

## Bug 1 — non-water painted blue

### Root causes (ranked by impact, with evidence)

1. **Sea assembly folded into a self-intersecting polygon and accepted flooded
   land.** The old `assembleSea` buffered the merged coastline by a fixed
   600 m offset (`offsetPolyline`), then kept whichever side contained fewer
   building centroids, accepting up to **10 %** of the city's buildings inside
   the sea. Measured on the sample data: the ring self-intersected **418
   times** (a miter offset of a jagged 180-point shoreline folds over itself),
   and the "better" side still contained **30 buildings (8 %)** — which
   *passed* the acceptance test. Earcut triangulation of a self-intersecting
   ring then spills water triangles over land unpredictably.

2. **No sub-tag filtering on `natural=water`.** Any `natural=water` polygon
   became blue. Swimming pools, reflecting pools, basins and wastewater ponds
   carry `natural=water` + a `water=*` sub-tag. (Fountains were only saved by
   an unrelated `amenity=fountain` branch running earlier.)

3. **Unclosed ways implicitly closed.** `waterway`/`natural=water` ways that
   are fragments of multipolygon relations arrive unclosed; triangulating them
   closes them across arbitrary land.

4. **Culverted/covered waterways painted on the surface.** The
   `waterway=river|canal|stream` buffer ignored `tunnel=*`, `covered=yes` and
   `layer<0` — underground channels became blue stripes across blocks. Streams
   /ditches/drains were also buffered despite being invisible at city scale.

5. **No minimum area.** Any ≥4-point ring qualified, down to garden ponds.

Not guilty (checked): CRS/projection is a consistent local equirectangular
frame in both ingest and meshing; the base ground was already land-green, not
blue; winding is normalized in `flatRingGeometry`.

### Fix (whitelist + land-default)

`src/ingest/overpass.ts`:

- `waterProvenance(tags)` is the single admission rule. Water requires
  positive evidence: `natural=water` (sub-tag absent or in
  `WATER_BODY_SUBTAGS` = lake/pond/reservoir/river/canal/oxbow/lagoon/harbour/
  bay), `waterway=riverbank`, or `landuse=reservoir`. Fountains, pools,
  wetlands (→ green), any unknown `water=*` sub-tag, and covered/underground
  features are rejected. Every accepted area records its `provenance` and
  `areaM2`.
- Closed-ring + `MIN_WATER_AREA_M2` (150 m²) + simple-polygon requirements for
  water polygons.
- Waterway buffering restricted to `river`/`canal`, skipping
  tunnel/covered/negative-layer segments. Streams/ditches/drains are no longer
  even fetched (`overpassFetch.ts`).
- **Sea rebuilt structurally**: the merged coastline chain is clipped to the
  scene rectangle and closed *along the rectangle boundary* (no offsetting, so
  no folding). Both closures are candidates; one is accepted only if it is a
  simple polygon containing ≤ max(2, 1 %) building centroids, preferring the
  ring containing a probe on the OSM water side (right of way direction). If
  neither qualifies, **no sea is painted** — land is the default and
  under-painting beats flooding.
- Known limitation: multipolygon water relations (lakes with islands) are not
  ingested (way-level only), and a fully-closed in-view island coastline
  yields no sea. Both err toward land.

Result on sample data: exactly one water body (`natural=coastline`), simple
polygon, **0 buildings** inside.

---

## Bug 2 — flicker

### Root cause: depth-buffer precision, not conceptual coplanarity

The scene layers flat surfaces at 10–30 mm separations (water .012, grass
.022, park .032, … road .05, markings .16). Nothing was exactly coplanar
except overlapping wear decals — yet everything flickered at distance. The
camera used a **standard 24-bit perspective depth buffer with near=1,
far=4500**. The smallest resolvable separation grows quadratically with eye
distance `z`: `dz ≈ z²(f−n)/(n·f·2²⁴)`:

| eye distance | resolvable separation |
|---|---|
| 200 m | 2.4 mm |
| **570 m (default camera)** | **19.4 mm** |
| 1000 m | 60 mm |
| 2000 m | 238 mm |

At the *default* camera distance the depth quantum already exceeded every
adjacent layer gap; zoomed out, the whole 0–220 mm stack collapsed into a
couple of depth values. Offset band-aids cannot fix this — no constant offset
survives a quadratically growing quantum.

Secondary true-coplanar source: wear decals (crack/stain/patch) were placed at
random positions **all at the same Y**, so overlapping quads z-fought at any
distance. (Tile-seam duplicates were investigated and ruled out: ingest is a
single Overpass fetch, ids are unique, junction ribbons are trimmed.)

### Fix at source

1. **Logarithmic depth buffer** (`src/editor/depthConfig.ts` +
   `Viewport.tsx`). Quantum becomes `z·ln(f+1)/2²⁴` ≈ **0.3 mm at 570 m,
   2.26 mm at the far plane** — every layer gap (min 4 mm) is resolvable
   everywhere in the frustum, by construction, not by tuning. Verified live:
   FX-preview composer path renders correctly with it.
2. **Water is carved out of the terrain** (`src/procgen/areas.ts
   buildTerrain`): validated water rings become ShapeGeometry *holes* in the
   ground; the water surface sits 0.35 m below grade with a bank skirt. No
   ground face remains under carved water, so ground/water cannot fight at
   all. Rings that can't be carved safely (non-simple ribbons, overlapping
   holes — earcut can't take intersecting holes) fall back to the painted
   layer, which the log-depth invariant covers.
3. **Decal placement is rejection-sampled** (`src/procgen/decalPlan.ts`): a
   city-wide grid-hashed planner refuses any decal whose bounding circle
   touches an already-placed decal — the only exactly-coplanar layer can no
   longer overlap itself. The `polygonOffset` band-aid on decal materials was
   removed (it is also silently ignored once log depth writes `gl_FragDepth`).

**Deliberately not done — baking lane markings into road textures.** Markings
are junction-trimmed geometric ribbons resolved per region (dash patterns,
double-yellow, crosswalk style) and exported as a separate semantic layer;
baking them would destroy that contract and re-implement the marking system
inside a texture atlas — to fix a symptom whose actual cause was depth
precision. With log depth, the 110 mm road→marking gap has ~50× headroom at
the far plane. If markings are ever baked, it should be for texturing quality,
not flicker.

---

## Regression guards (both run after every build AND as the export gate)

- **`waterLint`** (`src/resolver/waterAudit.ts`): every rendered water polygon
  must carry a whitelist provenance (banned-source regex), meet the minimum
  area, be a simple polygon, and — highest-signal — cover essentially zero
  building centroids. A wrong-side coastline trips it immediately.
- **`flickerLint`** (`src/resolver/lints.ts`): recomputes the worst-case depth
  quantum from `DEPTH_CONFIG` (the same constants the renderer uses) and fails
  if it exceeds the minimum layer separation — so disabling log depth,
  stretching the far plane, or squeezing the layer table turns the linter red.
  Also scans built meshes for near-coplanar overlaps, exact-duplicate
  surfaces, and same-height overlapping decal quads.
- **`npm test` (vitest, 20 tests)**: whitelist behavior (fountains/pools/
  wetlands/streams/culverts/basins never water; lakes/reservoirs/riverbanks/
  rivers are), unclosed-ring rejection, min-area, sea side-selection and
  refusal-to-flood on synthetic coastlines, the real sample city (sea exists,
  simple, 0 buildings flooded), terrain carving (no ground face under carved
  water, water below grade), depth invariants (log flag on, quantum vs.
  separation with 1.5× headroom, a test that documents standard depth would
  fail), and decal non-overlap.
