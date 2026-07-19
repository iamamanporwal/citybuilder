import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { conformTerrainToRoads, type RoadCorridor, type TerrainField } from '../procgen/terrain/field'
import { withCorridorElevation } from '../procgen/corridor'

// Roads-on-the-ground contract (PRD §7C/§8): the visible ground CONFORMS to the
// solved road surface so roads are never buried, junctions take the shape of
// their arms (no oval blobs), and curbs are anchored in the ground (no floats).

vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { roadMaterial: mat, sidewalkMaterial: mat(), facadeMaterial: mat, roofMaterial: mat, decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() } }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => new THREE.MeshBasicMaterial() }) }
})

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return { id, roadClass: 'primary', points, widthM: 12, lanes: 2, oneway: false, bridge: false, tunnel: false, layer: 0, centerLat: 0, centerLng: 0, ...over }
}
const resolution: RoadResolution = {
  surface: 'asphalt-worn',
  marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
  crossSection: { sidewalks: true, sidewalkWidth: 2.4, curbHeight: 0.22 },
  decalDensity: 0, provenance: [], confidence: 1,
}
const bounds = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }

// ---- issue #1: ground conforms to the road corridor -----------------------

describe('conformTerrainToRoads (ground follows the road, roads never buried)', () => {
  // a "hill" 5 m above datum everywhere; one road corridor solved down at 0 m.
  const hill: TerrainField = { sample: () => 5, enabled: true }
  const corridor: RoadCorridor = { pts: [{ x: -80, z: 0 }, { x: 80, z: 0 }], elev: [0, 0], half: 6, pave: 4 }

  it('returns the road-surface elevation on the paved corridor, not the hill', () => {
    const f = conformTerrainToRoads(hill, [corridor], bounds)
    // on the carriageway centre and out to the paved margin: ground == road (0)
    expect(f.sample(0, 0)).toBeCloseTo(0, 3)
    expect(f.sample(40, 0)).toBeCloseTo(0, 3)
    expect(f.sample(0, 6)).toBeCloseTo(0, 3) // curb edge (half)
  })

  it('eases back up to the natural hill away from the road (a graded shoulder)', () => {
    const f = conformTerrainToRoads(hill, [corridor], bounds)
    expect(f.sample(0, 60)).toBeCloseTo(5, 3) // well clear of the shoulder → natural
    const mid = f.sample(0, 16) // inside the shoulder blend → between road and hill
    expect(mid).toBeGreaterThan(0.1)
    expect(mid).toBeLessThan(4.9)
  })

  it('is a one-way burn: exposes its natural base and is deterministic', () => {
    const f = conformTerrainToRoads(hill, [corridor], bounds)
    expect(f.base).toBe(hill) // the elevation solve reads the base, never the conform
    expect(f.sample(12.3, 4.5)).toBe(f.sample(12.3, 4.5))
  })

  it('leaves a disabled (flat-world) field untouched', () => {
    const flat: TerrainField = { sample: () => 0, enabled: false }
    expect(conformTerrainToRoads(flat, [corridor], bounds)).toBe(flat)
  })
})

// ---- issue #2: junctions take the shape of their arms (not ovals) ---------

/** True when (x,z) lies inside any triangle of an indexed XZ-planar geometry. */
function covers(geo: THREE.BufferGeometry, x: number, z: number): boolean {
  const pos = geo.getAttribute('position')
  const idx = geo.getIndex()!
  const sign = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (ax - cx) * (bz - cz) - (bx - cx) * (az - cz)
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c)
    const d1 = sign(x, z, ax, az, bx, bz)
    const d2 = sign(x, z, bx, bz, cx, cz)
    const d3 = sign(x, z, cx, cz, ax, az)
    const neg = d1 < 0 || d2 < 0 || d3 < 0
    const posv = d1 > 0 || d2 > 0 || d3 > 0
    if (!(neg && posv)) return true
  }
  return false
}

describe('junction outline follows the arms (a filled crossing, not an oval)', () => {
  const build = (roads: RoadSegment[]) =>
    withCorridorElevation(true, () => buildRoadsSync(roads))
  let buildRoadsSync: (roads: RoadSegment[]) => ReturnType<typeof import('../procgen/roads').buildRoads>

  it('a 4-way pad FILLS the crossing (covers the corners an inscribed disc would miss)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    buildRoadsSync = (roads) =>
      buildRoads({ roads } as unknown as CityGraph, {} as ResolvedContext, new Map(roads.map((r) => [r.id, resolution])))
    const plus = build([
      road('e', [{ x: 0, z: 0 }, { x: 80, z: 0 }]),
      road('w', [{ x: 0, z: 0 }, { x: -80, z: 0 }]),
      road('s', [{ x: 0, z: 0 }, { x: 0, z: 80 }]),
      road('n', [{ x: 0, z: 0 }, { x: 0, z: -80 }]),
    ])
    const g = plus.intersections!.geometry
    // width 12 → the two road bands cross in a ~15 m square. The pad must cover the
    // whole crossing INCLUDING its corners — (6,6) sits inside the crossing square
    // but OUTSIDE the old inscribed disc (discRadius ≈ 7 m ⇒ misses the corner).
    // Covering it proves the pad is the true crossing footprint, not a round pad.
    expect(covers(g, 0, 0)).toBe(true) // centre
    expect(covers(g, 6, 0)).toBe(true) // arms
    expect(covers(g, 0, 6)).toBe(true)
    expect(covers(g, 6, 6)).toBe(true) // crossing CORNER — a disc/oval would miss this
    // …but it does NOT bulge out into the grass beyond the crossing.
    expect(covers(g, 30, 0)).toBe(false) // far down an arm
    expect(covers(g, 16, 16)).toBe(false) // far diagonal (grass)
  })

  it('a T junction paves its three arms but not the missing fourth side', async () => {
    const { buildRoads } = await import('../procgen/roads')
    // arms E, W (crossbar) and S (+z stem); no north (−z) arm beyond the crossbar.
    const tee = build([
      road('e', [{ x: 0, z: 0 }, { x: 80, z: 0 }]),
      road('w', [{ x: 0, z: 0 }, { x: -80, z: 0 }]),
      road('s', [{ x: 0, z: 0 }, { x: 0, z: 80 }]),
    ])
    const g = tee.intersections!.geometry
    expect(covers(g, 0, 0)).toBe(true)
    expect(covers(g, 6, 0)).toBe(true) // east arm
    expect(covers(g, 0, 6)).toBe(true) // south stem
    // no north arm: nothing paved well past the crossbar edge on the −z side
    expect(covers(g, 0, -20)).toBe(false)
  })
})

// ---- issue #3: curbs are anchored in the ground (no floating sidewalks) ----

describe('sidewalk curbs have a foundation skirt (no floating curbs)', () => {
  it('the curb slab extends below the road surface into the ground', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const roads = [road('main', [{ x: -80, z: 0 }, { x: 80, z: 0 }])]
    const result = withCorridorElevation(true, () =>
      buildRoads({ roads } as unknown as CityGraph, {} as ResolvedContext, new Map(roads.map((r) => [r.id, resolution]))))
    const pos = result.sidewalks!.geometry.getAttribute('position')
    let minY = Infinity, maxY = -Infinity
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    // flat road ⇒ base 0; curb top sits at curbHeight; the skirt now reaches a
    // foundation-depth BELOW grade so the curb is anchored (never floats).
    expect(maxY).toBeCloseTo(0.22, 2) // curb top = curbHeight above the road
    expect(minY).toBeLessThan(-0.2) // skirt reaches down into the ground
    expect(minY).toBeGreaterThan(-0.5) // but only one foundation depth, not runaway
  })
})
