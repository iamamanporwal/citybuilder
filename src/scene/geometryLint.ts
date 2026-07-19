import * as THREE from 'three'
import type { LintWarning } from '../resolver/varietyLint'
import { DEPTH_CONFIG } from '../editor/depthConfig'

// Render-visibility lint — the counterpart to physics/colliderLint for the VISUAL
// scene. It guards the two root causes of "objects invisible from some angles /
// pop in when close":
//   1. Stale / wrong bounding volumes → three.js frustum-culls a mesh that is
//      actually on screen (worst on merged & instanced meshes, whose bounds must
//      be recomputed after the merge/after instance matrices are set).
//   2. Zero-length vertex normals (a merge that dropped a source's normals) →
//      faces shade black, the visibility-adjacent glitch.
// Plus a clip-range sanity check: the far plane must reach the whole scene, or
// distant geometry is clipped away.
//
// Pure aside from lazily computing bounding volumes on the geometries it is
// handed (which is exactly what a correct renderer would do on first cull). Runs
// in vitest (THREE works headless) and at the build/export gate.

export interface GeometryLintOptions {
  /** Scene bounds (ENU meters) for the far-plane coverage check. */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** Cap on per-geometry normal samples (block-level zero normals still caught). */
  normalSamples?: number
}

const _v = new THREE.Vector3()
const _sphere = new THREE.Sphere()

export function geometryLint(roots: THREE.Object3D[], opts: GeometryLintOptions = {}): LintWarning[] {
  const warnings: LintWarning[] = []
  const warn = (message: string) => warnings.push({ severity: 'warn', message })
  const sampleCap = opts.normalSamples ?? 256

  let meshes = 0
  let badBounds = 0
  let zeroNormalMeshes = 0
  let badInstanceBounds = 0
  let maxReach = 0
  let firstBadBounds = ''
  let firstZeroNormal = ''
  let firstBadInstance = ''

  for (const root of roots) {
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const geo = mesh.geometry
      const pos = geo?.getAttribute('position')
      if (!geo || !pos) return
      meshes++

      // 1) bounding sphere must exist and be finite/positive. Compute lazily
      // (null after a merge/vertex edit) exactly as the renderer would.
      if (!geo.boundingSphere) geo.computeBoundingSphere()
      const bs = geo.boundingSphere
      if (!bs || !Number.isFinite(bs.radius) || bs.radius <= 0 || !isFiniteVec3(bs.center)) {
        badBounds++
        if (!firstBadBounds) firstBadBounds = mesh.name || o.type
      }

      // 2) normals present and non-degenerate (skip point/line/basic-lit prims
      // that legitimately carry none). Sample with a stride so a whole-city scan
      // stays cheap while still catching contiguous zero-normal blocks.
      const nrm = geo.getAttribute('normal')
      if (nrm) {
        const stride = Math.max(1, Math.floor(nrm.count / sampleCap))
        let zero = 0
        for (let i = 0; i < nrm.count; i += stride) {
          if (nrm.getX(i) === 0 && nrm.getY(i) === 0 && nrm.getZ(i) === 0) zero++
        }
        if (zero > 0) {
          zeroNormalMeshes++
          if (!firstZeroNormal) firstZeroNormal = mesh.name || o.type
        }
      }

      // 3) InstancedMesh: instance matrices carry world offsets, so the sphere
      // must enclose EVERY instance or the whole batch is wrongly culled.
      const im = mesh as THREE.InstancedMesh
      if (im.isInstancedMesh) {
        if (!im.boundingSphere) im.computeBoundingSphere()
        const isphere = im.boundingSphere
        if (!isphere || !Number.isFinite(isphere.radius) || !isFiniteVec3(isphere.center)) {
          badInstanceBounds++
          if (!firstBadInstance) firstBadInstance = mesh.name || 'instanced'
        } else if (!instancesEnclosed(im, geo, isphere)) {
          badInstanceBounds++
          if (!firstBadInstance) firstBadInstance = mesh.name || 'instanced'
        }
      }

      // track farthest reach for the clip-range check (world-space)
      if (bs && Number.isFinite(bs.radius)) {
        _sphere.copy(bs).applyMatrix4(mesh.matrixWorld)
        const reach = _sphere.center.length() + _sphere.radius
        if (reach > maxReach) maxReach = reach
      }
    })
  }

  if (badBounds) warn(`Geometry: ${badBounds} mesh(es) have missing/non-finite bounding volumes (e.g. ${firstBadBounds})`)
  if (zeroNormalMeshes)
    warn(`Geometry: ${zeroNormalMeshes} mesh(es) contain zero-length vertex normals (e.g. ${firstZeroNormal}) — will shade black`)
  if (badInstanceBounds)
    warn(`Geometry: ${badInstanceBounds} instanced mesh(es) have bounds that do not enclose all instances (e.g. ${firstBadInstance}) — batch will pop in/out`)

  // 4) clip range: the far plane must reach the whole scene, else distant
  // geometry is culled by the frustum. Prefer the measured reach; fall back to
  // the supplied bounds diagonal.
  let reach = maxReach
  if (opts.bounds) {
    const { minX, maxX, minZ, maxZ } = opts.bounds
    reach = Math.max(reach, Math.hypot(Math.max(Math.abs(minX), Math.abs(maxX)), Math.max(Math.abs(minZ), Math.abs(maxZ))))
  }
  if (reach > DEPTH_CONFIG.far) {
    warn(
      `Geometry: scene reaches ${Math.round(reach)} m but the camera far plane is ${DEPTH_CONFIG.far} m — ` +
        `distant geometry will be clipped`,
    )
  }

  if (!warnings.length) {
    warnings.push({
      severity: 'info',
      message: `Geometry check passed: ${meshes} meshes, bounds/normals valid, reach ${Math.round(reach)} m within far ${DEPTH_CONFIG.far} m`,
    })
  }
  return warnings
}

function isFiniteVec3(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/**
 * True when the instanced bounding sphere encloses every instance's geometry.
 * Samples instance translations (capped) and checks each lies within the sphere
 * radius allowing for the base geometry's own radius. Catches the classic
 * "sphere left at the origin geometry" bug where a wide-spread batch is culled.
 */
function instancesEnclosed(im: THREE.InstancedMesh, geo: THREE.BufferGeometry, sphere: THREE.Sphere): boolean {
  const geoR = geo.boundingSphere?.radius ?? 0
  const n = im.count
  const stride = Math.max(1, Math.floor(n / 128))
  const mat = new THREE.Matrix4()
  for (let i = 0; i < n; i += stride) {
    im.getMatrixAt(i, mat)
    _v.setFromMatrixPosition(mat)
    // instance origin must sit within the sphere (plus the instance's own extent,
    // conservatively the geometry radius scaled by the instance's max axis scale)
    const scale = maxAxisScale(mat)
    if (_v.distanceTo(sphere.center) > sphere.radius + geoR * scale + 1e-3) return false
  }
  return true
}

function maxAxisScale(m: THREE.Matrix4): number {
  const e = m.elements
  const sx = Math.hypot(e[0], e[1], e[2])
  const sy = Math.hypot(e[4], e[5], e[6])
  const sz = Math.hypot(e[8], e[9], e[10])
  return Math.max(sx, sy, sz)
}
