import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPayload } from 'payload'
import { RichText } from '@payloadcms/richtext-lexical/react'
import configPromise from '@/payload/payload.config'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ArrowRight } from 'lucide-react'

export const dynamic = 'force-dynamic'

type CategoryDoc = {
  id: string
  name: string
  slug: string
}

type ArticleDoc = {
  id: string
  title: string
  slug: string
  excerpt?: string | null
  body?: unknown
  order?: number | null
  publishedAt?: string | null
  category?: CategoryDoc | string | null
}

export async function generateStaticParams() {
  try {
    const payload = await getPayload({ config: configPromise })
    const result = await payload.find({
      collection: 'articles',
      where: { _status: { equals: 'published' } },
      limit: 500,
      depth: 0,
    })
    return (result.docs as unknown as ArticleDoc[]).map((doc) => ({
      slug: doc.slug,
    }))
  } catch {
    return []
  }
}

export default async function ArticleDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const payload = await getPayload({ config: configPromise })

  const result = await payload.find({
    collection: 'articles',
    where: {
      and: [
        { slug: { equals: slug } },
        { _status: { equals: 'published' } },
      ],
    },
    depth: 1,
    limit: 1,
  })

  const article = (result.docs as unknown as ArticleDoc[])[0]
  if (!article) notFound()

  const category =
    article.category && typeof article.category === 'object'
      ? article.category
      : null

  let prevArticle: ArticleDoc | null = null
  let nextArticle: ArticleDoc | null = null

  if (category) {
    const siblingsResult = await payload.find({
      collection: 'articles',
      where: {
        and: [
          { 'category.id': { equals: category.id } },
          { _status: { equals: 'published' } },
        ],
      },
      depth: 0,
      limit: 100,
      sort: 'order',
    })
    const siblings = siblingsResult.docs as unknown as ArticleDoc[]
    const currentIdx = siblings.findIndex((s) => s.slug === slug)
    if (currentIdx > 0) prevArticle = siblings[currentIdx - 1]
    if (currentIdx !== -1 && currentIdx < siblings.length - 1)
      nextArticle = siblings[currentIdx + 1]
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <nav className="mb-8 flex items-center gap-2 text-sm text-[var(--fg-3)]">
        <Link href="/docs" className="hover:text-[var(--accent-500)] transition-colors">
          Knowledge Base
        </Link>
        <span>/</span>
        {category && (
          <>
            <span className="text-[var(--fg-2)]">{category.name}</span>
            <span>/</span>
          </>
        )}
        <span className="text-[var(--fg-1)] font-medium truncate">{article.title}</span>
      </nav>

      <article>
        <h1 className="text-3xl font-semibold text-[var(--fg-1)] mb-4">{article.title}</h1>
        {article.excerpt && (
          <p className="text-lg text-[var(--fg-2)] leading-relaxed mb-8 border-l-2 border-[var(--accent-500)] pl-4">
            {article.excerpt}
          </p>
        )}
        {Boolean(article.body) && (
          <div className="prose prose-invert max-w-none text-[var(--fg-2)] leading-relaxed [&_h2]:text-[var(--fg-1)] [&_h3]:text-[var(--fg-1)] [&_h4]:text-[var(--fg-1)] [&_a]:text-[var(--accent-500)] [&_strong]:text-[var(--fg-1)] [&_code]:text-[var(--accent-500)] [&_code]:bg-[var(--surface-2)] [&_code]:px-1 [&_code]:rounded">
            <RichText data={article.body as unknown as Parameters<typeof RichText>[0]['data']} />
          </div>
        )}
      </article>

      {(prevArticle || nextArticle) && (
        <div className="mt-12 pt-8 border-t border-[var(--border)] flex items-center justify-between gap-4">
          {prevArticle ? (
            <Button asChild variant="outline" className="gap-2 border-[var(--border)] text-[var(--fg-1)] hover:text-[var(--fg-1)]">
              <Link href={`/docs/${prevArticle.slug}`}>
                <ArrowLeft size={16} />
                <span className="max-w-[160px] truncate">{prevArticle.title}</span>
              </Link>
            </Button>
          ) : (
            <div />
          )}
          {nextArticle ? (
            <Button asChild variant="outline" className="gap-2 border-[var(--border)] text-[var(--fg-1)] hover:text-[var(--fg-1)]">
              <Link href={`/docs/${nextArticle.slug}`}>
                <span className="max-w-[160px] truncate">{nextArticle.title}</span>
                <ArrowRight size={16} />
              </Link>
            </Button>
          ) : (
            <div />
          )}
        </div>
      )}
    </div>
  )
}
