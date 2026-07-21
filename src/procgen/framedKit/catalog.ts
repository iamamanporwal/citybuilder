// Framed-road kit CATALOG — ~50 assets built on the band engine (kit.ts).
// Each asset is a named builder returning per-surface geometry. Segments are a
// cross-section swept on a straight line; curves on a Catmull-Rom; junctions via
// the N-way algorithm; specials (cul-de-sac, roundabout, median cap, transitions)
// are small compositions. Everything partitions cleanly — road/sidewalk/grass are
// each their own strips with shared seams, and grass frames every edge (no dirt).

import * as THREE from 'three'
import type { Vec2 } from '../../types'
import { offsetPolyline, planarUvXZ, ribbonGeometry } from '../geometry'
import {
  type Arm,
  type Band,
  type CrossSection,
  type JunctionProfile,
  type Surface,
  type SurfaceGeoms,
  buildJunction,
  crossSectionWidth,
  sweepCrossSection,
} from './kit'

export interface KitAsset {
  id: string
  category: 'segment' | 'curve' | 'junction' | 'special'
  label: string
  build: () => SurfaceGeoms
}

// ---- band shorthands -------------------------------------------------------
const grass = (w = 1.6): Band => ({ w, surface: 'grass' })
const foot = (w = 2.0): Band => ({ w, surface: 'footpath' })
const curb = (w = 0.4): Band => ({ w, surface: 'curb' })
const asph = (w: number): Band => ({ w, surface: 'asphalt' })
const cobble = (w: number): Band => ({ w, surface: 'cobble' })
const plant = (w: number): Band => ({ w, surface: 'planting' })
const cycle = (w = 1.4): Band => ({ w, surface: 'cycle' })

const LANE = 3.4
const cs = (id: string, label: string, bands: Band[], markings?: CrossSection['markings']): CrossSection => ({
  id, label, bands, markings, foundation: 0.35,
})

// A framed sidewalk pair around a carriageway: [grass foot curb | ... | curb foot grass]
const sidewalksL = (v: number): Band[] => (v > 0 ? [grass(v), foot(), curb()] : [foot(), curb()])
const sidewalksR = (v: number): Band[] => (v > 0 ? [curb(), foot(), grass(v)] : [curb(), foot()])

// ---- cross-section presets (segments) --------------------------------------
const SECTIONS: CrossSection[] = [
  cs('res-2lane', 'Residential · 2-lane', [...sidewalksL(1.6), asph(2 * LANE), ...sidewalksR(1.6)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('res-2lane-narrow', 'Residential · narrow', [...sidewalksL(1.0), asph(2 * 2.9), ...sidewalksR(1.0)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('res-2lane-wide-verge', 'Residential · wide verge', [...sidewalksL(3.0), asph(2 * LANE), ...sidewalksR(3.0)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('collector-3lane', 'Collector · 3-lane', [...sidewalksL(1.6), asph(3 * LANE), ...sidewalksR(1.6)], [{ off: -LANE / 2, style: 'dashed', color: 'white' }, { off: LANE / 2, style: 'dashed', color: 'white' }]),
  cs('arterial-4lane', 'Arterial · 4-lane', [...sidewalksL(2.0), asph(4 * LANE), ...sidewalksR(2.0)], [{ off: 0, style: 'double', color: 'yellow' }, { off: -LANE, style: 'dashed', color: 'white' }, { off: LANE, style: 'dashed', color: 'white' }]),
  cs('arterial-6lane', 'Arterial · 6-lane', [...sidewalksL(2.0), asph(6 * LANE), ...sidewalksR(2.0)], [{ off: 0, style: 'double', color: 'yellow' }, { off: -LANE, style: 'dashed', color: 'white' }, { off: LANE, style: 'dashed', color: 'white' }, { off: -2 * LANE, style: 'dashed', color: 'white' }, { off: 2 * LANE, style: 'dashed', color: 'white' }]),
  cs('avenue-median', 'Avenue · planted median', [...sidewalksL(1.6), asph(2 * LANE), curb(0.3), plant(2.4), curb(0.3), asph(2 * LANE), ...sidewalksR(1.6)], [{ off: -(LANE + 1.5), style: 'solid', color: 'white' }, { off: LANE + 1.5, style: 'solid', color: 'white' }]),
  cs('avenue-median-wide', 'Avenue · wide median', [...sidewalksL(2.0), asph(2 * LANE), curb(0.3), plant(4.5), curb(0.3), asph(2 * LANE), ...sidewalksR(2.0)]),
  cs('boulevard-tree-verge', 'Boulevard · tree verge', [foot(2.5), grass(2.2), curb(), asph(2 * LANE), curb(), grass(2.2), foot(2.5)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('divided-highway', 'Divided highway', [grass(2.5), asph(2 * LANE), plant(5.0), asph(2 * LANE), grass(2.5)], [{ off: -(LANE + 2.5), style: 'solid', color: 'white' }, { off: LANE + 2.5, style: 'solid', color: 'white' }]),
  cs('one-way-2lane', 'One-way · 2-lane', [...sidewalksL(1.6), asph(2 * LANE), ...sidewalksR(1.6)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('urban-commercial', 'Commercial · wide walks', [foot(4.0), curb(), asph(2 * LANE), curb(), foot(4.0)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('parking-both', 'Residential · parking both', [...sidewalksL(1.6), asph(2.2), asph(2 * LANE), asph(2.2), ...sidewalksR(1.6)], [{ off: 0, style: 'dashed', color: 'white' }, { off: -LANE, style: 'solid', color: 'white' }, { off: LANE, style: 'solid', color: 'white' }]),
  cs('cycle-track-both', 'Cycle track · both sides', [grass(1.2), foot(1.8), cycle(), curb(), asph(2 * LANE), curb(), cycle(), foot(1.8), grass(1.2)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('cycle-track-oneside', 'Cycle track · one side', [grass(1.2), foot(1.8), cycle(), curb(), asph(2 * LANE), curb(), foot(1.8), grass(1.2)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('bus-lane', 'Bus lane · outer', [...sidewalksL(1.6), asph(3.2), asph(2 * LANE), asph(3.2), ...sidewalksR(1.6)], [{ off: 0, style: 'dashed', color: 'white' }, { off: -LANE, style: 'solid', color: 'white' }, { off: LANE, style: 'solid', color: 'white' }]),
  cs('european-cobble', 'European · cobble street', [foot(1.5), curb(0.3), cobble(2 * 2.9), curb(0.3), foot(1.5)]),
  cs('european-cobble-narrow', 'European · cobble alley', [foot(1.2), curb(0.25), cobble(4.2), curb(0.25), foot(1.2)]),
  cs('european-cobble-wide-walk', 'European · cobble + plaza walk', [foot(3.5), curb(0.3), cobble(6.0), curb(0.3), foot(3.5)]),
  cs('european-asph-narrow', 'European · narrow asphalt', [foot(1.5), curb(0.3), asph(5.8), curb(0.3), foot(1.5)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('rural-2lane', 'Rural · 2-lane + verge', [grass(2.5), asph(2 * LANE), grass(2.5)], [{ off: 0, style: 'dashed', color: 'yellow' }]),
  cs('rural-shoulder', 'Rural · gravel shoulder', [grass(2.0), cobble(1.0), asph(2 * LANE), cobble(1.0), grass(2.0)], [{ off: 0, style: 'dashed', color: 'yellow' }]),
  cs('lane-no-sidewalk', 'Lane · no sidewalk', [grass(1.5), asph(2 * 2.6), grass(1.5)]),
  cs('garden-path', 'Garden path (in green)', [grass(3.0), foot(2.2), grass(3.0)]),
  cs('garden-path-wide', 'Park promenade (in green)', [grass(3.5), foot(4.0), grass(3.5)]),
  cs('garden-path-planted', 'Park path · planting edge', [grass(2.0), plant(1.0), foot(2.4), plant(1.0), grass(2.0)]),
  cs('footpath-single', 'Footpath · single side', [foot(2.4), grass(2.5)]),
  cs('promenade-seaside', 'Promenade · wide walk + verge', [foot(5.0), grass(1.5), curb(), asph(2 * LANE), curb(), grass(1.5), foot(2.0)], [{ off: 0, style: 'dashed', color: 'white' }]),
  cs('median-tram-reserve', 'Median · grass reserve', [...sidewalksL(1.6), asph(LANE), curb(0.3), grass(3.0), curb(0.3), asph(LANE), ...sidewalksR(1.6)]),
]

// ---- junction profiles -----------------------------------------------------
const PROF_RES: JunctionProfile = { carriageHalf: LANE, curbW: 0.4, footW: 2.0, vergeW: 1.6, centerMark: { style: 'dashed', color: 'white' } }
const PROF_ARTERIAL: JunctionProfile = { carriageHalf: 2 * LANE, curbW: 0.4, footW: 2.5, vergeW: 1.6, centerMark: { style: 'double', color: 'yellow' } }
const PROF_EURO: JunctionProfile = { carriageHalf: 2.9, curbW: 0.3, footW: 1.5, vergeW: 0 }
const PROF_BOULEVARD: JunctionProfile = { carriageHalf: LANE, curbW: 0.4, footW: 2.5, vergeW: 3.0, centerMark: { style: 'dashed', color: 'white' } }

const ring = (n: number, rot = 0): Arm[] =>
  Array.from({ length: n }, (_, i) => ({ ang: rot + (i * 2 * Math.PI) / n, len: 16 }))

const JUNCTIONS: { id: string; label: string; arms: Arm[]; prof: JunctionProfile }[] = [
  { id: 'jct-tee', label: 'Junction · T (3-way)', arms: [{ ang: 0, len: 16 }, { ang: Math.PI, len: 16 }, { ang: -Math.PI / 2, len: 16 }], prof: PROF_RES },
  { id: 'jct-tee-arterial', label: 'Junction · T arterial', arms: [{ ang: 0, len: 18 }, { ang: Math.PI, len: 18 }, { ang: -Math.PI / 2, len: 18 }], prof: PROF_ARTERIAL },
  { id: 'jct-y', label: 'Junction · Y (3-way)', arms: ring(3, Math.PI / 2), prof: PROF_RES },
  { id: 'jct-cross', label: 'Junction · cross (4-way)', arms: ring(4), prof: PROF_RES },
  { id: 'jct-cross-arterial', label: 'Junction · cross arterial', arms: ring(4), prof: PROF_ARTERIAL },
  { id: 'jct-cross-boulevard', label: 'Junction · cross + verge', arms: ring(4), prof: PROF_BOULEVARD },
  { id: 'jct-cross-euro', label: 'Junction · cross (European)', arms: ring(4), prof: PROF_EURO },
  { id: 'jct-tee-euro', label: 'Junction · T (European)', arms: [{ ang: 0, len: 16 }, { ang: Math.PI, len: 16 }, { ang: -Math.PI / 2, len: 16 }], prof: PROF_EURO },
  { id: 'jct-5way', label: 'Junction · 5-way', arms: ring(5, Math.PI / 2), prof: PROF_RES },
  { id: 'jct-6way', label: 'Junction · 6-way', arms: ring(6), prof: PROF_RES },
  { id: 'jct-6way-arterial', label: 'Junction · 6-way arterial', arms: ring(6), prof: PROF_ARTERIAL },
  { id: 'jct-skew', label: 'Junction · skew 4-way', arms: [{ ang: 0.25, len: 16 }, { ang: Math.PI + 0.25, len: 16 }, { ang: Math.PI / 2 - 0.15, len: 16 }, { ang: -Math.PI / 2 - 0.15, len: 16 }], prof: PROF_RES },
]

// ---- curves ----------------------------------------------------------------
const S_CURVE: Vec2[] = [{ x: -18, z: -20 }, { x: -6, z: -12 }, { x: -10, z: 0 }, { x: 4, z: 8 }, { x: 0, z: 20 }]
const CORNER: Vec2[] = [{ x: -18, z: -2 }, { x: -2, z: -2 }, { x: 0, z: 0 }, { x: 2, z: 2 }, { x: 2, z: 18 }]
const CURVES: { id: string; label: string; section: string; path: Vec2[] }[] = [
  { id: 'curve-res-s', label: 'Curve · residential S', section: 'res-2lane', path: S_CURVE },
  { id: 'curve-res-90', label: 'Curve · residential 90°', section: 'res-2lane', path: CORNER },
  { id: 'curve-avenue-s', label: 'Curve · avenue median S', section: 'avenue-median', path: S_CURVE },
  { id: 'curve-euro-s', label: 'Curve · European cobble S', section: 'european-cobble', path: S_CURVE },
  { id: 'curve-boulevard-s', label: 'Curve · boulevard S', section: 'boulevard-tree-verge', path: S_CURVE },
  { id: 'curve-garden-s', label: 'Curve · garden path S', section: 'garden-path', path: S_CURVE },
]

// ---- specials --------------------------------------------------------------
function circlePoly(r: number, segs = 40, cx = 0, cz = 0): Vec2[] {
  return Array.from({ length: segs }, (_, i) => {
    const a = (i / segs) * Math.PI * 2
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r }
  })
}
function ringFill(outer: Vec2[], inner: Vec2[], y: number, surf: Surface, acc: SurfaceGeoms) {
  const g = planarUvXZ(ribbonGeometry([...outer, outer[0]], [...inner, inner[0]], y))
  const n = g.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0)
  const arr = acc.get(surf) ?? []; arr.push(g); acc.set(surf, arr)
}
function discFill(r: number, y: number, surf: Surface, acc: SurfaceGeoms, cx = 0, cz = 0) {
  const segs = 44
  const pos: number[] = [cx, y, cz]
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2
    pos.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r)
  }
  for (let i = 1; i <= segs; i++) idx.push(0, i + 1, i)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  const n = new Float32Array(pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
  planarUvXZ(g)
  const arr = acc.get(surf) ?? []; arr.push(g); acc.set(surf, arr)
}

function buildRoundabout(): SurfaceGeoms {
  const acc: SurfaceGeoms = new Map()
  const islandR = 6, ringInner = 6.4, ringOuter = 6.4 + 7, kerbW = 0.4, footW = 2.0, grassW = 1.6, y = 0.15
  // central island: grass disc + kerb ring
  discFill(islandR, 0, 'grass', acc)
  ringFill(circlePoly(islandR + kerbW), circlePoly(islandR), y, 'curb', acc)
  // circulating carriageway (asphalt annulus)
  ringFill(circlePoly(ringOuter), circlePoly(islandR + kerbW), 0, 'asphalt', acc)
  // outer kerb + footpath + grass rings
  ringFill(circlePoly(ringOuter + kerbW), circlePoly(ringOuter), y, 'curb', acc)
  ringFill(circlePoly(ringOuter + kerbW + footW), circlePoly(ringOuter + kerbW), y, 'footpath', acc)
  ringFill(circlePoly(ringOuter + kerbW + footW + grassW), circlePoly(ringOuter + kerbW + footW), 0, 'grass', acc)
  // 4 approach stubs
  const stub: CrossSection = { id: 's', label: 's', bands: [grass(grassW), foot(footW), curb(kerbW), asph(2 * LANE), curb(kerbW), foot(footW), grass(grassW)], foundation: 0.35 }
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2
    const d = { x: Math.cos(a), z: Math.sin(a) }
    sweepCrossSection([{ x: d.x * (ringOuter - 0.5), z: d.z * (ringOuter - 0.5) }, { x: d.x * 26, z: d.z * 26 }], stub, acc, { smooth: false })
  }
  return acc
}

function buildCulDeSac(): SurfaceGeoms {
  const acc: SurfaceGeoms = new Map()
  const hw = LANE, kerbW = 0.4, footW = 2.0, grassW = 1.6, y = 0.15
  const bulbR = 9
  const cz = 16
  // approach corridor
  const sec: CrossSection = { id: 'c', label: 'c', bands: [grass(grassW), foot(footW), curb(kerbW), asph(2 * hw), curb(kerbW), foot(footW), grass(grassW)], foundation: 0.35, markings: [{ off: 0, style: 'dashed', color: 'white' }] }
  sweepCrossSection([{ x: 0, z: -8 }, { x: 0, z: cz }], sec, acc, { smooth: false })
  // bulb centred at (0, cz): asphalt disc + kerb/footpath/grass rings
  discFill(bulbR, 0, 'asphalt', acc, 0, cz)
  ringFill(circlePoly(bulbR + kerbW, 40, 0, cz), circlePoly(bulbR, 40, 0, cz), y, 'curb', acc)
  ringFill(circlePoly(bulbR + kerbW + footW, 40, 0, cz), circlePoly(bulbR + kerbW, 40, 0, cz), y, 'footpath', acc)
  ringFill(circlePoly(bulbR + kerbW + footW + grassW, 40, 0, cz), circlePoly(bulbR + kerbW + footW, 40, 0, cz), 0, 'grass', acc)
  return acc
}

function buildMedianCap(): SurfaceGeoms {
  // avenue that starts a planted median partway along (median tapers in)
  const acc: SurfaceGeoms = new Map()
  const half: CrossSection = { id: 'h', label: 'h', bands: [grass(1.6), foot(2), curb(), asph(2 * LANE), curb(), foot(2), grass(1.6)], foundation: 0.35, markings: [{ off: 0, style: 'dashed', color: 'white' }] }
  sweepCrossSection([{ x: 0, z: -18 }, { x: 0, z: 0 }], half, acc, { smooth: false })
  const withMedian: CrossSection = { id: 'm', label: 'm', bands: [grass(1.6), foot(2), curb(), asph(2 * LANE), curb(0.3), plant(2.4), curb(0.3), asph(2 * LANE), curb(), foot(2), grass(1.6)], foundation: 0.35 }
  sweepCrossSection([{ x: 0, z: 0 }, { x: 0, z: 18 }], withMedian, acc, { smooth: false })
  return acc
}

function buildRoadToPath(): SurfaceGeoms {
  // drivable road transitioning to a pedestrian path (bollard line implied)
  const acc: SurfaceGeoms = new Map()
  const road: CrossSection = { id: 'r', label: 'r', bands: [grass(1.6), foot(2), curb(), asph(2 * LANE), curb(), foot(2), grass(1.6)], foundation: 0.35, markings: [{ off: 0, style: 'dashed', color: 'white' }] }
  sweepCrossSection([{ x: 0, z: -18 }, { x: 0, z: 0 }], road, acc, { smooth: false })
  const path: CrossSection = { id: 'p', label: 'p', bands: [grass(3.0), foot(2.4), grass(3.0)], foundation: 0.35 }
  sweepCrossSection([{ x: 0, z: 0 }, { x: 0, z: 18 }], path, acc, { smooth: false })
  return acc
}

const SPECIALS: KitAsset[] = [
  { id: 'special-roundabout', category: 'special', label: 'Roundabout', build: buildRoundabout },
  { id: 'special-culdesac', category: 'special', label: 'Cul-de-sac', build: buildCulDeSac },
  { id: 'special-median-cap', category: 'special', label: 'Median start/cap', build: buildMedianCap },
  { id: 'special-road-to-path', category: 'special', label: 'Road → path transition', build: buildRoadToPath },
]

// ---- assemble the catalog --------------------------------------------------
export function buildCatalog(): KitAsset[] {
  const assets: KitAsset[] = []

  for (const section of SECTIONS) {
    const L = 24
    assets.push({
      id: section.id, category: 'segment', label: section.label,
      build: () => sweepCrossSection([{ x: 0, z: -L / 2 }, { x: 0, z: L / 2 }], section, new Map(), { smooth: false }),
    })
  }
  for (const c of CURVES) {
    const section = SECTIONS.find((s) => s.id === c.section)!
    assets.push({ id: c.id, category: 'curve', label: c.label, build: () => sweepCrossSection(c.path, section, new Map(), { smooth: 1.6 }) })
  }
  for (const j of JUNCTIONS) {
    assets.push({ id: j.id, category: 'junction', label: j.label, build: () => buildJunction(j.arms, j.prof) })
  }
  assets.push(...SPECIALS)
  return assets
}

export const CATALOG_SIZE = () => buildCatalog().length
export { crossSectionWidth }
