import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { exportCity } from '../export/exporter'
import { rebuildWithLibraryAssets, rebuildWithCorridorElevation, rebuildWithRoadScale } from '../app/buildCity'

export function Toolbar() {
  const cameraMode = useEditor((s) => s.cameraMode)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  const snapping = useEditor((s) => s.snapping)
  const canUndo = useEditor((s) => s.undoStack.length > 0)
  const canRedo = useEditor((s) => s.redoStack.length > 0)
  const s = useEditor.getState

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-icon">🏙️</span> CityBuilder
        <span className="brand-sub">BETA</span>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button onClick={() => s().openPicker()} title="Pick a different area on the map (current edits are discarded)">
          🌍 New area
        </button>
      </div>

      <div className="tb-group" title="Camera mode">
        <button
          className={cameraMode === 'orbit' ? 'active' : ''}
          onClick={() => s().setCameraMode('orbit')}
          title="Orbit — left-drag rotate, right-drag pan, scroll/pinch zoom. Switching modes now keeps your selected object in view."
        >
          🧭 Orbit
        </button>
        <button
          className={cameraMode === 'fly' ? 'active' : ''}
          onClick={() => s().setCameraMode('fly')}
          title="Fly — WASD move, Q/E down/up, drag to look, Shift = fast, Esc to exit. Click any object to select it."
        >
          ✈️ Fly
        </button>
        <button
          className={cameraMode === 'drive' ? 'active' : ''}
          onClick={() => s().setCameraMode('drive')}
          title="Drive preview at eye level — W/S throttle, A/D steer, Esc to exit (shortcut: D). Spawns next to your selection."
        >
          🚗 Drive
        </button>
      </div>

      <div className="tb-group" title="Transform tool (works on unlocked objects)">
        <button className={gizmoMode === 'translate' ? 'active' : ''} onClick={() => s().setGizmoMode('translate')} title="Move (1)">↖ Move</button>
        <button className={gizmoMode === 'rotate' ? 'active' : ''} onClick={() => s().setGizmoMode('rotate')} title="Rotate (2)">⟳ Rotate</button>
        <button className={gizmoMode === 'scale' ? 'active' : ''} onClick={() => s().setGizmoMode('scale')} title="Scale (3)">⤢ Scale</button>
        <button className={snapping ? 'active' : ''} onClick={() => s().setSnapping(!snapping)} title="Snapping: 0.5 m grid, 15° angles (V)">⌗ Snap</button>
      </div>

      <div className="tb-group">
        <button disabled={!canUndo} onClick={() => s().undo()} title="Undo (Ctrl/Cmd+Z)">↩</button>
        <button disabled={!canRedo} onClick={() => s().redo()} title="Redo (Ctrl/Cmd+Shift+Z)">↪</button>
      </div>

      <div className="tb-spacer" />

      <SettingsMenu />

      <div className="tb-group">
        <button className="primary" onClick={() => exportCity()} title="Export scene GLB + collision GLB + semantics JSON">
          ⬇ Export
        </button>
        <button onClick={() => s().setHelpOpen(true)} title="Help & shortcuts">?</button>
      </div>
    </div>
  )
}

/** Advanced scene/view settings, tucked into a popover so the toolbar stays clean. */
function SettingsMenu() {
  const sunTime = useEditor((s) => s.sunTime)
  const fxPreview = useEditor((s) => s.fxPreview)
  const useLibraryAssets = useEditor((s) => s.useLibraryAssets)
  const useCorridorElevation = useEditor((s) => s.useCorridorElevation)
  const roadScale = useEditor((s) => s.roadScale)
  const s = useEditor.getState
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const [dragScale, setDragScale] = useState<number | null>(null)
  const shownScale = dragScale ?? roadScale
  const commitRoadScale = (v: number) => {
    setDragScale(null)
    if (v !== roadScale) rebuildWithRoadScale(v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const activeCount = (fxPreview ? 1 : 0) + (useLibraryAssets ? 1 : 0) + (useCorridorElevation ? 1 : 0)

  return (
    <div className="tb-settings-wrap" ref={wrap}>
      <button className={open ? 'active' : ''} onClick={() => setOpen((o) => !o)} title="Scene & view settings">
        ⚙ Settings{activeCount ? ` · ${activeCount}` : ''}
      </button>
      {open && (
        <div className="tb-settings-panel">
          <div className="tb-settings-title">Scene &amp; view</div>

          <label className="tb-setting-row">
            <input type="checkbox" checked={fxPreview} onChange={() => s().setFxPreview(!fxPreview)} />
            <span>
              <b>✨ FX preview</b>
              <em>Editor-only bloom / grade / vignette. Never exported.</em>
            </span>
          </label>

          <label className="tb-setting-row">
            <input type="checkbox" checked={useLibraryAssets} onChange={() => rebuildWithLibraryAssets(!useLibraryAssets)} />
            <span>
              <b>🧩 Library assets</b>
              <em>Fill buildings/props from bundled 3D models. Rebuilds the scene.</em>
            </span>
          </label>

          <label className="tb-setting-row">
            <input type="checkbox" checked={useCorridorElevation} onChange={() => rebuildWithCorridorElevation(!useCorridorElevation)} />
            <span>
              <b>🛣️ Road elevation solve</b>
              <em>Graph-wide grade solve instead of per-segment ramps. Rebuilds.</em>
            </span>
          </label>

          <div className="tb-setting-slider">
            <div className="tb-setting-slider-head">
              <b>↔️ Road width</b>
              <span>{shownScale.toFixed(2)}×</span>
            </div>
            <input
              type="range" min={1} max={3} step={0.25} value={shownScale}
              onChange={(e) => setDragScale(parseFloat(e.target.value))}
              onPointerUp={(e) => commitRoadScale(parseFloat((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitRoadScale(parseFloat((e.target as HTMLInputElement).value))}
            />
          </div>

          <div className="tb-setting-slider">
            <div className="tb-setting-slider-head">
              <b>{sunTime < 12 ? '🌅' : sunTime < 17 ? '☀️' : '🌇'} Sun time</b>
              <span>
                {String(Math.floor(sunTime)).padStart(2, '0')}:{String(Math.round((sunTime % 1) * 60)).padStart(2, '0')}
              </span>
            </div>
            <input type="range" min={5.5} max={20.5} step={0.25} value={sunTime} onChange={(e) => s().setSunTime(parseFloat(e.target.value))} />
          </div>
        </div>
      )}
    </div>
  )
}
