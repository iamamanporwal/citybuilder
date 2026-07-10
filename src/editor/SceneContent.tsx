import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Html, TransformControls } from '@react-three/drei'
import { useEditor } from '../state/store'
import { getVariant } from '../scene/registry'
import type { SceneObject } from '../types'

const PROC_FALLBACK = {
  state: 'procedural' as const,
  provider: 'procedural' as const,
  license: '',
  approved: true,
}

function currentObject3D(obj: SceneObject): THREE.Object3D | undefined {
  return getVariant(obj.id, obj.asset) ?? getVariant(obj.id, PROC_FALLBACK)
}

function ObjectNode({ id }: { id: string }) {
  const obj = useEditor((s) => s.objects[id])
  const job = useEditor((s) => s.jobs[id])
  const select = useEditor((s) => s.select)
  const clearSelection = useEditor((s) => s.clearSelection)

  const three = obj ? currentObject3D(obj) : undefined
  if (!obj || !three || obj.deleted || !obj.visible) return null

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (useEditor.getState().cameraMode !== 'orbit') return
    if (e.delta > 6) return // was a camera drag, not a click
    e.stopPropagation()
    if (obj.type === 'ground') {
      clearSelection()
      return
    }
    select([obj.id], e.nativeEvent.shiftKey)
  }

  const height = typeof obj.meta['height (m)'] === 'number' ? (obj.meta['height (m)'] as number) : 20

  return (
    <>
      <primitive
        object={three}
        position={obj.transform.position}
        rotation={obj.transform.rotation}
        scale={obj.transform.scale}
        onClick={onClick}
      />
      {job && (
        <Html
          center
          position={[obj.transform.position[0], height + 14, obj.transform.position[2]]}
          zIndexRange={[100, 0]}
        >
          <div className="scene-job">
            <div className="spinner" />
            <div className="scene-job-text">
              {job.message}
              <div className="scene-job-bar">
                <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
            </div>
          </div>
        </Html>
      )}
    </>
  )
}

function SelectionBox({ id }: { id: string }) {
  const box = useMemo(() => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)), [])
  const helper = useRef<THREE.Box3Helper>(null)
  useFrame(() => {
    const obj = useEditor.getState().objects[id]
    if (!obj) return
    const three = currentObject3D(obj)
    if (three && three.parent) {
      box.setFromObject(three)
    }
  })
  return <box3Helper ref={helper} args={[box, new THREE.Color('#ffc53d')]} />
}

/** Gizmo for the single selected, unlocked object. Commits transforms for undo. */
function Gizmo() {
  const selection = useEditor((s) => s.selection)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  const snapping = useEditor((s) => s.snapping)
  const cameraMode = useEditor((s) => s.cameraMode)
  const obj = useEditor((s) => (selection.length === 1 ? s.objects[selection[0]] : undefined))
  const before = useRef<SceneObject['transform'] | null>(null)

  if (cameraMode !== 'orbit' || !obj || obj.locked || obj.deleted || !obj.visible) return null
  const three = currentObject3D(obj)
  if (!three) return null

  return (
    <TransformControls
      object={three}
      mode={gizmoMode}
      translationSnap={snapping ? 0.5 : null}
      rotationSnap={snapping ? THREE.MathUtils.degToRad(15) : null}
      scaleSnap={snapping ? 0.1 : null}
      size={0.8}
      onMouseDown={() => {
        before.current = {
          position: [...obj.transform.position] as [number, number, number],
          rotation: [...obj.transform.rotation] as [number, number, number],
          scale: [...obj.transform.scale] as [number, number, number],
        }
        useEditor.getState().setGizmoDragging(true)
      }}
      onMouseUp={() => {
        useEditor.getState().setGizmoDragging(false)
        if (!before.current) return
        const after = {
          position: three.position.toArray() as [number, number, number],
          rotation: [three.rotation.x, three.rotation.y, three.rotation.z] as [
            number,
            number,
            number,
          ],
          scale: three.scale.toArray() as [number, number, number],
        }
        useEditor.getState().commitTransform(obj.id, before.current, after)
        before.current = null
      }}
    />
  )
}

export function SceneContent() {
  const order = useEditor((s) => s.objectOrder)
  const selection = useEditor((s) => s.selection)
  return (
    <group>
      {order.map((id) => (
        <ObjectNode key={id} id={id} />
      ))}
      {selection.map((id) => (
        <SelectionBox key={`sel_${id}`} id={id} />
      ))}
      <Gizmo />
    </group>
  )
}
