import { create } from 'zustand'

// Live camera read-out shared between the in-Canvas tracker (writer) and the
// DOM overlay (reader). Mirrors the driveHud.ts pattern: a tiny standalone
// store the render loop pokes each frame, kept separate from useEditor so it
// never triggers editor re-renders.
export interface CameraHud {
  x: number
  y: number
  z: number
  lat: number | null // null until a city (with an origin) is loaded
  lon: number | null
  set: (v: { x: number; y: number; z: number; lat: number | null; lon: number | null }) => void
}

export const useCameraHud = create<CameraHud>((set) => ({
  x: 0,
  y: 0,
  z: 0,
  lat: null,
  lon: null,
  set: (v) =>
    set((s) =>
      s.x === v.x && s.y === v.y && s.z === v.z && s.lat === v.lat && s.lon === v.lon ? s : v,
    ),
}))
