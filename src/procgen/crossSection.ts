// Road cross-section engineering profile (Top-25 #8 crown/camber + #22
// superelevation). A real carriageway is not a flat strip: it is CROWNED (centre
// raised ~2% above the edges so water sheds) and, on curves, SUPERELEVATED
// (banked into the turn). This module is the single source of truth for that
// vertical cross-section offset so the road SURFACE mesh, the surface-riding
// layers (markings/decals via surfaceElevSampler) and the physics collider all
// agree — otherwise markings float and the car rides a surface it can't see.
//
// The offset raises the centre and leaves the EDGES at grade (so the kerb /
// grass / sidewalk seam is untouched) and FADES to zero near junctions (so a
// crowned mid-block meets a flat junction disc with no seam step — the
// colliderAudit invariant). At lateral 0 the offset is the crown peak and the
// bank pivot, so a straight road's centreline is unchanged.
//
// Default OFF: buildRoads / colliders / the sampler reproduce the exact legacy
// flat strip so every parity + flicker + collider test stays byte-identical. The
// interactive app switches it on in buildScene; headless/export stay flat.

export const CROSS_SECTION = { enabled: false }
export function setCrossSectionEnabled(v: boolean): void {
  CROSS_SECTION.enabled = v
}
/** Run `fn` with the cross-section flag forced (restores after). For tests. */
export function withCrossSection<T>(enabled: boolean, fn: () => T): T {
  const prev = CROSS_SECTION.enabled
  CROSS_SECTION.enabled = enabled
  try {
    return fn()
  } finally {
    CROSS_SECTION.enabled = prev
  }
}

export const CROWN_SLOPE = 0.02 // 2% crown: centre rises 0.02 × half-width above the edges
export const SUPERELEV_MAX = 0.06 // up to 6% bank on the sharpest curves
const CURV_REF = 0.02 // curvature (1/m) at which superelevation reaches ~max (~50 m radius)
const TAPER_M = 6 // crown/bank ramp to zero within this distance of each end (junction)

/** Number of lateral samples per station in a crowned ribbon (edges+centre+quarters). */
export const CROSS_K = 5

/**
 * Vertical offset of the carriageway surface at a lateral position, relative to
 * the centreline profile. `ln` is the normalised lateral coordinate in [-1,+1]
 * (0 centre, ±1 kerb). `bank` is the signed superelevation amount for this
 * station (0 on straights). Centre-raised crown (edges at grade) plus a linear
 * bank tilt; the whole thing is scaled by the caller's fade near junctions.
 */
export function crossOffset(ln: number, halfWidth: number, bank: number): number {
  const crown = CROWN_SLOPE * halfWidth * (1 - ln * ln) // 0 at kerbs, peak at centre
  const superelev = bank * halfWidth * ln // outer edge up on a curve
  return crown + superelev
}

/** Ramp 0→1 as the station moves away from either end, so crown vanishes at junctions. */
export function crossFade(station: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(1, station / TAPER_M, (length - station) / TAPER_M))
}

/**
 * Signed superelevation per centreline point from local curvature. Positive
 * banks the +lateral (right) edge up. Zero at the endpoints (no curvature data)
 * and clamped to SUPERELEV_MAX. Deterministic, pure geometry.
 */
export function bankProfile(pts: { x: number; z: number }[]): number[] {
  const n = pts.length
  const bank = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x
    const az = pts[i].z - pts[i - 1].z
    const bx = pts[i + 1].x - pts[i].x
    const bz = pts[i + 1].z - pts[i].z
    const la = Math.hypot(ax, az) || 1
    const lb = Math.hypot(bx, bz) || 1
    // signed turn angle between consecutive segments (cross product, normalised)
    const cross = (ax * bz - az * bx) / (la * lb)
    const turn = Math.asin(Math.max(-1, Math.min(1, cross))) // radians, signed
    const segLen = 0.5 * (la + lb)
    const curvature = segLen > 0 ? turn / segLen : 0 // 1/m, signed
    // Bank INTO the turn: raise the OUTER edge. With our ln convention (offset
    // +half → ln -1) and the sampler's matching perpendicular sign, the physically
    // correct outer-edge-up sign is -sign(curvature) (verified against a known arc).
    const mag = Math.min(Math.abs(curvature) / CURV_REF, 1) * SUPERELEV_MAX
    bank[i] = -Math.sign(curvature) * mag
  }
  // smooth the endpoints toward their neighbours (curvature undefined at ends)
  if (n > 2) {
    bank[0] = bank[1] * 0.5
    bank[n - 1] = bank[n - 2] * 0.5
  }
  return bank
}
