# CityBuilder World API

Turn any real-world bounding box into a drivable 3D map the car game downloads
at runtime. Deployed on Vercel; artifacts live in Vercel Blob behind a CDN.

```
game ── POST /api/v1/maps {bbox, options} ──► job id (deterministic cache key)
game ── GET  /api/v1/maps/{id}            ──► generating | ready + manifest | failed
game ── fetch manifest.files.*.url        ──► GLBs + JSON from the Blob CDN
```

The same bbox + options always hashes to the same id, so a map generated once
(≈10–60 s) is returned instantly forever after — teammates testing the same
neighborhood hit the cache.

## Endpoints

### POST /api/v1/maps

```jsonc
{
  "bbox": { "south": 50.084, "west": 14.402, "north": 50.092, "east": 14.42 },
  "name": "Prague Old Town",              // optional display name
  "options": {                             // all optional, defaults shown
    "trees": true,
    "signals": true,
    "roadScale": 1,                        // road-width multiplier 1..4
    "corridorElevation": true,             // network elevation solve (bridges/ramps)
    "bake": true                           // Draco-compress GLBs (game supports Draco)
  }
}
```

Area cap: **12 km²** per request (Overpass fetch is tiled internally above 6 km²).

Responses:
- `200 { id, status: "ready", manifest }` — cache hit, use it immediately
- `202 { id, status: "generating", poll: "/api/v1/maps/{id}" }` — poll every few seconds
- `400 { error }` — bad bbox / body, `401` — bad `x-api-key`

### GET /api/v1/maps/{id}

- `200 { id, status: "generating" | "stalled", startedAt }`
- `200 { id, status: "ready", manifest }`
- `200 { id, status: "failed", error }` — re-POST the same body to retry
- `404` — unknown id

### Auth

Send `x-api-key: <key>`. Keys are configured via the `WORLD_API_KEYS` env var
(comma-separated) on the Vercel project; if unset the API is open (dev mode).
CORS is `*` by default (override with `WORLD_API_CORS_ORIGIN`), and the Blob
file URLs are public + CDN-cached, so browser games can fetch everything
directly.

## Manifest (contract v1)

```jsonc
{
  "manifestVersion": 1,
  "contract": "w1.s3.c2",           // bump ⇒ cached maps regenerate
  "id": "9f2c31ab8d4e07aa",
  "city": "Prague Old Town",
  "attribution": "© OpenStreetMap contributors (ODbL)",  // must be shown in-game
  "bbox": { "south": ..., "west": ..., "north": ..., "east": ... },
  "versions": { "semantics": 3, "collider": 2, "spawn": 1 },
  "bounds": { "minX": ..., "maxX": ..., "minZ": ..., "maxZ": ... },  // meters
  "coordinateSystem": { "up": "Y", "units": "meters", "scale": 1 },
  "baked": true,
  "files": {
    "environment": { "url": "...", "file": "city_scene.glb",      "bytes": ..., "contentType": "model/gltf-binary" },
    "collider":    { "url": "...", "file": "city_collision.glb",  ... },
    "surface":     { "url": "...", "file": "city_surface.glb",    ... },  // drivable-only subset
    "minimap":     { "url": "...", "file": "citymap_minimap.glb", ... },
    "semantics":   { "url": "...", "file": "city_semantics.json", ... },
    "spawn":       { "url": "...", "file": "citymap_spawn.json",  ... },
    "textures":    { "url": "...", "file": "textures_manifest.json", ... }
  },
  "warnings": ["..."]               // export-gate lint messages, informational
}
```

The roles map onto the game's conform set: `environment` = `*_environment.glb`,
`surface` = `*_surface.glb`, `collider` = `*_collider.glb`, `minimap` =
`*_minimap.glb`. Everything is Y-up, meters, 1:1 scale, origin at the area
center.

### File contents

- **environment** — visual scene, unlit-friendly metallic-roughness PBR,
  materials deduped + meshes batch-merged. No lights/shadows/post-FX baked in.
- **collider** — ~10–15 merged trimesh nodes grouped by physics behaviour.
  Each node's glTF `extras` carries `collider.kind` (trimesh/box/cylinder),
  `semantics` (`class`, `drivable`, `bridge`, `sensor`, `surfaceTag`…) and
  `physicsMaterial` (`friction`, `restitution`). Build Rapier colliders from
  these; use trimesh sanitization flags on construction.
- **surface** — the `drivable && !sensor` subset of the collider set, as its
  own GLB for wheel-contact raycasts.
- **semantics** — `semanticsVersion: 3`: per-road centerlines `[x,y,z][]` in
  true meters (y = solved elevation), `speed_limit_kmh`, `lanes`, `oneway`,
  `turn_lanes`, `roundabout`, cross-sections, plus `traffic_devices[]`
  (signals/stop/give-way/speed signs with position + heading) and a
  `traffic_audit`. This is the road graph for future AI traffic.
- **spawn** — `spawnVersion: 1`, auto-derived spawn position + heading on a
  drivable road.

## Game-side loading sketch (three.js + Rapier)

```ts
const res = await fetch(`${API}/api/v1/maps`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify({ bbox }),
})
let { id, status, manifest } = await res.json()
while (status === 'generating') {
  await sleep(3000)
  ;({ status, manifest } = await (await fetch(`${API}/api/v1/maps/${id}`, { headers: { 'x-api-key': KEY } })).json())
}

const env = await gltfLoader.loadAsync(manifest.files.environment.url) // Draco-enabled loader
scene.add(env.scene)

const col = await gltfLoader.loadAsync(manifest.files.collider.url)
col.scene.updateMatrixWorld(true)
col.scene.traverse((n) => {
  const x = n.userData
  if (!x?.collider) return
  if (x.collider.kind === 'trimesh' && n.geometry) {
    const geo = n.geometry.index ? n.geometry : mergeVertices(n.geometry)
    const desc = RAPIER.ColliderDesc.trimesh(
      geo.attributes.position.array, geo.index.array,
      4 | 16 | 32 | 64, // sanitization flags — required for downloaded geometry
    )
      .setFriction(x.physicsMaterial.friction)
      .setRestitution(x.physicsMaterial.restitution)
      .setSensor(x.semantics.sensor)
    world.createCollider(desc)
  }
})

const spawn = await (await fetch(manifest.files.spawn.url)).json()
car.teleport(spawn.spawn.position, spawn.spawn.heading_rad)
```

Show `manifest.attribution` in-game (OSM ODbL requirement).

## Local CLI (no deployment needed)

```
npm run generate -- --bbox 50.084,14.402,50.092,14.42 --name "Prague test" --bake
npm run generate -- --sample prague --bake          # offline, bundled OSM sample
```

Writes the same file set + `manifest.json` to `export/<slug>/`.

## Deploying

1. `vercel link` the repo, create a **Blob store** in the Vercel dashboard and
   connect it (sets `BLOB_READ_WRITE_TOKEN`).
2. Set `WORLD_API_KEYS` (comma-separated secrets for the game + team).
3. `vercel deploy`. The SPA and the API ship together; `vercel.json` gives the
   generator function 300 s / 3 GB.

Known limits (v1): 12 km² cap per map; textures are PNG (KTX2/Basis packing —
the iOS VRAM win — still belongs to the downstream bake step, tracked via
`textures_manifest.json`); one generation at a time per warm function instance
(concurrent requests for different areas may queue briefly).
