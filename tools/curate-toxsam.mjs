#!/usr/bin/env node
// Curate the downloaded ToxSam / Polygonal Mind CC0 pack (asset-library/) into the
// CityBuilder asset-library pipeline format: assets/library/toxsam-polygonal-mind/.
//
// - Selects only genuinely city-usable assets by role (name-keyword classifier).
// - Renames to clean semantic names (<role>_<nn>.glb) for readability/debuggability.
// - Favours the LIGHTEST files per role (smaller GLB ~ lower poly → web-friendly).
// - Writes an AUTHORITATIVE labels.json (the scanner trusts it over filenames),
//   mapping each asset to the resolver's OSM tag vocabulary so it pools correctly.
// - Writes LICENSE.txt (CC0 1.0) + NOTICE.md (attribution).
//
// Then run `node tools/build-asset-manifest.mjs` to fold it into assets/manifest.json.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'asset-library')                                  // downloaded pack + manifest
const OUT_DIR = join(ROOT, 'assets', 'library', 'toxsam-polygonal-mind')     // pipeline location
const OUT_GLB = join(OUT_DIR, 'glb')

// Role classifier — ordered, first match wins. Maps a stylized-metaverse asset to
// a CityBuilder role + semantic + OSM tag(s). `cap` bounds how many we keep per role
// (variety without bloat); we keep the lightest `cap` files. semantic picks the
// scanner's triangle/size budget bucket.
const ROLES = [
  { role: 'fire_hydrant', re: /hydrant/i,                                   semantic: 'street_furniture', osm: ['emergency=fire_hydrant'], cap: 12 },
  { role: 'bollard',      re: /bollard/i,                                   semantic: 'street_furniture', osm: ['barrier=bollard'],        cap: 16 },
  { role: 'bench',        re: /bench|seat(?!ing_area)/i,                    semantic: 'street_furniture', osm: ['amenity=bench'],          cap: 24 },
  { role: 'street_lamp',  re: /lamp|lantern|street.?light|light.?post|lamppost|streetlamp/i, semantic: 'street_furniture', osm: ['highway=street_lamp'], cap: 24 },
  { role: 'fountain',     re: /fountain|water.?fall|water.?fx|waterfeature/i, semantic: 'street_furniture', osm: ['amenity=fountain'],     cap: 12 },
  { role: 'bin',          re: /trash|garbage|\bbin\b|dumpster|litter|waste/i, semantic: 'street_furniture', osm: ['amenity=waste_basket'], cap: 12 },
  { role: 'bus_stop',     re: /bus.?stop|bus.?shelter|busstop/i,            semantic: 'street_furniture', osm: ['highway=bus_stop'],       cap: 8 },
  { role: 'fence',        re: /fence|railing|guard.?rail|hedge/i,           semantic: 'barrier',          osm: ['barrier=fence'],          cap: 20 },
  { role: 'sign',         re: /\bsign\b|signage|signpost|billboard/i,       semantic: 'street_furniture', osm: [], internal: ['street_sign'], cap: 20 },
  { role: 'statue',       re: /statue|monument|obelisk|sculpture|anubis|bastet|pharaoh|\bgod[a-z]/i, semantic: 'landmark_prop', osm: ['historic=memorial', 'tourism=artwork'], cap: 16 },
  { role: 'tree',         re: /\btree|palm|\bpine|\boak|bush|shrub|foliage|plant_|\bfern/i, semantic: 'vegetation', osm: ['natural=tree'], cap: 40 },
  { role: 'planter',      re: /planter|flower.?pot|\bpot_/i,                semantic: 'street_furniture', osm: ['man_made=planter'],       cap: 12 },
  // NOTE: ToxSam "buildings" (Architecture category) are deliberately EXCLUDED.
  // They are stylized art-gallery/tower pieces authored at arbitrary (non-metric)
  // scales — they fail the real-world-scale contract and would pollute building
  // pools. Buildings stay procedural / recognizer-driven; ToxSam contributes
  // street PROPS only, which is where its genuine value is.
]

const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifest.json'), 'utf8'))

// Bucket candidates by role.
const buckets = new Map(ROLES.map(r => [r.role, []]))
for (const a of manifest.assets) {
  if (!a.present || !a.localPath) continue
  const hay = `${a.name} ${a.category || ''}`
  for (const r of ROLES) {
    const nameHit = r.re.test(hay)
    const catHit = r.categories?.has(a.category)
    if (nameHit || catHit) { buckets.get(r.role).push(a); break }   // first role wins
  }
}

// Rebuild output dir fresh.
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_GLB, { recursive: true })

const labels = {}
let copied = 0
const summary = []
for (const r of ROLES) {
  const cands = buckets.get(r.role)
    .sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0))   // lightest first (web-friendly)
    .slice(0, r.cap)
  cands.forEach((a, i) => {
    const outName = `${r.role}_${String(i + 1).padStart(2, '0')}.glb`
    copyFileSync(join(SRC_DIR, a.localPath), join(OUT_GLB, outName))
    labels[outName] = {
      semantic: r.semantic,
      role: r.role,
      style: 'stylized',
      osmTags: r.osm,
      internalTags: r.internal ?? [],
      sizeClass: r.sizeClass,
      license: 'CC0-1.0',
      attribution: 'Polygonal Mind (via ToxSam open-source-3D-assets)',
      source: 'ToxSam / Polygonal Mind — CC0',
      sourceUrl: a.sourceUrl,
      origin: { collection: a.collection, name: a.name, category: a.category },
    }
    copied++
  })
  if (cands.length) summary.push(`${r.role.padEnd(14)} ${cands.length}`)
}

writeFileSync(join(OUT_DIR, 'labels.json'), JSON.stringify(labels, null, 2))
writeFileSync(join(OUT_DIR, 'LICENSE.txt'),
  'CC0 1.0 Universal (Public Domain Dedication)\n' +
  'https://creativecommons.org/publicdomain/zero/1.0/\n\n' +
  'Models by Polygonal Mind, catalogued by ToxSam (open-source-3D-assets).\n' +
  'No rights reserved. Attribution appreciated but not required.\n')
writeFileSync(join(OUT_DIR, 'NOTICE.md'),
  '# ToxSam / Polygonal Mind — CC0 pack (curated)\n\n' +
  `Curated subset: ${copied} models selected by city-relevance from the 991-model\n` +
  'CC0 registry at https://github.com/ToxSam/open-source-3D-assets\n' +
  '(models: https://github.com/ToxSam/cc0-models-Polygonal-Mind).\n\n' +
  'License: CC0 1.0 (public domain). Credit: Polygonal Mind.\n')

console.log(`Curated ${copied} assets → ${OUT_DIR}`)
console.log(summary.join('\n'))
