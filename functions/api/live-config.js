function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeLiveModelName(name) {
  const raw = (name || "").trim();
  if (!raw) return "gemini-2.0-flash-live-001";

  const noPrefix = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
  const aliases = new Map([
    ["gemini-2.5-flash-live-preview", "gemini-2.0-flash-live-001"],
    ["gemini-3.1-flash-live-preview", "gemini-2.0-flash-live-001"],
    ["gemini-live-2.5-flash-preview", "gemini-2.0-flash-live-001"],
  ]);

  return aliases.get(noPrefix) || noPrefix;
}

export async function onRequestGet(context) {
  const apiKey = context.env.GEMINI_API_KEY || "";
  const liveModel = normalizeLiveModelName(context.env.GEMINI_LIVE_MODEL || "");

  return json({
    apiKey,
    liveModel,
  });
}
