import type { Vec2 } from '../../types'
import { pointInRing, type Rect } from '../geometry'
import { hash01 } from '../../resolver/resolve'
import { isTerrainEnabled, TERRAIN } from './config'

// Deterministic, hydrology-aware terrain height field.
//
// One field, sampled by every consumer (road-elevation base height, ground mesh,
// land cover, buildings, props, physics) so nothing floats or sinks relative to
// anything else. The field is a pure function of the road bounds + whitelisted
// water rings — no Math.random, no wall-clock — so the same OSM always produces
// the same relief on any machine (matches the codebase determinism invariant).
//
// Composition (see TERRAIN constants):
//   1. Hydrology basis — inside a water ring the ground drops to a submerged
//      riverbed (hidden under the opaque water surface, so no hole-carving and
//      no z-fighting); outside, it rises from a shore lip up to base grade over
//      `valleyWidth`. This seats the Vltava in a real valley with banks.
//   2. Macro relief — multi-octave value noise (hash01 lattice), gentle and
//      long-wavelength so grades stay drivable, flattened near water.
//
// Perf: built once onto a coarse grid (TERRAIN.cell), then sampled with bilinear
// interpolation for the thousands of dense lookups roads/ground need.

export interface WaterRingLite {
  ring: Vec2[]
  holes: Vec2[][] // land islands — ground inside a hole is land, not riverbed
}

export interface TerrainField {
  /** True-metre ground height at world (x, z). */
  sample(x: number, z: number): number
  readonly enabled: boolean
  /**
   * The natural field this one was derived from, if any (set by
   * conformTerrainToRoads). The road-elevation solve relaxes toward the BASE, not
   * the conformed surface, so conforming the ground to the roads cannot feed back
   * into the solve. Undefined ⇒ this field is its own base.
   */
  readonly base?: TerrainField
}

const smoothstep = (t: number) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

// ---- value noise -----------------------------------------------------------

/** Deterministic lattice value in [0,1) at integer cell (ix, iz) for one octave. */
function latticeValue(ix: number, iz: number, octave: number): number {
  return hash01(`${ix}:${iz}:${octave}`)
}

/** Smooth value noise in [-1, 1] at (x, z) for a given wavelength/octave. */
function valueNoise(x: number, z: number, wavelength: number, octave: number): number {
  const gx = x / wavelength
  const gz = z / wavelength
  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  const fx = smoothstep(gx - ix)
  const fz = smoothstep(gz - iz)
  const v00 = latticeValue(ix, iz, octave)
  const v10 = latticeValue(ix + 1, iz, octave)
  const v01 = latticeValue(ix, iz + 1, octave)
  const v11 = latticeValue(ix + 1, iz + 1, octave)
  const vx0 = v00 + (v10 - v00) * fx
  const vx1 = v01 + (v11 - v01) * fx
  return (vx0 + (vx1 - vx0) * fz) * 2 - 1
}

/** Fractal (fBm) macro relief in ~[-1, 1]: octaves halve in amplitude, double in freq. */
function fbm(x: number, z: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let wavelength = TERRAIN.reliefWavelength
  for (let o = 0; o < TERRAIN.reliefOctaves; o++) {
    sum += amp * valueNoise(x, z, wavelength, o)
    norm += amp
    amp *= 0.5
    wavelength *= 0.5
  }
  return sum / norm
}

// ---- geometry helpers ------------------------------------------------------

function pointToSegDist(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx
  const cz = a.z + t * dz
  return Math.hypot(px - cx, pz - cz)
}

// ---- field construction ----------------------------------------------------

/**
 * Build the terrain height field from the scene bounds and the whitelisted water
 * rings (carved + painted — same set the renderer and water-sensor colliders
 * use, so terrain, water and physics all agree). Returns a zero field when the
 * feature flag is off, so every consumer reproduces the legacy flat world.
 */
export function buildTerrainField(bounds: Rect, water: WaterRingLite[]): TerrainField {
  if (!isTerrainEnabled()) return ZERO_FIELD

  const { cell, riverbedY, shoreY, valleyWidth, waterFlatten, reliefAmp } = TERRAIN

  // Precompute shoreline segments (outer rings + island edges) for the valley
  // distance transform, plus a global water bbox for a cheap broad-phase.
  const segs: [Vec2, Vec2][] = []
  let wminX = Infinity, wmaxX = -Infinity, wminZ = Infinity, wmaxZ = -Infinity
  const addRing = (r: Vec2[]) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]
      const b = r[(i + 1) % r.length]
      segs.push([a, b])
      wminX = Math.min(wminX, a.x); wmaxX = Math.max(wmaxX, a.x)
      wminZ = Math.min(wminZ, a.z); wmaxZ = Math.max(wmaxZ, a.z)
    }
  }
  for (const w of water) {
    addRing(w.ring)
    for (const h of w.holes) addRing(h)
  }
  const hasWater = segs.length > 0
  const reach = valleyWidth + 4 // beyond this from water, valley term is flat 0

  const insideWater = (x: number, z: number): boolean => {
    const p = { x, z }
    for (const w of water) {
      if (!pointInRing(p, w.ring)) continue
      if (w.holes.some((h) => pointInRing(p, h))) continue // island → land
      return true
    }
    return false
  }

  const distToWater = (x: number, z: number): number => {
    let d = Infinity
    for (const [a, b] of segs) {
      const dd = pointToSegDist(x, z, a, b)
      if (dd < d) d = dd
    }
    return d
  }

  // Sample the composed height at a world point.
  const heightAt = (x: number, z: number): number => {
    if (hasWater && insideWater(x, z)) return riverbedY

    // valley basis: shore lip at the water's edge → 0 at base grade over valleyWidth
    let valley = 0
    let farFromWater = true
    if (hasWater) {
      const nearBBox =
        x >= wminX - reach && x <= wmaxX + reach && z >= wminZ - reach && z <= wmaxZ + reach
      if (nearBBox) {
        const d = distToWater(x, z)
        farFromWater = d >= valleyWidth
        valley = shoreY + (0 - shoreY) * smoothstep(d / valleyWidth)
        // flatten macro relief close to the water so the river plain reads flat
        const mask = smoothstep((d - waterFlatten) / valleyWidth)
        return valley + fbm(x, z) * reliefAmp * mask
      }
    }
    // away from all water (or no water at all): full macro relief on base grade
    return (farFromWater ? 0 : valley) + fbm(x, z) * reliefAmp
  }

  // ---- bake onto a coarse grid; sample() does bilinear interpolation
  const originX = bounds.minX
  const originZ = bounds.minZ
  const cols = Math.max(2, Math.ceil((bounds.maxX - bounds.minX) / cell) + 1)
  const rows = Math.max(2, Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1)
  const grid = new Float64Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      grid[j * cols + i] = heightAt(originX + i * cell, originZ + j * cell)
    }
  }

  const sample = (x: number, z: number): number => {
    const gx = (x - originX) / cell
    const gz = (z - originZ) / cell
    let i = Math.floor(gx)
    let j = Math.floor(gz)
    // clamp to the grid interior so edge samples (roads within the pad) are valid
    i = i < 0 ? 0 : i > cols - 2 ? cols - 2 : i
    j = j < 0 ? 0 : j > rows - 2 ? rows - 2 : j
    const fx = gx - i < 0 ? 0 : gx - i > 1 ? 1 : gx - i
    const fz = gz - j < 0 ? 0 : gz - j > 1 ? 1 : gz - j
    const h00 = grid[j * cols + i]
    const h10 = grid[j * cols + i + 1]
    const h01 = grid[(j + 1) * cols + i]
    const h11 = grid[(j + 1) * cols + i + 1]
    const hx0 = h00 + (h10 - h00) * fx
    const hx1 = h01 + (h11 - h01) * fx
    return hx0 + (hx1 - hx0) * fz
  }

  return { sample, enabled: true }
}

const ZERO_FIELD: TerrainField = { sample: () => 0, enabled: false }

// ---- road-corridor conforming -----------------------------------------------
//
// The road-elevation solve produces a smoothed, grade-limited drivable surface
// that diverges from the raw terrain by up to ~1 m (the civil-engineering cut/
// fill). If the ground, land cover, props and colliders sampled the RAW field
// they would poke above the road and bury it (measured: 37% of the carriageway
// submerged, median 0.65 m). So after the roads are solved, the visible ground
// is CONFORMED to them: inside a road's paved footprint the field returns the
// road-surface elevation exactly, then blends back to the natural relief over a
// shoulder (a graded embankment). The road-elevation solve itself keeps reading
// the NATURAL field (buildTerrainField), so there is no circular dependency —
// conforming is a one-way burn of the solved roads into the ground datum.

export interface RoadCorridor {
  /** Centerline points (same polyline the road mesh is swept along). */
  pts: Vec2[]
  /** Solved surface elevation per centerline point (0 = grade), index-aligned. */
  elev: number[]
  /** Carriageway half-width (m). */
  half: number
  /** Extra paved margin outside the carriageway (curb + sidewalk) that must also
   *  sit flush with the road, so curbs don't float and sidewalks meet grade. */
  pave: number
}

// Distance over which the ground eases from the road surface back up to the
// natural relief outside the paved corridor (a drivable embankment shoulder).
const SHOULDER = 14

/** Point-to-segment: squared distance + clamped projection parameter t∈[0,1]. */
function segClosest(px: number, pz: number, a: Vec2, b: Vec2): { d2: number; t: number } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx
  const cz = a.z + t * dz
  return { d2: (px - cx) * (px - cx) + (pz - cz) * (pz - cz), t }
}

/**
 * Wrap a natural field so the ground conforms to the solved road corridors.
 * Returns `base` unchanged when terrain is off or there are no corridors, so the
 * flat / no-road worlds are byte-identical. Deterministic (fixed iteration order,
 * no randomness); a uniform-grid broad-phase keeps city-scale sampling cheap.
 */
export function conformTerrainToRoads(base: TerrainField, corridors: RoadCorridor[], bounds: Rect): TerrainField {
  if (!base.enabled || corridors.length === 0) return base

  // bucket each corridor SEGMENT into every grid cell its influence bbox touches
  const cell = 24
  const originX = bounds.minX
  const originZ = bounds.minZ
  const grid = new Map<string, [number, number][]>() // cellKey -> [corridorIdx, segIdx]
  const cx = (x: number) => Math.floor((x - originX) / cell)
  const cz = (z: number) => Math.floor((z - originZ) / cell)
  const push = (i: number, j: number, v: [number, number]) => {
    const k = `${i},${j}`
    let a = grid.get(k)
    if (!a) grid.set(k, (a = []))
    a.push(v)
  }
  corridors.forEach((c, ci) => {
    const reach = c.half + c.pave + SHOULDER
    for (let s = 1; s < c.pts.length; s++) {
      const a = c.pts[s - 1]
      const b = c.pts[s]
      const i0 = cx(Math.min(a.x, b.x) - reach)
      const i1 = cx(Math.max(a.x, b.x) + reach)
      const j0 = cz(Math.min(a.z, b.z) - reach)
      const j1 = cz(Math.max(a.z, b.z) + reach)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) push(i, j, [ci, s])
    }
  })

  const sample = (x: number, z: number): number => {
    const hb = base.sample(x, z)
    const i = cx(x)
    const j = cz(z)
    // strongest road influence wins (nearest corridor); blend to natural outside
    let bestW = 0
    let bestE = 0
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = grid.get(`${i + di},${j + dj}`)
        if (!list) continue
        for (const [ci, s] of list) {
          const c = corridors[ci]
          const { d2, t } = segClosest(x, z, c.pts[s - 1], c.pts[s])
          const d = Math.sqrt(d2)
          const flat = c.half + c.pave
          let w: number
          if (d <= flat) w = 1
          else if (d < flat + SHOULDER) w = smoothstep((flat + SHOULDER - d) / SHOULDER)
          else continue
          if (w > bestW) {
            bestW = w
            const e0 = c.elev[s - 1]
            const e1 = c.elev[Math.min(s, c.elev.length - 1)]
            bestE = e0 + (e1 - e0) * t
          }
        }
      }
    }
    return bestW <= 0 ? hb : bestE * bestW + hb * (1 - bestW)
  }

  return { sample, enabled: true, base }
}

// ---- active-field seam -----------------------------------------------------
//
// The scene builder installs the field before building roads/ground/props, and
// every consumer reads it through sampleTerrain — the same module-flag pattern
// used by setActiveCuration / setPaintWear / setCorridorElevationEnabled.

let active: TerrainField = ZERO_FIELD

export function setActiveTerrain(field: TerrainField | null): void {
  active = field ?? ZERO_FIELD
}

/** Ground height at world (x, z) — 0 when terrain is off or no field is installed. */
export function sampleTerrain(x: number, z: number): number {
  return active.sample(x, z)
}

/** The installed field (for consumers that want to skip work when flat). */
export function activeTerrain(): TerrainField {
  return active
}

/**
 * The NATURAL base of the installed field: the field the road-elevation solve
 * relaxes toward. When the active field was conformed to the roads, this returns
 * the underlying natural field, so the solve (and its cache) never sees the
 * conformed surface — the conform is one-way (roads → ground), never a feedback
 * loop. Identity-stable across a build, so it is a safe elevation-cache key.
 */
export function terrainSolveBase(): TerrainField {
  return active.base ?? active
}

/** Natural ground height at (x, z) for the elevation solve (ignores road conform). */
export function sampleTerrainBase(x: number, z: number): number {
  return terrainSolveBase().sample(x, z)
}
