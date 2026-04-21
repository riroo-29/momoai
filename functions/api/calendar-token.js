function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const form = new URLSearchParams();
  form.set("code", code);
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("redirect_uri", redirectUri);
  form.set("grant_type", "authorization_code");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token交換失敗(${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function onRequestGet(context) {
  const env = context.env || {};
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    return json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です" }, 500);
  }

  const reqUrl = new URL(context.request.url);
  const code = (reqUrl.searchParams.get("code") || "").trim();
  if (!code) {
    return json({
      error: "code が必要です",
      usage: "GET /api/calendar-token?code=xxxx",
    }, 400);
  }

  const redirectUri =
    String(env.GOOGLE_REDIRECT_URI || "").trim() ||
    `${reqUrl.origin}/api/calendar-token`;

  try {
    const token = await exchangeCode({ code, clientId, clientSecret, redirectUri });
    const refreshToken = token?.refresh_token || "";
    return json({
      ok: true,
      refreshToken,
      expiresIn: token?.expires_in,
      scope: token?.scope,
      message:
        refreshToken
          ? "取得成功: この refreshToken を GOOGLE_CALENDAR_REFRESH_TOKEN に設定してください"
          : "refresh_token が返っていません。認可URL再実行時に prompt=consent で再同意してください",
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
  }
}
