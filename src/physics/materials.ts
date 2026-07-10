import type { RoadSurfaceSet } from '../resolver/types'
import type { ColliderClass, PhysicsMaterialHint } from './types'

// Friction/restitution hints per surface and collider class. These are
// suggestions for the consuming game engine (carried in GLB extras), and are
// applied directly by the in-editor drive preview.

export const SURFACE_PHYSICS: Record<RoadSurfaceSet, PhysicsMaterialHint> = {
  'asphalt-new': { friction: 1.0, restitution: 0.05 },
  'asphalt-worn': { friction: 0.95, restitution: 0.05 },
  'asphalt-patched': { friction: 0.9, restitution: 0.05 },
  cobble: { friction: 0.8, restitution: 0.08 },
  pavers: { friction: 0.85, restitution: 0.06 },
  gravel: { friction: 0.6, restitution: 0.04 },
}

export const CLASS_PHYSICS: Record<ColliderClass, PhysicsMaterialHint> = {
  road: SURFACE_PHYSICS['asphalt-worn'], // overridden per segment by resolved surface
  intersection: SURFACE_PHYSICS['asphalt-worn'],
  sidewalk: { friction: 0.9, restitution: 0.05 },
  building: { friction: 0.7, restitution: 0.1 },
  terrain: { friction: 0.55, restitution: 0.02 }, // grass/dirt off-road
  barrier: { friction: 0.5, restitution: 0.2 },
  prop: { friction: 0.6, restitution: 0.15 },
  water: { friction: 0, restitution: 0 }, // sensor; values unused
}
