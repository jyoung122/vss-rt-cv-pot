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
