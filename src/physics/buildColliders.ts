import type RAPIER from '@dimforge/rapier3d-compat'
import type { ColliderDescriptor } from './types'

// ColliderDescriptor[] → static Rapier colliders, created imperatively
// (parent-less colliders are fixed; thousands of declarative React collider
// components would buy nothing but reconciliation cost). Water descriptors
// become sensors — the drive preview falls through them visually but a
// consumer could listen for intersections.

export interface StaticColliderSet {
  count: number
  dispose(): void
}

export function buildStaticColliders(
  world: RAPIER.World,
  rapier: typeof RAPIER,
  descriptors: ColliderDescriptor[],
): StaticColliderSet {
  const created: RAPIER.Collider[] = []

  for (const d of descriptors) {
    let desc: RAPIER.ColliderDesc | null = null
    if (d.kind === 'trimesh' && d.geometry) {
      const pos = d.geometry.getAttribute('position')
      const positions = new Float32Array(pos.array as ArrayLike<number>)
      const index = d.geometry.getIndex()!
      const indices = new Uint32Array(index.array as ArrayLike<number>)
      desc = rapier.ColliderDesc.trimesh(positions, indices)
    } else if (d.kind === 'box' && d.halfExtents) {
      desc = rapier.ColliderDesc.cuboid(...d.halfExtents)
    } else if (d.kind === 'cylinder' && d.radius !== undefined && d.halfHeight !== undefined) {
      desc = rapier.ColliderDesc.cylinder(d.halfHeight, d.radius)
    }
    if (!desc) continue

    const [px, py, pz] = d.transform.position
    const [qx, qy, qz, qw] = d.transform.quaternion
    desc
      .setTranslation(px, py, pz)
      .setRotation({ x: qx, y: qy, z: qz, w: qw })
      .setFriction(d.material.friction)
      .setRestitution(d.material.restitution)
    if (d.semantics.sensor) desc.setSensor(true)
    created.push(world.createCollider(desc))
  }

  return {
    count: created.length,
    dispose() {
      for (const c of created) world.removeCollider(c, false)
      created.length = 0
    },
  }
}
