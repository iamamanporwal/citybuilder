import * as THREE from 'three'
import type { AreaFeature, Vec2 } from '../types'
import { clipRingToRect, mergeGeometries, pointInRing, ringAreaM2, ringIsSimple, wallGeometry, type Rect } from './geometry'

// Rendered land-cover polygons (parks, grass, sand, forest floor) plus the
// terrain/water system. Land is the default base: the ground plane covers the
// whole scene and water exists only where a whitelisted water polygon CARVES a
// real hole in it (ShapeGeometry holes), with the water surface sunk below
// grade and a bank skirt closing the gap. No face of the ground remains under
// carved water, so ground/water can never z-fight. Water rings that cannot be
// carved safely (non-simple after clipping, or overlapping another hole) fall
// back to a painted overlay at the water layer height — separated far beyond
// the depth-buffer quantum (see editor/depthConfig.ts).

// y values follow the linter-enforced layer convention (editor/depthConfig.ts)
const AREA_STYLE: Record<string, { y: number; mat: THREE.MeshStandardMaterial } | undefined> = {
  grass: { y: 0.022, mat: new THREE.MeshStandardMaterial({ color: '#5d7050', roughness: 1 }) },
  park: { y: 0.032, mat: new THREE.MeshStandardMaterial({ color: '#55684a', roughness: 1 }) },
  sand: { y: 0.037, mat: new THREE.MeshStandardMaterial({ color: '#c2b280', roughness: 1 }) },
  forest: { y: 0.042, mat: new THREE.MeshStandardMaterial({ color: '#48583f', roughness: 1 }) },
}

const GROUND_MAT = new THREE.MeshStandardMaterial({ color: '#4d5545', roughness: 1 }) // land: mossy green
const WATER_MAT = new THREE.MeshStandardMaterial({ color: '#39566b', roughness: 0.25, metalness: 0.1 })
const BANK_MAT = new THREE.MeshStandardMaterial({ color: '#6b6353', roughness: 1, side: THREE.DoubleSide })
export const WATER_DEPTH = 0.35 // carved water sits this far below grade
const WATER_PAINT_Y = 0.012 // fallback painted-water layer (depthConfig convention)

/** Non-water land cover (grass, park, sand, forest floor) as flat tinted overlays. */
export function buildAreas(areas: AreaFeature[]): { kind: string; mesh: THREE.Mesh }[] {
  const byKind = new Map<string, THREE.BufferGeometry[]>()
  for (const a of areas) {
    if (!a.render || a.kind === 'water') continue
    const style = AREA_STYLE[a.kind]
    if (!style || a.ring.length < 3) continue
    const geo = flatRingGeometry(a.ring, style.y)
    if (!byKind.has(a.kind)) byKind.set(a.kind, [])
    byKind.get(a.kind)!.push(geo)
  }
  const out: { kind: string; mesh: THREE.Mesh }[] = []
  for (const [kind, geoms] of byKind) {
    const mesh = new THREE.Mesh(mergeGeometries(geoms), AREA_STYLE[kind]!.mat)
    mesh.name =
      kind === 'park' ? 'Parks' : kind === 'grass' ? 'Grass' : kind === 'sand' ? 'Sand & beaches' : 'Forest floor'
    mesh.receiveShadow = true
    out.push({ kind, mesh })
  }
  return out
}

export interface TerrainBuild {
  ground: THREE.Mesh
  water: THREE.Group | null
  carvedCount: number
  paintedCount: number
}

/**
 * Ground plane with water bodies carved out as real holes.
 * Water rings are clipped to the ground rect, validated (simple, non-trivial
 * area) and carved largest-first; a ring whose bbox overlaps an already carved
 * hole is painted instead (earcut cannot triangulate intersecting holes).
 */
export function buildTerrain(waterAreas: AreaFeature[], bounds: Rect): TerrainBuild {
  interface Candidate { ring: Vec2[]; area: number }
  const candidates: Candidate[] = []
  let painted = 0
  const paintGeoms: THREE.BufferGeometry[] = []
  const paint = (ring: Vec2[]) => {
    paintGeoms.push(flatRingGeometry(ring, WATER_PAINT_Y))
    painted++
  }

  for (const a of waterAreas) {
    if (!a.render || a.kind !== 'water' || a.ring.length < 3) continue
    const clipped = clipRingToRect(a.ring, bounds)
    if (clipped.length < 3) continue
    if (!ringIsSimple(clipped)) {
      // folded ribbon (hairpin river) — same-material overlay is safe to paint
      paint(clipped)
      continue
    }
    const area = ringAreaM2(clipped)
    if (area < 1) continue
    candidates.push({ ring: clipped, area })
  }

  candidates.sort((c1, c2) => c2.area - c1.area)
  const holes: Candidate[] = []
  for (const c of candidates) {
    const bb = ringBBox(c.ring)
    const clash = holes.some((h) => {
      const hb = ringBBox(h.ring)
      return bb.minX < hb.maxX && hb.minX < bb.maxX && bb.minZ < hb.maxZ && hb.minZ < bb.maxZ
    })
    if (clash) paint(c.ring)
    else holes.push(c)
  }

  // ---- ground: rect shape minus carved holes (shape space: (x, -z))
  const groundShape = new THREE.Shape([
    new THREE.Vector2(bounds.minX, -bounds.minZ),
    new THREE.Vector2(bounds.maxX, -bounds.minZ),
    new THREE.Vector2(bounds.maxX, -bounds.maxZ),
    new THREE.Vector2(bounds.minX, -bounds.maxZ),
  ])
  for (const h of holes) {
    groundShape.holes.push(new THREE.Path(h.ring.map((p) => new THREE.Vector2(p.x, -p.z))))
  }
  const groundGeo = new THREE.ShapeGeometry(groundShape)
  groundGeo.rotateX(-Math.PI / 2)
  const ground = new THREE.Mesh(indexed(groundGeo), GROUND_MAT)
  ground.receiveShadow = true
  ground.name = 'Ground'

  // ---- water: sunken surfaces filling the holes + bank skirts to grade
  const waterGeoms: THREE.BufferGeometry[] = []
  const bankGeoms: THREE.BufferGeometry[] = []
  for (const h of holes) {
    waterGeoms.push(flatRingGeometry(h.ring, -WATER_DEPTH))
    const closed = [...h.ring, h.ring[0]]
    bankGeoms.push(wallGeometry(closed, 0, -WATER_DEPTH))
  }

  let water: THREE.Group | null = null
  if (waterGeoms.length || paintGeoms.length) {
    water = new THREE.Group()
    water.name = 'Water'
    if (waterGeoms.length) {
      const m = new THREE.Mesh(mergeGeometries(waterGeoms), WATER_MAT)
      m.receiveShadow = true
      water.add(m)
    }
    if (bankGeoms.length) water.add(new THREE.Mesh(mergeGeometries(bankGeoms), BANK_MAT))
    if (paintGeoms.length) {
      const m = new THREE.Mesh(mergeGeometries(paintGeoms), WATER_MAT)
      m.receiveShadow = true
      water.add(m)
    }
  }
  return { ground, water, carvedCount: holes.length, paintedCount: painted }
}

/** True when point p lies over carved or painted water of these areas. */
export function isWaterAt(p: Vec2, waterAreas: AreaFeature[]): boolean {
  return waterAreas.some((a) => a.kind === 'water' && a.render && pointInRing(p, a.ring))
}

function ringBBox(ring: Vec2[]): Rect {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  return { minX, maxX, minZ, maxZ }
}

function flatRingGeometry(ring: Vec2[], y: number): THREE.BufferGeometry {
  const pts = ring.map((p) => new THREE.Vector2(p.x, -p.z))
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse()
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts))
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y, 0)
  return indexed(geo)
}

function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getIndex()) return g
  const count = g.getAttribute('position').count
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}
