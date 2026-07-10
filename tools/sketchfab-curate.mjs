#!/usr/bin/env node
/**
 * Sketchfab curation → assets/sketchfab-catalog.json
 *
 * For each coverage gap in the local library, searches the Sketchfab Data API
 * for downloadable, permissively-licensed, poly-budgeted models; scores and
 * labels the best candidates with the SAME resolver vocabulary the local
 * manifest uses (semantic · style · osmTag), so they can drop into pools or be
 * fetched on demand by the in-app replace flow.
 *
 * This does NOT download meshes — it builds a labeled, license-audited index.
 * Use tools/sketchfab-fetch.mjs to pull specific uids into the library.
 *
 * Run: set -a; . ./.env; set +a; node tools/sketchfab-curate.mjs
 */
import { writeFileSync } from 'fs'
import { search } from './sketchfab-lib.mjs'

const OUT = new URL('../assets/sketchfab-catalog.json', import.meta.url).pathname

// Permissive licenses only. NC (non-commercial) and ND (no-derivatives, blocks
// our scale-to-slot fitting) are excluded by construction. by-sa carries a
// share-alike obligation, so it is included but ranked below cc0/by.
const LICENSES = [
  { slug: 'cc0', label: 'CC0 (public domain)', score: 3 },
  { slug: 'by', label: 'CC-BY (attribution)', score: 2 },
  { slug: 'by-sa', label: 'CC-BY-SA (attribution, share-alike)', score: 1 },
]

// One acquisition target per coverage gap. maxFaces = per-semantic triangle
// budget tuned for a drivable AAA city (many instances on screen at once →
// street furniture must stay cheap; hero props can be richer). queries are
// ordered most-specific first.
const TARGETS = [
  { osmTag: 'natural=tree',              semantic: 'vegetation',      style: 'deciduous',   role: 'tree',          maxFaces: 6000,  queries: ['low poly tree', 'game tree', 'street tree'] },
  { osmTag: 'highway=street_lamp',       semantic: 'street_furniture', style: 'modern',     role: 'streetlight',   maxFaces: 8000,  queries: ['street lamp', 'street light', 'lamp post'] },
  { osmTag: 'highway=traffic_signals',   semantic: 'street_furniture', style: 'us',         role: 'traffic-light', maxFaces: 9000,  queries: ['traffic light', 'traffic signal'] },
  { osmTag: 'traffic_sign=*',            semantic: 'street_furniture', style: 'us',         role: 'road-sign',     maxFaces: 4000,  queries: ['road sign', 'traffic sign', 'stop sign'] },
  { osmTag: 'emergency=fire_hydrant',    semantic: 'street_furniture', style: 'us',         role: 'hydrant',       maxFaces: 4000,  queries: ['fire hydrant'] },
  { osmTag: 'amenity=bench',             semantic: 'street_furniture', style: 'park',       role: 'bench',         maxFaces: 5000,  queries: ['park bench', 'street bench'] },
  { osmTag: 'amenity=waste_basket',      semantic: 'street_furniture', style: 'city',       role: 'trash-can',     maxFaces: 4000,  queries: ['trash can', 'litter bin', 'waste basket'] },
  { osmTag: 'highway=bus_stop',          semantic: 'street_furniture', style: 'modern',     role: 'bus-stop',      maxFaces: 15000, queries: ['bus stop', 'bus shelter'] },
  { osmTag: 'barrier=fence',             semantic: 'barrier',          style: 'metal',      role: 'fence',         maxFaces: 6000,  queries: ['fence', 'metal fence', 'chain link fence'] },
  { osmTag: 'amenity=fountain',          semantic: 'landmark_prop',    style: 'classical',  role: 'fountain',      maxFaces: 30000, queries: ['fountain', 'city fountain'] },
  { osmTag: 'historic=memorial',         semantic: 'landmark_prop',    style: 'classical',  role: 'statue',        maxFaces: 40000, queries: ['statue', 'monument', 'memorial'] },
  { osmTag: 'vehicle',                   semantic: 'vehicle',          style: 'sedan',      role: 'car',           maxFaces: 50000, queries: ['low poly car', 'sedan car', 'parked car'] },
]

const CANDIDATES_PER_TARGET = 8

function scoreCandidate(r, target, licenseScore) {
  // Higher is better. Blends license, poly-budget fit (prefer well under budget
  // but not degenerate), texture presence, and popularity as a quality proxy.
  const faces = r.faceCount || 0
  const budgetFit = faces === 0 ? 0 : Math.max(0, 1 - faces / target.maxFaces) // 0..1, closer to 1 = leaner
  const textured = r.isDownloadable ? 1 : 0
  const pop = Math.min(1, Math.log10((r.likeCount || 0) + 1) / 3)
  return +(licenseScore * 2 + budgetFit * 2 + textured + pop).toFixed(3)
}

function pickThumb(r) {
  const imgs = r.thumbnails?.images || []
  const mid = imgs.filter(i => i.width >= 200 && i.width <= 640).sort((a, b) => a.width - b.width)[0]
  return (mid || imgs[0])?.url || null
}

async function curateTarget(t) {
  const seen = new Map() // uid -> best entry
  for (const license of LICENSES) {
    for (const q of t.queries) {
      let res
      try {
        res = await search({
          q,
          downloadable: 'true',
          license: license.slug,
          min_face_count: '1',        // skip unindexed faceCount=0 models
          max_face_count: String(t.maxFaces),
          count: '12',
          sort_by: '-likeCount',
        })
      } catch (e) {
        console.warn(`  ! ${t.osmTag} "${q}" [${license.slug}]: ${e.message}`)
        continue
      }
      for (const r of res.results || []) {
        if (!r.isDownloadable || !r.faceCount) continue
        const score = scoreCandidate(r, t, license.score)
        const entry = {
          uid: r.uid,
          name: r.name,
          author: r.user?.displayName || r.user?.username || 'unknown',
          authorUrl: r.user?.profileUrl || null,
          viewerUrl: r.viewerUrl || `https://sketchfab.com/3d-models/${r.uid}`,
          faceCount: r.faceCount,
          vertexCount: r.vertexCount || null,
          license: license.label,
          licenseSlug: license.slug,
          thumbnail: pickThumb(r),
          score,
        }
        const prev = seen.get(r.uid)
        if (!prev || entry.score > prev.score) seen.set(r.uid, entry)
      }
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES_PER_TARGET)
  console.log(`  ${t.osmTag}: ${ranked.length} candidates (best: ${ranked[0]?.name ?? '—'})`)
  return {
    osmTag: t.osmTag,
    semantic: t.semantic,
    style: t.style,
    role: t.role,
    maxFaces: t.maxFaces,
    candidates: ranked,
  }
}

async function main() {
  console.log('Curating Sketchfab candidates for coverage gaps…')
  const targets = []
  for (const t of TARGETS) targets.push(await curateTarget(t))

  const catalog = {
    schemaVersion: 1,
    generated: 'run: set -a; . ./.env; set +a; node tools/sketchfab-curate.mjs',
    note: 'Labeled, license-audited candidate index. Meshes are NOT bundled — fetch specific uids with tools/sketchfab-fetch.mjs. Permissive licenses only (cc0/by/by-sa); NC/ND excluded.',
    licenses: LICENSES.map(l => l.label),
    counts: {
      gapsTargeted: targets.length,
      totalCandidates: targets.reduce((s, t) => s + t.candidates.length, 0),
      gapsWithCandidates: targets.filter(t => t.candidates.length).length,
    },
    targets,
  }
  writeFileSync(OUT, JSON.stringify(catalog, null, 2))
  console.log(`\nWrote ${OUT}`)
  console.log(`  ${catalog.counts.gapsWithCandidates}/${catalog.counts.gapsTargeted} gaps have candidates · ${catalog.counts.totalCandidates} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
