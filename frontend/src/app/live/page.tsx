'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Filter, LayoutGrid, List, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { type Scene, CameraScene } from '@/components/camera-scenes'

// ─── Camera mock data ─────────────────────────────────────────────────────────

type AlertLevel = 'critical' | 'high' | 'medium' | null

interface Camera { id: string; scene: Scene; label: string; alert: AlertLevel }

const CAMERAS: Camera[] = [
  { id: 'CAM-117', scene: 'wrongway',     label: 'Loop 101 @ Bell Rd · SB', alert: 'critical' },
  { id: 'CAM-043', scene: 'highway',      label: 'Loop 101 @ Union Hills',  alert: null },
  { id: 'CAM-208', scene: 'stalled',      label: '83rd Ave @ Thunderbird',  alert: 'high' },
  { id: 'CAM-012', scene: 'intersection', label: 'Grand Ave @ 75th',        alert: 'high' },
  { id: 'CAM-156', scene: 'roundabout',   label: '99th Ave @ Happy Valley', alert: null },
  { id: 'CAM-091', scene: 'flood',        label: 'New River Rd',            alert: 'medium' },
]

// ─── Incident feed types + mock data ─────────────────────────────────────────

type VlmStatus = 'pending' | 'done' | 'skipped' | 'error'
type VlmVerdict = 'confirmed' | 'rejected' | null

interface FeedIncident {
  id: string
  video_id: string
  original_filename: string
  rule_id: string
  severity: 'high' | 'medium' | 'low'
  confidence: number
  t_start_s: number
  t_end_s: number
  vlm_status: VlmStatus
  vlm_verdict: VlmVerdict
  vlm_confidence: number | null
  created_at: string
}

function minsAgo(m: number) {
  return new Date(Date.now() - m * 60_000).toISOString()
}

const MOCK_INCIDENTS: FeedIncident[] = [
  { id: 'a1b2c3d4-0001', video_id: 'v-001', original_filename: 'Loop101_BellRd_SB.mp4',     rule_id: 'vehicle_collision',  severity: 'high',   confidence: 0.97, t_start_s: 14,  t_end_s: 22,  vlm_status: 'done',    vlm_verdict: 'confirmed', vlm_confidence: 0.95, created_at: minsAgo(3) },
  { id: 'a1b2c3d4-0002', video_id: 'v-002', original_filename: 'GrandAve_75th.mp4',          rule_id: 'ped_impact',         severity: 'high',   confidence: 0.91, t_start_s: 7,   t_end_s: 12,  vlm_status: 'pending', vlm_verdict: null,        vlm_confidence: null, created_at: minsAgo(8) },
  { id: 'a1b2c3d4-0003', video_id: 'v-003', original_filename: '83rdAve_Thunderbird.mp4',    rule_id: 'stationary_vehicle', severity: 'medium', confidence: 0.88, t_start_s: 34,  t_end_s: 90,  vlm_status: 'done',    vlm_verdict: 'confirmed', vlm_confidence: 0.86, created_at: minsAgo(15) },
  { id: 'a1b2c3d4-0004', video_id: 'v-004', original_filename: 'NewRiverRd_flood.mp4',       rule_id: 'mass_stop',          severity: 'medium', confidence: 0.82, t_start_s: 5,   t_end_s: 18,  vlm_status: 'done',    vlm_verdict: 'rejected',  vlm_confidence: 0.71, created_at: minsAgo(22) },
  { id: 'a1b2c3d4-0005', video_id: 'v-005', original_filename: 'Loop101_UnionHills.mp4',     rule_id: 'stationary_vehicle', severity: 'low',    confidence: 0.74, t_start_s: 61,  t_end_s: 75,  vlm_status: 'done',    vlm_verdict: 'confirmed', vlm_confidence: 0.70, created_at: minsAgo(34) },
  { id: 'a1b2c3d4-0006', video_id: 'v-006', original_filename: '99thAve_HappyValley.mp4',    rule_id: 'vehicle_collision',  severity: 'high',   confidence: 0.95, t_start_s: 2,   t_end_s: 9,   vlm_status: 'pending', vlm_verdict: null,        vlm_confidence: null, created_at: minsAgo(41) },
  { id: 'a1b2c3d4-0007', video_id: 'v-007', original_filename: 'Loop101_BellRd_NB.mp4',      rule_id: 'ped_impact',         severity: 'medium', confidence: 0.79, t_start_s: 19,  t_end_s: 27,  vlm_status: 'done',    vlm_verdict: 'confirmed', vlm_confidence: 0.81, created_at: minsAgo(58) },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RULE_LABELS: Record<string, string> = {
  vehicle_collision: 'Vehicle Collision',
  ped_impact: 'Pedestrian Impact',
  stationary_vehicle: 'Stationary Vehicle',
  mass_stop: 'Mass Stop',
}

const SEV_COLOR: Record<string, string> = {
  high: 'var(--warn-500)',
  medium: 'var(--warn-500)',
  low: 'var(--fg-4)',
}

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diffMs / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function incidentStatus(inc: FeedIncident): string {
  if (inc.vlm_status === 'pending') return 'pending'
  if (inc.vlm_status === 'done' && inc.vlm_verdict === 'confirmed') return 'confirmed'
  if (inc.vlm_status === 'done' && inc.vlm_verdict === 'rejected') return 'rejected'
  return 'skipped'
}

function statusColor(status: string): string {
  if (status === 'confirmed') return 'var(--ok-500)'
  if (status === 'pending') return 'var(--warn-500)'
  return 'var(--fg-4)'
}

// ─── Live dot ─────────────────────────────────────────────────────────────────

function LiveDot({ color = 'var(--danger-500)', label = 'LIVE' }: { color?: string; label?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
      fontFamily: 'var(--font-mono)', color }}>
      <span className="animate-pulse" style={{
        width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block',
        boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)`,
      }} />
      {label}
    </span>
  )
}

// ─── Camera tile ──────────────────────────────────────────────────────────────

function CameraTile({ cam, t, wide }: { cam: Camera; t: number; wide: boolean }) {
  const alertColor =
    cam.alert === 'critical' ? 'var(--danger-500)' :
    cam.alert === 'high'     ? 'var(--warn-500)' :
    cam.alert === 'medium'   ? 'var(--warn-500)' : null

  const now = new Date()
  const tickTime = new Date(now.getTime() + t * 1000)
  const timeStr = tickTime.toTimeString().slice(0, 8)

  return (
    <div style={{
      position: 'relative',
      aspectRatio: wide ? '32/9' : '16/9',
      background: '#000',
      border: alertColor ? `1px solid ${alertColor}` : '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
    }}>
      <CameraScene scene={cam.scene} t={t} />
      {/* vignette */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%)' }} />
      {/* top chips */}
      <div style={{ position: 'absolute', top: 8, left: 8, right: 8,
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <LiveDot color={alertColor ?? '#4a9'} label={alertColor ? 'ALERT' : 'LIVE'} />
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#fff',
          background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: 2, letterSpacing: '0.05em' }}>
          {timeStr}
        </div>
      </div>
      {/* alert banner */}
      {cam.alert === 'critical' && (
        <div style={{ position: 'absolute', left: 8, top: 32,
          background: 'rgba(217,75,61,0.92)', color: '#fff',
          padding: '5px 10px', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}>
          WRONG-WAY DETECTED · 98% CONF
        </div>
      )}
      {cam.alert === 'high' && cam.id === 'CAM-208' && (
        <div style={{ position: 'absolute', left: 8, top: 32,
          background: 'rgba(224,146,34,0.92)', color: '#14202a',
          padding: '5px 10px', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}>
          STALLED VEHICLE · 94% CONF
        </div>
      )}
      {/* bottom label */}
      <div style={{ position: 'absolute', left: 10, bottom: 10,
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em',
        background: 'rgba(0,0,0,0.55)', padding: '4px 8px', borderRadius: 2,
        backdropFilter: 'blur(4px)', color: '#fff' }}>
        {cam.id} · {cam.label}
      </div>
    </div>
  )
}

function CameraWall({ t, viewMode }: { t: number; viewMode: 'grid' | 'list' }) {
  return (
    <div style={{ padding: 16, background: 'var(--bg)', flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: viewMode === 'grid' ? 'repeat(3, 1fr)' : '1fr',
        gap: 10,
      }}>
        {CAMERAS.map((cam, idx) => (
          <CameraTile key={cam.id} cam={cam} t={t + idx * 0.2} wide={viewMode === 'list'} />
        ))}
      </div>
    </div>
  )
}

// ─── Map strip ────────────────────────────────────────────────────────────────

const EVENT_PINS = [
  { x: 325, y: 55, sev: 'critical' },
  { x: 160, y: 92, sev: 'high' },
  { x: 485, y: 55, sev: 'medium' },
  { x: 645, y: 60, sev: 'high' },
  { x: 240, y: 55, sev: 'low' },
  { x: 580, y: 92, sev: 'medium' },
]

const PIN_COLOR: Record<string, string> = {
  critical: 'var(--danger-500)',
  high: 'var(--warn-500)',
  medium: 'var(--warn-500)',
  low: 'var(--fg-4)',
}

function MapStrip() {
  return (
    <div style={{ height: 160, flexShrink: 0, borderTop: '1px solid var(--border)',
      background: 'var(--surface-1)', padding: '10px 16px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)',
          display: 'flex', alignItems: 'center', gap: 6 }}>
          <MapPin size={13} /> Event density · last 4 hours
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>Peoria + Glendale jurisdictions</div>
      </div>
      <div style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', position: 'relative', overflow: 'hidden' }}>
        <svg viewBox="0 0 800 120" preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', position: 'absolute' }}>
          <path d="M0,60 L800,55" stroke="var(--border-strong)" strokeWidth="2" fill="none" />
          <path d="M0,90 L800,92" stroke="var(--border-strong)" strokeWidth="1.5" fill="none" />
          {[160, 320, 480, 640].map((x) => (
            <path key={x} d={`M${x},0 L${x+5},120`} stroke="var(--border-strong)" strokeWidth="1.5" fill="none" />
          ))}
          {EVENT_PINS.map((p, i) => (
            <g key={i} transform={`translate(${p.x} ${p.y})`}>
              <circle r="14" fill={PIN_COLOR[p.sev]} opacity="0.18" />
              <circle r="5"  fill={PIN_COLOR[p.sev]} />
            </g>
          ))}
        </svg>
        <div style={{ position: 'absolute', bottom: 8, right: 8,
          background: 'var(--surface-1)', border: '1px solid var(--border)',
          padding: '4px 8px', fontSize: 10, color: 'var(--fg-3)', borderRadius: 2 }}>
          Peoria, AZ · 85345
        </div>
      </div>
    </div>
  )
}

// ─── Event feed ───────────────────────────────────────────────────────────────

function EventFeedPanel({ incidents, loading, selectedId, onSelect }: {
  incidents: FeedIncident[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div style={{ background: 'var(--surface-1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>Event feed</div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>Real-time · auto-updating</div>
        </div>
        <LiveDot color="var(--accent-400)" label="LIVE" />
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : incidents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-4">
            <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>No incidents yet</div>
            <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>Upload and analyze a video to see events here.</div>
          </div>
        ) : (
          incidents.map((inc) => {
            const isSelected = selectedId === inc.id
            const color = SEV_COLOR[inc.severity] ?? 'var(--fg-4)'
            const status = incidentStatus(inc)
            return (
              <div key={inc.id} onClick={() => onSelect(inc.id)} style={{
                padding: '14px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                background: isSelected ? 'color-mix(in srgb, var(--accent-500) 10%, transparent)' : 'transparent',
                borderLeft: isSelected ? '3px solid var(--accent-500)' : '3px solid transparent',
                paddingLeft: isSelected ? 13 : 16,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-4)',
                    letterSpacing: '0.04em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inc.id.slice(0, 8)}…
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-4)', flexShrink: 0 }}>
                    {fmtRelative(inc.created_at)}
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                  {RULE_LABELS[inc.rule_id] ?? inc.rule_id}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                  <MapPin size={11} style={{ flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inc.original_filename}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 3,
                    textTransform: 'uppercase', letterSpacing: '0.06em', border: '1px solid',
                    color, background: `color-mix(in srgb, ${color} 14%, transparent)`,
                    borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
                  }}>{inc.severity}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 500, padding: '2px 7px', borderRadius: 3,
                    textTransform: 'uppercase', letterSpacing: '0.06em', border: '1px solid',
                    color: statusColor(status),
                    background: `color-mix(in srgb, ${statusColor(status)} 10%, transparent)`,
                    borderColor: `color-mix(in srgb, ${statusColor(status)} 25%, transparent)`,
                  }}>{status}</span>
                  {isSelected && (
                    <Link href={`/events/${inc.id}`}
                      className="ml-auto text-[11px]"
                      style={{ color: 'var(--accent-400)', textDecoration: 'none' }}
                      onClick={(e) => e.stopPropagation()}>
                      View →
                    </Link>
                  )}
                </div>
              </div>
            )
          })
        )}
      </ScrollArea>
    </div>
  )
}

// ─── Sub-header ───────────────────────────────────────────────────────────────

function SubHeader({ viewMode, setViewMode, incidents }: {
  viewMode: 'grid' | 'list'
  setViewMode: (v: 'grid' | 'list') => void
  incidents: FeedIncident[]
}) {
  const highCount = incidents.filter((i) => i.severity === 'high').length
  const pendingCount = incidents.filter((i) => i.vlm_status === 'pending').length

  return (
    <div style={{ height: 52, flexShrink: 0, borderBottom: '1px solid var(--border)',
      background: 'var(--surface-1)', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600,
          letterSpacing: '-0.01em', color: 'var(--fg-1)' }}>Live operations</div>
        <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>
          Traffic &amp; infrastructure · {CAMERAS.length} cameras shown
        </div>
      </div>
      <div style={{ flex: 1 }} />
      {highCount > 0 && (
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 3,
          textTransform: 'uppercase', letterSpacing: '0.06em', border: '1px solid',
          color: 'var(--warn-300)',
          background: 'color-mix(in srgb, var(--warn-500) 14%, transparent)',
          borderColor: 'color-mix(in srgb, var(--warn-500) 30%, transparent)',
        }}>{highCount} high</span>
      )}
      {pendingCount > 0 && (
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 3,
          textTransform: 'uppercase', letterSpacing: '0.06em', border: '1px solid',
          color: 'var(--fg-3)', background: 'var(--surface-3)', borderColor: 'var(--border)',
        }}>{pendingCount} open</span>
      )}
      <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
      <Button variant="ghost" size="sm" className="gap-1.5 h-7 px-2.5 text-[11px]">
        <Filter size={11} /> Filter
      </Button>
      <div style={{ display: 'flex', background: 'var(--surface-2)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 2 }}>
        {(['grid', 'list'] as const).map((m) => (
          <Button key={m} variant="ghost" size="sm"
            onClick={() => setViewMode(m)}
            className={`h-[26px] w-[30px] p-0 rounded-[3px] ${
              viewMode === m ? 'bg-[var(--surface-3)] text-[var(--fg-1)]' : 'text-[var(--fg-4)]'
            }`}>
            {m === 'grid' ? <LayoutGrid size={13} /> : <List size={13} />}
          </Button>
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LiveOpsPage() {
  const [t, setT] = useState(0)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [incidents, setIncidents] = useState<FeedIncident[]>([])
  const [loading, setLoading] = useState(true)

  // Animation ticker — 10 fps is enough for smooth car movement
  useEffect(() => {
    const id = setInterval(() => setT((prev) => prev + 0.1), 100)
    return () => clearInterval(id)
  }, [])

  // Load live incident feed, auto-refresh every 30s
  useEffect(() => {
    function load() {
      fetch('/api/incidents/feed?limit=20')
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((d: { incidents: FeedIncident[] }) => {
          const list = d.incidents.length > 0 ? d.incidents : MOCK_INCIDENTS
          setIncidents(list)
          setSelectedId((prev) => prev ?? list[0]?.id ?? null)
          setLoading(false)
        })
        .catch(() => {
          setIncidents(MOCK_INCIDENTS)
          setSelectedId((prev) => prev ?? MOCK_INCIDENTS[0]?.id ?? null)
          setLoading(false)
        })
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <SubHeader viewMode={viewMode} setViewMode={setViewMode} incidents={incidents} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', flex: 1, minHeight: 0 }}>
        {/* Left: camera wall + map strip */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid var(--border)' }}>
          <CameraWall t={t} viewMode={viewMode} />
          <MapStrip />
        </div>
        {/* Right: event feed */}
        <EventFeedPanel
          incidents={incidents}
          loading={loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  )
}
