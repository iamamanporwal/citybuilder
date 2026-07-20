import { useEditor } from '../state/store'
import { ingestOverpass } from '../ingest/overpass'
import { resolveContext } from '../resolver/adapters'
import { lintScene } from '../resolver/varietyLint'
import { flickerLint, geometryLintScene, roadConsistencyLint, waterLint } from '../resolver/lints'
import { buildCollidersFromRegistry } from '../physics/registryColliders'
import { colliderLint } from '../physics/colliderLint'
import type { LintWarning } from '../resolver/varietyLint'
import { loadLibraryTemplates } from '../scene/libraryTemplates'
import { setActiveCuration } from '../resolver/assetPools'
import { activeIdsOf } from '../state/curation'
import { prefetchRecognizerData } from '../recognizer/prepass'
import { cityGraph, sceneContext } from '../scene/registry'
import { scaleRoadNetwork } from '../procgen/roadScale'
import { setTerrainEnabled } from '../procgen/terrain/config'
import { setCrossSectionEnabled } from '../procgen/crossSection'
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

/**
 * Every build/rebuild trigger surfaces the SAME gate: the resolver/variety/water/
 * flicker lints plus the two visibility gates added for the drive preview — the
 * collider audit (phantom/lane-intrusion/orphan/seam) over the exact set the car
 * drives, and the geometry-validity check (bounds/normals/instanced/clip) over
 * the rendered scene. Cheap relative to the initScene rebuild each trigger runs.
 */
function buildGateLints(): LintWarning[] {
  const out = [
    ...roadConsistencyLint(),
    ...flickerLint(),
    ...waterLint(),
    ...lintScene(),
    ...geometryLintScene(),
  ]
  const colliderSet = buildCollidersFromRegistry()
  if (colliderSet && cityGraph) out.push(...colliderLint(cityGraph, colliderSet))
  return out
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
  // Honor the store's terrain toggle on the first build (the module flag defaults
  // off for unit-test isolation; the app default is on via the store).
  setTerrainEnabled(s.useTerrain)
  setCrossSectionEnabled(s.roadCrown)
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
  await loadLibraryTemplates(kindsPresent(graph), applyCurationToResolver())
  perf('loadLibraryTemplates', t)
  s.setBuilding('Generating roads, buildings & props…')
  await new Promise((r) => setTimeout(r, 60))
  pristineGraph = graph
  t = now()
  s.initScene(workingGraph()!, ctx)
  perf('initScene/buildScene', t)
  t = now()
  useEditor.getState().setLintReport(buildGateLints())
  perf('lints', t)
  firstRunHelp()
}

function kindsPresent(graph: CityGraph) {
  return new Set(graph.points.map((p) => p.kind))
}

/**
 * Push the current in-app curation into the resolver's runtime allowlist and
 * return whether any library assets are active. The master `useLibraryAssets`
 * flag gates everything: off → nothing active (all procedural); on → only the
 * enabled kinds' selected model ids are usable. Called before every (re)build.
 */
function applyCurationToResolver(): boolean {
  const s = useEditor.getState()
  const active = s.useLibraryAssets ? activeIdsOf(s.curation) : new Set<string>()
  setActiveCuration(active)
  return active.size > 0
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
  await loadLibraryTemplates(kindsPresent(graph), applyCurationToResolver())
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  s.showToast(enabled ? 'Library 3D assets placed' : 'Reverted to procedural props')
}

/**
 * Commit an edited curation from the Curate studio and rebuild the scene live —
 * no download/re-import. Turns the master switch on when any kind is enabled (off
 * when the user unchecks everything → all procedural).
 */
export async function rebuildWithCuration(curation: import('../state/curation').CurationMap): Promise<void> {
  const s = useEditor.getState()
  s.setCuration(curation)
  s.setUseLibraryAssets(activeIdsOf(curation).size > 0)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  await loadLibraryTemplates(kindsPresent(graph), applyCurationToResolver())
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  const on = activeIdsOf(curation).size > 0
  s.showToast(on ? 'Asset library updated — applied to the map' : 'All kinds procedural')
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
  s.setLintReport(buildGateLints())
  s.showToast(enabled ? 'Network elevation solve on' : 'Reverted to per-segment elevation')
}

/**
 * Switch the road surface style (realistic aggregate ↔ arcade road-kit) and
 * rebuild in place. Roads are cloned per-segment from roadMaterial() at build,
 * so the whole surface set only changes on a rebuild; markings restyle live via
 * the paint-wear uniform. Geometry is untouched (PRD §8: roads stay data-driven).
 */
export async function rebuildWithRoadStyle(style: import('../materials/library').RoadStyle): Promise<void> {
  const s = useEditor.getState()
  s.setRoadStyle(style)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  s.showToast(style === 'arcade' ? 'Arcade road-kit style' : 'Realistic road style')
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
  await loadLibraryTemplates(kindsPresent(graph), applyCurationToResolver())
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  const pct = Math.round(useEditor.getState().roadScale * 100)
  s.showToast(pct === 100 ? 'Roads at original width' : `Roads widened to ${pct}%`)
}

/**
 * Toggle the terrain relief (procgen/terrain) and rebuild the scene in place.
 * The height field is rebuilt and reinstalled at the start of buildScene, so the
 * road-elevation solve, ground, land cover, buildings, props and colliders all
 * re-read it. Flag-off makes the field return 0 everywhere → the flat world.
 */
export async function rebuildWithTerrain(enabled: boolean): Promise<void> {
  const s = useEditor.getState()
  s.setUseTerrain(enabled)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  s.showToast(enabled ? 'Terrain relief on' : 'Flat terrain')
}

export async function rebuildWithRoadCrown(enabled: boolean): Promise<void> {
  const s = useEditor.getState()
  s.setRoadCrown(enabled)
  setCrossSectionEnabled(enabled)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  s.showToast(enabled ? 'Road crown + banking on' : 'Flat carriageways')
}

export async function rebuildWithGreenery(enabled: boolean): Promise<void> {
  const s = useEditor.getState()
  s.setRoadsideGreenery(enabled)
  const graph = workingGraph()
  if (!graph || !sceneContext) return
  s.initScene(graph, sceneContext)
  s.setLintReport(buildGateLints())
  s.showToast(enabled ? 'Roadside greenery on' : 'Roadside greenery off')
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
  await buildBundledSample('/data/raw_osm.json', 'Lower Manhattan, New York')
}

/**
 * Prague, Staré Město — a curated ≤4 km² sample centred on the Old Town so it
 * captures the Vltava, its road bridges and Charles Bridge (the anchor). Region
 * resolves to Czechia (eu-central): right-hand traffic, white centre lines,
 * European crosswalks & signs. Real OSM, prefetched like the Manhattan sample.
 */
export async function buildPragueSample(): Promise<void> {
  await buildBundledSample('/data/prague_osm.json', 'Staré Město, Prague')
}

async function buildBundledSample(url: string, name: string): Promise<void> {
  const s = useEditor.getState()
  try {
    s.setBuilding('Loading sample city…')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Sample data missing (HTTP ${res.status})`)
    const raw = await res.json()
    await generateScene(raw, name)
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
