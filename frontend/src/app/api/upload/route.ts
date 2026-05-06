export const runtime = 'nodejs'
export const maxDuration = 300

import { createLogger } from '@/lib/logger'

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:8080'
const log = createLogger('app.api.upload')

export async function POST(req: Request) {
  const started = Date.now()
  const headers = new Headers()
  const contentType = req.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const contentLength = req.headers.get('content-length')
  if (contentLength) headers.set('content-length', contentLength)
  const authorization = req.headers.get('authorization')
  if (authorization) headers.set('authorization', authorization)

  log.info('upload.proxy.start', { content_length: contentLength })
  const response = await fetch(`${BACKEND_URL}/api/upload`, {
    method: 'POST',
    body: req.body,
    headers,
    // @ts-expect-error duplex is required for streaming request bodies in Node fetch
    duplex: 'half',
  })
  log.info('upload.proxy.complete', {
    status_code: response.status,
    duration_ms: Date.now() - started,
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
