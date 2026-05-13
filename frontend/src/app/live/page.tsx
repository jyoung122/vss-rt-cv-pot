"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Power, AlertTriangle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { HlsPlayer } from "@/components/hls-player"
import { apiFetch } from "@/lib/api-fetch"

interface Monitor {
  id: string
  name: string
  source_url: string
  hls_path: string
  enabled: boolean
  last_enabled_at: string | null
  last_disabled_at: string | null
}

interface MonitorStats {
  events: number
  tracks: number
}

export default function LivePage() {
  const [liveMode, setLiveMode] = useState<boolean | null>(null)
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [stats, setStats] = useState<Record<string, MonitorStats>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [modeRes, monRes] = await Promise.all([
        apiFetch("/api/live/mode"),
        apiFetch("/api/monitors"),
      ])
      if (modeRes.ok) {
        const m = (await modeRes.json()) as { enabled: boolean }
        setLiveMode(m.enabled)
      }
      if (monRes.ok) {
        const list = (await monRes.json()) as Monitor[]
        setMonitors(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Poll per-monitor stats every 2s for the count badges
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const next: Record<string, MonitorStats> = {}
      for (const m of monitors) {
        try {
          const r = await apiFetch(`/api/monitors/${m.id}/stats`)
          if (r.ok) next[m.id] = (await r.json()) as MonitorStats
        } catch { /* ignore transient */ }
      }
      if (alive) setStats(next)
    }
    if (monitors.length > 0) {
      tick()
      const id = setInterval(tick, 2000)
      return () => { alive = false; clearInterval(id) }
    }
    return () => { alive = false }
  }, [monitors])

  const toggle = async (m: Monitor) => {
    if (!liveMode && !m.enabled) {
      setError("Live demo mode is disabled — turn it on in /settings first")
      return
    }
    setBusy(b => ({ ...b, [m.id]: true }))
    setError(null)
    try {
      const action = m.enabled ? "disable" : "enable"
      const res = await apiFetch(`/api/monitors/${m.id}/${action}`, { method: "POST" })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed")
    } finally {
      setBusy(b => ({ ...b, [m.id]: false }))
    }
  }

  const hlsUrl = (path: string) => {
    // mediamtx HLS lives on the same host at :8888 (exposed in compose).
    // Browser-side absolute URL — Next.js doesn't proxy this.
    if (typeof window === "undefined") return ""
    return `${window.location.protocol}//${window.location.hostname}:8888/${path}/index.m3u8`
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--fg-1)]">Live Ops</h1>
          <p className="text-sm text-[var(--fg-3)]">
            Mock RTSP cameras for the demo. Toggle to attach/detach from the GPU pipeline.
          </p>
        </div>
        {liveMode === false && (
          <Badge variant="outline" className="border-[var(--err-500)] text-[var(--err-500)]">
            Live mode disabled in /settings
          </Badge>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--err-500)]/40 bg-[var(--err-500)]/10 px-3 py-2 text-sm text-[var(--err-500)]">
          <AlertTriangle className="size-4" />
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {monitors.map(m => (
          <Card key={m.id} className="overflow-hidden border-[var(--border)] bg-[var(--surface-2)]">
            <div className="relative aspect-video bg-black">
              <HlsPlayer
                src={hlsUrl(m.hls_path)}
                className="size-full object-cover"
              />
              {!m.enabled && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white/80">
                  Detection off — preview only
                </div>
              )}
            </div>
            <div className="flex items-center justify-between p-3">
              <div>
                <div className="text-sm font-medium text-[var(--fg-1)]">{m.name}</div>
                <div className="text-[11px] text-[var(--fg-3)] font-mono">{m.id}</div>
              </div>
              <div className="flex items-center gap-2">
                {busy[m.id] ? (
                  <Loader2 className="size-4 animate-spin text-[var(--fg-3)]" />
                ) : (
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={() => toggle(m)}
                    disabled={!liveMode && !m.enabled}
                  />
                )}
              </div>
            </div>
            {m.enabled && stats[m.id] && (
              <div className="flex items-center gap-3 border-t border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[11px] text-[var(--fg-2)]">
                <span><span className="font-mono text-[var(--accent-500)]">{stats[m.id].events.toLocaleString()}</span> events</span>
                <span><span className="font-mono text-[var(--accent-500)]">{stats[m.id].tracks}</span> tracks</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[var(--ok-500)]">
                  <Power className="size-3" /> live
                </span>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
