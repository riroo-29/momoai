const MAX_TURNS = 12;

const SYSTEM_PROMPT = `
あなたはオリジナル2Dキャラクター「焔丸(ほむらまる)」です。

キャラ設定:
- 明るく勇気づける、礼儀正しい、少し少年剣士っぽい語彙
- 一人称は「ぼく」
- 相手のことは「主(あるじ)」と呼ぶ（自然な頻度で）
- 語尾は毎回固定しない。読みやすい自然な日本語
- AIや規約に反する内容は丁寧に断る

話し方:
- 返答は短め〜中くらい（2〜6文）
- 最初に共感、次に提案、最後に小さな一言で背中を押す
`.trim();

function formatJstNow(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function buildUserText(message, history) {
  const compact = [];
  for (const turn of (history || []).slice(-MAX_TURNS)) {
    const role = turn?.role || "user";
    const text = turn?.text || "";
    if (!text) continue;
    compact.push(`${role}: ${text}`);
  }
  return (
    "以下は会話履歴です。文脈を保って返答してください。\n" +
    compact.join("\n") +
    `\nuser: ${message}`
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status, data) {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const txt = JSON.stringify(data || {}).toLowerCase();
  return txt.includes("unavailable") || txt.includes("high demand");
}

async function requestGemini({ apiKey, model, payload }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message || e) } };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    const text = await res.text();
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function callGeminiWithRetry({ apiKey, models, payload }) {
  let last = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await requestGemini({ apiKey, model, payload });
      if (result.ok) return { ...result, model };
      last = { ...result, model, attempt };
      if (!shouldRetry(result.status, result.data) || attempt === 3) break;
      await wait(250 * attempt); // 250ms -> 500ms
    }
  }
  return last;
}

export async function onRequestPost(context) {
  const apiKey = context.env.GEMINI_API_KEY || "";
  const model = context.env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallback = (context.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite").trim();
  const models = [...new Set([model, fallback].filter(Boolean))];

  if (!apiKey) return json({ error: "GEMINI_API_KEY が未設定です。" }, 500);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "リクエストJSONが不正です" }, 400);
  }

  const message = (body?.message || "").trim();
  const history = Array.isArray(body?.history) ? body.history : [];
  if (!message) return json({ error: "message が空です" }, 400);

  const nowPrompt = `現在時刻の基準は ${formatJstNow(new Date())} (Asia/Tokyo)。時刻・日付質問にはこの基準で正確に答えてください。`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: buildUserText(message, history) }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }, { text: nowPrompt }] },
    generationConfig: { temperature: 0.8 },
  };

  const result = await callGeminiWithRetry({ apiKey, models, payload });
  if (!result || !result.ok) {
    const status = result?.status || 500;
    const raw = JSON.stringify(result?.data || {});
    if (status === 503 || shouldRetry(status, result?.data)) {
      return json(
        {
          error:
            "Gemini が一時的に混雑しています。数秒おいて再度送信してください。",
          detail: `Gemini API error (${status})`,
        },
        503,
      );
    }
    return json({ error: `Gemini API error (${status}): ${raw}` }, 500);
  }

  const parts = result?.data?.candidates?.[0]?.content?.parts || [];
  const reply = parts.map((p) => p?.text || "").join("").trim();
  if (!reply) return json({ error: "Gemini response からテキストを抽出できませんでした。" }, 500);

  return json({ reply, model: result.model });
}
