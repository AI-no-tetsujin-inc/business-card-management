// Google カレンダー連携: 各自が自分のカレンダーを連携すると、その人に関係する期限を終日の予定として入れる。
// 入れる予定（その人に関係するものだけ）:
//   顧客請求の担当者 … 請求書の作成開始（15日）・入金期日（翌月末）
//   社内請求の対象者 … 提出期限（翌月2日）・支払日（翌月5日）・領収書の原本の提出（月末。未提出があるとき）
//   代表（精算する人） … 社内請求の支払い（翌月5日）
//   サブスクの管理者 … 更新日
// 内容が変わったものだけ更新し、要らなくなった予定は消す（1時間ごと・連携した直後・「今すぐ反映」）
import type { Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso } from "./people";
import { openToken, sealToken } from "./google-link";
import { jstNow, shiftMonth } from "./notify";
import { getSettings } from "./settings";
import { buildLines, yen } from "./billing";
import { deadlineOf } from "./internal";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** 何日先までの予定を入れるか */
const HORIZON_DAYS = 100;

interface CalendarLink {
  user_email: string;
  refresh_token_enc: string;
  scopes: string;
  app_url: string;
  linked_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface DesiredEvent {
  key: string;
  date: string;
  summary: string;
  description: string;
  path: string;
}

const lastDayOf = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const monthNo = (period: string) => Number(period.slice(5, 7));

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Google カレンダーの予定 ID（英小文字 a〜v と数字だけ。人と予定の種類ごとに固定） */
const eventIdOf = async (email: string, key: string) => `ms${(await sha256hex(`${email}|${key}`)).slice(0, 40)}`;

// ---------- その人に入れる予定を組み立てる ----------

export async function desiredEvents(db: D1Database, email: string): Promise<DesiredEvent[]> {
  const today = jstNow().date;
  const thisMonth = today.slice(0, 7);
  const months = [-1, 0, 1, 2].map((n) => shiftMonth(thisMonth, n));
  const settings = await getSettings(db);
  const out: DesiredEvent[] = [];

  // 顧客請求の担当
  const { results: customers } = await db
    .prepare("SELECT id, name, delivery_to, contact_via FROM customers WHERE active = 1 AND lower(owner_email) = ? ORDER BY sort_order, name")
    .bind(email)
    .all<{ id: string; name: string; delivery_to: string; contact_via: string }>();
  for (const p of months) {
    const items: { name: string; total: number; status: string | null; line: string }[] = [];
    for (const c of customers) {
      const inv = await db.prepare("SELECT status, total FROM customer_invoices WHERE customer_id = ? AND period = ?").bind(c.id, p).first<{ status: string; total: number }>();
      const total = inv ? Number(inv.total) : (await buildLines(db, c.id, p)).total;
      if (!inv && total <= 0) continue;
      items.push({ name: c.name, total, status: inv?.status ?? null, line: `・${c.name}　${yen(total)}（送付先: ${c.delivery_to || "—"} ／ 連絡: ${c.contact_via || "—"}）` });
    }
    if (!items.length) continue;
    const m = monthNo(p);
    const names = items.map((i) => i.name.replace(/株式会社/g, "").trim()).join("・");
    const allCreated = items.every((i) => i.status && i.status !== "draft");
    const allDone = items.every((i) => i.status === "contacted");
    out.push({
      key: `invoice-start:${p}`,
      date: `${p}-15`,
      summary: `${allCreated ? "【済】" : ""}請求書の作成（${m}月分）: ${names}`,
      description: `${m}月分の顧客請求書を作成し、送付・連絡してください。\n\n${items.map((i) => i.line).join("\n")}`,
      path: `/billing?tab=month&period=${p}`,
    });
    out.push({
      key: `invoice-due:${p}`,
      date: lastDayOf(shiftMonth(p, 1)),
      summary: `入金期日（${m}月分）: ${names} ${yen(items.reduce((s, i) => s + i.total, 0))}`,
      description: `${m}月分の顧客請求書の振込期日です。${allDone ? "" : "\n（送付・連絡がまだの請求書があります）"}\n\n${items.map((i) => i.line).join("\n")}`,
      path: `/billing?tab=month&period=${p}`,
    });
  }

  // 社内請求の対象（稼働分・立替経費を出す人）
  const member = await db.prepare("SELECT email, display_name FROM internal_members WHERE active = 1 AND lower(email) = ?").bind(email).first<{ email: string; display_name: string }>();
  if (member) {
    for (const p of months) {
      const m = monthNo(p);
      const work = await db.prepare("SELECT 1 FROM internal_claims WHERE member_email = ? AND period = ? AND kind = 'work'").bind(member.email, p).first();
      out.push({
        key: `claim-deadline:${p}`,
        date: deadlineOf(p),
        summary: `${work ? "【済】" : ""}社内請求の提出期限（${m}月分の稼働分・立替経費）`,
        description: `${m}月分の稼働分と立替経費の請求書を、今日までに発行してください（月末締め・翌月5日払い）。`,
        path: "/internal",
      });
      out.push({
        key: `claim-pay:${p}`,
        date: `${shiftMonth(p, 1)}-05`,
        summary: `社内請求の支払日（${m}月分）`,
        description: `${m}月分の稼働分・立替経費が支払われる日です。`,
        path: "/internal",
      });
    }
    const pending = await db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM receipts WHERE member_email = ? AND original_submitted_at IS NULL")
      .bind(member.email)
      .first<{ n: number; total: number }>();
    if (pending && pending.n > 0) {
      out.push({
        key: `receipt-original:${thisMonth}`,
        date: lastDayOf(thisMonth),
        summary: `領収書の原本を提出（${pending.n}件・${yen(Number(pending.total))}）`,
        description: "まだ原本を渡していない領収書があります。手渡しで提出し、受け取った人がアプリで「原本提出済み」にチェックしてください。",
        path: "/internal",
      });
    }
  }

  // 代表（社内請求を支払う人）
  if (email === String(settings.claim_payer_email ?? "").toLowerCase()) {
    for (const p of months) {
      const m = monthNo(p);
      const { results: claims } = await db
        .prepare("SELECT c.kind, c.total, c.status, m.display_name FROM internal_claims c JOIN internal_members m ON m.email = c.member_email WHERE c.period = ? ORDER BY m.number_suffix DESC, c.kind DESC")
        .bind(p)
        .all<{ kind: string; total: number; status: string; display_name: string }>();
      const allPaid = claims.length > 0 && claims.every((c) => c.status === "paid");
      out.push({
        key: `claim-payout:${p}`,
        date: `${shiftMonth(p, 1)}-05`,
        summary: `${allPaid ? "【済】" : ""}社内請求の支払い（${m}月分）${claims.length ? ` ${yen(claims.reduce((s, c) => s + Number(c.total), 0))}` : ""}`,
        description: claims.length
          ? `${m}月分の社内請求の支払日です。\n\n${claims.map((c) => `・${c.display_name} ${c.kind === "work" ? "稼働分" : "立替経費"} ${yen(Number(c.total))}${c.status === "paid" ? "（精算済み）" : ""}`).join("\n")}`
          : `${m}月分の社内請求の支払日です（まだ提出された請求はありません）。`,
        path: "/internal",
      });
    }
  }

  // サブスクの管理者
  const { results: subs } = await db
    .prepare("SELECT id, service_name, amount, cycle, renewal_date FROM subscriptions WHERE active = 1 AND lower(admin_email) = ? AND renewal_date IS NOT NULL")
    .bind(email)
    .all<{ id: string; service_name: string; amount: number | null; cycle: string; renewal_date: string }>();
  for (const s of subs) {
    out.push({
      key: `sub-renewal:${s.id}`,
      date: s.renewal_date,
      summary: `サブスク更新: ${s.service_name}${s.amount ? `（${yen(Number(s.amount))}／${s.cycle === "yearly" ? "年" : "月"}）` : ""}`,
      description: `${s.service_name} の更新日です。解約・プラン変更・名義の移行が必要なら、この日までに対応してください。`,
      path: "/subscriptions",
    });
  }

  const until = addDays(today, HORIZON_DAYS);
  return out.filter((e) => e.date >= today && e.date <= until).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Google カレンダーへの反映 ----------

const tokenCache = new Map<string, { token: string; exp: number }>();

async function accessToken(env: Env, link: CalendarLink) {
  const cached = tokenCache.get(link.user_email);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await openToken(env.GOOGLE_CLIENT_SECRET, link.refresh_token_enc),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.includes("invalid_grant") ? "カレンダーの連携が切れています。プロフィールの「Google カレンダーと連携」からもう一度許可してください" : `Google の認証に失敗しました（${res.status}）`);
  }
  const data = await res.json<{ access_token: string; expires_in: number }>();
  tokenCache.set(link.user_email, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

/** Google の返したエラーを、利用者が対応できる言葉にする */
async function apiError(res: Response) {
  const text = await res.text();
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project/.test(text)) return "Google Cloud で「Google Calendar API」が有効になっていません。管理者が有効にしてください";
  if (res.status === 401 || res.status === 403) return `カレンダーに書き込む許可がありません（${res.status}）。プロフィールからもう一度連携してください`;
  return `Google カレンダーへの反映に失敗しました（${res.status}）: ${text.slice(0, 160)}`;
}

function eventBody(id: string, e: DesiredEvent, appUrl: string) {
  const url = appUrl ? `${appUrl}${e.path}` : "";
  return {
    id,
    status: "confirmed",
    summary: e.summary,
    description: `${e.description}${url ? `\n\n開く: ${url}` : ""}\n\n（名刺管理アプリが自動で入れた予定です）`,
    start: { date: e.date },
    end: { date: addDays(e.date, 1) },
    // 終日の期限なので、ほかの予定の空き時間には影響させない
    transparency: "transparent",
    // 前日の 9 時に通知
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 * 60 }] },
    ...(url && /^https?:\/\//.test(url) ? { source: { title: "名刺管理（AIの鉄人）", url } } : {}),
    extendedProperties: { private: { meishi: e.key } },
  };
}

/** 1人分を反映する。内容が変わった予定だけ Google に送る */
export async function syncCalendar(env: Env, email: string): Promise<{ changed: number; removed: number }> {
  const db = env.DB;
  const link = await db.prepare("SELECT * FROM calendar_links WHERE user_email = ?").bind(email).first<CalendarLink>();
  if (!link) return { changed: 0, removed: 0 };
  const today = jstNow().date;
  const desired = await desiredEvents(db, email);
  const { results: stored } = await db.prepare("SELECT key, event_id, hash, date FROM calendar_events WHERE user_email = ?").bind(email).all<{ key: string; event_id: string; hash: string; date: string }>();
  const storedBy = new Map(stored.map((s) => [s.key, s]));
  const upserts: { e: DesiredEvent; hash: string }[] = [];
  for (const e of desired) {
    const hash = (await sha256hex(JSON.stringify([e.date, e.summary, e.description, link.app_url]))).slice(0, 16);
    if (storedBy.get(e.key)?.hash !== hash) upserts.push({ e, hash });
  }
  const wanted = new Set(desired.map((e) => e.key));
  // これから先の日付なのに要らなくなった予定（顧客の担当が変わった・サブスクをやめた など）は消す
  const removals = stored.filter((s) => !wanted.has(s.key) && s.date >= today);
  // 過ぎた予定の記録は30日で片付ける（カレンダーの予定はそのまま残す）
  await db.prepare("DELETE FROM calendar_events WHERE user_email = ? AND date < ?").bind(email, addDays(today, -30)).run();

  if (!upserts.length && !removals.length) {
    await db.prepare("UPDATE calendar_links SET last_sync_at = ?, last_error = NULL, last_error_at = NULL WHERE user_email = ?").bind(nowIso(), email).run();
    return { changed: 0, removed: 0 };
  }
  try {
    const headers = { authorization: `Bearer ${await accessToken(env, link)}`, "content-type": "application/json" };
    for (const { e, hash } of upserts) {
      const id = await eventIdOf(email, e.key);
      const body = JSON.stringify(eventBody(id, e, link.app_url));
      // あれば上書き（消された予定も元に戻る）、なければ作る
      let res = await fetch(`${API}/${id}`, { method: "PUT", headers, body });
      if (res.status === 404) res = await fetch(API, { method: "POST", headers, body });
      if (!res.ok) throw new Error(await apiError(res));
      await db
        .prepare("INSERT OR REPLACE INTO calendar_events (user_email, key, event_id, hash, date) VALUES (?, ?, ?, ?, ?)")
        .bind(email, e.key, id, hash, e.date)
        .run();
    }
    for (const s of removals) {
      const res = await fetch(`${API}/${s.event_id}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(await apiError(res));
      await db.prepare("DELETE FROM calendar_events WHERE user_email = ? AND key = ?").bind(email, s.key).run();
    }
    await db.prepare("UPDATE calendar_links SET last_sync_at = ?, last_error = NULL, last_error_at = NULL WHERE user_email = ?").bind(nowIso(), email).run();
    return { changed: upserts.length, removed: removals.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.prepare("UPDATE calendar_links SET last_error = ?, last_error_at = ? WHERE user_email = ?").bind(msg, nowIso(), email).run();
    throw err;
  }
}

/** 定期処理: 連携している全員分を反映する */
export async function syncAllCalendars(env: Env) {
  const { results } = await env.DB.prepare("SELECT user_email FROM calendar_links").all<{ user_email: string }>();
  if (!results.length) return "カレンダーを連携している人はいません";
  const lines: string[] = [];
  for (const r of results) {
    try {
      const s = await syncCalendar(env, r.user_email);
      lines.push(`${r.user_email}: ${s.changed + s.removed ? `更新 ${s.changed} 件・削除 ${s.removed} 件` : "変更なし"}`);
    } catch (e) {
      lines.push(`${r.user_email}: 失敗（${e instanceof Error ? e.message : e}）`);
    }
  }
  return lines.join("\n");
}

export async function saveCalendarLink(env: Env, p: { email: string; refreshToken: string; scopes: string; appUrl: string }) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO calendar_links (user_email, refresh_token_enc, scopes, app_url, linked_at, last_sync_at, last_error, last_error_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  )
    .bind(p.email, await sealToken(env.GOOGLE_CLIENT_SECRET, p.refreshToken), p.scopes, p.appUrl, nowIso())
    .run();
  tokenCache.delete(p.email);
}

/** 連携を解除する。removeEvents なら、これから先の予定もカレンダーから消す */
async function unlinkCalendar(env: Env, email: string, removeEvents: boolean) {
  const db = env.DB;
  const link = await db.prepare("SELECT * FROM calendar_links WHERE user_email = ?").bind(email).first<CalendarLink>();
  if (!link) return { removed: 0 };
  let removed = 0;
  try {
    const token = await accessToken(env, link);
    if (removeEvents) {
      const { results } = await db.prepare("SELECT event_id FROM calendar_events WHERE user_email = ? AND date >= ?").bind(email, jstNow().date).all<{ event_id: string }>();
      for (const r of results) {
        const res = await fetch(`${API}/${r.event_id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
        if (res.ok || res.status === 404 || res.status === 410) removed++;
      }
    }
    // Google 側の許可も取り消す
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: await openToken(env.GOOGLE_CLIENT_SECRET, link.refresh_token_enc) }),
    });
  } catch {
    /* 連携が切れていても、手元の情報は消す */
  }
  await db.batch([db.prepare("DELETE FROM calendar_events WHERE user_email = ?").bind(email), db.prepare("DELETE FROM calendar_links WHERE user_email = ?").bind(email)]);
  tokenCache.delete(email);
  return { removed };
}

// ---------- 画面用 API ----------

export function registerCalendarRoutes(api: Hono<AppEnv>) {
  // 自分の連携状況と、入る予定（連携前でも見られる）
  api.get("/calendar", async (c) => {
    const email = c.get("user").email.toLowerCase();
    const link = await c.env.DB.prepare("SELECT user_email, linked_at, last_sync_at, last_error, last_error_at FROM calendar_links WHERE user_email = ?").bind(email).first();
    const upcoming = (await desiredEvents(c.env.DB, email)).map((e) => ({ date: e.date, summary: e.summary }));
    return c.json({ linked: Boolean(link), link, upcoming, configured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) });
  });

  api.post("/calendar/sync", async (c) => {
    const email = c.get("user").email.toLowerCase();
    try {
      return c.json(await syncCalendar(c.env, email));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  api.delete("/calendar", async (c) => {
    const user = c.get("user");
    const r = await unlinkCalendar(c.env, user.email.toLowerCase(), c.req.query("remove_events") === "1");
    await audit(c.env.DB, { userId: user.id, via: "web", action: "calendar_unlink", detail: r });
    return c.json({ ok: true, ...r });
  });
}
