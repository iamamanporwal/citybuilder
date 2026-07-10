#!/usr/bin/env node
/**
 * Sketchfab fetch → downloads vetted models from the curated catalog into the
 * asset library so they become real, measured, pooled assets.
 *
 * Reads assets/sketchfab-catalog.json, downloads the top candidate for each
 * requested gap tag (default: the drivable-street furniture set), writes GLBs
 * to assets/library/sketchfab-curated/glb/, records explicit labels in
 * labels.json (so the manifest scanner classifies them authoritatively) and
 * attributions in NOTICE.md, then you re-run build-asset-manifest.mjs.
 *
 * Run: set -a; . ./.env; set +a; node tools/sketchfab-fetch.mjs [tag ...]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { downloadLinks, fetchToBuffer } from './sketchfab-lib.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'assets/sketchfab-catalog.json'), 'utf8'))
const PACK_DIR = join(ROOT, 'assets/library/sketchfab-curated')
const GLB_DIR = join(PACK_DIR, 'glb')

// Default: the props that most shape a believable drivable street. Fountains,
// statues, vehicles are heavier/optional — request them explicitly by tag.
const DEFAULT_GAPS = [
  'highway=street_lamp',
  'highway=traffic_signals',
  'natural=tree',
  'amenity=bench',
  'amenity=waste_basket',
  'emergency=fire_hydrant',
  'highway=bus_stop',
  'barrier=fence',
]

const requested = process.argv.slice(2)
const gaps = requested.length ? requested : DEFAULT_GAPS

function slugify(role, name, uid) {
  const base = `${role}_${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return `${base}_${uid.slice(0, 6)}`
}

async function main() {
  mkdirSync(GLB_DIR, { recursive: true })
  const labels = {}
  const notices = []
  let ok = 0

  for (const tag of gaps) {
    const target = CATALOG.targets.find(t => t.osmTag === tag)
    if (!target || !target.candidates.length) {
      console.warn(`! ${tag}: no candidates in catalog — skipping`)
      continue
    }
    const cand = target.candidates[0] // highest-scored
    const slug = slugify(target.role, cand.name, cand.uid)
    const fileName = `${slug}.glb`
    try {
      const links = await downloadLinks(cand.uid)
      const url = links.glb?.url || links.gltf?.url
      if (!url) throw new Error('no glb/gltf download')
      const buf = await fetchToBuffer(url)
      writeFileSync(join(GLB_DIR, fileName), buf)
      labels[fileName] = {
        semantic: target.semantic,
        role: target.role,
        style: target.style,
        osmTags: [target.osmTag],
        license: cand.license,
        attribution: `"${cand.name}" by ${cand.author} — ${cand.license}`,
        source: `Sketchfab (${cand.author})`,
        sourceUrl: cand.viewerUrl,
      }
      notices.push(`- **${cand.name}** — ${cand.license} — by ${cand.author}\n  - ${cand.viewerUrl}\n  - mapped to \`${target.osmTag}\` · ${(cand.faceCount / 1000).toFixed(1)}k faces · file \`glb/${fileName}\``)
      console.log(`✓ ${tag.padEnd(22)} ${(buf.length / 1024).toFixed(0).padStart(5)} KB  ${cand.name} (${cand.faceCount}f, ${cand.licenseSlug})`)
      ok++
    } catch (e) {
      console.warn(`! ${tag}: ${e.message}`)
    }
  }

  writeFileSync(join(PACK_DIR, 'labels.json'), JSON.stringify(labels, null, 2))
  const notice = `# Sketchfab-curated assets — attribution\n\n` +
    `Downloaded via \`tools/sketchfab-fetch.mjs\` from the curated catalog.\n` +
    `All models are downloadable under permissive licenses (CC0 / CC-BY / CC-BY-SA).\n` +
    `CC-BY and CC-BY-SA require the attribution below; it is also stamped into the\n` +
    `asset manifest and carried into scene exports.\n\n` +
    notices.join('\n') + '\n'
  writeFileSync(join(PACK_DIR, 'NOTICE.md'), notice)

  console.log(`\nFetched ${ok}/${gaps.length} · wrote labels.json + NOTICE.md`)
  console.log('Next: node tools/build-asset-manifest.mjs')
}

main().catch(e => { console.error(e); process.exit(1) })
