import type * as THREE from 'three'
import type { RoadClass } from '../types'

// Shared collider contract: produced by physics/colliders.ts from semantic
// city data (never from visual mesh clones), consumed by BOTH the collision
// GLB exporter (export/colliderGlb.ts) and the in-editor Rapier drive preview
// (editor/driving/). Trimesh vertices are baked in world space except
// buildings, which stay centroid-local so editor moves are honored via the
// descriptor transform.

export type ColliderKind = 'trimesh' | 'box' | 'cylinder' | 'heightfield' // heightfield reserved for future DEM terrain

export type ColliderClass =
  | 'road'
  | 'intersection'
  | 'sidewalk'
  | 'building'
  | 'terrain'
  | 'barrier'
  | 'prop'
  | 'water'

export interface PhysicsMaterialHint {
  friction: number
  restitution: number
  surfaceTag?: string // resolver RoadSurfaceSet, e.g. 'asphalt-worn'
}

export interface ColliderSemantics {
  class: ColliderClass
  featureId?: string // road/building/barrier/point id (OSM-derived)
  roadClass?: RoadClass
  drivable?: boolean // gameplay drivability (false for footway etc.)
  bridge?: boolean
  propKind?: string // 'tree' | 'street_lamp' | ...
  sensor?: boolean // water trigger volumes — no solid response
  static: true // everything CityBuilder emits is static
}

export interface ColliderDescriptor {
  id: string // GLB node name: col_<class>_<featureId>
  kind: ColliderKind
  geometry?: THREE.BufferGeometry // trimesh: position + index only (no uv/normals)
  halfExtents?: [number, number, number] // box
  radius?: number // cylinder
  halfHeight?: number // cylinder
  transform: {
    position: [number, number, number]
    quaternion: [number, number, number, number]
  }
  semantics: ColliderSemantics
  material: PhysicsMaterialHint
}

export interface ColliderSet {
  colliders: ColliderDescriptor[]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  stats: Record<ColliderClass, number>
}
