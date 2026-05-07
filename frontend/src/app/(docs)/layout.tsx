import { getPayload } from 'payload'
import configPromise from '@/payload/payload.config'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { DocsSidebar, type DocsArticle, type DocsCategory } from '@/components/docs-sidebar'

export const dynamic = 'force-dynamic'

async function loadNav(): Promise<{
  categories: DocsCategory[]
  articles: DocsArticle[]
}> {
  try {
    const payload = await getPayload({ config: configPromise })
    const [cats, arts] = await Promise.all([
      payload.find({
        collection: 'categories',
        limit: 100,
        sort: 'order',
        depth: 0,
      }),
      payload.find({
        collection: 'articles',
        where: { _status: { equals: 'published' } },
        limit: 500,
        sort: 'order',
        depth: 1,
      }),
    ])
    return {
      categories: cats.docs as unknown as DocsCategory[],
      articles: arts.docs as unknown as DocsArticle[],
    }
  } catch {
    return { categories: [], articles: [] }
  }
}

export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { categories, articles } = await loadNav()

  return (
    <SidebarProvider className="h-svh">
      <DocsSidebar categories={categories} articles={articles} />
      <SidebarInset className="min-h-0 overflow-auto bg-[var(--bg)] text-[var(--fg-1)]">
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
