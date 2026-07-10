import type { CityGraph } from '../types'
import { ringAreaM2, ringIsSimple } from '../procgen/geometry'
import { MAX_RAMP_GRADE } from '../procgen/roadNetwork'
import type { LintWarning } from '../resolver/varietyLint'
import type { ColliderSet } from './types'

// Export-gate lint for the physics collider set. Pure (unlike flickerLint it
// reads no store/registry state) so it runs in vitest and at export time.

const MAX_TRIS_PER_MESH = 60_000
const MAX_TRIS_TOTAL = 1_500_000
// eased ramp curve peaks at π/2 × mean grade (see roadNetwork.ease); 1.6 covers it
const GRADE_TOLERANCE = 1.6

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

  // 3) bridge grade limit along road collider profiles
  let gradeIssues = 0
  for (const c of set.colliders) {
    if (c.semantics.class !== 'road' || !c.semantics.bridge || !c.geometry) continue
    const pos = c.geometry.getAttribute('position')
    // ribbon layout: vertices [left_i, right_i] pairs along the centerline
    for (let i = 0; i + 2 < pos.count; i += 2) {
      const dy = Math.abs(pos.getY(i + 2) - pos.getY(i))
      const dd = Math.hypot(pos.getX(i + 2) - pos.getX(i), pos.getZ(i + 2) - pos.getZ(i))
      if (dd > 0.5 && dy / dd > MAX_RAMP_GRADE * GRADE_TOLERANCE) {
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
