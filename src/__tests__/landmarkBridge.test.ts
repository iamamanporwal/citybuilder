import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { RoadSegment, Vec2 } from '../types'
import { findLandmark, matchBridgeLandmark } from '../scene/landmarks'
import { buildArchBridge, buildSuspensionBridge, chainCenterlines } from '../procgen/bridges'

function road(over: Partial<RoadSegment>): RoadSegment {
  return {
    id: 'road_1', roadClass: 'primary', points: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
    widthM: 20, lanes: 4, oneway: false, bridge: false, tunnel: false, layer: 1,
    centerLat: 37.82, centerLng: -122.48, ...over,
  }
}

describe('landmark catalog matching', () => {
  it('matches the Golden Gate Bridge by wikidata and by name (international orange)', () => {
    expect(findLandmark(undefined, 'Q44440')?.id).toBe('golden-gate-bridge')
    const m = matchBridgeLandmark(road({ bridge: true, name: 'Golden Gate Bridge' }))
    expect(m?.id).toBe('golden-gate-bridge')
    expect(m?.category).toBe('suspension-bridge')
    expect(m?.color).toBe('#c0362c')
  })

  it('does not match non-bridge roads', () => {
    expect(matchBridgeLandmark(road({ bridge: false, name: 'Golden Gate Bridge' }))).toBeNull()
  })

  it('falls back to a generic suspension structure for bridge:structure=suspension', () => {
    const m = matchBridgeLandmark(road({ bridge: true, name: 'Some Strait Crossing', structure: 'suspension' }))
    expect(m?.category).toBe('suspension-bridge')
  })

  it('matches Charles Bridge (Karlův most) by wikidata Q204871 and by name → stone arch', () => {
    expect(findLandmark(undefined, 'Q204871')?.id).toBe('charles-bridge')
    const m = matchBridgeLandmark(road({ bridge: true, roadClass: 'pedestrian', name: 'Karlův most', structure: 'arch' }))
    expect(m?.id).toBe('charles-bridge')
    expect(m?.category).toBe('stone-arch-bridge')
  })

  it('falls back to a generic stone-arch structure for bridge:structure=arch', () => {
    const m = matchBridgeLandmark(road({ bridge: true, name: 'Old Stone Bridge', structure: 'arch' }))
    expect(m?.category).toBe('stone-arch-bridge')
  })
})

describe('stone-arch bridge generator', () => {
  const deckY = 6.55
  const grp = buildArchBridge([{ x: 0, z: 0 }, { x: 470, z: 0 }], 10, { color: '#b8a883', deckY, towers: true })

  it('builds a masonry structure springing from the water with gate towers above the deck', () => {
    expect(grp).not.toBeNull()
    expect(grp!.children.length).toBe(2) // stone mesh + tower mesh
    const box = new THREE.Box3().setFromObject(grp!)
    expect(box.min.y).toBeLessThanOrEqual(0.6) // piers/arches reach down to the water
    expect(box.max.y).toBeGreaterThan(deckY + 20) // gothic towers dominate the silhouette
  })

  it('returns null for spans too short to be an arch bridge', () => {
    expect(buildArchBridge([{ x: 0, z: 0 }, { x: 20, z: 0 }], 6, { color: '#fff', deckY })).toBeNull()
  })

  it('builds without towers when not requested', () => {
    const g = buildArchBridge([{ x: 0, z: 0 }, { x: 200, z: 0 }], 8, { color: '#b8a883', deckY })
    expect(g).not.toBeNull()
    expect(g!.children.length).toBe(1) // stone mesh only
  })
})

describe('suspension bridge generator', () => {
  const deckY = 6.55
  const grp = buildSuspensionBridge([{ x: 0, z: 0 }, { x: 260, z: 0 }], 24, { color: '#c0362c', deckY })

  it('builds a structure with towers rising well above the deck', () => {
    expect(grp).not.toBeNull()
    expect(grp!.children.length).toBe(2) // structure mesh + cable mesh
    const box = new THREE.Box3().setFromObject(grp!)
    // towers push the silhouette far above the deck — the recognizable part
    expect(box.max.y).toBeGreaterThan(deckY + 24)
  })

  it('returns null for spans too short to be a suspension bridge', () => {
    expect(buildSuspensionBridge([{ x: 0, z: 0 }, { x: 20, z: 0 }], 12, { color: '#fff', deckY })).toBeNull()
  })
})

describe('centerline chaining', () => {
  it('chains contiguous bridge segments head-to-tail', () => {
    const a: Vec2[] = [{ x: 0, z: 0 }, { x: 100, z: 0 }]
    const b: Vec2[] = [{ x: 100, z: 0 }, { x: 200, z: 0 }]
    const chained = chainCenterlines([road({ points: a }), road({ points: b, id: 'road_2' })])
    expect(chained[0]).toEqual({ x: 0, z: 0 })
    expect(chained[chained.length - 1]).toEqual({ x: 200, z: 0 })
  })
})
