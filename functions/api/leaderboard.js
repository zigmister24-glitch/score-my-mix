const TOP_LIMIT = 6;
const DURATION_TOLERANCE_SECONDS = 2;

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

function safeDisplayName(value = "") {
  return String(value)
    .replace(/\.[^/.]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

async function getBoards(DB) {
  const allTime = await DB.prepare(`
    SELECT id, normalized_title, display_name, original_filename, duration_seconds, score, uploaded_at
    FROM leaderboard
    ORDER BY score DESC, uploaded_at DESC
    LIMIT ?
  `).bind(TOP_LIMIT).all();

  const hotStreak = await DB.prepare(`
    SELECT id, normalized_title, display_name, original_filename, duration_seconds, score, uploaded_at
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

function findRank(rows, targetId) {
  const index = rows.findIndex((row) => Number(row.id) === Number(targetId));
  return index >= 0 ? index + 1 : null;
}

export async function onRequestGet(context) {
  try {
    console.log("[leaderboard] GET leaderboard");
    const boards = await getBoards(context.env.DB);
    console.log("[leaderboard] GET ok", {
      allTime: boards.allTime.length,
      hotStreak: boards.hotStreak.length,
    });
    return json({ ok: true, ...boards });
  } catch (error) {
    console.error("[leaderboard] GET failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const score = Math.round(Number(body.score));
    const duration = Math.round(Number(body.duration_seconds));
    const now = new Date().toISOString();
    const originalFilename = String(body.original_filename || body.filename || "Untitled");
    const displayName = safeDisplayName(body.display_name || originalFilename);
    const normalizedTitle = cleanTitle(body.normalized_title || displayName || originalFilename);

    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return json({ ok: false, error: "Invalid score" }, 400);
    }

    if (!Number.isFinite(duration) || duration < 60 || duration > 600) {
      return json({ ok: false, error: "Invalid duration" }, 400);
    }

    if (!normalizedTitle || normalizedTitle.length < 2) {
      console.warn("[leaderboard] rejected invalid title", { originalFilename, displayName, normalizedTitle });
      return json({ ok: false, error: "Invalid title" }, 400);
    }

    console.log("[leaderboard] POST score received", {
      displayName,
      normalizedTitle,
      duration,
      score,
    });

    const existing = await context.env.DB.prepare(`
      SELECT *
      FROM leaderboard
      WHERE normalized_title = ?
      AND ABS(duration_seconds - ?) <= ?
      ORDER BY score DESC, uploaded_at DESC
      LIMIT 1
    `).bind(normalizedTitle, duration, DURATION_TOLERANCE_SECONDS).first();

    let status = "new_entry";
    let targetId = null;

    if (existing) {
      targetId = existing.id;
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

      const inserted = await context.env.DB.prepare(`
        SELECT id
        FROM leaderboard
        WHERE normalized_title = ?
        AND ABS(duration_seconds - ?) <= ?
        ORDER BY uploaded_at DESC
        LIMIT 1
      `).bind(normalizedTitle, duration, DURATION_TOLERANCE_SECONDS).first();
      targetId = inserted?.id ?? null;
    }

    const boards = await getBoards(context.env.DB);
    const allTimeRank = findRank(boards.allTime, targetId);
    const hotStreakRank = findRank(boards.hotStreak, targetId);

    const responsePayload = {
      ok: true,
      status,
      allTimeRank,
      hotStreakRank,
      madeAllTime: allTimeRank !== null && allTimeRank <= TOP_LIMIT,
      madeHotStreak: hotStreakRank !== null && hotStreakRank <= TOP_LIMIT,
      ...boards,
    };

    console.log("[leaderboard] POST saved", {
      displayName,
      status,
      allTimeRank,
      hotStreakRank,
      madeAllTime: responsePayload.madeAllTime,
      madeHotStreak: responsePayload.madeHotStreak,
    });

    return json(responsePayload);
  } catch (error) {
    console.error("[leaderboard] POST failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}
