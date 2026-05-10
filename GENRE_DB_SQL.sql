-- Song-level genre preference table
CREATE TABLE IF NOT EXISTS song_genres (
  normalized_title TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  title TEXT,
  artist TEXT,
  display_name TEXT,
  genre TEXT NOT NULL DEFAULT 'Modern Pop',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (normalized_title, duration_seconds)
);

-- Optional: keep genre on section maps too, if not already added
ALTER TABLE section_maps ADD COLUMN genre TEXT DEFAULT 'Modern Pop';

-- If the ALTER TABLE above errors because the column already exists, ignore it.

UPDATE section_maps
SET genre = 'Modern Pop'
WHERE genre IS NULL OR genre = '';
