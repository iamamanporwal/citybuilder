#!/usr/bin/env node
// Top-down orthographic preview of the experiment-roads kit, painted straight
// from the GLB triangles (no GL context needed — pure @napi-rs/canvas). Triangles
// are painter-sorted by height so the raised curb frame / footpath draw over the
// asphalt, exactly as they'd stack when viewed from above. Lets us eyeball the
// frame + junction corners without a renderer. Writes experiment-roads/preview.png.

import { NodeIO } from '@gltf-transform/core'
import { KHRTextureTransform } from '@gltf-transform/extensions'
import { createCanvas } from '@napi-rs/canvas'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'experiment-roads')
const io = new NodeIO().registerExtensions([KHRTextureTransform])

// material name → fill / stroke
const COLOR = {
  asphalt: '#34373d',
  curb_concrete: '#d7d3c8',
  footpath_concrete_slab: '#aba69b',
  lane_paint: '#f2f0e8',
}
const EDGE = 'rgba(0,0,0,0.10)'

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.glb') && f !== '_kit.glb')
  .sort()

const CELL = 460
const PAD = 26
const COLS = 3
const rows = Math.ceil(files.length / COLS)
const W = COLS * CELL
const H = rows * CELL
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
ctx.fillStyle = '#6f7d63' // grass-ish backdrop so footpath edges read
ctx.fillRect(0, 0, W, H)

for (let fi = 0; fi < files.length; fi++) {
  const file = files[fi]
  const cx = (fi % COLS) * CELL
  const cy = Math.floor(fi / COLS) * CELL
  const doc = await io.read(join(DIR, file))

  // collect triangles: {pts:[[x,z]x3], y, mat}
  const tris = []
  let min = [Infinity, Infinity]
  let max = [-Infinity, -Infinity]
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      const idx = prim.getIndices()
      const mat = prim.getMaterial()?.getName() ?? 'asphalt'
      if (!pos || !idx) continue
      for (let i = 0; i < idx.getCount(); i += 3) {
        const p = []
        let ysum = 0
        for (let k = 0; k < 3; k++) {
          const e = pos.getElement(idx.getScalar(i + k), [])
          p.push([e[0], e[2]])
          ysum += e[1]
          min[0] = Math.min(min[0], e[0]); min[1] = Math.min(min[1], e[2])
          max[0] = Math.max(max[0], e[0]); max[1] = Math.max(max[1], e[2])
        }
        tris.push({ p, y: ysum / 3, mat })
      }
    }
  }

  // fit transform (world XZ → cell pixels), preserve aspect, flip Z up
  const spanX = max[0] - min[0] || 1
  const spanZ = max[1] - min[1] || 1
  const s = (CELL - 2 * PAD) / Math.max(spanX, spanZ)
  const ox = cx + PAD + (CELL - 2 * PAD - spanX * s) / 2
  const oy = cy + PAD + (CELL - 2 * PAD - spanZ * s) / 2
  const tx = (x) => ox + (x - min[0]) * s
  const ty = (z) => oy + (max[1] - z) * s // flip so +Z is up

  // painter's order: lower Y first, higher (curb/paint) on top
  tris.sort((a, b) => a.y - b.y)
  for (const t of tris) {
    ctx.beginPath()
    ctx.moveTo(tx(t.p[0][0]), ty(t.p[0][1]))
    ctx.lineTo(tx(t.p[1][0]), ty(t.p[1][1]))
    ctx.lineTo(tx(t.p[2][0]), ty(t.p[2][1]))
    ctx.closePath()
    ctx.fillStyle = COLOR[t.mat] ?? '#888'
    ctx.fill()
    ctx.strokeStyle = EDGE
    ctx.lineWidth = 0.4
    ctx.stroke()
  }

  // label
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(cx + 8, cy + 8, 168, 26)
  ctx.fillStyle = '#fff'
  ctx.font = '16px sans-serif'
  ctx.fillText(`${file.replace('.glb', '')}  (${tris.length} tri)`, cx + 14, cy + 26)
}

writeFileSync(join(DIR, 'preview.png'), canvas.toBuffer('image/png'))
console.log(`Wrote ${join(DIR, 'preview.png')} (${W}x${H})`)
