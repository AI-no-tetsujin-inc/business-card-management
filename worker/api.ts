import { Hono } from "hono";
import { checkGoogle } from "./google";
import { getLink, removeLink } from "./google-link";
import { FIELD_KEYS, FIELD_LABEL, pickFields, ruleWarnings, type FieldKey, type OcrResult } from "../shared/fields";
import { currentUser, type AppEnv } from "./session";
import { runOcr } from "./ocr";
import { toCsv, type ExportRow } from "./csv";
import {
  CARD_LIST_SELECT,
  SORTS,
  addNote,
  audit,
  findMatches,
  getCardDetail,
  linkSamePerson,
  listCards,
  unlinkSamePerson,
  nowIso,
  registerPerson,
  updatePerson,
  uuid,
} from "./people";
import { BUDGET_USD, totalCost } from "./ai-usage";
import { registerBillingRoutes } from "./billing";
import { registerTaskRoutes } from "./tasks";
import { registerMinutesRoutes } from "./minutes";
import { registerDeviceTokenRoutes } from "./device-token";
import { registerVoissPackageRoutes } from "./voiss-package";
import { registerReviewRoutes } from "./quality";
import { registerGraphRoutes } from "./graph";
import { purgeCard } from "./housekeeping";
import { registerCompanyRoutes } from "./company";
import { JOBS, runJob, type JobName } from "./cron";
import { registerInternalRoutes } from "./internal";
import { registerCalendarRoutes } from "./calendar";
import { registerInsightRoutes } from "./insights";
import { registerOrgRoutes } from "./org";
import { registerSubscriptionRoutes } from "./subscriptions";
import { getSettings, graphEnabled, minutesEnabled, setSettings } from "./settings";

export const api = new Hono<AppEnv>();

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const WEB = "web";

// ---------- 認証・権限 ----------

api.use("*", async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  const path = new URL(c.req.url).pathname;
  if (!user.registered && path !== "/api/me" && path !== "/api/register") {
    return c.json({ error: "not_registered" }, 403);
  }
  // 閲覧のみの人は、自分のプロフィールと AI 連携の解除以外は書き込めない
  // 閲覧のみの人も、自分のカレンダー連携は使える（自分のカレンダーに期限を入れるだけ）
  const writable = ["/api/register", "/api/profile"].includes(path) || path.startsWith("/api/connections/") || path.startsWith("/api/calendar");
  if (user.role === "viewer" && c.req.method !== "GET" && !writable) {
    return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
  }
  if (path.startsWith("/api/admin/") && user.role !== "admin") return c.json({ error: "管理者のみの操作です" }, 403);
  await next();
});

api.get("/me", async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({ user: c.get("user"), features: { minutes: minutesEnabled(settings), graph: graphEnabled(settings) } });
});

// 設定（会社情報・Drive・通知）。閲覧は全員、変更は管理者
const SETTING_KEYS = [
  "drive_parent_id", "mail_from", "billing_admin_email", "company_name", "company_kana", "company_postal", "company_address1",
  "company_address2", "company_tel", "company_representative", "company_email", "bank_lines", "invoice_note",
  "subscription_notice_days", "chat_reminder_start_hour", "chat_reminder_end_hour", "feature_minutes", "feature_graph", "claim_payer_email",
];
api.get("/settings", async (c) => {
  const s = await getSettings(c.env.DB);
  return c.json({ settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k] ?? ""])) });
});
api.patch("/admin/settings", async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => SETTING_KEYS.includes(k)).map(([k, v]) => [k, String(v)]));
  await setSettings(c.env.DB, patch);
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "settings_update", detail: Object.keys(patch) });
  return c.json({ ok: true });
});

api.post("/register", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: "名前を入力してください" }, 400);
  await c.env.DB.prepare("UPDATE users SET name = ?, registered = 1 WHERE id = ?").bind(name.trim(), c.get("user").id).run();
  return c.json({ ok: true });
});

api.post("/profile", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: "名前を入力してください" }, 400);
  await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name.trim(), c.get("user").id).run();
  return c.json({ ok: true });
});

api.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE active = 1 AND (registered = 1 OR name != '') ORDER BY name").all();
  return c.json({ users: results });
});

// ---------- ChatGPT / Claude との連携（MCP の許可）の一覧と解除 ----------

api.get("/connections", async (c) => {
  const helpers = c.env.OAUTH_PROVIDER;
  if (!helpers) return c.json({ connections: [] });
  const { items } = await helpers.listUserGrants(c.get("user").id);
  const connections = await Promise.all(
    items.map(async (g) => {
      const client = await helpers.lookupClient(g.clientId).catch(() => null);
      return {
        id: g.id,
        client_name: (g.metadata?.clientName as string) || client?.clientName || g.clientId,
        created_at: new Date(g.createdAt * 1000).toISOString(),
      };
    }),
  );
  return c.json({ connections });
});

api.post("/connections/:id/revoke", async (c) => {
  const user = c.get("user");
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param("id"), user.id);
  await audit(c.env.DB, { userId: user.id, via: WEB, action: "disconnect", targetType: "grant", targetId: c.req.param("id") });
  return c.json({ ok: true });
});

// ---------- 画像（ログインした人だけが見られる） ----------

api.post("/images", async (c) => {
  const type = c.req.header("content-type") ?? "";
  const length = Number(c.req.header("content-length") ?? 0);
  if (type !== "image/jpeg") return c.json({ error: "JPEG 画像のみ対応しています" }, 400);
  if (!length || length > MAX_IMAGE_BYTES) return c.json({ error: "画像が大きすぎます" }, 400);
  const key = await putImage(c.env.IMAGES, c.req.raw.body!);
  return c.json({ key });
});

export async function putImage(bucket: R2Bucket, body: ReadableStream) {
  const d = new Date();
  const key = `img/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.jpg`;
  await bucket.put(key, body, { httpMetadata: { contentType: "image/jpeg" } });
  return key;
}

api.get("/images/*", async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/images\//, ""));
  if (!key.startsWith("img/")) return c.notFound();
  const obj = await c.env.IMAGES.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "private, max-age=86400, immutable",
      etag: obj.httpEtag,
    },
  });
});

// ---------- 重複チェック ----------

api.post("/duplicates", async (c) => {
  const body = await c.req.json<{ fields: Record<string, string>; exclude?: string }>();
  return c.json({ duplicates: await findMatches(c.env.DB, pickFields(body.fields), body.exclude) });
});

// ---------- 確認待ち（撮影 → 受付 → 裏で読み取り → 確認・修正 → 登録） ----------

interface DraftRow {
  id: string;
  status: string;
  front_full_key: string;
  front_display_key: string;
  back_full_key: string | null;
  back_display_key: string | null;
  exchanged_on: string;
  ocr: string | null;
  error: string | null;
  card_id: string | null;
  client_key: string | null;
  processing_started_at: string | null;
  locked_at: string | null;
  deferred_at: string | null;
  edited: string | null;
  edited_at: string | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

const DRAFT_SELECT = `SELECT d.*, u.name AS created_by_name FROM drafts d JOIN users u ON u.id = d.created_by`;

const parseOcr = (d: DraftRow): OcrResult | null => (d.ocr ? (JSON.parse(d.ocr) as OcrResult) : null);

/** 要確認の項目（AI が自信のない項目＋形式チェック）と理由 */
function flagsOf(ocr: OcrResult): { field: FieldKey | "image"; label: string; reason: string }[] {
  const rule = ruleWarnings(ocr.fields);
  const keys = new Set([...Object.keys(ocr.review), ...Object.keys(rule)]) as Set<FieldKey>;
  const out: { field: FieldKey | "image"; label: string; reason: string }[] = [...keys].map((k) => ({ field: k, label: FIELD_LABEL[k], reason: [ocr.review[k], rule[k]].filter(Boolean).join(" / ") }));
  if (!ocr.is_business_card) out.push({ field: "image", label: "画像", reason: "名刺ではない画像の可能性があります" });
  return out;
}
const flagCount = (ocr: OcrResult) => flagsOf(ocr).length;

/** 読み取りが止まったとみなす時間（Workers の処理が打ち切られた場合など） */
const STALE_MS = 2 * 60_000;

/** 読み取りを1回だけ実行する（同時に2回走らない・止まったものは拾い直す） */
async function processDraft(env: Env, id: string, force = false) {
  const now = nowIso();
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE drafts SET processing_started_at = ?, error = CASE WHEN ? THEN NULL ELSE error END
      WHERE id = ? AND status = 'pending' AND (? OR ocr IS NULL) AND (processing_started_at IS NULL OR processing_started_at < ? OR ?)`,
  )
    .bind(now, force ? 1 : 0, id, force ? 1 : 0, staleBefore, force ? 1 : 0)
    .run();
  if (!claim.meta.changes) return;
  const d = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<DraftRow>();
  if (!d) return;
  try {
    const keys = [d.front_display_key, d.back_display_key].filter((k): k is string => Boolean(k));
    const ocr = await runOcr(env, keys, d.created_by);
    await env.DB.prepare("UPDATE drafts SET ocr = ?, error = NULL WHERE id = ?").bind(JSON.stringify(ocr), id).run();
  } catch (e) {
    console.error("OCR failed", e);
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE drafts SET error = ? WHERE id = ?").bind(`読み取りに失敗しました: ${msg}`, id).run();
  }
}

/** 止まっている読み取り（受付から2分以上たっても終わっていないもの）を裏で拾い直す */
async function resumeStale(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, ids?: string[]) {
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const { results } = await c.env.DB.prepare(
    `SELECT id FROM drafts WHERE status = 'pending' AND ocr IS NULL AND error IS NULL AND (processing_started_at IS NULL OR processing_started_at < ?) LIMIT 5`,
  )
    .bind(staleBefore)
    .all<{ id: string }>();
  for (const r of results) if (!ids || ids.includes(r.id)) c.executionCtx.waitUntil(processDraft(c.env, r.id));
}

type DraftState = "reading" | "ready" | "flagged" | "duplicate" | "failed";

async function draftSummary(env: Env, d: DraftRow) {
  const ocr = parseOcr(d);
  const edited = d.edited ? (JSON.parse(d.edited) as { fields?: Record<string, string> }) : null;
  const fields = edited?.fields ? pickFields(edited.fields) : ocr?.fields;
  const dups = fields ? await findMatches(env.DB, pickFields(fields)) : [];
  const flags = ocr ? flagsOf(ocr) : [];
  const state: DraftState = d.error ? "failed" : !ocr ? "reading" : dups.length ? "duplicate" : flags.length ? "flagged" : "ready";
  return {
    id: d.id,
    status: d.status,
    state,
    front_display_key: d.front_display_key,
    has_back: Boolean(d.back_display_key),
    created_by_name: d.created_by_name,
    created_at: d.created_at,
    accepted_at: d.created_at,
    error: d.error,
    processed: Boolean(ocr),
    person_name: fields?.person_name ?? "",
    company_name: fields?.company_name ?? "",
    flag_count: ocr ? flags.length : null,
    flags,
    duplicate_count: dups.length,
    duplicates: dups.map((m) => ({ id: m.id, person_name: m.person_name, company_name: m.company_name, match: m.match })),
    deferred: Boolean(d.deferred_at),
    has_edits: Boolean(d.edited),
    card_id: d.card_id,
  };
}

/** 確認する順番: 先に撮った順。「あとで確認」は後ろに回す */
const QUEUE_ORDER = "ORDER BY (d.deferred_at IS NOT NULL), d.created_at";

async function imageExists(bucket: R2Bucket, key: string | undefined | null) {
  return !key || (key.startsWith("img/") && (await bucket.head(key)) !== null);
}

api.post("/drafts", async (c) => {
  const b = await c.req.json<{
    front_full: string;
    front_display: string;
    back_full?: string;
    back_display?: string;
    exchanged_on?: string;
    client_key?: string;
  }>();
  // 同じ撮影の再送（通信失敗後の再試行・連打）は、最初に受け付けたものを返す
  const clientKey = /^[\w-]{8,64}$/.test(b.client_key ?? "") ? b.client_key! : null;
  if (clientKey) {
    const dup = await c.env.DB.prepare("SELECT id FROM drafts WHERE client_key = ?").bind(clientKey).first<{ id: string }>();
    if (dup) return c.json({ id: dup.id, accepted: true, already: true });
  }
  if (!b.front_full || !b.front_display) return c.json({ error: "表面の画像がありません" }, 400);
  if (Boolean(b.back_full) !== Boolean(b.back_display)) return c.json({ error: "裏面の画像が不完全です" }, 400);
  for (const k of [b.front_full, b.front_display, b.back_full, b.back_display]) {
    if (!(await imageExists(c.env.IMAGES, k))) return c.json({ error: "画像が見つかりません" }, 400);
  }
  const id = uuid();
  const exchangedOn = /^\d{4}-\d{2}-\d{2}$/.test(b.exchanged_on ?? "") ? b.exchanged_on! : "";
  try {
    await c.env.DB.prepare(
      `INSERT INTO drafts (id, front_full_key, front_display_key, back_full_key, back_display_key, exchanged_on, client_key, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, b.front_full, b.front_display, b.back_full ?? null, b.back_display ?? null, exchangedOn, clientKey, c.get("user").id, nowIso())
      .run();
  } catch (e) {
    // 同時に届いた再送（一意制約）
    const dup = clientKey && (await c.env.DB.prepare("SELECT id FROM drafts WHERE client_key = ?").bind(clientKey).first<{ id: string }>());
    if (dup) return c.json({ id: dup.id, accepted: true, already: true });
    throw e;
  }
  // 受け付けたらすぐ返し、読み取りは裏で続ける（画面を移っても止まらない）
  c.executionCtx.waitUntil(processDraft(c.env, id));
  return c.json({ id, accepted: true });
});

api.get("/drafts", async (c) => {
  await resumeStale(c);
  const { results } = await c.env.DB.prepare(`${DRAFT_SELECT} WHERE d.status = 'pending' ${QUEUE_ORDER}`).all<DraftRow>();
  return c.json({ drafts: await Promise.all(results.map((d) => draftSummary(c.env, d))) });
});

/** 撮影画面から、受け付けた名刺の状態をまとめて確認する */
api.get("/drafts/status", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").filter((s) => /^[\w-]{8,64}$/.test(s)).slice(0, 50);
  if (!ids.length) return c.json({ drafts: [] });
  await resumeStale(c, ids);
  const { results } = await c.env.DB.prepare(`${DRAFT_SELECT} WHERE d.id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<DraftRow>();
  return c.json({
    drafts: await Promise.all(
      results.map(async (d) => (d.status === "pending" ? draftSummary(c.env, d) : { id: d.id, status: d.status, state: d.status === "done" ? "registered" : "discarded", card_id: d.card_id })),
    ),
  });
});

api.get("/drafts/count", async (c) => {
  // ナビの件数は「確認できるもの」（読み取りが終わったもの・失敗したもの）
  const r = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN ocr IS NULL AND error IS NULL THEN 1 ELSE 0 END) AS reading FROM drafts WHERE status = 'pending'",
  ).first<{ n: number; reading: number | null }>();
  return c.json({ count: (r?.n ?? 0) - (r?.reading ?? 0), reading: r?.reading ?? 0, total: r?.n ?? 0 });
});

api.get("/drafts/:id", async (c) => {
  const d = await c.env.DB.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).bind(c.req.param("id")).first<DraftRow>();
  if (!d) return c.json({ error: "見つかりません" }, 404);
  if (d.status === "pending" && !d.ocr && !d.error) await resumeStale(c, [d.id]);
  // 次に確認する名刺と残り件数（自分を除く、確認できるもの）
  const { results: queue } = await c.env.DB.prepare(
    `SELECT d.id FROM drafts d WHERE d.status = 'pending' AND d.id != ? AND (d.ocr IS NOT NULL OR d.error IS NOT NULL) ${QUEUE_ORDER}`,
  )
    .bind(d.id)
    .all<{ id: string }>();
  const nextNotDeferred = await c.env.DB.prepare(
    `SELECT d.id FROM drafts d WHERE d.status = 'pending' AND d.id != ? AND d.deferred_at IS NULL AND (d.ocr IS NOT NULL OR d.error IS NOT NULL) AND d.created_at >= ? ${QUEUE_ORDER} LIMIT 1`,
  )
    .bind(d.id, d.created_at)
    .first<{ id: string }>();
  return c.json({
    draft: {
      id: d.id,
      status: d.status,
      card_id: d.card_id,
      front_display_key: d.front_display_key,
      front_full_key: d.front_full_key,
      back_display_key: d.back_display_key,
      back_full_key: d.back_full_key,
      exchanged_on: d.exchanged_on,
      error: d.error,
      created_by_name: d.created_by_name,
      created_at: d.created_at,
      ocr: parseOcr(d),
      edited: d.edited ? JSON.parse(d.edited) : null,
      edited_at: d.edited_at,
      deferred: Boolean(d.deferred_at),
    },
    queue: { remaining: queue.length, next_id: nextNotDeferred?.id ?? queue[0]?.id ?? null },
  });
});

/** 確認画面で直している途中の内容を保存する（下書き保存・自動保存）／「あとで確認」 */
api.patch("/drafts/:id", async (c) => {
  const b = await c.req.json<{ edited?: unknown; deferred?: boolean }>();
  const id = c.req.param("id");
  if (b.edited !== undefined) {
    const json = b.edited === null ? null : JSON.stringify(b.edited);
    if (json && json.length > 20000) return c.json({ error: "内容が大きすぎます" }, 400);
    await c.env.DB.prepare("UPDATE drafts SET edited = ?, edited_at = ? WHERE id = ? AND status = 'pending'").bind(json, json ? nowIso() : null, id).run();
  }
  if (b.deferred !== undefined) {
    await c.env.DB.prepare("UPDATE drafts SET deferred_at = ? WHERE id = ? AND status = 'pending'").bind(b.deferred ? nowIso() : null, id).run();
  }
  return c.json({ ok: true });
});

api.post("/drafts/:id/retry", async (c) => {
  const id = c.req.param("id");
  await processDraft(c.env, id, true);
  const d = await c.env.DB.prepare("SELECT error FROM drafts WHERE id = ?").bind(id).first<{ error: string | null }>();
  return c.json({ error: d?.error ?? null });
});

api.post("/drafts/:id/discard", async (c) => {
  const d = await c.env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(c.req.param("id")).first<DraftRow>();
  if (!d) return c.json({ error: "見つかりません" }, 404);
  if (d.status === "discarded") return c.json({ ok: true, already: true });
  if (d.status !== "pending") return c.json({ error: "登録済みのため破棄できません（名刺は名刺一覧から操作してください）" }, 400);
  // 破棄は今回の取り込みだけ（既存の名刺には触れない）
  await c.env.DB.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ? AND status = 'pending'").bind(d.id).run();
  const keys = [d.front_full_key, d.front_display_key, d.back_full_key, d.back_display_key].filter((k): k is string => Boolean(k));
  await c.env.IMAGES.delete(keys);
  return c.json({ ok: true });
});

interface CommitBody {
  /** new: 新規 ／ merge: 既存の名刺を更新 ／ affiliate: 同じ人の別の所属（会社）として新規登録し、既存の名刺とまとめる */
  mode: "new" | "merge" | "affiliate";
  card_id?: string;
  fields: Record<string, string>;
  update_fields?: string[];
  exchange_place?: string;
  exchanged_on?: string;
  tags?: string[];
  note?: string;
}

/** 確認待ちを名刺として登録する（新規 or 既存の名刺に交換履歴として追加） */
async function commitDraft(env: Env, d: DraftRow, userId: string, body: CommitBody): Promise<string> {
  const fields = pickFields(body.fields);
  // 統合時は、画面で「更新する」にチェックした項目だけを新しい値にする（空欄で既存の値は消さない）
  const mergeFields =
    body.mode === "merge"
      ? Object.fromEntries(FIELD_KEYS.map((k) => [k, (body.update_fields ?? []).includes(k) ? fields[k] : ""]))
      : fields;
  const result = await registerPerson(env.DB, {
    userId,
    via: WEB,
    fields: mergeFields,
    exchangedOn: body.exchanged_on || d.exchanged_on,
    exchangePlace: body.exchange_place,
    tags: body.tags,
    note: body.note,
    mergeInto: body.mode === "merge" ? body.card_id : undefined,
    forceNew: body.mode !== "merge",
  });
  if (result.action === "needs_confirmation") throw new Error("統合先を選んでください");
  if (body.mode === "affiliate") {
    if (!body.card_id) throw new Error("まとめる名刺を選んでください");
    await linkSamePerson(env.DB, userId, result.cardId, body.card_id);
  }
  const at = nowIso();
  const img = (side: string, full: string, display: string) =>
    env.DB.prepare("INSERT INTO card_images (id, card_id, side, full_key, display_key, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), result.cardId, side, full, display, userId, at);
  const stmts = [img("front", d.front_full_key, d.front_display_key)];
  if (d.back_full_key && d.back_display_key) stmts.push(img("back", d.back_full_key, d.back_display_key));
  stmts.push(env.DB.prepare("UPDATE drafts SET status = 'done', card_id = ?, locked_at = NULL, edited = NULL WHERE id = ?").bind(result.cardId, d.id));
  await env.DB.batch(stmts);
  await audit(env.DB, { userId, via: WEB, action: result.action === "merged" ? "update" : "create", targetType: "card", targetId: result.cardId });
  return result.cardId;
}

/**
 * 登録の前に「登録処理中」の印を付ける（連打・一括登録の重なり・再読み込みでの二重登録を防ぐ）。
 * すでに登録済みなら、その名刺の ID を返す
 */
async function lockDraft(env: Env, id: string): Promise<{ draft?: DraftRow; done?: string; busy?: boolean; missing?: boolean }> {
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const r = await env.DB.prepare("UPDATE drafts SET locked_at = ? WHERE id = ? AND status = 'pending' AND (locked_at IS NULL OR locked_at < ?)")
    .bind(nowIso(), id, staleBefore)
    .run();
  const d = await env.DB.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).bind(id).first<DraftRow>();
  if (!d || d.status === "discarded") return { missing: true };
  if (d.status === "done") return { done: d.card_id ?? undefined };
  if (!r.meta.changes) return { busy: true };
  return { draft: d };
}
const unlockDraft = (env: Env, id: string) => env.DB.prepare("UPDATE drafts SET locked_at = NULL WHERE id = ? AND status = 'pending'").bind(id).run();

api.post("/drafts/:id/commit", async (c) => {
  const body = await c.req.json<CommitBody>();
  if (fieldsTooLong(body.fields) || String(body.exchange_place ?? "").length > 200 || String(body.note ?? "").length > 4000) return c.json({ error: "入力が長すぎます" }, 400);
  const lock = await lockDraft(c.env, c.req.param("id"));
  if (lock.done) return c.json({ card_id: lock.done, already: true });
  if (lock.missing) return c.json({ error: "この確認待ちは破棄されたか、見つかりません" }, 404);
  if (lock.busy) return c.json({ error: "この名刺は登録処理中です。少し待ってから一覧を確認してください" }, 409);
  try {
    const cardId = await commitDraft(c.env, lock.draft!, c.get("user").id, body);
    return c.json({ card_id: cardId });
  } catch (e) {
    await unlockDraft(c.env, lock.draft!.id);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/**
 * 問題のない名刺だけをまとめて新規登録する（既存の名刺は自動で更新しない）。
 * 1件ずつ結果を返すので、失敗した分だけやり直せる。登録済みのものは「登録済み」として返す（二重登録しない）
 */
api.post("/drafts/bulk-commit", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  const results: { id: string; result: "committed" | "already" | "skipped" | "failed"; card_id?: string; reason?: string }[] = [];
  for (const id of [...new Set(ids ?? [])].slice(0, 100)) {
    const lock = await lockDraft(c.env, id);
    if (lock.done) {
      results.push({ id, result: "already", card_id: lock.done });
      continue;
    }
    if (lock.missing || lock.busy) {
      results.push({ id, result: "skipped", reason: lock.busy ? "登録処理中です" : "見つかりません（破棄済み）" });
      continue;
    }
    const d = lock.draft!;
    try {
      const ocr = parseOcr(d);
      const edited = d.edited ? (JSON.parse(d.edited) as { fields?: Record<string, string> }) : null;
      const fields = edited?.fields ? pickFields(edited.fields) : ocr?.fields;
      let reason = "";
      if (d.error) reason = "読み取りに失敗しています";
      else if (!ocr || !fields) reason = "読み取りが終わっていません";
      else if (flagCount(ocr) > 0) reason = "要確認の項目があります";
      else if ((await findMatches(c.env.DB, pickFields(fields))).length > 0) reason = "重複候補があります";
      if (reason) {
        await unlockDraft(c.env, id);
        results.push({ id, result: "skipped", reason });
        continue;
      }
      const cardId = await commitDraft(c.env, d, c.get("user").id, { mode: "new", fields: fields!, exchanged_on: d.exchanged_on });
      results.push({ id, result: "committed", card_id: cardId });
    } catch (e) {
      await unlockDraft(c.env, id);
      results.push({ id, result: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({
    results,
    committed: results.filter((r) => r.result === "committed" || r.result === "already").length,
    skipped: results.filter((r) => r.result === "skipped"),
    failed: results.filter((r) => r.result === "failed").length,
  });
});

// ---------- 名刺 ----------

api.get("/cards", async (c) => {
  const q = c.req.query();
  const cards = await listCards(c.env.DB, { q: q.q, company: q.company, user: q.user, tag: q.tag, sort: q.sort, trash: q.trash === "1" });
  if (q.q?.trim()) await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "search", detail: { q: q.q, hits: cards.length } });
  return c.json({ cards });
});

api.get("/companies", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.company_key,
            (SELECT c2.company_name FROM cards c2 WHERE c2.company_key = c.company_key AND c2.deleted_at IS NULL
              ORDER BY c2.created_at DESC LIMIT 1) AS company_name,
            COUNT(*) AS count, MAX(c.created_at) AS last_created_at
       FROM cards c WHERE c.deleted_at IS NULL GROUP BY c.company_key ORDER BY c.company_key`,
  ).all();
  return c.json({ companies: results });
});

api.get("/tags", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT DISTINCT json_each.value AS tag FROM cards, json_each(cards.tags) WHERE cards.deleted_at IS NULL ORDER BY tag",
  ).all<{ tag: string }>();
  return c.json({ tags: results.map((r) => r.tag) });
});

api.get("/cards/:id", async (c) => {
  const detail = await getCardDetail(c.env.DB, c.req.param("id"));
  if (!detail) return c.json({ error: "見つかりません" }, 404);
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "view", targetType: "card", targetId: c.req.param("id") });
  return c.json(detail);
});

/** 別の会社の名刺と「同じ人」としてまとめる／外す */
api.post("/cards/:id/link", async (c) => {
  if (c.get("user").role === "viewer") return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
  const { other_id } = await c.req.json<{ other_id: string }>();
  try {
    await linkSamePerson(c.env.DB, c.get("user").id, c.req.param("id"), other_id);
    await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "link_person", targetType: "card", targetId: c.req.param("id"), detail: { other_id } });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
api.post("/cards/:id/unlink", async (c) => {
  if (c.get("user").role === "viewer") return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
  await unlinkSamePerson(c.env.DB, c.get("user").id, c.req.param("id"));
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "unlink_person", targetType: "card", targetId: c.req.param("id") });
  return c.json({ ok: true });
});

/** 名刺の項目の長さの上限（住所・その他は長め） */
const fieldsTooLong = (f: Record<string, unknown> | undefined) =>
  Object.entries(f ?? {}).some(([k, v]) => String(v ?? "").length > (k === "address" || k === "other" ? 1000 : 300));

api.patch("/cards/:id", async (c) => {
  const b = await c.req.json<{ fields: Record<string, string>; tags?: string[]; exchange_place?: string; exchanged_on?: string }>();
  if (fieldsTooLong(b.fields) || String(b.exchange_place ?? "").length > 200 || (b.tags ?? []).some((t) => String(t).length > 40)) return c.json({ error: "入力が長すぎます" }, 400);
  const user = c.get("user");
  const changes = await updatePerson(c.env.DB, c.req.param("id"), {
    userId: user.id,
    via: WEB,
    fields: pickFields(b.fields),
    tags: b.tags,
    exchangePlace: b.exchange_place ?? "",
    exchangedOn: b.exchanged_on,
  });
  if (!changes) return c.json({ error: "見つかりません" }, 404);
  if (changes.length) await audit(c.env.DB, { userId: user.id, via: WEB, action: "update", targetType: "card", targetId: c.req.param("id") });
  return c.json({ ok: true });
});

api.post("/cards/:id/delete", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const at = nowIso();
  const res = await c.env.DB.prepare("UPDATE cards SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL").bind(at, user.id, id).run();
  if (!res.meta.changes) return c.json({ error: "見つかりません" }, 404);
  await c.env.DB.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'deleted', ?, ?, ?)")
    .bind(uuid(), id, user.id, at, JSON.stringify({ via: WEB }))
    .run();
  await audit(c.env.DB, { userId: user.id, via: WEB, action: "delete", targetType: "card", targetId: id });
  return c.json({ ok: true });
});

api.post("/cards/:id/restore", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const at = nowIso();
  const res = await c.env.DB.prepare("UPDATE cards SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL").bind(id).run();
  if (!res.meta.changes) return c.json({ error: "見つかりません" }, 404);
  await c.env.DB.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'restored', ?, ?, ?)")
    .bind(uuid(), id, user.id, at, JSON.stringify({ via: WEB }))
    .run();
  await audit(c.env.DB, { userId: user.id, via: WEB, action: "restore", targetType: "card", targetId: id });
  return c.json({ ok: true });
});

api.post("/cards/:id/notes", async (c) => {
  const { body } = await c.req.json<{ body: string }>();
  try {
    await addNote(c.env.DB, c.req.param("id"), c.get("user").id, WEB, body ?? "");
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "note", targetType: "card", targetId: c.req.param("id") });
  return c.json({ ok: true });
});

// ---------- CSV 出力（管理者のみ） ----------

api.post("/export", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "CSV 出力は管理者のみです" }, 403);
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: "出力する名刺を選んでください" }, 400);
  const rows: ExportRow[] = [];
  // D1 のバインド数上限を避けるため分割して取得
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await c.env.DB.prepare(
      `${CARD_LIST_SELECT} WHERE c.id IN (${chunk.map(() => "?").join(", ")}) ORDER BY ${SORTS.company}`,
    )
      .bind(...chunk)
      .all<ExportRow>();
    rows.push(...results);
  }
  rows.sort((a, b) => String(a.company_key).localeCompare(String(b.company_key), "ja"));
  await audit(c.env.DB, { userId: user.id, via: WEB, action: "export", detail: { count: rows.length } });
  const date = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  return new Response(toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="meishi_${date}.csv"; filename*=UTF-8''${encodeURIComponent(`名刺_${date}.csv`)}`,
    },
  });
});

// ---------- 管理（管理者のみ） ----------

api.get("/admin/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, role, active, created_at, last_login_at FROM users ORDER BY created_at",
  ).all();
  return c.json({ users: results });
});

api.post("/admin/users/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const b = await c.req.json<{ role?: string; active?: boolean }>();
  if (id === me.id && (b.active === false || (b.role && b.role !== "admin"))) {
    return c.json({ error: "自分自身の権限は変更できません" }, 400);
  }
  if (b.role && !["admin", "member", "viewer"].includes(b.role)) return c.json({ error: "権限が不正です" }, 400);
  if (b.role) await c.env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(b.role, id).run();
  if (b.active !== undefined) {
    await c.env.DB.prepare("UPDATE users SET active = ? WHERE id = ?").bind(b.active ? 1 : 0, id).run();
    if (!b.active) {
      // 無効化: ログイン状態と ChatGPT / Claude との連携をすべて切る
      await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(id);
      for (const g of items) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, id);
    }
  }
  await audit(c.env.DB, { userId: me.id, via: WEB, action: "admin_user", targetType: "user", targetId: id, detail: b });
  return c.json({ ok: true });
});

api.get("/admin/audit", async (c) => {
  const user = c.req.query("user");
  const via = c.req.query("via");
  const where: string[] = [];
  const binds: string[] = [];
  if (user) {
    where.push("a.user_id = ?");
    binds.push(user);
  }
  if (via) {
    where.push(via === "ai" ? "a.via LIKE 'ai:%'" : "a.via = ?");
    if (via !== "ai") binds.push(via);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.name AS user_name,
            (SELECT person_name || '（' || company_name || '）' FROM cards WHERE cards.id = a.target_id) AS target_label
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC LIMIT 300`,
  )
    .bind(...binds)
    .all();
  return c.json({ logs: results });
});

api.get("/admin/ai-usage", async (c) => {
  const total = await totalCost(c.env.DB);
  const first = await c.env.DB.prepare("SELECT MIN(created_at) AS at FROM ai_usage").first<{ at: string | null }>();
  const { results: byPurpose } = await c.env.DB.prepare(
    `SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
       FROM ai_usage GROUP BY purpose, model ORDER BY cost_usd DESC`,
  ).all();
  return c.json({ total_usd: total, since: first?.at ?? null, budget_usd: BUDGET_USD, by_purpose: byPurpose });
});

// 設定状況（公開前のチェック用）。値そのものは返さない
api.get("/admin/status", async (c) => {
  const e = c.env;
  const users = await e.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE registered = 1").first<{ n: number }>();
  const googleLink = await getLink(e.DB);
  return c.json({
    items: [
      { key: "claude", label: "Claude API キー", ok: Boolean(e.ANTHROPIC_API_KEY), note: "名刺の読み取りに使う" },
      { key: "google_login", label: "Google ログイン", ok: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET), note: "画面へのログインと AI 連携の許可に使う" },
      { key: "google_link", label: "Google 連携（Drive・Gmail）", ok: Boolean(googleLink && !googleLink.last_error), note: googleLink ? (googleLink.last_error ?? `${googleLink.email} の権限で書類の保存・メール送信を行う`) : "下の「Google と連携」を押して許可する" },
      { key: "chat", label: "Google Chat の通知先", ok: Boolean(e.GOOGLE_CHAT_WEBHOOK_URL), note: "送付・連絡の未チェックを 1 時間ごとに通知" },
      { key: "pdf", label: "PDF の作成（Browser Run）", ok: Boolean(e.BROWSER), note: "請求書・見積書の PDF 化（無料枠 1 日 10 分）" },
      { key: "dev_login", label: "開発用ログインが無効", ok: e.DEV_LOGIN !== "1", note: "本番では DEV_LOGIN を設定しない（localhost 以外では動かない）" },
    ],
    registered_users: users?.n ?? 0,
    mcp_url: `${new URL(c.req.url).origin}/mcp`,
  });
});

api.get("/admin/google-link", async (c) => {
  const link = await getLink(c.env.DB);
  return c.json({ link: link ? { email: link.email, linked_at: link.linked_at, last_error: link.last_error, last_error_at: link.last_error_at } : null, login_ready: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) });
});
api.delete("/admin/google-link", async (c) => {
  await removeLink(c.env);
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "google_unlink" });
  return c.json({ ok: true });
});

api.post("/admin/google-check", async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({ results: await checkGoogle(c.env, settings.drive_parent_id) });
});

// ごみ箱の名刺を今すぐ完全に削除する（管理者のみ・元に戻せない）
api.post("/admin/cards/:id/purge", async (c) => {
  const id = c.req.param("id");
  const card = await c.env.DB.prepare("SELECT person_name, company_name, deleted_at FROM cards WHERE id = ?").bind(id).first<{
    person_name: string;
    company_name: string;
    deleted_at: string | null;
  }>();
  if (!card) return c.json({ error: "見つかりません" }, 404);
  if (!card.deleted_at) return c.json({ error: "ごみ箱にある名刺だけ完全に削除できます" }, 400);
  await purgeCard(c.env, id);
  await audit(c.env.DB, { userId: c.get("user").id, via: WEB, action: "purge", targetType: "card", detail: { name: `${card.person_name}（${card.company_name}）` } });
  return c.json({ ok: true });
});

// 定期処理を管理画面から手動で実行する（動作確認用）
api.post("/admin/jobs/:job", async (c) => {
  const job = c.req.param("job") as JobName;
  if (!(job in JOBS)) return c.json({ error: "不明な処理です" }, 400);
  return c.json({ result: await runJob(c.env, job, true) });
});

api.get("/admin/jobs", (c) => c.json({ jobs: JOBS }));

registerBillingRoutes(api);
registerInternalRoutes(api);
registerCalendarRoutes(api);
registerInsightRoutes(api);
registerOrgRoutes(api);
registerSubscriptionRoutes(api);
registerTaskRoutes(api);
registerMinutesRoutes(api);
registerDeviceTokenRoutes(api);
registerVoissPackageRoutes(api);
registerReviewRoutes(api);
registerGraphRoutes(api);
registerCompanyRoutes(api);
