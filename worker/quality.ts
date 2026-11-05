// 段階4: B. あいまいな重複判定 / C. 登録データの検証 / 確認依頼キュー
import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./anthropic";
import { ensureAiBudget } from "./ai-usage";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Hono } from "hono";
import { z } from "zod";
import { FIELD_KEYS, FIELD_LABEL, pickFields, ruleWarnings, type CardFields } from "../shared/fields";
import type { AppEnv } from "./session";
import { audit, contactPointStatements, nowIso, updatePerson, uuid, type Via } from "./people";
import { recordUsage } from "./ai-usage";

export const JUDGE_MODEL = "claude-haiku-5-5";
const AUTO_MERGE = 0.9;
const ASK_HUMAN = 0.6;
const PER_RUN = 20;

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// ---------- 名刺の統合 ----------

/** remove を keep にまとめる（画像・履歴・メモ・やり取り・タスク・つながりを移し、空欄を埋める） */
export async function mergeCards(db: D1Database, keepId: string, removeId: string, userId: string, via: Via) {
  const [keep, remove] = await Promise.all(
    [keepId, removeId].map((id) => db.prepare("SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL").bind(id).first<Record<string, string>>()),
  );
  if (!keep || !remove) throw new Error("統合する名刺が見つかりません");
  const merged = pickFields(keep);
  const filled: string[] = [];
  for (const k of FIELD_KEYS) {
    if (!merged[k] && remove[k]) {
      merged[k] = remove[k];
      filled.push(FIELD_LABEL[k]);
    }
  }
  const tags = [...new Set([...JSON.parse(keep.tags || "[]"), ...JSON.parse(remove.tags || "[]")])];
  const at = nowIso();
  const move = (table: string, col = "card_id") => db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).bind(keepId, removeId);
  await db.batch([
    db.prepare(`UPDATE cards SET ${FIELD_KEYS.map((k) => `${k} = ?`).join(", ")}, tags = ?, updated_by = ?, updated_at = ? WHERE id = ?`).bind(
      ...FIELD_KEYS.map((k) => merged[k]),
      JSON.stringify(tags),
      userId,
      at,
      keepId,
    ),
    move("card_images"),
    move("card_events"),
    move("card_notes"),
    move("interactions"),
    move("tasks"),
    move("review_items"),
    move("review_items", "other_card_id"),
    db.prepare("UPDATE relations SET from_node = ? WHERE from_node = ?").bind(`person:${keepId}`, `person:${removeId}`),
    db.prepare("UPDATE relations SET to_node = ? WHERE to_node = ?").bind(`person:${keepId}`, `person:${removeId}`),
    db.prepare("UPDATE cards SET deleted_at = ?, deleted_by = ?, merged_into = ? WHERE id = ?").bind(at, userId, keepId, removeId),
    db.prepare("DELETE FROM contact_points WHERE card_id = ?").bind(removeId),
    ...contactPointStatements(db, keepId, merged),
    db.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'updated', ?, ?, ?)").bind(
      uuid(),
      keepId,
      userId,
      at,
      JSON.stringify({ merged_from: `${remove.person_name}（${remove.company_name}）`, updated_fields: filled, via }),
    ),
  ]);
}

// ---------- AI 判定 ----------

const JudgeSchema = z.object({
  verdict: z.enum(["same", "different", "unsure"]).describe("同一人物 / 別人 / 判断できない"),
  confidence: z.number().describe("判定の確信度 0〜1"),
  reason: z.string().describe("理由（日本語で1〜2文）"),
});

const VerifySchema = z.object({
  issues: z.array(
    z.object({
      field: z.enum(FIELD_KEYS as [string, ...string[]]),
      problem: z.string().describe("問題点（日本語で短く）"),
      suggestion: z.string().describe("修正案。わからなければ空文字"),
      confidence: z.number().describe("問題があることの確信度 0〜1"),
    }),
  ),
});

async function judge<T extends z.ZodType>(env: Env, purpose: string, schema: T, system: string, user: string): Promise<z.infer<T>> {
  await ensureAiBudget(env);
  const client = anthropicClient(env);
  const res = await client.beta.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  await recordUsage(env.DB, { purpose, model: JUDGE_MODEL, usage: res.usage });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("判定できませんでした");
  return res.parsed_output as z.infer<T>;
}

const describe = (f: Partial<CardFields> & Record<string, unknown>) =>
  FIELD_KEYS.filter((k) => f[k])
    .map((k) => `${FIELD_LABEL[k]}: ${f[k]}`)
    .join("\n");

const DEDUPE_SYSTEM = `社内の名刺データベースで、2件の人物が同一人物かを判定します。
- 同姓同名でも会社・部署・連絡先が食い違えば別人の可能性を考える。転職・異動もありうる。
- ふりがなが同じで漢字が違う場合は、表記ゆれ・誤入力の可能性を考える。
- 決め手がなければ unsure にし、confidence を低くする。`;

/** B. 氏名・ふりがなが同じ名刺の組み合わせを AI が判定し、確信度で振り分ける */
/** ローカル開発で API キーが無いときだけ使う簡易判定（本番では使わない） */
const devMock = (env: Env) => !env.ANTHROPIC_API_KEY && env.DEV_LOGIN === "1";
function devJudgeDedupe(a: Record<string, string>, b: Record<string, string>): z.infer<typeof JudgeSchema> {
  if (a.person_key === b.person_key && a.company_key === b.company_key) return { verdict: "same", confidence: 0.95, reason: "（簡易判定）氏名と会社が一致" };
  if (a.person_key === b.person_key) return { verdict: "unsure", confidence: 0.5, reason: "（簡易判定）氏名が同じで会社が違う" };
  return { verdict: "different", confidence: 0.7, reason: "（簡易判定）ふりがなだけ一致" };
}

export async function dedupeScan(env: Env): Promise<string> {
  if (!env.ANTHROPIC_API_KEY && !devMock(env)) return "Claude API キーが未設定のため、重複判定はしていません";
  const { results: pairs } = await env.DB.prepare(
    `SELECT a.id AS a_id, b.id AS b_id FROM cards a JOIN cards b
        ON a.id < b.id AND a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND ((a.person_key != '' AND a.person_key = b.person_key)
            OR (a.person_name_kana != '' AND replace(a.person_name_kana, ' ', '') = replace(b.person_name_kana, ' ', '')))
     WHERE NOT EXISTS (SELECT 1 FROM merge_judgements j WHERE j.pair_key = a.id || ':' || b.id OR j.pair_key = b.id || ':' || a.id)
     LIMIT ${PER_RUN}`,
  ).all<{ a_id: string; b_id: string }>();
  let merged = 0;
  let asked = 0;
  for (const p of pairs) {
    const [a, b] = await Promise.all([p.a_id, p.b_id].map((id) => env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first<Record<string, string>>()));
    if (!a || !b) continue;
    const r = devMock(env)
      ? devJudgeDedupe(a, b)
      : await judge(env, "dedupe", JudgeSchema, DEDUPE_SYSTEM, `人物A（${a.created_at.slice(0, 10)} 登録）\n${describe(a)}\n\n人物B（${b.created_at.slice(0, 10)} 登録）\n${describe(b)}`);
    await env.DB.prepare("INSERT OR REPLACE INTO merge_judgements (pair_key, verdict, confidence, reason, decided_at) VALUES (?, ?, ?, ?, ?)")
      .bind(pairKey(a.id, b.id), r.verdict, r.confidence, r.reason, nowIso())
      .run();
    // 古い方を残す
    const [keep, remove] = a.created_at <= b.created_at ? [a, b] : [b, a];
    if (r.verdict === "same" && r.confidence >= AUTO_MERGE) {
      await mergeCards(env.DB, keep.id, remove.id, "system", "ai:重複判定");
      merged++;
    } else if (r.verdict !== "different" || r.confidence < ASK_HUMAN) {
      await env.DB.prepare(
        "INSERT INTO review_items (id, kind, card_id, other_card_id, reason, confidence, suggestion, created_at) VALUES (?, 'merge', ?, ?, ?, ?, '{}', ?)",
      )
        .bind(uuid(), keep.id, remove.id, `同じ人かもしれません: ${r.reason}`, r.confidence, nowIso())
        .run();
      asked++;
    }
  }
  return `${pairs.length}組を判定し、${merged}組を自動で統合、${asked}組を確認依頼にしました`;
}

const VERIFY_SYSTEM = `社内の名刺データベースに AI や議事録の自動取り込みで登録された人物データを点検します。
探すもの:
- 項目どうしの矛盾（会社名とメールのドメインが明らかに別の会社、部署と役職の取り違え など）
- 文字起こし・読み取りの誤変換の疑い（登録済みの会社名・人名に近いのに一文字違う、カタカナの揺れ など）
- 明らかに項目を取り違えている入力
問題がなければ issues は空配列。根拠のない指摘はしない。修正案は登録済みの表記に合わせる。`;

/** C. AI 経由・議事録から登録された名刺を点検し、怪しいものだけ確認依頼にする */
export async function verifyScan(env: Env): Promise<string> {
  if (!env.ANTHROPIC_API_KEY && !devMock(env)) return "Claude API キーが未設定のため、検証はしていません";
  const { results: cards } = await env.DB.prepare(
    `SELECT c.* FROM cards c WHERE c.deleted_at IS NULL AND c.verified_at IS NULL
        AND EXISTS (SELECT 1 FROM card_events e WHERE e.card_id = c.id AND (e.detail LIKE '%"via":"ai:%' OR e.detail LIKE '%"via":"minutes"%'))
      LIMIT ${PER_RUN}`,
  ).all<Record<string, string>>();
  if (!cards.length) return "検証が必要な名刺はありません";
  const { results: companies } = await env.DB.prepare("SELECT DISTINCT company_name AS v FROM cards WHERE deleted_at IS NULL LIMIT 300").all<{ v: string }>();
  let flagged = 0;
  for (const card of cards) {
    const fields = pickFields(card);
    const issues: { field: string; problem: string; suggestion: string; confidence: number }[] = Object.entries(ruleWarnings(fields))
      .filter(([k]) => fields[k as keyof CardFields])
      .map(([field, problem]) => ({ field, problem: problem!, suggestion: "", confidence: 0.9 }));
    const notes = await env.DB.prepare("SELECT body FROM card_notes WHERE card_id = ? ORDER BY created_at DESC LIMIT 3").bind(card.id).all<{ body: string }>();
    const r = devMock(env)
      ? { issues: [] }
      : await judge(
      env,
      "verify",
      VerifySchema,
      VERIFY_SYSTEM,
      `登録済みの会社名: ${companies.map((c) => c.v).join("、")}\n\n点検する人物:\n${describe(card)}\n\n関連メモ:\n${notes.results.map((n) => n.body).join("\n") || "（なし）"}`,
    );
    issues.push(...r.issues.filter((i) => i.confidence >= ASK_HUMAN));
    if (issues.length) {
      const suggestion = Object.fromEntries(issues.filter((i) => i.suggestion).map((i) => [i.field, i.suggestion]));
      await env.DB.prepare("INSERT INTO review_items (id, kind, card_id, reason, confidence, suggestion, created_at) VALUES (?, 'fix', ?, ?, ?, ?, ?)")
        .bind(
          uuid(),
          card.id,
          issues.map((i) => `${FIELD_LABEL[i.field as keyof CardFields] ?? i.field}: ${i.problem}`).join(" ／ "),
          Math.max(...issues.map((i) => i.confidence)),
          JSON.stringify(suggestion),
          nowIso(),
        )
        .run();
      flagged++;
    }
    await env.DB.prepare("UPDATE cards SET verified_at = ? WHERE id = ?").bind(nowIso(), card.id).run();
  }
  return `${cards.length}件を点検し、${flagged}件を確認依頼にしました`;
}

// ---------- 確認依頼キュー ----------

export async function listReviewItems(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.person_name AS card_name, a.company_name AS card_company, b.person_name AS other_name, b.company_name AS other_company,
              d.title AS document_title
         FROM review_items r
         LEFT JOIN cards a ON a.id = r.card_id
         LEFT JOIN cards b ON b.id = r.other_card_id
         LEFT JOIN documents d ON d.id = r.document_id
        WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all<Record<string, unknown>>();
  return results;
}

export interface ResolveInput {
  approve: boolean;
  /** new_person（以前の議事録から出た候補）のとき: "existing" = 候補の人物と同じ。名刺交換した人以外は登録しないので "new" は受け付けない */
  mode?: "new" | "existing";
  /** 承認時に修正後の項目を指定する（省略時は提案どおり） */
  fields?: Partial<CardFields>;
}

export async function resolveReviewItem(db: D1Database, id: string, userId: string, via: Via, input: ResolveInput): Promise<string> {
  const item = await db.prepare("SELECT * FROM review_items WHERE id = ? AND status = 'open'").bind(id).first<Record<string, string>>();
  if (!item) throw new Error("その確認依頼は見つからないか、対応済みです");
  const suggestion = JSON.parse(item.suggestion || "{}");
  let message = "却下しました";
  if (input.approve) {
    if (item.kind === "merge") {
      await mergeCards(db, item.card_id, item.other_card_id, userId, via);
      message = "2件の名刺を統合しました";
    } else if (item.kind === "fix") {
      await updatePerson(db, item.card_id, { userId, via, fields: input.fields ?? suggestion });
      message = "修正しました";
    } else if (item.kind === "new_person") {
      if (input.mode !== "existing" || !item.card_id) throw new Error("名刺交換した人以外は登録しません。「登録しない」で閉じてください");
      await db
        .prepare("INSERT INTO interactions (id, card_id, happened_on, kind, summary, document_id, created_at) VALUES (?, ?, NULL, 'meeting', ?, ?, ?)")
        .bind(uuid(), item.card_id, suggestion.role ?? "議事録に登場", item.document_id, nowIso())
        .run();
      message = "既存の人物のやり取りとして記録しました";
    }
  } else if (item.kind === "merge") {
    await db.prepare("INSERT OR REPLACE INTO merge_judgements (pair_key, verdict, confidence, reason, decided_at) VALUES (?, 'different', 1, '人が別人と判断', ?)")
      .bind(pairKey(item.card_id, item.other_card_id), nowIso())
      .run();
  }
  await db.prepare("UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
    .bind(input.approve ? "approved" : "rejected", userId, nowIso(), id)
    .run();
  await audit(db, { userId, via, action: input.approve ? "review_approve" : "review_reject", targetType: "review", targetId: id });
  return message;
}

export function registerReviewRoutes(api: Hono<AppEnv>) {
  api.get("/review", async (c) => c.json({ items: await listReviewItems(c.env.DB) }));
  api.get("/review/count", async (c) => {
    const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM review_items WHERE status = 'open'").first<{ n: number }>();
    return c.json({ count: r?.n ?? 0 });
  });
  api.post("/review/:id", async (c) => {
    try {
      const message = await resolveReviewItem(c.env.DB, c.req.param("id"), c.get("user").id, "web", await c.req.json<ResolveInput>());
      return c.json({ message });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
}

/** 毎日9時: 確認依頼がたまっていれば通知 */
export async function reviewReminderText(db: D1Database): Promise<string | null> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE status = 'open'").first<{ n: number }>();
  if (!r?.n) return null;
  return `🔍 確認依頼が ${r.n} 件あります（統合候補・データの誤りの疑い）。アプリの「確認依頼」から対応してください。`;
}

export async function qualityScan(env: Env) {
  return `${await dedupeScan(env)} ／ ${await verifyScan(env)}`;
}

