import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { useEditor } from '../state/store'
import {
  buildingFeatures,
  generationCache,
  getVariant,
  registerVariant,
  replaceables,
  variantKey,
} from '../scene/registry'
import { fitToSlot } from '../procgen/buildings'
import type { AssetInfo } from '../types'

// In-app Sketchfab library search + drop-into-slot (PRD §9 / §7D).
//
// All network goes through the same-origin Vite dev proxy (see vite.config.ts),
// which injects the API token server-side — the token is never in the client
// bundle. If the proxy isn't present (e.g. a static production build), these
// calls fail and the provider reports itself unavailable.

const API = '/api/sketchfab'

export interface SketchfabModel {
  uid: string
  name: string
  author: string
  authorUrl: string | null
  viewerUrl: string
  faceCount: number
  license: string // human label, e.g. "CC Attribution"
  licenseSlug: string
  thumbnail: string | null
}

// Permissive licenses only: CC0, CC-BY, CC-BY-SA. NC (non-commercial) and
// ND (no-derivatives — blocks our scale-to-slot fitting) are excluded.
const ALLOWED_LICENSES = ['cc0', 'by', 'by-sa'] as const

function pickThumb(r: any): string | null {
  const imgs = r?.thumbnails?.images || []
  const mid = imgs
    .filter((i: any) => i.width >= 200 && i.width <= 640)
    .sort((a: any, b: any) => a.width - b.width)[0]
  return (mid || imgs[0])?.url || null
}

/** Probe whether the Sketchfab proxy/token is wired (enables the provider). */
export async function sketchfabAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/me`, { headers: { Accept: 'application/json' } })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Search downloadable, permissively-licensed models under a per-semantic poly
 * budget. Merges the allowed-license buckets and de-dups by uid.
 */
export async function searchSketchfab(
  query: string,
  opts: { maxFaces?: number; perLicense?: number } = {},
): Promise<SketchfabModel[]> {
  const maxFaces = opts.maxFaces ?? 60000
  const perLicense = opts.perLicense ?? 8
  const seen = new Map<string, SketchfabModel>()

  await Promise.all(
    ALLOWED_LICENSES.map(async (slug) => {
      const qs = new URLSearchParams({
        type: 'models',
        q: query,
        downloadable: 'true',
        license: slug,
        min_face_count: '1',
        max_face_count: String(maxFaces),
        sort_by: '-likeCount',
        count: String(perLicense),
      })
      try {
        const res = await fetch(`${API}/search?${qs}`)
        if (!res.ok) return
        const data = await res.json()
        for (const r of data.results || []) {
          if (!r.isDownloadable || !r.faceCount) continue
          if (seen.has(r.uid)) continue
          seen.set(r.uid, {
            uid: r.uid,
            name: r.name,
            author: r.user?.displayName || r.user?.username || 'unknown',
            authorUrl: r.user?.profileUrl || null,
            viewerUrl: r.viewerUrl || `https://sketchfab.com/3d-models/${r.uid}`,
            faceCount: r.faceCount,
            license: r.license?.label || slug,
            licenseSlug: slug,
            thumbnail: pickThumb(r),
          })
        }
      } catch {
        /* one license bucket failing shouldn't kill the search */
      }
    }),
  )

  // leaner models first (cheaper to render, better for a dense city)
  return [...seen.values()].sort((a, b) => a.faceCount - b.faceCount)
}

/** Resolve a model's GLB download URL, then fetch its bytes through the proxy. */
async function fetchGlb(uid: string): Promise<ArrayBuffer> {
  const linksRes = await fetch(`${API}/models/${uid}/download`)
  if (!linksRes.ok) throw new Error(`download endpoint ${linksRes.status}`)
  const links = await linksRes.json()
  const glbUrl: string | undefined = links.glb?.url || links.gltf?.url
  if (!glbUrl) throw new Error('no glb/gltf download for this model')
  // route the temp S3 URL through the same-origin download proxy
  const proxied = `/api/sketchfab-dl?url=${encodeURIComponent(glbUrl)}`
  const binRes = await fetch(proxied)
  if (!binRes.ok) throw new Error(`file fetch ${binRes.status}`)
  return binRes.arrayBuffer()
}

/** Uniform-scale + ground a loaded model to a reference object's footprint. */
function fitToObjectBounds(model: THREE.Object3D, reference: THREE.Object3D): THREE.Group {
  const refBox = new THREE.Box3().setFromObject(reference)
  const refSize = refBox.getSize(new THREE.Vector3())
  const refCenter = refBox.getCenter(new THREE.Vector3())

  const modelBox = new THREE.Box3().setFromObject(model)
  const modelSize = modelBox.getSize(new THREE.Vector3())
  const modelCenter = modelBox.getCenter(new THREE.Vector3())

  // fit the horizontal footprint (props keep their own proportional height)
  const sx = modelSize.x > 1e-4 ? refSize.x / modelSize.x : 1
  const sz = modelSize.z > 1e-4 ? refSize.z / modelSize.z : 1
  const s = Math.min(sx, sz)

  const group = new THREE.Group()
  model.position.set(-modelCenter.x, -modelBox.min.y, -modelCenter.z)
  group.add(model)
  group.scale.setScalar(s)
  group.position.set(refCenter.x, refBox.min.y, refCenter.z)
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = true
      m.receiveShadow = true
    }
  })
  return group
}

function cacheKeyFor(uid: string): string {
  return `sf_${uid}`
}

/**
 * Download a chosen Sketchfab model and drop it into an object's slot.
 * Buildings fit to their footprint (fitToSlot); other replaceables fit to the
 * current placeholder's bounds. Provenance + license are recorded on the asset.
 */
export async function replaceWithSketchfab(objectId: string, model: SketchfabModel): Promise<void> {
  const store = useEditor.getState()
  const slot = replaceables.get(objectId)
  if (!slot) {
    store.showToast('This object has no replace slot (buildings & wikidata-linked props only)')
    return
  }
  if (store.jobs[objectId]) return

  const cacheKey = cacheKeyFor(model.uid)
  const asset: AssetInfo = {
    state: 'library',
    provider: 'sketchfab',
    license: `${model.license} — "${model.name}" by ${model.author} (Sketchfab)`,
    approved: false,
    cacheKey,
  }
  const key = variantKey(asset)

  if (generationCache.has(cacheKey)) {
    registerVariant(objectId, key, generationCache.get(cacheKey)!)
    store.swapAsset(objectId, asset)
    store.showToast('Cache hit — reused the downloaded model (no re-download)')
    return
  }

  store.setJob(
    { objectId, provider: 'sketchfab', status: 'running', progress: 0.05, message: `Fetching "${model.name}"…`, startedAt: performance.now() },
    objectId,
  )

  let buf: ArrayBuffer
  try {
    buf = await fetchGlb(model.uid)
  } catch (e) {
    useEditor.getState().setJob(null, objectId)
    useEditor.getState().showToast(`Download failed: ${(e as Error).message}`)
    return
  }

  useEditor.getState().setJob(
    { objectId, provider: 'sketchfab', status: 'running', progress: 0.7, message: 'Fitting to slot…', startedAt: performance.now() },
    objectId,
  )

  new GLTFLoader().parse(
    buf,
    '',
    (gltf) => {
      const feature = buildingFeatures.get(objectId)
      const fitted = feature
        ? fitToSlot(gltf.scene, feature)
        : (() => {
            const ref = getVariant(objectId, useEditor.getState().objects[objectId].asset)
            return ref ? fitToObjectBounds(gltf.scene, ref) : gltf.scene
          })()

      generationCache.set(cacheKey, fitted)
      registerVariant(objectId, key, fitted)
      const s = useEditor.getState()
      s.setJob(null, objectId)
      s.swapAsset(objectId, asset)
      s.select([objectId])
      s.showToast(`Placed "${model.name}" — approve or revert in the Inspector`)
    },
    () => {
      useEditor.getState().setJob(null, objectId)
      useEditor.getState().showToast('Could not parse that model — try another')
    },
  )
}
