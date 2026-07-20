import { describe, expect, it } from 'vitest'
import { bankProfile, CROSS_K, crossFade, crossOffset, CROWN_SLOPE, withCrossSection, CROSS_SECTION } from '../procgen/crossSection'
import { crownedRibbonGeometry } from '../procgen/geometry'
import type { Vec2 } from '../types'

describe('cross-section profile (crown + superelevation)', () => {
  it('crowns the centre and leaves the kerbs at grade', () => {
    const half = 6
    expect(crossOffset(0, half, 0)).toBeCloseTo(CROWN_SLOPE * half, 6) // centre peak
    expect(crossOffset(-1, half, 0)).toBeCloseTo(0, 6) // left kerb at grade
    expect(crossOffset(1, half, 0)).toBeCloseTo(0, 6) // right kerb at grade
    // symmetric about the centreline
    expect(crossOffset(-0.5, half, 0)).toBeCloseTo(crossOffset(0.5, half, 0), 6)
  })

  it('banks the outer edge up under superelevation', () => {
    const half = 6
    const bank = 0.05
    // +bank raises the +lateral (right) edge and lowers the left
    expect(crossOffset(1, half, bank)).toBeGreaterThan(crossOffset(-1, half, bank))
  })

  it('fades crown to zero at the ends and full in the middle', () => {
    const L = 100
    expect(crossFade(0, L)).toBe(0)
    expect(crossFade(L, L)).toBe(0)
    expect(crossFade(L / 2, L)).toBe(1)
    expect(crossFade(3, L)).toBeCloseTo(0.5, 5) // half-way up the 6 m taper
  })

  it('bankProfile is ~zero on a straight road and non-zero on a curve', () => {
    const straight: Vec2[] = [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 40, z: 0 },
      { x: 60, z: 0 },
    ]
    expect(bankProfile(straight).every((b) => Math.abs(b) < 1e-6)).toBe(true)

    const curve: Vec2[] = [
      { x: 0, z: 0 },
      { x: 20, z: 2 },
      { x: 38, z: 10 },
      { x: 50, z: 26 },
    ]
    expect(bankProfile(curve).some((b) => Math.abs(b) > 1e-3)).toBe(true)
  })

  it('crownedRibbonGeometry raises the centre above the kerbs (flat profile)', () => {
    const n = 5
    const left: Vec2[] = Array.from({ length: n }, (_, i) => ({ x: i * 10, z: -6 }))
    const right: Vec2[] = Array.from({ length: n }, (_, i) => ({ x: i * 10, z: 6 }))
    const fades = Array.from({ length: n }, () => 1) // full crown everywhere
    const banks = Array.from({ length: n }, () => 0)
    const g = crownedRibbonGeometry(left, right, 0.05, 6, fades, banks)
    const pos = g.getAttribute('position')
    const lane = g.getAttribute('aLane')
    expect(pos.count).toBe(n * CROSS_K)
    // at a mid station, the centre sample (lane≈0) sits above the kerb samples (lane≈±1)
    const mid = 2 * CROSS_K
    let centreY = -Infinity
    let kerbY = Infinity
    for (let k = 0; k < CROSS_K; k++) {
      const y = pos.getY(mid + k)
      if (Math.abs(lane.getX(mid + k)) < 1e-6) centreY = y
      if (Math.abs(Math.abs(lane.getX(mid + k)) - 1) < 1e-6) kerbY = Math.min(kerbY, y)
    }
    expect(centreY).toBeGreaterThan(kerbY)
    expect(centreY - kerbY).toBeCloseTo(CROWN_SLOPE * 6, 4) // 2% of half-width
  })

  it('withCrossSection restores the flag', () => {
    const before = CROSS_SECTION.enabled
    withCrossSection(!before, () => {
      expect(CROSS_SECTION.enabled).toBe(!before)
    })
    expect(CROSS_SECTION.enabled).toBe(before)
  })
})
