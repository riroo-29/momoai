function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function buildBridgeTaskStatusUrl(bridgeUrl, taskId) {
  const u = new URL(bridgeUrl);
  u.pathname = `/tasks/${encodeURIComponent(taskId)}`;
  u.search = "";
  return u.toString();
}

export async function onRequestGet(context) {
  try {
    const reqUrl = new URL(context.request.url);
    const taskId = (reqUrl.searchParams.get("id") || "").trim();
    if (!taskId) return json({ error: "id が空です" }, 400);

    const bridgeUrl = (context.env.CODEX_BRIDGE_URL || "").trim();
    const bridgeToken = (context.env.CODEX_BRIDGE_TOKEN || "").trim();
    if (!bridgeUrl) return json({ error: "CODEX_BRIDGE_URL 未設定です" }, 400);

    const statusUrl = buildBridgeTaskStatusUrl(bridgeUrl, taskId);
    const headers = {};
    if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;

    let res;
    try {
      res = await fetch(statusUrl, { method: "GET", headers });
    } catch (e) {
      return json({ error: `Codex bridge status request failed: ${e?.message || e}` }, 500);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      const text = await res.text();
      return json({ error: `Codex bridge status parse failed: ${text}` }, 500);
    }

    if (!res.ok) return json({ error: `Codex bridge status error (${res.status}): ${JSON.stringify(data)}` }, 500);

    return json({
      ok: true,
      result: {
        task: data?.task || null,
        raw: data,
      },
    });
  } catch (e) {
    return json({ error: `codex task-status unexpected error: ${e?.message || String(e)}` }, 500);
  }
}
