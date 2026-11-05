// 顧客請求管理: 月の状況（見積書→契約→請求書作成→送付→連絡）／見積書／契約／顧客マスタ／過去の書類の取り込み
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/format";
import { jpDate, monthLabel, postForm, shiftMonth, thisMonth, today, yen } from "../lib/money";
import { confirmLeave, FieldError, Hint, SkeletonList, useEditingGuard, useToast, useUnsavedGuard } from "../components/ui";
import { parseDocName, similarity } from "../lib/docname";

interface Customer {
  id: string;
  name: string;
  owner_email: string;
  owner_name: string | null;
  delivery_to: string;
  contact_via: string;
  invoice_note: string;
  memo: string;
  active: number;
}

interface InvoiceLine {
  period_label: string;
  name: string;
  qty: number;
  unit_price: number;
  amount: number;
}

interface Invoice {
  id: string;
  customer_id: string;
  period: string;
  number: string | null;
  issue_date: string | null;
  due_date: string | null;
  lines: string;
  note: string;
  subtotal: number;
  tax: number;
  total: number;
  status: "draft" | "created" | "sent" | "contacted";
  pdf_key: string | null;
  drive_file_id: string | null;
  owner_email: string;
  owner_name: string | null;
  issued_at: string | null;
  issued_by_name: string | null;
  sent_at: string | null;
  sent_by_name: string | null;
  contacted_at: string | null;
  contacted_by_name: string | null;
  imported: number;
}

interface BoardRow {
  customer: Customer;
  quote: { status: string; number: string } | null;
  contract: boolean;
  invoice: Invoice | null;
}

interface QuoteItem {
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
}

interface Quote {
  id?: string;
  customer_id: string;
  customer_name?: string;
  number?: string;
  issue_date: string;
  valid_until: string | null;
  subject: string;
  items: QuoteItem[];
  subtotal?: number;
  total?: number;
  remarks: string;
  status: "draft" | "sent" | "accepted" | "rejected";
  pdf_key?: string | null;
}

interface Contract {
  id?: string;
  customer_id: string | null;
  customer_name?: string;
  title: string;
  item_name: string;
  amount: number;
  cycle: "monthly" | "count" | "once";
  count_total: number | null;
  start_month: string;
  end_month: string | null;
  period_style: "month" | "range";
  quote_id: string | null;
  quote_number?: string | null;
  document_key?: string | null;
  document_name?: string | null;
  memo: string;
  status: "active" | "ended";
}

interface Staff {
  email: string;
  name: string;
}

const STATUS = { draft: "下書き", created: "作成済み", sent: "送付済み", contacted: "連絡済み" };
const QUOTE_STATUS = { draft: "下書き", sent: "提出済み", accepted: "受注", rejected: "失注" };
const CYCLE = { monthly: "月額", count: "回数契約", once: "単発" };
const TABS = [
  ["month", "月の状況"],
  ["quotes", "見積書"],
  ["contracts", "契約"],
  ["customers", "顧客"],
  ["import", "過去の書類"],
] as const;

function useStaff() {
  const [staff, setStaff] = useState<Staff[]>([]);
  useEffect(() => {
    api<{ users: Staff[] }>("/api/users").then((r) => setStaff(r.users), () => {});
  }, []);
  return staff;
}

function useCustomers() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const load = useCallback(() => {
    api<{ customers: Customer[] }>("/api/billing/customers").then((r) => setCustomers(r.customers), () => setCustomers([]));
  }, []);
  useEffect(load, [load]);
  return { customers, reload: load };
}

export function CustomerBillingPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "month";
  const setTab = (t: string, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra }, { replace: true });
  const tabs = TABS.filter(([k]) => k !== "import" || user.role === "admin");
  // 請求書の確認・作成は別の画面として開く（タブは出さない）
  const confirming = tab === "month" && Boolean(params.get("invoice"));
  return (
    <div className="page">
      <h1>顧客請求</h1>
      {!confirming && (
        <div className="tabs">
          {tabs.map(([k, l]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
      )}
      {tab === "month" ? (
        <MonthBoard />
      ) : tab === "quotes" ? (
        <QuotesView onMakeContract={(q) => setTab("contracts", { quote: q.id!, customer: q.customer_id })} />
      ) : tab === "contracts" ? (
        <ContractsView initialQuote={params.get("quote")} initialCustomer={params.get("customer")} />
      ) : tab === "customers" ? (
        <CustomersView />
      ) : (
        <ImportView />
      )}
    </div>
  );
}

// ---------- 月の状況 ----------

function Step({ done, label, sub }: { done: boolean | null; label: string; sub?: React.ReactNode }) {
  return (
    <div className="flow-step">
      <span className={`pill ${done === null ? "" : done ? "pill-ok" : "pill-warn"}`}>{label}</span>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

const lastDay = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** 請求書の状態を文字付きのバッジで示す */
function StatusBadge({ invoice, contract }: { invoice: Invoice | null; contract: boolean }) {
  if (!invoice) return contract ? <span className="status status-todo">未作成</span> : <span className="status">請求なし</span>;
  if (invoice.imported) return <span className="status status-done">完了（過去分）</span>;
  const map = { draft: ["status-todo", "下書き"], created: ["status-warn", "作成済み・未送付"], sent: ["status-warn", "送付済み・未連絡"], contacted: ["status-done", "送付・連絡済み"] } as const;
  const [cls, label] = map[invoice.status];
  return <span className={`status ${cls}`}>{label}</span>;
}

function nextAction(inv: Invoice | null, contract: boolean, c: Customer) {
  const who = c.owner_name ?? c.owner_email;
  if (!inv) return contract ? "「契約から下書きを作る」で下書きを用意する" : "この月の請求はありません";
  if (inv.imported) return "なし（取り込んだ過去の請求書）";
  switch (inv.status) {
    case "draft":
      return `${who}さんが「内容を確認して作成」で作成する`;
    case "created":
      return `${who}さんが ${c.delivery_to || "先方"} に送付して「送付済み」にチェック`;
    case "sent":
      return `${who}さんが ${c.contact_via || "先方"} で連絡して「連絡済み」にチェック`;
    default:
      return "なし（完了）";
  }
}

function MonthBoard() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // 月と開いている請求書は URL に持つ（ブラウザの「戻る」で一覧に戻れる・再読み込みしても同じ画面）
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? params.get("period")! : thisMonth();
  const editingId = params.get("invoice");
  const setPeriod = (p: string) => setParams({ tab: "month", period: p }, { replace: true });
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const readOnly = user.role === "viewer";
  const editing = useMemo(() => {
    const row = editingId ? rows?.find((r) => r.invoice?.id === editingId) : undefined;
    return row?.invoice ? { invoice: row.invoice, customer: row.customer } : null;
  }, [editingId, rows]);
  /** 一覧に戻ったときに表示する顧客（null なら画面の先頭） */
  const returnTo = useRef<string | null>(null);

  const openInvoice = (inv: Invoice, c: Customer) => {
    returnTo.current = c.id;
    setMessage(null);
    navigate({ search: `?tab=month&period=${period}&invoice=${inv.id}` }, { state: { fromBoard: true } });
  };
  const closeInvoice = (to: string | null) => {
    returnTo.current = to;
    // 一覧から開いたときは履歴を戻す（「戻る」を押しても確認画面がまた出ないように）
    if ((location.state as { fromBoard?: boolean } | null)?.fromBoard) navigate(-1);
    else setParams({ tab: "month", period }, { replace: true });
  };
  // 画面が切り替わったら、確認画面は先頭から・一覧は元の顧客の位置から見せる
  useEffect(() => {
    if (editingId) {
      window.scrollTo(0, 0);
      return;
    }
    if (!rows) return;
    const id = returnTo.current;
    returnTo.current = null;
    if (id) document.getElementById(`billing-${id}`)?.scrollIntoView({ block: "center" });
    else window.scrollTo(0, 0);
  }, [editingId, rows]);

  const load = useCallback(() => {
    api<{ rows: BoardRow[] }>(`/api/billing/board?period=${period}`).then((r) => setRows(r.rows), (e) => setMessage({ kind: "error", text: errorMessage(e) }));
  }, [period]);
  useEffect(load, [load]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: text.startsWith("⚠") ? "warn" : "ok", text });
      load();
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  };

  const prepare = () =>
    run("prepare", async () => {
      const r = await api<{ created: number }>("/api/billing/invoices/prepare", { body: { period } });
      return r.created ? `契約から請求書の下書きを ${r.created} 件作りました` : "新しく作る下書きはありません（契約が変わった下書きは更新しました）";
    });

  const issued = (customer: string, r: { number: string; warnings: string[] }) =>
    setMessage({
      kind: r.warnings.length ? "warn" : "ok",
      text: [`${customer} の請求書（No.${r.number}）を作成しました${r.warnings.some((w) => w.includes("Drive")) ? "" : "。Google Drive に保存しました"}`, ...r.warnings.map((w) => `⚠ ${w}`)].join("\n"),
    });

  const check = (inv: Invoice, body: { sent?: boolean; contacted?: boolean }) =>
    run(`check:${inv.id}`, async () => {
      await api(`/api/billing/invoices/${inv.id}/check`, { body });
    });

  if (editingId) {
    const back = (
      <button className="link-button" onClick={() => confirmLeave() && closeInvoice(editing?.customer.id ?? null)}>
        ‹ {monthLabel(period)}分の一覧に戻る
      </button>
    );
    if (rows === null) return <SkeletonList rows={2} />;
    if (!editing)
      return (
        <div className="empty">
          <p>この請求書は見つかりませんでした（削除されたか、別の月の請求書です）。</p>
          {back}
        </div>
      );
    return (
      <>
        <p className="back-line">{back}</p>
        <InvoiceConfirm
          // 請求書ごとに作り直す（別の会社を開いたときに、前の会社の入力が残らないように）
          key={editing.invoice.id}
          invoice={editing.invoice}
          customer={editing.customer}
          onClose={() => {
            closeInvoice(editing.customer.id);
            load();
          }}
          onIssued={(r) => {
            issued(editing.customer.name, r);
            // 作成結果のお知らせは一覧の先頭に出す
            closeInvoice(null);
            load();
          }}
        />
      </>
    );
  }

  const drafts = rows?.filter((r) => r.invoice?.status === "draft").length ?? 0;
  const total = rows?.reduce((s, r) => s + Number(r.invoice?.total ?? 0), 0) ?? 0;

  return (
    <>
      <div className="toolbar">
        <button className="btn btn-small" onClick={() => setPeriod(shiftMonth(period, -1))} aria-label="前の月">
          ◀
        </button>
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="対象月" />
        <button className="btn btn-small" onClick={() => setPeriod(shiftMonth(period, 1))} aria-label="次の月">
          ▶
        </button>
        <span className="muted small">
          {monthLabel(period)}分 合計 {yen(total)}
          {drafts > 0 && ` ・ 下書き ${drafts}件`}
        </span>
        {!readOnly && (
          <button className="btn btn-small" disabled={busy === "prepare"} onClick={prepare}>
            契約から下書きを作る
          </button>
        )}
      </div>
      <p className="small">
        <strong>{monthLabel(period)}分</strong> ・ 振込期日 {jpDate(lastDay(shiftMonth(period, 1)))} ・ 作成開始は毎月15日
      </p>
      <Hint summary="この画面の流れ（下書き → 確認して作成 → 送付 → 連絡）">
        毎月15日に契約から下書きを用意し、Google Chat で顧客ごとの担当者をメンションしてお知らせします。担当者が「内容を確認して作成」で文言と金額を確かめて作成すると、PDF が Google Drive に保存されます。顧客に送ったら「送付済み」、連絡したら「連絡済み」にチェックします。未チェックの間は 9〜19 時に1時間ごと Google Chat で通知します。
      </Hint>
      {message && <pre className={`notice notice-${message.kind}`}>{message.text}</pre>}
      {rows === null ? (
        <SkeletonList rows={3} />
      ) : rows.length === 0 ? (
        <div className="empty">顧客が登録されていません。「顧客」タブから登録してください。</div>
      ) : (
        <div className="billing-board">
          {rows.map(({ customer: c, quote, contract, invoice: inv }) => {
            const canCheck = !readOnly && (user.role === "admin" || user.email === c.owner_email);
            const created = inv && inv.status !== "draft";
            return (
              <section key={c.id} id={`billing-${c.id}`} className="panel billing-row">
                <div className="billing-head">
                  <div>
                    <h2>{c.name}</h2>
                    <div className="small muted">
                      担当 {c.owner_name ?? c.owner_email} ・ 送付先 {c.delivery_to || "—"} ・ 連絡 {c.contact_via || "—"}
                    </div>
                  </div>
                  <div className="billing-status">
                    <StatusBadge invoice={inv} contract={contract} />
                    {inv && <strong className="billing-total">{yen(inv.total)}</strong>}
                  </div>
                </div>
                <p className="next-action small">
                  <span className="muted">次にやること：</span>
                  {nextAction(inv, contract, c)}
                </p>
                <div className="flow">
                  <Step done={quote ? quote.status === "accepted" : null} label="見積書" sub={quote ? `${quote.number} ${QUOTE_STATUS[quote.status as keyof typeof QUOTE_STATUS] ?? ""}` : "なし"} />
                  <span className="flow-arrow">→</span>
                  <Step done={contract} label="契約" sub={contract ? "今月請求あり" : "今月の請求なし"} />
                  <span className="flow-arrow">→</span>
                  <Step
                    done={inv ? Boolean(created) : contract ? false : null}
                    label="請求書"
                    sub={inv ? (created ? `No.${inv.number} ${inv.imported ? "（過去分を取り込み）" : ""}` : "下書き") : contract ? "未作成" : ""}
                  />
                  <span className="flow-arrow">→</span>
                  <div className="flow-step">
                    <label className="check-line">
                      <input type="checkbox" disabled={!created || !canCheck || busy !== ""} checked={Boolean(inv?.sent_at)} onChange={(e) => inv && check(inv, { sent: e.target.checked })} />
                      <span>送付済み</span>
                    </label>
                    <div className="small muted">{inv?.sent_at ? `${fmtDateTime(inv.sent_at)} ${inv.sent_by_name ?? ""}` : c.delivery_to}</div>
                  </div>
                  <span className="flow-arrow">→</span>
                  <div className="flow-step">
                    <label className="check-line">
                      <input
                        type="checkbox"
                        disabled={!created || !canCheck || busy !== ""}
                        checked={Boolean(inv?.contacted_at)}
                        onChange={(e) => inv && check(inv, { contacted: e.target.checked })}
                      />
                      <span>連絡済み</span>
                    </label>
                    <div className="small muted">{inv?.contacted_at ? `${fmtDateTime(inv.contacted_at)} ${inv.contacted_by_name ?? ""}` : c.contact_via}</div>
                  </div>
                </div>
                {inv && (
                  <div className="row wrap">
                    {!readOnly && !inv.imported && (
                      <button className={`btn btn-small ${inv.status === "draft" ? "btn-primary" : ""}`} disabled={busy !== ""} onClick={() => openInvoice(inv, c)}>
                        {inv.status === "draft" ? "内容を確認して作成" : "直して作り直す"}
                      </button>
                    )}
                    {readOnly && !inv.imported && (
                      <a className="btn btn-small" href={`/api/billing/invoices/${inv.id}/preview`} target="_blank" rel="noreferrer">
                        プレビュー
                      </a>
                    )}
                    {inv.pdf_key && (
                      <a className="btn btn-small" href={`/api/billing/invoices/${inv.id}/file`} target="_blank" rel="noreferrer">
                        PDF を開く
                      </a>
                    )}
                    {inv.drive_file_id && (
                      <a className="btn btn-small" href={`https://drive.google.com/file/d/${inv.drive_file_id}/view`} target="_blank" rel="noreferrer">
                        Drive で開く
                      </a>
                    )}
                    {created && !canCheck && <span className="small muted">送付・連絡のチェックは {c.owner_name ?? c.owner_email} さん（または管理者）が行います</span>}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/** 作成前の確認: 明細・備考・請求日を直し、プレビューで見た目を確かめてから作成する（誰が作っても同じ手順） */
function InvoiceConfirm({ invoice, customer, onClose, onIssued }: { invoice: Invoice; customer: Customer; onClose: () => void; onIssued: (r: { number: string; warnings: string[] }) => void }) {
  const [lines, setLines] = useState<InvoiceLine[]>(() => JSON.parse(invoice.lines || "[]"));
  const [issueDate, setIssueDate] = useState(invoice.issue_date ?? today());
  const [note, setNote] = useState(invoice.note || customer.invoice_note || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0);
  const set = (i: number, patch: Partial<InvoiceLine>) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const [saved, setSaved] = useState<"" | "saving" | "saved">("");
  const save = async () => {
    setSaved("saving");
    await api(`/api/billing/invoices/${invoice.id}`, { method: "PATCH", body: { lines, issue_date: issueDate, note } });
    setDirty(false);
    setSaved("saved");
    setPreviewKey((k) => k + 1);
  };
  // 直したら少し待って自動で保存し、プレビューも作り直す（「保存」「プレビューを更新」を押さなくてよい）
  useEffect(() => {
    if (!dirty || busy) return;
    const t = setTimeout(() => {
      save().catch((e) => (setSaved(""), setError(errorMessage(e))));
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, lines, note, issueDate, busy]);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const create = () =>
    run("issue", async () => {
      if (invoice.status !== "draft" && !confirm(`${customer.name} の請求書を作り直します。同じ番号（No.${invoice.number}）で PDF を上書きします。よろしいですか？`)) return;
      await save();
      onIssued(await api<{ number: string; warnings: string[] }>(`/api/billing/invoices/${invoice.id}/issue`, { body: { issue_date: issueDate } }));
    });
  return (
    <div className="panel invoice-confirm">
      <div className="between">
        <h2>
          {customer.name} ・ {monthLabel(invoice.period)}分の請求書 {invoice.status === "draft" ? "（作成前の確認）" : `（No.${invoice.number} を直す）`}
        </h2>
      </div>
      <p className="muted small">文言（期間・内容・備考）と請求日を確認して、必要なら直してください。金額は税込で入力します（合計から消費税を逆算します）。毎月の金額そのものを変える場合は「契約」タブで直します。</p>
      <div className="confirm-grid">
        <div>
          <label className="stack inline">
            <span>請求日</span>
            <input type="date" value={issueDate} onChange={(e) => (setIssueDate(e.target.value), setDirty(true))} />
          </label>
          <div className="table-scroll">
            <table className="simple-table line-table">
              <thead>
                <tr>
                  <th>対象期間</th>
                  <th>内容（改行できます）</th>
                  <th>数量</th>
                  <th>単価（税込）</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td data-label="対象期間">
                      <input value={l.period_label} onChange={(e) => set(i, { period_label: e.target.value })} placeholder="10月分" style={{ width: 96 }} />
                    </td>
                    <td data-label="内容（改行できます）">
                      <textarea rows={2} value={l.name} onChange={(e) => set(i, { name: e.target.value })} />
                    </td>
                    <td data-label="数量">
                      <input type="number" min={1} value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} style={{ width: 56 }} />
                    </td>
                    <td data-label="単価（税込）">
                      <input type="number" min={0} value={l.unit_price} onChange={(e) => set(i, { unit_price: Number(e.target.value) })} style={{ width: 110 }} />
                    </td>
                    <td data-label="">
                      <button className="btn btn-small btn-danger-ghost" onClick={() => (setLines((ls) => ls.filter((_, j) => j !== i)), setDirty(true))}>
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <button className="btn btn-small" onClick={() => (setLines((ls) => [...ls, { period_label: "", name: "", qty: 1, unit_price: 0, amount: 0 }]), setDirty(true))}>
              ＋ 行を追加
            </button>{" "}
            合計（税込） <strong>{yen(total)}</strong>
          </p>
          <label className="stack">
            <span>備考（この顧客向けの文。振込手数料・免税事業者の文は自動で続けて載ります）</span>
            <textarea rows={3} value={note} onChange={(e) => (setNote(e.target.value), setDirty(true))} placeholder="例: 貴社ご注文書（注文No. 〇〇）に基づきご請求申し上げます。" />
          </label>
        </div>
        <div className="confirm-preview">
          <div className="between small">
            <span className="muted">プレビュー</span>
            <span className="muted" role="status">
              {dirty || saved === "saving" ? "保存しています…" : saved === "saved" ? "✓ 自動で保存しました" : "直すと自動で保存します"}
            </span>
          </div>
          <iframe key={previewKey} title="請求書のプレビュー" src={`/api/billing/invoices/${invoice.id}/preview?v=${previewKey}`} />
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions sticky-actions">
        <button className="btn" disabled={busy !== ""} onClick={() => confirmLeave() && onClose()}>
          一覧に戻る
        </button>
        <button className="btn btn-primary" disabled={busy !== "" || total <= 0} onClick={create}>
          {busy === "issue" ? "作成中…（数秒かかります）" : invoice.status === "draft" ? "この内容で作成" : "この内容で作り直す"}
        </button>
      </div>
    </div>
  );
}

// ---------- 見積書 ----------

const emptyQuote = (customerId = ""): Quote => ({
  customer_id: customerId,
  issue_date: today(),
  valid_until: null,
  subject: "",
  items: [{ name: "", qty: 1, unit: "式", unit_price: 0 }],
  remarks: "",
  status: "draft",
});

function QuotesView({ onMakeContract }: { onMakeContract: (q: Quote) => void }) {
  const { user } = useAuth();
  const { customers } = useCustomers();
  const [quotes, setQuotes] = useState<(Quote & { items: string | QuoteItem[] })[] | null>(null);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [message, setMessage] = useState<{ kind: string; text: string } | null>(null);
  const readOnly = user.role === "viewer";

  const load = useCallback(() => {
    api<{ quotes: Quote[] }>("/api/billing/quotes").then((r) => setQuotes(r.quotes), () => setQuotes([]));
  }, []);
  useEffect(load, [load]);

  const parse = (q: Quote & { items: string | QuoteItem[] }): Quote => ({ ...q, items: typeof q.items === "string" ? JSON.parse(q.items || "[]") : q.items });

  const [errs, setErrs] = useState<Record<string, string>>({});
  useEditingGuard(editing);
  const save = async () => {
    if (!editing) return;
    setMessage(null);
    const e: Record<string, string> = {};
    if (!editing.customer_id) e.customer_id = "宛先を選んでください";
    if (!editing.subject.trim()) e.subject = "件名を入力してください";
    if (!editing.items.some((i) => i.name.trim())) e.items = "品目を1つ以上入力してください";
    setErrs(e);
    if (Object.keys(e).length) return;
    try {
      if (editing.id) await api(`/api/billing/quotes/${editing.id}`, { method: "PATCH", body: editing });
      else await api("/api/billing/quotes", { body: editing });
      setEditing(null);
      load();
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    }
  };

  const makePdf = async (q: Quote) => {
    setMessage({ kind: "info", text: "PDF を作成しています…" });
    try {
      const r = await api<{ warnings: string[] }>(`/api/billing/quotes/${q.id}/pdf`, { body: {} });
      setMessage({ kind: r.warnings.length ? "warn" : "ok", text: ["PDF を作成しました", ...r.warnings].join("\n") });
      load();
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    }
  };

  const set = (patch: Partial<Quote>) => setEditing((q) => (q ? { ...q, ...patch } : q));
  const setItem = (i: number, patch: Partial<QuoteItem>) => set({ items: editing!.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const subtotal = editing?.items.reduce((s, i) => s + Math.round((Number(i.qty) || 0) * (Number(i.unit_price) || 0)), 0) ?? 0;

  return (
    <>
      {!readOnly && !editing && (
        <p>
          <button className="btn btn-primary" onClick={() => setEditing(emptyQuote())}>
            ＋ 見積書を作る
          </button>
        </p>
      )}
      {message && <pre className={`notice notice-${message.kind}`}>{message.text}</pre>}
      {editing && (
        <div className="panel">
          <h2>{editing.id ? `見積書を編集（No.${editing.number}）` : "見積書を作る"}</h2>
          <div className="grid-2">
            <label className="stack">
              <span>宛先</span>
              <select aria-invalid={Boolean(errs.customer_id)} value={editing.customer_id} onChange={(e) => set({ customer_id: e.target.value })}>
                <option value="">選んでください</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <FieldError message={errs.customer_id} />
            </label>
            <label className="stack">
              <span>件名</span>
              <input aria-invalid={Boolean(errs.subject)} value={editing.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="例: AI導入・定着支援プログラム" />
              <FieldError message={errs.subject} />
            </label>
            <label className="stack">
              <span>見積日</span>
              <input type="date" value={editing.issue_date} onChange={(e) => set({ issue_date: e.target.value })} />
            </label>
            <label className="stack">
              <span>有効期限</span>
              <input type="date" value={editing.valid_until ?? ""} onChange={(e) => set({ valid_until: e.target.value || null })} />
            </label>
            {editing.id && (
              <label className="stack">
                <span>状態</span>
                <select value={editing.status} onChange={(e) => set({ status: e.target.value as Quote["status"] })}>
                  {Object.entries(QUOTE_STATUS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="table-scroll">
            <table className="simple-table line-table">
              <thead>
                <tr>
                  <th>品目</th>
                  <th>数量</th>
                  <th>単位</th>
                  <th>単価（税抜）</th>
                  <th>金額</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {editing.items.map((it, i) => (
                  <tr key={i}>
                    <td data-label="品目">
                      <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} />
                    </td>
                    <td data-label="数量">
                      <input type="number" min={0} step="any" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} style={{ width: 70 }} />
                    </td>
                    <td data-label="単位">
                      <input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} style={{ width: 60 }} />
                    </td>
                    <td data-label="単価（税抜）">
                      <input type="number" min={0} value={it.unit_price} onChange={(e) => setItem(i, { unit_price: Number(e.target.value) })} style={{ width: 120 }} />
                    </td>
                    <td data-label="金額" className="small">{yen(Math.round((Number(it.qty) || 0) * (Number(it.unit_price) || 0)))}</td>
                    <td data-label="">
                      <button className="btn btn-small btn-danger-ghost" onClick={() => set({ items: editing.items.filter((_, j) => j !== i) })}>
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <button className="btn btn-small" onClick={() => set({ items: [...editing.items, { name: "", qty: 1, unit: "式", unit_price: 0 }] })}>
              ＋ 行を追加
            </button>{" "}
            小計 {yen(subtotal)} ／ 消費税 {yen(Math.floor(subtotal * 0.1))} ／ <strong>合計 {yen(subtotal + Math.floor(subtotal * 0.1))}</strong>
          </p>
          <FieldError message={errs.items} />
          <label className="stack">
            <span>備考</span>
            <textarea rows={3} value={editing.remarks} onChange={(e) => set({ remarks: e.target.value })} />
          </label>
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>
              キャンセル
            </button>
            <button className="btn btn-primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        {quotes === null ? (
          <p className="muted">読み込み中…</p>
        ) : quotes.length === 0 ? (
          <p className="muted">見積書はまだありません。</p>
        ) : (
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>見積日・番号</th>
                  <th>宛先・件名</th>
                  <th>合計（税込）</th>
                  <th>状態</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {quotes.map((raw) => {
                  const q = parse(raw);
                  return (
                    <tr key={q.id}>
                      <td className="small">
                        {jpDate(q.issue_date)}
                        <div className="muted">No.{q.number}</div>
                      </td>
                      <td>
                        <strong>{q.customer_name}</strong>
                        <div className="small muted">{q.subject}</div>
                      </td>
                      <td>{yen(q.total)}</td>
                      <td>
                        <span className={`pill ${q.status === "accepted" ? "pill-ok" : q.status === "rejected" ? "" : "pill-info"}`}>{QUOTE_STATUS[q.status]}</span>
                      </td>
                      <td>
                        <div className="row wrap">
                          {q.items.length > 0 && !readOnly && (
                            <button className="btn btn-small" onClick={() => setEditing(q)}>
                              編集
                            </button>
                          )}
                          {q.items.length > 0 && (
                            <a className="btn btn-small" href={`/api/billing/quotes/${q.id}/preview`} target="_blank" rel="noreferrer">
                              プレビュー
                            </a>
                          )}
                          {q.items.length > 0 && !readOnly && (
                            <button className="btn btn-small" onClick={() => makePdf(q)}>
                              PDF を作成
                            </button>
                          )}
                          {q.pdf_key && (
                            <a className="btn btn-small" href={`/api/billing/quotes/${q.id}/file`} target="_blank" rel="noreferrer">
                              PDF を開く
                            </a>
                          )}
                          {user.role === "admin" && (
                            <button className="btn btn-small" onClick={() => onMakeContract(q)}>
                              契約にする
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- 契約 ----------

const emptyContract = (customerId: string | null = null, quoteId: string | null = null): Contract => ({
  customer_id: customerId,
  title: "",
  item_name: "",
  amount: 0,
  cycle: "monthly",
  count_total: null,
  start_month: thisMonth(),
  end_month: null,
  period_style: "month",
  quote_id: quoteId,
  memo: "",
  status: "active",
});

function ContractsView({ initialQuote, initialCustomer }: { initialQuote: string | null; initialCustomer: string | null }) {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user.role === "admin";
  const { customers } = useCustomers();
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [editing, setEditing] = useState<Contract | null>(initialQuote && isAdmin ? emptyContract(initialCustomer, initialQuote) : null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ contracts: Contract[] }>("/api/billing/contracts").then((r) => setContracts(r.contracts), () => setContracts([]));
  }, []);
  useEffect(() => {
    load();
    api<{ quotes: Quote[] }>("/api/billing/quotes").then((r) => setQuotes(r.quotes), () => {});
  }, [load]);

  const [errs, setErrs] = useState<Record<string, string>>({});
  useEditingGuard(editing);
  const save = async () => {
    if (!editing) return;
    setError("");
    const e: Record<string, string> = {};
    if (!editing.customer_id) e.customer_id = "顧客を選んでください";
    if (!editing.title.trim()) e.title = "契約内容を入力してください";
    if (!Number.isInteger(Number(editing.amount)) || Number(editing.amount) <= 0) e.amount = "金額（税抜・円）を整数で入力してください";
    if (!/^\d{4}-\d{2}$/.test(editing.start_month)) e.start_month = "最初の請求月を選んでください";
    if (editing.cycle === "count" && !(Number(editing.count_total) >= 1)) e.count_total = "総回数を入力してください";
    setErrs(e);
    if (Object.keys(e).length) return;
    try {
      const body = { ...editing, amount: Number(editing.amount), count_total: editing.count_total ? Number(editing.count_total) : null };
      if (editing.id) await api(`/api/billing/contracts/${editing.id}`, { method: "PATCH", body });
      else await api("/api/billing/contracts", { body });
      setEditing(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const set = (patch: Partial<Contract>) => setEditing((c) => (c ? { ...c, ...patch } : c));

  return (
    <>
      {isAdmin && !editing && (
        <p>
          <button className="btn btn-primary" onClick={() => setEditing(emptyContract())}>
            ＋ 契約を登録
          </button>
        </p>
      )}
      {editing && (
        <div className="panel">
          <h2>{editing.id ? "契約を編集" : "契約を登録"}</h2>
          <div className="grid-2">
            <label className="stack">
              <span>顧客</span>
              <select aria-invalid={Boolean(errs.customer_id)} value={editing.customer_id ?? ""} onChange={(e) => set({ customer_id: e.target.value || null })}>
                <option value="">選んでください</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <FieldError message={errs.customer_id} />
            </label>
            <label className="stack">
              <span>契約内容（社内向けの名前）</span>
              <input aria-invalid={Boolean(errs.title)} value={editing.title} onChange={(e) => set({ title: e.target.value })} placeholder="例: AI活用支援 月額" />
              <FieldError message={errs.title} />
            </label>
            <label className="stack">
              <span>請求書の品目名（空なら契約内容）</span>
              <input value={editing.item_name} onChange={(e) => set({ item_name: e.target.value })} placeholder="例: AI活用コンサルティング費用" />
            </label>
            <label className="stack">
              <span>1回あたりの金額（税抜・円）</span>
              <input aria-invalid={Boolean(errs.amount)} type="number" min={0} value={editing.amount} onChange={(e) => set({ amount: Number(e.target.value) })} />
              <FieldError message={errs.amount} />
              <span className="small muted">税込 {yen(Math.round(Number(editing.amount) * 1.1))}</span>
            </label>
            <label className="stack">
              <span>請求サイクル</span>
              <select value={editing.cycle} onChange={(e) => set({ cycle: e.target.value as Contract["cycle"] })}>
                {Object.entries(CYCLE).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>最初の請求月</span>
              <input aria-invalid={Boolean(errs.start_month)} type="month" value={editing.start_month} onChange={(e) => set({ start_month: e.target.value })} />
              <FieldError message={errs.start_month} />
            </label>
            {editing.cycle === "monthly" && (
              <label className="stack">
                <span>最終月（空なら継続中）</span>
                <input type="month" value={editing.end_month ?? ""} onChange={(e) => set({ end_month: e.target.value || null })} />
              </label>
            )}
            {editing.cycle === "count" && (
              <label className="stack">
                <span>総回数</span>
                <input aria-invalid={Boolean(errs.count_total)} type="number" min={1} value={editing.count_total ?? ""} onChange={(e) => set({ count_total: Number(e.target.value) })} />
                <FieldError message={errs.count_total} />
              </label>
            )}
            {editing.cycle !== "once" && (
              <label className="stack">
                <span>請求書の期間の書き方</span>
                <select value={editing.period_style} onChange={(e) => set({ period_style: e.target.value as Contract["period_style"] })}>
                  <option value="month">「9月分」</option>
                  <option value="range">「9/1〜9/30」</option>
                </select>
              </label>
            )}
            <label className="stack">
              <span>もとになった見積書</span>
              <select value={editing.quote_id ?? ""} onChange={(e) => set({ quote_id: e.target.value || null })}>
                <option value="">（なし）</option>
                {quotes
                  .filter((q) => !editing.customer_id || q.customer_id === editing.customer_id)
                  .map((q) => (
                    <option key={q.id} value={q.id}>
                      No.{q.number} {q.subject}
                    </option>
                  ))}
              </select>
            </label>
            {editing.id && (
              <label className="stack">
                <span>状態</span>
                <select value={editing.status} onChange={(e) => set({ status: e.target.value as Contract["status"] })}>
                  <option value="active">有効</option>
                  <option value="ended">終了</option>
                </select>
              </label>
            )}
          </div>
          <label className="stack">
            <span>メモ</span>
            <textarea rows={2} value={editing.memo} onChange={(e) => set({ memo: e.target.value })} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>
              キャンセル
            </button>
            <button className="btn btn-primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        {contracts === null ? (
          <p className="muted">読み込み中…</p>
        ) : contracts.length === 0 ? (
          <p className="muted">契約はまだありません。</p>
        ) : (
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>顧客・契約</th>
                  <th>金額（税抜）</th>
                  <th>サイクル・期間</th>
                  <th>契約書</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className={c.status === "ended" ? "inactive" : ""}>
                    <td>
                      <strong>{c.customer_name ?? "（顧客未設定）"}</strong>
                      <div className="small muted">
                        {c.title}
                        {c.item_name && c.item_name !== c.title && ` ／ 請求書: ${c.item_name}`}
                        {c.quote_number && ` ／ 見積 No.${c.quote_number}`}
                        {c.status === "ended" && "（終了）"}
                      </div>
                    </td>
                    <td>{yen(c.amount)}</td>
                    <td className="small">
                      {CYCLE[c.cycle]}
                      {c.cycle === "count" && ` 全${c.count_total}回`}
                      <div className="muted">
                        {c.start_month}〜{c.cycle === "monthly" ? (c.end_month ?? "継続中") : ""}
                      </div>
                    </td>
                    <td className="small">
                      {c.document_key ? (
                        <a href={`/api/billing/contracts/${c.id}/document`} target="_blank" rel="noreferrer">
                          {c.document_name ?? "契約書"}
                        </a>
                      ) : (
                        <span className="muted">なし</span>
                      )}
                      {isAdmin && (
                        <label className="link-button small" style={{ display: "block" }}>
                          {c.document_key ? "差し替える" : "PDF を添付"}
                          <input
                            type="file"
                            accept="application/pdf"
                            hidden
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              e.target.value = "";
                              if (!f) return;
                              const fd = new FormData();
                              fd.set("file", f);
                              try {
                                const r = await postForm<{ warnings: string[] }>(`/api/billing/contracts/${c.id}/document`, fd);
                                toast(["契約書を添付しました", ...r.warnings].join("。"), { kind: r.warnings.length ? "info" : "ok" });
                                load();
                              } catch (err) {
                                toast(errorMessage(err), { kind: "error" });
                              }
                            }}
                          />
                        </label>
                      )}
                    </td>
                    {isAdmin && (
                      <td>
                        <button className="btn btn-small" onClick={() => setEditing({ ...c, item_name: c.item_name ?? "", memo: c.memo ?? "" })}>
                          編集
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isAdmin && <p className="muted small">契約の登録・変更は管理者が行います。</p>}
      </div>
    </>
  );
}

// ---------- 顧客マスタ ----------

function CustomersView() {
  const { user } = useAuth();
  const staff = useStaff();
  const { customers, reload } = useCustomers();
  const [editing, setEditing] = useState<Partial<Customer> | null>(null);
  const [error, setError] = useState("");
  const readOnly = user.role === "viewer";

  const [errs, setErrs] = useState<Record<string, string>>({});
  useEditingGuard(editing);
  const save = async () => {
    if (!editing) return;
    setError("");
    const e: Record<string, string> = {};
    if (!editing.name?.trim()) e.name = "宛名（正式名称）を入力してください";
    if (!/^[^@\s]+@[^@\s]+$/.test(editing.owner_email ?? "")) e.owner_email = "担当者のメールアドレスを入力してください";
    setErrs(e);
    if (Object.keys(e).length) return;
    try {
      if (editing.id) await api(`/api/billing/customers/${editing.id}`, { method: "PATCH", body: editing });
      else await api("/api/billing/customers", { body: editing });
      setEditing(null);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const set = (patch: Partial<Customer>) => setEditing((c) => ({ ...c, ...patch }));
  const owners = useMemo(() => {
    const list = [...staff];
    for (const c of customers ?? []) if (!list.some((s) => s.email === c.owner_email)) list.push({ email: c.owner_email, name: c.owner_name ?? c.owner_email });
    return list;
  }, [staff, customers]);

  return (
    <>
      {!readOnly && !editing && (
        <p>
          <button className="btn btn-primary" onClick={() => setEditing({ name: "", owner_email: user.email, delivery_to: "", contact_via: "", invoice_note: "", memo: "" })}>
            ＋ 顧客を追加
          </button>
        </p>
      )}
      {editing && (
        <div className="panel">
          <h2>{editing.id ? "顧客を編集" : "顧客を追加"}</h2>
          <div className="grid-2">
            <label className="stack">
              <span>宛名（正式名称）</span>
              <input aria-invalid={Boolean(errs.name)} value={editing.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="例: サンプル自動車株式会社" />
              <FieldError message={errs.name} />
            </label>
            <label className="stack">
              <span>請求書の担当（作成・送付・連絡）</span>
              <input
                aria-invalid={Boolean(errs.owner_email)}
                list="owner-list"
                value={editing.owner_email ?? ""}
                disabled={Boolean(editing.id) && user.role !== "admin"}
                onChange={(e) => set({ owner_email: e.target.value })}
              />
              {Boolean(editing.id) && user.role !== "admin" && <span className="small muted">担当の変更は管理者が行います</span>}
              <FieldError message={errs.owner_email} />
              <datalist id="owner-list">
                {owners.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="stack">
              <span>送付先</span>
              <input value={editing.delivery_to ?? ""} onChange={(e) => set({ delivery_to: e.target.value })} placeholder="例: Box、共有Googleドライブ" />
            </label>
            <label className="stack">
              <span>連絡手段</span>
              <input value={editing.contact_via ?? ""} onChange={(e) => set({ contact_via: e.target.value })} placeholder="例: LINE、Googleチャット" />
            </label>
          </div>
          <label className="stack">
            <span>請求書の備考に追加する文（注文番号など）</span>
            <textarea rows={2} value={editing.invoice_note ?? ""} onChange={(e) => set({ invoice_note: e.target.value })} />
          </label>
          <label className="stack">
            <span>メモ</span>
            <textarea rows={2} value={editing.memo ?? ""} onChange={(e) => set({ memo: e.target.value })} />
          </label>
          {editing.id && (
            <label className="check-line">
              <input type="checkbox" checked={editing.active !== 0} onChange={(e) => set({ active: e.target.checked ? 1 : 0 })} />
              <span>取引中（外すと月の状況に出なくなります）</span>
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>
              キャンセル
            </button>
            <button className="btn btn-primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        {customers === null ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>顧客</th>
                  <th>担当</th>
                  <th>送付先</th>
                  <th>連絡手段</th>
                  {!readOnly && <th />}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className={c.active ? "" : "inactive"}>
                    <td>
                      <strong>{c.name}</strong>
                      {c.invoice_note && <div className="small muted">備考: {c.invoice_note}</div>}
                    </td>
                    <td>{c.owner_name ?? c.owner_email}</td>
                    <td>{c.delivery_to}</td>
                    <td>{c.contact_via}</td>
                    {!readOnly && (
                      <td>
                        <button className="btn btn-small" onClick={() => setEditing(c)}>
                          編集
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- 過去の書類の取り込み ----------

interface ImportRow {
  file: File;
  kind: "invoice" | "quote";
  customer_id: string;
  number: string;
  issue_date: string;
  period: string;
  total: number;
  subject: string;
  /** 送付・連絡が済んでいるか（済んでいなければ担当者のチェック待ちで登録） */
  sent: boolean;
  state: "" | "done" | "error";
  note: string;
}

function ImportView() {
  const { customers } = useCustomers();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);

  const add = (files: FileList | null) => {
    if (!files || !customers) return;
    const next = Array.from(files).map((file): ImportRow => {
      const p = parseDocName(file.name);
      const best = p.customerName ? customers.map((c) => ({ c, s: similarity(c.name, p.customerName!) })).sort((a, b) => b.s - a.s)[0] : undefined;
      return {
        file,
        kind: p.kind ?? "invoice",
        customer_id: best && best.s >= 0.5 ? best.c.id : "",
        number: p.number ?? "",
        issue_date: p.issue_date ?? "",
        period: p.period ?? "",
        total: p.total ?? 0,
        subject: p.subject ?? "",
        sent: true,
        state: "",
        note: best && best.s >= 0.5 && best.s < 0.95 ? `ファイル名の「${p.customerName}」を ${best.c.name} として扱います` : "",
      };
    });
    setRows((r) => [...r, ...next]);
  };

  const set = (i: number, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const importAll = async () => {
    setBusy(true);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.state === "done") continue;
      const form = new FormData();
      form.set("file", r.file);
      for (const k of ["kind", "customer_id", "number", "issue_date", "period", "subject"] as const) form.set(k, r[k]);
      form.set("total", String(r.total));
      form.set("done", r.sent ? "1" : "0");
      try {
        const res = await postForm<{ warnings?: string[] }>("/api/billing/import", form);
        set(i, { state: "done", note: res.warnings?.join(" ") || "取り込みました" });
      } catch (e) {
        set(i, { state: "error", note: errorMessage(e) });
      }
    }
    setBusy(false);
  };

  return (
    <div className="panel">
      <h2>発行済みの請求書・見積書を取り込む</h2>
      <p className="muted small">
        システムの外で作った請求書・見積書（設定された代表者が作った分など）の PDF をまとめて選ぶと、ファイル名から顧客・日付・金額・番号を読み取ります。その月がまだ下書きなら、取り込んだ請求書に置き換えます。「送付・連絡」の「済み」を外すと、担当者のチェック待ちとして登録します。内容を確認して「取り込む」を押すと、アプリに登録して Google Drive の所定フォルダにも保存します（請求書は送付・連絡済みとして登録）。
      </p>
      <input type="file" accept="application/pdf" multiple onChange={(e) => add(e.target.files)} />
      {rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>ファイル</th>
                  <th>種類</th>
                  <th>顧客</th>
                  <th>番号</th>
                  <th>発行日</th>
                  <th>対象月 / 件名</th>
                  <th>合計（税込）</th>
                  <th>送付・連絡</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="small">{r.file.name}</td>
                    <td>
                      <select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as ImportRow["kind"] })} disabled={r.state === "done"}>
                        <option value="invoice">請求書</option>
                        <option value="quote">見積書</option>
                      </select>
                    </td>
                    <td>
                      <select value={r.customer_id} onChange={(e) => set(i, { customer_id: e.target.value })} disabled={r.state === "done"}>
                        <option value="">選んでください</option>
                        {customers?.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input value={r.number} onChange={(e) => set(i, { number: e.target.value })} size={14} disabled={r.state === "done"} />
                    </td>
                    <td>
                      <input type="date" value={r.issue_date} onChange={(e) => set(i, { issue_date: e.target.value })} disabled={r.state === "done"} />
                    </td>
                    <td>
                      {r.kind === "invoice" ? (
                        <input type="month" value={r.period} onChange={(e) => set(i, { period: e.target.value })} disabled={r.state === "done"} />
                      ) : (
                        <input value={r.subject} onChange={(e) => set(i, { subject: e.target.value })} disabled={r.state === "done"} />
                      )}
                    </td>
                    <td>
                      <input type="number" value={r.total} onChange={(e) => set(i, { total: Number(e.target.value) })} style={{ width: 110 }} disabled={r.state === "done"} />
                    </td>
                    <td data-label="送付・連絡">
                      {r.kind === "invoice" ? (
                        <label className="check-line small">
                          <input type="checkbox" checked={r.sent} disabled={r.state === "done"} onChange={(e) => set(i, { sent: e.target.checked })} />
                          済み
                        </label>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="small">
                      {r.state === "done" ? <span className="pill pill-ok">完了</span> : r.state === "error" ? <span className="pill pill-error">失敗</span> : null} {r.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setRows([])} disabled={busy}>
              クリア
            </button>
            <button className="btn btn-primary" onClick={importAll} disabled={busy || rows.every((r) => r.state === "done")}>
              {busy ? "取り込み中…" : "取り込む"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
