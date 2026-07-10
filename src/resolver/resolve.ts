import type { BuildingFeature, RoadSegment, Vec2 } from '../types'
import {
  CLIMATE_TREES,
  FACADE_RULES,
  FACADE_TINTS,
  MATRIX_VERSION,
  ROAD_RULES,
  ZONE_PROPS,
} from './matrix'
import type {
  BuildingResolution,
  MarkingStyle,
  PropRules,
  ResolvedContext,
  RoadResolution,
  TreeResolution,
  WeightedVariant,
  ZoneKind,
} from './types'

// ---------- deterministic seeding ----------
// Everything is keyed on hash(object_id + salt): the same city always resolves
// to the same content, on any machine, in any session.

export function hash01(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

export function pickWeighted<T>(pool: WeightedVariant<T>[], seed: number): T {
  const total = pool.reduce((s, v) => s + v.weight, 0)
  let t = seed * total
  for (const v of pool) {
    t -= v.weight
    if (t <= 0) return v.value
  }
  return pool[pool.length - 1].value
}

// ---------- building resolution ----------

export function resolveBuilding(b: BuildingFeature, ctx: ResolvedContext): BuildingResolution {
  const provenance: string[] = []
  const levels = b.levels ?? Math.max(1, Math.round(b.heightM / 3.2))
  const zone = ctx.zoneAt(centroid(b.footprint))
  const tag = b.tags.building

  let matched = FACADE_RULES[FACADE_RULES.length - 1]
  let confidence = 0.4
  for (const rule of FACADE_RULES) {
    const w = rule.when
    if (w.region && !w.region.includes(ctx.region.id)) continue
    if (w.climate && !w.climate.includes(ctx.climate)) continue
    if (w.buildingTag && !(tag && w.buildingTag.includes(tag))) continue
    if (w.minLevels !== undefined && levels < w.minLevels) continue
    if (w.maxLevels !== undefined && levels > w.maxLevels) continue
    if (w.zone && !w.zone.includes(zone)) continue
    matched = rule
    confidence =
      0.5 +
      (w.buildingTag ? 0.2 : 0) +
      (w.region || w.climate ? 0.15 : 0) +
      (b.heightSource === 'height-tag' ? 0.15 : b.heightSource === 'levels' ? 0.1 : 0)
    break
  }
  provenance.push(`facade rule: ${matched.id}`)
  provenance.push(`inputs: region=${ctx.region.id}, climate=${ctx.climate}, zone=${zone}, levels=${levels}${tag ? `, building=${tag}` : ''}`)

  const facade = pickWeighted(matched.pool, hash01(b.id + ':facade'))
  const roof = pickWeighted(matched.roofPool, hash01(b.id + ':roof'))
  const tints = FACADE_TINTS[facade]
  const tint = tints[Math.floor(hash01(b.id + ':tint') * tints.length) % tints.length]
  provenance.push(`picked: ${facade} / ${roof} / ${tint} (seeded by id)`)

  return {
    facade,
    roof,
    tint,
    uvSeed: [hash01(b.id + ':u'), hash01(b.id + ':v')],
    provenance,
    confidence: Math.min(confidence, 1),
  }
}

// ---------- road resolution ----------

export function resolveRoad(r: RoadSegment, ctx: ResolvedContext): RoadResolution {
  const provenance: string[] = []
  let matched = ROAD_RULES[ROAD_RULES.length - 1]
  for (const rule of ROAD_RULES) {
    const w = rule.when
    if (w.classIn && !w.classIn.includes(r.roadClass)) continue
    if (w.surfaceTag && !(r.surfaceTag && w.surfaceTag.includes(r.surfaceTag))) continue
    if (w.region && !w.region.includes(ctx.region.id)) continue
    matched = rule
    break
  }
  provenance.push(`surface rule: ${matched.id}${r.surfaceTag ? ` (surface=${r.surfaceTag})` : ''}`)

  const surface = pickWeighted(matched.pool, hash01(r.id + ':surface'))
  const marking = markingStyleFor(ctx)
  provenance.push(`picked: ${surface}; markings: ${marking.centerPattern} ${marking.centerColor}, ${marking.crosswalk} crosswalks (${ctx.region.label} pack)`)

  const drivable = !['pedestrian', 'footway', 'cycleway', 'service'].includes(r.roadClass)
  return {
    surface,
    marking,
    crossSection: {
      sidewalks: drivable && r.roadClass !== 'motorway' && !r.bridge,
      sidewalkWidth: 2.4,
      curbHeight: 0.22,
    },
    decalDensity: matched.decalDensity,
    provenance,
    confidence: r.surfaceTag ? 0.95 : 0.7,
  }
}

export function markingStyleFor(ctx: ResolvedContext): MarkingStyle {
  const c = ctx.region.centerline
  return {
    centerColor: c.includes('yellow') ? 'yellow' : 'white',
    centerPattern: c === 'double-yellow' ? 'double-solid' : c.includes('dashed') ? 'dashed' : 'solid',
    crosswalk: ctx.region.crosswalk,
  }
}

// ---------- trees & props ----------

export function resolveTree(id: string, ctx: ResolvedContext): TreeResolution {
  return {
    species: pickWeighted(ctx.treePool, hash01(id + ':species')),
    scale: 0.8 + hash01(id + ':scale') * 0.55,
    tint: hash01(id + ':tint') * 2 - 1,
  }
}

export function propRulesFor(zone: ZoneKind): PropRules {
  return ZONE_PROPS[zone]
}

export function climateTreePool(climate: ResolvedContext['climate']) {
  return CLIMATE_TREES[climate]
}

export { MATRIX_VERSION }

function centroid(fp: Vec2[]): Vec2 {
  let x = 0
  let z = 0
  for (const p of fp) {
    x += p.x
    z += p.z
  }
  return { x: x / fp.length, z: z / fp.length }
}
