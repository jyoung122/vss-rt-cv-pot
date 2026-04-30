export const runtime = 'nodejs'
export const maxDuration = 300

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:8080'

export async function POST(req: Request) {
  const headers = new Headers()
  const contentType = req.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const contentLength = req.headers.get('content-length')
  if (contentLength) headers.set('content-length', contentLength)

  const response = await fetch(`${BACKEND_URL}/api/upload`, {
    method: 'POST',
    body: req.body,
    headers,
    // @ts-expect-error duplex is required for streaming request bodies in Node fetch
    duplex: 'half',
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
