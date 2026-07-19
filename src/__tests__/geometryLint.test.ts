import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { geometryLint } from '../scene/geometryLint'
import { mergeGeometries } from '../procgen/geometry'

// Regression suite for the render-visibility gate (Problem 2: objects invisible
// from some angles / pop in when close) — bounding volumes, vertex normals,
// instanced bounds, and clip-range coverage.

const mat = () => new THREE.MeshBasicMaterial()
const warns = (roots: THREE.Object3D[], opts = {}) => geometryLint(roots, opts).filter((w) => w.severity === 'warn')

function validBox(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(2, 2, 2)
  return new THREE.Mesh(geo, mat())
}

describe('geometryLint — clean scene', () => {
  it('passes a well-formed mesh with an info summary', () => {
    const out = geometryLint([validBox()])
    expect(out.filter((w) => w.severity === 'warn')).toEqual([])
    expect(out.some((w) => w.severity === 'info' && w.message.includes('Geometry check passed'))).toBe(true)
  })

  it('lazily computes null bounds (as the renderer would) and accepts them', () => {
    const m = validBox()
    m.geometry.boundingSphere = null // simulate a fresh post-merge geometry
    expect(warns([m])).toEqual([])
    expect(m.geometry.boundingSphere).not.toBeNull()
  })
})

describe('geometryLint — bounds', () => {
  it('flags a mesh whose bounds are non-finite', () => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    geo.setIndex([0, 1, 2])
    const w = warns([new THREE.Mesh(geo, mat())])
    expect(w.some((x) => x.message.includes('bounding volumes'))).toBe(true)
  })
})

describe('geometryLint — normals', () => {
  it('flags zero-length vertex normals (the black-face / dropped-normal merge bug)', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const n = geo.getAttribute('normal') as THREE.BufferAttribute
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0, 0)
    n.needsUpdate = true
    const w = warns([new THREE.Mesh(geo, mat())])
    expect(w.some((x) => x.message.includes('zero-length vertex normals'))).toBe(true)
  })
})

describe('geometryLint — instanced bounds', () => {
  function spreadInstances(): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(), 2)
    const m = new THREE.Matrix4()
    im.setMatrixAt(0, m.makeTranslation(0, 0, 0))
    im.setMatrixAt(1, m.makeTranslation(1000, 0, 0))
    im.instanceMatrix.needsUpdate = true
    return im
  }

  it('flags stale bounds that do not enclose all instances', () => {
    const im = spreadInstances()
    im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1) // wrong: origin only
    const w = warns([im], { bounds: { minX: -1200, maxX: 1200, minZ: 0, maxZ: 0 } })
    expect(w.some((x) => x.message.includes('do not enclose all instances'))).toBe(true)
  })

  it('passes once the instance-aware bounding sphere is computed', () => {
    const im = spreadInstances()
    im.computeBoundingSphere() // the fix applied in the generators
    const w = warns([im], { bounds: { minX: -1200, maxX: 1200, minZ: 0, maxZ: 0 } })
    expect(w.some((x) => x.message.includes('do not enclose all instances'))).toBe(false)
  })
})

describe('geometryLint — clip range', () => {
  it('flags a scene that reaches past the camera far plane', () => {
    const w = warns([validBox()], { bounds: { minX: -9000, maxX: 9000, minZ: 0, maxZ: 0 } })
    expect(w.some((x) => x.message.includes('far plane'))).toBe(true)
  })
})

describe('mergeGeometries — normal robustness', () => {
  it('produces non-zero normals even when a source lacks a normal attribute', () => {
    const withNormals = new THREE.PlaneGeometry(1, 1)
    const noNormals = new THREE.BufferGeometry()
    noNormals.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3))
    noNormals.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2))
    noNormals.setIndex([0, 1, 2])
    const merged = mergeGeometries([withNormals, noNormals])
    const n = merged.getAttribute('normal') as THREE.BufferAttribute
    let zero = 0
    for (let i = 0; i < n.count; i++) if (n.getX(i) === 0 && n.getY(i) === 0 && n.getZ(i) === 0) zero++
    expect(zero).toBe(0)
    // and geometryLint agrees the merged mesh is clean
    expect(warns([new THREE.Mesh(merged, mat())])).toEqual([])
  })
})
