#!/usr/bin/env node
// Draco-compress + clean up exported GLBs (game engine review §1: "55 MB files
// choke the dev server / crash mobile VRAM"). The browser GLTFExporter can't emit
// Draco, so this is the Node bake step the pipeline was missing.
//
// Usage:
//   npm run bake                         # bakes ./city_scene.glb + ./city_collision.glb + ./citymap_minimap.glb if present
//   npm run bake -- path/to/a.glb b.glb  # bakes explicit files
//   npm run bake -- --out dist/ *.glb    # write to a directory instead of *.baked.glb
//
// KTX2/Basis texture compression needs the native `toktx` binary and is applied
// by the downstream bake service using textures_manifest.json; this step owns the
// geometry win (Draco), which is the dominant cost for these procedural scenes.

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { dedup, prune, weld, join } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join as pjoin } from 'node:path'

const DEFAULTS = ['city_scene.glb', 'city_collision.glb', 'citymap_minimap.glb']

function parseArgs(argv) {
  const files = []
  let outDir = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = argv[++i]
    else files.push(argv[i])
  }
  return { files, outDir }
}

function fmt(bytes) {
  return `${(bytes / 1_048_576).toFixed(2)} MB`
}

async function main() {
  const { files: argFiles, outDir } = parseArgs(process.argv.slice(2))
  const files = (argFiles.length ? argFiles : DEFAULTS).filter((f) => existsSync(f))
  if (!files.length) {
    console.error('No GLB files found. Pass paths or run in a folder with city_*.glb.')
    process.exit(1)
  }

  // Register ALL extensions so round-tripping preserves KHR_texture_transform
  // (road/facade tiling) and KHR_materials_unlit rather than silently dropping
  // unregistered extensions on read.
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    })

  let totalIn = 0
  let totalOut = 0
  for (const file of files) {
    const isCollider = /colli(der|sion)/i.test(file)
    const inSize = statSync(file).size
    totalIn += inSize

    const doc = await io.read(file)

    // weld is required before Draco (needs shared/indexed vertices). dedup+prune
    // strip duplicate accessors/materials and unused data. join merges compatible
    // meshes to cut draw calls — but it collapses nodes, which would destroy the
    // collider's per-node physics extras, so it runs on the visual scene only.
    const transforms = [weld(), dedup(), prune()]
    if (!isCollider) transforms.push(join())
    await doc.transform(...transforms)

    doc
      .createExtension(KHRDracoMeshCompression)
      .setRequired(true)
      .setEncoderOptions({
        method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
        encodeSpeed: 5,
        decodeSpeed: 5,
      })

    const out = outDir ? pjoin(outDir, basename(file)) : file.replace(/\.glb$/i, '.baked.glb')
    if (outDir && !existsSync(outDir)) {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(outDir, { recursive: true })
    }
    await io.write(out, doc)
    const outSize = statSync(out).size
    totalOut += outSize
    const ratio = inSize > 0 ? (inSize / outSize).toFixed(1) : '—'
    console.log(
      `${basename(file)}  ${fmt(inSize)} → ${fmt(outSize)}  (${ratio}× smaller)  ${isCollider ? '[collider: extras preserved]' : '[scene: joined]'}  → ${out}`,
    )
  }
  console.log(`\nTotal: ${fmt(totalIn)} → ${fmt(totalOut)}  (${(totalIn / totalOut).toFixed(1)}× smaller)`)
  console.log('Next: KTX2/Basis textures via toktx + textures_manifest.json (bake service).')
}

main().catch((e) => {
  console.error('Bake failed:', e)
  process.exit(1)
})
