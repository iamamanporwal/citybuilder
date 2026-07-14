/// <reference types="vite/client" />

// Recognizer / gateway env seams. All optional — the app runs fully without
// them (simulated descriptors, no premium providers). Server-side secrets
// (e.g. SKETCHFAB_API_TOKEN) live in the dev proxy, never here.
interface ImportMetaEnv {
  /** Vision-language endpoint for the Building Recognizer (photo + priors → descriptor). */
  readonly VITE_VLM_ENDPOINT?: string
  /** Model id the VLM endpoint should use (default claude-opus-4-8). */
  readonly VITE_VLM_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
