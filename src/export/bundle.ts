import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { useEditor } from '../state/store'
import {
  buildingResolutions,
  cityGraph,
  getVariant,
  roadResolutions,
  roadSegments,
  sceneContext,
} from '../scene/registry'
import { buildTextureManifest } from '../materials/packaging'
import { buildCollidersFromRegistry } from '../physics/registryColliders'
import { colliderLint } from '../physics/colliderLint'
import { flickerLint, roadConsistencyLint, waterLint } from '../resolver/lints'
import type { ColliderSet } from '../physics/types'
import { colliderGroupMerged } from './colliderGlb'
import { buildRoadSemantics, buildTrafficAudit, buildTrafficDevices } from './semantics'
import type { SceneObject } from '../types'
import { optimizeSceneForExport } from './optimizeScene'
import { buildMinimapGroup, deriveSpawn } from './spawn'
import type { LintWarning } from '../resolver/varietyLint'

// Environment-agnostic export: builds every export artifact as an in-memory
// buffer. The browser exporter (exporter.ts) downloads these; the headless
// pipeline (src/headless) writes them to disk or uploads them to blob storage.
// One code path, two sinks — so the API serves byte-identical files to the
// in-app export.

/** Role names align with the game runtime's conform set (*_environment /
 *  *_surface / *_collider / *_minimap + JSON sidecars). */
export type ExportRole =
  | 'environment'
  | 'collider'
  | 'surface'
  | 'minimap'
  | 'semantics'
  | 'spawn'
  | 'textures'

export interface ExportFile {
  name: string
  role: ExportRole
  contentType: string
  data: ArrayBuffer | string
}

export interface ExportBundle {
  files: ExportFile[]
  warnings: LintWarning[]
  stats: {
    materialsBefore: number
    materialsAfter: number
    meshesBefore: number
    meshesAfter: number
    colliderNodes: number
  }
  versions: { semantics: number; collider: number; spawn: number }
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  city: string
  attribution: string
}

export function glbBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => resolve(result as ArrayBuffer),
      (err) => reject(err),
      { binary: true },
    )
  })
}

const GLB = 'model/gltf-binary'
const JSON_CT = 'application/json'

function jsonFile(name: string, role: ExportRole, value: unknown): ExportFile {
  return { name, role, contentType: JSON_CT, data: JSON.stringify(value, null, 2) }
}

/** The drivable-surface subset of the collider set — the game raycasts this
 *  layer for wheel contact / surface grip, separate from the full collider. */
function surfaceGroup(set: ColliderSet): THREE.Group {
  const drivable: ColliderSet = {
    colliders: set.colliders.filter((d) => d.semantics.drivable && !d.semantics.sensor),
    bounds: set.bounds,
    stats: set.stats,
  }
  const g = colliderGroupMerged(drivable)
  g.name = 'citybuilder_surface'
  return g
}

/**
 * Build the full export bundle from the current scene registries + store.
 * Requires a built scene (store.initScene has run). Pure aside from updating
 * the store's lint report; safe in browser and Node.
 */
export async function buildExportBundle(): Promise<ExportBundle> {
  const s = useEditor.getState()

  // build the collider set BEFORE the gate so lint and GLB share one set
  const colliderSet = buildCollidersFromRegistry()

  // export gate: re-run geometry linters on the current (possibly edited) scene
  const gate = [
    ...flickerLint(),
    ...roadConsistencyLint(),
    ...waterLint(),
    ...(colliderSet && cityGraph ? colliderLint(cityGraph, colliderSet) : []),
  ]
  s.setLintReport([...gate, ...s.lintReport.filter((w) => !gate.some((g) => g.message === w.message))])
  const warnings = gate.filter((w) => w.severity === 'warn')

  // ---- visual scene
  const rawVisual = new THREE.Group()
  rawVisual.name = 'citybuilder_scene'
  for (const id of s.objectOrder) {
    const obj = s.objects[id]
    if (!obj || obj.deleted || !obj.visible) continue
    const three = getVariant(obj.id, obj.asset)
    if (!three) continue
    const clone = three.clone(true)
    clone.position.fromArray(obj.transform.position)
    clone.rotation.fromArray(obj.transform.rotation as [number, number, number])
    clone.scale.fromArray(obj.transform.scale)
    clone.name = `${obj.type}__${obj.id}`
    rawVisual.add(clone)
  }
  // dedup materials + batch-merge geometry so the game gets a few dozen draw
  // calls / materials instead of thousands (game engine review §2)
  const { group: visual, stats: optStats } = optimizeSceneForExport(rawVisual)

  // ---- collision layer: pre-merged into a handful of nodes grouped by physics
  //      behaviour (review §3), extras preserved — plus the drivable-only
  //      surface subset as its own GLB for the game's conform set
  const collision = colliderSet ? colliderGroupMerged(colliderSet) : new THREE.Group()
  if (!colliderSet) collision.name = 'citybuilder_colliders'
  const surface = colliderSet ? surfaceGroup(colliderSet) : new THREE.Group()

  // ---- semantics: the data that drives traffic AI / gameplay at runtime,
  //      plus the resolver's decision record for every object
  const roadSem = buildRoadSemantics([...roadSegments.values()], roadResolutions)
  const allObjects = s.objectOrder.map((id) => s.objects[id]).filter((o): o is SceneObject => !!o && !o.deleted)
  const trafficDevices = buildTrafficDevices(allObjects)
  const trafficAudit = buildTrafficAudit([...roadSegments.values()], trafficDevices)

  // ---- auto spawn + minimap derived from the road semantics (review §4)
  const bounds = colliderSet?.bounds ?? boundsFromRoads(roadSem)
  const spawn = deriveSpawn(roadSem, bounds)
  const minimap = buildMinimapGroup(roadSem)

  const semantics = {
    generator: 'CityBuilder MVP',
    semanticsVersion: 3, // v3: road y-channel is the full network elevation solve (default-on, E3); v2 was bridge-ramp-only; v1 was 2D centerlines
    city: s.cityName,
    attribution: s.attribution,
    exportedAt: new Date().toISOString(),
    renderingScope:
      'Content-only export: clean unlit PBR (metallic-roughness). Lighting, shadows, post-FX, reflections and sky are the game engine’s responsibility.',
    context: sceneContext
      ? {
          matrixVersion: sceneContext.matrixVersion,
          region: sceneContext.region.id,
          climate: sceneContext.climate,
          treePoolSource: sceneContext.treePoolSource,
          landCoverSource: sceneContext.landCoverSource,
          adapterLog: sceneContext.provenance,
        }
      : null,
    roads: roadSem,
    traffic_devices: trafficDevices,
    traffic_audit: trafficAudit,
    objects: s.objectOrder
      .map((id) => s.objects[id])
      .filter((o) => o && !o.deleted && o.type === 'building')
      .map((o) => {
        const res = buildingResolutions.get(o.id)
        return {
          id: o.id,
          name: o.name,
          tier: o.tier,
          asset_state: o.asset.state,
          provider: o.asset.provider,
          license: o.asset.license,
          approved: o.asset.approved,
          position: o.transform.position,
          resolution: res
            ? { facade: res.facade, roof: res.roof, tint: res.tint, confidence: res.confidence, provenance: res.provenance }
            : undefined,
        }
      }),
  }

  const spawnJson = {
    generator: 'CityBuilder MVP',
    spawnVersion: 1,
    city: s.cityName,
    spawn,
    note: spawn ? undefined : 'No drivable road found for auto-spawn; place manually.',
  }

  const files: ExportFile[] = [
    { name: 'city_scene.glb', role: 'environment', contentType: GLB, data: await glbBuffer(visual) },
    { name: 'city_collision.glb', role: 'collider', contentType: GLB, data: await glbBuffer(collision) },
    { name: 'city_surface.glb', role: 'surface', contentType: GLB, data: await glbBuffer(surface) },
    { name: 'citymap_minimap.glb', role: 'minimap', contentType: GLB, data: await glbBuffer(minimap) },
    jsonFile('city_semantics.json', 'semantics', semantics),
    jsonFile('citymap_spawn.json', 'spawn', spawnJson),
    // KTX2/Basis packaging manifest for the bake service (texel density, codecs, budgets)
    jsonFile('textures_manifest.json', 'textures', buildTextureManifest()),
  ]

  return {
    files,
    warnings,
    stats: { ...optStats, colliderNodes: collision.children.length },
    versions: { semantics: 3, collider: 2, spawn: 1 },
    bounds,
    city: s.cityName,
    attribution: s.attribution,
  }
}

function boundsFromRoads(roads: ReturnType<typeof buildRoadSemantics>) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const r of roads) {
    for (const p of r.centerline) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
      minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2])
    }
  }
  if (!isFinite(minX)) return { minX: -500, maxX: 500, minZ: -500, maxZ: 500 }
  return { minX, maxX, minZ, maxZ }
}
