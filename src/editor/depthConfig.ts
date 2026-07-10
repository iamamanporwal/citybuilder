// Single source of truth for depth-buffer configuration and the vertical layer
// convention. The Viewport reads camera planes and the log-depth flag from
// here; flickerLint proves the invariant "every layer separation is resolvable
// by the depth buffer at any in-scene distance" against the SAME constants, so
// the renderer and the linter cannot drift apart.
//
// Root cause this encodes (see docs/water-and-flicker-rca.md): with a standard
// 24-bit perspective depth buffer at near=1/far=4500, the smallest resolvable
// separation at the default camera distance (~570 m) is ~19 mm — larger than
// the 10 mm layer gaps — so the whole flat-layer stack z-fought when zoomed
// out. Logarithmic depth keeps the quantum under ~2.3 mm across the entire
// frustum, which every layer gap clears with margin.

export const DEPTH_CONFIG = {
  near: 1,
  far: 4500,
  logarithmicDepthBuffer: true,
  depthBits: 24,
} as const

/**
 * Smallest depth separation (meters) the buffer can resolve at eye distance z.
 * Standard depth: dz = z²(f-n)/(n·f·2^bits). Log depth: dz = z·ln(f+1)/2^bits.
 */
export function depthQuantumAt(
  z: number,
  cfg: { near: number; far: number; logarithmicDepthBuffer: boolean; depthBits: number } = DEPTH_CONFIG,
): number {
  const steps = 2 ** cfg.depthBits
  if (cfg.logarithmicDepthBuffer) return (z * Math.log(cfg.far + 1)) / steps
  return (z * z * (cfg.far - cfg.near)) / (cfg.near * cfg.far * steps)
}

// Vertical layer convention (local ENU meters). Every flat surface class must
// keep >= MIN_SEPARATION to its neighbors, and MIN_SEPARATION must exceed the
// worst-case depth quantum (checked by flickerLint).
export const LAYER_CONVENTION: [string, number][] = [
  ['terrain', 0],
  ['water', 0.012],
  ['grass', 0.022],
  ['park', 0.032],
  ['sand', 0.037],
  ['forest floor', 0.042],
  ['path surface', 0.046], // footway/cycleway/pedestrian — no junction nodes, so they cross carriageways untrimmed; the layer gap is what prevents the fight
  ['road surface', 0.05],
  ['wear decals', 0.08],
  ['junction surface', 0.11],
  ['lane markings', 0.16],
  ['crosswalks', 0.175],
  ['sidewalk top', 0.22],
]
export const MIN_SEPARATION = 0.004
