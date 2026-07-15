import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'

// Watchable build loader: an animated skyline + a step checklist tied to the
// real pipeline phases (inferred from buildMessage) + an elapsed timer. Keeps
// the wait informative whether the build takes 8 s or (on a busy Overpass) 30 s.

const STEPS: { label: string; match: RegExp }[] = [
  { label: 'Fetching live map data', match: /querying|downloading|openstreetmap/i },
  { label: 'Reading streets & buildings', match: /parsing/i },
  { label: 'Sensing region, climate & species', match: /resolving|region|climate|species|gbif|wikidata|recognizer/i },
  { label: 'Loading 3D assets', match: /asset library/i },
  { label: 'Constructing the city in 3D', match: /generating/i },
]

const SKYLINE = [38, 62, 48, 80, 55, 92, 44, 70, 58, 86, 50, 66]

export function LoadingScreen() {
  const buildMessage = useEditor((s) => s.buildMessage)
  const [elapsed, setElapsed] = useState(0)
  const t0 = useRef(Date.now())
  useEffect(() => {
    const id = setInterval(() => setElapsed((Date.now() - t0.current) / 1000), 200)
    return () => clearInterval(id)
  }, [])

  // furthest step the current message matches (steps are ordered & monotonic)
  let active = 0
  STEPS.forEach((s, i) => { if (s.match.test(buildMessage)) active = i })
  const pct = Math.min(97, ((active + 0.65) / STEPS.length) * 100)
  const slow = elapsed > 15

  return (
    <div className="loading">
      <div className="load-card">
        <div className="load-skyline" aria-hidden>
          {SKYLINE.map((h, i) => (
            <span key={i} style={{ height: `${h}%`, animationDelay: `${i * 0.12}s` }} />
          ))}
          <div className="load-sun" />
        </div>

        <h2>Building your city</h2>
        <p className="load-msg">{buildMessage || 'Starting…'}</p>

        <div className="load-bar"><div className="load-bar-fill" style={{ width: `${pct}%` }} /></div>

        <ul className="load-steps">
          {STEPS.map((s, i) => (
            <li key={s.label} className={i < active ? 'done' : i === active ? 'active' : ''}>
              <span className="load-step-dot">{i < active ? '✓' : i === active ? '' : ''}</span>
              {s.label}
            </li>
          ))}
        </ul>

        <div className="load-foot">
          <span className="load-elapsed">{elapsed.toFixed(1)}s</span>
          {slow && <span className="load-slow">OpenStreetMap is busy — hang tight, almost there…</span>}
        </div>
      </div>
    </div>
  )
}
