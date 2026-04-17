function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  try {
    let body;
    try {
      body = await context.request.json();
    } catch {
      return json({ error: "リクエストJSONが不正です" }, 400);
    }

    const task = (body?.task || "").trim();
    if (!task) return json({ error: "task が空です" }, 400);

    const bridgeUrl = (context.env.CODEX_BRIDGE_URL || "").trim();
    const bridgeToken = (context.env.CODEX_BRIDGE_TOKEN || "").trim();

    if (!bridgeUrl) {
      return json(
        {
          ok: true,
          result: {
            status: "queued",
            message: "CODEX_BRIDGE_URL 未設定。公開環境では依頼をキュー扱いで受領のみします。",
            task,
          },
        },
        200,
      );
    }

    const payload = {
      task,
      source: "momo_voice_app_pages",
      timestamp: new Date().toISOString(),
    };
    const headers = { "content-type": "application/json" };
    if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;

    let res;
    try {
      res = await fetch(bridgeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: `Codex bridge request failed: ${e?.message || e}` }, 500);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      const text = await res.text();
      return json({ error: `Codex bridge response parse failed: ${text}` }, 500);
    }

    if (!res.ok) return json({ error: `Codex bridge error (${res.status}): ${JSON.stringify(data)}` }, 500);

    return json({
      ok: true,
      result: {
        status: "sent",
        bridge: bridgeUrl,
        response: data,
      },
    });
  } catch (e) {
    return json({ error: `codex task unexpected error: ${e?.message || String(e)}` }, 500);
  }
}
