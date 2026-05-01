'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  HelpCircle,
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
  type Incident,
  type RuleId,
  type Severity,
  type VlmStatus,
  type VlmVerdict,
  formatBytes,
} from '@/lib/uploads'
import { resumeTourIfNeeded } from '@/lib/tour'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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

// ─── Incident helpers ─────────────────────────────────────────────────────────

const RULE_LABELS: Record<RuleId, string> = {
  vehicle_collision: 'Vehicle collision',
  ped_impact: 'Pedestrian impact',
  stationary_vehicle: 'Stationary vehicle',
  mass_stop: 'Traffic anomaly',
}

// Severity → CSS var token. No hex; tokens are defined in globals.css.
const SEVERITY_COLOR: Record<Severity, string> = {
  high:   'var(--danger-500)',
  medium: 'var(--warn-500)',
  low:    'var(--ink-400)',
}

function severityBadgeClass(severity: Severity): string {
  if (severity === 'high') {
    return 'border-[color:var(--danger-500)]/40 bg-[color:var(--danger-500)]/10 text-[color:var(--danger-500)]'
  }
  if (severity === 'medium') {
    return 'border-[color:var(--warn-500)]/40 bg-[color:var(--warn-500)]/10 text-[color:var(--warn-500)]'
  }
  return 'border-border text-muted-foreground'
}

function fmtTimestamp(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function UploadDetailPage() {
  const params = useParams<{ video_id: string }>()
  const router = useRouter()
  const videoId = params.video_id

  const [upload, setUpload] = useState<UploadRecord | null>(null)
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [incidentsLoading, setIncidentsLoading] = useState(true)
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
    setIncidentsLoading(true)
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

    // Incidents fetched independently so the tab can show its own loading state
    try {
      const incRes = await fetch(`/api/uploads/${videoId}/incidents`, { cache: 'no-store' })
      if (incRes.ok) {
        const incData = await incRes.json()
        setIncidents(incData.incidents ?? [])
      }
    } catch {
      // Silently degrade — incidents not available yet is not a fatal error
    } finally {
      setIncidentsLoading(false)
    }
  }, [videoId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    resumeTourIfNeeded('detail', router.push)
  }, [router])

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

          {/* Prompt recap — single-line, low-profile */}
          {upload.prompt && (
            <div
              className="flex items-center gap-2 rounded-[3px] px-2.5 py-1.5 text-[12px]"
              style={{
                background: 'color-mix(in srgb, var(--accent-500) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-500) 20%, transparent)',
              }}
            >
              <Sparkles
                className="size-3 shrink-0"
                strokeWidth={1.75}
                style={{ color: 'var(--accent-400)' }}
              />
              <span
                className="text-[10px] font-semibold uppercase tracking-[0.1em]"
                style={{ color: 'var(--fg-4)' }}
              >
                Query
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ color: 'var(--fg-2)' }}
                title={upload.prompt}
              >
                {upload.prompt}
              </span>
            </div>
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
                data-tour="scrubber"
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

                {/* Incident bands — rendered above track bands, below playhead */}
                {duration > 0 && incidents.map((inc) => {
                  const left = (inc.t_start_s / duration) * 100
                  const width = Math.max(((inc.t_end_s - inc.t_start_s) / duration) * 100, 0.5)
                  const color = SEVERITY_COLOR[inc.severity]
                  return (
                    <Tooltip key={inc.id}>
                      <TooltipTrigger asChild>
                        <div
                          onClick={(e) => {
                            e.stopPropagation()
                            seekTo(inc.t_start_s)
                          }}
                          style={{
                            position: 'absolute',
                            left: `${left}%`,
                            width: `${width}%`,
                            top: 0,
                            height: 4,
                            background: color,
                            opacity: 0.9,
                            cursor: 'pointer',
                            borderRadius: 1,
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[11px]">
                        {RULE_LABELS[inc.rule_id]} · {fmtTimestamp(inc.t_start_s)}–{fmtTimestamp(inc.t_end_s)}
                      </TooltipContent>
                    </Tooltip>
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
                <TabsTrigger data-tour="tab-events" value="events" className="text-[12px]">
                  Events
                </TabsTrigger>
                <TabsTrigger data-tour="tab-scenarios" value="scenarios" className="text-[12px]">
                  Scenarios
                  {incidents.length > 0 && (
                    <Badge variant="secondary" className="ml-1 font-mono text-[10px]">
                      {incidents.length}
                    </Badge>
                  )}
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

            {/* Scenarios tab — live incident data */}
            <TabsContent value="scenarios" className="flex min-h-0 flex-1 flex-col">
              <ScenariosPanel
                incidents={incidents}
                loading={incidentsLoading}
                onSelectIncident={(inc) => {
                  // Seek to incident start and select first involved track
                  seekTo(inc.t_start_s)
                  const firstId = inc.track_ids[0]
                  if (firstId != null) {
                    const idx = tracks.findIndex((t) => t.track_id === firstId)
                    if (idx !== -1) setSelectedTrackIdx(idx)
                  }
                }}
                onSelectTrackAtTime={(trackId, time) => {
                  const idx = tracks.findIndex((t) => t.track_id === trackId)
                  if (idx !== -1) {
                    setSelectedTrackIdx(idx)
                    seekTo(time)
                  }
                }}
              />
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

type VlmFilter = 'all' | 'confirmed' | 'rejected' | 'pending'

function ScenariosPanel({
  incidents,
  loading,
  onSelectIncident,
  onSelectTrackAtTime,
}: {
  incidents: Incident[]
  loading: boolean
  onSelectIncident: (inc: Incident) => void
  onSelectTrackAtTime: (trackId: number, time: number) => void
}) {
  const [filter, setFilter] = useState<VlmFilter>('all')

  const filtered = useMemo(() => {
    if (filter === 'confirmed') return incidents.filter(i => i.vlm_status === 'done' && i.vlm_verdict === 'confirmed')
    if (filter === 'rejected')  return incidents.filter(i => i.vlm_status === 'done' && i.vlm_verdict === 'rejected')
    if (filter === 'pending')   return incidents.filter(i => i.vlm_status === 'pending')
    return incidents
  }, [incidents, filter])

  if (loading) {
    return (
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-[3px]" />
        ))}
      </div>
    )
  }

  if (incidents.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <AlertTriangle
          className="mb-3 size-8"
          strokeWidth={1.25}
          style={{ color: 'var(--fg-4)' }}
        />
        <div className="text-[13px] text-muted-foreground">
          No incidents detected on this clip.
        </div>
        <div className="mt-1 text-[11px]" style={{ color: 'var(--fg-4)' }}>
          Run the rule analysis to detect vehicle collisions, pedestrian impacts, and anomalies.
        </div>
      </div>
    )
  }

  const filterOpts: { id: VlmFilter; label: string }[] = [
    { id: 'all', label: `All (${incidents.length})` },
    { id: 'confirmed', label: `Confirmed (${incidents.filter(i => i.vlm_status === 'done' && i.vlm_verdict === 'confirmed').length})` },
    { id: 'rejected', label: `Rejected (${incidents.filter(i => i.vlm_status === 'done' && i.vlm_verdict === 'rejected').length})` },
    { id: 'pending', label: `Pending (${incidents.filter(i => i.vlm_status === 'pending').length})` },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* VLM filter chips */}
      <div className="shrink-0 flex flex-wrap gap-1.5 px-3 pt-2.5 pb-2 border-b">
        {filterOpts.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className="rounded-[3px] px-2 py-0.5 text-[11px] font-medium transition-colors"
            style={{
              background: filter === id
                ? 'color-mix(in srgb, var(--accent-500) 20%, transparent)'
                : 'var(--surface-2)',
              color: filter === id ? 'var(--accent-400)' : 'var(--fg-3)',
              border: filter === id
                ? '1px solid color-mix(in srgb, var(--accent-500) 40%, transparent)'
                : '1px solid var(--border)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="text-[12px]" style={{ color: 'var(--fg-4)' }}>No incidents match this filter.</div>
          </div>
        ) : filtered.map((inc) => (
          <IncidentCard
            key={inc.id}
            incident={inc}
            onSelect={() => onSelectIncident(inc)}
            onSelectTrack={(trackId) => onSelectTrackAtTime(trackId, inc.t_start_s)}
          />
        ))}
      </div>
      <div
        className="flex shrink-0 items-center gap-2 border-t px-4 py-3 text-[11px]"
        style={{ background: 'var(--surface-2)', color: 'var(--fg-4)' }}
      >
        <Shield className="size-3 shrink-0" strokeWidth={1.75} />
        Rule-based detection · Cosmos-Reason2-2B validation
      </div>
    </div>
  )
}

// ─── VLM helpers ─────────────────────────────────────────────────────────────

function VlmPill({ status, verdict }: { status: VlmStatus; verdict: VlmVerdict }) {
  if (status === 'skipped') return null

  if (status === 'pending') return (
    <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
      <Clock className="size-2.5" strokeWidth={1.75} />
      VLM pending
    </Badge>
  )

  if (status === 'error') return (
    <Badge variant="outline" className="gap-1 text-[10px] border-destructive/40 bg-destructive/10 text-destructive">
      VLM error
    </Badge>
  )

  if (verdict === 'confirmed') return (
    <Badge variant="outline" className="gap-1 text-[10px] border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]">
      <Check className="size-2.5" strokeWidth={2.5} />
      VLM confirmed
    </Badge>
  )

  if (verdict === 'rejected') return (
    <Badge variant="outline" className="gap-1 text-[10px] border-[color:var(--danger-500)]/40 bg-[color:var(--danger-500)]/10 text-[color:var(--danger-500)]">
      <X className="size-2.5" strokeWidth={2.5} />
      VLM rejected
    </Badge>
  )

  return (
    <Badge variant="outline" className="gap-1 text-[10px] border-[color:var(--warn-500)]/40 bg-[color:var(--warn-500)]/10 text-[color:var(--warn-500)]">
      <HelpCircle className="size-2.5" strokeWidth={1.75} />
      VLM uncertain
    </Badge>
  )
}

function IncidentCard({
  incident,
  onSelect,
  onSelectTrack,
}: {
  incident: Incident
  onSelect: () => void
  onSelectTrack: (trackId: number) => void
}) {
  const [whyOpen, setWhyOpen] = useState(false)
  const hasWhy = incident.vlm_status === 'done' && !!incident.vlm_reasoning

  return (
    <Card className="rounded-[3px]">
      <CardHeader className="pb-0">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--fg-1)' }}>
                {RULE_LABELS[incident.rule_id]}
              </span>
              <Badge variant="outline" className={severityBadgeClass(incident.severity)}>
                {incident.severity}
              </Badge>
              <VlmPill status={incident.vlm_status} verdict={incident.vlm_verdict} />
            </div>
            <div className="font-mono text-[11px]" style={{ color: 'var(--fg-4)' }}>
              {fmtTimestamp(incident.t_start_s)} – {fmtTimestamp(incident.t_end_s)}
              {'  ·  '}
              {(incident.confidence * 100).toFixed(1)}% rule conf
              {incident.vlm_confidence != null && (
                <span style={{ color: 'var(--fg-3)' }}>
                  {'  ·  '}{(incident.vlm_confidence * 100).toFixed(1)}% VLM conf
                </span>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5"
            onClick={onSelect}
          >
            <Play className="size-3" strokeWidth={1.75} />
            Jump to
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-2 space-y-2">
        {incident.track_ids.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px]" style={{ color: 'var(--fg-4)' }}>Tracks:</span>
            {incident.track_ids.map((id) => (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="cursor-pointer font-mono text-[10px] hover:bg-secondary/50"
                    onClick={() => onSelectTrack(id)}
                  >
                    #{id}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Switch to Events tab to inspect track {id}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}

        {/* VLM "Why" expandable */}
        {hasWhy && (
          <div>
            <button
              onClick={() => setWhyOpen(!whyOpen)}
              className="flex items-center gap-1 text-[11px] transition-colors"
              style={{ color: 'var(--fg-3)' }}
            >
              <Brain className="size-3" strokeWidth={1.75} />
              Why?
              <ChevronDown
                className="size-3 transition-transform"
                style={{ transform: whyOpen ? 'rotate(180deg)' : 'none' }}
                strokeWidth={1.75}
              />
            </button>
            {whyOpen && (
              <div
                className="mt-1.5 rounded-[3px] px-2.5 py-2 text-[11px] leading-relaxed"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg-2)',
                }}
              >
                {incident.vlm_reasoning}
                {incident.vlm_latency_ms != null && (
                  <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--fg-4)' }}>
                    {incident.vlm_model} · {incident.vlm_latency_ms}ms
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
