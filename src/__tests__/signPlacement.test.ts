import { describe, expect, it, vi } from 'vitest'

// signs.ts imports procgen/materials, which builds canvas textures at load — stub
// it so planSpeedLimitSigns (pure placement math, no geometry) runs in node.
vi.mock('../procgen/materials', () => ({ mats: new Proxy({}, { get: () => ({}) }) }))

import type { ResolvedContext, RegionPack } from '../resolver/types'
import type { RoadSegment, Vec2 } from '../types'
import { planSpeedLimitSigns } from '../procgen/signs'

const road = (id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment => ({
  id,
  roadClass: 'primary',
  points,
  widthM: 10,
  lanes: 2,
  oneway: false,
  bridge: false,
  tunnel: false,
  layer: 0,
  centerLat: 40,
  centerLng: -74,
  ...over,
})

const ctx = (region: Partial<RegionPack>): ResolvedContext =>
  ({ region: { id: 'us', signShape: 'us-rect', drivingSide: 'right', ...region } } as unknown as ResolvedContext)

const straight: Vec2[] = [
  { x: 0, z: 0 },
  { x: 100, z: 0 },
]

describe('speed-limit sign placement (M3 Slice D)', () => {
  it('places a sign only for roads with a real (tagged) maxspeed', () => {
    const roads = [
      road('tagged', straight, { maxspeedKmh: 50 }),
      road('untagged', straight), // default speed exists but no physical sign
      road('foot', straight, { roadClass: 'footway', maxspeedKmh: 20 }),
      road('short', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { maxspeedKmh: 50 }), // too short
    ]
    const signs = planSpeedLimitSigns(roads, ctx({}))
    expect(signs.map((s) => s.roadId)).toEqual(['tagged'])
    expect(signs[0].display).toBe(30) // 50 km/h → ~30 mph (US region)
    expect(signs[0].unit).toBe('mph')
    expect(signs[0].style).toBe('us-rect')
  })

  it('offsets to the driving side and faces oncoming traffic', () => {
    // right-hand traffic: sign sits on the right of travel (+x here → right is +z)
    const right = planSpeedLimitSigns([road('r', straight, { maxspeedKmh: 50 })], ctx({ drivingSide: 'right' }))[0]
    const left = planSpeedLimitSigns([road('r', straight, { maxspeedKmh: 50 })], ctx({ drivingSide: 'left' }))[0]
    expect(right.position.z).toBeGreaterThan(2) // right of +x travel is +z
    expect(left.position.z).toBeLessThan(-2) // left-hand traffic mirrors it
    // faces oncoming: +Z front rotated to point back along −x (toward drivers going +x)
    expect(right.headingY).toBeCloseTo(Math.atan2(-1, 0), 5)
  })

  it('uses km/h + a circular plate outside US/UK, and is deterministic', () => {
    const eu = ctx({ id: 'eu-west', signShape: 'eu-circle', drivingSide: 'right' })
    const a = planSpeedLimitSigns([road('r', straight, { maxspeedKmh: 50 })], eu)
    const b = planSpeedLimitSigns([road('r', straight, { maxspeedKmh: 50 })], eu)
    expect(a[0].unit).toBe('km/h')
    expect(a[0].display).toBe(50)
    expect(a[0].style).toBe('circle')
    expect(a).toEqual(b)
  })
})
