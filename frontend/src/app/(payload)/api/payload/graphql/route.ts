import { GRAPHQL_POST } from '@payloadcms/next/routes'
import config from '@/payload/payload.config'

export const POST = GRAPHQL_POST(config)

export const OPTIONS = () =>
  new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
