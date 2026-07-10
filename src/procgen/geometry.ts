import * as THREE from 'three'
import type { Vec2 } from '../types'

// Polyline/ribbon helpers for road generation. All in XZ plane, Y up.

export function offsetPolyline(pts: Vec2[], offset: number): Vec2[] {
  const n = pts.length
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    let dpx = 0
    let dpz = 0
    let dnx = 0
    let dnz = 0
    let hasPrev = false
    let hasNext = false
    if (i > 0) {
      dpx = p.x - pts[i - 1].x
      dpz = p.z - pts[i - 1].z
      const l = Math.hypot(dpx, dpz) || 1
      dpx /= l
      dpz /= l
      hasPrev = true
    }
    if (i < n - 1) {
      dnx = pts[i + 1].x - p.x
      dnz = pts[i + 1].z - p.z
      const l = Math.hypot(dnx, dnz) || 1
      dnx /= l
      dnz /= l
      hasNext = true
    }
    let dx = (hasPrev ? dpx : dnx) + (hasNext ? dnx : dpx)
    let dz = (hasPrev ? dpz : dnz) + (hasNext ? dnz : dpz)
    const dl = Math.hypot(dx, dz) || 1
    dx /= dl
    dz /= dl
    // normal (left of direction)
    const nx = dz
    const nz = -dx
    // miter scale, clamped to avoid spikes at sharp corners
    let scale = 1
    if (hasPrev && hasNext) {
      const dot = Math.max(-1, Math.min(1, dpx * dnx + dpz * dnz))
      const cosHalf = Math.sqrt((1 + dot) / 2)
      scale = Math.min(1 / Math.max(cosHalf, 0.45), 2.2)
    }
    out.push({ x: p.x + nx * offset * scale, z: p.z + nz * offset * scale })
  }
  // collapse fold-overs: where |offset| exceeds the local curvature radius the
  // offset polyline reverses direction and the ribbon folds onto itself —
  // exactly coplanar self-overlap that z-fights and wrecks vertex normals.
  // A reversed offset segment (opposing its reference segment) is collapsed to
  // a zero-length step, which meshes as degenerate, invisible triangles.
  for (let i = 1; i < n; i++) {
    const rx = pts[i].x - pts[i - 1].x
    const rz = pts[i].z - pts[i - 1].z
    const ox = out[i].x - out[i - 1].x
    const oz = out[i].z - out[i - 1].z
    if (rx * ox + rz * oz < 0) out[i] = { ...out[i - 1] }
  }
  return out
}

/** Ribbon between two edge polylines. y: constant height or per-point profile. UVs in meters. */
export function ribbonGeometry(left: Vec2[], right: Vec2[], y: number | number[]): THREE.BufferGeometry {
  const n = Math.min(left.length, right.length)
  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  let dist = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += Math.hypot(left[i].x - left[i - 1].x, left[i].z - left[i - 1].z)
    const yi = typeof y === 'number' ? y : y[Math.min(i, y.length - 1)]
    const w = Math.hypot(right[i].x - left[i].x, right[i].z - left[i].z)
    positions.set([left[i].x, yi, left[i].z], i * 6)
    positions.set([right[i].x, yi, right[i].z], i * 6 + 3)
    uvs.set([0, dist], i * 4)
    uvs.set([w, dist], i * 4 + 2)
  }
  const indices: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(indices)
  if (typeof y === 'number') {
    // constant-height ribbon: exact up normals. computeVertexNormals averages
    // over collapsed/degenerate strips and shades folds dark; the true normal
    // of a flat ribbon is known analytically.
    const normals = new Float32Array(n * 2 * 3)
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  } else {
    g.computeVertexNormals()
  }
  return g
}

/**
 * World-planar XZ UVs in meters. Overlapping coplanar surfaces that share a
 * material then sample identical texels at identical world points, so whichever
 * triangle wins the depth tie paints the same color — overdraw is idempotent
 * and z-fighting cannot show. Used for surfaces whose members may overlap at
 * one layer height (junction discs, sidewalk tops at corners/parallel arms).
 */
export function planarUvXZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i)
    uv[i * 2 + 1] = -p.getZ(i)
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** Raised slab ribbon (top face at height h + vertical skirts down to 0 on both edges). */
export function raisedRibbonGeometry(left: Vec2[], right: Vec2[], h: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // top face gets world-planar UVs: sidewalk slabs from different arms overlap
  // at corners and along dual carriageways at the same curb height
  parts.push(planarUvXZ(ribbonGeometry(left, right, h)))
  parts.push(wallGeometry(left, h, 0))
  parts.push(wallGeometry(right, 0, h)) // reversed winding via height order
  return mergeGeometries(parts)
}

/** Vertical wall along a polyline from y0 to y1 (constants or per-point profiles). */
export function wallGeometry(
  pts: Vec2[],
  y0: number | number[],
  y1: number | number[],
): THREE.BufferGeometry {
  const n = pts.length
  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  let dist = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
    const a = typeof y0 === 'number' ? y0 : y0[Math.min(i, y0.length - 1)]
    const b = typeof y1 === 'number' ? y1 : y1[Math.min(i, y1.length - 1)]
    positions.set([pts[i].x, a, pts[i].z], i * 6)
    positions.set([pts[i].x, b, pts[i].z], i * 6 + 3)
    uvs.set([dist, 0], i * 4)
    uvs.set([dist, Math.abs(b - a)], i * 4 + 2)
  }
  const indices: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

/** Minimal geometry merge (positions/uv/index only) to avoid pulling in examples/jsm utils. */
export function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vtx = 0
  let idx = 0
  const hasUv = geoms.every((g) => g.getAttribute('uv'))
  for (const g of geoms) {
    vtx += g.getAttribute('position').count
    idx += g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count
  }
  const positions = new Float32Array(vtx * 3)
  const normals = new Float32Array(vtx * 3)
  const uvs = hasUv ? new Float32Array(vtx * 2) : null
  const indices = vtx > 65000 ? new Uint32Array(idx) : new Uint16Array(idx)
  let vo = 0
  let io = 0
  for (const g of geoms) {
    const p = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    positions.set(p.array as Float32Array, vo * 3)
    if (nrm) normals.set(nrm.array as Float32Array, vo * 3)
    if (uvs) uvs.set(g.getAttribute('uv').array as Float32Array, vo * 2)
    const gi = g.getIndex()
    if (gi) {
      for (let i = 0; i < gi.count; i++) indices[io + i] = gi.getX(i) + vo
      io += gi.count
    } else {
      for (let i = 0; i < p.count; i++) indices[io + i] = i + vo
      io += p.count
    }
    vo += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  out.setIndex(new THREE.BufferAttribute(indices, 1))
  return out
}

/**
 * Continuous reference line (OpenDRIVE-style): fit a centripetal Catmull-Rom
 * through the OSM polyline and resample at even arc-length spacing. Endpoints
 * are preserved exactly so junction topology is untouched. A server-side
 * osm2opendrive → libOpenDRIVE path can replace this evaluator without
 * touching downstream corridor meshing.
 */
export function smoothPolyline(pts: Vec2[], spacing = 4): Vec2[] {
  if (pts.length < 3) return pts
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  if (len < 14) return pts
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p.x, 0, p.z)),
    false,
    'centripetal',
  )
  const n = Math.max(3, Math.ceil(len / spacing))
  return curve.getSpacedPoints(n).map((v) => ({ x: v.x, z: v.z }))
}

export function polylineLength(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return l
}

export function pointAlong(pts: Vec2[], dist: number): { p: Vec2; dir: Vec2 } {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
    if (acc + seg >= dist && seg > 0) {
      const t = (dist - acc) / seg
      return {
        p: { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t },
        dir: { x: (pts[i].x - pts[i - 1].x) / seg, z: (pts[i].z - pts[i - 1].z) / seg },
      }
    }
    acc += seg
  }
  const n = pts.length
  const dx = pts[n - 1].x - pts[n - 2].x
  const dz = pts[n - 1].z - pts[n - 2].z
  const l = Math.hypot(dx, dz) || 1
  return { p: pts[n - 1], dir: { x: dx / l, z: dz / l } }
}

/** Cut a polyline shorter by trimStart/trimEnd meters (returns null if too short). */
export function trimPolyline(pts: Vec2[], trimStart: number, trimEnd: number): Vec2[] | null {
  const total = polylineLength(pts)
  if (total <= trimStart + trimEnd + 0.5) return null
  const start = pointAlong(pts, trimStart)
  const end = pointAlong(pts, total - trimEnd)
  const cum = [0]
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
  const mid = pts.filter((_, i) => cum[i] > trimStart && cum[i] < total - trimEnd)
  const out = [start.p, ...mid, end.p]
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z) > 0.05)
}

/** Signed shoelace area (m²) of a ring in the XZ plane. Positive = counterclockwise in (x, -z). */
export function ringAreaM2(ring: Vec2[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].z - ring[i].x * ring[j].z
  }
  return Math.abs(a / 2)
}

/** True when no two non-adjacent edges of the (implicitly closed) ring cross. O(n²). */
export function ringIsSimple(ring: Vec2[]): boolean {
  const n = ring.length
  if (n < 3) return false
  const at = (i: number) => ring[i % n]
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // closing edge is adjacent to the first
      const a = at(i), b = at(i + 1), c = at(j), d = at(j + 1)
      const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x)
      if (Math.abs(den) < 1e-12) continue
      const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den
      const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return false
    }
  }
  return true
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export interface Rect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Sutherland–Hodgman clip of a ring against an axis-aligned rect. */
export function clipRingToRect(ring: Vec2[], rect: Rect): Vec2[] {
  const edges: ((p: Vec2) => number)[] = [
    (p) => p.x - rect.minX,
    (p) => rect.maxX - p.x,
    (p) => p.z - rect.minZ,
    (p) => rect.maxZ - p.z,
  ]
  let poly = ring
  for (const side of edges) {
    const out: Vec2[] = []
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i]
      const prev = poly[(i + poly.length - 1) % poly.length]
      const dc = side(cur)
      const dp = side(prev)
      if (dc >= 0) {
        if (dp < 0) {
          const t = dp / (dp - dc)
          out.push({ x: prev.x + (cur.x - prev.x) * t, z: prev.z + (cur.z - prev.z) * t })
        }
        out.push(cur)
      } else if (dp >= 0) {
        const t = dp / (dp - dc)
        out.push({ x: prev.x + (cur.x - prev.x) * t, z: prev.z + (cur.z - prev.z) * t })
      }
    }
    poly = out
    if (poly.length < 3) return []
  }
  return poly
}

export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
