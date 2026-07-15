import type { RoadClass } from '../../types'

// Corridor elevation system — feature flag + design constants (Road Corridor
// Redesign §6a E0–E2). The network elevation solve is the single source of
// truth for the road y-channel when enabled; the renderer, the collider builder
// and the semantics exporter all read it through one seam (procgen/corridor).
//
// DEFAULT-ON (E3): the network elevation solve drives the road y-channel. It
// stays fully reversible — flag-off reproduces the legacy per-segment ramp math
// byte-for-byte (the legacy adapter in ./index.ts is retained), so the feature
// is still instant-A/B via the "🛣️ Road elevation" toolbar toggle. Flipped on
// after E4 (markings/sidewalks/decals/discs ride the surface) landed, so lifted
// at-grade roads no longer leave their surface layers floating (§1.4).

let enabled = true

/** Whether the network elevation solve drives road elevation (feature flag; OFF by default). */
export function isCorridorElevationEnabled(): boolean {
  return enabled
}

/** Toggle the corridor elevation solve. Called from the store toggle and from tests. */
export function setCorridorElevationEnabled(value: boolean): void {
  enabled = value
}

/** Run `fn` with the flag forced to `value`, restoring the prior state after (test helper). */
export function withCorridorElevation<T>(value: boolean, fn: () => T): T {
  const prev = enabled
  enabled = value
  try {
    return fn()
  } finally {
    enabled = prev
  }
}

// ---- design constants -----------------------------------------------------

// Maximum sustained longitudinal grade by road class (fraction, rise/run).
// Design values: the solve distributes elevation change across the network so
// no drivable edge exceeds its cap where the geometry allows it.
const GRADE_CAPS: Record<RoadClass, number> = {
  motorway: 0.04,
  trunk: 0.04,
  primary: 0.06,
  secondary: 0.06,
  tertiary: 0.07,
  residential: 0.08,
  unclassified: 0.08,
  living_street: 0.08,
  service: 0.08,
  pedestrian: 0.12,
  footway: 0.12,
  cycleway: 0.1,
}

export function maxGradeFor(roadClass: RoadClass): number {
  return GRADE_CAPS[roadClass] ?? 0.08
}

// Node-relaxation solver tuning. Fixed budget + key-ordered traversal keep the
// solve deterministic and reproducible bit-for-bit across machines.
export const SOLVER = {
  maxIterations: 80,
  /** Convergence tolerance on the largest per-iteration node move (m). */
  tolerance: 1e-4,
  /**
   * Weight pulling free nodes toward their base height (0 today; a DEM sample
   * later). Small so structure pins win over long approach chains, but nonzero
   * so a pin-free at-grade component settles flat at base instead of drifting.
   */
  baseWeight: 0.25,
} as const
