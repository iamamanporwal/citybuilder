import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BuildingFeature, PointFeature } from '../types'
import { libraryAsset, pickAssetFor, pooledAssetsOfSemantic, type LibraryAsset } from '../resolver/assetPools'

// Bridges the asset library into the procedural 2D→3D build. Library GLBs are
// pre-loaded (async) into per-kind templates BEFORE buildScene runs, then the
// synchronous prop builders instance/clone those templates in place of the
// procedural geometry. If a template is missing (flag off, no pooled asset, or
// a load error) the builder falls back to procedural — nothing breaks.

type PropKind = PointFeature['kind']

// Which OSM tag each point kind resolves against in the pools.
const KIND_TAG: Record<PropKind, string> = {
  tree: 'natural=tree',
  street_lamp: 'highway=street_lamp',
  traffic_signal: 'highway=traffic_signals',
  bench: 'amenity=bench',
  waste_basket: 'amenity=waste_basket',
  bus_stop: 'highway=bus_stop',
  fountain: 'amenity=fountain',
  statue: 'historic=memorial',
}

// Canonical real-world height (m) each kind is normalized to on load. Library
// assets arrive at wildly different authoring scales (metric to ~1000×); this
// pins them to a believable street size regardless of source units.
const CANONICAL_HEIGHT: Record<PropKind, number> = {
  tree: 9,
  street_lamp: 6.5,
  traffic_signal: 5.5,
  bench: 0.95,
  waste_basket: 1.0,
  bus_stop: 3.0,
  fountain: 3.5,
  statue: 3.5,
}

export interface TemplatePart {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

export interface AssetTemplate {
  kind: PropKind
  assetId: string
  name: string
  license: string
  parts: TemplatePart[] // baked to real scale, centered on X/Z, base at y=0
  sizeMeters: { x: number; y: number; z: number }
}

const templates = new Map<PropKind, AssetTemplate>()
// raw building GLB scenes (assetId → scene), cloned + fit-to-slot per footprint
const buildingScenes = new Map<string, THREE.Object3D>()
let loadFlag = false

// Library buildings only stand in for low/mid-rise stock: fitToSlot scales
// uniformly to the footprint, so a short brick model dropped into a tall tower
// slot would look squashed. Above this height we keep the procedural mass.
const MAX_LIBRARY_BUILDING_H = 45

export function getTemplate(kind: PropKind): AssetTemplate | undefined {
  return loadFlag ? templates.get(kind) : undefined
}

/** A cloned library building scene for this footprint, or null (→ procedural). */
export function buildingSceneFor(b: BuildingFeature): THREE.Object3D | null {
  if (!loadFlag || !buildingScenes.size) return null
  if (b.heightM > MAX_LIBRARY_BUILDING_H) return null
  const tag = `building=${b.tags.building && b.tags.building !== 'yes' ? b.tags.building : 'yes'}`
  const picked = pickAssetFor(tag, b.id) ?? pickAssetFor('building=yes', b.id)
  const scene = picked && buildingScenes.get(picked.id)
  return scene ? scene.clone(true) : null
}

export function librarySummary(): { kind: string; name: string; license: string }[] {
  return [...templates.values()].map((t) => ({ kind: t.kind, name: t.name, license: t.license }))
}

export function clearLibraryTemplates() {
  templates.clear()
  buildingScenes.clear()
}

function assetUrl(a: LibraryAsset): string {
  // repo assets/library/<rest>  →  served by the dev middleware at /assetlib/<rest>
  return '/assetlib/' + a.path.replace(/^assets\/library\//, '')
}

/** Flatten a loaded GLB scene into world-baked (geometry, material) parts. */
function flatten(root: THREE.Object3D): TemplatePart[] {
  root.updateWorldMatrix(true, true)
  const parts: TemplatePart[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geo = mesh.geometry.clone()
    geo.applyMatrix4(mesh.matrixWorld) // bake local hierarchy transform
    if (!geo.getAttribute('normal')) geo.computeVertexNormals()
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    parts.push({ geometry: geo, material: mat })
  })
  return parts
}

/** Normalize parts in place: uniform-scale to canonical height, center X/Z, base at y=0. */
function normalize(parts: TemplatePart[], canonicalH: number): { x: number; y: number; z: number } {
  const box = new THREE.Box3()
  for (const p of parts) {
    p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox!)
  }
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const scale = size.y > 1e-4 ? canonicalH / size.y : 1
  const m = new THREE.Matrix4().makeScale(scale, scale, scale)
  // after scaling, recenter X/Z on origin and drop base to y=0
  const t = new THREE.Matrix4().makeTranslation(-center.x * scale, -box.min.y * scale, -center.z * scale)
  const full = t.multiply(m)
  for (const p of parts) p.geometry.applyMatrix4(full)
  return { x: size.x * scale, y: size.y * scale, z: size.z * scale }
}

async function loadOne(kind: PropKind, loader: GLTFLoader): Promise<void> {
  const tag = KIND_TAG[kind]
  // deterministic single representative asset per kind (so instancing groups cleanly)
  const picked = pickAssetFor(tag, `libtemplate:${kind}`)
  if (!picked) return
  const asset = libraryAsset(picked.id)!
  // GLTFLoader resolves .bin/textures relative to the .gltf URL, which the
  // /assetlib dev middleware serves — so both self-contained .glb and
  // multi-file .gltf load.
  const gltf = await loader.loadAsync(assetUrl(asset))
  const parts = flatten(gltf.scene)
  if (!parts.length) return
  const sizeMeters = normalize(parts, CANONICAL_HEIGHT[kind])
  templates.set(kind, {
    kind,
    assetId: asset.id,
    name: asset.id.split('/').pop() ?? asset.id,
    license: asset.license,
    parts,
    sizeMeters,
  })
}

// Load every placeable building GLB once (kept raw — fitToSlot handles scaling
// per footprint at build time).
async function loadBuildings(loader: GLTFLoader): Promise<void> {
  await Promise.all(
    pooledAssetsOfSemantic('building').map(async (asset) => {
      try {
        const gltf = await loader.loadAsync(assetUrl(asset))
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
        })
        buildingScenes.set(asset.id, gltf.scene)
      } catch (e) {
        console.warn(`[library] building ${asset.id} load failed:`, (e as Error).message)
      }
    }),
  )
}

/**
 * Pre-load library templates for the given point kinds. Best-effort: a kind
 * with no pooled GLB, or a load failure, is simply skipped (procedural
 * fallback). Call BEFORE buildScene; results are read synchronously via
 * getTemplate. Set enabled=false to force all-procedural.
 */
export async function loadLibraryTemplates(kinds: Iterable<PropKind>, enabled: boolean): Promise<void> {
  clearLibraryTemplates()
  loadFlag = enabled
  if (!enabled) return
  const loader = new GLTFLoader()
  const unique = [...new Set(kinds)]
  await Promise.all([
    ...unique.map((k) =>
      loadOne(k, loader).catch((e) => {
        console.warn(`[library] ${k} template load failed, using procedural:`, (e as Error).message)
      }),
    ),
    loadBuildings(loader),
  ])
}

/** Instance a template's parts across placements. Returns meshes to add to a group. */
export function instanceTemplate(
  tmpl: AssetTemplate,
  placements: { x: number; z: number; rotY: number; scale?: number }[],
  objectId: string,
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = []
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const v = new THREE.Vector3()
  const s = new THREE.Vector3()
  for (const part of tmpl.parts) {
    const im = new THREE.InstancedMesh(part.geometry, part.material, placements.length)
    placements.forEach((pl, i) => {
      const sc = pl.scale ?? 1
      q.setFromAxisAngle(up, pl.rotY)
      v.set(pl.x, 0, pl.z)
      s.set(sc, sc, sc)
      m.compose(v, q, s)
      im.setMatrixAt(i, m)
    })
    im.instanceMatrix.needsUpdate = true
    im.castShadow = true
    im.receiveShadow = true
    im.userData.objectId = objectId
    out.push(im)
  }
  return out
}

/** Clone a template into a single positioned Group (for individually-selectable props). */
export function cloneTemplate(tmpl: AssetTemplate): THREE.Group {
  const g = new THREE.Group()
  for (const part of tmpl.parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    g.add(mesh)
  }
  return g
}
