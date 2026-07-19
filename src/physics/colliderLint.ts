import type { CityGraph, RoadSegment, Vec2 } from '../types'
import { polylineLength, ringAreaM2, ringIsSimple } from '../procgen/geometry'
import {
  analyzeRoadNodes,
  BRIDGE_LAYER_H,
  cumulative,
  discRadius,
  MAX_RAMP_GRADE,
  NON_DRIVABLE,
  nodeKey,
  segCenterline,
  shortSpanElevCap,
} from '../procgen/roadNetwork'
import { buildRoadElevation } from '../procgen/corridor'
import { maxGradeFor } from '../procgen/corridor/config'
import type { LintWarning } from '../resolver/varietyLint'
import type { ColliderSet } from './types'

// Export-gate lint for the physics collider set. Pure (unlike flickerLint it
// reads no store/registry state) so it runs in vitest and at export time.

const MAX_TRIS_PER_MESH = 60_000
const MAX_TRIS_TOTAL = 1_500_000
// eased ramp curve peaks at π/2 × mean grade (see roadNetwork.ease); 1.6 covers it
const GRADE_TOLERANCE = 1.6
// A solid obstacle counts as a lane intrusion only when its centre sits deeper
// than this inside the carriageway edge — so legitimate edge structures (curbs
// at half+0.05, a tree just off the kerb) never trip it, but a prop dropped on
// the lane (e.g. an OSM device left at its raw centreline coordinate) does.
const LANE_INTRUSION_MARGIN = 0.6
// Max vertical step tolerated where a road ribbon meets its junction disc. The
// parity contract (colliders.ts header) makes both = elevation + Y_ROAD_COL, so
// a clean solve is ~0 here; anything above this is a bump the car would feel.
const SEAM_STEP_TOL = 0.08

export function colliderLint(graph: CityGraph, set: ColliderSet): LintWarning[] {
  const warnings: LintWarning[] = []
  const warn = (message: string) => warnings.push({ severity: 'warn', message })

  const byClass = new Map<string, Set<string>>()
  for (const c of set.colliders) {
    if (!byClass.has(c.semantics.class)) byClass.set(c.semantics.class, new Set())
    if (c.semantics.featureId) byClass.get(c.semantics.class)!.add(c.semantics.featureId)
  }

  // 1) coverage: every non-tunnel road has a road collider
  const roadIds = byClass.get('road') ?? new Set()
  const missingRoads = graph.roads.filter((r) => !r.tunnel && r.points.length >= 2 && !roadIds.has(r.id))
  if (missingRoads.length) {
    warn(`Collider coverage: ${missingRoads.length} road(s) missing colliders (e.g. ${missingRoads[0].id})`)
  }

  // coverage: every valid building footprint has a collider; degenerates reported
  const buildingIds = byClass.get('building') ?? new Set()
  let degenerate = 0
  const missingBuildings: string[] = []
  for (const b of graph.buildings) {
    const valid = b.footprint.length >= 3 && ringIsSimple(b.footprint) && ringAreaM2(b.footprint) >= 1
    if (!valid) degenerate++
    else if (!buildingIds.has(b.id)) missingBuildings.push(b.id)
  }
  // buildings can legitimately be excluded (deleted/hidden in the editor) —
  // only warn when nothing at all was emitted for a non-empty city
  if (graph.buildings.length > degenerate && buildingIds.size === 0) {
    warn(`Collider coverage: no building colliders emitted for ${graph.buildings.length} buildings`)
  }
  if (degenerate) {
    warnings.push({
      severity: 'info',
      message: `Collider: ${degenerate} degenerate building footprint(s) skipped (non-simple or <1 m²)`,
    })
  }

  // exactly one terrain collider
  const terrainCount = set.stats.terrain
  if (terrainCount !== 1) warn(`Collider: expected exactly 1 terrain collider, found ${terrainCount}`)

  // 2) NaN / finite scan
  let nanIssues = 0
  for (const c of set.colliders) {
    const nums = [
      ...c.transform.position,
      ...c.transform.quaternion,
      ...(c.halfExtents ?? []),
      c.radius ?? 0,
      c.halfHeight ?? 0,
    ]
    if (nums.some((v) => !Number.isFinite(v))) nanIssues++
    if (c.geometry) {
      const pos = c.geometry.getAttribute('position')
      const arr = pos.array as Float32Array
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) {
          nanIssues++
          break
        }
      }
    }
  }
  if (nanIssues) warn(`Collider: ${nanIssues} collider(s) contain non-finite values`)

  // 3) bridge grade limit along road collider profiles. Each bridge is judged
  // against its OWN design profile: a short span clamps its ramp to 45% of the
  // length (roadNetwork.rampSpecFor), so its mean grade legitimately exceeds
  // MAX_RAMP_GRADE — that compromise is already reported by the road-
  // consistency lint, and the collider check must not double-fire on it.
  const roadById = new Map(graph.roads.map((r) => [r.id, r]))
  let gradeIssues = 0
  for (const c of set.colliders) {
    if (c.semantics.class !== 'road' || !c.semantics.bridge || !c.geometry) continue
    const r = c.semantics.featureId ? roadById.get(c.semantics.featureId) : undefined
    let allowedMean = MAX_RAMP_GRADE
    if (r && r.points.length >= 2) {
      const L = polylineLength(r.points)
      // mirror the generators: path bridges cap their height by what the span
      // can climb at the class grade limit (corridor/elevation.ts fallback)
      let fullElev = Math.max(r.layer, 1) * BRIDGE_LAYER_H
      if (NON_DRIVABLE.has(r.roadClass)) {
        fullElev = Math.min(fullElev, shortSpanElevCap(L, maxGradeFor(r.roadClass)))
      }
      // design mean grade under either profile source: legacy ramps use
      // MAX_RAMP_GRADE, the network solve uses the per-class cap — allow the
      // steeper of the two design intents for this span.
      const meanFor = (cap: number) =>
        fullElev / Math.min(Math.max(fullElev / cap, 40), Math.max(L * 0.45, 20))
      allowedMean = Math.max(
        MAX_RAMP_GRADE,
        meanFor(MAX_RAMP_GRADE),
        meanFor(maxGradeFor(r.roadClass)),
      )
    }
    const pos = c.geometry.getAttribute('position')
    // ribbon layout: vertices [left_i, right_i] pairs along the centerline
    for (let i = 0; i + 2 < pos.count; i += 2) {
      const dy = Math.abs(pos.getY(i + 2) - pos.getY(i))
      const dd = Math.hypot(pos.getX(i + 2) - pos.getX(i), pos.getZ(i + 2) - pos.getZ(i))
      if (dd > 0.5 && dy / dd > allowedMean * GRADE_TOLERANCE) {
        gradeIssues++
        break
      }
    }
  }
  if (gradeIssues) warn(`Collider: ${gradeIssues} bridge collider(s) exceed the ${MAX_RAMP_GRADE * 100}% grade limit`)

  // 4) trimesh budgets (Rapier static trimesh cooking cost guard)
  let totalTris = 0
  let oversize = 0
  for (const c of set.colliders) {
    if (!c.geometry) continue
    const tris = (c.geometry.getIndex()?.count ?? c.geometry.getAttribute('position').count) / 3
    totalTris += tris
    if (tris > MAX_TRIS_PER_MESH) oversize++
  }
  if (oversize) warn(`Collider: ${oversize} trimesh(es) exceed ${MAX_TRIS_PER_MESH.toLocaleString()} triangles`)
  if (totalTris > MAX_TRIS_TOTAL) {
    warn(`Collider: total trimesh budget exceeded (${Math.round(totalTris).toLocaleString()} triangles)`)
  }

  // 5) unique ids — a duplicated id means two colliders were emitted for one
  // feature (a merge/dedup slip); the GLB loader keys on the node name, so the
  // second silently overwrites or double-stacks. Cheap invariant, guards §14A.
  const ids = new Set<string>()
  let dupIds = 0
  for (const c of set.colliders) {
    if (ids.has(c.id)) dupIds++
    ids.add(c.id)
  }
  if (dupIds) warn(`Collider: ${dupIds} duplicate collider id(s)`)

  // 6) lane intrusion — the core "invisible obstacle on the road" guard. No
  // SOLID prop collider may sit inside a drivable, at-grade carriageway MID-BLOCK:
  // props belong on the kerb/verge, and one dropped in a lane is exactly the
  // phantom a car slams into. Junction discs are excluded — an intersection is an
  // open drivable area where corner devices (signals) legitimately sit near the
  // untrimmed ribbon overlap; only a straight-segment intrusion is a real hazard.
  const lanes = new DrivableLaneSet(graph.roads, analyzeRoadNodes(graph.roads))
  const intruders: string[] = []
  for (const c of set.colliders) {
    if (c.semantics.sensor || c.semantics.class !== 'prop') continue
    const [x, , z] = c.transform.position
    if (lanes.intrudes({ x, z })) intruders.push(c.semantics.featureId ?? c.id)
  }
  if (intruders.length) {
    warn(
      `Collider: ${intruders.length} solid prop collider(s) intrude into a driving lane ` +
        `(e.g. ${intruders[0]}) — obstacle on the drivable surface`,
    )
  }

  // 7) seam continuity — where a road ribbon meets its junction disc both are
  // emitted at elevation + Y_ROAD_COL, so a correct solve leaves no step. A
  // mismatch here is a lip the car jolts over crossing the intersection.
  const steps = seamSteps(graph.roads)
  if (steps.count) {
    warn(
      `Collider: ${steps.count} junction seam(s) step more than ${(SEAM_STEP_TOL * 100).toFixed(0)} cm ` +
        `(worst ${(steps.worst * 100).toFixed(0)} cm at ${steps.worstNode}) — bump crossing the junction`,
    )
  }

  if (!warnings.some((w) => w.severity === 'warn')) {
    warnings.push({
      severity: 'info',
      message: `Collider check passed: ${set.colliders.length} colliders (${Object.entries(set.stats)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}), ${Math.round(totalTris).toLocaleString()} collision triangles`,
    })
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Drivable-lane membership oracle (pure, node-safe — re-implemented locally like
// sanity.ts's DrivableGrid so this lint never imports the DOM-tainted renderer).
// Indexes at-grade, drivable carriageways; bridge/tunnel decks are excluded
// because their lanes are elevated, so a ground-level prop under them is not an
// intrusion. A uniform grid keeps the per-collider query O(1).
// ---------------------------------------------------------------------------

interface LaneSeg { ax: number; az: number; bx: number; bz: number; half: number }
interface JunctionDisc { x: number; z: number; r2: number }

class DrivableLaneSet {
  private cells = new Map<string, LaneSeg[]>()
  private discs: JunctionDisc[] = []
  private static CELL = 24

  constructor(roads: RoadSegment[], nodes: ReturnType<typeof analyzeRoadNodes>) {
    for (const r of roads) {
      if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.bridge) continue
      if (r.points.length < 2 || !(r.widthM > 0)) continue
      const half = r.widthM / 2
      for (let i = 1; i < r.points.length; i++) this.insert(r.points[i - 1], r.points[i], half)
    }
    // junction open areas: a corner device near the untrimmed ribbon overlap is
    // not a mid-lane hazard, so exclude a disc (a bit past the visual disc radius).
    for (const info of nodes.values()) {
      if (info.count < 2) continue
      const rad = discRadius(info.maxWidth) + 1
      this.discs.push({ x: info.p.x, z: info.p.z, r2: rad * rad })
    }
  }

  private nearJunction(p: Vec2): boolean {
    for (const d of this.discs) {
      if ((p.x - d.x) ** 2 + (p.z - d.z) ** 2 < d.r2) return true
    }
    return false
  }

  private insert(a: Vec2, b: Vec2, half: number): void {
    const C = DrivableLaneSet.CELL
    const pad = half + 1
    for (let cx = Math.floor((Math.min(a.x, b.x) - pad) / C); cx <= Math.floor((Math.max(a.x, b.x) + pad) / C); cx++) {
      for (let cz = Math.floor((Math.min(a.z, b.z) - pad) / C); cz <= Math.floor((Math.max(a.z, b.z) + pad) / C); cz++) {
        const key = `${cx},${cz}`
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, half })
      }
    }
  }

  /** True when p sits deeper than LANE_INTRUSION_MARGIN inside a carriageway,
   *  away from any junction disc (open intersection area). */
  intrudes(p: Vec2): boolean {
    if (this.nearJunction(p)) return false
    const C = DrivableLaneSet.CELL
    const list = this.cells.get(`${Math.floor(p.x / C)},${Math.floor(p.z / C)}`)
    if (!list) return false
    for (const s of list) {
      const limit = s.half - LANE_INTRUSION_MARGIN
      if (limit > 0 && pointSegDist(p, s.ax, s.az, s.bx, s.bz) < limit) return true
    }
    return false
  }
}

function pointSegDist(q: Vec2, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  let t = len2 > 1e-9 ? ((q.x - ax) * dx + (q.z - az) * dz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(q.x - (ax + dx * t), q.z - (az + dz * t))
}

/**
 * Vertical step where each road end meets the junction disc it feeds. Both the
 * road ribbon (elevation.profileFor) and the disc (elevation.nodeElevation) sit
 * at the same +Y_ROAD_COL offset, so the physical step is |profile_end − node|.
 * Pure: rebuilds the same elevation the collider builder used.
 */
function seamSteps(roads: RoadSegment[]): { count: number; worst: number; worstNode: string } {
  const nodes = analyzeRoadNodes(roads)
  const elevation = buildRoadElevation(roads)
  let count = 0
  let worst = 0
  let worstNode = ''
  for (const r of roads) {
    if (r.tunnel || r.points.length < 2) continue
    const pts = segCenterline(r)
    const profile = elevation.profileFor(r, cumulative(pts))
    for (const atEnd of [false, true]) {
      const endPt = atEnd ? pts[pts.length - 1] : pts[0]
      const key = nodeKey(endPt)
      const node = nodes.get(key)
      if (!node || node.count < 2) continue // not a shared junction; nothing to match
      const step = Math.abs((atEnd ? profile[profile.length - 1] : profile[0]) - elevation.nodeElevation(key))
      if (step > SEAM_STEP_TOL) {
        count++
        if (step > worst) { worst = step; worstNode = key }
      }
    }
  }
  return { count, worst, worstNode }
}
