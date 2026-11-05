// 請求書・見積書の HTML（PDF の元）。レイアウトは既存の書類（Canva 製の請求書、INVOY の見積書、
// monthly-invoice スキルの社内請求書）の実測値を移植したもの
import type { Settings } from "./settings";

const FONT = `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">`;
const h = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const br = (s: unknown) => h(s).replace(/\n/g, "<br>");
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const num = (n: number) => n.toLocaleString("ja-JP");
export const jpDate = (d: string) => (d ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : "");
/** 2026年10月05日（日付として正しくない値は出さない） */
const jpDate0 = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日` : "");

/** 見積書の宛名も同じく、長い社名は「株式会社」の前で改行する */
function quoteAddressee(name: string) {
  if (name.length > 14 && name.endsWith("株式会社")) return `${h(name.slice(0, -4))}<br>株式会社 御中`;
  return `${h(name)} 御中`;
}

/** 長い社名は「株式会社」の前で改行する（例: 架空・情報システムサービス／株式会社） */
function addressee(name: string) {
  if (name.length > 14 && name.endsWith("株式会社")) return `<div class="addressee long">${h(name.slice(0, -4))}<br>株式会社　御中</div>`;
  if (name.length > 14) return `<div class="addressee long">${h(name)}　御中</div>`;
  return `<div class="addressee">${h(name)}　御中</div>`;
}

// ---------- 顧客向け請求書（テストモーターア様・IOSI 様向けと同じ体裁） ----------

export interface InvoiceLine {
  period_label: string;
  name: string;
  qty: number;
  unit_price: number; // 税込
  amount: number; // 税込
}

export function customerInvoiceHtml(s: Settings, d: {
  customerName: string;
  number: string;
  issueDate: string;
  dueLabel: string;
  lines: InvoiceLine[];
  subtotal: number;
  tax: number;
  total: number;
  extraNote: string;
}) {
  // 明細は8行分の枠（設定された代表者作成の請求書と同じ。最後の線だけ太い）
  const rows = [...d.lines, ...Array(Math.max(0, 8 - d.lines.length)).fill(null)]
    .map((l: InvoiceLine | null) =>
      l
        ? `<tr><td class="c nowrap">${h(l.period_label)}</td><td>${br(l.name)}</td><td class="c">${l.qty}</td><td class="num">${yen(l.unit_price)}</td><td class="num">${yen(l.amount)}</td></tr>`
        : `<tr><td></td><td></td><td></td><td></td><td></td></tr>`,
    )
    .join("\n");
  const note = [d.extraNote, s.invoice_note].filter(Boolean).join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>請求書 ${h(d.number)}</title>${FONT}<style>
@page { size: 595.5pt 842.25pt; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 595.5pt; height: 842.25pt; font-family: "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", sans-serif; font-weight: 500; font-size: 10pt; line-height: 13.7pt; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 595.5pt; height: 842.25pt; overflow: hidden; }
.page > div, .page > table { position: absolute; }
.num { text-align: right; }
.nowrap { white-space: nowrap; }
.title { top: 61pt; left: 60.5pt; width: 475.5pt; padding-bottom: 0; border-bottom: 1.2pt solid #000; font-size: 24pt; line-height: 29pt; font-weight: 700; letter-spacing: 0.3em; }
.addressee { top: 130pt; left: 60.5pt; width: 254pt; padding-bottom: 3pt; border-bottom: 1pt solid #000; font-size: 14pt; line-height: 20pt; font-weight: 700; letter-spacing: 0.16em; white-space: nowrap; }
.addressee.long { top: 128pt; width: 285pt; letter-spacing: 0.04em; white-space: normal; }
.meta { top: 131pt; left: 358pt; width: 178pt; line-height: 15.5pt; }
.meta span { float: right; }
.issuer { top: 178pt; left: 358pt; }
.issuer b { display: block; font-size: 11pt; line-height: 16pt; margin-bottom: 3pt; }
.issuer .tel { margin-top: 3pt; }
.lead { top: 239pt; left: 60.5pt; }
.amount { top: 274pt; left: 60.5pt; width: 254.5pt; padding-bottom: 3pt; border-bottom: 1.2pt solid #000; font-size: 14pt; line-height: 19pt; font-weight: 700; }
.amount span { float: right; font-size: 15pt; font-weight: 500; letter-spacing: 0.08em; }
.items { top: 327.5pt; left: 39.5pt; width: 535pt; border-collapse: collapse; table-layout: fixed; background: linear-gradient(#000 0 20pt, transparent 20pt); }
.items th { color: #fff; font-weight: 500; height: 20pt; padding: 0 8pt; text-align: left; }
.items th.c { text-align: center; } .items th.num { text-align: right; }
.items td { height: 20pt; padding: 1pt 8pt; border-bottom: 0.7pt solid #000; vertical-align: bottom; }
.items tr:last-child td { border-bottom: 1.5pt solid #000; }
.items td.c { text-align: center; }
.items .w1 { width: 62pt; } .items .w2 { width: 263pt; } .items .w3 { width: 52pt; } .items .w4 { width: 80pt; } .items .w5 { width: 78pt; }
.summary { top: 535.5pt; left: 343pt; width: 231.5pt; border-collapse: collapse; table-layout: fixed; background: linear-gradient(to top, #000 0 20pt, transparent 20pt); }
.summary td { height: 20pt; padding: 0 9.5pt; }
.summary tr.total td { color: #fff; font-weight: 700; }
.summary tr.total td:first-child { font-weight: 500; }
.footer { top: 642pt; left: 60.5pt; width: 475.5pt; border-collapse: collapse; table-layout: fixed; }
.footer td { vertical-align: top; padding: 2pt 0; }
.footer td.k { width: 96.5pt; padding-left: 27.5pt; }
.footer tr.line td { border-bottom: 0.7pt solid #000; }
.footer p + p { margin-top: 5.8pt; }
</style></head><body><div class="page">
<div class="title">請求書</div>
${addressee(d.customerName)}
<div class="meta">日付：<span>${jpDate(d.issueDate)}</span><br>請求書番号：<span>${h(d.number)}</span></div>
<div class="issuer"><b>${h(s.company_name)}</b>${h(s.company_postal)}<br>${h(s.company_address1)}<br>${h(s.company_address2)}<div class="tel">電話：${h(s.company_tel)}</div></div>
<div class="lead">下記の通りご請求申し上げます。</div>
<div class="amount">ご請求金額<span>${yen(d.total)}</span></div>
<table class="items"><colgroup><col class="w1"><col class="w2"><col class="w3"><col class="w4"><col class="w5"></colgroup>
<tr><th class="c">対象期間</th><th>内容</th><th class="c">数量</th><th class="num">単価（税込）</th><th class="num">金額（税込）</th></tr>
${rows}
</table>
<table class="summary">
<tr><td>10%対象（税抜）</td><td class="num">${yen(d.subtotal)}</td></tr>
<tr><td>消費税（10%）</td><td class="num">${yen(d.tax)}</td></tr>
<tr class="total"><td>合計</td><td class="num">${yen(d.total)}</td></tr>
</table>
<table class="footer">
<tr class="line"><td class="k">振込期日</td><td>${h(d.dueLabel)}までのお振込をお願いいたします。</td></tr>
<tr><td class="k">振込先</td><td>${s.bank_lines.split("\n").map((l) => `<p>${h(l)}</p>`).join("")}</td></tr>
<tr class="line"><td class="k">法人名称</td><td>${h(s.company_name)}<br>${h(s.company_kana)}</td></tr>
<tr><td class="k">備考欄</td><td>${br(note)}</td></tr>
</table>
</div></body></html>`;
}

// ---------- 見積書（IOSI 様向け見積書と同じ体裁） ----------

export interface QuoteItem {
  name: string;
  qty: number;
  unit: string;
  unit_price: number; // 税抜
}

export function quoteHtml(s: Settings, d: {
  customerName: string;
  number: string;
  issueDate: string;
  validUntil: string;
  subject: string;
  items: QuoteItem[];
  subtotal: number;
  tax: number;
  total: number;
  remarks: string;
}) {
  const rows = [...d.items, ...Array(Math.max(0, 5 - d.items.length)).fill(null)]
    .map((i: QuoteItem | null) =>
      i
        ? `<tr><td>${br(i.name)}</td><td class="num">${h(i.qty)}${h(i.unit)}</td><td class="num">${num(i.unit_price)}</td><td class="num">${num(i.qty * i.unit_price)}</td></tr>`
        : `<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>見積書 ${h(d.number)}</title>${FONT}<style>
@page { size: A4; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 595pt; height: 841pt; font-family: "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", sans-serif; color: #191919; font-size: 10pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 595pt; height: 841pt; padding: 45pt 56.7pt; }
.meta { text-align: right; font-size: 9pt; }
.title { text-align: center; font-size: 22pt; font-weight: 700; letter-spacing: 0.22em; margin: 18pt 0 22pt; }
.head { display: flex; justify-content: space-between; }
.left { width: 225pt; }
.addressee { font-size: 14pt; line-height: 1.4; }
.amount { margin-top: 14pt; background: #f3f3f3; padding: 6pt 8.5pt; font-size: 12pt; display: flex; justify-content: space-between; }
.amount b { font-weight: 700; }
.issuer { width: 200pt; padding-top: 40pt; font-size: 10pt; }
.issuer .block { margin-top: 12pt; }
table { border-collapse: collapse; table-layout: fixed; width: 100%; }
td, th { border: 0.75pt solid #212121; padding: 4.6pt 9.25pt; }
th { background: #757575; color: #fff; font-weight: 700; text-align: center; padding: 6pt 0; }
.num { text-align: right; }
.items { margin-top: 26pt; }
.items .c1 { width: 248pt; } .items .c2 { width: 60pt; } .items .c3 { width: 85pt; }
.summary { width: 233pt; margin-left: auto; }
.summary td { border-top: none; }
.summary .total { font-weight: 700; }
.breakdown { width: 252pt; margin: 22pt 0 0 auto; }
.breakdown td { border: none; padding: 4pt 8.5pt; white-space: nowrap; }
.breakdown tr.upper td { border-bottom: 0.75pt solid #212121; }
.remarks-label { margin-top: 26pt; font-size: 9.5pt; }
.remarks { margin-top: 6pt; background: #f3f3f3; padding: 10pt 12pt; white-space: pre-wrap; font-size: 9.5pt; line-height: 1.6; }
</style></head><body><div class="page">
<div class="meta">${jpDate0(d.issueDate)}<br>見積書番号: ${h(d.number)}</div>
<div class="title">見積書</div>
<div class="head">
<div class="left">
<div class="addressee">${quoteAddressee(d.customerName)}</div>
<div>件名：${h(d.subject)}</div>
<div>下記のとおりお見積申し上げます。</div>
<div class="amount"><span>お見積金額</span><b>¥ ${num(d.total)}</b></div>
<div style="margin-top:10pt">有効期限：${jpDate0(d.validUntil)}</div>
</div>
<div class="issuer">
<div>${h(s.company_name)}<br>${h(s.company_representative)}</div>
<div class="block">${h(s.company_postal)}<br>${h(s.company_address1)}<br>${h(s.company_address2)}</div>
<div class="block">TEL:${h(s.company_tel)}<br>${h(s.company_email)}</div>
</div>
</div>
<table class="items"><colgroup><col class="c1"><col class="c2"><col class="c3"><col></colgroup>
<tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr>
${rows}
</table>
<table class="summary"><colgroup><col style="width:144pt"><col></colgroup>
<tr><td>小計</td><td class="num">${num(d.subtotal)}</td></tr>
<tr><td>消費税 (10%)</td><td class="num">${num(d.tax)}</td></tr>
<tr><td class="total">合計</td><td class="num total">${num(d.total)}</td></tr>
</table>
<table class="breakdown">
<tr class="upper"><td>10%対象</td><td class="num">${num(d.subtotal)}</td><td>消費税</td><td class="num">${num(d.tax)}</td></tr>
<tr><td>8%対象</td><td class="num">0</td><td>消費税</td><td class="num">0</td></tr>
</table>
<div class="remarks-label">備考</div>
<div class="remarks">${h(d.remarks)}</div>
</div></body></html>`;
}

// ---------- 社内請求（登録された社内請求対象者 → 会社）。monthly-invoice スキルと同じ体裁 ----------

const INTERNAL_CSS = `
@page { size: A4; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 595pt; height: 841pt; font-family: "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", sans-serif; color: #191919; line-height: 1.448; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 595pt; height: 841pt; }
.page > div { position: absolute; }
.meta { top: 45pt; right: 56.418pt; font-size: 9pt; text-align: right; }
.title { top: 83.06pt; left: 56.691pt; width: 481.891pt; font-size: 22pt; font-weight: 700; text-align: center; letter-spacing: 0.216em; }
.addressee { top: 133.35pt; left: 56.691pt; font-size: 14pt; }
.subject { top: 155.03pt; left: 56.691pt; font-size: 10pt; }
.lead { top: 172.35pt; left: 56.691pt; font-size: 10pt; }
.issuer { top: 161.92pt; left: 326.551pt; font-size: 10.5pt; }
.due { top: 236.09pt; left: 56.691pt; font-size: 10pt; }
.amount { top: 198.82pt; left: 56.691pt; width: 221.668pt; height: 27.008pt; background: #f3f3f3; padding: 4.81pt 8.3pt 0 8.5pt; font-size: 12pt; }
.amount .v { float: right; font-weight: 700; }
.body { top: 275.375pt; left: 56.691pt; width: 481.891pt; }
table { border-collapse: collapse; table-layout: fixed; font-size: 10pt; }
td, th { border: 0.75pt solid #212121; padding: 4.63pt 9.25pt; vertical-align: middle; }
th { background: #757575; color: #fff; font-weight: 700; text-align: center; padding: 6.05pt 0; }
.num { text-align: right; }
.items { width: 481.891pt; }
.summary { width: 233.191pt; margin-left: auto; }
.summary td { border-top: none; }
.summary .total { font-weight: 700; }
.breakdown { width: 252.281pt; margin: 18pt 0 0 auto; }
.breakdown td { border: none; padding: 4.18pt 8.5pt; white-space: nowrap; }
.breakdown tr.upper td { border-bottom: 0.75pt solid #212121; }
.note { margin-top: 10pt; font-size: 8.5pt; color: #555; text-align: right; }
.bank-label { margin-top: 22pt; font-size: 9.5pt; }
.bank { margin-top: 4pt; background: #f3f3f3; padding: 10pt 8.5pt; font-size: 10pt; }`;

function internalHead(s: Settings, d: { number: string; issueDate: string; subject: string; issuer: string; total: number; dueDate: string }) {
  return `<div class="meta">${jpDate0(d.issueDate)}<br>請求書番号: ${h(d.number)}</div>
<div class="title">請求書</div>
<div class="addressee">${h(s.company_name)} 御中</div>
<div class="lead">下記のとおりご請求申し上げます。</div>
<div class="subject">件名：${h(d.subject)}</div>
<div class="issuer">${h(d.issuer)}</div>
<div class="amount">ご請求金額<span class="v">¥ ${num(d.total)}</span></div>
<div class="due">お支払期限：${jpDate0(d.dueDate)}</div>`;
}

export function internalWorkHtml(s: Settings, d: {
  number: string;
  issueDate: string;
  dueDate: string;
  subject: string;
  issuer: string;
  bank: string;
  lines: { name: string; qty: number; unit_price: number; amount: number }[];
  subtotal: number;
  tax: number;
  total: number;
}) {
  const rows = [...d.lines, ...Array(Math.max(0, 5 - d.lines.length)).fill(null)]
    .map((l) =>
      l
        ? `<tr><td>${br(l.name)}</td><td class="num">${l.qty}</td><td class="num">${num(l.unit_price)}</td><td class="num">${num(l.amount)}</td></tr>`
        : `<tr><td>　</td><td></td><td></td><td></td></tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>請求書 ${h(d.number)}</title>${FONT}<style>${INTERNAL_CSS}</style></head><body><div class="page">
${internalHead(s, d)}
<div class="body">
<table class="items"><colgroup><col style="width:248.7pt"><col style="width:59.5pt"><col style="width:85pt"><col></colgroup>
<tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr>
${rows}
</table>
<table class="summary"><colgroup><col style="width:144.6pt"><col></colgroup>
<tr><td>小計</td><td class="num">${num(d.subtotal)}</td></tr>
<tr><td>消費税 (10%)</td><td class="num">${num(d.tax)}</td></tr>
<tr><td class="total">合計</td><td class="num total">${num(d.total)}</td></tr>
</table>
<table class="breakdown">
<tr class="upper"><td>10%対象</td><td class="num">${num(d.subtotal)}</td><td>消費税</td><td class="num">${num(d.tax)}</td></tr>
<tr><td>8%対象</td><td class="num">0</td><td>消費税</td><td class="num">0</td></tr>
</table>
<div class="bank-label">振込先</div>
<div class="bank">${h(d.bank) || "（振込先が未登録です）"}</div>
</div>
</div></body></html>`;
}

export function internalExpenseHtml(s: Settings, d: {
  number: string;
  issueDate: string;
  dueDate: string;
  subject: string;
  issuer: string;
  bank: string;
  lines: { date: string; purpose: string; amount: number }[];
  total: number;
}) {
  const rows = d.lines
    .map((l) => `<tr><td style="text-align:center">${h(l.date.replace(/-/g, "/"))}</td><td>${br(l.purpose)}</td><td class="num">${num(l.amount)}</td></tr>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>請求書（経費） ${h(d.number)}</title>${FONT}<style>${INTERNAL_CSS}</style></head><body><div class="page">
${internalHead(s, d)}
<div class="body">
<table class="items"><colgroup><col style="width:85pt"><col><col style="width:88.6pt"></colgroup>
<tr><th>日付</th><th>内容</th><th>金額</th></tr>
${rows}
</table>
<table class="summary"><colgroup><col style="width:144.6pt"><col></colgroup>
<tr><td class="total">合計</td><td class="num total">${num(d.total)}</td></tr>
</table>
<div class="note">※ 立替経費の実費精算です。領収書の金額（税込）をそのまま記載しており、消費税は別途加算していません。</div>
<div class="bank-label">振込先</div>
<div class="bank">${h(d.bank) || "（振込先が未登録です）"}</div>
</div>
</div></body></html>`;
}
