// Live Overpass fetch for a user-selected bounding box, with mirror fallback
// and a small localStorage cache so the last city survives a reload.

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

export interface FetchOptions {
  trees: boolean
  signals: boolean
}

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

function buildQuery(b: BBox, opts: FetchOptions): string {
  const bbox = `(${b.south},${b.west},${b.north},${b.east})`
  const parts = [
    `way["building"]${bbox};`,
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service|footway|cycleway)$"]${bbox};`,
    // land use / land cover polygons: rendered (water, parks) + zoning context
    `way["landuse"~"^(residential|commercial|retail|industrial|grass|forest|meadow|reservoir)$"]${bbox};`,
    `way["natural"~"^(water|wood|grassland|coastline|wetland|beach|sand)$"]${bbox};`,
    // streams/ditches/drains deliberately not fetched: never rendered as water
    `way["waterway"~"^(river|canal|riverbank)$"]${bbox};`,
    `way["leisure"~"^(park|garden|pitch|playground)$"]${bbox};`,
    `way["barrier"~"^(fence|wall)$"]${bbox};`,
    `way["amenity"="fountain"]${bbox};`,
    `node["highway"="street_lamp"]${bbox};`,
    `node["amenity"~"^(bench|waste_basket|fountain)$"]${bbox};`,
    `node["highway"="bus_stop"]${bbox};`,
    `node["historic"~"^(memorial|monument)$"]${bbox};`,
    `node["tourism"="artwork"]${bbox};`,
    `way["historic"~"^(memorial|monument)$"]${bbox};`,
  ]
  if (opts.signals) parts.push(`node["highway"="traffic_signals"]${bbox};`)
  if (opts.trees) parts.push(`node["natural"="tree"]${bbox};`)
  return `[out:json][timeout:90];(${parts.join('')});out body geom;`
}

export async function fetchOsmArea(
  bbox: BBox,
  opts: FetchOptions,
  onStatus: (msg: string) => void,
): Promise<any> {
  const query = buildQuery(bbox, opts)
  let lastError: unknown = null
  for (let i = 0; i < MIRRORS.length; i++) {
    const mirror = MIRRORS[i]
    try {
      onStatus(
        i === 0
          ? 'Querying OpenStreetMap for your area…'
          : `Primary server busy — trying mirror ${i + 1}…`,
      )
      const res = await fetch(mirror, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onStatus('Downloading map data…')
      const json = await res.json()
      if (!json.elements) throw new Error('Malformed Overpass response')
      return json
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`All Overpass servers failed (${lastError}). Try a smaller area or retry in a minute.`)
}

// ---- last-city cache (best effort; skipped when over localStorage quota) ----

const CACHE_KEY = 'cb_city_cache_v1'

export interface CachedCity {
  name: string
  raw: any
}

export function cacheCity(name: string, raw: any): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ name, raw }))
  } catch {
    localStorage.removeItem(CACHE_KEY)
  }
}

export function loadCachedCity(): CachedCity | null {
  try {
    const s = localStorage.getItem(CACHE_KEY)
    if (!s) return null
    const c = JSON.parse(s)
    if (c && c.name && c.raw?.elements) return c
  } catch {}
  return null
}
