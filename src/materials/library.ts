import * as THREE from 'three'
import type { FacadeSet, RoadSurfaceSet, RoofSet } from '../resolver/types'
import {
  generateFacadeTextures,
  generateRoofTextures,
  generateSurfaceTextures,
  makeDecals,
} from './textures'
import { FACADE_TILE_M, ROAD_TILE_M } from './packaging'

// PBR (metallic-roughness) material library. Materials are UNLIT-authored:
// standard PBR params only — no emissive hacks, no baked light. The editor
// previews them lit; the export carries clean PBR for the game engine.

const surf = generateSurfaceTextures()
const facades = generateFacadeTextures()
const roofs = generateRoofTextures()
export const decals = makeDecals()

function std(o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial(o)
}

// ---------- road surfaces (shared per set; per-segment UV offset via clone) ----------

const ROAD_MATERIALS: Record<RoadSurfaceSet, THREE.MeshStandardMaterial> = {
  'asphalt-new': std({ map: surf.asphaltNew.albedo, roughnessMap: surf.asphaltNew.mr, metalnessMap: surf.asphaltNew.mr, roughness: 1, metalness: 1 }),
  'asphalt-worn': std({ map: surf.asphaltWorn.albedo, roughnessMap: surf.asphaltWorn.mr, metalnessMap: surf.asphaltWorn.mr, roughness: 1, metalness: 1 }),
  'asphalt-patched': std({ map: surf.asphaltPatched.albedo, roughnessMap: surf.asphaltPatched.mr, metalnessMap: surf.asphaltPatched.mr, roughness: 1, metalness: 1 }),
  cobble: std({ map: surf.cobble.albedo, normalMap: surf.cobble.normal, roughnessMap: surf.cobble.mr, metalnessMap: surf.cobble.mr, roughness: 1, metalness: 1 }),
  pavers: std({ map: surf.pavers.albedo, normalMap: surf.pavers.normal, roughnessMap: surf.pavers.mr, metalnessMap: surf.pavers.mr, roughness: 1, metalness: 1 }),
  gravel: std({ map: surf.gravel.albedo, roughnessMap: surf.gravel.mr, metalnessMap: surf.gravel.mr, roughness: 1, metalness: 1 }),
}

for (const m of Object.values(ROAD_MATERIALS)) {
  m.map!.repeat.set(1 / ROAD_TILE_M, 1 / ROAD_TILE_M)
}

export function roadMaterial(set: RoadSurfaceSet, uvSeed = 0): THREE.MeshStandardMaterial {
  const base = ROAD_MATERIALS[set]
  if (uvSeed === 0) return base
  // seeded per-instance UV shift breaks visible tiling between adjacent segments
  const m = base.clone()
  m.map = base.map!.clone()
  m.map.offset.set(uvSeed % 1, (uvSeed * 7.13) % 1)
  return m
}

export const sidewalkMaterial = std({
  map: surf.sidewalk.albedo,
  roughnessMap: surf.sidewalk.mr,
  metalnessMap: surf.sidewalk.mr,
  roughness: 1,
  metalness: 1,
})
sidewalkMaterial.map!.repeat.set(1 / 2.4, 1 / 2.4)

// ---------- building facades (per-instance tint + seeded UV offset) ----------

const FACADE_GLASSINESS: Record<FacadeSet, { rough: number; metal: number }> = {
  'brick-red': { rough: 0.92, metal: 0 },
  'brick-brown': { rough: 0.92, metal: 0 },
  'stucco-warm': { rough: 0.95, metal: 0 },
  'stucco-cool': { rough: 0.95, metal: 0 },
  'concrete-panel': { rough: 0.85, metal: 0 },
  'office-glass': { rough: 0.35, metal: 0.25 },
  'curtainwall-dark': { rough: 0.28, metal: 0.35 },
  'storefront-mixed': { rough: 0.7, metal: 0.05 },
}

export function facadeMaterial(set: FacadeSet, tint: string, uvSeed: [number, number]): THREE.MeshStandardMaterial {
  const g = FACADE_GLASSINESS[set]
  const map = facades[set].clone()
  map.repeat.set(1 / FACADE_TILE_M.w, 1 / FACADE_TILE_M.h)
  map.offset.set(uvSeed[0], uvSeed[1])
  map.needsUpdate = true
  return std({ map, color: tint, roughness: g.rough, metalness: g.metal })
}

const ROOF_MATERIALS: Record<RoofSet, THREE.MeshStandardMaterial> = {
  'bitumen-dark': std({ map: roofs['bitumen-dark'], roughness: 0.95 }),
  'tile-red': std({ map: roofs['tile-red'], roughness: 0.85 }),
  'metal-pale': std({ map: roofs['metal-pale'], roughness: 0.5, metalness: 0.6 }),
  'concrete-pale': std({ map: roofs['concrete-pale'], roughness: 0.92 }),
}
for (const m of Object.values(ROOF_MATERIALS)) m.map!.repeat.set(1 / 4, 1 / 4)

export function roofMaterial(set: RoofSet): THREE.MeshStandardMaterial {
  return ROOF_MATERIALS[set]
}

// ---------- decal materials (content, not post-FX) ----------

// No polygonOffset: decals sit a real 30mm above the road layer, which the
// log-depth buffer resolves at any in-scene distance (see editor/depthConfig.ts).
// polygonOffset is also silently ignored once log depth writes gl_FragDepth.
function decalMat(tex: THREE.Texture): THREE.MeshStandardMaterial {
  return std({ map: tex, transparent: true, roughness: 1, depthWrite: false })
}

export const decalMaterials = {
  crack: decalMat(decals.crack),
  stain: decalMat(decals.stain),
  patch: decalMat(decals.patch),
  manhole: decalMat(decals.manhole),
}
