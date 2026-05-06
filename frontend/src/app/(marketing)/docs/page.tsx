import { getPayload } from 'payload'
import configPromise from '../../../payload/payload.config'
import DocsSearch from './_components/docs-search'

export const dynamic = 'force-dynamic'

export default async function DocsIndexPage() {
  const payload = await getPayload({ config: configPromise })

  const [articlesResult, categoriesResult] = await Promise.all([
    payload.find({
      collection: 'articles',
      where: { _status: { equals: 'published' } },
      depth: 1,
      limit: 200,
      sort: 'order',
    }),
    payload.find({
      collection: 'categories',
      limit: 100,
      sort: 'order',
    }),
  ])

  type CategoryDoc = {
    id: string
    name: string
    slug: string
    order?: number | null
  }

  type ArticleDoc = {
    id: string
    title: string
    slug: string
    excerpt?: string | null
    order?: number | null
    category?: CategoryDoc | string | null
  }

  const articles = articlesResult.docs as unknown as ArticleDoc[]
  const categories = categoriesResult.docs as unknown as CategoryDoc[]

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold text-[var(--fg-1)]">Knowledge Base</h1>
        <p className="mt-3 text-[var(--fg-2)]">
          Browse guides, concepts, and reference articles for AIMS operators.
        </p>
      </div>

      <DocsSearch articles={articles} categories={categories} />
    </div>
  )
}
