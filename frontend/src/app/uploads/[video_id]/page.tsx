'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Video,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  type UploadRecord,
  type TrackSummary,
  formatBytes,
} from '@/lib/uploads'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// Suppress "unused import" — cn is available for future use
void cn

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

const CLASS_COLORS: Record<string, string> = {
  car: 'var(--accent-500)',
  bicycle: '#3a9560',
  person: '#6b7ec2',
  road_sign: '#e09222',
}

function classColor(cls: string): string {
  return CLASS_COLORS[cls] ?? 'var(--accent-500)'
}

function classPillStyle(cls: string): React.CSSProperties {
  const color = classColor(cls)
  return {
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
    color: color,
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function UploadDetailPage() {
  const params = useParams<{ video_id: string }>()
  const videoId = params.video_id

  const [upload, setUpload] = useState<UploadRecord | null>(null)
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Player state
  const videoRef = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedTrackIdx, setSelectedTrackIdx] = useState<number | null>(null)

  // ─── Data fetch ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const [uploadRes, eventsRes] = await Promise.all([
        fetch(`/api/uploads/${videoId}`, { cache: 'no-store' }),
        fetch(`/api/uploads/${videoId}/events?group=tracks`, { cache: 'no-store' }),
      ])
      if (uploadRes.status === 404) {
        setNotFound(true)
        return
      }
      if (!uploadRes.ok) throw new Error(`HTTP ${uploadRes.status}`)
      const uploadData: UploadRecord = await uploadRes.json()
      setUpload(uploadData)

      if (eventsRes.ok) {
        const eventsData = await eventsRes.json()
        setTracks(eventsData.events ?? [])
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [videoId])

  useEffect(() => { void load() }, [load])

  // ─── Player helpers ────────────────────────────────────────────────────────

  const seekTo = useCallback((s: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = s
      setTime(s)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const vid = videoRef.current
    if (!vid) return
    if (playing) {
      vid.pause()
      setPlaying(false)
    } else {
      void vid.play()
      setPlaying(true)
    }
  }, [playing])

  const prevTrack = useCallback(() => {
    // Find the last track that starts before current time
    let idx: number | null = null
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (tracks[i].first_t_seconds < time - 0.5) {
        idx = i
        break
      }
    }
    if (idx !== null) {
      setSelectedTrackIdx(idx)
      seekTo(tracks[idx].first_t_seconds)
    }
  }, [tracks, time, seekTo])

  const nextTrack = useCallback(() => {
    const next = tracks.findIndex((t) => t.first_t_seconds > time + 0.5)
    if (next !== -1) {
      setSelectedTrackIdx(next)
      seekTo(tracks[next].first_t_seconds)
    }
  }, [tracks, time, seekTo])

  const handleScrubberClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const dur = upload?.duration_s ?? 0
    seekTo(pct * dur)
  }, [upload, seekTo])

  // Auto-select track as playhead moves through it
  const onTimeUpdate = useCallback(() => {
    const vid = videoRef.current
    if (!vid) return
    setTime(vid.currentTime)
    const activeIdx = tracks.findIndex(
      (t) => vid.currentTime >= t.first_t_seconds &&
             vid.currentTime <= t.last_t_seconds
    )
    if (activeIdx !== -1 && activeIdx !== selectedTrackIdx) {
      setSelectedTrackIdx(activeIdx)
    }
  }, [tracks, selectedTrackIdx])

  // ─── Derived ────────────────────────────────────────────────────────────────

  const duration = upload?.duration_s ?? 0
  const selectedTrack = selectedTrackIdx !== null ? tracks[selectedTrackIdx] : null

  // ─── Render: loading / error / 404 ─────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <LoadingShell />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <div className="font-display text-4xl font-semibold text-muted-foreground">404</div>
        <div className="font-display text-lg">Upload not found</div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/uploads">
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
            Back to uploads
          </Link>
        </Button>
      </div>
    )
  }

  if (fetchError || !upload) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <div className="text-sm text-destructive">Failed to load: {fetchError}</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
          Retry
        </Button>
      </div>
    )
  }

  // ─── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col" style={{ minHeight: 0 }}>

      {/* ── Breadcrumb bar ──────────────────────────────────────────────── */}
      <div
        className="flex h-14 shrink-0 items-center gap-3 border-b px-5"
        style={{ background: 'var(--surface-1)' }}
      >
        <Link
          href="/uploads"
          className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Uploads
        </Link>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" strokeWidth={1.5} />
        <span className="max-w-xs truncate font-mono text-[13px] font-medium text-foreground">
          {upload.original_filename}
        </span>
        <div className="flex-1" />

        {/* Analysis complete badge */}
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
            <Button
              variant="default"
              size="sm"
              className="gap-1.5"
              disabled
            >
              <Plus className="size-3.5" strokeWidth={2} />
              Create detection rule
            </Button>
          </TooltipTrigger>
          <TooltipContent>Coming in v1.5</TooltipContent>
        </Tooltip>
      </div>

      {/* ── Meta strip ──────────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-7 border-b px-5 py-3"
        style={{ background: 'var(--surface-2)', fontSize: 12, color: 'var(--fg-3)' }}
      >
        <MetaStat label="Duration"
          value={upload.duration_s != null ? fmtTime(upload.duration_s) : '—'} />
        <MetaStat label="Resolution"
          value={upload.width && upload.height ? `${upload.width}×${upload.height}` : '—'} />
        <MetaStat label="Size" value={formatBytes(upload.size_bytes)} />
        <MetaStat label="Source" value="Upload" />
        <MetaStat label="Uploaded by" value="—" />
        <MetaStat label="Analyzed in" value="real-time" />
        <div className="flex-1" />
        <div
          className="flex items-center gap-1.5 text-[12px] font-medium"
          style={{ color: 'var(--accent-400)' }}
        >
          <Sparkles className="size-3" strokeWidth={1.75} />
          {upload.event_count} detections · {upload.track_count} tracks
        </div>
      </div>

      {/* ── Two-column body ─────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-hidden"
        style={{ display: 'grid', gridTemplateColumns: '1fr 380px', minHeight: 0 }}
      >

        {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
        <div
          className="flex flex-col gap-4 overflow-auto p-5"
          style={{ minWidth: 0 }}
        >

          {/* Prompt recap card — only if prompt present */}
          {upload.prompt && (
            <Card
              className="flex items-center gap-3 rounded-[3px] px-3.5 py-3"
              style={{
                background: 'color-mix(in srgb, var(--accent-500) 8%, var(--surface-1))',
                border: '1px solid color-mix(in srgb, var(--accent-500) 25%, transparent)',
              }}
            >
              <div
                className="grid shrink-0 place-items-center rounded-[3px]"
                style={{
                  width: 28, height: 28,
                  background: 'var(--accent-500)',
                  color: '#fff',
                }}
              >
                <Sparkles className="size-3.5" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]"
                  style={{ color: 'var(--fg-4)' }}
                >
                  Your query
                </div>
                <div className="text-[14px]" style={{ color: 'var(--fg-1)' }}>
                  &ldquo;{upload.prompt}&rdquo;
                </div>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0" disabled>
                    Refine query
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Coming in v1.5</TooltipContent>
              </Tooltip>
            </Card>
          )}

          {/* design: not a Card — video player container with unique aspect ratio + dark chrome.
              Card would add a conflicting bg/border that fights the #000 player aesthetic. */}
          <div
            className="overflow-hidden rounded-[3px]"
            style={{ background: '#000', border: '1px solid var(--border)' }}
          >
            {/* Video element */}
            <div className="relative">
              <video
                ref={videoRef}
                src={upload.playback_url}
                preload="metadata"
                crossOrigin="anonymous"
                onTimeUpdate={onTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                className="block w-full"
                style={{ maxHeight: 440, objectFit: 'contain', background: '#000' }}
              />
              {/* Overlay timestamp */}
              <div
                className="absolute left-3 top-3 font-mono text-[10px] tracking-[0.05em] text-white"
                style={{
                  background: 'rgba(0,0,0,0.55)',
                  padding: '4px 8px',
                  borderRadius: 2,
                }}
              >
                RECORDED ·{' '}
                {new Date(upload.uploaded_at).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                }).toUpperCase()}
              </div>
            </div>

            {/* Controls strip */}
            <div
              className="px-3.5 py-3"
              style={{ background: '#0a0d12', color: '#fff' }}
            >
              {/* Controls row */}
              <div className="mb-3 flex items-center gap-3">
                {/* Play/pause — ghost icon on dark bg, bespoke accent background */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={togglePlay}
                  className="size-[34px] shrink-0 text-white hover:opacity-90 hover:bg-transparent"
                  style={{ background: 'var(--accent-500)' }}
                  aria-label={playing ? 'Pause' : 'Play'}
                >
                  {playing
                    ? <Pause className="size-3.5" strokeWidth={2} />
                    : <Play className="size-3.5" strokeWidth={2} />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={prevTrack}
                  className="gap-1 px-2 py-1 text-[12px] hover:bg-white/10"
                  style={{ color: 'rgba(255,255,255,0.7)' }}
                >
                  <ChevronLeft className="size-3.5" strokeWidth={1.75} />
                  Prev event
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={nextTrack}
                  className="gap-1 px-2 py-1 text-[12px] hover:bg-white/10"
                  style={{ color: 'rgba(255,255,255,0.7)' }}
                >
                  Next event
                  <ChevronRight className="size-3.5" strokeWidth={1.75} />
                </Button>
                <div className="flex-1" />
                <div className="font-mono text-[12px]" style={{ color: 'rgba(255,255,255,0.7)' }}>
                  {fmtTime(time)} / {duration > 0 ? fmtTime(duration) : '--:--'}
                </div>
              </div>

              {/* design: not a shadcn primitive — bespoke scrubber DOM with custom track bands per
                  detected object, playhead, and click-to-seek. No primitive maps to this. */}
              <div
                className="relative cursor-pointer"
                style={{ height: 26 }}
                onClick={handleScrubberClick}
              >
                {/* Track background */}
                <div
                  className="absolute left-0 right-0"
                  style={{
                    top: 10, height: 6,
                    background: 'rgba(255,255,255,0.12)',
                    borderRadius: 2,
                  }}
                >
                  {/* Progress fill */}
                  <div
                    style={{
                      width: duration > 0 ? `${(time / duration) * 100}%` : '0%',
                      height: '100%',
                      background: 'var(--accent-500)',
                      borderRadius: 2,
                    }}
                  />
                </div>

                {/* Event bands (one per track) */}
                {duration > 0 && tracks.map((track, i) => {
                  const left = (track.first_t_seconds / duration) * 100
                  const width = Math.max((track.duration_s / duration) * 100, 0.5)
                  const isSelected = selectedTrackIdx === i
                  const color = classColor(track.class)
                  return (
                    <div
                      key={track.track_id}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedTrackIdx(i)
                        seekTo(track.first_t_seconds)
                      }}
                      style={{
                        position: 'absolute',
                        left: `${left}%`,
                        width: `${width}%`,
                        top: 4,
                        height: 18,
                        background: color,
                        opacity: isSelected ? 1 : 0.65,
                        cursor: 'pointer',
                        borderRadius: 1,
                        boxShadow: isSelected
                          ? `0 0 0 2px ${color}, 0 0 0 4px rgba(255,255,255,0.2)`
                          : 'none',
                      }}
                    />
                  )
                })}

                {/* Playhead */}
                <div
                  style={{
                    position: 'absolute',
                    left: duration > 0 ? `calc(${(time / duration) * 100}% - 1px)` : 0,
                    top: 0,
                    width: 2,
                    height: 26,
                    background: '#fff',
                    boxShadow: '0 0 6px rgba(255,255,255,0.6)',
                    pointerEvents: 'none',
                  }}
                />
              </div>

              {/* Timeline legend */}
              {duration > 0 && (
                <div
                  className="mt-2 flex justify-between font-mono text-[10px]"
                  style={{ color: 'rgba(255,255,255,0.5)' }}
                >
                  <span>0:00</span>
                  <span>{fmtTime(duration * 0.25)}</span>
                  <span>{fmtTime(duration * 0.5)}</span>
                  <span>{fmtTime(duration * 0.75)}</span>
                  <span>{fmtTime(duration)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Selected track summary card */}
          {selectedTrack && (
            <Card
              className="rounded-[3px] p-4"
              style={{
                border: '1px solid color-mix(in srgb, var(--accent-500) 30%, transparent)',
                background: 'color-mix(in srgb, var(--accent-500) 6%, var(--surface-1))',
              }}
            >
              {/* Header */}
              <div className="mb-3 flex items-center gap-2">
                <div
                  className="grid shrink-0 place-items-center rounded-[3px]"
                  style={{
                    width: 22, height: 22,
                    background: 'var(--accent-500)',
                    color: '#fff',
                  }}
                >
                  <Sparkles className="size-3" strokeWidth={1.75} />
                </div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--fg-1)' }}>
                  Track {(selectedTrackIdx ?? 0) + 1} of {tracks.length}
                  {' · '}
                  <span className="capitalize">{selectedTrack.class}</span>
                </div>
                {/* Selected-track class label badge */}
                <Badge
                  variant="outline"
                  className="capitalize text-[10px]"
                  style={classPillStyle(selectedTrack.class)}
                >
                  {selectedTrack.class}
                </Badge>
                <div className="flex-1" />
                {/* Track count / confidence — secondary mono badge */}
                <Badge variant="secondary" className="font-mono text-[10px]">
                  @ {fmtTime(selectedTrack.first_t_seconds)} · conf {selectedTrack.max_confidence.toFixed(2)}
                </Badge>
              </div>

              {/* Details */}
              <div className="mb-3 space-y-1 text-[13px]" style={{ color: 'var(--fg-1)', lineHeight: 1.55 }}>
                <div>
                  Tracked <span className="capitalize">{selectedTrack.class}</span> for{' '}
                  {selectedTrack.duration_s.toFixed(1)}s ({selectedTrack.detection_count} detections)
                </div>
                <div className="font-mono text-[11px]" style={{ color: 'var(--fg-3)' }}>
                  First bbox: ({selectedTrack.first_bbox.x1.toFixed(0)},{' '}
                  {selectedTrack.first_bbox.y1.toFixed(0)},{' '}
                  {selectedTrack.first_bbox.x2.toFixed(0)},{' '}
                  {selectedTrack.first_bbox.y2.toFixed(0)})
                </div>
                <div className="font-mono text-[11px]" style={{ color: 'var(--fg-3)' }}>
                  Max confidence: {selectedTrack.max_confidence.toFixed(2)}
                </div>
              </div>

              {/* Action chips */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    seekTo(selectedTrack.first_t_seconds)
                    if (videoRef.current) void videoRef.current.play()
                  }}
                  className="gap-1.5 h-7"
                >
                  <Play className="size-3" strokeWidth={1.75} />
                  Replay segment
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5 h-7" disabled>
                      <Download className="size-3" strokeWidth={1.75} />
                      Export clip
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Coming in v1.5</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5 h-7" disabled>
                      <Plus className="size-3" strokeWidth={1.75} />
                      Save to incident
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Coming in v1.5</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1.5 h-7" disabled>
                      <X className="size-3" strokeWidth={1.75} />
                      Dismiss false positive
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Coming in v1.5</TooltipContent>
                </Tooltip>
              </div>
            </Card>
          )}

          {/* No track selected hint */}
          {!selectedTrack && tracks.length > 0 && (
            <div
              className="rounded-[3px] px-4 py-3 text-[13px]"
              style={{
                background: 'var(--surface-2)',
                color: 'var(--fg-4)',
                border: '1px solid var(--border)',
              }}
            >
              Click a track in the right panel or on the scrubber to see details.
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN — tabbed event panel ───────────────────────── */}
        <div
          className="flex flex-col overflow-hidden"
          style={{
            borderLeft: '1px solid var(--border)',
            background: 'var(--surface-1)',
            minHeight: 0,
          }}
        >
          {/* Panel header */}
          <div className="shrink-0 border-b px-4 pb-0 pt-3.5">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--fg-1)' }}>
              Detected events
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--fg-4)' }}>
              Click an event to jump to that moment
            </div>
          </div>

          {/* Tabs — must be outside the header div to use full column height */}
          <Tabs defaultValue="events" className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 pt-3">
              <TabsList variant="line" className="gap-3">
                <TabsTrigger value="events" className="text-[12px]">
                  Events
                </TabsTrigger>
                <TabsTrigger value="scenarios" className="text-[12px] opacity-50" disabled>
                  Scenarios
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Events tab */}
            <TabsContent value="events" className="flex min-h-0 flex-1 flex-col">
              <EventsPanel
                tracks={tracks}
                selectedTrackIdx={selectedTrackIdx}
                onSelect={(i) => {
                  setSelectedTrackIdx(i)
                  seekTo(tracks[i].first_t_seconds)
                }}
              />
            </TabsContent>

            {/* Scenarios tab — empty state */}
            <TabsContent value="scenarios" className="flex min-h-0 flex-1 flex-col">
              <ScenariosEmptyState />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.1em]"
        style={{ color: 'var(--fg-4)' }}
      >
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-medium" style={{ color: 'var(--fg-1)' }}>
        {value}
      </div>
    </div>
  )
}

function EventsPanel({
  tracks,
  selectedTrackIdx,
  onSelect,
}: {
  tracks: TrackSummary[]
  selectedTrackIdx: number | null
  onSelect: (i: number) => void
}) {
  if (tracks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
        <Video className="mb-3 size-8 text-muted-foreground/40" strokeWidth={1.25} />
        <div className="text-[13px] text-muted-foreground">No tracks detected</div>
        <div className="mt-1 text-[11px]" style={{ color: 'var(--fg-4)' }}>
          The pipeline found no objects to track in this clip.
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* design: not a Card — table-style rows with alternating bg, full-width border-b, and
          click-to-select behavior. Card would add padding/radius that breaks the row grid. */}
      <div className="flex-1 overflow-auto">
        {tracks.map((track, i) => {
          const isSelected = selectedTrackIdx === i
          const color = classColor(track.class)
          return (
            <div
              key={track.track_id}
              onClick={() => onSelect(i)}
              className="cursor-pointer border-b transition-colors"
              style={{
                padding: '14px 16px',
                paddingLeft: isSelected ? 13 : 16,
                background: isSelected
                  ? 'color-mix(in srgb, var(--accent-500) 10%, transparent)'
                  : 'transparent',
                borderLeft: isSelected
                  ? '3px solid var(--accent-500)'
                  : '3px solid transparent',
              }}
            >
              {/* Top row: time + confidence */}
              <div className="mb-2 flex items-center gap-2">
                <div
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: color }}
                />
                <div className="font-mono text-[10px]" style={{ color: 'var(--fg-4)' }}>
                  @ {fmtTime(track.first_t_seconds)}
                </div>
                <div className="flex-1" />
                <div className="font-mono text-[10px]" style={{ color: 'var(--fg-4)' }}>
                  {track.max_confidence.toFixed(2)}
                </div>
              </div>

              {/* Content: thumbnail + details */}
              <div className="flex items-start gap-2.5">
                {/* Thumbnail placeholder */}
                <div
                  className="grid shrink-0 place-items-center rounded-[2px] border"
                  style={{
                    width: 96, height: 54,
                    background: '#000',
                    color: 'var(--fg-4)',
                  }}
                >
                  <Video className="size-4" strokeWidth={1.25} />
                </div>

                {/* Details */}
                <div className="min-w-0 flex-1">
                  <div
                    className="mb-1 text-[13px] font-semibold capitalize"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    {track.class}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--fg-3)', lineHeight: 1.4 }}>
                    {track.detection_count} detections over {track.duration_s.toFixed(1)}s
                  </div>
                  <div
                    className="mt-1 font-mono text-[10px]"
                    style={{ color: 'var(--fg-4)' }}
                  >
                    bbox ({track.first_bbox.x1.toFixed(0)},{track.first_bbox.y1.toFixed(0)},{' '}
                    {track.first_bbox.x2.toFixed(0)},{track.first_bbox.y2.toFixed(0)})
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div
        className="flex shrink-0 items-center gap-2 border-t px-4 py-3 text-[11px]"
        style={{ background: 'var(--surface-2)', color: 'var(--fg-4)' }}
      >
        <Shield className="size-3 shrink-0" strokeWidth={1.75} />
        Analysis pipeline · POT DeepStream · per-frame raw detections
      </div>
    </div>
  )
}

function ScenariosEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div
        className="mb-4 grid place-items-center rounded-[3px]"
        style={{
          width: 48, height: 48,
          background: 'color-mix(in srgb, var(--accent-500) 10%, transparent)',
          color: 'var(--accent-400)',
        }}
      >
        <Sparkles className="size-5" strokeWidth={1.5} />
      </div>
      <div className="mb-2 text-[15px] font-semibold" style={{ color: 'var(--fg-2)' }}>
        Scenarios coming in v1.5
      </div>
      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-4)' }}>
        Semantic interpretation of detection patterns over time — wrong-way drivers, stalled
        vehicles, incidents — generated by VLM or rule analysis.
      </div>
    </div>
  )
}

function LoadingShell() {
  return (
    <div className="flex flex-col gap-0">
      {/* breadcrumb skeleton */}
      <div
        className="flex h-14 items-center gap-3 border-b px-5"
        style={{ background: 'var(--surface-1)' }}
      >
        <Skeleton className="h-3 w-16 rounded-[3px]" />
        <Skeleton className="h-3 w-3 rounded" />
        <Skeleton className="h-3 w-48 rounded-[3px]" />
      </div>
      {/* meta strip skeleton */}
      <div
        className="flex h-12 items-center gap-6 border-b px-5"
        style={{ background: 'var(--surface-2)' }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-2 w-12 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>
        ))}
      </div>
      {/* body skeleton */}
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    </div>
  )
}
