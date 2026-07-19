import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { ingestOverpass } from '../ingest/overpass'
import { BRIDGE_LAYER_H, cumulative, nodeKey } from '../procgen/roadNetwork'
import { polylineLength, smoothPolyline } from '../procgen/geometry'
import { buildRoadGraph } from '../procgen/corridor/graph'
import { maxGradeFor } from '../procgen/corridor/config'
import { solveNetworkElevation } from '../procgen/corridor/elevation'
import { buildRoadElevation, withCorridorElevation } from '../procgen/corridor'

// Road Corridor Redesign — Stage 2 invariant suite (§6a E1). These are the
// contract for the network elevation solve: determinism, grade caps everywhere,
// C⁰ at junctions, C¹ at joints, bounded vertical curvature, NaN-safety, and
// renderer↔math parity generalised from bridges to every drivable segment.

// Materials build canvas textures at module load — stub them so buildRoads runs
// in plain node for the renderer-parity test (mirrors roadElevation.test.ts).
vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return {
    roadMaterial: mat,
    sidewalkMaterial: mat(),
    facadeMaterial: mat,
    roofMaterial: mat,
    decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() },
  }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => mat() }) }
})

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id,
    roadClass: 'residential',
    points,
    widthM: 8,
    lanes: 2,
    oneway: false,
    bridge: false,
    tunnel: false,
    layer: 0,
    centerLat: 0,
    centerLng: 0,
    ...over,
  }
}

/** Dense per-metre elevation profile of a road via the network solve. */
function sampleEdge(elev: ReturnType<typeof solveNetworkElevation>, r: RoadSegment) {
  const L = polylineLength(r.points)
  const cum: number[] = []
  for (let d = 0; d <= L + 1e-9; d += 1) cum.push(d)
  if (cum[cum.length - 1] < L) cum.push(L)
  return { cum, z: elev.profileFor(r, cum) }
}

function maxGrade(cum: number[], z: number[]): number {
  let g = 0
  for (let i = 1; i < z.length; i++) {
    const ds = cum[i] - cum[i - 1]
    if (ds > 1e-6) g = Math.max(g, Math.abs(z[i] - z[i - 1]) / ds)
  }
  return g
}

// ---------------------------------------------------------------------------

describe('RoadGraph topology (E0)', () => {
  it('classifies endpoints, joints and junctions and pins elevated structures', () => {
    const g = buildRoadGraph([
      road('w', [{ x: -100, z: 0 }, { x: 0, z: 0 }]),
      road('e', [{ x: 0, z: 0 }, { x: 100, z: 0 }]),
      road('n', [{ x: 0, z: 0 }, { x: 0, z: 100 }]),
      road('br', [{ x: 100, z: 0 }, { x: 160, z: 0 }], { bridge: true, layer: 1 }),
    ])
    expect(g.nodes.get(nodeKey({ x: -100, z: 0 }))!.kind).toBe('endpoint')
    expect(g.nodes.get(nodeKey({ x: 100, z: 0 }))!.kind).toBe('joint') // e ↔ br
    expect(g.nodes.get(nodeKey({ x: 0, z: 0 }))!.kind).toBe('junction') // w,e,n
    // far bridge node touched only by a bridge → pinned to the deck height
    const far = g.nodes.get(nodeKey({ x: 160, z: 0 }))!
    expect(far.pin).toBeCloseTo(BRIDGE_LAYER_H)
    // ramp foot carries an at-grade edge too → free
    expect(g.nodes.get(nodeKey({ x: 100, z: 0 }))!.pin).toBeNull()
  })

  it('drops degenerate self-loops and paths from the graph', () => {
    const g = buildRoadGraph([
      road('loop', [{ x: 0, z: 0 }, { x: 5, z: 5 }, { x: 0.1, z: 0.1 }]), // both ends snap together
      road('foot', [{ x: 0, z: 0 }, { x: 50, z: 0 }], { roadClass: 'footway' }),
    ])
    expect(g.edges.has('loop')).toBe(false)
    expect(g.edges.has('foot')).toBe(false)
  })
})

describe('network elevation solve (E1)', () => {
  // A chain climbing onto a bridge deck: endpoint → at-grade → at-grade → bridge.
  const chain = () => [
    road('a1', [{ x: 0, z: 0 }, { x: 100, z: 0 }]),
    road('a2', [{ x: 100, z: 0 }, { x: 200, z: 0 }]),
    road('br', [{ x: 200, z: 0 }, { x: 320, z: 0 }], { bridge: true, layer: 1 }),
  ]

  it('is deterministic — identical elevations on repeated solves', () => {
    const roads = chain()
    const a = solveNetworkElevation(roads)
    const b = solveNetworkElevation(roads)
    for (const key of ['a1', 'a2', 'br']) {
      const ra = sampleEdge(a, roads.find((r) => r.id === key)!)
      const rb = sampleEdge(b, roads.find((r) => r.id === key)!)
      expect(ra.z).toEqual(rb.z)
    }
  })

  it('grade cap holds on every at-grade edge', () => {
    const roads = chain()
    const elev = solveNetworkElevation(roads)
    for (const r of roads.filter((r) => !r.bridge)) {
      const { cum, z } = sampleEdge(elev, r)
      // cubic vertical curve peaks near 1.5× the mean grade; 1.6× matches the
      // existing eased-ramp allowance in roadElevation.test.ts
      expect(maxGrade(cum, z)).toBeLessThanOrEqual(maxGradeFor(r.roadClass) * 1.6 + 1e-6)
    }
  })

  it('C¹ continuity through a degree-2 joint (grades match across segments)', () => {
    const roads = chain()
    const elev = solveNetworkElevation(roads)
    const s1 = sampleEdge(elev, roads[0]) // a1, joint at its end
    const s2 = sampleEdge(elev, roads[1]) // a2, joint at its start
    const n1 = s1.z.length
    const gEndA1 = (s1.z[n1 - 1] - s1.z[n1 - 2]) / (s1.cum[n1 - 1] - s1.cum[n1 - 2])
    const gStartA2 = (s2.z[1] - s2.z[0]) / (s2.cum[1] - s2.cum[0])
    expect(gStartA2).toBeCloseTo(gEndA1, 2)
  })

  it('C⁰ continuity at a junction (all arms share the node height)', () => {
    const roads = [
      road('w', [{ x: -100, z: 0 }, { x: 0, z: 0 }]),
      road('e', [{ x: 0, z: 0 }, { x: 100, z: 0 }]),
      road('n', [{ x: 0, z: 0 }, { x: 0, z: 100 }]),
      road('s', [{ x: 0, z: 0 }, { x: 0, z: -100 }]),
      road('e2', [{ x: 100, z: 0 }, { x: 160, z: 0 }], { bridge: true, layer: 1 }),
    ]
    const elev = solveNetworkElevation(roads)
    const zc = elev.nodeElevation(nodeKey({ x: 0, z: 0 }))
    for (const r of roads.filter((r) => ['w', 'e', 'n', 's'].includes(r.id))) {
      const { z } = sampleEdge(elev, r)
      // the arm end that touches the centre must equal the node elevation
      const startsAtCentre = nodeKey({ x: r.points[0].x, z: r.points[0].z }) === nodeKey({ x: 0, z: 0 })
      const atCentre = startsAtCentre ? z[0] : z[z.length - 1]
      expect(atCentre).toBeCloseTo(zc, 6)
    }
  })

  it('vertical curvature is bounded (no kinks)', () => {
    const roads = chain()
    const elev = solveNetworkElevation(roads)
    for (const r of roads.filter((r) => !r.bridge)) {
      const { cum, z } = sampleEdge(elev, r)
      for (let i = 1; i < z.length - 1; i++) {
        const ds = (cum[i + 1] - cum[i - 1]) / 2
        const curv = Math.abs(z[i + 1] - 2 * z[i] + z[i - 1]) / (ds * ds)
        expect(Number.isFinite(curv)).toBe(true)
        expect(curv).toBeLessThan(0.05) // per-metre grade change stays gentle
      }
    }
  })

  it('bridges still reach the layer deck height and stay NaN-free', () => {
    const roads = [
      road('approach', [{ x: -120, z: 0 }, { x: 0, z: 0 }]),
      road('bridge', [{ x: 0, z: 0 }, { x: 300, z: 0 }], { bridge: true, layer: 1, roadClass: 'primary' }),
    ]
    const elev = solveNetworkElevation(roads)
    const { z } = sampleEdge(elev, roads[1])
    expect(Math.max(...z)).toBeCloseTo(BRIDGE_LAYER_H, 1)
    for (const y of z) expect(Number.isFinite(y)).toBe(true)
  })

  it('distributes a short bridge climb back through the approach chain', () => {
    // A short bridge cannot climb 6.5 m within its own length at grade — the
    // solve lifts the ramp-foot node so the approach shares the climb.
    const roads = [
      road('a', [{ x: 0, z: 0 }, { x: 200, z: 0 }], { roadClass: 'primary' }),
      road('short', [{ x: 200, z: 0 }, { x: 240, z: 0 }], { bridge: true, layer: 1, roadClass: 'primary' }),
    ]
    const elev = solveNetworkElevation(roads)
    const foot = elev.nodeElevation(nodeKey({ x: 200, z: 0 }))
    expect(foot).toBeGreaterThan(0.5) // the foot is lifted, not pinned to 0
    const { cum, z } = sampleEdge(elev, roads[0])
    expect(maxGrade(cum, z)).toBeLessThanOrEqual(maxGradeFor('primary') * 1.6 + 1e-6)
  })
})

describe('consumer seam parity', () => {
  it('flag-off returns the exact legacy per-segment profile', () => {
    const roads = [
      road('approach', [{ x: -80, z: 0 }, { x: 0, z: 0 }]),
      road('bridge', [{ x: 0, z: 0 }, { x: 300, z: 0 }], { bridge: true, layer: 1 }),
    ]
    const legacy = withCorridorElevation(false, () => {
      const e = buildRoadElevation(roads)
      return roads.map((r) => e.profileFor(r, cumulative(r.points)))
    })
    // legacy at-grade approach is flat zero; bridge peaks at the deck
    expect(legacy[0].every((y) => y === 0)).toBe(true)
    expect(Math.max(...legacy[1])).toBeCloseTo(BRIDGE_LAYER_H, 5)
  })

  it('renderer parity: buildRoads mesh Y equals profile + Y_ROAD for an elevated at-grade road (flag on)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const resolution: RoadResolution = {
      surface: 'asphalt-worn',
      marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
      crossSection: { sidewalks: false, sidewalkWidth: 2.4, curbHeight: 0.22 },
      decalDensity: 0,
      provenance: [],
      confidence: 1,
    }
    const roads = [
      road('appr', [{ x: 0, z: 0 }, { x: 200, z: 0 }], { roadClass: 'primary' }),
      road('br', [{ x: 200, z: 0 }, { x: 320, z: 0 }], { bridge: true, layer: 1, roadClass: 'primary' }),
    ]
    const graph = { roads } as unknown as CityGraph
    const resolutions = new Map(roads.map((r) => [r.id, resolution]))

    withCorridorElevation(true, () => {
      const result = buildRoads(graph, {} as ResolvedContext, resolutions)
      const elev = solveNetworkElevation(roads)
      const mesh = result.roadMeshes.get('appr')!
      expect(mesh).toBeDefined()
      const pts = smoothPolyline(roads[0].points)
      const cum = cumulative(pts)
      const expected = elev.profileFor(roads[0], cum).map((e) => e + 0.05) // Y_ROAD
      const pos = mesh.geometry.getAttribute('position')
      expect(pos.count).toBe(pts.length * 2)
      // the approach must actually be elevated (proves the solve reached the mesh)
      expect(Math.max(...expected)).toBeGreaterThan(0.1)
      for (let i = 0; i < pts.length; i++) {
        expect(pos.getY(i * 2)).toBeCloseTo(expected[i], 5)
        expect(pos.getY(i * 2 + 1)).toBeCloseTo(expected[i], 5)
      }
    })
  })
})

describe('surface layers ride the elevation (E4)', () => {
  const Y_ROAD = 0.05
  const Y_MARK = 0.16
  const CURB = 0.22

  const resolution = (sidewalks: boolean): RoadResolution => ({
    surface: 'asphalt-worn',
    marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
    crossSection: { sidewalks, sidewalkWidth: 2.4, curbHeight: CURB },
    decalDensity: 0,
    provenance: [],
    confidence: 1,
  })

  // A flat network around a REAL crossroads (degree 4, markings + sidewalks
  // emitted), no bridge → the solve settles every node to exactly 0, so E4 must
  // reproduce the legacy global-Y layer stack byte-for-byte (flag-on == flag-off).
  // Collinear degree-2 way splits are exercised separately below: junction
  // consolidation (§15) intentionally makes those CONTINUOUS with the flag on.
  const flatRoads = () => [
    road('a', [{ x: 0, z: 0 }, { x: 120, z: 0 }], { roadClass: 'primary' }),
    road('b', [{ x: 120, z: 0 }, { x: 240, z: 0 }], { roadClass: 'primary' }),
    road('c', [{ x: 120, z: -100 }, { x: 120, z: 0 }], { roadClass: 'primary' }),
    road('d', [{ x: 120, z: 0 }, { x: 120, z: 100 }], { roadClass: 'primary' }),
  ]

  it('flat crossroads is byte-identical with the flag on vs off (markings, sidewalks, road)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const run = (flag: boolean) =>
      withCorridorElevation(flag, () => {
        const roads = flatRoads()
        const graph = { roads } as unknown as CityGraph
        const res = new Map(roads.map((r) => [r.id, resolution(true)]))
        const r = buildRoads(graph, {} as ResolvedContext, res)
        const arr = (m: THREE.Mesh | null) =>
          m ? Array.from(m.geometry.getAttribute('position').array as Float32Array) : []
        return {
          road: arr(r.roadMeshes.get('a') ?? null),
          markings: arr(r.markings),
          sidewalks: arr(r.sidewalks),
        }
      })
    const off = run(false)
    const on = run(true)
    expect(on.road).toEqual(off.road)
    expect(on.markings).toEqual(off.markings)
    expect(on.sidewalks).toEqual(off.sidewalks)
    // sanity: the layers actually exist so this isn't vacuously comparing []
    expect(on.markings.length).toBeGreaterThan(0)
    expect(on.sidewalks.length).toBeGreaterThan(0)
  })

  it('collinear way split: continuous flag-on (no trim/disc), legacy disc flag-off (§15)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const run = (flag: boolean) =>
      withCorridorElevation(flag, () => {
        const roads = [
          road('a', [{ x: 0, z: 0 }, { x: 120, z: 0 }], { roadClass: 'primary' }),
          road('b', [{ x: 120, z: 0 }, { x: 240, z: 0 }], { roadClass: 'primary' }),
        ]
        const graph = { roads } as unknown as CityGraph
        const res = new Map(roads.map((r) => [r.id, resolution(false)]))
        const r = buildRoads(graph, {} as ResolvedContext, res)
        const pos = r.roadMeshes.get('a')!.geometry.getAttribute('position')
        let maxX = -Infinity
        for (let i = 0; i < pos.count; i++) maxX = Math.max(maxX, pos.getX(i))
        return { maxX, discs: r.intersections }
      })
    const on = run(true)
    const off = run(false)
    expect(on.maxX).toBeCloseTo(120, 3) // ribbon runs through the seam untrimmed
    expect(on.discs).toBeNull() // no pancake at the way split
    expect(off.maxX).toBeLessThan(120) // legacy keeps the trimmed seam + disc
    expect(off.discs).not.toBeNull()
  })

  // An elevated approach: a SHORT bridge deck cannot climb 6.5 m within its own
  // length at grade, so the solve lifts the ramp foot and the approach shares the
  // climb — a substantial, distributed lift the surface layers must ride. A fixed
  // global-Y would leave markings/curbs floating metres below the road.
  const elevatedRoads = () => [
    road('appr', [{ x: 0, z: 0 }, { x: 200, z: 0 }], { roadClass: 'primary' }),
    road('br', [{ x: 200, z: 0 }, { x: 240, z: 0 }], { bridge: true, layer: 1, roadClass: 'primary' }),
  ]

  it('lane markings ride the road surface (never leave the surface band)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    withCorridorElevation(true, () => {
      const roads = elevatedRoads()
      const graph = { roads } as unknown as CityGraph
      const res = new Map(roads.map((r) => [r.id, resolution(false)]))
      const result = buildRoads(graph, {} as ResolvedContext, res)
      const elev = solveNetworkElevation(roads)
      // road added-elevation band over the approach
      const pts = smoothPolyline(roads[0].points)
      const added = elev.profileFor(roads[0], cumulative(pts))
      const eMax = Math.max(...added)
      expect(eMax).toBeGreaterThan(1) // approach genuinely lifted (metres)
      const mpos = result.markings!.geometry.getAttribute('position')
      let markMax = -Infinity
      for (let i = 0; i < mpos.count; i++) {
        const y = mpos.getY(i)
        // every marking vertex is exactly Y_MARK above SOME road elevation on
        // the approach — i.e. it rides the surface, not a fixed plane at Y_MARK.
        expect(y - Y_MARK).toBeGreaterThanOrEqual(-1e-3)
        expect(y - Y_MARK).toBeLessThanOrEqual(eMax + 1e-3)
        markMax = Math.max(markMax, y)
      }
      // and the paint clearly lifted with the grade (would be flat Y_MARK before E4)
      expect(markMax).toBeGreaterThan(Y_MARK + 1)
    })
  })

  it('sidewalks/curbs ride the road surface (curb top stays curbHeight above the road)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    withCorridorElevation(true, () => {
      const roads = elevatedRoads()
      const graph = { roads } as unknown as CityGraph
      const res = new Map(roads.map((r) => [r.id, resolution(true)]))
      const result = buildRoads(graph, {} as ResolvedContext, res)
      const elev = solveNetworkElevation(roads)
      const pts = smoothPolyline(roads[0].points)
      const added = elev.profileFor(roads[0], cumulative(pts))
      const eMax = Math.max(...added)
      const spos = result.sidewalks!.geometry.getAttribute('position')
      let topMax = -Infinity
      let minY = Infinity
      for (let i = 0; i < spos.count; i++) {
        const y = spos.getY(i)
        // every slab vertex stays inside the road-elevation band + curb; before
        // E4 the slab was pinned to [0, curbHeight] regardless of the grade.
        expect(y).toBeLessThanOrEqual(eMax + CURB + 1e-3)
        topMax = Math.max(topMax, y)
        minY = Math.min(minY, y)
      }
      // curb top climbs with the road (near eMax+curb, less the junction trim);
      // the skirt now extends one foundation-depth below the road surface (so the
      // curb is anchored in the ground and never floats), but no further; and it
      // clearly lifted off the flat stack.
      const FOUNDATION = 0.35
      expect(topMax).toBeGreaterThan(eMax + CURB - 0.6)
      expect(minY).toBeGreaterThanOrEqual(-FOUNDATION - 1e-3)
      expect(topMax).toBeGreaterThan(CURB + 1)
    })
  })
})

describe('real-city solve (determinism, convergence, NaN-safety)', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/data/raw_osm.json', import.meta.url)), 'utf8'),
  )
  const graph = ingestOverpass(raw, 'Lower Manhattan')

  it('converges within budget with no grade violations on real data', () => {
    const elev = solveNetworkElevation(graph.roads)
    expect(elev.stats.converged).toBe(true)
    expect(elev.stats.gradeViolations).toBe(0)
  })

  it('produces finite elevations for every road and reproduces bit-for-bit', () => {
    const a = solveNetworkElevation(graph.roads)
    const b = solveNetworkElevation(graph.roads)
    for (const r of graph.roads) {
      const cum = cumulative(r.points)
      const za = a.profileFor(r, cum)
      const zb = b.profileFor(r, cum)
      expect(za).toEqual(zb)
      for (const y of za) expect(Number.isFinite(y)).toBe(true)
    }
  })
})
