// 毎日20時の「今日の AIの鉄人」: その日の会議・ネクストアクション・期限が近いタスクを議事録スペースに送る
// 本文は D1 から組み立てる（AI は使わない。2026-10-31 に Haiku の「今日の動き」をやめた）
import type { DocRow } from "./minutes";
import { digestText, whenLabel, type MinutesTask } from "./minutes-text";
import { listTasks } from "./tasks";
import { sendChat } from "./notify";
import { getSettings } from "./settings";

/** 日本時間のその日に行われた（取り込みが済んだ）会議 */
async function meetingsOn(db: D1Database, date: string) {
  const start = new Date(`${date}T00:00:00+09:00`).toISOString();
  const end = new Date(Date.parse(start) + 86400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT d.*, u.name AS recorder_name FROM documents d LEFT JOIN users u ON u.id = d.recorded_by
        WHERE d.status = 'done'
          AND ((d.started_at >= ? AND d.started_at < ?)
            OR (d.started_at IS NULL AND d.meeting_date = ?)
            OR (d.started_at IS NULL AND d.meeting_date IS NULL AND d.created_at >= ? AND d.created_at < ?))
        ORDER BY COALESCE(d.started_at, d.created_at)`,
    )
    .bind(start, end, date, start, end)
    .all<DocRow>();
  return results;
}

export async function minutesDigest(env: Env, date: string): Promise<string> {
  const db = env.DB;
  const docs = await meetingsOn(db, date);
  if (!docs.length) return "今日の会議はありません（送りませんでした）";
  const ids = new Set(docs.map((d) => d.id));
  const placeholders = docs.map(() => "?").join(",");
  const { results: actions } = await db
    .prepare(
      `SELECT t.title, t.due_on, t.assignee_name, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
        WHERE t.status = 'open' AND t.document_id IN (${placeholders}) ORDER BY t.due_on IS NULL, t.due_on`,
    )
    .bind(...ids)
    .all<MinutesTask>();
  const soon = new Date(Date.parse(date) + 2 * 86400_000).toISOString().slice(0, 10);
  const dueSoon = (await listTasks(db, { status: "open", dueBefore: soon }))
    .filter((t) => !ids.has(String(t.document_id ?? "")))
    .map((t) => ({ title: String(t.title), due_on: (t.due_on as string) ?? null, assignee: (t.assignee as string) ?? null, assignee_name: (t.assignee_name as string) ?? "" }));
  const appUrl = (await getSettings(db)).app_url;
  const text = digestText({
    date,
    meetings: docs.map((d) => ({ title: d.title, when: whenLabel(d), recorder: d.recorder_name ?? null, summary: d.summary })),
    actions,
    dueSoon,
    appUrl: appUrl ? `${appUrl}/minutes` : undefined,
  });
  if (!text) return "今日の会議はありません（送りませんでした）";
  const ok = await sendChat(env, text, "minutes");
  return ok ? `会議 ${docs.length}件のまとめを議事録スペースに送りました` : `Google Chat が未設定か、送信に失敗しました:\n${text}`;
}
