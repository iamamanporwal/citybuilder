// ---------- City Graph (Layer 1: data — the source of truth) ----------

export interface Vec2 {
  x: number
  z: number
}

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'unclassified'
  | 'living_street'
  | 'pedestrian'
  | 'service'
  | 'footway'
  | 'cycleway'

export interface RoadSegment {
  id: string
  name?: string
  roadClass: RoadClass
  points: Vec2[] // centerline, local ENU meters
  widthM: number // full carriageway width
  lanes: number
  oneway: boolean
  bridge: boolean
  tunnel: boolean
  layer: number // OSM layer for grade separation
  surfaceTag?: string // OSM surface=* if present
  structure?: string // OSM bridge:structure=* (suspension/cable-stayed/…) — landmark recognition
  wikidata?: string // OSM wikidata QID — landmark recognition (survives to 3D build)
  // FAITHFUL traffic tier (Road-updates.md §1, §8.4). Parsed from OSM; a region
  // default is applied in the resolver where these are absent, and flagged
  // low-confidence in the coverage report so a human verifies before training use.
  maxspeedKmh?: number // OSM maxspeed resolved to km/h (undefined ⇒ untagged; resolver fills a region default)
  turnLanes?: string[] // OSM turn:lanes, one entry per lane L→R, e.g. ['left','through','through;right']
  roundabout?: boolean // OSM junction=roundabout|mini_roundabout (implicitly one-way)
  centerLat: number
  centerLng: number
}

export type AreaKind = 'water' | 'park' | 'grass' | 'sand' | 'forest' | 'residential' | 'commercial' | 'retail' | 'industrial'

export interface AreaFeature {
  id: string
  kind: AreaKind
  ring: Vec2[]
  holes?: Vec2[][] // interior land islands cut out of the surface (e.g. islands in a sea)
  render: boolean // zoning-only areas (residential etc.) aren't drawn
  areaM2?: number // shoelace area in local meters (set for water; audited by waterAuditLint)
  provenance?: string // which whitelist rule admitted the feature, e.g. 'natural=water(lake)'
}

export interface BuildingFeature {
  id: string
  name?: string
  footprint: Vec2[] // local ENU meters, closed ring (last != first)
  heightM: number
  levels?: number
  heightSource: 'height-tag' | 'levels' | 'estimated'
  tier: 'landmark' | 'notable' | 'generic'
  lat: number
  lng: number
  wikidata?: string
  tags: Record<string, string>
}

export interface PointFeature {
  id: string
  kind:
    | 'traffic_signal'
    | 'tree'
    | 'street_lamp'
    | 'bench'
    | 'waste_basket'
    | 'fountain'
    | 'statue'
    | 'bus_stop'
    // FAITHFUL traffic devices (Road-updates.md §8.1/§8.3)
    | 'stop_sign' // highway=stop
    | 'give_way' // highway=give_way (yield)
    | 'crossing' // highway=crossing (pedestrian)
    | 'road_sign' // traffic_sign=* (type carried in signType)
  position: Vec2
  lat: number
  lng: number
  name?: string
  wikidata?: string
  /** OSM classifier for a device: traffic_sign value for road_sign, crossing=* for crossing. */
  signType?: string
}

export interface BarrierFeature {
  id: string
  kind: 'fence' | 'wall'
  points: Vec2[]
}

export interface CityGraph {
  cityName: string
  origin: { lat: number; lng: number }
  bboxLatLng: { south: number; west: number; north: number; east: number }
  attribution: string
  license: string
  roads: RoadSegment[]
  buildings: BuildingFeature[]
  areas: AreaFeature[]
  barriers: BarrierFeature[]
  points: PointFeature[]
  report: {
    buildingCount: number
    buildingsWithHeight: number
    namedBuildings: number
    roadCount: number
    roadsWithLanes: number
    signalCount: number
    treeCount: number
  }
}

// ---------- Scene objects (Layer 2: geometry metadata) ----------

export type ObjectType =
  | 'building'
  | 'road'
  | 'traffic-signal'
  | 'vegetation'
  | 'ground'
  | 'sidewalks'
  | 'markings'
  | 'area'
  | 'street-furniture'
  | 'bridge-structure'

export type AssetState = 'procedural' | 'generated' | 'library' | 'uploaded'
export type ProviderId = 'procedural' | 'trellis-local' | 'meshy' | 'sketchfab' | 'upload'

export interface Transform {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface AssetInfo {
  state: AssetState
  provider: ProviderId | null
  license: string
  approved: boolean
  cacheKey?: string
}

export interface RealWorldRef {
  lat: number
  lng: number
  mapUrl: string
  streetViewUrl: string
  wikidata?: string
  name?: string
}

export interface SceneObject {
  id: string
  type: ObjectType
  name: string
  tier?: 'landmark' | 'notable' | 'generic'
  locked: boolean
  visible: boolean
  deleted: boolean
  transform: Transform
  asset: AssetInfo
  realworld?: RealWorldRef
  // type-specific metadata shown in inspector
  meta: Record<string, string | number | boolean | undefined>
}

// ---------- Jobs (async generation) ----------

export interface GenerationJob {
  objectId: string
  provider: ProviderId
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number // 0..1
  message: string
  startedAt: number
}

export type CameraMode = 'orbit' | 'fly' | 'drive'
export type GizmoMode = 'translate' | 'rotate' | 'scale'

export const DEG2RAD = Math.PI / 180
