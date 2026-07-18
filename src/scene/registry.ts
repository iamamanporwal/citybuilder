import * as THREE from 'three'
import type { AssetInfo, BuildingFeature, CityGraph, RoadSegment, SceneObject } from '../types'
import type { BuildingResolution, FacadeSet, ResolvedContext, RoadResolution, RoofSet } from '../resolver/types'
import { resolveRoad } from '../resolver/resolve'
import { buildRoads } from '../procgen/roads'
import { buildEnhancedBuilding, buildProceduralBuilding, fitToSlot, footprintCentroid } from '../procgen/buildings'
import { buildAreas, buildTerrain } from '../procgen/areas'
import { buildFurniture, buildTrafficSignal, buildTrees } from '../procgen/props'
import { buildBarriers, buildBusStop, buildEnhancedProp, buildFountain, buildStatue } from '../procgen/propLibrary'
import { buildGenericSign, buildGiveWaySign, buildSpeedLimitSign, buildStopSign, planSpeedLimitSigns } from '../procgen/signs'
import { curbsideDevicePosition, deviceHeading, nearestRoadInfo } from '../procgen/signMath'
import { buildRoadElevation } from '../procgen/corridor'
import { hash01 } from '../resolver/resolve'
import { drivableRoads } from '../editor/bus'
import { buildingSceneFor, cloneTemplateFor, collectProtectedResources, isLibraryEnabled } from './libraryTemplates'
import { clearRecognizerCache, recognizeBuilding } from '../recognizer/recognizer'
import type { AppearancePlan } from '../recognizer/types'

// Three.js objects live outside React state. The store holds serializable
// SceneObject records; this registry maps object id -> mesh variants.

export const variants = new Map<string, Map<string, THREE.Object3D>>()
export const buildingFeatures = new Map<string, BuildingFeature>()
export const roadSegments = new Map<string, RoadSegment>()
// per-object Context Resolver output (inspector provenance + semantic export)
export const buildingResolutions = new Map<string, BuildingResolution>()
// per-building recognizer appearance plan (descriptor + fallback-chain decision)
export const buildingPlans = new Map<string, AppearancePlan>()
export const roadResolutions = new Map<string, RoadResolution>()
export let sceneContext: ResolvedContext | null = null
// the ingested City Graph for the current scene (lints audit it post-build)
export let cityGraph: CityGraph | null = null
// generation cache: cacheKey -> variant key that holds the result (PRD §11.2)
export const generationCache = new Map<string, THREE.Object3D>()
// objects with a generation slot (buildings + wikidata-linked props). The
// gateway consults this instead of hardcoding "buildings only". Buildings also
// carry the recognizer's prompt/descriptor so a real Trellis/Meshy call (and
// the simulation) can be driven by the recognized appearance.
export const replaceables = new Map<
  string,
  {
    cacheKeyBase: string
    build: () => THREE.Object3D
    prompt?: string
    descriptor?: import('../recognizer/types').BuildingDescriptor
  }
>()

export function variantKey(asset: AssetInfo): string {
  return `${asset.state}:${asset.provider ?? 'none'}:${asset.cacheKey ?? ''}`
}

export function registerVariant(id: string, key: string, obj: THREE.Object3D) {
  if (!variants.has(id)) variants.set(id, new Map())
  variants.get(id)!.set(key, obj)
}

export function getVariant(id: string, asset: AssetInfo): THREE.Object3D | undefined {
  return variants.get(id)?.get(variantKey(asset))
}

export interface BuildingMaterial { facade: FacadeSet; roof: RoofSet; tint: string }

/** The editable material of a procedural building (null if not a known building). */
export function currentBuildingMaterial(id: string): BuildingMaterial | null {
  const r = buildingResolutions.get(id)
  return r ? { facade: r.facade, roof: r.roof, tint: r.tint } : null
}

/**
 * Re-skin a procedural building in place: patch its BuildingResolution's facade /
 * roof / tint, rebuild just that mesh, and swap the variant. Returns false for
 * buildings that aren't procedural-facade (library/generated GLBs carry their own
 * materials and aren't re-skinnable this way). The old geometry is disposed.
 */
export function applyBuildingMaterial(id: string, mat: BuildingMaterial, asset: AssetInfo): boolean {
  const b = buildingFeatures.get(id)
  const res = buildingResolutions.get(id)
  const plan = buildingPlans.get(id)
  if (!b || !res || !plan) return false
  const newRes: BuildingResolution = { ...res, facade: mat.facade, roof: mat.roof, tint: mat.tint }
  buildingResolutions.set(id, newRes)
  const key = variantKey(asset)
  const old = variants.get(id)?.get(key)
  const mesh = buildProceduralBuilding(b, newRes, plan.roofForm)
  mesh.name = b.name ?? 'Building'
  mesh.userData.objectId = id
  registerVariant(id, key, mesh)
  if (old && old !== mesh)
    old.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
  return true
}

function mapUrls(lat: number, lng: number) {
  return {
    mapUrl: `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`,
    streetViewUrl: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`,
  }
}

const PROC_ASSET: AssetInfo = {
  state: 'procedural',
  provider: 'procedural',
  license: 'generated-internal',
  approved: true,
}

const IDENTITY = {
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
}

const NON_DRIVE = new Set(['pedestrian', 'service', 'footway', 'cycleway'])

/** Collect every geometry/material reachable from the given variant map. */
function collectResources(
  source: Map<string, Map<string, THREE.Object3D>>,
  geoms: Set<THREE.BufferGeometry>,
  mats: Set<THREE.Material>,
) {
  for (const m of source.values())
    for (const obj of m.values())
      obj.traverse((n) => {
        const mesh = n as THREE.Mesh
        if (mesh.geometry) geoms.add(mesh.geometry)
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((x) => mats.add(x))
        else if (mat) mats.add(mat)
      })
}

/**
 * Free GPU resources orphaned by a rebuild. Safe by construction: we dispose a
 * geometry/material from the OLD scene only if the freshly built NEW scene does
 * not reference it AND it isn't owned by a persistent library template / cached
 * generation. Reused module-singletons (procedural textures, shared materials)
 * therefore survive automatically because they reappear in `newGeoms/newMats`.
 * Textures are intentionally left alone — they are shared singletons whose
 * lifetime we don't track, and a stale material's map is cheap to keep.
 */
function disposeOrphaned(oldGeoms: Set<THREE.BufferGeometry>, oldMats: Set<THREE.Material>) {
  const keepGeoms = new Set<THREE.BufferGeometry>()
  const keepMats = new Set<THREE.Material>()
  collectResources(variants, keepGeoms, keepMats)
  for (const o of generationCache.values())
    o.traverse((n) => {
      const mesh = n as THREE.Mesh
      if (mesh.geometry) keepGeoms.add(mesh.geometry)
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((x) => keepMats.add(x))
      else if (mat) keepMats.add(mat)
    })
  collectProtectedResources(keepGeoms, keepMats)
  let freed = 0
  for (const g of oldGeoms) if (!keepGeoms.has(g)) { g.dispose(); freed++ }
  for (const m of oldMats) if (!keepMats.has(m)) m.dispose()
  return freed
}

/** Build the full base scene from the City Graph. Fills registries, returns object records. */
export function buildScene(graph: CityGraph, ctx: ResolvedContext): SceneObject[] {
  // Snapshot the outgoing scene's GPU resources so we can free the ones the new
  // build orphans (fixes a per-rebuild leak: the registry was cleared but never
  // disposed). Disposal happens at the end, after the new scene exists.
  const oldGeoms = new Set<THREE.BufferGeometry>()
  const oldMats = new Set<THREE.Material>()
  collectResources(variants, oldGeoms, oldMats)

  variants.clear()
  buildingFeatures.clear()
  roadSegments.clear()
  buildingResolutions.clear()
  buildingPlans.clear()
  clearRecognizerCache()
  roadResolutions.clear()
  replaceables.clear()
  sceneContext = ctx
  cityGraph = graph
  drivableRoads.length = 0
  for (const r of graph.roads) {
    if (!NON_DRIVE.has(r.roadClass) && !r.tunnel && !r.bridge) {
      drivableRoads.push({ pts: r.points, width: r.widthM })
    }
  }
  const objects: SceneObject[] = []

  const add = (
    rec: Omit<SceneObject, 'deleted' | 'visible'> & { visible?: boolean },
    obj: THREE.Object3D,
  ) => {
    obj.userData.objectId = rec.id
    registerVariant(rec.id, variantKey(rec.asset), obj)
    objects.push({ deleted: false, visible: true, ...rec })
  }

  // ---- terrain: land-default ground with water carved out as real holes
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const r of graph.roads) for (const p of r.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  if (!isFinite(minX)) { minX = -500; maxX = 500; minZ = -500; maxZ = 500 }
  const pad = 120
  const bounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }
  const terrain = buildTerrain(graph.areas.filter((a) => a.kind === 'water'), bounds)
  add(
    {
      id: 'terrain_ground', type: 'ground', name: 'Ground', locked: true,
      transform: { position: [0, 0, 0], ...IDENTITY },
      asset: { ...PROC_ASSET }, meta: { 'water holes carved': terrain.carvedCount },
    },
    terrain.ground,
  )
  if (terrain.water) {
    add(
      {
        id: 'areas_water', type: 'area', name: 'Water', locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET },
        meta: { 'land cover': 'water', carved: terrain.carvedCount, painted: terrain.paintedCount },
      },
      terrain.water,
    )
  }

  // ---- rendered land cover (parks, grass, sand, forest floor)
  for (const { kind, mesh } of buildAreas(graph.areas)) {
    const id = `areas_${kind}`
    mesh.userData.objectId = id
    add(
      {
        id, type: 'area', name: mesh.name, locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET }, meta: { 'land cover': kind },
      },
      mesh,
    )
  }

  // ---- roads (locked, per-segment) — surfaces/markings resolved per segment
  for (const r of graph.roads) roadResolutions.set(r.id, resolveRoad(r, ctx))
  const roadResult = buildRoads(graph, ctx, roadResolutions)
  for (const r of graph.roads) {
    const mesh = roadResult.roadMeshes.get(r.id)
    if (!mesh) continue
    roadSegments.set(r.id, r)
    const res = roadResolutions.get(r.id)!
    add(
      {
        id: r.id, type: 'road',
        name: r.name ?? `${r.roadClass} road`,
        locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET },
        realworld: { lat: r.centerLat, lng: r.centerLng, ...mapUrls(r.centerLat, r.centerLng) },
        meta: {
          class: r.roadClass, 'width (m)': Math.round(r.widthM * 10) / 10,
          lanes: r.lanes, oneway: r.oneway,
          surface: res.surface,
          bridge: r.bridge || undefined, tunnel: r.tunnel || undefined,
          layer: r.layer !== 0 ? r.layer : undefined,
        },
      },
      mesh,
    )
  }
  const networkParts: [string, string, SceneObject['type'], THREE.Object3D | null][] = [
    ['net_intersections', 'Intersections', 'markings', roadResult.intersections],
    ['net_sidewalks', 'Sidewalks & curbs', 'sidewalks', roadResult.sidewalks],
    ['net_markings', 'Lane markings (white)', 'markings', roadResult.markings],
    ['net_markings_yellow', 'Lane markings (yellow)', 'markings', roadResult.markingsYellow],
    ['net_decals', 'Surface decals', 'markings', roadResult.decals],
    ['net_bridges', 'Bridge structures', 'bridge-structure', roadResult.bridges],
    ['net_portals', 'Tunnel portals', 'bridge-structure', roadResult.portals],
  ]
  for (const [id, name, type, obj] of networkParts) {
    if (!obj) continue
    add(
      {
        id, type, name, locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET }, meta: {},
      },
      obj,
    )
  }

  // ---- landmark bridges (Golden Gate & co): recognizable suspension structures,
  // selectable and Sketchfab-replaceable (unlike the merged generic bridge blob)
  for (const lb of roadResult.landmarkBridges) {
    lb.group.traverse((o) => (o.userData.objectId = lb.id))
    replaceables.set(lb.id, {
      cacheKeyBase: `landmark|${lb.id}`,
      build: () => lb.group.clone(),
    })
    add(
      {
        id: lb.id, type: 'bridge-structure', name: lb.name, tier: 'landmark', locked: false,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET },
        realworld: { lat: lb.centerLat, lng: lb.centerLng, ...mapUrls(lb.centerLat, lb.centerLng), wikidata: lb.wikidata, name: lb.name },
        meta: { landmark: true, structure: lb.structure, 'replace search': lb.sketchfabQuery },
      },
      lb.group,
    )
  }

  // ---- buildings (the upgradeable 95%) — the Building Recognizer decides how
  // each one looks and which source fills its slot (PRD §7F). The descriptor
  // drives the procedural facade + roof form; the local asset library is one
  // branch of the fallback chain, behind the (default-OFF) feature flag.
  const libraryEnabled = isLibraryEnabled()
  for (const b of graph.buildings) {
    buildingFeatures.set(b.id, b)
    const plan = recognizeBuilding(b, ctx, { libraryEnabled })
    buildingPlans.set(b.id, plan)
    // buildingResolutions holds the recognizer's final resolution so lints,
    // the inspector provenance and semantics export all reflect its decision.
    buildingResolutions.set(b.id, plan.resolution)
    const fp = b.footprint.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(';')
    replaceables.set(b.id, {
      // descriptor style folded into the cache base: two visually-different
      // recognitions of the same footprint cache as distinct generations.
      cacheKeyBase: `${fp}|${b.heightM.toFixed(1)}|${plan.descriptor.style}`,
      prompt: plan.generationPrompt,
      descriptor: plan.descriptor,
      build: () => buildEnhancedBuilding(b, plan.resolution),
    })
    // fallback chain, build-time branch: a library GLB fitted to the footprint
    // (only when the flag is on AND the plan chose it), else the descriptor-
    // driven procedural mass with its roof-form cap.
    const libScene = plan.buildPath === 'library-match' ? buildingSceneFor(b) : null
    // fitToSlot returns null for a degenerate GLB → fall back to procedural (so the
    // building never vanishes when the library toggle is on).
    const fitted = libScene ? fitToSlot(libScene, b) : null
    const mesh = fitted ?? buildProceduralBuilding(b, plan.resolution, plan.roofForm)
    if (fitted) { fitted.name = b.name ?? 'Building'; fitted.userData.objectId = b.id }
    const c = footprintCentroid(b.footprint)
    add(
      {
        id: b.id, type: 'building',
        name: b.name ?? `Building ${b.id.slice(4, 10)}`,
        tier: b.tier, locked: false,
        transform: { position: [c.x, 0, c.z], ...IDENTITY },
        asset: { ...PROC_ASSET },
        realworld: {
          lat: b.lat, lng: b.lng, ...mapUrls(b.lat, b.lng),
          wikidata: b.wikidata, name: b.name,
        },
        meta: {
          'height (m)': Math.round(b.heightM * 10) / 10,
          levels: b.levels,
          'height source': b.heightSource,
          'building type': b.tags.building !== 'yes' ? b.tags.building : undefined,
          address: b.tags['addr:housenumber']
            ? `${b.tags['addr:housenumber']} ${b.tags['addr:street'] ?? ''}`.trim()
            : undefined,
          style: plan.descriptor.style,
          facade: plan.facade,
          roof: plan.roof,
          'roof form': plan.roofForm !== 'flat' ? plan.roofForm : undefined,
          model: libScene ? 'library 3D asset' : 'recognizer facade',
        },
      },
      mesh,
    )
  }

  // ---- street furniture: signals + regulatory signs + common props (movable)
  const PROP_BUILDERS: Partial<Record<typeof graph.points[number]['kind'], (p: (typeof graph.points)[number]) => THREE.Object3D>> = {
    traffic_signal: buildTrafficSignal,
    fountain: buildFountain,
    statue: buildStatue,
    bus_stop: buildBusStop,
    // FAITHFUL regulatory signs (Road-updates.md §8.1). crossing has no prop —
    // it exports to semantics and future surface crosswalks, not a post.
    stop_sign: buildStopSign,
    give_way: buildGiveWaySign,
    road_sign: buildGenericSign,
  }
  // Devices that must face the road grid rather than a fixed world axis: signal
  // heads align WITH travel; signs turn to CONFRONT the approaching driver (§8.1).
  const ORIENTED: Partial<Record<typeof graph.points[number]['kind'], boolean>> = {
    traffic_signal: false, // align with travel
    stop_sign: true, // face oncoming
    give_way: true,
    road_sign: true,
  }
  const LABELS: Partial<Record<typeof graph.points[number]['kind'], string>> = {
    traffic_signal: 'Traffic signal',
    fountain: 'Fountain',
    bus_stop: 'Bus stop',
    stop_sign: 'Stop sign',
    give_way: 'Give way',
    road_sign: 'Road sign',
  }
  // devices ride the solved road elevation (a signal on a bridge approach must
  // stand on the ramp, not float at grade under it) — memoised per roads array
  const deviceElevation = buildRoadElevation(graph.roads)
  for (const p of graph.points) {
    const builder = PROP_BUILDERS[p.kind]
    if (!builder) continue
    // library GLB variant for this feature if pooled + loaded, else the procedural
    // builder (per-feature pick → variety across signals/bus-stops/fountains/statues)
    const libG = cloneTemplateFor(p.kind, p.id)
    const g = libG ?? builder(p)
    // OSM maps traffic devices ON the highway way — move them to the curb and
    // onto the road's solved elevation (§8.1); other props keep their position.
    let pos: { x: number; z: number } = p.position
    let posY = 0
    let rotY = 0
    if (p.kind in ORIENTED) {
      const near = nearestRoadInfo(p.position, graph.roads)
      pos = curbsideDevicePosition(p.position, near, ctx.region.drivingSide)
      if (near?.road && near.dist <= near.road.widthM / 2 + 8) {
        const e = deviceElevation.profileFor(near.road, [near.station ?? 0])[0] ?? 0
        posY = Math.abs(e) > 1e-6 ? e : 0
      }
      rotY = deviceHeading(near, ORIENTED[p.kind]!)
      g.rotation.y = rotY
    }
    g.position.set(pos.x, posY, pos.z)
    const label = LABELS[p.kind] ?? 'Statue / memorial'
    // wikidata-linked landmarks route to AI generation via the gateway
    if (p.wikidata && (p.kind === 'statue' || p.kind === 'fountain')) {
      replaceables.set(p.id, {
        cacheKeyBase: `prop|${p.kind}|${hash01(p.id).toFixed(6)}`,
        build: () => buildEnhancedProp(p),
      })
    }
    add(
      {
        id: p.id,
        type: p.kind === 'traffic_signal' ? 'traffic-signal' : 'street-furniture',
        name: p.name ?? label,
        tier: p.wikidata ? 'notable' : undefined,
        locked: false,
        transform: { position: [pos.x, posY, pos.z], rotation: [0, rotY, 0], scale: [1, 1, 1] },
        asset: { ...PROC_ASSET },
        realworld: { lat: p.lat, lng: p.lng, ...mapUrls(p.lat, p.lng), wikidata: p.wikidata, name: p.name },
        meta: { kind: p.kind !== 'traffic_signal' ? p.kind : undefined, signType: p.signType },
      },
      g,
    )
  }

  // ---- speed-limit signs placed from tagged road maxspeed (faithful only),
  // region-keyed face + unit, on the driving side, facing oncoming traffic (§8.4).
  for (const sp of planSpeedLimitSigns(graph.roads, ctx)) {
    const g = buildSpeedLimitSign(sp.display, sp.unit, sp.style)
    g.position.set(sp.position.x, sp.y, sp.position.z)
    g.rotation.y = sp.headingY
    add(
      {
        id: sp.id,
        type: 'street-furniture',
        name: g.name,
        locked: false,
        transform: { position: [sp.position.x, sp.y, sp.position.z], rotation: [0, sp.headingY, 0], scale: [1, 1, 1] },
        asset: { ...PROC_ASSET },
        realworld: { lat: sp.lat, lng: sp.lng, ...mapUrls(sp.lat, sp.lng), name: g.name },
        meta: { kind: 'speed_limit', speedKmh: sp.kmh, display: `${sp.display} ${sp.unit}`, roadId: sp.roadId },
      },
      g,
    )
  }

  // ---- fences & walls (merged, locked)
  const barrierMesh = buildBarriers(graph.barriers)
  if (barrierMesh) {
    add(
      {
        id: 'net_barriers', type: 'street-furniture', name: barrierMesh.name, locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET }, meta: { count: graph.barriers.length },
      },
      barrierMesh,
    )
  }

  // ---- vegetation: multi-species instanced pools (GBIF/climate mix)
  const trees = graph.points.filter((p) => p.kind === 'tree')
  if (trees.length) {
    const g = buildTrees(trees, ctx)
    add(
      {
        id: 'veg_trees', type: 'vegetation', name: `Street trees (${trees.length})`,
        locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET },
        meta: { count: trees.length, 'species source': ctx.treePoolSource },
      },
      g,
    )
  }

  // ---- zoning-aware street furniture (lamps, benches, bins, signs)
  const furniture = buildFurniture(graph, ctx)
  if (furniture.children.length) {
    const counts = furniture.userData.counts ?? {}
    add(
      {
        id: 'furn_all', type: 'street-furniture', name: 'Street furniture',
        locked: true,
        transform: { position: [0, 0, 0], ...IDENTITY },
        asset: { ...PROC_ASSET },
        meta: { streetlights: counts.lamps, benches: counts.benches, bins: counts.bins, signs: counts.signs, 'lamp style': ctx.region.lampStyle },
      },
      furniture,
    )
  }

  disposeOrphaned(oldGeoms, oldMats)
  return objects
}
