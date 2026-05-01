'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Car,
  Check,
  Clock,
  HelpCircle,
  PersonStanding,
  ParkingSquare,
  Layers,
  X,
} from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { type VlmVerdict } from '@/lib/uploads'

// ─── Types ────────────────────────────────────────────────────────────────────

type RuleId = 'vehicle_collision' | 'ped_impact' | 'stationary_vehicle' | 'mass_stop'
type Severity = 'high' | 'medium' | 'low'

interface RecentIncident {
  id: string
  video_id: string
  confidence: number
  t_start_s: number
  t_end_s: number
  track_ids: number[]
  metadata: Record<string, unknown>
  created_at: string
  vlm_status: string
  vlm_verdict: VlmVerdict
  vlm_confidence: number | null
}

interface CatalogEntry {
  rule_id: RuleId
  severity: Severity
  total: number
  avg_confidence: number
  vlm_confirmed: number
  vlm_rejected: number
  vlm_pending: number
  false_positive_rate: number | null
  last_detected_at: string | null
  recent_incidents: RecentIncident[]
}

// ─── Static rule metadata ─────────────────────────────────────────────────────

const RULE_META: Record<RuleId, {
  label: string
  desc: string
  icon: React.ReactNode
  color: string
  thresholds: { label: string; value: string }[]
  logic: string
}> = {
  vehicle_collision: {
    label: 'Vehicle Collision',
    desc: 'Two vehicle tracks with sustained bounding-box overlap followed by a simultaneous velocity collapse and extended stationary period.',
    icon: <Car size={18} />,
    color: 'var(--danger-500)',
    thresholds: [
      { label: 'Min IOU overlap', value: '0.30' },
      { label: 'Sustained frames', value: '3' },
      { label: 'Co-stop window', value: '±1.0 s' },
      { label: 'Velocity drop (×)', value: '5.0' },
      { label: 'Stationary after (s)', value: '3.0' },
    ],
    logic: 'Requires both vehicles to show ≥5× velocity drop within 1 s of overlap, then remain stationary for ≥3 s combined.',
  },
  ped_impact: {
    label: 'Pedestrian Impact',
    desc: 'A car and person track with sustained centroid proximity, followed by the pedestrian stopping or disappearing.',
    icon: <PersonStanding size={18} />,
    color: 'var(--danger-500)',
    thresholds: [
      { label: 'Centroid proximity', value: '< 0.5 × avg-diag' },
      { label: 'Proximity frames', value: '2' },
      { label: 'Post-impact window', value: '1.0 s' },
    ],
    logic: 'Person track must stop (v < 5 px/s) or terminate within 1 s of proximity.',
  },
  stationary_vehicle: {
    label: 'Stationary Vehicle',
    desc: 'A vehicle that was previously moving but has remained stopped in-lane or on the shoulder for an extended period.',
    icon: <ParkingSquare size={18} />,
    color: 'var(--warn-500)',
    thresholds: [
      { label: 'Min stationary (s)', value: '15.0' },
      { label: 'Prior motion (px/s)', value: '> 8.0' },
    ],
    logic: 'Track must exceed 8 px/s at some earlier point (not parked), then stay below 5 px/s for ≥15 s.',
  },
  mass_stop: {
    label: 'Mass Stop / Traffic Jam',
    desc: 'Four or more vehicle tracks exhibiting a high simultaneous velocity drop within a 2-second window — a sudden traffic arrest.',
    icon: <Layers size={18} />,
    color: 'var(--warn-500)',
    thresholds: [
      { label: 'Min vehicles', value: '4' },
      { label: 'Time window (s)', value: '2.0' },
      { label: 'Velocity drop (×)', value: '6.0' },
    ],
    logic: 'At least 4 distinct tracks must each show ≥6× velocity drop ratio within the same 2-second window.',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    high: 'bg-[color-mix(in_srgb,var(--danger-500)_14%,transparent)] text-[var(--danger-500)] border-[color-mix(in_srgb,var(--danger-500)_30%,transparent)]',
    medium: 'bg-[color-mix(in_srgb,var(--warn-500)_14%,transparent)] text-[var(--warn-500)] border-[color-mix(in_srgb,var(--warn-500)_30%,transparent)]',
    low: 'bg-[color-mix(in_srgb,var(--ink-400)_14%,transparent)] text-[var(--fg-3)] border-[color-mix(in_srgb,var(--ink-400)_30%,transparent)]',
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold tracking-wide border uppercase ${styles[severity]}`}>
      {severity}
    </span>
  )
}

function VlmPill({ verdict, status }: { verdict: VlmVerdict; status: string }) {
  if (status === 'skipped' || status === 'pending') return (
    <span className="inline-flex items-center gap-1 text-[var(--fg-4)] text-[10px]">
      <Clock size={10} /> {status}
    </span>
  )
  if (verdict === 'confirmed') return (
    <span className="inline-flex items-center gap-1 text-[var(--ok-500)] text-[10px] font-medium">
      <Check size={10} strokeWidth={2.5} /> confirmed
    </span>
  )
  if (verdict === 'rejected') return (
    <span className="inline-flex items-center gap-1 text-[var(--danger-500)] text-[10px] font-medium">
      <X size={10} strokeWidth={2.5} /> rejected
    </span>
  )
  if (verdict === 'uncertain') return (
    <span className="inline-flex items-center gap-1 text-[var(--warn-500)] text-[10px] font-medium">
      <HelpCircle size={10} /> uncertain
    </span>
  )
  if (status === 'error') return (
    <span className="text-[var(--danger-500)] text-[10px]">error</span>
  )
  return null
}

function StatCard({ label, value, mono = false }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--radius-sm)]">
      <div className="text-[10px] font-semibold tracking-widest uppercase text-[var(--fg-4)] mb-1">{label}</div>
      <div className={`text-lg font-semibold text-[var(--fg-1)] leading-none ${mono ? 'font-mono' : 'font-display'}`}>
        {value}
      </div>
    </div>
  )
}

// ─── Left panel — catalog list ────────────────────────────────────────────────

function CatalogList({
  entries,
  selectedId,
  onSelect,
  loading,
}: {
  entries: CatalogEntry[]
  selectedId: RuleId
  onSelect: (id: RuleId) => void
  loading: boolean
}) {
  return (
    <div className="flex flex-col h-full border-r border-[var(--border)] bg-[var(--surface-1)]">
      {/* list header */}
      <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="text-xs font-semibold text-[var(--fg-1)]">Incident catalog</div>
        <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
          {RULE_META ? Object.keys(RULE_META).length : 4} types · rule-based detection
        </div>
      </div>

      <ScrollArea className="flex-1">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-4 py-3 border-b border-[var(--border)]">
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-3 w-full mb-1" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))
          : entries.map((entry) => {
              const meta = RULE_META[entry.rule_id]
              const isSel = entry.rule_id === selectedId
              return (
                <button
                  key={entry.rule_id}
                  onClick={() => onSelect(entry.rule_id)}
                  className="w-full text-left px-4 py-3 border-b border-[var(--border)] transition-colors hover:bg-[var(--surface-2)]"
                  style={{
                    background: isSel ? 'color-mix(in srgb, var(--accent-500) 8%, transparent)' : undefined,
                    borderLeft: isSel ? '3px solid var(--accent-500)' : '3px solid transparent',
                    paddingLeft: isSel ? 13 : 16,
                  }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div
                      className="flex items-center justify-center w-6 h-6 rounded-[3px] shrink-0"
                      style={{
                        background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                        color: meta.color,
                      }}
                    >
                      {meta.icon}
                    </div>
                    <span className="text-[13px] font-semibold text-[var(--fg-1)] flex-1 truncate">{meta.label}</span>
                    <span className="font-mono text-[11px] text-[var(--fg-3)] shrink-0">{entry.total}</span>
                  </div>
                  <p className="text-[11px] text-[var(--fg-3)] leading-[1.4] line-clamp-2 mb-2">
                    {meta.desc}
                  </p>
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={entry.severity} />
                    {entry.total > 0 && (
                      <span className="text-[10px] text-[var(--fg-4)]">
                        {entry.vlm_confirmed} confirmed
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
      </ScrollArea>
    </div>
  )
}

// ─── Right panel — rule detail ────────────────────────────────────────────────

function RuleDetail({ entry, loading }: { entry: CatalogEntry | null; loading: boolean }) {
  if (loading || !entry) {
    return (
      <div className="flex-1 overflow-auto p-7">
        <Skeleton className="h-8 w-64 mb-4" />
        <div className="grid grid-cols-4 gap-2 mb-6">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
        <Skeleton className="h-40 mb-4" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  const meta = RULE_META[entry.rule_id]

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl p-7 space-y-0">
        {/* Header */}
        <div className="flex items-center gap-3 mb-1">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-sm)] border shrink-0"
            style={{
              background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
              color: meta.color,
              borderColor: `color-mix(in srgb, ${meta.color} 28%, transparent)`,
            }}
          >
            {meta.icon}
          </div>
          <div>
            <div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--fg-4)]">
              Incident type
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight text-[var(--fg-1)] leading-none">
                {meta.label}
              </h1>
              <SeverityBadge severity={entry.severity} />
            </div>
          </div>
        </div>

        <p className="text-[13px] text-[var(--fg-3)] leading-relaxed mt-3 mb-5">{meta.desc}</p>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-2 mb-7">
          <StatCard label="Total detected" value={entry.total} />
          <StatCard label="VLM confirmed" value={entry.vlm_confirmed} />
          <StatCard
            label="Avg confidence"
            value={entry.avg_confidence > 0 ? entry.avg_confidence.toFixed(2) : '—'}
            mono
          />
          <StatCard
            label="False positive rate"
            value={entry.false_positive_rate != null ? `${(entry.false_positive_rate * 100).toFixed(0)}%` : '—'}
          />
        </div>

        {/* Detection thresholds */}
        <Section title="Detection thresholds" subtitle="Module-level constants that govern when this rule fires">
          <div className="space-y-1.5">
            {meta.thresholds.map((t) => (
              <div
                key={t.label}
                className="flex items-center gap-3 px-3 py-2.5 bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--radius-sm)]"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-500)] shrink-0" />
                <span className="flex-1 text-[12px] text-[var(--fg-2)]">{t.label}</span>
                <span className="font-mono text-[12px] text-[var(--accent-400)]">{t.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 px-3 py-2.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-sm)]">
            <span className="text-[11px] font-semibold text-[var(--fg-2)]">Trigger logic: </span>
            <span className="text-[11px] text-[var(--fg-3)]">{meta.logic}</span>
          </div>
        </Section>

        {/* Recent incidents */}
        <Section
          title="Recent incidents"
          subtitle={entry.total === 0 ? 'No incidents detected yet' : `Most recent ${Math.min(5, entry.total)} of ${entry.total} total`}
        >
          {entry.total === 0 ? (
            <div className="py-8 text-center text-[var(--fg-4)] text-sm">
              No incidents detected. Run
              {' '}
              <span className="font-mono text-[var(--accent-400)]">POST /api/uploads/:id/analyze</span>
              {' '}
              after uploading a video.
            </div>
          ) : (
            <div className="space-y-1.5">
              {entry.recent_incidents.map((inc) => (
                <Link
                  key={inc.id}
                  href={`/uploads/${inc.video_id}`}
                  className="flex items-center gap-3 px-3 py-2.5 bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--radius-sm)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-[var(--fg-3)]">
                        {fmtTime(inc.t_start_s)}–{fmtTime(inc.t_end_s)}
                      </span>
                      <span className="text-[10px] text-[var(--fg-4)]">·</span>
                      <span className="font-mono text-[11px] text-[var(--fg-3)]">
                        {inc.track_ids.length} track{inc.track_ids.length !== 1 ? 's' : ''}
                      </span>
                      <span className="text-[10px] text-[var(--fg-4)]">·</span>
                      <span className="font-mono text-[11px] text-[var(--accent-400)]">
                        {(inc.confidence * 100).toFixed(0)}% conf
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--fg-4)] mt-0.5 font-mono truncate">
                      {inc.video_id}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-3">
                    <VlmPill verdict={inc.vlm_verdict} status={inc.vlm_status} />
                    <span className="text-[10px] text-[var(--fg-4)]">{fmtRelative(inc.created_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="pt-6 mt-6 border-t border-[var(--border)]">
      <div className="mb-3.5">
        <div className="font-display text-[15px] font-semibold tracking-tight text-[var(--fg-1)]">{title}</div>
        {subtitle && <div className="text-[11px] text-[var(--fg-3)] mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IncidentCatalogPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<RuleId>('vehicle_collision')

  useEffect(() => {
    fetch('/api/incidents/catalog')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setCatalog(data.catalog)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const selectedEntry = catalog.find((e) => e.rule_id === selectedId) ?? null

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--fg-4)] gap-2">
        <AlertTriangle size={16} />
        <span className="text-sm">Failed to load catalog: {error}</span>
      </div>
    )
  }

  // Ensure all 4 rules show even before data loads
  const displayEntries: CatalogEntry[] =
    loading
      ? (Object.keys(RULE_META) as RuleId[]).map((rule_id) => ({
          rule_id,
          severity: ({ vehicle_collision: 'high', ped_impact: 'high', stationary_vehicle: 'medium', mass_stop: 'low' } as Record<RuleId, Severity>)[rule_id],
          total: 0,
          avg_confidence: 0,
          vlm_confirmed: 0,
          vlm_rejected: 0,
          vlm_pending: 0,
          false_positive_rate: null,
          last_detected_at: null,
          recent_incidents: [],
        }))
      : catalog

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Left — 360px catalog list */}
      <div className="w-[360px] shrink-0 flex flex-col min-h-0">
        <CatalogList
          entries={displayEntries}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={false}
        />
      </div>

      {/* Right — detail panel */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg)]">
        <RuleDetail entry={selectedEntry} loading={loading} />
      </div>
    </div>
  )
}
