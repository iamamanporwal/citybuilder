import * as THREE from 'three'
import type { ColliderDescriptor, ColliderSet } from '../physics/types'

// ColliderSet → THREE.Group for GLB export. Each collider becomes a named,
// debug-viewable mesh whose userData (GLTFExporter → glTF node `extras`)
// carries the machine-readable truth. A Rapier/Jolt loader reads
// extras.collider.kind → trimesh(positions, indices) / cuboid(...halfExtents)
// / cylinder(halfHeight, radius), applies extras.semantics.sensor via
// setSensor and friction/restitution from extras.physicsMaterial.

const solidMat = new THREE.MeshBasicMaterial({ color: '#888888' })
const sensorMat = new THREE.MeshBasicMaterial({ color: '#3a7bd5', transparent: true, opacity: 0.35 })

function colliderMesh(d: ColliderDescriptor): THREE.Mesh {
  let geometry: THREE.BufferGeometry
  if (d.kind === 'trimesh') {
    geometry = d.geometry!
  } else if (d.kind === 'box') {
    const [hx, hy, hz] = d.halfExtents!
    geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2)
  } else {
    geometry = new THREE.CylinderGeometry(d.radius!, d.radius!, d.halfHeight! * 2, 12)
  }
  const mesh = new THREE.Mesh(geometry, d.semantics.sensor ? sensorMat : solidMat)
  mesh.name = d.id
  mesh.position.fromArray(d.transform.position)
  mesh.quaternion.fromArray(d.transform.quaternion)
  // plain JSON only — GLTFExporter serializes userData into node extras
  mesh.userData = {
    collider: {
      kind: d.kind,
      ...(d.halfExtents ? { halfExtents: d.halfExtents } : {}),
      ...(d.radius !== undefined ? { radius: d.radius } : {}),
      ...(d.halfHeight !== undefined ? { halfHeight: d.halfHeight } : {}),
    },
    semantics: {
      class: d.semantics.class,
      featureId: d.semantics.featureId ?? null,
      roadClass: d.semantics.roadClass ?? null,
      drivable: d.semantics.drivable ?? false,
      bridge: d.semantics.bridge ?? false,
      propKind: d.semantics.propKind ?? null,
      sensor: d.semantics.sensor ?? false,
      static: true,
    },
    physicsMaterial: {
      friction: d.material.friction,
      restitution: d.material.restitution,
      surfaceTag: d.material.surfaceTag ?? null,
    },
  }
  return mesh
}

export function colliderGroup(set: ColliderSet): THREE.Group {
  const root = new THREE.Group()
  root.name = 'citybuilder_colliders'
  root.userData = {
    formatVersion: 1,
    generator: 'CityBuilder',
    stats: set.stats,
    bounds: set.bounds,
  }
  for (const d of set.colliders) root.add(colliderMesh(d))
  return root
}
