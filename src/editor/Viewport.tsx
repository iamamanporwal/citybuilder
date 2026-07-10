import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky } from '@react-three/drei'
import { Bloom, BrightnessContrast, EffectComposer, SMAA, Vignette } from '@react-three/postprocessing'
import { useEditor } from '../state/store'
import { CameraRig } from './CameraRig'
import { SceneContent } from './SceneContent'
import { DEPTH_CONFIG } from './depthConfig'

/**
 * EDITOR-ONLY look-dev preview. The authoring tool ships clean unlit PBR
 * content — lighting, post-FX, reflections and sky live in the game engine.
 * This composer approximates the engine's grade so artists can sanity-check;
 * nothing here is baked into textures or written to the export.
 */
function FxPreview() {
  const on = useEditor((s) => s.fxPreview)
  if (!on) return null
  return (
    <EffectComposer>
      <SMAA />
      <Bloom intensity={0.25} luminanceThreshold={0.85} mipmapBlur />
      <BrightnessContrast brightness={0.02} contrast={0.12} />
      <Vignette eskil={false} offset={0.22} darkness={0.55} />
    </EffectComposer>
  )
}

function Lighting() {
  const sunTime = useEditor((s) => s.sunTime)
  const sun = useMemo(() => {
    const a = ((sunTime - 6) / 12) * Math.PI // 6:00 -> sunrise, 18:00 -> sunset
    const elev = Math.sin(a)
    return {
      pos: [Math.cos(a) * 900, Math.max(elev, 0.03) * 700 + 40, 350] as [number, number, number],
      intensity: Math.max(elev, 0) * 2.0 + 0.15,
      ambient: Math.max(elev, 0) * 0.9 + 0.5,
    }
  }, [sunTime])

  return (
    <>
      <Sky sunPosition={sun.pos} distance={4000} turbidity={6} rayleigh={1.2} />
      <hemisphereLight args={['#c6d8ea', '#57584e', sun.ambient]} />
      <ambientLight intensity={0.18} />
      <directionalLight
        position={sun.pos}
        intensity={sun.intensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-650}
        shadow-camera-right={650}
        shadow-camera-top={650}
        shadow-camera-bottom={-650}
        shadow-camera-near={10}
        shadow-camera-far={3000}
        shadow-bias={-0.0002}
        shadow-normalBias={0.6}
      />
    </>
  )
}

export function Viewport() {
  const clearSelection = useEditor((s) => s.clearSelection)
  return (
    <Canvas
      shadows
      camera={{ position: [-340, 300, 340], fov: 55, near: DEPTH_CONFIG.near, far: DEPTH_CONFIG.far }}
      // logarithmicDepthBuffer is load-bearing: with standard perspective depth
      // the layer stack (10-30mm gaps) drops below the depth quantum beyond
      // ~350m viewing distance and z-fights. flickerLint proves this invariant.
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        logarithmicDepthBuffer: DEPTH_CONFIG.logarithmicDepthBuffer,
      }}
      onPointerMissed={(e) => {
        if (e.type === 'click') clearSelection()
      }}
      dpr={[1, 2]}
    >
      <Lighting />
      <SceneContent />
      <CameraRig />
      <FxPreview />
    </Canvas>
  )
}
