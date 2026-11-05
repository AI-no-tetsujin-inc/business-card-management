// Google Chat への通知（スペースの Incoming Webhook）。space "minutes" は議事録用のスペース（未設定なら通常のスペース）
export async function sendChat(env: Env, text: string, space?: "minutes"): Promise<boolean> {
  const url = (space === "minutes" && env.GOOGLE_CHAT_MINUTES_WEBHOOK_URL) || env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!url) {
    console.log("[Google Chat 未設定のため送信しません]\n" + text);
    return false;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) console.error("Google Chat への通知に失敗", res.status, await res.text());
  return res.ok;
}

/** 同じ定期処理を二重に実行しないための記録。初回なら true */
export async function claimJob(db: D1Database, key: string): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO job_runs (key, ran_at) VALUES (?, ?)").bind(key, new Date().toISOString()).run();
  return r.meta.changes > 0;
}

/** 日本時間の今日（YYYY-MM-DD）と今月（YYYY-MM） */
export function jstToday() {
  const d = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return { date: d, month: d.slice(0, 7), day: Number(d.slice(8, 10)) };
}

/**
 * Google Chat でのメンション。ログインしたことがある人は Google のユーザー ID（google_sub）で本当にメンションし、
 * まだの人は「@名前」と書くだけにする
 */
export async function chatMention(db: D1Database, email: string, fallbackName?: string) {
  const u = await db.prepare("SELECT google_sub, name FROM users WHERE lower(email) = lower(?)").bind(email).first<{ google_sub: string | null; name: string }>();
  return u?.google_sub ? `<users/${u.google_sub}>` : `@${fallbackName || u?.name || email}`;
}

export function jstNow(at = Date.now()) {
  const d = new Date(at + 9 * 3600_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { date: d.toISOString().slice(0, 10), month: d.toISOString().slice(0, 7), y, m, day, hour: d.getUTCHours(), isLastDay: day === lastDay };
}

/** YYYY-MM の前月・翌月 */
export function shiftMonth(period: string, n: number) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
