// 会社の詳細（人・案件・決定事項・契約と請求・タスク・最近のやり取り）
import type { Hono } from "hono";
import { companyKey } from "../shared/fields";
import type { AppEnv } from "./session";

export async function getCompany(db: D1Database, key: string) {
  const [people, deals, decisions, contracts, invoices, tasks, interactions] = await db.batch([
    db.prepare(
      `SELECT c.id, c.person_name, c.person_name_kana, c.department, c.title, c.email, c.phone, c.mobile, c.exchanged_on, u.name AS created_by_name
         FROM cards c JOIN users u ON u.id = c.created_by WHERE c.company_key = ? AND c.deleted_at IS NULL ORDER BY c.person_name_kana`,
    ).bind(key),
    db.prepare("SELECT * FROM deals WHERE company_key = ? ORDER BY COALESCE(updated_at, created_at) DESC").bind(key),
    db.prepare(
      `SELECT x.text, x.created_at, d.id AS document_id, d.title AS document_title, d.meeting_date FROM decisions x JOIN documents d ON d.id = x.document_id
        WHERE x.company_key = ? ORDER BY COALESCE(d.meeting_date, x.created_at) DESC LIMIT 30`,
    ).bind(key),
    db.prepare("SELECT * FROM contracts WHERE company_key = ? ORDER BY status, start_month DESC").bind(key),
    db.prepare(
      `SELECT i.id, i.period, i.total AS amount, i.status, i.number FROM customer_invoices i JOIN customers cu ON cu.id = i.customer_id
        WHERE cu.company_key = ? ORDER BY i.period DESC LIMIT 12`,
    ).bind(key),
    db.prepare(
      `SELECT t.id, t.title, t.due_on, t.status, ua.name AS assignee, t.assignee_name FROM tasks t
         LEFT JOIN users ua ON ua.id = t.assignee_user_id LEFT JOIN cards c ON c.id = t.card_id
        WHERE t.status = 'open' AND (c.company_key = ?1 OR (t.company_name != '' AND t.company_name LIKE ?2)) ORDER BY t.due_on LIMIT 50`,
    ).bind(key, `%${key}%`),
    db.prepare(
      `SELECT i.summary, i.happened_on, i.created_at, c.id AS card_id, c.person_name, d.id AS document_id, d.title AS document_title
         FROM interactions i JOIN cards c ON c.id = i.card_id LEFT JOIN documents d ON d.id = i.document_id
        WHERE c.company_key = ? ORDER BY COALESCE(i.happened_on, i.created_at) DESC LIMIT 20`,
    ).bind(key),
  ]);
  type Row = Record<string, string | number | null>;
  const name =
    (people.results as Row[]).map((p) => p).length > 0
      ? await db.prepare("SELECT company_name AS n FROM cards WHERE company_key = ? AND deleted_at IS NULL ORDER BY length(company_name) DESC LIMIT 1").bind(key).first<{ n: string }>()
      : await db.prepare("SELECT company_name AS n FROM contracts WHERE company_key = ? UNION SELECT company_name FROM deals WHERE company_key = ? LIMIT 1").bind(key, key).first<{ n: string }>();
  if (!name && !(people.results.length || deals.results.length || contracts.results.length)) return null;
  return {
    company_key: key,
    company_name: name?.n ?? key,
    people: people.results as Row[],
    deals: deals.results as Row[],
    decisions: decisions.results as Row[],
    contracts: contracts.results as Row[],
    recent_invoices: invoices.results as Row[],
    open_tasks: tasks.results as Row[],
    recent_interactions: interactions.results as Row[],
  };
}

export function registerCompanyRoutes(api: Hono<AppEnv>) {
  api.get("/company", async (c) => {
    const key = c.req.query("key") ?? companyKey(c.req.query("name") ?? "");
    const data = key ? await getCompany(c.env.DB, key) : null;
    return data ? c.json(data) : c.json({ error: "見つかりません" }, 404);
  });
}
