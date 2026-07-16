import * as THREE from 'three'
import type { RoadSegment, Vec2 } from '../types'
import { mergeGeometries, offsetPolyline, pointAlong, polylineLength, ribbonGeometry, wallGeometry } from './geometry'

// Procedural suspension-bridge superstructure. The plain deck slab a bridge
// gets by default is unrecognizable; a landmark like the Golden Gate needs its
// silhouette — two towers, a sagging main cable per side (catenary), vertical
// suspenders, and a coloured stiffening girder. This is deterministic and
// scaled to the span. See scene/landmarks.ts for which bridges opt in and their
// colour (the Golden Gate paints in International Orange).

export interface SuspensionSpec {
  color: string
  deckY: number // nominal deck height (local ENU metres)
}

export interface LandmarkBridge {
  id: string
  name: string
  wikidata?: string
  sketchfabQuery?: string
  structure: string // 'suspension' | 'stone-arch' — for inspector/semantics
  centerLat: number
  centerLng: number
  group: THREE.Group
}

export interface ArchSpec {
  color: string
  deckY: number // nominal deck height (local ENU metres)
  waterY?: number // level the piers/arches spring from (default 0 = grade)
  towers?: boolean // gothic gate towers at each end (Charles Bridge silhouette)
}

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)

/** Chain multiple contiguous bridge segments into one ordered centerline. */
export function chainCenterlines(segs: RoadSegment[]): Vec2[] {
  if (segs.length === 1) return segs[0].points
  const remaining = segs.map((s) => [...s.points])
  let chain = remaining.shift()!
  const TOL = 45
  let progress = true
  while (remaining.length && progress) {
    progress = false
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      const head = chain[0]
      const tail = chain[chain.length - 1]
      if (d2(tail, c[0]) < TOL) { chain = chain.concat(c.slice(1)); remaining.splice(i, 1); progress = true; break }
      if (d2(tail, c[c.length - 1]) < TOL) { chain = chain.concat(c.slice(0, -1).reverse()); remaining.splice(i, 1); progress = true; break }
      if (d2(head, c[c.length - 1]) < TOL) { chain = c.slice(0, -1).concat(chain); remaining.splice(i, 1); progress = true; break }
      if (d2(head, c[0]) < TOL) { chain = c.slice(1).reverse().concat(chain); remaining.splice(i, 1); progress = true; break }
    }
  }
  return chain
}

interface Cross { p: Vec2; dir: Vec2; left: Vec2; right: Vec2 }
function crossAt(pts: Vec2[], d: number, half: number): Cross {
  const { p, dir } = pointAlong(pts, d)
  const nx = -dir.z
  const nz = dir.x
  return { p, dir, left: { x: p.x + nx * half, z: p.z + nz * half }, right: { x: p.x - nx * half, z: p.z - nz * half } }
}

function boxAt(x: number, y: number, z: number, w: number, h: number, dep: number, yaw: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, dep)
  if (yaw) g.rotateY(yaw)
  g.translate(x, y, z)
  return g
}

function toIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getIndex()) return g
  const count = g.getAttribute('position').count
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

/**
 * Build a suspension bridge group along `centerline`. Returns null if the span
 * is too short to be a suspension bridge. One merged mesh per material.
 */
export function buildSuspensionBridge(centerline: Vec2[], widthM: number, spec: SuspensionSpec): THREE.Group | null {
  const pts = centerline
  if (pts.length < 2) return null
  const L = polylineLength(pts)
  if (L < 45) return null
  const half = Math.max(widthM / 2, 4)
  const deckY = spec.deckY
  const towerH = Math.min(Math.max(L * 0.16, 24), 130)

  const struct: THREE.BufferGeometry[] = [] // towers + deck girder (matte)
  const cables: THREE.BufferGeometry[] = [] // main cables + suspenders

  // ---- towers at 30% and 70% of the span
  const towerD = [0.3 * L, 0.7 * L]
  const towerTops: { left: THREE.Vector3; right: THREE.Vector3 }[] = []
  for (const d of towerD) {
    const c = crossAt(pts, d, half)
    const yaw = Math.atan2(c.dir.x, c.dir.z)
    const legW = Math.max(2, half * 0.16)
    struct.push(boxAt(c.left.x, deckY + towerH / 2 - 1, c.left.z, legW, towerH, legW, yaw))
    struct.push(boxAt(c.right.x, deckY + towerH / 2 - 1, c.right.z, legW, towerH, legW, yaw))
    // cross braces high on the towers (the recognizable "double portal" look)
    for (const frac of [0.62, 0.92]) {
      struct.push(boxAt(c.p.x, deckY + towerH * frac, c.p.z, half * 2.1, legW * 0.9, legW * 0.8, yaw + Math.PI / 2))
    }
    towerTops.push({
      left: new THREE.Vector3(c.left.x, deckY + towerH, c.left.z),
      right: new THREE.Vector3(c.right.x, deckY + towerH, c.right.z),
    })
  }

  // ---- main cable per side: anchorage → tower1 → parabolic sag → tower2 → anchorage
  const sag = towerH * 0.86
  const buildCable = (side: 'left' | 'right') => {
    const edgeAt = (d: number): Vec2 => {
      const c = crossAt(pts, d, half)
      return side === 'left' ? c.left : c.right
    }
    const t1 = side === 'left' ? towerTops[0].left : towerTops[0].right
    const t2 = side === 'left' ? towerTops[1].left : towerTops[1].right
    const startA = edgeAt(2)
    const endA = edgeAt(Math.max(L - 2, 2))
    const path: THREE.Vector3[] = [new THREE.Vector3(startA.x, deckY + 1, startA.z), t1.clone()]
    const steps = Math.max(6, Math.round((towerD[1] - towerD[0]) / 18))
    for (let s = 1; s < steps; s++) {
      const tt = s / steps
      const d = towerD[0] + (towerD[1] - towerD[0]) * tt
      const pos = edgeAt(d)
      const y = deckY + towerH - sag * (1 - Math.pow(2 * tt - 1, 2))
      path.push(new THREE.Vector3(pos.x, y, pos.z))
    }
    path.push(t2.clone(), new THREE.Vector3(endA.x, deckY + 1, endA.z))
    const curve = new THREE.CatmullRomCurve3(path, false, 'catmullrom', 0.2)
    cables.push(new THREE.TubeGeometry(curve, Math.max(24, path.length * 3), Math.max(0.35, half * 0.045), 5, false))
  }
  buildCable('left')
  buildCable('right')

  // ---- vertical suspenders between the towers
  for (let d = towerD[0] + 16; d < towerD[1]; d += 16) {
    const tt = (d - towerD[0]) / (towerD[1] - towerD[0])
    const cableY = deckY + towerH - sag * (1 - Math.pow(2 * tt - 1, 2))
    const c = crossAt(pts, d, half)
    for (const edge of [c.left, c.right]) {
      const h = Math.max(cableY - (deckY + 1.2), 0.5)
      const cyl = new THREE.CylinderGeometry(0.18, 0.18, h, 5)
      cyl.translate(edge.x, deckY + 1.2 + h / 2, edge.z)
      cables.push(cyl)
    }
  }

  // ---- coloured stiffening girder + railing along both deck edges
  const samples = Math.max(2, Math.ceil(L / 6))
  const leftEdge: Vec2[] = []
  const rightEdge: Vec2[] = []
  for (let i = 0; i <= samples; i++) {
    const c = crossAt(pts, (i / samples) * L, half)
    leftEdge.push(c.left)
    rightEdge.push(c.right)
  }
  struct.push(wallGeometry(leftEdge, deckY - 1.6, deckY + 1.2))
  struct.push(wallGeometry(rightEdge, deckY + 1.2, deckY - 1.6))

  const group = new THREE.Group()
  const structMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6, metalness: 0.2 })
  const cableMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.45, metalness: 0.35 })
  if (struct.length) group.add(new THREE.Mesh(mergeGeometries(struct.map(toIndexed)), structMat))
  if (cables.length) group.add(new THREE.Mesh(mergeGeometries(cables.map(toIndexed)), cableMat))
  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true })
  return group.children.length ? group : null
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Vertical triangular prism from footprint (a,b,c) extruded y0→y1. Cutwater/starling. */
function extrudeTri(a: Vec2, b: Vec2, c: Vec2, y0: number, y1: number): THREE.BufferGeometry {
  const pos = [
    a.x, y0, a.z, b.x, y0, b.z, c.x, y0, c.z, // bottom
    a.x, y1, a.z, b.x, y1, b.z, c.x, y1, c.z, // top
  ]
  const idx = [
    0, 2, 1, 3, 4, 5, // bottom (cw), top (ccw)
    0, 1, 4, 0, 4, 3, // side a-b
    1, 2, 5, 1, 5, 4, // side b-c
    2, 0, 3, 2, 3, 5, // side c-a
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Build a masonry stone-arch bridge along `centerline` (Charles Bridge and kin).
 * Segmental arches spring from piers that stand in the river, a solid stone
 * parapet runs the deck edges, pointed cutwaters break the current at each pier,
 * and (optionally) gothic gate towers mark each end — the recognizable silhouette
 * a plain elevated slab can't give. Deterministic, scaled to the span. One merged
 * mesh per material. Returns null for spans too short to be an arch bridge.
 */
export function buildArchBridge(centerline: Vec2[], widthM: number, spec: ArchSpec): THREE.Group | null {
  const pts = centerline
  if (pts.length < 2) return null
  const L = polylineLength(pts)
  if (L < 40) return null

  const half = Math.max(widthM / 2, 2.5)
  const deckY = spec.deckY
  const waterY = spec.waterY ?? 0
  const parapetH = 1.05
  const deckThk = 0.7
  const crown = deckY - deckThk // arch crowns meet the deck soffit

  const nSpans = clamp(Math.round(L / 28), 3, 20)
  const spanPitch = L / nSpans
  const pierHalf = clamp(spanPitch * 0.13, 1.4, 3.2) // half pier thickness along the deck
  const openHalf = Math.max(spanPitch / 2 - pierHalf, 2)
  // segmental (shallow) arch: rise bounded so piers keep some height above water
  const rise = clamp(openHalf * 0.72, 1.5, crown - waterY - 1.6)
  const springY = crown - rise
  const archRad = (openHalf * openHalf + rise * rise) / (2 * rise)
  const circleCY = crown - archRad

  const bottomYAt = (s: number): number => {
    for (let k = 0; k <= nSpans; k++) {
      if (Math.abs(s - k * spanPitch) <= pierHalf) return waterY // pier / abutment to water
    }
    const k = Math.min(Math.floor(s / spanPitch), nSpans - 1)
    const local = s - (k + 0.5) * spanPitch
    if (Math.abs(local) >= openHalf) return springY
    return circleCY + Math.sqrt(Math.max(archRad * archRad - local * local, 0))
  }

  // stations: fine uniform grid + sharp pier-edge pairs so the wall drops crisply
  const stationSet = new Set<number>()
  const add = (s: number) => stationSet.add(clamp(s, 0, L))
  for (let s = 0; s <= L; s += 1.5) add(s)
  add(L)
  for (let k = 0; k <= nSpans; k++) {
    const c = k * spanPitch
    add(c - pierHalf - 0.02); add(c - pierHalf + 0.02)
    add(c + pierHalf - 0.02); add(c + pierHalf + 0.02)
  }
  const S = [...stationSet].sort((a, b) => a - b)

  const leftEdge: Vec2[] = []
  const rightEdge: Vec2[] = []
  const bottomY: number[] = []
  const topY: number[] = []
  for (const s of S) {
    const c = crossAt(pts, s, half)
    leftEdge.push(c.left)
    rightEdge.push(c.right)
    bottomY.push(bottomYAt(s))
    topY.push(deckY + parapetH)
  }

  const stone: THREE.BufferGeometry[] = []
  // side spandrel walls (arch-profile bottom, solid parapet on top) on both edges
  stone.push(wallGeometry(leftEdge, bottomY, topY))
  stone.push(wallGeometry(rightEdge, topY, bottomY)) // reversed winding faces out
  // deck walking surface + soffit slab that closes the underside between arches
  stone.push(ribbonGeometry(leftEdge, rightEdge, deckY))
  stone.push(ribbonGeometry(rightEdge, leftEdge, bottomY.map(() => crown)))

  // barrel soffits: one curved underside per opening (follows the arch curve)
  for (let k = 0; k < nSpans; k++) {
    const lo = k * spanPitch + pierHalf
    const hi = (k + 1) * spanPitch - pierHalf
    const li: number[] = []
    for (let i = 0; i < S.length; i++) if (S[i] >= lo - 0.03 && S[i] <= hi + 0.03) li.push(i)
    if (li.length < 2) continue
    const l = li.map((i) => leftEdge[i])
    const r = li.map((i) => rightEdge[i])
    const y = li.map((i) => bottomY[i])
    stone.push(ribbonGeometry(l, r, y))
  }

  // solid piers into the water + pointed cutwaters (starlings) on both sides
  for (let k = 1; k < nSpans; k++) {
    const s = k * spanPitch
    const c = crossAt(pts, s, half)
    const yaw = Math.atan2(c.dir.x, c.dir.z)
    stone.push(boxAt(c.p.x, (waterY + springY) / 2, c.p.z, 2 * half + 0.4, springY - waterY, 2 * pierHalf, yaw))
    const nx = -c.dir.z, nz = c.dir.x // lateral (deck normal)
    const along = c.dir
    const cwLen = pierHalf * 1.6
    for (const side of [1, -1]) {
      const baseC = { x: c.p.x + nx * side * half, z: c.p.z + nz * side * half }
      const b0 = { x: baseC.x + along.x * pierHalf, z: baseC.z + along.z * pierHalf }
      const b1 = { x: baseC.x - along.x * pierHalf, z: baseC.z - along.z * pierHalf }
      const apex = { x: baseC.x + nx * side * cwLen, z: baseC.z + nz * side * cwLen }
      stone.push(extrudeTri(b0, b1, apex, waterY, springY + 0.2))
    }
  }

  const group = new THREE.Group()
  const stoneMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
  group.add(new THREE.Mesh(mergeGeometries(stone.map(toIndexed)), stoneMat))

  // ---- gothic gate towers at each end (the Old Town / Malá Strana silhouette)
  if (spec.towers) {
    const towers: THREE.BufferGeometry[] = []
    const gateH = 5.5
    const bodyH = 13
    const coneH = 7
    const depth = Math.min(8, L * 0.12)
    const legW = Math.max(2, half * 0.35)
    const towerHalf = half + 1
    for (const s of [Math.min(9, L * 0.05), Math.max(L - 9, L * 0.95)]) {
      const c = crossAt(pts, s, towerHalf)
      const yaw = Math.atan2(c.dir.x, c.dir.z)
      // two gate legs so the deck passes through the arch, a body block above, a spire
      towers.push(boxAt(c.left.x, deckY + gateH / 2, c.left.z, legW, gateH, depth, yaw))
      towers.push(boxAt(c.right.x, deckY + gateH / 2, c.right.z, legW, gateH, depth, yaw))
      towers.push(boxAt(c.p.x, deckY + gateH + bodyH / 2, c.p.z, towerHalf * 2 + 0.6, bodyH, depth + 0.6, yaw))
      const spire = new THREE.ConeGeometry(towerHalf * 1.15, coneH, 4)
      spire.rotateY(Math.PI / 4 + yaw)
      spire.translate(c.p.x, deckY + gateH + bodyH + coneH / 2, c.p.z)
      towers.push(spire)
    }
    const towerMat = new THREE.MeshStandardMaterial({ color: '#8f8069', roughness: 0.9, metalness: 0 })
    group.add(new THREE.Mesh(mergeGeometries(towers.map(toIndexed)), towerMat))
  }

  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true })
  return group.children.length ? group : null
}
