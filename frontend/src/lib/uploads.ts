// Shared types and helpers for the uploads feature

export type RuleId = 'vehicle_collision' | 'ped_impact' | 'stationary_vehicle' | 'mass_stop'
export type Severity = 'high' | 'medium' | 'low'

export type Incident = {
  id: string
  video_id: string
  rule_id: RuleId
  severity: Severity
  confidence: number
  t_start_s: number
  t_end_s: number
  frame_start: number
  frame_end: number
  track_ids: number[]
  bbox_union: { x: number; y: number; w: number; h: number }
  metadata: Record<string, unknown>
  created_at: string
}

export type UploadRecord = {
  video_id: string
  original_filename: string
  prompt: string | null
  duration_s: number | null
  width: number | null
  height: number | null
  fps: number | null
  size_bytes: number
  uploaded_at: string         // RFC3339
  playback_url: string        // "/api/video/<video_id>"
  event_count: number
  track_count: number
}

export type TrackSummary = {
  track_id: number
  class: string               // 'car' | 'bicycle' | 'person' | 'road_sign'
  first_t_seconds: number
  last_t_seconds: number
  duration_s: number
  detection_count: number
  max_confidence: number
  first_bbox: { x1: number; y1: number; x2: number; y2: number }
}

export type RawDetection = {
  track_id: number
  class: string
  frame_id: number
  t_seconds: number
  confidence: number
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatDurationSize(duration_s: number | null, size_bytes: number): string {
  if (duration_s != null) {
    return `${formatDuration(duration_s)} · ${formatBytes(size_bytes)}`
  }
  return formatBytes(size_bytes)
}

export function formatUploaded(iso: string): string {
  const d = new Date(iso)
  return d
    .toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    })
    .replace(',', ' ·')
}
