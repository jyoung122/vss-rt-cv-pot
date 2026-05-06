import Link from 'next/link'
import { getPayload } from 'payload'
import configPromise from '@/payload/payload.config'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const dynamic = 'force-dynamic'

type CategoryDoc = {
  id: string
  name: string
  slug: string
  description?: string | null
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

export default async function DocsIndexPage() {
  const payload = await getPayload({ config: configPromise })

  const [articlesResult, categoriesResult] = await Promise.all([
    payload.find({
      collection: 'articles',
      where: { _status: { equals: 'published' } },
      depth: 1,
      limit: 500,
      sort: 'order',
    }),
    payload.find({
      collection: 'categories',
      limit: 100,
      sort: 'order',
    }),
  ])

  const articles = articlesResult.docs as unknown as ArticleDoc[]
  const categories = categoriesResult.docs as unknown as CategoryDoc[]

  const articlesByCategory = new Map<string, ArticleDoc[]>()
  for (const a of articles) {
    const cid =
      a.category && typeof a.category === 'object'
        ? a.category.id
        : typeof a.category === 'string'
          ? a.category
          : null
    if (!cid) continue
    const list = articlesByCategory.get(cid) ?? []
    list.push(a)
    articlesByCategory.set(cid, list)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold text-[var(--fg-1)]">Knowledge Base</h1>
        <p className="mt-3 text-[var(--fg-2)]">
          Guides, concepts, and reference articles for AIMS operators. Pick a category below or use
          the filter in the sidebar to jump to an article.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {categories.map((cat) => {
          const count = articlesByCategory.get(cat.id)?.length ?? 0
          const firstSlug = articlesByCategory.get(cat.id)?.[0]?.slug
          return (
            <Card key={cat.id} className="bg-[var(--surface-1)]">
              <CardHeader>
                <CardTitle className="text-[var(--fg-1)]">{cat.name}</CardTitle>
                {cat.description && (
                  <CardDescription className="text-[var(--fg-2)]">
                    {cat.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="text-sm text-[var(--fg-3)]">
                {count === 0 ? (
                  <span>No articles yet.</span>
                ) : firstSlug ? (
                  <Link
                    href={`/docs/${firstSlug}`}
                    className="text-[var(--accent-500)] hover:underline"
                  >
                    {count} article{count === 1 ? '' : 's'} →
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
