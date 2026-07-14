import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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

// ---------------------------------------------------------------------------
// Pre-merged collider export (fixes the engine's "I merge at load; 1 collider =
// no freeze" flag). Instead of one GLB node per collider (thousands), we emit a
// handful of merged trimeshes grouped by physics BEHAVIOUR — everything the
// loader distinguishes via extras: sensor vs solid, drivable, physics material,
// surface tag. Box/cylinder primitives are baked to geometry and folded in.
// Per-node extras (friction / sensor / drivable / class) are preserved, so the
// engine's existing loader still reads them — it just gets ~10 nodes, not 5,000.

function q(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** Group key: distinct nodes for every physics behaviour the loader cares about. */
function groupKey(d: ColliderDescriptor): string {
  const s = d.semantics
  const m = d.material
  return [
    s.sensor ? 'sensor' : 'solid',
    s.class,
    s.drivable ? 'drive' : 'nodrive',
    m.surfaceTag ?? '-',
    q(m.friction),
    q(m.restitution),
  ].join('|')
}

/** Bake a descriptor into a world-space, position-only, indexed trimesh geometry. */
function descriptorGeometry(d: ColliderDescriptor): THREE.BufferGeometry | null {
  let g: THREE.BufferGeometry
  if (d.kind === 'trimesh') {
    if (!d.geometry) return null
    g = d.geometry.clone()
  } else if (d.kind === 'box') {
    const [hx, hy, hz] = d.halfExtents!
    g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2)
  } else if (d.kind === 'cylinder') {
    g = new THREE.CylinderGeometry(d.radius!, d.radius!, d.halfHeight! * 2, 12)
  } else {
    return null // heightfield: not merged
  }
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(d.transform.position),
    new THREE.Quaternion().fromArray(d.transform.quaternion),
    new THREE.Vector3(1, 1, 1),
  )
  g.applyMatrix4(matrix)
  if (!g.getIndex()) {
    const count = g.getAttribute('position').count
    const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
    for (let i = 0; i < count; i++) arr[i] = i
    g.setIndex(new THREE.BufferAttribute(arr, 1))
  }
  return g
}

export function colliderGroupMerged(set: ColliderSet): THREE.Group {
  const root = new THREE.Group()
  root.name = 'citybuilder_colliders'

  const groups = new Map<
    string,
    { rep: ColliderDescriptor; geos: THREE.BufferGeometry[]; count: number }
  >()
  for (const d of set.colliders) {
    const g = descriptorGeometry(d)
    if (!g) continue
    const key = groupKey(d)
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = { rep: d, geos: [], count: 0 }
      groups.set(key, bucket)
    }
    bucket.geos.push(g)
    bucket.count++
  }

  let idx = 0
  for (const [key, b] of groups) {
    let merged: THREE.BufferGeometry | null = null
    try {
      merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false)
    } catch {
      merged = null
    }
    if (!merged) {
      // never drop physics — emit unmerged rather than silently skip
      b.geos.forEach((g, i) => root.add(makeMergedMesh(g, b.rep, b.count, `${key}#${i}`, idx++)))
      continue
    }
    root.add(makeMergedMesh(merged, b.rep, b.count, key, idx++))
  }

  root.userData = {
    formatVersion: 2, // v2: pre-merged nodes (was per-feature in v1)
    merged: true,
    generator: 'CityBuilder',
    stats: set.stats,
    bounds: set.bounds,
    nodeCount: root.children.length,
  }
  return root
}

function makeMergedMesh(
  geometry: THREE.BufferGeometry,
  rep: ColliderDescriptor,
  featureCount: number,
  key: string,
  idx: number,
): THREE.Mesh {
  const s = rep.semantics
  const mesh = new THREE.Mesh(geometry, s.sensor ? sensorMat : solidMat)
  mesh.name = `col_${s.sensor ? 'sensor_' : ''}${s.class}_${idx}`
  mesh.userData = {
    collider: { kind: 'trimesh' },
    semantics: {
      class: s.class,
      drivable: s.drivable ?? false,
      sensor: s.sensor ?? false,
      static: true,
      merged: true,
      featureCount,
      groupKey: key,
    },
    physicsMaterial: {
      friction: rep.material.friction,
      restitution: rep.material.restitution,
      surfaceTag: rep.material.surfaceTag ?? null,
    },
  }
  return mesh
}
