// 段階3: タスク管理（議事録・AI・画面から登録、期限前に Google Chat でリマインド）
import type { Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso, uuid, type Via } from "./people";
import { jstToday } from "./notify";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface TaskInput {
  title: string;
  detail?: string;
  assigneeUserId?: string | null;
  assigneeName?: string;
  dueOn?: string | null;
  cardId?: string | null;
  companyName?: string;
  source: Via;
  documentId?: string | null;
  confidence?: number | null;
  createdBy: string | null;
}

/** 名前から社員を探す（「甲野」→「甲野 省吾」のような部分一致も可） */
export async function resolveAssignee(db: D1Database, name: string): Promise<string | null> {
  const key = name.normalize("NFKC").replace(/\s|さん|様|くん|君/g, "");
  if (!key) return null;
  const { results } = await db.prepare("SELECT id, name FROM users WHERE active = 1 AND registered = 1").all<{ id: string; name: string }>();
  const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
  const exact = results.find((u) => norm(u.name) === key);
  if (exact) return exact.id;
  const partial = results.filter((u) => norm(u.name).includes(key) || key.includes(norm(u.name)));
  return partial.length === 1 ? partial[0].id : null;
}

export function createTaskStatement(db: D1Database, t: TaskInput) {
  const id = uuid();
  return {
    id,
    stmt: db
      .prepare(
        `INSERT INTO tasks (id, title, detail, assignee_user_id, assignee_name, due_on, card_id, company_name, source, document_id, confidence, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        t.title.trim(),
        (t.detail ?? "").trim(),
        t.assigneeUserId ?? null,
        t.assigneeName ?? "",
        t.dueOn && DATE.test(t.dueOn) ? t.dueOn : null,
        t.cardId ?? null,
        t.companyName ?? "",
        t.source,
        t.documentId ?? null,
        t.confidence ?? null,
        t.createdBy,
        nowIso(),
      ),
  };
}

const TASK_SELECT = `
  SELECT t.*, ua.name AS assignee, c.person_name AS person_name, c.company_name AS person_company, d.title AS document_title
    FROM tasks t
    LEFT JOIN users ua ON ua.id = t.assignee_user_id
    LEFT JOIN cards c ON c.id = t.card_id
    LEFT JOIN documents d ON d.id = t.document_id`;

export async function listTasks(db: D1Database, f: { assignee?: string; status?: "open" | "done" | "all"; dueBefore?: string }) {
  const where: string[] = [];
  const binds: string[] = [];
  if (f.assignee) {
    where.push("t.assignee_user_id = ?");
    binds.push(f.assignee);
  }
  if (f.status && f.status !== "all") {
    where.push("t.status = ?");
    binds.push(f.status);
  }
  if (f.dueBefore) {
    where.push("t.due_on IS NOT NULL AND t.due_on <= ?");
    binds.push(f.dueBefore);
  }
  const { results } = await db
    .prepare(
      `${TASK_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.status, CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END, t.due_on, t.created_at DESC LIMIT 500`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return results;
}

export async function setTaskDone(db: D1Database, id: string, userId: string, done: boolean) {
  const r = await db
    .prepare("UPDATE tasks SET status = ?, done_at = ?, done_by = ? WHERE id = ?")
    .bind(done ? "done" : "open", done ? nowIso() : null, done ? userId : null, id)
    .run();
  return r.meta.changes > 0;
}

export function registerTaskRoutes(api: Hono<AppEnv>) {
  api.get("/tasks", async (c) => {
    const user = c.get("user");
    const scope = c.req.query("scope") ?? "mine";
    const status = (c.req.query("status") ?? "open") as "open" | "done" | "all";
    return c.json({ tasks: await listTasks(c.env.DB, { assignee: scope === "mine" ? user.id : undefined, status }) });
  });

  api.post("/tasks", async (c) => {
    const user = c.get("user");
    const b = await c.req.json<{ title: string; detail?: string; assignee_user_id?: string; due_on?: string; card_id?: string }>();
    if (!b.title?.trim()) return c.json({ error: "タスクの内容を入力してください" }, 400);
    const { id, stmt } = createTaskStatement(c.env.DB, {
      title: b.title,
      detail: b.detail,
      assigneeUserId: b.assignee_user_id || null,
      dueOn: b.due_on,
      cardId: b.card_id || null,
      source: "web",
      createdBy: user.id,
    });
    await stmt.run();
    await audit(c.env.DB, { userId: user.id, via: "web", action: "task_create", targetType: "task", targetId: id });
    return c.json({ id });
  });

  api.patch("/tasks/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const b = await c.req.json<{ title?: string; detail?: string; assignee_user_id?: string | null; due_on?: string | null; done?: boolean }>();
    if (b.done !== undefined && !(await setTaskDone(c.env.DB, id, user.id, b.done))) return c.json({ error: "見つかりません" }, 404);
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (typeof b.title === "string" && b.title.trim()) sets.push("title = ?"), binds.push(b.title.trim());
    if (typeof b.detail === "string") sets.push("detail = ?"), binds.push(b.detail.trim());
    if (b.assignee_user_id !== undefined) sets.push("assignee_user_id = ?"), binds.push(b.assignee_user_id || null);
    if (b.due_on !== undefined) sets.push("due_on = ?"), binds.push(b.due_on && DATE.test(b.due_on) ? b.due_on : null);
    if (sets.length) await c.env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    await audit(c.env.DB, { userId: user.id, via: "web", action: b.done ? "task_done" : "task_update", targetType: "task", targetId: id });
    return c.json({ ok: true });
  });
}

/** 毎日9時: 期限が2日以内・期限切れの未完了タスク */
export async function taskReminderText(db: D1Database): Promise<string | null> {
  const today = jstToday().date;
  const soon = new Date(Date.parse(today) + 2 * 86400_000).toISOString().slice(0, 10);
  const tasks = await listTasks(db, { status: "open", dueBefore: soon });
  if (!tasks.length) return null;
  const lines = tasks.map((t) => {
    const due = String(t.due_on);
    const mark = due < today ? "期限切れ" : due === today ? "今日まで" : `${Number(due.slice(5, 7))}/${Number(due.slice(8))}まで`;
    const who = (t.assignee as string) || (t.assignee_name as string) || "担当未定";
    return `・[${mark}] ${t.title}（${who}）`;
  });
  return `*期限が近いタスク*（${tasks.length}件）\n${lines.join("\n")}`;
}
