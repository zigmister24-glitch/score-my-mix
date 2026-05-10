type Env = {
  DB: D1Database
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const normalizedTitle = url.searchParams.get('normalized_title') || ''
  const durationSeconds = Number(url.searchParams.get('duration_seconds') || 0)

  if (!normalizedTitle || !Number.isFinite(durationSeconds)) {
    return json({ ok: false, error: 'Missing song identity' }, { status: 400 })
  }

  const row = await env.DB.prepare(`
    SELECT genre
    FROM song_genres
    WHERE normalized_title = ? AND duration_seconds = ?
    LIMIT 1
  `).bind(normalizedTitle, Math.round(durationSeconds)).first<{ genre: string }>()

  return json({ ok: true, found: Boolean(row), genre: row?.genre ?? null })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json<any>().catch(() => null)

  if (!body?.normalized_title || !Number.isFinite(Number(body?.duration_seconds)) || !body?.genre) {
    return json({ ok: false, error: 'Missing song genre payload' }, { status: 400 })
  }

  await env.DB.prepare(`
    INSERT INTO song_genres (
      normalized_title,
      duration_seconds,
      title,
      artist,
      display_name,
      genre,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(normalized_title, duration_seconds)
    DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      display_name = excluded.display_name,
      genre = excluded.genre,
      updated_at = datetime('now')
  `).bind(
    String(body.normalized_title),
    Math.round(Number(body.duration_seconds)),
    String(body.title ?? ''),
    String(body.artist ?? ''),
    String(body.display_name ?? ''),
    String(body.genre),
  ).run()

  return json({ ok: true })
}
