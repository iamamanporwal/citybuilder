import type { CityGraph } from '../types'
import { pointInRing, ringAreaM2, ringIsSimple } from '../procgen/geometry'
import { MIN_WATER_AREA_M2 } from '../ingest/overpass'
import type { LintWarning } from './varietyLint'

// Water over-classification regression gate (pure — unit-tested headless and
// run in-app after every build). Guards the invariants of the ingest
// whitelist: every rendered water polygon carries a whitelist provenance, is
// large enough to be a real water body, and — the highest-signal check —
// covers essentially no building footprints. Buildings are land; a coastline
// assembled on the wrong side or an implicitly-closed polygon fragment floods
// them immediately and trips this audit.

const BANNED_PROVENANCE = /fountain|swimming|pool|wetland|stream|ditch|drain|basin|wastewater/i

export function auditWater(graph: CityGraph): LintWarning[] {
  const warnings: LintWarning[] = []
  const water = graph.areas.filter((a) => a.kind === 'water' && a.render)

  for (const w of water) {
    if (!w.provenance) {
      warnings.push({ severity: 'warn', message: `Water ${w.id} has no whitelist provenance — it bypassed the ingest whitelist.` })
    } else if (BANNED_PROVENANCE.test(w.provenance)) {
      warnings.push({ severity: 'warn', message: `Water ${w.id} admitted via banned source "${w.provenance}" — fountains/pools/wetlands/streams are never water surfaces.` })
    }
    const area = w.areaM2 ?? ringAreaM2(w.ring)
    if (area < MIN_WATER_AREA_M2) {
      warnings.push({ severity: 'warn', message: `Water ${w.id} is ${Math.round(area)} m² — below the ${MIN_WATER_AREA_M2} m² minimum for a rendered water body.` })
    }
    // buffered waterway ribbons may fold at hairpins (rendered as safe painted
    // overlays); closed water bodies and the sea must be simple polygons
    if (!w.provenance?.startsWith('waterway=') && !ringIsSimple(w.ring)) {
      warnings.push({ severity: 'warn', message: `Water ${w.id} is a self-intersecting polygon — triangulation would spill water over land.` })
    }
  }

  // buildings are land: essentially none may sit inside painted water
  let flooded = 0
  let example = ''
  for (const b of graph.buildings) {
    let x = 0, z = 0
    for (const p of b.footprint) { x += p.x; z += p.z }
    const c = { x: x / b.footprint.length, z: z / b.footprint.length }
    if (water.some((w) => pointInRing(c, w.ring))) {
      flooded++
      if (!example) example = b.name ?? b.id
    }
  }
  const allowed = Math.max(2, Math.ceil(graph.buildings.length * 0.01))
  if (flooded > allowed) {
    warnings.push({
      severity: 'warn',
      message: `${flooded} building(s) sit inside painted water (e.g. ${example}) — water is over-classified (allowed: ${allowed}).`,
    })
  }

  if (!warnings.length) {
    warnings.push({
      severity: 'info',
      message: `Water audit passed: ${water.length} water bodies, all whitelisted (${[...new Set(water.map((w) => w.provenance))].join(', ') || 'none'}), ${flooded} building(s) touched.`,
    })
  }
  return warnings
}
