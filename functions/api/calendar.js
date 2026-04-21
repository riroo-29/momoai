function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function formatJstDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toJstDate(base = new Date()) {
  return new Date(base.getTime() + 9 * 60 * 60 * 1000);
}

function parseJstRangeFromQuery(rawQuery) {
  const q = String(rawQuery || "").trim();
  const nowJst = toJstDate(new Date());
  const todayStr = formatJstDate(nowJst);

  const mkRange = (offsetDays, label) => {
    const startJst = new Date(nowJst.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const day = formatJstDate(startJst);
    return {
      label,
      startIso: `${day}T00:00:00+09:00`,
      endIso: `${day}T23:59:59+09:00`,
    };
  };

  if (!q || q.includes("今日")) return mkRange(0, "今日");
  if (q.includes("明日")) return mkRange(1, "明日");
  if (q.includes("明後日") || q.includes("あさって")) return mkRange(2, "明後日");
  if (q.includes("今週")) {
    const end = new Date(nowJst.getTime() + 6 * 24 * 60 * 60 * 1000);
    return {
      label: "今週",
      startIso: `${todayStr}T00:00:00+09:00`,
      endIso: `${formatJstDate(end)}T23:59:59+09:00`,
    };
  }

  const m = q.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const yyyy = m[1];
    const mm = String(Number(m[2])).padStart(2, "0");
    const dd = String(Number(m[3])).padStart(2, "0");
    const day = `${yyyy}-${mm}-${dd}`;
    return {
      label: `${day}`,
      startIso: `${day}T00:00:00+09:00`,
      endIso: `${day}T23:59:59+09:00`,
    };
  }

  return mkRange(0, "今日");
}

async function fetchAccessToken(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(env.GOOGLE_CALENDAR_REFRESH_TOKEN || "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Calendar未設定です（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALENDAR_REFRESH_TOKEN）");
  }

  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("refresh_token", refreshToken);
  form.set("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error(`Google token取得失敗(${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function mapGoogleEvent(ev) {
  const start = ev?.start?.dateTime || ev?.start?.date || "";
  const end = ev?.end?.dateTime || ev?.end?.date || "";
  return {
    id: ev?.id || "",
    summary: ev?.summary || "(無題)",
    start,
    end,
    location: ev?.location || "",
    description: ev?.description || "",
    htmlLink: ev?.htmlLink || "",
  };
}

function buildSummary(label, items) {
  if (!Array.isArray(items) || items.length === 0) return `${label}の予定はありません`;
  const lines = items.slice(0, 5).map((it, idx) => {
    const s = String(it.start || "");
    const hhmm = s.includes("T") ? s.split("T")[1].slice(0, 5) : "終日";
    return `${idx + 1}. ${hhmm} ${it.summary}`;
  });
  return `${label}の予定は${items.length}件\n${lines.join("\n")}`;
}

export async function onRequestGet(context) {
  try {
    const accessToken = await fetchAccessToken(context.env);
    const calendarId = encodeURIComponent(String(context.env.GOOGLE_CALENDAR_ID || "primary").trim() || "primary");
    const url = new URL(context.request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const mode = (url.searchParams.get("mode") || "").trim();

    const range =
      mode === "today"
        ? parseJstRangeFromQuery("今日")
        : parseJstRangeFromQuery(q);

    const endpoint =
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events` +
      `?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(range.startIso)}` +
      `&timeMax=${encodeURIComponent(range.endIso)}&maxResults=20`;

    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: `Google Calendar取得失敗(${res.status}): ${JSON.stringify(data)}` }, 500);
    }

    const items = Array.isArray(data?.items) ? data.items.map(mapGoogleEvent) : [];
    return json({
      ok: true,
      label: range.label,
      timezone: "Asia/Tokyo",
      range: { start: range.startIso, end: range.endIso },
      items,
      summary: buildSummary(range.label, items),
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const accessToken = await fetchAccessToken(context.env);
    const calendarId = encodeURIComponent(String(context.env.GOOGLE_CALENDAR_ID || "primary").trim() || "primary");
    const body = await context.request.json().catch(() => ({}));
    const summary = String(body?.summary || "").trim();
    const start = String(body?.start || "").trim();
    const end = String(body?.end || "").trim();
    const timezone = String(body?.timezone || "Asia/Tokyo").trim() || "Asia/Tokyo";
    const description = String(body?.description || "").trim();
    const location = String(body?.location || "").trim();

    if (!summary || !start || !end) {
      return json({ error: "summary/start/end は必須です" }, 400);
    }

    const payload = {
      summary,
      description,
      location,
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
    };

    const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: `Google Calendar作成失敗(${res.status}): ${JSON.stringify(data)}` }, 500);
    }

    return json({
      ok: true,
      event: mapGoogleEvent(data),
      message: "予定を作成しました",
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
  }
}
