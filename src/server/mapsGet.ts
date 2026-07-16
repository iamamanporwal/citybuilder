// GET /api/v1/maps/:id — poll a map job. Ready responses embed the manifest,
// whose file URLs point straight at the CDN-cached Blob artifacts.
//
// Bundled to api/v1/maps/[id].mjs by tools/build-api.mjs.

import { authorized, corsHeaders, json, jobStatus } from './world'

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'missing or invalid x-api-key' })

  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  if (!/^[0-9a-f]{16}$/.test(id)) return json(400, { error: 'invalid map id' })

  const status = await jobStatus(id)
  switch (status.status) {
    case 'ready':
      return json(200, { id, status: 'ready', manifest: status.manifest })
    case 'generating':
      return json(200, {
        id,
        status: status.stale ? 'stalled' : 'generating',
        startedAt: status.startedAt,
        note: status.stale ? 'No progress for 15+ min — re-POST the same bbox/options to retry.' : undefined,
      })
    case 'failed':
      return json(200, { id, status: 'failed', error: status.error, failedAt: status.failedAt })
    default:
      return json(404, { id, status: 'unknown', note: 'No job with this id — POST /api/v1/maps first.' })
  }
}
