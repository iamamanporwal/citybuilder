#!/usr/bin/env node
// Geometry-sanity gate for the experiment-roads kit. Loads every GLB with
// gltf-transform (no GL / image decode needed) and asserts:
//   - parses, has meshes/primitives, has named materials
//   - position accessors carry finite min/max (no NaN)
//   - vertical extent ≈ [0 .. curbH] (the frame lifts exactly the curb height)
//   - horizontal extents are within the expected tile footprint
//   - every primitive has POSITION + NORMAL + indices
// Exit non-zero on any failure so it can gate the build.

import { NodeIO } from '@gltf-transform/core'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'experiment-roads')
const CURB_H = 0.16
const TOL = 0.02

const io = new NodeIO()
let failures = 0
const note = (f, msg) => {
  console.log(`  ✗ ${f}: ${msg}`)
  failures++
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort()
if (!files.length) {
  console.error('No GLBs in experiment-roads/. Run: npx tsx tools/experiment-roads.ts')
  process.exit(1)
}

for (const file of files) {
  const doc = await io.read(join(DIR, file))
  const root = doc.getRoot()
  const meshes = root.listMeshes()
  const materials = root.listMaterials()
  let prims = 0
  let tris = 0
  let verts = 0
  let bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  let missingAttr = false
  let nan = false

  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      prims++
      const pos = prim.getAttribute('POSITION')
      const nrm = prim.getAttribute('NORMAL')
      const idx = prim.getIndices()
      if (!pos || !nrm || !idx) missingAttr = true
      if (pos) {
        verts += pos.getCount()
        const min = pos.getMinNormalized ? pos.getMin([]) : pos.getMin([])
        const max = pos.getMax([])
        if (min.some((v) => !Number.isFinite(v)) || max.some((v) => !Number.isFinite(v))) nan = true
        bbox.minX = Math.min(bbox.minX, min[0]); bbox.maxX = Math.max(bbox.maxX, max[0])
        bbox.minY = Math.min(bbox.minY, min[1]); bbox.maxY = Math.max(bbox.maxY, max[1])
        bbox.minZ = Math.min(bbox.minZ, min[2]); bbox.maxZ = Math.max(bbox.maxZ, max[2])
      }
      if (idx) tris += idx.getCount() / 3
    }
  }

  const isKit = file === '_kit.glb'
  const matNames = materials.map((m) => m.getName()).sort()

  // Assertions
  if (!meshes.length) note(file, 'no meshes')
  if (!prims) note(file, 'no primitives')
  if (missingAttr) note(file, 'a primitive is missing POSITION/NORMAL/indices')
  if (nan) note(file, 'non-finite position bounds (NaN)')
  if (!materials.length) note(file, 'no materials')
  if (Math.abs(bbox.minY - 0) > TOL) note(file, `floor Y ${bbox.minY.toFixed(3)} ≠ 0`)
  if (Math.abs(bbox.maxY - CURB_H) > TOL) note(file, `top Y ${bbox.maxY.toFixed(3)} ≠ curbH ${CURB_H}`)
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ)
  const cap = isKit ? 160 : 60
  if (!Number.isFinite(span) || span < 6 || span > cap) note(file, `footprint span ${span.toFixed(1)}m out of range`)

  const ok = `${bbox.minX.toFixed(1)}..${bbox.maxX.toFixed(1)} x  ${bbox.minZ.toFixed(1)}..${bbox.maxZ.toFixed(1)} z  y[${bbox.minY.toFixed(3)}..${bbox.maxY.toFixed(3)}]`
  console.log(
    `  ${file.padEnd(18)} prims=${String(prims).padStart(2)} tris=${String(Math.round(tris)).padStart(5)} verts=${String(verts).padStart(5)} mats=[${matNames.join(', ')}]\n      bbox ${ok}`,
  )
}

console.log('')
if (failures) {
  console.error(`FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('All GLBs passed geometry sanity.')
