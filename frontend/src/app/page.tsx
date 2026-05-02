'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowUpRight,
  FileVideo,
  Gauge,
  MapPinned,
  ShieldCheck,
  Sparkles,
  Upload,
  Video,
} from 'lucide-react'

import {
  type UploadRecord,
  type Incident,
  formatDuration,
  formatUploaded,
} from '@/lib/uploads'
import { hasSeenTour, resumeTourIfNeeded } from '@/lib/tour'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

const DEMO_NOTICE_KEY = 'aims:demo-notice:v1'

const KPI_TRENDS = {
  events: [12, 18, 15, 22, 19, 28, 24, 31, 27, 34, 29, 38],
  response: [8, 7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 4],
  falsePositive: [5, 4.5, 4, 3.8, 3.5, 3.2, 3, 2.8, 2.7, 2.6, 2.5, 2.4],
  cameras: [140, 141, 138, 142, 143, 142, 141, 142, 142, 143, 142, 142],
}

const EVENT_BREAKDOWN = [
  { label: 'Vehicle detections', value: 412, color: 'var(--accent-500)' },
  { label: 'Pedestrian activity', value: 289, color: 'var(--accent-400)' },
  { label: 'Bicycle activity', value: 184, color: 'var(--warn-500)' },
  { label: 'Road signs', value: 138, color: 'var(--accent-300)' },
  { label: 'Other objects', value: 177, color: 'var(--ink-400)' },
]

const CORRIDOR_BREAKDOWN = [
  { label: 'Loop 101', value: 384, color: 'var(--accent-500)' },
  { label: 'Bell Rd', value: 248, color: 'var(--accent-400)' },
  { label: 'Grand Ave', value: 192, color: 'var(--accent-400)' },
  { label: '83rd Ave', value: 156, color: 'var(--accent-300)' },
  { label: 'Thunderbird', value: 134, color: 'var(--accent-300)' },
  { label: 'Other', value: 133, color: 'var(--ink-400)' },
]

const SEVERITY_BREAKDOWN = [
  { label: 'Critical', value: 47, color: 'var(--danger-500)' },
  { label: 'High', value: 218, color: 'var(--warn-500)' },
  { label: 'Medium', value: 549, color: 'var(--accent-400)' },
  { label: 'Low', value: 433, color: 'var(--ink-400)' },
]

const ACTIVE_RULES = [
  { name: 'Stopped vehicle on shoulder', triggers: 412, fp: 1.8, status: 'mock live' },
  { name: 'Debris or cargo loss', triggers: 289, fp: 3.4, status: 'mock live' },
  { name: 'Wrong-way movement', triggers: 47, fp: 0.4, status: 'mock live' },
  { name: 'Standing water on roadway', triggers: 138, fp: 2.1, status: 'mock live' },
  { name: 'Signal phase anomaly', triggers: 177, fp: 5.2, status: 'tuning' },
]

export default function DashboardPage() {
  const router = useRouter()
  const [uploads, setUploads] = useState<UploadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [incidentCount, setIncidentCount] = useState<number | null>(null)
  const [vlmConfirmedCount, setVlmConfirmedCount] = useState<number | null>(null)
  const [incidentsLoading, setIncidentsLoading] = useState(true)
  const [demoNoticeOpen, setDemoNoticeOpen] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(DEMO_NOTICE_KEY)) setDemoNoticeOpen(true)
  }, [])

  useEffect(() => {
    if (!hasSeenTour()) resumeTourIfNeeded('dashboard', router.push)
  }, [router])

  useEffect(() => {
    let cancelled = false

    async function loadUploads() {
      setError(null)
      try {
        const res = await fetch('/api/uploads', { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) setUploads(data.uploads ?? [])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load uploads')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadUploads()

    return () => {
      cancelled = true
    }
  }, [])

  // Derive incident count by fetching per-upload — no dedicated /api/incidents endpoint yet.
  // When the backend adds a global count endpoint, replace this with a single fetch.
  useEffect(() => {
    if (loading) return
    if (uploads.length === 0) {
      setIncidentCount(0)
      setVlmConfirmedCount(0)
      setIncidentsLoading(false)
      return
    }

    let cancelled = false

    async function loadIncidentCounts() {
      try {
        const results = await Promise.all(
          uploads.map((u) =>
            fetch(`/api/uploads/${u.video_id}/incidents`, { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : { incidents: [] }))
              .then((d: { incidents?: Incident[] }) => d.incidents ?? [])
              .catch(() => [] as Incident[]),
          ),
        )
        if (!cancelled) {
          const all = results.flat()
          setIncidentCount(all.length)
          setVlmConfirmedCount(
            all.filter(i => i.vlm_status === 'done' && i.vlm_verdict === 'confirmed').length
          )
        }
      } finally {
        if (!cancelled) setIncidentsLoading(false)
      }
    }

    void loadIncidentCounts()

    return () => {
      cancelled = true
    }
  }, [uploads, loading])

  const stats = useMemo(() => {
    const eventCount = uploads.reduce((sum, item) => sum + item.event_count, 0)
    const trackCount = uploads.reduce((sum, item) => sum + item.track_count, 0)
    const totalDuration = uploads.reduce(
      (sum, item) => sum + (item.duration_s ?? 0),
      0,
    )
    const latestUpload = uploads[0] ?? null

    return {
      eventCount,
      trackCount,
      totalDuration,
      latestUpload,
    }
  }, [uploads])

  const latestUploads = uploads.slice(0, 5)

  function dismissDemoNotice() {
    localStorage.setItem(DEMO_NOTICE_KEY, '1')
    setDemoNoticeOpen(false)
  }

  return (
    <div className="flex h-full flex-col">
      <DemoNoticeDialog open={demoNoticeOpen} onDismiss={dismissDemoNotice} />
      <div className="flex-1 overflow-auto p-5">
        <div className="w-full">
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent-400)]">
                City operations · April 2026
              </div>
              <h1 className="mt-1 font-display text-[28px] font-semibold leading-tight tracking-tight text-foreground">
                Operations overview
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
                Upload-backed detection metrics with demo analytics placeholders
                for the v1 reporting surface.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-[color:var(--accent-500)]/40 bg-[color:var(--accent-500)]/10 text-[color:var(--accent-400)]"
              >
                Uploads live
              </Badge>
              <Badge variant="outline" className="text-muted-foreground">
                Analytics demo data
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {stats.latestUpload
                  ? `Updated ${formatUploaded(stats.latestUpload.uploaded_at)}`
                  : 'No uploads yet'}
              </span>
            </div>
          </div>

          {error && (
            <Card className="mb-4 border-[color:var(--danger-500)]/35 bg-destructive/10">
              <CardContent className="py-3 text-sm text-destructive">
                Dashboard metrics could not load: {error}
              </CardContent>
            </Card>
          )}

          <div data-tour="kpi-grid" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <KpiCard
              label="Events indexed"
              value={loading ? null : stats.eventCount.toLocaleString()}
              delta={`${stats.trackCount.toLocaleString()} tracks`}
              trend={KPI_TRENDS.events}
              tone="accent"
              source="Uploads API"
            />
            <KpiCard
              label="Analyzed footage"
              value={loading ? null : formatDuration(stats.totalDuration)}
              delta={`${uploads.length.toLocaleString()} uploads`}
              trend={KPI_TRENDS.cameras}
              tone="neutral"
              source="Uploads API"
            />
            <KpiCard
              label="Rule-detected"
              value={incidentsLoading ? null : (incidentCount ?? '—').toString()}
              delta="incidents"
              trend={KPI_TRENDS.falsePositive}
              tone="warn"
              source="Uploads API"
              icon={<AlertTriangle className="size-3.5" strokeWidth={1.75} />}
            />
            <div data-tour="kpi-vlm">
              <KpiCard
                label="VLM-confirmed"
                value={incidentsLoading ? null : (vlmConfirmedCount ?? '—').toString()}
                delta="by Cosmos-Reason2"
                trend={KPI_TRENDS.falsePositive}
                tone="ok"
                source="Uploads API"
                icon={<ShieldCheck className="size-3.5" strokeWidth={1.75} />}
              />
            </div>
            <KpiCard
              label="Avg. response time"
              value="3:42"
              delta="-24%"
              trend={KPI_TRENDS.response}
              tone="ok"
              source="Demo data"
            />
            <KpiCard
              label="False positive rate"
              value="2.4%"
              delta="-1.1pp"
              trend={KPI_TRENDS.falsePositive}
              tone="ok"
              source="Demo data"
            />
          </div>

          <div data-tour="trend-map" className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-[1.45fr_1fr]">
            <TrendCard />
            <MapCard />
          </div>

          <div data-tour="breakdown" className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <BreakdownCard title="By event type" items={EVENT_BREAKDOWN} />
            <BreakdownCard title="By corridor" items={CORRIDOR_BREAKDOWN} />
            <BreakdownCard title="By severity" items={SEVERITY_BREAKDOWN} />
          </div>

          <div data-tour="heatmap-rules" className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-[2fr_1fr]">
            <HeatmapCard />
            <RulesCard />
          </div>

          <div data-tour="recent-uploads" className="mb-6 grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1fr]">
            <RecentUploadsCard
              uploads={latestUploads}
              loading={loading}
              totalUploads={uploads.length}
            />
            <OutcomesCard />
          </div>
        </div>
      </div>
    </div>
  )
}

function KpiCard({
  label,
  value,
  delta,
  trend,
  tone,
  source,
  icon,
}: {
  label: string
  value: string | null
  delta: string
  trend: number[]
  tone: 'accent' | 'ok' | 'neutral' | 'warn'
  source: string
  icon?: React.ReactNode
}) {
  const color =
    tone === 'accent'
      ? 'var(--accent-500)'
      : tone === 'ok'
        ? 'var(--ok-500)'
        : tone === 'warn'
          ? 'var(--warn-500)'
          : 'var(--fg-4)'

  return (
    <Card className="rounded-[3px]">
      <CardContent className="py-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {icon && <span style={{ color }}>{icon}</span>}
            {label}
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {source}
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          {value == null ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="font-display text-[28px] font-semibold leading-none tracking-tight">
              {value}
            </div>
          )}
          <div className="font-mono text-xs font-medium" style={{ color }}>
            {delta}
          </div>
        </div>
        <Sparkline trend={trend} color={color} />
      </CardContent>
    </Card>
  )
}

function Sparkline({ trend, color }: { trend: number[]; color: string }) {
  const max = Math.max(...trend)
  const min = Math.min(...trend)
  const range = max - min || 1
  const points = trend
    .map((value, index) => {
      const x = (index / (trend.length - 1)) * 100
      const y = 30 - ((value - min) / range) * 26
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="mt-3 block h-9 w-full"
      aria-hidden="true"
    >
      <polygon points={`0,30 ${points} 100,30`} fill={color} opacity="0.12" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function TrendCard() {
  const days = 30
  const series = [
    {
      name: 'Vehicles',
      data: Array.from({ length: days }, (_, i) => 12 + Math.sin(i / 3) * 4 + (i % 5)),
      color: 'var(--accent-500)',
    },
    {
      name: 'Pedestrians',
      data: Array.from({ length: days }, (_, i) => 8 + Math.cos(i / 4) * 3 + (i % 4)),
      color: 'var(--accent-400)',
    },
    {
      name: 'Bicycles',
      data: Array.from({ length: days }, (_, i) => 5 + Math.sin(i / 5 + 2) * 2 + (i % 3)),
      color: 'var(--warn-500)',
    },
  ]
  const all = series.flatMap((item) => item.data)
  const max = Math.max(...all)
  const w = 700
  const h = 220
  const pl = 36
  const pr = 16
  const pt = 12
  const pb = 28
  const x = (i: number) => pl + (i / (days - 1)) * (w - pl - pr)
  const y = (value: number) => pt + (1 - value / max) * (h - pt - pb)

  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Events over time</CardTitle>
          <CardDescription>Daily detections by object type</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          {series.map((item) => (
            <span key={item.name} className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-[1px]"
                style={{ background: item.color }}
              />
              {item.name}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-[240px] w-full"
          aria-hidden="true"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <g key={p}>
              <line
                x1={pl}
                x2={w - pr}
                y1={pt + p * (h - pt - pb)}
                y2={pt + p * (h - pt - pb)}
                stroke="var(--border)"
                strokeWidth="1"
                strokeDasharray={p === 1 ? '0' : '2 3'}
              />
              <text
                x={pl - 6}
                y={pt + p * (h - pt - pb) + 3}
                fontSize="10"
                fill="var(--fg-4)"
                textAnchor="end"
                fontFamily="var(--font-mono)"
              >
                {Math.round(max * (1 - p))}
              </text>
            </g>
          ))}
          {[0, 7, 14, 21, 28].map((day) => (
            <text
              key={day}
              x={x(day)}
              y={h - 10}
              fontSize="10"
              fill="var(--fg-4)"
              textAnchor="middle"
              fontFamily="var(--font-mono)"
            >
              Apr {day + 1}
            </text>
          ))}
          {series.map((item) => {
            const points = item.data.map((value, i) => `${x(i)},${y(value)}`).join(' ')
            return (
              <polyline
                key={item.name}
                points={points}
                fill="none"
                stroke={item.color}
                strokeWidth="1.75"
              />
            )
          })}
        </svg>
      </CardContent>
    </Card>
  )
}

function MapCard() {
  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Hotspots</CardTitle>
          <CardDescription>Event density across Peoria</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent>
        <div
          className="relative min-h-[260px] overflow-hidden rounded-[3px] border"
          style={{ background: 'var(--surface-2)' }}
        >
          <svg
            viewBox="0 0 400 260"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            {[40, 90, 140, 190].map((yy) => (
              <line
                key={yy}
                x1={0}
                x2={400}
                y1={yy}
                y2={yy + (yy === 90 ? -2 : 2)}
                stroke="var(--border)"
                strokeWidth={yy === 90 ? 2.5 : 1.5}
              />
            ))}
            {[80, 160, 240, 320].map((xx) => (
              <line
                key={xx}
                x1={xx}
                x2={xx + 2}
                y1={0}
                y2={260}
                stroke="var(--border)"
                strokeWidth={xx === 160 ? 2.5 : 1.5}
              />
            ))}
            {[
              { x: 165, y: 88, r: 36, w: 1 },
              { x: 240, y: 90, r: 28, w: 0.7 },
              { x: 80, y: 140, r: 24, w: 0.6 },
              { x: 320, y: 190, r: 20, w: 0.5 },
              { x: 162, y: 192, r: 30, w: 0.85 },
            ].map((point, index) => (
              <g key={index}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.r * 1.6}
                  fill="var(--accent-500)"
                  opacity={point.w * 0.12}
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.r}
                  fill="var(--accent-500)"
                  opacity={point.w * 0.25}
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.r * 0.5}
                  fill="var(--accent-500)"
                  opacity={point.w * 0.5}
                />
              </g>
            ))}
            <text x="170" y="82" fontSize="9" fill="var(--fg-2)" fontFamily="var(--font-mono)">
              101 @ BELL
            </text>
            <text x="245" y="84" fontSize="9" fill="var(--fg-2)" fontFamily="var(--font-mono)">
              GRAND/75TH
            </text>
            <text x="84" y="135" fontSize="9" fill="var(--fg-2)" fontFamily="var(--font-mono)">
              83RD/T-BIRD
            </text>
          </svg>
          <div
            className="absolute bottom-2 left-2 flex items-center gap-2 rounded-[2px] border px-2 py-1 text-[10px] text-muted-foreground"
            style={{ background: 'var(--surface-1)' }}
          >
            <MapPinned className="size-3" />
            Demo density
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function BreakdownCard({
  title,
  items,
}: {
  title: string
  items: { label: string; value: number; color: string }[]
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  const max = Math.max(...items.map((item) => item.value))

  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{total.toLocaleString()} demo events</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => {
          const pct = (item.value / total) * 100
          const width = (item.value / max) * 100
          return (
            <div key={item.label}>
              <div className="mb-1 flex justify-between gap-3 text-xs">
                <span className="truncate text-foreground/85">{item.label}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {item.value.toLocaleString()} · {pct.toFixed(1)}%
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-[1px]"
                style={{ background: 'var(--surface-3)' }}
              >
                <div
                  className="h-full"
                  style={{ width: `${width}%`, background: item.color }}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function HeatmapCard() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const hours = Array.from({ length: 24 }, (_, index) => index)
  const cell = (day: number, hour: number) => {
    const rush =
      Math.exp(-Math.pow((hour - 8) / 2, 2)) +
      Math.exp(-Math.pow((hour - 17) / 2, 2))
    const weekend = day >= 5 ? 0.55 : 1
    return Math.min(1, rush * weekend * (0.9 + Math.sin(day + hour) * 0.1))
  }

  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>When events happen</CardTitle>
          <CardDescription>Day of week by hour of day</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[40px_1fr] gap-2">
          <div className="flex flex-col gap-1">
            {days.map((day) => (
              <div key={day} className="flex h-[18px] items-center text-[11px] text-muted-foreground">
                {day}
              </div>
            ))}
          </div>
          <div className="min-w-0">
            <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
              {days.map((day, dayIndex) =>
                hours.map((hour) => {
                  const value = cell(dayIndex, hour)
                  return (
                    <div
                      key={`${day}-${hour}`}
                      className="h-[18px] rounded-[1px]"
                      title={`${day} ${hour}:00`}
                      style={{
                        background: 'var(--accent-500)',
                        opacity: 0.08 + value * 0.82,
                      }}
                    />
                  )
                }),
              )}
            </div>
            <div className="mt-1 grid grid-cols-[repeat(24,minmax(0,1fr))]">
              {hours.map((hour) => (
                <div key={hour} className="text-center font-mono text-[9px] text-muted-foreground">
                  {hour % 6 === 0 ? `${hour}h` : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function RulesCard() {
  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Active detection rules</CardTitle>
          <CardDescription>Mock rule volumes for reporting</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border border-y">
          {ACTIVE_RULES.map((rule) => (
            <div key={rule.name} className="flex items-center gap-3 py-2.5">
              <Sparkles className="size-3.5 shrink-0 text-[color:var(--accent-400)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {rule.name}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  fp {rule.fp}%
                </div>
              </div>
              <div className="font-mono text-sm font-semibold">
                {rule.triggers}
              </div>
              <Badge
                variant="outline"
                className={
                  rule.status === 'tuning'
                    ? 'border-[color:var(--warn-500)]/40 bg-[color:var(--warn-500)]/10 text-[color:var(--warn-500)]'
                    : 'border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]'
                }
              >
                {rule.status}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function RecentUploadsCard({
  uploads,
  loading,
  totalUploads,
}: {
  uploads: UploadRecord[]
  loading: boolean
  totalUploads: number
}) {
  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Recent uploads</CardTitle>
          <CardDescription>
            Real v1 workflow · {totalUploads.toLocaleString()} total
          </CardDescription>
        </div>
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link href="/uploads">
            <Upload className="size-3.5" />
            Uploads
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="h-12 w-full" />
            ))}
          </div>
        ) : uploads.length === 0 ? (
          <div
            className="flex min-h-[180px] flex-col items-center justify-center rounded-[3px] border border-dashed p-6 text-center"
            style={{
              background:
                'color-mix(in srgb, var(--accent-500) 5%, var(--surface-1))',
            }}
          >
            <FileVideo className="mb-3 size-8 text-[color:var(--accent-400)]" />
            <div className="font-display text-base font-semibold">
              No uploads yet
            </div>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Add a clip to populate the real dashboard metrics and timeline
              inspection flow.
            </p>
            <Button asChild className="mt-4 gap-1.5">
              <Link href="/uploads">
                <Upload className="size-3.5" />
                Add upload
              </Link>
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border border-y">
            {uploads.map((upload) => (
              <Link
                key={upload.video_id}
                href={`/uploads/${upload.video_id}`}
                className="grid grid-cols-[40px_1fr_auto] items-center gap-3 py-3 transition-colors hover:bg-secondary/30"
              >
                <div
                  className="grid size-10 place-items-center rounded-[2px] border"
                  style={{ background: '#000' }}
                >
                  <Video className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs font-medium text-foreground">
                    {upload.original_filename}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{upload.event_count.toLocaleString()} events</span>
                    <span>{upload.track_count.toLocaleString()} tracks</span>
                    <span>{formatUploaded(upload.uploaded_at)}</span>
                  </div>
                </div>
                <ArrowUpRight className="size-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function OutcomesCard() {
  const outcomes = [
    {
      icon: Gauge,
      stat: '4 min 12 s',
      label: 'Avg. clearance time',
      body: 'Modeled improvement placeholder for future incident workflow data.',
    },
    {
      icon: ShieldCheck,
      stat: '0',
      label: 'Biometric IDs',
      body: 'Policy placeholder: v1 tracks detections, not face or gait identity.',
    },
  ]

  return (
    <Card className="rounded-[3px]">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Outcomes</CardTitle>
          <CardDescription>Executive reporting placeholders</CardDescription>
        </div>
        <DemoBadge />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {outcomes.map((item) => (
            <div
              key={item.label}
              className="rounded-[3px] border p-4"
              style={{ background: 'var(--surface-2)' }}
            >
              <item.icon className="mb-3 size-4 text-[color:var(--accent-400)]" />
              <div className="font-display text-2xl font-semibold tracking-tight text-[color:var(--accent-400)]">
                {item.stat}
              </div>
              <div className="mt-2 text-xs font-medium text-foreground">
                {item.label}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {item.body}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function DemoNoticeDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const rows: { label: string; status: 'live' | 'demo' }[] = [
    { label: 'Events indexed / Analyzed footage', status: 'live' },
    { label: 'Rule-detected incidents', status: 'live' },
    { label: 'VLM-confirmed incidents', status: 'live' },
    { label: 'Trend chart, hotspot map', status: 'demo' },
    { label: 'Event / corridor / severity breakdowns', status: 'demo' },
    { label: 'Activity heatmap, detection rules', status: 'demo' },
    { label: 'Outcomes & clearance times', status: 'demo' },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDismiss() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-base">About this dashboard</DialogTitle>
          <DialogDescription>
            The top KPI tiles reflect real data from videos you upload and process.
            The analytics panels below are placeholder data for the v1 reporting surface —
            they illustrate what the full operations view will show when connected to live feeds.
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border rounded-[3px] border text-xs">
          <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
            <span>Section</span>
            <span>Source</span>
          </div>
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2">
              <span className="text-foreground/85">{row.label}</span>
              <Badge
                variant="outline"
                className={
                  row.status === 'live'
                    ? 'border-[color:var(--ok-500)]/40 bg-[color:var(--ok-500)]/10 text-[color:var(--ok-300)]'
                    : 'border-border text-muted-foreground'
                }
              >
                {row.status === 'live' ? 'live' : 'demo'}
              </Badge>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={onDismiss} className="w-full sm:w-auto">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DemoBadge() {
  return (
    <Badge variant="outline" className="shrink-0 text-muted-foreground">
      demo data
    </Badge>
  )
}
