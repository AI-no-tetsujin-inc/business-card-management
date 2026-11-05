// 人物像（ステークホルダー情報）: 立場・温度感・今の状況・性格・関心・気をつけること・人間関係
// - 取り込み: Claude のスキルで文字起こしなどから振り分けた結果（JSON）を入れる。アプリ側で AI は使わない
//   人がはっきり決まり（person_id が正しい・メールや電話・氏名＋会社が一致）確信度が高いものは自動で反映し、
//   それ以外は「確認待ち」にして人が選ぶ
// - 出力: 会社ごと・人ごとにまとめた Markdown（ChatGPT / Claude にそのまま渡せる。スキルが名前を突き合わせるのにも使う）
import type { Hono } from "hono";
import type { AppEnv, User } from "./session";
import { audit, EXACT_MATCHES, findMatches, nowIso, uuid } from "./people";
import { companyKey, emptyFields, personKey } from "../shared/fields";
import { getSettings } from "./settings";
import { AUTO_APPLY_CONFIDENCE, INSIGHT_CATEGORIES, isInsightCategory, type InsightCategory } from "../shared/insights";
import { jstNow } from "./notify";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 1回で受け取る上限（画面の取り込みはファイルが大きくなりやすいので多め、AI 連携は100件） */
export const MAX_IMPORT_ITEMS = 500;
export const MAX_AI_ITEMS = 100;

export interface InsightInput {
  card_id?: string;
  name?: string;
  company?: string;
  category?: string;
  text?: string;
  evidence?: string;
  confidence?: number;
  date?: string;
}

export type PendingReason = "人が見つからない" | "候補が複数" | "確信度が低い" | "社内メンバー";

/** 取り込みの結果（画面と AI 連携で同じ形を返す） */
export interface ImportResult {
  applied: { card_id: string; name: string; category: InsightCategory }[];
  pending: { name: string; company: string; category: InsightCategory; reason: PendingReason; candidate?: { card_id: string; name: string; company: string } }[];
  skipped: { name: string; category: InsightCategory; reason: "重複" }[];
  errors: { index: number; message: string }[];
}

const CATEGORY_KEYS = INSIGHT_CATEGORIES.map((c) => c.key).join(" / ");

/**
 * 振り分け結果を取り込む。取り込み画面（スキルの JSON）・AI 連携の add_person_insights・名刺画面の手入力が、すべてこの関数を通る。
 * - 人の特定: card_id を優先し、なければ「氏名＋会社」（メール・電話・氏名＋会社の一致）で探す
 * - 人がはっきりしていて confidence が 0.7 以上なら反映。それ以外は確認待ち（理由つき）
 * - 社内メンバー（社内ドメインのメール・自社の名刺・社員と同じ名前）には入れず、確認待ちにする
 * - card_id（確認待ちなら候補の人か氏名＋会社）・分類・内容・出どころがすべて同じものは飛ばす（消したものも戻さない）
 * - 分類が決まった8つ以外・内容が空の件はエラーにして、残りは処理する
 */
export async function importInsights(
  db: D1Database,
  user: Pick<User, "id">,
  payload: { source?: string; date?: string; items: InsightInput[] },
  source: "skill" | "ai" | "manual",
  opts: { domain: string },
): Promise<ImportResult> {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const importId = uuid();
  const at = nowIso();
  const sourceTitle = String(payload.source ?? "").trim().slice(0, 200);
  const defaultDate = DATE.test(String(payload.date ?? "")) ? String(payload.date) : null;
  const result: ImportResult = { applied: [], pending: [], skipped: [], errors: [] };
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();

  // 社内メンバーの見分け: 社内ドメインのメール・自社の名刺・社員（ログインした人・社内請求の対象）と同じ名前
  const settings = await getSettings(db);
  const ownCompany = companyKey(String(settings.company_name || "株式会社AIの鉄人"));
  const { results: staff } = await db
    .prepare("SELECT name FROM users WHERE name != '' UNION SELECT display_name FROM internal_members")
    .all<{ name: string }>();
  const staffNames = new Set(staff.map((r) => personKey(r.name)).filter(Boolean));
  const domain = `@${opts.domain.toLowerCase()}`;
  const isInternal = (c: { email?: string | null; company_key?: string | null; person_name?: string | null } | null, name: string) =>
    Boolean(
      (c && (String(c.email ?? "").toLowerCase().endsWith(domain) || c.company_key === ownCompany || staffNames.has(personKey(String(c.person_name ?? ""))))) ||
        (name && staffNames.has(personKey(name))),
    );

  for (const [index, it] of items.entries()) {
    const body = String(it.text ?? "").trim().slice(0, 1000);
    const rawCategory = String(it.category ?? "").trim();
    if (!isInsightCategory(rawCategory)) {
      result.errors.push({ index, message: `category「${rawCategory || "（空）"}」は使えません。${CATEGORY_KEYS} のどれかにしてください` });
      continue;
    }
    if (!body) {
      result.errors.push({ index, message: "text が空です" });
      continue;
    }
    const category: InsightCategory = rawCategory;
    const name = String(it.name ?? "").trim().slice(0, 100);
    const company = String(it.company ?? "").trim().slice(0, 200);
    const confidence = Math.max(0, Math.min(1, Number(it.confidence ?? 0.8) || 0));

    // どの名刺の人か: card_id → メール・電話・氏名＋会社の一致
    type Card = { id: string; person_name: string; company_name: string; company_key: string; email: string };
    let card: Card | null = null;
    let candidates: Card[] = [];
    if (it.card_id) {
      card = await db
        .prepare("SELECT id, person_name, company_name, company_key, email FROM cards WHERE id = ? AND deleted_at IS NULL")
        .bind(String(it.card_id))
        .first<Card>();
    }
    if (!card && name) {
      const matches = await findMatches(db, { ...emptyFields(), person_name: name, company_name: company });
      const sure = [...new Set(matches.filter((m) => EXACT_MATCHES.includes(m.match) || m.match === "name_company").map((m) => m.id))];
      const toCard = (m: (typeof matches)[number]) => ({ id: m.id, person_name: m.person_name, company_name: m.company_name, company_key: companyKey(m.company_name), email: m.email });
      if (sure.length === 1) card = toCard(matches.find((m) => m.id === sure[0])!);
      else candidates = (sure.length ? matches.filter((m) => sure.includes(m.id)) : matches).map(toCard);
    }

    let reason: PendingReason | null = null;
    if (isInternal(card ?? (candidates.length === 1 ? candidates[0] : null), name)) reason = "社内メンバー";
    else if (!card) reason = candidates.length > 1 ? "候補が複数" : "人が見つからない";
    else if (confidence < AUTO_APPLY_CONFIDENCE) reason = "確信度が低い";
    const suggested = card ?? (candidates.length === 1 ? candidates[0] : null);

    // 同じもの（人・分類・内容・出どころ）は二重に入れない。確認待ち・消したもの・「入れない」にしたものも含めて見る
    const who = card?.id ?? suggested?.id ?? `${name}|${company}`;
    const dupKey = `${who}|${category}|${body}|${sourceTitle}`;
    const dup =
      seen.has(dupKey) ||
      ((card ?? suggested)
        ? await db
            .prepare("SELECT 1 FROM person_insights WHERE (card_id = ?1 OR (card_id IS NULL AND suggested_card_id = ?1)) AND category = ?2 AND body = ?3 AND source_title = ?4")
            .bind((card ?? suggested)!.id, category, body, sourceTitle)
            .first()
        : await db
            .prepare("SELECT 1 FROM person_insights WHERE card_id IS NULL AND suggested_name = ? AND suggested_company = ? AND category = ? AND body = ? AND source_title = ?")
            .bind(name, company, category, body, sourceTitle)
            .first());
    if (dup) {
      result.skipped.push({ name: name || card?.person_name || "", category, reason: "重複" });
      continue;
    }
    seen.add(dupKey);

    const date = DATE.test(String(it.date ?? "")) ? String(it.date) : defaultDate;
    const apply = !reason && card;
    stmts.push(
      db
        .prepare(
          `INSERT INTO person_insights (id, card_id, suggested_card_id, category, body, evidence, happened_on, source_title, source, status, suggested_name, suggested_company, confidence, import_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uuid(),
          apply ? card!.id : null,
          apply ? null : (suggested?.id ?? null),
          category,
          body,
          String(it.evidence ?? "").trim().slice(0, 500),
          date,
          sourceTitle,
          source,
          apply ? "active" : "pending",
          name || card?.person_name || "",
          company || card?.company_name || "",
          confidence,
          importId,
          user.id,
          at,
        ),
    );
    if (apply) result.applied.push({ card_id: card!.id, name: name || card!.person_name, category });
    else
      result.pending.push({
        name,
        company,
        category,
        reason: reason!,
        ...(suggested ? { candidate: { card_id: suggested.id, name: suggested.person_name, company: suggested.company_name } } : {}),
      });
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return result;
}

interface InsightRow {
  id: string;
  card_id: string | null;
  category: InsightCategory;
  body: string;
  evidence: string;
  happened_on: string | null;
  source_title: string;
  source: string;
  confidence: number;
  created_at: string;
  created_by: string | null;
  created_by_name?: string | null;
}

export async function cardInsights(db: D1Database, cardId: string) {
  const { results } = await db
    .prepare(
      `SELECT p.*, u.name AS created_by_name FROM person_insights p LEFT JOIN users u ON u.id = p.created_by
        WHERE p.card_id = ? AND p.status = 'active' ORDER BY COALESCE(p.happened_on, substr(p.created_at, 1, 10)) DESC, p.created_at DESC`,
    )
    .bind(cardId)
    .all<InsightRow>();
  return results;
}

// ---------- Markdown の出力 ----------

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const dateOf = (r: { happened_on: string | null; created_at: string }) => r.happened_on ?? r.created_at.slice(0, 10);

/** 会社ごと・人ごとの人物像をまとめた Markdown。companyKey か cardId で絞れる */
export async function exportMarkdown(db: D1Database, opts: { companyKey?: string; cardId?: string } = {}) {
  const where = ["c.deleted_at IS NULL"];
  const binds: string[] = [];
  if (opts.cardId) (where.push("c.id = ?"), binds.push(opts.cardId));
  else if (opts.companyKey) (where.push("c.company_key = ?"), binds.push(opts.companyKey));
  const { results: cards } = await db
    .prepare(
      `SELECT c.id, c.person_name, c.person_name_kana, c.company_name, c.company_key, c.department, c.title, c.exchanged_on, c.person_group
         FROM cards c WHERE ${where.join(" AND ")} ORDER BY c.company_key, c.person_name`,
    )
    .bind(...binds)
    .all<Record<string, string | null>>();
  const ids = cards.map((c) => String(c.id));
  const insights = new Map<string, InsightRow[]>();
  const notes = new Map<string, { body: string; created_at: string }[]>();
  const meetings = new Map<string, { happened_on: string | null; created_at: string; summary: string }[]>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const q = chunk.map(() => "?").join(",");
    const [a, b, d] = await db.batch([
      db.prepare(`SELECT * FROM person_insights WHERE status = 'active' AND card_id IN (${q}) ORDER BY COALESCE(happened_on, substr(created_at, 1, 10)) DESC`).bind(...chunk),
      db.prepare(`SELECT card_id, body, created_at FROM card_notes WHERE card_id IN (${q}) ORDER BY created_at DESC`).bind(...chunk),
      db.prepare(`SELECT card_id, happened_on, created_at, summary FROM interactions WHERE card_id IN (${q}) ORDER BY COALESCE(happened_on, created_at) DESC`).bind(...chunk),
    ]);
    for (const r of a.results as unknown as InsightRow[]) insights.set(r.card_id!, [...(insights.get(r.card_id!) ?? []), r]);
    for (const r of b.results as { card_id: string; body: string; created_at: string }[]) notes.set(r.card_id, [...(notes.get(r.card_id) ?? []), r]);
    for (const r of d.results as { card_id: string; happened_on: string | null; created_at: string; summary: string }[])
      meetings.set(r.card_id, [...(meetings.get(r.card_id) ?? []), r]);
  }

  const lines: string[] = [];
  const today = jstNow().date;
  const scope = opts.cardId ? "1人" : opts.companyKey ? `${cards[0]?.company_name ?? ""}` : "全員";
  lines.push(`# 人物情報（株式会社AIの鉄人 名刺管理）`, "", `- 出力日: ${today}`, `- 範囲: ${scope}（${cards.length}人）`);
  lines.push(
    "- 各人の見出しの [id: …] は名刺管理の ID です。Claude のスキル「person-insights」で文字起こしを振り分けるときに、この ID で人を特定します。",
    "- 分類: " + INSIGHT_CATEGORIES.map((c) => c.label).join("・"),
    "",
  );
  let currentCompany = "\u0000";
  for (const c of cards) {
    if (c.company_key !== currentCompany) {
      currentCompany = String(c.company_key);
      lines.push(`## ${c.company_name || "（会社名なし）"}`, "");
    }
    const head = [c.department, c.title].filter(Boolean).join("・");
    lines.push(`### ${c.person_name || "（氏名なし）"}${c.person_name_kana ? `（${c.person_name_kana}）` : ""}${head ? ` — ${head}` : ""} [id: ${c.id}]`);
    const ins = insights.get(String(c.id)) ?? [];
    const nts = notes.get(String(c.id)) ?? [];
    const mts = meetings.get(String(c.id)) ?? [];
    if (!ins.length && !nts.length && !mts.length) {
      lines.push(`- 最後に名刺交換: ${c.exchanged_on ?? "不明"}（人物像はまだありません）`, "");
      continue;
    }
    for (const cat of INSIGHT_CATEGORIES) {
      const rows = ins.filter((r) => r.category === cat.key).slice(0, 5);
      if (!rows.length) continue;
      lines.push(`- **${cat.label}**`);
      for (const r of rows) lines.push(`  - ${oneLine(r.body)}（${dateOf(r)}${r.source_title ? `・${oneLine(r.source_title)}` : ""}）`);
    }
    if (mts.length) {
      lines.push("- **最近のやり取り（議事録）**");
      for (const m of mts.slice(0, 5)) lines.push(`  - ${m.happened_on ?? m.created_at.slice(0, 10)}: ${oneLine(m.summary)}`);
    }
    if (nts.length) {
      lines.push("- **メモ**");
      for (const n of nts.slice(0, 5)) lines.push(`  - ${n.created_at.slice(0, 10)}: ${oneLine(n.body)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 操作ログ用の件数 */
export const countsOf = (r: ImportResult) => ({ applied: r.applied.length, pending: r.pending.length, skipped: r.skipped.length, errors: r.errors.length });

// ---------- 画面用 API ----------

export function registerInsightRoutes(api: Hono<AppEnv>) {
  api.get("/cards/:id/insights", async (c) => c.json({ insights: await cardInsights(c.env.DB, c.req.param("id")) }));

  // 手で追記する（名刺の詳細画面の「人物像」）
  api.post("/cards/:id/insights", async (c) => {
    const b = await c.req.json<{ category: string; text: string; date?: string }>();
    if (!isInsightCategory(b.category)) return c.json({ error: "分類を選んでください" }, 400);
    if (!String(b.text ?? "").trim()) return c.json({ error: "内容を入力してください" }, 400);
    const card = await c.env.DB.prepare("SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL").bind(c.req.param("id")).first();
    if (!card) return c.json({ error: "見つかりません" }, 404);
    const r = await importInsights(c.env.DB, c.get("user"), { items: [{ card_id: c.req.param("id"), category: b.category, text: b.text, date: b.date, confidence: 1 }] }, "manual", { domain: c.env.ALLOWED_DOMAIN });
    if (r.skipped.length) return c.json({ error: "同じ内容がすでにあります" }, 400);
    if (r.pending[0]?.reason === "社内メンバー") return c.json({ error: "社内メンバーの名刺には人物像を入れません（確認待ちに回しました）" }, 400);
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "insight_add", targetType: "card", targetId: c.req.param("id") });
    return c.json({ ok: true });
  });

  // スキルの振り分け結果を取り込む
  api.post("/insights/import", async (c) => {
    const b = await c.req.json<{ source?: string; date?: string; items?: InsightInput[] }>().catch(() => null);
    if (!b || !Array.isArray(b.items) || !b.items.length) return c.json({ error: "振り分け結果（items）が見つかりません。スキルが作った JSON をそのまま入れてください" }, 400);
    if (b.items.length > MAX_IMPORT_ITEMS) return c.json({ error: `一度に取り込めるのは ${MAX_IMPORT_ITEMS} 件までです` }, 400);
    const r = await importInsights(c.env.DB, c.get("user"), { source: b.source, date: b.date, items: b.items }, "skill", { domain: c.env.ALLOWED_DOMAIN });
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "insight_import", detail: countsOf(r) });
    return c.json(r);
  });

  // 確認待ち（人が決まっていない・自信が低い）
  api.get("/insights/pending", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.category, p.body, p.evidence, p.happened_on, p.source_title, p.suggested_name, p.suggested_company, p.confidence, p.created_at,
              s.id AS suggested_card_id, s.person_name AS suggested_person, s.company_name AS suggested_card_company
         FROM person_insights p LEFT JOIN cards s ON s.id = p.suggested_card_id AND s.deleted_at IS NULL
        WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 300`,
    ).all();
    return c.json({ pending: results });
  });

  api.post("/insights/:id/assign", async (c) => {
    const { card_id } = await c.req.json<{ card_id: string }>();
    const card = await c.env.DB.prepare("SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL").bind(String(card_id)).first();
    if (!card) return c.json({ error: "その名刺が見つかりません" }, 400);
    const r = await c.env.DB.prepare("UPDATE person_insights SET card_id = ?, suggested_card_id = NULL, status = 'active' WHERE id = ? AND status = 'pending'").bind(card_id, c.req.param("id")).run();
    return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "すでに処理済みです" }, 409);
  });

  api.post("/insights/:id/dismiss", async (c) => {
    await c.env.DB.prepare("UPDATE person_insights SET status = 'dismissed' WHERE id = ? AND status = 'pending'").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  // 消す: 書いた本人か管理者（取り込んだものは管理者か取り込んだ本人）
  api.delete("/insights/:id", async (c) => {
    const user = c.get("user");
    const row = await c.env.DB.prepare("SELECT created_by FROM person_insights WHERE id = ?").bind(c.req.param("id")).first<{ created_by: string | null }>();
    if (!row) return c.json({ error: "見つかりません" }, 404);
    if (user.role !== "admin" && row.created_by !== user.id) return c.json({ error: "消せるのは書いた本人と管理者だけです" }, 403);
    await c.env.DB.prepare("UPDATE person_insights SET status = 'dismissed' WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  // Markdown の出力（全員・会社・1人）
  api.get("/insights/export", async (c) => {
    const company = c.req.query("company");
    const cardId = c.req.query("card");
    const md = await exportMarkdown(c.env.DB, { companyKey: company || undefined, cardId: cardId || undefined });
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "insight_export", detail: { company: company ?? "", card: cardId ?? "" } });
    return c.json({ markdown: md });
  });

  api.get("/insights/summary", async (c) => {
    const r = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM person_insights WHERE status = 'active') AS active,
              (SELECT COUNT(*) FROM person_insights WHERE status = 'pending') AS pending,
              (SELECT COUNT(DISTINCT card_id) FROM person_insights WHERE status = 'active') AS people`,
    ).first();
    const { results: companies } = await c.env.DB.prepare(
      "SELECT company_key, MIN(company_name) AS company_name, COUNT(*) AS n FROM cards WHERE deleted_at IS NULL AND company_key != '' GROUP BY company_key ORDER BY company_name",
    ).all();
    return c.json({ ...r, companies });
  });
}
