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
  const apiKey = context.env.GEMINI_API_KEY || "";
  const liveModel = context.env.GEMINI_LIVE_MODEL || "gemini-live-2.5-flash-preview";

  return json({
    apiKey,
    liveModel,
  });
}
