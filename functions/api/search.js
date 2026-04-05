function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function extractReplyText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p?.text || "").join("").trim();
}

function extractSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    if (!web?.uri) continue;
    sources.push({
      title: web.title || web.uri,
      url: web.uri,
    });
  }
  const unique = [];
  const seen = new Set();
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    unique.push(s);
  }
  return unique.slice(0, 8);
}

export async function onRequestGet(context) {
  const apiKey = context.env.GEMINI_API_KEY || "";
  if (!apiKey) return json({ error: "GEMINI_API_KEY が未設定です。" }, 500);

  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q が空です" }, 400);

  const model = context.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `次の質問に対してGoogle検索を使って最新情報を確認し、日本語で簡潔に要約してください: ${q}`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: `検索API接続エラー: ${e?.message || e}` }, 500);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const text = await res.text();
    return json({ error: `検索APIレスポンス解析失敗: ${text}` }, 500);
  }

  if (!res.ok) {
    return json({ error: `検索APIエラー(${res.status}): ${JSON.stringify(data)}` }, 500);
  }

  const summary = extractReplyText(data);
  const sources = extractSources(data);
  return json({
    query: q,
    summary: summary || "要約を取得できませんでした。",
    sources,
    model,
  });
}

