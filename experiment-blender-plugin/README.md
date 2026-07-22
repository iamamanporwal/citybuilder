# CityBuilder OSM — Blender add-on (MVP v0.1)

Build a real, editable 3D city in Blender from OpenStreetMap data, using the same
semantics as the CityBuilder web app (road widths, water whitelist, building heights).

See [PLAN.md](PLAN.md) for the full technical plan and roadmap (framed roads via
Geometry Nodes, terrain, landmarks, game-export bridge).

```
citybuilder_osm/            the add-on source (Blender extension)
citybuilder_osm-0.1.0.zip   ready-to-install package
test_headless.py            no-GUI smoke test (fetch → build → render)
```

## Install (never used Blender before? start here)

> **Already done on this Mac** — the extension was installed and enabled via CLI.
> Skip to **First build**. On another machine, follow the steps below.

1. Install Blender 4.2 or newer (this was tested on 5.1): https://www.blender.org/download/
   or `brew install --cask blender`.
2. Open Blender. Go to **Edit ▸ Preferences ▸ Get Extensions**, click the **˅** dropdown
   arrow in the top-right corner, choose **Install from Disk…**, and pick
   `citybuilder_osm-0.1.0.zip`.
3. Still in Preferences, go to **System ▸ Network** and make sure
   **Allow Online Access** is enabled (the add-on downloads map data from the internet).
4. Close Preferences.

Re-installing an updated zip over the old one just works (same id = upgrade).

## First build

1. In the 3D viewport, press **N** (or click the tiny `<` arrow at the top-right of the
   viewport) to open the sidebar. Click the **CityBuilder** tab.
2. Enter a latitude/longitude (defaults are Prague Staré Město; grab coordinates from
   Google Maps with right-click ▸ "50.08700, 14.42080") and a radius (400 m is a good start).
3. Click **Build City**. The Overpass fetch takes 5–30 s and Blender will freeze during it —
   that's normal for v0.1. A status line at the bottom reports what was built.
4. Navigate: orbit with middle-mouse drag (or two-finger drag on a trackpad), zoom with
   scroll, `Home` key frames everything. Press **Z** and pick *Rendered* or *Material
   Preview* for shaded colors.

Everything lands in a `CityBuilder` collection (top-right Outliner). **Clear City**
removes it all; **Build City** on new coordinates replaces the old city.

## Editing tips (the point of being in Blender)

- Tick **Separate building objects** before building to get one object per building —
  click any building, press `Tab` to edit its verts, extrude roofs, bevel edges.
- With the default merged mesh: select the Buildings object, `Tab`, hover a building,
  press `L` to select just it (linked), then edit — or `P ▸ By Loose Parts` to split all.
- Materials are plain Principled BSDF (`CB Building`, `CB Water`, …) — recolor once,
  everything updates.
- Export for the game: **File ▸ Export ▸ glTF 2.0 (.glb)** — glTF is Y-up like the app.

## Headless smoke test (CI-able)

```sh
blender --background --factory-startup --online-mode \
        --python test_headless.py -- /path/to/outdir
```

Fetches Prague (300 m), asserts non-trivial geometry, writes `test_city.blend` and
`test_render.png` to the outdir.

## Rebuild the zip after code changes

```sh
blender --command extension build --source-dir citybuilder_osm \
        --output-filepath citybuilder_osm-0.1.0.zip
# optional: install straight into your Blender
blender --command extension install-file --repo user_default --enable citybuilder_osm-0.1.0.zip
```

## Known MVP limits (see PLAN.md roadmap)

- Flat world: no terrain, bridges at grade, tunnels skipped.
- Roads are flat ribbons (real curb/verge cross-sections are v0.2, via Geometry Nodes).
- Building courtyards (multipolygon holes) not carved yet; flat roofs only.
- UI blocks during the fetch; radius capped at 1.5 km.
