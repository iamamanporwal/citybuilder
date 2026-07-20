import { useState } from 'react'
import { useCameraHud } from '../state/cameraHud'
import { useEditor } from '../state/store'

const fmt = (n: number) => n.toFixed(1)

// Always-on camera position read-out. Sits in the corner of the viewport in
// every mode (orbit / fly / drive) so you always know where you are on the map,
// and the 📋 button copies a compact location string you can paste back to say
// "improve this spot".
export function CoordHud() {
  const { x, y, z, lat, lon } = useCameraHud()
  const mode = useEditor((s) => s.cameraMode)
  const [copied, setCopied] = useState(false)

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
      </div>
      <button className="coord-copy" onClick={copy} title="Copy location to clipboard">
        {copied ? '✓' : '📋'}
      </button>
    </div>
  )
}
