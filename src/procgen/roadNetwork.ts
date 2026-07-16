import type { RoadSegment, Vec2 } from '../types'
import { densifyPolyline, pointAlong, polylineLength, smoothPolyline } from './geometry'

// Shared road-network analysis + bridge elevation math, extracted from roads.ts
// so the renderer, the physics collider builder and the semantics exporter all
// compute grade separation from one deterministic source. Profiles here are in
// TRUE meters (0 = grade) — callers add their own cosmetic Y offsets.

export const BRIDGE_LAYER_H = 6.5
export const MAX_RAMP_GRADE = 0.06 // 6% — driving-grade approach ramps

export const NON_DRIVABLE = new Set(['pedestrian', 'footway', 'cycleway'])

export interface RoadNodeInfo {
  count: number
  maxWidth: number
  p: Vec2
  hasSurface: boolean // some at-grade (non-bridge) drivable segment touches this node
  bridgeElev: number
}

export function nodeKey(p: Vec2): string {
  return `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`
}

/** Junction-disc radius for a node given the widest arm touching it. */
export const discRadius = (maxWidth: number) => maxWidth * 0.58

/**
 * Max deck height a span of length L can reach within a grade cap: the eased
 * ramp's peak slope is F·π/(2R), and on a short span the two ramps meet at
 * mid-span (R = L/2), so F_max = grade·L/π. A 21 m footbridge can NOT climb to
 * 6.5 m — uncapped it renders (and collides) as an absurd >60% spike.
 */
export const shortSpanElevCap = (spanLen: number, grade: number) => (grade * spanLen) / Math.PI

/**
 * The reference centerline every consumer (renderer, colliders, semantics)
 * meshes a segment along. Bridges are densified so a straight 2-point OSM way
 * still samples its humped elevation profile between the (grounded) feet —
 * without this the deck renders flat at grade (the Mánesův most bug).
 */
export function segCenterline(r: RoadSegment): Vec2[] {
  const s = smoothPolyline(r.points)
  return r.bridge ? densifyPolyline(s, 8) : s
}

/** Endpoint keys of every at-grade (non-bridge, non-tunnel) way of ANY class —
 * used to ground path-bridge (footbridge) ramps, which analyzeRoadNodes'
 * drivable-only map cannot see. */
export function groundedNodeKeys(roads: RoadSegment[]): Set<string> {
  const s = new Set<string>()
  for (const r of roads) {
    if (r.tunnel || r.bridge || r.points.length === 0) continue
    s.add(nodeKey(r.points[0]))
    s.add(nodeKey(r.points[r.points.length - 1]))
  }
  return s
}

function nearestOnPolyline(pts: Vec2[], q: Vec2): { dist: number; dir: Vec2 } {
  let best = Infinity
  let dir: Vec2 = { x: 1, z: 0 }
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, az = pts[i - 1].z
    const dx = pts[i].x - ax, dz = pts[i].z - az
    const len2 = dx * dx + dz * dz || 1
    let t = ((q.x - ax) * dx + (q.z - az) * dz) / len2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = ax + dx * t, pz = az + dz * t
    const d2 = (q.x - px) ** 2 + (q.z - pz) ** 2
    if (d2 < best) {
      best = d2
      const l = Math.sqrt(len2)
      dir = { x: dx / l, z: dz / l }
    }
  }
  return { dist: Math.sqrt(best), dir }
}

/**
 * Footway/cycleway bridge ways that are the mapped SIDEWALKS of a drivable
 * bridge (OSM maps them as separate parallel ways). The engine's bridges
 * deliberately render no separate sidewalks, and these ribbons ramp with
 * legacy math that never matches the road deck — they end up as floating
 * strips beside the bridge. Detected as: every sampled station lies beside a
 * drivable bridge deck (within half-width + 5 m) AND runs parallel to it.
 * Standalone footbridges (Charles Bridge) match nothing and are kept.
 */
export function siblingFootwayBridgeIds(roads: RoadSegment[]): Set<string> {
  const out = new Set<string>()
  const decks = roads.filter((r) => r.bridge && !NON_DRIVABLE.has(r.roadClass) && r.points.length >= 2)
  if (!decks.length) return out
  for (const f of roads) {
    if (!f.bridge || !NON_DRIVABLE.has(f.roadClass) || f.points.length < 2) continue
    const L = polylineLength(f.points)
    if (L < 1) continue
    const beside = [0.25, 0.5, 0.75].every((t) => {
      const { p, dir } = pointAlong(f.points, L * t)
      return decks.some((b) => {
        const n = nearestOnPolyline(b.points, p)
        return n.dist <= b.widthM / 2 + 5 && Math.abs(n.dir.x * dir.x + n.dir.z * dir.z) >= 0.8
      })
    })
    if (beside) out.add(f.id)
  }
  return out
}

export function cumulative(pts: Vec2[]): number[] {
  const out = [0]
  for (let i = 1; i < pts.length; i++)
    out.push(out[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
  return out
}

export const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)))

/** Junction map over drivable, non-tunnel segment endpoints (moved from buildRoads). */
export function analyzeRoadNodes(roads: RoadSegment[]): Map<string, RoadNodeInfo> {
  const nodeUse = new Map<string, RoadNodeInfo>()
  for (const r of roads) {
    if (NON_DRIVABLE.has(r.roadClass) || r.tunnel) continue
    const segElev = r.bridge ? Math.max(r.layer, 1) * BRIDGE_LAYER_H : 0
    for (const end of [r.points[0], r.points[r.points.length - 1]]) {
      const k = nodeKey(end)
      const e = nodeUse.get(k)
      if (e) {
        e.count++
        e.maxWidth = Math.max(e.maxWidth, r.widthM)
        e.hasSurface = e.hasSurface || !r.bridge
        e.bridgeElev = Math.max(e.bridgeElev, segElev)
      } else {
        nodeUse.set(k, { count: 1, maxWidth: r.widthM, p: end, hasSurface: !r.bridge, bridgeElev: segElev })
      }
    }
  }
  return nodeUse
}

/** Ramp parameters for a bridge segment; null when the segment is at grade. */
export interface RampSpec {
  fullElev: number // Math.max(layer, 1) * BRIDGE_LAYER_H
  rampLen: number
  startElev: number // 0 if the start node is grounded (hasSurface), else fullElev
  endElev: number
}

export function rampSpecFor(
  r: RoadSegment,
  totalLen: number,
  nodes: Map<string, RoadNodeInfo>,
): RampSpec | null {
  const fullElev = r.bridge ? Math.max(r.layer, 1) * BRIDGE_LAYER_H : 0
  if (!r.bridge || fullElev <= 0) return null
  const rampLen = Math.min(Math.max(fullElev / MAX_RAMP_GRADE, 40), Math.max(totalLen * 0.45, 20))
  const [startElev, endElev] = [r.points[0], r.points[r.points.length - 1]].map((p) => {
    const node = nodes.get(nodeKey(p))
    return node && node.hasSurface ? 0 : fullElev
  })
  return { fullElev, rampLen, startElev, endElev }
}

/** True elevation (m) at distance d along a polyline of total length L. */
export function elevationAt(spec: RampSpec, d: number, L: number): number {
  const up = spec.startElev + (spec.fullElev - spec.startElev) * ease(d / spec.rampLen)
  const down = spec.endElev + (spec.fullElev - spec.endElev) * ease((L - d) / spec.rampLen)
  return Math.min(up, down)
}

/** Per-point true-elevation profile for any polyline parameterization of the segment. */
export function elevationProfile(spec: RampSpec | null, cum: number[]): number[] {
  if (!spec) return cum.map(() => 0)
  const L = cum[cum.length - 1]
  return cum.map((d) => elevationAt(spec, d, L))
}
