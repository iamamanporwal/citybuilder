import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { optimizeSceneForExport } from '../export/optimizeScene'
import { colliderGroupMerged } from '../export/colliderGlb'
import { deriveSpawn, buildMinimapGroup } from '../export/spawn'
import type { ColliderSet } from '../physics/types'
import type { RoadSemanticsEntry } from '../export/semantics'

function boxMesh(mat: THREE.Material, x: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
  m.position.x = x
  return m
}

describe('optimizeSceneForExport', () => {
  it('dedups identical materials and merges their geometry', () => {
    const root = new THREE.Group()
    // three visually identical meshes (distinct instances) at different positions
    for (let i = 0; i < 3; i++) {
      root.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#808080', roughness: 0.5 }), i * 5))
    }
    const { group, stats } = optimizeSceneForExport(root)
    expect(stats.materialsBefore).toBe(3)
    expect(stats.materialsAfter).toBe(1)
    expect(stats.meshesBefore).toBe(3)
    expect(stats.meshesAfter).toBe(1) // one merged batch
    // merged geometry keeps all vertices (3 baked boxes)
    const merged = group.children[0] as THREE.Mesh
    expect(merged.geometry.getAttribute('position').count).toBe(72) // 24 verts * 3
  })

  it('keeps transparent materials in a separate batch', () => {
    const root = new THREE.Group()
    root.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#808080' }), 0))
    root.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#808080', transparent: true, opacity: 0.5 }), 5))
    const { group, stats } = optimizeSceneForExport(root)
    expect(stats.materialsAfter).toBe(2)
    expect(group.children.length).toBe(2)
  })

  it('keeps multi-material meshes as passthrough without double-emitting children', () => {
    const root = new THREE.Group()
    // multi-material parent with a single-material child mesh
    const parent = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      [new THREE.MeshStandardMaterial({ color: '#111111' }), new THREE.MeshStandardMaterial({ color: '#222222' })],
    )
    parent.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#333333' }), 2))
    root.add(parent)
    const { group, stats } = optimizeSceneForExport(root)
    expect(stats.meshesBefore).toBe(2) // parent + child
    expect(group.children.length).toBe(2) // passthrough parent + merged child (no dupes)
  })

  it('bakes world transform into merged geometry (position preserved)', () => {
    const root = new THREE.Group()
    root.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#123456' }), 100))
    const { group } = optimizeSceneForExport(root)
    const merged = group.children[0] as THREE.Mesh
    merged.geometry.computeBoundingBox()
    const c = new THREE.Vector3()
    merged.geometry.boundingBox!.getCenter(c)
    expect(c.x).toBeCloseTo(100, 3)
  })
})

describe('colliderGroupMerged', () => {
  function tri(id: string, cls: 'road' | 'building', drivable: boolean, friction: number): ColliderSet['colliders'][number] {
    const g = new THREE.BoxGeometry(2, 2, 2)
    g.deleteAttribute('uv')
    g.deleteAttribute('normal')
    return {
      id,
      kind: 'trimesh',
      geometry: g,
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      semantics: { class: cls, featureId: id, drivable, static: true },
      material: { friction, restitution: 0 },
    }
  }

  it('merges colliders that share a physics group and keeps distinct groups apart', () => {
    const set: ColliderSet = {
      colliders: [
        tri('a', 'road', true, 0.9),
        tri('b', 'road', true, 0.9), // same group as a → merges
        tri('c', 'building', false, 0.8), // distinct group
      ],
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      stats: {} as ColliderSet['stats'],
    }
    const g = colliderGroupMerged(set)
    expect(g.children.length).toBe(2) // road group + building group
    expect(g.userData.formatVersion).toBe(2)
    expect(g.userData.merged).toBe(true)
    const road = g.children.find((c) => c.userData.semantics.class === 'road')!
    expect(road.userData.semantics.merged).toBe(true)
    expect(road.userData.semantics.featureCount).toBe(2)
    expect(road.userData.semantics.drivable).toBe(true)
    expect(road.userData.physicsMaterial.friction).toBeCloseTo(0.9)
  })

  it('bakes box/cylinder primitives into merged trimeshes', () => {
    const set: ColliderSet = {
      colliders: [
        {
          id: 'wall',
          kind: 'box',
          halfExtents: [1, 1, 1],
          transform: { position: [5, 0, 0], quaternion: [0, 0, 0, 1] },
          semantics: { class: 'barrier', featureId: 'w', static: true },
          material: { friction: 0.6, restitution: 0 },
        },
      ],
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      stats: {} as ColliderSet['stats'],
    }
    const g = colliderGroupMerged(set)
    expect(g.children.length).toBe(1)
    const mesh = g.children[0] as THREE.Mesh
    expect(mesh.userData.collider.kind).toBe('trimesh')
    expect(mesh.geometry.getAttribute('position')).toBeTruthy()
  })
})

describe('deriveSpawn + minimap', () => {
  function road(id: string, cls: string, opts: Partial<RoadSemanticsEntry> = {}): RoadSemanticsEntry {
    return {
      id,
      name: null,
      class: cls,
      width_m: 10,
      lanes: 2,
      oneway: false,
      bridge: false,
      tunnel: false,
      layer: 0,
      surface: null,
      marking: null,
      confidence: null,
      drivable: true,
      cross_section: null,
      elevation: null,
      centerline: [
        [0, 0, 0],
        [50, 0, 0],
        [100, 0, 0],
      ],
      ...opts,
    }
  }
  const bounds = { minX: -100, maxX: 200, minZ: -100, maxZ: 100 }

  it('picks a drivable, non-bridge road and faces down its centerline', () => {
    const spawn = deriveSpawn([road('r1', 'primary')], bounds)
    expect(spawn).not.toBeNull()
    expect(spawn!.road_id).toBe('r1')
    expect(spawn!.forward[0]).toBeCloseTo(1) // heading +x down the centerline
    expect(spawn!.forward[2]).toBeCloseTo(0)
  })

  it('skips bridges, tunnels and footways', () => {
    const spawn = deriveSpawn(
      [
        road('bridge', 'primary', { bridge: true }),
        road('foot', 'footway', { drivable: false }),
      ],
      bounds,
    )
    expect(spawn).toBeNull()
  })

  it('builds a minimap group with one mesh per drivable road', () => {
    const g = buildMinimapGroup([road('r1', 'primary'), road('foot', 'footway', { drivable: false })])
    expect(g.children.length).toBe(1)
  })
})
