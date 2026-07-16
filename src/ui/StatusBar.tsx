import { useEditor } from '../state/store'
import { useDriveHud } from '../state/driveHud'

const MODE_HINT: Record<string, string> = {
  orbit: 'Left-drag rotate · right-drag pan · scroll zoom · click objects to select',
  fly: 'click to capture mouse · WASD fly · Space/C up/down · scroll = speed · Shift fast · Alt slow · Esc release, Esc again exit',
  drive: 'W/S throttle & brake · A/D steer · Esc to exit',
}

export function StatusBar() {
  const cameraMode = useEditor((s) => s.cameraMode)
  const selection = useEditor((s) => s.selection)
  const objects = useEditor((s) => s.objects)
  const attribution = useEditor((s) => s.attribution)
  const speed = useDriveHud((s) => s.speedKmh)

  const selText =
    selection.length === 1
      ? objects[selection[0]]?.name
      : selection.length > 1
        ? `${selection.length} objects`
        : 'nothing selected'

  return (
    <div className="statusbar">
      <span className="sb-mode">{cameraMode.toUpperCase()}{cameraMode === 'drive' ? ` · ${speed} km/h` : ''}</span>
      <span className="sb-hint">{MODE_HINT[cameraMode]}</span>
      <span className="sb-sel">Selected: {selText}</span>
      <span className="sb-spacer" />
      <span className="sb-attr">{attribution}</span>
    </div>
  )
}
