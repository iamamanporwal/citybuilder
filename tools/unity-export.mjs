#!/usr/bin/env node
// unity-export.mjs — pull a city from the CityBuilder World API (or a local
// `npm run generate` export) and emit a Unity-ready bundle:
//
//   <out>/city_scene.glb        visual city (import with glTFast)
//   <out>/city_collision.glb    physics colliders (extras carry friction etc.)
//   <out>/city_surface.glb      drivable-only subset (wheel raycasts)
//   <out>/unity_city.json       roads/lanes/buildings/signals/spawn, Unity coords
//   <out>/unity_prompt.txt      prompt to paste into Unity AI (Muse/Assistant)
//
// Remote:  node tools/unity-export.mjs --api https://<deploy>.vercel.app \
//            --key $WORLD_API_KEY --preset prague-core --out export/unity-prague
// Local:   npm run generate -- --sample prague --bake
//          node tools/unity-export.mjs --from export/prague --out export/unity-prague
//
// Coordinates: source GLBs/JSON are glTF right-handed, Y-up, meters, origin at
// the area center. Unity is left-handed; glTFast imports GLBs by negating X.
// This script negates X in unity_city.json the same way, so JSON positions
// line up 1:1 with the imported GLB. Pass --keep-gltf-handedness to disable.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PRESETS = {
  // Docs sample: Staré Město (Old Town) — small, fast.
  'prague-old-town': { south: 50.084, west: 14.402, north: 50.092, east: 14.42, name: 'Prague Old Town' },
  // ~10.7 km² core: Old Town, New Town, Malá Strana, castle, river bridges.
  // Just under the World API's 12 km² per-request cap.
  'prague-core': { south: 50.068, west: 14.395, north: 50.098, east: 14.44, name: 'Prague Core' },
}

function parseArgs(argv) {
  const args = { flipX: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--api') args.api = argv[++i]
    else if (a === '--key') args.key = argv[++i]
    else if (a === '--from') args.from = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--name') args.name = argv[++i]
    else if (a === '--preset') args.preset = argv[++i]
    else if (a === '--bbox') {
      const [south, west, north, east] = argv[++i].split(',').map(Number)
      args.bbox = { south, west, north, east }
    } else if (a === '--no-bake') args.noBake = true
    else if (a === '--keep-gltf-handedness') args.flipX = false
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

/** POST the bbox, poll until ready, return the manifest. */
async function generateRemote({ api, key, bbox, name, noBake }) {
  const headers = { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }
  const body = { bbox, name, options: noBake ? { bake: false } : {} }
  console.log(`POST ${api}/api/v1/maps  bbox=${JSON.stringify(bbox)}`)
  let job = await fetchJson(`${api}/api/v1/maps`, { method: 'POST', headers, body: JSON.stringify(body) })
  console.log(`  job ${job.id}: ${job.status}`)
  while (job.status === 'generating' || job.status === 'stalled') {
    await sleep(3000)
    job = await fetchJson(`${api}/api/v1/maps/${job.id}`, { headers })
    process.stdout.write(`\r  job ${job.id}: ${job.status}   `)
  }
  console.log()
  if (job.status === 'failed') throw new Error(`Generation failed: ${job.error}`)
  if (job.status !== 'ready') throw new Error(`Unexpected job status: ${job.status}`)
  return job.manifest
}

/** Resolve one manifest file entry to bytes — Blob CDN URL or local file. */
async function loadFile(entry, localDir) {
  if (entry.url && /^https?:/.test(entry.url)) {
    const res = await fetch(entry.url)
    if (!res.ok) throw new Error(`fetch ${entry.url} → HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  return readFile(join(localDir, entry.file ?? entry.url))
}

const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp
const point = (p, flipX) => [round(flipX ? -p[0] : p[0], 2), round(p[1], 2), round(p[2], 2)]

function polylineLength(line) {
  let len = 0
  for (let i = 1; i < line.length; i++) {
    const dx = line[i][0] - line[i - 1][0]
    const dy = line[i][1] - line[i - 1][1]
    const dz = line[i][2] - line[i - 1][2]
    len += Math.hypot(dx, dy, dz)
  }
  return len
}

/** Reshape city_semantics.json into the Unity-facing city description. */
function buildUnityCity({ manifest, semantics, spawn, flipX }) {
  const roads = (semantics.roads ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    class: r.class, // motorway | primary | residential | footway | ...
    drivable: r.drivable,
    width_m: r.width_m,
    lanes: r.lanes,
    lane_width_m: r.lanes > 0 ? round(r.width_m / r.lanes) : null,
    oneway: r.oneway,
    speed_limit_kmh: r.speed_limit_kmh,
    speed_limit_source: r.speed_limit_source,
    turn_lanes: r.turn_lanes,
    roundabout: r.roundabout,
    bridge: r.bridge,
    tunnel: r.tunnel,
    surface: r.surface,
    length_m: round(polylineLength(r.centerline)),
    // Y = solved elevation (bridges/ramps already resolved), meters.
    centerline: r.centerline.map((p) => point(p, flipX)),
  }))

  const devices = (semantics.traffic_devices ?? []).map((d) => ({
    id: d.id,
    kind: d.kind, // traffic_signal | stop_sign | give_way | road_sign | speed_limit
    position: point(d.position, flipX),
    // glTF X-flip mirrors the world, which negates yaw for Y-up headings.
    heading_rad: round(flipX ? -d.heading_rad : d.heading_rad, 4),
    sign_type: d.sign_type,
    speed_limit_kmh: d.speed_limit_kmh,
  }))

  const buildings = (semantics.objects ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    tier: o.tier,
    position: point(o.position, flipX),
    look: o.resolution ? { facade: o.resolution.facade, roof: o.resolution.roof, tint: o.resolution.tint } : null,
  }))

  const kmByClass = {}
  for (const r of roads) kmByClass[r.class] = round((kmByClass[r.class] ?? 0) + r.length_m / 1000)

  return {
    format: 'citybuilder-unity-city',
    formatVersion: 1,
    city: manifest.city,
    attribution: manifest.attribution, // ODbL — must be shown in-game
    bbox: manifest.bbox,
    bounds: manifest.bounds,
    coordinateSystem: {
      up: 'Y',
      units: 'meters',
      handedness: flipX ? 'left (Unity, X negated to match glTFast import)' : 'right (glTF, as generated)',
      origin: 'area center',
    },
    spawn: spawn?.spawn
      ? {
          position: point(spawn.spawn.position, flipX),
          heading_rad: round(flipX ? -spawn.spawn.heading_rad : spawn.spawn.heading_rad, 4),
        }
      : null,
    stats: {
      roads: roads.length,
      drivable_roads: roads.filter((r) => r.drivable).length,
      road_km_by_class: kmByClass,
      total_road_km: round(Object.values(kmByClass).reduce((a, b) => a + b, 0)),
      buildings: buildings.length,
      traffic_devices: devices.length,
      traffic_audit: semantics.traffic_audit ?? null,
    },
    roads,
    traffic_devices: devices,
    buildings,
  }
}

function unityPrompt(city) {
  return `Build a realistic, browser-and-mobile-optimized city scene from the imported CityBuilder data for ${city.city}. \
city_scene.glb is the authoritative geometry (Y-up, meters, origin at area center); do not regenerate roads or buildings — enhance them. \
unity_city.json lists every road (centerline, lane count, lane width, speed limit, one-way, bridges) plus buildings, traffic signals and a spawn point; use it to place signage, lane markings, street lights and traffic logic. \
Add: URP with one realtime directional light and baked ambient; wind-animated grass and tree foliage along road verges (GPU shader wind, no per-blade physics); clean asphalt with subtle detail normals and crisp lane paint; light fog and bloom tuned for mobile WebGL/WebGPU; GPU instancing and static batching everywhere; texture atlases, no shadows beyond one cascade. \
Target 60 fps desktop browser, 30 fps mid-range phone. Keep the OpenStreetMap attribution visible: "${city.attribution}".`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.from && !args.api)) {
    console.log(`Usage:
  node tools/unity-export.mjs --api <url> [--key <key>] (--preset prague-core | --bbox s,w,n,e) [--name <city>] [--out <dir>]
  node tools/unity-export.mjs --from <export-dir> [--out <dir>]
Options: --no-bake (skip Draco), --keep-gltf-handedness (no X flip)
Presets: ${Object.keys(PRESETS).join(', ')}`)
    process.exit(args.help ? 0 : 1)
  }

  let manifest
  let localDir = null
  if (args.from) {
    localDir = resolve(args.from)
    manifest = JSON.parse(await readFile(join(localDir, 'manifest.json'), 'utf8'))
    console.log(`Local export: ${manifest.city} (${localDir})`)
  } else {
    const preset = args.preset ? PRESETS[args.preset] : null
    if (args.preset && !preset) throw new Error(`Unknown preset "${args.preset}". Have: ${Object.keys(PRESETS).join(', ')}`)
    const bbox = args.bbox ?? preset
    if (!bbox) throw new Error('Provide --bbox s,w,n,e or --preset')
    manifest = await generateRemote({
      api: args.api.replace(/\/$/, ''),
      key: args.key ?? process.env.WORLD_API_KEY,
      bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
      name: args.name ?? preset?.name ?? 'Unity export',
      noBake: args.noBake,
    })
  }

  const out = resolve(args.out ?? `export/unity-${(manifest.city ?? 'city').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
  await mkdir(out, { recursive: true })

  // GLBs straight through; JSON files parsed for the unity_city build.
  const wanted = ['environment', 'collider', 'surface', 'minimap']
  for (const role of wanted) {
    const entry = manifest.files[role]
    if (!entry) continue
    const bytes = await loadFile(entry, localDir)
    await writeFile(join(out, entry.file), bytes)
    console.log(`  ${entry.file}  ${(bytes.length / 1e6).toFixed(1)} MB`)
  }
  const semantics = JSON.parse((await loadFile(manifest.files.semantics, localDir)).toString('utf8'))
  const spawn = manifest.files.spawn ? JSON.parse((await loadFile(manifest.files.spawn, localDir)).toString('utf8')) : null

  const city = buildUnityCity({ manifest, semantics, spawn, flipX: args.flipX })
  await writeFile(join(out, 'unity_city.json'), JSON.stringify(city, null, 2))
  await writeFile(join(out, 'unity_prompt.txt'), unityPrompt(city))

  console.log(`\n${city.city} → ${out}`)
  console.log(`  roads: ${city.stats.roads} (${city.stats.drivable_roads} drivable, ${city.stats.total_road_km} km)`)
  console.log(`  km by class: ${JSON.stringify(city.stats.road_km_by_class)}`)
  console.log(`  buildings: ${city.stats.buildings}, traffic devices: ${city.stats.traffic_devices}`)
  if (city.spawn) console.log(`  spawn: [${city.spawn.position}] heading ${city.spawn.heading_rad} rad`)
  console.log(`  wrote unity_city.json + unity_prompt.txt (${args.flipX ? 'Unity handedness, X flipped' : 'glTF handedness'})`)
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
