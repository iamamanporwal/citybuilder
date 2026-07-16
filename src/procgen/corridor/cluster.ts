import { discRadius } from '../roadNetwork'
import type { RoadGraph } from './graph'

// Junction consolidation (Road Corridor Redesign §15) — the osm2streets /
// OSMnx move applied to our graph. OSM maps a big junction as a CLUSTER of
// nodes a few metres apart joined by 2–15 m internal link ways (turn lanes,
// dual-carriageway splits). Treating each node as its own junction gives every
// bridgehead a stack of overlapping discs at different solved heights and
// ribbons that criss-cross them — the "pancake pile" artifact.
//
// Rules (deterministic, all metric, gated on elevation compatibility so
// grade-SEPARATED levels never merge):
//   1. internal-edge contraction: an edge shorter than
//      INTERNAL_EDGE_FACTOR × (radA + radB) is junction interior — its two end
//      nodes merge (osm2streets' "short road" consolidation).
//   2. proximity: two junction-degree nodes whose discs overlap
//      (dist ≤ PROXIMITY_FACTOR × (radA + radB)) merge (OSMnx node buffering).
//   3. |Δz| gates on both rules; a cluster never grows beyond MAX_SPAN_M so a
//      chain of close junctions along a street can't swallow a whole block.
//
// The solve then CONTRACTS each cluster to one super-node, so the entire
// junction settles at ONE height and every arm ramps smoothly into it; the
// renderer draws one merged patch (union of member discs) instead of N discs.

export const INTERNAL_EDGE_FACTOR = 1.5
export const PROXIMITY_FACTOR = 1.0
const Z_GATE_EDGE = 2.0 // m — contracting an edge steeper than this would flatten a real ramp
const Z_GATE_PROXIMITY = 1.2
const MAX_SPAN_M = 45 // max cluster bbox diagonal (incl. disc radii)

export interface JunctionClusters {
  /** member node key → canonical cluster key (present only for multi-node clusters; canonical maps to itself). */
  alias: Map<string, string>
  /** canonical key → all member keys (sorted). */
  clusters: Map<string, string[]>
}

interface Box {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Consolidate junction node clusters of `graph`, judged at solved heights `z`. */
export function clusterJunctions(graph: RoadGraph, z: Map<string, number>): JunctionClusters {
  // per-node disc radius = widest incident arm's disc
  const radius = new Map<string, number>()
  for (const [key, n] of graph.nodes) {
    let w = 0
    for (const inc of n.incident) w = Math.max(w, graph.edges.get(inc.edgeId)!.seg.widthM)
    radius.set(key, discRadius(w))
  }

  // union-find with per-root bbox (node positions dilated by their radii)
  const parent = new Map<string, string>()
  const box = new Map<string, Box>()
  for (const [key, n] of graph.nodes) {
    parent.set(key, key)
    const r = radius.get(key)!
    box.set(key, { minX: n.p.x - r, maxX: n.p.x + r, minZ: n.p.z - r, maxZ: n.p.z + r })
  }
  const find = (k: string): string => {
    let root = k
    while (parent.get(root) !== root) root = parent.get(root)!
    while (parent.get(k) !== root) {
      const next = parent.get(k)!
      parent.set(k, root)
      k = next
    }
    return root
  }
  const tryUnion = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const ba = box.get(ra)!
    const bb = box.get(rb)!
    const merged: Box = {
      minX: Math.min(ba.minX, bb.minX),
      maxX: Math.max(ba.maxX, bb.maxX),
      minZ: Math.min(ba.minZ, bb.minZ),
      maxZ: Math.max(ba.maxZ, bb.maxZ),
    }
    if (Math.hypot(merged.maxX - merged.minX, merged.maxZ - merged.minZ) > MAX_SPAN_M) return
    // canonical root = lexicographically smallest — deterministic on any machine
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra]
    parent.set(child, root)
    box.set(root, merged)
  }

  const zOf = (k: string) => z.get(k) ?? 0
  const degree = (k: string) => graph.nodes.get(k)!.incident.length

  // candidate unions, sorted (metric, keyA, keyB) so union order is deterministic
  const candidates: { d: number; a: string; b: string }[] = []

  // rule 1 — internal edges
  for (const [, e] of graph.edges) {
    if (degree(e.startKey) < 2 || degree(e.endKey) < 2) continue
    const limit = INTERNAL_EDGE_FACTOR * (radius.get(e.startKey)! + radius.get(e.endKey)!)
    if (e.length > limit) continue
    if (Math.abs(zOf(e.startKey) - zOf(e.endKey)) > Z_GATE_EDGE) continue
    const [a, b] = e.startKey < e.endKey ? [e.startKey, e.endKey] : [e.endKey, e.startKey]
    candidates.push({ d: e.length, a, b })
  }

  // rule 2 — overlapping discs (grid hash keeps it near-linear)
  const CELL = 18
  const grid = new Map<string, string[]>()
  const cellOf = (x: number, zc: number) => `${Math.floor(x / CELL)},${Math.floor(zc / CELL)}`
  const keys = [...graph.nodes.keys()].sort()
  for (const k of keys) {
    if (degree(k) < 2) continue
    const p = graph.nodes.get(k)!.p
    const cell = cellOf(p.x, p.z)
    if (!grid.has(cell)) grid.set(cell, [])
    grid.get(cell)!.push(k)
  }
  for (const k of keys) {
    if (degree(k) < 2) continue
    const n = graph.nodes.get(k)!
    const cx = Math.floor(n.p.x / CELL)
    const cz = Math.floor(n.p.z / CELL)
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const o of grid.get(`${ix},${iz}`) ?? []) {
          if (o <= k) continue // each unordered pair once
          const m = graph.nodes.get(o)!
          const dist = Math.hypot(m.p.x - n.p.x, m.p.z - n.p.z)
          if (dist > PROXIMITY_FACTOR * (radius.get(k)! + radius.get(o)!)) continue
          if (Math.abs(zOf(k) - zOf(o)) > Z_GATE_PROXIMITY) continue
          candidates.push({ d: dist, a: k, b: o })
        }
      }
    }
  }

  candidates.sort((p, q) => p.d - q.d || (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : 1))
  for (const c of candidates) tryUnion(c.a, c.b)

  // collect multi-node clusters
  const members = new Map<string, string[]>()
  for (const k of keys) {
    const root = find(k)
    if (!members.has(root)) members.set(root, [])
    members.get(root)!.push(k)
  }
  const alias = new Map<string, string>()
  const clusters = new Map<string, string[]>()
  for (const [root, list] of members) {
    if (list.length < 2) continue
    list.sort()
    clusters.set(root, list)
    for (const k of list) alias.set(k, root)
  }
  return { alias, clusters }
}
