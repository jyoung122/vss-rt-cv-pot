"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { apiFetch } from "@/lib/api-fetch"

export default function SettingsPage() {
  const [liveMode, setLiveMode] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch("/api/live/mode")
      .then(r => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(d => setLiveMode(d.enabled))
      .catch(e => setError(String(e)))
  }, [])

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch("/api/live/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { enabled: boolean }
      setLiveMode(d.enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--fg-1)]">Settings</h1>
        <p className="text-sm text-[var(--fg-3)]">Demo operator controls.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--err-500)]/40 bg-[var(--err-500)]/10 px-3 py-2 text-sm text-[var(--err-500)]">
          <AlertTriangle className="size-4" /> {error}
        </div>
      )}

      <Card className="max-w-xl border-[var(--border)] bg-[var(--surface-2)]">
        <CardHeader>
          <CardTitle className="text-[var(--fg-1)]">Live demo mode</CardTitle>
        </CardHeader>
        <CardContent className="flex items-start justify-between gap-6">
          <div className="text-sm text-[var(--fg-3)]">
            Master kill switch for the mock-camera RTSP pipeline. When off, all
            monitor toggles in <span className="font-mono">/live</span> are disabled,
            and any currently-attached cameras get torn down (frees the GPU).
            Turning back on does <em>not</em> auto-re-enable cameras — choose
            which to attach individually.
          </div>
          {liveMode === null ? (
            <Loader2 className="size-5 animate-spin text-[var(--fg-3)]" />
          ) : (
            <Switch
              checked={liveMode}
              onCheckedChange={toggle}
              disabled={busy}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
