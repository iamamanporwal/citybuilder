import type { RoadSegment, SceneObject } from '../types'
import type { RoadResolution } from '../resolver/types'
import { analyzeRoadNodes, cumulative, rampSpecFor } from '../procgen/roadNetwork'
import { densifyPolyline } from '../procgen/geometry'
import { buildRoadElevation } from '../procgen/corridor'
import { effectiveSpeed } from '../procgen/signMath'

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
  // FAITHFUL traffic tier (Road-updates.md §8.4). The trainer reads the SAME
  // speed/turn data that placed the signs, so what the learner sees and what the
  // sim enforces cannot disagree. `speed_limit_source: 'default'` is low-confidence.
  speed_limit_kmh: number | null
  speed_limit_source: 'tag' | 'default' | null
  turn_lanes: string[] | null
  roundabout: boolean
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
    // Bridges are linearly densified (raw line, no smoothing): a straight
    // 2-point span otherwise exports only its two (grounded) endpoint heights
    // and a consumer interpolating between them gets a flat deck with no hump.
    const pts = r.bridge && r.points.length >= 2 ? densifyPolyline(r.points, 8) : r.points
    const cum = cumulative(pts)
    // `spec` still reports the bridge-height/ramp-length metadata; the actual
    // y-channel comes from the shared elevation seam (network solve when on).
    const spec = pts.length >= 2 ? rampSpecFor(r, cum[cum.length - 1], nodes) : null
    const ys = elevation.profileFor(r, cum)
    const speed = effectiveSpeed(r)
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
      speed_limit_kmh: speed?.kmh ?? null,
      speed_limit_source: speed?.source ?? null,
      turn_lanes: r.turnLanes ?? null,
      roundabout: r.roundabout ?? false,
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
      centerline: pts.map((p, i) => [round(p.x), round(ys[i]), round(p.z)]),
    }
  })
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

// ---- traffic devices (signals + signs) — §8.5 single semantic source --------

const DEVICE_KINDS = new Set(['stop_sign', 'give_way', 'road_sign', 'speed_limit'])

export interface TrafficDeviceEntry {
  id: string
  kind: string // traffic_signal | stop_sign | give_way | road_sign | speed_limit
  position: [number, number, number]
  heading_rad: number // facing direction (0 = local +Z, toward oncoming traffic for signs)
  sign_type: string | null // OSM traffic_sign / crossing classifier when known
  speed_limit_kmh: number | null // for speed_limit devices
}

/**
 * Traffic-device semantics from the built scene objects: signal heads and the
 * regulatory/speed signs, with the SAME positions + headings the renderer used.
 * The trainer consumes this to know where signals and limits are (§8.5).
 */
export function buildTrafficDevices(objects: SceneObject[]): TrafficDeviceEntry[] {
  const out: TrafficDeviceEntry[] = []
  for (const o of objects) {
    if (o.deleted) continue
    const isSignal = o.type === 'traffic-signal'
    const kind = isSignal ? 'traffic_signal' : (o.meta.kind as string | undefined)
    if (!isSignal && !(kind && DEVICE_KINDS.has(kind))) continue
    out.push({
      id: o.id,
      kind: kind!,
      position: [round(o.transform.position[0]), round(o.transform.position[1]), round(o.transform.position[2])],
      heading_rad: round(o.transform.rotation[1]),
      sign_type: (o.meta.signType as string | undefined) ?? null,
      speed_limit_kmh: typeof o.meta.speedKmh === 'number' ? o.meta.speedKmh : null,
    })
  }
  return out
}

// ---- audit gate (§8.5): faithful-tier coverage before a city is training-ready

export interface TrafficAudit {
  roads_drivable: number
  speed_tagged: number // faithful — from OSM
  speed_defaulted: number // low-confidence — region default, needs human review
  signals: number
  signs: number
  /** No drivable road relies on a defaulted speed limit — the faithful gate. */
  training_ready: boolean
}

export function buildTrafficAudit(roads: RoadSegment[], devices: TrafficDeviceEntry[]): TrafficAudit {
  let tagged = 0
  let defaulted = 0
  let drivable = 0
  for (const r of roads) {
    const s = effectiveSpeed(r)
    if (!s) continue
    drivable++
    s.source === 'tag' ? tagged++ : defaulted++
  }
  return {
    roads_drivable: drivable,
    speed_tagged: tagged,
    speed_defaulted: defaulted,
    signals: devices.filter((d) => d.kind === 'traffic_signal').length,
    signs: devices.filter((d) => d.kind !== 'traffic_signal').length,
    training_ready: defaulted === 0,
  }
}
