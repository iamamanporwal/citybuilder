import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { cityGraph } from '../scene/registry'
import { useCameraHud } from '../state/cameraHud'

// Must match the forward projection in ingest/overpass.ts (local ENU frame:
// x = east metres, z = south metres, so north is -z). We invert it here to turn
// the live camera position back into geographic lat/lon.
const METERS_PER_DEG_LAT = 111320

// throttle the DOM read-out to ~8 Hz — plenty for a "where am I" HUD, and keeps
// us from re-rendering the overlay on every one of ~60 frames.
const INTERVAL = 1 / 8

// Lives inside the <Canvas>; works in every camera mode (orbit / fly / drive)
// because they all drive the same useThree() camera. It only pushes to the
// store, so it never re-renders anything itself.
export function CoordTracker() {
  const camera = useThree((s) => s.camera)
  const set = useCameraHud((s) => s.set)
  const acc = useRef(0)

  useFrame((_, dt) => {
    acc.current += dt
    if (acc.current < INTERVAL) return
    acc.current = 0

    const p = camera.position
    const x = Math.round(p.x * 10) / 10
    const y = Math.round(p.y * 10) / 10
    const z = Math.round(p.z * 10) / 10

    let lat: number | null = null
    let lon: number | null = null
    const origin = cityGraph?.origin
    if (origin) {
      const mPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)
      lat = origin.lat - z / METERS_PER_DEG_LAT
      lon = origin.lng + x / mPerDegLng
      // 6 dp ≈ 0.1 m of precision — enough to point at a specific building.
      lat = Math.round(lat * 1e6) / 1e6
      lon = Math.round(lon * 1e6) / 1e6
    }

    set({ x, y, z, lat, lon })
  })

  return null
}
