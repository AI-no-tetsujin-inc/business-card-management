// 社内請求・経費精算: 月末締め・翌月5日払い。登録された社内請求対象者が翌月2日までに「稼働分」と「立替経費」の請求書を発行し、
// 領収書の写真と一緒に Google Drive に入れる。全員そろったら代表（設定された代表者）に Google Chat で知らせ、税理士に送ってもらう
import type { Context, Hono } from "hono";
import type { AppEnv, User } from "./session";
import { audit, nowIso, uuid } from "./people";
import { chatMention, claimJob, jstNow, sendChat, shiftMonth } from "./notify";
import { getSettings } from "./settings";
import { internalExpenseHtml, internalWorkHtml, jpDate } from "./templates";
import { documentResponse, monthFolder, safeName, storeDocument } from "./documents";
import { ensureFolder, googleReady, trashDriveFile, uploadToDrive } from "./google";
import { yen } from "./billing";

const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 最初の受付月（2026年10月分。9月分の未精算経費も含めて受け付ける） */
export const FIRST_PERIOD = "2026-10";
export const EARLIEST_EXPENSE_DATE = "2026-09-01";
const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
const RECEIPT_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf", "image/heic": "heic" };

const lastDayOf = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
/** 支払日: 翌月5日 */
const payDate = (period: string) => `${shiftMonth(period, 1)}-05`;
/** 提出期限: 翌月2日 */
export const deadlineOf = (period: string) => `${shiftMonth(period, 1)}-02`;
/** Google Chat での依頼・リマインド・完了の連絡を自動で送り始める月（10月分は手動で連絡済み） */
export const CHAT_FLOW_FROM = "2026-11";

interface Member {
  email: string;
  display_name: string;
  number_suffix: string;
  bank_text: string;
  default_item: string;
  default_unit_price: number;
}

async function getMember(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM internal_members WHERE email = ? AND active = 1").bind(email).first<Member>();
}

/** まだ請求に含めていない経費（その月の末日までの分。初回は9月分も含む） */
interface ExpenseRow {
  id: string;
  member_email: string;
  spent_on: string;
  purpose: string;
  amount: number;
  receipt_id: string | null;
  receipt_amount: number | null;
  receipt_name: string | null;
  original_submitted_at: string | null;
  [k: string]: unknown;
}

async function unclaimedItems(db: D1Database, email: string, period: string) {
  const { results } = await db
    .prepare(
      `SELECT e.*, r.amount AS receipt_amount, r.file_name AS receipt_name, r.original_submitted_at
         FROM expense_items e LEFT JOIN receipts r ON r.id = e.receipt_id
        WHERE e.member_email = ? AND e.claim_id IS NULL AND e.spent_on <= ? AND e.spent_on >= ?
        ORDER BY e.spent_on, e.created_at`,
    )
    .bind(email, lastDayOf(period), EARLIEST_EXPENSE_DATE)
    .all<ExpenseRow>();
  return results.map((r) => ({
    ...r,
    match: !r.receipt_id ? "no_receipt" : Number(r.receipt_amount) === Number(r.amount) ? "ok" : "mismatch",
  }));
}

function workLines(member: Member, period: string, lines?: { name: string; qty: number; unit_price: number }[]) {
  const m = Number(period.slice(5, 7));
  const src = lines?.length ? lines : [{ name: member.default_item.replace("{M}", String(m)), qty: 1, unit_price: member.default_unit_price }];
  const out = src
    .filter((l) => l.name?.trim())
    .map((l) => {
      const qty = Number(l.qty) || 1;
      const unit = Math.round(Number(l.unit_price) || 0);
      return { name: `[${lastDayOf(period)}]${l.name.trim().replace(/^\[\d{4}-\d{2}-\d{2}\]/, "")}`, qty, unit_price: unit, amount: qty * unit };
    });
  const subtotal = out.reduce((s, l) => s + l.amount, 0);
  const tax = Math.floor(subtotal * 0.1);
  return { lines: out, subtotal, tax, total: subtotal + tax };
}

function claimHtml(settings: Record<string, string>, member: Member, claim: {
  kind: "work" | "expense";
  period: string;
  number: string;
  issue_date: string;
  due_date: string;
  lines: unknown[];
  subtotal: number;
  tax: number;
  total: number;
}) {
  const m = Number(claim.period.slice(5, 7));
  const base = { number: claim.number, issueDate: claim.issue_date, dueDate: claim.due_date, issuer: member.display_name, bank: member.bank_text };
  return claim.kind === "work"
    ? internalWorkHtml(settings, { ...base, subject: `${m}月稼働分`, lines: claim.lines as never, subtotal: claim.subtotal, tax: claim.tax, total: claim.total })
    : internalExpenseHtml(settings, { ...base, subject: `${m}月分 立替経費`, lines: claim.lines as never, total: claim.total });
}

/** 社内請求書のファイル名（Drive と税理士提出用で同じ名前にする） */
const claimFileName = (name: string, period: string, kind: "work" | "expense", issueDate: string) =>
  `請求書_${name}${Number(period.slice(0, 4))}年${Number(period.slice(5, 7))}月${kind === "work" ? "稼働分" : "分経費"}_${issueDate.replace(/-/g, "")}.pdf`;

function claimNumber(member: Member, period: string, kind: "work" | "expense") {
  return `${shiftMonth(period, 1).replace("-", "")}01-${member.number_suffix}${kind === "expense" ? "E" : ""}`;
}

/** 請求を作る（提出）。経費は領収書と1円単位で一致しないものがあると提出できない */
async function buildClaim(db: D1Database, member: Member, period: string, kind: "work" | "expense", body: { lines?: { name: string; qty: number; unit_price: number }[]; allow_missing_receipt?: boolean }) {
  const issue = jstNow().date;
  if (kind === "work") {
    const w = workLines(member, period, body.lines);
    if (!w.lines.length || w.total <= 0) throw new Error("稼働分の品目と金額を入力してください");
    return { ...w, items: [] as string[], number: claimNumber(member, period, kind), issue_date: issue, due_date: payDate(period) };
  }
  const items = await unclaimedItems(db, member.email, period);
  if (!items.length) throw new Error("請求する立替経費がありません");
  const mismatch = items.filter((i) => i.match === "mismatch");
  if (mismatch.length) {
    throw new Error(
      `領収書の金額と一致しない明細があります: ${mismatch.map((i) => `${i.spent_on} ${i.purpose}（明細 ${yen(Number(i.amount))} ／ 領収書 ${yen(Number(i.receipt_amount))}）`).join("、")}`,
    );
  }
  const missing = items.filter((i) => i.match === "no_receipt");
  if (missing.length && !body.allow_missing_receipt) throw new Error(`領収書が登録されていない明細があります: ${missing.map((i) => `${i.spent_on} ${i.purpose}`).join("、")}`);
  const lines = items.map((i) => ({ date: String(i.spent_on), purpose: String(i.purpose), amount: Number(i.amount) }));
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, subtotal: total, tax: 0, total, items: items.map((i) => String(i.id)), number: claimNumber(member, period, kind), issue_date: issue, due_date: payDate(period) };
}

/** 提出前の確認用（作成も保存もしない）。AI から「先に中身を見せて」と言われたとき用 */
export async function previewClaim(db: D1Database, memberEmail: string, period: string, kind: "work" | "expense", body: Parameters<typeof buildClaim>[4]) {
  if (!MONTH.test(period) || period < FIRST_PERIOD) throw new Error(`${monthFolder(FIRST_PERIOD)}以降を指定してください`);
  const member = await getMember(db, memberEmail);
  if (!member) throw new Error("提出者が見つかりません");
  const exists = await db.prepare("SELECT number FROM internal_claims WHERE member_email = ? AND period = ? AND kind = ?").bind(memberEmail, period, kind).first<{ number: string }>();
  if (exists) throw new Error(`この月の${kind === "work" ? "稼働分" : "立替経費"}はすでに提出済みです（No.${exists.number}）`);
  const claim = await buildClaim(db, member, period, kind, body);
  return { member: member.display_name, bank_registered: Boolean(member.bank_text), ...claim };
}

export async function submitClaim(env: Env, user: User, memberEmail: string, period: string, kind: "work" | "expense", body: Parameters<typeof buildClaim>[4]) {
  const db = env.DB;
  if (!MONTH.test(period) || period < FIRST_PERIOD) throw new Error(`${monthFolder(FIRST_PERIOD)}以降を指定してください`);
  const member = await getMember(db, memberEmail);
  if (!member) throw new Error("提出者が見つかりません");
  if (!member.bank_text.trim()) throw new Error(`${member.display_name}さんの振込先が未登録です。「社内請求・経費」の「振込先・既定の品目」から登録してから提出してください`);
  const exists = await db.prepare("SELECT id FROM internal_claims WHERE member_email = ? AND period = ? AND kind = ?").bind(memberEmail, period, kind).first();
  if (exists) throw new Error("この月の請求はすでに提出済みです。作り直す場合は取り消してから提出してください");
  const claim = await buildClaim(db, member, period, kind, body);
  const id = uuid();
  const settings = await getSettings(db);
  const html = claimHtml(settings, member, { kind, period, ...claim });
  const fileName = claimFileName(member.display_name, period, kind, claim.issue_date);
  const folders = ["社内請求・経費", monthFolder(period), member.display_name.slice(0, 2)];
  const doc = await storeDocument(env, html, `docs/internal/${id}.pdf`, [...folders, "請求書"], fileName);
  const stmts = [
    db.prepare(
      `INSERT INTO internal_claims (id, member_email, period, kind, number, issue_date, due_date, lines, subtotal, tax, total, pdf_key, drive_file_id, submitted_at, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, memberEmail, period, kind, claim.number, claim.issue_date, claim.due_date, JSON.stringify(claim.lines), claim.subtotal, claim.tax, claim.total, doc.pdf_key, doc.drive_file_id, nowIso(), user.id),
    ...claim.items.map((itemId) => db.prepare("UPDATE expense_items SET claim_id = ? WHERE id = ?").bind(id, itemId)),
  ];
  await db.batch(stmts);
  await audit(db, { userId: user.id, via: "web", action: "claim_submit", targetType: "internal_claim", targetId: id, detail: { member: memberEmail, period, kind } });
  return { id, warnings: doc.warnings, receipts_pending: kind === "expense" ? (await claimReceiptsLeft(db, id)) : 0 };
}

// ---------- 領収書を Drive へ（提出とは別の呼び出しで、少しずつ） ----------
// Cloudflare は1回の呼び出しで外へ出せる通信の数に上限があり、提出と同時に全部置くと途中から失敗する。
// 画面は提出のあと RECEIPTS_PER_CALL 件ずつ呼び出し、残りは毎時の定期処理でも置く

const RECEIPTS_PER_CALL = 3;

const RECEIPTS_LEFT_SQL = `FROM expense_items e
  JOIN receipts r ON r.id = e.receipt_id
  JOIN internal_claims c ON c.id = e.claim_id
  JOIN internal_members m ON m.email = c.member_email
 WHERE r.drive_file_id IS NULL`;

async function claimReceiptsLeft(db: D1Database, claimId: string) {
  const r = await db.prepare(`SELECT COUNT(*) AS n ${RECEIPTS_LEFT_SQL} AND c.id = ?`).bind(claimId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Drive に置く領収書の名前。CSV・写真と同じ番号（R019 など）を先頭に付ける。
 * 同じ日・同じ用途・同じ金額の領収書（往復の片道ずつの乗車券など）も、別々のファイルとして残す
 */
export function receiptDriveName(r: { file_name: string; spent_on: string; purpose: string; amount: number }) {
  const ext = r.file_name.split(".").pop();
  const num = /^(R\d+)_/i.exec(r.file_name)?.[1].toUpperCase();
  return safeName(`${num ? `${num}_` : ""}${r.spent_on}_${r.purpose}_${r.amount}円.${ext}`);
}

/**
 * 以前は同じ日・用途・金額の領収書が同じ名前になり、Drive で上書きされて片方が消えていた。
 * 1つの Drive ファイルを複数の領収書が指しているものは、置き直す対象に戻す（古いファイルはゴミ箱へ）
 */
async function repairSharedReceiptFiles(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT drive_file_id AS id FROM receipts WHERE drive_file_id IS NOT NULL AND drive_file_id != '' GROUP BY drive_file_id HAVING COUNT(*) > 1",
  ).all<{ id: string }>();
  for (const { id } of results) {
    await env.DB.prepare("UPDATE receipts SET drive_file_id = NULL WHERE drive_file_id = ?").bind(id).run();
    await trashDriveFile(env, id).catch(() => {});
  }
}

/** 提出済みの経費の領収書を「立替領収書」フォルダへ置く（claimId を省くと全部の請求から）。Drive 側で失敗したら止めて、次の呼び出しでやり直す */
export async function saveClaimReceiptsToDrive(env: Env, claimId?: string, limit = RECEIPTS_PER_CALL) {
  const db = env.DB;
  if (await googleReady(env)) await repairSharedReceiptFiles(env);
  const { results } = await db
    .prepare(
      `SELECT r.id, r.file_key, r.file_name, r.mime, r.amount, e.spent_on, e.purpose, c.period, m.display_name
       ${RECEIPTS_LEFT_SQL} ${claimId ? "AND c.id = ?" : ""} ORDER BY c.submitted_at, e.spent_on LIMIT ?`,
    )
    .bind(...(claimId ? [claimId, limit] : [limit]))
    .all<Record<string, string | number>>();
  const warnings: string[] = [];
  let saved = 0;
  if (!results.length) return { saved, remaining: 0, warnings };
  if (!(await googleReady(env))) return { saved, remaining: claimId ? await claimReceiptsLeft(db, claimId) : 0, warnings: ["Google と連携していないため、領収書は Drive に保存していません（管理画面の「Google と連携」）"] };
  // フォルダは1回の呼び出しの中で1度だけ調べる（通信の数を減らすため）
  const parent = (await getSettings(db)).drive_parent_id;
  const folderIds = new Map<string, string>();
  try {
    for (const r of results) {
      const obj = await env.IMAGES.get(String(r.file_key));
      if (!obj) {
        // 置くものがないので空文字にして、次から飛ばす
        await db.prepare("UPDATE receipts SET drive_file_id = '' WHERE id = ?").bind(r.id).run();
        warnings.push(`領収書の画像が見つからないため Drive に置けませんでした（${r.spent_on} ${r.purpose}）`);
        continue;
      }
      const folders = ["社内請求・経費", monthFolder(String(r.period)), String(r.display_name).slice(0, 2), "立替領収書"];
      const key = folders.join("/");
      if (!folderIds.has(key)) folderIds.set(key, await ensureFolder(env, parent, folders));
      const name = receiptDriveName({ file_name: String(r.file_name), spent_on: String(r.spent_on), purpose: String(r.purpose), amount: Number(r.amount) });
      const driveId = await uploadToDrive(env, folderIds.get(key)!, name, String(r.mime), await obj.arrayBuffer(), { keepExisting: true });
      await db.prepare("UPDATE receipts SET drive_file_id = ? WHERE id = ?").bind(driveId, r.id).run();
      saved++;
    }
  } catch (e) {
    // Drive 側の失敗（連携切れ・上限など）は、次の呼び出しでやり直す
    warnings.push(`Google Drive への保存に失敗しました: ${e instanceof Error ? e.message : e}`);
  }
  return { saved, remaining: claimId ? await claimReceiptsLeft(db, claimId) : 0, warnings };
}

// ---------- 通知（Google Chat） ----------
//   月末 21時          経費登録と請求書の発行のお願い（まだの人をメンション）
//   1日 10・14・19時    まだの人だけをメンションしてリマインド
//   全員そろったら      代表（設定された代表者）をメンションして「税理士に送ってください」（1か月に1回）
// 原本の手渡しは期限を設けないので、通知しない（画面で人ごとにチェックする）

export interface MemberMonthStatus {
  email: string;
  name: string;
  work: boolean;
  expense: boolean;
  no_expense: boolean;
  pending_items: number;
  /** 立替経費は済んだか（請求書を発行した、または「今月は立替経費なし」） */
  expense_done: boolean;
  /** Drive にまだ置けていない領収書の写真 */
  drive_pending: number;
  /** 原本をまだ渡していない領収書（この月の請求に含めたもの） */
  originals_pending: number;
  done: boolean;
}

/** その月の、人ごとのやることの状況 */
export async function monthStatus(db: D1Database, period: string) {
  const { results: members } = await db.prepare("SELECT email, display_name FROM internal_members WHERE active = 1 ORDER BY number_suffix DESC").all<{ email: string; display_name: string }>();
  const rows: MemberMonthStatus[] = [];
  for (const m of members) {
    const [claims, none, receipts] = await db.batch([
      db.prepare("SELECT kind FROM internal_claims WHERE member_email = ? AND period = ?").bind(m.email, period),
      db.prepare("SELECT 1 AS x FROM internal_no_expense WHERE member_email = ? AND period = ?").bind(m.email, period),
      db
        .prepare(
          `SELECT COALESCE(SUM(r.drive_file_id IS NULL), 0) AS drive, COALESCE(SUM(r.original_submitted_at IS NULL), 0) AS originals
             FROM expense_items e JOIN receipts r ON r.id = e.receipt_id JOIN internal_claims c ON c.id = e.claim_id
            WHERE c.member_email = ? AND c.period = ?`,
        )
        .bind(m.email, period),
    ]);
    const kinds = (claims.results as { kind: string }[]).map((c) => c.kind);
    const r = receipts.results[0] as { drive: number; originals: number };
    const pending = (await unclaimedItems(db, m.email, period)).length;
    const work = kinds.includes("work");
    const expense = kinds.includes("expense");
    const noExpense = none.results.length > 0;
    const expenseDone = expense || (noExpense && pending === 0);
    rows.push({
      email: m.email,
      name: m.display_name,
      work,
      expense,
      no_expense: noExpense,
      pending_items: pending,
      expense_done: expenseDone,
      drive_pending: Number(r.drive),
      originals_pending: Number(r.originals),
      done: work && expenseDone,
    });
  }
  return { members: rows, complete: rows.length > 0 && rows.every((x) => x.done && x.drive_pending === 0) };
}

const md = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const shortName = (name: string) => name.slice(0, 2);

/** まだの人ごとの「残っていること」 */
function leftText(m: MemberMonthStatus) {
  return [!m.work && "稼働分の請求書", !m.expense_done && "立替経費の請求書（なければ「今月は立替経費なし」）"].filter(Boolean).join("・");
}

/** 月末21時のお願い（request）と、1日のリマインド（remind）。全員済んでいれば null */
export async function claimChatText(env: Env, period: string, kind: "request" | "remind") {
  const { members } = await monthStatus(env.DB, period);
  const left = members.filter((m) => !m.done);
  if (!left.length) return null;
  const settings = await getSettings(env.DB);
  const mentions = (await Promise.all(left.map((x) => chatMention(env.DB, x.email, x.name)))).join(" ");
  const m = Number(period.slice(5, 7));
  const url = `${settings.app_url}/internal`;
  if (kind === "request") {
    return [
      mentions,
      `🧾 *${m}月分の経費登録と請求書の発行をお願いします*`,
      `期限は ${md(deadlineOf(period))} まで、支払いは ${md(payDate(period))} です。`,
      "① 稼働分の請求書: 「プレビュー」で金額を確認して、赤い「発行する」",
      "② 立替経費: 領収書を登録して「プレビュー」で確認し、赤い「発行する」（なければ「今月は立替経費なし」）",
      "発行すると、請求書と領収書の写真が Google Drive に入ります。",
      url,
    ].join("\n");
  }
  return [
    mentions,
    `⏰ *${m}月分の経費登録・請求書の発行がまだです*（期限 ${md(deadlineOf(period))}）`,
    ...left.map((x) => `・${shortName(x.name)}: ${leftText(x)}`),
    url,
  ].join("\n");
}

/**
 * 全員の請求書の発行と、領収書の写真の Drive 保存がそろったら、代表（設定された代表者）に Google Chat で知らせる（1か月に1回）。
 * 発行・Drive 保存・「立替経費なし」のたびと、毎時の定期処理から呼ぶ
 */
export async function notifyClaimsComplete(env: Env, period: string): Promise<string> {
  if (period < CHAT_FLOW_FROM) return `${monthFolder(CHAT_FLOW_FROM)}から自動で連絡します`;
  const { members, complete } = await monthStatus(env.DB, period);
  if (!complete) {
    const left = members.filter((m) => !m.done || m.drive_pending > 0);
    return `まだそろっていません（${left.map((x) => `${shortName(x.name)}: ${x.done ? `領収書の写真 ${x.drive_pending} 枚を Drive に保存中` : leftText(x)}`).join("、")}）`;
  }
  const key = `claims-complete:${period}`;
  if (!(await claimJob(env.DB, key))) return "連絡済みです";
  const settings = await getSettings(env.DB);
  let folder = `${settings.app_url}/internal`;
  if (await googleReady(env)) {
    folder = await ensureFolder(env, settings.drive_parent_id, ["社内請求・経費", monthFolder(period)]).then(
      (id) => `https://drive.google.com/drive/folders/${id}`,
      () => folder,
    );
  }
  const m = Number(period.slice(5, 7));
  const names = members.map((x) => shortName(x.name)).join("・");
  const cc = (await Promise.all(members.map((x) => chatMention(env.DB, x.email, x.name)))).join(" ");
  const noExpense = members.filter((x) => !x.expense);
  const originals = members.reduce((s, x) => s + x.originals_pending, 0);
  const text = [
    folder,
    "",
    await chatMention(env.DB, settings.claim_payer_email),
    `CC: ${cc}`,
    `${m}月分の経費の登録と請求書の発行が完了しました。こちらに${names}の以下の書類を格納済みです。`,
    "・立替領収書の写真",
    "・立替経費の請求書",
    "・稼働分の請求書",
    ...(noExpense.length ? [`（${noExpense.map((x) => shortName(x.name)).join("・")}は今月の立替経費なし）`] : []),
    "",
    `中身を確認して、税理士に送ってください。${md(payDate(period))}までに支払いをお願いします。`,
    ...(originals ? [`領収書の原本（${originals}枚）は、次に会うときに渡します。`] : []),
    "",
    "（名刺管理アプリからの自動連絡です）",
  ].join("\n");
  if (!(await sendChat(env, text))) {
    // 送れなかったら次の機会（毎時の定期処理）にやり直す
    await env.DB.prepare("DELETE FROM job_runs WHERE key = ?").bind(key).run();
    return env.GOOGLE_CHAT_WEBHOOK_URL ? "Google Chat への送信に失敗しました（1時間後にやり直します）" : "Google Chat が未設定のため送信しませんでした";
  }
  return "代表に Google Chat で連絡しました";
}

/** 画面・AI からの操作のあとで、そろっていれば連絡する（操作の応答は待たせない） */
function afterChange(c: Context<AppEnv>, period: string) {
  c.executionCtx.waitUntil(notifyClaimsComplete(c.env, period).catch((e) => console.error("notifyClaimsComplete", e)));
}

// ---------- 画面用 API ----------

const canWrite = (c: Context<AppEnv>) => c.get("user").role !== "viewer";
/** 社内請求・経費・領収書を変えられるのは本人と管理者だけ（見るのは全員） */
export const selfOrAdmin = (user: { role: string; email: string }, memberEmail: string) => user.role === "admin" || user.email === memberEmail;
const notYours = (c: Context<AppEnv>) => c.json({ error: "他の人の社内請求・経費・領収書は、本人と管理者だけが変更できます" }, 403);
const denied = (c: Context<AppEnv>) => c.json({ error: "閲覧のみの権限では変更できません" }, 403);

export function registerInternalRoutes(api: Hono<AppEnv>) {
  api.get("/internal/members", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM internal_members WHERE active = 1 ORDER BY number_suffix DESC").all();
    return c.json({ members: results });
  });

  api.patch("/internal/members/:email", async (c) => {
    if (!canWrite(c)) return denied(c);
    const me = c.get("user");
    // 振込先は本人か管理者だけが変えられる（他人の振込先を書き換えて支払いを横取りできないように）
    if (me.role !== "admin" && me.email !== c.req.param("email")) return c.json({ error: "振込先・既定の品目を変えられるのは本人と管理者だけです" }, 403);
    const b = await c.req.json<Partial<Member>>();
    if (String(b.bank_text ?? "").length > 300 || String(b.default_item ?? "").length > 200 || String(b.display_name ?? "").length > 50) return c.json({ error: "入力が長すぎます" }, 400);
    await c.env.DB.prepare(
      `UPDATE internal_members SET display_name = COALESCE(?, display_name), bank_text = COALESCE(?, bank_text),
         default_item = COALESCE(?, default_item), default_unit_price = COALESCE(?, default_unit_price) WHERE email = ?`,
    )
      .bind(b.display_name ?? null, b.bank_text ?? null, b.default_item ?? null, b.default_unit_price ?? null, c.req.param("email"))
      .run();
    await audit(c.env.DB, {
      userId: c.get("user").id,
      via: "web",
      action: "member_update",
      targetType: "internal_member",
      targetId: c.req.param("email"),
      detail: { changed: Object.keys(b).filter((k) => ["display_name", "bank_text", "default_item", "default_unit_price"].includes(k)) },
    });
    return c.json({ ok: true });
  });

  // 月の状況（全員分）
  api.get("/internal/overview", async (c) => {
    const p = c.req.query("period");
    const period = p && MONTH.test(p) ? p : shiftMonth(jstNow().month, -1) < FIRST_PERIOD ? FIRST_PERIOD : shiftMonth(jstNow().month, -1);
    const db = c.env.DB;
    const { results: members } = await db.prepare("SELECT * FROM internal_members WHERE active = 1 ORDER BY number_suffix DESC").all<Member>();
    const rows = [];
    for (const m of members) {
      const { results: claims } = await db
        .prepare("SELECT c.*, u.name AS paid_by_name FROM internal_claims c LEFT JOIN users u ON u.id = c.paid_by WHERE c.member_email = ? AND c.period = ?")
        .bind(m.email, period)
        .all<Record<string, unknown>>();
      const { results: claimedItems } = await db
        .prepare(
          `SELECT e.*, r.amount AS receipt_amount, r.file_name AS receipt_name, r.original_submitted_at FROM expense_items e
             LEFT JOIN receipts r ON r.id = e.receipt_id JOIN internal_claims c ON c.id = e.claim_id
            WHERE c.member_email = ? AND c.period = ? ORDER BY e.spent_on`,
        )
        .bind(m.email, period)
        .all();
      rows.push({
        member: m,
        work: claims.find((x) => x.kind === "work") ?? null,
        expense: claims.find((x) => x.kind === "expense") ?? null,
        pending_items: await unclaimedItems(db, m.email, period),
        claimed_items: claimedItems,
        work_preview: workLines(m, period),
      });
    }
    const settings = await getSettings(db);
    const status = await monthStatus(db, period);
    const payer = await db.prepare("SELECT name FROM users WHERE lower(email) = lower(?)").bind(settings.claim_payer_email).first<{ name: string }>();
    const notified = await db.prepare("SELECT ran_at FROM job_runs WHERE key = ?").bind(`claims-complete:${period}`).first<{ ran_at: string }>();
    return c.json({
      period,
      deadline: deadlineOf(period),
      pay_date: payDate(period),
      first_period: FIRST_PERIOD,
      chat_flow_from: CHAT_FLOW_FROM,
      payer_email: settings.claim_payer_email,
      payer_name: payer?.name || "代表",
      complete: status.complete,
      notified_at: notified?.ran_at ?? null,
      rows: rows.map((r) => ({ ...r, status: status.members.find((x) => x.email === r.member.email) })),
    });
  });

  // 領収書
  api.post("/internal/receipts", async (c) => {
    if (!canWrite(c)) return denied(c);
    const form = await c.req.formData();
    const file = form.get("file") as unknown as File | null;
    const email = String(form.get("member_email") ?? "");
    if (!selfOrAdmin(c.get("user"), email)) return notYours(c);
    const amount = Number(form.get("amount"));
    const paidOn = String(form.get("paid_on") ?? "");
    const vendor = String(form.get("vendor") ?? "").trim();
    const purpose = String(form.get("purpose") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    if (purpose.length > 200 || vendor.length > 200 || note.length > 500) return c.json({ error: "用途・支払先・メモが長すぎます" }, 400);
    if (!file) return c.json({ error: "領収書のファイルを選んでください" }, 400);
    const ext = RECEIPT_TYPES[file.type];
    if (!ext) return c.json({ error: "写真（JPG・PNG）か PDF を選んでください" }, 400);
    if (file.size > MAX_RECEIPT_BYTES) return c.json({ error: "ファイルが大きすぎます（15MBまで）" }, 400);
    if (!Number.isInteger(amount) || amount <= 0) return c.json({ error: "金額は領収書のとおり1円単位で入力してください" }, 400);
    if (!DATE.test(paidOn)) return c.json({ error: "領収書の日付を入力してください" }, 400);
    if (!(await getMember(c.env.DB, email))) return c.json({ error: "提出者が見つかりません" }, 400);
    const id = uuid();
    const key = `receipts/${paidOn.slice(0, 7)}/${id}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    const user = c.get("user");
    const at = nowIso();
    const stmts = [
      c.env.DB.prepare("INSERT INTO receipts (id, member_email, file_key, file_name, mime, amount, paid_on, vendor, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, email, key, file.name || `receipt.${ext}`, file.type, amount, paidOn, vendor, user.id, at),
    ];
    // 用途を入れた場合は、同じ日付・金額で経費の明細も作る
    if (purpose) {
      stmts.push(
        c.env.DB.prepare("INSERT INTO expense_items (id, member_email, spent_on, purpose, amount, receipt_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(uuid(), email, paidOn, purpose, amount, id, note, user.id, at),
      );
    }
    await c.env.DB.batch(stmts);
    return c.json({ id });
  });

  api.get("/internal/receipts", async (c) => {
    const email = c.req.query("member");
    const { results } = await c.env.DB.prepare(
      `SELECT r.*, u.name AS checked_by_name,
              (SELECT COUNT(*) FROM expense_items e WHERE e.receipt_id = r.id) AS used
         FROM receipts r LEFT JOIN users u ON u.id = r.original_checked_by
        ${email ? "WHERE r.member_email = ?" : ""} ORDER BY r.original_submitted_at IS NOT NULL, r.paid_on DESC LIMIT 300`,
    )
      .bind(...(email ? [email] : []))
      .all();
    return c.json({ receipts: results });
  });

  api.get("/internal/receipts/:id/file", async (c) => {
    const r = await c.env.DB.prepare("SELECT file_key, file_name FROM receipts WHERE id = ?").bind(c.req.param("id")).first<{ file_key: string; file_name: string }>();
    return documentResponse(c.env, r?.file_key ?? null, r?.file_name ?? "receipt");
  });

  // まとめて原本提出済みにする（本人か管理者の分だけ。ほかの人の分は飛ばす）
  api.post("/internal/receipts/original-bulk", async (c) => {
    if (!canWrite(c)) return denied(c);
    const { ids, submitted } = await c.req.json<{ ids: string[]; submitted: boolean }>();
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) return c.json({ error: "対象の領収書を選んでください（500件まで）" }, 400);
    const user = c.get("user");
    const db = c.env.DB;
    const rows: { id: string; member_email: string }[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map(String);
      const { results } = await db.prepare(`SELECT id, member_email FROM receipts WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; member_email: string }>();
      rows.push(...results);
    }
    const allowed = rows.filter((r) => selfOrAdmin(user, r.member_email));
    const at = submitted ? nowIso() : null;
    await db.batch(
      allowed.map((r) => db.prepare("UPDATE receipts SET original_submitted_at = ?, original_checked_by = ? WHERE id = ?").bind(at, submitted ? user.id : null, r.id)),
    );
    await audit(db, { userId: user.id, via: "web", action: "receipt_original", targetType: "receipt", detail: { submitted, count: allowed.length } });
    return c.json({ updated: allowed.length, skipped: ids.length - allowed.length });
  });

  api.post("/internal/receipts/:id/original", async (c) => {
    if (!canWrite(c)) return denied(c);
    const { submitted } = await c.req.json<{ submitted: boolean }>();
    const user = c.get("user");
    // 原本提出済みは、その領収書の本人か管理者がチェックする
    const rc = await c.env.DB.prepare("SELECT member_email FROM receipts WHERE id = ?").bind(c.req.param("id")).first<{ member_email: string }>();
    if (!rc) return c.json({ error: "見つかりません" }, 404);
    if (!selfOrAdmin(user, rc.member_email)) return c.json({ error: "原本提出済みのチェックは、本人と管理者だけが付けられます" }, 403);
    await c.env.DB.prepare("UPDATE receipts SET original_submitted_at = ?, original_checked_by = ? WHERE id = ?")
      .bind(submitted ? nowIso() : null, submitted ? user.id : null, c.req.param("id"))
      .run();
    await audit(c.env.DB, { userId: user.id, via: "web", action: "receipt_original", targetType: "receipt", targetId: c.req.param("id"), detail: { submitted } });
    return c.json({ ok: true });
  });

  api.delete("/internal/receipts/:id", async (c) => {
    if (!canWrite(c)) return denied(c);
    const owner = await c.env.DB.prepare("SELECT member_email FROM receipts WHERE id = ?").bind(c.req.param("id")).first<{ member_email: string }>();
    if (owner && !selfOrAdmin(c.get("user"), owner.member_email)) return notYours(c);
    const used = await c.env.DB.prepare("SELECT 1 FROM expense_items WHERE receipt_id = ? AND claim_id IS NOT NULL").bind(c.req.param("id")).first();
    if (used) return c.json({ error: "提出済みの請求に含まれている領収書は削除できません" }, 400);
    const r = await c.env.DB.prepare("SELECT file_key FROM receipts WHERE id = ?").bind(c.req.param("id")).first<{ file_key: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE expense_items SET receipt_id = NULL WHERE receipt_id = ?").bind(c.req.param("id")),
      c.env.DB.prepare("DELETE FROM receipts WHERE id = ?").bind(c.req.param("id")),
    ]);
    if (r) await c.env.IMAGES.delete(r.file_key);
    return c.json({ ok: true });
  });

  // 経費の明細
  api.post("/internal/expenses", async (c) => {
    if (!canWrite(c)) return denied(c);
    const b = await c.req.json<{ member_email: string; spent_on: string; purpose: string; amount: number; receipt_id?: string; note?: string }>();
    if (!selfOrAdmin(c.get("user"), b.member_email)) return notYours(c);
    if (!(await getMember(c.env.DB, b.member_email))) return c.json({ error: "提出者が見つかりません" }, 400);
    if (!DATE.test(b.spent_on) || b.spent_on < EARLIEST_EXPENSE_DATE) return c.json({ error: `日付は ${jpDate(EARLIEST_EXPENSE_DATE)} 以降で入力してください` }, 400);
    if (!b.purpose?.trim()) return c.json({ error: "用途を入力してください" }, 400);
    if (b.purpose.length > 200 || String(b.note ?? "").length > 500) return c.json({ error: "用途・メモが長すぎます" }, 400);
    if (!Number.isInteger(Number(b.amount)) || Number(b.amount) <= 0) return c.json({ error: "金額は1円単位の整数で入力してください" }, 400);
    const id = uuid();
    await c.env.DB.prepare("INSERT INTO expense_items (id, member_email, spent_on, purpose, amount, receipt_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, b.member_email, b.spent_on, b.purpose.trim(), Number(b.amount), b.receipt_id || null, b.note ?? "", c.get("user").id, nowIso())
      .run();
    return c.json({ id });
  });

  api.patch("/internal/expenses/:id", async (c) => {
    if (!canWrite(c)) return denied(c);
    const item = await c.env.DB.prepare("SELECT claim_id, member_email FROM expense_items WHERE id = ?").bind(c.req.param("id")).first<{ claim_id: string | null; member_email: string }>();
    if (!item) return c.json({ error: "見つかりません" }, 404);
    if (!selfOrAdmin(c.get("user"), item.member_email)) return notYours(c);
    if (item.claim_id) return c.json({ error: "提出済みの明細は変更できません（請求を取り消してから変更してください）" }, 400);
    const b = await c.req.json<{ spent_on?: string; purpose?: string; amount?: number; receipt_id?: string | null }>();
    await c.env.DB.prepare(
      "UPDATE expense_items SET spent_on = COALESCE(?, spent_on), purpose = COALESCE(?, purpose), amount = COALESCE(?, amount), receipt_id = CASE WHEN ? THEN ? ELSE receipt_id END WHERE id = ?",
    )
      .bind(b.spent_on ?? null, b.purpose ?? null, b.amount ?? null, b.receipt_id !== undefined ? 1 : 0, b.receipt_id ?? null, c.req.param("id"))
      .run();
    return c.json({ ok: true });
  });

  api.delete("/internal/expenses/:id", async (c) => {
    if (!canWrite(c)) return denied(c);
    const owner = await c.env.DB.prepare("SELECT member_email FROM expense_items WHERE id = ?").bind(c.req.param("id")).first<{ member_email: string }>();
    if (owner && !selfOrAdmin(c.get("user"), owner.member_email)) return notYours(c);
    const r = await c.env.DB.prepare("DELETE FROM expense_items WHERE id = ? AND claim_id IS NULL").bind(c.req.param("id")).run();
    return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "提出済みの明細は削除できません" }, 400);
  });

  // 「今月は立替経費なし」（立替経費の請求書を出さない月も、やることを「済み」にする）
  api.post("/internal/no-expense", async (c) => {
    if (!canWrite(c)) return denied(c);
    const b = await c.req.json<{ member_email: string; period: string; none: boolean }>();
    if (!selfOrAdmin(c.get("user"), b.member_email)) return notYours(c);
    if (!MONTH.test(b.period)) return c.json({ error: "対象月を指定してください" }, 400);
    if (!(await getMember(c.env.DB, b.member_email))) return c.json({ error: "提出者が見つかりません" }, 400);
    if (b.none) {
      if ((await unclaimedItems(c.env.DB, b.member_email, b.period)).length) return c.json({ error: "未請求の立替経費が登録されています。削除するか、立替経費の請求書を発行してください" }, 400);
      await c.env.DB.prepare("INSERT OR IGNORE INTO internal_no_expense (member_email, period, declared_at, declared_by) VALUES (?, ?, ?, ?)")
        .bind(b.member_email, b.period, nowIso(), c.get("user").id)
        .run();
      afterChange(c, b.period);
    } else {
      await c.env.DB.prepare("DELETE FROM internal_no_expense WHERE member_email = ? AND period = ?").bind(b.member_email, b.period).run();
    }
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "claim_no_expense", targetType: "internal_member", targetId: b.member_email, detail: { period: b.period, none: b.none } });
    return c.json({ ok: true });
  });

  // 請求の提出・プレビュー・取り消し
  api.post("/internal/claims/preview", async (c) => {
    const b = await c.req.json<{ member_email: string; period: string; kind: "work" | "expense"; lines?: never[]; allow_missing_receipt?: boolean }>();
    const member = await getMember(c.env.DB, b.member_email);
    if (!member) return c.json({ error: "提出者が見つかりません" }, 400);
    try {
      const claim = await buildClaim(c.env.DB, member, b.period, b.kind, { lines: b.lines, allow_missing_receipt: true });
      return c.html(claimHtml(await getSettings(c.env.DB), member, { kind: b.kind, period: b.period, ...claim }));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/internal/claims", async (c) => {
    if (!canWrite(c)) return denied(c);
    const b = await c.req.json<{ member_email: string; period: string; kind: "work" | "expense"; lines?: { name: string; qty: number; unit_price: number }[]; allow_missing_receipt?: boolean }>();
    try {
      if (!selfOrAdmin(c.get("user"), b.member_email)) return notYours(c);
      const r = await submitClaim(c.env, c.get("user"), b.member_email, b.period, b.kind, b);
      if (!r.receipts_pending) afterChange(c, b.period);
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 提出した経費の領収書を Drive へ（画面が残りが 0 になるまで繰り返し呼ぶ）
  api.post("/internal/claims/:id/drive-receipts", async (c) => {
    const claim = await c.env.DB.prepare("SELECT member_email, period FROM internal_claims WHERE id = ?").bind(c.req.param("id")).first<{ member_email: string; period: string }>();
    if (!claim) return c.json({ error: "見つかりません" }, 404);
    if (!selfOrAdmin(c.get("user"), claim.member_email)) return notYours(c);
    const r = await saveClaimReceiptsToDrive(c.env, c.req.param("id"));
    if (!r.remaining) afterChange(c, claim.period);
    return c.json(r);
  });

  api.delete("/internal/claims/:id", async (c) => {
    if (!canWrite(c)) return denied(c);
    const claim = await c.env.DB.prepare("SELECT status, pdf_key, member_email FROM internal_claims WHERE id = ?").bind(c.req.param("id")).first<{ status: string; pdf_key: string | null; member_email: string }>();
    if (!claim) return c.json({ error: "見つかりません" }, 404);
    if (!selfOrAdmin(c.get("user"), claim.member_email)) return notYours(c);
    if (claim.status === "paid") return c.json({ error: "精算済みの請求は取り消せません" }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE expense_items SET claim_id = NULL WHERE claim_id = ?").bind(c.req.param("id")),
      c.env.DB.prepare("DELETE FROM internal_claims WHERE id = ?").bind(c.req.param("id")),
    ]);
    if (claim.pdf_key) await c.env.IMAGES.delete(claim.pdf_key);
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "claim_cancel", targetType: "internal_claim", targetId: c.req.param("id") });
    return c.json({ ok: true, note: "Google Drive に保存した PDF は残っています。不要なら Drive で削除してください" });
  });

  api.post("/internal/claims/:id/paid", async (c) => {
    if (!canWrite(c)) return denied(c);
    const { paid } = await c.req.json<{ paid: boolean }>();
    const user = c.get("user");
    // 精算済み（支払った）のチェックは代表だけが付けられる。請求した本人や管理者でも付けられない
    const payer = (await getSettings(c.env.DB)).claim_payer_email;
    if (user.email !== payer) return c.json({ error: "精算済みのチェックは代表（支払いをする人）だけが付けられます" }, 403);
    await c.env.DB.prepare("UPDATE internal_claims SET status = ?, paid_at = ?, paid_by = ? WHERE id = ?")
      .bind(paid ? "paid" : "submitted", paid ? nowIso() : null, paid ? user.id : null, c.req.param("id"))
      .run();
    await audit(c.env.DB, { userId: user.id, via: "web", action: "claim_paid", targetType: "internal_claim", targetId: c.req.param("id"), detail: { paid } });
    return c.json({ ok: true });
  });

  // 税理士に渡すファイルの一覧（ZIP はブラウザで作る。Worker のメモリに写真をまとめて載せないため）
  api.get("/internal/export", async (c) => {
    const period = c.req.query("period") ?? "";
    if (!MONTH.test(period)) return c.json({ error: "対象月を指定してください" }, 400);
    const db = c.env.DB;
    const settings = await getSettings(db);
    const { results: invoices } = await db
      .prepare(
        `SELECT i.id, i.number, i.issue_date, i.total, i.imported, c.name AS customer FROM customer_invoices i JOIN customers c ON c.id = i.customer_id
          WHERE i.period = ? AND i.status != 'draft' AND i.pdf_key IS NOT NULL ORDER BY i.number`,
      )
      .bind(period)
      .all<{ id: string; number: string; issue_date: string; total: number; imported: number; customer: string }>();
    const { results: claims } = await db
      .prepare(
        `SELECT c.id, c.kind, c.number, c.issue_date, c.total, c.status, m.display_name FROM internal_claims c JOIN internal_members m ON m.email = c.member_email
          WHERE c.period = ? AND c.pdf_key IS NOT NULL ORDER BY m.number_suffix DESC, c.kind DESC`,
      )
      .bind(period)
      .all<{ id: string; kind: "work" | "expense"; number: string; issue_date: string; total: number; status: string; display_name: string }>();
    const { results: expenses } = await db
      .prepare(
        `SELECT e.spent_on, e.purpose, e.amount, e.note, m.display_name, c.number AS claim_number,
                r.id AS receipt_id, r.vendor, r.file_name, r.mime, r.amount AS receipt_amount, r.original_submitted_at
           FROM expense_items e JOIN internal_claims c ON c.id = e.claim_id JOIN internal_members m ON m.email = e.member_email
           LEFT JOIN receipts r ON r.id = e.receipt_id
          WHERE c.period = ? ORDER BY m.number_suffix DESC, e.spent_on, e.created_at`,
      )
      .bind(period)
      .all<Record<string, string | number | null>>();
    const pending = await db
      .prepare(
        `SELECT m.display_name, COUNT(*) AS n FROM expense_items e JOIN internal_members m ON m.email = e.member_email
          WHERE e.claim_id IS NULL AND e.spent_on <= ? AND e.spent_on >= ? GROUP BY m.display_name`,
      )
      .bind(lastDayOf(period), EARLIEST_EXPENSE_DATE)
      .all<{ display_name: string; n: number }>();
    return c.json({
      period,
      invoices: invoices.map((i) => ({
        ...i,
        url: `/api/billing/invoices/${i.id}/file`,
        file_name: safeName(`請求書_${settings.company_name}_${i.customer}_${String(i.issue_date).replace(/-/g, "")}_${i.total}円_No${i.number}.pdf`),
      })),
      claims: claims.map((x) => ({ ...x, url: `/api/internal/claims/${x.id}/file`, file_name: safeName(claimFileName(x.display_name, period, x.kind, x.issue_date)) })),
      expenses: expenses.map((e) => ({ ...e, url: e.receipt_id ? `/api/internal/receipts/${e.receipt_id}/file` : null })),
      pending: pending.results,
    });
  });

  api.get("/internal/claims/:id/file", async (c) => {
    const r = await c.env.DB.prepare("SELECT pdf_key, number FROM internal_claims WHERE id = ?").bind(c.req.param("id")).first<{ pdf_key: string | null; number: string }>();
    return documentResponse(c.env, r?.pdf_key ?? null, `請求書_${r?.number}.pdf`);
  });
}
