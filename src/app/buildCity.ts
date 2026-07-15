import { useEditor } from '../state/store'
import { ingestOverpass } from '../ingest/overpass'
import { resolveContext } from '../resolver/adapters'
import { lintScene } from '../resolver/varietyLint'
import { flickerLint, roadConsistencyLint, waterLint } from '../resolver/lints'
import { loadLibraryTemplates } from '../scene/libraryTemplates'
import { prefetchRecognizerData } from '../recognizer/prepass'
import { sceneContext } from '../scene/registry'
import { scaleRoadNetwork } from '../procgen/roadScale'
import type { CityGraph } from '../types'
import {
  cacheCity,
  fetchOsmArea,
  type BBox,
  type CachedCity,
  type FetchOptions,
} from '../ingest/overpassFetch'

// City build orchestration: fetch (or reuse) raw OSM → City Graph → 3D scene.

// The pristine, un-scaled City Graph straight from ingest. Every rebuild path
// (library assets, corridor elevation, road width) derives its working graph
// from this, so the toggles COMPOSE and road-width scaling never compounds.
let pristineGraph: CityGraph | null = null

/** Current working graph = pristine with the active road-width scale applied. */
function workingGraph(): CityGraph | null {
  if (!pristineGraph) return null
  return scaleRoadNetwork(pristineGraph, useEditor.getState().roadScale)
}

function firstRunHelp() {
  if (!localStorage.getItem('cb_seen_help')) {
    useEditor.getState().setHelpOpen(true)
    localStorage.setItem('cb_seen_help', '1')
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const perf = (label: string, t0: number) => {
  if (import.meta.env?.DEV) console.info(`[perf] ${label}: ${Math.round(now() - t0)} ms`)
}

async function generateScene(raw: any, name: string) {
  const s = useEditor.getState()
  s.setBuilding('Parsing map data…')
  await new Promise((r) => setTimeout(r, 30))
  let t = now()
  const graph = ingestOverpass(raw, name)
  perf(`ingest (${raw?.elements?.length ?? 0} elements → ${graph.buildings.length} buildings, ${graph.roads.length} roads)`, t)
  if (graph.buildings.length === 0 && graph.roads.length === 0) {
    throw new Error('No streets or buildings found in this area — try a town or city center.')
  }
  // Context Resolver (region/climate/species/land-cover) and the recognizer
  // Wikidata prepass are independent — run them concurrently so their network
  // latencies overlap instead of adding up.
  t = now()
  const [ctx] = await Promise.all([
    resolveContext(graph.bboxLatLng, graph.areas, (m) => s.setBuilding(m)),
    prefetchRecognizerData(graph.buildings),
  ])
  perf('context + recognizer prepass (parallel)', t)
  // Pre-load library GLB templates for the point kinds present, so the
  // synchronous scene build can place real 3D assets instead of procedural
  // placeholders (falls back per-kind if an asset is missing).
  s.setBuilding('Loading 3D asset library…')
  t = now()
  await loadLibraryTemplates(kindsPresent(graph), useEditor.getState().useLibraryAssets)
  perf('loadLibraryTemplates', t)
  s.setBuilding('Generating roads, buildings & props…')
  await new Promise((r) => setTimeout(r, 60))
  pristineGraph = graph
  t = now()
  s.initScene(workingGraph()!, ctx)
  perf('initScene/buildScene', t)
  t = now()
  useEditor.getState().setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  perf('lints', t)
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
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  await loadLibraryTemplates(kindsPresent(graph), enabled)
  s.initScene(graph, sceneContext)
  s.setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  s.showToast(enabled ? 'Library 3D assets placed' : 'Reverted to procedural props')
}

/**
 * Toggle the network elevation solve (Road Corridor Redesign §6a) and rebuild
 * the current scene in place. Roads, colliders and semantics all re-read the
 * elevation seam, so a flip re-solves the whole network's y-channel.
 */
export async function rebuildWithCorridorElevation(enabled: boolean): Promise<void> {
  const s = useEditor.getState()
  s.setUseCorridorElevation(enabled)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  s.initScene(graph, sceneContext)
  s.setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  s.showToast(enabled ? 'Network elevation solve on' : 'Reverted to per-segment elevation')
}

/**
 * Set the road-width multiplier (car-game "stretch roads" trigger, §14) and
 * rebuild the current scene in place. Widens drivable carriageways and displaces
 * non-road features out of the widened corridors — roads, colliders, semantics
 * and the drive preview all re-read the scaled graph.
 */
export async function rebuildWithRoadScale(factor: number): Promise<void> {
  const s = useEditor.getState()
  s.setRoadScale(factor)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  await loadLibraryTemplates(kindsPresent(graph), s.useLibraryAssets)
  s.initScene(graph, sceneContext)
  s.setLintReport([...roadConsistencyLint(), ...flickerLint(), ...waterLint(), ...lintScene()])
  const pct = Math.round(useEditor.getState().roadScale * 100)
  s.showToast(pct === 100 ? 'Roads at original width' : `Roads widened to ${pct}%`)
}

export async function buildCityFromArea(bbox: BBox, name: string, opts: FetchOptions): Promise<void> {
  const s = useEditor.getState()
  try {
    s.setBuilding('Querying OpenStreetMap for your area…')
    const tFetch = now()
    const raw = await fetchOsmArea(bbox, opts, (m) => s.setBuilding(m))
    perf('fetchOsmArea (network)', tFetch)
    const tGen = now()
    await generateScene(raw, name)
    perf('generateScene (total)', tGen)
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
