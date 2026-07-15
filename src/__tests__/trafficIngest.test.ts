import { describe, expect, it } from 'vitest'
import { ingestOverpass } from '../ingest/overpass'

// Faithful traffic tier (Road-updates.md §1, §8): OSM road/traffic tags we now
// ingest — speed limits, turn lanes, direction normalisation. These feed signs,
// lane arrows and the semantic export the trainer consumes.

interface Tags {
  [k: string]: string
}
const way = (id: number, tags: Tags, coords: [number, number][]) => ({
  type: 'way' as const,
  id,
  tags,
  geometry: coords.map(([lat, lon]) => ({ lat, lon })),
})
const node = (id: number, tags: Tags, lat: number, lon: number) => ({
  type: 'node' as const,
  id,
  tags,
  lat,
  lon,
})
const raw = (elements: unknown[]) => ({ elements: elements as never })
const L: [number, number][] = [
  [0, 0],
  [0, 0.01],
]

describe('faithful traffic ingest — road tags (M2 Slice A)', () => {
  it('parses maxspeed as km/h, converting mph and special values', () => {
    const g = ingestOverpass(
      raw([
        way(1, { highway: 'primary', maxspeed: '50' }, L),
        way(2, { highway: 'primary', maxspeed: '30 mph' }, L),
        way(3, { highway: 'primary', maxspeed: '50 km/h' }, L),
        way(4, { highway: 'primary' }, L),
        way(5, { highway: 'motorway', maxspeed: 'none' }, L),
        way(6, { highway: 'living_street', maxspeed: 'walk' }, L),
      ]),
      'T',
    )
    const by = (id: number) => g.roads.find((r) => r.id === `road_${id}`)!
    expect(by(1).maxspeedKmh).toBe(50) // bare number = km/h (OSM convention)
    expect(by(2).maxspeedKmh).toBe(48) // 30 mph → 48 km/h
    expect(by(3).maxspeedKmh).toBe(50)
    expect(by(4).maxspeedKmh).toBeUndefined() // untagged ⇒ resolver default later
    expect(by(5).maxspeedKmh).toBe(130) // 'none' → high display cap
    expect(by(6).maxspeedKmh).toBe(7) // 'walk'
  })

  it('parses turn:lanes into one entry per lane (L→R), preserving multi-turn cells', () => {
    const g = ingestOverpass(
      raw([way(1, { highway: 'primary', lanes: '3', 'turn:lanes': 'left|through|through;right' }, L)]),
      'T',
    )
    expect(g.roads[0].turnLanes).toEqual(['left', 'through', 'through;right'])
    // untagged ⇒ undefined, not an empty array
    const g2 = ingestOverpass(raw([way(2, { highway: 'primary' }, L)]), 'T')
    expect(g2.roads[0].turnLanes).toBeUndefined()
  })

  it('normalises oneway=-1 by reversing geometry and marking the road one-way', () => {
    const tri: [number, number][] = [
      [0, 0],
      [0, 0.01],
      [0, 0.02],
    ]
    const fwd = ingestOverpass(raw([way(1, { highway: 'primary' }, tri)]), 'T').roads[0]
    const rev = ingestOverpass(raw([way(1, { highway: 'primary', oneway: '-1' }, tri)]), 'T').roads[0]
    expect(fwd.oneway).toBe(false)
    expect(rev.oneway).toBe(true)
    // reversed: rev's first point is the same world coord as fwd's last point
    const fl = fwd.points[fwd.points.length - 1]
    expect(rev.points[0].x).toBeCloseTo(fl.x, 6)
    expect(rev.points[0].z).toBeCloseTo(fl.z, 6)
  })

  it('treats junction=roundabout as one-way and flags it', () => {
    const g = ingestOverpass(raw([way(1, { highway: 'primary', junction: 'roundabout' }, L)]), 'T')
    expect(g.roads[0].oneway).toBe(true)
    expect(g.roads[0].roundabout).toBe(true)
  })

  it('recognises the standard oneway spellings', () => {
    for (const v of ['yes', 'true', '1']) {
      const g = ingestOverpass(raw([way(1, { highway: 'primary', oneway: v }, L)]), 'T')
      expect(g.roads[0].oneway).toBe(true)
    }
    const no = ingestOverpass(raw([way(1, { highway: 'primary', oneway: 'no' }, L)]), 'T')
    expect(no.roads[0].oneway).toBe(false)
  })

  // guard: a node element in the mix must not break road parsing
  it('ingests roads alongside traffic-signal nodes without interference', () => {
    const g = ingestOverpass(
      raw([way(1, { highway: 'primary', maxspeed: '40' }, L), node(2, { highway: 'traffic_signals' }, 0, 0)]),
      'T',
    )
    expect(g.roads).toHaveLength(1)
    expect(g.roads[0].maxspeedKmh).toBe(40)
    expect(g.report.signalCount).toBe(1)
  })
})

describe('faithful traffic ingest — device nodes (M2 Slice B)', () => {
  // a way is needed so ingest has geometry for the origin/frame
  const base = way(99, { highway: 'primary' }, L)
  const dev = (elements: unknown[]) => ingestOverpass(raw([base, ...elements]), 'T')
  const find = (g: ReturnType<typeof dev>, kind: string) => g.points.filter((p) => p.kind === kind)

  it('parses stop and give_way regulatory nodes', () => {
    const g = dev([node(1, { highway: 'stop' }, 0, 0.001), node(2, { highway: 'give_way' }, 0, 0.002)])
    expect(find(g, 'stop_sign')).toHaveLength(1)
    expect(find(g, 'give_way')).toHaveLength(1)
  })

  it('parses crossings with their style in signType', () => {
    const g = dev([
      node(1, { highway: 'crossing', crossing: 'zebra' }, 0, 0.001),
      node(2, { highway: 'crossing', crossing: 'traffic_signals' }, 0, 0.002),
    ])
    const cx = find(g, 'crossing')
    expect(cx).toHaveLength(2)
    expect(cx.map((c) => c.signType).sort()).toEqual(['traffic_signals', 'zebra'])
  })

  it('parses generic traffic_sign nodes carrying the OSM sign class', () => {
    const g = dev([
      node(1, { traffic_sign: 'US:R1-1' }, 0, 0.001),
      node(2, { traffic_sign: 'maxspeed', maxspeed: '30' }, 0, 0.002),
    ])
    const signs = find(g, 'road_sign')
    expect(signs).toHaveLength(2)
    expect(signs.map((s) => s.signType).sort()).toEqual(['US:R1-1', 'maxspeed'])
  })

  it('prefers a specific regulatory kind over the generic traffic_sign fallback', () => {
    // a stop node that also carries traffic_sign should classify as stop_sign
    const g = dev([node(1, { highway: 'stop', traffic_sign: 'US:R1-1' }, 0, 0.001)])
    expect(find(g, 'stop_sign')).toHaveLength(1)
    expect(find(g, 'road_sign')).toHaveLength(0)
  })
})
