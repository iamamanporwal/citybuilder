import { describe, expect, it } from 'vitest'
import type { BuildingFeature, CityGraph, RoadSegment, Vec2 } from '../types'
import { sanitizeCity } from '../procgen/sanity'

// ---- fixture builders (mirror the RoadSegment/BuildingFeature shapes) ------

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id,
    roadClass: 'primary',
    points,
    widthM: 14,
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

function square(cx: number, cz: number, h: number): Vec2[] {
  return [
    { x: cx - h, z: cz - h },
    { x: cx + h, z: cz - h },
    { x: cx + h, z: cz + h },
    { x: cx - h, z: cz + h },
  ]
}

function building(id: string, footprint: Vec2[], over: Partial<BuildingFeature> = {}): BuildingFeature {
  return {
    id,
    footprint,
    heightM: 12,
    heightSource: 'estimated',
    tier: 'generic',
    lat: 0,
    lng: 0,
    tags: {},
    ...over,
  }
}

function graphOf(roads: RoadSegment[], buildings: BuildingFeature[]): CityGraph {
  return {
    cityName: 'Test',
    origin: { lat: 0, lng: 0 },
    bboxLatLng: { south: 0, west: 0, north: 0, east: 0 },
    attribution: '',
    license: '',
    roads,
    buildings,
    areas: [],
    barriers: [],
    points: [],
    report: {
      buildingCount: buildings.length,
      buildingsWithHeight: 0,
      namedBuildings: 0,
      roadCount: roads.length,
      roadsWithLanes: 0,
      signalCount: 0,
      treeCount: 0,
    },
  }
}

const rules = (r: ReturnType<typeof sanitizeCity>['report'], name: string) =>
  r.issues.filter((i) => i.rule === name)

// ---------------------------------------------------------------------------

describe('sanitizeCity — building rules', () => {
  it('drops a building sitting on a drivable carriageway', () => {
    const r = road('rd', [{ x: -100, z: 0 }, { x: 100, z: 0 }], { widthM: 20 })
    const b = building('onroad', square(0, 0, 3)) // centred on the lane
    const { graph, report } = sanitizeCity(graphOf([r], [b]))
    expect(rules(report, 'building-on-carriageway')).toHaveLength(1)
    expect(graph.buildings).toHaveLength(0)
  })

  it('drops the lower-priority of two overlapping buildings', () => {
    const big = building('big', square(0, 0, 20), { heightM: 40 })
    const small = building('small', square(1, 1, 4), { heightM: 8 })
    const { graph, report } = sanitizeCity(graphOf([], [big, small]))
    const issue = rules(report, 'building-overlaps-building')
    expect(issue).toHaveLength(1)
    expect(issue[0].entityId).toBe('small')
    expect(graph.buildings.map((b) => b.id)).toEqual(['big'])
  })

  it('drops a degenerate footprint (too few points)', () => {
    const b = building('degen', [{ x: 0, z: 0 }, { x: 1, z: 0 }])
    const { graph, report } = sanitizeCity(graphOf([], [b]))
    expect(rules(report, 'degenerate-footprint')).toHaveLength(1)
    expect(graph.buildings).toHaveLength(0)
  })

  it('drops a sub-4m² footprint', () => {
    const b = building('tiny', square(0, 0, 0.5)) // 1m x 1m = 1 m²
    const { report } = sanitizeCity(graphOf([], [b]))
    expect(rules(report, 'degenerate-footprint')).toHaveLength(1)
  })

  it('clamps an absurd height', () => {
    const b = building('tower', square(0, 0, 15), { heightM: 5000 })
    const { graph, report } = sanitizeCity(graphOf([], [b]))
    expect(rules(report, 'absurd-height')).toHaveLength(1)
    expect(report.issues[0].action).toBe('clamped')
    expect(graph.buildings).toHaveLength(1)
    expect(graph.buildings[0].heightM).toBe(700)
  })

  it('clamps a non-positive height', () => {
    const b = building('flat', square(0, 0, 10), { heightM: 0 })
    const { graph, report } = sanitizeCity(graphOf([], [b]))
    expect(rules(report, 'absurd-height')).toHaveLength(1)
    expect(graph.buildings[0].heightM).toBeGreaterThan(0)
  })

  it('drops a building under an elevated bridge deck', () => {
    const bridge = road('br', [{ x: -100, z: 0 }, { x: 100, z: 0 }], {
      widthM: 20,
      bridge: true,
      layer: 1,
    })
    const b = building('underbridge', square(0, 0, 3), { heightM: 10 }) // rises above the soffit
    const { graph, report } = sanitizeCity(graphOf([bridge], [b]))
    expect(rules(report, 'building-under-bridge-deck')).toHaveLength(1)
    expect(graph.buildings).toHaveLength(0)
  })

  it('keeps a short building that clears the bridge soffit', () => {
    const bridge = road('br', [{ x: -100, z: 0 }, { x: 100, z: 0 }], {
      widthM: 20,
      bridge: true,
      layer: 1,
    })
    const b = building('lowshed', square(0, 0, 3), { heightM: 3 }) // well below the deck
    const { graph, report } = sanitizeCity(graphOf([bridge], [b]))
    expect(rules(report, 'building-under-bridge-deck')).toHaveLength(0)
    expect(graph.buildings).toHaveLength(1)
  })

  it('drops a footprint entirely outside the scene bounds', () => {
    const r = road('rd', [{ x: -50, z: 0 }, { x: 50, z: 0 }])
    const far = building('far', square(5000, 5000, 10))
    const { graph, report } = sanitizeCity(graphOf([r], [far]))
    expect(rules(report, 'out-of-bounds')).toHaveLength(1)
    expect(graph.buildings).toHaveLength(0)
  })

  it('dedupes near-identical buildings', () => {
    const a = building('a', square(0, 0, 10))
    const b = building('b', square(0, 0, 10)) // same centroid + area
    const { graph, report } = sanitizeCity(graphOf([], [a, b]))
    const dup = rules(report, 'duplicate-building')
    expect(dup).toHaveLength(1)
    expect(dup[0].entityId).toBe('b')
    expect(graph.buildings.map((x) => x.id)).toEqual(['a'])
  })
})

describe('sanitizeCity — road rules', () => {
  it('drops a degenerate (zero-length) road', () => {
    const r = road('z', [{ x: 5, z: 5 }, { x: 5, z: 5 }])
    const { graph, report } = sanitizeCity(graphOf([r], []))
    expect(rules(report, 'degenerate-road')).toHaveLength(1)
    expect(graph.roads).toHaveLength(0)
  })

  it('clamps an absurd road width by class', () => {
    const r = road('wide', [{ x: 0, z: 0 }, { x: 50, z: 0 }], { widthM: 500, roadClass: 'primary' })
    const { graph, report } = sanitizeCity(graphOf([r], []))
    expect(rules(report, 'absurd-width')).toHaveLength(1)
    expect(graph.roads).toHaveLength(1)
    expect(graph.roads[0].widthM).toBe(40) // primary max
  })

  it('clamps a non-positive road width to a class default', () => {
    const r = road('zerow', [{ x: 0, z: 0 }, { x: 30, z: 0 }], { widthM: 0, roadClass: 'residential' })
    const { graph, report } = sanitizeCity(graphOf([r], []))
    expect(rules(report, 'absurd-width')).toHaveLength(1)
    expect(graph.roads[0].widthM).toBeGreaterThan(0)
  })

  it('drops a road with NaN/Infinity coordinates', () => {
    const r = road('bad', [{ x: 0, z: 0 }, { x: NaN, z: Infinity }])
    const { graph, report } = sanitizeCity(graphOf([r], []))
    expect(rules(report, 'invalid-coords')).toHaveLength(1)
    expect(graph.roads).toHaveLength(0)
  })

  it('dedupes a coincident road', () => {
    const a = road('a', [{ x: 0, z: 0 }, { x: 100, z: 0 }])
    const b = road('b', [{ x: 0, z: 0 }, { x: 100, z: 0 }])
    const { graph, report } = sanitizeCity(graphOf([a, b], []))
    const dup = rules(report, 'duplicate-road')
    expect(dup).toHaveLength(1)
    expect(dup[0].entityId).toBe('b')
    expect(graph.roads.map((x) => x.id)).toEqual(['a'])
  })

  it('adjusts a zero-lane drivable road', () => {
    const r = road('nolanes', [{ x: 0, z: 0 }, { x: 60, z: 0 }], { lanes: 0 })
    const { graph, report } = sanitizeCity(graphOf([r], []))
    expect(rules(report, 'zero-lane-drivable')).toHaveLength(1)
    expect(graph.roads[0].lanes).toBeGreaterThan(0)
  })

  it('flags (does not drop) a road passing through a building', () => {
    // narrow road clipping the interior of a large building; its centroid is far
    // enough from the centerline that the on-carriageway rule does NOT fire.
    const r = road('through', [{ x: -100, z: 18 }, { x: 0, z: 18 }, { x: 100, z: 18 }], {
      widthM: 4,
    })
    const b = building('clipped', square(0, 0, 20)) // x,z ∈ [-20,20]; vertex (0,18) is inside
    const { graph, report } = sanitizeCity(graphOf([r], [b]))
    const flag = rules(report, 'road-through-building')
    expect(flag).toHaveLength(1)
    expect(flag[0].action).toBe('flagged')
    expect(graph.roads).toHaveLength(1) // road survives
    expect(graph.buildings).toHaveLength(1) // building survives (flag only)
  })
})

describe('sanitizeCity — invariants', () => {
  it('passes a clean graph through unchanged (no issues, same counts)', () => {
    const roads = [
      road('r1', [{ x: -100, z: 0 }, { x: 100, z: 0 }]),
      road('r2', [{ x: 0, z: -100 }, { x: 0, z: 100 }]),
    ]
    const buildings = [
      building('h1', square(60, 60, 10)),
      building('h2', square(-60, 60, 10)),
      building('h3', square(60, -60, 10)),
    ]
    const { graph, report } = sanitizeCity(graphOf(roads, buildings))
    expect(report.issues).toHaveLength(0)
    expect(report.counts).toEqual({})
    expect(graph.roads).toHaveLength(roads.length)
    expect(graph.buildings).toHaveLength(buildings.length)
  })

  it('does not mutate its input graph', () => {
    const input = graphOf(
      [
        road('wide', [{ x: 0, z: 0 }, { x: 50, z: 0 }], { widthM: 500 }),
        road('bad', [{ x: 0, z: 0 }, { x: NaN, z: 0 }]),
      ],
      [
        building('tower', square(0, 200, 15), { heightM: 5000 }),
        building('degen', [{ x: 0, z: 0 }, { x: 1, z: 0 }]),
      ],
    )
    const snapshot = JSON.stringify(input)
    sanitizeCity(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('is deterministic (same input → identical report)', () => {
    const build = () =>
      graphOf(
        [road('wide', [{ x: 0, z: 0 }, { x: 50, z: 0 }], { widthM: 500 })],
        [building('big', square(0, 0, 20), { heightM: 40 }), building('small', square(1, 1, 4), { heightM: 8 })],
      )
    const a = sanitizeCity(build())
    const b = sanitizeCity(build())
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report))
    expect(a.graph.buildings.map((x) => x.id)).toEqual(b.graph.buildings.map((x) => x.id))
  })
})
