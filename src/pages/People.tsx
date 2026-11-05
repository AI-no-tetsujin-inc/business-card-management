// 人物情報: 人物像（立場・温度感・今の状況・性格・関心・気をつけること・人間関係）のまとめての出力と、振り分け結果の取り込み・確認待ち
// 振り分けは各自の Claude（スキル「person-insights」か、名刺管理のコネクタ）で行い、アプリ側では AI を使わない
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Hint, copyText, useToast } from "../components/ui";
import { downloadBlob, readTextFile } from "../lib/csv";
import { INSIGHT_LABEL, type InsightCategory } from "../../shared/insights";

interface Summary {
  active: number;
  pending: number;
  people: number;
  companies: { company_key: string; company_name: string; n: number }[];
}
interface Pending {
  id: string;
  category: InsightCategory;
  body: string;
  evidence: string;
  happened_on: string | null;
  source_title: string;
  suggested_name: string;
  suggested_company: string;
  confidence: number;
  suggested_card_id: string | null;
  suggested_person: string | null;
  suggested_card_company: string | null;
}
/** 取り込みの結果（AI 連携の add_person_insights と同じ形） */
interface ImportResult {
  applied: { card_id: string; name: string; category: InsightCategory }[];
  pending: { name: string; company: string; category: InsightCategory; reason: string; candidate?: { name: string; company: string } }[];
  skipped: { name: string; category: InsightCategory; reason: string }[];
  errors: { index: number; message: string }[];
}

export function PeoplePage() {
  const { user } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [company, setCompany] = useState(params.get("company") ?? "");
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [json, setJson] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const canWrite = user.role !== "viewer";

  const load = useCallback(() => {
    api<Summary>("/api/insights/summary").then(setSummary, (e) => setError(errorMessage(e)));
    api<{ pending: Pending[] }>("/api/insights/pending").then((r) => setPending(r.pending), () => setPending([]));
  }, []);
  useEffect(load, [load]);

  const exportMd = async (mode: "copy" | "file") => {
    const r = await api<{ markdown: string }>(`/api/insights/export${company ? `?company=${encodeURIComponent(company)}` : ""}`);
    const name = company ? summary?.companies.find((c) => c.company_key === company)?.company_name ?? "会社" : "全員";
    if (mode === "copy") await copyText(r.markdown, `人物情報（${name}）`, toast);
    else downloadBlob(new Blob([r.markdown], { type: "text/markdown" }), `人物情報_${name}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.md`);
  };

  const runImport = async (text: string) => {
    setError("");
    setResult(null);
    let payload: unknown;
    try {
      // Claude の返事に ```json … ``` が付いていても読めるように、最初の { から最後の } までを使う
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      payload = JSON.parse(start >= 0 ? text.slice(start, end + 1) : text);
    } catch {
      setError("振り分け結果を読めませんでした。スキルが作った JSON ファイルを選ぶか、中身をそのまま貼り付けてください");
      return;
    }
    try {
      const r = await api<ImportResult>("/api/insights/import", { body: payload });
      setResult(r);
      setJson("");
      toast(`${r.applied.length} 件を人物像に反映しました${r.pending.length ? `（確認待ち ${r.pending.length} 件）` : ""}`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <h1>人物情報</h1>
      <p className="muted">
        取引先の人ごとに、立場・温度感・今の状況・性格・関心・気をつけること・人間関係をためていきます。たまった情報は名刺の詳細の「人物像」で見られ、まとめて出力して ChatGPT / Claude に渡せます。
      </p>
      {summary && (
        <p className="small">
          人物像 <strong>{summary.active}</strong> 件（{summary.people} 人）{summary.pending > 0 && <> ・ 確認待ち <strong>{summary.pending}</strong> 件</>}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel">
        <h2>1. まとめて出力（Markdown）</h2>
        <p className="muted small">会社ごと・人ごとに、人物像・最近のやり取り（議事録）・メモをまとめます。会う前の準備や、ChatGPT / Claude での相談にそのまま貼れます。振り分けのときに Claude に渡すと、名前を正しく突き合わせられます。</p>
        <div className="row wrap">
          <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="会社" style={{ width: "auto", maxWidth: "100%" }}>
            <option value="">全員</option>
            {summary?.companies.map((c) => (
              <option key={c.company_key} value={c.company_key}>
                {c.company_name}（{c.n}人）
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-small" onClick={() => exportMd("copy")}>
            コピー
          </button>
          <button className="btn btn-small" onClick={() => exportMd("file")}>
            ファイルで保存
          </button>
        </div>
      </section>

      {canWrite && (
        <section className="panel">
          <h2>2. 文字起こしなどから振り分けて入れる</h2>
          <ol className="steps">
            <li>
              自分の Claude に「<strong>person-insights</strong>」スキルを入れます（最初の1回だけ）。
              <a href="/skills/person-insights.zip" download>
                スキルをダウンロード
              </a>
            </li>
            <li>Claude に、会議の文字起こし（議事録のテキストでも、メモでも可）と、上の「1. まとめて出力」でコピーした人物情報を渡して「人物ごとに振り分けて」と頼みます。</li>
            <li>Claude が作った JSON ファイルを下に入れるか、中身を貼り付けて「取り込む」を押します。</li>
          </ol>
          <div className="import-json">
            <label className="btn btn-small">
              ファイルを選ぶ
              <input
                type="file"
                accept=".json,application/json,text/plain"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) await runImport(await readTextFile(f));
                }}
              />
            </label>
            <textarea rows={5} value={json} onChange={(e) => setJson(e.target.value)} placeholder='または、Claude が出した JSON（{"source": …, "items": [ … ]}）をここに貼り付け' />
            <button className="btn btn-primary" disabled={!json.trim()} onClick={() => runImport(json)}>
              取り込む
            </button>
          </div>
          {result && (
            <div className={`notice ${result.pending.length || result.errors.length ? "notice-warn" : "notice-ok"}`} role="status">
              <p>
                反映 {result.applied.length} 件 ・ 確認待ち {result.pending.length} 件{result.skipped.length > 0 && ` ・ 取り込み済みのため省略 ${result.skipped.length} 件`}
                {result.errors.length > 0 && ` ・ エラー ${result.errors.length} 件`}
              </p>
              {result.pending.length > 0 && (
                <ul className="small">
                  {result.pending.map((p, i) => (
                    <li key={i}>
                      確認待ち: {p.name || "（名前なし）"}
                      {p.company && `（${p.company}）`} ・ {INSIGHT_LABEL[p.category]} ・ {p.reason}
                      {p.candidate && `（候補: ${p.candidate.name}）`}
                    </li>
                  ))}
                </ul>
              )}
              {result.errors.length > 0 && (
                <ul className="small error">
                  {result.errors.map((e) => (
                    <li key={e.index}>
                      {e.index + 1} 件目: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <Hint summary="Claude に「名刺管理」のコネクタをつないでいる場合">
            ファイルを作らなくても、Claude に「この文字起こしを人物ごとに振り分けて名刺管理に入れて」と頼めば、そのまま反映されます（使う機能: add_person_insights）。まとめての出力も「〇〇社の人物情報を出して」で取れます。
          </Hint>
        </section>
      )}

      <section className="panel">
        <h2>3. 確認待ち{pending && pending.length > 0 && <span className="pill pill-warn"> {pending.length}件</span>}</h2>
        <p className="muted small">人がはっきりしない・自信が低いため、自動では入れなかったものです。どの人の情報か選んでください。</p>
        {pending === null ? (
          <p className="muted small">読み込み中…</p>
        ) : pending.length === 0 ? (
          <p className="muted small">確認待ちはありません。</p>
        ) : (
          <ul className="pending-list">
            {pending.map((p) => (
              <PendingRow key={p.id} p={p} canWrite={canWrite} onDone={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PendingRow({ p, canWrite, onDone }: { p: Pending; canWrite: boolean; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; person_name: string; company_name: string }[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (q.trim().length < 1) return setHits([]);
    const t = setTimeout(() => {
      api<{ cards: { id: string; person_name: string; company_name: string }[] }>(`/api/cards?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.cards.slice(0, 6)), () => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const assign = async (cardId: string, name: string) => {
    try {
      await api(`/api/insights/${p.id}/assign`, { body: { card_id: cardId } });
      toast(`${name}さんの人物像に入れました`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const dismiss = async () => {
    await api(`/api/insights/${p.id}/dismiss`, { body: {} });
    onDone();
  };
  return (
    <li className="pending-row">
      <div>
        <strong>
          {p.suggested_name || "（名前なし）"}
          {p.suggested_company && `（${p.suggested_company}）`}
        </strong>
        <span className="pill">{INSIGHT_LABEL[p.category] ?? p.category}</span>
      </div>
      <p>{p.body}</p>
      <p className="muted small">
        {[p.happened_on, p.source_title, p.evidence && `根拠: 「${p.evidence}」`, `確信度 ${Math.round(p.confidence * 100)}%`].filter(Boolean).join(" ・ ")}
      </p>
      {canWrite && (
        <div className="row wrap">
          {p.suggested_card_id && (
            <button className="btn btn-primary btn-small" onClick={() => assign(p.suggested_card_id!, p.suggested_person ?? "")}>
              {p.suggested_person}さん（{p.suggested_card_company}）に入れる
            </button>
          )}
          <input className="pending-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ほかの人を名前で探す" aria-label="入れる人を探す" />
          <button className="btn btn-small" onClick={dismiss}>
            入れない
          </button>
        </div>
      )}
      {hits.length > 0 && (
        <div className="row wrap">
          {hits.map((h) => (
            <button key={h.id} className="btn btn-small" onClick={() => assign(h.id, h.person_name)}>
              {h.person_name}（{h.company_name}）
            </button>
          ))}
        </div>
      )}
      {!p.suggested_card_id && !hits.length && (
        <p className="muted small">
          名刺がまだない人なら、先に<Link to="/upload">名刺を登録</Link>してから選んでください。
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </li>
  );
}
