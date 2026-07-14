import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { ProviderId } from '../types'
import { useEditor } from '../state/store'
import {
  buildingFeatures,
  generationCache,
  registerVariant,
  replaceables,
  variantKey,
} from '../scene/registry'
import { fitToSlot } from '../procgen/buildings'

// The generation gateway (PRD §9): pluggable providers behind one interface.
// Swapping in a real Trellis endpoint or a Meshy key is config, not code.

export interface ProviderDef {
  id: ProviderId
  label: string
  detail: string
  cost: string
  available: boolean
  unavailableReason?: string
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'procedural',
    label: 'Keep procedural',
    detail: 'The default data-driven placeholder. Correct footprint, height and position.',
    cost: 'Free',
    available: true,
  },
  {
    id: 'trellis-local',
    label: 'Generate 3D (Trellis, self-hosted)',
    detail:
      'Image-to-3D from the reference photo, fit to this slot. Simulated locally until a GPU endpoint is configured in Settings.',
    cost: '~¢ / asset',
    available: true,
  },
  {
    id: 'meshy',
    label: 'Meshy (premium API)',
    detail: 'Higher-quality topology & textures for hero assets.',
    cost: '$ / asset',
    available: false,
    unavailableReason: 'Needs a Meshy API key — add one in Settings to enable.',
  },
  {
    id: 'sketchfab',
    label: 'Search Sketchfab library',
    detail:
      'Search millions of licensed 3D models and drop one straight into this slot — no download or generation. Permissive licenses only (CC0 / CC-BY / CC-BY-SA), poly-budgeted, attribution recorded.',
    cost: 'Free',
    available: true,
  },
  {
    id: 'upload',
    label: 'Upload custom model (.glb)',
    detail: 'Drop in your own glTF/GLB. Auto-scaled and grounded to the slot.',
    cost: 'Free',
    available: true,
  },
]

function cacheKeyFor(cacheKeyBase: string, provider: ProviderId): string {
  // identical slots (same base + provider) share one generation (PRD §11.2)
  let h = 2166136261
  const s = `${cacheKeyBase}|${provider}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `gen_${(h >>> 0).toString(36)}`
}

/** Queue an AI generation job for any replaceable slot (simulated Trellis worker). */
export async function runGeneration(objectId: string, provider: ProviderId): Promise<void> {
  const store = useEditor.getState()
  const slot = replaceables.get(objectId)
  if (!slot) {
    store.showToast('This object has no generation slot (buildings & wikidata-linked props only)')
    return
  }
  if (store.jobs[objectId]) return

  const cacheKey = cacheKeyFor(slot.cacheKeyBase, provider)
  const asset = {
    state: 'generated' as const,
    provider,
    license: 'generated-internal (Trellis MIT)',
    approved: false,
    cacheKey,
  }
  const key = variantKey(asset)

  if (generationCache.has(cacheKey)) {
    registerVariant(objectId, key, generationCache.get(cacheKey)!)
    useEditor.getState().swapAsset(objectId, asset)
    useEditor.getState().showToast('Cache hit — swapped instantly (no GPU cost)')
    return
  }

  // The recognizer's descriptor prompt is what a real Trellis/Meshy image-to-3D
  // call is conditioned on (photo + this prompt). Surfaced here so the seam is
  // visible in the simulation and ready for a real endpoint.
  const promptMsg = slot.prompt ? `Generating from: “${slot.prompt}”…` : 'Generating mesh from reference…'
  store.setJob(
    {
      objectId,
      provider,
      status: 'running',
      progress: 0,
      message: promptMsg,
      startedAt: performance.now(),
    },
    objectId,
  )

  // Simulated async GPU worker: progress ticks, then a deterministic result.
  const durationMs = 2600 + Math.random() * 1400
  const started = performance.now()
  await new Promise<void>((resolve) => {
    const tick = () => {
      const p = Math.min((performance.now() - started) / durationMs, 1)
      const s = useEditor.getState()
      if (s.jobs[objectId]) {
        s.setJob(
          {
            ...s.jobs[objectId],
            progress: p,
            message:
              p < 0.4 ? promptMsg : p < 0.8 ? 'Texturing & LODs…' : 'Fitting to slot…',
          },
          objectId,
        )
      }
      if (p >= 1) resolve()
      else requestAnimationFrame(tick)
    }
    tick()
  })

  const result = slot.build()
  generationCache.set(cacheKey, result)
  registerVariant(objectId, key, result)

  const s = useEditor.getState()
  s.setJob(null, objectId)
  s.swapAsset(objectId, asset)
  s.select([objectId])
  s.showToast('Generated result placed — approve or revert in the Inspector')
}

/** Upload a custom .glb/.gltf and fit it into the object's slot. */
export function uploadModel(objectId: string, file: File): void {
  const feature = buildingFeatures.get(objectId)
  const store = useEditor.getState()
  if (!feature) {
    store.showToast('Upload targets a building slot — select a building first')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    new GLTFLoader().parse(
      reader.result as ArrayBuffer,
      '',
      (gltf) => {
        const fitted = fitToSlot(gltf.scene, feature)
        const asset = {
          state: 'uploaded' as const,
          provider: 'upload' as const,
          license: 'user-provided',
          approved: false,
          cacheKey: `up_${file.name}_${file.size}`,
        }
        registerVariant(objectId, variantKey(asset), fitted)
        const s = useEditor.getState()
        s.swapAsset(objectId, asset)
        s.showToast(`"${file.name}" fitted to slot — fine-tune with gizmos`)
      },
      () => store.showToast('Could not parse that file — export as .glb and retry'),
    )
  }
  reader.readAsArrayBuffer(file)
}
