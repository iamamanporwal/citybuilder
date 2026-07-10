import type { Vec2 } from '../types'

// ---------- Context Resolver types ----------
// The resolver maps (region × feature-type × OSM tags × land-cover × climate)
// to concrete content decisions: asset pool picks, material sets, road
// cross-sections, marking styles and prop rules. Deterministic via hash(id).

export type RegionId = 'us' | 'uk' | 'eu-west' | 'eu-central' | 'eu-south' | 'jp' | 'in' | 'au' | 'generic'

export type ClimateZone = 'tropical' | 'arid' | 'mediterranean' | 'temperate' | 'continental' | 'boreal'

export type LandCoverClass = 'built' | 'trees' | 'grass' | 'water' | 'bare'

export type ZoneKind = 'residential' | 'commercial' | 'retail' | 'industrial' | 'park' | 'none'

export type TreeSpecies = 'broadleaf' | 'columnar' | 'conifer' | 'palm' | 'acacia'

export type FacadeSet =
  | 'brick-red'
  | 'brick-brown'
  | 'stucco-warm'
  | 'stucco-cool'
  | 'concrete-panel'
  | 'office-glass'
  | 'curtainwall-dark'
  | 'storefront-mixed'

export type RoofSet = 'bitumen-dark' | 'tile-red' | 'metal-pale' | 'concrete-pale'

export type RoadSurfaceSet = 'asphalt-new' | 'asphalt-worn' | 'asphalt-patched' | 'cobble' | 'pavers' | 'gravel'

export interface WeightedVariant<T> {
  value: T
  weight: number
}

export interface RegionPack {
  id: RegionId
  label: string
  drivingSide: 'right' | 'left'
  centerline: 'double-yellow' | 'single-yellow-dashed' | 'white-dashed' | 'white-solid'
  crosswalk: 'continental' | 'zebra' | 'ladder'
  signShape: 'us-rect' | 'eu-circle' | 'jp-mix'
  lampStyle: 'cobra' | 'euro-post' | 'heritage'
}

export interface MarkingStyle {
  centerColor: 'yellow' | 'white'
  centerPattern: 'double-solid' | 'dashed' | 'solid'
  crosswalk: RegionPack['crosswalk']
}

export interface CrossSectionSpec {
  sidewalks: boolean
  sidewalkWidth: number
  curbHeight: number
}

export interface PropRules {
  lampSpacing: number | null // meters between streetlights, null = none
  benchDensity: number // benches per 100 m of sidewalk (retail/park zones)
  binDensity: number
  treeSpacing: number | null // generated street trees when OSM has none
}

export interface BuildingResolution {
  facade: FacadeSet
  roof: RoofSet
  tint: string
  uvSeed: [number, number]
  provenance: string[]
  confidence: number
}

export interface RoadResolution {
  surface: RoadSurfaceSet
  marking: MarkingStyle
  crossSection: CrossSectionSpec
  decalDensity: number // wear decals per 100 m
  provenance: string[]
  confidence: number
}

export interface TreeResolution {
  species: TreeSpecies
  scale: number
  tint: number // hue shift -1..1
}

/** Everything resolved once per build, before per-feature resolution. */
export interface ResolvedContext {
  matrixVersion: string
  region: RegionPack
  climate: ClimateZone
  treePool: WeightedVariant<TreeSpecies>[]
  treePoolSource: 'gbif' | 'climate-default'
  landCoverSource: 'worldcover' | 'osm-derived' | 'none'
  landCoverAt: (p: Vec2) => LandCoverClass
  zoneAt: (p: Vec2) => ZoneKind
  provenance: string[]
}
