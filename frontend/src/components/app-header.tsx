'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  CalendarDays,
  Check,
  ChevronRight,
  Download,
  MapPinned,
  Plus,
  Search,
} from 'lucide-react'

import { type UploadRecord } from '@/lib/uploads'
import { cn } from '@/lib/utils'
import { startTour } from '@/lib/tour'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const RANGES = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: 'Quarter' },
  { id: 'ytd', label: 'YTD' },
] as const

type RangeId = (typeof RANGES)[number]['id']

export function AppHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const [range, setRange] = useState<RangeId>('30d')
  const [upload, setUpload] = useState<UploadRecord | null>(null)
  const [search, setSearch] = useState('')

  const detailVideoId = useMemo(() => {
    const match = pathname.match(/^\/uploads\/([^/]+)$/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  }, [pathname])

  useEffect(() => {
    if (pathname !== '/uploads') return
    setSearch(new URLSearchParams(window.location.search).get('q') ?? '')
  }, [pathname])

  useEffect(() => {
    if (!detailVideoId) {
      setUpload(null)
      return
    }

    let cancelled = false
    setUpload(null)

    async function loadUpload() {
      try {
        const res = await fetch(`/api/uploads/${detailVideoId}`, {
          cache: 'no-store',
        })
        if (!res.ok) {
          if (!cancelled) setUpload(null)
          return
        }
        const data: UploadRecord = await res.json()
        if (!cancelled) setUpload(data)
      } catch {
        if (!cancelled) setUpload(null)
      }
    }

    void loadUpload()

    return () => {
      cancelled = true
    }
  }, [detailVideoId])

  const updateUploadSearch = (value: string) => {
    setSearch(value)
    const params = new URLSearchParams(window.location.search)
    if (value.trim()) {
      params.set('q', value)
    } else {
      params.delete('q')
    }
    const query = params.toString()
    router.replace(query ? `/uploads?${query}` : '/uploads', { scroll: false })
  }

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      {pathname === '/' ? (
        <>
          <span className="font-display text-[13px] font-medium text-foreground">
            Dashboard
          </span>
          <div className="flex-1" />
          <div
            className="flex rounded-[3px] border p-0.5"
            style={{ background: 'var(--surface-2)' }}
          >
            {RANGES.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRange(item.id)}
                className={cn(
                  'h-[26px] rounded-[3px] px-2.5 text-[11px]',
                  range === item.id
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                style={{
                  background:
                    range === item.id ? 'var(--surface-3)' : 'transparent',
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" disabled className="gap-1.5">
            <CalendarDays className="size-3.5" />
            Apr 1 - Apr 30
          </Button>
          <Button variant="outline" size="sm" disabled className="gap-1.5">
            <Download className="size-3.5" />
            Export PDF
          </Button>
        </>
      ) : pathname === '/uploads' ? (
        <>
          <span className="font-display text-[13px] font-medium text-foreground">
            Uploads
          </span>
          <div className="flex-1" />
          <div
            className="flex h-8 w-full max-w-80 items-center gap-2 rounded-[3px] border px-3"
            style={{ background: 'var(--surface-2)' }}
          >
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => updateUploadSearch(e.target.value)}
              placeholder="Search uploads by name"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </>
      ) : detailVideoId ? (
        <>
          <Link
            href="/uploads"
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Uploads
          </Link>
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground/50"
            strokeWidth={1.5}
          />
          <span className="max-w-xs truncate font-mono text-[13px] font-medium text-foreground">
            {upload?.original_filename ?? detailVideoId}
          </span>
          <div className="flex-1" />
          <Badge
            variant="outline"
            className="gap-1.5 border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]"
          >
            <Check className="size-3" strokeWidth={2.5} />
            Analysis complete
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5" disabled>
                <Download className="size-3.5" strokeWidth={1.75} />
                Export report
              </Button>
            </TooltipTrigger>
            <TooltipContent>Coming in v1.5</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="default" size="sm" className="gap-1.5" disabled>
                <Plus className="size-3.5" strokeWidth={2} />
                Create detection rule
              </Button>
            </TooltipTrigger>
            <TooltipContent>Coming in v1.5</TooltipContent>
          </Tooltip>
        </>
      ) : (
        <>
          <span className="font-display text-sm font-semibold tracking-tight">
            SSI AIMS
          </span>
          <div className="flex-1" />
        </>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => startTour(router.push)}
      >
        <MapPinned className="size-3.5" strokeWidth={1.75} />
        Tour
      </Button>
      <ThemeToggle />
    </header>
  )
}
