import { describe, expect, it } from 'vitest'
import type { RoadSegment, Vec2 } from '../types'
import type { LandCoverClass, ZoneKind } from '../resolver/types'
import { planRoadsideVegetation } from '../procgen/vegetation'

// Pure-planner regression suite. No THREE / canvas — the scatter is deterministic
// geometry, so we can assert placement rules without a renderer.

function road(over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id: 'r1',
    roadClass: 'residential',
    points: [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ],
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

// ctx stub: land cover / zone driven by simple predicates the test controls.
function ctx(cover: (p: Vec2) => LandCoverClass, zone: ZoneKind = 'residential') {
  return { landCoverAt: cover, zoneAt: (_p: Vec2) => zone }
}

const flat = () => 0

describe('planRoadsideVegetation', () => {
  it('is deterministic — identical input yields identical output', () => {
    const roads = [road()]
    const c = ctx(() => 'grass')
    const a = planRoadsideVegetation(roads, c, flat)
    const b = planRoadsideVegetation(roads, c, flat)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('only scatters where land cover is grass or bare', () => {
    const built = planRoadsideVegetation([road()], ctx(() => 'built'), flat)
    const water = planRoadsideVegetation([road()], ctx(() => 'water'), flat)
    const grass = planRoadsideVegetation([road()], ctx(() => 'grass'), flat)
    expect(built).toHaveLength(0)
    expect(water).toHaveLength(0)
    expect(grass.length).toBeGreaterThan(0)
  })

  it('never places a tuft inside the carriageway', () => {
    const r = road({ widthM: 10 })
    const out = planRoadsideVegetation([r], ctx(() => 'grass'), flat)
    for (const inst of out) {
      // road runs along x with centerline z=0; |z| must clear the half-width
      expect(Math.abs(inst.z)).toBeGreaterThanOrEqual(r.widthM / 2 - 1e-6)
    }
  })

  it('skips bridges and tunnels (no verge beside a deck)', () => {
    expect(planRoadsideVegetation([road({ bridge: true })], ctx(() => 'grass'), flat)).toHaveLength(0)
    expect(planRoadsideVegetation([road({ tunnel: true })], ctx(() => 'grass'), flat)).toHaveLength(0)
  })

  it('respects the global budget', () => {
    // a long, dense park road would blow past a tiny budget; the planner caps it
    const long = road({ points: [{ x: 0, z: 0 }, { x: 4000, z: 0 }] })
    const out = planRoadsideVegetation([long], ctx(() => 'grass', 'park'), flat, { grass: 50, shrub: 10 })
    expect(out.filter((i) => i.kind === 'grass').length).toBeLessThanOrEqual(50)
    expect(out.filter((i) => i.kind === 'shrub').length).toBeLessThanOrEqual(10)
  })

  it('grass sits on the sampled ground height', () => {
    const out = planRoadsideVegetation([road()], ctx(() => 'grass'), (x) => x * 0.01)
    for (const inst of out) expect(inst.y).toBeCloseTo(inst.x * 0.01, 6)
  })

  it('park zones scatter denser than commercial', () => {
    const park = planRoadsideVegetation([road()], ctx(() => 'grass', 'park'), flat)
    const commercial = planRoadsideVegetation([road()], ctx(() => 'grass', 'commercial'), flat)
    expect(park.length).toBeGreaterThan(commercial.length)
  })
})
