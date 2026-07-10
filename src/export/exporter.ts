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
import { colliderGroup } from './colliderGlb'
import { buildRoadSemantics } from './semantics'

// Export (PRD §14, MVP scope): visual GLB + separate lightweight collision GLB
// + the semantic road/provenance data the game runtime consumes.

function download(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

function exportGlb(root: THREE.Object3D, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => {
        download(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), filename)
        resolve()
      },
      (err) => reject(err),
      { binary: true },
    )
  })
}

import { flickerLint, roadConsistencyLint, waterLint } from '../resolver/lints'

export async function exportCity(): Promise<void> {
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
  const gateWarnings = gate.filter((w) => w.severity === 'warn')
  s.showToast(
    gateWarnings.length
      ? `Exporting with ${gateWarnings.length} geometry warning(s) — see Variety/Flicker linter in the Inspector`
      : 'Exporting… files will download',
  )

  // ---- visual scene
  const visual = new THREE.Group()
  visual.name = 'citybuilder_scene'
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
    visual.add(clone)
  }

  // ---- collision layer: generated from semantic data (physics/colliders.ts),
  //      named nodes with glTF extras carrying collider + material metadata
  const collision = colliderSet ? colliderGroup(colliderSet) : new THREE.Group()
  if (!colliderSet) collision.name = 'citybuilder_colliders'

  // ---- semantics: the data that drives traffic AI / gameplay at runtime,
  //      plus the resolver's decision record for every object
  const semantics = {
    generator: 'CityBuilder MVP',
    semanticsVersion: 2, // BREAKING vs v1: road centerlines are now [x, y, z] (y = true elevation in meters)
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
    roads: buildRoadSemantics([...roadSegments.values()], roadResolutions),
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

  try {
    await exportGlb(visual, 'city_scene.glb')
    await exportGlb(collision, 'city_collision.glb')
    download(
      new Blob([JSON.stringify(semantics, null, 2)], { type: 'application/json' }),
      'city_semantics.json',
    )
    // KTX2/Basis packaging manifest for the bake service (texel density, codecs, budgets)
    download(
      new Blob([JSON.stringify(buildTextureManifest(), null, 2)], { type: 'application/json' }),
      'textures_manifest.json',
    )
    useEditor.getState().showToast('Export complete: scene GLB, collision GLB, semantics + texture manifest')
  } catch (e) {
    useEditor.getState().showToast(`Export failed: ${e}`)
  }
}
