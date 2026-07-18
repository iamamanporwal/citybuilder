#!/usr/bin/env node
// Curate the Kenney "City Kit (Roads)" CC0 pack into the pipeline.
//
// Roads in CityBuilder are procedural-from-data and LOCKED (PRD §8) — tile models
// can't provide a driving-grade surface, lane semantics, or trustworthy collision.
// So the 60 road/bridge tiles are catalogued as REFERENCE-ONLY (engine-export use,
// never auto-placed, excluded from the curate studio), exactly like the existing
// Quaternius road tiles. The genuinely useful street PROPS (streetlights, highway
// signs, construction barrier/cone/light) are pooled as normal so they show up in
// the Curate Asset Library studio.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'asset-library', 'kenney_city-kit-roads', 'Models', 'GLB format')
const OUT = join(ROOT, 'assets', 'library', 'kenney-city-kit-roads')
const OUT_GLB = join(OUT, 'glb')

// name-prefix → label. First match wins.
function classify(name) {
  if (/^light-/.test(name)) return { semantic: 'street_furniture', role: 'street_lamp', style: 'kenney-modern', osmTags: ['highway=street_lamp'], internalTags: [] }
  if (/^sign-/.test(name)) return { semantic: 'street_furniture', role: 'sign', style: 'kenney', osmTags: [], internalTags: ['street_sign'] }
  if (/^construction-cone/.test(name)) return { semantic: 'street_furniture', role: 'cone', style: 'kenney', osmTags: [], internalTags: ['traffic_cone'] }
  if (/^construction-barrier/.test(name)) return { semantic: 'barrier', role: 'barrier', style: 'kenney', osmTags: ['barrier=fence'], internalTags: ['temporary_barrier'] }
  if (/^construction-light/.test(name)) return { semantic: 'street_furniture', role: 'cone', style: 'kenney', osmTags: [], internalTags: ['traffic_cone'] }
  // roads / tiles / bridges → reference-only (roads stay procedural)
  return { semantic: 'road_module', role: 'road-tile', style: 'kenney-asphalt', osmTags: ['highway=residential'], internalTags: [], referenceOnly: true }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT_GLB, { recursive: true })

const files = readdirSync(SRC).filter((f) => /\.glb$/i.test(f))
const labels = {}
const tally = {}
for (const f of files) {
  copyFileSync(join(SRC, f), join(OUT_GLB, f))
  const cls = classify(f.replace(/\.glb$/i, ''))
  labels[f] = {
    ...cls,
    license: 'CC0-1.0',
    attribution: 'Kenney (kenney.nl)',
    source: 'Kenney — City Kit Roads (CC0)',
    sourceUrl: 'https://kenney.nl/assets/city-kit-roads',
  }
  const key = cls.referenceOnly ? 'road-tile (reference-only)' : cls.role
  tally[key] = (tally[key] || 0) + 1
}

writeFileSync(join(OUT, 'labels.json'), JSON.stringify(labels, null, 2))
writeFileSync(join(OUT, 'LICENSE.txt'),
  'CC0 1.0 Universal (Public Domain Dedication)\n' +
  'https://creativecommons.org/publicdomain/zero/1.0/\n\n' +
  'Kenney — City Kit Roads. Created/distributed by Kenney (www.kenney.nl).\n' +
  'Credit "Kenney" appreciated but not required.\n')
writeFileSync(join(OUT, 'NOTICE.md'),
  '# Kenney — City Kit Roads (CC0)\n\n' +
  `${files.length} models from https://kenney.nl/assets/city-kit-roads (CC0).\n\n` +
  'Road/bridge tiles are catalogued **reference-only**: CityBuilder roads are\n' +
  'generated procedurally from map data and locked (PRD §8), so tile models are\n' +
  'never auto-placed. The streetlights, highway signs and construction props are\n' +
  'pooled as normal street furniture.\n')
writeFileSync(join(OUT, '.gitignore'), 'glb/*.glb\n!labels.json\n!LICENSE.txt\n!NOTICE.md\n')

console.log(`Curated ${files.length} Kenney road-kit models → ${OUT}`)
console.log(Object.entries(tally).map(([k, n]) => `  ${k.padEnd(28)} ${n}`).join('\n'))
