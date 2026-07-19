import * as THREE from 'three'
import type { RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, ZoneKind } from '../resolver/types'
import { hash01 } from '../resolver/resolve'
import { NON_DRIVABLE } from './roadNetwork'
import { sampleTerrain } from './terrain/field'

// ---------------------------------------------------------------------------
// Roadside Vegetation & ground-detail engine.
//
// Slow-Roads / ETS2-style verges: procedural grass tufts + low shrubs scattered
// along the strip BESIDE the carriageway, wherever the land cover is grass/bare.
// Everything is deterministic (seeded by road id + station), GPU-instanced (one
// InstancedMesh per kind), and land-cover / zoning aware. Roots sit on the
// terrain field — this is off-road ground detail, so it never rides the road
// elevation solve and never touches the coplanar road-surface stack (tufts are
// tall meshes, exempt from the flat-mesh flicker lint, same as trees).
//
// The PLANNER (planRoadsideVegetation) is pure geometry — no THREE, no canvas —
// so it is unit-testable in the node env. The mesh builder is the only part that
// touches a canvas, and it does so lazily (never at module load) so importing
// this file from a node test stays canvas-free.
// ---------------------------------------------------------------------------

let _greeneryEnabled = true
export function setGreeneryEnabled(v: boolean): void {
  _greeneryEnabled = v
}
export function greeneryEnabled(): boolean {
  return _greeneryEnabled
}

export type VegKind = 'grass' | 'shrub'

export interface VegInstance {
  x: number
  z: number
  y: number
  scale: number
  rotY: number
  tint: number // -1..1, drives per-instance HSL jitter
  dry: boolean // on 'bare' cover — drier/yellower
  kind: VegKind
}

export interface VegBudget {
  grass: number
  shrub: number
}

const DEFAULT_BUDGET: VegBudget = { grass: 26000, shrub: 6000 }

// Per-zone verge character. spacing = metres between tufts along the road;
// shrubEvery = one shrub attempt per N grass stations; band = how far out from
// the carriageway edge the verge extends. Dense, leafy zones get tighter grass.
interface VergeRule {
  grassSpacing: number
  shrubEvery: number
  band: number
}
const VERGE_RULES: Record<ZoneKind, VergeRule> = {
  park: { grassSpacing: 1.1, shrubEvery: 5, band: 5.0 },
  residential: { grassSpacing: 1.6, shrubEvery: 7, band: 3.6 },
  none: { grassSpacing: 1.4, shrubEvery: 6, band: 4.5 },
  retail: { grassSpacing: 2.8, shrubEvery: 0, band: 2.4 },
  commercial: { grassSpacing: 2.9, shrubEvery: 0, band: 2.4 },
  industrial: { grassSpacing: 2.2, shrubEvery: 9, band: 3.0 },
}

// The verge starts just beyond a typical sidewalk so tufts fringe the kerb line
// rather than sprouting in a driving lane; the land-cover gate + carriageway
// clearance below are the real guarantees against on-road placement.
const VERGE_INSET = 1.4

/**
 * Compact carriageway occupancy index — grid-hashed segment list, point-in-band
 * test. A local copy of props.ts' CarriagewayIndex so the planner stays free of
 * the canvas-heavy props/materials import chain (node tests import this file).
 */
class DrivableIndex {
  private cells = new Map<string, { ax: number; az: number; bx: number; bz: number; half: number }[]>()
  private static CELL = 24

  constructor(roads: RoadSegment[]) {
    const C = DrivableIndex.CELL
    for (const r of roads) {
      if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.points.length < 2) continue
      const half = r.widthM / 2
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1]
        const b = r.points[i]
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
    }
  }

  inside(p: Vec2, margin: number): boolean {
    const C = DrivableIndex.CELL
    const list = this.cells.get(`${Math.floor(p.x / C)},${Math.floor(p.z / C)}`)
    if (!list) return false
    for (const s of list) {
      const dx = s.bx - s.ax
      const dz = s.bz - s.az
      const len2 = dx * dx + dz * dz
      let t = len2 > 1e-9 ? ((p.x - s.ax) * dx + (p.z - s.az) * dz) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const d = Math.hypot(p.x - (s.ax + dx * t), p.z - (s.az + dz * t))
      if (d < s.half + margin) return true
    }
    return false
  }
}

function polyLen(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return l
}

function alongWithDir(pts: Vec2[], dist: number): { p: Vec2; dir: Vec2 } {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dz = pts[i].z - pts[i - 1].z
    const seg = Math.hypot(dx, dz)
    if (acc + seg >= dist && seg > 0) {
      const t = (dist - acc) / seg
      return { p: { x: pts[i - 1].x + dx * t, z: pts[i - 1].z + dz * t }, dir: { x: dx / seg, z: dz / seg } }
    }
    acc += seg
  }
  const n = pts.length
  const dx = pts[n - 1].x - pts[n - 2].x
  const dz = pts[n - 1].z - pts[n - 2].z
  const l = Math.hypot(dx, dz) || 1
  return { p: pts[n - 1], dir: { x: dx / l, z: dz / l } }
}

/**
 * Pure, deterministic roadside scatter. `sampleY` supplies the ground height
 * (terrain field in the app, a stub in tests). Returns instances in a stable
 * order so the global budget truncates identically every build.
 */
export function planRoadsideVegetation(
  roads: RoadSegment[],
  ctx: Pick<ResolvedContext, 'landCoverAt' | 'zoneAt'>,
  sampleY: (x: number, z: number) => number,
  budget: VegBudget = DEFAULT_BUDGET,
): VegInstance[] {
  const index = new DrivableIndex(roads)
  const out: VegInstance[] = []
  let nGrass = 0
  let nShrub = 0

  for (const r of roads) {
    // A verge needs solid ground beside the road: no bridge decks (nothing under
    // the parapet), no tunnels, and only roads with a real carriageway width.
    if (r.bridge || r.tunnel || r.points.length < 2 || NON_DRIVABLE.has(r.roadClass)) continue
    const L = polyLen(r.points)
    if (L < 12) continue
    const zone = ctx.zoneAt(r.points[Math.floor(r.points.length / 2)])
    const rule = VERGE_RULES[zone] ?? VERGE_RULES.none
    const half = r.widthM / 2

    for (const side of [-1, 1] as const) {
      let step = 0
      for (let d = rule.grassSpacing * 0.5; d < L; d += rule.grassSpacing, step++) {
        if (nGrass >= budget.grass) break
        const { p, dir } = alongWithDir(r.points, d)
        const across = { x: -dir.z * side, z: dir.x * side }
        // jittered lateral offset within the verge band
        const off = half + VERGE_INSET + hash01(`${r.id}:vo${side}${step}`) * rule.band
        const gx = p.x + across.x * off
        const gz = p.z + across.z * off
        const cover = ctx.landCoverAt({ x: gx, z: gz })
        if (cover !== 'grass' && cover !== 'bare') continue
        if (index.inside({ x: gx, z: gz }, 0.3)) continue
        const dry = cover === 'bare'
        // thin bare/dry verges out a little so they read as scrubby, not lush
        if (dry && hash01(`${r.id}:vd${side}${step}`) > 0.55) continue
        out.push({
          x: gx,
          z: gz,
          y: sampleY(gx, gz),
          scale: 0.72 + hash01(`${r.id}:vs${side}${step}`) * 0.6,
          rotY: hash01(`${r.id}:vr${side}${step}`) * Math.PI,
          tint: hash01(`${r.id}:vt${side}${step}`) * 2 - 1,
          dry,
          kind: 'grass',
        })
        nGrass++

        // a shrub occasionally at the same station, pushed a touch further out
        if (!dry && rule.shrubEvery > 0 && step % rule.shrubEvery === 0 && nShrub < budget.shrub) {
          const soff = off + 0.8 + hash01(`${r.id}:sh${side}${step}`) * 1.2
          const sx = p.x + across.x * soff
          const sz = p.z + across.z * soff
          if (ctx.landCoverAt({ x: sx, z: sz }) === 'grass' && !index.inside({ x: sx, z: sz }, 0.4)) {
            out.push({
              x: sx,
              z: sz,
              y: sampleY(sx, sz),
              scale: 0.55 + hash01(`${r.id}:ss${side}${step}`) * 0.6,
              rotY: hash01(`${r.id}:sr${side}${step}`) * Math.PI * 2,
              tint: hash01(`${r.id}:st${side}${step}`) * 2 - 1,
              dry: false,
              kind: 'shrub',
            })
            nShrub++
          }
        }
      }
    }
    if (nGrass >= budget.grass && nShrub >= budget.shrub) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Mesh builders (browser-only; canvas generated lazily)
// ---------------------------------------------------------------------------

let _grassTex: THREE.Texture | null = null
/** Alpha grass-clump billboard: a fan of tapered blades on a transparent field. */
function grassBillboardTexture(): THREE.Texture {
  if (_grassTex) return _grassTex
  const S = 128
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, S, S)
  // deterministic blade fan rooted along the bottom edge
  let h = 987654321 >>> 0
  const rnd = () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296)
  const blades = 15
  for (let i = 0; i < blades; i++) {
    const rootX = S * (0.1 + 0.8 * (i / (blades - 1)) + (rnd() - 0.5) * 0.06)
    const tipX = rootX + (rnd() - 0.5) * S * 0.28
    const tipY = S * (0.08 + rnd() * 0.42)
    const w = S * (0.035 + rnd() * 0.03)
    const g = ctx.createLinearGradient(0, S, 0, tipY)
    const lo = 60 + Math.floor(rnd() * 24)
    g.addColorStop(0, `rgb(${lo - 14},${lo + 26},${Math.floor(lo * 0.5)})`)
    g.addColorStop(1, `rgb(${lo + 40},${lo + 78},${Math.floor(lo * 0.6)})`)
    ctx.fillStyle = g
    const midX = (rootX + tipX) / 2 + (rnd() - 0.5) * S * 0.1
    ctx.beginPath()
    ctx.moveTo(rootX - w, S)
    ctx.quadraticCurveTo(midX - w * 0.4, (S + tipY) / 2, tipX, tipY)
    ctx.quadraticCurveTo(midX + w * 0.4, (S + tipY) / 2, rootX + w, S)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  _grassTex = tex
  return tex
}

/** Two crossed vertical quads, unit height (0..1), unit width (-0.5..0.5). */
function grassBladeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const quad = (nx: number, nz: number) => {
    const base = pos.length / 3
    // corners: bottom-left, bottom-right, top-right, top-left
    pos.push(-0.5 * nx, 0, -0.5 * nz, 0.5 * nx, 0, 0.5 * nz, 0.5 * nx, 1, 0.5 * nz, -0.5 * nx, 1, -0.5 * nz)
    uv.push(0, 0, 1, 0, 1, 1, 0, 1)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  quad(1, 0) // faces ±Z
  quad(0, 1) // faces ±X
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// Distance-dither LOD: far tufts are stochastically discarded so the verge fades
// out instead of ending in a hard ring, and distant overdraw is cut. Pure
// in-shader (view-space depth, hashed threshold) — no uniforms, no ticker.
function withDistanceFade(m: THREE.MeshStandardMaterial, near: number, far: number): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCbDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvCbDist = -mvPosition.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCbDist;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float cbFade = 1.0 - smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, vCbDist);
        float cbHash = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        if (cbFade < cbHash) discard;`,
      )
  }
  return m
}

/**
 * Roadside vegetation as instanced meshes. Returns a Group tagged for selection,
 * or an empty Group when greenery is disabled / nothing qualifies.
 */
export function buildRoadsideVegetation(roads: RoadSegment[], ctx: ResolvedContext): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Roadside greenery'
  group.userData.objectId = 'veg_roadside'
  if (!greeneryEnabled()) return group

  const instances = planRoadsideVegetation(roads, ctx, sampleTerrain)
  if (!instances.length) return group

  const grass = instances.filter((i) => i.kind === 'grass')
  const shrubs = instances.filter((i) => i.kind === 'shrub')

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const s = new THREE.Vector3()
  const v = new THREE.Vector3()
  const col = new THREE.Color()

  if (grass.length) {
    const geo = grassBladeGeometry()
    const mat = withDistanceFade(
      new THREE.MeshStandardMaterial({
        map: grassBillboardTexture(),
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0,
      }),
      70,
      135,
    )
    const im = new THREE.InstancedMesh(geo, mat, grass.length)
    grass.forEach((e, i) => {
      const w = e.scale * 0.8
      const hgt = e.scale * (0.42 + (e.tint + 1) * 0.09)
      q.setFromAxisAngle(up, e.rotY)
      s.set(w, hgt, w)
      v.set(e.x, e.y, e.z)
      im.setMatrixAt(i, m.compose(v, q, s))
      // green base tinted toward yellow when dry; per-instance HSL jitter
      col.set(e.dry ? '#9aa055' : '#5f8a3e').offsetHSL(e.tint * 0.02, e.tint * 0.05, e.tint * 0.06)
      im.setColorAt(i, col)
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere() // world-space instances vs origin geometry — cull correctly
    im.name = `Grass (${grass.length})`
    im.userData.objectId = 'veg_roadside'
    im.receiveShadow = true
    group.add(im)
  }

  if (shrubs.length) {
    const geo = new THREE.IcosahedronGeometry(1, 1)
    const mat = new THREE.MeshStandardMaterial({ color: '#4a6b34', roughness: 1, metalness: 0, flatShading: true })
    const im = new THREE.InstancedMesh(geo, mat, shrubs.length)
    shrubs.forEach((e, i) => {
      const r = e.scale
      q.setFromAxisAngle(up, e.rotY)
      s.set(r, r * 0.82, r)
      v.set(e.x, e.y + r * 0.7, e.z) // sit the blob on the ground
      im.setMatrixAt(i, m.compose(v, q, s))
      col.set('#4a6b34').offsetHSL(e.tint * 0.03, e.tint * 0.05, e.tint * 0.05)
      im.setColorAt(i, col)
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
    im.castShadow = true
    im.name = `Shrubs (${shrubs.length})`
    im.userData.objectId = 'veg_roadside'
    group.add(im)
  }

  group.userData.counts = { grass: grass.length, shrubs: shrubs.length }
  return group
}
