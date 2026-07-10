import * as THREE from 'three'
import type { BarrierFeature, PointFeature } from '../types'
import { hash01 } from '../resolver/resolve'
import { mergeGeometries, wallGeometry } from './geometry'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Common-prop library, mapped from OSM tags by the Context Resolver.
 * Ships with procedural CC0-style stand-ins; drop real CC0 packs
 * (Kenney / Quaternius / Poly Pizza) into /public/props/<kind>_<variant>.glb
 * and the loader prefers them. Each instance is seeded by object id.
 */

const stone = new THREE.MeshStandardMaterial({ color: '#9b968c', roughness: 0.9 })
const bronze = new THREE.MeshStandardMaterial({ color: '#6d5f42', roughness: 0.45, metalness: 0.7 })
const waterMat = new THREE.MeshStandardMaterial({ color: '#4a6d82', roughness: 0.15, metalness: 0.1 })
const metal = new THREE.MeshStandardMaterial({ color: '#3a4046', roughness: 0.55, metalness: 0.6 })
const glass = new THREE.MeshStandardMaterial({ color: '#8fa5b2', roughness: 0.2, metalness: 0.2, transparent: true, opacity: 0.55 })
const fenceMat = new THREE.MeshStandardMaterial({ color: '#4c5254', roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide })

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  m.castShadow = true
  return m
}

export function buildFountain(p: PointFeature): THREE.Group {
  const g = new THREE.Group()
  const seed = hash01(p.id)
  const r = 1.6 + seed * 1.6
  g.add(mesh(new THREE.CylinderGeometry(r, r * 1.06, 0.55, 20), stone, 0, 0.275, 0))
  const water = mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 0.06, 20), waterMat, 0, 0.5, 0)
  water.castShadow = false
  g.add(water)
  g.add(mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.3, 10), stone, 0, 1.15, 0))
  g.add(mesh(new THREE.CylinderGeometry(r * 0.35, 0.08, 0.22, 14), stone, 0, 1.85, 0))
  if (seed > 0.5) g.add(mesh(new THREE.CylinderGeometry(r * 0.18, 0.05, 0.16, 12), stone, 0, 2.35, 0))
  g.name = p.name ?? 'Fountain'
  return g
}

export function buildStatue(p: PointFeature): THREE.Group {
  const g = new THREE.Group()
  const seed = hash01(p.id)
  const plinthH = 0.9 + seed * 0.9
  g.add(mesh(new THREE.BoxGeometry(1.5, 0.3, 1.5), stone, 0, 0.15, 0))
  g.add(mesh(new THREE.BoxGeometry(1.0, plinthH, 1.0), stone, 0, 0.3 + plinthH / 2, 0))
  if (seed > 0.62) {
    // obelisk variant
    const h = 3 + seed * 3
    g.add(mesh(new THREE.CylinderGeometry(0.12, 0.4, h, 4), stone, 0, 0.3 + plinthH + h / 2, 0))
  } else {
    // figure variant
    const base = 0.3 + plinthH
    g.add(mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.5, 8), bronze, 0, base + 0.75, 0))
    g.add(mesh(new THREE.SphereGeometry(0.2, 10, 8), bronze, 0, base + 1.68, 0))
    const arm = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6), bronze, 0.3, base + 1.25, 0)
    arm.rotation.z = -0.9 - seed * 0.5
    g.add(arm)
  }
  g.name = p.name ?? 'Statue'
  return g
}

export function buildBusStop(p: PointFeature): THREE.Group {
  const g = new THREE.Group()
  const seed = hash01(p.id)
  const w = 3.2
  for (const x of [-w / 2 + 0.1, w / 2 - 0.1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 8), metal, x, 1.25, 0))
  }
  g.add(mesh(new THREE.BoxGeometry(w + 0.3, 0.08, 1.6), metal, 0, 2.55, -0.1))
  const back = mesh(new THREE.BoxGeometry(w, 1.7, 0.05), glass, 0, 1.45, -0.75)
  back.castShadow = false
  g.add(back)
  g.add(mesh(new THREE.BoxGeometry(w * 0.8, 0.06, 0.4), metal, 0, 0.55, -0.4))
  if (seed > 0.4) g.add(mesh(new THREE.BoxGeometry(0.5, 0.7, 0.08), metal, w / 2 - 0.15, 2.1, 0.3))
  g.name = p.name ?? 'Bus stop'
  g.rotation.y = hash01(p.id + ':rot') * Math.PI * 2
  return g
}

/** All fences/walls merged into one locked mesh. */
export function buildBarriers(barriers: BarrierFeature[]): THREE.Mesh | null {
  const geoms: THREE.BufferGeometry[] = []
  for (const b of barriers) {
    if (b.points.length < 2) continue
    const h = b.kind === 'wall' ? 1.6 : 1.15
    geoms.push(wallGeometry(b.points, 0, h))
  }
  if (!geoms.length) return null
  const m = new THREE.Mesh(mergeVertices(mergeGeometries(geoms), 1e-3), fenceMat)
  m.name = `Fences & walls (${barriers.length})`
  m.castShadow = true
  return m
}

/** Enhanced (AI-slot) variant for wikidata-linked statues/fountains. */
export function buildEnhancedProp(p: PointFeature): THREE.Group {
  const g = p.kind === 'fountain' ? buildFountain({ ...p, id: p.id + ':gen' }) : buildStatue({ ...p, id: p.id + ':gen' })
  g.scale.setScalar(1.25)
  g.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.material === stone) {
      m.material = new THREE.MeshStandardMaterial({ color: '#b0a893', roughness: 0.6 })
    }
  })
  g.name += ' (generated)'
  return g
}
