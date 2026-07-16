import type { RoadSegment } from '../../types'
import {
  analyzeRoadNodes,
  BRIDGE_LAYER_H,
  elevationProfile,
  groundedNodeKeys,
  MAX_RAMP_GRADE,
  nodeKey,
  rampSpecFor,
  shortSpanElevCap,
  type RoadNodeInfo,
} from '../roadNetwork'
import { maxGradeFor, SOLVER } from './config'
import { clusterJunctions, type JunctionClusters } from './cluster'
import { buildRoadGraph, isCorridorEdge, type RoadGraph } from './graph'

// Road Corridor Redesign — Stage 2 (E1): the network elevation solve.
//
// One elevation source, three consumers (renderer, colliders, semantics). The
// solve runs in two passes over the topology graph (graph.ts):
//
//   2a. Node relaxation — projected Gauss-Seidel. Grade-separated structure
//       nodes are hard-pinned to their deck height; every other node relaxes
//       toward its base height (0 today, a DEM sample later) and toward its
//       neighbours, then is PROJECTED back inside the grade-cap interval of
//       each incident edge. This distributes a bridge's climb across the whole
//       approach chain instead of forcing an over-grade ramp into one short
//       segment — the actual fix for "broken transitions / inconsistent heights".
//
//   2b. Per-edge profile z(s) — a C¹ cubic between the two solved node heights.
//       Grades at a degree-2 JOINT are a single shared through-tangent, so a
//       route flows smoothly across segment boundaries (C¹). At a degree-≥3
//       JUNCTION every arm meets at the shared node height (C⁰). Bridge edges
//       keep the eased ramp shape (a hump when both feet are grounded) so decks
//       reproduce the legacy look while reading the solved foot elevations.
//
// Determinism: fixed iteration budget, key-sorted traversal, grade projection
// with a canonical interval — no Math.random, no wall-clock, no float early-exit
// that could differ across machines. Same roads ⇒ same elevation everywhere.

export interface EdgeGrades {
  /** dz/ds at the edge start, measured in the start→end direction. */
  start: number
  /** dz/ds at the edge end, measured in the start→end direction. */
  end: number
}

export interface ElevationStats {
  /** Iterations run (== budget ⇒ did not reach tolerance). */
  iterations: number
  /** Largest node move on the final iteration (m). */
  residual: number
  /** True when the solve reached tolerance within the iteration budget. */
  converged: boolean
  /** Incident-edge grade constraints the geometry made infeasible. */
  gradeViolations: number
  /** Consolidated junction clusters (multi-node) found by cluster.ts. */
  clusters: number
  /** Junction-internal link edges contracted away by consolidation. */
  internalEdges: number
}

export interface NetworkElevation {
  /** Solved true-metre elevation at a graph node (0 if the key is unknown). */
  nodeElevation(key: string): number
  /** Grades (dz/ds, start→end) at an edge's two ends, or null for a non-corridor edge. */
  edgeGrades(edgeId: string): EdgeGrades | null
  /**
   * True-metre elevation profile (0 = grade, no cosmetic Y offset) for `r`
   * sampled at the cumulative distances `cum` along the caller's polyline.
   * Non-corridor edges (paths, tunnels, degenerate) fall back to the legacy
   * per-segment ramp math so footbridges and portals are unchanged.
   */
  profileFor(r: RoadSegment, cum: number[]): number[]
  /** Canonical key of the consolidated junction containing `key`, or null. */
  clusterOf(key: string): string | null
  /** True for junction-internal link roads (both ends in one cluster). */
  isInternal(roadId: string): boolean
  readonly stats: ElevationStats
}

const smoothstep = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)))
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Cubic Hermite on [0,1] with endpoint values and endpoint tangents (per unit t). */
function hermite(t: number, z0: number, z1: number, m0: number, m1: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * z0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * z1 + (t3 - t2) * m1
}

/** Solve the whole road network's elevation from raw OSM road segments. */
export function solveNetworkElevation(roads: RoadSegment[]): NetworkElevation {
  const legacyNodes = analyzeRoadNodes(roads) // for the non-corridor fallback path
  const grounded = groundedNodeKeys(roads) // all-class grounding for footbridges

  // Pass 1 — solve the raw graph, so junction consolidation can judge node
  // compatibility at SOLVED heights (grade-separated levels must never merge).
  const graph1 = buildRoadGraph(roads)
  const pass1 = solveNodeElevations(graph1)
  const consolidation: JunctionClusters = clusterJunctions(graph1, pass1.z)

  // Pass 2 — contract each cluster to one super-node and re-solve: the whole
  // junction settles at ONE height and every arm ramps smoothly into it.
  const graph = consolidation.alias.size ? buildRoadGraph(roads, consolidation.alias) : graph1
  const { z, iterations, residual } = solveNodeElevations(graph)
  const grades = solveEdgeGrades(graph, z)
  const stats = computeStats(graph, z, iterations, residual)
  stats.clusters = consolidation.clusters.size
  stats.internalEdges = graph.internalEdges.size

  const zAt = (key: string) => z.get(consolidation.alias.get(key) ?? key) ?? 0

  return {
    nodeElevation: zAt,
    edgeGrades: (edgeId) => grades.get(edgeId) ?? null,
    profileFor: (r, cum) => profileFor(r, cum, graph, z, grades, legacyNodes, grounded, zAt),
    clusterOf: (key) => consolidation.alias.get(key) ?? null,
    isInternal: (roadId) => graph.internalEdges.has(roadId),
    stats,
  }
}

// ---- 2a. node relaxation ---------------------------------------------------

// Base height per node (0 today; a DEM sample plugs in here later, §6a E6).
const baseHeight = (_key: string): number => 0

function solveNodeElevations(graph: RoadGraph): {
  z: Map<string, number>
  iterations: number
  residual: number
} {
  const z = new Map<string, number>()
  const keys = [...graph.nodes.keys()].sort() // fixed, deterministic visit order
  for (const key of keys) {
    const n = graph.nodes.get(key)!
    z.set(key, n.pin ?? baseHeight(key))
  }

  const { maxIterations, tolerance, baseWeight } = SOLVER
  let iterations = 0
  let residual = 0
  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1
    let maxMove = 0
    for (const key of keys) {
      const n = graph.nodes.get(key)!
      if (n.pin !== null) continue // hard constraint — never moves

      // Laplacian target: pull toward base and toward neighbours (1/length weighted).
      let num = baseWeight * baseHeight(key)
      let den = baseWeight
      // Grade-cap interval: intersection of [z_j ± maxGrade·len] over incident edges.
      let lo = -Infinity
      let hi = Infinity
      for (const inc of n.incident) {
        const zj = z.get(inc.farKey)!
        const w = 1 / inc.length
        num += w * zj
        den += w
        const span = graph.edges.get(inc.edgeId)!.maxGrade * inc.length
        lo = Math.max(lo, zj - span)
        hi = Math.min(hi, zj + span)
      }
      const target = num / den
      // An empty interval means pins demand a steeper grade than the geometry
      // allows over the available length — take the midpoint compromise (the
      // least-violating deterministic choice) rather than crash or diverge.
      const next = lo <= hi ? clamp(target, lo, hi) : (lo + hi) / 2

      const prev = z.get(key)!
      z.set(key, next)
      maxMove = Math.max(maxMove, Math.abs(next - prev))
    }
    residual = maxMove
    if (maxMove < tolerance) break
  }
  return { z, iterations, residual }
}

// ---- 2b. per-node out-grades → per-edge end grades -------------------------

/** dz/ds moving OUTWARD from each node into each incident edge (metres/metre). */
function solveEdgeGrades(graph: RoadGraph, z: Map<string, number>): Map<string, EdgeGrades> {
  const outGrade = new Map<string, Map<string, number>>()
  const setOut = (key: string, edgeId: string, g: number) => {
    let m = outGrade.get(key)
    if (!m) outGrade.set(key, (m = new Map()))
    m.set(edgeId, g)
  }

  for (const key of [...graph.nodes.keys()].sort()) {
    const n = graph.nodes.get(key)!
    const zN = z.get(key)!
    if (n.kind === 'joint' && n.incident.length === 2) {
      // Shared through-tangent → C¹ across the joint. Axis: farA → N → farB.
      const [A, B] = n.incident
      const m = (z.get(B.farKey)! - z.get(A.farKey)!) / (A.length + B.length)
      const capA = graph.edges.get(A.edgeId)!.maxGrade
      const capB = graph.edges.get(B.edgeId)!.maxGrade
      // Moving outward toward farA is the −axis direction; toward farB is +axis.
      setOut(key, A.edgeId, clamp(-m, -capA, capA))
      setOut(key, B.edgeId, clamp(m, -capB, capB))
    } else {
      // Junction / endpoint: no shared tangent — each edge runs ~straight (its
      // own secant) into the node. Junctions keep only C⁰ (shared node height).
      for (const inc of n.incident) {
        const cap = graph.edges.get(inc.edgeId)!.maxGrade
        setOut(key, inc.edgeId, clamp((z.get(inc.farKey)! - zN) / inc.length, -cap, cap))
      }
    }
  }

  const grades = new Map<string, EdgeGrades>()
  for (const [id, edge] of graph.edges) {
    // start grade (start→end) = outward-from-start; end grade (start→end) =
    // −outward-from-end (outward at the end points end→start).
    grades.set(id, {
      start: outGrade.get(edge.startKey)?.get(id) ?? 0,
      end: -(outGrade.get(edge.endKey)?.get(id) ?? 0),
    })
  }
  return grades
}

// ---- per-edge profile evaluation ------------------------------------------

function profileFor(
  r: RoadSegment,
  cum: number[],
  graph: RoadGraph,
  z: Map<string, number>,
  grades: Map<string, EdgeGrades>,
  legacyNodes: Map<string, RoadNodeInfo>,
  grounded: Set<string>,
  zAt: (key: string) => number,
): number[] {
  // Junction-internal link (both ends contracted into one cluster): flat at
  // the consolidated junction height — the junction patch is its surface.
  if (graph.internalEdges.has(r.id)) {
    const zc = zAt(nodeKey(r.points[0]))
    return cum.map(() => zc)
  }
  const edge = graph.edges.get(r.id)
  if (!edge || !isCorridorEdge(r)) {
    if (r.bridge && r.points.length >= 2) {
      // Path bridges (footways/cycleways): legacy ramp shape, but grounded via
      // the ALL-class node map — analyzeRoadNodes only sees drivable ways, so a
      // footbridge landing on a path used to stay pinned at full height and
      // float mid-air at its ends. Height is capped by what the span can
      // physically climb at the class grade limit (a 21 m footbridge is a
      // gentle bump, not a 6.5 m spike).
      const L = cum[cum.length - 1]
      const fullElev = Math.min(
        Math.max(r.layer, 1) * BRIDGE_LAYER_H,
        shortSpanElevCap(L, maxGradeFor(r.roadClass)),
      )
      const rampLen = Math.min(Math.max(fullElev / MAX_RAMP_GRADE, 40), Math.max(L * 0.45, 20))
      const [startElev, endElev] = [r.points[0], r.points[r.points.length - 1]].map((p) =>
        grounded.has(nodeKey(p)) ? 0 : fullElev,
      )
      return elevationProfile({ fullElev, rampLen, startElev, endElev }, cum)
    }
    // Non-bridge paths, tunnels, self-loops, degenerate — legacy behaviour.
    const spec = r.points.length >= 2 ? rampSpecFor(r, cum[cum.length - 1], legacyNodes) : null
    return elevationProfile(spec, cum)
  }

  const L = cum[cum.length - 1] || edge.length
  const z0 = z.get(edge.startKey)!
  const z1 = z.get(edge.endKey)!

  if (edge.bridge) {
    // Eased ramp/hump onto the deck (preserves the legacy deck look) but reading
    // the SOLVED foot elevations so it welds to whatever the network settled on.
    const fullElev = Math.max(edge.layer, 1) * BRIDGE_LAYER_H
    const rampLen = Math.min(Math.max(fullElev / edge.maxGrade, 40), Math.max(L * 0.45, 20))
    return cum.map((d) => {
      const up = z0 + (fullElev - z0) * smoothstep(d / rampLen)
      const down = z1 + (fullElev - z1) * smoothstep((L - d) / rampLen)
      return Math.min(up, down)
    })
  }

  const g = grades.get(r.id)!
  const m0 = g.start * L // Hermite tangents are per unit t → scale by length
  const m1 = g.end * L
  return cum.map((d) => hermite(L > 0 ? d / L : 0, z0, z1, m0, m1))
}

// ---- stats -----------------------------------------------------------------

function computeStats(
  graph: RoadGraph,
  z: Map<string, number>,
  iterations: number,
  residual: number,
): ElevationStats {
  let gradeViolations = 0
  for (const edge of graph.edges.values()) {
    const dz = Math.abs(z.get(edge.endKey)! - z.get(edge.startKey)!)
    if (dz > edge.maxGrade * edge.length + 1e-6) gradeViolations++
  }
  return {
    iterations,
    residual,
    converged: iterations < SOLVER.maxIterations || residual < SOLVER.tolerance,
    gradeViolations,
    clusters: 0, // filled by solveNetworkElevation
    internalEdges: 0,
  }
}
