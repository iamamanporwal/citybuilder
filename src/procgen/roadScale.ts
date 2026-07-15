import type {
  BarrierFeature,
  BuildingFeature,
  CityGraph,
  PointFeature,
  RoadSegment,
  Vec2,
} from '../types'
import { NON_DRIVABLE } from './roadNetwork'

// Road Width Scaling — the car-game "stretch roads" trigger (redesign §14).
//
// A pure, deterministic transform: widen the drivable carriageways by a factor
// and displace non-road features (buildings/props/barriers) just enough to make
// room, so wider roads stay aesthetic and nothing gets buried under asphalt.
// Applied at build time, so the renderer, colliders, semantics and drive
// preview all consume the same scaled graph. Identity at factor === 1.
//
// "What is a road" is answered by the data model: CityGraph.roads, drivable
// subset for widening + displacement. Areas (grass/park/WATER) and terrain are
// never touched — asphalt over grass reads fine, and water stays on its own
// carve/whitelist invariants.

/** Extra gap (m) kept between the new curb and a displaced feature. */
const SETBACK_MARGIN = 1.5
/** Clamp the multiplier to a sane, aesthetic range. */
const MIN_SCALE = 1
const MAX_SCALE = 4
/** Grid cells never smaller than this, so a thin road doesn't shatter the grid. */
const MIN_CELL = 8

export function clampRoadScale(factor: number): number {
  if (!Number.isFinite(factor)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, factor))
}

const isDrivable = (r: RoadSegment) => !NON_DRIVABLE.has(r.roadClass)

/**
 * Widen drivable roads by `factor` and displace non-road features out of the
 * widened corridors. Returns a NEW graph (the input is never mutated); returns
 * the input unchanged when `factor` rounds to 1.
 */
export function scaleRoadNetwork(graph: CityGraph, factor: number): CityGraph {
  const k = clampRoadScale(factor)
  if (Math.abs(k - 1) < 1e-6) return graph

  // 1. widen carriageways in place (centerlines unchanged). Paths keep width.
  const roads = graph.roads.map((r) => (isDrivable(r) ? { ...r, widthM: r.widthM * k } : r))

  // 2. displacement field from AT-GRADE drivable roads only (a widened bridge
  //    deck passes over ground features — it must not shove them aside).
  const field = buildDisplacementField(graph.roads, k)

  const buildings = graph.buildings.map((b) => displaceBuilding(b, field))
  const points = graph.points.map((p) => displacePoint(p, field))
  const barriers = graph.barriers.map((b) => displaceBarrier(b, field))

  return { ...graph, roads, buildings, points, barriers }
}

// ---- displacement field ----------------------------------------------------

interface WideEdge {
  a: Vec2
  b: Vec2
  /** clearance = new half-width + setback margin. */
  clearance: number
}

type Field = (p: Vec2) => Vec2

/** Push a point out of every widened at-grade drivable road that now overlaps it. */
function buildDisplacementField(roads: RoadSegment[], k: number): Field {
  const edges: WideEdge[] = []
  let maxClearance = MIN_CELL
  for (const r of roads) {
    if (!isDrivable(r) || r.bridge || r.tunnel || r.points.length < 2) continue
    const clearance = (k * r.widthM) / 2 + SETBACK_MARGIN
    maxClearance = Math.max(maxClearance, clearance)
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]
      const b = r.points[i]
      if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-6) edges.push({ a, b, clearance })
    }
  }
  if (edges.length === 0) return () => ({ x: 0, z: 0 })

  // uniform spatial grid: each edge is inserted into every cell its influence
  // AABB touches, so a query only needs the single cell containing the point.
  const cell = maxClearance
  const grid = new Map<string, WideEdge[]>()
  const key = (cx: number, cz: number) => `${cx},${cz}`
  for (const e of edges) {
    const minX = Math.min(e.a.x, e.b.x) - e.clearance
    const maxX = Math.max(e.a.x, e.b.x) + e.clearance
    const minZ = Math.min(e.a.z, e.b.z) - e.clearance
    const maxZ = Math.max(e.a.z, e.b.z) + e.clearance
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
      for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz++) {
        const k2 = key(cx, cz)
        let bucket = grid.get(k2)
        if (!bucket) grid.set(k2, (bucket = []))
        bucket.push(e)
      }
    }
  }

  return (p: Vec2): Vec2 => {
    const bucket = grid.get(key(Math.floor(p.x / cell), Math.floor(p.z / cell)))
    if (!bucket) return { x: 0, z: 0 }
    let dx = 0
    let dz = 0
    for (const e of bucket) {
      const near = closestOnSegment(p, e.a, e.b)
      const pen = e.clearance - near.dist
      if (pen > 0) {
        dx += near.nx * pen
        dz += near.nz * pen
      }
    }
    return { x: dx, z: dz }
  }
}

/** Closest point on segment a→b to p: perpendicular distance + unit outward normal. */
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; nx: number; nz: number } {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const len2 = abx * abx + abz * abz
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + abx * t
  const cz = a.z + abz * t
  let nx = p.x - cx
  let nz = p.z - cz
  const dist = Math.hypot(nx, nz)
  if (dist > 1e-6) {
    nx /= dist
    nz /= dist
  } else {
    // p sits on the centerline — push along the segment's left normal (stable,
    // deterministic choice) rather than emit a NaN direction.
    const l = Math.sqrt(len2) || 1
    nx = abz / l
    nz = -abx / l
  }
  return { dist, nx, nz }
}

// ---- per-feature application -----------------------------------------------

/** Translate a building rigidly by its most-encroached footprint vertex's push. */
function displaceBuilding(b: BuildingFeature, field: Field): BuildingFeature {
  let best: Vec2 = { x: 0, z: 0 }
  let bestMag = 0
  for (const v of b.footprint) {
    const d = field(v)
    const m = d.x * d.x + d.z * d.z
    if (m > bestMag) {
      bestMag = m
      best = d
    }
  }
  if (bestMag === 0) return b
  return { ...b, footprint: b.footprint.map((v) => ({ x: v.x + best.x, z: v.z + best.z })) }
}

function displacePoint(p: PointFeature, field: Field): PointFeature {
  const d = field(p.position)
  if (d.x === 0 && d.z === 0) return p
  return { ...p, position: { x: p.position.x + d.x, z: p.position.z + d.z } }
}

function displaceBarrier(b: BarrierFeature, field: Field): BarrierFeature {
  let moved = false
  const points = b.points.map((v) => {
    const d = field(v)
    if (d.x === 0 && d.z === 0) return v
    moved = true
    return { x: v.x + d.x, z: v.z + d.z }
  })
  return moved ? { ...b, points } : b
}
