import { create } from 'zustand'

interface DriveHud {
  speedKmh: number
  setSpeed: (v: number) => void
}

export const useDriveHud = create<DriveHud>((set) => ({
  speedKmh: 0,
  setSpeed: (v) => set((s) => (s.speedKmh === v ? s : { speedKmh: v })),
}))
