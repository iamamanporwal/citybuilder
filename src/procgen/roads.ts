import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { hash01 } from '../resolver/resolve'
import { decalMaterials, roadMaterial, sidewalkMaterial } from '../materials/library'
import { mats } from './materials'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mergeGeometries, offsetPolyline, planarUvXZ, pointAlong, polylineLength, raisedRibbonGeometry, ribbonGeometry, smoothPolyline, trimPolyline, wallGeometry } from './geometry'
import { analyzeRoadNodes, cumulative, elevationProfile, nodeKey, NON_DRIVABLE, rampSpecFor } from './roadNetwork'
import { DecalPlanner } from './decalPlan'

// Deterministic procedural road system (PRD §8). Roads are generated from data,
// never from generative-3D, and are locked in the editor. Surfaces, markings and
// wear decals come from the Context Resolver; bridges/tunnels from OSM layer tags.

// vertical layer convention (see editor/depthConfig.ts LAYER_CONVENTION —
// linter-enforced, and proven against the depth-buffer quantum):
// terrain 0 < water .012 < grass .022 < park .032 < sand .037 < forest .042
// < path .046 < road .05 < decals .08 < junction discs .11 < markings .16 < crosswalks .175 < sidewalk .22
const Y_PATH = 0.046 // footway/cycleway/pedestrian: no junction nodes, cross carriageways untrimmed
const Y_ROAD = 0.05
const Y_DECAL = 0.08
const Y_DISC = 0.11
const Y_MARK = 0.16
const Y_CROSSWALK = 0.175

export interface RoadBuildResult {
  roadMeshes: Map<string, THREE.Mesh>
  intersections: THREE.Mesh | null
  sidewalks: THREE.Mesh | null
  markings: THREE.Mesh | null
  markingsYellow: THREE.Mesh | null
  decals: THREE.Group | null
  bridges: THREE.Group | null
  portals: THREE.Group | null
}

function pushQuad(
  positions: number[],
  indices: number[],
  c: Vec2,
  along: Vec2,
  halfLen: number,
  across: Vec2,
  halfWid: number,
  y: number,
  uvs?: number[],
) {
  const base = positions.length / 3
  const corners = [
    { x: c.x - along.x * halfLen - across.x * halfWid, z: c.z - along.z * halfLen - across.z * halfWid },
    { x: c.x + along.x * halfLen - across.x * halfWid, z: c.z + along.z * halfLen - across.z * halfWid },
    { x: c.x + along.x * halfLen + across.x * halfWid, z: c.z + along.z * halfLen + across.z * halfWid },
    { x: c.x - along.x * halfLen + across.x * halfWid, z: c.z - along.z * halfLen + across.z * halfWid },
  ]
  for (const p of corners) positions.push(p.x, y, p.z)
  uvs?.push(0, 0, 1, 0, 1, 1, 0, 1)
  indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
}

function geometryFromArrays(positions: number[], indices: number[], uvs?: number[]): THREE.BufferGeometry | null {
  if (positions.length === 0) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

class MarkingBuffer {
  pos: number[] = []
  idx: number[] = []
  addRibbon(g: THREE.BufferGeometry) {
    const p = g.getAttribute('position')
    const gi = g.getIndex()!
    const base = this.pos.length / 3
    for (let i = 0; i < p.count; i++) this.pos.push(p.getX(i), p.getY(i), p.getZ(i))
    for (let i = 0; i < gi.count; i++) this.idx.push(gi.getX(i) + base)
  }
}

export function buildRoads(
  graph: CityGraph,
  ctx: ResolvedContext,
  resolutions: Map<string, RoadResolution>,
): RoadBuildResult {
  // ---- junction detection (drivable classes only)
  const nodeUse = analyzeRoadNodes(graph.roads)
  const isJunction = (p: Vec2) => (nodeUse.get(nodeKey(p))?.count ?? 0) >= 2
  const junctionRadius = (p: Vec2) => (nodeUse.get(nodeKey(p))?.maxWidth ?? 8) * 0.55

  const roadMeshes = new Map<string, THREE.Mesh>()
  const sidewalkGeoms: THREE.BufferGeometry[] = []
  const white = new MarkingBuffer()
  const yellow = new MarkingBuffer()
  const whiteQuads = { pos: [] as number[], idx: [] as number[] }
  const bridgeGeoms: THREE.BufferGeometry[] = []
  const pierGeoms: THREE.BufferGeometry[] = []
  const portalBoxes: THREE.BufferGeometry[] = []
  const decalQuads: Record<keyof typeof decalMaterials, { pos: number[]; idx: number[]; uv: number[] }> = {
    crack: { pos: [], idx: [], uv: [] },
    stain: { pos: [], idx: [], uv: [] },
    patch: { pos: [], idx: [], uv: [] },
    manhole: { pos: [], idx: [], uv: [] },
  }
  const decalPlanner = new DecalPlanner()

  for (const r of graph.roads) {
    if (r.points.length < 2) continue
    const res = resolutions.get(r.id)
    if (!res) continue

    // ---- tunnels: no surface; portal frames at transitions to open air
    if (r.tunnel) {
      for (const atEnd of [false, true]) {
        const endPt = atEnd ? r.points[r.points.length - 1] : r.points[0]
        const node = nodeUse.get(nodeKey(endPt))
        if (!node || node.hasSurface) {
          const { dir } = pointAlong(r.points, atEnd ? polylineLength(r.points) - 0.5 : 0.5)
          portalBoxes.push(...portalGeometry(endPt, dir, r.widthM))
        }
      }
      continue
    }

    // continuous reference line: smooth the OSM polyline, endpoints preserved
    const pts = smoothPolyline(r.points)
    const half = r.widthM / 2

    // trim the carriageway at junctions so ribbons never overlap co-planarly —
    // the junction disc (one layer up) is the intersection surface
    let surfacePts = pts
    if (!r.bridge) {
      const t0 = isJunction(pts[0]) ? junctionRadius(pts[0]) * 0.72 : 0
      const t1 = isJunction(pts[pts.length - 1]) ? junctionRadius(pts[pts.length - 1]) * 0.72 : 0
      if (t0 || t1) {
        surfacePts = trimPolyline(pts, t0, t1) ?? trimPolyline(pts, t0 * 0.5, t1 * 0.5) ?? pts
      }
    }
    const left = offsetPolyline(surfacePts, half)
    const right = offsetPolyline(surfacePts, -half)

    // ---- elevation profile (bridges ramp from grade to layer height, grade-limited)
    // Paths (footway/cycleway/pedestrian) never register junction nodes, so
    // they cross carriageways and each other untrimmed. They render one layer
    // below the road surface, and with world-planar UVs + a shared material so
    // path-over-path overlap (plaza polylines) paints identical texels.
    const isPath = NON_DRIVABLE.has(r.roadClass)
    const yBase = isPath ? Y_PATH : Y_ROAD
    const cum = cumulative(pts)
    const spec = rampSpecFor(r, cum[cum.length - 1], nodeUse)
    let profile: number[] | number = yBase
    if (spec) profile = elevationProfile(spec, cum).map((e) => e + yBase)

    const surface = ribbonGeometry(left, right, profile)
    if (isPath) planarUvXZ(surface)
    const mesh = new THREE.Mesh(surface, roadMaterial(res.surface, isPath ? 0 : hash01(r.id + ':uv')))
    mesh.name = r.name ?? `${r.roadClass} road`
    mesh.userData.objectId = r.id
    mesh.receiveShadow = true
    roadMeshes.set(r.id, mesh)

    // ---- bridge structure: fascia + rails + piers
    if (r.bridge && Array.isArray(profile)) {
      const deck = profile
      const fasciaBottom = deck.map((y) => y - 0.9)
      const railTop = deck.map((y) => y + 1.05)
      bridgeGeoms.push(wallGeometry(left, fasciaBottom, railTop))
      bridgeGeoms.push(wallGeometry(right, railTop, fasciaBottom))
      const L = cum[cum.length - 1]
      for (let d = 14; d < L - 10; d += 22) {
        const { p } = pointAlong(pts, d)
        const elevHere = deck[nearestIndex(cum, d)]
        if (elevHere > 3.5) {
          const pier = new THREE.CylinderGeometry(0.85, 1.0, elevHere - 0.35, 10)
          pier.translate(p.x, (elevHere - 0.35) / 2, p.z)
          pierGeoms.push(pier)
        }
      }
      continue // no sidewalks/markings/decals on decks in this pass (P1: elevated markings)
    }

    const drivable = !NON_DRIVABLE.has(r.roadClass) && r.roadClass !== 'service'

    // ---- sidewalks from resolved cross-section, trimmed at junctions
    if (res.crossSection.sidewalks) {
      const sw = res.crossSection.sidewalkWidth
      const startTrim = isJunction(pts[0]) ? junctionRadius(pts[0]) + sw : 0
      const endTrim = isJunction(pts[pts.length - 1])
        ? junctionRadius(pts[pts.length - 1]) + sw
        : 0
      const walkPts = trimPolyline(pts, startTrim, endTrim)
      if (walkPts && walkPts.length >= 2) {
        for (const side of [1, -1]) {
          const inner = offsetPolyline(walkPts, side * (half + 0.05))
          const outer = offsetPolyline(walkPts, side * (half + sw))
          sidewalkGeoms.push(raisedRibbonGeometry(inner, outer, res.crossSection.curbHeight))
        }
      }
    }

    // ---- markings (region-correct via resolver)
    if (drivable && r.lanes >= 1) {
      const startJ = isJunction(pts[0])
      const endJ = isJunction(pts[pts.length - 1])
      const markPts = trimPolyline(
        pts,
        startJ ? junctionRadius(pts[0]) : 0,
        endJ ? junctionRadius(pts[pts.length - 1]) : 0,
      )
      if (markPts && markPts.length >= 2) {
        const buf = res.marking.centerColor === 'yellow' ? yellow : white
        if (!r.oneway && r.lanes >= 2) {
          if (res.marking.centerPattern === 'double-solid') {
            for (const off of [0.18, -0.18]) {
              buf.addRibbon(ribbonGeometry(offsetPolyline(markPts, off + 0.06), offsetPolyline(markPts, off - 0.06), Y_MARK))
            }
          } else if (res.marking.centerPattern === 'solid') {
            buf.addRibbon(ribbonGeometry(offsetPolyline(markPts, 0.08), offsetPolyline(markPts, -0.08), Y_MARK))
          } else {
            dashedLine(markPts, 0, buf)
          }
        } else if (r.oneway && r.lanes >= 2) {
          for (let laneLine = 1; laneLine < Math.min(r.lanes, 4); laneLine++) {
            dashedLine(markPts, -half + (r.widthM / r.lanes) * laneLine, white)
          }
        }

        // crosswalks at junction ends
        if (r.roadClass !== 'motorway' && r.widthM >= 5) {
          for (const [atEnd, junction] of [[false, startJ], [true, endJ]] as const) {
            if (!junction) continue
            const endPt = atEnd ? markPts[markPts.length - 1] : markPts[0]
            const { dir } = pointAlong(markPts, atEnd ? polylineLength(markPts) - 0.5 : 0.5)
            const inward = atEnd ? { x: -dir.x, z: -dir.z } : dir
            const across = { x: -inward.z, z: inward.x }
            const stripes = Math.max(3, Math.floor((r.widthM - 2) / 1.6))
            for (let s = 0; s < stripes; s++) {
              const lateral = -((stripes - 1) / 2) * 1.6 + s * 1.6
              const c = { x: endPt.x + inward.x * 1.6 + across.x * lateral, z: endPt.z + inward.z * 1.6 + across.z * lateral }
              pushQuad(whiteQuads.pos, whiteQuads.idx, c, inward, 1.1, across, res.marking.crosswalk === 'ladder' ? 0.3 : 0.4, Y_CROSSWALK)
            }
            if (res.marking.crosswalk === 'ladder') {
              for (const edge of [-1.3, 1.3]) {
                const c = { x: endPt.x + inward.x * (1.6 + edge), z: endPt.z + inward.z * (1.6 + edge) }
                pushQuad(whiteQuads.pos, whiteQuads.idx, c, inward, 0.12, across, (stripes * 1.6) / 2 + 0.4, Y_CROSSWALK)
              }
            }
          }
        }

        // ---- wear decals-as-content (seeded per segment). All decals share one
        // Y layer, so overlapping quads would be exactly coplanar — the planner
        // rejects any placement that intersects a decal already placed anywhere.
        if (res.decalDensity > 0 && res.surface.startsWith('asphalt')) {
          const L = polylineLength(markPts)
          const count = Math.floor((res.decalDensity * L) / 100 + hash01(r.id + ':dseed'))
          for (let i = 0; i < count; i++) {
            const t = hash01(`${r.id}:d${i}`)
            const { p, dir } = pointAlong(markPts, 3 + t * Math.max(L - 6, 1))
            const across = { x: -dir.z, z: dir.x }
            const lat = (hash01(`${r.id}:dl${i}`) - 0.5) * r.widthM * 0.55
            const c = { x: p.x + across.x * lat, z: p.z + across.z * lat }
            const kind = pickDecal(hash01(`${r.id}:dk${i}`))
            const s = 0.9 + hash01(`${r.id}:ds${i}`) * 1.4
            if (!decalPlanner.tryPlace(c, s)) continue
            const q = decalQuads[kind]
            pushQuad(q.pos, q.idx, c, dir, s, across, s, Y_DECAL, q.uv)
          }
        }
      }
    }
  }

  // ---- intersection surfaces + manholes
  // Junction discs share one Y layer and often overlap — OSM dual carriageways
  // put several junction nodes within a few meters. Two rules keep that from
  // z-fighting (exact coplanarity is unfixable by depth precision):
  //  1. a disc fully contained in an already-kept disc is dropped (pure overdraw);
  //  2. remaining discs get world-planar UVs, so overlapping discs sample
  //     identical texels — whichever triangle wins the depth tie paints the
  //     same pixel, and the overlap region reads as one continuous surface.
  const discGeoms: THREE.BufferGeometry[] = []
  const junctionNodes = [...nodeUse.entries()]
    .filter(([, info]) => info.count >= 2)
    .map(([k, info]) => ({ k, info, rad: info.maxWidth * 0.58 }))
    .sort((a, b) => b.rad - a.rad || (a.k < b.k ? -1 : 1))
  const keptDiscs: { x: number; z: number; rad: number; elev: number }[] = []
  for (const { k, info, rad } of junctionNodes) {
    const contained = keptDiscs.some(
      (o) => o.elev === info.bridgeElev && Math.hypot(o.x - info.p.x, o.z - info.p.z) + rad <= o.rad + 1e-6,
    )
    if (!contained) {
      keptDiscs.push({ x: info.p.x, z: info.p.z, rad, elev: info.bridgeElev })
      const seg = Math.max(10, Math.min(24, Math.round(rad * 3)))
      const g = new THREE.CircleGeometry(rad, seg)
      g.rotateX(-Math.PI / 2)
      g.translate(info.p.x, info.bridgeElev + Y_DISC, info.p.z)
      discGeoms.push(planarUvXZ(nonIndexedToIndexed(g)))
    }
    if (info.maxWidth >= 6 && info.bridgeElev === 0 && hash01(k + ':mh') > 0.45) {
      const off = (hash01(k + ':mo') - 0.5) * rad
      const c = { x: info.p.x + off, z: info.p.z + off * 0.6 }
      // manholes share the decal non-overlap budget: junction nodes a few
      // meters apart otherwise stamp exactly coplanar overlapping quads
      if (decalPlanner.tryPlace(c, 0.45)) {
        const q = decalQuads.manhole
        pushQuad(q.pos, q.idx, c, { x: 1, z: 0 }, 0.45, { x: 0, z: 1 }, 0.45, Y_DISC + 0.015, q.uv)
      }
    }
  }

  // ---- assemble merged meshes (welded: coincident vertices deduplicated)
  const asMesh = (geoms: THREE.BufferGeometry[], mat: THREE.Material, name: string, id: string) => {
    if (!geoms.length) return null
    const m = new THREE.Mesh(mergeVertices(mergeGeometries(geoms), 1e-3), mat)
    m.name = name
    m.userData.objectId = id
    m.receiveShadow = true
    return m
  }

  const intersections = asMesh(discGeoms, roadMaterial('asphalt-worn'), 'Intersections', 'net_intersections')
  const sidewalks = asMesh(sidewalkGeoms, sidewalkMaterial, 'Sidewalks & curbs', 'net_sidewalks')

  const whiteGeoms: THREE.BufferGeometry[] = []
  const wg1 = geometryFromArrays(white.pos, white.idx)
  if (wg1) whiteGeoms.push(wg1)
  const wg2 = geometryFromArrays(whiteQuads.pos, whiteQuads.idx)
  if (wg2) whiteGeoms.push(wg2)
  const markings = whiteGeoms.length ? new THREE.Mesh(whiteGeoms.length > 1 ? mergeNoUv(whiteGeoms) : whiteGeoms[0], mats.markingWhite) : null
  if (markings) {
    markings.name = 'Lane markings (white)'
    markings.userData.objectId = 'net_markings'
  }
  const yg = geometryFromArrays(yellow.pos, yellow.idx)
  const markingsYellow = yg ? new THREE.Mesh(yg, mats.markingYellow) : null
  if (markingsYellow) {
    markingsYellow.name = 'Lane markings (yellow)'
    markingsYellow.userData.objectId = 'net_markings_yellow'
  }

  let decalsGroup: THREE.Group | null = null
  for (const [kind, q] of Object.entries(decalQuads)) {
    const g = geometryFromArrays(q.pos, q.idx, q.uv)
    if (!g) continue
    decalsGroup ??= new THREE.Group()
    decalsGroup.add(new THREE.Mesh(g, decalMaterials[kind as keyof typeof decalMaterials]))
  }
  if (decalsGroup) {
    decalsGroup.name = 'Surface decals'
    decalsGroup.userData.objectId = 'net_decals'
    decalsGroup.traverse((o) => (o.userData.objectId = 'net_decals'))
  }

  let bridges: THREE.Group | null = null
  if (bridgeGeoms.length || pierGeoms.length) {
    bridges = new THREE.Group()
    bridges.name = 'Bridge structures'
    const structMat = new THREE.MeshStandardMaterial({ color: '#9d9e97', roughness: 0.9 })
    if (bridgeGeoms.length) bridges.add(new THREE.Mesh(mergeVertices(mergeGeometries(bridgeGeoms), 1e-3), structMat))
    if (pierGeoms.length) bridges.add(new THREE.Mesh(mergeGeometries(pierGeoms.map(nonIndexedToIndexed)), structMat))
    bridges.traverse((o) => {
      o.userData.objectId = 'net_bridges'
      o.castShadow = true
    })
  }

  let portals: THREE.Group | null = null
  if (portalBoxes.length) {
    portals = new THREE.Group()
    portals.name = 'Tunnel portals'
    const portalMat = new THREE.MeshStandardMaterial({ color: '#8c8d86', roughness: 0.95 })
    portals.add(new THREE.Mesh(mergeGeometries(portalBoxes.map(nonIndexedToIndexed)), portalMat))
    portals.traverse((o) => (o.userData.objectId = 'net_portals'))
  }

  return { roadMeshes, intersections, sidewalks, markings, markingsYellow, decals: decalsGroup, bridges, portals }

  // ---- local helpers ----

  function dashedLine(pts: Vec2[], offset: number, buf: MarkingBuffer) {
    const linePts = offsetPolyline(pts, offset)
    const total = polylineLength(linePts)
    let d = 2
    while (d + 3 < total - 2) {
      const t = trimPolyline(linePts, d, Math.max(total - d - 3, 0))
      if (t && t.length >= 2) {
        buf.addRibbon(ribbonGeometry(offsetPolyline(t, 0.08), offsetPolyline(t, -0.08), Y_MARK))
      }
      d += 9
    }
  }
}

function pickDecal(seed: number): 'crack' | 'stain' | 'patch' {
  return seed < 0.5 ? 'crack' : seed < 0.8 ? 'stain' : 'patch'
}

function nearestIndex(cum: number[], d: number): number {
  for (let i = 0; i < cum.length; i++) if (cum[i] >= d) return i
  return cum.length - 1
}

function portalGeometry(p: Vec2, dir: Vec2, width: number): THREE.BufferGeometry[] {
  const angle = Math.atan2(dir.x, dir.z)
  const make = (w: number, h: number, d: number, ox: number, oy: number): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(w, h, d)
    g.rotateY(angle)
    // offset along the across axis
    const ax = Math.cos(angle)
    const az = -Math.sin(angle)
    g.translate(p.x + ax * ox, oy, p.z + az * ox)
    return g
  }
  const half = width / 2 + 0.5
  return [
    make(0.9, 5.4, 1.2, -half, 2.7),
    make(0.9, 5.4, 1.2, half, 2.7),
    make(width + 1.9, 1.1, 1.2, 0, 5.4),
  ]
}

/** Merge geometries that may lack uv (markings don't need them). */
function mergeNoUv(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const g of geoms) g.deleteAttribute('uv')
  return mergeGeometries(geoms)
}

function nonIndexedToIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getIndex()) return g
  const count = g.getAttribute('position').count
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}
