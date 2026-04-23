const TOP_LIMIT = 6;
const DURATION_TOLERANCE_SECONDS = 2;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function getBoards(DB) {
  const allTime = await DB.prepare(`
    SELECT display_name, original_filename, duration_seconds, score, uploaded_at
    FROM leaderboard
    ORDER BY score DESC, uploaded_at DESC
    LIMIT ?
  `).bind(TOP_LIMIT).all();

  const hotStreak = await DB.prepare(`
    SELECT display_name, original_filename, duration_seconds, score, uploaded_at
    FROM leaderboard
    WHERE uploaded_at >= datetime('now', '-30 days')
    ORDER BY score DESC, uploaded_at DESC
    LIMIT ?
  `).bind(TOP_LIMIT).all();

  return {
    allTime: allTime.results || [],
    hotStreak: hotStreak.results || [],
  };
}

export async function onRequestGet(context) {
  try {
    const boards = await getBoards(context.env.DB);
    return json({ ok: true, ...boards });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const score = Math.round(Number(body.score));
    const duration = Math.round(Number(body.duration_seconds));
    const now = new Date().toISOString();

    const displayName = String(body.display_name || body.original_filename || "Untitled")
      .replace(/\.[^/.]+$/, "")
      .slice(0, 140);

    const originalFilename = String(body.original_filename || "Untitled");

    const normalizedTitle = String(body.normalized_title || displayName)
      .replace(/\.[^/.]+$/, "")
      .toLowerCase()
      .replace(/\b(final|master|mix|remaster|v\d+|wav|mp3|m4a)\b/g, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return json({ ok: false, error: "Invalid score" }, 400);
    }

    if (!Number.isFinite(duration) || duration < 60 || duration > 600) {
      return json({ ok: false, error: "Invalid duration" }, 400);
    }

    const existing = await context.env.DB.prepare(`
      SELECT *
      FROM leaderboard
      WHERE normalized_title = ?
      AND ABS(duration_seconds - ?) <= ?
      ORDER BY score DESC, uploaded_at DESC
      LIMIT 1
    `).bind(normalizedTitle, duration, DURATION_TOLERANCE_SECONDS).first();

    let status = "new_entry";

    if (existing) {
      if (score > existing.score) {
        await context.env.DB.prepare(`
          UPDATE leaderboard
          SET score = ?, display_name = ?, original_filename = ?, duration_seconds = ?, uploaded_at = ?
          WHERE id = ?
        `).bind(score, displayName, originalFilename, duration, now, existing.id).run();

        status = "improved";
      } else {
        status = "retained";
      }
    } else {
      await context.env.DB.prepare(`
        INSERT INTO leaderboard (
          normalized_title, display_name, original_filename, duration_seconds, score, uploaded_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(normalizedTitle, displayName, originalFilename, duration, score, now).run();
    }

    const boards = await getBoards(context.env.DB);

    return json({
      ok: true,
      status,
      ...boards,
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}