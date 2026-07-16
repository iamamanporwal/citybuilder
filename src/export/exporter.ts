import { useEditor } from '../state/store'
import { buildExportBundle } from './bundle'

// Export (PRD §14, MVP scope): visual GLB + separate lightweight collision GLB
// + the semantic road/provenance data the game runtime consumes. The artifact
// building lives in bundle.ts (shared with the headless API pipeline); this
// module is the browser sink — it turns buffers into file downloads.

function download(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export async function exportCity(): Promise<void> {
  const s = useEditor.getState()
  s.showToast('Exporting… files will download')
  try {
    const bundle = await buildExportBundle()
    if (bundle.warnings.length) {
      s.showToast(
        `Exporting with ${bundle.warnings.length} geometry warning(s) — see Variety/Flicker linter in the Inspector`,
      )
    }
    for (const f of bundle.files) {
      download(new Blob([f.data], { type: f.contentType }), f.name)
    }
    const { stats } = bundle
    useEditor
      .getState()
      .showToast(
        `Export complete: ${bundle.files.length} files. Materials ${stats.materialsBefore}→${stats.materialsAfter}, ` +
          `meshes ${stats.meshesBefore}→${stats.meshesAfter}, collider nodes ${stats.colliderNodes}. ` +
          `Run "npm run bake" to Draco+KTX2 compress.`,
      )
  } catch (e) {
    useEditor.getState().showToast(`Export failed: ${e}`)
  }
}
