import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { nodeKey, siblingFootwayBridgeIds } from '../procgen/roadNetwork'
import { solveNetworkElevation } from '../procgen/corridor'
import { withCorridorElevation } from '../procgen/corridor'

// Junction consolidation (§15): OSM maps one big junction as a cluster of
// nodes joined by short internal link ways. These tests pin the three core
// behaviours: contraction to ONE height, the grade-separation guard, and the
// renderer's merged patch / internal-edge handling.

vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { roadMaterial: mat, sidewalkMaterial: mat(), curbFrameMaterial: mat(), framedWalkMaterial: mat(), framedVergeMaterial: mat(), facadeMaterial: mat, roofMaterial: mat, decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() } }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => new THREE.MeshBasicMaterial() }) }
})

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id, roadClass: 'primary', points, widthM: 8, lanes: 2, oneway: false,
    bridge: false, tunnel: false, layer: 0, centerLat: 0, centerLng: 0, ...over,
  }
}

const resolution: RoadResolution = {
  surface: 'asphalt-worn',
  marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
  crossSection: { sidewalks: false, sidewalkWidth: 2.4, curbHeight: 0.22 },
  decalDensity: 0,
  provenance: [],
  confidence: 1,
}

describe('junction consolidation — solve', () => {
  // Two crossroads 6 m apart joined by a short internal link (a dual-
  // carriageway split): must contract into ONE cluster at ONE height.
  const dualCarriagewayJunction = () => [
    road('w1', [{ x: -100, z: 0 }, { x: 0, z: 0 }]),
    road('link', [{ x: 0, z: 0 }, { x: 6, z: 0 }]), // 6 m internal edge
    road('e1', [{ x: 6, z: 0 }, { x: 106, z: 0 }]),
    road('n1', [{ x: 0, z: -80 }, { x: 0, z: 0 }]),
    road('s1', [{ x: 6, z: 0 }, { x: 6, z: 80 }]),
  ]

  it('contracts a short internal edge: one cluster, one elevation, link flagged internal', () => {
    const elev = solveNetworkElevation(dualCarriagewayJunction())
    const kA = nodeKey({ x: 0, z: 0 })
    const kB = nodeKey({ x: 6, z: 0 })
    expect(elev.clusterOf(kA)).not.toBeNull()
    expect(elev.clusterOf(kA)).toBe(elev.clusterOf(kB))
    expect(elev.isInternal('link')).toBe(true)
    expect(elev.nodeElevation(kA)).toBe(elev.nodeElevation(kB))
    expect(elev.stats.clusters).toBe(1)
    expect(elev.stats.internalEdges).toBe(1)
  })

  it('internal edges profile flat at the cluster height', () => {
    const elev = solveNetworkElevation(dualCarriagewayJunction())
    const prof = elev.profileFor(road('link', [{ x: 0, z: 0 }, { x: 6, z: 0 }]), [0, 3, 6])
    const zc = elev.nodeElevation(nodeKey({ x: 0, z: 0 }))
    for (const v of prof) expect(v).toBe(zc)
  })

  it('grade separation guard: a deck node above a grade junction never merges', () => {
    // long bridge whose interior joint at (0,0) is pinned to deck height 6.5;
    // an at-grade crossroads sits 2.5 m away — vertically separated levels.
    const roads = [
      road('b1', [{ x: -150, z: 0 }, { x: 0, z: 0 }], { bridge: true, layer: 1 }),
      road('b2', [{ x: 0, z: 0 }, { x: 150, z: 0 }], { bridge: true, layer: 1 }),
      road('g1', [{ x: -100, z: 2.5 }, { x: 0, z: 2.5 }]),
      road('g2', [{ x: 0, z: 2.5 }, { x: 100, z: 2.5 }], { roadClass: 'secondary' }),
      road('g3', [{ x: 0, z: 2.5 }, { x: 0, z: 100 }]),
    ]
    const elev = solveNetworkElevation(roads)
    const deckKey = nodeKey({ x: 0, z: 0 })
    const gradeKey = nodeKey({ x: 0, z: 2.5 })
    expect(elev.nodeElevation(deckKey)).toBeCloseTo(6.5, 3)
    expect(elev.nodeElevation(gradeKey)).toBeLessThan(1)
    // the two levels must not share a cluster
    expect(
      elev.clusterOf(deckKey) === null ||
        elev.clusterOf(deckKey) !== elev.clusterOf(gradeKey),
    ).toBe(true)
  })
})

describe('junction consolidation — renderer', () => {
  it('cluster renders ONE merged patch; internal link renders no ribbon', async () => {
    const { buildRoads } = await import('../procgen/roads')
    await withCorridorElevation(true, async () => {
      const roads = [
        road('w1', [{ x: -100, z: 0 }, { x: 0, z: 0 }]),
        road('link', [{ x: 0, z: 0 }, { x: 6, z: 0 }]),
        road('e1', [{ x: 6, z: 0 }, { x: 106, z: 0 }]),
        road('n1', [{ x: 0, z: -80 }, { x: 0, z: 0 }]),
        road('s1', [{ x: 6, z: 0 }, { x: 6, z: 80 }]),
      ]
      const graph = { roads } as unknown as CityGraph
      const res = new Map(roads.map((r) => [r.id, resolution]))
      const result = buildRoads(graph, {} as ResolvedContext, res)
      expect(result.roadMeshes.get('link')).toBeUndefined() // internal: no ribbon
      expect(result.roadMeshes.get('w1')).toBeDefined()
      expect(result.intersections).not.toBeNull() // the merged patch exists
    })
  })

  it('sibling footway-bridge detection: parallel deck sidewalks match, standalone footbridges do not', () => {
    const deck = road('deck', [{ x: 0, z: 0 }, { x: 200, z: 0 }], { bridge: true, layer: 1, widthM: 10 })
    const sibling = road('side', [{ x: 5, z: 7 }, { x: 195, z: 7 }], { bridge: true, layer: 1, roadClass: 'footway', widthM: 2 })
    const standalone = road('solo', [{ x: 50, z: 300 }, { x: 250, z: 300 }], { bridge: true, layer: 1, roadClass: 'footway', widthM: 3 })
    const crossing = road('cross', [{ x: 100, z: -40 }, { x: 100, z: 40 }], { bridge: true, layer: 1, roadClass: 'footway', widthM: 2 })
    const ids = siblingFootwayBridgeIds([deck, sibling, standalone, crossing])
    expect(ids.has('side')).toBe(true)
    expect(ids.has('solo')).toBe(false)
    expect(ids.has('cross')).toBe(false) // perpendicular: a real footbridge over the road
  })
})
