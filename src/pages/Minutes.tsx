import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDate, fmtDateTime } from "../lib/format";
import { CopyButton, useToast } from "../components/ui";
import { VoissRecorder } from "../components/VoissRecorder";

interface Doc {
  id: string;
  title: string;
  drive_file_id: string;
  source: "voiss" | "paste" | "drive";
  recorder_name: string | null;
  started_at: string | null;
  duration_sec: number | null;
  meeting_date: string | null;
  summary: string;
  status: "pending" | "processing" | "done" | "failed" | "skipped";
  error: string | null;
  stats: string;
  created_at: string;
  processed_at: string | null;
  task_count: number;
  review_count: number;
}

const STATUS: Record<Doc["status"], [string, string]> = {
  pending: ["待機中", ""],
  processing: ["取り込み中", "pill-info"],
  done: ["完了", "pill-ok"],
  failed: ["失敗", "pill-error"],
  skipped: ["対象外", ""],
};

const SOURCE: Record<Doc["source"], string> = { voiss: "Voiss", paste: "貼り付け", drive: "Drive" };

function durationLabel(sec: number) {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const min = Math.round(sec / 60);
  const h = Math.floor(min / 60);
  return h ? `${h}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`;
}

/** 例: 2026/10/22 14:05（1時間5分） */
function whenText(d: Pick<Doc, "started_at" | "duration_sec" | "meeting_date">) {
  if (d.started_at) return `${fmtDateTime(d.started_at)}${d.duration_sec ? `（${durationLabel(d.duration_sec)}）` : ""}`;
  return d.meeting_date ? fmtDate(d.meeting_date) : "";
}

export function MinutesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ documents: Doc[] }>("/api/minutes").then((r) => setDocs(r.documents), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000); // 取り込み中の状態を更新
    return () => clearInterval(t);
  }, [load]);

  const submit = async () => {
    setError("");
    try {
      const r = await api<{ id: string }>("/api/minutes/import", { body: { title, text } });
      navigate(`/minutes/${r.id}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>議事録</h1>
        {user.role !== "viewer" && (
          <button className="btn" onClick={() => setShowImport(!showImport)}>
            ＋ 貼り付けて取り込む
          </button>
        )}
      </div>
      <p className="muted small">
        下の「録音開始」で Mac の Voiss が録音し、止めると文字起こししてここに届きます。文字起こしの全文と音声を Google Drive の「議事録」フォルダに保存し、Google Chat の議事録スペースに知らせます。ネクストアクション（タスク）だけは Claude が抜き出します。
      </p>
      {user.role !== "viewer" && <VoissRecorder onArrived={load} />}
      {showImport && (
        <div className="panel">
          <label className="stack">
            <span>タイトル</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 10/15 サンプル商事 定例" />
          </label>
          <label className="stack">
            <span>本文（議事録・文字起こし）</span>
            <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => setShowImport(false)}>
              キャンセル
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={!title.trim() || !text.trim()}>
              取り込む
            </button>
          </div>
        </div>
      )}
      {docs === null ? (
        <p className="muted">読み込み中…</p>
      ) : docs.length === 0 ? (
        <div className="empty">まだ議事録はありません。</div>
      ) : (
        <ul className="list">
          {docs.map((d) => (
            <li key={d.id}>
              <Link to={`/minutes/${d.id}`} className="list-item">
                <div className="list-main">
                  <div className="list-title">{d.title}</div>
                  <div className="list-sub">{d.summary || d.error || ""}</div>
                  <div className="list-meta">
                    {[whenText(d) || `取り込み ${fmtDateTime(d.processed_at ?? d.created_at)}`, d.recorder_name ? `録音 ${d.recorder_name}` : "", SOURCE[d.source] ?? ""]
                      .filter(Boolean)
                      .join(" ・ ")}
                  </div>
                </div>
                <div className="list-badges">
                  <span className={`pill ${STATUS[d.status][1]}`}>
              {(d.status === "processing" || d.status === "pending") && <span className="spinner spinner-small" aria-hidden="true" />}
              {STATUS[d.status][0]}
            </span>
                  {d.task_count > 0 && <span className="pill">次の動き {d.task_count}</span>}
                  {d.review_count > 0 && <span className="pill pill-warn">確認待ち {d.review_count}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface MinutesDetail {
  document: Doc & { drive_url: string | null; audio_pending: boolean; drive_audio_id: string | null };
  decisions: { id: string; text: string; company_name: string }[];
  tasks: { id: string; title: string; assignee: string | null; assignee_name: string; due_on: string | null; status: string }[];
  people: { id: string; card_id: string; person_name: string; company_name: string; summary: string }[];
  deals: { id: string; company_name: string; name: string; status: string; amount: string }[];
}

export function MinutesDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<MinutesDetail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<MinutesDetail>(`/api/minutes/${id}`).then(setData, (e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);
  // 取り込み中だけ5秒ごとに読み直す（読み直すたびに data が変わるので、data そのものには依存しない）
  const status = data?.document.status;
  useEffect(() => {
    if (status !== "processing" && status !== "pending") return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, status]);

  const retry = async () => {
    await api(`/api/minutes/${id}/retry`, { body: {} });
    load();
  };

  if (!data) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">読み込み中…</p>}</div>;
  const d = data.document;
  return (
    <div className="page">
      <p>
        <Link className="back-link" to="/minutes">‹ 議事録一覧</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{d.title}</h1>
          <div className="muted small">
            {[whenText(d), d.recorder_name ? `録音 ${d.recorder_name}` : ""].filter(Boolean).join(" ・ ")}{" "}
            <span className={`pill ${STATUS[d.status][1]}`}>
              {(d.status === "processing" || d.status === "pending") && <span className="spinner spinner-small" aria-hidden="true" />}
              {STATUS[d.status][0]}
            </span>
          </div>
        </div>
        {(d.status === "failed" || d.status === "done") && user.role !== "viewer" && (
          <button className="btn btn-small" onClick={retry}>
            取り込み直す
          </button>
        )}
      </div>
      {d.status === "processing" && (
        <p className="notice voiss-working" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Claude がタスクを抜き出し、全文を Drive に保存しています。長い会議は数分かかります（この画面は自動で更新されます）。</span>
        </p>
      )}
      {d.error && <p className="notice notice-error">{d.error}</p>}
      {d.drive_url ? (
        <p className="small">
          <a href={d.drive_url} target="_blank" rel="noreferrer">
            Google Drive で開く（全文{d.drive_audio_id ? "・音声" : ""}）
          </a>
          {d.audio_pending && <span className="muted"> ・ 音声は Drive に置いている途中です</span>}
        </p>
      ) : (
        d.audio_pending && <p className="small muted">音声は届いています。全文を Drive に保存したあと、同じフォルダに置きます。</p>
      )}
      {d.summary && (
        <div className="panel">
          <h2>要点</h2>
          <p>{d.summary}</p>
        </div>
      )}
      {data.decisions.length > 0 && (
        <div className="panel">
          <h2>決まったこと</h2>
          <ul>
            {data.decisions.map((x) => (
              <li key={x.id}>
                {x.text}
                {x.company_name && <span className="muted small">（{x.company_name}）</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.tasks.length > 0 && (
        <div className="panel">
          <h2>ネクストアクション</h2>
          <ul>
            {data.tasks.map((t) => (
              <li key={t.id}>
                {t.status === "done" ? <s>{t.title}</s> : t.title}
                <span className="muted small">
                  （{t.assignee || t.assignee_name || "担当未定"}
                  {t.due_on && ` ・ ${fmtDate(t.due_on)}まで`}）
                </span>
              </li>
            ))}
          </ul>
          <Link to="/tasks" className="small">
            タスク一覧へ →
          </Link>
        </div>
      )}
      {data.people.length > 0 && (
        <div className="panel">
          <h2>登場した人物</h2>
          <ul>
            {data.people.map((p) => (
              <li key={p.id}>
                <Link to={`/cards/${p.card_id}`}>{p.person_name}</Link>
                <span className="muted small">（{p.company_name}）{p.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.deals.length > 0 && (
        <div className="panel">
          <h2>案件</h2>
          <ul>
            {data.deals.map((x) => (
              <li key={x.id}>
                {x.company_name}／{x.name}
                <span className="muted small">
                  （{x.status}
                  {x.amount && ` ・ ${x.amount}`}）
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TranscriptPanel documentId={d.id} />
    </div>
  );
}

/** 目的別の抜き出し: 文字起こしの全文から、目的に合わせて取り出す（結果は残り、ほかの人も見られる） */
function TranscriptPanel({ documentId }: { documentId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const open = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && text === null) api<{ text: string }>(`/api/minutes/${documentId}/text`).then((r) => setText(r.text), (err) => setError(errorMessage(err)));
  };
  const lines = useMemo(() => {
    const all = (text ?? "").split("\n").filter((l) => l.trim());
    const q = query.trim();
    return q ? all.filter((l) => l.includes(q)) : all;
  }, [text, query]);

  return (
    <details className="panel transcript" onToggle={open}>
      <summary>
        <h2>文字起こしの全文</h2>
      </summary>
      {error && <p className="error">{error}</p>}
      {text === null ? (
        <p className="muted small">読み込み中…</p>
      ) : !text.trim() ? (
        <p className="muted small">全文はありません。</p>
      ) : (
        <>
          <div className="row wrap">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="言葉で絞り込む" aria-label="全文を絞り込む" />
            <CopyButton value={text} label="全文" />
          </div>
          <p className="muted small">{query.trim() ? `${lines.length}行が当てはまります` : `${lines.length}行`}</p>
          <div className="transcript-body">{lines.join("\n")}</div>
        </>
      )}
    </details>
  );
}
