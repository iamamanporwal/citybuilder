import { describe, expect, it } from 'vitest'
import type { AssetInfo, RoadSegment, SceneObject, Vec2 } from '../types'
import type { RoadResolution } from '../resolver/types'
import { buildRoadSemantics, buildTrafficAudit, buildTrafficDevices } from '../export/semantics'

const road = (id: string, over: Partial<RoadSegment> = {}): RoadSegment => ({
  id,
  roadClass: 'primary',
  points: [
    { x: 0, z: 0 },
    { x: 50, z: 0 },
  ],
  widthM: 10,
  lanes: 2,
  oneway: false,
  bridge: false,
  tunnel: false,
  layer: 0,
  centerLat: 0,
  centerLng: 0,
  ...over,
})

const res: RoadResolution = {
  surface: 'asphalt-worn',
  marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
  crossSection: { sidewalks: false, sidewalkWidth: 2.4, curbHeight: 0.22 },
  decalDensity: 0,
  provenance: [],
  confidence: 1,
}

const ASSET: AssetInfo = { state: 'procedural', provider: 'procedural', license: 'x', approved: true }
const obj = (id: string, type: SceneObject['type'], meta: SceneObject['meta'], rotY = 0, pos: Vec2 = { x: 1, z: 2 }): SceneObject => ({
  id,
  type,
  name: id,
  locked: false,
  visible: true,
  deleted: false,
  transform: { position: [pos.x, 0, pos.z], rotation: [0, rotY, 0], scale: [1, 1, 1] },
  asset: ASSET,
  meta,
})

describe('road semantics — faithful traffic fields (M3 Slice F)', () => {
  it('emits speed limit (tag vs default), turn lanes and roundabout', () => {
    const roads = [
      road('a', { maxspeedKmh: 50, turnLanes: ['left', 'through'] }),
      road('b', { roadClass: 'residential' }), // untagged → default
      road('c', { roundabout: true, oneway: true }),
    ]
    const sem = buildRoadSemantics(roads, new Map(roads.map((r) => [r.id, res])))
    const a = sem.find((s) => s.id === 'a')!
    expect(a.speed_limit_kmh).toBe(50)
    expect(a.speed_limit_source).toBe('tag')
    expect(a.turn_lanes).toEqual(['left', 'through'])
    const b = sem.find((s) => s.id === 'b')!
    expect(b.speed_limit_kmh).toBe(30)
    expect(b.speed_limit_source).toBe('default')
    expect(b.turn_lanes).toBeNull()
    expect(sem.find((s) => s.id === 'c')!.roundabout).toBe(true)
  })
})

describe('traffic devices + audit (M3 Slice F §8.5)', () => {
  const objects = [
    obj('sig1', 'traffic-signal', { kind: undefined }, 1.2),
    obj('stop1', 'street-furniture', { kind: 'stop_sign', signType: undefined }, 0.5),
    obj('spd1', 'street-furniture', { kind: 'speed_limit', speedKmh: 50, display: '30 mph' }, -0.5),
    obj('sign1', 'street-furniture', { kind: 'road_sign', signType: 'US:W1-1' }),
    obj('bench1', 'street-furniture', { kind: 'bench' }), // not a device
    obj('bldg', 'building', {}), // not a device
  ]

  it('extracts only signals + signs, with heading, position and metadata', () => {
    const dev = buildTrafficDevices(objects)
    expect(dev.map((d) => d.id).sort()).toEqual(['sig1', 'sign1', 'spd1', 'stop1'])
    const sig = dev.find((d) => d.id === 'sig1')!
    expect(sig.kind).toBe('traffic_signal')
    expect(sig.heading_rad).toBeCloseTo(1.2, 5)
    const spd = dev.find((d) => d.id === 'spd1')!
    expect(spd.kind).toBe('speed_limit')
    expect(spd.speed_limit_kmh).toBe(50)
    expect(dev.find((d) => d.id === 'sign1')!.sign_type).toBe('US:W1-1')
  })

  it('ignores deleted objects', () => {
    const withDeleted = [...objects, { ...obj('sigX', 'traffic-signal', {}), deleted: true }]
    expect(buildTrafficDevices(withDeleted).some((d) => d.id === 'sigX')).toBe(false)
  })

  it('audit flags low-confidence (defaulted) speeds and gates training-ready', () => {
    const dev = buildTrafficDevices(objects)
    const mixed = buildTrafficAudit([road('a', { maxspeedKmh: 50 }), road('b', { roadClass: 'residential' })], dev)
    expect(mixed.speed_tagged).toBe(1)
    expect(mixed.speed_defaulted).toBe(1)
    expect(mixed.training_ready).toBe(false) // a defaulted speed remains
    expect(mixed.signals).toBe(1)
    expect(mixed.signs).toBe(3)

    const allTagged = buildTrafficAudit([road('a', { maxspeedKmh: 50 }), road('b', { maxspeedKmh: 40 })], dev)
    expect(allTagged.training_ready).toBe(true)
  })
})
