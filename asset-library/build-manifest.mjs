#!/usr/bin/env node
// Builds asset-library/manifest.json from the ToxSam CC0 registry JSONs (.registry/)
// against the locally cloned GLBs (toxsam-polygonal-mind/). Preserves the source
// Theme/Category labels so nothing needs manual re-labelling.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REG = join(ROOT, '.registry')
const MODELS = join(ROOT, 'toxsam-polygonal-mind')

// Which collections are relevant to a drivable real-world city (rest = metaverse filler).
const CITY_RELEVANT = new Set(['pm-transit', 'pm-momuspark', 'pm-ca-world', 'pm-towers'])

const projects = JSON.parse(readFileSync(join(REG, 'projects.json'), 'utf8'))
const projById = Object.fromEntries((Array.isArray(projects) ? projects : projects.projects).map(p => [p.id, p]))

const files = readdirSync(REG).filter(f => f.endsWith('.json') && f !== 'projects.json')
const assets = []
let missing = 0

for (const f of files) {
  const collection = f.replace(/\.json$/, '')
  const items = JSON.parse(readFileSync(join(REG, f), 'utf8'))
  for (const it of items) {
    const ghPath = it.metadata?.github_path || it.model_file_url?.split('/main/')[1]
    const localPath = ghPath ? join('toxsam-polygonal-mind', ghPath) : null
    const present = localPath ? existsSync(join(ROOT, localPath)) : false
    if (!present) missing++
    const attrs = Object.fromEntries((it.metadata?.attributes || []).map(a => [a.trait_type, a.value]))
    assets.push({
      id: it.id,
      name: it.name,
      collection,
      collectionDesc: projById[collection]?.description || '',
      format: it.format || 'GLB',
      license: projById[collection]?.license || 'CC0',
      cityRelevant: CITY_RELEVANT.has(collection),
      theme: attrs.Theme || null,
      category: attrs.Category || null,      // Furniture / Infrastructure / Building / ...
      fileSize: it.metadata?.file_size || null,
      localPath,
      present,
      sourceUrl: it.model_file_url,
      thumbnail: it.thumbnail_url,
    })
  }
}

const byCollection = {}
for (const a of assets) (byCollection[a.collection] ??= []).push(a)
const byCategory = {}
for (const a of assets) { const k = a.category || 'uncategorized'; byCategory[k] = (byCategory[k] || 0) + 1 }

const manifest = {
  source: 'ToxSam/open-source-3D-assets → ToxSam/cc0-models-Polygonal-Mind (Polygonal Mind)',
  license: 'CC0 1.0 Universal (public domain)',
  attribution: 'Models by Polygonal Mind, catalogued by ToxSam. CC0 — no attribution required (credit appreciated).',
  totalAssets: assets.length,
  presentLocally: assets.filter(a => a.present).length,
  missingLocally: missing,
  cityRelevantCollections: [...CITY_RELEVANT],
  countsByCategory: byCategory,
  countsByCollection: Object.fromEntries(Object.entries(byCollection).map(([k, v]) => [k, v.length])),
  assets,
}

writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`manifest.json: ${assets.length} assets, ${manifest.presentLocally} present, ${missing} missing`)
console.log('by category:', byCategory)
