// 確認待ち: 撮影した名刺をあとから落ち着いて確認・登録する。問題のないものは選んでまとめて登録できる
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { REVIEW_COUNT_KEY } from "./DraftReview";
import { MATCH_LABEL } from "../../shared/fields";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Thumb } from "../components/CardImage";
import { SkeletonList, useToast } from "../components/ui";
import { fmtDateTime } from "../lib/format";
import type { DraftSummary } from "../types";

type State = DraftSummary["state"];
const STATE: Record<State, { label: string; cls: string }> = {
  reading: { label: "読み取り中", cls: "status" },
  ready: { label: "確認可能", cls: "status status-done" },
  flagged: { label: "要確認", cls: "status status-warn" },
  duplicate: { label: "重複候補", cls: "status status-todo" },
  failed: { label: "読み取り失敗", cls: "status status-error" },
};
const FILTERS: { key: string; label: string; test: (d: DraftSummary) => boolean }[] = [
  { key: "", label: "すべて", test: () => true },
  { key: "ready", label: "確認可能", test: (d) => d.state === "ready" },
  { key: "flagged", label: "要確認", test: (d) => d.state === "flagged" },
  { key: "duplicate", label: "重複候補", test: (d) => d.state === "duplicate" },
  { key: "failed", label: "読み取り失敗", test: (d) => d.state === "failed" },
  { key: "reading", label: "読み取り中", test: (d) => d.state === "reading" },
  { key: "deferred", label: "あとで確認", test: (d) => d.deferred },
];

/** 一括登録できない理由（なければ空） */
const blockReason = (d: DraftSummary) =>
  d.state === "reading" ? "読み取りが終わっていません" : d.state === "failed" ? "読み取りに失敗しています" : d.state === "flagged" ? "要確認の項目があります" : d.state === "duplicate" ? "重複候補があります" : "";

interface BulkResult {
  committed: number;
  failed: string[];
  skipped: { id: string; reason: string }[];
}

export function DraftsPage() {
  const { refreshPending, user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filter = params.get("state") ?? "";
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const canWrite = user.role !== "viewer";
  const location = useLocation();
  const [finished, setFinished] = useState(Boolean((location.state as { finished?: boolean } | null)?.finished));
  const registered = (() => {
    try {
      return Number(sessionStorage.getItem(REVIEW_COUNT_KEY) ?? 0);
    } catch {
      return 0;
    }
  })();

  const load = useCallback(() => {
    api<{ drafts: DraftSummary[] }>("/api/drafts").then(
      (r) => {
        setDrafts(r.drafts);
        setError("");
        // 一覧から消えたもの（登録済みなど）は選択から外す
        setSelected((s) => new Set([...s].filter((id) => r.drafts.some((d) => d.id === id && !blockReason(d)))));
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);
  // 読み取り中のものがあれば、終わるまで数秒ごとに更新する
  useEffect(() => {
    if (!drafts?.some((d) => d.state === "reading")) return;
    const t = setTimeout(() => {
      load();
      refreshPending();
    }, 4000);
    return () => clearTimeout(t);
  }, [drafts, load, refreshPending]);

  const shown = useMemo(() => (drafts ?? []).filter(FILTERS.find((f) => f.key === filter)?.test ?? (() => true)), [drafts, filter]);
  const committable = (drafts ?? []).filter((d) => !blockReason(d));
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, (drafts ?? []).filter(f.test).length]));

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const bulkCommit = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ results: { id: string; result: string; reason?: string }[] }>("/api/drafts/bulk-commit", { body: { ids } });
      const res: BulkResult = {
        committed: r.results.filter((x) => x.result === "committed" || x.result === "already").length,
        failed: r.results.filter((x) => x.result === "failed").map((x) => x.id),
        skipped: r.results.filter((x) => x.result === "skipped").map((x) => ({ id: x.id, reason: x.reason ?? "" })),
      };
      setResult(res);
      toast(`${res.committed} 件を登録しました`);
    } catch (e) {
      // 通信が切れても、サーバーで登録済みのものは次の読み込みで一覧から消える（再実行しても二重にならない）
      toast(`${errorMessage(e)}（もう一度押しても二重に登録されません）`, { kind: "error" });
    } finally {
      setBusy(false);
      load();
      refreshPending();
    }
  };

  const remainingAfter = drafts?.length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>確認待ち</h1>
        {canWrite && (
          <Link className="btn" to="/upload">
            ＋ 撮影する
          </Link>
        )}
      </div>

      {/* 1件ずつの確認を最後まで進めたときの結果 */}
      {finished && drafts && (
        <div className="notice notice-ok" role="status">
          <p>
            <strong>確認できる名刺はこれで最後です。</strong> この端末で登録した名刺: <strong>{registered}</strong> 件
          </p>
          {drafts.length > 0 ? (
            <p className="small">
              残っている名刺: 要確認 {counts.flagged} 件 ・ 重複候補 {counts.duplicate} 件 ・ 読み取り失敗 {counts.failed} 件 ・ 読み取り中 {counts.reading} 件 ・ あとで確認 {counts.deferred} 件
            </p>
          ) : (
            <p className="small">確認待ちは残っていません。</p>
          )}
          <button
            className="link-button small"
            onClick={() => {
              try {
                sessionStorage.removeItem(REVIEW_COUNT_KEY);
              } catch {
                /* noop */
              }
              setFinished(false);
            }}
          >
            件数をリセット
          </button>
        </div>
      )}

      {result && (
        <div className={`notice ${result.failed.length ? "notice-warn" : "notice-ok"}`} role="status">
          <p>
            成功 <strong>{result.committed}</strong> 件 ・ 失敗 <strong>{result.failed.length}</strong> 件 ・ 確認待ち <strong>{remainingAfter}</strong> 件
            {result.skipped.length > 0 && `（${result.skipped.length} 件は状態が変わったため登録していません）`}
          </p>
          {result.failed.length > 0 && (
            <button className="btn btn-small" disabled={busy} onClick={() => bulkCommit(result.failed)}>
              失敗した {result.failed.length} 件だけ再試行
            </button>
          )}
        </div>
      )}

      {error ? (
        <div className="notice notice-error" role="alert">
          <p>確認待ちを読み込めませんでした（{error}）。</p>
          <button className="btn btn-small" onClick={load}>
            再読み込み
          </button>
        </div>
      ) : drafts === null ? (
        <SkeletonList rows={3} />
      ) : drafts.length === 0 ? (
        <div className="empty">
          <p>確認待ちの名刺はありません。</p>
          {canWrite && (
            <Link className="btn btn-primary btn-small" to="/upload">
              名刺を撮影する
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="filter-chips" role="group" aria-label="状態で絞り込む">
            {FILTERS.filter((f) => f.key === "" || counts[f.key] > 0).map((f) => (
              <button key={f.key} aria-pressed={filter === f.key} className={filter === f.key ? "active" : ""} onClick={() => setParams(f.key ? { state: f.key } : {}, { replace: true })}>
                {f.label} {counts[f.key]}
              </button>
            ))}
          </div>

          {canWrite && committable.length > 0 && (
            <div className="panel bulk-bar">
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={committable.every((d) => selected.has(d.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(committable.map((d) => d.id)) : new Set())}
                />
                登録可能な名刺をすべて選択（{committable.length} 件）
              </label>
              <button className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => bulkCommit([...selected])}>
                {busy ? "登録しています…" : `選択した ${selected.size} 件を登録`}
              </button>
              <p className="muted small">選んだ名刺は新しい名刺として登録します（既存の名刺は更新しません）。要確認・重複候補・読み取り失敗・読み取り中の名刺は、まとめて登録できません。1件ずつ開いて確認してください。</p>
            </div>
          )}

          <ul className="list draft-list">
            {shown.map((d) => {
              const reason = blockReason(d);
              return (
                <li key={d.id} className="list-row">
                  {canWrite && (
                    <input
                      type="checkbox"
                      className="row-check"
                      disabled={Boolean(reason) || busy}
                      aria-label={reason ? `${d.person_name || "名刺"}: ${reason}のため一括登録できません` : `${d.person_name || "名刺"} を選択`}
                      checked={selected.has(d.id)}
                      onChange={(e) => toggle(d.id, e.target.checked)}
                    />
                  )}
                  <Link to={`/drafts/${d.id}`} className="list-item">
                    <Thumb imageKey={d.front_display_key} alt="名刺" />
                    <div className="list-main">
                      <div className="list-title">{d.person_name || <span className="muted">{d.state === "reading" ? "（読み取り中）" : "（氏名なし）"}</span>}</div>
                      <div className="list-sub">{d.company_name}</div>
                      <div className="list-meta">
                        {d.created_by_name} ・ {fmtDateTime(d.created_at)}
                        {d.has_back ? " ・ 表裏" : " ・ 表のみ"}
                        {d.has_edits && " ・ 下書きあり"}
                      </div>
                      {d.state === "flagged" && <div className="draft-reason small">要確認: {d.flags.map((f) => f.label).join("・")}</div>}
                      {d.state === "duplicate" && (
                        <div className="draft-reason small">
                          重複候補: {d.duplicates.map((m) => `${m.person_name}（${m.company_name}）— ${MATCH_LABEL[m.match] ?? m.match}`).join("、")}
                        </div>
                      )}
                      {d.state === "failed" && <div className="draft-reason small error">{d.error}</div>}
                    </div>
                    <div className="list-badges">
                      <span className={STATE[d.state].cls}>{STATE[d.state].label}</span>
                      {d.deferred && <span className="status">あとで確認</span>}
                      {reason && d.state !== "reading" && <span className="small link-like">確認する →</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && <div className="empty">この状態の名刺はありません。</div>}
        </>
      )}
    </div>
  );
}
