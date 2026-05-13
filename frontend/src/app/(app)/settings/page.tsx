'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDevSettings } from '@/lib/use-dev-settings'
import { apiFetch } from '@/lib/api-fetch'

type Category = 'development'

const NAV: { id: Category; label: string }[] = [
  { id: 'development', label: 'Development' },
]

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-none">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

interface VlmProviderState {
  active: string
  env_default: string
  available: string[]
  overridden: boolean
}

function VlmProviderControl() {
  const [state, setState] = useState<VlmProviderState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/dev/vlm-provider', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function pick(provider: string) {
    if (state?.active === provider) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/dev/vlm-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setPending(false)
    }
  }

  async function reset() {
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/dev/vlm-provider', { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingRow
      label="VLM provider"
      description={
        state
          ? `Active: ${state.active}${state.overridden ? ' (runtime override)' : ' (from VLM_PROVIDER env)'}. Env default: ${state.env_default}.`
          : error
          ? `Failed to load: ${error}`
          : 'Loading…'
      }
    >
      <div className="flex items-center gap-2">
        {state?.available.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={state.active === p ? 'default' : 'outline'}
            disabled={pending}
            onClick={() => void pick(p)}
            className="h-7 px-3 text-xs"
          >
            {p}
          </Button>
        ))}
        {state?.overridden && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void reset()}
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            Reset
          </Button>
        )}
      </div>
    </SettingRow>
  )
}

function LiveModeControl() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch('/api/live/mode')
      .then(r => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(d => setEnabled(d.enabled))
      .catch(e => setError(String(e)))
  }, [])

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/live/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { enabled: boolean }
      setEnabled(d.enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      label="Live demo mode"
      description="Master kill switch for the mock-camera RTSP pipeline. Turning OFF tears down any attached cameras (frees GPU). Turning ON does not auto-re-attach — choose cameras individually in /live."
    >
      {enabled === null ? (
        <span className="text-xs text-muted-foreground">{error ?? 'loading…'}</span>
      ) : (
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={toggle}
        />
      )}
    </SettingRow>
  )
}

function DevelopmentSettings() {
  const { settings, update } = useDevSettings()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">Development</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tooling and debug options. These settings only apply in development mode.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Live demo
            <Badge variant="secondary" className="text-xs font-normal">operator</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-0">
          <LiveModeControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            VLM provider
            <Badge variant="secondary" className="text-xs font-normal">runtime override</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-0">
          <VlmProviderControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Debug flags
            <Badge variant="secondary" className="text-xs font-normal">dev only</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-0">
          <SettingRow
            label="Mock data"
            description="Substitute fixture data for live API responses."
          >
            <Switch
              checked={settings.mockData}
              onCheckedChange={(v) => update('mockData', v)}
            />
          </SettingRow>
          <Separator />
          <SettingRow
            label="Verbose logging"
            description="Emit detailed logs to the browser console."
          >
            <Switch
              checked={settings.verboseLogs}
              onCheckedChange={(v) => update('verboseLogs', v)}
            />
          </SettingRow>
          <Separator />
          <SettingRow
            label="Show query times"
            description="Overlay database query durations on list views."
          >
            <Switch
              checked={settings.showQueryTimes}
              onCheckedChange={(v) => update('showQueryTimes', v)}
            />
          </SettingRow>
          <Separator />
          <SettingRow
            label="Hide Events tab"
            description="Hidden by default — toggle off to expose raw track detections on the video detail page."
          >
            <Switch
              checked={settings.hideEventsTab}
              onCheckedChange={(v) => update('hideEventsTab', v)}
            />
          </SettingRow>
        </CardContent>
      </Card>
    </div>
  )
}

export default function SettingsPage() {
  const [active, setActive] = useState<Category>('development')

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar nav */}
      <aside className="w-48 shrink-0 border-r px-3 py-5">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        <nav className="space-y-0.5">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                active === id
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Content pane */}
      <main className="flex-1 overflow-y-auto px-8 py-6 max-w-2xl">
        {active === 'development' && <DevelopmentSettings />}
      </main>
    </div>
  )
}
