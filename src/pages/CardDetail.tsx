import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CARD_FIELDS, pickFields, ruleWarnings, type CardFields, type FieldKey } from "../../shared/fields";
import { api, downloadCsv, errorMessage } from "../api";
import { CardImage } from "../components/CardImage";
import { FieldForm } from "../components/FieldForm";
import { TagInput } from "../components/TagInput";
import { fmtDate, fmtDateTime, parseTags } from "../lib/format";
import { viaLabel } from "../lib/next";
import { useAuth } from "../auth";
import { CopyButton, SkeletonDetail, copyText, useToast, useUnsavedGuard } from "../components/ui";
import { PersonProfile } from "../components/PersonProfile";
import { LAST_LIST_KEY } from "./Cards";
import type { CardDetail, CardEvent } from "../types";

function eventText(e: CardEvent): string {
  const d = JSON.parse(e.detail || "{}") as {
    exchanged_on?: string;
    exchange_place?: string;
    updated_fields?: string[];
    changes?: { label: string; before: string; after: string }[];
    via?: string;
    merged_from?: string;
    linked?: string;
  };
  const when = [d.exchanged_on && `交換日 ${fmtDate(d.exchanged_on)}`, d.exchange_place].filter(Boolean).join(" ・ ");
  const updated = d.changes?.length
    ? `（${d.changes.map((c) => `${c.label}: ${c.before || "空"} → ${c.after || "空"}`).join("、")}）`
    : d.updated_fields?.length
      ? `（${d.updated_fields.join("・")}を更新）`
      : "";
  const via = viaLabel(d.via) ? `［${viaLabel(d.via)}］` : "";
  if (d.linked) return `${e.user_name} が${d.linked}`;
  if (d.merged_from) return `${e.user_name} が「${d.merged_from}」を同じ人物として統合${updated}${via}`;
  return `${eventBody(e, when, updated)}${via}`;
}

function eventBody(e: CardEvent, when: string, updated: string): string {
  switch (e.type) {
    case "created":
      return `${e.user_name} が登録${when ? ` ・ ${when}` : ""}`;
    case "exchanged":
      return `${e.user_name} も名刺を登録${when ? ` ・ ${when}` : ""}${updated}`;
    case "updated":
      return `${e.user_name} が情報を編集${updated}`;
    case "deleted":
      return `${e.user_name} がごみ箱に移動`;
    case "restored":
      return `${e.user_name} がごみ箱から復元`;
  }
}

type EditDraft = { fields: CardFields; tags: string[]; place: string; exchangedOn: string };
function readDraft(key: string): EditDraft | null {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as EditDraft) : null;
  } catch {
    return null;
  }
}
function writeDraft(key: string, v: EditDraft) {
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 保存できなくても編集はできる */
  }
}
function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/** コピーボタンを付ける項目（トーストに出す名前） */
const COPYABLE: Partial<Record<FieldKey, string>> = {
  person_name: "氏名",
  company_name: "会社名",
  department: "部署",
  title: "役職",
  email: "メールアドレス",
  phone: "電話番号",
  mobile: "携帯番号",
  fax: "FAX",
  postal_code: "郵便番号",
  address: "住所",
  url: "URL",
};

/** メールやチャットに貼り付けやすい連絡先のテキスト（空欄は省略。メモや履歴などの社内情報は入れない） */
function contactText(c: CardFields) {
  const lines = [
    c.company_name,
    [c.department, c.title].filter(Boolean).join(" "),
    c.person_name,
    c.email && `メール: ${c.email}`,
    c.phone && `電話: ${c.phone}`,
    c.mobile && `携帯: ${c.mobile}`,
    (c.postal_code || c.address) && [c.postal_code && `〒${c.postal_code.replace(/^〒/, "")}`, c.address].filter(Boolean).join(" "),
    c.url && `URL: ${c.url}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function CardDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const backTo = (() => {
    try {
      return `/${sessionStorage.getItem(LAST_LIST_KEY) ?? ""}`;
    } catch {
      return "/";
    }
  })();
  const [data, setData] = useState<CardDetail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<CardFields | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [place, setPlace] = useState("");
  const [exchangedOn, setExchangedOn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [initialFields, setInitialFields] = useState("");
  const editDirty = editing && JSON.stringify({ fields, tags, place, exchangedOn }) !== initialFields;
  // 編集中の変更やメモの書きかけがあるときは、画面を離れる前に確認する
  useUnsavedGuard(editDirty || note.trim() !== "");
  // ブラウザの「戻る」や再読み込みでも消えないよう、保存していない編集は下書きとして残す
  const draftKey = `meishi:edit:${id}`;
  const [savedDraft, setSavedDraft] = useState(() => readDraft(draftKey));
  useEffect(() => {
    if (editDirty && fields) writeDraft(draftKey, { fields, tags, place, exchangedOn });
  }, [editDirty, fields, tags, place, exchangedOn, draftKey]);

  const load = useCallback(() => {
    api<CardDetail>(`/api/cards/${id}`).then(setData, (e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  const startEdit = (restore = false) => {
    if (!data) return;
    const original = { fields: pickFields(data.card), tags: parseTags(data.card.tags), place: data.card.exchange_place, exchangedOn: data.card.exchanged_on };
    const v = restore && savedDraft ? savedDraft : original;
    setFields(v.fields);
    setTags(v.tags);
    setPlace(v.place);
    setExchangedOn(v.exchangedOn);
    setInitialFields(JSON.stringify(original));
    setEditing(true);
    if (!restore) {
      clearDraft(draftKey);
      setSavedDraft(null);
    }
  };
  const cancelEdit = () => {
    if (editDirty && !confirm("編集した内容を破棄しますか？")) return;
    clearDraft(draftKey);
    setSavedDraft(null);
    setEditing(false);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/cards/${id}`, { method: "PATCH", body: { fields, tags, exchange_place: place, exchanged_on: exchangedOn } });
      setEditing(false);
      clearDraft(draftKey);
      setSavedDraft(null);
      toast("保存しました");
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setNoteError("");
    try {
      await api(`/api/cards/${id}/notes`, { body: { body: note } });
      setNote("");
      toast("メモを追加しました");
      load();
    } catch (err) {
      // 書いたメモは残したまま、もう一度押せるようにする
      setNoteError(`${errorMessage(err)}（もう一度「メモを追加」を押してください）`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api(`/api/cards/${id}/delete`, { body: {} });
      const name = data?.card.person_name || "名刺";
      navigate(backTo);
      toast(`${name} をごみ箱に移動しました`, {
        action: {
          label: "元に戻す",
          onClick: async () => {
            await api(`/api/cards/${id}/restore`, { body: {} });
            toast("元に戻しました");
            navigate(`/cards/${id}`);
          },
        },
      });
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  const restore = async () => {
    await api(`/api/cards/${id}/restore`, { body: {} });
    toast("ごみ箱から復元しました");
    load();
  };

  if (!data)
    return error ? (
      <div className="page">
        <div className="notice notice-error" role="alert">
          <p>名刺を読み込めませんでした（{error}）。</p>
          <button className="btn btn-small" onClick={() => (setError(""), load())}>
            再読み込み
          </button>
        </div>
      </div>
    ) : (
      <SkeletonDetail />
    );
  const { card, images, events, notes, interactions, tasks } = data;
  const latestFront = images.find((i) => i.side === "front");
  const latestBack = images.find((i) => i.side === "back");
  const olderImages = images.filter((i) => i !== latestFront && i !== latestBack);

  return (
    <div className="page">
      <p>
        <Link className="back-link" to={backTo}>‹ 名刺一覧</Link>
      </p>
      {card.deleted_at && (
        <div className="notice notice-warn row between">
          <span>この名刺はごみ箱にあります（{fmtDateTime(card.deleted_at)}）。</span>
          <button className="btn btn-small" onClick={restore}>
            復元する
          </button>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1>{card.person_name || "（氏名なし）"}</h1>
          <div className="muted">
            {card.company_name && (
              <Link to={`/company?key=${encodeURIComponent(card.company_key)}`}>{card.company_name}</Link>
            )}
            {[card.department, card.title].filter(Boolean).map((v) => ` ・ ${v}`)}
          </div>
        </div>
        {!editing && !card.deleted_at && (
          <div className="row desktop-only">
            <button className="btn" onClick={() => copyText(contactText(card), "連絡先", toast)}>
              連絡先をまとめてコピー
            </button>
            {user.role === "admin" && (
              <button className="btn" onClick={() => downloadCsv([card.id])}>
                CSV
              </button>
            )}
            {user.role !== "viewer" && (
              <button className="btn" onClick={() => startEdit()}>
                編集
              </button>
            )}
          </div>
        )}
      </div>

      {/* スマホ: よく使う操作を1タップで（電話アプリの連絡先画面と同じ並び） */}
      {!editing && !card.deleted_at && (
        <div className="quick-actions mobile-only">
          {(card.mobile || card.phone) && (
            <a href={`tel:${(card.mobile || card.phone).replace(/[^\d+]/g, "")}`}>
              電話
            </a>
          )}
          {card.email && (
            <a href={`mailto:${card.email}`}>
              メール
            </a>
          )}
          <button onClick={() => copyText(contactText(card), "連絡先", toast)}>
            コピー
          </button>
          {user.role !== "viewer" && (
            <button onClick={() => startEdit()}>
              編集
            </button>
          )}
        </div>
      )}

      {savedDraft && !editing && !card.deleted_at && user.role !== "viewer" && (
        <div className="notice notice-warn row between" role="status">
          <span>保存していない編集が残っています。</span>
          <span className="row">
            <button className="btn btn-small btn-primary" onClick={() => startEdit(true)}>
              続きから編集
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                clearDraft(draftKey);
                setSavedDraft(null);
              }}
            >
              破棄
            </button>
          </span>
        </div>
      )}

      <div className={`review-layout ${editing ? "editing" : ""}`}>
        {/* 編集中は画像を小さく・開閉式にして、入力欄をすぐ見られるようにする（タップで拡大） */}
        {editing && (
          <details className="edit-images">
            <summary>名刺の画像を見る（タップで拡大）</summary>
            <div className="edit-thumbs">
              {latestFront && <CardImage displayKey={latestFront.display_key} fullKey={latestFront.full_key} alt="表面" className="card-image small" />}
              {latestBack && <CardImage displayKey={latestBack.display_key} fullKey={latestBack.full_key} alt="裏面" className="card-image small" />}
            </div>
          </details>
        )}
        <div className="review-images">
          {latestFront && <CardImage displayKey={latestFront.display_key} fullKey={latestFront.full_key} alt="表面" />}
          {latestBack && <CardImage displayKey={latestBack.display_key} fullKey={latestBack.full_key} alt="裏面" />}
          {olderImages.length > 0 && (
            <details>
              <summary className="small">以前の名刺画像（{olderImages.length}枚）</summary>
              <div className="older-images">
                {olderImages.map((img) => (
                  <figure key={img.id}>
                    <CardImage displayKey={img.display_key} fullKey={img.full_key} alt="以前の名刺" className="card-image small" />
                    <figcaption className="muted small">
                      {img.uploaded_by_name} ・ {fmtDate(img.uploaded_at)}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="review-form">
          {editing && fields ? (
            <div className="panel">
              <FieldForm fields={fields} onChange={(k: FieldKey, v) => setFields({ ...fields, [k]: v })} flags={ruleWarnings(fields)} />
              <div className="grid-2">
                <label className="stack">
                  <span>交換日</span>
                  <input type="date" value={exchangedOn} onChange={(e) => setExchangedOn(e.target.value)} />
                </label>
                <label className="stack">
                  <span>交換場所・イベント名</span>
                  <input value={place} onChange={(e) => setPlace(e.target.value)} />
                </label>
              </div>
              <label className="stack">
                <span>タグ</span>
                <TagInput value={tags} onChange={setTags} />
              </label>
              {error && <p className="error">{error}</p>}
              <div className="actions edit-actions">
                <button className="btn" onClick={cancelEdit} disabled={busy}>
                  キャンセル
                </button>
                <button className="btn btn-primary" onClick={save} disabled={busy}>
                  {busy ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : (
            <div className="panel">
              <dl className="details">
                {CARD_FIELDS.filter(({ key }) => card[key]).map(({ key, label }) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd className="dd-with-copy">
                      {/* 開く（発信・メール作成・サイト表示）とコピーは別のボタンにする */}
                      {key === "email" ? (
                        <a href={`mailto:${card.email}`}>{card.email}</a>
                      ) : ["phone", "mobile", "fax"].includes(key) ? (
                        <a href={`tel:${card[key].replace(/[^\d+]/g, "")}`}>{card[key]}</a>
                      ) : key === "url" ? (
                        <a href={/^https?:\/\//.test(card.url) ? card.url : `https://${card.url}`} target="_blank" rel="noreferrer">
                          {card.url}
                        </a>
                      ) : (
                        <span className="pre">{card[key]}</span>
                      )}
                      {COPYABLE[key] && <CopyButton value={card[key]} label={COPYABLE[key]!} />}
                    </dd>
                  </div>
                ))}
                {card.exchanged_on && (
                  <div>
                    <dt>交換日</dt>
                    <dd>{fmtDate(card.exchanged_on)}</dd>
                  </div>
                )}
                {card.exchange_place && (
                  <div>
                    <dt>交換場所</dt>
                    <dd>{card.exchange_place}</dd>
                  </div>
                )}
                {parseTags(card.tags).length > 0 && (
                  <div>
                    <dt>タグ</dt>
                    <dd>
                      {parseTags(card.tags).map((t) => (
                        <Link key={t} to={`/?tag=${encodeURIComponent(t)}&view=list`} className="tag">
                          {t}
                        </Link>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {!card.deleted_at && <PersonProfile cardId={card.id} personName={card.person_name} />}
          <AffiliationPanel card={card} affiliations={data.affiliations ?? []} canWrite={user.role !== "viewer" && !card.deleted_at} onChanged={load} />

          <div className="panel">
            <h2>メモ</h2>
            <form onSubmit={addNote} className="note-form">
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="話した内容・次のアクションなど（誰でも追加できます）" />
              <button className="btn btn-primary" type="submit" disabled={busy || !note.trim()}>
                {busy ? "追加中…" : "メモを追加"}
              </button>
            </form>
            {noteError && (
              <p className="error small" role="alert">
                {noteError}
              </p>
            )}
            {notes.length === 0 ? (
              <p className="muted small">まだメモはありません。</p>
            ) : (
              <ul className="notes">
                {notes.map((n) => (
                  <li key={n.id}>
                    <div className="note-meta">
                      {n.created_by_name} ・ {fmtDateTime(n.created_at)}
                      {viaLabel(n.source) && <span className="pill pill-info via">{viaLabel(n.source)}</span>}
                    </div>
                    <div className="pre">{n.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(interactions.length > 0 || tasks.length > 0) && (
            <div className="panel">
              {interactions.length > 0 && (
                <>
                  <h2>過去のやり取り</h2>
                  <ul className="plain-list">
                    {interactions.map((i) => (
                      <li key={i.id}>
                        <span className="muted small">{fmtDate(i.happened_on ?? i.created_at)}</span> {i.summary}
                        {i.document_id && (
                          <>
                            {" "}
                            <Link to={`/minutes/${i.document_id}`} className="small">
                              議事録
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {tasks.length > 0 && (
                <>
                  <h2>関連タスク</h2>
                  <ul className="plain-list">
                    {tasks.map((t) => (
                      <li key={t.id}>
                        {t.status === "done" ? <s>{t.title}</s> : t.title}
                        <span className="muted small">
                          （{t.assignee || t.assignee_name || "担当未定"}
                          {t.due_on && ` ・ ${fmtDate(t.due_on)}まで`}）
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="panel">
            <h2>履歴</h2>
            <ul className="timeline">
              {events.map((e) => (
                <li key={e.id} className={`ev-${e.type}`}>
                  <span className="timeline-date">{fmtDateTime(e.created_at)}</span>
                  <span>{eventText(e)}</span>
                </li>
              ))}
            </ul>
          </div>

          {!card.deleted_at && !editing && user.role !== "viewer" && (
            <div className="actions">
              <button className="btn btn-danger-ghost" onClick={remove}>
                ごみ箱に移動（あとで元に戻せます）
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


/** 同じ人の別の所属（転職・兼務など）。会社ごとの名刺は分けたまま、同じ人としてまとめる */
function AffiliationPanel({ card, affiliations, canWrite, onChanged }: { card: CardDetail["card"]; affiliations: CardDetail["affiliations"]; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(card.person_name);
  const [results, setResults] = useState<CardDetail["card"][] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !q.trim()) return setResults(null);
    const t = setTimeout(() => {
      api<{ cards: CardDetail["card"][] }>(`/api/cards?q=${encodeURIComponent(q)}`).then(
        (r) => setResults(r.cards.filter((c) => c.id !== card.id && !affiliations.some((a) => a.id === c.id))),
        () => setResults([]),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [open, q, card.id, affiliations]);

  const link = async (other: CardDetail["card"]) => {
    if (!confirm(`「${other.company_name} の ${other.person_name}」を、この名刺と同じ人としてまとめます。名刺はそれぞれ残ります。よろしいですか？`)) return;
    setBusy(true);
    try {
      await api(`/api/cards/${card.id}/link`, { body: { other_id: other.id } });
      toast("同じ人としてまとめました");
      setOpen(false);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (!confirm("この名刺を、同じ人のまとまりから外します（名刺は消えません）。よろしいですか？")) return;
    try {
      await api(`/api/cards/${card.id}/unlink`, { body: {} });
      toast("まとまりから外しました");
      onChanged();
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  if (!affiliations.length && !canWrite) return null;
  return (
    <div className="panel">
      <h2>同じ人の別の所属</h2>
      {affiliations.length ? (
        <ul className="plain-list">
          {affiliations.map((a) => (
            <li key={a.id}>
              <Link to={`/cards/${a.id}`}>{a.company_name || "（会社名なし）"}</Link>
              <span className="muted small">
                {" "}
                {[a.department, a.title].filter(Boolean).join(" ")}
                {a.exchanged_on && ` ・ 交換日 ${fmtDate(a.exchanged_on)}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">転職・兼務などで別の会社の名刺もある場合は、同じ人としてまとめられます（会社ごとの名刺はそのまま残ります）。</p>
      )}
      {canWrite && (
        <div className="row">
          <button className="btn btn-small" aria-expanded={open} onClick={() => setOpen(!open)}>
            別の会社の名刺とまとめる
          </button>
          {affiliations.length > 0 && (
            <button className="btn btn-small btn-danger-ghost" onClick={unlink}>
              この名刺をまとまりから外す
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="link-search">
          <label className="stack">
            <span>まとめる名刺を探す（氏名・会社名など）</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {results === null ? null : results.length === 0 ? (
            <p className="muted small">見つかりません。</p>
          ) : (
            <ul className="plain-list">
              {results.slice(0, 10).map((r) => (
                <li key={r.id} className="row between">
                  <span>
                    <strong>{r.person_name}</strong> {r.company_name} <span className="muted small">{[r.department, r.title].filter(Boolean).join(" ")}</span>
                  </span>
                  <button className="btn btn-small" disabled={busy} onClick={() => link(r)}>
                    同じ人としてまとめる
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
