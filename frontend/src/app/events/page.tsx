'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowUpRight,
  Car,
  CheckCircle2,
  Clock,
  Layers,
  ParkingSquare,
  PersonStanding,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'high' | 'medium' | 'low'
type VlmStatus = 'pending' | 'done' | 'skipped' | 'error'
type VlmVerdict = 'confirmed' | 'rejected' | null

interface FeedIncident {
  id: string
  video_id: string
  original_filename: string
  rule_id: string
  severity: Severity
  confidence: number
  t_start_s: number
  t_end_s: number
  vlm_status: VlmStatus
  vlm_verdict: VlmVerdict
  vlm_confidence: number | null
  created_at: string
}

// ─── Rule display metadata ─────────────────────────────────────────────────────

const RULE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  vehicle_collision: {
    label: 'Vehicle Collision',
    icon: <Car size={13} />,
    color: 'var(--danger-500)',
  },
  ped_impact: {
    label: 'Pedestrian Impact',
    icon: <PersonStanding size={13} />,
    color: 'var(--danger-500)',
  },
  stationary_vehicle: {
    label: 'Stationary Vehicle',
    icon: <ParkingSquare size={13} />,
    color: 'var(--warn-500)',
  },
  mass_stop: {
    label: 'Mass Stop',
    icon: <Layers size={13} />,
    color: 'var(--warn-500)',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    high: 'text-[var(--danger-500)] border-[color-mix(in_srgb,var(--danger-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger-500)_10%,transparent)]',
    medium: 'text-[var(--warn-500)] border-[color-mix(in_srgb,var(--warn-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn-500)_10%,transparent)]',
    low: 'text-[var(--fg-4)] border-[var(--border)] bg-[var(--surface-2)]',
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold tracking-wide border uppercase ${styles[severity]}`}>
      {severity}
    </span>
  )
}

function VlmBadge({ status, verdict }: { status: VlmStatus; verdict: VlmVerdict }) {
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border uppercase text-[var(--fg-4)] border-[var(--border)] bg-[var(--surface-2)]">
        <Clock size={9} />
        pending
      </span>
    )
  }
  if (status === 'done' && verdict === 'confirmed') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border uppercase text-[var(--ok-500)] border-[color-mix(in_srgb,var(--ok-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--ok-500)_10%,transparent)]">
        <CheckCircle2 size={9} />
        confirmed
      </span>
    )
  }
  if (status === 'done' && verdict === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border uppercase text-[var(--fg-4)] border-[var(--border)] bg-[var(--surface-2)]">
        <XCircle size={9} />
        rejected
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border uppercase text-[var(--fg-4)] border-[var(--border)] bg-[var(--surface-2)]">
      —
    </span>
  )
}

function IncidentRow({ inc }: { inc: FeedIncident }) {
  const meta = RULE_META[inc.rule_id]
  return (
    <div className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors group">
      <div
        className="w-1.5 h-8 rounded-full shrink-0"
        style={{ background: meta?.color ?? 'var(--fg-4)' }}
      />
      <div className="flex items-center gap-2 w-[200px] shrink-0">
        <span style={{ color: meta?.color ?? 'var(--fg-4)' }}>{meta?.icon}</span>
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg-1)] leading-tight">
            {meta?.label ?? inc.rule_id}
          </div>
          <SeverityBadge severity={inc.severity} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-[var(--fg-2)] truncate" title={inc.original_filename}>
          {inc.original_filename}
        </div>
        <div className="font-mono text-[11px] text-[var(--fg-4)]">
          {fmtSeconds(inc.t_start_s)} – {fmtSeconds(inc.t_end_s)}
        </div>
      </div>
      <div className="w-[64px] shrink-0 text-right">
        <div className="font-mono text-[13px] text-[var(--fg-1)]">
          {Math.round(inc.confidence * 100)}%
        </div>
        <div className="text-[10px] text-[var(--fg-4)]">confidence</div>
      </div>
      <div className="w-[96px] shrink-0">
        <VlmBadge status={inc.vlm_status} verdict={inc.vlm_verdict} />
      </div>
      <div className="w-[120px] shrink-0 font-mono text-[11px] text-[var(--fg-4)]">
        {fmtTimestamp(inc.created_at)}
      </div>
      <Link
        href={`/events/${inc.id}`}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Button variant="ghost" size="sm" className="gap-1 h-7 px-2 text-[11px]">
          View <ArrowUpRight size={11} />
        </Button>
      </Link>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EventFeedPage() {
  const [incidents, setIncidents] = useState<FeedIncident[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  function load() {
    setLoading(true)
    setError(null)
    fetch('/api/incidents/feed?limit=200')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setIncidents(data.incidents)
        setTotal(data.total)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }

  useEffect(() => { load() }, [])

  const filtered = filter === 'all'
    ? incidents
    : filter === 'confirmed'
    ? incidents.filter((i) => i.vlm_verdict === 'confirmed')
    : filter === 'pending'
    ? incidents.filter((i) => i.vlm_status === 'pending')
    : incidents.filter((i) => i.rule_id === filter)

  const ruleOptions = Array.from(new Set(incidents.map((i) => i.rule_id)))

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[var(--fg-4)]">
        <AlertTriangle size={16} />
        <span className="text-sm">Failed to load event feed: {error}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-1)] shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={14} style={{ color: 'var(--accent-400)' }} />
            <h1 className="font-display text-[15px] font-semibold tracking-tight text-[var(--fg-1)]">
              Event Feed
            </h1>
          </div>
          <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
            {total !== null ? `${total} incidents across all uploads` : 'Cross-upload incident feed'}
          </div>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 flex-wrap">
          {(['all', 'confirmed', 'pending'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2.5 h-7 text-[11px] font-medium rounded-[var(--radius-sm)] border transition-colors capitalize"
              style={{
                background: filter === f ? 'color-mix(in srgb, var(--accent-500) 12%, transparent)' : 'var(--surface-2)',
                color: filter === f ? 'var(--accent-400)' : 'var(--fg-3)',
                borderColor: filter === f ? 'color-mix(in srgb, var(--accent-500) 35%, transparent)' : 'var(--border)',
              }}
            >
              {f}
            </button>
          ))}
          {ruleOptions.map((r) => (
            <button
              key={r}
              onClick={() => setFilter(r)}
              className="px-2.5 h-7 text-[11px] font-medium rounded-[var(--radius-sm)] border transition-colors"
              style={{
                background: filter === r ? 'color-mix(in srgb, var(--accent-500) 12%, transparent)' : 'var(--surface-2)',
                color: filter === r ? 'var(--accent-400)' : 'var(--fg-3)',
                borderColor: filter === r ? 'color-mix(in srgb, var(--accent-500) 35%, transparent)' : 'var(--border)',
              }}
            >
              {RULE_META[r]?.label ?? r}
            </button>
          ))}
        </div>

        <Button variant="ghost" size="sm" onClick={load} className="gap-1.5 h-7 px-2.5 text-[11px]">
          <RefreshCw size={11} />
          Refresh
        </Button>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-4 px-5 py-2 bg-[var(--surface-2)] border-b border-[var(--border)] shrink-0">
        <div className="w-1.5 shrink-0" />
        <div className="w-[200px] shrink-0 text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--fg-4)]">
          Rule
        </div>
        <div className="flex-1 text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--fg-4)]">
          Video · Timestamp
        </div>
        <div className="w-[64px] shrink-0 text-right text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--fg-4)]">
          Conf.
        </div>
        <div className="w-[96px] shrink-0 text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--fg-4)]">
          VLM
        </div>
        <div className="w-[120px] shrink-0 text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--fg-4)]">
          Detected
        </div>
        <div className="w-[60px] shrink-0" />
      </div>

      {/* Rows */}
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5">
                <Skeleton className="w-1.5 h-8 rounded-full" />
                <Skeleton className="w-48 h-8" />
                <Skeleton className="flex-1 h-8" />
                <Skeleton className="w-16 h-8" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Sparkles size={28} style={{ color: 'var(--fg-4)' }} />
            <div className="text-[13px] font-semibold text-[var(--fg-2)]">
              {incidents.length === 0 ? 'No incidents detected yet' : 'No results for this filter'}
            </div>
            <p className="text-[12px] text-[var(--fg-4)] max-w-xs">
              {incidents.length === 0
                ? 'Upload and analyze a video to start seeing detection events here.'
                : 'Try a different filter or check back after more videos are analyzed.'}
            </p>
          </div>
        ) : (
          filtered.map((inc) => <IncidentRow key={inc.id} inc={inc} />)
        )}
      </ScrollArea>

      {!loading && filtered.length > 0 && (
        <div className="px-5 py-2 border-t border-[var(--border)] bg-[var(--surface-1)] shrink-0">
          <span className="font-mono text-[11px] text-[var(--fg-4)]">
            Showing {filtered.length} of {total ?? incidents.length} incidents
          </span>
        </div>
      )}
    </div>
  )
}
