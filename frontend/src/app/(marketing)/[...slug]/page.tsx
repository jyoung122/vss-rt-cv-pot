import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPayload } from 'payload'
import configPromise from '../../../payload/payload.config'
import BlockRenderer from '@/payload/components/blocks/BlockRenderer'

export const dynamic = 'force-dynamic'

type MetaGroup = {
  title?: string | null
  description?: string | null
}

type PageDoc = {
  id: string
  title: string
  slug: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks?: any[]
  meta?: MetaGroup | null
}

export async function generateStaticParams() {
  try {
    const payload = await getPayload({ config: configPromise })
    const result = await payload.find({
      collection: 'pages',
      where: { _status: { equals: 'published' } },
      limit: 200,
      depth: 0,
    })
    return (result.docs as unknown as PageDoc[]).map((doc) => ({
      slug: doc.slug.split('/'),
    }))
  } catch {
    return []
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>
}): Promise<Metadata> {
  const { slug } = await params
  const joined = slug.join('/')
  const payload = await getPayload({ config: configPromise })

  const result = await payload.find({
    collection: 'pages',
    where: {
      and: [
        { slug: { equals: joined } },
        { _status: { equals: 'published' } },
      ],
    },
    depth: 0,
    limit: 1,
  })

  const page = (result.docs as unknown as PageDoc[])[0]
  if (!page) return {}

  return {
    title: page.meta?.title ?? page.title,
    description: page.meta?.description ?? undefined,
  }
}

export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ slug: string[] }>
}) {
  const { slug } = await params
  const joined = slug.join('/')

  const payload = await getPayload({ config: configPromise })

  const result = await payload.find({
    collection: 'pages',
    where: {
      and: [
        { slug: { equals: joined } },
        { _status: { equals: 'published' } },
      ],
    },
    depth: 2,
    limit: 1,
  })

  const page = (result.docs as unknown as PageDoc[])[0]
  if (!page) notFound()

  return (
    <div>
      {page.blocks && page.blocks.length > 0 ? (
        <BlockRenderer blocks={page.blocks} />
      ) : (
        <div className="mx-auto max-w-4xl px-6 py-16">
          <h1 className="text-4xl font-bold text-[var(--fg-1)]">{page.title}</h1>
        </div>
      )}
    </div>
  )
}
