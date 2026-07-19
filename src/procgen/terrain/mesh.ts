import * as THREE from 'three'
import type { Rect } from '../geometry'
import { sampleTerrain } from './field'
import { TERRAIN } from './config'

// The single terrain surface geometry, shared by the visual ground (areas.ts)
// and the physics terrain collider (physics/colliders.ts) so the car drives on
// exactly the surface it sees. A uniform grid over `bounds`, each vertex raised
// onto the height field. Grid density is capped (~220 segments/axis) so a large
// area stays one manageable mesh. PlaneGeometry.rotateX(-π/2) gives +Y normals in
// the XZ plane, matching the shape-space winding used across the procgen modules.
export function terrainGridGeometry(bounds: Rect, cell = TERRAIN.cell): THREE.BufferGeometry {
  const w = bounds.maxX - bounds.minX
  const d = bounds.maxZ - bounds.minZ
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  // Denser than the field memo grid: the ground must hug the road-conformed field
  // closely, or the coarse triangles interpolate over narrow roads/footways and
  // re-bury them at the corridor edges. ~6 m cells (capped ~380 seg/axis) keep the
  // ground within ~a few cm of the field everywhere while staying one mesh.
  const c = Math.max(6, Math.ceil(Math.max(w, d) / 380))
  const cols = Math.max(1, Math.round(w / c))
  const rows = Math.max(1, Math.round(d / c))
  const geo = new THREE.PlaneGeometry(w, d, cols, rows).rotateX(-Math.PI / 2)
  geo.translate(cx, 0, cz)
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, sampleTerrain(pos.getX(i), pos.getZ(i)))
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}
