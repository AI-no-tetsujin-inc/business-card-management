// 契約・サブスク管理: 会社で契約しているサービスの一覧。方針として会社名義・法人カードに統一する
import type { Context, Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso, uuid } from "./people";
import { chatMention, jstNow, sendChat } from "./notify";
import { getSettings } from "./settings";
import { jpDate } from "./templates";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const FIELDS = ["service_name", "holder", "payment_method", "amount", "cycle", "renewal_date", "accounts", "admin_email", "migration_status", "migration_month", "note"] as const;

export const isPersonal = (s: { holder: string; payment_method: string }) => s.holder === "personal" || s.payment_method === "personal";

function validate(b: Record<string, unknown>): string | null {
  if (!String(b.service_name ?? "").trim()) return "サービス名を入力してください";
  if (FIELDS.some((k) => String(b[k] ?? "").length > (k === "note" || k === "accounts" ? 2000 : 200))) return "入力が長すぎます";
  if (!["company", "personal"].includes(String(b.holder))) return "契約名義を選んでください";
  if (!["corporate_card", "personal"].includes(String(b.payment_method))) return "支払い方法を選んでください";
  if (!["monthly", "yearly"].includes(String(b.cycle))) return "月額か年額かを選んでください";
  if (b.amount !== null && b.amount !== "" && b.amount !== undefined && !Number.isInteger(Number(b.amount))) return "金額は整数（円）で入力してください";
  if (b.renewal_date && !DATE.test(String(b.renewal_date))) return "更新日の形式が不正です";
  if (b.migration_month && !MONTH.test(String(b.migration_month))) return "移行予定月の形式が不正です";
  return null;
}

const nextRenewal = (date: string, cycle: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  if (cycle === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/** 毎日9時: 更新日が近いサブスクを通知し、過ぎた更新日を次回に進める */
export async function subscriptionNotices(env: Env): Promise<string> {
  const db = env.DB;
  const settings = await getSettings(db);
  const days = Number(settings.subscription_notice_days || 7);
  const today = jstNow().date;
  // 過ぎた更新日を次回分に進める
  const { results: past } = await db.prepare("SELECT id, renewal_date, cycle FROM subscriptions WHERE active = 1 AND renewal_date < ?").bind(today).all<{ id: string; renewal_date: string; cycle: string }>();
  for (const s of past) {
    let next = s.renewal_date;
    while (next < today) next = nextRenewal(next, s.cycle);
    await db.prepare("UPDATE subscriptions SET renewal_date = ? WHERE id = ?").bind(next, s.id).run();
  }
  const target = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
  const { results } = await db.prepare("SELECT * FROM subscriptions WHERE active = 1 AND renewal_date = ?").bind(target).all<Record<string, string | number | null>>();
  if (!results.length) return "通知するサブスクはありません";
  const lines = results.map(
    (s) =>
      `・${s.service_name}（${s.cycle === "yearly" ? "年額" : "月額"}${s.amount ? ` ¥${Number(s.amount).toLocaleString("ja-JP")}` : ""}）${isPersonal(s as never) ? " ⚠️個人名義・個人立替" : ""}`,
  );
  await sendChat(
    env,
    `${await chatMention(db, settings.billing_admin_email)}\n📅 *サブスクの更新日が${days}日後（${jpDate(target)}）です*\n${lines.join("\n")}\n解約・プラン変更・名義移行が必要なら、更新日までに対応してください。`,
  );
  return `${results.length}件を通知しました`;
}

const canWrite = (c: Context<AppEnv>) => c.get("user").role !== "viewer";

export function registerSubscriptionRoutes(api: Hono<AppEnv>) {
  api.get("/subscriptions", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT s.*, u.name AS admin_name FROM subscriptions s LEFT JOIN users u ON u.email = s.admin_email
        ORDER BY s.active DESC, (s.holder = 'personal' OR s.payment_method = 'personal') DESC, s.renewal_date IS NULL, s.renewal_date, s.service_name`,
    ).all();
    return c.json({ subscriptions: results });
  });

  const save = async (c: Context<AppEnv>, id?: string) => {
    if (!canWrite(c)) return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
    const b = await c.req.json<Record<string, unknown>>();
    const err = validate(b);
    if (err) return c.json({ error: err }, 400);
    const vals = FIELDS.map((k) => {
      const v = b[k];
      if (k === "amount") return v === "" || v === null || v === undefined ? null : Number(v);
      if (k === "renewal_date" || k === "migration_month") return v ? String(v) : null;
      return String(v ?? "").trim();
    });
    if (!["none", "planned", "done"].includes(String(vals[8]))) vals[8] = "none";
    if (id) {
      await c.env.DB.prepare(`UPDATE subscriptions SET ${FIELDS.map((k) => `${k} = ?`).join(", ")}, active = ?, updated_at = ? WHERE id = ?`)
        .bind(...vals, b.active === false ? 0 : 1, nowIso(), id)
        .run();
    } else {
      id = uuid();
      await c.env.DB.prepare(`INSERT INTO subscriptions (id, ${FIELDS.join(", ")}, created_at) VALUES (?, ${FIELDS.map(() => "?").join(", ")}, ?)`)
        .bind(id, ...vals, nowIso())
        .run();
    }
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "subscription_save", targetType: "subscription", targetId: id });
    return c.json({ id });
  };
  api.post("/subscriptions", (c) => save(c));
  api.patch("/subscriptions/:id", (c) => save(c, c.req.param("id")));
}
