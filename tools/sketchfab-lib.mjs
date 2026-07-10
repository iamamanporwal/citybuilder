// Shared Sketchfab Data API v3 client for the Node curation tools.
// Token comes from SKETCHFAB_API_TOKEN in the environment (loaded from .env).
// The public Sketchfab API intermittently returns empty/timeout under load,
// so every call retries with backoff.

const API = 'https://api.sketchfab.com/v3'

export function token() {
  const t = process.env.SKETCHFAB_API_TOKEN
  if (!t) throw new Error('SKETCHFAB_API_TOKEN not set — `set -a; . ./.env; set +a` first')
  return t
}

async function req(url, { retries = 5, expectJson = true } = {}) {
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Token ${token()}` } })
      // The public API intermittently emits spurious 4xx/5xx under load from
      // this environment (observed: 400/408/429). Only genuine auth/not-found
      // errors are fatal; everything else retries.
      if ([401, 403, 404].includes(res.status)) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
      }
      if (!res.ok) throw new Error(`transient ${res.status}`)
      if (!expectJson) return res
      const text = await res.text()
      const data = text ? JSON.parse(text) : {}
      // API sometimes 200s with an empty body under load — treat as transient.
      if (expectJson && Object.keys(data).length === 0) throw new Error('empty body')
      return data
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e
      await new Promise(r => setTimeout(r, 400 * (attempt + 1) + Math.floor(Math.sqrt(attempt) * 137)))
    }
  }
  throw new Error(`Sketchfab request failed after ${retries} tries: ${url}\n  ${lastErr?.message}`)
}

export async function search(params) {
  const qs = new URLSearchParams({ type: 'models', ...params }).toString()
  return req(`${API}/search?${qs}`)
}

export async function downloadLinks(uid) {
  return req(`${API}/models/${uid}/download`)
}

// Presigned S3 download URLs must be fetched WITHOUT our API token — an extra
// Authorization header makes S3 reject the request with 400. Plain retrying GET.
export async function fetchToBuffer(url) {
  let lastErr
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`file HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  throw new Error(`file download failed after 5 tries: ${lastErr?.message}`)
}
