/**
 * useUploadProgress — 6-stage upload state machine.
 *
 * Stages: idle → [queued →] upload → ingest → rules → vlm → done | error
 *
 * The "queued" stage is conditional: it only appears when the initial
 * POST /api/upload response returns queue_status="queued". Once the
 * backend flips queue_status to "active", the strip advances.
 *
 * Polling: recursive setTimeout (not setInterval) so a slow fetch never
 * queues a backlog of concurrent requests. AbortController cancels
 * in-flight fetches on unmount or videoId change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'

export type UploadStage = 'idle' | 'queued' | 'upload' | 'ingest' | 'rules' | 'vlm' | 'done' | 'error'

export interface UploadProgressState {
  stage: UploadStage
  percent: number       // XHR upload progress (0-100); 0 outside upload stage
  sub: string | null    // e.g. "12 480 events", "12 / 57 validated", "running…"
  error: string | null  // surfaced from /analyze or polling failures
  queueStatus: 'queued' | 'active' | 'done' | null
  queuePosition: number | null
  /** True if this upload was ever in the queued state — used to keep the Queued pill visible */
  wasQueued: boolean
}

export interface UploadProgressActions {
  /** Call when XHR upload starts. */
  startUpload: () => void
  /** Call on XHR progress events. */
  setUploadPercent: (pct: number) => void
  /** Call when upload HTTP 200 arrives with the returned video_id, queue info, etc. */
  uploadDone: (videoId: string, durationS: number | null, queueStatus?: 'queued' | 'active' | null, queuePosition?: number | null) => void
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
  const [queueStatus, setQueueStatus] = useState<'queued' | 'active' | 'done' | null>(null)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const [wasQueued, setWasQueued] = useState(false)

  // Internal refs so polling callbacks can read current state without stale closures
  const videoIdRef = useRef<string | null>(null)
  const durationRef = useRef<number | null>(null)
  const stageRef = useRef<UploadStage>('idle')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Whether this upload was ever queued — used to keep the Queued pill visible
  const wasQueuedRef = useRef(false)

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
      const res = await apiFetch(`/api/uploads/${videoId}/analyze`, {
        method: 'POST',
        signal: ctrl.signal,
      })
      if (res.status === 503) throw new Error('Detection pipeline unavailable — vss-rt-cv did not complete')
      // 422 = pipeline ran but no events detected — treat as zero incidents
      if (!res.ok && res.status !== 422) throw new Error(`Analyze failed: HTTP ${res.status}`)
      const data = res.ok ? (await res.json()) as { incidents_found: number } : { incidents_found: 0 }

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
      const res = await apiFetch(`/api/uploads/${videoId}/progress`, {
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

  // ── Queue polling (every 2 s — slow-moving state) ─────────────────────────
  const scheduleQueuePoll = useCallback((videoId: string) => {
    clearTimer()
    pollTimerRef.current = setTimeout(() => void pollQueue(videoId), 2000)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pollQueue = useCallback(async (videoId: string) => {
    if (stageRef.current !== 'queued') return
    try {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const res = await apiFetch(`/api/uploads/${videoId}/progress`, {
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`Poll failed: HTTP ${res.status}`)
      const d = (await res.json()) as ProgressResponse

      // Update queue position display
      if (d.queue_status === 'queued') {
        setQueueStatus('queued')
        setQueuePosition(d.queue_position ?? null)
        scheduleQueuePoll(videoId)
        return
      }

      // queue_status flipped to "active" (or null/done) — advance out of queued
      setQueueStatus(d.queue_status ?? 'active')
      setQueuePosition(null)

      // If upload bytes are already done (percent=100 in upload stage was
      // never entered because we went idle→queued), jump straight to ingest.
      // Otherwise enter the upload stage normally.
      // Since the XHR was already submitted before we entered queued state,
      // the bytes are done — go straight to ingest.
      durationRef.current = d.duration_s ?? durationRef.current
      plateauRef.current = { lastCount: -1, streak: 0, startedAt: Date.now() }
      setPercent(100)
      setStageAndRef('ingest')
      setSub(null)
      scheduleIngestPoll(videoId)
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
      const res = await apiFetch(`/api/uploads/${videoId}/progress`, {
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
    wasQueuedRef.current = false
    plateauRef.current = { lastCount: -1, streak: 0, startedAt: 0 }
    setStageAndRef('upload')
    setPercent(0)
    setSub(null)
    setError(null)
    setQueueStatus(null)
    setQueuePosition(null)
    setWasQueued(false)
  }, [setStageAndRef])

  const setUploadPercent = useCallback((pct: number) => {
    setPercent(pct)
  }, [])

  const uploadDone = useCallback(
    (videoId: string, durationS: number | null, qs?: 'queued' | 'active' | null, qp?: number | null) => {
      videoIdRef.current = videoId
      durationRef.current = durationS

      if (qs === 'queued') {
        // Enter the queued holding stage — XHR bytes are done but processing
        // is waiting behind other jobs in DeepStream.
        wasQueuedRef.current = true
        setWasQueued(true)
        setQueueStatus('queued')
        setQueuePosition(qp ?? null)
        setPercent(100)
        setStageAndRef('queued')
        setSub(null)
        scheduleQueuePoll(videoId)
      } else {
        // Active immediately — go straight to ingest as before
        setQueueStatus(qs ?? null)
        setQueuePosition(null)
        plateauRef.current = { lastCount: -1, streak: 0, startedAt: Date.now() }
        setPercent(100)
        setStageAndRef('ingest')
        setSub(null)
        scheduleIngestPoll(videoId)
      }
    },
    [setStageAndRef, scheduleIngestPoll, scheduleQueuePoll],
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
    wasQueuedRef.current = false
    plateauRef.current = { lastCount: -1, streak: 0, startedAt: 0 }
    setStageAndRef('idle')
    setPercent(0)
    setSub(null)
    setError(null)
    setQueueStatus(null)
    setQueuePosition(null)
    setWasQueued(false)
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
    queueStatus,
    queuePosition,
    wasQueued,
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
  queue_status: 'queued' | 'active' | 'done' | null
  queue_position: number | null
}
