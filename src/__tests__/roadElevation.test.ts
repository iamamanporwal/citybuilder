import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import {
  analyzeRoadNodes,
  BRIDGE_LAYER_H,
  cumulative,
  elevationProfile,
  MAX_RAMP_GRADE,
  rampSpecFor,
} from '../procgen/roadNetwork'
import { smoothPolyline } from '../procgen/geometry'
import { withCorridorElevation } from '../procgen/corridor'

// Materials build canvas textures at module load — stub them so buildRoads
// runs in plain node for the renderer-parity test.
vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return {
    roadMaterial: mat,
    sidewalkMaterial: mat(),
    facadeMaterial: mat,
    roofMaterial: mat,
    decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() },
  }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => mat() }) }
})

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
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
  }
}

function line(x0: number, x1: number, step: number): Vec2[] {
  const pts: Vec2[] = []
  for (let x = x0; x <= x1 + 1e-9; x += step) pts.push({ x, z: 0 })
  return pts
}

const resolution: RoadResolution = {
  surface: 'asphalt-worn',
  marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
  crossSection: { sidewalks: false, sidewalkWidth: 2.4, curbHeight: 0.22 },
  decalDensity: 0,
  provenance: [],
  confidence: 1,
}

describe('bridge elevation profiles', () => {
  it('isolated bridge (no grounded ends) stays at full layer height', () => {
    const b = road('b1', line(0, 300, 20), { bridge: true, layer: 1 })
    const nodes = analyzeRoadNodes([b])
    const cum = cumulative(b.points)
    const spec = rampSpecFor(b, cum[cum.length - 1], nodes)!
    expect(spec.fullElev).toBeCloseTo(BRIDGE_LAYER_H)
    const profile = elevationProfile(spec, cum)
    for (const y of profile) expect(y).toBeCloseTo(BRIDGE_LAYER_H, 6)
  })

  it('ramps from a grounded end, grade-limited, monotone up to the plateau', () => {
    const b = road('b1', line(0, 300, 20), { bridge: true, layer: 1 })
    const approach = road('a1', [{ x: -80, z: 0 }, { x: 0, z: 0 }])
    const nodes = analyzeRoadNodes([b, approach])
    const spec = rampSpecFor(b, 300, nodes)!
    expect(spec.startElev).toBe(0)
    expect(spec.endElev).toBeCloseTo(BRIDGE_LAYER_H)
    // dense sampling for the grade check
    const cum: number[] = []
    for (let d = 0; d <= 300; d += 1) cum.push(d)
    const profile = elevationProfile(spec, cum)
    expect(profile[0]).toBeCloseTo(0, 6)
    expect(profile[profile.length - 1]).toBeCloseTo(BRIDGE_LAYER_H, 6)
    let maxGrade = 0
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i]).toBeGreaterThanOrEqual(profile[i - 1] - 1e-9) // monotone
      maxGrade = Math.max(maxGrade, Math.abs(profile[i] - profile[i - 1]) / (cum[i] - cum[i - 1]))
    }
    // eased curve peaks at π/2 × mean grade — the physical grade cap for lints
    expect(maxGrade).toBeLessThanOrEqual(MAX_RAMP_GRADE * 1.6)
  })

  it('at-grade segments produce an all-zero profile', () => {
    const r = road('r1', line(0, 100, 10))
    const nodes = analyzeRoadNodes([r])
    expect(rampSpecFor(r, 100, nodes)).toBeNull()
    const profile = elevationProfile(null, cumulative(r.points))
    for (const y of profile) expect(y).toBe(0)
  })

  it('short bridges clamp ramp length without NaN', () => {
    const b = road('b1', [{ x: 0, z: 0 }, { x: 30, z: 0 }], { bridge: true, layer: 1 })
    const nodes = analyzeRoadNodes([b])
    const spec = rampSpecFor(b, 30, nodes)!
    expect(spec.rampLen).toBeCloseTo(20)
    const profile = elevationProfile(spec, cumulative(b.points))
    for (const y of profile) {
      expect(Number.isFinite(y)).toBe(true)
      expect(y).toBeLessThanOrEqual(BRIDGE_LAYER_H + 1e-9)
    }
  })
})

describe('renderer parity', () => {
  // The legacy per-segment renderer path (flag OFF). Pinned off explicitly since
  // the network solve is now the default (E3); the network path's own renderer
  // parity lives in corridorElevation.test.ts.
  it('buildRoads bridge deck Y equals elevationProfile + Y_ROAD (legacy path, flag off)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    withCorridorElevation(false, () => {
      const bridge = road('bridge', line(0, 300, 20), { bridge: true, layer: 1 })
      const approach = road('approach', [{ x: -80, z: 0 }, { x: 0, z: 0 }])
      const graph = { roads: [bridge, approach] } as unknown as CityGraph
      const resolutions = new Map([
        ['bridge', resolution],
        ['approach', resolution],
      ])
      const result = buildRoads(graph, {} as ResolvedContext, resolutions)
      const mesh = result.roadMeshes.get('bridge')!
      expect(mesh).toBeDefined()

      const pts = smoothPolyline(bridge.points)
      const cum = cumulative(pts)
      const nodes = analyzeRoadNodes(graph.roads)
      const expected = elevationProfile(rampSpecFor(bridge, cum[cum.length - 1], nodes), cum).map(
        (e) => e + 0.05, // Y_ROAD cosmetic offset (roads.ts)
      )
      const pos = mesh.geometry.getAttribute('position')
      expect(pos.count).toBe(pts.length * 2) // ribbon: left+right vertex per point
      for (let i = 0; i < pts.length; i++) {
        expect(pos.getY(i * 2)).toBeCloseTo(expected[i], 5)
        expect(pos.getY(i * 2 + 1)).toBeCloseTo(expected[i], 5)
      }
    })
  })
})
