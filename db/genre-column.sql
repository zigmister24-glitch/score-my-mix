-- Run once against the Cloudflare D1 database before deploying this version.
-- Safe to ignore the duplicate-column error if you have already run it.
ALTER TABLE section_maps ADD COLUMN genre TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_section_maps_title_duration_genre
ON section_maps (normalized_title, duration_seconds, genre);
