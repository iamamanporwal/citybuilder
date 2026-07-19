import { describe, expect, it } from 'vitest'
import type { CityGraph, PointFeature, RoadSegment, Vec2 } from '../types'
import type { RoadResolution } from '../resolver/types'
import type { FurniturePlacements } from '../procgen/props'
import { buildColliders } from '../physics/colliders'
import { colliderLint } from '../physics/colliderLint'

// Focused regression suite for the collider AUDIT + the root-cause fixes it
// guards (Problem 1: invisible/phantom obstacles on the drivable surface).

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id, roadClass: 'primary', points, widthM: 12, lanes: 4, oneway: false,
    bridge: false, tunnel: false, layer: 0, centerLat: 0, centerLng: 0, ...over,
  }
}

function point(id: string, kind: PointFeature['kind'], position: Vec2): PointFeature {
  return { id, kind, position, lat: 0, lng: 0 }
}

function graphOf(roads: RoadSegment[], points: PointFeature[] = [], barriers: CityGraph['barriers'] = []): CityGraph {
  return {
    cityName: 't', origin: { lat: 0, lng: 0 }, bboxLatLng: { south: 0, west: 0, north: 0, east: 0 },
    attribution: '', license: '', roads, buildings: [], areas: [], barriers, points,
    report: {} as CityGraph['report'],
  } as unknown as CityGraph
}

const noRes = new Map<string, RoadResolution>()
const warnings = (g: CityGraph, s = buildColliders(g, noRes)) => colliderLint(g, s).filter((w) => w.severity === 'warn')

// a long straight road down +X so props can sit mid-block, away from any junction
const straight = road('r_main', [{ x: -100, z: 0 }, { x: 100, z: 0 }], { widthM: 12 })

describe('lane-intrusion audit', () => {
  it('flags a solid prop collider dropped in a driving lane', () => {
    // a tree is NOT relocated (thin, roadScale-displaced elsewhere) → its collider
    // stays where mapped; on the centreline that is a mid-lane obstacle.
    const g = graphOf([straight], [point('tree_in_lane', 'tree', { x: 0, z: 0 })])
    const w = warnings(g)
    expect(w.some((x) => x.message.includes('intrude into a driving lane'))).toBe(true)
  })

  it('passes when the same prop sits on the verge', () => {
    const g = graphOf([straight], [point('tree_verge', 'tree', { x: 0, z: 20 })]) // well outside half-width 6
    expect(warnings(g)).toEqual([])
  })

  it('relocates an un-placed traffic signal off the centreline so it never intrudes', () => {
    const g = graphOf([straight], [point('sig1', 'traffic_signal', { x: 0, z: 0 })])
    const set = buildColliders(g, noRes)
    const sig = set.colliders.find((c) => c.semantics.featureId === 'sig1')!
    // pushed to the kerb: perpendicular distance from the road line (z=0) > half
    expect(Math.abs(sig.transform.position[2])).toBeGreaterThan(6)
    expect(warnings(g, set)).toEqual([])
  })
})

describe('no phantom / duplicate furniture colliders', () => {
  const furniture: FurniturePlacements = {
    lamps: [{ p: { x: 0, z: 8 }, rotY: 0, y: 0 }],
    benches: [], bins: [], signs: [],
  }

  it('emits the lamp collider once (furniture channel), never a second at the raw OSM point', () => {
    // the same OSM lamp appears in graph.points AND in furniturePlacements.lamps
    const g = graphOf([straight], [point('osm_lamp', 'street_lamp', { x: 0, z: 0 })])
    const set = buildColliders(g, noRes, { furniturePlacements: furniture })
    const lampCols = set.colliders.filter((c) => c.semantics.propKind === 'street_lamp')
    expect(lampCols.length).toBe(1)
    expect(lampCols[0].id).toContain('furn_lamp')
    // and no phantom at the raw centreline point
    expect(set.colliders.some((c) => c.semantics.featureId === 'osm_lamp')).toBe(false)
  })
})

describe('aggregate-object exclusion suppresses constituent colliders (no orphans)', () => {
  const g = graphOf(
    [straight],
    [point('t1', 'tree', { x: 0, z: 20 }), point('t2', 'tree', { x: 10, z: 20 })],
    [{ id: 'b1', kind: 'wall', points: [{ x: 0, z: 30 }, { x: 20, z: 30 }] }],
  )
  const furniture: FurniturePlacements = { lamps: [{ p: { x: 0, z: 8 }, rotY: 0, y: 0 }], benches: [], bins: [], signs: [] }

  it('hiding veg_trees drops every tree collider', () => {
    const set = buildColliders(g, noRes, { excluded: new Set(['veg_trees']) })
    expect(set.colliders.some((c) => c.semantics.propKind === 'tree')).toBe(false)
  })
  it('hiding furn_all drops every furniture collider', () => {
    const set = buildColliders(g, noRes, { furniturePlacements: furniture, excluded: new Set(['furn_all']) })
    expect(set.colliders.some((c) => c.id.includes('furn_lamp'))).toBe(false)
  })
  it('hiding net_barriers drops every barrier collider', () => {
    const set = buildColliders(g, noRes, { excluded: new Set(['net_barriers']) })
    expect(set.stats.barrier).toBe(0)
  })
})

describe('duplicate-id and seam audits', () => {
  it('flags a duplicated collider id', () => {
    const g = graphOf([straight])
    const set = buildColliders(g, noRes)
    const dup = { ...set, colliders: [...set.colliders, { ...set.colliders[0] }] }
    expect(colliderLint(g, dup).some((w) => w.message.includes('duplicate collider id'))).toBe(true)
  })

  it('a flat network has no junction seam steps', () => {
    // cross of two roads sharing an endpoint → a real junction, all at grade
    const cross = [
      road('a', [{ x: -60, z: 0 }, { x: 0, z: 0 }]),
      road('b', [{ x: 0, z: 0 }, { x: 60, z: 0 }]),
      road('c', [{ x: 0, z: -60 }, { x: 0, z: 0 }]),
      road('d', [{ x: 0, z: 0 }, { x: 0, z: 60 }]),
    ]
    const g = graphOf(cross)
    expect(warnings(g).some((w) => w.message.includes('seam'))).toBe(false)
  })
})

describe('bridge rails do not intrude into the deck', () => {
  it('rail collider inner face sits at or beyond the carriageway edge', () => {
    const bridge = road('br', [{ x: -40, z: 0 }, { x: 40, z: 0 }], { bridge: true, layer: 1, widthM: 12 })
    const set = buildColliders(graphOf([bridge]), noRes)
    const rails = set.colliders.filter((c) => c.semantics.class === 'barrier' && c.semantics.bridge)
    expect(rails.length).toBeGreaterThan(0)
    const half = 6
    for (const r of rails) {
      const railThick = r.halfExtents![2] * 2
      const innerFace = Math.abs(r.transform.position[2]) - railThick / 2
      expect(innerFace).toBeGreaterThanOrEqual(half - 1e-6)
    }
  })
})
