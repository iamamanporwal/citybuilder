// Framed-road kit ENGINE — a clean, band-based cross-section generator.
//
// The whole design principle (owner's brief): a road surface should be JUST that
// surface. A cross-section is an ordered list of BANDS (asphalt · curb · footpath ·
// grass · planting · cobble · cycle …), each with a width and a top height. The
// engine sweeps them along a centreline as strips that PARTITION the width — they
// share exact seams, never overlap. Because no two surfaces ever fight for the same
// pixels, there is no coplanar z-fighting/flicker; because the outermost band is a
// grass verge, the road frames itself in green with no dirt gap. A height step
// between adjacent bands emits exactly ONE vertical skirt (no coincident walls).
//
// Output is material-AGNOSTIC: a Map<Surface, BufferGeometry[]>. The caller (the
// GLB tool, or the in-app builder) supplies the actual materials. Everything is
// local ENU metres, Y-up, XZ ground plane — the repo procgen convention, so this
// drops straight into roads.ts when wired, and scales with widthM for the road-
// widening feature (carriageway bands are numeric and can be recomputed per road).

import * as THREE from 'three'
import type { Vec2 } from '../../types'
import {
  mergeGeometries,
  offsetPolyline,
  planarUvXZ,
  polylineLength,
  ribbonGeometry,
  smoothPolyline,
  trimPolyline,
  wallGeometry,
} from '../geometry'

export type Surface =
  | 'asphalt'
  | 'cobble'
  | 'curb'
  | 'footpath'
  | 'grass'
  | 'planting'
  | 'cycle'
  | 'markWhite'
  | 'markYellow'

/** Default top height (metres above the road datum) per surface. Curb & footpath
 *  are flush (frame reads by material + the curb face); planting sits a touch below
 *  the kerb top; cycle track is a low raised strip; grass is at grade. */
export const SURFACE_H: Record<Surface, number> = {
  asphalt: 0,
  cobble: 0,
  cycle: 0.03,
  curb: 0.15,
  footpath: 0.15,
  planting: 0.12,
  grass: 0,
  markWhite: 0.02,
  markYellow: 0.02,
}

export interface Band {
  w: number
  surface: Surface
  /** Override the default top height for this band. */
  h?: number
}

export interface Marking {
  /** Profile offset from the cross-section centre (metres, +left / −right). */
  off: number
  style: 'dashed' | 'solid' | 'double'
  color?: 'white' | 'yellow'
  w?: number
}

export interface CrossSection {
  id: string
  label: string
  /** Left→right bands spanning the full width; the centre of the total width is
   *  the centreline the road follows (offset 0 = OSM centreline). */
  bands: Band[]
  markings?: Marking[]
  /** Longitudinal foundation depth for raised bands so kerbs never float on terrain. */
  foundation?: number
}

export type SurfaceGeoms = Map<Surface, THREE.BufferGeometry[]>

function accumAdd(acc: SurfaceGeoms, s: Surface, ...g: (THREE.BufferGeometry | null)[]) {
  const arr = acc.get(s) ?? []
  for (const gg of g) if (gg) arr.push(gg)
  acc.set(s, arr)
}

const heightOf = (b: Band): number => b.h ?? SURFACE_H[b.surface]

/** Flat top ribbon: world-planar XZ UVs + forced +Y normals so overlapping strips
 *  (kerbs from adjacent roads, junction corners) sample identical texels & share a
 *  normal — idempotent overdraw, the anti-flicker trick from raisedRibbonGeometry. */
function flatTop(a: Vec2[], b: Vec2[], y: number | number[]): THREE.BufferGeometry {
  const g = planarUvXZ(ribbonGeometry(a, b, y))
  // normalise winding so faces point +Y — mirrored sides otherwise shade
  // oppositely under DoubleSide (left dark / right bright). See roads.ts windUp.
  const idx = g.getIndex()
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  if (idx && idx.count >= 3) {
    const i0 = idx.getX(0), i1 = idx.getX(1), i2 = idx.getX(2)
    const e1x = pos.getX(i1) - pos.getX(i0), e1z = pos.getZ(i1) - pos.getZ(i0)
    const e2x = pos.getX(i2) - pos.getX(i0), e2z = pos.getZ(i2) - pos.getZ(i0)
    if (e1x * e2z - e1z * e2x > 0) {
      const arr = idx.array as Uint16Array | Uint32Array
      for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t }
      idx.needsUpdate = true
    }
  }
  const n = g.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0)
  return g
}

/** Cumulative band offsets across the full width, centred on 0. */
export function bandLayout(xs: CrossSection): { band: Band; inner: number; outer: number }[] {
  const total = xs.bands.reduce((s, b) => s + b.w, 0)
  let cur = -total / 2
  return xs.bands.map((band) => {
    const inner = cur
    cur += band.w
    return { band, inner, outer: cur }
  })
}

export function crossSectionWidth(xs: CrossSection): number {
  return xs.bands.reduce((s, b) => s + b.w, 0)
}

/**
 * Sweep a cross-section along a centreline into per-surface geometry. `smooth`
 * resamples the centreline (for curves). The bands partition the width, so the
 * only vertical faces are (a) the step between two adjacent bands of different
 * height and (b) the outer drop of a raised outermost band — each emitted once.
 */
export function sweepCrossSection(
  center: Vec2[],
  xs: CrossSection,
  acc: SurfaceGeoms = new Map(),
  opts: { smooth?: number | false } = {},
): SurfaceGeoms {
  const c = opts.smooth === false ? center : smoothPolyline(center, opts.smooth ?? 3)
  const layout = bandLayout(xs)
  const foundation = xs.foundation ?? 0

  // edge polylines at every distinct offset (dedup so shared seams reuse the line)
  const edgeAt = new Map<number, Vec2[]>()
  const edge = (off: number) => {
    let e = edgeAt.get(off)
    if (!e) edgeAt.set(off, (e = offsetPolyline(c, off)))
    return e
  }

  // tops
  for (const { band, inner, outer } of layout) {
    const h = heightOf(band)
    acc.get(band.surface) // touch
    accumAdd(acc, band.surface, flatTop(edge(outer), edge(inner), h))
  }

  // internal skirts at height steps (assign to the taller band's surface)
  for (let i = 0; i < layout.length - 1; i++) {
    const L = layout[i]
    const R = layout[i + 1]
    const hL = heightOf(L.band)
    const hR = heightOf(R.band)
    if (Math.abs(hL - hR) < 1e-4) continue
    const b = L.outer // == R.inner
    const lo = Math.min(hL, hR)
    const hi = Math.max(hL, hR)
    const surf = hL > hR ? L.band.surface : R.band.surface
    accumAdd(acc, surf, wallGeometry(edge(b), lo, hi))
  }

  // outer drops of raised outermost bands (down to foundation so nothing floats)
  const first = layout[0]
  const last = layout[layout.length - 1]
  if (heightOf(first.band) > 1e-4) accumAdd(acc, first.band.surface, wallGeometry(edge(first.inner), -foundation, heightOf(first.band)))
  if (heightOf(last.band) > 1e-4) accumAdd(acc, last.band.surface, wallGeometry(edge(last.outer), heightOf(last.band), -foundation))

  // markings
  for (const m of xs.markings ?? []) addMarking(acc, c, m)

  return acc
}

function addMarking(acc: SurfaceGeoms, center: Vec2[], m: Marking) {
  const surf: Surface = m.color === 'yellow' ? 'markYellow' : 'markWhite'
  const y = 0.02
  const hw = (m.w ?? 0.12) / 2
  const strip = (line: Vec2[]) => flatTop(offsetPolyline(line, hw), offsetPolyline(line, -hw), y)
  if (m.style === 'double') {
    accumAdd(acc, surf, strip(offsetPolyline(center, m.off + 0.09)))
    accumAdd(acc, surf, strip(offsetPolyline(center, m.off - 0.09)))
    return
  }
  const line = offsetPolyline(center, m.off)
  if (m.style === 'solid') { accumAdd(acc, surf, strip(line)); return }
  // dashed
  const total = polylineLength(line)
  let d = 2.5
  while (d + 3 < total - 2) {
    const seg = trimPolyline(line, d, Math.max(total - d - 3, 0))
    if (seg && seg.length >= 2) accumAdd(acc, surf, strip(seg))
    d += 6.5
  }
}

export function mergeSurfaceGeoms(acc: SurfaceGeoms): Map<Surface, THREE.BufferGeometry> {
  const out = new Map<Surface, THREE.BufferGeometry>()
  for (const [s, geoms] of acc) {
    if (!geoms.length) continue
    out.set(s, geoms.length > 1 ? mergeGeometries(geoms) : geoms[0])
  }
  return out
}

// ---------------------------------------------------------------------------
// Junctions — N arms (3..6+) meeting at the origin, framed cross-section, clean
// corners with grass filling every gap so no dirt shows.
// ---------------------------------------------------------------------------

export interface JunctionProfile {
  carriageHalf: number // asphalt half-width
  curbW: number
  lawnW?: number // tree-lawn grass verge BETWEEN curb & footpath (0 = none, urban)
  footW: number
  vergeW: number // outer grass verge width
  curbH?: number
  flare?: number // extra pad radius beyond the outer band (bell-mouth), default 0.6
  centerMark?: { style: Marking['style']; color?: 'white' | 'yellow' } // per-arm centre line
}

export interface Arm {
  ang: number // outward heading (radians)
  len: number // corridor length beyond the pad (ignored when padOnly)
  prof?: JunctionProfile // per-arm cross-section (mixed-width junctions); falls back to the shared prof
}

export const LAWN_H = 0.04 // raised tree-lawn height (sits in a trough between curb & footpath)

const v = (ang: number, r: number): Vec2 => ({ x: Math.cos(ang) * r, z: Math.sin(ang) * r })
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z })
const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s })

/** Pad radius = where the arms are trimmed to. Segments trim to the SAME radius so
 *  their cross-section registers with the junction arm mouth (the Lego rule). */
export function junctionPadRadius(prof: JunctionProfile): number {
  return prof.carriageHalf + prof.curbW + (prof.lawnW ?? 0) + prof.footW + prof.vergeW + (prof.flare ?? 0.6)
}

export function buildJunction(
  arms: Arm[],
  prof: JunctionProfile,
  acc: SurfaceGeoms = new Map(),
  opts: { padOnly?: boolean; skipPad?: boolean; radius?: number } = {},
): SurfaceGeoms {
  const curbH = prof.curbH ?? SURFACE_H.curb
  // All arms trim to ONE shared disc so the pad is a clean hull; each arm keeps its
  // OWN width (mixed-width junctions), so a narrow arm flares out to the disc.
  // `radius` overrides the disc (used in-app to hug the existing asphalt pad).
  const R = opts.radius ?? Math.max(...arms.map((a) => junctionPadRadius(a.prof ?? prof)))
  const sorted = [...arms].sort((a, b) => a.ang - b.ang)

  const A = sorted.map((arm) => {
    const p = arm.prof ?? prof
    const hw = p.carriageHalf
    const rCurb = hw + p.curbW
    const rLawn = rCurb + (p.lawnW ?? 0)
    const rFoot = rLawn + p.footW
    const rGrass = rFoot + p.vergeW
    const d = v(arm.ang, 1)
    const perp = { x: -d.z, z: d.x }
    const mouth = scale(d, R)
    const at = (lat: number) => add(mouth, scale(perp, lat))
    return {
      arm, p, d, perp, mouth, lawnW: p.lawnW ?? 0,
      asphP: at(hw), asphM: at(-hw),
      curbP: at(rCurb), curbM: at(-rCurb),
      lawnP: at(rLawn), lawnM: at(-rLawn),
      footP: at(rFoot), footM: at(-rFoot),
      grassP: at(rGrass), grassM: at(-rGrass),
    }
  })

  // 1) each arm as a framed corridor beyond the pad (skipped in a network, where
  //    the segment sweep provides the arm — padOnly).
  if (!opts.padOnly) {
    for (const a of A) sweepCrossSection([a.mouth, add(a.mouth, scale(a.d, a.arm.len))], junctionArmCrossSection(a.p), acc, { smooth: false })
  }

  // 2) central asphalt pad = convex hull of the carriageway mouth corners
  //    (skipPad: in-app keeps its own elevation-aware pad, we only add the frame)
  if (!opts.skipPad) {
    const hull = convexHull(A.flatMap((a) => [a.asphP, a.asphM]))
    accumAdd(acc, 'asphalt', fillRing(hull, SURFACE_H.asphalt))
  }

  // 3) fill every corner between adjacent arms: curb → lawn → footpath → grass
  const n = A.length
  for (let i = 0; i < n; i++) {
    const cur = A[i]
    const nxt = A[(i + 1) % n]
    let gap = nxt.arm.ang - cur.arm.ang
    while (gap <= 0) gap += Math.PI * 2
    const straight = gap > 2.7 // ~155°+: through-road, run bands straight (no dome)
    const arc = (a: Vec2, b: Vec2) => (straight ? [a, b] : arcBetween(a, b, 6))

    const asphChord = [cur.asphP, nxt.asphM]
    const curbArc = arc(cur.curbP, nxt.curbM)
    const footArc = arc(cur.footP, nxt.footM)
    const grassArc = arc(cur.grassP, nxt.grassM)

    // curb strip + curb face
    accumAdd(acc, 'curb', fillRing([cur.asphP, nxt.asphM, ...curbArc.slice().reverse()], curbH))
    accumAdd(acc, 'curb', wallGeometry(asphChord, SURFACE_H.asphalt, curbH))

    let footInnerArc = curbArc
    if (cur.lawnW > 0.05 && nxt.lawnW > 0.05) {
      const lawnArc = arc(cur.lawnP, nxt.lawnM)
      accumAdd(acc, 'curb', wallGeometry(curbArc, LAWN_H, curbH)) // curb back → lawn trough
      accumAdd(acc, 'grass', fillRing([...curbArc, ...lawnArc.slice().reverse()], LAWN_H)) // tree lawn
      accumAdd(acc, 'footpath', wallGeometry(lawnArc, LAWN_H, curbH)) // footpath inner face
      footInnerArc = lawnArc
    }
    // footpath top + outer drop
    accumAdd(acc, 'footpath', fillRing([...footInnerArc, ...footArc.slice().reverse()], curbH))
    accumAdd(acc, 'footpath', wallGeometry(footArc, curbH, SURFACE_H.grass))
    // grass corner fill → no dirt gap
    if (cur.p.vergeW > 0 && nxt.p.vergeW > 0) accumAdd(acc, 'grass', fillRing([...footArc, ...grassArc.slice().reverse()], SURFACE_H.grass))
  }

  // 4) per-arm centre marking up to the pad
  if (!opts.padOnly) {
    for (const a of A) {
      const cm = a.p.centerMark
      if (cm) addMarking(acc, [add(a.mouth, scale(a.d, 1.5)), add(a.mouth, scale(a.d, a.arm.len))], { off: 0, style: cm.style, color: cm.color })
    }
  }
  return acc
}

/** The symmetric framed cross-section for a junction arm / matching segment:
 *  grass | footpath | lawn | curb | asphalt | curb | lawn | footpath | grass. */
export function junctionArmCrossSection(prof: JunctionProfile): CrossSection {
  const { carriageHalf: hw, curbW, footW, vergeW } = prof
  const lawnW = prof.lawnW ?? 0
  const lawn: Band[] = lawnW > 0.05 ? [{ w: lawnW, surface: 'grass', h: LAWN_H }] : []
  const outerGrass: Band[] = vergeW > 0 ? [{ w: vergeW, surface: 'grass' }] : []
  const bands: Band[] = [
    ...outerGrass,
    { w: footW, surface: 'footpath' },
    ...lawn,
    { w: curbW, surface: 'curb' },
    { w: hw * 2, surface: 'asphalt' },
    { w: curbW, surface: 'curb' },
    ...lawn,
    { w: footW, surface: 'footpath' },
    ...outerGrass,
  ]
  return { id: 'junction-arm', label: 'junction arm', bands, foundation: 0.35 }
}

// ---- polygon helpers -------------------------------------------------------

/** Arc between two points swept around the origin (rounded junction corner). */
function arcBetween(a: Vec2, b: Vec2, segs: number): Vec2[] {
  const ra = Math.hypot(a.x, a.z)
  const rb = Math.hypot(b.x, b.z)
  let a0 = Math.atan2(a.z, a.x)
  let a1 = Math.atan2(b.z, b.x)
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

/** Triangulate a simple ring into a flat up-facing face at height y (world-planar UV). */
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
  const a = pts[idx[0]], b = pts[idx[1]], cc = pts[idx[2]]
  if ((b.x - a.x) * (cc.y - a.y) - (b.y - a.y) * (cc.x - a.x) > 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  const nrm = new Float32Array(pts.length * 3)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  return planarUvXZ(g)
}

/** Andrew's monotone chain convex hull (CCW). */
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
