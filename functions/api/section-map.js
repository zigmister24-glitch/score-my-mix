const DURATION_TOLERANCE_SECONDS = 2;
const MAX_SECTIONS = 80;

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

function normaliseSections(sections, duration) {
  if (!Array.isArray(sections)) return [];

  const cleaned = sections
    .slice(0, MAX_SECTIONS)
    .map((section) => ({
      start: Number(section.start),
      end: Number(section.end),
      label: safeText(section.label || "", 60),
    }))
    .filter((section) => Number.isFinite(section.start) && Number.isFinite(section.end))
    .map((section) => ({
      ...section,
      start: Math.max(0, Math.min(duration, section.start)),
      end: Math.max(0, Math.min(duration, section.end)),
    }))
    .filter((section) => section.end - section.start >= 1)
    .sort((a, b) => a.start - b.start);

  return cleaned.map((section) => ({
    start: Number(section.start.toFixed(3)),
    end: Number(section.end.toFixed(3)),
    label: section.label,
  }));
}

async function findMap(DB, normalizedTitle, duration) {
  return DB.prepare(`
    SELECT *
    FROM section_maps
    WHERE normalized_title = ?
    AND ABS(duration_seconds - ?) <= ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(normalizedTitle, duration, DURATION_TOLERANCE_SECONDS).first();
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const normalizedTitle = cleanTitle(url.searchParams.get("normalized_title") || "");
    const duration = Math.round(Number(url.searchParams.get("duration_seconds") || 0));

    if (!normalizedTitle || normalizedTitle.length < 2) return json({ ok: false, error: "Invalid title" }, 400);
    if (!Number.isFinite(duration) || duration < 1 || duration > 900) return json({ ok: false, error: "Invalid duration" }, 400);

    const row = await findMap(context.env.DB, normalizedTitle, duration);
    if (!row) return json({ ok: true, found: false, map: null });

    let sections = [];
    try { sections = JSON.parse(row.sections_json || "[]"); } catch { sections = []; }

    return json({
      ok: true,
      found: true,
      map: {
        id: row.id,
        normalizedTitle: row.normalized_title,
        title: row.title || "",
        artist: row.artist || "",
        displayName: row.display_name || "",
        durationSeconds: row.duration_seconds,
        sections,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    console.error("[section-map] GET failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const normalizedTitle = cleanTitle(body.normalized_title || body.display_name || body.title || "");
    const duration = Math.round(Number(body.duration_seconds));
    const title = safeText(body.title || body.display_name || normalizedTitle);
    const artist = safeText(body.artist || "");
    const displayName = safeText(body.display_name || (artist ? `${title} - ${artist}` : title));

    if (!normalizedTitle || normalizedTitle.length < 2) return json({ ok: false, error: "Invalid title" }, 400);
    if (!Number.isFinite(duration) || duration < 1 || duration > 900) return json({ ok: false, error: "Invalid duration" }, 400);

    const sections = normaliseSections(body.sections, duration);
    if (sections.length < 1) return json({ ok: false, error: "No valid sections supplied" }, 400);

    const now = new Date().toISOString();
    const existing = await findMap(context.env.DB, normalizedTitle, duration);
    const sectionsJson = JSON.stringify(sections);

    if (existing) {
      await context.env.DB.prepare(`
        UPDATE section_maps
        SET title = ?, artist = ?, display_name = ?, duration_seconds = ?, sections_json = ?, updated_at = ?
        WHERE id = ?
      `).bind(title, artist, displayName, duration, sectionsJson, now, existing.id).run();
      return json({ ok: true, status: "updated", id: existing.id });
    }

    const inserted = await context.env.DB.prepare(`
      INSERT INTO section_maps (
        normalized_title, title, artist, display_name, duration_seconds, sections_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(normalizedTitle, title, artist, displayName, duration, sectionsJson, now, now).run();

    return json({ ok: true, status: "created", id: inserted.meta?.last_row_id ?? null });
  } catch (error) {
    console.error("[section-map] POST failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const body = await context.request.json();
    const normalizedTitle = cleanTitle(body.normalized_title || "");
    const duration = Math.round(Number(body.duration_seconds));

    if (!normalizedTitle || normalizedTitle.length < 2) return json({ ok: false, error: "Invalid title" }, 400);
    if (!Number.isFinite(duration) || duration < 1 || duration > 900) return json({ ok: false, error: "Invalid duration" }, 400);

    await context.env.DB.prepare(`
      DELETE FROM section_maps
      WHERE normalized_title = ?
      AND ABS(duration_seconds - ?) <= ?
    `).bind(normalizedTitle, duration, DURATION_TOLERANCE_SECONDS).run();

    return json({ ok: true, status: "deleted" });
  } catch (error) {
    console.error("[section-map] DELETE failed", error);
    return json({ ok: false, error: error.message }, 500);
  }
}
