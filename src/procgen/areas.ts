import * as THREE from 'three'
import polygonClipping from 'polygon-clipping'
import type { AreaFeature, Vec2 } from '../types'
import { clipRingToRect, mergeGeometries, pointInRing, ringAreaM2, ringIsSimple, wallGeometry, type Rect } from './geometry'
import { generateLandTextures } from '../materials/textures'
import { sampleTerrain } from './terrain/field'
import { isTerrainEnabled, TERRAIN } from './terrain/config'
import { terrainGridGeometry } from './terrain/mesh'

// Rendered land-cover polygons (parks, grass, sand, forest floor) plus the
// terrain/water system. Land is the default base: the ground plane covers the
// whole scene and water exists only where a whitelisted water polygon CARVES a
// real hole in it (ShapeGeometry holes), with the water surface sunk below
// grade and a bank skirt closing the gap. No face of the ground remains under
// carved water, so ground/water can never z-fight. Water rings that cannot be
// carved safely (non-simple after clipping, or overlapping another hole) fall
// back to a painted overlay at the water layer height — separated far beyond
// the depth-buffer quantum (see editor/depthConfig.ts).

// y values follow the linter-enforced layer convention (editor/depthConfig.ts)
const AREA_STYLE: Record<string, { y: number; mat: THREE.MeshStandardMaterial } | undefined> = {
  grass: { y: 0.022, mat: new THREE.MeshStandardMaterial({ color: '#5d7050', roughness: 1 }) },
  park: { y: 0.032, mat: new THREE.MeshStandardMaterial({ color: '#55684a', roughness: 1 }) },
  sand: { y: 0.037, mat: new THREE.MeshStandardMaterial({ color: '#c2b280', roughness: 1 }) },
  forest: { y: 0.042, mat: new THREE.MeshStandardMaterial({ color: '#48583f', roughness: 1 }) },
}

const GROUND_MAT = new THREE.MeshStandardMaterial({ color: '#4d5545', roughness: 1 }) // land: mossy green

// Ground-cover textures are attached lazily on the first render (browser only).
// areas.ts stays canvas-free at module load so node tests that import it (they
// call buildTerrain/waterRings, never render) never touch a CanvasTexture.
let landTexturesApplied = false
export function applyLandTextures(): void {
  if (landTexturesApplied) return
  landTexturesApplied = true
  const tex = generateLandTextures()
  const attach = (mat: THREE.MeshStandardMaterial, t: { albedo: THREE.Texture; normal: THREE.Texture }, tileM: number) => {
    mat.map = t.albedo
    mat.normalMap = t.normal
    mat.color.set('#ffffff') // let the albedo drive the hue; color would otherwise multiply it down
    for (const m of [t.albedo, t.normal]) m.repeat.set(1 / tileM, 1 / tileM)
    mat.needsUpdate = true
  }
  attach(AREA_STYLE.grass!.mat, tex.grass, 8)
  attach(AREA_STYLE.park!.mat, tex.park, 8)
  attach(AREA_STYLE.forest!.mat, tex.forest, 8)
  attach(AREA_STYLE.sand!.mat, tex.sand, 7)
  attach(GROUND_MAT, tex.ground, 9)
}

// Animated ocean surface. It stays a MeshStandardMaterial so it keeps scene
// lighting, shadows and the logarithmic depth buffer (see editor/depthConfig);
// scrolling-wave ripples and a horizon fresnel sheen are injected via
// onBeforeCompile. A single shared uniform is advanced each render frame by
// tickOcean() so the water visibly moves — this reads unmistakably as sea/ocean
// rather than a flat blue slab.
const OCEAN_UNIFORMS = { uTime: { value: 0 } }
export function tickOcean(t: number): void {
  OCEAN_UNIFORMS.uTime.value = t
}
function makeOceanMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#1e4d68', roughness: 0.18, metalness: 0.0 })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = OCEAN_UNIFORMS.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOceanWPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvOceanWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vOceanWPos;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float ow1 = sin(vOceanWPos.x * 0.045 + uTime * 0.8) * cos(vOceanWPos.z * 0.052 - uTime * 0.6);
        float ow2 = sin((vOceanWPos.x + vOceanWPos.z) * 0.11 - uTime * 0.9);
        float oRip = 0.5 + 0.5 * (ow1 * 0.6 + ow2 * 0.4);
        diffuseColor.rgb *= mix(0.82, 1.18, oRip);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float oFres = pow(1.0 - max(dot(normalize(vViewPosition), normal), 0.0), 3.0);
        totalEmissiveRadiance += vec3(0.05, 0.11, 0.16) * oFres;`,
      )
  }
  m.customProgramCacheKey = () => 'citybuilder-ocean'
  return m
}
const WATER_MAT = makeOceanMaterial()
const BANK_MAT = new THREE.MeshStandardMaterial({ color: '#6b6353', roughness: 1, side: THREE.DoubleSide })
export const WATER_DEPTH = 0.35 // carved water sits this far below grade
const WATER_PAINT_Y = 0.012 // fallback painted-water layer (depthConfig convention)

type ClipPoly = [number, number][][]
const toClipPoly = (ring: Vec2[], holes: Vec2[][] = []): ClipPoly => [
  ring.map((p) => [p.x, p.z] as [number, number]),
  ...holes.map((h) => h.map((p) => [p.x, p.z] as [number, number])),
]

/**
 * Non-water land cover (grass, park, sand, forest floor) as flat tinted
 * overlays. Land cover renders ABOVE the water layer, so any pond/river inside
 * a park polygon would be painted over and vanish — water is subtracted from
 * every overlapping land-cover polygon first (a pond in a park stays a pond).
 */
export function buildAreas(areas: AreaFeature[]): { kind: string; mesh: THREE.Mesh }[] {
  const water = areas.filter((a) => a.render && a.kind === 'water' && a.ring.length >= 3)
  const waterPolys: ClipPoly[] = water.map((a) => toClipPoly(a.ring, a.holes))
  const waterBoxes = water.map((a) => ringBBox(a.ring))

  const byKind = new Map<string, THREE.BufferGeometry[]>()
  for (const a of areas) {
    if (!a.render || a.kind === 'water') continue
    const style = AREA_STYLE[a.kind]
    if (!style || a.ring.length < 3) continue
    const bb = ringBBox(a.ring)
    const clash = waterBoxes.some(
      (wb) => bb.minX < wb.maxX && wb.minX < bb.maxX && bb.minZ < wb.maxZ && wb.minZ < bb.maxZ,
    )
    if (!byKind.has(a.kind)) byKind.set(a.kind, [])
    if (!clash) {
      byKind.get(a.kind)!.push(flatRingGeometry(a.ring, style.y))
      continue
    }
    try {
      const cut = polygonClipping.difference([toClipPoly(a.ring, a.holes)], waterPolys)
      for (const poly of cut) {
        if (!poly.length || poly[0].length < 3) continue
        const ring = poly[0].map(([x, z]) => ({ x, z }))
        const holes = poly.slice(1).filter((h) => h.length >= 3).map((h) => h.map(([x, z]) => ({ x, z })))
        byKind.get(a.kind)!.push(holedFlatGeometry(ring, holes, style.y))
      }
    } catch {
      byKind.get(a.kind)!.push(flatRingGeometry(a.ring, style.y)) // degenerate input — keep legacy behaviour
    }
  }
  const out: { kind: string; mesh: THREE.Mesh }[] = []
  for (const [kind, geoms] of byKind) {
    const geo = conformToTerrain(mergeGeometries(geoms))
    const mesh = new THREE.Mesh(geo, AREA_STYLE[kind]!.mat)
    mesh.name =
      kind === 'park' ? 'Parks' : kind === 'grass' ? 'Grass' : kind === 'sand' ? 'Sand & beaches' : 'Forest floor'
    mesh.receiveShadow = true
    out.push({ kind, mesh })
  }
  return out
}

export interface TerrainBuild {
  ground: THREE.Mesh
  water: THREE.Group | null
  carvedCount: number
  paintedCount: number
}

/**
 * Classify water rings against the ground rect: rings that carve real holes
 * vs. rings that fall back to painted overlays. Shared by buildTerrain and the
 * physics collider builder (water sensor volumes) so both agree exactly.
 */
export interface WaterRing {
  ring: Vec2[]
  holes: Vec2[][] // land islands cut out of this water surface
}
export function waterRings(waterAreas: AreaFeature[], bounds: Rect): { carved: WaterRing[]; painted: WaterRing[] } {
  interface Candidate { ring: Vec2[]; holes: Vec2[][]; area: number }
  const candidates: Candidate[] = []
  const painted: WaterRing[] = []

  for (const a of waterAreas) {
    if (!a.render || a.kind !== 'water' || a.ring.length < 3) continue
    const clipped = clipRingToRect(a.ring, bounds)
    if (clipped.length < 3) continue
    const holes = (a.holes ?? [])
      .map((h) => clipRingToRect(h, bounds))
      .filter((h) => h.length >= 3 && ringIsSimple(h))
    if (!ringIsSimple(clipped)) {
      // folded ribbon (hairpin river) — same-material overlay is safe to paint
      painted.push({ ring: clipped, holes })
      continue
    }
    const area = ringAreaM2(clipped)
    if (area < 1) continue
    candidates.push({ ring: clipped, holes, area })
  }

  candidates.sort((c1, c2) => c2.area - c1.area)
  const kept: Candidate[] = []
  for (const c of candidates) {
    const bb = ringBBox(c.ring)
    const clash = kept.some((h) => {
      const hb = ringBBox(h.ring)
      return bb.minX < hb.maxX && hb.minX < bb.maxX && bb.minZ < hb.maxZ && hb.minZ < bb.maxZ
    })
    if (clash) painted.push({ ring: c.ring, holes: c.holes })
    else kept.push(c)
  }
  return { carved: kept.map((h) => ({ ring: h.ring, holes: h.holes })), painted }
}

/**
 * Ground plane with water bodies carved out as real holes.
 * Water rings are clipped to the ground rect, validated (simple, non-trivial
 * area) and carved largest-first; a ring whose bbox overlaps an already carved
 * hole is painted instead (earcut cannot triangulate intersecting holes).
 */
export function buildTerrain(waterAreas: AreaFeature[], bounds: Rect): TerrainBuild {
  return isTerrainEnabled()
    ? buildTerrainRelief(waterAreas, bounds)
    : buildTerrainFlat(waterAreas, bounds)
}

/**
 * Terrain-relief ground: a displaced grid seated on the height field. Water is
 * NOT carved — the field drops to a submerged riverbed inside each water ring,
 * hidden under the opaque water surface, so ground and water separate purely
 * by height (no holes, no bank skirts, no z-fight). See procgen/terrain/field.ts.
 */
function buildTerrainRelief(waterAreas: AreaFeature[], bounds: Rect): TerrainBuild {
  const { carved, painted } = waterRings(waterAreas, bounds)
  const ground = buildGroundGrid(bounds)
  ground.name = 'Ground'

  // flat opaque water surfaces (islands cut out), seated in the field's valley
  const surfaces = [...carved, ...painted].map((w) => holedFlatGeometry(w.ring, w.holes, TERRAIN.waterSurfaceY))
  let water: THREE.Group | null = null
  if (surfaces.length) {
    water = new THREE.Group()
    water.name = 'Water'
    const m = new THREE.Mesh(mergeGeometries(surfaces), WATER_MAT)
    m.receiveShadow = true
    water.add(m)
  }
  return { ground, water, carvedCount: carved.length, paintedCount: painted.length }
}

/** Legacy flat ground (terrain off): rect minus carved water holes, water sunk to
 *  -WATER_DEPTH with bank skirts. Byte-identical to the pre-terrain behaviour. */
function buildTerrainFlat(waterAreas: AreaFeature[], bounds: Rect): TerrainBuild {
  const { carved, painted } = waterRings(waterAreas, bounds)
  const paintGeoms = painted.map((p) => holedFlatGeometry(p.ring, p.holes, WATER_PAINT_Y))

  // ---- ground: rect shape minus carved water (shape space: (x, -z))
  const groundShape = new THREE.Shape([
    new THREE.Vector2(bounds.minX, -bounds.minZ),
    new THREE.Vector2(bounds.maxX, -bounds.minZ),
    new THREE.Vector2(bounds.maxX, -bounds.maxZ),
    new THREE.Vector2(bounds.minX, -bounds.maxZ),
  ])
  for (const c of carved) {
    groundShape.holes.push(new THREE.Path(c.ring.map((p) => new THREE.Vector2(p.x, -p.z))))
  }
  const groundGeo = indexed(new THREE.ShapeGeometry(groundShape).rotateX(-Math.PI / 2))
  // land islands sit inside carved water — re-add them as ground faces at grade
  const islandGeoms: THREE.BufferGeometry[] = []
  for (const c of carved) for (const h of c.holes) islandGeoms.push(flatRingGeometry(h, 0))
  const ground = new THREE.Mesh(
    islandGeoms.length ? mergeGeometries([groundGeo, ...islandGeoms]) : groundGeo,
    GROUND_MAT,
  )
  ground.receiveShadow = true
  ground.name = 'Ground'

  // ---- water: sunken surfaces (islands cut out) + bank skirts to grade
  const waterGeoms: THREE.BufferGeometry[] = []
  const bankGeoms: THREE.BufferGeometry[] = []
  for (const c of carved) {
    waterGeoms.push(holedFlatGeometry(c.ring, c.holes, -WATER_DEPTH))
    bankGeoms.push(wallGeometry([...c.ring, c.ring[0]], 0, -WATER_DEPTH))
    for (const h of c.holes) bankGeoms.push(wallGeometry([...h, h[0]], -WATER_DEPTH, 0)) // island shore skirt
  }

  let water: THREE.Group | null = null
  if (waterGeoms.length || paintGeoms.length) {
    water = new THREE.Group()
    water.name = 'Water'
    if (waterGeoms.length) {
      const m = new THREE.Mesh(mergeGeometries(waterGeoms), WATER_MAT)
      m.receiveShadow = true
      water.add(m)
    }
    if (bankGeoms.length) water.add(new THREE.Mesh(mergeGeometries(bankGeoms), BANK_MAT))
    if (paintGeoms.length) {
      const m = new THREE.Mesh(mergeGeometries(paintGeoms), WATER_MAT)
      m.receiveShadow = true
      water.add(m)
    }
  }
  return { ground, water, carvedCount: carved.length, paintedCount: painted.length }
}

/** True when point p lies over carved or painted water of these areas (islands excluded). */
export function isWaterAt(p: Vec2, waterAreas: AreaFeature[]): boolean {
  return waterAreas.some(
    (a) =>
      a.kind === 'water' &&
      a.render &&
      pointInRing(p, a.ring) &&
      !(a.holes ?? []).some((h) => pointInRing(p, h)),
  )
}

function ringBBox(ring: Vec2[]): Rect {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  return { minX, maxX, minZ, maxZ }
}

export function flatRingGeometry(ring: Vec2[], y: number): THREE.BufferGeometry {
  const pts = ring.map((p) => new THREE.Vector2(p.x, -p.z))
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse()
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts))
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y, 0)
  return indexed(geo)
}

/** Flat filled ring with interior holes cut out (islands), at height y. */
export function holedFlatGeometry(ring: Vec2[], holes: Vec2[][], y: number): THREE.BufferGeometry {
  if (!holes.length) return flatRingGeometry(ring, y)
  const outer = ring.map((p) => new THREE.Vector2(p.x, -p.z))
  if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse()
  const shape = new THREE.Shape(outer)
  for (const h of holes) {
    if (h.length < 3) continue
    const hp = h.map((p) => new THREE.Vector2(p.x, -p.z))
    if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse() // holes wind opposite the outline
    shape.holes.push(new THREE.Path(hp))
  }
  const geo = new THREE.ShapeGeometry(shape)
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y, 0)
  return indexed(geo)
}

function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.getIndex()) return g
  const count = g.getAttribute('position').count
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

/**
 * Raise every vertex of a flat XZ geometry onto the terrain field (adds the
 * field height to the existing y, so a layer offset like AREA_STYLE.y is kept as
 * a gap on top of the ground). A no-op when terrain is off (sampleTerrain → 0),
 * which is why land cover can call it unconditionally and stay flat-world exact.
 */
function conformToTerrain(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) + sampleTerrain(pos.getX(i), pos.getZ(i)))
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/**
 * Ground as a uniform grid displaced by the terrain field. Grid density is
 * capped (~220 segments/axis) so a large area stays a manageable single mesh.
 * PlaneGeometry.rotateX(-π/2) yields +Y-facing normals in the XZ plane, matching
 * the shape-space winding used elsewhere in this module.
 */
function buildGroundGrid(bounds: Rect): THREE.Mesh {
  const mesh = new THREE.Mesh(terrainGridGeometry(bounds), GROUND_MAT)
  mesh.receiveShadow = true
  return mesh
}
