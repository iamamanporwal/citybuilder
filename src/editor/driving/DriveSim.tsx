import { useEffect, useState } from 'react'
import { Physics, useRapier } from '@react-three/rapier'
import { buildCollidersFromRegistry } from '../../physics/registryColliders'
import { buildStaticColliders } from '../../physics/buildColliders'
import { Car } from './Car'

// Drive preview physics world. Lazy-mounted by Viewport only while
// cameraMode === 'drive' (this file is the React.lazy chunk boundary carrying
// the ~2MB rapier wasm): colliders are rebuilt fresh on every entry, so gizmo
// edits need no invalidation bookkeeping, and unmount frees the whole world.

function CityColliders({ onReady }: { onReady: () => void }) {
  const { world, rapier } = useRapier()
  useEffect(() => {
    const set = buildCollidersFromRegistry()
    const built = set ? buildStaticColliders(world, rapier, set.colliders) : null
    onReady()
    return () => built?.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, rapier])
  return null
}

export default function DriveSim() {
  // spawn the car only after the city colliders exist so it lands on the road
  const [ready, setReady] = useState(false)
  return (
    <Physics colliders={false} gravity={[0, -9.81, 0]} timeStep={1 / 60} interpolate>
      <CityColliders onReady={() => setReady(true)} />
      {ready && <Car />}
    </Physics>
  )
}
