function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestGet(context) {
  const env = context.env || {};
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) return json({ error: "GOOGLE_CLIENT_ID が未設定です" }, 500);

  const reqUrl = new URL(context.request.url);
  const redirectUri =
    String(env.GOOGLE_REDIRECT_URI || "").trim() ||
    `${reqUrl.origin}/api/calendar-token`;

  const state = reqUrl.searchParams.get("state") || "";
  const scope =
    "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  if (state) authUrl.searchParams.set("state", state);

  return json({
    ok: true,
    authUrl: authUrl.toString(),
    redirectUri,
    message: "このURLをブラウザで開いて認可後、code を /api/calendar-token に渡してください",
  });
}
