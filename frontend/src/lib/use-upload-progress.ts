/**
 * useUploadProgress — 5-stage upload state machine.
 *
 * Stages: idle → upload → ingest → rules → vlm → done | error
 *
 * Polling: recursive setTimeout (not setInterval) so a slow fetch never
 * queues a backlog of concurrent requests. AbortController cancels
 * in-flight fetches on unmount or videoId change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type UploadStage = 'idle' | 'upload' | 'ingest' | 'rules' | 'vlm' | 'done' | 'error'

export interface UploadProgressState {
  stage: UploadStage
  percent: number       // XHR upload progress (0-100); 0 outside upload stage
  sub: string | null    // e.g. "12 480 events", "12 / 57 validated", "running…"
  error: string | null  // surfaced from /analyze or polling failures
}

export interface UploadProgressActions {
  /** Call when XHR upload starts. */
  startUpload: () => void
  /** Call on XHR progress events. */
  setUploadPercent: (pct: number) => void
  /** Call when upload HTTP 200 arrives with the returned video_id. */
  uploadDone: (videoId: string, durationS: number | null) => void
  /** Call on XHR upload error. */
  uploadError: (msg: string) => void
  /** Reset to idle (e.g. after done+refresh). */
  reset: () => void
}

export function useUploadProgress(): UploadProgressState & UploadProgressActions {
  const [stage, setStage] = useState<UploadStage>('idle')
  const [percent, setPercent] = useState(0)
  const [sub, setSub] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Internal refs so polling callbacks can read current state without stale closures
  const videoIdRef = useRef<string | null>(null)
  const durationRef = useRef<number | null>(null)
  const stageRef = useRef<UploadStage>('idle')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Plateau detection state
  const plateauRef = useRef({ lastCount: -1, streak: 0, startedAt: 0 })

  const setStageAndRef = useCallback((s: UploadStage) => {
    stageRef.current = s
    setStage(s)
  }, [])

  const clearTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [])

  // ── Analyze trigger ───────────────────────────────────────────────────────
  const triggerAnalyze = useCallback(async (videoId: string) => {
    setStageAndRef('rules')
    setSub('running…')
    try {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const res = await fetch(`/api/uploads/${videoId}/analyze`, {
        method: 'POST',
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`Analyze failed: HTTP ${res.status}`)
      const data = (await res.json()) as { incidents_found: number }

      if (data.incidents_found === 0) {
        // No incidents → skip VLM, go straight to done
        setSub(null)
        setStageAndRef('done')
      } else {
        // Incidents exist → enter VLM polling stage
        setSub(null)
        setStageAndRef('vlm')
        scheduleVlmPoll(videoId)
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Analyze failed')
      setSub(null)
      setStageAndRef('error')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── VLM polling (every 2 s) ───────────────────────────────────────────────
  const scheduleVlmPoll = useCallback((videoId: string) => {
    clearTimer()
    pollTimerRef.current = setTimeout(() => void pollVlm(videoId), 2000)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pollVlm = useCallback(async (videoId: string) => {
    if (stageRef.current !== 'vlm') return
    try {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const res = await fetch(`/api/uploads/${videoId}/progress`, {
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`Poll failed: HTTP ${res.status}`)
      const d = (await res.json()) as ProgressResponse

      // VLM disabled or all skipped → grey pill, straight to done
      if (!d.vlm_enabled || (d.vlm_skipped > 0 && d.vlm_pending === 0 && d.vlm_done === 0 && d.vlm_error === 0)) {
        setSub(null)
        setStageAndRef('done')
        return
      }

      // Error variant
      if (d.vlm_error > 0) {
        setError(`VLM validation error on ${d.vlm_error} incident(s)`)
        setSub(null)
        setStageAndRef('error')
        return
      }

      const total = d.vlm_done + d.vlm_pending + d.vlm_error + d.vlm_skipped
      setSub(`${d.vlm_done} / ${total} validated`)

      if (d.vlm_pending === 0) {
        // All incidents settled
        setSub(null)
        setStageAndRef('done')
        return
      }

      scheduleVlmPoll(videoId)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Polling failed')
      setSub(null)
      setStageAndRef('error')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ingest polling (every 1 s) ────────────────────────────────────────────
  const scheduleIngestPoll = useCallback((videoId: string) => {
    clearTimer()
    pollTimerRef.current = setTimeout(() => void pollIngest(videoId), 1000)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pollIngest = useCallback(async (videoId: string) => {
    if (stageRef.current !== 'ingest') return
    try {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const res = await fetch(`/api/uploads/${videoId}/progress`, {
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`Poll failed: HTTP ${res.status}`)
      const d = (await res.json()) as ProgressResponse

      const eventCount = d.event_count
      setSub(eventCount > 0 ? `${eventCount.toLocaleString()} events` : null)

      const p = plateauRef.current
      const durationS = durationRef.current ?? d.duration_s ?? 30
      const elapsed = (Date.now() - p.startedAt) / 1000

      // Hard cap: never wait longer than duration + 5 s
      const hardCap = durationS + 5

      if (elapsed >= hardCap) {
        setSub(null)
        void triggerAnalyze(videoId)
        return
      }

      // Min ingest wait before plateau detection arms
      const minWait = Math.min(15, durationS)
      const plateauArmed = elapsed >= minWait

      // Plateau detection: 3 consecutive polls with same event_count
      if (eventCount === p.lastCount) {
        p.streak += 1
      } else {
        p.streak = 1
        p.lastCount = eventCount
      }

      if (plateauArmed && p.streak >= 3) {
        setSub(null)
        void triggerAnalyze(videoId)
        return
      }

      scheduleIngestPoll(videoId)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Polling failed')
      setSub(null)
      setStageAndRef('error')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public actions ────────────────────────────────────────────────────────
  const startUpload = useCallback(() => {
    videoIdRef.current = null
    durationRef.current = null
    plateauRef.current = { lastCount: -1, streak: 0, startedAt: 0 }
    setStageAndRef('upload')
    setPercent(0)
    setSub(null)
    setError(null)
  }, [setStageAndRef])

  const setUploadPercent = useCallback((pct: number) => {
    setPercent(pct)
  }, [])

  const uploadDone = useCallback(
    (videoId: string, durationS: number | null) => {
      videoIdRef.current = videoId
      durationRef.current = durationS
      plateauRef.current = { lastCount: -1, streak: 0, startedAt: Date.now() }
      setPercent(100)
      setStageAndRef('ingest')
      setSub(null)
      scheduleIngestPoll(videoId)
    },
    [setStageAndRef, scheduleIngestPoll],
  )

  const uploadError = useCallback(
    (msg: string) => {
      setError(msg)
      setSub(null)
      setStageAndRef('error')
    },
    [setStageAndRef],
  )

  const reset = useCallback(() => {
    clearTimer()
    abort()
    videoIdRef.current = null
    durationRef.current = null
    plateauRef.current = { lastCount: -1, streak: 0, startedAt: 0 }
    setStageAndRef('idle')
    setPercent(0)
    setSub(null)
    setError(null)
  }, [setStageAndRef, clearTimer, abort])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimer()
      abort()
    }
  }, [clearTimer, abort])

  return {
    stage,
    percent,
    sub,
    error,
    startUpload,
    setUploadPercent,
    uploadDone,
    uploadError,
    reset,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────
interface ProgressResponse {
  video_id: string
  duration_s: number | null
  event_count: number
  incidents_total: number
  vlm_pending: number
  vlm_done: number
  vlm_skipped: number
  vlm_error: number
  vlm_enabled: boolean
}
