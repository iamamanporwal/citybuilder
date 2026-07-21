#!/usr/bin/env tsx
/**
 * EXPERIMENT — Lego-connected framed road NETWORK. Proves the connection rule from
 * experiment-roads/ROAD-CASES.md: every arm at a node trims to the same pad radius,
 * the node is filled by a junction pad, and segments sweep the SAME cross-section
 * trimmed to that radius — so segment ↔ junction seams register with no gap.
 *
 *   npx tsx tools/framed-network.ts
 *   → experiment-roads/framed-network/network.glb + preview.png
 *
 * Built on the kit engine (src/procgen/framedKit). Once this reads clean, the same
 * rule ports into the in-app framed toggle.
 */

import '../src/headless/shims'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Vec2 } from '../src/types'
import { curbFrameMaterial, framedVergeMaterial, framedWalkMaterial, roadMaterial } from '../src/materials/library'
import { mergeGeometries, polylineLength, trimPolyline } from '../src/procgen/geometry'
import {
  type JunctionProfile,
  type Surface,
  type SurfaceGeoms,
  buildJunction,
  junctionArmCrossSection,
  junctionPadRadius,
  mergeSurfaceGeoms,
  sweepCrossSection,
} from '../src/procgen/framedKit/kit'

// ---- network model ---------------------------------------------------------
interface Node { id: string; p: Vec2 }
interface Edge { a: string; b: string; cls: string; via?: Vec2[] }

// A small demo network: two crossings + a T, straight + curved segments, dead-ends.
const NODES: Node[] = [
  { id: 'J1', p: { x: 0, z: 0 } }, // cross
  { id: 'J2', p: { x: 0, z: 62 } }, // T (north, via a curve)
  { id: 'J3', p: { x: 62, z: 0 } }, // cross (east)
  { id: 'DS', p: { x: 0, z: -34 } }, // dead-end south
  { id: 'DW', p: { x: -34, z: 0 } }, // dead-end west
  { id: 'J2E', p: { x: 30, z: 62 } }, // T east arm dead-end
  { id: 'J2W', p: { x: -30, z: 62 } }, // T west arm dead-end
  { id: 'J3N', p: { x: 62, z: 34 } },
  { id: 'J3S', p: { x: 62, z: -34 } },
  { id: 'J3E', p: { x: 96, z: 0 } },
]
const EDGES: Edge[] = [
  { a: 'J1', b: 'J2', cls: 'residential', via: [{ x: 10, z: 31 }] }, // curved segment
  { a: 'J1', b: 'J3', cls: 'secondary' }, // straight arterial-ish
  { a: 'J1', b: 'DS', cls: 'residential' },
  { a: 'J1', b: 'DW', cls: 'residential' },
  { a: 'J2', b: 'J2E', cls: 'residential' },
  { a: 'J2', b: 'J2W', cls: 'residential' },
  { a: 'J3', b: 'J3N', cls: 'secondary' },
  { a: 'J3', b: 'J3S', cls: 'secondary' },
  { a: 'J3', b: 'J3E', cls: 'secondary' },
]

// ---- per-class cross-section (grass-verge tree-lawn, matches in-app) --------
function profFor(cls: string, widthM: number): JunctionProfile {
  const P: Record<string, Omit<JunctionProfile, 'carriageHalf'>> = {
    residential: { curbW: 0.4, lawnW: 1.5, footW: 1.8, vergeW: 1.2, centerMark: { style: 'dashed', color: 'white' } },
    secondary: { curbW: 0.42, lawnW: 1.2, footW: 2.2, vergeW: 1.2, centerMark: { style: 'double', color: 'yellow' } },
  }
  return { carriageHalf: widthM / 2, ...(P[cls] ?? P.residential) }
}
const WIDTH: Record<string, number> = { residential: 7, secondary: 11 }

// ---- build the network -----------------------------------------------------
function buildNetwork(): SurfaceGeoms {
  const acc: SurfaceGeoms = new Map()
  const nodeOf = new Map(NODES.map((n) => [n.id, n]))
  // incident edges per node
  const incident = new Map<string, Edge[]>()
  for (const e of EDGES) {
    for (const id of [e.a, e.b]) {
      const l = incident.get(id) ?? []; l.push(e); incident.set(id, l)
    }
  }
  const deg = (id: string) => incident.get(id)?.length ?? 0
  const isJunction = (id: string) => deg(id) >= 3

  // edge centreline (a→b) with via points
  const centre = (e: Edge): Vec2[] => [nodeOf.get(e.a)!.p, ...(e.via ?? []), nodeOf.get(e.b)!.p]
  const dirFrom = (id: string, e: Edge): Vec2 => {
    const c = centre(e)
    const [p0, p1] = e.a === id ? [c[0], c[1]] : [c[c.length - 1], c[c.length - 2]]
    const dx = p1.x - p0.x, dz = p1.z - p0.z
    const l = Math.hypot(dx, dz) || 1
    return { x: dx / l, z: dz / l }
  }
  // a node's shared disc radius = the WIDEST incident arm's pad radius (each arm
  // keeps its own width and flares to this disc — per-arm profiles handle the rest)
  const nodeR = (id: string): number =>
    Math.max(...(incident.get(id) ?? []).map((e) => junctionPadRadius(profFor(e.cls, WIDTH[e.cls] ?? 7))))

  // 1) junction pads (padOnly — segments provide the arms), per-arm profiles
  for (const n of NODES) {
    if (!isJunction(n.id)) continue
    const arms = (incident.get(n.id) ?? []).map((e) => {
      const d = dirFrom(n.id, e)
      return { ang: Math.atan2(d.z, d.x), len: 0, prof: profFor(e.cls, WIDTH[e.cls] ?? 7) }
    })
    const local: SurfaceGeoms = new Map()
    buildJunction(arms, arms[0].prof, local, { padOnly: true })
    for (const [s, geoms] of local) for (const g of geoms) { g.translate(n.p.x, 0, n.p.z); accAdd(acc, s, g) }
  }

  // 2) segments — sweep the class cross-section, trimmed to each end's disc radius
  for (const e of EDGES) {
    const c = centre(e)
    const prof = profFor(e.cls, WIDTH[e.cls] ?? 7)
    const xs = junctionArmCrossSection(prof)
    const trimA = isJunction(e.a) ? nodeR(e.a) : 0
    const trimB = isJunction(e.b) ? nodeR(e.b) : 0
    const total = polylineLength(c)
    if (total <= trimA + trimB + 1) continue
    const cut = trimPolyline(c, trimA, trimB)
    if (cut && cut.length >= 2) sweepCrossSection(cut, xs, acc, { smooth: e.via ? 1.6 : false })
  }
  return acc
}

function accAdd(acc: SurfaceGeoms, s: Surface, g: THREE.BufferGeometry) {
  const arr = acc.get(s) ?? []; arr.push(g); acc.set(s, arr)
}

// ---- materials + export ----------------------------------------------------
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...o })
const MATERIAL: Record<Surface, THREE.Material> = {
  asphalt: roadMaterial('asphalt-new'), cobble: roadMaterial('cobble'),
  curb: curbFrameMaterial, footpath: framedWalkMaterial, grass: framedVergeMaterial,
  planting: std({ color: '#4f6b3b' }), cycle: std({ color: '#8a4a3a' }),
  markWhite: std({ color: '#f2f0e8' }), markYellow: std({ color: '#e6c23e' }),
}
const PREVIEW: Record<Surface, string> = {
  asphalt: '#34373d', cobble: '#57545c', curb: '#cfccc1', footpath: '#c6c3b8',
  grass: '#5d7050', planting: '#4f6b3b', cycle: '#8a4a3a', markWhite: '#f2f0e8', markYellow: '#e6c23e',
}

function glb(root: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((res, rej) => new GLTFExporter().parse(root, (r) => res(r as ArrayBuffer), (e) => rej(e), { binary: true }))
}

async function main() {
  const outDir = join(process.cwd(), 'experiment-roads', 'framed-network')
  mkdirSync(outDir, { recursive: true })
  const acc = buildNetwork()
  const merged = mergeSurfaceGeoms(acc)

  const grp = new THREE.Group(); grp.name = 'framed_network'
  for (const [s, g] of merged) { const m = new THREE.Mesh(g, MATERIAL[s]); m.name = s; grp.add(m) }
  writeFileSync(join(outDir, 'network.glb'), Buffer.from(await glb(grp)))

  renderTopDown(merged, join(outDir, 'preview.png'))
  console.log(`Done → ${outDir}/`)
}

function renderTopDown(merged: Map<Surface, THREE.BufferGeometry>, path: string) {
  const W = 1500, H = 1200, PAD = 40
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3f4a34'; ctx.fillRect(0, 0, W, H)
  const tris: { p: number[][]; y: number; s: Surface }[] = []
  let min = [Infinity, Infinity], max = [-Infinity, -Infinity]
  for (const [s, g] of merged) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const idx = g.getIndex()!
    for (let i = 0; i < idx.count; i += 3) {
      const p: number[][] = []; let ys = 0
      for (let k = 0; k < 3; k++) { const vi = idx.getX(i + k); const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi); p.push([x, z]); ys += y; min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], z); max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], z) }
      tris.push({ p, y: ys / 3, s })
    }
  }
  const spanX = max[0] - min[0] || 1, spanZ = max[1] - min[1] || 1
  const sc = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanZ)
  const ox = PAD + (W - 2 * PAD - spanX * sc) / 2, oy = PAD + (H - 2 * PAD - spanZ * sc) / 2
  const tx = (x: number) => ox + (x - min[0]) * sc, ty = (z: number) => oy + (max[1] - z) * sc
  tris.sort((a, b) => a.y - b.y)
  for (const t of tris) {
    ctx.beginPath(); ctx.moveTo(tx(t.p[0][0]), ty(t.p[0][1])); ctx.lineTo(tx(t.p[1][0]), ty(t.p[1][1])); ctx.lineTo(tx(t.p[2][0]), ty(t.p[2][1])); ctx.closePath()
    ctx.fillStyle = PREVIEW[t.s] ?? '#888'; ctx.fill()
  }
  writeFileSync(path, canvas.toBuffer('image/png'))
  console.log(`Wrote ${path}`)
}

main().catch((e) => { console.error('framed-network failed:', e); process.exit(1) })
