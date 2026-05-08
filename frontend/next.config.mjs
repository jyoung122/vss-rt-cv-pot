import { withPayload } from '@payloadcms/next/withPayload'

// Backend address for API + WS rewrites.
// - In the docker stack: defaults to http://backend:8080 (compose service name).
// - For local `npm run dev`: set BACKEND_URL=http://localhost:8080 in
//   frontend/.env.local (matches docker-compose.dev.yml's exposed port).
const backend = process.env.BACKEND_URL || 'http://backend:8080'

// Supabase (Kong gateway) address for /auth + /storage rewrites. Same-origin
// proxy keeps the browser talking only to the frontend port — no need to
// forward Kong's port through Brev/etc.
const supabase = process.env.SUPABASE_INTERNAL_URL || 'http://kong:8000'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      // /api/payload/* and /api/upload (singular) are local Next.js route
      // handlers — they take precedence over rewrites, so this catch-all
      // safely covers everything else (e.g. /api/uploads, /api/incidents).
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/ws/:path*', destination: `${backend}/ws/:path*` },
      { source: '/auth/v1/:path*', destination: `${supabase}/auth/v1/:path*` },
      { source: '/storage/v1/:path*', destination: `${supabase}/storage/v1/:path*` },
    ]
  },
}

export default withPayload(nextConfig)
