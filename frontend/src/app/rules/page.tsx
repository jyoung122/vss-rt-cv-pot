'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Car,
  Check,
  MapPin,
  Shield,
  Sparkles,
  Video,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type Schedule = '24/7' | 'Weekdays 6am–7pm' | 'Custom schedule'

// ─── Mock cameras ─────────────────────────────────────────────────────────────

const ALL_CAMERAS = [
  { id: 'CAM-101', label: 'Main St & 1st Ave · NB' },
  { id: 'CAM-102', label: 'Highway 40 @ Mile 12 · EB' },
  { id: 'CAM-103', label: 'Interchange Ramp · SB off' },
  { id: 'CAM-104', label: 'Bridge Crossing · WB' },
]

// ─── Interpretation chips ─────────────────────────────────────────────────────

function parsePromptChips(prompt: string) {
  const chips: { label: string; value: string; icon: React.ReactNode }[] = []
  const lower = prompt.toLowerCase()

  if (lower.includes('wrong') && lower.includes('way')) {
    chips.push({ label: 'Event type', value: 'Wrong-way vehicle', icon: <Car size={12} /> })
    chips.push({ label: 'Direction rule', value: 'Counter to lane flow', icon: <ArrowRight size={12} /> })
  } else if (lower.includes('stall') || lower.includes('stopp') || lower.includes('stationar')) {
    chips.push({ label: 'Event type', value: 'Stationary vehicle', icon: <Car size={12} /> })
    chips.push({ label: 'Duration', value: 'Sustained ≥ 60s', icon: <Zap size={12} /> })
  } else if (lower.includes('collisi') || lower.includes('crash') || lower.includes('accident')) {
    chips.push({ label: 'Event type', value: 'Vehicle collision', icon: <Car size={12} /> })
    chips.push({ label: 'Trigger', value: 'Velocity collapse + overlap', icon: <Zap size={12} /> })
  } else if (lower.includes('pedestrian') || lower.includes('person') || lower.includes('walker')) {
    chips.push({ label: 'Event type', value: 'Pedestrian proximity', icon: <Car size={12} /> })
    chips.push({ label: 'Trigger', value: 'Track proximity + stop', icon: <Zap size={12} /> })
  } else if (prompt.trim().length > 10) {
    chips.push({ label: 'Event type', value: 'Custom detection', icon: <Sparkles size={12} /> })
    chips.push({ label: 'Trigger', value: 'First frame match', icon: <Zap size={12} /> })
  }

  if (lower.includes('highway') || lower.includes('freeway') || lower.includes('route') || lower.includes('hwy')) {
    chips.push({ label: 'Location', value: 'Highway corridor', icon: <MapPin size={12} /> })
  } else if (lower.includes('intersection') || lower.includes('& ') || lower.includes(' @ ')) {
    chips.push({ label: 'Location', value: 'Intersection', icon: <MapPin size={12} /> })
  } else if (chips.length > 0) {
    chips.push({ label: 'Location', value: 'All cameras', icon: <MapPin size={12} /> })
  }

  return chips
}

// ─── Match preview card ────────────────────────────────────────────────────────

function MatchCard({ cam, time, conf }: { cam: string; time: string; conf: number }) {
  return (
    <div className="border border-[var(--border)] rounded-[var(--radius-sm)] overflow-hidden bg-[var(--surface-1)]">
      <div className="aspect-video bg-[var(--surface-3)] flex items-center justify-center relative">
        <div className="absolute inset-0 flex items-end">
          <div className="w-full h-1/2 bg-gradient-to-t from-black/50 to-transparent" />
        </div>
        <div
          className="absolute border-2 rounded-sm"
          style={{
            left: '52%', top: '55%', width: 72, height: 36,
            borderColor: 'var(--danger-500)',
            boxShadow: '0 0 10px color-mix(in srgb, var(--danger-500) 50%, transparent)',
          }}
        />
        <div
          className="absolute top-2 right-2 font-mono text-[10px] text-white px-1.5 py-0.5 rounded-[2px]"
          style={{ background: 'color-mix(in srgb, var(--danger-500) 90%, transparent)' }}
        >
          MATCH · {conf.toFixed(2)}
        </div>
        <div className="absolute bottom-0 left-0 right-0 px-2.5 py-2 text-[11px] text-white/80 font-mono">
          {cam}
        </div>
      </div>
      <div className="px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-[12px] font-medium text-[var(--fg-1)]">{cam}</div>
          <div className="text-[11px] text-[var(--fg-4)]">{time}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1">
          Review <ArrowRight size={10} />
        </Button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RuleBuilderPage() {
  const router = useRouter()

  const [prompt, setPrompt] = useState(
    'Alert me when any vehicle travels the wrong way on Highway 40 between Camera 101 and Camera 103'
  )
  const [selectedCams, setSelectedCams] = useState<string[]>(['CAM-101', 'CAM-102', 'CAM-103'])
  const [severity, setSeverity] = useState<Severity>('critical')
  const [schedule, setSchedule] = useState<Schedule>('24/7')
  const [autoDispatch, setAutoDispatch] = useState(true)
  const [notifyOps, setNotifyOps] = useState(true)
  const [updateDms, setUpdateDms] = useState(false)
  const [deployed, setDeployed] = useState(false)

  const chips = parsePromptChips(prompt)
  const isParsed = chips.length > 0

  function toggleCam(id: string) {
    setSelectedCams((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    )
  }

  function handleDeploy() {
    setDeployed(true)
    setTimeout(() => router.push('/incidents'), 1200)
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Action bar */}
      <div
        className="flex items-center gap-3 px-5 shrink-0 border-b border-[var(--border)]"
        style={{ height: 52, background: 'var(--surface-1)' }}
      >
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="text-[var(--fg-3)]">Detection rules</span>
          <span className="text-[var(--fg-4)]">›</span>
          <span className="font-medium text-[var(--fg-1)]">New rule</span>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="text-[12px]" onClick={() => router.push('/incidents')}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" className="text-[12px]">
          Save draft
        </Button>
        <Button
          size="sm"
          className="gap-1.5 text-[12px]"
          style={{ background: 'var(--accent-500)', color: '#fff', border: 'none' }}
          onClick={handleDeploy}
          disabled={deployed || !isParsed}
        >
          {deployed ? (
            <>
              <Check size={13} /> Deployed
            </>
          ) : (
            <>
              Deploy rule <ArrowRight size={13} />
            </>
          )}
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT — prompt + interpretation + preview */}
        <div className="flex-1 overflow-auto p-5">
          <div className="max-w-[680px]">
            <div
              className="text-[11px] font-semibold tracking-[0.14em] uppercase mb-1.5"
              style={{ color: 'var(--accent-400)' }}
            >
              Step 1 of 3
            </div>
            <h1 className="font-display text-[26px] font-semibold tracking-tight text-[var(--fg-1)] mb-1.5">
              Describe the event in plain English.
            </h1>
            <p className="text-[13px] text-[var(--fg-3)] leading-relaxed mb-7">
              The VLM parses your description, selects the right cameras, and previews matches
              against the last 24 hours before anything goes live.
            </p>

            {/* Prompt box */}
            <div className="mb-1.5">
              <label className="block text-[11px] font-semibold tracking-[0.04em] text-[var(--fg-2)] mb-2">
                Detection prompt
              </label>
              <div
                className="rounded-[var(--radius-md)]"
                style={{
                  border: `2px solid ${isParsed ? 'var(--accent-500)' : 'var(--border)'}`,
                  background: 'var(--surface-1)',
                  boxShadow: isParsed
                    ? '0 0 0 5px color-mix(in srgb, var(--accent-500) 10%, transparent)'
                    : 'none',
                  transition: 'box-shadow 0.2s, border-color 0.2s',
                }}
              >
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  className="w-full resize-none outline-none p-4 text-[15px] leading-relaxed bg-transparent text-[var(--fg-1)]"
                  style={{ fontFamily: 'var(--font-body)' }}
                  placeholder="Describe what you want to detect…"
                />
                <div
                  className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)]"
                >
                  <Sparkles size={11} style={{ color: 'var(--accent-400)' }} />
                  <span className="text-[11px]" style={{ color: isParsed ? 'var(--fg-3)' : 'var(--fg-4)' }}>
                    {isParsed
                      ? `Parsed successfully · ${selectedCams.length} cameras selected · 2 preview matches`
                      : 'Type a description to begin parsing'}
                  </span>
                </div>
              </div>
            </div>

            {/* Interpretation chips */}
            {chips.length > 0 && (
              <div className="mb-8">
                <div className="text-[12px] font-semibold text-[var(--fg-2)] mb-2.5">
                  Here's how AIMS interpreted your rule:
                </div>
                <div className="flex flex-wrap gap-2">
                  {chips.map((c) => (
                    <div
                      key={c.label}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)]"
                      style={{
                        background: 'color-mix(in srgb, var(--accent-500) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--accent-500) 25%, transparent)',
                      }}
                    >
                      <span style={{ color: 'var(--accent-400)' }}>{c.icon}</span>
                      <div>
                        <div className="text-[10px] tracking-[0.08em] uppercase text-[var(--fg-4)]">{c.label}</div>
                        <div className="text-[12px] font-medium text-[var(--fg-1)]">{c.value}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Preview matches */}
            {isParsed && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-display text-[17px] font-semibold text-[var(--fg-1)]">
                      Preview matches
                    </div>
                    <div className="text-[12px] text-[var(--fg-4)] mt-0.5">
                      Run against archived footage from the last 24 hours
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1.5 text-[11px] h-7">
                    <Sparkles size={11} /> Re-run preview
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MatchCard cam="CAM-102 · Highway 40 @ Mile 12" time="Yesterday, 02:41 local" conf={0.94} />
                  <MatchCard cam="CAM-101 · Main St & 1st Ave" time="Yesterday, 18:08 local" conf={0.87} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — config panel */}
        <div
          className="w-[360px] shrink-0 overflow-auto flex flex-col gap-6 p-6"
          style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface-1)' }}
        >
          {/* Cameras */}
          <div>
            <div className="text-[12px] font-semibold text-[var(--fg-2)] mb-2.5">
              Cameras ({selectedCams.length})
            </div>
            <div className="space-y-0.5">
              {ALL_CAMERAS.map((c) => {
                const checked = selectedCams.includes(c.id)
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--radius-sm)] cursor-pointer text-[13px] transition-colors"
                    style={{
                      background: checked
                        ? 'color-mix(in srgb, var(--accent-500) 8%, transparent)'
                        : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCam(c.id)}
                      style={{ accentColor: 'var(--accent-500)' }}
                    />
                    <Video size={13} style={{ color: 'var(--fg-4)' }} />
                    <span className="text-[var(--fg-1)]">{c.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Severity */}
          <div>
            <div className="text-[12px] font-semibold text-[var(--fg-2)] mb-2.5">Severity</div>
            <div className="flex gap-1.5">
              {(['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className="flex-1 h-8 text-[11px] font-medium capitalize rounded-[var(--radius-sm)] border transition-colors"
                  style={{
                    border: `1px solid ${severity === s ? 'var(--accent-500)' : 'var(--border)'}`,
                    background: severity === s
                      ? 'color-mix(in srgb, var(--accent-500) 14%, transparent)'
                      : 'var(--surface-2)',
                    color: severity === s ? 'var(--accent-400)' : 'var(--fg-3)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* When to run */}
          <div>
            <div className="text-[12px] font-semibold text-[var(--fg-2)] mb-2.5">When to run</div>
            <div className="space-y-1.5">
              {(['24/7', 'Weekdays 6am–7pm', 'Custom schedule'] as Schedule[]).map((s) => (
                <label
                  key={s}
                  className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-[var(--radius-sm)] border cursor-pointer text-[13px] transition-colors"
                  style={{
                    border: `1px solid ${schedule === s ? 'var(--accent-500)' : 'var(--border)'}`,
                    background: schedule === s
                      ? 'color-mix(in srgb, var(--accent-500) 8%, transparent)'
                      : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    checked={schedule === s}
                    onChange={() => setSchedule(s)}
                    style={{ accentColor: 'var(--accent-500)' }}
                  />
                  <span className="text-[var(--fg-1)]">{s}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Routing */}
          <div>
            <div className="text-[12px] font-semibold text-[var(--fg-2)] mb-2.5">Routing</div>
            <div className="space-y-2.5">
              <label className="flex items-start gap-3 p-3 border border-[var(--border)] rounded-[var(--radius-sm)] bg-[var(--surface-2)] cursor-pointer">
                <Switch
                  checked={autoDispatch}
                  onCheckedChange={setAutoDispatch}
                  className="mt-0.5 shrink-0"
                />
                <div>
                  <div className="text-[13px] font-medium text-[var(--fg-1)]">Auto-escalate to CAD</div>
                  <div className="text-[11px] text-[var(--fg-4)] mt-0.5">Send directly to 911 dispatch on match</div>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 border border-[var(--border)] rounded-[var(--radius-sm)] bg-[var(--surface-2)] cursor-pointer">
                <Switch
                  checked={notifyOps}
                  onCheckedChange={setNotifyOps}
                  className="mt-0.5 shrink-0"
                />
                <div>
                  <div className="text-[13px] font-medium text-[var(--fg-1)]">Notify traffic ops</div>
                  <div className="text-[11px] text-[var(--fg-4)] mt-0.5">In-app alert + email on match</div>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 border border-[var(--border)] rounded-[var(--radius-sm)] bg-[var(--surface-2)] cursor-pointer">
                <Switch
                  checked={updateDms}
                  onCheckedChange={setUpdateDms}
                  className="mt-0.5 shrink-0"
                />
                <div>
                  <div className="text-[13px] font-medium text-[var(--fg-1)]">Update upstream DMS</div>
                  <div className="text-[11px] text-[var(--fg-4)] mt-0.5">Push warning message to dynamic signs</div>
                </div>
              </label>
            </div>
          </div>

          {/* Compliance notice */}
          <div
            className="p-3 rounded-[var(--radius-sm)] text-[12px] leading-relaxed"
            style={{
              background: 'color-mix(in srgb, var(--ok-500) 8%, var(--surface-1))',
              border: '1px solid color-mix(in srgb, var(--ok-500) 25%, transparent)',
            }}
          >
            <div className="flex items-center gap-2 font-medium text-[var(--fg-1)] mb-1.5">
              <Shield size={13} style={{ color: 'var(--ok-500)' }} />
              Rule complies with policy
            </div>
            <span className="text-[var(--fg-3)]">
              Vehicle / infrastructure detection only. No face, biometric, or person tracking.
              Auditable under records retention schedule.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
