import { useState } from 'react'
import * as THREE from 'three'
import { useCameraHud } from '../state/cameraHud'
import { useEditor } from '../state/store'
import { cityGraph } from '../scene/registry'
import { frameBus } from '../editor/bus'

const fmt = (n: number) => n.toFixed(1)

// Must match the forward projection in ingest/overpass.ts (local ENU frame:
// x = east metres, z = south metres, so north is -z).
const METERS_PER_DEG_LAT = 111320

// Match a single DMS token like 50°06'07.09"N (minutes/seconds optional, unicode
// prime/quote marks allowed). Hemisphere letter tells us lat (N/S) vs lon (E/W),
// so component order doesn't matter.
const DMS_TOKEN =
  /(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″”]\s*)?([NSEWnsew])/g

function parseDMS(raw: string): { lat: number; lon: number } | null {
  const found: { deg: number; hemi: string }[] = []
  for (const m of raw.matchAll(DMS_TOKEN)) {
    const deg = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600
    const hemi = m[4].toUpperCase()
    const signed = hemi === 'S' || hemi === 'W' ? -deg : deg
    found.push({ deg: signed, hemi })
  }
  if (found.length !== 2) return null
  const latPart = found.find((f) => f.hemi === 'N' || f.hemi === 'S')
  const lonPart = found.find((f) => f.hemi === 'E' || f.hemi === 'W')
  if (!latPart || !lonPart) return null
  return { lat: latPart.deg, lon: lonPart.deg }
}

// Parse either decimal "lat, lon" / "lat lon" or DMS 50°06'07.09"N 14°27'30.98"E.
// Returns null on anything that isn't two finite numbers in valid geo range.
function parseLatLon(raw: string): { lat: number; lon: number } | null {
  const s = raw.trim()
  let result: { lat: number; lon: number } | null = null

  if (/[°'"′″”NSEWnsew]/.test(s)) {
    result = parseDMS(s)
  } else {
    const parts = s
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      result = { lat: parts[0], lon: parts[1] }
    }
  }

  if (!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon)) return null
  const { lat, lon } = result
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return result
}

// Always-on camera position read-out. Sits in the corner of the viewport in
// every mode (orbit / fly / drive) so you always know where you are on the map,
// and the 📋 button copies a compact location string you can paste back to say
// "improve this spot". The "Go to" input jumps the camera to any lat/lon inside
// the loaded map — outside it, we toast instead of flying off into empty space.
export function CoordHud() {
  const { x, y, z, lat, lon } = useCameraHud()
  const mode = useEditor((s) => s.cameraMode)
  const [copied, setCopied] = useState(false)
  const [goto, setGoto] = useState('')

  const hasGeo = lat != null && lon != null

  const copy = () => {
    const parts = [
      hasGeo ? `lat/lon: ${lat!.toFixed(6)}, ${lon!.toFixed(6)}` : null,
      `xyz: ${fmt(x)}, ${fmt(y)}, ${fmt(z)}`,
      `mode: ${mode}`,
    ].filter(Boolean)
    const text = parts.join('  |  ')
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }

  const go = () => {
    const showToast = useEditor.getState().showToast
    const parsed = parseLatLon(goto)
    if (!parsed) {
      showToast('Enter coordinates as "lat, lon" — e.g. 50.087, 14.421')
      return
    }
    const graph = cityGraph
    if (!graph) {
      showToast('No map loaded yet')
      return
    }
    const b = graph.bboxLatLng
    if (parsed.lat < b.south || parsed.lat > b.north || parsed.lon < b.west || parsed.lon > b.east) {
      showToast(`${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)} is outside the loaded map area`)
      return
    }
    // forward projection (inverse of CoordTracker) → local ENU world position
    const origin = graph.origin
    const mPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)
    const wx = (parsed.lon - origin.lng) * mPerDegLng
    const wz = -(parsed.lat - origin.lat) * METERS_PER_DEG_LAT
    frameBus.emit({ center: new THREE.Vector3(wx, 0, wz), radius: 60 })
    showToast(`Jumped to ${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)}`)
    setGoto('')
  }

  return (
    <div className="coord-hud">
      <div className="coord-rows">
        <div className="coord-row">
          <span className="coord-key">XYZ</span>
          <span className="coord-val">
            {fmt(x)}, {fmt(y)}, {fmt(z)}
          </span>
        </div>
        <div className="coord-row">
          <span className="coord-key">LAT/LON</span>
          <span className="coord-val">
            {hasGeo ? `${lat!.toFixed(6)}, ${lon!.toFixed(6)}` : '—'}
          </span>
        </div>
        <div className="coord-row coord-goto">
          <input
            className="coord-goto-input"
            type="text"
            value={goto}
            placeholder="Go to lat, lon"
            onChange={(e) => setGoto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
            title="Type a latitude, longitude inside the loaded map and press Enter to fly there"
          />
          <button className="coord-goto-btn" onClick={go} title="Jump camera to these coordinates">
            Go
          </button>
        </div>
      </div>
      <button className="coord-copy" onClick={copy} title="Copy location to clipboard">
        {copied ? '✓' : '📋'}
      </button>
    </div>
  )
}
