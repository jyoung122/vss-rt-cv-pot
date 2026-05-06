"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeft, BookOpen, LogIn, Search } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type DocsCategory = {
  id: string
  name: string
  slug: string
  order?: number | null
}

export type DocsArticle = {
  id: string
  title: string
  slug: string
  order?: number | null
  category?: DocsCategory | string | null
}

function categoryIdOf(article: DocsArticle): string | null {
  const c = article.category
  if (!c) return null
  if (typeof c === "string") return c
  return c.id
}

export function DocsSidebar({
  categories,
  articles,
}: {
  categories: DocsCategory[]
  articles: DocsArticle[]
}) {
  const pathname = usePathname()
  const [query, setQuery] = React.useState("")

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return articles
    return articles.filter((a) => a.title.toLowerCase().includes(q))
  }, [articles, query])

  const byCategory = React.useMemo(() => {
    const map = new Map<string, DocsArticle[]>()
    for (const a of filtered) {
      const cid = categoryIdOf(a)
      if (!cid) continue
      const list = map.get(cid) ?? []
      list.push(a)
      map.set(cid, list)
    }
    return map
  }, [filtered])

  return (
    <Sidebar>
      <SidebarHeader>
        <Link href="/docs" className="flex items-center gap-2 px-2 py-3">
          <BookOpen className="size-5 text-[var(--accent-500)]" />
          <span className="text-sm font-semibold text-[var(--fg-1)]">Knowledge Base</span>
        </Link>
        <div className="px-2 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-3)]" />
            <Input
              type="search"
              placeholder="Filter articles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-sm"
              aria-label="Filter docs"
            />
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {categories.map((cat) => {
          const items = byCategory.get(cat.id) ?? []
          if (query.trim() && items.length === 0) return null
          return (
            <SidebarGroup key={cat.id}>
              <SidebarGroupLabel>{cat.name}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.length === 0 ? (
                    <SidebarMenuItem>
                      <span className="px-2 py-1.5 text-xs text-[var(--fg-3)]">
                        No articles yet
                      </span>
                    </SidebarMenuItem>
                  ) : (
                    items.map((a) => {
                      const href = `/docs/${a.slug}`
                      const active = pathname === href
                      return (
                        <SidebarMenuItem key={a.id}>
                          <SidebarMenuButton asChild isActive={active}>
                            <Link href={href}>{a.title}</Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-2">
          <Button asChild variant="ghost" size="sm" className="flex-1 justify-start text-[var(--fg-2)] hover:text-[var(--fg-1)]">
            <Link href="/">
              <ArrowLeft className="mr-1 size-4" />
              Back to app
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">
            <Link href="/login">
              <LogIn className="mr-1 size-4" />
              Sign in
            </Link>
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
