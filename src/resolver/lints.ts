import * as THREE from 'three'
import type { Vec2 } from '../types'
import { useEditor } from '../state/store'
import { cityGraph, getVariant, roadSegments } from '../scene/registry'
import { DEPTH_CONFIG, depthQuantumAt, LAYER_CONVENTION, MIN_SEPARATION } from '../editor/depthConfig'
import { auditWater } from './waterAudit'
import type { LintWarning } from './varietyLint'

// Geometry robustness linters, run after every build and again as an export
// gate: depth-precision + coplanar-overlap flicker, water over-classification,
// road network consistency (elevation/width jumps, seams, under-clearance).

export { LAYER_CONVENTION } from '../editor/depthConfig'

/** Water over-classification regression gate (see waterAudit.ts). */
export function waterLint(): LintWarning[] {
  if (!cityGraph) return []
  return auditWater(cityGraph)
}

export function flickerLint(): LintWarning[] {
  const warnings: LintWarning[] = []

  // ---- static: every layer separation must exceed the worst-case depth
  // quantum anywhere in the frustum, or the stack z-fights when zoomed out.
  // This is the regression gate that fails if someone disables the log depth
  // buffer, stretches the far plane, or squeezes the layer convention.
  const worstQuantum = depthQuantumAt(DEPTH_CONFIG.far)
  if (worstQuantum > MIN_SEPARATION) {
    warnings.push({
      severity: 'warn',
      message: `Depth buffer cannot resolve the layer stack: quantum at far plane is ${(worstQuantum * 1000).toFixed(1)}mm > min layer separation ${MIN_SEPARATION * 1000}mm (near=${DEPTH_CONFIG.near}, far=${DEPTH_CONFIG.far}, logDepth=${DEPTH_CONFIG.logarithmicDepthBuffer}). All flat layers will flicker at distance.`,
    })
  }

  // ---- static: the layer convention itself must stay separated
  const sorted = [...LAYER_CONVENTION].sort((a, b) => a[1] - b[1])
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i][1] - sorted[i - 1][1]
    if (gap < MIN_SEPARATION - 1e-9) {
      warnings.push({
        severity: 'warn',
        message: `Layer convention violated: "${sorted[i - 1][0]}" and "${sorted[i][0]}" are ${Math.round(gap * 1000)}mm apart (min ${MIN_SEPARATION * 1000}mm).`,
      })
    }
  }

  // ---- dynamic: scan flat meshes for near-coplanar XZ overlaps
  const s = useEditor.getState()
  const flats: { name: string; type: string; y: number; box: THREE.Box3 }[] = []
  const tmp = new THREE.Box3()
  for (const id of s.objectOrder) {
    const obj = s.objects[id]
    if (!obj || obj.deleted || !obj.visible) continue
    const three = getVariant(obj.id, obj.asset)
    if (!three) continue
    three.updateMatrixWorld(true)
    three.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      mesh.geometry.computeBoundingBox()
      if (!mesh.geometry.boundingBox) return
      // world-space bbox: local geometry bounds through the mesh's world matrix
      tmp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
      const h = tmp.max.y - tmp.min.y
      const area = (tmp.max.x - tmp.min.x) * (tmp.max.z - tmp.min.z)
      // truly flat surfaces only — raised slabs (sidewalks, curbs) have vertical
      // skirts and are not coplanar-risk layers
      if (h < 0.1 && area > 6) {
        flats.push({ name: obj.name, type: obj.type, y: (tmp.min.y + tmp.max.y) / 2, box: tmp.clone() })
      }
    })
  }
  let coplanarPairs = 0
  let example = ''
  for (let i = 0; i < flats.length; i++) {
    for (let j = i + 1; j < flats.length; j++) {
      const a = flats[i]
      const b = flats[j]
      if (a.name === b.name) continue // merged layers of the same object overlap by design
      // same layer class shares a height by design and its members never overlap
      // spatially (markings are disjoint quads; road ribbons are trimmed at
      // junctions by construction) — the AABB test would false-positive on
      // diagonal neighbors, so intra-class pairs are exempt; cross-class
      // conflicts (road vs area, decal vs water, …) remain fully checked
      if (a.type === b.type && (a.type === 'markings' || a.type === 'road' || a.type === 'area')) continue
      if (Math.abs(a.y - b.y) > MIN_SEPARATION * 0.75) continue
      if (a.box.max.x < b.box.min.x || b.box.max.x < a.box.min.x) continue
      if (a.box.max.z < b.box.min.z || b.box.max.z < a.box.min.z) continue
      coplanarPairs++
      if (!example) example = `"${a.name}" ↔ "${b.name}" at y≈${a.y.toFixed(3)}`
    }
  }
  // ---- dynamic: exact duplicates (e.g. a mesh added twice / seam dedupe failure)
  let duplicates = 0
  for (let i = 0; i < flats.length; i++) {
    for (let j = i + 1; j < flats.length; j++) {
      const a = flats[i], b = flats[j]
      if (a.name === b.name) continue
      if (
        Math.abs(a.y - b.y) < 1e-4 &&
        Math.abs(a.box.min.x - b.box.min.x) < 0.01 && Math.abs(a.box.max.x - b.box.max.x) < 0.01 &&
        Math.abs(a.box.min.z - b.box.min.z) < 0.01 && Math.abs(a.box.max.z - b.box.max.z) < 0.01
      ) duplicates++
    }
  }
  if (duplicates > 0) {
    warnings.push({ severity: 'warn', message: `${duplicates} exact-duplicate flat mesh pair(s) — the same surface is in the scene twice.` })
  }

  // ---- dynamic: wear decals share one Y layer; overlapping quads are exactly
  // coplanar and z-fight regardless of depth precision. Placement is
  // rejection-sampled at build time (decalPlan.ts); this catches regressions.
  const decalOverlaps = countDecalQuadOverlaps()
  if (decalOverlaps > 0) {
    warnings.push({ severity: 'warn', message: `${decalOverlaps} overlapping coplanar decal quad pair(s) — decal placement must be rejection-sampled.` })
  }

  if (coplanarPairs > 0) {
    warnings.push({
      severity: 'warn',
      message: `Flicker risk: ${coplanarPairs} near-coplanar overlapping surface pair(s) (< ${MIN_SEPARATION * 1000}mm apart), e.g. ${example}.`,
    })
  } else if (!warnings.some((w) => w.severity === 'warn')) {
    warnings.push({
      severity: 'info',
      message: `Flicker check passed: ${flats.length} flat surfaces separated, depth quantum ${(worstQuantum * 1000).toFixed(2)}mm at far plane, no coplanar decal overlaps.`,
    })
  }
  return warnings
}

/** Count pairs of same-height overlapping decal quads across all decal meshes. */
function countDecalQuadOverlaps(): number {
  const s = useEditor.getState()
  const obj = s.objects['net_decals']
  if (!obj || obj.deleted || !obj.visible) return 0
  const three = getVariant(obj.id, obj.asset)
  if (!three) return 0
  interface Quad { minX: number; maxX: number; minZ: number; maxZ: number; y: number }
  const quads: Quad[] = []
  three.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const pos = mesh.geometry.getAttribute('position')
    for (let q = 0; q + 3 < pos.count; q += 4) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let v = q; v < q + 4; v++) {
        minX = Math.min(minX, pos.getX(v)); maxX = Math.max(maxX, pos.getX(v))
        minZ = Math.min(minZ, pos.getZ(v)); maxZ = Math.max(maxZ, pos.getZ(v))
      }
      quads.push({ minX, maxX, minZ, maxZ, y: pos.getY(q) })
    }
  })
  // grid hash so city-scale decal counts stay cheap
  const CELL = 12
  const grid = new Map<string, number[]>()
  let overlaps = 0
  for (let i = 0; i < quads.length; i++) {
    const a = quads[i]
    const cx = Math.floor((a.minX + a.maxX) / 2 / CELL)
    const cz = Math.floor((a.minZ + a.maxZ) / 2 / CELL)
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const j of grid.get(`${ix},${iz}`) ?? []) {
          const b = quads[j]
          if (Math.abs(a.y - b.y) > 0.001) continue
          if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ) continue
          overlaps++
        }
      }
    }
    const key = `${cx},${cz}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(i)
  }
  return overlaps
}

function segLen(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return l
}

const NON_DRIVABLE = new Set(['footway', 'cycleway', 'pedestrian', 'service'])

export function roadConsistencyLint(): LintWarning[] {
  const warnings: LintWarning[] = []
  // driving-grade checks apply to the drivable network; footpaths may
  // legitimately have steps, steep footbridges and narrow joins
  const segs = [...roadSegments.values()].filter((r) => !NON_DRIVABLE.has(r.roadClass))

  // ---- endpoint buckets for width jumps and near-miss seams
  interface End { id: string; name?: string; cls: string; width: number; p: Vec2 }
  const buckets = new Map<string, End[]>()
  const bucketKey = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.z)}`
  const ends: End[] = []
  for (const r of segs) {
    if (r.points.length < 2) continue
    for (const p of [r.points[0], r.points[r.points.length - 1]]) {
      const e = { id: r.id, name: r.name, cls: r.roadClass, width: r.widthM, p }
      ends.push(e)
      const k = bucketKey(p)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k)!.push(e)
    }
  }

  let widthJumps = 0
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (a.id === b.id || a.cls !== b.cls) continue
        if (a.name && b.name && a.name !== b.name) continue
        const dist = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z)
        if (dist > 0.6) continue
        const ratio = Math.max(a.width, b.width) / Math.min(a.width, b.width)
        if (ratio > 1.6) widthJumps++
      }
    }
  }
  if (widthJumps > 0) {
    warnings.push({
      severity: 'warn',
      message: `${widthJumps} width jump(s) >60% between connected same-class segments — carriageway will visibly step; needs cross-section blending.`,
    })
  }

  // ---- near-miss seams: endpoints 0.15–0.8 m apart that never became a junction
  let seams = 0
  for (const e of ends) {
    for (const dx of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        const k = `${Math.round(e.p.x) + dx},${Math.round(e.p.z) + dz}`
        for (const o of buckets.get(k) ?? []) {
          if (o.id <= e.id) continue
          const d = Math.hypot(e.p.x - o.p.x, e.p.z - o.p.z)
          if (d > 0.15 && d < 0.8) seams++
        }
      }
    }
  }
  if (seams > 0) {
    warnings.push({ severity: 'warn', message: `${seams} near-miss endpoint seam(s) (0.15–0.8 m apart) — surfaces may show gaps at these joints.` })
  }

  // ---- bridges: ramp feasibility + clearance over crossed roads
  let shortBridges = 0
  let lowClearance = 0
  for (const r of segs) {
    if (!r.bridge || r.tunnel) continue
    const elev = Math.max(r.layer, 1) * 6.5
    const L = segLen(r.points)
    if (elev / Math.max(L * 0.45, 1) > 0.1) shortBridges++
    // coarse crossing check: another at-grade drivable road passing near mid-span
    const mid = r.points[Math.floor(r.points.length / 2)]
    for (const o of segs) {
      if (o.id === r.id || o.bridge || o.tunnel) continue
      for (const p of o.points) {
        if (Math.hypot(p.x - mid.x, p.z - mid.z) < (r.widthM + o.widthM) / 2) {
          if (elev < 4.5) lowClearance++
          break
        }
      }
    }
  }
  if (shortBridges > 0) {
    warnings.push({ severity: 'warn', message: `${shortBridges} bridge(s) too short for a ≤10% approach ramp at their layer height — deck grade exceeds driving standard.` })
  }
  if (lowClearance > 0) {
    warnings.push({ severity: 'warn', message: `${lowClearance} bridge(s) with <4.5 m clearance over a crossed road.` })
  }

  if (!warnings.length) {
    warnings.push({ severity: 'info', message: `Road consistency passed: ${segs.length} segments, no elevation/width/seam violations.` })
  }
  return warnings
}
