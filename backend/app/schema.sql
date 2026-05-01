CREATE TABLE IF NOT EXISTS uploads (
  video_id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  prompt TEXT,
  duration_s REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  size_bytes BIGINT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES uploads(video_id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL,
  frame_id INTEGER NOT NULL,
  t_seconds REAL NOT NULL,
  class TEXT NOT NULL,
  confidence REAL NOT NULL,
  bbox_x1 REAL NOT NULL,
  bbox_y1 REAL NOT NULL,
  bbox_x2 REAL NOT NULL,
  bbox_y2 REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS events_video_frame_idx ON events(video_id, frame_id);
CREATE INDEX IF NOT EXISTS events_video_track_idx ON events(video_id, track_id);

CREATE TABLE IF NOT EXISTS incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      TEXT NOT NULL REFERENCES uploads(video_id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL,           -- 'vehicle_collision' | 'ped_impact' | 'stationary_vehicle' | 'mass_stop'
  severity      TEXT NOT NULL,           -- 'high' | 'medium' | 'low'
  confidence    REAL NOT NULL,           -- 0..1
  t_start_s     REAL NOT NULL,
  t_end_s       REAL NOT NULL,
  frame_start   INT  NOT NULL,
  frame_end     INT  NOT NULL,
  track_ids     INT[] NOT NULL,
  bbox_union    JSONB NOT NULL,          -- {"x":int,"y":int,"w":int,"h":int}
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_video_t ON incidents (video_id, t_start_s);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_dedup ON incidents (video_id, rule_id, t_start_s, track_ids);

-- Phase 8: VLM validation columns (added via ALTER so existing rows get defaults)
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_status     TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_verdict    TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_reasoning  TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_confidence REAL;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_model      TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_clip_path  TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_latency_ms INTEGER;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vlm_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidents_vlm_pending ON incidents (video_id) WHERE vlm_status = 'pending';

-- Rule configuration: user-tunable thresholds per rule type.
-- Rows are upserted on first PUT; missing rows mean "use code defaults".
CREATE TABLE IF NOT EXISTS rule_config (
  rule_id    TEXT PRIMARY KEY,
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
