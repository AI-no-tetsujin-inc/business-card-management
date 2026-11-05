// A. 議事録の取り込み: Voiss（Mac の録音アプリ）・貼り付け・Drive のフォルダから届いた文字起こしを、
// Workflows で 取得 → 分割 → 抽出 → 保存 → Drive に保存 → 議事録スペースに通知 → 音声を保存 の順に処理する
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Hono } from "hono";
import { companyKey } from "../shared/fields";
import type { AppEnv } from "./session";
import { audit, findMatches, nowIso, uuid, EXACT_MATCHES } from "./people";
import { createTaskStatement, resolveAssignee } from "./tasks";
import { extractTasks, mergeExtractions, splitText, type Extraction } from "./extract";
import { driveConfigured, driveFolderUrl, ensureFolder, fetchFileText, googleReady, listMinutesFiles, uploadLargeToDrive, uploadToDrive } from "./google";
import { claimJob, sendChat } from "./notify";
import { BUDGET_USD, totalCost } from "./ai-usage";
import { emptyFields } from "../shared/fields";
import { getSettings, graphEnabled, setSettings } from "./settings";
import { driveText, meetingDateOf, minutesChatText, minutesFileStem, monthFolderOf, type MinutesDoc } from "./minutes-text";

const SYSTEM_USER = "system";
const VIA = "minutes";
export const textKey = (documentId: string) => `minutes/${documentId}.txt`;
export const audioKey = (documentId: string) => `minutes/${documentId}.audio`;

export interface DocRow extends MinutesDoc {
  drive_file_id: string;
  modified_time: string;
  status: string;
  error: string | null;
  title_auto: number;
  recorded_by: string | null;
  audio_key: string | null;
  audio_type: string | null;
  drive_folder_id: string | null;
  drive_text_id: string | null;
  drive_audio_id: string | null;
}

export interface WorkflowParams {
  documentId: string;
  /** アプリの URL（Chat の投稿にリンクを付ける）。定期処理から始めたときは無い */
  origin?: string;
  /** "audio" = あとから届いた音声を Drive に置くだけ */
  only?: "audio";
}

/** その議事録から作ったデータを消す（議事録が書き直されて取り込み直すとき） */
async function clearDocumentData(db: D1Database, documentId: string) {
  await db.batch([
    db.prepare("DELETE FROM decisions WHERE document_id = ?").bind(documentId),
    db.prepare("DELETE FROM relations WHERE document_id = ?").bind(documentId),
    db.prepare("DELETE FROM interactions WHERE document_id = ?").bind(documentId),
    db.prepare("DELETE FROM tasks WHERE document_id = ? AND status = 'open'").bind(documentId),
    db.prepare("DELETE FROM review_items WHERE document_id = ? AND status = 'open'").bind(documentId),
  ]);
}

export async function startWorkflow(env: Env, documentId: string, origin?: string) {
  await env.DB.prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ?").bind(documentId).run();
  await env.MINUTES_WORKFLOW.create({ id: `${documentId}-${Date.now()}`, params: { documentId, origin } });
}

/** 定期処理（毎日のまとめ）の投稿にアプリへのリンクを付けるため、アプリの URL を覚えておく */
export async function rememberAppUrl(env: Env, origin: string) {
  const settings = await getSettings(env.DB);
  if (settings.app_url !== origin) await setSettings(env.DB, { app_url: origin });
}

export async function startAudioWorkflow(env: Env, documentId: string) {
  await env.MINUTES_WORKFLOW.create({ id: `${documentId}-audio-${Date.now()}`, params: { documentId, only: "audio" } });
}

/** 利用額の累計が上限に達したら AI の自動処理を止める */
export async function overBudget(env: Env) {
  const cost = await totalCost(env.DB);
  if (cost < BUDGET_USD) return false;
  if (await claimJob(env.DB, "budget-stop")) {
    await sendChat(env, `AI の利用額の累計が $${cost.toFixed(2)} に達したため、議事録のタスクの抜き出しを止めました（上限 $${BUDGET_USD}）。文字起こしの保存と通知は続けます。`, "minutes");
  }
  return true;
}

/** Drive の取り込み用フォルダを確認し、新しい・更新された議事録の処理を始める */
export async function scanDrive(env: Env): Promise<string> {
  if (!driveConfigured(env)) return "Drive の取り込みが設定されていません（GOOGLE_SERVICE_ACCOUNT_JSON / DRIVE_FOLDER_ID）";
  if (await overBudget(env)) return "今月の AI 利用額が上限に近いため止めています";
  const files = await listMinutesFiles(env);
  let started = 0;
  for (const f of files) {
    const doc = await env.DB.prepare("SELECT * FROM documents WHERE drive_file_id = ?").bind(f.id).first<DocRow>();
    if (!doc) {
      const id = uuid();
      await env.DB.prepare("INSERT INTO documents (id, drive_file_id, title, modified_time, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, f.id, f.name, f.modifiedTime, nowIso())
        .run();
      await startWorkflow(env, id);
      started++;
    } else if (doc.modified_time !== f.modifiedTime && doc.status !== "processing") {
      await clearDocumentData(env.DB, doc.id);
      await env.DB.prepare("UPDATE documents SET title = ?, modified_time = ? WHERE id = ?").bind(f.name, f.modifiedTime, doc.id).run();
      await startWorkflow(env, doc.id);
      started++;
    }
  }
  return `${files.length}件を確認し、${started}件の取り込みを始めました`;
}

// ---------- 抽出結果のまとめと保存 ----------

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s/g, "");

/**
 * 抽出結果を保存する。人物は名刺交換した人（登録済みの人）だけ。議事録に出てきた人を新しく登録したり、確認依頼にしたりはしない。
 * 登録済みの人と確実に一致したときだけ「会議に出た」履歴を残す。graph（つながり）がオフのときは案件・つながりも作らない
 */
export async function saveExtraction(env: Env, documentId: string, ex: Extraction, opts: { graph: boolean } = { graph: true }) {
  const db = env.DB;
  const at = nowIso();
  const meetingDate = /^\d{4}-\d{2}-\d{2}$/.test(ex.meeting.date) ? ex.meeting.date : "";
  const stats = { people: 0, new_people: 0, reviews: 0, tasks: 0, decisions: 0, deals: 0, relations: 0 };
  const personNode = new Map<string, string>(); // 抽出した名前 → person:<card_id>
  const stmts: D1PreparedStatement[] = [];

  // 人物: 登録済みの人と確実に一致したときだけ、やり取りを記録する（一致しない人は何もしない）
  for (const p of ex.people.filter((p) => !p.internal && p.name)) {
    const fields = { ...emptyFields(), person_name: p.name, person_name_kana: p.kana, company_name: p.company, department: p.department, title: p.title, email: p.email, phone: p.phone };
    const sure = (await findMatches(db, fields)).find((m) => EXACT_MATCHES.includes(m.match) || m.match === "name_company");
    if (!sure) continue;
    stats.people++;
    personNode.set(norm(p.name), `person:${sure.id}`);
    stmts.push(
      db.prepare("INSERT INTO interactions (id, card_id, happened_on, kind, summary, document_id, created_at) VALUES (?, ?, ?, 'meeting', ?, ?, ?)")
        .bind(uuid(), sure.id, meetingDate || null, `「${ex.meeting.title}」${p.role ? `: ${p.role}` : ""}`, documentId, at),
    );
  }

  // 案件
  const dealNode = new Map<string, string>();
  for (const d of opts.graph ? ex.deals.filter((d) => d.company && d.name) : []) {
    const key = companyKey(d.company);
    const existing = await db.prepare("SELECT id FROM deals WHERE company_key = ? AND name = ?").bind(key, d.name).first<{ id: string }>();
    const id = existing?.id ?? uuid();
    stmts.push(
      existing
        ? db.prepare("UPDATE deals SET status = ?, amount = CASE WHEN ? != '' THEN ? ELSE amount END, document_id = ?, updated_at = ? WHERE id = ?")
            .bind(d.status, d.amount, d.amount, documentId, at, id)
        : db.prepare("INSERT INTO deals (id, company_name, company_key, name, status, amount, document_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(id, d.company, key, d.name, d.status, d.amount, documentId, at),
    );
    dealNode.set(norm(d.name), `deal:${id}`);
    stats.deals++;
  }

  // 決定事項
  for (const d of ex.decisions.filter((d) => d.text)) {
    stmts.push(
      db.prepare("INSERT INTO decisions (id, document_id, text, company_name, company_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(uuid(), documentId, d.text, d.company, d.company ? companyKey(d.company) : "", at),
    );
    stats.decisions++;
  }

  // タスク（ネクストアクション）
  for (const t of ex.tasks.filter((t) => t.title)) {
    const assigneeUserId = t.assignee ? await resolveAssignee(db, t.assignee) : null;
    const person = t.related_person ? personNode.get(norm(t.related_person)) : undefined;
    const { stmt } = createTaskStatement(db, {
      title: t.title,
      detail: t.evidence,
      assigneeUserId,
      assigneeName: assigneeUserId ? "" : t.assignee,
      dueOn: t.due_on,
      cardId: person ? person.slice("person:".length) : null,
      companyName: t.related_company,
      source: VIA,
      documentId,
      confidence: t.confidence,
      createdBy: SYSTEM_USER,
    });
    stmts.push(stmt);
    stats.tasks++;
  }

  if (opts.graph) {
    // つながり（両端がわかるものだけ）
    const nodeOf = (name: string, type: string) =>
      type === "person" ? personNode.get(norm(name)) : type === "company" ? (name ? `company:${companyKey(name)}` : undefined) : dealNode.get(norm(name));
    for (const r of ex.relations) {
      const from = nodeOf(r.from, r.from_type);
      const to = nodeOf(r.to, r.to_type);
      if (!from || !to || from === to) continue;
      stmts.push(
        db.prepare("INSERT INTO relations (id, from_node, to_node, kind, label, document_id, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(uuid(), from, to, r.kind, r.evidence.slice(0, 200), documentId, r.confidence, at),
      );
      stats.relations++;
    }
    // 案件と会社のつながり
    for (const d of ex.deals.filter((d) => d.company && d.name)) {
      const node = dealNode.get(norm(d.name));
      if (node)
        stmts.push(
          db.prepare("INSERT INTO relations (id, from_node, to_node, kind, label, document_id, confidence, created_at) VALUES (?, ?, ?, '案件', ?, ?, ?, ?)")
            .bind(uuid(), `company:${companyKey(d.company)}`, node, d.status, documentId, d.confidence, at),
        );
    }
  }

  // 仮のタイトル（Voiss の「録音 10/22 14:05」など）は、抜き出した会議名に置き換える
  const title = ex.meeting.title.trim().slice(0, 100);
  stmts.push(
    db.prepare(
      `UPDATE documents SET status = 'done', meeting_date = ?, summary = ?, stats = ?, processed_at = ?, error = NULL,
              title = CASE WHEN title_auto = 1 AND ? != '' THEN ? ELSE title END,
              title_auto = CASE WHEN title_auto = 1 AND ? != '' THEN 0 ELSE title_auto END
        WHERE id = ?`,
    ).bind(meetingDate || null, ex.meeting.summary, JSON.stringify(stats), at, title, title, title, documentId),
  );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stats;
}

async function extractionContext(db: D1Database) {
  const [emp, people, companies] = await db.batch([
    db.prepare("SELECT name FROM users WHERE registered = 1 AND active = 1"),
    db.prepare("SELECT person_name || '（' || company_name || '）' AS v FROM cards WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 300"),
    db.prepare("SELECT DISTINCT company_name AS v FROM cards WHERE deleted_at IS NULL AND company_name != '' LIMIT 300"),
  ]);
  return {
    employees: (emp.results as { name: string }[]).map((r) => r.name),
    knownPeople: (people.results as { v: string }[]).map((r) => r.v),
    knownCompanies: (companies.results as { v: string }[]).map((r) => r.v),
  };
}

const EMPTY_EXTRACTION: Extraction = { meeting: { title: "", date: "", summary: "" }, people: [], relations: [], decisions: [], tasks: [], deals: [] };

// ---------- 議事録を読む（画面・Chat・Drive・MCP で共通） ----------

export async function loadMinutes(db: D1Database, id: string) {
  const doc = await db
    .prepare("SELECT d.*, u.name AS recorder_name FROM documents d LEFT JOIN users u ON u.id = d.recorded_by WHERE d.id = ?")
    .bind(id)
    .first<DocRow>();
  if (!doc) return null;
  const [decisions, tasks, interactions, deals] = await db.batch([
    db.prepare("SELECT * FROM decisions WHERE document_id = ? ORDER BY created_at").bind(id),
    db.prepare("SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.document_id = ? ORDER BY t.due_on IS NULL, t.due_on, t.created_at").bind(id),
    db.prepare("SELECT i.*, c.person_name, c.company_name FROM interactions i JOIN cards c ON c.id = i.card_id WHERE i.document_id = ?").bind(id),
    db.prepare("SELECT * FROM deals WHERE document_id = ?").bind(id),
  ]);
  return {
    doc,
    decisions: decisions.results as { id: string; text: string; company_name: string }[],
    tasks: tasks.results as { id: string; title: string; assignee: string | null; assignee_name: string; due_on: string | null; status: string }[],
    people: interactions.results as { id: string; card_id: string; person_name: string; company_name: string; summary: string }[],
    deals: deals.results as { id: string; company_name: string; name: string; status: string; amount: string }[],
  };
}

/** 全文（R2 の控え）。無ければ空文字 */
export async function minutesTranscript(env: Env, id: string) {
  return (await (await env.IMAGES.get(textKey(id)))?.text()) ?? "";
}

/** Drive 上の場所（Voiss・貼り付けは議事録フォルダ、Drive から取り込んだものは元のファイル） */
export function driveLinkOf(doc: Pick<DocRow, "drive_folder_id" | "drive_file_id">) {
  if (doc.drive_folder_id) return driveFolderUrl(doc.drive_folder_id);
  if (!/^(manual|voiss):/.test(doc.drive_file_id)) return `https://drive.google.com/file/d/${doc.drive_file_id}/view`;
  return null;
}

/** 文字起こしの全文（冒頭に会議の情報とネクストアクション）を、共有ドライブの「議事録/YYYY年M月/YYYYMMDD_タイトル/」に置く。AI は使わない */
async function saveMinutesToDrive(env: Env, documentId: string, origin?: string): Promise<string | null> {
  if (!(await googleReady(env))) return "Google と連携していないため、Drive には保存していません（管理画面の「Google と連携」）";
  const data = await loadMinutes(env.DB, documentId);
  if (!data) throw new Error("議事録の記録が見つかりません");
  const { doc } = data;
  const stem = minutesFileStem(doc);
  const folderId =
    doc.drive_folder_id ?? (await ensureFolder(env, (await getSettings(env.DB)).drive_parent_id, ["議事録", monthFolderOf(meetingDateOf(doc)), stem]));
  const text = driveText(doc, data.decisions, data.tasks, await minutesTranscript(env, documentId), origin ? `${origin}/minutes/${documentId}` : undefined);
  const fileId = await uploadToDrive(env, folderId, `${stem}.txt`, "text/plain; charset=utf-8", new TextEncoder().encode(text));
  await env.DB.prepare("UPDATE documents SET drive_folder_id = ?, drive_text_id = ? WHERE id = ?").bind(folderId, fileId, documentId).run();
  return null;
}

/** R2 に届いている音声を、文字起こしと同じフォルダに置く（置いたら R2 からは消す）。まだフォルダが無ければ何もしない */
async function saveAudio(env: Env, documentId: string): Promise<string> {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(documentId).first<DocRow>();
  if (!doc?.audio_key) return "音声はまだ届いていません";
  if (!doc.drive_folder_id) return "Drive のフォルダがまだ無いため、あとで置きます";
  const obj = await env.IMAGES.get(doc.audio_key);
  if (!obj) return "音声は置き済みです";
  const ext = doc.audio_type === "audio/wav" ? "wav" : "m4a";
  const fileId = await uploadLargeToDrive(env, doc.drive_folder_id, `${minutesFileStem(doc)}.${ext}`, doc.audio_type ?? "audio/mp4", obj.body, obj.size);
  await env.DB.prepare("UPDATE documents SET drive_audio_id = ?, audio_key = NULL WHERE id = ?").bind(fileId, documentId).run();
  await env.IMAGES.delete(doc.audio_key);
  return "音声を Drive に置きました";
}

async function notifyMinutes(env: Env, documentId: string, origin: string | undefined, note?: string) {
  const data = await loadMinutes(env.DB, documentId);
  if (!data) return;
  const text = minutesChatText(data.doc, data.decisions, data.tasks, { drive: driveLinkOf(data.doc), app: origin ? `${origin}/minutes/${documentId}` : null }, note);
  await sendChat(env, text, "minutes");
  await env.DB.prepare("UPDATE documents SET notified_at = ? WHERE id = ?").bind(nowIso(), documentId).run();
}

// ---------- Workflow ----------

export class MinutesWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { documentId, origin, only } = event.payload;
    if (only === "audio") {
      await step.do("音声を保存", { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "10 minutes" }, () => saveAudio(this.env, documentId));
      return;
    }
    try {
      const meta = await step.do("本文を取得", { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } }, async () => {
        const doc = await this.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(documentId).first<DocRow>();
        if (!doc) throw new Error("議事録の記録が見つかりません");
        const base = { source: doc.source, meetingDate: doc.started_at ? meetingDateOf(doc) : "" };
        if (/^(manual|voiss):/.test(doc.drive_file_id)) {
          const obj = await this.env.IMAGES.get(textKey(documentId));
          if (!obj) throw new Error("文字起こしの本文が見つかりません");
          return { ...base, title: doc.title };
        }
        const { name, text } = await fetchFileText(this.env, doc.drive_file_id);
        await this.env.IMAGES.put(textKey(documentId), text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
        return { ...base, title: name };
      });

      const prep = await step.do("設定を確認", async () => ({
        graph: graphEnabled(await getSettings(this.env.DB)),
        skipAi: await overBudget(this.env),
      }));

      const ranges = await step.do("分割", async () => {
        const text = await (await this.env.IMAGES.get(textKey(documentId)))!.text();
        return splitText(text);
      });

      const parts: Extraction[] = [];
      if (!prep.skipAi) {
        const context = await step.do("登録済みの名前を集める", () => extractionContext(this.env.DB));
        for (let i = 0; i < ranges.length; i++) {
          const part = await step.do(
            `タスクの抜き出し ${i + 1}/${ranges.length}`,
            { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "10 minutes" },
            async () => {
              const text = await (await this.env.IMAGES.get(textKey(documentId)))!.text();
              const [s, e] = ranges[i];
              // AI（有料の Claude API）で抜き出すのはタスクだけ。全文の保存・Drive・通知は AI なしで行う
              return extractTasks(this.env, text.slice(s, e), { title: meta.title, part: i + 1, parts: ranges.length, meetingDate: meta.meetingDate, ...context });
            },
          );
          parts.push(part);
        }
      }

      await step.do("保存", async () => {
        const merged = parts.length ? mergeExtractions(parts) : EMPTY_EXTRACTION;
        // 録音の開始日時がわかるときは、AI が読み取った日付より優先する
        if (meta.meetingDate) merged.meeting.date = meta.meetingDate;
        return saveExtraction(this.env, documentId, merged, { graph: prep.graph });
      });

      // Drive から取り込んだものは元のファイルが Drive にあるので置かない
      const driveWarning =
        meta.source === "drive"
          ? null
          : await step.do("Drive に保存", { retries: { limit: 3, delay: "1 minute", backoff: "exponential" } }, () => saveMinutesToDrive(this.env, documentId, origin));

      await step.do("通知", async () => {
        const notes = [prep.skipAi ? "今月の AI 利用額が上限に近いため、タスクの抜き出しは止めています（全文は保存しました）。" : "", driveWarning ?? ""].filter(Boolean);
        await notifyMinutes(this.env, documentId, origin, notes.join("\n") || undefined);
      });

      if (meta.source !== "drive") {
        await step.do("音声を保存", { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "10 minutes" }, () => saveAudio(this.env, documentId));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do("失敗を記録", async () => {
        await this.env.DB.prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?").bind(message, documentId).run();
        // 抜き出しに失敗しても、文字起こしの全文は Drive に残す
        const doc = await this.env.DB.prepare("SELECT source, title FROM documents WHERE id = ?").bind(documentId).first<{ source: string; title: string }>();
        let saved = false;
        if (doc && doc.source !== "drive") saved = await saveMinutesToDrive(this.env, documentId, origin).then((w) => !w, () => false);
        const link = origin ? `\nアプリの「取り込み直す」でやり直せます: ${origin}/minutes/${documentId}` : "";
        await sendChat(
          this.env,
          `議事録「${doc?.title ?? ""}」の取り込みに失敗しました: ${message}${saved ? "\n文字起こしの全文は Drive に保存しました。" : ""}${link}`,
          "minutes",
        );
      });
    }
  }
}

// ---------- 画面用 API ----------

export function registerMinutesRoutes(api: Hono<AppEnv>) {
  api.get("/minutes", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT d.id, d.title, d.drive_file_id, d.source, d.started_at, d.duration_sec, d.meeting_date, d.summary, d.status, d.error, d.stats,
              d.created_at, d.processed_at, u.name AS recorder_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.document_id = d.id) AS task_count,
              (SELECT COUNT(*) FROM review_items r WHERE r.document_id = d.id AND r.status = 'open') AS review_count
         FROM documents d LEFT JOIN users u ON u.id = d.recorded_by
        ORDER BY COALESCE(d.started_at, d.meeting_date, d.created_at) DESC LIMIT 100`,
    ).all();
    return c.json({ documents: results, drive: driveConfigured(c.env) });
  });

  api.get("/minutes/:id", async (c) => {
    const id = c.req.param("id");
    const data = await loadMinutes(c.env.DB, id);
    if (!data) return c.json({ error: "見つかりません" }, 404);
    return c.json({
      document: { ...data.doc, drive_url: driveLinkOf(data.doc), audio_pending: Boolean(data.doc.audio_key) },
      decisions: data.decisions,
      tasks: data.tasks,
      people: data.people,
      deals: data.deals,
    });
  });

  // 文字起こしの全文（画面で読む・検索する）
  api.get("/minutes/:id/text", async (c) => {
    const text = await minutesTranscript(c.env, c.req.param("id"));
    return c.json({ text });
  });

  // 議事録を貼り付けて取り込む（Voiss を使わない場合・動作確認用）
  api.post("/minutes/import", async (c) => {
    const user = c.get("user");
    const { title, text } = await c.req.json<{ title: string; text: string }>();
    if (!title?.trim() || !text?.trim()) return c.json({ error: "タイトルと本文を入力してください" }, 400);
    if (text.length > 500_000) return c.json({ error: "本文が長すぎます" }, 400);
    const id = uuid();
    await c.env.IMAGES.put(textKey(id), text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await c.env.DB.prepare("INSERT INTO documents (id, drive_file_id, title, modified_time, created_at, source, recorded_by) VALUES (?, ?, ?, ?, ?, 'paste', ?)")
      .bind(id, `manual:${id}`, title.trim(), nowIso(), nowIso(), user.id)
      .run();
    await startWorkflow(c.env, id, new URL(c.req.url).origin);
    await rememberAppUrl(c.env, new URL(c.req.url).origin);
    await audit(c.env.DB, { userId: user.id, via: "web", action: "minutes_import", targetType: "document", targetId: id });
    return c.json({ id });
  });

  api.post("/minutes/:id/retry", async (c) => {
    const id = c.req.param("id");
    const doc = await c.env.DB.prepare("SELECT status FROM documents WHERE id = ?").bind(id).first<{ status: string }>();
    if (!doc) return c.json({ error: "見つかりません" }, 404);
    if (doc.status === "processing") return c.json({ error: "処理中です" }, 400);
    await clearDocumentData(c.env.DB, id);
    await startWorkflow(c.env, id, new URL(c.req.url).origin);
    return c.json({ ok: true });
  });
}
