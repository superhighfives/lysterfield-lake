-- A visitor's polaroid, from submission to the gallery (plans/in-progress/polaroids.md).
--
-- status: uploading (row made, clip not in yet) → submitted → approved (queued to make)
-- → making → made → shown, or rejected / failed. Times are milliseconds since the epoch.
CREATE TABLE polaroids (
  -- Random and unguessable: it's the private link until the polaroid is shown.
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  -- The visitor's framing, as job.json's source.crop: { x, y, zoom }.
  crop TEXT NOT NULL,
  -- Only to say it's ready; cleared once that's sent.
  email TEXT,
  clip_type TEXT,
  clip_size INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  made_at INTEGER,
  shown_at INTEGER
);

CREATE INDEX polaroids_status ON polaroids (status, approved_at);
CREATE INDEX polaroids_shown ON polaroids (shown_at) WHERE status = 'shown';
