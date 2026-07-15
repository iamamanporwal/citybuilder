import * as THREE from 'three'
import type { Transform } from '../types'
import { cityGraph, getVariant, roadResolutions } from '../scene/registry'
import { useEditor } from '../state/store'
import { furniturePlacements } from '../procgen/props'
import { focusState, focusTarget, lastOrbitTarget } from '../editor/bus'
import { buildColliders, type PropExtent } from './colliders'
import type { ColliderSet } from './types'

// In a large city, cooking a trimesh collider for every building on drive-entry
// stalls for seconds. The car only interacts with its surroundings, so beyond
// this radius from the spawn we skip building colliders. Only kicks in once the
// city is big enough that cooking everything would hurt.
const DRIVE_BUILDING_RADIUS = 1500 // generous drivable bubble; keeps collider cook bounded on 5-10 km² cities
const RADIUS_FILTER_MIN_BUILDINGS = 2000

// Live-scene convenience: pulls the CityGraph + road resolutions from the
// registry, movable-object transforms and deleted/hidden flags from the
// zustand store, generated furniture placements from the procgen side channel,
// and measured extents from live prop variants (robust to AI-replaced models).
// Kept separate from colliders.ts so the pure builder has no store/registry
// (and hence no DOM) dependencies for tests.

const MEASURED_KINDS = new Set(['fountain', 'statue', 'bus_stop'])

export function buildCollidersFromRegistry(): ColliderSet | null {
  if (!cityGraph) return null
  const objects = useEditor.getState().objects

  const placements = new Map<string, Transform>()
  const excluded = new Set<string>()
  const propExtents = new Map<string, PropExtent>()
  const box = new THREE.Box3()

  // drive-collider bubble: skip far-away building colliders in big cities
  const center = focusState.has ? focusTarget : lastOrbitTarget
  const radiusFilter = cityGraph.buildings.length > RADIUS_FILTER_MIN_BUILDINGS
  const r2 = DRIVE_BUILDING_RADIUS * DRIVE_BUILDING_RADIUS

  for (const o of Object.values(objects)) {
    if (o.deleted || !o.visible) {
      excluded.add(o.id)
      continue
    }
    if (o.type === 'building' || o.type === 'street-furniture' || o.type === 'traffic-signal') {
      if (radiusFilter && o.type === 'building') {
        const dx = o.transform.position[0] - center.x
        const dz = o.transform.position[2] - center.z
        if (dx * dx + dz * dz > r2) { excluded.add(o.id); continue }
      }
      placements.set(o.id, o.transform)
    }
  }

  for (const p of cityGraph.points) {
    if (!MEASURED_KINDS.has(p.kind) || excluded.has(p.id)) continue
    const o = objects[p.id]
    if (!o) continue
    const variant = getVariant(p.id, o.asset)
    if (!variant || o.asset.state === 'procedural') continue // seeded fallbacks match procedural builds
    box.setFromObject(variant)
    if (box.isEmpty()) continue
    const hx = (box.max.x - box.min.x) / 2
    const hy = (box.max.y - box.min.y) / 2
    const hz = (box.max.z - box.min.z) / 2
    propExtents.set(p.id, {
      box: [hx, hy, hz],
      radius: Math.max(hx, hz),
      halfHeight: hy,
    })
  }

  return buildColliders(cityGraph, roadResolutions, {
    placements,
    excluded,
    furniturePlacements: furniturePlacements.current,
    propExtents,
  })
}
