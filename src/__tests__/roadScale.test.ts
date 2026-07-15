import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  BarrierFeature,
  BuildingFeature,
  CityGraph,
  PointFeature,
  RoadSegment,
  Vec2,
} from '../types'
import { ingestOverpass } from '../ingest/overpass'
import { NON_DRIVABLE } from '../procgen/roadNetwork'
import { clampRoadScale, scaleRoadNetwork } from '../procgen/roadScale'

// Road Width Scaling invariant suite (redesign §14): drivable roads widen and
// paths don't, bridges widen but don't shove ground features, roadside features
// are set back out of the widened carriageway while far ones stay put, water/
// areas are untouched, factor 1 is identity, and the transform is deterministic.

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id,
    roadClass: 'residential',
    points,
    widthM: 10,
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

function building(id: string, footprint: Vec2[]): BuildingFeature {
  return { id, footprint, heightM: 12, heightSource: 'estimated', tier: 'generic', lat: 0, lng: 0, tags: {} }
}

function box(cx: number, cz: number, half = 2): Vec2[] {
  return [
    { x: cx - half, z: cz - half },
    { x: cx + half, z: cz - half },
    { x: cx + half, z: cz + half },
    { x: cx - half, z: cz + half },
  ]
}

function graphOf(over: Partial<CityGraph>): CityGraph {
  return {
    cityName: 'test',
    origin: { lat: 0, lng: 0 },
    bboxLatLng: { south: 0, west: 0, north: 0, east: 0 },
    attribution: '',
    license: '',
    roads: [],
    buildings: [],
    areas: [],
    barriers: [],
    points: [],
    report: {
      buildingCount: 0,
      buildingsWithHeight: 0,
      namedBuildings: 0,
      roadCount: 0,
      roadsWithLanes: 0,
      signalCount: 0,
      treeCount: 0,
    },
    ...over,
  }
}

const AXIS: Vec2[] = [
  { x: -200, z: 0 },
  { x: 200, z: 0 },
]

/** Min perpendicular distance from any footprint vertex to the x-axis (z=0). */
const minZDist = (b: BuildingFeature) => Math.min(...b.footprint.map((v) => Math.abs(v.z)))

describe('clampRoadScale', () => {
  it('clamps to [1,4] and rejects non-finite', () => {
    expect(clampRoadScale(2.5)).toBe(2.5)
    expect(clampRoadScale(10)).toBe(4)
    expect(clampRoadScale(0.3)).toBe(1)
    expect(clampRoadScale(NaN)).toBe(1)
  })
})

describe('road widening', () => {
  it('scales drivable carriageway width but leaves footpaths alone', () => {
    const g = graphOf({
      roads: [
        road('drive', AXIS, { widthM: 10, roadClass: 'primary' }),
        road('foot', AXIS, { widthM: 3, roadClass: 'footway' }),
      ],
    })
    const out = scaleRoadNetwork(g, 2)
    expect(out.roads.find((r) => r.id === 'drive')!.widthM).toBe(20)
    expect(out.roads.find((r) => r.id === 'foot')!.widthM).toBe(3)
  })

  it('widens bridge decks too', () => {
    const g = graphOf({ roads: [road('br', AXIS, { widthM: 12, bridge: true, layer: 1 })] })
    expect(scaleRoadNetwork(g, 1.5).roads[0].widthM).toBe(18)
  })

  it('factor 1 is an identity (same reference, input untouched)', () => {
    const g = graphOf({ roads: [road('r', AXIS)], buildings: [building('b', box(0, 7))] })
    expect(scaleRoadNetwork(g, 1)).toBe(g)
  })

  it('is deterministic', () => {
    const build = () =>
      graphOf({
        roads: [road('r', AXIS, { widthM: 10 })],
        buildings: [building('b', box(0, 8))],
        points: [{ id: 'p', kind: 'tree', position: { x: 0, z: 7 }, lat: 0, lng: 0 }],
      })
    expect(scaleRoadNetwork(build(), 2.5)).toEqual(scaleRoadNetwork(build(), 2.5))
  })
})

describe('non-road displacement', () => {
  it('sets a roadside building back out of the widened carriageway', () => {
    // road half 5 (orig) → ×2 → half 10. Building at z≈7 overlaps the new road.
    const g = graphOf({ roads: [road('r', AXIS, { widthM: 10 })], buildings: [building('b', box(0, 7))] })
    const out = scaleRoadNetwork(g, 2)
    const newHalf = 10
    // every vertex must clear the widened carriageway
    expect(minZDist(out.buildings[0])).toBeGreaterThanOrEqual(newHalf - 1e-6)
    // it moved away from the road, not toward it
    expect(minZDist(out.buildings[0])).toBeGreaterThan(minZDist(g.buildings[0]))
  })

  it('leaves buildings far from any road untouched', () => {
    const far = building('far', box(0, 200))
    const g = graphOf({ roads: [road('r', AXIS, { widthM: 10 })], buildings: [far] })
    expect(scaleRoadNetwork(g, 3).buildings[0].footprint).toEqual(far.footprint)
  })

  it('does NOT displace ground features under a widened bridge', () => {
    const under = building('under', box(0, 7))
    const g = graphOf({
      roads: [road('br', AXIS, { widthM: 10, bridge: true, layer: 1 })],
      buildings: [under],
    })
    const out = scaleRoadNetwork(g, 2)
    expect(out.buildings[0].footprint).toEqual(under.footprint) // stayed put
    expect(out.roads[0].widthM).toBe(20) // deck still widened
  })

  it('displaces roadside props and barriers', () => {
    const g = graphOf({
      roads: [road('r', AXIS, { widthM: 10 })],
      points: [{ id: 'lamp', kind: 'street_lamp', position: { x: 0, z: 6 }, lat: 0, lng: 0 }] as PointFeature[],
      barriers: [{ id: 'fence', kind: 'fence', points: [{ x: -5, z: 6 }, { x: 5, z: 6 }] }] as BarrierFeature[],
    })
    const out = scaleRoadNetwork(g, 2)
    expect(out.points[0].position.z).toBeGreaterThanOrEqual(10 - 1e-6)
    for (const p of out.barriers[0].points) expect(Math.abs(p.z)).toBeGreaterThanOrEqual(10 - 1e-6)
  })

  it('never leaves a roadside building overlapping a widened drivable road', () => {
    // realistic frontage: buildings BESIDE each street, clear of the junction
    // (the straddling / mid-intersection case is a documented v1 limit).
    const buildings: BuildingFeature[] = []
    for (const [cx, cz] of [[50, 7], [50, -7], [-50, 7], [80, -8]] as const) // beside horizontal
      buildings.push(building(`h_${cx}_${cz}`, box(cx, cz, 1.5)))
    for (const [cx, cz] of [[7, 50], [-7, 50], [-8, -80]] as const) // beside vertical
      buildings.push(building(`v_${cx}_${cz}`, box(cx, cz, 1.5)))
    const g = graphOf({
      roads: [
        road('h', [{ x: -200, z: 0 }, { x: 200, z: 0 }], { widthM: 12 }),
        road('v', [{ x: 0, z: -200 }, { x: 0, z: 200 }], { widthM: 12 }),
      ],
      buildings,
    })
    const out = scaleRoadNetwork(g, 2)
    const newHalf = 12 // 12/2 * 2
    for (const b of out.buildings)
      for (const v of b.footprint) {
        const insideH = Math.abs(v.x) <= 200 && Math.abs(v.z) < newHalf - 1e-6
        const insideV = Math.abs(v.z) <= 200 && Math.abs(v.x) < newHalf - 1e-6
        expect(insideH || insideV).toBe(false)
      }
  })

  it('leaves areas (grass/park/water) untouched', () => {
    const areas = [{ id: 'lake', kind: 'water' as const, ring: box(0, 6, 30), render: true }]
    const g = graphOf({ roads: [road('r', AXIS, { widthM: 10 })], areas })
    expect(scaleRoadNetwork(g, 3).areas).toBe(areas)
  })
})

describe('real-city robustness (messy OSM at scale)', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/data/raw_osm.json', import.meta.url)), 'utf8'),
  )
  const graph = ingestOverpass(raw, 'Lower Manhattan')

  it('widens every drivable road, never a footpath, with finite geometry', () => {
    const out = scaleRoadNetwork(graph, 2)
    for (let i = 0; i < graph.roads.length; i++) {
      const before = graph.roads[i]
      const after = out.roads[i]
      const factor = NON_DRIVABLE.has(before.roadClass) ? 1 : 2
      expect(after.widthM).toBeCloseTo(before.widthM * factor, 6)
    }
    for (const b of out.buildings) for (const v of b.footprint) {
      expect(Number.isFinite(v.x)).toBe(true)
      expect(Number.isFinite(v.z)).toBe(true)
    }
    // does not mutate the pristine graph
    expect(graph.roads.some((r, i) => r.widthM !== graph.roads[i].widthM)).toBe(false)
  })

  it('is deterministic and does not mutate the input on real data', () => {
    const snapshotWidth = graph.roads.map((r) => r.widthM)
    const a = scaleRoadNetwork(graph, 1.75)
    const b = scaleRoadNetwork(graph, 1.75)
    expect(a.buildings.map((x) => x.footprint)).toEqual(b.buildings.map((x) => x.footprint))
    expect(graph.roads.map((r) => r.widthM)).toEqual(snapshotWidth) // pristine intact
  })
})
