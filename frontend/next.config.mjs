import { withPayload } from '@payloadcms/next/withPayload'

// Backend address for API + WS rewrites.
// - In the docker stack: defaults to http://backend:8080 (compose service name).
// - For local `npm run dev`: set BACKEND_URL=http://localhost:8080 in
//   frontend/.env.local (matches docker-compose.dev.yml's exposed port).
const backend = process.env.BACKEND_URL || 'http://backend:8080'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      // Any /api/payload/* request must NOT be forwarded to FastAPI — Payload
      // handles those internally as Next.js route handlers.  Use a negative-
      // lookahead in the source regex so only non-payload /api/* paths are
      // proxied to the backend.
      { source: '/api/((?!payload).*)', destination: `${backend}/api/$1` },
      { source: '/ws/:path*', destination: `${backend}/ws/:path*` },
    ]
  },
}

export default withPayload(nextConfig)
