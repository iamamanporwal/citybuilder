import type { Vec2 } from '../types'

// Wear-decal placement with a global non-overlap guarantee.
//
// All wear decals of a kind share one flat mesh at the same Y, and different
// kinds sit at the SAME layer height — two overlapping decal quads are exactly
// coplanar and z-fight regardless of depth-buffer precision. Placement is
// therefore rejection-sampled: a decal is only accepted if its bounding circle
// clears every previously accepted decal, city-wide (grid-hashed). Purely
// geometric and deterministic, so it is unit-testable without a renderer.

export interface PlannedDecal {
  c: Vec2
  half: number // quad half-extent (decals are square)
}

const CELL = 10 // grid cell (m); must exceed 2 * max circumradius (~2.3 * √2 * 2 ≈ 6.5)

export class DecalPlanner {
  private grid = new Map<string, PlannedDecal[]>()

  /** Accepts and records the decal if it overlaps nothing placed so far. */
  tryPlace(c: Vec2, half: number): boolean {
    const r = half * Math.SQRT2 // circumradius of the rotated quad
    const cx = Math.floor(c.x / CELL)
    const cz = Math.floor(c.z / CELL)
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const d of this.grid.get(`${ix},${iz}`) ?? []) {
          if (Math.hypot(d.c.x - c.x, d.c.z - c.z) < r + d.half * Math.SQRT2) return false
        }
      }
    }
    const key = `${cx},${cz}`
    if (!this.grid.has(key)) this.grid.set(key, [])
    this.grid.get(key)!.push({ c, half })
    return true
  }
}
