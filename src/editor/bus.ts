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
