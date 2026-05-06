'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  Check,
  Clock,
  Filter,
  Grid3x3,
  List as ListIcon,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Upload as UploadIcon,
  Video,
  X,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/utils'
import {
  type UploadRecord,
  formatBytes,
  formatDurationSize,
  formatUploaded,
} from '@/lib/uploads'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { resumeTourIfNeeded } from '@/lib/tour'
import {
  useUploadProgress,
  type UploadStage,
} from '@/lib/use-upload-progress'

const ACCEPT = '.mp4,.mkv'

const SUGGESTIONS = [
  'Traffic incidents',
  'Debris',
  'Wrong-way',
  'Flooding',
  'Signal issues',
]

// Base 5-stage strip — display label and matching slug
const PIPELINE_STAGES_BASE: { label: string; slug: UploadStage }[] = [
  { label: 'Uploading',       slug: 'upload'  },
  { label: 'Ingesting',       slug: 'ingest'  },
  { label: 'Detecting rules', slug: 'rules'   },
  { label: 'Validating',      slug: 'vlm'     },
  { label: 'Done',            slug: 'done'    },
]

// With optional leading Queued stage prepended when this upload was queued
const PIPELINE_STAGES_QUEUED: { label: string; slug: UploadStage }[] = [
  { label: 'Queued',          slug: 'queued'  },
  ...PIPELINE_STAGES_BASE,
]

const STAGE_ORDER_BASE: UploadStage[] = ['upload', 'ingest', 'rules', 'vlm', 'done']
const STAGE_ORDER_QUEUED: UploadStage[] = ['queued', 'upload', 'ingest', 'rules', 'vlm', 'done']

export default function UploadsPage() {
  return (
    <Suspense fallback={<div className="flex-1 p-5 text-sm text-muted-foreground">Loading uploads…</div>}>
      <UploadsContent />
    </Suspense>
  )
}

function UploadsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [items, setItems] = useState<UploadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(
    'Flag any traffic incidents, debris, or wrong-way drivers',
  )

  // Active upload state
  const [activeName, setActiveName] = useState<string | null>(null)
  const [activeSize, setActiveSize] = useState<number>(0)
  const progress = useUploadProgress()

  // Upload modal + preview / delete dialogs
  const [uploadOpen, setUploadOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<UploadRecord | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/uploads', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.uploads ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load uploads')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    resumeTourIfNeeded('uploads', router.push)
  }, [router])

  // When stage reaches done, refresh the list and reset after 1.5 s
  useEffect(() => {
    if (progress.stage !== 'done') return
    void (async () => {
      await refresh()
      setTimeout(() => {
        setActiveName(null)
        setActiveSize(0)
        progress.reset()
      }, 1500)
    })()
  }, [progress.stage]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null)
      setActiveName(file.name)
      setActiveSize(file.size)
      setUploadOpen(false)
      progress.startUpload()

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/upload')
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              progress.setUploadPercent(Math.round((e.loaded / e.total) * 100))
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              progress.setUploadPercent(100)
              try {
                const body = JSON.parse(xhr.responseText) as {
                  video_id?: string
                  duration_s?: number
                  queue_status?: 'queued' | 'active'
                  queue_position?: number
                }
                const vid = body.video_id ?? ''
                const dur = body.duration_s ?? null
                const qs = body.queue_status ?? null
                const qp = body.queue_position ?? null
                progress.uploadDone(vid, dur, qs, qp)
              } catch {
                progress.uploadDone('', null)
              }
              resolve()
            } else if (xhr.status === 503) {
              // Demo queue is full
              let msg = 'Demo queue is full — try again in a moment.'
              try {
                const body = JSON.parse(xhr.responseText) as { error?: string; queue_depth?: number }
                if (body.error === 'queue full') {
                  msg = `Demo queue is full${body.queue_depth != null ? ` (${body.queue_depth} jobs)` : ''} — try again in a moment.`
                }
              } catch { /* use default msg */ }
              reject(new Error(msg))
            } else {
              reject(new Error(`Upload failed: HTTP ${xhr.status}`))
            }
          }
          xhr.onerror = () => reject(new Error('Network error'))
          const fd = new FormData()
          fd.append('file', file)
          // Attach the current query as prompt so the backend stores it
          if (query.trim()) fd.append('prompt', query.trim())
          xhr.send(fd)
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed'
        setError(msg)
        progress.uploadError(msg)
        setActiveName(null)
        setActiveSize(0)
      } finally {
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [query, progress],
  )

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!ACCEPT.split(',').some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setError(`Only ${ACCEPT} accepted`)
      return
    }
    void handleUpload(file)
  }

  const handleDelete = async (item: UploadRecord) => {
    try {
      const res = await fetch(`/api/uploads/${item.video_id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setPendingDelete(null)
    }
  }

  const [search, setSearch] = useState(searchParams.get('q') ?? '')
  const view = (searchParams.get('view') ?? 'list') as 'list' | 'grid'
  const filtered = items.filter((u) =>
    u.original_filename.toLowerCase().includes(search.toLowerCase()),
  )

  const setView = (v: 'list' | 'grid') => {
    const params = new URLSearchParams(window.location.search)
    params.set('view', v)
    router.replace(`/uploads?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-5">
        <div className="w-full">
          {/* Active upload card */}
          {activeName && (
            <Card
              className="relative mb-5 overflow-hidden rounded-[3px] p-4"
              style={{
                border:
                  '1px solid color-mix(in srgb, var(--accent-500) 30%, var(--border))',
                background: 'var(--surface-1)',
              }}
            >
              {progress.stage !== 'done' && progress.stage !== 'error' && (
                <div className="ov-sweep pointer-events-none absolute inset-0" />
              )}
              <div className="relative flex items-center gap-3.5">
                <div
                  className="grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded-[2px] border"
                  style={{ background: '#000' }}
                >
                  <Video
                    className="size-5 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <div className="font-mono text-[13px] font-medium text-foreground truncate">
                      {activeName}
                    </div>
                    <StageBadge stage={progress.stage} error={progress.error} />
                  </div>
                  <div className="mb-2.5 truncate text-xs text-muted-foreground">
                    {formatBytes(activeSize)} · query: &quot;
                    {query.length > 80 ? query.slice(0, 80) + '…' : query}
                    &quot;
                  </div>
                  <PipelineStrip
                    stage={progress.stage}
                    percent={progress.percent}
                    sub={progress.sub}
                    error={progress.error}
                    queuePosition={progress.queuePosition}
                    wasQueued={progress.wasQueued}
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Recent uploads */}
          <div data-tour="uploads-list">
            <div className="mb-3 flex items-center gap-2.5">
              <div
                className="flex h-8 w-full max-w-164 items-center gap-2 rounded-[3px] border px-3"
                style={{ background: 'var(--surface-2)' }}
              >
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => {
                    const v = e.target.value
                    setSearch(v)
                    const params = new URLSearchParams(window.location.search)
                    if (v.trim()) { params.set('q', v) } else { params.delete('q') }
                    router.replace(`/uploads?${params.toString()}`, { scroll: false })
                  }}
                  placeholder="Search by name"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <Button
                onClick={() => setUploadOpen(true)}
                disabled={!!activeName}
                size="sm"
                className="gap-1.5 shrink-0"
              >
                <UploadIcon className="size-3.5" strokeWidth={2} />
                Upload video
              </Button>
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
              >
                <Filter className="size-3.5" strokeWidth={1.75} />
                Filter
              </Button>
              <div
                className="flex rounded-[3px] border p-0.5"
                style={{ background: 'var(--surface-2)' }}
              >
                {(['list', 'grid'] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setView(m)}
                    className={cn(
                      'h-[26px] gap-1 rounded-[3px] px-2.5 text-[11px]',
                      view === m ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    style={view === m ? { background: 'var(--surface-3)' } : undefined}
                  >
                    {m === 'list'
                      ? <><ListIcon className="size-3" strokeWidth={1.75} /> List</>
                      : <><Grid3x3 className="size-3" strokeWidth={1.75} /> Grid</>
                    }
                  </Button>
                ))}
              </div>
            </div>

            {/* Empty / loading states — shared across both views */}
            {loading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {items.length === 0
                  ? 'No uploads yet. Click "Upload video" to get started.'
                  : 'No uploads match your search.'}
              </div>
            ) : view === 'grid' ? (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {filtered.map((u) => (
                  <Card
                    key={u.video_id}
                    className="group relative overflow-hidden rounded-[3px] p-0 transition-shadow hover:shadow-md"
                  >
                    {/* Thumbnail */}
                    <Link href={`/uploads/${u.video_id}`} className="block">
                      <div
                        className="relative aspect-video w-full overflow-hidden"
                        style={{ background: '#000' }}
                      >
                        {u.thumbnail_url ? (
                          <img
                            src={u.thumbnail_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                            <Video className="size-8" strokeWidth={1.25} />
                          </div>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                          <ArrowUpRight className="size-5 text-white" strokeWidth={1.75} />
                        </div>
                      </div>
                    </Link>

                    {/* Card body */}
                    <div className="p-3">
                      <Link
                        href={`/uploads/${u.video_id}`}
                        className="block truncate font-mono text-[12px] font-medium text-foreground hover:text-primary transition-colors"
                      >
                        {u.original_filename}
                      </Link>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <Badge
                          variant="outline"
                          className="gap-1 border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)] text-[10px]"
                        >
                          <Check className="size-2.5" strokeWidth={2.5} />
                          analyzed
                        </Badge>
                        {u.track_count > 0 && (
                          <span
                            className="font-mono text-[10px]"
                            style={{ color: 'var(--accent-400)' }}
                          >
                            {u.track_count} tracked
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {formatDurationSize(u.duration_s, u.size_bytes)}
                        </span>
                        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setPreviewUrl(u.playback_url)}
                                className="size-6 text-muted-foreground"
                                aria-label="Quick preview"
                              >
                                <ArrowUpRight className="size-3" strokeWidth={1.75} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Quick preview</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setPendingDelete(u)}
                                className="size-6 text-muted-foreground hover:bg-destructive/15 hover:text-[color:var(--danger-500)]"
                                aria-label="Delete"
                              >
                                <Trash2 className="size-3" strokeWidth={1.75} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <>
                {/* Table header — list view only */}
                <div
                  className="grid items-center gap-4 border-b py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                  style={{
                    gridTemplateColumns: '90px 1fr 120px 110px 130px 180px 70px',
                    color: 'var(--fg-4)',
                  }}
                >
                  <div>Preview</div>
                  <div>File · Query</div>
                  <div>Status</div>
                  <div>Tracks</div>
                  <div>Duration · Size</div>
                  <div>Uploaded</div>
                  <div className="text-right">Actions</div>
                </div>
                {filtered.map((u, idx) => (
                  <div
                    key={u.video_id}
                    className="grid items-center gap-4 border-b py-3.5 text-[13px] transition-colors hover:bg-secondary/30"
                    style={{
                      gridTemplateColumns: '90px 1fr 120px 110px 130px 180px 70px',
                      background:
                        idx % 2 === 1
                          ? 'color-mix(in srgb, var(--fg-1) 2%, transparent)'
                          : 'transparent',
                    }}
                  >
                    {/* Preview thumbnail — clicking navigates to detail */}
                    <Link href={`/uploads/${u.video_id}`} className="block">
                      <div
                        className="relative h-12 w-[84px] overflow-hidden rounded-[2px] border hover:ring-1 hover:ring-primary/50 transition-all"
                        style={{ background: '#000' }}
                      >
                        {u.thumbnail_url ? (
                          <img
                            src={u.thumbnail_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-muted-foreground">
                            <Video className="size-5" strokeWidth={1.5} />
                          </div>
                        )}
                      </div>
                    </Link>

                    {/* File · Query */}
                    <div className="min-w-0">
                      <Link
                        href={`/uploads/${u.video_id}`}
                        className="block hover:text-primary transition-colors"
                      >
                        <div className="truncate font-mono text-xs font-medium text-foreground">
                          {u.original_filename}
                        </div>
                      </Link>
                      {u.prompt ? (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Sparkles
                            className="size-2.5 shrink-0"
                            strokeWidth={1.75}
                            style={{ color: 'var(--accent-400)' }}
                          />
                          <span className="truncate">
                            {u.prompt.length > 80
                              ? u.prompt.slice(0, 80) + '…'
                              : u.prompt}
                          </span>
                        </div>
                      ) : (
                        <div className="mt-1 text-[11px] text-muted-foreground/40">
                          —
                        </div>
                      )}
                    </div>

                    {/* Status */}
                    <div>
                      <Badge
                        variant="outline"
                        className="gap-1 border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]"
                      >
                        <Check className="size-3" strokeWidth={2} />
                        analyzed
                      </Badge>
                    </div>

                    {/* Tracks */}
                    <div>
                      {u.track_count > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="secondary"
                            className="font-mono h-6 min-w-[28px] justify-center px-1.5 text-[11px]"
                            style={{
                              background:
                                'color-mix(in srgb, var(--accent-500) 18%, transparent)',
                              color: 'var(--accent-400)',
                            }}
                          >
                            {u.track_count}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            tracked
                          </span>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/50">
                          No detections
                        </span>
                      )}
                    </div>

                    {/* Duration · Size */}
                    <div className="font-mono text-xs text-foreground/80">
                      {formatDurationSize(u.duration_s, u.size_bytes)}
                    </div>

                    {/* Uploaded */}
                    <div className="text-xs text-muted-foreground">
                      {formatUploaded(u.uploaded_at)}
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setPreviewUrl(u.playback_url)}
                            className="size-7 text-muted-foreground"
                            aria-label="Quick preview"
                          >
                            <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Quick preview</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setPendingDelete(u)}
                            className="size-7 text-muted-foreground hover:bg-destructive/15 hover:text-[color:var(--danger-500)]"
                            aria-label="Delete"
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.75} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </>
            )}

            {error && (
              <div
                className="mt-4 flex items-start gap-2 rounded-[3px] border px-3 py-2 text-xs"
                style={{
                  borderColor:
                    'color-mix(in srgb, var(--danger-500) 40%, var(--border))',
                  background:
                    'color-mix(in srgb, var(--danger-500) 8%, transparent)',
                  color: 'var(--danger-500)',
                }}
              >
                <X className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Upload modal */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display text-base">Upload video</DialogTitle>
            <DialogDescription>
              Drop a clip or select a file, then describe what AIMS should look for.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Dropzone */}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              className={cn(
                'flex w-full flex-col items-center justify-center gap-2 rounded-[3px] border px-6 py-8 text-center transition-colors',
                dragActive ? 'ring-2 ring-primary/40' : 'hover:bg-secondary/30',
              )}
              style={{ background: 'var(--surface-2)' }}
            >
              <div
                className="grid size-10 place-items-center rounded-[3px]"
                style={{
                  background: 'color-mix(in srgb, var(--accent-500) 14%, transparent)',
                  color: 'var(--accent-400)',
                }}
              >
                <UploadIcon className="size-5" strokeWidth={1.75} />
              </div>
              <div className="font-display text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                Drop a video here
              </div>
              <div className="text-xs text-muted-foreground">
                MP4 or MKV · up to 500 MB · H.264 or H.265
              </div>
              <div className="mt-1 flex gap-2">
                <span
                  className="inline-flex h-7 items-center gap-1.5 rounded-[3px] px-3 text-xs font-medium text-white"
                  style={{ background: 'var(--accent-500)' }}
                >
                  <UploadIcon className="size-3.5" strokeWidth={2} />
                  Select file
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border px-3 text-xs font-medium text-muted-foreground"
                      style={{ background: 'var(--surface-1)' }}
                    >
                      <Video className="size-3.5" strokeWidth={1.75} />
                      Pull from camera archive
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Coming in v2</TooltipContent>
                </Tooltip>
              </div>
            </button>

            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              onChange={onPickFile}
              className="hidden"
            />

            {/* Query */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground/80">
                <Sparkles
                  className="size-[13px]"
                  strokeWidth={1.75}
                  style={{ color: 'var(--accent-400)' }}
                />
                What should AIMS look for?
              </label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-[3px] border px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary/60"
                style={{
                  background: 'var(--surface-1)',
                  color: 'var(--fg-1)',
                  fontFamily: 'var(--font-sans)',
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setQuery((q) =>
                        q.endsWith(s) ? q : `${q.replace(/\s+$/, '')} · ${s}`,
                      )
                    }
                    className="h-6 rounded-full px-2 text-[11px]"
                  >
                    + {s}
                  </Button>
                ))}
              </div>
              <div className="flex gap-3.5 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Shield className="size-3" strokeWidth={1.75} />
                  Faces &amp; plates auto-redacted on ingest
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" strokeWidth={1.75} />
                  Typical: real-time on GPU
                </span>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview modal */}
      <Dialog open={!!previewUrl} onOpenChange={(o) => { if (!o) setPreviewUrl(null) }}>
        <DialogContent className="max-w-4xl p-0">
          <video src={previewUrl ?? undefined} controls autoPlay className="w-full bg-black" />
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this upload?</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-foreground">{pendingDelete?.original_filename}</span>{' '}
              will be permanently removed from the server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (pendingDelete) void handleDelete(pendingDelete) }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


function StageBadge({ stage, error }: { stage: UploadStage; error: string | null }) {
  if (stage === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 text-[11px] border-[color:var(--danger-500)]/40 bg-[color:var(--danger-500)]/10 text-[color:var(--danger-500)]"
          >
            <X className="size-3" strokeWidth={2} />
            Error
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{error ?? 'Unknown error'}</TooltipContent>
      </Tooltip>
    )
  }
  const isDone = stage === 'done'
  const labelMap: Record<UploadStage, string> = {
    idle: 'Idle',
    queued: 'Queued',
    upload: 'Uploading',
    ingest: 'Ingesting',
    rules: 'Detecting rules',
    vlm: 'Validating',
    done: 'Complete',
    error: 'Error',
  }
  const Icon = isDone ? Check : Sparkles
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 text-[11px]',
        isDone
          ? 'border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]'
          : 'border-[color:var(--accent-500)]/40 bg-[color:var(--accent-500)]/10 text-[color:var(--accent-400)]',
      )}
    >
      <Icon className="size-3" strokeWidth={2} />
      {labelMap[stage]}
    </Badge>
  )
}

// ── Pipeline strip (5 stages, or 6 when wasQueued=true) ────────────────────
function PipelineStrip({
  stage,
  percent,
  sub,
  error,
  queuePosition,
  wasQueued,
}: {
  stage: UploadStage
  percent: number
  sub: string | null
  error: string | null
  queuePosition: number | null
  wasQueued: boolean
}) {
  const PIPELINE_STAGES = wasQueued ? PIPELINE_STAGES_QUEUED : PIPELINE_STAGES_BASE
  const STAGE_ORDER = wasQueued ? STAGE_ORDER_QUEUED : STAGE_ORDER_BASE

  const activeIdx = STAGE_ORDER.indexOf(stage)
  const isError = stage === 'error'

  // When stage=error, activeIdx=-1; we track which pill was last active via
  // a separate concept: the error occurs at whichever pill was last active.
  // We surface the error tooltip on the first pill in the error case.
  const errorPillSlug = isError ? (PIPELINE_STAGES[0]?.slug ?? 'upload') : null

  // Sub-text for the Queued pill
  const queueSub =
    stage === 'queued'
      ? queuePosition === 0
        ? 'next up'
        : queuePosition != null
          ? `${queuePosition} ahead — waiting for DeepStream`
          : 'waiting for DeepStream'
      : null

  return (
    <div>
      {/* Progress bars */}
      <div className="flex gap-1">
        {PIPELINE_STAGES.map(({ slug }, i) => {
          const done = !isError && activeIdx > i
          const active = !isError && activeIdx === i
          const isUploadSlot = slug === 'upload'
          const isQueuedSlot = slug === 'queued'

          const width = done
            ? '100%'
            : active && isUploadSlot
              ? `${percent}%`
              : active && isQueuedSlot
                ? '40%'   // indeterminate-ish progress for queued state
                : active
                  ? '60%'
                  : '0%'

          return (
            <div
              key={slug}
              className="relative h-1.5 flex-1 overflow-hidden rounded-[1px]"
              style={{ background: 'var(--surface-3)' }}
            >
              <div
                className="h-full transition-[width] duration-300"
                style={{
                  width,
                  background: done
                    ? 'var(--ok-500)'
                    : isQueuedSlot && active
                      ? 'var(--fg-3)'   // muted color for queued state
                      : 'var(--accent-500)',
                }}
              />
            </div>
          )
        })}
      </div>

      {/* Labels row */}
      <div
        className="mt-1.5 flex justify-between font-mono text-[10px] tracking-[0.04em]"
        style={{ color: 'var(--fg-4)' }}
      >
        {PIPELINE_STAGES.map(({ label, slug }, i) => {
          const active = !isError && activeIdx === i
          // VLM is greyed with "—" only when stage=done and we went idle→upload→ingest→rules→done
          // (skipped vlm). Since STAGE_ORDER has vlm at index 3 and done at 4, activeIdx===4
          // and we check i===3. But by the time stage=done, activeIdx===4 > 3, so vlm bar
          // shows done (green) which is fine. No need for a special skip variant in the bars.
          // For the label, we show "—" if this was the vlm pill and we had no vlm stage.
          // We can't easily detect "was vlm entered?" post-hoc with only stage, so we always
          // show the label. The plan's "grey pill with —" is for the ACTIVE state when
          // vlm_enabled=false — that's handled in the hook (it never enters vlm stage).
          const showErrorHere = isError && slug === errorPillSlug
          const isQueuedSlot = slug === 'queued'

          return (
            <div key={slug} className="flex flex-col items-start">
              <span
                style={
                  active && isQueuedSlot
                    ? { color: 'var(--fg-2)' }
                    : active
                      ? { color: 'var(--accent-400)' }
                      : {}
                }
              >
                {label.toUpperCase()}
              </span>
              {active && isQueuedSlot && queueSub && (
                <span
                  className="mt-0.5 text-[9px] normal-case tracking-normal"
                  style={{ color: 'var(--fg-4)', opacity: 0.7 }}
                >
                  {queueSub}
                </span>
              )}
              {active && !isQueuedSlot && sub && (
                <span
                  className="mt-0.5 text-[9px] normal-case tracking-normal"
                  style={{ color: 'var(--fg-4)', opacity: 0.6 }}
                >
                  {sub}
                </span>
              )}
              {showErrorHere && error && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="mt-0.5 text-[9px] normal-case tracking-normal cursor-help"
                      style={{ color: 'var(--danger-500)', opacity: 0.8 }}
                    >
                      error
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{error}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
