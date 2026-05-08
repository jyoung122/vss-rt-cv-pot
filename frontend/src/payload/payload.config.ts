import path from 'path'
import { fileURLToPath } from 'url'

import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import { seoPlugin } from '@payloadcms/plugin-seo'

import { Articles } from './collections/Articles'
import { Categories } from './collections/Categories'
import { Pages } from './collections/Pages'
import { Media } from './collections/Media'
import { Users } from './collections/Users'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: 'users',
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  // Mount Payload's REST/GraphQL under /api/payload so /api/* stays free for
  // FastAPI rewrites (Payload's default /api/[...slug] catch-all otherwise
  // shadows every backend route).
  routes: {
    api: '/api/payload',
  },
  editor: lexicalEditor(),
  collections: [Articles, Categories, Pages, Media, Users],
  secret: process.env.PAYLOAD_SECRET || '',
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI,
    },
    schemaName: 'payload',
  }),
  plugins: [
    s3Storage({
      collections: {
        media: true,
      },
      bucket: process.env.PAYLOAD_S3_BUCKET!,
      config: {
        endpoint: process.env.STORAGE_S3_ENDPOINT!,
        region: process.env.REGION || 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_PROTOCOL_ACCESS_KEY_ID!,
          secretAccessKey: process.env.S3_PROTOCOL_ACCESS_KEY_SECRET!,
        },
      },
    }),
    seoPlugin({
      collections: ['pages', 'articles'],
      uploadsCollection: 'media',
    }),
  ],
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
