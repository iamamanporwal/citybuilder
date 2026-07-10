import { buildingFeatures, buildingResolutions, roadResolutions } from '../scene/registry'
import { footprintCentroid } from '../procgen/buildings'

// Variety linter: flags monotonous content the seeded pools should have avoided
// (dominant variants, identical neighbors). Runs after every build.

export interface LintWarning {
  severity: 'warn' | 'info'
  message: string
}

export function lintScene(): LintWarning[] {
  const warnings: LintWarning[] = []

  // ---- facade distribution
  const facadeCounts = new Map<string, number>()
  for (const res of buildingResolutions.values()) {
    facadeCounts.set(res.facade, (facadeCounts.get(res.facade) ?? 0) + 1)
  }
  const total = buildingResolutions.size
  if (total > 20) {
    for (const [facade, count] of facadeCounts) {
      const share = count / total
      if (share > 0.55) {
        warnings.push({
          severity: 'warn',
          message: `Facade "${facade}" covers ${Math.round(share * 100)}% of buildings — widen the matching pool in the content matrix.`,
        })
      }
    }
    if (facadeCounts.size < 3) {
      warnings.push({
        severity: 'warn',
        message: `Only ${facadeCounts.size} facade set(s) in use — the matrix rules for this region/climate resolve too narrowly.`,
      })
    }
  }

  // ---- identical adjacent neighbors (same facade + same tint within 40 m)
  const entries = [...buildingResolutions.entries()].map(([id, res]) => {
    const f = buildingFeatures.get(id)!
    return { id, res, c: footprintCentroid(f.footprint) }
  })
  let adjacentDupes = 0
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      const d2 = (a.c.x - b.c.x) ** 2 + (a.c.z - b.c.z) ** 2
      if (d2 < 1600 && a.res.facade === b.res.facade && a.res.tint === b.res.tint) adjacentDupes++
    }
  }
  if (adjacentDupes > total * 0.06) {
    warnings.push({
      severity: 'warn',
      message: `${adjacentDupes} adjacent building pairs share facade AND tint — add tints to the "${[...facadeCounts.keys()][0]}" pools.`,
    })
  } else if (adjacentDupes > 0) {
    warnings.push({ severity: 'info', message: `${adjacentDupes} adjacent identical-facade pairs (within tolerance).` })
  }

  // ---- road surface variety
  const surfCounts = new Map<string, number>()
  for (const res of roadResolutions.values()) surfCounts.set(res.surface, (surfCounts.get(res.surface) ?? 0) + 1)
  if (roadResolutions.size > 30 && surfCounts.size === 1) {
    warnings.push({ severity: 'warn', message: 'All roads share one surface variant — check the road rules pool weights.' })
  }

  // ---- confidence floor
  const lowConf = [...buildingResolutions.values()].filter((r) => r.confidence < 0.5).length
  if (lowConf > total * 0.5) {
    warnings.push({
      severity: 'info',
      message: `${lowConf}/${total} buildings resolved via the generic fallback rule — richer OSM tags or a zoning layer would raise confidence.`,
    })
  }

  if (!warnings.length) warnings.push({ severity: 'info', message: 'Variety checks passed — no dominant variants or identical neighbors.' })
  return warnings
}
