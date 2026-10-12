-- Link the retained user turn to the existing authoritative stream status.
ALTER TABLE message ADD COLUMN turn_stream_id TEXT;
ALTER TABLE message ADD COLUMN backend_terminal INTEGER NOT NULL DEFAULT 0;
