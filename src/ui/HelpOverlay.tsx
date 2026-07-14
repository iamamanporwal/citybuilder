import { useEditor } from '../state/store'

export function HelpOverlay() {
  const open = useEditor((s) => s.helpOpen)
  const cityName = useEditor((s) => s.cityName)
  const setHelpOpen = useEditor.getState().setHelpOpen
  if (!open) return null
  return (
    <div className="overlay" onClick={() => setHelpOpen(false)}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <h1>🏙️ Welcome to CityBuilder</h1>
        <p className="help-lede">
          A real slice of <b>{cityName || 'the city'}</b> was built automatically from
          OpenStreetMap data. Every road, building, signal and tree is a separate, tagged object.
          Your job is to <b>upgrade the buildings that matter</b> — the roads are already
          driving-grade and locked.
        </p>
        <div className="help-cols">
          <div>
            <h2>Workflow</h2>
            <ol>
              <li><b>Click a building</b> — the Inspector shows its real-world reference and map links.</li>
              <li>Choose <b>“Generate 3D”</b> to replace it with an AI-generated model, or upload your own <b>.glb</b>. It's fitted into the exact slot.</li>
              <li><b>Approve or revert</b> the result. Everything is undoable.</li>
              <li>Press <b>D</b> to <b>drive</b> the city at eye level — that's the view that matters.</li>
              <li><b>Export</b> the scene + collision + lane semantics for the game.</li>
            </ol>
          </div>
          <div>
            <h2>Shortcuts</h2>
            <table>
              <tbody>
                <tr><td><kbd>Left-drag</kbd></td><td>Orbit · <kbd>Right-drag</kbd> pan · scroll zoom</td></tr>
                <tr><td><kbd>D</kbd></td><td>Drive — <kbd>W</kbd>/<kbd>S</kbd> go · <kbd>A</kbd>/<kbd>D</kbd> steer</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Exit drive/fly · deselect</td></tr>
                <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>Move / Rotate / Scale</td></tr>
                <tr><td><kbd>V</kbd></td><td>Toggle snapping</td></tr>
                <tr><td><kbd>F</kbd></td><td>Frame selection</td></tr>
                <tr><td><kbd>Shift</kbd>+click</td><td>Multi-select</td></tr>
                <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd></td><td>Undo</td></tr>
                <tr><td><kbd>Del</kbd></td><td>Delete (unlocked objects)</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <button className="primary wide" onClick={() => setHelpOpen(false)}>
          Start building →
        </button>
      </div>
    </div>
  )
}
