import * as THREE from 'three'
import type { AssetInfo, BuildingFeature, CityGraph, RoadSegment, SceneObject } from '../types'
import type { BuildingResolution, ResolvedContext, RoadResolution } from '../resolver/types'
import { resolveBuilding, resolveRoad } from '../resolver/resolve'
import { buildRoads } from '../procgen/roads'
import { buildEnhancedBuilding, buildProceduralBuilding, footprintCentroid } from '../procgen/buildings'
import { buildAreas, buildTerrain } from '../procgen/areas'
import { buildFurniture, buildTrafficSignal, buildTrees } from '../procgen/props'
import { buildBarriers, buildBusStop, buildEnhancedProp, buildFountain, buildStatue } from '../procgen/propLibrary'
import { hash01 } from '../resolver/resolve'
import { drivableRoads } from '../editor/bus'

// Three.js objects live outside React state. The store holds serializable
// SceneObject records; this registry maps object id -> mesh variants.

export const variants = new Map<string, Map<string, THREE.Object3D>>()
export const buildingFeatures = new Map<string, BuildingFeature>()
export const roadSegments = new Map<string, RoadSegment>()
// per-object Context Resolver output (inspector provenance + semantic export)
export const buildingResolutions = new Map<string, BuildingResolution>()
export const roadResolutions = new Map<string, RoadResolution>()
export let sceneContext: ResolvedContext | null = null
// the ingested City Graph for the current scene (lints audit it post-build)
export let cityGraph: CityGraph | null = null
// generation cache: cacheKey -> variant key that holds the result (PRD §11.2)
export const generationCache = new Map<string, THREE.Object3D>()
// objects with a generation slot (buildings + wikidata-linked props). The
// gateway consults this instead of hardcoding "buildings only".
export const replaceables = new Map<string, { cacheKeyBase: string; build: () => THREE.Object3D }>()

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

/** Build the full base scene from the City Graph. Fills registries, returns object records. */
export function buildScene(graph: CityGraph, ctx: ResolvedContext): SceneObject[] {
  variants.clear()
  buildingFeatures.clear()
  roadSegments.clear()
  buildingResolutions.clear()
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

  // ---- buildings (the upgradeable 95%) — facade/roof sets from the resolver
  for (const b of graph.buildings) {
    buildingFeatures.set(b.id, b)
    const res = resolveBuilding(b, ctx)
    buildingResolutions.set(b.id, res)
    const fp = b.footprint.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(';')
    replaceables.set(b.id, {
      cacheKeyBase: `${fp}|${b.heightM.toFixed(1)}`,
      build: () => buildEnhancedBuilding(b, res),
    })
    const mesh = buildProceduralBuilding(b, res)
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
          facade: res.facade,
          roof: res.roof,
        },
      },
      mesh,
    )
  }

  // ---- street furniture: signals + common props (movable, selectable)
  const PROP_BUILDERS: Partial<Record<typeof graph.points[number]['kind'], (p: (typeof graph.points)[number]) => THREE.Object3D>> = {
    traffic_signal: buildTrafficSignal,
    fountain: buildFountain,
    statue: buildStatue,
    bus_stop: buildBusStop,
  }
  for (const p of graph.points) {
    const builder = PROP_BUILDERS[p.kind]
    if (!builder) continue
    const g = builder(p)
    g.position.set(p.position.x, 0, p.position.z)
    const label =
      p.kind === 'traffic_signal' ? 'Traffic signal'
      : p.kind === 'fountain' ? 'Fountain'
      : p.kind === 'bus_stop' ? 'Bus stop'
      : 'Statue / memorial'
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
        transform: { position: [p.position.x, 0, p.position.z], ...IDENTITY },
        asset: { ...PROC_ASSET },
        realworld: { lat: p.lat, lng: p.lng, ...mapUrls(p.lat, p.lng), wikidata: p.wikidata, name: p.name },
        meta: { kind: p.kind !== 'traffic_signal' ? p.kind : undefined },
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

  return objects
}
