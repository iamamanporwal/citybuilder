import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEditor } from '../state/store'
import { loadCachedCity, type BBox } from '../ingest/overpassFetch'
import { buildCityFromArea, buildFromCache, buildSampleCity } from '../app/buildCity'

// Full-screen location picker: search a place, drag/resize the selection
// rectangle, and build a 3D city from exactly that area.

const MAX_AREA_KM2 = 4
const WARN_AREA_KM2 = 2.5
const KM_PER_DEG_LAT = 110.574

interface SearchResult {
  display_name: string
  lat: string
  lon: string
}

interface SelStats {
  wKm: number
  hKm: number
  areaKm2: number
}

function kmPerDegLng(lat: number) {
  return 111.32 * Math.cos((lat * Math.PI) / 180)
}

function boundsStats(b: L.LatLngBounds): SelStats {
  const midLat = (b.getSouth() + b.getNorth()) / 2
  const wKm = (b.getEast() - b.getWest()) * kmPerDegLng(midLat)
  const hKm = (b.getNorth() - b.getSouth()) * KM_PER_DEG_LAT
  return { wKm, hKm, areaKm2: wKm * hKm }
}

/** Rectangle with corner resize handles, drag-to-move, and live dimension labels. */
function createSelection(map: L.Map, onChange: (b: L.LatLngBounds) => void) {
  const c = map.getCenter()
  const dLat = 0.55 / KM_PER_DEG_LAT // ~1.1 km tall
  const dLng = 0.65 / kmPerDegLng(c.lat) // ~1.3 km wide
  let bounds = L.latLngBounds([c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng])

  const rect = L.rectangle(bounds, {
    color: '#2f6fd0',
    weight: 2,
    fillColor: '#4c9aff',
    fillOpacity: 0.1,
    interactive: true,
  }).addTo(map)

  const handleIcon = L.divIcon({ className: 'sel-handle', iconSize: [16, 16] })
  const corners = () => [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthEast(), bounds.getSouthWest()]
  const handles = corners().map((p) =>
    L.marker(p, { icon: handleIcon, draggable: true, keyboard: false }).addTo(map),
  )

  const widthLabel = L.tooltip({ permanent: true, direction: 'top', className: 'dim-label', offset: [0, -6] })
    .setLatLng(bounds.getNorthWest())
    .addTo(map)
  const heightLabel = L.tooltip({ permanent: true, direction: 'left', className: 'dim-label', offset: [-6, 0] })
    .setLatLng(bounds.getNorthWest())
    .addTo(map)

  function refresh() {
    rect.setBounds(bounds)
    const pts = corners()
    handles.forEach((h, i) => h.setLatLng(pts[i]))
    const s = boundsStats(bounds)
    widthLabel.setLatLng(L.latLng(bounds.getNorth(), (bounds.getWest() + bounds.getEast()) / 2))
    widthLabel.setContent(`${s.wKm.toFixed(2)} km`)
    heightLabel.setLatLng(L.latLng((bounds.getSouth() + bounds.getNorth()) / 2, bounds.getWest()))
    heightLabel.setContent(`${s.hKm.toFixed(2)} km`)
    onChange(bounds)
  }

  // corner resize (opposite corner stays anchored)
  handles.forEach((h, i) => {
    h.on('drag', () => {
      const p = h.getLatLng()
      const anchor = corners()[(i + 2) % 4]
      bounds = L.latLngBounds(p, anchor)
      refresh()
    })
  })

  // drag rectangle to move
  let dragStart: L.LatLng | null = null
  let startBounds: L.LatLngBounds | null = null
  rect.on('mousedown', (e: L.LeafletMouseEvent) => {
    dragStart = e.latlng
    startBounds = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast())
    map.dragging.disable()
    L.DomEvent.stop(e)
  })
  map.on('mousemove', (e: L.LeafletMouseEvent) => {
    if (!dragStart || !startBounds) return
    const dLat2 = e.latlng.lat - dragStart.lat
    const dLng2 = e.latlng.lng - dragStart.lng
    bounds = L.latLngBounds(
      [startBounds.getSouth() + dLat2, startBounds.getWest() + dLng2],
      [startBounds.getNorth() + dLat2, startBounds.getEast() + dLng2],
    )
    refresh()
  })
  const endDrag = () => {
    dragStart = null
    startBounds = null
    map.dragging.enable()
  }
  map.on('mouseup', endDrag)
  map.on('mouseout', (e: L.LeafletMouseEvent) => {
    if ((e.originalEvent as MouseEvent).relatedTarget === null) endDrag()
  })

  refresh()
  return {
    getBounds: () => bounds,
    moveTo(center: L.LatLng) {
      const halfLat = (bounds.getNorth() - bounds.getSouth()) / 2
      const halfLng = (bounds.getEast() - bounds.getWest()) / 2
      bounds = L.latLngBounds(
        [center.lat - halfLat, center.lng - halfLng],
        [center.lat + halfLat, center.lng + halfLng],
      )
      refresh()
    },
  }
}

export function AreaPicker() {
  const mapRef = useRef<HTMLDivElement>(null)
  const selRef = useRef<ReturnType<typeof createSelection> | null>(null)
  const leafletRef = useRef<L.Map | null>(null)
  const [stats, setStats] = useState<SelStats>({ wKm: 0, hKm: 0, areaKm2: 0 })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [placeName, setPlaceName] = useState('Lower Manhattan, New York')
  const [withTrees, setWithTrees] = useState(true)
  const [withSignals, setWithSignals] = useState(true)
  const loadError = useEditor((s) => s.loadError)
  const cached = loadCachedCity()

  useEffect(() => {
    if (!mapRef.current) return
    const map = L.map(mapRef.current, { zoomControl: false, attributionControl: false }).setView(
      [40.7065, -74.011],
      14,
    )
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map)
    selRef.current = createSelection(map, (b) => setStats(boundsStats(b)))
    leafletRef.current = map
    return () => {
      map.remove()
      leafletRef.current = null
      selRef.current = null
    }
  }, [])

  // debounced place search (Nominatim, free, no key)
  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([])
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`,
      )
        .then((r) => r.json())
        .then((d) => setResults(Array.isArray(d) ? d : []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 450)
    return () => clearTimeout(t)
  }, [query])

  const pickResult = (r: SearchResult) => {
    const center = L.latLng(parseFloat(r.lat), parseFloat(r.lon))
    leafletRef.current?.setView(center, 14)
    selRef.current?.moveTo(center)
    setPlaceName(r.display_name.split(',').slice(0, 2).join(',').trim())
    setResults([])
    setQuery('')
  }

  const overLimit = stats.areaKm2 > MAX_AREA_KM2
  const warn = !overLimit && stats.areaKm2 > WARN_AREA_KM2

  const build = () => {
    const b = selRef.current?.getBounds()
    if (!b || overLimit) return
    const bbox: BBox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }
    buildCityFromArea(bbox, placeName, { trees: withTrees, signals: withSignals })
  }

  return (
    <div className="picker">
      <div ref={mapRef} className="picker-map" />

      <div className="picker-brand">
        <div className="brand">
          <span className="brand-icon">🏙️</span> CityBuilder
        </div>
        <div className="picker-search-wrap">
          <input
            className="picker-search"
            placeholder="🔍 Search a city or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {(results.length > 0 || searching) && (
            <div className="picker-results">
              {searching && <div className="picker-result muted">Searching…</div>}
              {results.map((r, i) => (
                <div key={i} className="picker-result" onClick={() => pickResult(r)}>
                  📍 {r.display_name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="picker-panel">
        <h1>Build a 3D city</h1>
        <p className="picker-sub">
          Move & resize the rectangle over the streets you want, then build. Roads, buildings and
          props are generated from real OpenStreetMap data.
        </p>

        <div className={`sel-stats ${overLimit ? 'over' : warn ? 'warn' : ''}`}>
          <div className="sel-dims">
            {stats.wKm.toFixed(2)} × {stats.hKm.toFixed(2)} km
          </div>
          <div className="sel-area">
            {stats.areaKm2.toFixed(2)} km²
            <span className="sel-max"> / max {MAX_AREA_KM2} km²</span>
          </div>
          {overLimit && <div className="sel-note">Too large — shrink the rectangle to build.</div>}
          {warn && <div className="sel-note">Large area — dense city centers may load slowly.</div>}
        </div>

        <div className="picker-layers">
          <label className="layer locked">
            <input type="checkbox" checked disabled /> 🛣️ Roads & 🏢 Buildings
            <span className="layer-tag">always on</span>
          </label>
          <label className="layer">
            <input type="checkbox" checked={withTrees} onChange={(e) => setWithTrees(e.target.checked)} />
            🌳 Trees
          </label>
          <label className="layer">
            <input
              type="checkbox"
              checked={withSignals}
              onChange={(e) => setWithSignals(e.target.checked)}
            />
            🚦 Traffic signals
          </label>
        </div>

        {loadError && <div className="picker-error">⚠ {loadError}</div>}

        <button className="picker-build" disabled={overLimit} onClick={build}>
          ⚡ Build this area
        </button>
        <div className="picker-alt">
          <button onClick={() => buildSampleCity()}>Load sample · Lower Manhattan</button>
          {cached && <button onClick={() => buildFromCache(cached)}>Continue · {cached.name}</button>}
        </div>
        <div className="picker-attr">Map © OpenStreetMap contributors · © CARTO · Data ODbL</div>
      </div>
    </div>
  )
}
