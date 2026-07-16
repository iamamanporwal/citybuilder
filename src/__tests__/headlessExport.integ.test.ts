// Headless export integration: the World API / CLI path. Installs the DOM
// shims FIRST (procgen materials draw canvas textures at module load), builds
// the Prague sample scene through the real store, and asserts the export
// bundle produces valid GLBs with real (non-blank, distinct) textures and
// physics extras — the exact seam the Vercel API ships to the game.
import '../headless/shims'

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ResolvedContext } from '../resolver/types'
import { REGION_PACKS, MATRIX_VERSION, CLIMATE_TREES } from '../resolver/matrix'
import { ingestOverpass } from '../ingest/overpass'
import { useEditor } from '../state/store'
import { buildExportBundle } from '../export/bundle'

const praguePath = fileURLToPath(new URL('../../public/data/prague_osm.json', import.meta.url))

function euCentralCtx(): ResolvedContext {
  return {
    matrixVersion: MATRIX_VERSION,
    region: REGION_PACKS['eu-central'],
    climate: 'continental',
    treePool: CLIMATE_TREES.continental,
    treePoolSource: 'climate-default',
    landCoverSource: 'osm-derived',
    landCoverAt: () => 'built',
    zoneAt: () => 'none',
    provenance: [],
  }
}

/** Collect the distinct embedded PNG images inside a GLB (by byte signature). */
function distinctPngs(glb: ArrayBuffer): Set<string> {
  const buf = Buffer.from(glb)
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const end = Buffer.from('IEND')
  const seen = new Set<string>()
  let from = 0
  while (true) {
    const start = buf.indexOf(magic, from)
    if (start < 0) break
    const stop = buf.indexOf(end, start)
    if (stop < 0) break
    seen.add(buf.subarray(start, stop + 8).toString('base64'))
    from = stop + 8
  }
  return seen
}

describe('headless export bundle (Prague sample, shimmed DOM)', () => {
  const raw = JSON.parse(readFileSync(praguePath, 'utf8'))

  it('produces the full 7-file bundle with valid GLBs, distinct textures and drivable surface extras', async () => {
    const graph = ingestOverpass(raw, 'Staré Město, Prague')
    useEditor.getState().initScene(graph, euCentralCtx())
    const bundle = await buildExportBundle()

    const roles = bundle.files.map((f) => f.role).sort()
    expect(roles).toEqual(
      ['collider', 'environment', 'minimap', 'semantics', 'spawn', 'surface', 'textures'].sort(),
    )
    expect(bundle.versions).toEqual({ semantics: 3, collider: 2, spawn: 1 })

    // every GLB is a real binary glTF
    for (const f of bundle.files.filter((f) => f.contentType === 'model/gltf-binary')) {
      const head = Buffer.from(f.data as ArrayBuffer, 0, 4).toString('latin1')
      expect(head, `${f.name} GLB magic`).toBe('glTF')
      expect((f.data as ArrayBuffer).byteLength, `${f.name} size`).toBeGreaterThan(1000)
    }

    // textures actually rendered: multiple DISTINCT embedded images (a broken
    // canvas shim exports N byte-identical blanks — the @napi-rs .data() bug)
    const scene = bundle.files.find((f) => f.role === 'environment')!
    const pngs = distinctPngs(scene.data as ArrayBuffer)
    expect(pngs.size, 'distinct embedded textures in city_scene.glb').toBeGreaterThan(5)

    // surface GLB = drivable subset, smaller than the full collider
    const collider = bundle.files.find((f) => f.role === 'collider')!
    const surface = bundle.files.find((f) => f.role === 'surface')!
    expect((surface.data as ArrayBuffer).byteLength).toBeLessThan((collider.data as ArrayBuffer).byteLength)

    // semantics + spawn parse and carry the contract fields
    const semantics = JSON.parse(bundle.files.find((f) => f.role === 'semantics')!.data as string)
    expect(semantics.semanticsVersion).toBe(3)
    expect(semantics.roads.length).toBeGreaterThan(500)
    expect(semantics.roads[0].centerline[0]).toHaveLength(3)
    const spawn = JSON.parse(bundle.files.find((f) => f.role === 'spawn')!.data as string)
    expect(spawn.spawnVersion).toBe(1)
    expect(spawn.spawn).toBeTruthy()
  }, 60_000)
})
