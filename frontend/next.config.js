/** @type {import('next').NextConfig} */

// Backend address for API + WS rewrites.
// - In the docker stack: defaults to http://backend:8080 (compose service name).
// - For local `npm run dev`: set BACKEND_URL=http://localhost:8080 in
//   frontend/.env.local (matches docker-compose.dev.yml's exposed port).
const backend = process.env.BACKEND_URL || 'http://backend:8080'

const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/ws/:path*', destination: `${backend}/ws/:path*` },
    ]
  },
}
module.exports = nextConfig
