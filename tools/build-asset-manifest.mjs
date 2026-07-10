#!/usr/bin/env node
/**
 * Asset library scanner → assets/manifest.json + assets/coverage-report.md
 *
 * Scans assets/library/<pack>/gltf/*.gltf, extracts real geometry stats
 * (bbox in meters, triangle count, materials, LODs), classifies each model
 * with a deterministic keyword lexicon, maps it to OSM tags, and groups
 * assets into weighted pools keyed by (osm tag × style) for the Context
 * Resolver's hash(feature_id) pick.
 *
 * Re-runnable: node tools/build-asset-manifest.mjs
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'fs'
import { join, basename } from 'path'

const ROOT = new URL('..', import.meta.url).pathname
const LIB_DIR = join(ROOT, 'assets', 'library')
const OUT_MANIFEST = join(ROOT, 'assets', 'manifest.json')
const OUT_COVERAGE = join(ROOT, 'assets', 'coverage-report.md')

// ---------------------------------------------------------------------------
// Classification lexicon — ordered; first match wins.
// semantic: coarse type · role: function within the type · style: visual family
// osm: tags this asset can satisfy · internal: pseudo-tags for pipeline stages
// that have no mainstream OSM equivalent (lane markings etc.)
// ---------------------------------------------------------------------------
const LEXICON = [
  // -- complete buildings ----------------------------------------------------
  { re: /^Building_Large/i,  semantic: 'building', role: 'complete', style: 'downtown-brick',
    osm: ['building=commercial', 'building=office', 'building=yes'], sizeClass: 'large' },
  { re: /^Building_Medium/i, semantic: 'building', role: 'complete', style: 'downtown-brick',
    osm: ['building=commercial', 'building=retail', 'building=yes'], sizeClass: 'medium' },
  { re: /^Building_Small/i,  semantic: 'building', role: 'complete', style: 'downtown-brick',
    osm: ['building=retail', 'building=residential', 'building=yes'], sizeClass: 'small' },

  // -- street-level props ----------------------------------------------------
  { re: /^Prop_Bollard/i,      semantic: 'street_furniture', role: 'bollard', style: 'metal-concrete', osm: ['barrier=bollard'] },
  { re: /^Prop_ManholeCover/i, semantic: 'street_furniture', role: 'manhole', style: 'metal-concrete', osm: ['man_made=manhole'] },
  { re: /^Prop_Drain/i,        semantic: 'street_furniture', role: 'drain',   style: 'metal-concrete', osm: ['man_made=manhole', 'manhole=drain'] },
  { re: /^(Prop_Planter|Sidewalk_Planter)/i, semantic: 'street_furniture', role: 'planter', style: 'concrete', osm: ['man_made=planter'] },
  { re: /^Prop_ACUnit/i, semantic: 'rooftop_prop', role: 'hvac', style: 'metal', osm: [], internal: ['rooftop:hvac'] },

  // -- road network modules (reference only — CityBuilder roads are locked
  //    and generated procedurally; kept for engine export / future streaming)
  { re: /^Street_.*Intersection/i, semantic: 'road_module', role: 'junction', style: 'asphalt-us',
    osm: ['junction=yes'], referenceOnly: true },
  { re: /^Street_4Lane|^Street_.*4Lane/i, semantic: 'road_module', role: 'carriageway-4lane', style: 'asphalt-us',
    osm: ['highway=secondary', 'highway=primary'], referenceOnly: true },
  { re: /^Street_2Lane|^Street_.*2Lane/i, semantic: 'road_module', role: 'carriageway-2lane', style: 'asphalt-us',
    osm: ['highway=residential', 'highway=tertiary'], referenceOnly: true },
  { re: /^Street_Asphalt/i, semantic: 'road_module', role: 'surface-patch', style: 'asphalt-us',
    osm: ['area:highway=asphalt'], referenceOnly: true },

  // -- road markings / decals -------------------------------------------------
  { re: /^Decal_Crosswalk/i, semantic: 'road_decal', role: 'crosswalk', style: 'paint-us',
    osm: ['highway=crossing', 'crossing=marked'] },
  { re: /^Decal_Bikelane/i, semantic: 'road_decal', role: 'bike-lane', style: 'paint-us', osm: ['cycleway=lane'] },
  { re: /^Decal_Stop\b/i,   semantic: 'road_decal', role: 'stop-text', style: 'paint-us', osm: ['highway=stop'] },
  { re: /^Decal_ArrowStraight/i,     semantic: 'road_decal', role: 'lane-arrow', style: 'paint-us', osm: [], internal: ['turn:lanes~through'] },
  { re: /^Decal_ArrowTurnLeft/i,     semantic: 'road_decal', role: 'lane-arrow', style: 'paint-us', osm: [], internal: ['turn:lanes~left'] },
  { re: /^Decal_ArrowTurnRight/i,    semantic: 'road_decal', role: 'lane-arrow', style: 'paint-us', osm: [], internal: ['turn:lanes~right'] },
  { re: /^Decal_ArrowForwardLeft/i,  semantic: 'road_decal', role: 'lane-arrow', style: 'paint-us', osm: [], internal: ['turn:lanes~through;left'] },
  { re: /^Decal_ArrowForwardRight/i, semantic: 'road_decal', role: 'lane-arrow', style: 'paint-us', osm: [], internal: ['turn:lanes~through;right'] },
  { re: /^Decal_/i, semantic: 'road_decal', role: 'lane-marking', style: 'paint-us', osm: [], internal: ['road_marking'] },

  // -- sidewalks ----------------------------------------------------------------
  { re: /^Sidewalk_/i, semantic: 'sidewalk_module', role: 'sidewalk', style: 'concrete-us',
    osm: ['highway=footway', 'footway=sidewalk'], referenceOnly: true },

  // -- modular facade kit (composed into buildings, mapped via building:part) ---
  { re: /^(Brick|Metal|Trim|Cornice|Roof|Floor|Door|DoorFrame|Entrance|Stairs)/i,
    semantic: 'building_module', dynamicModule: true },
]

// building_module refinement: style from material family, role from function keywords
function refineModule(name) {
  const style =
    /^Brick|_RedBrick|RedWhite/i.test(name) ? 'brick-red' :
    /^Metal/i.test(name) ? 'metal-glass' :
    /Slate/i.test(name) ? 'slate' :
    /^(Trim|Cornice_Trim|Floor|Entrance|Stairs|Door)/i.test(name) ? 'painted-trim' :
    /^Cornice_Metal/i.test(name) ? 'metal-glass' :
    /^Cornice_Brick/i.test(name) ? 'brick-red' : 'painted-trim'
  const role =
    /InteriorWall/i.test(name) ? 'interior-wall' :
    /Window/i.test(name) ? 'window' :
    /^Cornice|TopTrim/i.test(name) ? 'cornice' :
    /^Roof/i.test(name) ? 'roof' :
    /Column/i.test(name) ? 'column' :
    /Corner|90Angle/i.test(name) ? 'corner' :
    /^DoorFrame|^Door_/i.test(name) ? 'door' :
    /^Entrance/i.test(name) ? 'entrance' :
    /^Stairs/i.test(name) ? 'stairs' :
    /^Floor/i.test(name) ? 'floor' :
    /Trim/i.test(name) ? 'trim' : 'wall'
  const material =
    style === 'brick-red' ? 'brick' :
    style === 'metal-glass' ? 'metal' :
    style === 'slate' ? 'slate' : 'concrete'
  return { style, role, osm: ['building:part=yes', `building:material=${material}`] }
}

// review thresholds per semantic type
const MAX_DIM_M = { building: 200, building_module: 50, road_module: 100, sidewalk_module: 50, road_decal: 60, street_furniture: 10, rooftop_prop: 10 }
const MAX_TRIS  = { building: 100000, building_module: 20000, road_module: 30000, sidewalk_module: 20000, road_decal: 2000, street_furniture: 10000, rooftop_prop: 10000 }

// ---------------------------------------------------------------------------
// glTF parsing — bbox via node-transformed POSITION accessor min/max,
// triangle counts via indices (or position count) per primitive instance.
// ---------------------------------------------------------------------------
function mat4Identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }
function mat4Multiply(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
function mat4FromTRS(t = [0,0,0], r = [0,0,0,1], s = [1,1,1]) {
  const [x, y, z, w] = r
  const [sx, sy, sz] = s
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]
}
function applyMat4(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

function analyzeGltf(path) {
  const g = JSON.parse(readFileSync(path, 'utf8'))
  const bboxMin = [Infinity, Infinity, Infinity]
  const bboxMax = [-Infinity, -Infinity, -Infinity]
  let tris = 0
  const nodeNames = []

  function visit(nodeIdx, parent) {
    const node = g.nodes[nodeIdx]
    if (node.name) nodeNames.push(node.name)
    const local = node.matrix ?? mat4FromTRS(node.translation, node.rotation, node.scale)
    const world = mat4Multiply(parent, local)
    if (node.mesh !== undefined) {
      for (const prim of g.meshes[node.mesh].primitives ?? []) {
        if (prim.mode !== undefined && prim.mode !== 4) continue // triangles only
        const pos = g.accessors[prim.attributes?.POSITION]
        if (pos?.min && pos?.max) {
          for (let corner = 0; corner < 8; corner++) {
            const p = applyMat4(world, [
              (corner & 1 ? pos.max : pos.min)[0],
              (corner & 2 ? pos.max : pos.min)[1],
              (corner & 4 ? pos.max : pos.min)[2],
            ])
            for (let axis = 0; axis < 3; axis++) {
              bboxMin[axis] = Math.min(bboxMin[axis], p[axis])
              bboxMax[axis] = Math.max(bboxMax[axis], p[axis])
            }
          }
        }
        const idx = prim.indices !== undefined ? g.accessors[prim.indices] : null
        tris += Math.floor((idx ? idx.count : pos?.count ?? 0) / 3)
      }
    }
    for (const c of node.children ?? []) visit(c, world)
  }
  for (const n of g.scenes?.[g.scene ?? 0]?.nodes ?? []) visit(n, mat4Identity())

  const materials = (g.materials ?? []).map(m => m.name).filter(Boolean)
  const textures = (g.images ?? []).map(i => i.uri).filter(Boolean).filter(u => !u.endsWith('.bin'))
  const lodNames = nodeNames.filter(n => /_LOD\d/i.test(n))
  const ok = Number.isFinite(bboxMin[0])
  return {
    bboxMin: ok ? bboxMin.map(v => +v.toFixed(3)) : null,
    bboxMax: ok ? bboxMax.map(v => +v.toFixed(3)) : null,
    tris, materials, textures,
    lods: lodNames.length ? [...new Set(lodNames.map(n => n.match(/_LOD(\d)/i)[0].toUpperCase()))].sort() : ['LOD0'],
  }
}

// ---------------------------------------------------------------------------
// Scan packs
// ---------------------------------------------------------------------------
const assets = []
const reviewFlags = []

for (const pack of readdirSync(LIB_DIR).filter(d => statSync(join(LIB_DIR, d)).isDirectory())) {
  const gltfDir = join(LIB_DIR, pack, 'gltf')
  let files = []
  try { files = readdirSync(gltfDir).filter(f => f.endsWith('.gltf') || f.endsWith('.glb')) } catch { continue }
  const licenseText = (() => { try { return readFileSync(join(LIB_DIR, pack, 'LICENSE.txt'), 'utf8') } catch { return '' } })()
  const license = /CC0 1\.0/i.test(licenseText) ? 'CC0-1.0' : 'see LICENSE.txt'
  const source = /quaternius/i.test(licenseText + pack) ? 'Quaternius — Downtown City MegaKit (free)' : pack

  for (const file of files.sort()) {
    const name = basename(file).replace(/\.(gltf|glb)$/i, '')
    const geo = analyzeGltf(join(gltfDir, file))
    const rule = LEXICON.find(r => r.re.test(name))
    let cls
    if (!rule) {
      cls = { semantic: 'unclassified', role: 'unknown', style: 'unknown', osm: [] }
    } else if (rule.dynamicModule) {
      cls = { semantic: rule.semantic, ...refineModule(name) }
    } else {
      cls = { semantic: rule.semantic, role: rule.role, style: rule.style, osm: rule.osm, internal: rule.internal, sizeClass: rule.sizeClass, referenceOnly: rule.referenceOnly }
    }

    const size = geo.bboxMin ? geo.bboxMax.map((v, i) => +(v - geo.bboxMin[i]).toFixed(3)) : null
    const flags = []
    if (cls.semantic === 'unclassified') flags.push('unclassified')
    if (!size) flags.push('no-geometry')
    if (size && Math.max(...size) > (MAX_DIM_M[cls.semantic] ?? 50)) flags.push('oversized')
    if (geo.tris > (MAX_TRIS[cls.semantic] ?? 20000)) flags.push('high-poly')

    const asset = {
      id: `${pack}/${name}`,
      path: `assets/library/${pack}/gltf/${file}`,
      engineExports: {
        unity: `assets/library/${pack}/fbx/unity/${name}.fbx`,
        unreal: `assets/library/${pack}/fbx/unreal/${name}.fbx`,
      },
      semantic: cls.semantic,
      role: cls.role,
      style: cls.style,
      sizeClass: cls.sizeClass,
      osmTags: cls.osm ?? [],
      internalTags: cls.internal ?? [],
      referenceOnly: cls.referenceOnly ?? false,
      sizeMeters: size ? { x: size[0], y: size[1], z: size[2] } : null,
      bbox: geo.bboxMin ? { min: geo.bboxMin, max: geo.bboxMax } : null,
      groundOffsetY: geo.bboxMin ? +(-geo.bboxMin[1]).toFixed(3) : 0,
      triangles: geo.tris,
      lods: geo.lods,
      materials: geo.materials,
      textures: geo.textures,
      source,
      license,
      flags,
    }
    assets.push(asset)
    if (flags.length) reviewFlags.push({ id: asset.id, flags, sizeMeters: asset.sizeMeters, triangles: geo.tris })
  }
}

// ---------------------------------------------------------------------------
// Weighted pools per (osm tag × style). Deterministic pick contract:
//   pickWeighted(pool.entries, hash01(featureId + '|' + poolKey))
// Weights: 1.0 default · 0.5 for "_noWear"/clean duplicates · building pools
// weight by how well the size class fits the tag's typical scale.
// ---------------------------------------------------------------------------
const BUILDING_TAG_WEIGHTS = {
  'building=yes':         { large: 1, medium: 1, small: 1 },
  'building=commercial':  { large: 1.5, medium: 1, small: 0.5 },
  'building=office':      { large: 1.5, medium: 1, small: 0.25 },
  'building=retail':      { large: 0.25, medium: 1, small: 1.5 },
  'building=residential': { large: 0.25, medium: 0.75, small: 1.5 },
}
const pools = {}
for (const a of assets) {
  if (a.flags.length) continue // review-flagged assets never enter pools
  for (const tag of [...a.osmTags, ...a.internalTags]) {
    const key = `${tag}|${a.style}`
    let weight = /noWear/i.test(a.id) ? 0.5 : 1
    if (a.semantic === 'building' && BUILDING_TAG_WEIGHTS[tag]) weight *= BUILDING_TAG_WEIGHTS[tag][a.sizeClass] ?? 1
    ;(pools[key] ??= { osmTag: tag, style: a.style, semantic: a.semantic, referenceOnly: a.referenceOnly, entries: [] })
      .entries.push({ id: a.id, weight: +weight.toFixed(3) })
  }
}

const manifest = {
  schemaVersion: 1,
  generated: 'run: node tools/build-asset-manifest.mjs',
  pickContract: "pickWeighted(pool.entries, hash01(featureId + '|' + poolKey)) — deterministic per feature; scale = clamp(featureSize / sizeMeters); ground with groundOffsetY",
  counts: {
    assets: assets.length,
    pooled: assets.filter(a => !a.flags.length && (a.osmTags.length || a.internalTags.length)).length,
    flaggedForReview: reviewFlags.length,
    pools: Object.keys(pools).length,
  },
  assets,
  pools,
}
writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2))

// ---------------------------------------------------------------------------
// Coverage report — tags the CityBuilder pipeline consumes vs library supply
// ---------------------------------------------------------------------------
const PIPELINE_TAGS = [
  ['building=yes', 'generic buildings (procgen fallback exists)'],
  ['building=commercial', 'commercial buildings'],
  ['building=residential', 'residential buildings'],
  ['building:part=yes', 'facade kit modules for composed buildings'],
  ['highway=crossing', 'crosswalk markings'],
  ['cycleway=lane', 'bike lane markings'],
  ['footway=sidewalk', 'sidewalk surfaces'],
  ['barrier=bollard', 'bollards'],
  ['man_made=manhole', 'manholes/drains'],
  ['man_made=planter', 'street planters'],
  ['natural=tree', 'street/park trees (procgen instanced today)'],
  ['highway=street_lamp', 'street lights (procgen today)'],
  ['highway=traffic_signals', 'traffic signals (procgen today)'],
  ['amenity=bench', 'benches (procgen today)'],
  ['amenity=fountain', 'fountains (procgen today)'],
  ['amenity=waste_basket', 'waste bins (procgen today)'],
  ['highway=bus_stop', 'bus stops (procgen today)'],
  ['barrier=fence', 'fences (procgen today)'],
  ['barrier=wall', 'walls (procgen today)'],
  ['barrier=hedge', 'hedges (procgen today)'],
  ['emergency=fire_hydrant', 'hydrants'],
  ['traffic_sign=*', 'road signs'],
  ['historic=memorial', 'statues/memorials (procgen today)'],
  ['vehicle', 'parked/traffic vehicles'],
]
const coveredTags = new Set(Object.values(pools).map(p => p.osmTag))
const covered = PIPELINE_TAGS.filter(([t]) => coveredTags.has(t))
const missing = PIPELINE_TAGS.filter(([t]) => !coveredTags.has(t))
const extra = [...coveredTags].filter(t => !PIPELINE_TAGS.some(([p]) => p === t)).sort()

const bySemantic = {}
for (const a of assets) bySemantic[a.semantic] = (bySemantic[a.semantic] ?? 0) + 1

const md = `# Asset Library Coverage Report

Generated by \`tools/build-asset-manifest.mjs\`. Re-run after adding packs.

## Library contents

| Metric | Value |
|---|---|
| Assets scanned | ${assets.length} |
| Assets in pools | ${manifest.counts.pooled} |
| Flagged for review | ${reviewFlags.length} |
| Weighted pools (tag × style) | ${Object.keys(pools).length} |

By semantic type: ${Object.entries(bySemantic).map(([k, v]) => `**${k}** ${v}`).join(' · ')}

## Pipeline tags covered (${covered.length}/${PIPELINE_TAGS.length})

| OSM tag | Need | Pool sizes |
|---|---|---|
${covered.map(([t, d]) => `| \`${t}\` | ${d} | ${Object.values(pools).filter(p => p.osmTag === t).map(p => `${p.style}: ${p.entries.length}`).join(', ')} |`).join('\n')}

## Missing — no assets in library (${missing.length}/${PIPELINE_TAGS.length})

| OSM tag | Need |
|---|---|
${missing.map(([t, d]) => `| \`${t}\` | ${d} |`).join('\n')}

> Missing tags fall back to CityBuilder's procedural generators — nothing breaks,
> but these are the acquisition priorities for a AAA look: **trees, street lights,
> benches, signs, hydrants, bus stops, fences, vehicles, fountains**.

## Tags supplied beyond the current pipeline (${extra.length})

${extra.map(t => `\`${t}\``).join(' · ') || '—'}

## Flagged for review (${reviewFlags.length})

${reviewFlags.length ? `| Asset | Flags | Size (m) | Tris |\n|---|---|---|---|\n${reviewFlags.map(r => `| ${r.id} | ${r.flags.join(', ')} | ${r.sizeMeters ? `${r.sizeMeters.x}×${r.sizeMeters.y}×${r.sizeMeters.z}` : '—'} | ${r.triangles} |`).join('\n')}` : 'None.'}
`
writeFileSync(OUT_COVERAGE, md)

console.log(`assets: ${assets.length} · pools: ${Object.keys(pools).length} · flagged: ${reviewFlags.length}`)
console.log(`coverage: ${covered.length}/${PIPELINE_TAGS.length} pipeline tags covered, ${missing.length} missing`)
for (const r of reviewFlags) console.log(`  review: ${r.id} [${r.flags.join(', ')}]`)
