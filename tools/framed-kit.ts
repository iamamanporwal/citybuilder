#!/usr/bin/env tsx
/**
 * Framed-road kit generator — builds the whole catalog (src/procgen/framedKit)
 * into standalone GLB assets + a top-down preview contact sheet for review.
 *
 *   npx tsx tools/framed-kit.ts
 *   → experiment-roads/framed-kit/<id>.glb, preview.png, manifest.json
 *
 * The engine is material-agnostic; this tool binds each Surface to a material
 * (real baked asphalt/cobble PBR from the app; flat clean concrete/grass) and to
 * a preview colour. Same code path the in-app builder will use when wired.
 */

import '../src/headless/shims'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { curbFrameMaterial, framedWalkMaterial, roadMaterial } from '../src/materials/library'
import { mergeGeometries } from '../src/procgen/geometry'
import { buildCatalog } from '../src/procgen/framedKit/catalog'
import { mergeSurfaceGeoms, type Surface } from '../src/procgen/framedKit/kit'

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...o })

const MATERIAL: Record<Surface, THREE.Material> = {
  asphalt: roadMaterial('asphalt-new'),
  cobble: roadMaterial('cobble'),
  curb: curbFrameMaterial,
  footpath: framedWalkMaterial,
  grass: std({ color: '#6f8a55', roughness: 1 }),
  planting: std({ color: '#4f6b3b', roughness: 1 }),
  cycle: std({ color: '#8a4a3a', roughness: 0.95 }),
  markWhite: std({ color: '#f2f0e8', roughness: 0.7 }),
  markYellow: std({ color: '#e6c23e', roughness: 0.7 }),
}
for (const [name, m] of Object.entries(MATERIAL)) { m.name = name; ;(m as any).side = THREE.DoubleSide }

const PREVIEW_COLOR: Record<Surface, string> = {
  asphalt: '#34373d', cobble: '#57545c', curb: '#d3d0c6', footpath: '#c6c3b8',
  grass: '#6f8a55', planting: '#4f6b3b', cycle: '#8a4a3a', markWhite: '#f2f0e8', markYellow: '#e6c23e',
}

function glbBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) =>
    new GLTFExporter().parse(root, (r) => resolve(r as ArrayBuffer), (e) => reject(e), { binary: true, onlyVisible: true }),
  )
}

async function main() {
  const outDir = join(process.cwd(), 'experiment-roads', 'framed-kit')
  mkdirSync(outDir, { recursive: true })
  const catalog = buildCatalog()
  console.log(`Catalog: ${catalog.length} assets`)

  // Build geometry once per asset; reuse for GLB export + preview.
  const built = catalog.map((a) => ({ asset: a, surfaces: mergeSurfaceGeoms(a.build()) }))

  const manifest: any[] = []
  for (const { asset, surfaces } of built) {
    const grp = new THREE.Group()
    grp.name = asset.id
    for (const [surf, geom] of surfaces) {
      const mesh = new THREE.Mesh(geom, MATERIAL[surf])
      mesh.name = `${asset.id}_${surf}`
      grp.add(mesh)
    }
    const buf = await glbBuffer(grp)
    writeFileSync(join(outDir, `${asset.id}.glb`), Buffer.from(buf))
    manifest.push({ id: asset.id, category: asset.category, label: asset.label, surfaces: [...surfaces.keys()], kb: +(buf.byteLength / 1024).toFixed(1) })
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ count: catalog.length, assets: manifest }, null, 2))
  console.log(`Wrote ${catalog.length} GLBs → ${outDir}/`)

  renderContactSheet(built, join(outDir, 'preview.png'))
}

function renderContactSheet(built: { asset: any; surfaces: Map<Surface, THREE.BufferGeometry> }[], path: string) {
  const COLS = 6
  const CELL = 300
  const PAD = 16
  const rows = Math.ceil(built.length / COLS)
  const W = COLS * CELL
  const H = rows * CELL
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#20242a'
  ctx.fillRect(0, 0, W, H)

  built.forEach(({ asset, surfaces }, fi) => {
    const cx = (fi % COLS) * CELL
    const cy = Math.floor(fi / COLS) * CELL
    // gather tris {p:[[x,z]*3], y, surf}
    const tris: { p: number[][]; y: number; surf: Surface }[] = []
    let min = [Infinity, Infinity], max = [-Infinity, -Infinity]
    for (const [surf, g] of surfaces) {
      const pos = g.getAttribute('position') as THREE.BufferAttribute
      const idx = g.getIndex()!
      for (let i = 0; i < idx.count; i += 3) {
        const p: number[][] = []; let ys = 0
        for (let k = 0; k < 3; k++) {
          const vi = idx.getX(i + k)
          const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi)
          p.push([x, z]); ys += y
          min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], z)
          max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], z)
        }
        tris.push({ p, y: ys / 3, surf })
      }
    }
    const spanX = max[0] - min[0] || 1, spanZ = max[1] - min[1] || 1
    const s = (CELL - 2 * PAD) / Math.max(spanX, spanZ)
    const ox = cx + PAD + (CELL - 2 * PAD - spanX * s) / 2
    const oy = cy + PAD + (CELL - 2 * PAD - spanZ * s) / 2
    const tx = (x: number) => ox + (x - min[0]) * s
    const ty = (z: number) => oy + (max[1] - z) * s
    tris.sort((a, b) => a.y - b.y)
    for (const t of tris) {
      ctx.beginPath()
      ctx.moveTo(tx(t.p[0][0]), ty(t.p[0][1]))
      ctx.lineTo(tx(t.p[1][0]), ty(t.p[1][1]))
      ctx.lineTo(tx(t.p[2][0]), ty(t.p[2][1]))
      ctx.closePath()
      ctx.fillStyle = PREVIEW_COLOR[t.surf] ?? '#888'
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    ctx.fillRect(cx + 6, cy + 6, CELL - 12, 22)
    ctx.fillStyle = '#fff'
    ctx.font = '13px sans-serif'
    ctx.fillText(asset.label, cx + 11, cy + 21)
  })
  writeFileSync(path, canvas.toBuffer('image/png'))
  console.log(`Wrote ${path} (${W}x${H})`)
}

main().catch((e) => { console.error('framed-kit failed:', e); process.exit(1) })
