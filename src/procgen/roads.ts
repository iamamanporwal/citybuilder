import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { hash01 } from '../resolver/resolve'
import { decalMaterials, roadMaterial, sidewalkMaterial } from '../materials/library'
import { mats } from './materials'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import polygonClipping from 'polygon-clipping'
import { crownedRibbonGeometry, mergeGeometries, offsetPolyline, planarUvXZ, pointAlong, polylineLength, raisedRibbonGeometry, ribbonGeometry, ringAreaM2, roundPolygon, smoothPolyline, trimPolyline, wallGeometry } from './geometry'
import { bankProfile, CROSS_SECTION, crossFade, crossOffset } from './crossSection'
import { analyzeRoadNodes, BRIDGE_LAYER_H, cumulative, discRadius, nodeKey, NON_DRIVABLE, segCenterline, siblingFootwayBridgeIds } from './roadNetwork'
import { buildRoadElevation, isCorridorElevationEnabled } from './corridor'
import { sampleTerrain } from './terrain/field'
import { TERRAIN } from './terrain/config'
import { DecalPlanner } from './decalPlan'
import { matchBridgeLandmark, type LandmarkEntry } from '../scene/landmarks'
import { buildArchBridge, buildSuspensionBridge, chainCenterlines, type LandmarkBridge } from './bridges'

// Deterministic procedural road system (PRD §8). Roads are generated from data,
// never from generative-3D, and are locked in the editor. Surfaces, markings and
// wear decals come from the Context Resolver; bridges/tunnels from OSM layer tags.

// vertical layer convention (see editor/depthConfig.ts LAYER_CONVENTION —
// linter-enforced, and proven against the depth-buffer quantum):
// Compressed paint stack (mirrors LAYER_CONVENTION in editor/depthConfig.ts):
// terrain 0 < water .012 < grass .022 < park .032 < sand .037 < forest .042
// < path .046 < road .05 < markings .055 < decals .06 < junction discs .065 < crosswalks .07 < sidewalk .22
// Paint sits a few mm above the road so it reads as paint (tires don't clip it);
// log-depth resolves the 4-5 mm gaps. Keep these in sync with LAYER_CONVENTION.
const Y_PATH = 0.046 // footway/cycleway/pedestrian: no junction nodes, cross carriageways untrimmed
const Y_ROAD = 0.05
const Y_MARK = 0.055
const Y_DECAL = 0.06
const Y_DISC = 0.065
const Y_CROSSWALK = 0.07
// Pedestrian plazas/streets sit on a raised slab (curb ~14 cm above grade) so
// they read as an uplifted pedestrian area rather than flush pavement.
const PLAZA_CURB_H = 0.14
// The curb's vertical face extends this far BELOW the road surface so the raised
// sidewalk slab always has supporting geometry buried in the ground (no floating
// curbs, even where the terrain beside a fill-embankment road dips below it).
const SIDEWALK_FOUNDATION = 0.35

// Stop lines sit on through-classes only (residential/service/living_street
// junctions in a dense old town would otherwise get a painted bar at every arm),
// just behind the crosswalk (which occupies inward 0.5–2.7 m) on the approach.
const STOP_LINE_CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary'])
const STOP_LINE_DIST = 3.15

// Junction bell-mouth (network-solve path only). The paved intersection PAD
// flares wider than the arms (JUNCTION_FLARE) and its corners are rounded with a
// curb-return radius so turns read as drivable and the pad hugs the roads — vs.
// the old bare disc / circle-union blob that bulged into the grass. Pad-only
// geometry: carriageway ribbons, sidewalks and markings are untouched, so the
// elevation/collider/renderer-parity guarantees all still hold. Flag-off keeps
// the exact legacy convex-hull/disc pad (byte-identical).
const JUNCTION_FLARE = 1.3
const junctionFilletR = (maxWidth: number) => Math.min(7, Math.max(2, maxWidth * 0.45))

export interface RoadBuildResult {
  roadMeshes: Map<string, THREE.Mesh>
  intersections: THREE.Mesh | null
  sidewalks: THREE.Mesh | null
  markings: THREE.Mesh | null
  markingsYellow: THREE.Mesh | null
  decals: THREE.Group | null
  bridges: THREE.Group | null
  portals: THREE.Group | null
  landmarkBridges: LandmarkBridge[]
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
  // ---- elevation: single source of truth (network solve when enabled, else
  // the legacy per-segment ramp). The collider builder and semantics exporter
  // read the same seam so all three agree on the y-channel.
  const elevation = buildRoadElevation(graph.roads)
  const consolidate = isCorridorElevationEnabled()

  // ---- pass-through joints (§15): a degree-2 node where two arms continue
  // near-collinearly at similar width is a WAY SPLIT, not a junction — the
  // smoothed centerlines + C¹ elevation make the seam tight, so it needs no
  // disc, no trim and no crosswalk. Without this every OSM way split stamps a
  // flat pancake that floats visibly on any ramp.
  const passThrough = new Set<string>()
  if (consolidate) {
    const armDirs = new Map<string, { d: Vec2; w: number }[]>()
    for (const r of graph.roads) {
      if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.points.length < 2) continue
      const ends: [Vec2, Vec2][] = [
        [r.points[0], r.points[1]],
        [r.points[r.points.length - 1], r.points[r.points.length - 2]],
      ]
      for (const [p, q] of ends) {
        const l = Math.hypot(q.x - p.x, q.z - p.z) || 1
        const k = nodeKey(p)
        let a = armDirs.get(k)
        if (!a) armDirs.set(k, (a = []))
        a.push({ d: { x: (q.x - p.x) / l, z: (q.z - p.z) / l }, w: r.widthM })
      }
    }
    for (const [k, arms] of armDirs) {
      if (arms.length !== 2) continue
      const [a, b] = arms
      const dot = a.d.x * b.d.x + a.d.z * b.d.z
      const ratio = Math.max(a.w, b.w) / Math.max(Math.min(a.w, b.w), 0.1)
      if (dot <= -0.866 && ratio <= 1.35) passThrough.add(k)
    }
  }

  const isJunction = (p: Vec2) =>
    (nodeUse.get(nodeKey(p))?.count ?? 0) >= 2 && !passThrough.has(nodeKey(p))
  const junctionRadius = (p: Vec2) => (nodeUse.get(nodeKey(p))?.maxWidth ?? 8) * 0.55
  // Crosswalks/stop lines belong at REAL junctions only: a consolidated
  // cluster or a degree-≥3 node — never at way splits.
  const realJunction = (p: Vec2) => {
    const k = nodeKey(p)
    return elevation.clusterOf(k) !== null || (nodeUse.get(k)?.count ?? 0) >= 3
  }

  // ---- consolidated junction clusters (§15): member discs per cluster, for
  // the merged junction patch and for trimming arms back to the patch edge.
  const clusterDiscs = new Map<string, { x: number; z: number; rad: number }[]>()
  for (const [k, info] of nodeUse) {
    const c = elevation.clusterOf(k)
    if (!c) continue
    let list = clusterDiscs.get(c)
    if (!list) clusterDiscs.set(c, (list = []))
    list.push({ x: info.p.x, z: info.p.z, rad: discRadius(info.maxWidth) })
  }
  /** Trim distance from an end of `pts` back to the cluster patch boundary, or null if unclustered. */
  const clusterExitTrim = (pts: Vec2[], atEnd: boolean): number | null => {
    const key = nodeKey(atEnd ? pts[pts.length - 1] : pts[0])
    const c = elevation.clusterOf(key)
    if (!c) return null
    const discs = clusterDiscs.get(c)
    if (!discs || discs.length < 2) return null
    const L = polylineLength(pts)
    const maxWalk = Math.min(L * 0.45, 60)
    let lastInside = -1
    for (let s = 0; s <= maxWalk; s += 0.75) {
      const { p } = pointAlong(pts, atEnd ? L - s : s)
      if (discs.some((d) => (p.x - d.x) ** 2 + (p.z - d.z) ** 2 <= d.rad * d.rad)) lastInside = s
    }
    if (lastInside < 0) return null
    return Math.min(lastInside + 0.6, maxWalk)
  }

  // OSM-mapped sidewalk ways of drivable bridges: dropped (the engine's bridges
  // render no separate sidewalks; these only ever showed up as floating strips).
  const siblingFootways = consolidate ? siblingFootwayBridgeIds(graph.roads) : new Set<string>()

  const roadMeshes = new Map<string, THREE.Mesh>()
  const sidewalkGeoms: THREE.BufferGeometry[] = []
  const white = new MarkingBuffer()
  const yellow = new MarkingBuffer()
  const whiteQuads = { pos: [] as number[], idx: [] as number[] }
  const bridgeGeoms: THREE.BufferGeometry[] = []
  const pierGeoms: THREE.BufferGeometry[] = []
  const portalBoxes: THREE.BufferGeometry[] = []

  // ---- landmark bridges (Golden Gate & co): grouped by catalog id so a bridge
  // split across several OSM ways builds ONE recognizable suspension structure.
  // Their deck surfaces still render per-segment; only the generic fascia+pier
  // superstructure is replaced by the dedicated generator.
  const PROCEDURAL_BRIDGES = new Set(['suspension-bridge', 'cable-stayed-bridge', 'stone-arch-bridge'])
  const landmarkGroups = new Map<string, { entry: LandmarkEntry; segs: RoadSegment[] }>()
  for (const r of graph.roads) {
    if (!r.bridge) continue
    const lm = matchBridgeLandmark(r)
    if (!lm || !PROCEDURAL_BRIDGES.has(lm.category)) continue
    // the arch generator builds a pedestrian stone bridge (solid parapets, stone
    // deck); a DRIVABLE arch bridge keeps its generic drivable deck + structure.
    if (lm.category === 'stone-arch-bridge' && !NON_DRIVABLE.has(r.roadClass)) continue
    if (!landmarkGroups.has(lm.id)) landmarkGroups.set(lm.id, { entry: lm, segs: [] })
    landmarkGroups.get(lm.id)!.segs.push(r)
  }
  // drop groups whose chained span is too short for their generator to fire, so
  // the generic bridge structure still covers those segments (no bare deck).
  const minSpanFor = (cat: string) => (cat === 'stone-arch-bridge' ? 40 : 45)
  for (const [id, g] of [...landmarkGroups]) {
    if (polylineLength(chainCenterlines(g.segs)) < minSpanFor(g.entry.category)) landmarkGroups.delete(id)
  }
  const landmarkRoadIds = new Set<string>()
  // arch-landmark decks are drawn by buildArchBridge at ONE unified height; their
  // per-segment ribbons are skipped (mixed OSM `layer` tags on the same bridge —
  // Charles Bridge spans layer 1 and 3 — would otherwise split the deck in two).
  const archLandmarkRoadIds = new Set<string>()
  for (const g of landmarkGroups.values()) {
    for (const s of g.segs) {
      landmarkRoadIds.add(s.id)
      if (g.entry.category === 'stone-arch-bridge') archLandmarkRoadIds.add(s.id)
    }
  }
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

    // arch-landmark decks (Charles Bridge) are built as one unified structure
    // after the loop — skip the per-segment surface so the deck is single-level.
    if (archLandmarkRoadIds.has(r.id)) continue
    // junction-internal links: the merged junction patch is their surface
    if (elevation.isInternal(r.id)) continue
    // mapped sidewalk ways of a drivable bridge: no separate ribbon
    if (siblingFootways.has(r.id)) continue

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

    // continuous reference line: smooth the OSM polyline (endpoints preserved),
    // bridges densified so a straight 2-point span still samples its elevation
    // hump (shared with colliders/semantics via segCenterline).
    const pts = segCenterline(r)
    const half = r.widthM / 2

    // trim the carriageway at junctions so ribbons never overlap co-planarly —
    // the junction surface (one layer up) covers the gap. At a consolidated
    // cluster the arm trims back to the MERGED patch boundary (not its own
    // node's disc), and bridge decks trim there too, so a deck no longer runs
    // through the middle of its bridgehead junction.
    let surfacePts = pts
    let startTrimApplied = 0
    {
      const c0 = clusterExitTrim(pts, false)
      const c1 = clusterExitTrim(pts, true)
      let t0: number
      let t1: number
      if (!r.bridge) {
        t0 = c0 ?? (isJunction(pts[0]) ? junctionRadius(pts[0]) * 0.72 : 0)
        t1 = c1 ?? (isJunction(pts[pts.length - 1]) ? junctionRadius(pts[pts.length - 1]) * 0.72 : 0)
      } else {
        t0 = c0 ?? 0
        t1 = c1 ?? 0
      }
      if (t0 || t1) {
        const full = trimPolyline(pts, t0, t1)
        const half2 = full ? null : trimPolyline(pts, t0 * 0.5, t1 * 0.5)
        if (full) {
          surfacePts = full
          startTrimApplied = t0
        } else if (half2) {
          surfacePts = half2
          startTrimApplied = t0 * 0.5
        }
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
    const trueProfile = elevation.profileFor(r, cum)
    // A flat segment stays a scalar height so ribbonGeometry keeps its exact
    // up-normal fast path (legacy parity); any relief promotes to a per-point
    // profile. Bridges are always elevated, so decks remain per-point arrays.
    // The ribbon's profile is sampled at the TRIMMED stations (offset by the
    // applied start trim) — sampling the untrimmed stations onto trimmed
    // vertices shifted an elevated arm's heights by the trim length, stepping
    // the surface exactly at junction mouths.
    const elevated = trueProfile.some((e) => Math.abs(e) > 1e-6)
    let profile: number[] | number = yBase
    if (elevated) {
      const stations =
        surfacePts === pts ? cum : cumulative(surfacePts).map((c) => c + startTrimApplied)
      profile = elevation.profileFor(r, stations).map((e) => e + yBase)
    }

    // Surface-relative layer heights (Road Corridor Redesign E4). Markings,
    // decals, crosswalks and sidewalks must ride the road surface: a fixed
    // global-Y offset stops meaning "above the road" the moment the elevation
    // solve lifts an at-grade road (a bridge approach), so they'd detach/float
    // (§1.4). `surfElev` returns the road's ADDED elevation (0 = grade) at any
    // 2D point by projecting it onto the centerline; a flat road returns a
    // constant 0, so every layer keeps its exact legacy Y — byte-identical.
    // Cross-section (#8 crown / #22 superelevation) — drivable carriageways only,
    // never paths. `fadeAt` ramps the crown to 0 within TAPER of each end so a
    // crowned mid-block meets the flat junction disc with no seam; `bankAt`
    // interpolates the curvature-derived superelevation. Both the surface geometry
    // AND surfElev use the SAME station (measured along `pts`) so every riding
    // layer (markings/decals/crosswalks) tracks the crowned surface exactly.
    const crownOn = CROSS_SECTION.enabled && !isPath
    const rideLayers = elevated || crownOn
    const lenPts = polylineLength(pts)
    const bankArr = crownOn ? bankProfile(pts) : []
    const bankAt = (station: number): number => {
      if (!crownOn || bankArr.length === 0) return 0
      let i = 1
      while (i < cum.length && cum[i] < station) i++
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(i, cum.length - 1)
      const span = cum[i1] - cum[i0] || 1
      const t = Math.max(0, Math.min(1, (station - cum[i0]) / span))
      return bankArr[i0] + (bankArr[i1] - bankArr[i0]) * t
    }
    const fadeAt = (station: number): number => (crownOn ? crossFade(station, lenPts) : 0)
    const surfElev = surfaceElevSampler(pts, trueProfile, elevated, crownOn ? { half, bankAt, fadeAt } : null)
    const layerProfile = (line: Vec2[], layerY: number): number | number[] =>
      rideLayers ? line.map((p) => surfElev(p) + layerY) : layerY

    // Pedestrian ways (plazas / pedestrian streets) render as a RAISED slab with
    // a curb skirt — like a sidewalk — instead of a flush ribbon, so they read
    // as an uplifted pedestrian area, not pavement at road level. A raised slab
    // (bbox height > 0.1 m) is exempt from the flat-layer coplanar flicker check
    // (see resolver/lints.ts), so overlapping plaza ways stay safe. Footways/
    // cycleways/crossings stay flush (they cross carriageways untrimmed). Only
    // flat (non-elevated) pedestrian ways are raised; elevated ones stay flush.
    const isPlaza = r.roadClass === 'pedestrian' && !elevated
    // Paths/plazas are NOT in the road-elevation solve, so on relief they would
    // render at a fixed absolute Y and get buried under (or float over) the
    // terrain. Instead they ride the conformed terrain field directly: sampleTerrain
    // already has the drivable roads burned in, so a footway meets any carriageway
    // it crosses instead of hovering above the hillside. Flat world ⇒ sampleTerrain
    // returns 0 ⇒ the path keeps its exact legacy Y (byte-identical).
    // Waterfront paths (river greenways) ride the terrain down toward the shore,
    // but must never dip to the water surface — that would make the path ribbon
    // coplanar with the water and z-fight. Clamp to a boardwalk just above the
    // water level so a shore path floats cleanly over the water instead. (Flat
    // world: sampleTerrain 0 > the clamp, so paths keep their exact legacy Y.)
    const pathFloor = TERRAIN.waterSurfaceY + 0.06
    const groundAt = isPath
      ? left.map((_, i) => Math.max(sampleTerrain(surfacePts[i].x, surfacePts[i].z), pathFloor))
      : null
    let surface: THREE.BufferGeometry
    if (isPlaza) {
      surface = raisedRibbonGeometry(left, right, PLAZA_CURB_H, groundAt ?? 0)
    } else if (isPath) {
      surface = ribbonGeometry(left, right, groundAt!.map((g) => g + Y_PATH))
      planarUvXZ(surface)
    } else if (crownOn) {
      // Engineering cross-section: subdivided, crowned + superelevated ribbon.
      // fades/banks are keyed to the station along `pts` (startTrimApplied offsets
      // the trimmed surface vertices back onto the full centerline) so they match
      // surfElev exactly. crownedRibbonGeometry sets aLane; add the aWear gate.
      const surfCum = cumulative(surfacePts)
      const fades = surfCum.map((c) => fadeAt(startTrimApplied + c))
      const banks = surfCum.map((c) => bankAt(startTrimApplied + c))
      surface = crownedRibbonGeometry(left, right, profile, half, fades, banks)
      const vc = surface.getAttribute('position').count
      surface.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(vc).fill(1), 1))
    } else {
      surface = ribbonGeometry(left, right, profile)
      // Lane-space wear coords for the asphalt wear shader (#7). aLane: -1 (left
      // kerb) → +1 (right kerb) across the ribbon (ribbonGeometry emits left then
      // right per section, so even verts = left). aWear=1 flags a driven
      // carriageway; junction patches / paths / cobble lack it, so the wear shader
      // (gated by aWear) stays OFF there — no misfire where there is no lane frame.
      const vc = surface.getAttribute('position').count
      const lane = new Float32Array(vc)
      const wear = new Float32Array(vc)
      for (let i = 0; i < vc; i++) {
        lane[i] = i % 2 === 0 ? -1 : 1
        wear[i] = 1
      }
      surface.setAttribute('aLane', new THREE.BufferAttribute(lane, 1))
      surface.setAttribute('aWear', new THREE.BufferAttribute(wear, 1))
    }
    const mesh = new THREE.Mesh(surface, roadMaterial(res.surface, isPath ? 0 : hash01(r.id + ':uv')))
    mesh.name = r.name ?? `${r.roadClass} road`
    mesh.userData.objectId = r.id
    mesh.receiveShadow = true
    roadMeshes.set(r.id, mesh)

    // ---- bridge structure: fascia + rails + piers (landmark bridges get the
    // dedicated suspension generator instead, built after the loop)
    if (r.bridge && Array.isArray(profile)) {
      if (!landmarkRoadIds.has(r.id)) {
        const deck = profile // aligned with surfacePts/left/right stations
        // fascia + rails only where the deck is genuinely elevated — a wall
        // along the near-grade ramp portion slices through the junction area
        // and the terrain (§15). Legacy (flag off) keeps the full-span wall.
        const runs: [number, number][] = []
        if (consolidate) {
          let a = -1
          for (let i = 0; i < deck.length; i++) {
            if (deck[i] - yBase > 0.8) {
              if (a < 0) a = i
            } else {
              if (a >= 0 && i - a >= 2) runs.push([a, i])
              a = -1
            }
          }
          if (a >= 0 && deck.length - a >= 2) runs.push([a, deck.length])
        } else {
          runs.push([0, deck.length])
        }
        for (const [a, b] of runs) {
          const dl = deck.slice(a, b)
          const fasciaBottom = dl.map((y) => y - 0.9)
          const railTop = dl.map((y) => y + 1.05)
          bridgeGeoms.push(wallGeometry(left.slice(a, b), fasciaBottom, railTop))
          bridgeGeoms.push(wallGeometry(right.slice(a, b), railTop, fasciaBottom))
        }
        const cumS = surfacePts === pts ? cum : cumulative(surfacePts)
        const L = cumS[cumS.length - 1]
        for (let d = 14; d < L - 10; d += 22) {
          const { p } = pointAlong(surfacePts, d)
          const elevHere = deck[nearestIndex(cumS, d)]
          if (elevHere > 3.5) {
            const pier = new THREE.CylinderGeometry(0.85, 1.0, elevHere - 0.35, 10)
            pier.translate(p.x, (elevHere - 0.35) / 2, p.z)
            pierGeoms.push(pier)
          }
        }
      }
      continue // no sidewalks/markings/decals on decks in this pass (P1: elevated markings)
    }

    const drivable = !NON_DRIVABLE.has(r.roadClass) && r.roadClass !== 'service'

    // ---- sidewalks from resolved cross-section, trimmed at junctions
    // (at a consolidated cluster: back to the merged patch boundary)
    if (res.crossSection.sidewalks) {
      const sw = res.crossSection.sidewalkWidth
      const cs = clusterExitTrim(pts, false)
      const ce = clusterExitTrim(pts, true)
      const startTrim = cs !== null ? cs + sw : isJunction(pts[0]) ? junctionRadius(pts[0]) + sw : 0
      const endTrim =
        ce !== null
          ? ce + sw
          : isJunction(pts[pts.length - 1])
            ? junctionRadius(pts[pts.length - 1]) + sw
            : 0
      const walkPts = trimPolyline(pts, startTrim, endTrim)
      if (walkPts && walkPts.length >= 2) {
        // Curb/sidewalk slab: top face at base+curbHeight (base = the road surface
        // it rides), and the vertical curb face runs DOWN past the road surface by
        // SIDEWALK_FOUNDATION so the curb always has supporting geometry embedded in
        // the ground and never floats — even on a fill embankment where the ground
        // beside the road dips below the carriageway. The top stays exactly
        // curbHeight above the road; only the skirt extends downward.
        const base = layerProfile(walkPts, 0)
        const foot = typeof base === 'number' ? base - SIDEWALK_FOUNDATION : base.map((b) => b - SIDEWALK_FOUNDATION)
        const slabH = res.crossSection.curbHeight + SIDEWALK_FOUNDATION
        for (const side of [1, -1]) {
          const inner = offsetPolyline(walkPts, side * (half + 0.05))
          const outer = offsetPolyline(walkPts, side * (half + sw))
          sidewalkGeoms.push(raisedRibbonGeometry(inner, outer, slabH, foot))
        }
      }
    }

    // ---- markings (region-correct via resolver)
    if (drivable && r.lanes >= 1) {
      const cs = clusterExitTrim(pts, false)
      const ce = clusterExitTrim(pts, true)
      // crosswalks/stop lines only at REAL junctions (cluster or degree ≥ 3);
      // way splits used to paint crosswalks in the middle of nowhere.
      const startJ = consolidate ? realJunction(pts[0]) : isJunction(pts[0])
      const endJ = consolidate ? realJunction(pts[pts.length - 1]) : isJunction(pts[pts.length - 1])
      const markPts = trimPolyline(
        pts,
        cs ?? (isJunction(pts[0]) ? junctionRadius(pts[0]) : 0),
        ce ?? (isJunction(pts[pts.length - 1]) ? junctionRadius(pts[pts.length - 1]) : 0),
      )
      if (markPts && markPts.length >= 2) {
        const buf = res.marking.centerColor === 'yellow' ? yellow : white
        const markElev = (line: Vec2[]) => layerProfile(line, Y_MARK)
        if (!r.oneway && r.lanes >= 2) {
          if (res.marking.centerPattern === 'double-solid') {
            for (const off of [0.18, -0.18]) {
              buf.addRibbon(ribbonGeometry(offsetPolyline(markPts, off + 0.06), offsetPolyline(markPts, off - 0.06), markElev(markPts)))
            }
          } else if (res.marking.centerPattern === 'solid') {
            buf.addRibbon(ribbonGeometry(offsetPolyline(markPts, 0.08), offsetPolyline(markPts, -0.08), markElev(markPts)))
          } else {
            dashedLine(markPts, 0, buf, markElev)
          }
        } else if (r.oneway && r.lanes >= 2) {
          for (let laneLine = 1; laneLine < Math.min(r.lanes, 4); laneLine++) {
            dashedLine(markPts, -half + (r.widthM / r.lanes) * laneLine, white, markElev)
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
              const cwY = rideLayers ? surfElev(c) + Y_CROSSWALK : Y_CROSSWALK
              pushQuad(whiteQuads.pos, whiteQuads.idx, c, inward, 1.1, across, res.marking.crosswalk === 'ladder' ? 0.3 : 0.4, cwY)
            }
            if (res.marking.crosswalk === 'ladder') {
              for (const edge of [-1.3, 1.3]) {
                const c = { x: endPt.x + inward.x * (1.6 + edge), z: endPt.z + inward.z * (1.6 + edge) }
                const cwY = rideLayers ? surfElev(c) + Y_CROSSWALK : Y_CROSSWALK
                pushQuad(whiteQuads.pos, whiteQuads.idx, c, inward, 0.12, across, (stripes * 1.6) / 2 + 0.4, cwY)
              }
            }

            // ---- stop line: a solid transverse bar just behind the crosswalk on
            // the approach, on the driving-side half of a two-way carriageway
            // (full width one-way). Only on through-classes so tiny old-town
            // junctions don't get a bar at every arm.
            if (STOP_LINE_CLASSES.has(r.roadClass) && polylineLength(markPts) > STOP_LINE_DIST + 0.6) {
              const lat = r.oneway ? 0 : (ctx.region?.drivingSide === 'left' ? 1 : -1) * (r.widthM / 4)
              const halfWid = r.oneway ? r.widthM / 2 - 0.2 : r.widthM / 4 - 0.1
              const c = {
                x: endPt.x + inward.x * STOP_LINE_DIST + across.x * lat,
                z: endPt.z + inward.z * STOP_LINE_DIST + across.z * lat,
              }
              const y = rideLayers ? surfElev(c) + Y_CROSSWALK : Y_CROSSWALK
              pushQuad(whiteQuads.pos, whiteQuads.idx, c, inward, 0.3, across, halfWid, y)
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
            const decalY = rideLayers ? surfElev(c) + Y_DECAL : Y_DECAL
            pushQuad(q.pos, q.idx, c, dir, s, across, s, decalY, q.uv)
          }
        }
      }
    }

    // ---- turn-lane arrows (§8.3). Oneway roads only, where turn:lanes maps 1:1
    // to lanes L→R across the carriageway. Painted near the exit, surface-riding.
    if (drivable && r.oneway && r.turnLanes && r.turnLanes.length >= 1) {
      const Ls = polylineLength(surfacePts)
      if (Ls > 12) {
        const n = r.turnLanes.length
        const lw = r.widthM / n
        const { p, dir } = pointAlong(surfacePts, Ls - 5)
        const w = { x: dir.z, z: -dir.x } // left normal (leftmost lane at +half)
        for (let i = 0; i < n; i++) {
          const off = half - (i + 0.5) * lw
          const center = { x: p.x + w.x * off, z: p.z + w.z * off }
          const y = rideLayers ? surfElev(center) + Y_MARK : Y_MARK
          pushTurnArrow(whiteQuads, center, dir, w, r.turnLanes[i], y)
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
  const keptDiscs: { x: number; z: number; rad: number; elev: number }[] = []

  // External arms entering each consolidated cluster (internal links excluded):
  // used to mesh ONE rounded, flared junction pad per cluster (the union of the
  // arm mouths) instead of a blobby union of member discs. Each arm carries its
  // own node position so a spread-out bridgehead pad still hugs every mouth.
  const clusterArms = new Map<string, { p: Vec2; d: Vec2; h: number }[]>()
  if (consolidate) {
    for (const r of graph.roads) {
      if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.points.length < 2) continue
      if (elevation.isInternal(r.id)) continue
      const h = r.widthM / 2
      const ends: [Vec2, Vec2][] = [
        [r.points[0], r.points[1]],
        [r.points[r.points.length - 1], r.points[r.points.length - 2]],
      ]
      for (const [p, q] of ends) {
        const c = elevation.clusterOf(nodeKey(p))
        if (!c) continue
        const l = Math.hypot(q.x - p.x, q.z - p.z) || 1
        let a = clusterArms.get(c)
        if (!a) clusterArms.set(c, (a = []))
        a.push({ p, d: { x: (q.x - p.x) / l, z: (q.z - p.z) / l }, h })
      }
    }
  }

  // ---- consolidated junction patches (§15): ONE merged surface per cluster —
  // the union of its member discs — at the cluster's single solved height,
  // instead of a stack of per-node pancakes at mixed heights. Member discs
  // seed the containment list so leftover single discs inside a patch drop.
  for (const [canonical, discs] of [...clusterDiscs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (discs.length < 2) continue
    const zc = elevation.nodeElevation(canonical)

    // Preferred: ONE rounded pad = the boolean UNION of every external arm's
    // rectangle (each anchored at its OWN node, run out to the trimmed ribbon and
    // flared) — the true junction footprint, concave notches included, rather than
    // the convex hull of the mouths (which fills the notches into a blob). Corners
    // rounded with a curb-return fillet, filled with the road material.
    let padded = false
    const arms = clusterArms.get(canonical)
    if (arms && arms.length >= 2) {
      const maxW = Math.max(...discs.map((d) => d.rad)) / 0.58
      let ring = armUnionRing(discs[0] as unknown as Vec2, arms, (a) => a.h * 1.16 + 1.5, JUNCTION_FLARE)
      if (ring.length >= 3) {
        ring = roundPolygon(ring, junctionFilletR(maxW))
        const g = junctionPatchGeometry([ring.map((p) => [p.x, p.z] as [number, number])], zc + Y_DISC)
        if (g) {
          discGeoms.push(g)
          padded = true
        }
      }
    }
    // Fallback (degenerate arm set): the previous circle-union blob.
    if (!padded) {
      let mp: [number, number][][][]
      try {
        const polys = discs.map((d) => [circleRing(d)])
        mp = polygonClipping.union(polys[0] as never, ...(polys.slice(1) as never[])) as [number, number][][][]
      } catch {
        mp = discs.map((d) => [circleRing(d)])
      }
      for (const poly of mp) {
        const g = junctionPatchGeometry(poly, zc + Y_DISC)
        if (g) discGeoms.push(g)
      }
    }
    for (const d of discs) keptDiscs.push({ x: d.x, z: d.z, rad: d.rad, elev: zc })
  }

  // Arms meeting each node (drivable, at-grade): direction pointing AWAY from the
  // node into the road, plus the road half-width. Used to mesh a junction as the
  // convex hull of its arm mouths — a polygon that hugs the roads — instead of a
  // fat disc that bulges into the grass as a visible circle.
  const armsAt = new Map<string, { d: Vec2; h: number }[]>()
  for (const r of graph.roads) {
    if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.points.length < 2) continue
    const h = r.widthM / 2
    const ends: [Vec2, Vec2][] = [
      [r.points[0], r.points[1]],
      [r.points[r.points.length - 1], r.points[r.points.length - 2]],
    ]
    for (const [p, q] of ends) {
      const l = Math.hypot(q.x - p.x, q.z - p.z) || 1
      const key = nodeKey(p)
      let a = armsAt.get(key)
      if (!a) armsAt.set(key, (a = []))
      a.push({ d: { x: (q.x - p.x) / l, z: (q.z - p.z) / l }, h })
    }
  }

  const junctionNodes = [...nodeUse.entries()]
    .filter(([k, info]) => info.count >= 2 && !elevation.clusterOf(k) && !passThrough.has(k))
    .map(([k, info]) => ({ k, info, rad: discRadius(info.maxWidth) }))
    .sort((a, b) => b.rad - a.rad || (a.k < b.k ? -1 : 1))
  for (const { k, info, rad } of junctionNodes) {
    // Disc sits on the solved node height (network solve) so an intersection
    // that the elevation solve lifted rides with its approaches; flag-off this
    // returns the legacy per-node bridge elevation, so discs are byte-identical.
    const nodeElev = elevation.nodeElevation(k)
    const contained = keptDiscs.some(
      (o) => o.elev === nodeElev && Math.hypot(o.x - info.p.x, o.z - info.p.z) + rad <= o.rad + 1e-6,
    )
    if (!contained) {
      keptDiscs.push({ x: info.p.x, z: info.p.z, rad, elev: nodeElev })
      const arms = armsAt.get(k)
      // UNION of the arm rectangles → the true +/T/X/Y footprint (concave notches
      // and all), rounded at the corners with a curb-return fillet, filled with the
      // road material. The ribbons trim back to junctionRadius*0.72, so the pad
      // reaches a touch past that to lap onto each mouth. Falls back to the disc
      // only when the union degenerates or arms are unavailable. Flag-off keeps the
      // legacy convex-hull pad (byte-identical A/B).
      let g: THREE.BufferGeometry | null = null
      if (arms && arms.length >= 2) {
        let ring: Vec2[]
        if (consolidate) {
          const reach = junctionRadius(info.p) * 0.72 + 0.8
          ring = armUnionRing(info.p, arms, () => reach, JUNCTION_FLARE)
          if (ring.length >= 3) ring = roundPolygon(ring, junctionFilletR(info.maxWidth))
        } else {
          ring = junctionArmHull(info.p, arms, junctionRadius(info.p) * 0.72 - 0.6, 1)
        }
        if (ring.length >= 3) g = junctionPatchGeometry([ring.map((p) => [p.x, p.z] as [number, number])], nodeElev + Y_DISC)
      }
      if (!g) {
        const seg = Math.max(10, Math.min(24, Math.round(rad * 3)))
        const cg = new THREE.CircleGeometry(rad, seg)
        cg.rotateX(-Math.PI / 2)
        cg.translate(info.p.x, nodeElev + Y_DISC, info.p.z)
        g = planarUvXZ(nonIndexedToIndexed(cg))
      }
      discGeoms.push(g)
    }
    if (info.maxWidth >= 6 && nodeElev === 0 && hash01(k + ':mh') > 0.45) {
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

  // manholes on consolidated junction patches too (members left the singles
  // loop above): same seeds, same planner guard, at the cluster's ONE height.
  for (const [k, info] of [...nodeUse.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (info.count < 2 || !elevation.clusterOf(k) || passThrough.has(k)) continue
    if (info.maxWidth < 6 || elevation.nodeElevation(k) !== 0 || hash01(k + ':mh') <= 0.45) continue
    const off = (hash01(k + ':mo') - 0.5) * discRadius(info.maxWidth)
    const c = { x: info.p.x + off, z: info.p.z + off * 0.6 }
    if (decalPlanner.tryPlace(c, 0.45)) {
      const q = decalQuads.manhole
      pushQuad(q.pos, q.idx, c, { x: 1, z: 0 }, 0.45, { x: 0, z: 1 }, 0.45, Y_DISC + 0.015, q.uv)
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
    // DoubleSide is load-bearing: rails/fascias are single-quad walls, so a
    // one-sided material makes guardrails vanish when viewed from the deck
    // (the inside face is the back face) — they must read from every angle.
    const structMat = new THREE.MeshStandardMaterial({ color: '#9d9e97', roughness: 0.9, side: THREE.DoubleSide })
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

  // ---- landmark suspension bridges (one recognizable structure per catalog id)
  const landmarkBridges: LandmarkBridge[] = []
  for (const g of landmarkGroups.values()) {
    const centerline = smoothPolyline(chainCenterlines(g.segs))
    const width = Math.max(...g.segs.map((s) => s.widthM))
    const isArch = g.entry.category === 'stone-arch-bridge'
    let grp: THREE.Group | null
    if (isArch) {
      // arch decks use the MIN positive layer so a stray high `layer` tag on one
      // segment can't lift the whole (single-level) masonry bridge unrealistically.
      const layers = g.segs.map((s) => s.layer).filter((l) => l >= 1)
      const layer = layers.length ? Math.min(...layers) : 1
      grp = buildArchBridge(centerline, width, {
        color: g.entry.color ?? '#b8a883',
        deckY: BRIDGE_LAYER_H * layer + Y_ROAD,
        towers: true,
      })
    } else {
      // deck sits at the elevation solver's bridge height for this layer (see roadNetwork)
      const maxLayer = Math.max(1, ...g.segs.map((s) => s.layer || 1))
      grp = buildSuspensionBridge(centerline, width, {
        color: g.entry.color ?? '#9a9ea3',
        deckY: BRIDGE_LAYER_H * maxLayer + Y_ROAD,
      })
    }
    if (!grp) continue
    grp.name = g.entry.label
    const mid = g.segs[Math.floor(g.segs.length / 2)]
    landmarkBridges.push({
      id: `landmark_${g.entry.id}`,
      name: g.entry.label,
      wikidata: g.entry.wikidata?.[0],
      sketchfabQuery: g.entry.sketchfabQuery,
      structure: isArch ? 'stone-arch' : 'suspension',
      centerLat: mid.centerLat,
      centerLng: mid.centerLng,
      group: grp,
    })
  }

  return { roadMeshes, intersections, sidewalks, markings, markingsYellow, decals: decalsGroup, bridges, portals, landmarkBridges }

  // ---- local helpers ----

  function dashedLine(
    pts: Vec2[],
    offset: number,
    buf: MarkingBuffer,
    elev: (line: Vec2[]) => number | number[],
  ) {
    const linePts = offsetPolyline(pts, offset)
    const total = polylineLength(linePts)
    let d = 2
    while (d + 3 < total - 2) {
      const t = trimPolyline(linePts, d, Math.max(total - d - 3, 0))
      if (t && t.length >= 2) {
        buf.addRibbon(ribbonGeometry(offsetPolyline(t, 0.08), offsetPolyline(t, -0.08), elev(t)))
      }
      d += 9
    }
  }
}

function pickDecal(seed: number): 'crack' | 'stain' | 'patch' {
  return seed < 0.5 ? 'crack' : seed < 0.8 ? 'stain' : 'patch'
}

/** Append an up-facing triangle (auto-wound to a +Y normal, like pushQuad). */
function pushTri(pos: number[], idx: number[], q0: Vec2, q1: Vec2, q2: Vec2, y: number) {
  const e1x = q1.x - q0.x, e1z = q1.z - q0.z
  const e2x = q2.x - q0.x, e2z = q2.z - q0.z
  const base = pos.length / 3
  if (e1z * e2x - e1x * e2z >= 0) pos.push(q0.x, y, q0.z, q1.x, y, q1.z, q2.x, y, q2.z)
  else pos.push(q0.x, y, q0.z, q2.x, y, q2.z, q1.x, y, q1.z)
  idx.push(base, base + 1, base + 2)
}

/** OSM turn:lanes token → head rotation toward the left normal (radians). */
function turnAngle(turn: string): number {
  switch (turn.split(';')[0].trim()) {
    case 'left': return 0.7
    case 'slight_left':
    case 'merge_to_left': return 0.35
    case 'sharp_left': return 1.15
    case 'right': return -0.7
    case 'slight_right':
    case 'merge_to_right': return -0.35
    case 'sharp_right': return -1.15
    case 'reverse': return Math.PI
    default: return 0 // through / none / empty / unrecognised
  }
}

/** Lane-guidance arrow: straight shaft + a head bent per the turn indication. */
function pushTurnArrow(
  buf: { pos: number[]; idx: number[] },
  c: Vec2,
  u: Vec2,
  w: Vec2,
  turn: string,
  y: number,
) {
  const ang = turnAngle(turn)
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const hx = u.x * ca + w.x * sa
  const hz = u.z * ca + w.z * sa
  const hl = Math.hypot(hx, hz) || 1
  const h = { x: hx / hl, z: hz / hl }
  const hp = { x: h.z, z: -h.x } // perpendicular to the head
  const shaftC = { x: c.x - u.x * 0.2, z: c.z - u.z * 0.2 }
  pushQuad(buf.pos, buf.idx, shaftC, u, 0.75, w, 0.14, y)
  const tip = { x: c.x + h.x * 1.25, z: c.z + h.z * 1.25 }
  const bl = { x: c.x + h.x * 0.45 + hp.x * 0.42, z: c.z + h.z * 0.45 + hp.z * 0.42 }
  const br = { x: c.x + h.x * 0.45 - hp.x * 0.42, z: c.z + h.z * 0.45 - hp.z * 0.42 }
  pushTri(buf.pos, buf.idx, tip, bl, br, y)
}

/**
 * Road-surface elevation sampler for surface-riding layers (E4). Given the
 * smoothed centerline `pts` and its per-point ADDED elevation `profile`
 * (0 = grade, index-aligned with `pts`), returns the elevation at any 2D query
 * point by projecting it onto the nearest centerline segment and interpolating.
 * A flat road (`elevated === false`) returns a constant 0 so every derived layer
 * keeps its exact legacy global-Y constant — byte-identical, no promotion cost.
 */
interface CrownParams {
  half: number
  bankAt: (station: number) => number
  fadeAt: (station: number) => number
}

function surfaceElevSampler(
  pts: Vec2[],
  profile: number[],
  elevated: boolean,
  crown: CrownParams | null = null,
): (q: Vec2) => number {
  if ((!elevated && !crown) || pts.length < 2) return () => 0
  // cumulative station along the centerline, for crown fade/bank lookup
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
  return (q: Vec2): number => {
    let best = Infinity
    let bestElev = 0
    let bestStation = 0
    let bestPerp = 0
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x
      const az = pts[i - 1].z
      const dx = pts[i].x - ax
      const dz = pts[i].z - az
      const segLen2 = dx * dx + dz * dz || 1
      let t = ((q.x - ax) * dx + (q.z - az) * dz) / segLen2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = ax + dx * t
      const pz = az + dz * t
      const d2 = (q.x - px) * (q.x - px) + (q.z - pz) * (q.z - pz)
      if (d2 < best) {
        best = d2
        const e0 = profile[i - 1]
        const e1 = profile[Math.min(i, profile.length - 1)]
        bestElev = elevated ? e0 + (e1 - e0) * t : 0
        if (crown) {
          const segLen = Math.sqrt(segLen2)
          bestStation = cum[i - 1] + t * segLen
          // signed perpendicular distance (left-normal (-dz, dx) / segLen)
          bestPerp = ((q.x - px) * -dz + (q.z - pz) * dx) / segLen
        }
      }
    }
    if (!crown) return bestElev
    const ln = Math.max(-1, Math.min(1, bestPerp / crown.half))
    return bestElev + crown.fadeAt(bestStation) * crossOffset(ln, crown.half, crown.bankAt(bestStation))
  }
}

function nearestIndex(cum: number[], d: number): number {
  for (let i = 0; i < cum.length; i++) if (cum[i] >= d) return i
  return cum.length - 1
}

/**
 * Junction outline = boolean UNION of one rectangle per arm. Each arm's rectangle
 * runs from just BEHIND the node (so all arms overlap and fill the throat) out to
 * its trimmed mouth, at the road's full width. The union of those rectangles is
 * exactly the +/T/X/Y footprint the arms make — including the CONCAVE notches
 * between arms, which a convex hull cannot represent (it fills the notches, giving
 * the oval/blob this replaces). Returns the largest ring of the union, or [] when
 * it degenerates (caller falls back to the disc). `reachFor` gives each arm's
 * outward extent (its ribbon trim), `flare` widens the mouths so turns read.
 */
interface UnionArm { p?: Vec2; d: Vec2; h: number }
function armUnionRing(
  center: Vec2,
  arms: UnionArm[],
  reachFor: (a: UnionArm) => number,
  flare: number,
): Vec2[] {
  const rects: [number, number][][] = []
  for (const a of arms) {
    const o = a.p ?? center
    const perp = { x: a.d.z, z: -a.d.x }
    const h = a.h * flare
    const back = a.h + 1.5 // start behind the node so every arm overlaps at the centre
    const reach = reachFor(a)
    const bx = o.x - a.d.x * back, bz = o.z - a.d.z * back
    const fx = o.x + a.d.x * reach, fz = o.z + a.d.z * reach
    rects.push([
      [bx + perp.x * h, bz + perp.z * h],
      [fx + perp.x * h, fz + perp.z * h],
      [fx - perp.x * h, fz - perp.z * h],
      [bx - perp.x * h, bz - perp.z * h],
      [bx + perp.x * h, bz + perp.z * h],
    ])
  }
  // Curb-return corner fills: the union of arm rectangles leaves an open concave
  // NOTCH in every corner between two adjacent arms (the diagonal wedges of a +/T/X
  // have no arm to cover them) — that is the bare grass the intersection showed
  // through. Bridge each real corner by filling the wedge out to where the two
  // arms' outer side-edges intersect (the natural curb-return apex), so the paved
  // junction reads as one continuous surface. Only genuine corners are filled
  // (25°–155° between arms): collinear pass-throughs and acute dual-carriageway
  // slivers are skipped so nothing bulges into the grass behind a straight road.
  for (const rect of armCornerFills(center, arms, reachFor, flare)) rects.push(rect)
  if (rects.length < 1) return []
  let merged: [number, number][][][]
  try {
    const polys = rects.map((r) => [r])
    merged = polygonClipping.union(polys[0] as never, ...(polys.slice(1) as never[])) as [number, number][][][]
  } catch {
    return []
  }
  // the union of arms sharing a node is one connected body — keep its largest ring
  let best: Vec2[] = []
  let bestA = 0
  for (const poly of merged) {
    const ring = poly[0]
    if (!ring || ring.length < 4) continue
    const v = ring.map(([x, z]) => ({ x, z }))
    if (v.length > 1 && Math.hypot(v[0].x - v[v.length - 1].x, v[0].z - v[v.length - 1].z) < 1e-6) v.pop()
    const a = ringAreaM2(v)
    if (a > bestA) { bestA = a; best = v }
  }
  return best
}

/**
 * Curb-return fill polygons for the concave notches between adjacent arms. For each
 * pair of arms that form a genuine corner (25°–155° apart), fill the wedge from the
 * throat out to the intersection of their two outer side-edges (the curb-return
 * apex), so the diagonal gaps a +/T/X leaves between its arms are paved rather than
 * showing grass. Skips near-collinear pairs (a road passing straight through, whose
 * union has no notch) and acute slivers (parallel dual carriageways). Each fill is a
 * closed ring `[o A, mouth A, apex, mouth B, o B]`; the caller unions them with the
 * arm rectangles, so overlap is dissolved and the result stays a simple polygon.
 */
function armCornerFills(
  center: Vec2,
  arms: UnionArm[],
  reachFor: (a: UnionArm) => number,
  flare: number,
): [number, number][][] {
  if (arms.length < 2) return []
  const sorted = [...arms].sort((p, q) => Math.atan2(p.d.z, p.d.x) - Math.atan2(q.d.z, q.d.x))
  const fills: [number, number][][] = []
  for (let i = 0; i < sorted.length; i++) {
    const A = sorted[i]
    const B = sorted[(i + 1) % sorted.length]
    const dot = Math.max(-1, Math.min(1, A.d.x * B.d.x + A.d.z * B.d.z))
    const theta = Math.acos(dot) // undirected angle between the two arms
    if (theta < 0.44 || theta > 2.70) continue // ~25°..~155°: real corners only
    const oA = A.p ?? center
    const oB = B.p ?? center
    const perpA = { x: A.d.z, z: -A.d.x }
    const perpB = { x: B.d.z, z: -B.d.x }
    // the side of each arm that faces the other arm
    const sideA = perpA.x * B.d.x + perpA.z * B.d.z >= 0 ? 1 : -1
    const sideB = perpB.x * A.d.x + perpB.z * A.d.z >= 0 ? 1 : -1
    const hA = A.h * flare
    const hB = B.h * flare
    const reachA = reachFor(A)
    const reachB = reachFor(B)
    // outer side-edge of each arm (a point on it + its direction)
    const eAx = oA.x + perpA.x * sideA * hA, eAz = oA.z + perpA.z * sideA * hA
    const eBx = oB.x + perpB.x * sideB * hB, eBz = oB.z + perpB.z * sideB * hB
    // mouth corners on those facing edges
    const mA: [number, number] = [eAx + A.d.x * reachA, eAz + A.d.z * reachA]
    const mB: [number, number] = [eBx + B.d.x * reachB, eBz + B.d.z * reachB]
    // apex = intersection of the two outer side-edge lines
    const den = A.d.x * -B.d.z - A.d.z * -B.d.x
    let apex: [number, number]
    const maxOut = Math.max(reachA, reachB) * 1.9
    if (Math.abs(den) > 1e-4) {
      const t = ((eBx - eAx) * -B.d.z - (eBz - eAz) * -B.d.x) / den
      apex = [eAx + A.d.x * t, eAz + A.d.z * t]
      // reject an apex that shoots far out (shallow corner) — chamfer instead
      if (t < 0 || Math.hypot(apex[0] - oA.x, apex[1] - oA.z) > maxOut) apex = [(mA[0] + mB[0]) / 2, (mA[1] + mB[1]) / 2]
    } else {
      apex = [(mA[0] + mB[0]) / 2, (mA[1] + mB[1]) / 2]
    }
    const ring: [number, number][] = [[oA.x, oA.z], mA, apex, mB, [oB.x, oB.z], [oA.x, oA.z]]
    fills.push(ring)
  }
  return fills
}

/**
 * Junction fill polygon = convex hull of every arm's two mouth corners at the
 * setback distance from the node, plus the node itself (keeps degenerate 2-arm
 * cases non-empty). Bounded by the roads, so — unlike the disc it replaces — it
 * never bulges into the surrounding grass/sidewalk as a circle.
 */
function junctionArmHull(center: Vec2, arms: { d: Vec2; h: number }[], setback: number, flare = 1): Vec2[] {
  const pts: Vec2[] = [center]
  for (const a of arms) {
    const perp = { x: a.d.z, z: -a.d.x }
    const bx = center.x + a.d.x * setback
    const bz = center.z + a.d.z * setback
    pts.push({ x: bx + perp.x * a.h * flare, z: bz + perp.z * a.h * flare })
    pts.push({ x: bx - perp.x * a.h * flare, z: bz - perp.z * a.h * flare })
  }
  return convexHull(pts)
}

/** Andrew's monotone-chain convex hull in the XZ plane (CCW in (x, z)). */
function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  if (pts.length < 3) return pts
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** Closed 24-gon ring approximating a junction disc, for the polygon union. */
function circleRing(d: { x: number; z: number; rad: number }): [number, number][] {
  const SEG = 24
  const ring: [number, number][] = []
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2
    ring.push([d.x + Math.cos(a) * d.rad, d.z + Math.sin(a) * d.rad])
  }
  ring.push([...ring[0]])
  return ring
}

/**
 * Mesh one polygon (outer ring + holes) of a consolidated junction patch as an
 * up-facing surface at height `y`, with world-planar UVs (same idempotent-
 * overdraw property as the single discs it replaces).
 */
function junctionPatchGeometry(poly: [number, number][][], y: number): THREE.BufferGeometry | null {
  const toV2 = (ring: [number, number][]): THREE.Vector2[] => {
    const pts = ring.map(([x, z]) => new THREE.Vector2(x, z))
    if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop()
    return pts
  }
  const contour = toV2(poly[0])
  if (contour.length < 3) return null
  const holes = poly.slice(1).map(toV2).filter((h) => h.length >= 3)
  let faces: number[][]
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  } catch {
    return null
  }
  if (!faces.length) return null
  const all = contour.concat(...holes)
  const pos = new Float32Array(all.length * 3)
  all.forEach((p, i) => pos.set([p.x, y, p.y], i * 3))
  const idx: number[] = []
  for (const f of faces) idx.push(f[0], f[1], f[2])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  // wind up-facing: +Y normals like every other flat road layer
  const a = all[idx[0]]
  const b = all[idx[1]]
  const c = all[idx[2]]
  if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]
      idx[i + 1] = idx[i + 2]
      idx[i + 2] = t
    }
    g.setIndex(idx)
  }
  const normals = new Float32Array(all.length * 3)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return planarUvXZ(g)
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
