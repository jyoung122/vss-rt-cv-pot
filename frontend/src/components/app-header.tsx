'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Check,
  ChevronRight,
  Download,
  LayoutGrid,
  List,
  MapPinned,
  Plus,
} from 'lucide-react'

import { type UploadRecord } from '@/lib/uploads'
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

export function AppHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [upload, setUpload] = useState<UploadRecord | null>(null)
  const [uploadStats, setUploadStats] = useState<{ total: number; events: number } | null>(null)

  const detailVideoId = useMemo(() => {
    const match = pathname.match(/^\/uploads\/([^/]+)$/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  }, [pathname])

  useEffect(() => {
    if (pathname !== '/uploads') return
    let cancelled = false
    fetch('/api/uploads', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { uploads?: UploadRecord[] }) => {
        if (cancelled) return
        const uploads = d.uploads ?? []
        setUploadStats({
          total: uploads.length,
          events: uploads.reduce((sum, u) => sum + (u.track_count ?? 0), 0),
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
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



  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      {pathname === '/' ? (
        <>
          <div className="flex flex-col justify-center">
            <span className="text font-semibold leading-none tracking-[0.12em] text-[color:var(--accent-400)]">
              City operations · {new Date().toLocaleString('default', { month: 'short', year: 'numeric' })}
            </span>          
          </div>
          <div className="flex-1" />
        </>
      ) : pathname === '/uploads' ? (
        <>
          <div className="flex flex-col justify-center">
            <span className="font-display text-[13px] font-semibold leading-none text-foreground">
              Uploaded videos
            </span>
            <span className="mt-0.5 text-[11px] leading-none text-muted-foreground">
              Analyze footage · flag events with timestamps
            </span>
          </div>
          <div className="flex-1" />
          <div className="hidden md:flex items-center gap-5 mr-1">
            {[
              { label: 'Total uploads', value: uploadStats ? String(uploadStats.total) : '—' },
              { label: 'Events detected', value: uploadStats ? String(uploadStats.events) : '—' },
              { label: 'Avg. analysis', value: '≈real-time' },
            ].map(({ label, value }) => (
              <div key={label} className="text-right">
                <div className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--fg-4)' }}>
                  {label}
                </div>
                <div className="font-display text-sm font-semibold leading-tight">{value}</div>
              </div>
            ))}
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
      ) : pathname === '/live' ? (
        <>
          <span className="font-display text-[13px] font-medium text-foreground">
            Live Ops
          </span>
          <div className="flex-1" />
          <div
            className="flex rounded-[3px] border p-0.5"
            style={{ background: 'var(--surface-2)' }}
          >
            {(['grid', 'list'] as const).map((m) => (
              <button
                key={m}
                onClick={() => router.replace(`/live?view=${m}`, { scroll: false })}
                className={`flex h-[26px] w-[30px] items-center justify-center rounded-[3px] transition-colors ${
                  (searchParams.get('view') ?? 'grid') === m
                    ? 'bg-[var(--surface-3)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'grid' ? <LayoutGrid size={13} /> : <List size={13} />}
              </button>
            ))}
          </div>
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
