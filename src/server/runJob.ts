// The generation worker: runs the headless pipeline, uploads artifacts to
// Blob, writes the manifest last (its existence IS the "ready" signal).

import { generateCity } from '../headless/generate'
import { bakeBundle } from '../headless/bake'
import {
  CONTRACT,
  MANIFEST_VERSION,
  failedPath,
  manifestPath,
  putFile,
  putJson,
  type MapRequest,
} from './world'

// The scene build writes module-level registries (scene/registry.ts), so two
// generations must never interleave inside one warm instance. Serialize them.
let chain: Promise<unknown> = Promise.resolve()

export function runJob(id: string, req: MapRequest): Promise<void> {
  const run = chain.then(() => generateAndUpload(id, req)).catch(async (e) => {
    await putJson(failedPath(id), {
      error: e instanceof Error ? e.message : String(e),
      failedAt: new Date().toISOString(),
    }).catch(() => {})
  })
  chain = run
  return run
}

async function generateAndUpload(id: string, req: MapRequest): Promise<void> {
  let bundle = await generateCity({
    bbox: req.bbox,
    name: req.name ?? `bbox ${req.bbox.south.toFixed(4)},${req.bbox.west.toFixed(4)}`,
    trees: req.options.trees,
    signals: req.options.signals,
    roadScale: req.options.roadScale,
    corridorElevation: req.options.corridorElevation,
    framedRoads: req.options.framedRoads,
    onProgress: (m) => console.log(`[world-api ${id}] ${m}`),
  })
  if (req.options.bake) {
    console.log(`[world-api ${id}] Draco-compressing…`)
    bundle = await bakeBundle(bundle)
  }

  const files: Record<string, { url: string; file: string; bytes: number; contentType: string }> = {}
  for (const f of bundle.files) {
    const bytes = typeof f.data === 'string' ? Buffer.byteLength(f.data) : f.data.byteLength
    const url = await putFile(`maps/${id}/${f.name}`, f.data, f.contentType)
    files[f.role] = { url, file: f.name, bytes, contentType: f.contentType }
    console.log(`[world-api ${id}] uploaded ${f.name} (${(bytes / 1_048_576).toFixed(2)} MB)`)
  }

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    contract: CONTRACT,
    id,
    generator: 'CityBuilder World API',
    city: bundle.city,
    attribution: bundle.attribution,
    bbox: req.bbox,
    options: req.options,
    versions: bundle.versions,
    bounds: bundle.bounds,
    baked: req.options.bake,
    coordinateSystem: { up: 'Y', units: 'meters', scale: 1 },
    files,
    warnings: bundle.warnings.map((w) => w.message),
    generatedAt: new Date().toISOString(),
  }
  // manifest goes up last — its existence flips the job to "ready"
  await putJson(manifestPath(id), manifest)
  console.log(`[world-api ${id}] ready`)
}
