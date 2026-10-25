-- Run once in the existing Cloudflare D1 database before deploying.
-- Profile IDs stay fixed even when display names change.
CREATE TABLE IF NOT EXISTS genre_profiles (
  id TEXT PRIMARY KEY CHECK (id IN ('Scarlett Lullaby','User Defined 1','User Defined 2','User Defined 3','User Defined 4')),
  name TEXT NOT NULL,
  weight_db REAL NOT NULL CHECK (weight_db BETWEEN -12 AND 12),
  body_db REAL NOT NULL CHECK (body_db BETWEEN -12 AND 12),
  core_db REAL NOT NULL CHECK (core_db BETWEEN -12 AND 12),
  air_db REAL NOT NULL CHECK (air_db BETWEEN -12 AND 12),
  updated_at TEXT NOT NULL
);
