'use client'

import { use, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Bell, ChevronLeft, ChevronRight, ChevronRight as ChevronRightSm,
  Clock, Download, MapPin, Pause, Play, Shield, Sparkles,
  User, Video, X, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { type Scene, CameraScene } from '@/components/camera-scenes'

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'high' | 'medium' | 'low'

interface RelatedCamera {
  id: string
  label: string
  distance: string
}

interface EventDetail {
  id: string
  scene: Scene
  title: string
  cameraId: string
  cameraLabel: string
  rule: string
  ruleId: string
  severity: Severity
  confidence: number
  vlmSummary: string
  vlmTags: string[]
  vlmModel: string
  vlmLatencyMs: number
  duration: number
  relatedCameras: RelatedCamera[]
  created_at: string
}

// ─── Mock data ────────────────────────────────────────────────────────────────

function minsAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString()
}

const MOCK_EVENT_DETAILS: Record<string, EventDetail> = {
  'a1b2c3d4-0001': {
    id: 'a1b2c3d4-0001',
    scene: 'wrongway',
    title: 'Wrong-way driver on Loop 101 SB at Bell Rd',
    cameraId: 'CAM-117',
    cameraLabel: 'Loop 101 @ Bell Rd · SB',
    rule: 'Wrong-Way Vehicle',
    ruleId: 'vehicle_collision',
    severity: 'high',
    confidence: 0.97,
    vlmSummary: 'A red sedan is traveling northbound in the southbound lanes of Loop 101 near Bell Road. The vehicle appears to be moving at approximately 35 mph and has not yet responded to road markings. No collision has occurred but oncoming traffic is slowing and moving to the right shoulder.',
    vlmTags: ['vehicle:sedan', 'direction:northbound-in-SB-lanes', 'speed:~35mph', 'color:red', 'risk:imminent-collision'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 312,
    duration: 12,
    relatedCameras: [
      { id: 'CAM-118', label: 'Loop 101 @ Bell Rd · NB', distance: '0.1 mi' },
      { id: 'CAM-115', label: 'Loop 101 @ Greenway · SB', distance: '0.6 mi' },
      { id: 'CAM-119', label: 'Loop 101 @ Union Hills · SB', distance: '1.4 mi' },
    ],
    created_at: minsAgo(3),
  },
  'a1b2c3d4-0002': {
    id: 'a1b2c3d4-0002',
    scene: 'intersection',
    title: 'Pedestrian impact at Grand Ave & 75th Ave',
    cameraId: 'CAM-012',
    cameraLabel: 'Grand Ave @ 75th',
    rule: 'Pedestrian Impact',
    ruleId: 'ped_impact',
    severity: 'high',
    confidence: 0.91,
    vlmSummary: 'A pedestrian appears to have been struck at the intersection of Grand Ave and 75th Ave. A dark SUV failed to yield at the crosswalk during a green light cycle. The pedestrian was crossing with the walk signal and is now stationary on the pavement.',
    vlmTags: ['vehicle:suv', 'pedestrian:adult', 'crosswalk:active', 'signal:green', 'status:stationary-pedestrian'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 287,
    duration: 10,
    relatedCameras: [
      { id: 'CAM-013', label: 'Grand Ave @ 83rd Ave', distance: '0.5 mi' },
      { id: 'CAM-011', label: 'Grand Ave @ 67th Ave', distance: '0.5 mi' },
    ],
    created_at: minsAgo(8),
  },
  'a1b2c3d4-0003': {
    id: 'a1b2c3d4-0003',
    scene: 'stalled',
    title: 'Stalled vehicle blocking lane on 83rd Ave at Thunderbird',
    cameraId: 'CAM-208',
    cameraLabel: '83rd Ave @ Thunderbird',
    rule: 'Stationary Vehicle',
    ruleId: 'stationary_vehicle',
    severity: 'medium',
    confidence: 0.88,
    vlmSummary: 'A red vehicle has been stationary in the right travel lane of 83rd Ave for over 56 seconds. Hazard lights are active and a warning triangle appears to have been placed behind the vehicle. Traffic is queuing in the right lane and merging left.',
    vlmTags: ['vehicle:sedan', 'status:stalled', 'hazards:active', 'lane:right', 'queue-forming:true'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 341,
    duration: 56,
    relatedCameras: [
      { id: 'CAM-209', label: '83rd Ave @ Beardsley', distance: '0.3 mi' },
      { id: 'CAM-207', label: '83rd Ave @ Peoria Ave', distance: '0.8 mi' },
    ],
    created_at: minsAgo(15),
  },
  'a1b2c3d4-0004': {
    id: 'a1b2c3d4-0004',
    scene: 'flood',
    title: 'Roadway flooding detected on New River Rd',
    cameraId: 'CAM-091',
    cameraLabel: 'New River Rd',
    rule: 'Mass Stop',
    ruleId: 'mass_stop',
    severity: 'medium',
    confidence: 0.82,
    vlmSummary: 'Standing water covers both travel lanes of New River Rd with depth estimated at 4–8 inches. A sedan has stopped mid-road and appears unable to proceed. A warning diamond is visible upstream. VLM re-classified the original mass-stop trigger as flood inundation.',
    vlmTags: ['hazard:flooding', 'water-depth:~6in', 'vehicle:sedan', 'status:stopped-in-water', 'road-closed:recommended'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 398,
    duration: 13,
    relatedCameras: [
      { id: 'CAM-092', label: 'New River Rd @ 67th Ave', distance: '0.4 mi' },
      { id: 'CAM-090', label: 'New River Rd @ 75th Ave', distance: '0.9 mi' },
    ],
    created_at: minsAgo(22),
  },
  'a1b2c3d4-0005': {
    id: 'a1b2c3d4-0005',
    scene: 'highway',
    title: 'Stationary vehicle in travel lane on Loop 101 at Union Hills',
    cameraId: 'CAM-043',
    cameraLabel: 'Loop 101 @ Union Hills',
    rule: 'Stationary Vehicle',
    ruleId: 'stationary_vehicle',
    severity: 'low',
    confidence: 0.74,
    vlmSummary: 'A light-colored vehicle has been stopped on the right shoulder of Loop 101 near Union Hills for approximately 14 seconds. The vehicle is fully off the travel lane and does not appear to be a primary obstruction, though it may be a breakdown. No other vehicles are affected.',
    vlmTags: ['vehicle:unknown', 'status:stopped', 'location:right-shoulder', 'risk:low', 'duration:14s'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 274,
    duration: 14,
    relatedCameras: [
      { id: 'CAM-044', label: 'Loop 101 @ Peoria Ave', distance: '0.5 mi' },
      { id: 'CAM-042', label: 'Loop 101 @ Happy Valley', distance: '0.7 mi' },
      { id: 'CAM-043B', label: 'Loop 101 @ Union Hills · SB', distance: '0.1 mi' },
    ],
    created_at: minsAgo(34),
  },
  'a1b2c3d4-0006': {
    id: 'a1b2c3d4-0006',
    scene: 'roundabout',
    title: 'Vehicle collision at 99th Ave roundabout near Happy Valley',
    cameraId: 'CAM-156',
    cameraLabel: '99th Ave @ Happy Valley',
    rule: 'Vehicle Collision',
    ruleId: 'vehicle_collision',
    severity: 'high',
    confidence: 0.95,
    vlmSummary: 'Two vehicles appear to have made contact while navigating the 99th Ave roundabout. A gray hatchback exited the roundabout unexpectedly, making contact with an approaching silver sedan. Both vehicles are now stopped at the roundabout exit and are partially blocking traffic.',
    vlmTags: ['vehicle:hatchback', 'vehicle:sedan', 'contact:detected', 'location:roundabout-exit', 'blocking:partial'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 305,
    duration: 9,
    relatedCameras: [
      { id: 'CAM-157', label: '99th Ave @ Jomax Rd', distance: '0.6 mi' },
      { id: 'CAM-155', label: '99th Ave @ Pinnacle Peak', distance: '0.8 mi' },
    ],
    created_at: minsAgo(41),
  },
  'a1b2c3d4-0007': {
    id: 'a1b2c3d4-0007',
    scene: 'intersection',
    title: 'Pedestrian near-miss on Loop 101 Bell Rd NB off-ramp',
    cameraId: 'CAM-107',
    cameraLabel: 'Loop 101 @ Bell Rd · NB',
    rule: 'Pedestrian Impact',
    ruleId: 'ped_impact',
    severity: 'medium',
    confidence: 0.79,
    vlmSummary: 'A pedestrian entered the Loop 101 northbound off-ramp crosswalk against a red signal and narrowly avoided a turning vehicle. No contact was made. The pedestrian continued across after the vehicle stopped. The incident lasted approximately 8 seconds.',
    vlmTags: ['pedestrian:adult', 'crosswalk:active', 'signal:red-for-ped', 'near-miss:true', 'duration:8s'],
    vlmModel: 'aims-vision-4.2',
    vlmLatencyMs: 319,
    duration: 8,
    relatedCameras: [
      { id: 'CAM-117', label: 'Loop 101 @ Bell Rd · SB', distance: '0.1 mi' },
      { id: 'CAM-108', label: 'Loop 101 @ Bell Rd · NB ramp', distance: '0.2 mi' },
    ],
    created_at: minsAgo(58),
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<Severity, string> = {
  high:   'var(--danger-500)',
  medium: 'var(--warn-500)',
  low:    'var(--fg-4)',
}

function shortId(id: string): string {
  return `E-${id.slice(-6).toUpperCase()}`
}

function fmtFull(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtHMS(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ─── Animated player ──────────────────────────────────────────────────────────

function AnimatedPlayer({ detail }: { detail: EventDetail }) {
  const [t, setT] = useState(0)
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(true)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const duration = detail.duration
  const sevColor = SEVERITY_COLOR[detail.severity]

  // Scene animation ticker (10 fps)
  useEffect(() => {
    const id = setInterval(() => setT((prev) => prev + 0.1), 100)
    return () => clearInterval(id)
  }, [])

  // Playhead ticker
  useEffect(() => {
    if (playing) {
      tickRef.current = setInterval(() => {
        setPos((p) => {
          if (p >= duration) { setPlaying(false); return duration }
          return p + 0.1
        })
      }, 100)
    } else if (tickRef.current) {
      clearInterval(tickRef.current)
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [playing, duration])

  const now = new Date()
  const tickTime = new Date(now.getTime() + t * 1000)
  const timeStr = tickTime.toTimeString().slice(0, 8)

  return (
    <div style={{ background: '#000', border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div style={{ position: 'relative', aspectRatio: '16/9' }}>
        {/* Scene */}
        <CameraScene scene={detail.scene} t={t} />

        {/* Vignette */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.65) 100%)' }} />

        {/* Top-left severity badge */}
        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '3px 8px',
            background: `color-mix(in srgb, ${sevColor} 25%, rgba(0,0,0,0.6))`,
            border: `1px solid ${sevColor}`,
            color: '#fff', borderRadius: 2,
            fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          }}>
            DETECTED · {detail.cameraId}
          </span>
        </div>

        {/* Top-right timestamp */}
        <div style={{ position: 'absolute', top: 10, right: 10,
          fontFamily: 'var(--font-mono)', fontSize: 10, color: '#fff',
          background: 'rgba(0,0,0,0.55)', padding: '3px 7px',
          borderRadius: 2, letterSpacing: '0.05em' }}>
          {timeStr}
        </div>

        {/* Bounding box annotation */}
        <div style={{
          position: 'absolute', left: '55%', top: '60%', width: '16%', height: '22%',
          border: `2px solid ${sevColor}`,
          boxShadow: `0 0 10px ${sevColor}55`,
          pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', top: -20, left: -2,
            background: sevColor, color: '#fff',
            fontSize: 9, fontFamily: 'var(--font-mono)', padding: '2px 6px',
            letterSpacing: '0.04em', whiteSpace: 'nowrap',
          }}>
            {Math.round(detail.confidence * 100)}% conf
          </div>
        </div>

        {/* Player controls */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px 12px',
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
        }}>
          <button
            onClick={() => setPlaying((p) => !p)}
            style={{
              width: 30, height: 30, borderRadius: 3, border: 'none',
              background: 'rgba(255,255,255,0.15)', color: '#fff',
              display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0,
            }}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>

          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#fff', flexShrink: 0 }}>
            {fmtSeconds(pos)} / {fmtSeconds(duration)}
          </div>

          {/* Scrubber */}
          <div
            style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.2)', borderRadius: 2,
              position: 'relative', cursor: 'pointer' }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setPos(((e.clientX - rect.left) / rect.width) * duration)
            }}
          >
            {/* Accent fill */}
            <div style={{
              width: `${(pos / duration) * 100}%`, height: '100%',
              background: 'var(--accent-500)', borderRadius: 2,
            }} />
            {/* Detection marker at 20% */}
            <div style={{
              position: 'absolute', left: '20%', top: -3, width: 2, height: 9,
              background: 'var(--danger-500)', borderRadius: 1,
            }} />
          </div>

          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
            {fmtSeconds(duration)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── AI summary panel ─────────────────────────────────────────────────────────

function AiSummaryPanel({ detail }: { detail: EventDetail }) {
  return (
    <div style={{
      border: '1px solid color-mix(in srgb, var(--accent-500) 30%, transparent)',
      background: 'color-mix(in srgb, var(--accent-500) 6%, var(--surface-1))',
      padding: 18, borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 24, height: 24, borderRadius: 'var(--radius-sm)',
          background: 'var(--accent-500)', color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Sparkles size={13} />
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-1)' }}>AI event summary</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-4)' }}>
          {detail.vlmModel} · {detail.vlmLatencyMs}ms
        </div>
      </div>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--fg-1)', margin: '0 0 14px' }}>
        {detail.vlmSummary}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {detail.vlmTags.map((tag) => (
          <span key={tag} style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            padding: '3px 8px', borderRadius: 3,
            background: 'color-mix(in srgb, var(--accent-500) 12%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--accent-500) 25%, transparent)',
            color: 'var(--fg-2)', letterSpacing: '0.02em',
          }}>{tag}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Event timeline ───────────────────────────────────────────────────────────

function EventTimeline({ detail }: { detail: EventDetail }) {
  const entries = [
    {
      offsetMs: 0,
      Icon: Sparkles,
      tone: 'accent' as const,
      who: 'AIMS',
      what: `${detail.rule} detected (${Math.round(detail.confidence * 100)}%)`,
    },
    {
      offsetMs: 2000,
      Icon: Zap,
      tone: 'accent' as const,
      who: 'AIMS',
      what: 'Notification dispatched to operations team',
    },
    {
      offsetMs: 17000,
      Icon: User,
      tone: 'neutral' as const,
      who: 'Traffic ops',
      what: 'Traffic ops acknowledged · reviewing clip',
    },
    {
      offsetMs: 45000,
      Icon: Bell,
      tone: 'warn' as const,
      who: 'Ops center',
      what: 'Event flagged for follow-up',
    },
  ]

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
        Event timeline
      </div>
      {entries.map((ev, i) => {
        const iconColor =
          ev.tone === 'accent' ? 'var(--accent-400)' :
          ev.tone === 'warn'   ? 'var(--warn-500)' :
          'var(--fg-3)'
        const iconBg =
          ev.tone === 'accent' ? 'color-mix(in srgb, var(--accent-500) 20%, transparent)' :
          ev.tone === 'warn'   ? 'color-mix(in srgb, var(--warn-500) 20%, transparent)' :
          'var(--surface-3)'
        return (
          <div key={i} style={{ display: 'flex', gap: 14, paddingBottom: 14, position: 'relative' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)',
              minWidth: 80, paddingTop: 4 }}>
              {fmtHMS(detail.created_at, ev.offsetMs)}
            </div>
            <div style={{ position: 'relative' }}>
              <div style={{ width: 22, height: 22, borderRadius: 999, background: iconBg,
                color: iconColor, display: 'grid', placeItems: 'center', border: '1px solid var(--border)' }}>
                <ev.Icon size={11} />
              </div>
              {i < entries.length - 1 && (
                <div style={{ position: 'absolute', left: 10.5, top: 22, bottom: -14, width: 1,
                  background: 'var(--border)' }} />
              )}
            </div>
            <div style={{ flex: 1, paddingTop: 2 }}>
              <div style={{ fontSize: 13, color: 'var(--fg-1)', marginBottom: 2 }}>{ev.what}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>{ev.who}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Right panel sections ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-4)',
      letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>
      {children}
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 20px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface-1)', gap: 10, flexShrink: 0 }}>
        <Skeleton className="w-48 h-4" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', flex: 1, minHeight: 0 }}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Skeleton className="w-72 h-7" />
          <Skeleton className="w-full" style={{ aspectRatio: '16/9' } as React.CSSProperties} />
          <Skeleton className="w-full h-32" />
        </div>
        <div style={{ padding: 20, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skeleton className="w-full h-10" />
          <Skeleton className="w-full h-8" />
          <Skeleton className="w-full h-8" />
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [detail, setDetail] = useState<EventDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`/api/incidents/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (data && data.id) {
          // Map real API shape → EventDetail, falling back to mock for scene/extra fields
          const mock = MOCK_EVENT_DETAILS[id]
          setDetail({
            id: data.id,
            scene: mock?.scene ?? 'highway',
            title: mock?.title ?? data.original_filename,
            cameraId: mock?.cameraId ?? 'CAM-000',
            cameraLabel: mock?.cameraLabel ?? data.original_filename,
            rule: mock?.rule ?? data.rule_id,
            ruleId: data.rule_id,
            severity: data.severity,
            confidence: data.confidence,
            vlmSummary: data.vlm_reasoning ?? mock?.vlmSummary ?? '',
            vlmTags: mock?.vlmTags ?? [],
            vlmModel: data.vlm_model ?? mock?.vlmModel ?? 'aims-vision-4.2',
            vlmLatencyMs: data.vlm_latency_ms ?? mock?.vlmLatencyMs ?? 0,
            duration: mock?.duration ?? Math.max(data.t_end_s - data.t_start_s, 5),
            relatedCameras: mock?.relatedCameras ?? [],
            created_at: data.created_at,
          })
          setLoading(false)
        } else {
          throw new Error('empty')
        }
      })
      .catch(() => {
        const mock = MOCK_EVENT_DETAILS[id]
        if (mock) {
          setDetail(mock)
        } else {
          setNotFound(true)
        }
        setLoading(false)
      })
  }, [id])

  if (loading) return <LoadingSkeleton />

  if (notFound || !detail) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 8, color: 'var(--fg-4)' }}>
        <Video size={28} style={{ opacity: 0.4 }} />
        <div style={{ fontSize: 14, fontWeight: 500 }}>Event not found</div>
        <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>ID: {id}</div>
        <Link href="/events">
          <Button variant="ghost" size="sm" className="mt-2 gap-1.5">
            <ChevronLeft size={13} /> Back to feed
          </Button>
        </Link>
      </div>
    )
  }

  const sevColor = SEVERITY_COLOR[detail.severity]

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* Breadcrumb bar */}
      <div style={{ height: 48, borderBottom: '1px solid var(--border)', background: 'var(--surface-1)',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 8, fontSize: 13, flexShrink: 0 }}>
        <Link href="/live" style={{ color: 'var(--fg-4)', textDecoration: 'none' }}>Live Ops</Link>
        <ChevronRightSm size={11} style={{ color: 'var(--fg-4)' }} />
        <Link href="/events" style={{ color: 'var(--fg-3)', textDecoration: 'none' }}>Event Feed</Link>
        <ChevronRightSm size={11} style={{ color: 'var(--fg-4)' }} />
        <span style={{ color: 'var(--fg-1)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
          {shortId(detail.id)}
        </span>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" className="gap-1 h-7 px-2 text-[11px]" disabled>
          <ChevronLeft size={11} /> Prev
        </Button>
        <Button variant="ghost" size="sm" className="gap-1 h-7 px-2 text-[11px]" disabled>
          Next <ChevronRight size={11} />
        </Button>
      </div>

      {/* Body: 1fr + 360px */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* ── Left scrollable panel ── */}
        <div style={{ padding: 24, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Header */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 2,
                border: `1px solid ${sevColor}`, color: sevColor,
                background: `color-mix(in srgb, ${sevColor} 12%, transparent)`,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>{detail.severity}</span>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)' }}>
                {shortId(detail.id)} · {detail.ruleId}
              </div>
            </div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600,
              letterSpacing: '-0.02em', margin: '0 0 10px', color: 'var(--fg-1)', lineHeight: 1.2 }}>
              {detail.title}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--fg-3)',
              display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={11} />{fmtFull(detail.created_at)}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <MapPin size={11} />{detail.cameraLabel}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Shield size={11} />{Math.round(detail.confidence * 100)}% confidence
              </span>
            </div>
          </div>

          <AnimatedPlayer detail={detail} />
          <AiSummaryPanel detail={detail} />
          <EventTimeline detail={detail} />
        </div>

        {/* ── Right panel ── */}
        <div style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface-1)',
          padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 22 }}>

          {/* Dispatch */}
          <div>
            <SectionLabel>Dispatch</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Button variant="default" size="sm" className="w-full justify-center gap-1.5">
                <Zap size={12} /> Escalate to 911 CAD
              </Button>
              <Button variant="secondary" size="sm" className="w-full justify-center gap-1.5">
                <Bell size={12} /> Notify AZ DOT traffic ops
              </Button>
              <Button variant="secondary" size="sm" className="w-full justify-center gap-1.5">
                <Sparkles size={12} /> Mark as resolved
              </Button>
              <Button variant="ghost" size="sm" className="w-full justify-center gap-1.5 text-[var(--fg-3)]">
                <X size={12} /> Mark as false positive
              </Button>
            </div>
          </div>

          {/* Detection rule card */}
          <div>
            <SectionLabel>Detection rule</SectionLabel>
            <div style={{ padding: 12, background: 'var(--surface-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)', marginBottom: 4 }}>
                {detail.rule}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8 }}>
                Rule ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{detail.ruleId}</span>
              </div>
              <Link href="/rules">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]">
                  View rule config
                </Button>
              </Link>
            </div>
          </div>

          {/* Related cameras */}
          {detail.relatedCameras.length > 0 && (
            <div>
              <SectionLabel>Related cameras</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.relatedCameras.map((cam) => (
                  <Link key={cam.id} href={`/live`} style={{ textDecoration: 'none' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                    }}>
                      <Video size={13} style={{ color: 'var(--fg-4)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: 'var(--fg-1)', fontWeight: 500,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cam.label}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)' }}>
                          {cam.id} · {cam.distance}
                        </div>
                      </div>
                      <ChevronRightSm size={12} style={{ color: 'var(--fg-4)', flexShrink: 0 }} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Export */}
          <div>
            <SectionLabel>Export</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Download size={12} /> Incident PDF
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Download size={12} /> JSON data
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
