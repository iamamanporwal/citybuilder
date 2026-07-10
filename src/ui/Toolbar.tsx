import { useEditor } from '../state/store'
import { exportCity } from '../export/exporter'

export function Toolbar() {
  const cameraMode = useEditor((s) => s.cameraMode)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  const snapping = useEditor((s) => s.snapping)
  const sunTime = useEditor((s) => s.sunTime)
  const fxPreview = useEditor((s) => s.fxPreview)
  const canUndo = useEditor((s) => s.undoStack.length > 0)
  const canRedo = useEditor((s) => s.redoStack.length > 0)
  const s = useEditor.getState

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-icon">🏙️</span> CityBuilder
        <span className="brand-sub">BETA</span>
      </div>

      <div className="tb-group">
        <button
          onClick={() => s().openPicker()}
          title="Pick a different area on the map (current edits are discarded)"
        >
          🌍 New area
        </button>
      </div>

      <div className="tb-group" title="Camera mode">
        <button
          className={cameraMode === 'orbit' ? 'active' : ''}
          onClick={() => s().setCameraMode('orbit')}
          title="Orbit / pan overview camera"
        >
          🧭 Orbit
        </button>
        <button
          className={cameraMode === 'fly' ? 'active' : ''}
          onClick={() => s().setCameraMode('fly')}
          title="Fly camera — WASD to move, drag to look, Shift = fast, Esc to exit"
        >
          ✈️ Fly
        </button>
        <button
          className={cameraMode === 'drive' ? 'active' : ''}
          onClick={() => s().setCameraMode('drive')}
          title="Drive preview at eye level — W/S throttle, A/D steer, Esc to exit (shortcut: D)"
        >
          🚗 Drive
        </button>
      </div>

      <div className="tb-group" title="Transform tool (works on unlocked objects)">
        <button
          className={gizmoMode === 'translate' ? 'active' : ''}
          onClick={() => s().setGizmoMode('translate')}
          title="Move (1)"
        >
          ↖ Move
        </button>
        <button
          className={gizmoMode === 'rotate' ? 'active' : ''}
          onClick={() => s().setGizmoMode('rotate')}
          title="Rotate (2)"
        >
          ⟳ Rotate
        </button>
        <button
          className={gizmoMode === 'scale' ? 'active' : ''}
          onClick={() => s().setGizmoMode('scale')}
          title="Scale (3)"
        >
          ⤢ Scale
        </button>
        <button
          className={snapping ? 'active' : ''}
          onClick={() => s().setSnapping(!snapping)}
          title="Snapping: 0.5 m grid, 15° angles (V)"
        >
          ⌗ Snap
        </button>
      </div>

      <div className="tb-group">
        <button disabled={!canUndo} onClick={() => s().undo()} title="Undo (Ctrl/Cmd+Z)">
          ↩ Undo
        </button>
        <button disabled={!canRedo} onClick={() => s().redo()} title="Redo (Ctrl/Cmd+Shift+Z)">
          ↪ Redo
        </button>
      </div>

      <div className="tb-group">
        <button
          className={fxPreview ? 'active' : ''}
          onClick={() => s().setFxPreview(!fxPreview)}
          title="Editor-only look-dev preview (bloom, grade, vignette). Approximates the game engine's post stack — NEVER exported; the output stays clean unlit PBR."
        >
          ✨ FX preview
        </button>
      </div>

      <div className="tb-group sun-group" title="Editor-only preview lighting — the export carries no lights or baked shadows">
        <span className="sun-label">{sunTime < 12 ? '🌅' : sunTime < 17 ? '☀️' : '🌇'}</span>
        <input
          type="range"
          min={5.5}
          max={20.5}
          step={0.25}
          value={sunTime}
          onChange={(e) => s().setSunTime(parseFloat(e.target.value))}
        />
        <span className="sun-time">
          {String(Math.floor(sunTime)).padStart(2, '0')}:{String(Math.round((sunTime % 1) * 60)).padStart(2, '0')}
        </span>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group">
        <button className="primary" onClick={() => exportCity()} title="Export scene GLB + collision GLB + semantics JSON">
          ⬇ Export city
        </button>
        <button onClick={() => s().setHelpOpen(true)} title="Help & shortcuts">
          ?
        </button>
      </div>
    </div>
  )
}
