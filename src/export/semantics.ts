import type { RoadSegment } from '../types'
import type { RoadResolution } from '../resolver/types'
import { analyzeRoadNodes, cumulative, elevationProfile, rampSpecFor } from '../procgen/roadNetwork'

// Semantic road export (city_semantics.json, semanticsVersion 2).
// Centerlines are 3-component [x, y, z] in TRUE meters (y = 0 at grade, no
// cosmetic render offsets) so a car game can follow bridge decks. Elevation is
// evaluated on the RAW OSM polyline's own cumulative distances; the smoothed
// render polyline differs in length by <1%, so profiles agree within cm.

export interface RoadSemanticsEntry {
  id: string
  name: string | null
  class: string
  width_m: number
  lanes: number
  oneway: boolean
  bridge: boolean
  tunnel: boolean
  layer: number
  surface: string | null
  marking: string | null
  confidence: number | null
  drivable: boolean
  cross_section: {
    sidewalks: boolean
    sidewalk_width_m: number
    curb_height_m: number
  } | null
  elevation: {
    bridge_height_m: number
    ramp_length_m: number
  } | null
  centerline: [number, number, number][]
}

const NON_DRIVABLE = new Set(['pedestrian', 'footway', 'cycleway'])

export function buildRoadSemantics(
  roads: RoadSegment[],
  resolutions: Map<string, RoadResolution>,
): RoadSemanticsEntry[] {
  const nodes = analyzeRoadNodes(roads)
  return roads.map((r) => {
    const res = resolutions.get(r.id)
    const cum = cumulative(r.points)
    const spec = r.points.length >= 2 ? rampSpecFor(r, cum[cum.length - 1], nodes) : null
    const ys = elevationProfile(spec, cum)
    return {
      id: r.id,
      name: r.name ?? null,
      class: r.roadClass,
      width_m: round(r.widthM),
      lanes: r.lanes,
      oneway: r.oneway,
      bridge: r.bridge,
      tunnel: r.tunnel,
      layer: r.layer,
      surface: res?.surface ?? null,
      marking: res ? `${res.marking.centerPattern} ${res.marking.centerColor}` : null,
      confidence: res?.confidence ?? null,
      drivable: !NON_DRIVABLE.has(r.roadClass),
      cross_section: res
        ? {
            sidewalks: res.crossSection.sidewalks,
            sidewalk_width_m: res.crossSection.sidewalkWidth,
            curb_height_m: res.crossSection.curbHeight,
          }
        : null,
      elevation: spec
        ? { bridge_height_m: round(spec.fullElev), ramp_length_m: round(spec.rampLen) }
        : null,
      centerline: r.points.map((p, i) => [round(p.x), round(ys[i]), round(p.z)]),
    }
  })
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
