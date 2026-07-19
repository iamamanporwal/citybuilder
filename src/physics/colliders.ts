import * as THREE from 'three'
import type { CityGraph, PointFeature, RoadSegment, Transform, Vec2 } from '../types'
import type { RoadResolution } from '../resolver/types'
import { hash01 } from '../resolver/resolve'
import {
  offsetPolyline,
  pointAlong,
  polylineLength,
  ribbonGeometry,
  raisedRibbonGeometry,
  ringAreaM2,
  ringIsSimple,
  smoothPolyline,
  trimPolyline,
  mergeGeometries,
  type Rect,
} from '../procgen/geometry'
import { flatRingGeometry, waterRings } from '../procgen/areas'
import { sampleTerrain } from '../procgen/terrain/field'
import { isTerrainEnabled } from '../procgen/terrain/config'
import { terrainGridGeometry } from '../procgen/terrain/mesh'
import {
  analyzeRoadNodes,
  cumulative,
  discRadius,
  nodeKey,
  NON_DRIVABLE,
  segCenterline,
  siblingFootwayBridgeIds,
  type RoadNodeInfo,
} from '../procgen/roadNetwork'
import { buildRoadElevation, type RoadElevation } from '../procgen/corridor'
import { curbsideDevicePosition, nearestRoadInfo } from '../procgen/signMath'
import type { FurniturePlacements } from '../procgen/props'
import { CLASS_PHYSICS, SURFACE_PHYSICS } from './materials'
import type { ColliderClass, ColliderDescriptor, ColliderSet } from './types'

// Collider generation from semantic city data (CityGraph + resolutions) — never
// from visual mesh clones. Road/sidewalk surfaces mirror the visual layer
// heights (Y_ROAD_COL, curbHeight) so tires touch the rendered surface, but
// road ribbons are UNTRIMMED at junctions and junction discs sit at road height
// (not the visual +6cm anti-z-fighting offset) so physics has one continuous
// drivable surface with no steps. See editor/depthConfig.ts for the rendering
// layer convention this deliberately does NOT replicate.

// mirrors Y_ROAD in procgen/roads.ts — the visual road surface height
const Y_ROAD_COL = 0.05

export interface PropExtent {
  radius?: number
  halfHeight?: number
  box?: [number, number, number] // half-extents
}

export interface BuildCollidersOptions {
  /** Live SceneObject transforms for movable objects (buildings/props). */
  placements?: Map<string, Transform>
  /** Deleted or hidden object ids — no collider emitted. */
  excluded?: Set<string>
  /** Benches/bins/signs get colliders (default false — decorative clutter). */
  includeMinorProps?: boolean
  /** Generated lamp/bench/bin/sign placements from procgen/props side channel. */
  furniturePlacements?: FurniturePlacements | null
  /** Measured extents from live registry variants (AI-replaced props). */
  propExtents?: Map<string, PropExtent>
  /** Driving side for curbside relocation of un-placed oriented devices (default right). */
  drivingSide?: 'left' | 'right'
}

// Editable point props whose collider may be nudged to the kerb when a raw OSM
// node lands inside a driving lane AND no live placement exists (headless / pure
// builds). In production these carry a live placement from the store, so the
// collider tracks the visible mesh exactly (correspondence) and this never fires;
// it only keeps the pure/headless collider set free of in-lane obstacles. Trees
// are excluded — they are numerous, thin, and displaced out of lanes by roadScale.
const RELOCATABLE_PROP_KINDS = new Set<PointFeature['kind']>([
  'traffic_signal', 'stop_sign', 'give_way', 'road_sign', 'bus_stop', 'fountain', 'statue',
])

const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1]

function yawQuaternion(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
}

/** Strip render attributes; guarantee an index (Rapier/GLB trimeshes need one). */
function toTrimesh(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  if (!g.getIndex()) {
    const count = g.getAttribute('position').count
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
    for (let i = 0; i < count; i++) idx[i] = i
    g.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  return g
}

function sanitizeId(featureId: string): string {
  return featureId.replace(/[/:]/g, '_')
}

export function buildColliders(
  graph: CityGraph,
  roadResolutions: Map<string, RoadResolution>,
  opts: BuildCollidersOptions = {},
): ColliderSet {
  const excluded = opts.excluded ?? new Set<string>()
  const colliders: ColliderDescriptor[] = []
  const nodes = analyzeRoadNodes(graph.roads)
  // Same elevation seam the renderer reads, so collider heights mirror the
  // visual road surface exactly (the parity contract in the header comment).
  const elevation = buildRoadElevation(graph.roads)

  // ---- bounds (same padded rect as scene/registry.ts terrain)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const r of graph.roads) for (const p of r.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  if (!isFinite(minX)) { minX = -500; maxX = 500; minZ = -500; maxZ = 500 }
  const pad = 120
  const bounds: Rect = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }

  roadColliders(graph, roadResolutions, elevation, colliders)
  intersectionColliders(nodes, elevation, colliders)
  sidewalkColliders(graph, roadResolutions, nodes, colliders)
  bridgeRailColliders(graph, elevation, colliders)
  portalColliders(graph, nodes, colliders)
  buildingColliders(graph, opts, excluded, colliders)
  terrainCollider(bounds, colliders)
  waterSensors(graph, bounds, colliders)
  barrierColliders(graph, excluded, colliders)
  propColliders(graph, opts, excluded, colliders)

  const stats = Object.fromEntries(
    (['road', 'intersection', 'sidewalk', 'building', 'terrain', 'barrier', 'prop', 'water'] as ColliderClass[]).map(
      (c) => [c, 0],
    ),
  ) as Record<ColliderClass, number>
  for (const c of colliders) stats[c.semantics.class]++
  return { colliders, bounds, stats }
}

// ---------------------------------------------------------------------------

function roadColliders(
  graph: CityGraph,
  resolutions: Map<string, RoadResolution>,
  elevation: RoadElevation,
  out: ColliderDescriptor[],
) {
  // mapped sidewalk ways of drivable bridges are not rendered (roads.ts §15) —
  // no floating invisible collider either. Empty set in legacy mode.
  const siblings = elevation.stats ? siblingFootwayBridgeIds(graph.roads) : new Set<string>()
  for (const r of graph.roads) {
    if (r.tunnel || r.points.length < 2) continue
    if (siblings.has(r.id)) continue
    // same reference line as the renderer (bridges densified so straight
    // 2-point spans carry their elevation hump into the collider too)
    const pts = segCenterline(r)
    const half = r.widthM / 2
    const cum = cumulative(pts)
    const profile = elevation.profileFor(r, cum).map((e) => e + Y_ROAD_COL)
    // untrimmed at junctions: physics tolerates overlap; trimming would leave
    // gaps under the visual junction discs
    const geometry = toTrimesh(
      ribbonGeometry(offsetPolyline(pts, half), offsetPolyline(pts, -half), profile),
    )
    const res = resolutions.get(r.id)
    const material = res
      ? { ...SURFACE_PHYSICS[res.surface], surfaceTag: res.surface }
      : { ...CLASS_PHYSICS.road }
    out.push({
      id: `col_road_${sanitizeId(r.id)}`,
      kind: 'trimesh',
      geometry,
      transform: { position: [0, 0, 0], quaternion: IDENTITY_Q },
      semantics: {
        class: 'road',
        featureId: r.id,
        roadClass: r.roadClass,
        drivable: !NON_DRIVABLE.has(r.roadClass),
        bridge: r.bridge || undefined,
        static: true,
      },
      material,
    })
  }
}

function intersectionColliders(
  nodes: Map<string, RoadNodeInfo>,
  elevation: RoadElevation,
  out: ColliderDescriptor[],
) {
  for (const [k, info] of nodes) {
    if (info.count < 2) continue
    const rad = discRadius(info.maxWidth)
    const seg = Math.max(10, Math.min(24, Math.round(rad * 3)))
    const g = new THREE.CircleGeometry(rad, seg)
    g.rotateX(-Math.PI / 2)
    // flat disc at ROAD height (not the visual +6cm junction offset), on the
    // SOLVED node elevation — consolidated cluster members all sit at one
    // height, so a car crosses a bridgehead without steps. The legacy adapter
    // returns bridgeElev here, keeping flag-off byte-identical.
    g.translate(info.p.x, elevation.nodeElevation(k) + Y_ROAD_COL, info.p.z)
    out.push({
      id: `col_intersection_${sanitizeId(k)}`,
      kind: 'trimesh',
      geometry: toTrimesh(g),
      transform: { position: [0, 0, 0], quaternion: IDENTITY_Q },
      semantics: { class: 'intersection', featureId: k, drivable: true, static: true },
      material: { ...CLASS_PHYSICS.intersection },
    })
  }
}

function sidewalkColliders(
  graph: CityGraph,
  resolutions: Map<string, RoadResolution>,
  nodes: Map<string, RoadNodeInfo>,
  out: ColliderDescriptor[],
) {
  const isJunction = (p: Vec2) => (nodes.get(nodeKey(p))?.count ?? 0) >= 2
  const junctionRadius = (p: Vec2) => (nodes.get(nodeKey(p))?.maxWidth ?? 8) * 0.55
  for (const r of graph.roads) {
    if (r.tunnel || r.bridge || r.points.length < 2) continue
    const res = resolutions.get(r.id)
    if (!res?.crossSection.sidewalks) continue
    const pts = smoothPolyline(r.points)
    const half = r.widthM / 2
    const sw = res.crossSection.sidewalkWidth
    // same junction trims as the visual sidewalks (sidewalks shouldn't cross intersections)
    const startTrim = isJunction(pts[0]) ? junctionRadius(pts[0]) + sw : 0
    const endTrim = isJunction(pts[pts.length - 1]) ? junctionRadius(pts[pts.length - 1]) + sw : 0
    const walkPts = trimPolyline(pts, startTrim, endTrim)
    if (!walkPts || walkPts.length < 2) continue
    const sides: THREE.BufferGeometry[] = []
    for (const side of [1, -1]) {
      const inner = offsetPolyline(walkPts, side * (half + 0.05))
      const outer = offsetPolyline(walkPts, side * (half + sw))
      sides.push(raisedRibbonGeometry(inner, outer, res.crossSection.curbHeight))
    }
    out.push({
      id: `col_sidewalk_${sanitizeId(r.id)}`,
      kind: 'trimesh',
      geometry: toTrimesh(mergeGeometries(sides)),
      transform: { position: [0, 0, 0], quaternion: IDENTITY_Q },
      semantics: { class: 'sidewalk', featureId: r.id, drivable: false, static: true },
      material: { ...CLASS_PHYSICS.sidewalk },
    })
  }
}

function bridgeRailColliders(graph: CityGraph, elevation: RoadElevation, out: ColliderDescriptor[]) {
  const RAIL_H = 1.05
  const RAIL_T = 0.12
  // same sibling rule as roadColliders: mapped bridge-sidewalk ways get no rails
  const siblings = elevation.stats ? siblingFootwayBridgeIds(graph.roads) : new Set<string>()
  for (const r of graph.roads) {
    if (!r.bridge || r.tunnel || r.points.length < 2) continue
    if (siblings.has(r.id)) continue
    const pts = segCenterline(r) // densified: rails ride the humped deck, not a flat chord
    const cum = cumulative(pts)
    const deck = elevation.profileFor(r, cum).map((e) => e + Y_ROAD_COL)
    const half = r.widthM / 2
    let n = 0
    for (const side of [1, -1]) {
      // centre the rail box just OUTSIDE the deck edge (+RAIL_T/2) so its inner
      // face sits exactly at the carriageway edge — otherwise the box straddles
      // the edge line and pokes RAIL_T/2 into the drivable lane at car height,
      // clipping a car that hugs the parapet.
      const rail = offsetPolyline(pts, side * (half + RAIL_T / 2))
      for (let i = 0; i + 1 < rail.length; i++) {
        const a = rail[i]
        const b = rail[i + 1]
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 0.2) continue
        const yaw = Math.atan2(-(b.z - a.z), b.x - a.x) // box local X along the edge
        const midDeck = (deck[i] + deck[i + 1]) / 2
        out.push({
          id: `col_barrier_${sanitizeId(r.id)}_rail${side > 0 ? 'L' : 'R'}${n++}`,
          kind: 'box',
          halfExtents: [len / 2, RAIL_H / 2, RAIL_T / 2],
          transform: {
            position: [(a.x + b.x) / 2, midDeck + RAIL_H / 2, (a.z + b.z) / 2],
            quaternion: yawQuaternion(yaw),
          },
          semantics: { class: 'barrier', featureId: r.id, bridge: true, static: true },
          material: { ...CLASS_PHYSICS.barrier },
        })
      }
    }
  }
}

function portalColliders(graph: CityGraph, nodes: Map<string, RoadNodeInfo>, out: ColliderDescriptor[]) {
  // portal frame dimensions mirror portalGeometry in procgen/roads.ts
  for (const r of graph.roads) {
    if (!r.tunnel || r.points.length < 2) continue
    for (const atEnd of [false, true]) {
      const endPt = atEnd ? r.points[r.points.length - 1] : r.points[0]
      const node = nodes.get(nodeKey(endPt))
      if (!(!node || node.hasSurface)) continue // same open-air transition check as the renderer
      const { dir } = pointAlong(r.points, atEnd ? polylineLength(r.points) - 0.5 : 0.5)
      const angle = Math.atan2(dir.x, dir.z)
      const ax = Math.cos(angle)
      const az = -Math.sin(angle)
      const half = r.widthM / 2 + 0.5
      const boxes: [number, number, number, number, number][] = [
        // [w, h, d, acrossOffset, y]
        [0.9, 5.4, 1.2, -half, 2.7],
        [0.9, 5.4, 1.2, half, 2.7],
        [r.widthM + 1.9, 1.1, 1.2, 0, 5.4],
      ]
      boxes.forEach(([w, h, d, ox, oy], i) => {
        out.push({
          id: `col_barrier_${sanitizeId(r.id)}_portal${atEnd ? 'B' : 'A'}${i}`,
          kind: 'box',
          halfExtents: [w / 2, h / 2, d / 2],
          transform: {
            position: [endPt.x + ax * ox, oy, endPt.z + az * ox],
            quaternion: yawQuaternion(angle),
          },
          semantics: { class: 'barrier', featureId: r.id, static: true },
          material: { ...CLASS_PHYSICS.barrier },
        })
      })
    }
  }
}

function buildingColliders(
  graph: CityGraph,
  opts: BuildCollidersOptions,
  excluded: Set<string>,
  out: ColliderDescriptor[],
) {
  for (const b of graph.buildings) {
    if (excluded.has(b.id)) continue
    const fp = b.footprint
    if (fp.length < 3 || !ringIsSimple(fp) || ringAreaM2(fp) < 1) continue // lint reports the count
    // centroid-local extrusion, same (x, -z) shape space as procgen/buildings.ts
    let cx = 0, cz = 0
    for (const p of fp) { cx += p.x; cz += p.z }
    cx /= fp.length; cz /= fp.length
    const pts2 = fp.map((p) => new THREE.Vector2(p.x - cx, -(p.z - cz)))
    if (THREE.ShapeUtils.isClockWise(pts2)) pts2.reverse()
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts2), { depth: b.heightM, bevelEnabled: false })
    geo.rotateX(-Math.PI / 2) // extrusion +z -> +y; base at y=0

    const live = opts.placements?.get(b.id)
    const position: [number, number, number] = live ? [...live.position] : [cx, sampleTerrain(cx, cz), cz]
    // yaw-only rotation: buildings are edited with a Y gizmo; other axes ignored
    const quaternion = live && live.rotation[1] !== 0 ? yawQuaternion(live.rotation[1]) : IDENTITY_Q
    out.push({
      id: `col_building_${sanitizeId(b.id)}`,
      kind: 'trimesh',
      geometry: toTrimesh(geo),
      transform: { position, quaternion },
      semantics: { class: 'building', featureId: b.id, static: true },
      material: { ...CLASS_PHYSICS.building },
    })
  }
}

function terrainCollider(bounds: Rect, out: ColliderDescriptor[]) {
  // Terrain relief on: the drive surface is the SAME displaced grid the renderer
  // shows (terrainGridGeometry), emitted as a trimesh so the car rolls over hills
  // and down into the river valley on exactly the mesh it sees. Water is still not
  // carved (the riverbed sits below the opaque surface); water sensors overlay.
  if (isTerrainEnabled()) {
    out.push({
      id: 'col_terrain_ground',
      kind: 'trimesh',
      geometry: toTrimesh(terrainGridGeometry(bounds)),
      transform: { position: [0, 0, 0], quaternion: IDENTITY_Q },
      semantics: { class: 'terrain', featureId: 'terrain_ground', static: true },
      material: { ...CLASS_PHYSICS.terrain },
    })
    return
  }
  // Terrain off: one flat box, top at y=0 (byte-identical to the pre-terrain build).
  const hx = (bounds.maxX - bounds.minX) / 2
  const hz = (bounds.maxZ - bounds.minZ) / 2
  out.push({
    id: 'col_terrain_ground',
    kind: 'box',
    halfExtents: [hx, 0.5, hz],
    transform: {
      position: [(bounds.minX + bounds.maxX) / 2, -0.5, (bounds.minZ + bounds.maxZ) / 2],
      quaternion: IDENTITY_Q,
    },
    semantics: { class: 'terrain', featureId: 'terrain_ground', static: true },
    material: { ...CLASS_PHYSICS.terrain },
  })
}

function waterSensors(graph: CityGraph, bounds: Rect, out: ColliderDescriptor[]) {
  const { carved, painted } = waterRings(graph.areas.filter((a) => a.kind === 'water'), bounds)
  const rings = [...carved, ...painted]
  rings.forEach((r, i) => {
    out.push({
      id: `col_water_${i}`,
      kind: 'trimesh',
      geometry: toTrimesh(flatRingGeometry(r.ring, 0)),
      transform: { position: [0, 0, 0], quaternion: IDENTITY_Q },
      semantics: { class: 'water', sensor: true, static: true },
      material: { ...CLASS_PHYSICS.water },
    })
  })
}

function barrierColliders(graph: CityGraph, excluded: Set<string>, out: ColliderDescriptor[]) {
  if (excluded.has('net_barriers')) return // aggregate hidden → no orphan wall colliders
  const THICK = 0.15
  for (const b of graph.barriers) {
    if (b.points.length < 2) continue
    const h = b.kind === 'wall' ? 1.6 : 1.15
    for (let i = 0; i + 1 < b.points.length; i++) {
      const a = b.points[i]
      const c = b.points[i + 1]
      const len = Math.hypot(c.x - a.x, c.z - a.z)
      if (len < 0.2) continue
      const yaw = Math.atan2(-(c.z - a.z), c.x - a.x)
      out.push({
        id: `col_barrier_${sanitizeId(b.id)}_${i}`,
        kind: 'box',
        halfExtents: [len / 2, h / 2, THICK / 2],
        transform: {
          position: [(a.x + c.x) / 2, h / 2, (a.z + c.z) / 2],
          quaternion: yawQuaternion(yaw),
        },
        semantics: { class: 'barrier', featureId: b.id, static: true },
        material: { ...CLASS_PHYSICS.barrier },
      })
    }
  }
}

interface PropShape {
  kind: 'box' | 'cylinder'
  radius?: number
  halfHeight?: number
  box?: [number, number, number]
  rotY?: number
  minor?: boolean
}

// Kinds whose colliders are owned by the generated-furniture side channel
// (furniturePlacements), NOT the raw graph.points loop. OSM maps these on the
// highway/sidewalk way; buildFurniture (procgen/props.ts) relocates them to the
// curb, proves carriageway clearance, and rides the solved elevation. Emitting
// them from graph.points too would double up — a SECOND solid collider at the
// raw OSM point (uncleared, y=0), which for a centreline-mapped lamp lands INSIDE
// a driving lane: the "invisible obstacle on the road" phantom. One owner only.
const FURNITURE_CHANNEL_KINDS = new Set<PointFeature['kind']>(['street_lamp', 'bench', 'waste_basket'])

/** True when q sits inside any drivable, at-grade carriageway (centerline ± half). */
function insideAnyLane(q: Vec2, graph: CityGraph): boolean {
  for (const r of graph.roads) {
    if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.bridge || r.points.length < 2 || !(r.widthM > 0)) continue
    const half = r.widthM / 2
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]
      const b = r.points[i]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz
      let t = len2 > 1e-9 ? ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      if (Math.hypot(q.x - (a.x + dx * t), q.z - (a.z + dz * t)) < half) return true
    }
  }
  return false
}

/**
 * Kerb position for an OSM-mapped oriented device (mapped ON the highway line),
 * clear of every drivable lane. Starts from the single-road kerb offset; if that
 * still lands in a lane (a junction/dual-carriageway where the nearest-road push
 * projects into a crossing lane), it searches both sides at growing offsets and
 * takes the first clear spot. Deterministic; production overrides via `live`.
 */
function clearDevicePosition(p: Vec2, graph: CityGraph, drivingSide: 'left' | 'right'): Vec2 {
  const near = nearestRoadInfo(p, graph.roads)
  const base = curbsideDevicePosition(p, near, drivingSide)
  if (!insideAnyLane(base, graph)) return base
  if (!near?.road || !near.point) return base
  const nrm = { x: -near.dir.z, z: near.dir.x }
  const half = near.road.widthM / 2
  const preferred = drivingSide === 'right' ? -1 : 1
  for (const off of [half + 0.7, half + 1.6, half + 2.8, half + 4.2]) {
    for (const s of [preferred, -preferred]) {
      const cand = { x: near.point.x + nrm.x * s * off, z: near.point.z + nrm.z * s * off }
      if (!insideAnyLane(cand, graph)) return cand
    }
  }
  return base // give up gracefully — the audit will flag if still in a lane
}

function propShapeFor(p: PointFeature): PropShape | null {
  switch (p.kind) {
    case 'tree':
      return { kind: 'cylinder', radius: 0.25, halfHeight: 1.6 } // trunk only — canopy overhangs
    case 'traffic_signal':
      return { kind: 'cylinder', radius: 0.12, halfHeight: 2.3 }
    case 'street_lamp':
      return { kind: 'cylinder', radius: 0.1, halfHeight: 3.7 }
    case 'fountain':
      // same seeded basin radius as propLibrary.buildFountain
      return { kind: 'cylinder', radius: 1.6 + hash01(p.id) * 1.6, halfHeight: 0.4 }
    case 'statue':
      return { kind: 'box', box: [0.75, 1.5, 0.75] }
    case 'bus_stop':
      // same seeded rotation as propLibrary.buildBusStop
      return { kind: 'box', box: [1.75, 1.3, 0.85], rotY: hash01(p.id + ':rot') * Math.PI * 2 }
    case 'bench':
      return { kind: 'box', box: [0.85, 0.45, 0.3], minor: true }
    case 'waste_basket':
      return { kind: 'cylinder', radius: 0.28, halfHeight: 0.43, minor: true }
    default:
      return null
  }
}

function propColliders(
  graph: CityGraph,
  opts: BuildCollidersOptions,
  excluded: Set<string>,
  out: ColliderDescriptor[],
) {
  const push = (
    id: string,
    shape: PropShape,
    propKind: string,
    pos: [number, number, number],
    rotY: number,
  ) => {
    const base: Pick<ColliderDescriptor, 'transform' | 'semantics' | 'material'> = {
      transform: {
        position: pos,
        quaternion: rotY !== 0 ? yawQuaternion(rotY) : IDENTITY_Q,
      },
      semantics: { class: 'prop', featureId: id, propKind, static: true },
      material: { ...CLASS_PHYSICS.prop },
    }
    if (shape.kind === 'cylinder') {
      out.push({
        id: `col_prop_${sanitizeId(id)}`,
        kind: 'cylinder',
        radius: shape.radius!,
        halfHeight: shape.halfHeight!,
        ...base,
        transform: { ...base.transform, position: [pos[0], pos[1] + shape.halfHeight!, pos[2]] },
      })
    } else {
      out.push({
        id: `col_prop_${sanitizeId(id)}`,
        kind: 'box',
        halfExtents: shape.box!,
        ...base,
        transform: { ...base.transform, position: [pos[0], pos[1] + shape.box![1], pos[2]] },
      })
    }
  }

  // aggregate-object exclusion: the store's editable objects are the render
  // aggregates (veg_trees, furn_all), not the individual features their colliders
  // are keyed by. Hiding an aggregate must therefore suppress its constituents
  // here, or the mesh vanishes while its colliders linger as orphans (the car
  // hits an invisible tree/lamp). Individually-editable props (signals, statues…)
  // already suppress by their own id via `excluded`.
  const treesHidden = excluded.has('veg_trees')
  const furnitureHidden = excluded.has('furn_all')

  for (const p of graph.points) {
    if (excluded.has(p.id)) continue
    // owned by the furniture channel below — never emit a second (phantom) collider
    if (FURNITURE_CHANNEL_KINDS.has(p.kind)) continue
    if (p.kind === 'tree' && treesHidden) continue
    const shape = propShapeFor(p)
    if (!shape || (shape.minor && !opts.includeMinorProps)) continue
    const ext = opts.propExtents?.get(p.id)
    if (ext) {
      if (shape.kind === 'cylinder' && ext.radius && ext.halfHeight) {
        shape.radius = ext.radius
        shape.halfHeight = ext.halfHeight
      } else if (shape.kind === 'box' && ext.box) {
        shape.box = ext.box
      }
    }
    // an un-placed editable prop mapped inside a lane is nudged to a kerb spot
    // clear of EVERY drivable lane (whole-network clearance, so a device at a
    // junction never lands in the crossing lane); props already clear are left
    // exactly where OSM mapped them.
    const live = opts.placements?.get(p.id)
    let base: Vec2 = p.position
    if (!live && RELOCATABLE_PROP_KINDS.has(p.kind) && insideAnyLane(p.position, graph)) {
      base = clearDevicePosition(p.position, graph, opts.drivingSide ?? 'right')
    }
    // seat the base on the terrain (matches building colliders) so a trunk on a
    // hillside or in a valley touches the visible ground instead of floating or
    // sinking at y=0. sampleTerrain returns 0 with terrain off (byte-identical).
    const pos: [number, number, number] = live
      ? [...live.position]
      : [base.x, sampleTerrain(base.x, base.z), base.z]
    const rotY = (live?.rotation[1] ?? 0) + (shape.rotY ?? 0)
    push(p.id, shape, p.kind, pos, rotY)
  }

  // generated street furniture (lamps always; benches/bins/signs are minor).
  // The base y is the placement's road-surface elevation (props on ramps/decks).
  const fp = furnitureHidden ? null : opts.furniturePlacements
  if (fp) {
    fp.lamps.forEach((l, i) =>
      push(`furn_lamp_${i}`, { kind: 'cylinder', radius: 0.1, halfHeight: 3.7 }, 'street_lamp', [l.p.x, l.y ?? 0, l.p.z], l.rotY),
    )
    if (opts.includeMinorProps) {
      fp.benches.forEach((b, i) =>
        push(`furn_bench_${i}`, { kind: 'box', box: [0.85, 0.45, 0.3] }, 'bench', [b.p.x, b.y ?? 0, b.p.z], b.rotY),
      )
      fp.bins.forEach((b, i) =>
        push(`furn_bin_${i}`, { kind: 'cylinder', radius: 0.28, halfHeight: 0.43 }, 'waste_basket', [b.p.x, b.y ?? 0, b.p.z], b.rotY),
      )
      fp.signs.forEach((s, i) =>
        push(`furn_sign_${i}`, { kind: 'cylinder', radius: 0.06, halfHeight: 1.3 }, 'sign', [s.p.x, s.y ?? 0, s.p.z], s.rotY),
      )
    }
  }
}
