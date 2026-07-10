import * as THREE from 'three'

// Tiny event bus for one-shot camera framing requests (hierarchy double-click, F key).

export interface FrameRequest {
  center: THREE.Vector3
  radius: number
}

let frameListener: ((r: FrameRequest) => void) | null = null

export const frameBus = {
  emit(r: FrameRequest) {
    frameListener?.(r)
  },
  on(cb: (r: FrameRequest) => void) {
    frameListener = cb
    return () => {
      if (frameListener === cb) frameListener = null
    }
  },
}

// Road polylines for drive-mode spawning (filled at scene build time).
export const drivableRoads: { pts: { x: number; z: number }[]; width: number }[] = []

// Last orbit-camera target, published by CameraRig each frame — the drive sim
// spawns the car on the road nearest to where the user was looking.
export const lastOrbitTarget = new THREE.Vector3()

/** Closest point on any drivable road to (x, z), with the road heading there. */
export function nearestRoadPoint(x: number, z: number) {
  let best = { d: Infinity, x: 0, z: 0, hx: 0, hz: 1 }
  for (const r of drivableRoads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const abx = b.x - a.x
      const abz = b.z - a.z
      const len2 = abx * abx + abz * abz || 1
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2
      t = Math.max(0, Math.min(1, t))
      const px = a.x + abx * t
      const pz = a.z + abz * t
      const d = (x - px) * (x - px) + (z - pz) * (z - pz)
      if (d < best.d) {
        const l = Math.sqrt(len2)
        best = { d, x: px, z: pz, hx: abx / l, hz: abz / l }
      }
    }
  }
  return best
}
