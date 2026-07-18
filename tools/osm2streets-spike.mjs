// osm2streets feasibility spike (a-b-street/osm2streets, Apache-2.0).
//
// Proves we can get lane-accurate street geometry + proper intersection polygons
// out of osm2streets-js (a prebuilt WASM, no Rust build) from our existing OSM
// data, headless. This is the data foundation for a future lane-level road
// renderer that would replace the ribbon+disc geometry in procgen/roads.ts.
//
//   node tools/osm2streets-spike.mjs [path/to/raw_osm.json] [--dump out.geojson]
//
// Default input: public/data/raw_osm.json (the Lower Manhattan sample).
// Findings + integration plan: docs/osm2streets-spike.md

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// no `main`/`exports` in the package.json, so import the explicit ESM entry
import { initSync, JsStreetNetwork } from 'osm2streets-js/osm2streets_js.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const dumpIdx = args.indexOf('--dump')
const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : null
const inPath = args.find((a, i) => !a.startsWith('--') && i !== dumpIdx + 1) ?? `${root}public/data/raw_osm.json`

// wasm-bindgen "web" target: feed the .wasm bytes to initSync for a headless run.
const wasmPath = fileURLToPath(new URL('../node_modules/osm2streets-js/osm2streets_js_bg.wasm', import.meta.url))
initSync(new WebAssembly.Module(fs.readFileSync(wasmPath)))

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Overpass JSON (our ingest input) → OSM XML (what JsStreetNetwork consumes).
 * Overpass "out geom" gives each way a `nodes` id list AND an index-aligned
 * `geometry` list; many of those nodes have no standalone element, so we
 * synthesise every referenced node from the way geometry or osm2streets sees
 * ways with unresolved nodes ("intersection with no roads").
 */
function overpassToOsmXml(raw) {
  const nodes = new Map()
  for (const el of raw.elements) if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags })
  for (const el of raw.elements) {
    if (el.type === 'way' && el.nodes && el.geometry) {
      for (let i = 0; i < el.nodes.length; i++) {
        const g = el.geometry[i]
        if (g && !nodes.has(el.nodes[i])) nodes.set(el.nodes[i], { lat: g.lat, lon: g.lon })
      }
    }
  }
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
  for (const n of nodes.values()) {
    latMin = Math.min(latMin, n.lat); latMax = Math.max(latMax, n.lat)
    lonMin = Math.min(lonMin, n.lon); lonMax = Math.max(lonMax, n.lon)
  }
  const tagsOf = (t) => (t ? Object.entries(t).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('') : '')
  const parts = ['<?xml version="1.0"?>', '<osm version="0.6">', `<bounds minlat="${latMin}" minlon="${lonMin}" maxlat="${latMax}" maxlon="${lonMax}"/>`]
  for (const [id, n] of nodes) parts.push(`<node id="${id}" lat="${n.lat}" lon="${n.lon}">${tagsOf(n.tags)}</node>`)
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.nodes) continue
    parts.push(`<way id="${el.id}">${el.nodes.map((n) => `<nd ref="${n}"/>`).join('')}${tagsOf(el.tags)}</way>`)
  }
  parts.push('</osm>')
  return { xml: parts.join('\n'), nodeCount: nodes.size }
}

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'))
const { xml, nodeCount } = overpassToOsmXml(raw)
console.log(`input: ${inPath}`)
console.log(`nodes: ${nodeCount} · ways: ${raw.elements.filter((e) => e.type === 'way').length} · OSM XML: ${(xml.length / 1048576).toFixed(2)} MB`)

const options = {
  debug_each_step: false,
  dual_carriageway_experiment: false,
  sidepath_zipping_experiment: false,
  inferred_sidewalks: true,
  inferred_kerbs: true,
  osm2lanes: false,
}
const started = Date.now()
const net = new JsStreetNetwork(xml, '', options)
const lanes = JSON.parse(net.toLanePolygonsGeojson())
const laneMarkings = JSON.parse(net.toLaneMarkingsGeojson())
const intersections = JSON.parse(net.toIntersectionMarkingsGeojson())
const ms = Date.now() - started

const kinds = {}
for (const f of lanes.features) { const k = f.properties?.type ?? '?'; kinds[k] = (kinds[k] ?? 0) + 1 }
console.log(`build: ${ms} ms`)
console.log(`lane polygons: ${lanes.features.length} · kinds: ${JSON.stringify(kinds)}`)
console.log(`lane markings: ${laneMarkings.features.length} · intersection polygons: ${intersections.features.length}`)
console.log(`sample lane props: ${JSON.stringify(lanes.features[0]?.properties)}`)

if (dumpPath) {
  fs.writeFileSync(dumpPath, JSON.stringify(lanes))
  console.log(`wrote lane polygons GeoJSON → ${dumpPath}`)
}
