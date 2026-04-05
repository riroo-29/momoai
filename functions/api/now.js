function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function formatJst(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}(${pick("weekday")}) ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export async function onRequestGet() {
  const now = new Date();
  return json({
    nowIso: now.toISOString(),
    timezone: "Asia/Tokyo",
    nowJst: formatJst(now),
  });
}

