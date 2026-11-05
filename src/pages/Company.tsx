import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../lib/format";
import { OrgChart } from "../components/OrgChart";

type Row = Record<string, string | number | null>;
interface CompanyData {
  company_key: string;
  company_name: string;
  people: Row[];
  deals: Row[];
  decisions: Row[];
  contracts: Row[];
  recent_invoices: Row[];
  open_tasks: Row[];
  recent_interactions: Row[];
}

const yen = (n: unknown) => `¥${Number(n).toLocaleString("ja-JP")}`;

/** 会社の詳細: この会社に関することを1画面に集める */
const INVOICE_STATUS: Record<string, string> = { draft: "下書き", created: "作成済み", sent: "送付済み", contacted: "連絡済み" };

export function CompanyPage() {
  const { features } = useAuth();
  const [params] = useSearchParams();
  const key = params.get("key") ?? "";
  const [data, setData] = useState<CompanyData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    api<CompanyData>(`/api/company?key=${encodeURIComponent(key)}`).then(setData, (e) => setError(errorMessage(e)));
  }, [key]);

  if (!data) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">読み込み中…</p>}</div>;

  return (
    <div className="page">
      <p>
        <Link className="back-link" to="/companies">‹ 会社一覧</Link>
      </p>
      <div className="page-head">
        <h1>{data.company_name}</h1>
        <Link className="btn" to={`/people?company=${encodeURIComponent(data.company_key)}`}>
          この会社の人物情報を出力
        </Link>
        {features.graph && (
          <Link className="btn" to={`/map?center=${encodeURIComponent(`company:${data.company_key}`)}`}>
            つながりを見る
          </Link>
        )}
      </div>

      <OrgChart companyKey={data.company_key} companyName={data.company_name} />

      <div className="company-layout">
        <div>
          <div className="panel">
            <h2>人物（{data.people.length}名）</h2>
            <ul className="plain-list">
              {data.people.map((p) => (
                <li key={String(p.id)}>
                  <Link to={`/cards/${p.id}`}>{p.person_name}</Link>
                  <span className="muted small"> {[p.department, p.title].filter(Boolean).join(" ・ ")}</span>
                  {p.email && <div className="small muted">{p.email}</div>}
                </li>
              ))}
            </ul>
          </div>
          {data.recent_interactions.length > 0 && (
            <div className="panel">
              <h2>最近のやり取り</h2>
              <ul className="plain-list">
                {data.recent_interactions.map((i, n) => (
                  <li key={n}>
                    <span className="muted small">{fmtDate(String(i.happened_on ?? i.created_at))}</span> <Link to={`/cards/${i.card_id}`}>{i.person_name}</Link> {i.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.decisions.length > 0 && (
            <div className="panel">
              <h2>決定事項（議事録より）</h2>
              <ul className="plain-list">
                {data.decisions.map((d, n) => (
                  <li key={n}>
                    {d.text}{" "}
                    <Link to={`/minutes/${d.document_id}`} className="small">
                      {d.document_title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          {data.open_tasks.length > 0 && (
            <div className="panel">
              <h2>未完了のタスク</h2>
              <ul className="plain-list">
                {data.open_tasks.map((t) => (
                  <li key={String(t.id)}>
                    {t.title}
                    <span className="muted small">
                      （{t.assignee || t.assignee_name || "担当未定"}
                      {t.due_on && ` ・ ${fmtDate(String(t.due_on))}まで`}）
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.deals.length > 0 && (
            <div className="panel">
              <h2>案件</h2>
              <ul className="plain-list">
                {data.deals.map((d) => (
                  <li key={String(d.id)}>
                    {d.name} <span className="pill">{d.status || "—"}</span>
                    {d.amount && <span className="muted small"> {d.amount}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.contracts.length > 0 && (
            <div className="panel">
              <h2>契約・請求</h2>
              <ul className="plain-list">
                {data.contracts.map((c) => (
                  <li key={String(c.id)}>
                    {c.title} {yen(c.amount)}
                    <span className="muted small"> {c.status === "active" ? "有効" : "終了"}</span>
                  </li>
                ))}
              </ul>
              {data.recent_invoices.length > 0 && (
                <ul className="plain-list small">
                  {data.recent_invoices.slice(0, 6).map((i) => (
                    <li key={String(i.id)}>
                      {String(i.period).replace("-", "/")} {yen(Number(i.amount))}{" "}
                      <span className={`pill ${i.status === "contacted" ? "pill-ok" : "pill-warn"}`}>{INVOICE_STATUS[String(i.status)] ?? i.status}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="small">
                <Link to="/billing">顧客請求へ</Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
