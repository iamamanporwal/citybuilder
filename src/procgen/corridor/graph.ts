import type { RoadSegment, Vec2 } from '../../types'
import { BRIDGE_LAYER_H, NON_DRIVABLE, nodeKey } from '../roadNetwork'
import { maxGradeFor } from './config'

// Road Corridor Redesign — Stage 0 (E0): topology graph.
//
// Builds a real graph from CityGraph.roads so elevation flows THROUGH the
// network instead of being decided per segment by a binary heuristic. Scope
// mirrors analyzeRoadNodes: drivable (non-path), non-tunnel edges — the surfaces
// that actually carry a continuous drivable elevation. Paths and tunnels are
// excluded here and handled by the legacy per-segment path in the consumers, so
// footbridges and portals keep their exact current behaviour.
//
// Determinism: nodes are keyed by the same half-metre snap as roadNetwork, and
// every map is populated in road order then read in sorted-key order by the
// solver, so the graph and everything derived from it reproduce bit-for-bit.

export type NodeKind = 'endpoint' | 'joint' | 'junction'

export interface IncidentEdge {
  edgeId: string
  /** Which end of the edge touches this node. */
  end: 'start' | 'end'
  /** Key of the node at the OTHER end of this edge. */
  farKey: string
  /** Edge length (m) — used to weight the elevation solve and bound grades. */
  length: number
}

export interface GraphNode {
  key: string
  p: Vec2
  incident: IncidentEdge[]
  kind: NodeKind
  /** Some incident edge is at grade (non-bridge) — this node can sit on the ground. */
  hasSurface: boolean
  /** Max layer×BRIDGE_LAYER_H over incident bridge edges (0 if none). */
  bridgeElev: number
  /**
   * Hard elevation constraint (m), or null when free. A node touched ONLY by
   * grade-separated (bridge) edges is pinned to the deck height; every other
   * node is free and settled by relaxation.
   */
  pin: number | null
}

export interface GraphEdge {
  id: string
  seg: RoadSegment
  startKey: string
  endKey: string
  length: number
  /** Longitudinal grade cap for this edge's class (fraction). */
  maxGrade: number
  bridge: boolean
  layer: number
}

export interface RoadGraph {
  nodes: Map<string, GraphNode>
  edges: Map<string, GraphEdge>
  /** Node keys with degree ≥ 3 — need C⁰ (shared elevation) but not C¹. */
  junctions: string[]
  /** Node keys with degree 2 — routes flow through with C¹ (grade) continuity. */
  joints: string[]
  /**
   * Road ids whose two ends contracted into the SAME consolidated junction
   * (only populated when the graph is built with an alias map): the 2–15 m
   * internal link ways inside a big junction. They carry no elevation
   * constraint (the junction is one height) and the renderer skips their
   * ribbons — the merged junction patch is their surface.
   */
  internalEdges: Set<string>
}

function segLength(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return l
}

/** Is this segment in scope for the elevation graph (drivable, non-tunnel, real)? */
export function isCorridorEdge(r: RoadSegment): boolean {
  return !NON_DRIVABLE.has(r.roadClass) && !r.tunnel && r.points.length >= 2
}

/**
 * Build the road-network topology graph from raw OSM road segments.
 * With `alias` (junction consolidation, see cluster.ts), member node keys
 * contract onto their cluster's canonical key: the cluster solves as ONE
 * super-node, and edges whose two ends collapse together are recorded as
 * `internalEdges` (junction-interior links) instead of graph edges.
 */
export function buildRoadGraph(roads: RoadSegment[], alias?: Map<string, string>): RoadGraph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const internalEdges = new Set<string>()
  const keyOf = (p: Vec2) => {
    const raw = nodeKey(p)
    return alias?.get(raw) ?? raw
  }

  const touch = (key: string, p: Vec2): GraphNode => {
    let n = nodes.get(key)
    if (!n) {
      n = { key, p, incident: [], kind: 'endpoint', hasSurface: false, bridgeElev: 0, pin: null }
      nodes.set(key, n)
    }
    return n
  }

  for (const r of roads) {
    if (!isCorridorEdge(r)) continue
    const start = r.points[0]
    const end = r.points[r.points.length - 1]
    const startKey = keyOf(start)
    const endKey = keyOf(end)
    // Both ends on one node: either a degenerate self-loop (raw) or a
    // junction-internal link (contracted by the alias) — no continuity to
    // solve either way.
    if (startKey === endKey) {
      if (alias && nodeKey(start) !== nodeKey(end)) internalEdges.add(r.id)
      continue
    }

    const length = segLength(r.points)
    if (length < 1e-3) continue
    const bridgeElev = r.bridge ? Math.max(r.layer, 1) * BRIDGE_LAYER_H : 0

    edges.set(r.id, {
      id: r.id,
      seg: r,
      startKey,
      endKey,
      length,
      maxGrade: maxGradeFor(r.roadClass),
      bridge: r.bridge,
      layer: r.layer,
    })

    const a = touch(startKey, start)
    const b = touch(endKey, end)
    a.incident.push({ edgeId: r.id, end: 'start', farKey: endKey, length })
    b.incident.push({ edgeId: r.id, end: 'end', farKey: startKey, length })
    for (const n of [a, b]) {
      if (!r.bridge) n.hasSurface = true
      n.bridgeElev = Math.max(n.bridgeElev, bridgeElev)
    }
  }

  // classify + pin (deterministic: derived only from per-node aggregates)
  const junctions: string[] = []
  const joints: string[] = []
  for (const [key, n] of nodes) {
    const degree = n.incident.length
    n.kind = degree >= 3 ? 'junction' : degree === 2 ? 'joint' : 'endpoint'
    if (n.kind === 'junction') junctions.push(key)
    else if (n.kind === 'joint') joints.push(key)
    // A node touched only by grade-separated edges is the elevated interior of a
    // structure and is pinned to the deck; a node that also carries an at-grade
    // edge is a ramp foot / at-grade node and stays free (relaxation settles it).
    n.pin = n.bridgeElev > 0 && !n.hasSurface ? n.bridgeElev : null
  }
  junctions.sort()
  joints.sort()

  return { nodes, edges, junctions, joints, internalEdges }
}
