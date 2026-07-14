import * as THREE from 'three'
import type { BuildingFeature, Vec2 } from '../types'
import type { BuildingResolution } from '../resolver/types'
import type { RoofForm } from '../recognizer/types'
import { hash01 } from '../resolver/resolve'
import { facadeMaterial, roofMaterial } from '../materials/library'
import { mats } from './materials'

// Buildings are generated into a fixed "slot": the footprint/height/position come
// from data and stay stable no matter which provider fills the slot (PRD §7.2).

export function footprintCentroid(fp: Vec2[]): Vec2 {
  let x = 0
  let z = 0
  for (const p of fp) {
    x += p.x
    z += p.z
  }
  return { x: x / fp.length, z: z / fp.length }
}

function footprintShape(fp: Vec2[], c: Vec2, scale = 1): THREE.Shape {
  const pts = fp.map((p) => new THREE.Vector2((p.x - c.x) * scale, -(p.z - c.z) * scale))
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse()
  return new THREE.Shape(pts)
}

function extrudeFootprint(
  fp: Vec2[],
  c: Vec2,
  height: number,
  yBase: number,
  scale: number,
  bevel: boolean,
): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(footprintShape(fp, c, scale), {
    depth: height,
    bevelEnabled: bevel,
    bevelThickness: bevel ? 0.6 : 0,
    bevelSize: bevel ? 0.4 : 0,
    bevelSegments: 1,
  })
  geo.rotateX(-Math.PI / 2) // extrusion +z -> +y (up); shape (x, -z) -> world (x, z)
  geo.translate(0, yBase, 0)
  return geo
}

// buildings sink below grade so the base is never coplanar with the terrain
const BASE_SINK = 0.4

// Pitched roofs are the tent forms (all fan to an apex over the centroid); dome
// is a scaled hemisphere. Everything else (flat, tall towers) gets no cap.
const TENT_FORMS = new Set<RoofForm>(['gabled', 'hipped', 'pyramidal', 'mansard', 'skillion'])

// Roof caps use a double-sided variant of the shared roof material so the cap
// renders correctly regardless of footprint winding (the tent fan can wind
// either way). Only four RoofSets exist, so the cache stays tiny.
const doubleSidedRoofCache = new Map<THREE.Material, THREE.Material>()
function capMaterial(res: BuildingResolution): THREE.Material {
  const base = roofMaterial(res.roof)
  let ds = doubleSidedRoofCache.get(base)
  if (!ds) {
    ds = base.clone()
    ds.side = THREE.DoubleSide
    doubleSidedRoofCache.set(base, ds)
  }
  return ds
}

function footprintExtent(fp: Vec2[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of fp) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  return { minX, maxX, minZ, maxZ }
}

/**
 * A pitched/domed roof cap for a low/mid-rise building, in the mesh-local frame
 * (relative to the footprint centroid c, base at world y=topY). Returns null for
 * flat roofs. The cap fully covers the flat extrusion top, so no coplanar face
 * is exposed (see the flicker invariants) — the shared top edge is a line, not a
 * plane. Kept off tall masses by the caller (roofForm is 'flat' above ~25 m).
 */
export function buildRoofCap(
  fp: Vec2[],
  c: Vec2,
  form: RoofForm,
  topY: number,
  res: BuildingResolution,
): THREE.Mesh | null {
  if (form === 'flat') return null
  const ext = footprintExtent(fp)
  const rx = (ext.maxX - ext.minX) / 2
  const rz = (ext.maxZ - ext.minZ) / 2
  const minExtent = Math.min(rx, rz) * 2
  if (minExtent < 2) return null // too small to read as a roof

  if (form === 'dome') {
    const domeH = Math.min(minExtent * 0.5, 8)
    const geo = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    geo.scale(rx, domeH, rz)
    geo.translate((ext.minX + ext.maxX) / 2 - c.x, topY, (ext.minZ + ext.maxZ) / 2 - c.z)
    const mesh = new THREE.Mesh(geo, roofMaterial(res.roof))
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  if (!TENT_FORMS.has(form)) return null
  // skillion is a single slope; the rest fan symmetrically to a centroid apex.
  const pitch = Math.max(1.2, Math.min(minExtent * (form === 'skillion' ? 0.22 : 0.35), 6))
  const apex = new THREE.Vector3(0, topY + pitch, 0)
  const positions: number[] = []
  const n = fp.length
  for (let i = 0; i < n; i++) {
    const a = fp[i]
    const bb = fp[(i + 1) % n]
    positions.push(
      a.x - c.x, topY, a.z - c.z,
      bb.x - c.x, topY, bb.z - c.z,
      apex.x, apex.y, apex.z,
    )
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, capMaterial(res))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/**
 * Tier-2/1 procedural placeholder: extruded footprint + recognizer/resolver PBR
 * materials, plus an optional pitched/domed roof cap when the recognizer's
 * descriptor calls for one (low/mid-rise only).
 */
export function buildProceduralBuilding(
  b: BuildingFeature,
  res: BuildingResolution,
  roofForm: RoofForm = 'flat',
): THREE.Object3D {
  const c = footprintCentroid(b.footprint)
  const geo = extrudeFootprint(b.footprint, c, b.heightM + BASE_SINK, -BASE_SINK, 1, false)
  const mesh = new THREE.Mesh(geo, [
    roofMaterial(res.roof),
    facadeMaterial(res.facade, res.tint, res.uvSeed),
  ])
  mesh.position.set(c.x, 0, c.z)
  mesh.name = b.name ?? 'Building'
  mesh.userData.objectId = b.id
  mesh.castShadow = true
  mesh.receiveShadow = true

  const cap = buildRoofCap(b.footprint, c, roofForm, b.heightM, res)
  if (!cap) return mesh

  const group = new THREE.Group()
  group.name = mesh.name
  group.userData.objectId = b.id
  group.position.set(c.x, 0, c.z)
  mesh.position.set(0, 0, 0) // re-parent: group now carries the world position
  group.add(mesh, cap)
  return group
}

/**
 * "Generated" variant — stands in for a Trellis/Meshy result until a real GPU
 * endpoint is configured. Deterministic per building, visually richer: setback
 * tiers, cornice bevel, rooftop plant, antenna on landmarks.
 */
export function buildEnhancedBuilding(b: BuildingFeature, res: BuildingResolution): THREE.Group {
  const c = footprintCentroid(b.footprint)
  const rand = (salt: string) => hash01(b.id + ':gen:' + salt)
  const group = new THREE.Group()
  group.position.set(c.x, 0, c.z)
  group.name = `${b.name ?? 'Building'} (generated)`

  const wall = facadeMaterial(res.facade, res.tint, [rand('u'), rand('v')])
  const wallUpper = facadeMaterial(res.facade, res.tint, [rand('u2'), rand('v2')])
  const hasTier = b.heightM > 35 && b.footprint.length >= 4
  const baseH = hasTier ? b.heightM * (0.55 + rand('h') * 0.15) : b.heightM

  const base = new THREE.Mesh(extrudeFootprint(b.footprint, c, baseH + BASE_SINK, -BASE_SINK, 1, true), [
    roofMaterial(res.roof),
    wall,
  ])
  base.castShadow = true
  base.receiveShadow = true
  group.add(base)

  if (hasTier) {
    const tierScale = 0.62 + rand('ts') * 0.15
    const tier = new THREE.Mesh(
      extrudeFootprint(b.footprint, c, b.heightM - baseH, baseH, tierScale, true),
      [roofMaterial(res.roof), wallUpper],
    )
    tier.castShadow = true
    group.add(tier)
  }

  // rooftop mechanical penthouse
  const bbox = new THREE.Box3().setFromObject(group)
  const size = bbox.getSize(new THREE.Vector3())
  const phW = Math.min(size.x, size.z) * 0.25
  if (phW > 1.5) {
    const ph = new THREE.Mesh(
      new THREE.BoxGeometry(phW, 2.4, phW * 0.8),
      new THREE.MeshStandardMaterial({ color: '#6b6b66', roughness: 0.9 }),
    )
    ph.position.set(0, b.heightM + 1.2, 0)
    ph.castShadow = true
    group.add(ph)
  }

  if (b.tier === 'landmark' && b.heightM > 60) {
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.3, b.heightM * 0.15, 6),
      mats.signalPole,
    )
    antenna.position.set(0, b.heightM + b.heightM * 0.075, 0)
    group.add(antenna)
  }
  return group
}

/**
 * Fit an arbitrary imported model into a building slot: uniform-scale to the
 * footprint extent, ground it at y=0, center it on the footprint centroid.
 */
export function fitToSlot(model: THREE.Object3D, b: BuildingFeature): THREE.Group {
  const c = footprintCentroid(b.footprint)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of b.footprint) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  const slotExtent = Math.max(maxX - minX, maxZ - minZ)

  const bbox = new THREE.Box3().setFromObject(model)
  const size = bbox.getSize(new THREE.Vector3())
  const modelExtent = Math.max(size.x, size.z) || 1
  const scale = slotExtent / modelExtent
  const center = bbox.getCenter(new THREE.Vector3())

  const wrapper = new THREE.Group()
  model.position.sub(center) // center at origin
  model.position.y += size.y / 2 - (center.y - bbox.min.y) + (bbox.min.y - center.y) // will re-ground below
  const inner = new THREE.Group()
  inner.add(model)
  inner.scale.setScalar(scale)
  wrapper.add(inner)

  // re-ground precisely after scaling, then sink the base below grade by the
  // same amount as procedural buildings so no bottom face is coplanar with the
  // terrain (avoids z-fighting — see the flicker invariants).
  const after = new THREE.Box3().setFromObject(wrapper)
  wrapper.position.set(c.x, -after.min.y - BASE_SINK, c.z)
  wrapper.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  return wrapper
}
