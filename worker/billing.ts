// 顧客請求管理: 顧客マスタ → 見積書 → 契約 → 請求書作成（毎月15日〜）→ 送付 → 連絡
import type { Context, Hono } from "hono";
import { companyKey } from "../shared/fields";
import type { AppEnv, User } from "./session";
import { audit, nowIso, uuid } from "./people";
import { chatMention, jstNow, shiftMonth } from "./notify";
import { getSettings } from "./settings";
import { customerInvoiceHtml, quoteHtml, type InvoiceLine, type QuoteItem } from "./templates";
import { documentResponse, monthFolder, saveToDrive, storeDocument } from "./documents";
import { trashDriveFile } from "./google";

const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const TAX_RATE = 0.1;
const taxOf = (subtotal: number) => Math.floor(subtotal * TAX_RATE);
const withTax = (n: number) => Math.round(n * (1 + TAX_RATE));

export function monthsFrom(start: string, until: string, max = 60): string[] {
  const out: string[] = [];
  let [y, m] = start.split("-").map(Number);
  while (out.length < max) {
    const p = `${y}-${String(m).padStart(2, "0")}`;
    if (p > until) break;
    out.push(p);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const lastDayOf = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// ---------- 契約 → 請求書の明細 ----------

interface ContractRow {
  id: string;
  customer_id: string | null;
  company_name: string;
  title: string;
  item_name: string;
  amount: number; // 税抜
  cycle: "monthly" | "count" | "once";
  count_total: number | null;
  start_month: string;
  end_month: string | null;
  period_style: "month" | "range";
  status: string;
}

/** その契約が period に請求するなら何回目か（しないなら 0） */
export function occurrence(c: Pick<ContractRow, "cycle" | "start_month" | "end_month" | "count_total">, period: string) {
  let months = monthsFrom(c.start_month, period);
  if (c.cycle === "monthly" && c.end_month) months = months.filter((p) => p <= c.end_month!);
  if (c.cycle === "count") months = months.slice(0, c.count_total ?? 0);
  if (c.cycle === "once") months = months.slice(0, 1);
  const i = months.indexOf(period);
  return i + 1;
}

export function periodLabel(c: Pick<ContractRow, "cycle" | "period_style">, period: string) {
  if (c.cycle === "once") return "";
  const m = Number(period.slice(5, 7));
  return c.period_style === "range" ? `${m}/1〜${m}/${Number(lastDayOf(period).slice(8))}` : `${m}月分`;
}

/** 顧客・月の請求書の明細を契約から作る（金額は税込で表示、合計は税抜＋消費税） */
export async function buildLines(db: D1Database, customerId: string, period: string) {
  const { results } = await db
    .prepare("SELECT * FROM contracts WHERE customer_id = ? AND status = 'active' AND start_month <= ? ORDER BY cycle DESC, start_month, title")
    .bind(customerId, period)
    .all<ContractRow>();
  const billable = results.filter((c) => occurrence(c, period) > 0);
  const lines: InvoiceLine[] = billable.map((c) => {
    const nth = occurrence(c, period);
    const name = (c.item_name || c.title) + (c.cycle === "count" ? `（${nth}/${c.count_total}回目）` : "");
    return { period_label: periodLabel(c, period), name, qty: 1, unit_price: withTax(c.amount), amount: withTax(c.amount) };
  });
  const subtotal = billable.reduce((s, c) => s + c.amount, 0);
  return { lines, subtotal, tax: taxOf(subtotal), total: subtotal + taxOf(subtotal) };
}

/** その月の請求書の下書きを作る（契約が変わっていれば、下書きのものだけ作り直す） */
export async function prepareInvoices(db: D1Database, period: string, userId: string | null) {
  const { results: customers } = await db.prepare("SELECT id FROM customers WHERE active = 1").all<{ id: string }>();
  let created = 0;
  for (const c of customers) {
    const b = await buildLines(db, c.id, period);
    if (!b.lines.length) continue;
    const existing = await db.prepare("SELECT id, status FROM customer_invoices WHERE customer_id = ? AND period = ?").bind(c.id, period).first<{ id: string; status: string }>();
    if (!existing) {
      await db
        .prepare(
          "INSERT INTO customer_invoices (id, customer_id, period, lines, subtotal, tax, total, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
        )
        .bind(uuid(), c.id, period, JSON.stringify(b.lines), b.subtotal, b.tax, b.total, nowIso(), userId)
        .run();
      created++;
    } else if (existing.status === "draft") {
      await db.prepare("UPDATE customer_invoices SET lines = ?, subtotal = ?, tax = ?, total = ? WHERE id = ?")
        .bind(JSON.stringify(b.lines), b.subtotal, b.tax, b.total, existing.id)
        .run();
    }
  }
  return created;
}

async function nextNumber(db: D1Database, table: "customer_invoices" | "quotes", date: string, sep = "-", pad = 3) {
  const prefix = date.replace(/-/g, "");
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE number LIKE ?`).bind(`${prefix}${sep}%`).first<{ n: number }>();
  return `${prefix}${sep}${String((r?.n ?? 0) + 1).padStart(pad, "0")}`;
}

/** 振込期日: 対象月の翌月末日 */
const dueOf = (period: string) => {
  const next = shiftMonth(period, 1);
  return { date: lastDayOf(next), label: `${Number(next.slice(0, 4))}年${Number(next.slice(5, 7))}月末日` };
};

// ---------- 一覧（顧客・月ごとの進み具合） ----------

const INVOICE_SELECT = `
  SELECT i.*, c.name AS customer_name, c.owner_email, c.delivery_to, c.contact_via, ou.name AS owner_name,
         us.name AS sent_by_name, uc.name AS contacted_by_name, ui.name AS issued_by_name
    FROM customer_invoices i JOIN customers c ON c.id = i.customer_id
    LEFT JOIN users ou ON ou.email = c.owner_email
    LEFT JOIN users us ON us.id = i.sent_by
    LEFT JOIN users uc ON uc.id = i.contacted_by
    LEFT JOIN users ui ON ui.id = i.issued_by`;

export async function board(db: D1Database, period: string) {
  const { results: customers } = await db
    .prepare(
      `SELECT c.*, u.name AS owner_name FROM customers c LEFT JOIN users u ON u.email = c.owner_email
        WHERE c.active = 1 ORDER BY c.sort_order, c.name`,
    )
    .all<Record<string, unknown>>();
  const { results: invoices } = await db.prepare(`${INVOICE_SELECT} WHERE i.period = ?`).bind(period).all<Record<string, unknown>>();
  const rows = [];
  for (const c of customers) {
    const quote = await db.prepare("SELECT status, number FROM quotes WHERE customer_id = ? ORDER BY issue_date DESC LIMIT 1").bind(c.id).first<{ status: string; number: string }>();
    const { results: contracts } = await db.prepare("SELECT * FROM contracts WHERE customer_id = ? AND status = 'active'").bind(c.id).all<ContractRow>();
    const contract = contracts.some((k) => occurrence(k, period) > 0);
    const invoice = invoices.find((i) => i.customer_id === c.id) ?? null;
    rows.push({ customer: c, quote, contract, invoice });
  }
  return rows;
}

// ---------- 書類の作成 ----------

export async function issueInvoice(env: Env, id: string, user: User, issueDate?: string) {
  const db = env.DB;
  const inv = await db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).bind(id).first<Record<string, string | number | null>>();
  if (!inv) throw new Error("請求書が見つかりません");
  const lines = JSON.parse(String(inv.lines)) as InvoiceLine[];
  if (!lines.length) throw new Error("明細がありません。契約を確認してください");
  const date = issueDate && DATE.test(issueDate) ? issueDate : String(inv.issue_date || jstNow().date);
  const number = String(inv.number || (await nextNumber(db, "customer_invoices", date)));
  const due = dueOf(String(inv.period));
  const settings = await getSettings(db);
  const customer = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(inv.customer_id).first<Record<string, string>>();
  const html = customerInvoiceHtml(settings, {
    customerName: customer!.name,
    number,
    issueDate: date,
    dueLabel: due.label,
    lines,
    subtotal: Number(inv.subtotal),
    tax: Number(inv.tax),
    total: Number(inv.total),
    extraNote: noteOf(inv, customer),
  });
  const fileName = `請求書_${settings.company_name}_${customer!.name}_${date.replace(/-/g, "")}_${inv.total}円_No${number}.pdf`;
  const doc = await storeDocument(env, html, `docs/invoices/${id}.pdf`, ["顧客請求書", monthFolder(String(inv.period)), customer!.name], fileName);
  // 作り直しでファイル名（金額・日付）が変わったときは、前の PDF を Drive のゴミ箱に移す（間違った版を残さない）
  if (inv.drive_file_id && doc.drive_file_id && inv.drive_file_id !== doc.drive_file_id) {
    try {
      await trashDriveFile(env, String(inv.drive_file_id));
      doc.warnings.push("前に作った PDF は Google Drive のゴミ箱に移しました（30日以内なら戻せます）");
    } catch (e) {
      doc.warnings.push(`前に作った PDF を Drive のゴミ箱に移せませんでした。Drive で手動で削除してください（${e instanceof Error ? e.message : e}）`);
    }
  }
  await db
    .prepare(
      `UPDATE customer_invoices SET number = ?, issue_date = ?, due_date = ?, pdf_key = ?, drive_file_id = COALESCE(?, drive_file_id),
         status = CASE WHEN status = 'draft' THEN 'created' ELSE status END, issued_at = ?, issued_by = ? WHERE id = ?`,
    )
    .bind(number, date, due.date, doc.pdf_key, doc.drive_file_id, nowIso(), user.id, id)
    .run();
  await audit(db, { userId: user.id, via: "web", action: "invoice_issue", targetType: "customer_invoice", targetId: id });
  return { number, warnings: doc.warnings };
}

/** 請求書の文言（明細・備考・請求日）を直す。誰でも（閲覧のみ以外）作成前に確認して直せる。取り込んだ過去分は直せない */
export async function updateInvoice(db: D1Database, id: string, b: { lines?: InvoiceLine[]; note?: string; issue_date?: string }) {
  const inv = await db.prepare("SELECT status, imported FROM customer_invoices WHERE id = ?").bind(id).first<{ status: string; imported: number }>();
  if (!inv) throw new Error("請求書が見つかりません");
  if (inv.imported) throw new Error("取り込んだ過去の請求書は直せません");
  if (b.lines && (b.lines.length > 50 || b.lines.some((l) => String(l.name ?? "").length > 300 || String(l.period_label ?? "").length > 40))) throw new Error("明細が多すぎるか長すぎます（50行・内容300字まで）");
  if (typeof b.note === "string" && b.note.length > 2000) throw new Error("備考は2000字までです");
  if (b.lines) {
    const lines = b.lines
      .filter((l) => String(l.name ?? "").trim())
      .map((l) => ({ period_label: String(l.period_label ?? ""), name: String(l.name).trim(), qty: Number(l.qty) || 1, unit_price: Math.round(Number(l.unit_price) || 0), amount: (Number(l.qty) || 1) * Math.round(Number(l.unit_price) || 0) }));
    if (!lines.length) throw new Error("明細が空です");
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const subtotal = Math.round(total / (1 + TAX_RATE));
    await db.prepare("UPDATE customer_invoices SET lines = ?, subtotal = ?, tax = ?, total = ? WHERE id = ?").bind(JSON.stringify(lines), subtotal, total - subtotal, total, id).run();
  }
  if (typeof b.note === "string") await db.prepare("UPDATE customer_invoices SET note = ? WHERE id = ?").bind(b.note.trim(), id).run();
  if (b.issue_date) {
    if (!DATE.test(b.issue_date)) throw new Error("請求日は YYYY-MM-DD で指定してください");
    await db.prepare("UPDATE customer_invoices SET issue_date = ? WHERE id = ?").bind(b.issue_date, id).run();
  }
}

/** 請求書の備考: 請求書ごとに直した文があればそれ、なければ顧客の既定の文 */
const noteOf = (inv: Record<string, unknown>, customer: Record<string, string> | null) => String(inv.note || customer?.invoice_note || "");

async function invoicePreview(db: D1Database, id: string) {
  const inv = await db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).bind(id).first<Record<string, string | number | null>>();
  if (!inv) return null;
  const settings = await getSettings(db);
  const customer = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(inv.customer_id).first<Record<string, string>>();
  return customerInvoiceHtml(settings, {
    customerName: customer!.name,
    number: String(inv.number || "（作成時に採番）"),
    issueDate: String(inv.issue_date || jstNow().date),
    dueLabel: dueOf(String(inv.period)).label,
    lines: JSON.parse(String(inv.lines)),
    subtotal: Number(inv.subtotal),
    tax: Number(inv.tax),
    total: Number(inv.total),
    extraNote: noteOf(inv, customer),
  });
}

/** 送付済み・連絡済みのチェック（担当者と管理者だけ） */
export async function checkInvoice(db: D1Database, id: string, user: User, b: { sent?: boolean; contacted?: boolean }) {
  const inv = await db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).bind(id).first<Record<string, string | null>>();
  if (!inv) throw new Error("請求書が見つかりません");
  if (inv.status === "draft") throw new Error("先に請求書を作成してください");
  if (user.role !== "admin" && user.email !== inv.owner_email) throw new Error(`この請求書の担当は ${inv.owner_name ?? inv.owner_email} さんです（送付・連絡のチェックは担当者と管理者だけ）`);
  const at = nowIso();
  const sent = b.sent === undefined ? inv.sent_at : b.sent ? inv.sent_at ?? at : null;
  const contacted = b.contacted === undefined ? inv.contacted_at : b.contacted ? inv.contacted_at ?? at : null;
  const status = sent && contacted ? "contacted" : sent ? "sent" : "created";
  await db
    .prepare(
      `UPDATE customer_invoices SET sent_at = ?, sent_by = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(sent_by, ?) END,
         contacted_at = ?, contacted_by = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(contacted_by, ?) END, status = ? WHERE id = ?`,
    )
    .bind(sent, sent, user.id, contacted, contacted, user.id, status, id)
    .run();
  await audit(db, { userId: user.id, via: "web", action: "invoice_check", targetType: "customer_invoice", targetId: id, detail: b });
  return status;
}

function quoteTotals(items: QuoteItem[]) {
  const subtotal = items.reduce((s, i) => s + Math.round(i.qty * i.unit_price), 0);
  return { subtotal, tax: taxOf(subtotal), total: subtotal + taxOf(subtotal) };
}

async function quoteHtmlFor(db: D1Database, q: Record<string, string | number | null>) {
  const settings = await getSettings(db);
  const customer = await db.prepare("SELECT name FROM customers WHERE id = ?").bind(q.customer_id).first<{ name: string }>();
  return quoteHtml(settings, {
    customerName: customer?.name ?? "",
    number: String(q.number),
    issueDate: String(q.issue_date),
    validUntil: String(q.valid_until ?? ""),
    subject: String(q.subject),
    items: JSON.parse(String(q.items)),
    subtotal: Number(q.subtotal),
    tax: Number(q.tax),
    total: Number(q.total),
    remarks: String(q.remarks),
  });
}

// ---------- 通知用 ----------

/** 毎月15日: 請求書の担当者（顧客ごとの担当）へ「作成を始めてください」。担当者ごとにまとめて返す */
/** 毎月15日: 顧客請求書の作成開始（Google Chat で担当者をメンション）。作成待ちがなければ null */
export async function invoiceStartText(db: D1Database, period: string) {
  await prepareInvoices(db, period, null);
  const { results } = await db.prepare(`${INVOICE_SELECT} WHERE i.period = ? AND i.status = 'draft' ORDER BY c.sort_order`).bind(period).all<Record<string, unknown>>();
  if (!results.length) return null;
  const byOwner = new Map<string, { name: string; lines: string[] }>();
  for (const r of results) {
    const email = String(r.owner_email);
    const entry = byOwner.get(email) ?? { name: String(r.owner_name ?? email), lines: [] };
    entry.lines.push(`・${r.customer_name}　${yen(Number(r.total))}（送付先: ${r.delivery_to} ／ 連絡: ${r.contact_via}）`);
    byOwner.set(email, entry);
  }
  const blocks = [];
  for (const [email, o] of byOwner) blocks.push(`${await chatMention(db, email, o.name)}\n${o.lines.join("\n")}`);
  const m = Number(period.slice(5, 7));
  return `🧾 *${monthFolder(period)}の顧客請求書の作成を始めてください*\n契約から下書きを用意しました。\n\n${blocks.join("\n\n")}\n\nアプリの「顧客請求」で内容を確認して「請求書を作成」を押すか、Claude で「${m}月分の請求書を作って」と頼むと、PDF が Google Drive に保存されます。送付・連絡したらチェックしてください。`;
}

/** 1時間ごと: 送付・連絡が未チェックの請求書（Google Chat） */
export async function uncheckedText(db: D1Database) {
  const { results } = await db
    .prepare(`${INVOICE_SELECT} WHERE i.status IN ('created', 'sent') ORDER BY c.sort_order`)
    .all<Record<string, string | number | null>>();
  if (!results.length) return null;
  const lines = results.map((r) => {
    const todo = [!r.sent_at && `送付（${r.delivery_to}）`, !r.contacted_at && `連絡（${r.contact_via}）`].filter(Boolean).join("・");
    return `・${r.owner_name ?? r.owner_email}さん: ${r.customer_name} ${monthFolder(String(r.period))} — ${todo} が未チェック`;
  });
  return `🔔 *顧客請求書の送付・連絡が未チェックです*\n${lines.join("\n")}\n送付・連絡したら、アプリの「顧客請求」でチェックしてください。`;
}

// ---------- 画面用 API ----------

const canWrite = (c: Context<AppEnv>) => c.get("user").role !== "viewer";

export function registerBillingRoutes(api: Hono<AppEnv>) {
  // 顧客マスタ
  api.get("/billing/customers", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT c.*, u.name AS owner_name FROM customers c LEFT JOIN users u ON u.email = c.owner_email ORDER BY c.active DESC, c.sort_order, c.name",
    ).all();
    return c.json({ customers: results });
  });

  const customerFields = ["name", "owner_email", "delivery_to", "contact_via", "invoice_note", "memo"] as const;
  api.post("/billing/customers", async (c) => {
    const b = await c.req.json<Record<string, string>>();
    if (!b.name?.trim() || !b.owner_email?.trim()) return c.json({ error: "顧客名と担当者を入力してください" }, 400);
    if (customerFields.some((k) => String(b[k] ?? "").length > (k === "invoice_note" || k === "memo" ? 2000 : 200))) return c.json({ error: "入力が長すぎます" }, 400);
    const id = uuid();
    const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM customers").first<{ n: number }>();
    await c.env.DB.prepare(
      `INSERT INTO customers (id, name, company_key, owner_email, delivery_to, contact_via, invoice_note, memo, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, b.name.trim(), companyKey(b.name), b.owner_email.trim(), b.delivery_to ?? "", b.contact_via ?? "", b.invoice_note ?? "", b.memo ?? "", (max?.n ?? 0) + 1, nowIso())
      .run();
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "customer_create", targetType: "customer", targetId: id });
    return c.json({ id });
  });

  api.patch("/billing/customers/:id", async (c) => {
    const b = await c.req.json<Record<string, string | number>>();
    if (customerFields.some((k) => String(b[k] ?? "").length > (k === "invoice_note" || k === "memo" ? 2000 : 200))) return c.json({ error: "入力が長すぎます" }, 400);
    // 請求書の担当（送付・連絡のチェックができる人）の変更は管理者だけ
    if (typeof b.owner_email === "string" && c.get("user").role !== "admin") {
      const cur = await c.env.DB.prepare("SELECT owner_email FROM customers WHERE id = ?").bind(c.req.param("id")).first<{ owner_email: string }>();
      if (cur && cur.owner_email !== String(b.owner_email).trim()) return c.json({ error: "請求書の担当の変更は管理者だけができます" }, 403);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    for (const k of customerFields) {
      if (typeof b[k] === "string") {
        sets.push(`${k} = ?`);
        binds.push(String(b[k]).trim());
      }
    }
    if (typeof b.name === "string") sets.push("company_key = ?"), binds.push(companyKey(b.name));
    if (b.active !== undefined) sets.push("active = ?"), binds.push(b.active ? 1 : 0);
    if (!sets.length) return c.json({ ok: true });
    await c.env.DB.prepare(`UPDATE customers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds, nowIso(), c.req.param("id")).run();
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "customer_update", targetType: "customer", targetId: c.req.param("id") });
    return c.json({ ok: true });
  });

  // 契約
  api.get("/billing/contracts", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT k.*, cu.name AS customer_name, q.number AS quote_number FROM contracts k
         LEFT JOIN customers cu ON cu.id = k.customer_id LEFT JOIN quotes q ON q.id = k.quote_id
        ORDER BY k.status, cu.sort_order, k.start_month DESC`,
    ).all();
    return c.json({ contracts: results });
  });

  const saveContract = async (c: Context<AppEnv>, id?: string) => {
    if (c.get("user").role !== "admin") return c.json({ error: "契約の登録・変更は管理者のみです" }, 403);
    const b = await c.req.json<Record<string, string | number | null>>();
    const customer = await c.env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(b.customer_id ?? "").first<{ name: string }>();
    if (!customer) return c.json({ error: "顧客を選んでください" }, 400);
    if (!String(b.title ?? "").trim()) return c.json({ error: "契約内容を入力してください" }, 400);
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount < 0) return c.json({ error: "金額（税抜・円）を整数で入力してください" }, 400);
    if (!["monthly", "count", "once"].includes(String(b.cycle))) return c.json({ error: "請求サイクルが不正です" }, 400);
    if (!MONTH.test(String(b.start_month))) return c.json({ error: "最初の請求月を入力してください" }, 400);
    if (b.cycle === "count" && !(Number(b.count_total) >= 1)) return c.json({ error: "回数契約は総回数を入力してください" }, 400);
    const vals = [
      b.customer_id,
      customer.name,
      companyKey(customer.name),
      String(b.title).trim(),
      String(b.item_name ?? "").trim(),
      amount,
      b.cycle,
      b.cycle === "count" ? Number(b.count_total) : null,
      b.start_month,
      b.cycle === "monthly" && b.end_month ? b.end_month : null,
      b.period_style === "range" ? "range" : "month",
      b.quote_id || null,
      String(b.memo ?? ""),
    ];
    const user = c.get("user");
    if (id) {
      await c.env.DB.prepare(
        `UPDATE contracts SET customer_id = ?, company_name = ?, company_key = ?, title = ?, item_name = ?, amount = ?, cycle = ?, count_total = ?,
           start_month = ?, end_month = ?, period_style = ?, quote_id = ?, memo = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(...vals, b.status === "ended" ? "ended" : "active", user.id, nowIso(), id)
        .run();
    } else {
      id = uuid();
      await c.env.DB.prepare(
        `INSERT INTO contracts (customer_id, company_name, company_key, title, item_name, amount, cycle, count_total, start_month, end_month, period_style, quote_id, memo, id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(...vals, id, user.id, nowIso())
        .run();
      if (b.quote_id) await c.env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(b.quote_id).run();
    }
    await audit(c.env.DB, { userId: user.id, via: "web", action: "contract_update", targetType: "contract", targetId: id });
    return c.json({ id });
  };
  // 契約書（PDF）の添付・表示
  api.post("/billing/contracts/:id/document", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "契約書の添付は管理者のみです" }, 403);
    const k = await c.env.DB.prepare("SELECT k.id, cu.name AS customer_name FROM contracts k LEFT JOIN customers cu ON cu.id = k.customer_id WHERE k.id = ?")
      .bind(c.req.param("id"))
      .first<{ id: string; customer_name: string | null }>();
    if (!k) return c.json({ error: "契約が見つかりません" }, 404);
    const form = await c.req.formData();
    const file = form.get("file") as unknown as File | null;
    if (!file || file.type !== "application/pdf") return c.json({ error: "契約書の PDF を選んでください" }, 400);
    if (file.size > 20 * 1024 * 1024) return c.json({ error: "ファイルが大きすぎます（20MBまで）" }, 400);
    const data = await file.arrayBuffer();
    const key = `docs/contracts/${k.id}.pdf`;
    await c.env.IMAGES.put(key, data, { httpMetadata: { contentType: "application/pdf" } });
    const warnings: string[] = [];
    const driveId = await saveToDrive(c.env, ["契約書", k.customer_name ?? "顧客未設定"], file.name || "契約書.pdf", "application/pdf", data, warnings);
    await c.env.DB.prepare("UPDATE contracts SET document_key = ?, document_name = ?, document_drive_id = COALESCE(?, document_drive_id) WHERE id = ?")
      .bind(key, file.name || "契約書.pdf", driveId, k.id)
      .run();
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "contract_document", targetType: "contract", targetId: k.id, detail: { name: file.name } });
    return c.json({ ok: true, warnings });
  });
  api.get("/billing/contracts/:id/document", async (c) => {
    const k = await c.env.DB.prepare("SELECT document_key, document_name FROM contracts WHERE id = ?").bind(c.req.param("id")).first<{ document_key: string | null; document_name: string | null }>();
    return documentResponse(c.env, k?.document_key ?? null, k?.document_name ?? "契約書.pdf");
  });

  api.post("/billing/contracts", (c) => saveContract(c));
  api.patch("/billing/contracts/:id", (c) => saveContract(c, c.req.param("id")));

  // 見積書
  api.get("/billing/quotes", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT q.*, cu.name AS customer_name FROM quotes q JOIN customers cu ON cu.id = q.customer_id ORDER BY q.issue_date DESC, q.number DESC",
    ).all();
    return c.json({ quotes: results });
  });

  const saveQuote = async (c: Context<AppEnv>, id?: string) => {
    if (!canWrite(c)) return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
    const b = await c.req.json<{ customer_id: string; issue_date: string; valid_until?: string; subject: string; items: QuoteItem[]; remarks?: string; status?: string }>();
    if (!b.customer_id || !b.subject?.trim()) return c.json({ error: "顧客と件名を入力してください" }, 400);
    if (b.valid_until && !DATE.test(b.valid_until)) return c.json({ error: "有効期限は日付で入力してください" }, 400);
    if ((b.items ?? []).length > 50) return c.json({ error: "品目は50行までです" }, 400);
    if (b.subject.length > 200 || (b.remarks ?? "").length > 2000 || (b.items ?? []).some((i) => String(i.name ?? "").length > 300 || String(i.unit ?? "").length > 20))
      return c.json({ error: "入力が長すぎます（件名200字・品目300字・備考2000字まで）" }, 400);
    const issueDate = DATE.test(b.issue_date) ? b.issue_date : jstNow().date;
    const items = (b.items ?? [])
      .filter((i) => i.name?.trim())
      .map((i) => ({ name: i.name.trim(), qty: Number(i.qty) || 1, unit: String(i.unit ?? ""), unit_price: Math.round(Number(i.unit_price) || 0) }));
    const t = quoteTotals(items);
    const status = ["draft", "sent", "accepted", "rejected"].includes(String(b.status)) ? b.status : "draft";
    if (id) {
      await c.env.DB.prepare(
        "UPDATE quotes SET customer_id = ?, issue_date = ?, valid_until = ?, subject = ?, items = ?, subtotal = ?, tax = ?, total = ?, remarks = ?, status = ?, updated_at = ? WHERE id = ?",
      )
        .bind(b.customer_id, issueDate, b.valid_until || null, b.subject.trim(), JSON.stringify(items), t.subtotal, t.tax, t.total, b.remarks ?? "", status, nowIso(), id)
        .run();
    } else {
      id = uuid();
      const number = await nextNumber(c.env.DB, "quotes", issueDate, "-", 1);
      await c.env.DB.prepare(
        `INSERT INTO quotes (id, customer_id, number, issue_date, valid_until, subject, items, subtotal, tax, total, remarks, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, b.customer_id, number, issueDate, b.valid_until || null, b.subject.trim(), JSON.stringify(items), t.subtotal, t.tax, t.total, b.remarks ?? "", status, c.get("user").id, nowIso())
        .run();
    }
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "quote_save", targetType: "quote", targetId: id });
    return c.json({ id });
  };
  api.post("/billing/quotes", (c) => saveQuote(c));
  api.patch("/billing/quotes/:id", (c) => saveQuote(c, c.req.param("id")));

  api.get("/billing/quotes/:id/preview", async (c) => {
    const q = await c.env.DB.prepare("SELECT * FROM quotes WHERE id = ?").bind(c.req.param("id")).first<Record<string, string | number | null>>();
    return q ? c.html(await quoteHtmlFor(c.env.DB, q)) : c.notFound();
  });

  api.post("/billing/quotes/:id/pdf", async (c) => {
    const q = await c.env.DB.prepare("SELECT q.*, cu.name AS customer_name FROM quotes q JOIN customers cu ON cu.id = q.customer_id WHERE q.id = ?")
      .bind(c.req.param("id"))
      .first<Record<string, string | number | null>>();
    if (!q) return c.json({ error: "見積書が見つかりません" }, 404);
    try {
      const doc = await storeDocument(
        c.env,
        await quoteHtmlFor(c.env.DB, q),
        `docs/quotes/${q.id}.pdf`,
        ["見積書", String(q.customer_name)],
        `${String(q.issue_date).replace(/-/g, "")}_御見積書_${q.customer_name}様_${q.subject}.pdf`,
      );
      await c.env.DB.prepare("UPDATE quotes SET pdf_key = ?, drive_file_id = COALESCE(?, drive_file_id) WHERE id = ?").bind(doc.pdf_key, doc.drive_file_id, q.id).run();
      return c.json({ ok: true, warnings: doc.warnings });
    } catch (e) {
      return c.json({ error: `PDF を作れませんでした: ${e instanceof Error ? e.message : e}` }, 500);
    }
  });

  api.get("/billing/quotes/:id/file", async (c) => {
    const q = await c.env.DB.prepare("SELECT pdf_key, number FROM quotes WHERE id = ?").bind(c.req.param("id")).first<{ pdf_key: string | null; number: string }>();
    return documentResponse(c.env, q?.pdf_key ?? null, `見積書_${q?.number}.pdf`);
  });

  // 月ごとの請求書
  api.get("/billing/board", async (c) => {
    const p = c.req.query("period");
    const period = p && MONTH.test(p) ? p : jstNow().month;
    return c.json({ period, rows: await board(c.env.DB, period) });
  });

  api.post("/billing/invoices/prepare", async (c) => {
    if (!canWrite(c)) return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
    const { period } = await c.req.json<{ period: string }>();
    if (!MONTH.test(period)) return c.json({ error: "対象月が不正です" }, 400);
    return c.json({ created: await prepareInvoices(c.env.DB, period, c.get("user").id) });
  });

  api.patch("/billing/invoices/:id", async (c) => {
    if (!canWrite(c)) return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
    try {
      await updateInvoice(c.env.DB, c.req.param("id"), await c.req.json());
      await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "invoice_edit", targetType: "customer_invoice", targetId: c.req.param("id") });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get("/billing/invoices/:id/preview", async (c) => {
    const html = await invoicePreview(c.env.DB, c.req.param("id"));
    if (!html) return c.notFound();
    // 画面内の小さな枠で見るときは、A4 を枠の幅に縮めて全体を表示する。
    // フォント（Google Fonts）の読み込みを待たないよう、スタイルより前に置いて本文ができた時点で縮める
    const fit = `<script>document.addEventListener("DOMContentLoaded",function(){var W=document.body.offsetWidth;function f(){var z=innerWidth/W;document.documentElement.style.zoom=z<1?String(z):""}f();addEventListener("resize",f)})</script>`;
    c.header("X-Frame-Options", "SAMEORIGIN");
    // スマホでは viewport を指定しないと枠の幅を 980px とみなすので、枠の実際の幅に合わせる
    return c.html(html.replace("<head>", `<head><meta name="viewport" content="width=device-width">${fit}`));
  });

  api.post("/billing/invoices/:id/issue", async (c) => {
    if (!canWrite(c)) return c.json({ error: "閲覧のみの権限では変更できません" }, 403);
    const { issue_date } = await c.req.json<{ issue_date?: string }>().catch(() => ({ issue_date: undefined }));
    try {
      return c.json(await issueInvoice(c.env, c.req.param("id"), c.get("user"), issue_date));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get("/billing/invoices/:id/file", async (c) => {
    const inv = await c.env.DB.prepare("SELECT pdf_key, number FROM customer_invoices WHERE id = ?").bind(c.req.param("id")).first<{ pdf_key: string | null; number: string }>();
    return documentResponse(c.env, inv?.pdf_key ?? null, `請求書_${inv?.number}.pdf`);
  });

  api.post("/billing/invoices/:id/check", async (c) => {
    try {
      const status = await checkInvoice(c.env.DB, c.req.param("id"), c.get("user"), await c.req.json());
      return c.json({ status });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 発行済みの書類（PDF）の取り込み
  api.post("/billing/import", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "取り込みは管理者のみです" }, 403);
    const form = await c.req.formData();
    const file = form.get("file") as unknown as File | null;
    const kind = String(form.get("kind"));
    const customerId = String(form.get("customer_id") ?? "");
    const number = String(form.get("number") ?? "");
    const issueDate = String(form.get("issue_date") ?? "");
    const total = Number(form.get("total") ?? 0);
    if (!file || !DATE.test(issueDate) || !number) return c.json({ error: "ファイル・番号・日付が必要です" }, 400);
    const customer = await c.env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(customerId).first<{ name: string }>();
    if (!customer) return c.json({ error: "顧客を選んでください" }, 400);
    const data = await file.arrayBuffer();
    const id = uuid();
    const warnings: string[] = [];
    const user = c.get("user");
    if (kind === "quote") {
      const subject = String(form.get("subject") ?? "");
      const key = `docs/quotes/${id}.pdf`;
      await c.env.IMAGES.put(key, data, { httpMetadata: { contentType: "application/pdf" } });
      const driveId = await saveToDrive(c.env, ["見積書", customer.name], file.name, "application/pdf", data, warnings);
      const subtotal = Math.round(total / (1 + TAX_RATE));
      await c.env.DB.prepare(
        `INSERT INTO quotes (id, customer_id, number, issue_date, subject, subtotal, tax, total, status, pdf_key, drive_file_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      )
        .bind(id, customerId, number, issueDate, subject, subtotal, total - subtotal, total, key, driveId, user.id, nowIso())
        .run();
    } else {
      const period = String(form.get("period") ?? "");
      if (!MONTH.test(period)) return c.json({ error: "対象月が必要です" }, 400);
      // 送付・連絡が済んでいるか（済んでいなければ、担当者のチェック待ちとして登録する）
      const done = String(form.get("done") ?? "1") !== "0";
      // その月がまだ下書き（システムで作成していない）なら、取り込む請求書に置き換える。作成済みなら二重にしない
      const exists = await c.env.DB.prepare("SELECT id, status FROM customer_invoices WHERE customer_id = ? AND period = ?").bind(customerId, period).first<{ id: string; status: string }>();
      if (exists && exists.status !== "draft") return c.json({ error: `${customer.name} の ${monthFolder(period)} はすでにシステムで作成されています（二重に登録しないため取り込みません）` }, 409);
      if (exists) {
        await c.env.DB.prepare("DELETE FROM customer_invoices WHERE id = ? AND status = 'draft'").bind(exists.id).run();
        warnings.push("この月の下書きを、取り込んだ請求書に置き換えました");
      }
      const key = `docs/invoices/${id}.pdf`;
      await c.env.IMAGES.put(key, data, { httpMetadata: { contentType: "application/pdf" } });
      const driveId = await saveToDrive(c.env, ["顧客請求書", monthFolder(period), customer.name], file.name, "application/pdf", data, warnings);
      const subtotal = Math.round(total / (1 + TAX_RATE));
      const at = nowIso();
      await c.env.DB.prepare(
        `INSERT INTO customer_invoices (id, customer_id, period, number, issue_date, due_date, subtotal, tax, total, status, pdf_key, drive_file_id,
           created_at, created_by, issued_at, issued_by, sent_at, sent_by, contacted_at, contacted_by, imported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
        .bind(
          id, customerId, period, number, issueDate, dueOf(period).date, subtotal, total - subtotal, total, done ? "contacted" : "created", key, driveId,
          at, user.id, at, user.id, done ? at : null, done ? user.id : null, done ? at : null, done ? user.id : null,
        )
        .run();
    }
    await audit(c.env.DB, { userId: user.id, via: "web", action: "document_import", targetType: kind, targetId: id });
    return c.json({ id, warnings });
  });
}
