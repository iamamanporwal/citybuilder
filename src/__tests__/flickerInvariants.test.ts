import { describe, expect, it } from 'vitest'
import { DEPTH_CONFIG, depthQuantumAt, LAYER_CONVENTION, MIN_SEPARATION } from '../editor/depthConfig'
import { DecalPlanner } from '../procgen/decalPlan'
import { seededRandom } from '../procgen/geometry'

// Regression suite for z-fighting. Root cause was depth-buffer precision: with
// a standard perspective depth buffer (near=1, far=4500) the smallest
// resolvable separation at the default camera distance (~570 m) is ~19 mm —
// larger than the 10 mm layer gaps — so the flat-layer stack flickered when
// zoomed out. These tests pin the invariant that fixed it.

describe('depth precision invariant', () => {
  it('uses a logarithmic depth buffer', () => {
    expect(DEPTH_CONFIG.logarithmicDepthBuffer).toBe(true)
  })

  it('resolves the minimum layer separation everywhere in the frustum', () => {
    // worst case is the far plane; require 1.5x headroom
    expect(depthQuantumAt(DEPTH_CONFIG.far) * 1.5).toBeLessThan(MIN_SEPARATION)
  })

  it('documents why standard depth is insufficient (guards against "simplifying" the flag away)', () => {
    const standard = { ...DEPTH_CONFIG, logarithmicDepthBuffer: false }
    // at the default editor camera distance the standard buffer already
    // cannot separate the layers — reverting the flag must fail this suite
    expect(depthQuantumAt(570, standard)).toBeGreaterThan(MIN_SEPARATION)
  })

  it('keeps every layer pair separated by at least MIN_SEPARATION', () => {
    const sorted = [...LAYER_CONVENTION].sort((a, b) => a[1] - b[1])
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i][1] - sorted[i - 1][1]
      expect(gap, `${sorted[i - 1][0]} -> ${sorted[i][0]}`).toBeGreaterThanOrEqual(MIN_SEPARATION - 1e-9)
    }
  })
})

describe('decal placement (exactly coplanar layer)', () => {
  it('never accepts two overlapping decals', () => {
    const rand = seededRandom('decals')
    const planner = new DecalPlanner()
    const accepted: { c: { x: number; z: number }; half: number }[] = []
    for (let i = 0; i < 2000; i++) {
      const c = { x: rand() * 400 - 200, z: rand() * 400 - 200 }
      const half = 0.9 + rand() * 1.4
      if (planner.tryPlace(c, half)) accepted.push({ c, half })
    }
    expect(accepted.length).toBeGreaterThan(100) // planner still places plenty
    for (let i = 0; i < accepted.length; i++) {
      for (let j = i + 1; j < accepted.length; j++) {
        const a = accepted[i], b = accepted[j]
        // axis-aligned worst case: quads cannot overlap if circumcircles clear
        const dist = Math.hypot(a.c.x - b.c.x, a.c.z - b.c.z)
        expect(dist).toBeGreaterThanOrEqual((a.half + b.half) * Math.SQRT2 - 1e-9)
      }
    }
  })
})
