import { useEffect } from 'react'
import { useEditor } from './state/store'
import { Viewport } from './editor/Viewport'
import { Toolbar } from './ui/Toolbar'
import { Hierarchy } from './ui/Hierarchy'
import { Inspector } from './ui/Inspector'
import { StatusBar } from './ui/StatusBar'
import { HelpOverlay } from './ui/HelpOverlay'
import { AreaPicker } from './ui/AreaPicker'
import { LoadingScreen } from './ui/LoadingScreen'
import { frameObjects } from './editor/actions'

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const s = useEditor.getState()
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') {
        e.preventDefault()
        s.redo()
        return
      }
      switch (e.code) {
        case 'Escape':
          if (s.helpOpen) s.setHelpOpen(false)
          else if (s.cameraMode !== 'orbit') s.setCameraMode('orbit')
          else s.clearSelection()
          break
        case 'Digit1':
          s.setGizmoMode('translate')
          break
        case 'Digit2':
          s.setGizmoMode('rotate')
          break
        case 'Digit3':
          s.setGizmoMode('scale')
          break
        case 'KeyV':
          s.setSnapping(!s.snapping)
          break
        case 'KeyF':
          if (s.cameraMode === 'orbit' && s.selection.length) frameObjects(s.selection)
          break
        case 'KeyD':
          // one-key drive preview (only from orbit — D steers while driving)
          if (s.cameraMode === 'orbit') s.setCameraMode('drive')
          break
        case 'Delete':
        case 'Backspace':
          if (s.selection.length) {
            e.preventDefault()
            s.deleteSelected()
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Toast() {
  const toast = useEditor((s) => s.toast)
  if (!toast) return null
  return <div className="toast">{toast}</div>
}

function DriveHudOverlay() {
  const mode = useEditor((s) => s.cameraMode)
  if (mode !== 'drive') return null
  return (
    <div className="drive-hud">
      🚗 Drive preview — <b>W/S</b> throttle · <b>A/D</b> steer · <b>Esc</b> to exit
    </div>
  )
}

export default function App() {
  useGlobalShortcuts()
  const appPhase = useEditor((s) => s.appPhase)

  if (appPhase === 'picker') return <AreaPicker />

  if (appPhase === 'building') return <LoadingScreen />

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <Hierarchy />
        <div className="viewport">
          <Viewport />
          <DriveHudOverlay />
          <Toast />
        </div>
        <Inspector />
      </div>
      <StatusBar />
      <HelpOverlay />
    </div>
  )
}
