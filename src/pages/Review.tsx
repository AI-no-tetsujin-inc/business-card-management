import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { FIELD_LABEL, type FieldKey } from "../../shared/fields";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/format";

interface ReviewItem {
  id: string;
  kind: "merge" | "new_person" | "fix";
  card_id: string | null;
  other_card_id: string | null;
  card_name: string | null;
  card_company: string | null;
  other_name: string | null;
  other_company: string | null;
  document_id: string | null;
  document_title: string | null;
  reason: string;
  confidence: number | null;
  suggestion: string;
  created_at: string;
}

const KIND: Record<ReviewItem["kind"], string> = { merge: "統合候補", new_person: "新しい人物の候補", fix: "データの誤りの疑い" };

export function ReviewPage() {
  const { user, refreshPending } = useAuth();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [message, setMessage] = useState("");
  const readOnly = user.role === "viewer";

  const load = useCallback(() => {
    api<{ items: ReviewItem[] }>("/api/review").then((r) => setItems(r.items), (e) => setMessage(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const resolve = async (item: ReviewItem, body: { approve: boolean; mode?: "new" | "existing" }) => {
    try {
      const r = await api<{ message: string }>(`/api/review/${item.id}`, { body });
      setMessage(r.message);
      load();
      refreshPending();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <h1>確認依頼</h1>
      <p className="muted small">AI が「人の確認が必要」と判断したものだけが並びます。確信度が高いものは自動で処理済みです。</p>
      {message && <p className="notice">{message}</p>}
      {items === null ? (
        <p className="muted">読み込み中…</p>
      ) : items.length === 0 ? (
        <div className="empty">確認依頼はありません。</div>
      ) : (
        <ul className="list">
          {items.map((it) => {
            const s = JSON.parse(it.suggestion || "{}");
            return (
              <li key={it.id} className="panel review-item">
                <div className="row between">
                  <span className="pill pill-warn">{KIND[it.kind]}</span>
                  <span className="muted small">
                    {it.confidence !== null && `確信度 ${Math.round(it.confidence * 100)}% ・ `}
                    {fmtDateTime(it.created_at)}
                  </span>
                </div>
                <p>{it.reason}</p>
                {it.kind === "merge" && (
                  <p className="small">
                    <Link to={`/cards/${it.card_id}`}>
                      {it.card_name}（{it.card_company}）
                    </Link>
                    {" と "}
                    <Link to={`/cards/${it.other_card_id}`}>
                      {it.other_name}（{it.other_company}）
                    </Link>
                  </p>
                )}
                {it.kind === "fix" && (
                  <>
                    <p className="small">
                      対象: <Link to={`/cards/${it.card_id}`}>{it.card_name}（{it.card_company}）</Link>
                    </p>
                    {Object.keys(s).length > 0 && (
                      <ul className="small">
                        {Object.entries(s).map(([k, v]) => (
                          <li key={k}>
                            {FIELD_LABEL[k as FieldKey] ?? k} → 「{String(v)}」
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {it.kind === "new_person" && (
                  <>
                    <p className="small">
                      {s.fields?.person_name}（{s.fields?.company_name || "会社不明"}）
                      {it.document_title && (
                        <>
                          {" ・ 議事録 "}
                          <Link to={`/minutes/${it.document_id}`}>{it.document_title}</Link>
                        </>
                      )}
                    </p>
                    {s.evidence && <p className="small muted">「{s.evidence}」</p>}
                    {it.card_id && (
                      <p className="small">
                        似た人物: <Link to={`/cards/${it.card_id}`}>{it.card_name}（{it.card_company}）</Link>
                      </p>
                    )}
                  </>
                )}
                {!readOnly && (
                  <div className="row">
                    {it.kind === "merge" && (
                      <>
                        <button className="btn btn-primary btn-small" onClick={() => resolve(it, { approve: true })}>
                          同じ人なので統合する
                        </button>
                        <button className="btn btn-small" onClick={() => resolve(it, { approve: false })}>
                          別人
                        </button>
                      </>
                    )}
                    {it.kind === "fix" && (
                      <>
                        {Object.keys(s).length > 0 && (
                          <button className="btn btn-primary btn-small" onClick={() => resolve(it, { approve: true })}>
                            修正案どおりに直す
                          </button>
                        )}
                        <button className="btn btn-small" onClick={() => resolve(it, { approve: false })}>
                          問題なし
                        </button>
                      </>
                    )}
                    {it.kind === "new_person" && (
                      <>
                        {it.card_id && (
                          <button className="btn btn-primary btn-small" onClick={() => resolve(it, { approve: true, mode: "existing" })}>
                            似た人物と同じ
                          </button>
                        )}
                        <button className="btn btn-small" onClick={() => resolve(it, { approve: false })}>
                          登録しない
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
