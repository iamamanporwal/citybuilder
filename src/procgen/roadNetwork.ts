import type { RoadSegment, Vec2 } from '../types'

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
