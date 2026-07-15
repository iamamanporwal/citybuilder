import { describe, expect, it } from 'vitest'
import type { RoadSegment, Vec2 } from '../types'
import {
  deviceHeading,
  displaySpeed,
  effectiveSpeed,
  nearestRoadInfo,
  speedUnitFor,
} from '../procgen/signMath'

const road = (id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment => ({
  id,
  roadClass: 'primary',
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
})

describe('signMath — orientation (M3 Slice C)', () => {
  const roads = [
    road('r', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { oneway: true }),
    road('foot', [{ x: 0, z: 5 }, { x: 10, z: 5 }], { roadClass: 'footway' }),
  ]

  it('finds the nearest drivable road tangent and distance, ignoring footways', () => {
    const n = nearestRoadInfo({ x: 5, z: 2 }, roads)!
    expect(n).not.toBeNull()
    expect(n.dir.x).toBeCloseTo(1, 6)
    expect(n.dir.z).toBeCloseTo(0, 6)
    expect(n.dist).toBeCloseTo(2, 6) // 2 m off, not 3 m to the footway
    expect(n.oneway).toBe(true)
  })

  it('returns null when there is no drivable road', () => {
    expect(nearestRoadInfo({ x: 0, z: 0 }, [road('f', [{ x: 0, z: 0 }, { x: 5, z: 0 }], { roadClass: 'cycleway' })])).toBeNull()
  })

  it('aligns a +Z device with the road; faceOncoming flips it 180°', () => {
    const n = nearestRoadInfo({ x: 5, z: 2 }, roads)!
    const along = deviceHeading(n, false)
    const oncoming = deviceHeading(n, true)
    expect(along).toBeCloseTo(Math.PI / 2, 6) // +Z rotated to face +X
    expect(Math.abs(Math.abs(along - oncoming) - Math.PI)).toBeCloseTo(0, 6)
  })

  it('falls back to 0 with no nearby road', () => {
    expect(deviceHeading(null, true)).toBe(0)
  })
})

describe('signMath — speed limits (M3 Slice D)', () => {
  it('picks region speed unit', () => {
    expect(speedUnitFor('us')).toBe('mph')
    expect(speedUnitFor('uk')).toBe('mph')
    expect(speedUnitFor('eu-west')).toBe('km/h')
    expect(speedUnitFor('in')).toBe('km/h')
  })

  it('converts km/h to a posted display increment', () => {
    expect(displaySpeed(48, 'mph')).toBe(30) // 30 mph round-trip
    expect(displaySpeed(50, 'km/h')).toBe(50)
    expect(displaySpeed(30, 'km/h')).toBe(30)
    expect(displaySpeed(97, 'mph')).toBe(60) // ~60 mph
  })

  it('uses the OSM tag when present, else a class default flagged low-confidence', () => {
    expect(effectiveSpeed(road('a', [{ x: 0, z: 0 }, { x: 1, z: 0 }], { maxspeedKmh: 50 }))).toEqual({
      kmh: 50,
      source: 'tag',
    })
    const def = effectiveSpeed(road('b', [{ x: 0, z: 0 }, { x: 1, z: 0 }], { roadClass: 'residential' }))!
    expect(def.source).toBe('default')
    expect(def.kmh).toBe(30)
    expect(effectiveSpeed(road('f', [{ x: 0, z: 0 }, { x: 1, z: 0 }], { roadClass: 'footway' }))).toBeNull()
  })
})
