// Global key state shared by fly mode (CameraRig) and the drive sim.
export const pressed = new Set<string>()

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!isTyping(e)) pressed.add(e.code)
  })
  window.addEventListener('keyup', (e) => pressed.delete(e.code))
  window.addEventListener('blur', () => pressed.clear())
}
