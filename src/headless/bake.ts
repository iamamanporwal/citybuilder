// In-process Draco bake for headless exports — same transform chain as
// tools/bake-glb.mjs (weld → dedup → prune → join-visual-only → Draco), but
// operating on in-memory buffers so the API can bake before uploading.
// KTX2/Basis texture compression still belongs to the downstream bake service
// (needs the native toktx binary); Draco is the dominant win for these
// procedural scenes.

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { dedup, prune, weld, join } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import type { ExportBundle, ExportFile } from '../export/bundle'

let ioPromise: Promise<NodeIO> | null = null

function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () =>
    new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    }))()
  return ioPromise
}

/**
 * Draco-compress one GLB buffer. `joinMeshes` merges compatible meshes to cut
 * draw calls — visual scene only; joining collapses nodes, which would destroy
 * the collider/surface per-node physics extras.
 */
export async function bakeGlb(data: Uint8Array, joinMeshes: boolean): Promise<Uint8Array> {
  const io = await getIO()
  const doc = await io.readBinary(data)
  const transforms = [weld(), dedup(), prune()]
  if (joinMeshes) transforms.push(join())
  await doc.transform(...transforms)
  doc
    .createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
    })
  return io.writeBinary(doc)
}

/** Bake every GLB in the bundle in place (JSON files pass through untouched). */
export async function bakeBundle(bundle: ExportBundle): Promise<ExportBundle> {
  const files: ExportFile[] = []
  for (const f of bundle.files) {
    if (f.contentType !== 'model/gltf-binary') {
      files.push(f)
      continue
    }
    const preservesExtras = f.role === 'collider' || f.role === 'surface'
    const baked = await bakeGlb(new Uint8Array(f.data as ArrayBuffer), !preservesExtras)
    files.push({ ...f, data: baked.buffer.slice(baked.byteOffset, baked.byteOffset + baked.byteLength) as ArrayBuffer })
  }
  return { ...bundle, files }
}
