#!/usr/bin/env tsx
/**
 * EXPERIMENT — modular "framed road" asset kit → standalone GLBs.
 *
 * The idea (from the reference brief): a road is an asphalt carriageway wrapped in
 * a raised CONCRETE FRAME (the curb) that hugs the road edge, and that frame is
 * EXTENDED outward into a footpath/pathway. The raised curb face + the light curb
 * strip read as a clean border; the footpath slab beyond it makes the whole thing
 * look like a finished street — especially at junctions, where the frame wraps the
 * corners and the road mouths stay open.
 *
 * This is an ASSET-LIBRARY experiment, not the OSM corridor path. Fixed-width GLB
 * tiles can't conform to arbitrary OSM widths/curves (that's why production roads
 * are procedural — see docs/modular-road-asset-system.md §1). But for a curated
 * kit of hand-authored pieces, parametric GLBs are exactly right. We reuse the
 * repo's own geometry primitives + real baked PBR textures + the headless
 * three.js→GLB path, so these assets carry the same material quality as the app.
 *
 * Output: experiment-roads/<tile>.glb  (+ _kit.glb overview + viewer.html)
 *
 * Usage:  npx tsx tools/experiment-roads.ts
 */

import '../src/headless/shims' // MUST be first: materials draw canvas textures at import time
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Vec2 } from '../src/types'
import {
  offsetPolyline,
  ribbonGeometry,
  wallGeometry,
  mergeGeometries,
  planarUvXZ,
  smoothPolyline,
  polylineLength,
  trimPolyline,
} from '../src/procgen/geometry'
import { roadMaterial, sidewalkMaterial } from '../src/materials/library'

// ----------------------------------------------------------------------------
// Cross-section — the single source of truth for the "framed road" look.
// All values are local ENU metres, Y-up, XZ ground plane (repo convention).
// ----------------------------------------------------------------------------

const SEC = {
  laneW: 3.4, // one lane
  lanes: 2, // 2-lane carriageway
  curbW: 0.5, // width of the raised curb strip (the bright "frame" band)
  pathW: 2.4, // footpath width beyond the curb
  curbH: 0.16, // curb top height above the asphalt (the frame's lift)
  yRoad: 0.02, // asphalt top
  yMark: 0.032, // paint, a hair above asphalt
}
const HALF = (SEC.laneW * SEC.lanes) / 2 // carriageway half-width, to inner curb face
const FRAME = HALF + SEC.curbW // to outer curb strip / inner footpath
const OUTER = HALF + SEC.curbW + SEC.pathW // to outer footpath edge

// ----------------------------------------------------------------------------
// Materials.  Reuse the app's real baked PBR where it helps (asphalt aggregate,
// concrete slab footpath); a dedicated smooth light concrete for the curb frame
// so it reads distinct from the slab footpath — like the reference image.
// GLTFExporter serialises the base PBR (maps/roughness/metalness); the runtime
// onBeforeCompile shaders are intentionally not baked (clean PBR for the engine).
// ----------------------------------------------------------------------------

const asphaltMat = roadMaterial('asphalt-new')
asphaltMat.name = 'asphalt'

const footpathMat = sidewalkMaterial
footpathMat.name = 'footpath_concrete_slab'

const curbMat = new THREE.MeshStandardMaterial({ color: '#cfccc2', roughness: 0.85, metalness: 0 })
curbMat.name = 'curb_concrete'

const markMat = new THREE.MeshStandardMaterial({ color: '#eeece4', roughness: 0.7, metalness: 0 })
markMat.name = 'lane_paint'

const crosswalkMat = markMat

// Preview/asset kit: render both faces so triangle winding can never hide a
// surface in whatever viewer/engine loads the GLB. GLTFExporter preserves this
// as glTF `doubleSided`. (These are throwaway process-local material refs.)
for (const m of [asphaltMat, footpathMat, curbMat, markMat]) m.side = THREE.DoubleSide

// ----------------------------------------------------------------------------
// Small geometry helpers layered on the repo primitives.
// ----------------------------------------------------------------------------

/** Flat quad (up-normal) from 4 CCW-ish corners at height y, world-planar UVs. */
function quad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, y: number): THREE.BufferGeometry {
  const pos = new Float32Array([a.x, y, a.z, b.x, y, b.z, c.x, y, c.z, d.x, y, d.z])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  const n = new Float32Array(12)
  for (let i = 1; i < 12; i += 3) n[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
  return planarUvXZ(g)
}

/** Triangulate a simple (CCW-or-CW) ring into a flat up-facing face at height y. */
function fillRing(ring: Vec2[], y: number): THREE.BufferGeometry | null {
  const pts = ring.map((p) => new THREE.Vector2(p.x, p.z))
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop()
  if (pts.length < 3) return null
  let faces: number[][]
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts, [])
  } catch {
    return null
  }
  if (!faces.length) return null
  const pos = new Float32Array(pts.length * 3)
  pts.forEach((p, i) => pos.set([p.x, y, p.y], i * 3))
  const idx: number[] = []
  for (const f of faces) idx.push(f[0], f[1], f[2])
  // wind up-facing (+Y) like every flat road layer
  const a = pts[idx[0]], b = pts[idx[1]], c = pts[idx[2]]
  if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  const n = new Float32Array(pts.length * 3)
  for (let i = 1; i < n.length; i += 3) n[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
  return planarUvXZ(g)
}

/** Accumulate geometry per material, merge once at the end → few draw calls. */
class MeshBuilder {
  private byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
  add(mat: THREE.Material, ...geoms: (THREE.BufferGeometry | null)[]) {
    const arr = this.byMat.get(mat) ?? []
    for (const g of geoms) if (g) arr.push(g)
    this.byMat.set(mat, arr)
  }
  toGroup(name: string): THREE.Group {
    const grp = new THREE.Group()
    grp.name = name
    for (const [mat, geoms] of this.byMat) {
      if (!geoms.length) continue
      const merged = geoms.length > 1 ? mergeGeometries(geoms) : geoms[0]
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = `${name}_${mat.name || 'mat'}`
      grp.add(mesh)
    }
    return grp
  }
}

// ----------------------------------------------------------------------------
// Corridor — the framed cross-section swept along a centreline.
//   asphalt carriageway | raised curb strip | footpath | outer skirt
// `capStart`/`capEnd` close the curb+footpath across the ends (dead-ends), else
// the ends stay open so tiles butt together.
// ----------------------------------------------------------------------------

interface CorridorOpts {
  centerSmooth?: boolean
  smoothSpacing?: number // Catmull-Rom resample spacing (smaller = smoother curves)
  centerline?: boolean // dashed centre paint
  laneEdges?: boolean // solid edge lines against the curb
  sides?: 'both' | 'left' | 'right'
}

/**
 * Build the framed corridor from the RAW centreline. We derive every lateral band
 * by offsetting the centreline directly (offsetPolyline offsets left for +off), so
 * left side uses +off and right side uses -off — no sign ambiguity.
 */
function buildCorridor(mb: MeshBuilder, rawCenter: Vec2[], opts: CorridorOpts = {}) {
  const center = opts.centerSmooth === false ? rawCenter : smoothPolyline(rawCenter, opts.smoothSpacing ?? 3)
  const sides = opts.sides ?? 'both'

  const edgeL = offsetPolyline(center, +HALF)
  const edgeR = offsetPolyline(center, -HALF)

  // Carriageway asphalt
  mb.add(asphaltMat, ribbonGeometry(edgeL, edgeR, SEC.yRoad))

  const doSide = (s: 1 | -1) => {
    const inner = offsetPolyline(center, s * HALF) // curb face (bottom) at asphalt edge
    const frame = offsetPolyline(center, s * FRAME) // curb strip / footpath seam
    const outer = offsetPolyline(center, s * OUTER) // outer footpath edge

    // Curb inner face (the vertical "frame" wall rising off the asphalt)
    mb.add(curbMat, wallGeometry(inner, SEC.yRoad, SEC.curbH))
    // Curb top strip (bright smooth concrete band)
    mb.add(curbMat, s > 0 ? ribbonGeometry(inner, frame, SEC.curbH) : ribbonGeometry(frame, inner, SEC.curbH))
    // Footpath top (concrete slabs)
    mb.add(footpathMat, s > 0 ? ribbonGeometry(frame, outer, SEC.curbH) : ribbonGeometry(outer, frame, SEC.curbH))
    // Outer skirt down to grade
    mb.add(footpathMat, wallGeometry(outer, SEC.curbH, 0))
  }
  if (sides === 'both' || sides === 'left') doSide(+1)
  if (sides === 'both' || sides === 'right') doSide(-1)

  // Paint
  if (opts.centerline) addDashedLine(mb, center, 0)
  if (opts.laneEdges) {
    addSolidLine(mb, offsetPolyline(center, +HALF - 0.22))
    addSolidLine(mb, offsetPolyline(center, -HALF + 0.22))
  }
}

function addDashedLine(mb: MeshBuilder, center: Vec2[], off: number) {
  const line = offsetPolyline(center, off)
  const total = polylineLength(line)
  let d = 2.5
  while (d + 3 < total - 2) {
    const seg = trimPolyline(line, d, Math.max(total - d - 3, 0))
    if (seg && seg.length >= 2) {
      mb.add(markMat, ribbonGeometry(offsetPolyline(seg, 0.09), offsetPolyline(seg, -0.09), SEC.yMark))
    }
    d += 6.5
  }
}

function addSolidLine(mb: MeshBuilder, line: Vec2[]) {
  mb.add(markMat, ribbonGeometry(offsetPolyline(line, 0.06), offsetPolyline(line, -0.06), SEC.yMark))
}

// ----------------------------------------------------------------------------
// Junction — N arms meeting at the origin, with a clean framed border that wraps
// the corners and leaves the road mouths open.
// ----------------------------------------------------------------------------

interface Arm {
  ang: number // outward heading (radians)
  len: number // arm length from origin to open end
}

function v(ang: number, r: number): Vec2 {
  return { x: Math.cos(ang) * r, z: Math.sin(ang) * r }
}
function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z }
}
function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, z: a.z * s }
}

function buildJunction(mb: MeshBuilder, arms: Arm[], opts: { crosswalks?: boolean } = {}) {
  const sorted = [...arms].sort((a, b) => a.ang - b.ang)
  // Trim radius: pull each arm's asphalt/curb back so the pad + corners have room.
  const R = OUTER + 0.6

  // Per-arm frames
  const A = sorted.map((arm) => {
    const d = v(arm.ang, 1) // outward unit
    const perp = { x: -d.z, z: d.x } // +90° (CCW)
    const mouth = scale(d, R) // arm start on the pad boundary
    return {
      arm,
      d,
      perp,
      mouth,
      // carriageway mouth corners (at the pad boundary)
      pAsphPlus: add(mouth, scale(perp, HALF)),
      pAsphMinus: add(mouth, scale(perp, -HALF)),
      // outer footpath corners at the pad boundary
      pOutPlus: add(mouth, scale(perp, OUTER)),
      pOutMinus: add(mouth, scale(perp, -OUTER)),
      pFramePlus: add(mouth, scale(perp, FRAME)),
      pFrameMinus: add(mouth, scale(perp, -FRAME)),
    }
  })

  // 1) Each arm as a framed corridor from the pad boundary outward.
  for (const a of A) {
    const end = scale(a.d, a.arm.len)
    buildCorridor(mb, [a.mouth, end], { centerSmooth: false, centerline: false })
  }

  // 2) Central asphalt pad = convex hull of all mouth carriageway corners.
  const hullPts: Vec2[] = []
  for (const a of A) {
    hullPts.push(a.pAsphPlus, a.pAsphMinus)
  }
  const hull = convexHull(hullPts)
  mb.add(asphaltMat, fillRing(hull, SEC.yRoad))

  // 3) Corner frame (curb + footpath) filling each gap between adjacent arms.
  const n = A.length
  for (let i = 0; i < n; i++) {
    const cur = A[i]
    const nxt = A[(i + 1) % n]
    // the corner lives on cur's +perp side and nxt's −perp side
    const inA = cur.pAsphPlus
    const inB = nxt.pAsphMinus
    const frameA = cur.pFramePlus
    const frameB = nxt.pFrameMinus
    const outA = cur.pOutPlus
    const outB = nxt.pOutMinus

    // Angular gap to the next arm. A wide gap (~180°) means the two arms are
    // collinear (a straight through-road): the footpath there must run STRAIGHT
    // across, not bulge into a dome. A convex gap (≤ ~150°) gets a rounded corner.
    let gap = nxt.arm.ang - cur.arm.ang
    while (gap <= 0) gap += Math.PI * 2
    while (gap > Math.PI * 2) gap -= Math.PI * 2
    const straightThrough = gap > 2.7 // > ~155°

    const arc = straightThrough ? [outA, outB] : arcBetween(outA, outB, 6)
    const frameArc = straightThrough ? [frameA, frameB] : arcBetween(frameA, frameB, 6)

    // curb top strip: between the asphalt-edge chord (inA→inB) and the frame chord
    const curbRing = [inA, inB, ...frameArc.slice().reverse()]
    mb.add(curbMat, fillRing(curbRing, SEC.curbH))
    // footpath top: between the frame arc and the outer arc
    const pathRing = [...frameArc, ...arc.slice().reverse()]
    mb.add(footpathMat, fillRing(pathRing, SEC.curbH))

    // curb inner face (vertical frame wall) along the asphalt chord inA→inB
    mb.add(curbMat, wallGeometry([inA, inB], SEC.yRoad, SEC.curbH))
    // outer skirt down to grade along the outer arc
    mb.add(footpathMat, wallGeometry(arc, SEC.curbH, 0))
  }

  // 4) Crosswalk stripes across each arm mouth.
  if (opts.crosswalks) {
    for (const a of A) {
      addCrosswalk(mb, a.mouth, a.d, a.perp)
    }
  }
}

/** Arc between two points, swept around the origin (clean rounded junction corner). */
function arcBetween(a: Vec2, b: Vec2, segs: number): Vec2[] {
  const ra = Math.hypot(a.x, a.z)
  const rb = Math.hypot(b.x, b.z)
  let a0 = Math.atan2(a.z, a.x)
  let a1 = Math.atan2(b.z, b.x)
  // shortest sweep
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI
  const out: Vec2[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const ang = a0 + (a1 - a0) * t
    const r = ra + (rb - ra) * t
    out.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r })
  }
  return out
}

function addCrosswalk(mb: MeshBuilder, mouth: Vec2, d: Vec2, perp: Vec2) {
  const setBack = 1.4 // from pad boundary inward toward centre
  const c = add(mouth, scale(d, -setBack))
  const stripeLen = 2.2
  const stripeW = 0.45
  const pitch = 0.85
  const nStripes = Math.floor((HALF * 2 - 0.4) / pitch)
  const start = -(nStripes - 1) * pitch * 0.5
  for (let i = 0; i < nStripes; i++) {
    const off = start + i * pitch
    const s = add(c, scale(perp, off))
    const a = add(add(s, scale(perp, -stripeW / 2)), scale(d, -stripeLen / 2))
    const b = add(add(s, scale(perp, stripeW / 2)), scale(d, -stripeLen / 2))
    const cc = add(add(s, scale(perp, stripeW / 2)), scale(d, stripeLen / 2))
    const e = add(add(s, scale(perp, -stripeW / 2)), scale(d, stripeLen / 2))
    mb.add(crosswalkMat, quad(a, b, cc, e, SEC.yMark))
  }
}

/** Andrew's monotone-chain convex hull, returns CCW ring. */
function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z)
  if (p.length < 3) return p
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: Vec2[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Vec2[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// ----------------------------------------------------------------------------
// Tile catalogue
// ----------------------------------------------------------------------------

function tileStraight(): THREE.Group {
  const mb = new MeshBuilder()
  const L = 24
  buildCorridor(mb, [{ x: 0, z: -L / 2 }, { x: 0, z: L / 2 }], {
    centerSmooth: false,
    centerline: true,
  })
  return mb.toGroup('road_straight')
}

function tileCurve(): THREE.Group {
  const mb = new MeshBuilder()
  // A winding S like the reference image.
  const ctrl: Vec2[] = [
    { x: -18, z: -20 },
    { x: -6, z: -12 },
    { x: -10, z: 0 },
    { x: 4, z: 8 },
    { x: 0, z: 20 },
  ]
  buildCorridor(mb, ctrl, { centerSmooth: true, smoothSpacing: 1.6, centerline: true })
  return mb.toGroup('road_curve')
}

function tileCorner(): THREE.Group {
  const mb = new MeshBuilder()
  const ctrl: Vec2[] = [
    { x: -18, z: -2 },
    { x: -2, z: -2 },
    { x: 0, z: 0 },
    { x: 2, z: 2 },
    { x: 2, z: 18 },
  ]
  buildCorridor(mb, ctrl, { centerSmooth: true, smoothSpacing: 1.6, centerline: true })
  return mb.toGroup('road_corner')
}

function tileTee(): THREE.Group {
  const mb = new MeshBuilder()
  buildJunction(
    mb,
    [
      { ang: 0, len: 16 }, // +X
      { ang: Math.PI, len: 16 }, // -X
      { ang: -Math.PI / 2, len: 16 }, // -Z stem
    ],
    { crosswalks: true },
  )
  return mb.toGroup('road_tee')
}

function tileCross(): THREE.Group {
  const mb = new MeshBuilder()
  buildJunction(
    mb,
    [
      { ang: 0, len: 16 },
      { ang: Math.PI / 2, len: 16 },
      { ang: Math.PI, len: 16 },
      { ang: -Math.PI / 2, len: 16 },
    ],
    { crosswalks: true },
  )
  return mb.toGroup('road_cross')
}

function tileEnd(): THREE.Group {
  const mb = new MeshBuilder()
  const L = 20
  buildCorridor(mb, [{ x: 0, z: -L / 2 }, { x: 0, z: L / 2 - 0.01 }], {
    centerSmooth: false,
    centerline: true,
  })
  // Rounded curb return + footpath cap around the +Z end. Semicircle centred at
  // (0, cz), sweeping angle 0 → PI so it bulges toward +Z (from +x edge over the
  // top to −x edge), matching the straight corridor's ±HALF edges at z = cz.
  const cz = L / 2
  const SEG = 14
  const ringAt = (r: number): Vec2[] => {
    const out: Vec2[] = []
    for (let i = 0; i <= SEG; i++) {
      const a = (Math.PI * i) / SEG
      out.push({ x: Math.cos(a) * r, z: cz + Math.sin(a) * r })
    }
    return out
  }
  const capInner = ringAt(HALF)
  const frameCap = ringAt(FRAME)
  const capOuter = ringAt(OUTER)

  // asphalt end cap: the half-disc of carriageway under the return
  mb.add(asphaltMat, fillRing([...capInner], SEC.yRoad))
  // curb strip ring + footpath ring
  mb.add(curbMat, fillRing([...capInner, ...frameCap.slice().reverse()], SEC.curbH))
  mb.add(footpathMat, fillRing([...frameCap, ...capOuter.slice().reverse()], SEC.curbH))
  // vertical curb face + outer skirt
  mb.add(curbMat, wallGeometry(capInner, SEC.yRoad, SEC.curbH))
  mb.add(footpathMat, wallGeometry(capOuter, SEC.curbH, 0))
  return mb.toGroup('road_end')
}

// ----------------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------------

function glbBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (r) => resolve(r as ArrayBuffer),
      (e) => reject(e),
      { binary: true, onlyVisible: true },
    )
  })
}

async function main() {
  const outDir = join(process.cwd(), 'experiment-roads')
  mkdirSync(outDir, { recursive: true })

  const tiles: Record<string, () => THREE.Group> = {
    road_straight: tileStraight,
    road_curve: tileCurve,
    road_corner: tileCorner,
    road_tee: tileTee,
    road_cross: tileCross,
    road_end: tileEnd,
  }

  const kit = new THREE.Group()
  kit.name = 'experiment_road_kit'
  let col = 0
  const gap = 46

  for (const [name, make] of Object.entries(tiles)) {
    const g = make()
    const buf = await glbBuffer(g)
    writeFileSync(join(outDir, `${name}.glb`), Buffer.from(buf))
    const kb = (buf.byteLength / 1024).toFixed(1)
    console.log(`  ${name.padEnd(16)} ${kb.padStart(8)} KB`)

    // Lay a clone into the overview kit.
    const clone = make()
    clone.position.set((col % 3) * gap, 0, Math.floor(col / 3) * gap)
    kit.add(clone)
    col++
  }

  const kitBuf = await glbBuffer(kit)
  writeFileSync(join(outDir, '_kit.glb'), Buffer.from(kitBuf))
  console.log(`  ${'_kit'.padEnd(16)} ${(kitBuf.byteLength / 1024).toFixed(1).padStart(8)} KB`)

  console.log(`\nDone → ${outDir}/`)
}

main().catch((e) => {
  console.error('experiment-roads failed:', e)
  process.exit(1)
})
