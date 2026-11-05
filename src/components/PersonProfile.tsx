// 名刺の詳細の「人物像」: 立場・温度感・今の状況・性格・関心・気をつけること・人間関係を、分類ごとに新しい順で見せる
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { INSIGHT_CATEGORIES, type InsightCategory } from "../../shared/insights";
import { copyText, useToast } from "./ui";

interface Insight {
  id: string;
  category: InsightCategory;
  body: string;
  evidence: string;
  happened_on: string | null;
  source_title: string;
  source: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

/** 分類ごとに最初に見せる件数（それより古いものは「ほか N 件」で開く） */
const SHOW = 3;
const SOURCE_LABEL: Record<string, string> = { skill: "振り分け", ai: "AI 連携", manual: "手入力" };

export function PersonProfile({ cardId, personName }: { cardId: string; personName: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Insight[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ category: InsightCategory; text: string } | null>(null);
  const [error, setError] = useState("");
  const canWrite = user.role !== "viewer";

  const load = useCallback(() => {
    api<{ insights: Insight[] }>(`/api/cards/${cardId}/insights`).then((r) => setItems(r.insights), (e) => setError(errorMessage(e)));
  }, [cardId]);
  useEffect(load, [load]);

  const add = async () => {
    if (!form?.text.trim()) return;
    try {
      await api(`/api/cards/${cardId}/insights`, { body: { category: form.category, text: form.text } });
      setForm(null);
      toast("人物像に追加しました");
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async (i: Insight) => {
    try {
      await api(`/api/insights/${i.id}`, { method: "DELETE" });
      toast("削除しました");
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const exportOne = async () => {
    const r = await api<{ markdown: string }>(`/api/insights/export?card=${cardId}`);
    await copyText(r.markdown, `${personName}さんの人物情報`, toast);
  };

  return (
    <div className="panel person-profile">
      <div className="between row">
        <h2>人物像</h2>
        <div className="row">
          <button className="btn btn-small" onClick={exportOne} disabled={!items?.length}>
            まとめてコピー
          </button>
          {canWrite && !form && (
            <button className="btn btn-small" onClick={() => setForm({ category: "status", text: "" })}>
              ＋ 追記
            </button>
          )}
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      {form && (
        <div className="profile-form">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as InsightCategory })} aria-label="分類">
            {INSIGHT_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <textarea
            rows={2}
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
            placeholder={INSIGHT_CATEGORIES.find((c) => c.key === form.category)?.hint}
            autoFocus
          />
          <div className="row">
            <button className="btn btn-small" onClick={() => setForm(null)}>
              やめる
            </button>
            <button className="btn btn-primary btn-small" disabled={!form.text.trim()} onClick={add}>
              追加
            </button>
          </div>
        </div>
      )}
      {items === null ? (
        <p className="muted small">読み込み中…</p>
      ) : items.length === 0 ? (
        <p className="muted small">
          まだありません。会議の文字起こしなどから振り分けて入れるには「<Link to="/people">人物情報</Link>」の手順を見てください。手で書くときは「＋ 追記」から。
        </p>
      ) : (
        <dl className="profile-list">
          {INSIGHT_CATEGORIES.map((cat) => {
            const rows = items.filter((i) => i.category === cat.key);
            if (!rows.length) return null;
            const shown = open.has(cat.key) ? rows : rows.slice(0, SHOW);
            return (
              <div key={cat.key}>
                <dt>{cat.label}</dt>
                <dd>
                  <ul>
                    {shown.map((i) => (
                      <li key={i.id}>
                        <span>{i.body}</span>
                        <span className="muted small">
                          {" "}
                          {i.happened_on ?? i.created_at.slice(0, 10)}
                          {i.source_title && ` ・ ${i.source_title}`} ・ {SOURCE_LABEL[i.source] ?? i.source}
                          {i.evidence && <span title={`根拠: ${i.evidence}`}> ・ 根拠あり</span>}
                        </span>
                        {canWrite && (user.role === "admin" || i.created_by === user.id) && (
                          <button className="link-button small profile-remove" onClick={() => remove(i)} aria-label={`「${i.body}」を削除`}>
                            削除
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {rows.length > SHOW && (
                    <button
                      className="link-button small"
                      onClick={() =>
                        setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(cat.key)) n.delete(cat.key);
                          else n.add(cat.key);
                          return n;
                        })
                      }
                    >
                      {open.has(cat.key) ? "閉じる" : `ほか ${rows.length - SHOW} 件`}
                    </button>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}
