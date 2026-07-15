import type { RoadSegment } from '../types'
import type { RoadResolution } from '../resolver/types'
import { analyzeRoadNodes, cumulative, rampSpecFor } from '../procgen/roadNetwork'
import { buildRoadElevation } from '../procgen/corridor'

// Semantic road export (city_semantics.json, semanticsVersion 3).
// Centerlines are 3-component [x, y, z] in TRUE meters (y = 0 at grade, no
// cosmetic render offsets) so a car game can follow bridge decks. The y-channel
// is the shared network elevation solve (default-on, E3) — not just bridge ramps
// — so approaches and grade-separated at-grade roads carry real elevation too.
// Elevation is evaluated on the RAW OSM polyline's own cumulative distances; the
// smoothed render polyline differs in length by <1%, so profiles agree within cm.

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
  const elevation = buildRoadElevation(roads)
  return roads.map((r) => {
    const res = resolutions.get(r.id)
    const cum = cumulative(r.points)
    // `spec` still reports the bridge-height/ramp-length metadata; the actual
    // y-channel comes from the shared elevation seam (network solve when on).
    const spec = r.points.length >= 2 ? rampSpecFor(r, cum[cum.length - 1], nodes) : null
    const ys = elevation.profileFor(r, cum)
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
