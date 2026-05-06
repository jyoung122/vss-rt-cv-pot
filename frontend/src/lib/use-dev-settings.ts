'use client'

import { useCallback, useEffect, useState } from 'react'

export interface DevSettings {
  hideEventsTab: boolean
  mockData: boolean
  verboseLogs: boolean
  showQueryTimes: boolean
}

const DEFAULTS: DevSettings = {
  hideEventsTab: true,
  mockData: false,
  verboseLogs: false,
  showQueryTimes: false,
}

const KEY = 'aims:dev-settings'

function load(): DevSettings {
  if (typeof window === 'undefined') return DEFAULTS
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

function save(s: DevSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // quota exceeded or private browsing — silently ignore
  }
}

export function useDevSettings() {
  const [settings, setSettings] = useState<DevSettings>(DEFAULTS)

  useEffect(() => {
    setSettings(load())
  }, [])

  const update = useCallback(<K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      save(next)
      return next
    })
  }, [])

  return { settings, update }
}
