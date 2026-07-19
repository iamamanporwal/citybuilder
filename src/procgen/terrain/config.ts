// Terrain relief system — feature flag + design constants.
//
// Mirrors the corridor-elevation flag (procgen/corridor/config.ts): one module
// flag, flipped by the store toggle and by tests, read through a single seam
// (procgen/terrain/field.ts sampleTerrain). The terrain height field is the base
// height the road-elevation solve relaxes toward, and the datum the ground mesh,
// land cover, buildings, props and physics all sit on.
//
// DEFAULT-ON in the app: the store's `useTerrain` initial value is true and the
// app/headless build paths enable this flag before building (buildCity /
// headless generate). Fully reversible — flag-off makes sampleTerrain return 0
// everywhere, reproducing the legacy flat world byte-for-byte, so the feature is
// instant-A/B via the "⛰️ Terrain relief" toolbar toggle.
//
// The MODULE-level default is OFF so that unit tests exercising the procgen
// functions directly (buildTerrain / buildRoads / colliders) see the flat world
// unless they opt in with withTerrain(true) — existing tests stay byte-identical.

let enabled = false

/** Whether the terrain height field drives world elevation (feature flag). */
export function isTerrainEnabled(): boolean {
  return enabled
}

/** Toggle the terrain relief. Called from the store toggle and from tests. */
export function setTerrainEnabled(value: boolean): void {
  enabled = value
}

/** Run `fn` with the flag forced to `value`, restoring the prior state after (test helper). */
export function withTerrain<T>(value: boolean, fn: () => T): T {
  const prev = enabled
  enabled = value
  try {
    return fn()
  } finally {
    enabled = prev
  }
}

// ---- design constants (metres) --------------------------------------------
//
// Tuned for "subtle & drivable": gentle relief across a river-plain old town,
// with the river seated in a shallow valley. Every slope stays well under the
// road-class grade caps so the solver never has to fight the terrain.
export const TERRAIN = {
  /** Height-field memo grid resolution. Roads/ground sample the grid + bilinear. */
  cell: 12,
  /** Peak macro-relief amplitude away from water (rolling hills, ± this). */
  reliefAmp: 2.6,
  /** Base wavelength of the macro relief (m). Long → gentle, drivable grades. */
  reliefWavelength: 230,
  /** Octaves of value noise summed into the relief (each ½ amplitude, 2× freq). */
  reliefOctaves: 3,
  /** Opaque river/lake surface height. Below city grade so a bank lip reads. */
  waterSurfaceY: -1.2,
  /** Submerged ground under water. Kept well below the surface so it is hidden
   *  by the opaque water (no carve, no z-fight — pure vertical separation). */
  riverbedY: -3.0,
  /** Ground height at the very water's edge — just above the surface (the lip). */
  shoreY: -0.85,
  /** Distance over which the bank rises from the shore up to base grade (0). */
  valleyWidth: 150,
  /** Within this distance of water the macro relief is flattened out (flat plain). */
  waterFlatten: 45,
} as const
