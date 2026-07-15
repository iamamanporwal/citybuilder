import type { RoadSegment } from '../../types'
import { analyzeRoadNodes, elevationProfile, rampSpecFor } from '../roadNetwork'
import { isCorridorElevationEnabled } from './config'
import { solveNetworkElevation, type ElevationStats } from './elevation'

// Road Corridor Redesign — Stage 2 consumer seam (E2).
//
// The renderer (procgen/roads), the collider builder (physics/colliders) and the
// semantics exporter (export/semantics) all read the road y-channel through this
// one function, so there is a single source of truth. Flag-on routes through the
// network solve; flag-off returns a legacy adapter with the identical interface
// and byte-identical output, so the whole invariant suite stays green and the
// feature is instant-A/B (see config.ts).

export interface RoadElevation {
  /** True-metre elevation profile (0 = grade) for `r` at the caller's stations `cum`. */
  profileFor(r: RoadSegment, cum: number[]): number[]
  /**
   * Solved true-metre elevation at a graph node (0 = grade). The renderer reads
   * this to sit junction discs on the solved node height; flag-off it returns the
   * legacy per-node bridge elevation, so junction geometry is byte-identical.
   */
  nodeElevation(key: string): number
  /** Solve diagnostics when the network solve ran; null in legacy mode. */
  readonly stats: ElevationStats | null
}

// The renderer, collider builder and semantics exporter each ask for the
// elevation of the SAME roads array within one scene build. The solve is
// deterministic and side-effect-free, so memoise it per (roads array, flag
// state): a scene build does one solve, not three. The WeakMap keys on array
// identity, so a new build (new array) never sees a stale result.
const cache = new WeakMap<RoadSegment[], { enabled: boolean; value: RoadElevation }>()

export function buildRoadElevation(roads: RoadSegment[]): RoadElevation {
  const enabled = isCorridorElevationEnabled()
  const hit = cache.get(roads)
  if (hit && hit.enabled === enabled) return hit.value
  const value = enabled ? solveNetworkElevation(roads) : legacyElevation(roads)
  cache.set(roads, { enabled, value })
  return value
}

// Legacy adapter: the exact per-segment ramp math roads.ts/colliders.ts/
// semantics.ts used inline before the seam existed.
function legacyElevation(roads: RoadSegment[]): RoadElevation {
  const nodes = analyzeRoadNodes(roads)
  return {
    profileFor(r, cum) {
      const spec = r.points.length >= 2 ? rampSpecFor(r, cum[cum.length - 1], nodes) : null
      return elevationProfile(spec, cum)
    },
    // Legacy junction discs sat at the per-node `bridgeElev`; reading it here
    // keeps flag-off geometry byte-identical while the network path (below)
    // supplies the solved node height.
    nodeElevation: (key) => nodes.get(key)?.bridgeElev ?? 0,
    stats: null,
  }
}

export { isCorridorElevationEnabled, setCorridorElevationEnabled, withCorridorElevation } from './config'
export { buildRoadGraph } from './graph'
export { solveNetworkElevation } from './elevation'
export type { NetworkElevation, EdgeGrades, ElevationStats } from './elevation'
export type { RoadGraph, GraphNode, GraphEdge } from './graph'
