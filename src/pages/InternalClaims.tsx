// 社内請求・経費精算: 月末締め・翌月5日払い。稼働分と立替経費の請求書を翌月2日までに発行する（全員が全員の分を見られる）
// やることに番号を振り、必ず押すボタンは赤にする。全員そろったら代表に Google Chat で自動連絡（サーバー側）
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/format";
import { jpDate, monthLabel, openHtml, postForm, shiftMonth, today, yen } from "../lib/money";
import { Hint, SkeletonList, useToast } from "../components/ui";

/** 期限までの日数（日本時間の今日から） */
const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400_000);
const untilText = (date: string) => {
  const d = daysUntil(date);
  return d > 0 ? `あと${d}日` : d === 0 ? "今日まで" : `${-d}日過ぎています`;
};

interface Member {
  email: string;
  display_name: string;
  number_suffix: string;
  bank_text: string;
  default_item: string;
  default_unit_price: number;
}

interface Claim {
  id: string;
  kind: "work" | "expense";
  number: string;
  issue_date: string;
  due_date: string;
  total: number;
  status: "submitted" | "paid";
  pdf_key: string | null;
  drive_file_id: string | null;
  submitted_at: string;
  paid_at: string | null;
  paid_by_name: string | null;
}

interface ExpenseItem {
  id: string;
  spent_on: string;
  purpose: string;
  amount: number;
  receipt_id: string | null;
  receipt_amount: number | null;
  receipt_name: string | null;
  original_submitted_at: string | null;
  match?: "ok" | "mismatch" | "no_receipt";
}

interface WorkLine {
  name: string;
  qty: number;
  unit_price: number;
}

/** その月の、人ごとのやることの状況（サーバーの monthStatus） */
interface MemberStatus {
  work: boolean;
  expense: boolean;
  no_expense: boolean;
  pending_items: number;
  expense_done: boolean;
  drive_pending: number;
  originals_pending: number;
  done: boolean;
}

interface Row {
  member: Member;
  status: MemberStatus;
  work: Claim | null;
  expense: Claim | null;
  pending_items: ExpenseItem[];
  claimed_items: ExpenseItem[];
  work_preview: { lines: WorkLine[]; subtotal: number; tax: number; total: number };
}

interface Overview {
  period: string;
  deadline: string;
  pay_date: string;
  first_period: string;
  chat_flow_from: string;
  /** 請求書を受け取って支払う人（代表） */
  payer_email: string;
  payer_name: string;
  /** 全員の発行と領収書の Drive 保存がそろったか */
  complete: boolean;
  /** 代表に Google Chat で連絡した日時 */
  notified_at: string | null;
  rows: Row[];
}

interface Receipt {
  id: string;
  member_email: string;
  file_name: string;
  amount: number;
  paid_on: string;
  vendor: string;
  original_submitted_at: string | null;
  checked_by_name: string | null;
  used: number;
}

type Flash = { kind: "ok" | "warn" | "error"; text: string } | null;

export function InternalClaimsPage() {
  const [period, setPeriod] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [receiptsKey, setReceiptsKey] = useState(0);
  const { user } = useAuth();

  const load = useCallback(() => {
    api<Overview>(`/api/internal/overview${period ? `?period=${period}` : ""}`).then(
      (r) => {
        setData(r);
        if (!period) setPeriod(r.period);
      },
      (e) => setFlash({ kind: "error", text: errorMessage(e) }),
    );
    setReceiptsKey((k) => k + 1);
  }, [period]);
  useEffect(load, [load]);

  if (!data || !period)
    return (
      <div className="page">
        <h1>社内請求・経費</h1>
        {flash?.kind === "error" ? (
          <div className="notice notice-error" role="alert">
            <p>{flash.text}</p>
            <button className="btn btn-small" onClick={() => (setFlash(null), load())}>
              再読み込み
            </button>
          </div>
        ) : (
          <SkeletonList rows={2} />
        )}
      </div>
    );
  const first = data.first_period;

  return (
    <div className="page">
      <h1>社内請求・経費</h1>
      <div className="toolbar">
        <button className="btn btn-small" disabled={period <= first} onClick={() => setPeriod(shiftMonth(period, -1))} aria-label="前の月">
          ◀
        </button>
        <input type="month" min={first} value={period} onChange={(e) => e.target.value >= first && setPeriod(e.target.value)} aria-label="稼働月" />
        <button className="btn btn-small" onClick={() => setPeriod(shiftMonth(period, 1))} aria-label="次の月">
          ▶
        </button>
        <span className="toolbar-spacer" />
        {user.role !== "viewer" && (
          <Link className="btn btn-small" to="/internal/import">
            ＋ 立替経費をまとめて登録（CSV＋写真）
          </Link>
        )}
        <Link className="btn btn-small" to="/internal/export">
          税理士提出用のファイル
        </Link>
      </div>
      <div className="deadline-bar">
        <span>
          <strong>{monthLabel(period)}分</strong>（稼働月）
        </span>
        <span>
          提出期限 <strong>{jpDate(data.deadline)}</strong> <span className={`status ${daysUntil(data.deadline) < 0 ? "status-error" : daysUntil(data.deadline) <= 1 ? "status-warn" : "status-todo"}`}>{untilText(data.deadline)}</span>
        </span>
        <span>
          支払日 <strong>{jpDate(data.pay_date)}</strong>
        </span>
      </div>
      <Hint summary="締め・発行・支払いのルール">
        月末締め・翌月5日払いです。翌月2日までに、稼働分と立替経費の請求書を発行します。請求書と領収書の写真は Google Drive の「社内請求・経費 / {monthLabel(period)}分」に入ります。お知らせはすべて Google Chat です（月末21時にお願い、1日の10・14・19時にまだの人だけをメンションしてリマインド、全員そろったら{data.payer_name}さんに「税理士に送ってください」と自動で連絡）。領収書の原本は期限なしで、次に会うときにまとめて渡します。立替経費は、明細と領収書の金額が1円でも違うと発行できません。
      </Hint>
      <MonthChecklist data={data} />
      {flash && <pre className={`notice notice-${flash.kind}`}>{flash.text}</pre>}
      {data.rows.map((row) => (
        <MemberPanel key={row.member.email} row={row} period={period} payerName={data.payer_name} onChange={load} setFlash={setFlash} />
      ))}
      <ReceiptOriginals key={receiptsKey} members={data.rows.map((r) => r.member)} onChange={load} />
    </div>
  );
}

/** 済み／まだ の印 */
function Mark({ done, todo = "まだ", doneText = "済み" }: { done: boolean; todo?: string; doneText?: string }) {
  return done ? <span className="status status-done">✓ {doneText}</span> : <span className="status status-warn">{todo}</span>;
}

/** 今月やることの一覧（人ごと）。全員そろったら代表に自動で連絡する */
function MonthChecklist({ data }: { data: Overview }) {
  const m = monthLabel(data.period);
  return (
    <section className="panel checklist">
      <h2>{m}分のやること</h2>
      <div className="table-scroll">
        <table className="simple-table">
          <thead>
            <tr>
              <th />
              <th>① 稼働分の請求書</th>
              <th>② 立替経費の請求書</th>
              <th>③ 領収書の写真（Drive）</th>
              <th>④ 原本を{data.payer_name}さんへ</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(({ member, status: st }) => (
              <tr key={member.email}>
                <th scope="row">{member.display_name}</th>
                <td data-label="① 稼働分の請求書">
                  <Mark done={st.work} doneText="発行済み" />
                </td>
                <td data-label="② 立替経費の請求書">
                  <Mark done={st.expense_done} doneText={st.expense ? "発行済み" : "経費なし"} />
                </td>
                <td data-label="③ 領収書の写真（Drive）">
                  {!st.expense ? <span className="muted small">—</span> : <Mark done={st.drive_pending === 0} todo={`保存中（残り ${st.drive_pending} 枚）`} doneText="保存済み" />}
                </td>
                <td data-label="④ 原本">
                  {!st.expense ? (
                    <span className="muted small">—</span>
                  ) : st.originals_pending ? (
                    <span className="status status-todo">まだ {st.originals_pending} 枚（期限なし）</span>
                  ) : (
                    <Mark done doneText="渡した" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        {data.notified_at ? (
          <>
            <span className="status status-done">✓ 連絡済み</span> {fmtDateTime(data.notified_at)} に{data.payer_name}さんへ Google Chat で「税理士に送ってください」と連絡しました。
          </>
        ) : data.period < data.chat_flow_from ? (
          <span className="muted">{monthLabel(data.chat_flow_from)}分からは、全員の①〜③がそろうと{data.payer_name}さんに Google Chat で自動で連絡します。</span>
        ) : data.complete ? (
          <>全員そろいました。まもなく{data.payer_name}さんに Google Chat で連絡します。</>
        ) : (
          <span className="muted">全員の①〜③がそろうと、{data.payer_name}さんに Google Chat で「中身を確認して税理士に送ってください」と自動で連絡します。④は期限なしです。</span>
        )}
      </p>
    </section>
  );
}

/** 本人か管理者か（社内請求・経費の変更は本人と管理者だけ。サーバー側でも同じ制限） */
const selfOrAdmin = (user: { role: string; email: string }, email: string) => user.role !== "viewer" && (user.role === "admin" || user.email === email);

function ClaimBox({ claim, owner, onChange, setFlash }: { claim: Claim; owner: string; onChange: () => void; setFlash: (f: Flash) => void }) {
  const { user } = useAuth();
  const readOnly = !selfOrAdmin(user, owner);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e) });
    }
  };
  return (
    <div className="claim-box">
      <div>
        <span className="pill pill-ok">発行済み</span> No.{claim.number} <strong>{yen(claim.total)}</strong>
        <span className="small muted"> ・ {fmtDateTime(claim.submitted_at)}</span>
        {claim.status === "paid" && <span className="pill pill-ok"> 精算済み</span>}
      </div>
      <div className="row wrap">
        {claim.pdf_key && (
          <a className="btn btn-small" href={`/api/internal/claims/${claim.id}/file`} target="_blank" rel="noreferrer">
            PDF を開く
          </a>
        )}
        {claim.drive_file_id && (
          <a className="btn btn-small" href={`https://drive.google.com/file/d/${claim.drive_file_id}/view`} target="_blank" rel="noreferrer">
            Drive で開く
          </a>
        )}
        {!readOnly && claim.status !== "paid" && (
          <button
            className="btn btn-small btn-danger-ghost"
            onClick={() =>
              confirm("この請求書を取り消します（明細は未発行に戻ります）。よろしいですか？") &&
              act(async () => {
                const r = await api<{ note: string }>(`/api/internal/claims/${claim.id}`, { method: "DELETE" });
                setFlash({ kind: "warn", text: `取り消しました。${r.note}` });
              })
            }
          >
            取り消す
          </button>
        )}
      </div>
    </div>
  );
}

/** 番号つきの手順の見出し。済んだら番号の代わりに ✓ */
function StepHead({ no, done, children }: { no: number; done: boolean; children: ReactNode }) {
  return (
    <h3 className="step-head">
      <span className={`step-no ${done ? "step-no-done" : ""}`}>{done ? "✓" : no}</span>
      {children}
    </h3>
  );
}

function MemberPanel({ row, period, payerName, onChange, setFlash }: { row: Row; period: string; payerName: string; onChange: () => void; setFlash: (f: Flash) => void }) {
  const { user } = useAuth();
  // 見るのは全員、変えられるのは本人と管理者だけ
  const readOnly = !selfOrAdmin(user, row.member.email);
  const m = row.member;
  const st = row.status;
  const [lines, setLines] = useState<WorkLine[]>(() => row.work_preview.lines.map((l) => ({ ...l, name: l.name.replace(/^\[\d{4}-\d{2}-\d{2}\]/, "") })));
  const [busy, setBusy] = useState("");
  // 発行の前にプレビューで金額を確かめる。内容が変わったら、もう一度プレビューから
  const [previewed, setPreviewed] = useState({ work: false, expense: false });
  useEffect(() => {
    setLines(row.work_preview.lines.map((l) => ({ ...l, name: l.name.replace(/^\[\d{4}-\d{2}-\d{2}\]/, "") })));
  }, [row.work_preview]);
  useEffect(() => setPreviewed((p) => ({ ...p, work: false })), [lines]);
  useEffect(() => setPreviewed((p) => ({ ...p, expense: false })), [row.pending_items]);

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0);
  const tax = Math.floor(subtotal * 0.1);

  const submit = async (kind: "work" | "expense") => {
    const missing = row.pending_items.filter((i) => i.match === "no_receipt");
    let allow = false;
    if (kind === "expense" && missing.length) {
      if (!confirm(`領収書のない明細が ${missing.length} 件あります。このまま発行しますか？（領収書がもらえない支払いの場合のみ）`)) return;
      allow = true;
    }
    setBusy(kind);
    try {
      const r = await api<{ id: string; warnings: string[]; receipts_pending: number }>("/api/internal/claims", {
        body: { member_email: m.email, period, kind, lines: kind === "work" ? lines : undefined, allow_missing_receipt: allow },
      });
      const done = `${m.display_name}さんの${monthLabel(period)}分の${kind === "work" ? "稼働分" : "立替経費"}の請求書を発行しました（間違えた場合は「取り消す」で戻せます）`;
      const warnings = [...r.warnings];
      // 領収書は発行とは別に、数件ずつ Drive に置く（1回で全部置くと Cloudflare の通信数の上限にかかる）
      const total = r.receipts_pending;
      let left = total;
      while (left > 0) {
        setFlash({ kind: "ok", text: `${done}\n領収書の写真を Google Drive に保存しています…（${total - left}/${total}）この画面を開いたままにしてください` });
        const d = await api<{ saved: number; remaining: number; warnings: string[] }>(`/api/internal/claims/${r.id}/drive-receipts`, { body: {} });
        warnings.push(...d.warnings);
        if (!d.saved && d.remaining >= left) {
          warnings.push(`領収書の写真 ${d.remaining} 枚はまだ Drive に保存できていません。1時間ごとに自動で続きを保存します（全部そろうまで数時間かかることがあります）`);
          break;
        }
        left = d.remaining;
      }
      setFlash({ kind: warnings.length ? "warn" : "ok", text: [`${done}\n請求書の PDF${total ? `と領収書の写真 ${total - left} 枚` : ""}を Google Drive に保存しました`, ...warnings].join("\n") });
      onChange();
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  };

  const preview = (kind: "work" | "expense") =>
    openHtml("/api/internal/claims/preview", { member_email: m.email, period, kind, lines: kind === "work" ? lines : undefined }).then(
      () => setPreviewed((p) => ({ ...p, [kind]: true })),
      (e) => setFlash({ kind: "error", text: errorMessage(e) }),
    );

  const setNoExpense = async (none: boolean) => {
    try {
      await api("/api/internal/no-expense", { body: { member_email: m.email, period, none } });
      onChange();
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e) });
    }
  };

  const setLine = (i: number, patch: Partial<WorkLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pendingTotal = row.pending_items.reduce((s, i) => s + Number(i.amount), 0);
  const mismatches = row.pending_items.filter((i) => i.match === "mismatch").length;
  const needPreview = (kind: "work" | "expense") =>
    !previewed[kind] && <span className="small muted">先に「プレビューで金額を確認」を押すと、発行できます</span>;

  return (
    <section className="panel">
      <div className="between">
        <div>
          <h2>
            {m.display_name} {st.done ? <span className="status status-done">✓ 請求書の発行は済み</span> : <span className="status status-warn">まだのことがあります</span>}
          </h2>
          <div className="row small">
            <span className="muted">
              合計 <strong className="claim-total">{yen((row.work ? Number(row.work.total) : subtotal + tax) + (row.expense ? Number(row.expense.total) : pendingTotal))}</strong>
              {!row.work || !row.expense ? "（未発行の分は見込み）" : ""}
            </span>
          </div>
        </div>
        <MemberSettings member={m} onChange={onChange} />
      </div>
      {readOnly && user.role !== "viewer" && <p className="muted small">この方の請求・経費を変えられるのは、本人と管理者だけです（見ることはできます）。</p>}
      {!m.bank_text && <p className="notice notice-warn small">振込先が未登録です。「振込先・既定の品目」から登録してください（請求書に載ります）。</p>}

      <div className="step">
        <StepHead no={1} done={st.work}>
          稼働分の請求書を発行
        </StepHead>
        {row.work ? (
          <ClaimBox claim={row.work} owner={m.email} onChange={onChange} setFlash={setFlash} />
        ) : (
          <>
            <p className="muted small">内容を確認 → 「プレビューで金額を確認」→ 金額が合っていれば赤い「発行する」。PDF が Google Drive に入ります。</p>
            <div className="table-scroll">
              <table className="simple-table line-table">
                <thead>
                  <tr>
                    <th>品目</th>
                    <th>数量</th>
                    <th>単価（税抜）</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td data-label="品目">
                        <input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} disabled={readOnly} />
                      </td>
                      <td data-label="数量">
                        <input type="number" min={1} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} style={{ width: 60 }} disabled={readOnly} />
                      </td>
                      <td data-label="単価（税抜）">
                        <input type="number" min={0} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} style={{ width: 120 }} disabled={readOnly} />
                      </td>
                      <td data-label="">
                        {!readOnly && lines.length > 1 && (
                          <button className="btn btn-small btn-danger-ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                            削除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">
              {!readOnly && (
                <button className="btn btn-small" onClick={() => setLines((ls) => [...ls, { name: "", qty: 1, unit_price: 0 }])}>
                  ＋ 行を追加
                </button>
              )}{" "}
              小計 {yen(subtotal)} ／ 消費税 {yen(tax)} ／ <strong>合計 {yen(subtotal + tax)}</strong>
            </p>
            <div className="row wrap">
              <button className="btn btn-small" onClick={() => preview("work")}>
                プレビューで金額を確認
              </button>
              {!readOnly && (
                <>
                  <button className="btn btn-must" disabled={busy !== "" || subtotal <= 0 || !previewed.work} onClick={() => submit("work")}>
                    {busy === "work" ? "発行中…" : `${yen(subtotal + tax)} で発行する`}
                  </button>
                  {needPreview("work")}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="step">
        <StepHead no={2} done={st.expense_done}>
          立替経費の請求書を発行
        </StepHead>
        {row.expense ? (
          <>
            <ClaimBox claim={row.expense} owner={m.email} onChange={onChange} setFlash={setFlash} />
            {row.claimed_items.length > 0 && <ItemTable items={row.claimed_items} member={m} readOnly onChange={onChange} setFlash={setFlash} />}
          </>
        ) : st.no_expense && row.pending_items.length === 0 ? (
          <p className="small">
            <span className="status status-done">✓ 今月は立替経費なし</span>{" "}
            {!readOnly && (
              <button className="btn btn-small btn-danger-ghost" onClick={() => setNoExpense(false)}>
                取り消す
              </button>
            )}
          </p>
        ) : (
          <>
            <p className="muted small">
              領収書を登録（上の「立替経費をまとめて登録」か、下の「経費を追加」）→「プレビューで金額を確認」→ 赤い「発行する」。発行すると、請求書と領収書の写真が Google Drive に入ります。写真は少しずつ保存するので、画面を閉じると全部そろうまで数時間（5〜6時間）かかることがあります。
            </p>
            {row.pending_items.length > 0 ? (
              <ItemTable items={row.pending_items} member={m} readOnly={readOnly} onChange={onChange} setFlash={setFlash} />
            ) : (
              <p className="muted small">未請求の立替経費はありません。</p>
            )}
            {!readOnly && <AddExpense member={m} onChange={onChange} setFlash={setFlash} />}
            {!readOnly && row.pending_items.length === 0 && (
              <p>
                <button className="btn btn-small" onClick={() => setNoExpense(true)}>
                  今月は立替経費なし
                </button>
              </p>
            )}
            {row.pending_items.length > 0 && (
              <div className="row wrap">
                <span className="small">
                  合計 <strong>{yen(pendingTotal)}</strong>（{row.pending_items.length}件）
                  {mismatches > 0 && <span className="error"> 領収書と金額が一致しない明細が {mismatches} 件あります</span>}
                </span>
                <button className="btn btn-small" onClick={() => preview("expense")}>
                  プレビューで金額を確認
                </button>
                {!readOnly && (
                  <>
                    <button className="btn btn-must" disabled={busy !== "" || mismatches > 0 || !previewed.expense} onClick={() => submit("expense")}>
                      {busy === "expense" ? "発行中…" : `${yen(pendingTotal)} で発行する`}
                    </button>
                    {needPreview("expense")}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {row.expense && (
        <div className="step">
          <StepHead no={3} done={st.drive_pending === 0}>
            領収書の写真を Google Drive に保存（自動）
          </StepHead>
          <p className="small">
            {st.drive_pending ? (
              <>
                <span className="status status-warn">残り {st.drive_pending} 枚を保存中</span>{" "}
                <span className="muted">1時間ごとに自動で続きを保存します（全部そろうまで数時間かかることがあります）。押すボタンはありません。</span>
              </>
            ) : (
              <span className="muted">すべて「立替領収書」フォルダに保存しました。</span>
            )}
          </p>
        </div>
      )}
      {row.expense && (
        <div className="step">
          <StepHead no={4} done={st.originals_pending === 0}>
            領収書の原本を{payerName}さんに渡す（期限なし）
          </StepHead>
          <p className="muted small">
            {st.originals_pending
              ? `まだ ${st.originals_pending} 枚。次に会うときにまとめて渡し、下の「領収書の原本」で${m.display_name.slice(0, 2)}さんの分をまとめてチェックしてください。`
              : "この月の領収書の原本はすべて渡しました。"}
          </p>
        </div>
      )}
    </section>
  );
}

const MATCH = {
  ok: <span className="pill pill-ok">一致</span>,
  mismatch: <span className="pill pill-error">金額不一致</span>,
  no_receipt: <span className="pill pill-warn">領収書なし</span>,
};

function ItemTable({ items, member, readOnly, onChange, setFlash }: { items: ExpenseItem[]; member: Member; readOnly: boolean; onChange: () => void; setFlash: (f: Flash) => void }) {
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e) });
    }
  };
  const attach = (item: ExpenseItem, file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    form.set("member_email", member.email);
    form.set("amount", String(item.amount));
    form.set("paid_on", item.spent_on);
    act(async () => {
      const r = await postForm<{ id: string }>("/api/internal/receipts", form);
      await api(`/api/internal/expenses/${item.id}`, { method: "PATCH", body: { receipt_id: r.id } });
    });
  };
  return (
    <div className="table-scroll">
      <table className="simple-table line-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>用途</th>
            <th>金額</th>
            <th>領収書</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td data-label="日付" className="small">{i.spent_on.replace(/-/g, "/")}</td>
              <td data-label="用途">{i.purpose}</td>
              <td data-label="金額">
                {readOnly ? (
                  yen(i.amount)
                ) : (
                  <input
                    type="number"
                    defaultValue={i.amount}
                    style={{ width: 100 }}
                    onBlur={(e) => Number(e.target.value) !== i.amount && act(() => api(`/api/internal/expenses/${i.id}`, { method: "PATCH", body: { amount: Number(e.target.value) } }))}
                  />
                )}
              </td>
              <td data-label="領収書" className="small">
                {i.receipt_id ? (
                  <>
                    <a href={`/api/internal/receipts/${i.receipt_id}/file`} target="_blank" rel="noreferrer">
                      {i.receipt_name}
                    </a>{" "}
                    {yen(i.receipt_amount)} {i.match && MATCH[i.match]}
                  </>
                ) : readOnly ? (
                  i.match && MATCH[i.match]
                ) : (
                  <label className="link-button">
                    領収書を添付
                    <input type="file" accept="image/jpeg,image/png,image/heic,application/pdf" hidden onChange={(e) => attach(i, e.target.files?.[0])} />
                  </label>
                )}
              </td>
              {!readOnly && (
                <td data-label="">
                  <button className="btn btn-small btn-danger-ghost" onClick={() => confirm("この明細を削除しますか？") && act(() => api(`/api/internal/expenses/${i.id}`, { method: "DELETE" }))}>
                    削除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddExpense({ member, onChange, setFlash }: { member: Member; onChange: () => void; setFlash: (f: Flash) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ spent_on: today(), purpose: "", amount: "", vendor: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <p>
        <button className="btn btn-small" onClick={() => setOpen(true)}>
          ＋ 経費を追加（領収書つき）
        </button>
      </p>
    );
  const save = async () => {
    setBusy(true);
    try {
      if (file) {
        const f = new FormData();
        f.set("file", file);
        f.set("member_email", member.email);
        f.set("amount", form.amount);
        f.set("paid_on", form.spent_on);
        f.set("vendor", form.vendor);
        f.set("purpose", form.purpose);
        if (!form.purpose.trim()) throw new Error("用途を入力してください");
        await postForm("/api/internal/receipts", f);
      } else {
        await api("/api/internal/expenses", { body: { member_email: member.email, spent_on: form.spent_on, purpose: form.purpose, amount: Number(form.amount) } });
      }
      setForm({ spent_on: today(), purpose: "", amount: "", vendor: "" });
      setFile(null);
      setOpen(false);
      onChange();
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel panel-info">
      <div className="grid-2">
        <label className="stack">
          <span>日付（領収書の日付）</span>
          <input type="date" min="2026-09-01" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} />
        </label>
        <label className="stack">
          <span>金額（領収書のとおり1円単位）</span>
          <input type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </label>
        <label className="stack">
          <span>用途</span>
          <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="例: サンプル自動車様訪問 交通費" />
        </label>
        <label className="stack">
          <span>支払先（任意）</span>
          <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="例: JR東日本" />
        </label>
      </div>
      <label className="stack">
        <span>領収書（写真・JPG・PNG・PDF）</span>
        <input type="file" accept="image/jpeg,image/png,image/heic,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className="actions">
        <button className="btn" onClick={() => setOpen(false)}>
          キャンセル
        </button>
        <button className="btn btn-primary" disabled={busy || !form.purpose.trim() || !(Number(form.amount) > 0)} onClick={save}>
          {file ? "追加" : "領収書なしで追加（あとで添付できます）"}
        </button>
      </div>
    </div>
  );
}

function MemberSettings({ member, onChange }: { member: Member; onChange: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(member);
  const [error, setError] = useState("");
  // 振込先を変えられるのは本人と管理者だけ（サーバー側でも同じ制限）
  if (user.role === "viewer" || (user.role !== "admin" && user.email !== member.email)) return null;
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        振込先・既定の品目
      </button>
    );
  const save = async () => {
    try {
      await api(`/api/internal/members/${encodeURIComponent(member.email)}`, {
        method: "PATCH",
        body: { bank_text: form.bank_text, default_item: form.default_item, default_unit_price: Number(form.default_unit_price) },
      });
      setOpen(false);
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="panel panel-info member-settings">
      <label className="stack">
        <span>振込先（請求書に載ります）</span>
        <input value={form.bank_text} onChange={(e) => setForm({ ...form, bank_text: e.target.value })} placeholder="例: ○○銀行 ○○支店 普通 1234567 サンプル タロウ" />
      </label>
      <label className="stack">
        <span>稼働分の既定の品目（{"{M}"} は月に置き換わります）</span>
        <input value={form.default_item} onChange={(e) => setForm({ ...form, default_item: e.target.value })} />
      </label>
      <label className="stack">
        <span>既定の単価（税抜・円）</span>
        <input type="number" min={0} value={form.default_unit_price} onChange={(e) => setForm({ ...form, default_unit_price: Number(e.target.value) })} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={() => setOpen(false)}>
          キャンセル
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}

function ReceiptOriginals({ members, onChange }: { members: Member[]; onChange: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [error, setError] = useState("");
  const [who, setWho] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ receipts: Receipt[] }>("/api/internal/receipts").then((r) => setReceipts(r.receipts), () => setReceipts([]));
  }, []);
  useEffect(load, [load]);
  const name = (email: string) => members.find((m) => m.email === email)?.display_name ?? email;
  const mark = async (r: Receipt, submitted: boolean) => {
    try {
      await api(`/api/internal/receipts/${r.id}/original`, { body: { submitted } });
      load();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  /** まとめて原本提出済みにする（間違えたときのために「元に戻す」を出す） */
  const markMany = async (ids: string[], submitted: boolean, undo = true) => {
    if (!ids.length) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ updated: number; skipped: number }>("/api/internal/receipts/original-bulk", { body: { ids, submitted } });
      setSelected(new Set());
      toast(`${r.updated} 件を${submitted ? "原本提出済みにしました" : "未提出に戻しました"}${r.skipped ? `（${r.skipped} 件は本人か管理者だけが変更できるため飛ばしました）` : ""}`, {
        action: undo && r.updated ? { label: "元に戻す", onClick: () => markMany(ids, !submitted, false) } : undefined,
      });
      load();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = (receipts ?? []).filter((r) => !who || r.member_email === who);
  // まとめて選べるのは、まだ原本が出ていなくて、自分がチェックできるもの
  const selectable = shown.filter((r) => !r.original_submitted_at && selfOrAdmin(user, r.member_email));
  const pending = receipts?.filter((r) => !r.original_submitted_at).length ?? 0;
  const owners = [...new Set((receipts ?? []).map((r) => r.member_email))];
  /** その人の、まだ原本が出ていなくて自分がチェックできる領収書 */
  const byOwner = (email: string) => (receipts ?? []).filter((r) => r.member_email === email && !r.original_submitted_at && selfOrAdmin(user, r.member_email)).map((r) => r.id);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <section className="panel">
      <h2>
        領収書の原本 {pending > 0 && <span className="pill pill-warn">未提出 {pending}件</span>}
      </h2>
      <p className="muted small">原本は期限なしで、次に会うときに人ごとにまとめて渡します。渡したら、その人の「まとめて原本提出済みにする」を押してください（1枚ずつなら右のチェック）。間違えたら「元に戻す」で戻せます。</p>
      {error && <p className="error">{error}</p>}
      {receipts === null ? (
        <p className="muted">読み込み中…</p>
      ) : receipts.length === 0 ? (
        <p className="muted small">領収書はまだありません。</p>
      ) : (
        <>
          {owners.some((e) => byOwner(e).length) && (
            <div className="row wrap">
              {owners.map((e) => {
                const ids = byOwner(e);
                return (
                  ids.length > 0 && (
                    <button key={e} className="btn btn-primary btn-small" disabled={busy} onClick={() => confirm(`${name(e)}さんの未提出 ${ids.length} 枚を、原本提出済みにします。よろしいですか？`) && markMany(ids, true)}>
                      {name(e)}さんの未提出 {ids.length} 枚をまとめて原本提出済みにする
                    </button>
                  )
                );
              })}
            </div>
          )}
          <div className="bulk-bar row wrap">
            {owners.length > 1 && (
              <select value={who} onChange={(e) => (setWho(e.target.value), setSelected(new Set()))} aria-label="提出者で絞り込む" style={{ width: "auto" }}>
                <option value="">全員</option>
                {owners.map((e) => (
                  <option key={e} value={e}>
                    {name(e)}
                  </option>
                ))}
              </select>
            )}
            <label className="check-line">
              <input
                type="checkbox"
                disabled={!selectable.length || busy}
                checked={selectable.length > 0 && selectable.every((r) => selected.has(r.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
              />
              未提出をすべて選択（{selectable.length} 件）
            </label>
            <button className="btn btn-primary btn-small" disabled={!selected.size || busy} onClick={() => markMany([...selected], true)}>
              選択した {selected.size} 件を原本提出済みにする
            </button>
          </div>
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>選択</th>
                  <th>提出者</th>
                  <th>日付</th>
                  <th>支払先・ファイル</th>
                  <th>金額</th>
                  <th>原本</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const canEdit = selfOrAdmin(user, r.member_email);
                  return (
                    <tr key={r.id}>
                      <td>
                        {!r.original_submitted_at && canEdit && (
                          <input type="checkbox" aria-label={`${r.paid_on} ${r.vendor} を選択`} disabled={busy} checked={selected.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                        )}
                      </td>
                      <td>{name(r.member_email)}</td>
                      <td className="small">{r.paid_on.replace(/-/g, "/")}</td>
                      <td className="small">
                        {r.vendor && `${r.vendor} ・ `}
                        <a href={`/api/internal/receipts/${r.id}/file`} target="_blank" rel="noreferrer">
                          {r.file_name}
                        </a>
                      </td>
                      <td>{yen(r.amount)}</td>
                      <td>
                        <label className="check-line">
                          <input type="checkbox" disabled={!canEdit || busy} title={canEdit ? undefined : "本人と管理者がチェックします"} checked={Boolean(r.original_submitted_at)} onChange={(e) => mark(r, e.target.checked)} />
                          <span className="small">{r.original_submitted_at ? `原本提出済み（${fmtDateTime(r.original_submitted_at)} ${r.checked_by_name ?? ""}）` : "原本提出済み"}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
