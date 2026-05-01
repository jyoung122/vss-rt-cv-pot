'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Car,
  Layers,
  ParkingSquare,
  PersonStanding,
  RotateCcw,
  Save,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

// ─── Types ────────────────────────────────────────────────────────────────────

type RuleId = 'vehicle_collision' | 'ped_impact' | 'stationary_vehicle' | 'mass_stop'
type Severity = 'high' | 'medium' | 'low'

interface ThresholdField {
  key: string
  label: string
  unit: string
  type: 'float' | 'int'
  min: number
  max: number
  step: number
}

interface CatalogEntry {
  rule_id: RuleId
  severity: Severity
  thresholds: Record<string, number>
  threshold_schema: ThresholdField[]
  thresholds_updated_at: string | null
}

// ─── Static rule UI metadata ──────────────────────────────────────────────────

const RULE_META: Record<RuleId, {
  label: string
  desc: string
  logic: string
  icon: React.ReactNode
  color: string
}> = {
  vehicle_collision: {
    label: 'Vehicle Collision',
    desc: 'Two vehicle tracks with sustained bounding-box overlap followed by a simultaneous velocity collapse and extended stationary period.',
    logic: 'Both vehicles must show a velocity drop above threshold within the co-stop window of the overlap, then stay stationary combined for the required duration.',
    icon: <Car size={18} />,
    color: 'var(--danger-500)',
  },
  ped_impact: {
    label: 'Pedestrian Impact',
    desc: 'A car and person track with sustained centroid proximity, followed by the pedestrian stopping or disappearing from the scene.',
    logic: 'Person track must stop (v < 5 px/s) or terminate within 1 s after the proximity window.',
    icon: <PersonStanding size={18} />,
    color: 'var(--danger-500)',
  },
  stationary_vehicle: {
    label: 'Stationary Vehicle',
    desc: 'A vehicle that was previously moving but has remained stopped in-lane or on the shoulder for an extended period.',
    logic: 'Track must have exceeded the prior-motion threshold at some earlier point (filters parked cars), then stay below 5 px/s for the minimum stationary duration.',
    icon: <ParkingSquare size={18} />,
    color: 'var(--warn-500)',
  },
  mass_stop: {
    label: 'Mass Stop / Traffic Jam',
    desc: 'Four or more vehicle tracks exhibiting a simultaneous high velocity drop within a short window — a sudden traffic arrest.',
    logic: 'At least N distinct tracks must each show a velocity drop ratio above threshold within the same time window.',
    icon: <Layers size={18} />,
    color: 'var(--warn-500)',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function SeverityDot({ color }: { color: string }) {
  return <div className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: color }} />
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    high: 'text-[var(--danger-500)] border-[color-mix(in_srgb,var(--danger-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger-500)_10%,transparent)]',
    medium: 'text-[var(--warn-500)] border-[color-mix(in_srgb,var(--warn-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn-500)_10%,transparent)]',
    low: 'text-[var(--fg-3)] border-[var(--border)] bg-[var(--surface-2)]',
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold tracking-wide border uppercase ${styles[severity]}`}>
      {severity}
    </span>
  )
}

// ─── Threshold editor ─────────────────────────────────────────────────────────

function ThresholdEditor({
  entry,
  onSaved,
}: {
  entry: CatalogEntry
  onSaved: (updated: Record<string, number>) => void
}) {
  const [values, setValues] = useState<Record<string, number>>({ ...entry.thresholds })
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(entry.thresholds_updated_at)
  const [error, setError] = useState<string | null>(null)

  const dirty = entry.threshold_schema.some((f) => values[f.key] !== entry.thresholds[f.key])

  const prevRuleId = useRef(entry.rule_id)
  useEffect(() => {
    if (prevRuleId.current !== entry.rule_id) {
      setValues({ ...entry.thresholds })
      setSavedAt(entry.thresholds_updated_at)
      setError(null)
      prevRuleId.current = entry.rule_id
    }
  }, [entry])

  function handleChange(key: string, raw: string, fieldType: 'float' | 'int') {
    const parsed = fieldType === 'int' ? parseInt(raw, 10) : parseFloat(raw)
    if (!isNaN(parsed)) setValues((v) => ({ ...v, [key]: parsed }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/rules/${entry.rule_id}/thresholds`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thresholds: values }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSavedAt(data.updated_at)
      onSaved(values)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    setResetting(true)
    setError(null)
    try {
      const res = await fetch(`/api/rules/${entry.rule_id}/thresholds/reset`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setValues({ ...data.thresholds })
      setSavedAt(null)
      onSaved(data.thresholds)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div>
      <div className="space-y-2">
        {entry.threshold_schema.map((field) => {
          const val = values[field.key] ?? entry.thresholds[field.key]
          const isModified = val !== entry.thresholds[field.key]
          return (
            <div
              key={field.key}
              className="flex items-center gap-3 px-3 py-2.5 bg-[var(--surface-1)] border rounded-[var(--radius-sm)] transition-colors"
              style={{ borderColor: isModified ? 'var(--accent-500)' : 'var(--border)' }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                style={{ background: isModified ? 'var(--accent-500)' : 'var(--border-strong)' }}
              />
              <span className="flex-1 text-[12px] text-[var(--fg-2)]">{field.label}</span>
              <div className="flex items-center gap-2 shrink-0">
                {field.unit && (
                  <span className="text-[11px] text-[var(--fg-4)]">{field.unit}</span>
                )}
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={val}
                  onChange={(e) => handleChange(field.key, e.target.value, field.type)}
                  className="w-20 h-7 px-2 text-right font-mono text-[12px] text-[var(--fg-1)] bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--accent-500)]"
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 mt-4">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="gap-1.5"
          style={{
            background: dirty ? 'var(--accent-500)' : undefined,
            color: dirty ? '#fff' : undefined,
          }}
        >
          <Save size={13} />
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleReset}
          disabled={resetting}
          className="gap-1.5"
        >
          <RotateCcw size={13} />
          {resetting ? 'Resetting…' : 'Reset to defaults'}
        </Button>
        <div className="flex-1" />
        {error && <span className="text-[11px] text-[var(--danger-500)]">{error}</span>}
        {!dirty && savedAt && (
          <span className="text-[11px] text-[var(--fg-4)]">Saved {fmtRelative(savedAt)}</span>
        )}
        {dirty && <span className="text-[11px] text-[var(--warn-500)]">Unsaved changes</span>}
      </div>

      {!dirty && savedAt && (
        <div className="mt-3 px-3 py-2.5 bg-[color-mix(in_srgb,var(--accent-500)_8%,transparent)] border border-[color-mix(in_srgb,var(--accent-500)_25%,transparent)] rounded-[var(--radius-sm)] text-[11px] text-[var(--fg-2)]">
          Changes apply on the next analyze run — re-analyze videos from the Uploads page.
        </div>
      )}
    </div>
  )
}

// ─── Rule detail (right panel) ────────────────────────────────────────────────

function RuleDetail({
  entry,
  loading,
  onThresholdsSaved,
}: {
  entry: CatalogEntry | null
  loading: boolean
  onThresholdsSaved: (ruleId: RuleId, thresholds: Record<string, number>) => void
}) {
  if (loading || !entry) {
    return (
      <div className="flex-1 overflow-auto p-7 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-48 mt-4" />
      </div>
    )
  }

  const meta = RULE_META[entry.rule_id]

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl p-7">
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
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
              Incident rule
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight text-[var(--fg-1)] leading-none">
                {meta.label}
              </h1>
              <SeverityBadge severity={entry.severity} />
            </div>
          </div>
        </div>

        <p className="text-[13px] text-[var(--fg-3)] leading-relaxed mb-6">{meta.desc}</p>

        <Separator className="mb-6 bg-[var(--border)]" />

        {/* Threshold configuration */}
        <div className="mb-6">
          <div className="mb-3">
            <div className="font-display text-[15px] font-semibold tracking-tight text-[var(--fg-1)]">
              Detection thresholds
            </div>
            <div className="text-[11px] text-[var(--fg-3)] mt-0.5">
              Adjust values and save — changes apply on the next analyze run
            </div>
          </div>
          <ThresholdEditor
            key={entry.rule_id}
            entry={entry}
            onSaved={(updated) => onThresholdsSaved(entry.rule_id, updated)}
          />
        </div>

        <Separator className="mb-6 bg-[var(--border)]" />

        {/* Trigger logic */}
        <div>
          <div className="font-display text-[15px] font-semibold tracking-tight text-[var(--fg-1)] mb-2">
            Trigger logic
          </div>
          <div className="px-3 py-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--radius-sm)] text-[12px] text-[var(--fg-2)] leading-relaxed">
            {meta.logic}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Left rule list ───────────────────────────────────────────────────────────

function RuleList({
  entries,
  selectedId,
  onSelect,
}: {
  entries: CatalogEntry[]
  selectedId: RuleId
  onSelect: (id: RuleId) => void
}) {
  return (
    <div className="flex flex-col h-full border-r border-[var(--border)] bg-[var(--surface-1)]">
      <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="text-xs font-semibold text-[var(--fg-1)]">Incident rules</div>
        <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
          {entries.length} types · click to configure
        </div>
      </div>
      <ScrollArea className="flex-1">
        {entries.map((entry) => {
          const meta = RULE_META[entry.rule_id]
          const isSel = entry.rule_id === selectedId
          const hasOverrides = !!entry.thresholds_updated_at
          return (
            <button
              key={entry.rule_id}
              onClick={() => onSelect(entry.rule_id)}
              className="w-full text-left border-b border-[var(--border)] transition-colors hover:bg-[var(--surface-2)]"
              style={{
                padding: isSel ? '14px 16px 14px 13px' : '14px 16px',
                background: isSel ? 'color-mix(in srgb, var(--accent-500) 8%, transparent)' : undefined,
                borderLeft: isSel ? '3px solid var(--accent-500)' : '3px solid transparent',
              }}
            >
              <div className="flex items-center gap-2.5 mb-1.5">
                <SeverityDot color={meta.color} />
                <span className="text-[13px] font-semibold text-[var(--fg-1)] flex-1 truncate">
                  {meta.label}
                </span>
              </div>
              <p className="text-[11px] text-[var(--fg-3)] leading-[1.4] line-clamp-2 mb-2">
                {meta.desc}
              </p>
              <div className="flex items-center gap-2">
                <SeverityBadge severity={entry.severity} />
                {hasOverrides && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border uppercase text-[var(--accent-400)] border-[color-mix(in_srgb,var(--accent-500)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent-500)_10%,transparent)]">
                    custom
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

  function handleThresholdsSaved(ruleId: RuleId, updated: Record<string, number>) {
    setCatalog((prev) =>
      prev.map((e) =>
        e.rule_id === ruleId
          ? { ...e, thresholds: updated, thresholds_updated_at: new Date().toISOString() }
          : e
      )
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--fg-4)] gap-2">
        <AlertTriangle size={16} />
        <span className="text-sm">Failed to load rules: {error}</span>
      </div>
    )
  }

  const selectedEntry = catalog.find((e) => e.rule_id === selectedId) ?? null

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="w-[320px] shrink-0 flex flex-col min-h-0">
        {loading ? (
          <div className="p-4 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <RuleList entries={catalog} selectedId={selectedId} onSelect={setSelectedId} />
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg)]">
        <RuleDetail
          entry={selectedEntry}
          loading={loading}
          onThresholdsSaved={handleThresholdsSaved}
        />
      </div>
    </div>
  )
}
