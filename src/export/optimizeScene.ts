import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Export optimizer (fixes the game engine's "2,217 materials → draw-call storm"
// flag). The editor mints a fresh material per building (per-tint + per-instance
// UV jitter) and per road segment — thousands of one-off materials and meshes.
//
// This pass runs on a throwaway clone right before export and does two things:
//   1. Deduplicate materials by visual signature. The ONLY per-instance
//      difference is the anti-tiling UV *offset* (cosmetic); we drop it so
//      identical looks collapse to a single shared material.
//   2. Merge every geometry that shares a material into one batched mesh, so the
//      game gets a few dozen draw calls instead of thousands.
//
// The visual GLB is only render + raycast source — gameplay identity lives in
// city_semantics.json — so flattening per-object nodes is safe.

const KEEP_ATTRS = new Set(['position', 'normal', 'uv', 'color'])

function q(v: number): number {
  return Math.round(v * 1000) / 1000
}

function texId(t: THREE.Texture | null | undefined): string {
  if (!t) return '-'
  // source.uuid is shared across Texture.clone() (clones copy the source ref),
  // so per-instance cloned maps of the same canvas collapse here. repeat DOES
  // matter (road tile vs facade tile); offset is intentionally excluded.
  return `${t.source?.uuid ?? t.uuid}:${q(t.repeat.x)}x${q(t.repeat.y)}:${t.colorSpace}`
}

/** Visual signature of a material, ignoring per-instance UV offset. */
function materialSignature(m: THREE.Material): string {
  const s = m as unknown as {
    color?: THREE.Color
    emissive?: THREE.Color
    emissiveIntensity?: number
    roughness?: number
    metalness?: number
    map?: THREE.Texture
    normalMap?: THREE.Texture
    roughnessMap?: THREE.Texture
    metalnessMap?: THREE.Texture
    emissiveMap?: THREE.Texture
    vertexColors?: boolean
  }
  return [
    m.type,
    s.color ? s.color.getHexString() : '-',
    s.emissive ? s.emissive.getHexString() : '-',
    s.emissiveIntensity ?? '-',
    s.roughness ?? '-',
    s.metalness ?? '-',
    m.transparent ? '1' : '0',
    q(m.opacity),
    m.side,
    m.depthWrite ? '1' : '0',
    s.vertexColors ? '1' : '0',
    texId(s.map),
    texId(s.normalMap),
    texId(s.roughnessMap),
    texId(s.metalnessMap),
    texId(s.emissiveMap),
  ].join('|')
}

/** Canonical instance for a signature: a CLONE with UV offsets zeroed (we merge
 *  geometry, which drops the per-instance jitter the offset provided). Cloning —
 *  rather than mutating — keeps the live editor materials untouched on export.
 *  Cloned textures share their .source, so GLTFExporter still dedups the image. */
function canonicalize(m: THREE.Material): THREE.Material {
  const clone = m.clone()
  const s = clone as unknown as Record<string, THREE.Texture | undefined>
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
    const tex = s[slot]
    if (tex && (tex.offset.x !== 0 || tex.offset.y !== 0)) {
      const t = tex.clone()
      t.offset.set(0, 0)
      s[slot] = t
    }
  }
  return clone
}

/** World-bake a geometry and normalize it for merging (indexed, common attrs). */
function prepGeometry(geo: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry | null {
  if (!geo.getAttribute('position')) return null
  const g = geo.clone()
  g.morphAttributes = {}
  for (const name of Object.keys(g.attributes)) {
    if (!KEEP_ATTRS.has(name)) g.deleteAttribute(name)
  }
  g.applyMatrix4(matrix)
  if (!g.getIndex()) {
    const count = g.getAttribute('position').count
    const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
    for (let i = 0; i < count; i++) arr[i] = i
    g.setIndex(new THREE.BufferAttribute(arr, 1))
  }
  return g
}

function attributeSignature(g: THREE.BufferGeometry): string {
  return Object.keys(g.attributes).sort().join(',')
}

export interface OptimizeStats {
  materialsBefore: number
  materialsAfter: number
  meshesBefore: number
  meshesAfter: number
}

/**
 * Returns a new Group with deduped materials and merged geometry, plus stats.
 * Never drops geometry: if a bucket can't be merged it is emitted unmerged.
 */
export function optimizeSceneForExport(root: THREE.Object3D): { group: THREE.Group; stats: OptimizeStats } {
  root.updateMatrixWorld(true)

  const canonical = new Map<string, THREE.Material>()
  const seenMaterials = new Set<THREE.Material>()
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>()
  const passthrough: THREE.Object3D[] = []
  let meshesBefore = 0

  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geo = mesh.geometry
    if (!geo || !geo.getAttribute('position')) return
    meshesBefore++

    // Multi-material meshes reference geometry groups — keep them intact, just
    // bake the world transform so they sit correctly with no parent nodes.
    if (Array.isArray(mesh.material)) {
      // clone(false): children are visited separately by traverse() — a recursive
      // clone would double-emit them
      const clone = mesh.clone(false)
      clone.geometry = geo.clone().applyMatrix4(mesh.matrixWorld)
      clone.position.set(0, 0, 0)
      clone.quaternion.identity()
      clone.scale.set(1, 1, 1)
      mesh.material.forEach((m) => seenMaterials.add(m))
      passthrough.push(clone)
      return
    }

    const mat = mesh.material as THREE.Material
    seenMaterials.add(mat)
    const sig = materialSignature(mat)
    let canon = canonical.get(sig)
    if (!canon) {
      canon = canonicalize(mat)
      canonical.set(sig, canon)
    }

    const g = prepGeometry(geo, mesh.matrixWorld)
    if (!g) return
    const key = `${sig}##${attributeSignature(g)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { mat: canon, geos: [] }
      buckets.set(key, bucket)
    }
    bucket.geos.push(g)
  })

  const group = new THREE.Group()
  group.name = root.name || 'citybuilder_scene'
  let idx = 0
  for (const b of buckets.values()) {
    let merged: THREE.BufferGeometry | null = null
    try {
      merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false)
    } catch {
      merged = null
    }
    if (merged) {
      const mesh = new THREE.Mesh(merged, b.mat)
      mesh.name = `batch_${idx++}`
      group.add(mesh)
    } else {
      // merge failed (shouldn't happen after normalization) — never drop geometry
      b.geos.forEach((g) => group.add(new THREE.Mesh(g, b.mat)))
    }
  }
  for (const p of passthrough) group.add(p)

  return {
    group,
    stats: {
      materialsBefore: seenMaterials.size,
      materialsAfter: canonical.size,
      meshesBefore,
      meshesAfter: group.children.length,
    },
  }
}
