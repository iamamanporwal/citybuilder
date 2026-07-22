# CityBuilder OSM — Blender add-on (v0.5 "production")

Build a game-ready 3D city in Blender from OpenStreetMap: **framed roads** (curbs,
sidewalks, grass verges, lane markings, crosswalks, junction pads), **elevation**
(corridor solve + flat/hills/real-DEM terrain), **buildings v2** (courtyard holes, gabled/
hipped/pyramidal roofs, procedural facade shaders with lit windows), **landmark bridges**
(suspension + stone arch), **street props** (lamps, signals, signs), and **one-click game
export** (`unity_city.json` + `city_scene.glb`, matching the CityBuilder app contract).

Docs: [PLAN.md](PLAN.md) (roadmap) · [SPEC.md](SPEC.md) (module contracts) ·
[specs/](specs/) (engineering specs ported from the app).

```
citybuilder_osm/            add-on source (Blender extension, pure stdlib)
citybuilder_osm-0.5.0.zip   ready-to-install package
test_headless.py            integration matrix (quick | prague | goldengate)
test_matlib.py/test_export.py  Blender-side module tests
showcase.py                 Cycles beauty renders from a saved .blend
```

## Install / upgrade

> If v0.1 is already installed, installing the new zip over it upgrades in place
> (same extension id). Restart Blender afterwards.

1. Blender 4.2+ (tested on 5.1): https://www.blender.org/download/ or `brew install --cask blender`.
2. **Edit ▸ Preferences ▸ Get Extensions ▸ ˅ (top-right) ▸ Install from Disk…** → pick
   `citybuilder_osm-0.5.0.zip`.
3. **Preferences ▸ System ▸ Network → enable "Allow Online Access"** (OSM fetch; the DEM
   terrain mode also downloads elevation tiles).

## Use

1. 3D viewport → press **N** → **CityBuilder** tab.
2. Pick a **Location preset** (Prague, Golden Gate, Manhattan, London, Tokyo) or enter
   lat/lon (Google Maps right-click copies coordinates).
3. Choose **Terrain**: Flat / Gentle hills / Real elevation (AWS Terrain Tiles).
4. **Build City** — blocks 10–60 s depending on radius (progress in the cursor).
5. **See the materials: press Z → Material Preview** (Solid mode shows flat colors only).
   Best quality: switch render engine to Cycles and use Z → Rendered.
6. **Export for game**: the panel's *Export Game Bundle* writes `unity_city.json`,
   `citymap_spawn.json`, and `city_scene.glb` (glTF is Y-up; Unity X-flip handled like the
   app's exporter).

## Headless test matrix (CI-able)

```sh
blender --background --factory-startup --online-mode --python test_headless.py -- quick outdir
blender --background --factory-startup --online-mode --python test_headless.py -- prague outdir
blender --background --factory-startup --online-mode --python test_headless.py -- goldengate outdir
# beauty renders from a saved matrix .blend:
blender --background outdir/prague.blend --python showcase.py -- outdir/prague_beauty [bridge]
```

Each scenario asserts geometry counts and renders an overview + a **driver-camera** shot.
Every pure module also self-tests: `cd citybuilder_osm && python3 <module>.py`.

## Rebuild the zip

```sh
blender --command extension build --source-dir citybuilder_osm \
        --output-filepath citybuilder_osm-0.5.0.zip
blender --command extension install-file --repo user_default --enable citybuilder_osm-0.5.0.zip
```

## Attribution (ship with your game)

- Map data: **© OpenStreetMap contributors (ODbL 1.0)** — embedded in every export.
- DEM terrain: Terrain tiles by Mapzen/Tilezen via AWS Open Data; SRTM/3DEP courtesy USGS.

## Known limits (v0.5 → see PLAN.md)

- Procedural materials only — photographic PBR textures (ambientCG, CC0) are v0.6.
- Junction pads are convex hulls + corner arcs; the osm2streets trim-back port lands v0.6.
- Hipped roofs are ridge approximations (bpypolyskel vendoring is v0.6); complex/concave
  footprints fall back to flat.
- Tree-lawn does not yet taper at junction mouths; tunnels are skipped, not rendered.
- UI blocks during fetch; radius capped at 1.5 km (tiled fetch is v0.6).
- Parallel-mapped ways (dual carriageways, segregated cycle tracks) are swept
  independently and overlap instead of merging into one cross-section — the
  osm2streets pre-pass (v0.6) merges them. Paths/cycleways already follow terrain.
- Heavy Overpass boxes (giant park relations, e.g. Golden Gate/Presidio) can 504;
  the fetch degrades gracefully (relations dropped) but may still fail under
  mirror load — retry, shrink radius, or use the tiled fetch when it lands.
