import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../lib/format";
import type { Company } from "../types";

export function CompaniesPage() {
  const { features } = useAuth();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"name" | "count" | "recent">("name");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ companies: Company[] }>("/api/companies").then((r) => setCompanies(r.companies), (e) => setError(errorMessage(e)));
  }, []);

  const shown = (companies ?? [])
    .filter((c) => !filter || c.company_name.normalize("NFKC").toLowerCase().includes(filter.normalize("NFKC").toLowerCase()))
    .sort((a, b) =>
      sort === "count" ? b.count - a.count : sort === "recent" ? b.last_created_at.localeCompare(a.last_created_at) : a.company_key.localeCompare(b.company_key, "ja"),
    );

  return (
    <div className="page">
      <h1>会社</h1>
      <div className="toolbar">
        <input className="search" type="search" placeholder="会社名で絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="並び順">
          <option value="name">会社名順</option>
          <option value="count">人数が多い順</option>
          <option value="recent">最近登録した順</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {companies === null ? (
        <p className="muted">読み込み中…</p>
      ) : shown.length === 0 ? (
        <div className="empty">会社がありません。</div>
      ) : (
        <ul className="company-grid">
          {shown.map((c) => (
            <li key={c.company_key}>
              <Link to={`/company?key=${encodeURIComponent(c.company_key)}`} className="company-card">
                <span className="company-name">{c.company_name || "（会社名なし）"}</span>
                <span className="muted small">
                  {c.count}名 ・ 最終登録 {fmtDate(c.last_created_at)}
                </span>
              </Link>
              {features.graph && (
                <Link to={`/map?center=${encodeURIComponent(`company:${c.company_key}`)}`} className="small map-link">
                  つながりを見る →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
