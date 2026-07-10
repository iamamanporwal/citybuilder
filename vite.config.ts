import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Sketchfab integration keeps the API token server-side (PRD §7D):
//  - /api/sketchfab/*      → api.sketchfab.com/v3/*  with the token injected
//    into the Authorization header here, so it never enters the client bundle.
//  - /api/sketchfab-dl?url= → server-side fetch of a model's presigned S3
//    download URL, streamed back. A path-rewriting proxy corrupts the AWS
//    signature (URL-encoding drift → 403), so this is a fetch-and-pipe
//    middleware that passes the signed URL through byte-for-byte.
//
// Production note: a static build has no dev server — the in-app Sketchfab
// search needs an equivalent backend/serverless proxy. Until then the feature
// is dev-only and degrades gracefully (the provider probes /api/sketchfab/me
// and disables itself if the proxy is absent).
function sketchfabDownload(): Plugin {
  const ALLOWED = ['sketchfab.com', 'amazonaws.com']
  return {
    name: 'sketchfab-download',
    configureServer(server) {
      server.middlewares.use('/api/sketchfab-dl', async (req, res) => {
        try {
          const target = new URL(req.originalUrl || req.url || '', 'http://x').searchParams.get('url')
          if (!target) { res.statusCode = 400; return res.end('missing url') }
          const host = new URL(target).hostname
          if (!ALLOWED.some((d) => host === d || host.endsWith(`.${d}`))) {
            res.statusCode = 400
            return res.end('host not allowed')
          }
          const upstream = await fetch(target) // exact signed URL, no auth header
          res.statusCode = upstream.status
          res.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream')
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (e) {
          res.statusCode = 502
          res.end(`download proxy error: ${(e as Error).message}`)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const token = env.SKETCHFAB_API_TOKEN || ''

  return {
    plugins: [react(), sketchfabDownload()],
    build: {
      chunkSizeWarningLimit: 2000,
    },
    server: {
      proxy: {
        '/api/sketchfab': {
          target: 'https://api.sketchfab.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/sketchfab/, '/v3'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (token) proxyReq.setHeader('Authorization', `Token ${token}`)
            })
          },
        },
      },
    },
  }
})
