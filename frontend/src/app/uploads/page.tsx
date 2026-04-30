'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

import { cn } from '@/lib/utils'
import {
  type UploadRecord,
  formatBytes,
  formatDurationSize,
  formatUploaded,
} from '@/lib/uploads'

const ACCEPT = '.mp4,.mkv'

const SUGGESTIONS = [
  'Traffic incidents',
  'Debris',
  'Wrong-way',
  'Flooding',
  'Signal issues',
]

const STAGES = ['Upload', 'Ingest', 'CV analysis', 'Index events'] as const
const STAGE_LABELS = ['UPLOAD', 'INGEST', 'CV ANALYSIS', 'INDEX'] as const

export default function UploadsPage() {
  const [items, setItems] = useState<UploadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState(
    'Flag any traffic incidents, debris, or wrong-way drivers',
  )

  // Active upload state
  const [activeName, setActiveName] = useState<string | null>(null)
  const [activeSize, setActiveSize] = useState<number>(0)
  const [uploadPct, setUploadPct] = useState(0)
  const [stage, setStage] = useState(0) // 0 upload, 1 ingest, 2 analyze, 3 done
  const stageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Preview / delete dialogs
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

  // After upload completes, advance simulated post-upload stages
  useEffect(() => {
    if (stage <= 0 || stage >= 3) return
    stageTimer.current = setTimeout(() => setStage((s) => s + 1), 1400)
    return () => {
      if (stageTimer.current) clearTimeout(stageTimer.current)
    }
  }, [stage])

  // When stage hits 3 (done), refresh the list and clear active
  useEffect(() => {
    if (stage !== 3) return
    void (async () => {
      await refresh()
      setTimeout(() => {
        setActiveName(null)
        setActiveSize(0)
        setUploadPct(0)
        setStage(0)
      }, 1200)
    })()
  }, [stage, refresh])

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null)
      setActiveName(file.name)
      setActiveSize(file.size)
      setUploadPct(0)
      setStage(0)

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/upload')
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadPct(Math.round((e.loaded / e.total) * 100))
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setUploadPct(100)
              setStage(1)
              resolve()
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
        setError(err instanceof Error ? err.message : 'Upload failed')
        setActiveName(null)
        setUploadPct(0)
        setStage(0)
      } finally {
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [query],
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

  const filtered = items.filter((u) =>
    u.original_filename.toLowerCase().includes(search.toLowerCase()),
  )

  // Total tracks across all uploads for the stats header
  const totalTracks = items.reduce((sum, u) => sum + (u.track_count ?? 0), 0)

  const stageDoneOrActive = (i: number) => {
    if (i === 0) return { done: uploadPct >= 100, active: stage === 0 }
    return { done: i < stage, active: i === stage && stage < 3 }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top filter bar — search */}
      <div
        className="flex h-12 shrink-0 items-center gap-3 border-b px-5"
        style={{ background: 'var(--surface-1)' }}
      >
        <span className="font-display text-[13px] font-medium text-foreground">
          Uploads
        </span>
        <div className="flex-1" />
        <div
          className="flex h-8 w-80 items-center gap-2 rounded-[3px] border px-3"
          style={{ background: 'var(--surface-2)' }}
        >
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search uploads by name"
            className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="mx-auto max-w-[1280px]">
          {/* Page header */}
          <div className="mb-5 flex items-baseline justify-between">
            <div>
              <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.02em]">
                Uploaded videos
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Analyze recorded footage against a natural-language query.
                Events are flagged with timestamps.
              </p>
            </div>
            <div className="flex gap-7">
              <Stat label="Total uploads" value={items.length.toString()} />
              <Stat
                label="Events detected"
                value={items.length === 0 ? '—' : totalTracks.toString()}
                hint="Sum of tracked objects across all uploads"
              />
              <Stat label="Avg. analysis" value="≈real-time" />
            </div>
          </div>

          {/* Dropzone + query */}
          <div
            className="grid grid-cols-1 gap-6 rounded-md p-6 lg:grid-cols-2"
            style={{
              border:
                '1.5px dashed color-mix(in srgb, var(--accent-500) 40%, var(--border))',
              background:
                'color-mix(in srgb, var(--accent-500) 5%, var(--surface-1))',
            }}
          >
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              disabled={!!activeName}
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-[3px] border px-6 py-5 text-center transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
                dragActive && 'ring-2 ring-primary/40',
              )}
              style={{ background: 'var(--surface-1)' }}
            >
              <div
                className="grid size-12 place-items-center rounded-[3px]"
                style={{
                  background:
                    'color-mix(in srgb, var(--accent-500) 14%, transparent)',
                  color: 'var(--accent-400)',
                }}
              >
                <UploadIcon className="size-[22px]" strokeWidth={1.75} />
              </div>
              <div className="font-display text-[17px] font-semibold tracking-[-0.01em] text-foreground">
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
                <span
                  className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border px-3 text-xs font-medium text-muted-foreground"
                  style={{ background: 'var(--surface-2)' }}
                  title="Coming in v2"
                >
                  <Video className="size-3.5" strokeWidth={1.75} />
                  Pull from camera archive
                </span>
              </div>
            </button>

            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              onChange={onPickFile}
              className="hidden"
              disabled={!!activeName}
            />

            <div className="flex flex-col gap-2">
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
                rows={4}
                className="resize-none rounded-[3px] border px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary/60"
                style={{
                  background: 'var(--surface-1)',
                  color: 'var(--fg-1)',
                  fontFamily: 'var(--font-sans)',
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() =>
                      setQuery((q) =>
                        q.endsWith(s) ? q : `${q.replace(/\s+$/, '')} · ${s}`,
                      )
                    }
                    className="h-6 cursor-pointer rounded-full border px-2 text-[11px] text-foreground/85 transition-colors hover:border-primary/50"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    + {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-3.5 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Shield className="size-3" strokeWidth={1.75} />
                  Faces & plates auto-redacted on ingest
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" strokeWidth={1.75} />
                  Typical: real-time on GPU
                </span>
              </div>
            </div>
          </div>

          {/* Active upload card */}
          {activeName && (
            <div
              className="relative mt-5 overflow-hidden rounded-[3px] p-4"
              style={{
                border:
                  '1px solid color-mix(in srgb, var(--accent-500) 30%, var(--border))',
                background: 'var(--surface-1)',
              }}
            >
              {stage < 3 && (
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
                    <StageBadge stage={stage} />
                  </div>
                  <div className="mb-2.5 truncate text-xs text-muted-foreground">
                    {formatBytes(activeSize)} · query: &quot;
                    {query.length > 80 ? query.slice(0, 80) + '…' : query}
                    &quot;
                  </div>
                  <div className="flex gap-1">
                    {STAGES.map((label, i) => {
                      const { done, active } = stageDoneOrActive(i)
                      const width = done
                        ? '100%'
                        : active && i === 0
                          ? `${uploadPct}%`
                          : active
                            ? '60%'
                            : '0%'
                      return (
                        <div
                          key={label}
                          className="relative h-1.5 flex-1 overflow-hidden rounded-[1px]"
                          style={{ background: 'var(--surface-3)' }}
                        >
                          <div
                            className="h-full transition-[width] duration-300"
                            style={{
                              width,
                              background: done
                                ? 'var(--ok-500)'
                                : 'var(--accent-500)',
                            }}
                          />
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className="mt-1.5 flex justify-between font-mono text-[10px] tracking-[0.04em]"
                    style={{ color: 'var(--fg-4)' }}
                  >
                    {STAGE_LABELS.map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Recent uploads */}
          <div className="mt-7">
            <div className="mb-3 flex items-center gap-2.5">
              <div className="text-[13px] font-semibold text-foreground">
                Recent uploads · {filtered.length}
              </div>
              <div className="flex-1" />
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-[3px] px-2.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Filter className="size-3.5" strokeWidth={1.75} />
                Filter
              </button>
              <div
                className="flex rounded-[3px] border p-0.5"
                style={{ background: 'var(--surface-2)' }}
              >
                <button
                  type="button"
                  className="inline-flex h-[26px] items-center gap-1 rounded-[3px] px-2.5 text-[11px] text-foreground"
                  style={{ background: 'var(--surface-3)' }}
                >
                  <ListIcon className="size-3" strokeWidth={1.75} /> List
                </button>
                <button
                  type="button"
                  className="inline-flex h-[26px] items-center gap-1 rounded-[3px] px-2.5 text-[11px] text-muted-foreground"
                  title="Grid view — coming soon"
                >
                  <Grid3x3 className="size-3" strokeWidth={1.75} /> Grid
                </button>
              </div>
            </div>

            {/* Table header */}
            <div
              className="grid items-center gap-4 border-b px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
              style={{
                gridTemplateColumns:
                  '90px 1fr 120px 110px 130px 180px 70px',
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

            {/* Empty / loading / error states */}
            {loading ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {items.length === 0
                  ? 'No uploads yet. Drop a clip above to get started.'
                  : 'No uploads match your search.'}
              </div>
            ) : (
              filtered.map((u, idx) => (
                <div
                  key={u.video_id}
                  className="grid items-center gap-4 border-b px-4 py-3.5 text-[13px] transition-colors hover:bg-secondary/30"
                  style={{
                    gridTemplateColumns:
                      '90px 1fr 120px 110px 130px 180px 70px',
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
                      <div className="grid h-full w-full place-items-center text-muted-foreground">
                        <Video className="size-5" strokeWidth={1.5} />
                      </div>
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
                    <span
                      className="inline-flex items-center gap-1 rounded-[3px] px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        background:
                          'color-mix(in srgb, var(--ok-500) 14%, transparent)',
                        color: 'var(--ok-300)',
                      }}
                    >
                      <Check className="size-3" strokeWidth={2} />
                      analyzed
                    </span>
                  </div>

                  {/* Tracks */}
                  <div>
                    {u.track_count > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-[3px] px-1.5 font-mono text-[11px] font-semibold"
                          style={{
                            background:
                              'color-mix(in srgb, var(--accent-500) 18%, transparent)',
                            color: 'var(--accent-400)',
                          }}
                        >
                          {u.track_count}
                        </span>
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
                    <button
                      type="button"
                      onClick={() => setPreviewUrl(u.playback_url)}
                      className="inline-flex size-7 items-center justify-center rounded-[3px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                      title="Quick preview"
                    >
                      <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(u)}
                      className="inline-flex size-7 items-center justify-center rounded-[3px] text-muted-foreground hover:bg-destructive/15 hover:text-[color:var(--danger-500)]"
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              ))
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

      {/* Preview modal */}
      {previewUrl && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewUrl(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-4xl overflow-hidden rounded-md border"
            style={{ background: 'var(--surface-1)' }}
          >
            <button
              type="button"
              onClick={() => setPreviewUrl(null)}
              className="absolute right-2 top-2 z-10 inline-flex size-8 items-center justify-center rounded-[3px] bg-black/40 text-white hover:bg-black/60"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
            <video
              src={previewUrl}
              controls
              autoPlay
              className="block w-full bg-black"
            />
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingDelete(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-md border p-5"
            style={{ background: 'var(--surface-1)' }}
          >
            <h2 className="font-display text-base font-semibold">
              Delete this upload?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-mono text-foreground">
                {pendingDelete.original_filename}
              </span>{' '}
              will be permanently removed from the server.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="inline-flex h-8 items-center rounded-[3px] border px-3 text-xs hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDelete(pendingDelete)}
                className="inline-flex h-8 items-center rounded-[3px] px-3 text-xs font-medium text-white"
                style={{ background: 'var(--danger-500)' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="text-right" title={hint}>
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.1em]"
        style={{ color: 'var(--fg-4)' }}
      >
        {label}
      </div>
      <div className="font-display text-base font-semibold">{value}</div>
    </div>
  )
}

function StageBadge({ stage }: { stage: number }) {
  const label =
    stage === 0
      ? 'Uploading'
      : stage === 1
        ? 'Ingesting'
        : stage === 2
          ? 'Analyzing'
          : 'Complete'
  const Icon = stage === 3 ? Check : Sparkles
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        background:
          stage === 3
            ? 'color-mix(in srgb, var(--ok-500) 14%, transparent)'
            : 'color-mix(in srgb, var(--accent-500) 14%, transparent)',
        color: stage === 3 ? 'var(--ok-300)' : 'var(--accent-400)',
      }}
    >
      <Icon className="size-3" strokeWidth={2} />
      {label}
    </span>
  )
}
