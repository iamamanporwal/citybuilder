import { useEditor } from '../state/store'
import { ingestOverpass } from '../ingest/overpass'
import { resolveContext } from '../resolver/adapters'
import { lintScene } from '../resolver/varietyLint'
import { flickerLint, roadConsistencyLint, waterLint } from '../resolver/lints'
import { loadLibraryTemplates } from '../scene/libraryTemplates'
import { cityGraph, sceneContext } from '../scene/registry'
import type { CityGraph } from '../types'
import {
  cacheCity,
  fetchOsmArea,
  type BBox,
  type CachedCity,
  type FetchOptions,
} from '../ingest/overpassFetch'

// City build orchestration: fetch (or reuse) raw OSM → City Graph → 3D scene.

function firstRunHelp() {
  if (!localStorage.getItem('cb_seen_help')) {
    useEditor.getState().setHelpOpen(true)
    localStorage.setItem('cb_seen_help', '1')
  }
}

async function generateScene(raw: any, name: string) {
  const s = useEditor.getState()
  s.setBuilding('Parsing map data…')
  await new Promise((r) => setTimeout(r, 30))
  const graph = ingestOverpass(raw, name)
  if (graph.buildings.length === 0 && graph.roads.length === 0) {
    throw new Error('No streets or buildings found in this area — try a town or city center.')
  }
  // Context Resolver: region pack, climate, species pools, land-cover/zoning samplers
  const ctx = await resolveContext(graph.bboxLatLng, graph.areas, (m) => s.setBuilding(m))
  // Pre-load library GLB templates for the point kinds present, so the
  // synchronous scene build can place real 3D assets instead of procedural
  // placeholders (falls back per-kind if an asset is missing).
  s.setBuilding('Loading 3D asset library…')
  await loadLibraryTemplates(kindsPresent(graph), useEditor.getState().useLibraryAssets)
  s.setBuilding('Generating roads, buildings & props…')
  await new Promise((r) => setTimeout(r, 60))
  s.initScene(graph, ctx)
  useEditor.getState().setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  firstRunHelp()
}

function kindsPresent(graph: CityGraph) {
  return new Set(graph.points.map((p) => p.kind))
}

/**
 * Toggle library assets on/off and rebuild the current scene in place (reuses
 * the cached City Graph + resolved context — no refetch). Called by the
 * toolbar toggle.
 */
export async function rebuildWithLibraryAssets(enabled: boolean): Promise<void> {
  const s = useEditor.getState()
  s.setUseLibraryAssets(enabled)
  if (!cityGraph || !sceneContext) return
  const graph = cityGraph
  const ctx = sceneContext
  await loadLibraryTemplates(kindsPresent(graph), enabled)
  s.initScene(graph, ctx)
  s.setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  s.showToast(enabled ? 'Library 3D assets placed' : 'Reverted to procedural props')
}

export async function buildCityFromArea(bbox: BBox, name: string, opts: FetchOptions): Promise<void> {
  const s = useEditor.getState()
  try {
    s.setBuilding('Querying OpenStreetMap for your area…')
    const raw = await fetchOsmArea(bbox, opts, (m) => s.setBuilding(m))
    await generateScene(raw, name)
    cacheCity(name, raw)
  } catch (e) {
    s.setLoadError(e instanceof Error ? e.message : String(e))
  }
}

export async function buildSampleCity(): Promise<void> {
  const s = useEditor.getState()
  try {
    s.setBuilding('Loading sample city…')
    const res = await fetch('/data/raw_osm.json')
    if (!res.ok) throw new Error(`Sample data missing (HTTP ${res.status})`)
    const raw = await res.json()
    await generateScene(raw, 'Lower Manhattan, New York')
  } catch (e) {
    s.setLoadError(e instanceof Error ? e.message : String(e))
  }
}

export async function buildFromCache(cached: CachedCity): Promise<void> {
  const s = useEditor.getState()
  try {
    await generateScene(cached.raw, cached.name)
  } catch (e) {
    s.setLoadError(e instanceof Error ? e.message : String(e))
  }
}
