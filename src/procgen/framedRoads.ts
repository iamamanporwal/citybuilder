// "Framed roads" road style (experiment → setting). A road reads much cleaner
// when the carriageway is wrapped in a raised CONCRETE FRAME (a bright curb strip
// hugging the asphalt edge) that extends outward into a footpath — the whole
// street then looks finished, especially at junctions. This module is the single
// source of truth for whether the procedural road builder emits that framed
// cross-section, mirroring crossSection.ts (the crown flag).
//
// Default OFF: buildRoads reproduces the exact legacy sidewalk/curb geometry so
// every parity + flicker + collider test stays byte-identical. The interactive
// app switches it on in buildScene via the store toggle; the headless/World-API
// pipeline defaults it ON (GenerateOptions.framedRoads, opt-out per request).
//
// It composes with (does not replace) the material road-style A/B (realistic /
// arcade) and the crown flag — it only changes the kerb/footpath cross-section.

export const FRAMED_ROADS = { enabled: false }

export function setFramedRoadsEnabled(v: boolean): void {
  FRAMED_ROADS.enabled = v
}

/** Run `fn` with the framed-roads flag forced (restores after). For tests. */
export function withFramedRoads<T>(enabled: boolean, fn: () => T): T {
  const prev = FRAMED_ROADS.enabled
  FRAMED_ROADS.enabled = enabled
  try {
    return fn()
  } finally {
    FRAMED_ROADS.enabled = prev
  }
}

// Cross-section dimensions (local ENU metres). The bright curb strip is the
// "frame"; the footpath fills the rest of the sidewalk band out to FRAME_WALK_W.
export const FRAME_CURB_W = 0.42 // width of the bright raised curb strip
export const FRAME_WALK_W = 2.6 // total sidewalk band (curb strip + footpath), from the carriageway edge
export const FRAME_CURB_H = 0.16 // curb/footpath top height above the road surface
export const FRAME_VERGE_H = 0.04 // raised tree-lawn verge height (sits in the trough between curb & footpath)

/** Per-road-class framed cross-section (grass-verge / green-frame default). All
 *  metres, from the carriageway edge outward: curb strip → grass verge → footpath.
 *  Carriageway width itself is the road's widthM (scales with road-widening).
 *  Returns null for classes that should stay FRAMELESS (highways have shoulders,
 *  not sidewalks — framing them buries a multi-lane road in white bands). */
export interface FramedPreset {
  curbW: number
  vergeW: number // tree-lawn grass verge (0 = curb+footpath adjacent, no lawn)
  footW: number
}
export function framedPresetFor(roadClass: string): FramedPreset | null {
  switch (roadClass) {
    case 'motorway':
    case 'trunk':
      return null // frameless: expressway shoulders, no pedestrian frame
    case 'primary':
      return { curbW: 0.45, vergeW: 1.0, footW: 2.4 }
    case 'secondary':
      return { curbW: 0.42, vergeW: 1.2, footW: 2.2 }
    case 'tertiary':
    case 'unclassified':
      return { curbW: 0.4, vergeW: 1.3, footW: 2.0 }
    case 'residential':
    case 'living_street':
      return { curbW: 0.4, vergeW: 1.6, footW: 1.8 }
    default:
      return { curbW: 0.4, vergeW: 1.3, footW: 2.0 }
  }
}
