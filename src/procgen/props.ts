import * as THREE from 'three'
import type { CityGraph, PointFeature, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, TreeSpecies } from '../resolver/types'
import { hash01, propRulesFor, resolveTree } from '../resolver/resolve'
import { mats } from './materials'
import { mergeGeometries } from './geometry'

// Street furniture & vegetation. Everything is seeded by object id — varied but
// deterministic. Densities are zoning-aware via the Context Resolver.

/** Traffic signal: pole + mast head with 3 lamps. Selectable street furniture. */
export function buildTrafficSignal(p: PointFeature): THREE.Group {
  const g = new THREE.Group()
  g.name = 'Traffic signal'
  g.userData.objectId = p.id
  g.position.set(p.position.x, 0, p.position.z)

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.6, 8), mats.signalPole)
  pole.position.y = 2.3
  pole.castShadow = true
  g.add(pole)

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.26), mats.signalHead)
  head.position.set(0, 4.4, 0.14)
  g.add(head)

  const lampGeo = new THREE.SphereGeometry(0.09, 10, 8)
  const lamps: [THREE.Material, number][] = [
    [mats.signalRed, 0.3],
    [mats.signalAmber, 0],
    [mats.signalGreen, -0.3],
  ]
  for (const [mat, dy] of lamps) {
    const lamp = new THREE.Mesh(lampGeo, mat)
    lamp.position.set(0, 4.4 + dy, 0.28)
    g.add(lamp)
  }
  return g
}

// ---------------------------------------------------------------------------
// Trees: multi-species instanced pools (species mix from GBIF/climate resolver)
// ---------------------------------------------------------------------------

interface SpeciesGeo {
  trunk: THREE.BufferGeometry
  canopy: THREE.BufferGeometry
  canopyColor: string
  trunkH: number
}

function speciesGeometry(): Record<TreeSpecies, SpeciesGeo> {
  return {
    broadleaf: { trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 6), canopy: new THREE.IcosahedronGeometry(1, 1), canopyColor: '#4d7038', trunkH: 2.6 },
    columnar: { trunk: new THREE.CylinderGeometry(0.1, 0.14, 1, 6), canopy: new THREE.ConeGeometry(0.75, 3.4, 8), canopyColor: '#3c5a33', trunkH: 1.1 },
    conifer: { trunk: new THREE.CylinderGeometry(0.1, 0.16, 1, 6), canopy: new THREE.ConeGeometry(1.15, 2.9, 8), canopyColor: '#38543a', trunkH: 1.6 },
    palm: { trunk: new THREE.CylinderGeometry(0.09, 0.13, 1, 6), canopy: new THREE.SphereGeometry(1, 8, 5).scale(1.5, 0.42, 1.5), canopyColor: '#4f7a34', trunkH: 4.6 },
    acacia: { trunk: new THREE.CylinderGeometry(0.1, 0.15, 1, 6), canopy: new THREE.SphereGeometry(1, 8, 5).scale(1.7, 0.55, 1.7), canopyColor: '#5c7540', trunkH: 3.0 },
  }
}

export function buildTrees(trees: PointFeature[], ctx: ResolvedContext): THREE.Group {
  const group = new THREE.Group()
  group.name = `Street trees (${trees.length})`
  group.userData.objectId = 'veg_trees'
  if (!trees.length) return group

  const geos = speciesGeometry()
  const bySpecies = new Map<TreeSpecies, { t: PointFeature; scale: number; tint: number }[]>()
  for (const t of trees) {
    if (ctx.landCoverAt(t.position) === 'water') continue
    const res = resolveTree(t.id, ctx)
    if (!bySpecies.has(res.species)) bySpecies.set(res.species, [])
    bySpecies.get(res.species)!.push({ t, scale: res.scale, tint: res.tint })
  }

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const v = new THREE.Vector3()
  const c = new THREE.Color()

  for (const [species, list] of bySpecies) {
    const geo = geos[species]
    const trunks = new THREE.InstancedMesh(geo.trunk, mats.treeTrunk, list.length)
    const canopyMat = new THREE.MeshStandardMaterial({ color: geo.canopyColor, roughness: 1 })
    const canopies = new THREE.InstancedMesh(geo.canopy, canopyMat, list.length)
    trunks.castShadow = true
    canopies.castShadow = true
    list.forEach((e, i) => {
      const trunkH = geo.trunkH * e.scale
      const cs = e.scale * (species === 'broadleaf' ? 1.9 : 1.15)
      s.set(e.scale, trunkH, e.scale)
      v.set(e.t.position.x, trunkH / 2, e.t.position.z)
      m.compose(v, q, s)
      trunks.setMatrixAt(i, m)
      s.set(cs, cs, cs)
      v.set(e.t.position.x, trunkH + cs * (species === 'columnar' || species === 'conifer' ? 1.1 : 0.45), e.t.position.z)
      m.compose(v, q, s)
      canopies.setMatrixAt(i, m)
      c.set(geo.canopyColor).offsetHSL(e.tint * 0.03, e.tint * 0.06, e.tint * 0.045)
      canopies.setColorAt(i, c)
    })
    trunks.instanceMatrix.needsUpdate = true
    canopies.instanceMatrix.needsUpdate = true
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true
    trunks.userData.objectId = 'veg_trees'
    canopies.userData.objectId = 'veg_trees'
    group.add(trunks, canopies)
  }
  return group
}

// ---------------------------------------------------------------------------
// Streetlights, benches, bins, signs — zoning-aware generated placement
// ---------------------------------------------------------------------------

const FURNITURE_ROADS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'trunk'])

function lampGeometry(style: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 7.4, 8)
  pole.translate(0, 3.7, 0)
  parts.push(pole)
  if (style === 'cobra') {
    const arm = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6)
    arm.rotateZ(Math.PI / 2)
    arm.translate(1.0, 7.3, 0)
    parts.push(arm)
    const head = new THREE.BoxGeometry(0.85, 0.16, 0.3)
    head.translate(2.0, 7.28, 0)
    parts.push(head)
  } else {
    // euro-post / heritage: top-mounted lantern
    const lantern = new THREE.CylinderGeometry(0.16, 0.22, 0.55, 8)
    lantern.translate(0, 7.6, 0)
    parts.push(lantern)
  }
  return mergeGeometries(parts)
}

function benchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const seat = new THREE.BoxGeometry(1.7, 0.07, 0.5)
  seat.translate(0, 0.45, 0)
  parts.push(seat)
  const back = new THREE.BoxGeometry(1.7, 0.45, 0.06)
  back.translate(0, 0.75, -0.24)
  parts.push(back)
  for (const x of [-0.7, 0.7]) {
    const leg = new THREE.BoxGeometry(0.08, 0.45, 0.45)
    leg.translate(x, 0.22, 0)
    parts.push(leg)
  }
  return mergeGeometries(parts)
}

function binGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.28, 0.24, 0.85, 10)
  g.translate(0, 0.42, 0)
  return g
}

function signGeometry(shape: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const pole = new THREE.CylinderGeometry(0.045, 0.055, 2.6, 6)
  pole.translate(0, 1.3, 0)
  parts.push(pole)
  const plate =
    shape === 'us-rect'
      ? new THREE.BoxGeometry(0.6, 0.75, 0.04)
      : new THREE.CylinderGeometry(0.38, 0.38, 0.04, 16).rotateX(Math.PI / 2)
  plate.translate(0, 2.6, 0)
  parts.push(plate)
  return parts.length > 1 ? mergeGeometries(parts) : parts[0]
}

export interface Placement {
  p: Vec2
  rotY: number
}

export interface FurniturePlacements {
  lamps: Placement[]
  benches: Placement[]
  bins: Placement[]
  signs: Placement[]
}

// Side channel for the physics collider builder: generated furniture positions
// exist only inside buildFurniture, and userData would leak into the visual
// GLB via GLTFExporter's extras serialization — a module ref avoids that.
export const furniturePlacements: { current: FurniturePlacements | null } = { current: null }

/** Generated + OSM street furniture, instanced per kind. */
export function buildFurniture(graph: CityGraph, ctx: ResolvedContext): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Street furniture'

  // OSM-mapped furniture positions (authoritative where present)
  const osmLamps = graph.points.filter((p) => p.kind === 'street_lamp')
  const osmBenches = graph.points.filter((p) => p.kind === 'bench')
  const osmBins = graph.points.filter((p) => p.kind === 'waste_basket')

  const lamps: Placement[] = osmLamps.map((p) => ({ p: p.position, rotY: hash01(p.id) * Math.PI * 2 }))
  const benches: Placement[] = osmBenches.map((p) => ({ p: p.position, rotY: hash01(p.id) * Math.PI * 2 }))
  const bins: Placement[] = osmBins.map((p) => ({ p: p.position, rotY: 0 }))
  const signs: Placement[] = []

  const nearExistingLamp = (p: Vec2) => lamps.some((l) => (l.p.x - p.x) ** 2 + (l.p.z - p.z) ** 2 < 64)

  for (const r of graph.roads) {
    if (!FURNITURE_ROADS.has(r.roadClass) || r.bridge || r.tunnel || r.points.length < 2) continue
    const L = polyLen(r.points)
    if (L < 20) continue
    const mid = r.points[Math.floor(r.points.length / 2)]
    const zone = ctx.zoneAt(mid)
    const rules = propRulesFor(zone)

    // streetlights: alternate sides, zone spacing, seeded jitter
    if (rules.lampSpacing) {
      let side = hash01(r.id + ':side') > 0.5 ? 1 : -1
      for (let d = rules.lampSpacing * 0.5; d < L; d += rules.lampSpacing) {
        const jitter = (hash01(`${r.id}:lj${d}`) - 0.5) * 6
        const { p, dir } = alongWithDir(r.points, Math.min(Math.max(d + jitter, 2), L - 2))
        const across = { x: -dir.z * side, z: dir.x * side }
        const lp = { x: p.x + across.x * (r.widthM / 2 + 1.1), z: p.z + across.z * (r.widthM / 2 + 1.1) }
        if (ctx.landCoverAt(lp) !== 'water' && !nearExistingLamp(lp)) {
          lamps.push({ p: lp, rotY: Math.atan2(-across.x, -across.z) })
        }
        side = -side
      }
    }

    // benches & bins in social zones, on the sidewalk
    if (rules.benchDensity > 0) {
      const count = Math.floor((rules.benchDensity * L) / 100 + hash01(r.id + ':bseed') * 0.8)
      for (let i = 0; i < count; i++) {
        const d = (0.15 + 0.7 * hash01(`${r.id}:b${i}`)) * L
        const side = hash01(`${r.id}:bs${i}`) > 0.5 ? 1 : -1
        const { p, dir } = alongWithDir(r.points, d)
        const across = { x: -dir.z * side, z: dir.x * side }
        const bp = { x: p.x + across.x * (r.widthM / 2 + 1.6), z: p.z + across.z * (r.widthM / 2 + 1.6) }
        if (ctx.landCoverAt(bp) !== 'water') benches.push({ p: bp, rotY: Math.atan2(-across.x, -across.z) + Math.PI })
      }
    }
    if (rules.binDensity > 0) {
      const count = Math.floor((rules.binDensity * L) / 100 + hash01(r.id + ':binseed') * 0.6)
      for (let i = 0; i < count; i++) {
        const d = (0.1 + 0.8 * hash01(`${r.id}:bin${i}`)) * L
        const side = hash01(`${r.id}:bins${i}`) > 0.5 ? 1 : -1
        const { p, dir } = alongWithDir(r.points, d)
        const across = { x: -dir.z * side, z: dir.x * side }
        const bp = { x: p.x + across.x * (r.widthM / 2 + 0.9), z: p.z + across.z * (r.widthM / 2 + 0.9) }
        if (ctx.landCoverAt(bp) !== 'water') bins.push({ p: bp, rotY: 0 })
      }
    }

    // regulatory sign near segment ends at junctions (probabilistic, seeded)
    for (const atEnd of [false, true]) {
      if (hash01(`${r.id}:sign${atEnd}`) > 0.35) continue
      const d = atEnd ? Math.max(L - 6, 2) : Math.min(6, L - 2)
      const { p, dir } = alongWithDir(r.points, d)
      const side = ctx.region.drivingSide === 'right' ? -1 : 1
      const across = { x: -dir.z * side, z: dir.x * side }
      const sp = { x: p.x + across.x * (r.widthM / 2 + 0.8), z: p.z + across.z * (r.widthM / 2 + 0.8) }
      if (ctx.landCoverAt(sp) !== 'water') signs.push({ p: sp, rotY: Math.atan2(dir.x, dir.z) })
    }
  }

  const poleMat = mats.signalPole
  const woodMat = new THREE.MeshStandardMaterial({ color: '#6b5138', roughness: 0.9 })
  const binMat = new THREE.MeshStandardMaterial({ color: '#3a4a3d', roughness: 0.8, metalness: 0.3 })
  const signMat = new THREE.MeshStandardMaterial({ color: '#c8cccf', roughness: 0.5, metalness: 0.4 })

  const addInstanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Placement[], name: string) => {
    if (!list.length) return
    const im = new THREE.InstancedMesh(geo, mat, list.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const s = new THREE.Vector3(1, 1, 1)
    const v = new THREE.Vector3()
    list.forEach((e, i) => {
      q.setFromAxisAngle(up, e.rotY)
      v.set(e.p.x, 0, e.p.z)
      m.compose(v, q, s)
      im.setMatrixAt(i, m)
    })
    im.instanceMatrix.needsUpdate = true
    im.castShadow = true
    im.name = name
    im.userData.objectId = 'furn_all'
    group.add(im)
  }

  addInstanced(lampGeometry(ctx.region.lampStyle), poleMat, lamps, `Streetlights (${lamps.length})`)
  addInstanced(benchGeometry(), woodMat, benches, `Benches (${benches.length})`)
  addInstanced(binGeometry(), binMat, bins, `Bins (${bins.length})`)
  addInstanced(signGeometry(ctx.region.signShape), signMat, signs, `Signs (${signs.length})`)
  group.userData.objectId = 'furn_all'
  group.userData.counts = { lamps: lamps.length, benches: benches.length, bins: bins.length, signs: signs.length }
  furniturePlacements.current = { lamps, benches, bins, signs }
  return group
}

function polyLen(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return l
}

function alongWithDir(pts: Vec2[], dist: number): { p: Vec2; dir: Vec2 } {
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
