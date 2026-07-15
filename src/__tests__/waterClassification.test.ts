import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ingestOverpass, MIN_WATER_AREA_M2 } from '../ingest/overpass'
import { auditWater } from '../resolver/waterAudit'
import { pointInRing, ringIsSimple } from '../procgen/geometry'
import type { CityGraph } from '../types'

// Regression suite for water over-classification: only whitelisted, closed,
// sufficiently large real water bodies may be painted blue; land is the
// default. See docs/water-and-flicker-rca.md.

const M = 111320 // meters per degree at the equator (tests use lat ~ 0)

type LatLon = [number, number]
function way(id: number, tags: Record<string, string>, coords: LatLon[]) {
  return { type: 'way', id, tags, geometry: coords.map(([lat, lon]) => ({ lat, lon })) }
}

/** Closed square ring of `side` meters centered at (latC, lonC). */
function square(latC: number, lonC: number, side: number): LatLon[] {
  const d = side / 2 / M
  return [
    [latC - d, lonC - d], [latC - d, lonC + d], [latC + d, lonC + d], [latC + d, lonC - d], [latC - d, lonC - d],
  ]
}

function ingest(elements: object[]): CityGraph {
  return ingestOverpass({ elements: elements as never }, 'test')
}

const waterAreas = (g: CityGraph) => g.areas.filter((a) => a.kind === 'water')

// an anchor road so the local frame has non-water extents
const anchorRoad = way(9000, { highway: 'residential' }, [[0, -0.003], [0, 0.003]])

describe('water whitelist', () => {
  it('renders a large closed lake with provenance', () => {
    const g = ingest([anchorRoad, way(1, { natural: 'water', water: 'lake' }, square(0, 0, 100))])
    const w = waterAreas(g)
    expect(w).toHaveLength(1)
    expect(w[0].provenance).toBe('natural=water(lake)')
    expect(w[0].areaM2!).toBeGreaterThan(MIN_WATER_AREA_M2)
  })

  it('renders reservoirs and riverbank areas', () => {
    const g = ingest([
      anchorRoad,
      way(1, { landuse: 'reservoir' }, square(0, 0.001, 80)),
      way(2, { waterway: 'riverbank' }, square(0, -0.001, 80)),
    ])
    expect(waterAreas(g).map((w) => w.provenance).sort()).toEqual(['landuse=reservoir', 'waterway=riverbank'])
  })

  it('never paints fountains, pools, wetlands or unknown water sub-tags', () => {
    const g = ingest([
      anchorRoad,
      way(1, { natural: 'water', amenity: 'fountain' }, square(0, 0, 30)),
      way(2, { natural: 'water', water: 'swimming_pool' }, square(0, 0.001, 30)),
      way(3, { leisure: 'swimming_pool', natural: 'water' }, square(0, 0.002, 30)),
      way(4, { natural: 'wetland' }, square(0, 0.003, 100)),
      way(5, { natural: 'water', water: 'basin' }, square(0, 0.004, 50)),
      way(6, { natural: 'water', water: 'wastewater' }, square(0, 0.005, 50)),
    ])
    expect(waterAreas(g)).toHaveLength(0)
    // the fountain survives as a point prop, the wetland as green cover
    expect(g.points.some((p) => p.kind === 'fountain')).toBe(true)
    expect(g.areas.some((a) => a.kind === 'grass')).toBe(true)
  })

  it('never buffers streams, ditches, drains or culverted waterways', () => {
    const line: LatLon[] = [[0, -0.002], [0, 0.002]]
    const g = ingest([
      anchorRoad,
      way(1, { waterway: 'stream' }, line),
      way(2, { waterway: 'ditch' }, line),
      way(3, { waterway: 'drain' }, line),
      way(4, { waterway: 'river', tunnel: 'yes' }, line),
      way(5, { waterway: 'river', covered: 'yes' }, line),
      way(6, { waterway: 'canal', layer: '-1' }, line),
    ])
    expect(waterAreas(g)).toHaveLength(0)
  })

  it('buffers an open river into a water ribbon', () => {
    const g = ingest([anchorRoad, way(1, { waterway: 'river' }, [[0, -0.002], [0, 0], [0, 0.002]])])
    const w = waterAreas(g)
    expect(w).toHaveLength(1)
    expect(w[0].provenance).toBe('waterway=river')
  })

  it('drops water below the minimum area threshold', () => {
    const g = ingest([anchorRoad, way(1, { natural: 'water', water: 'pond' }, square(0, 0, 7))]) // 49 m²
    expect(waterAreas(g)).toHaveLength(0)
  })

  it('drops unclosed water rings (multipolygon fragments) instead of flooding land', () => {
    const open = square(0, 0, 200).slice(0, 4) // 4 points, not closed
    const g = ingest([anchorRoad, way(1, { natural: 'water' }, open)])
    expect(waterAreas(g)).toHaveLength(0)
  })
})

describe('sea from coastline', () => {
  // coastline heading north (lat increasing) at lon 0 → OSM water-on-right = east
  const coast = way(100, { natural: 'coastline' }, [[-0.002, 0], [-0.001, 0], [0.001, 0], [0.002, 0]])
  const westBuildings = [1, 2, 3].map((i) =>
    way(200 + i, { building: 'yes' }, square(-0.001 + i * 0.001, -0.0015, 30)),
  )

  it('paints the sea on the water side and never over buildings', () => {
    const g = ingest([anchorRoad, coast, ...westBuildings])
    const sea = g.areas.find((a) => a.id === 'water_sea')
    expect(sea).toBeDefined()
    expect(ringIsSimple(sea!.ring)).toBe(true)
    // a probe well east of the shoreline is water; buildings (west) stay dry
    // (the local frame origin is the centroid of ALL geometry, so compute the
    // coastline's local x from the graph origin)
    const xCoast = (0 - g.origin.lng) * M * Math.cos((g.origin.lat * Math.PI) / 180)
    expect(pointInRing({ x: xCoast + 60, z: 0 }, sea!.ring)).toBe(true)
    for (const b of g.buildings) {
      let x = 0, z = 0
      for (const p of b.footprint) { x += p.x; z += p.z }
      expect(pointInRing({ x: x / b.footprint.length, z: z / b.footprint.length }, sea!.ring)).toBe(false)
    }
  })

  it('paints a strait between two facing shores without flooding either shore (Golden Gate case)', () => {
    // north shore runs EAST at lat +0.001 → water on its right = south
    const northShore = way(400, { natural: 'coastline' }, [[0.001, -0.002], [0.001, -0.0005], [0.001, 0.0005], [0.001, 0.002]])
    // south shore runs WEST at lat -0.001 → water on its right = north
    const southShore = way(401, { natural: 'coastline' }, [[-0.001, 0.002], [-0.001, 0.0005], [-0.001, -0.0005], [-0.001, -0.002]])
    // land buildings on both shores (well clear of the water band between ±0.001 lat)
    const shoreBuildings = [
      way(410, { building: 'yes' }, square(0.0018, -0.0008, 30)),
      way(411, { building: 'yes' }, square(0.0018, 0.0008, 30)),
      way(412, { building: 'yes' }, square(-0.0018, -0.0008, 30)),
      way(413, { building: 'yes' }, square(-0.0018, 0.0008, 30)),
    ]
    const g = ingest([anchorRoad, northShore, southShore, ...shoreBuildings])
    const seas = g.areas.filter((a) => a.id.startsWith('water_sea'))
    expect(seas.length).toBeGreaterThanOrEqual(1)
    expect(seas.every((s) => ringIsSimple(s.ring))).toBe(true)
    // a probe in the middle of the strait (local origin ≈ 0,0) is water …
    const mid = { x: (0 - g.origin.lng) * M * Math.cos((g.origin.lat * Math.PI) / 180), z: -(0 - g.origin.lat) * M }
    expect(seas.some((s) => pointInRing(mid, s.ring))).toBe(true)
    // … and NO shore building sits in the water
    for (const b of g.buildings) {
      let x = 0, z = 0
      for (const p of b.footprint) { x += p.x; z += p.z }
      const c = { x: x / b.footprint.length, z: z / b.footprint.length }
      expect(seas.some((s) => pointInRing(c, s.ring))).toBe(false)
    }
    // and the water audit stays clean (no buildings flooded)
    expect(auditWater(g).filter((w) => w.severity === 'warn')).toEqual([])
  })

  it('refuses to paint a sea that would flood buildings on both sides', () => {
    const eastBuildings = [1, 2, 3, 4, 5].map((i) =>
      way(300 + i, { building: 'yes' }, square(-0.0015 + i * 0.0006, 0.0015, 30)),
    )
    const g = ingest([anchorRoad, coast, ...westBuildings, ...eastBuildings])
    expect(g.areas.find((a) => a.id === 'water_sea')).toBeUndefined()
  })
})

describe('real sample city (Lower Manhattan)', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/data/raw_osm.json', import.meta.url)), 'utf8'),
  )
  const g = ingestOverpass(raw, 'Lower Manhattan')

  it('classifies only whitelisted water and floods no buildings', () => {
    const warns = auditWater(g).filter((w) => w.severity === 'warn')
    expect(warns).toEqual([])
  })

  it('keeps the harbor: a sea polygon exists and is a simple polygon', () => {
    const sea = g.areas.find((a) => a.id === 'water_sea')
    expect(sea).toBeDefined()
    expect(ringIsSimple(sea!.ring)).toBe(true)
  })

  it('turns mapped fountains into props, not water polygons', () => {
    expect(g.points.filter((p) => p.kind === 'fountain').length).toBeGreaterThan(0)
    expect(waterAreas(g).some((a) => a.provenance?.includes('fountain'))).toBe(false)
  })
})
