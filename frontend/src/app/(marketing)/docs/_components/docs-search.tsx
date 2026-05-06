'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Category = {
  id: string
  name: string
  slug: string
  order?: number | null
}

type Article = {
  id: string
  title: string
  slug: string
  excerpt?: string | null
  order?: number | null
  category?: Category | string | null
}

type DocsSearchProps = {
  articles: Article[]
  categories: Category[]
}

export default function DocsSearch({ articles, categories }: DocsSearchProps) {
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()

  if (q) {
    // Flat filtered results
    const filtered = articles.filter((a) => {
      const title = a.title.toLowerCase()
      const excerpt = (a.excerpt ?? '').toLowerCase()
      return title.includes(q) || excerpt.includes(q)
    })

    return (
      <div className="space-y-4">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-3)]"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search articles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 bg-[var(--surface-1)] border-[var(--border)] text-[var(--fg-1)] placeholder:text-[var(--fg-3)]"
          />
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-[var(--fg-3)] py-4">No articles match &ldquo;{query}&rdquo;.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((article) => (
              <Link key={article.id} href={`/docs/${article.slug}`} className="block group">
                <Card className="h-full bg-[var(--surface-1)] border-[var(--border)] transition-colors group-hover:bg-[var(--surface-2)]">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-[var(--fg-1)]">{article.title}</CardTitle>
                  </CardHeader>
                  {article.excerpt && (
                    <CardContent>
                      <p className="text-sm text-[var(--fg-2)] line-clamp-3">{article.excerpt}</p>
                    </CardContent>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Grouped by category when no search query
  const sortedCategories = [...categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  return (
    <div className="space-y-8">
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-3)]"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder="Search articles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 bg-[var(--surface-1)] border-[var(--border)] text-[var(--fg-1)] placeholder:text-[var(--fg-3)]"
        />
      </div>

      {sortedCategories.map((category) => {
        const catArticles = articles
          .filter((a) => {
            const cat = a.category
            if (!cat) return false
            if (typeof cat === 'string') return cat === category.id
            return cat.id === category.id
          })
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

        if (catArticles.length === 0) return null

        return (
          <section key={category.id}>
            <h2 className="mb-4 text-xl font-semibold text-[var(--fg-1)]">{category.name}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {catArticles.map((article) => (
                <Link key={article.id} href={`/docs/${article.slug}`} className="block group">
                  <Card className="h-full bg-[var(--surface-1)] border-[var(--border)] transition-colors group-hover:bg-[var(--surface-2)]">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base text-[var(--fg-1)]">{article.title}</CardTitle>
                    </CardHeader>
                    {article.excerpt && (
                      <CardContent>
                        <p className="text-sm text-[var(--fg-2)] line-clamp-3">{article.excerpt}</p>
                      </CardContent>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
