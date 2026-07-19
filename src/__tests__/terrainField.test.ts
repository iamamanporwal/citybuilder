import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../types'
import { buildTerrainField, type WaterRingLite } from '../procgen/terrain/field'
import { isTerrainEnabled, setTerrainEnabled, TERRAIN, withTerrain } from '../procgen/terrain/config'

// The terrain height field: deterministic, hydrology-aware, and inert when off.

const bounds = { minX: -400, maxX: 400, minZ: -400, maxZ: 400 }
// a lake ring roughly in the middle of the area
const lake: WaterRingLite = {
  ring: [
    { x: -120, z: -80 }, { x: 120, z: -80 }, { x: 120, z: 80 }, { x: -120, z: 80 },
  ] as Vec2[],
  holes: [],
}

describe('terrain field', () => {
  it('returns a zero field when the flag is off (flat world, byte-identical)', () => {
    withTerrain(false, () => {
      const f = buildTerrainField(bounds, [lake])
      expect(f.enabled).toBe(false)
      for (const [x, z] of [[0, 0], [200, -150], [-350, 300], [50, 50]]) {
        expect(f.sample(x, z)).toBe(0)
      }
    })
  })

  it('is deterministic — same inputs produce identical samples', () => {
    withTerrain(true, () => {
      const a = buildTerrainField(bounds, [lake])
      const b = buildTerrainField(bounds, [lake])
      for (const [x, z] of [[0, 0], [200, -150], [-350, 300], [37, -212], [123, 45]]) {
        expect(a.sample(x, z)).toBe(b.sample(x, z))
      }
    })
  })

  it('seats water in a valley: submerged riverbed inside, dry ground outside', () => {
    withTerrain(true, () => {
      const f = buildTerrainField(bounds, [lake])
      // a point well inside the lake sits on the submerged riverbed, below the
      // opaque water surface (so the surface always hides it)
      const inside = f.sample(0, 0)
      expect(inside).toBeLessThan(TERRAIN.waterSurfaceY)
      expect(inside).toBeCloseTo(TERRAIN.riverbedY, 5)
      // a point far from the water rises toward base grade (well above the surface)
      const far = f.sample(-380, 380)
      expect(far).toBeGreaterThan(TERRAIN.waterSurfaceY)
    })
  })

  it('keeps relief subtle & drivable (bounded amplitude, gentle grades)', () => {
    withTerrain(true, () => {
      const f = buildTerrainField(bounds, []) // no water → pure macro relief
      let min = Infinity, max = -Infinity
      const step = 20
      for (let x = bounds.minX; x <= bounds.maxX; x += step) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z += step) {
          const h = f.sample(x, z)
          min = Math.min(min, h); max = Math.max(max, h)
        }
      }
      // within the tuned amplitude (a little slack for bilinear interpolation)
      expect(max).toBeLessThanOrEqual(TERRAIN.reliefAmp + 0.5)
      expect(min).toBeGreaterThanOrEqual(-TERRAIN.reliefAmp - 0.5)
      // local grade between adjacent 20 m samples stays gentle (< 8%, the tightest
      // residential grade cap) so roads following the terrain remain drivable
      for (let x = bounds.minX; x < bounds.maxX; x += step) {
        const g = Math.abs(f.sample(x + step, 0) - f.sample(x, 0)) / step
        expect(g).toBeLessThan(0.08)
      }
    })
  })

  it('withTerrain restores the previous flag state', () => {
    const before = isTerrainEnabled()
    withTerrain(!before, () => {
      expect(isTerrainEnabled()).toBe(!before)
    })
    expect(isTerrainEnabled()).toBe(before)
    setTerrainEnabled(before) // leave global state as found
  })
})
