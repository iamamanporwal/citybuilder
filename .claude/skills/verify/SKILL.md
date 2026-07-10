---
name: verify
description: Build, launch and drive CityBuilder to verify changes end-to-end (WebGL SPA, Playwright headless works)
---

# Verifying CityBuilder

## Launch

```bash
npm run dev -- --port 5199 --strictPort   # check first: a dev server may already be on 5199
```

Vite serves live source, so an already-running server reflects working-tree changes.

## Drive with Playwright (headless Chromium renders WebGL fine on this Mac)

Install in the scratchpad (not the repo): `npm i playwright && npx playwright install chromium`.
Launch args that worked: `['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist']`.

Flow to reach a built city:
1. `page.goto(...)` → AreaPicker appears.
2. Click **"Load sample · Lower Manhattan"** → wait for `canvas`, then ~12 s for ingest + procgen.
3. Dismiss the welcome overlay: click **"Start building →"** (it eats keyboard input otherwise).

Useful probes:
- **Drive mode**: `page.keyboard.press('KeyD')` (only from orbit). Rapier chunk + wasm + collider
  build ≈ 8 s on first entry, ~3 s after. Hold `KeyW` to accelerate. Read speed from
  `.sb-mode` in the StatusBar (`"DRIVE · 94 km/h"`). `Escape` returns to orbit.
- **Export**: click **"⬇ Export city"** with `acceptDownloads: true`; four downloads arrive
  (city_scene.glb, city_collision.glb, city_semantics.json, textures_manifest.json).
  GLB JSON chunk starts at byte 20, length at byte 12 (uint32 LE) — parse it to check
  node `extras` (collider/semantics/physicsMaterial).

## Gotchas

- An occasional `ERR_HTTP2_PROTOCOL_ERROR` + Vite reconnect early in page load can reload the
  page and reset to the picker — do UI steps after `waitUntil: 'load'` + a settle sleep.
- Tests import procgen/ingest/resolver only; `src/materials/` needs DOM (canvas textures), so
  anything importing it (roads.ts, registry.ts) must be vi.mock'd in node tests.
