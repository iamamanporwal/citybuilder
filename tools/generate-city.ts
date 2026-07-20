#!/usr/bin/env tsx
// Headless city export CLI — the same pipeline the World API runs, writing to
// a local directory. Useful for testing the headless path and for handing a
// map to the game without deploying anything.
//
// Usage:
//   npm run generate -- --bbox 50.084,14.402,50.092,14.42 --name "Prague test"
//   npm run generate -- --sample prague --bake
//   npm run generate -- --bbox ... --out exports/boston --road-scale 1.5 --no-trees
//
// Flags:
//   --bbox south,west,north,east   area to fetch from Overpass (≤12 km²)
//   --sample prague|manhattan      use the bundled OSM sample (offline)
//   --name "..."                   city name for semantics/attribution
//   --out dir                      output directory (default export/<slug>)
//   --road-scale N                 road-width multiplier 1..4
//   --no-trees / --no-signals      skip those OSM layers
//   --no-elevation                 disable the network elevation solve
//   --terrain                      enable terrain relief (off by default → flat world)
//   --bake                         Draco-compress GLBs in-process

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCity } from '../src/headless/generate'
import { bakeBundle } from '../src/headless/bake'
import type { BBox } from '../src/ingest/overpassFetch'

const SAMPLES: Record<string, { path: string; name: string }> = {
  prague: { path: 'public/data/prague_osm.json', name: 'Staré Město, Prague' },
  manhattan: { path: 'public/data/raw_osm.json', name: 'Lower Manhattan, New York' },
}

interface Args {
  bbox?: BBox
  sample?: string
  name?: string
  out?: string
  roadScale?: number
  trees: boolean
  signals: boolean
  elevation: boolean
  terrain: boolean
  bake: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { trees: true, signals: true, elevation: true, terrain: false, bake: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--bbox': {
        const parts = (argv[++i] ?? '').split(',').map(Number)
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error('--bbox expects south,west,north,east')
        }
        a.bbox = { south: parts[0], west: parts[1], north: parts[2], east: parts[3] }
        break
      }
      case '--sample': a.sample = argv[++i]; break
      case '--name': a.name = argv[++i]; break
      case '--out': a.out = argv[++i]; break
      case '--road-scale': a.roadScale = Number(argv[++i]); break
      case '--no-trees': a.trees = false; break
      case '--no-signals': a.signals = false; break
      case '--no-elevation': a.elevation = false; break
      case '--terrain': a.terrain = true; break
      case '--no-terrain': a.terrain = false; break
      case '--bake': a.bake = true; break
      default: throw new Error(`Unknown flag: ${flag}`)
    }
  }
  return a
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'city'
}

const fmt = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`

async function main() {
  const args = parseArgs(process.argv.slice(2))

  let raw: unknown
  let name = args.name
  if (args.sample) {
    const sample = SAMPLES[args.sample]
    if (!sample) throw new Error(`Unknown sample "${args.sample}" (have: ${Object.keys(SAMPLES).join(', ')})`)
    raw = JSON.parse(readFileSync(sample.path, 'utf8'))
    name ??= sample.name
  } else if (!args.bbox) {
    throw new Error('Pass --bbox south,west,north,east or --sample prague|manhattan')
  }

  const t0 = Date.now()
  let bundle = await generateCity({
    bbox: args.bbox,
    raw,
    name,
    trees: args.trees,
    signals: args.signals,
    roadScale: args.roadScale,
    corridorElevation: args.elevation,
    terrain: args.terrain,
    onProgress: (m) => console.log(`  ${m}`),
  })

  if (args.bake) {
    console.log('  Draco-compressing GLBs…')
    bundle = await bakeBundle(bundle)
  }

  const outDir = args.out ?? join('export', slug(bundle.city))
  mkdirSync(outDir, { recursive: true })
  const manifestFiles: Record<string, { file: string; role: string; bytes: number; contentType: string }> = {}
  for (const f of bundle.files) {
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data)
    writeFileSync(join(outDir, f.name), data)
    manifestFiles[f.role] = { file: f.name, role: f.role, bytes: data.byteLength, contentType: f.contentType }
    console.log(`  ${f.name.padEnd(24)} ${fmt(data.byteLength)}`)
  }
  const manifest = {
    manifestVersion: 1,
    generator: 'CityBuilder World API',
    city: bundle.city,
    attribution: bundle.attribution,
    versions: bundle.versions,
    bounds: bundle.bounds,
    baked: args.bake,
    files: manifestFiles,
    warnings: bundle.warnings.map((w) => w.message),
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}/`)
  if (bundle.warnings.length) console.log(`${bundle.warnings.length} geometry warning(s) — see manifest.json`)
}

main().catch((e) => {
  console.error(`generate-city failed: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
