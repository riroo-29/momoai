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

export async function onRequestPost(context) {
  const apiKey = context.env.GEMINI_API_KEY || "";
  const model = context.env.GEMINI_MODEL || "gemini-2.5-flash";

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

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: `Gemini API request failed: ${e?.message || e}` }, 500);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const text = await res.text();
    return json({ error: `Gemini API error (${res.status}): ${text}` }, 500);
  }

  if (!res.ok) {
    return json({ error: `Gemini API error (${res.status}): ${JSON.stringify(data)}` }, 500);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const reply = parts.map((p) => p?.text || "").join("").trim();
  if (!reply) return json({ error: "Gemini response からテキストを抽出できませんでした。" }, 500);

  return json({ reply, model });
}
