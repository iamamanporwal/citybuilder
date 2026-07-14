import type { BuildingFeature } from '../types'
import type { ResolvedContext } from '../resolver/types'
import type { BuildingPriors, RoofForm } from './types'

// Stage 1 of the recognizer: gather structured priors from the data we already
// have. Pure and synchronous — the async signals (wikidata style, photo) are
// resolved elsewhere and passed in, so a build never blocks here.

/** OSM roof:shape → our RoofForm. Unknown / ornamental shapes collapse to the nearest buildable form. */
const ROOF_SHAPE_MAP: Record<string, RoofForm> = {
  flat: 'flat',
  gabled: 'gabled',
  'gabled_row': 'gabled',
  'side_gabled': 'gabled',
  'front_gabled': 'gabled',
  gambrel: 'mansard',
  saltbox: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'hipped',
  'half_hipped': 'hipped',
  pyramidal: 'pyramidal',
  mansard: 'mansard',
  skillion: 'skillion',
  'lean_to': 'skillion',
  'mono_pitched': 'skillion',
  dome: 'dome',
  onion: 'dome',
  round: 'dome',
  cone: 'pyramidal',
  conical: 'pyramidal',
}

export function normalizeRoofShape(tag: string | undefined): RoofForm | undefined {
  if (!tag) return undefined
  return ROOF_SHAPE_MAP[tag.toLowerCase()]
}

/**
 * Which OSM building=* values carry a real reference photo worth sending to a
 * VLM. Today the only photo source wired is Wikidata P18 (fetched for
 * wikidata-linked landmarks); Mapillary street-level and aerial tiles are
 * documented milestones. So `hasPhoto` is true when a photoUrl was resolved.
 */
export function gatherPriors(
  b: BuildingFeature,
  ctx: ResolvedContext,
  extra: { wikidataStyle?: string; photoUrl?: string } = {},
): BuildingPriors {
  const t = b.tags
  const centroid = footCentroid(b)
  const levels = b.levels ?? Math.max(1, Math.round(b.heightM / 3.2))
  return {
    id: b.id,
    buildingType: t.building ?? 'yes',
    architectureTag: t['building:architecture'],
    roofShapeTag: normalizeRoofShape(t['roof:shape']),
    roofMaterialTag: t['roof:material'],
    facadeMaterialTag: t['building:material'] ?? t['building:facade:material'] ?? t['material'],
    levels,
    heightM: b.heightM,
    heightConfident: b.heightSource !== 'estimated',
    region: ctx.region.id,
    climate: ctx.climate,
    zone: ctx.zoneAt(centroid),
    wikidata: b.wikidata,
    wikidataStyle: extra.wikidataStyle,
    name: b.name,
    hasPhoto: !!extra.photoUrl,
    photoUrl: extra.photoUrl,
    massingSource: 'osm-extrusion',
  }
}

function footCentroid(b: BuildingFeature): { x: number; z: number } {
  let x = 0
  let z = 0
  for (const p of b.footprint) {
    x += p.x
    z += p.z
  }
  return { x: x / b.footprint.length, z: z / b.footprint.length }
}
