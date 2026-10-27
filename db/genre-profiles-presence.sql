-- Run once on an existing genre_profiles table before deploying Presence.
ALTER TABLE genre_profiles ADD COLUMN presence_db REAL NOT NULL DEFAULT 0
  CHECK (presence_db BETWEEN -12 AND 12);
