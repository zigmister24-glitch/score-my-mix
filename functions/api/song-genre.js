function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function cleanTitle(value = "") {
  return String(value)
    .replace(/\.[^/.]+$/, "")
    .toLowerCase()
    .replace(/\b(final|master|mix|remaster|bounce|export|demo|version|v\d+|wav|mp3|m4a)\b/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value = "", maxLength = 140) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const normalizedTitle = cleanTitle(url.searchParams.get("normalized_title") || "");
    const duration = Math.round(Number(url.searchParams.get("duration_seconds") || 0));

    if (!normalizedTitle || normalizedTitle.length < 2) return json({ ok: false, error: "Invalid title" }, 400);
    if (!Number.isFinite(duration) || duration < 60 || duration > 900) return json({ ok: true, found: false, genre: null });

    const row = await context.env.DB.prepare(`
      SELECT genre
      FROM song_genres
      WHERE normalized_title = ?
      AND ABS(duration_seconds - ?) <= 2
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(normalizedTitle, duration).first();

    return json({ ok: true, found: Boolean(row), genre: row?.genre ?? null });
  } catch (error) {
    console.error("[song-genre] GET failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const normalizedTitle = cleanTitle(body.normalized_title || "");
    const duration = Math.round(Number(body.duration_seconds));
    const genre = safeText(body.genre || "Modern Pop", 80);

    if (!normalizedTitle || normalizedTitle.length < 2) return json({ ok: false, error: "Invalid title" }, 400);
    if (!Number.isFinite(duration) || duration < 60 || duration > 900) return json({ ok: true, skipped: true, reason: "Song too short" });
    if (!genre) return json({ ok: false, error: "Invalid genre" }, 400);

    const title = safeText(body.title || "", 140);
    const artist = safeText(body.artist || "", 140);
    const displayName = safeText(body.display_name || "", 180);
    const now = new Date().toISOString();

    await context.env.DB.prepare(`
      INSERT INTO song_genres (
        normalized_title,
        duration_seconds,
        title,
        artist,
        display_name,
        genre,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_title, duration_seconds)
      DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        display_name = excluded.display_name,
        genre = excluded.genre,
        updated_at = excluded.updated_at
    `).bind(normalizedTitle, duration, title, artist, displayName, genre, now, now).run();

    return json({ ok: true, genre });
  } catch (error) {
    console.error("[song-genre] POST failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}
