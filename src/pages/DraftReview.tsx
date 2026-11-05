// 確認待ちの個別確認: 元画像と読み取り結果を見比べて直し、「登録して次へ」で次の名刺へ進む。
// 直している途中の内容はサーバーに自動保存するので、画面を移っても失わない
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CARD_FIELDS, MATCH_LABEL, emptyFields, ruleWarnings, todayJst, type CardFields, type FieldFlags, type FieldKey } from "../../shared/fields";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { CardImage } from "../components/CardImage";
import { FieldForm } from "../components/FieldForm";
import { TagInput } from "../components/TagInput";
import { ProgressMeter, REGISTER_STEPS, SkeletonDetail, Stepper, useToast } from "../components/ui";
import { readingProgress } from "../lib/capture";
import { fmtDate, fmtDateTime } from "../lib/format";
import type { CardDetail, DraftDetail, DraftEdits, DuplicateCandidate } from "../types";

/** 重複候補があるときの選び方。選ぶまで登録できない（自動で統合・上書きしない） */
type Choice = { kind: "merge" | "affiliate"; cardId: string } | { kind: "new" } | null;

export const REVIEW_COUNT_KEY = "meishi:review-registered";
const bumpRegistered = () => {
  try {
    sessionStorage.setItem(REVIEW_COUNT_KEY, String(Number(sessionStorage.getItem(REVIEW_COUNT_KEY) ?? 0) + 1));
  } catch {
    /* noop */
  }
};

export function DraftReviewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refreshPending, user } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [queue, setQueue] = useState<{ remaining: number; next_id: string | null }>({ remaining: 0, next_id: null });
  const [fields, setFields] = useState<CardFields>(emptyFields());
  const [confirmed, setConfirmed] = useState<Set<FieldKey>>(new Set());
  const [exchangedOn, setExchangedOn] = useState(todayJst());
  const [place, setPlace] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [choice, setChoice] = useState<Choice>(null);
  const [targetCard, setTargetCard] = useState<CardDetail | null>(null);
  const [updateFields, setUpdateFields] = useState<Set<FieldKey>>(new Set());
  const [companies, setCompanies] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [retryStarted, setRetryStarted] = useState<number | null>(null);
  const [retryValue, setRetryValue] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const loaded = useRef(false);
  const dirty = useRef(false);
  const canWrite = user.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const r = await api<{ draft: DraftDetail; queue: { remaining: number; next_id: string | null } }>(`/api/drafts/${id}`);
      setDraft(r.draft);
      setQueue(r.queue);
      const e = r.draft.edited;
      if (e) {
        // 前回直していた途中の内容から続ける
        setFields({ ...emptyFields(), ...e.fields });
        setConfirmed(new Set(e.confirmed as FieldKey[]));
        setExchangedOn(e.exchangedOn || r.draft.exchanged_on || todayJst());
        setPlace(e.place);
        setTags(e.tags);
        setNote(e.note);
        setSavedAt(r.draft.edited_at);
      } else {
        setFields(r.draft.ocr ? r.draft.ocr.fields : emptyFields());
        setConfirmed(new Set());
        setExchangedOn(r.draft.exchanged_on || todayJst());
        setPlace("");
        setTags([]);
        setNote("");
        setSavedAt(null);
      }
      setChoice(null);
      loaded.current = true;
      dirty.current = false;
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    loaded.current = false;
    setDraft(null);
    setError("");
    load();
  }, [load]);
  useEffect(() => {
    api<{ companies: { company_name: string }[] }>("/api/companies").then((r) => setCompanies(r.companies.map((c) => c.company_name).filter(Boolean)), () => {});
  }, []);
  // 読み取り中に開いたときは、終わるまで数秒ごとに確認する
  useEffect(() => {
    if (!draft || draft.ocr || draft.error || draft.status !== "pending") return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [draft, load]);
  // 読み直し中のメーター（経過時間の目安。終わったら閉じる）
  useEffect(() => {
    if (retryStarted === null) return;
    const t = setInterval(() => setRetryValue(readingProgress(Date.now() - retryStarted)), 400);
    return () => clearInterval(t);
  }, [retryStarted]);

  const edits = (): DraftEdits => ({ fields, confirmed: [...confirmed], exchangedOn, place, tags, note });
  const saveEdits = useCallback(
    async (silent = true) => {
      if (!draft || draft.status !== "pending" || !canWrite) return;
      await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { edited: edits() } });
      dirty.current = false;
      setSavedAt(new Date().toISOString());
      if (!silent) toast("下書きを保存しました");
    },
    [draft, fields, confirmed, exchangedOn, place, tags, note, canWrite], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // 直したら少し待って自動保存する（画面を移っても入力を失わない）
  useEffect(() => {
    if (!loaded.current) return;
    dirty.current = true;
    const t = setTimeout(() => saveEdits().catch(() => {}), 1200);
    return () => clearTimeout(t);
  }, [fields, confirmed, exchangedOn, place, tags, note]); // eslint-disable-line react-hooks/exhaustive-deps
  // 画面を離れるときに保存しきれていなければ送っておく
  const latest = useRef(edits);
  latest.current = edits;
  useEffect(
    () => () => {
      if (dirty.current && draft?.status === "pending" && canWrite) {
        fetch(`/api/drafts/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ edited: latest.current() }), keepalive: true }).catch(() => {});
      }
    },
    [draft, canWrite],
  );

  // 要確認 = Claude が自信のない項目 + 形式チェックに引っかかった項目
  const flags: FieldFlags = useMemo(() => {
    const rule = ruleWarnings(fields);
    const merged: FieldFlags = { ...(draft?.ocr?.review ?? {}) };
    for (const [k, v] of Object.entries(rule) as [FieldKey, string][]) merged[k] = merged[k] ? `${merged[k]} / ${v}` : v;
    return merged;
  }, [fields, draft]);
  const remaining = CARD_FIELDS.map((f) => f.key).filter((k) => flags[k] && !confirmed.has(k));

  // 重複チェック（氏名・会社名・メール・電話が変わったら少し待ってから再検索）
  useEffect(() => {
    if (!draft?.ocr && !draft?.error) return;
    const t = setTimeout(() => {
      api<{ duplicates: DuplicateCandidate[] }>("/api/duplicates", { body: { fields } }).then((r) => {
        setDuplicates(r.duplicates);
        setChoice((prev) => (prev && prev.kind !== "new" && !r.duplicates.some((d) => d.id === prev.cardId) ? null : prev));
      }, () => {});
    }, 400);
    return () => clearTimeout(t);
  }, [draft, fields.email, fields.person_name, fields.company_name, fields.phone, fields.mobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // 更新先の名刺を読み込み、今回の値がある（空欄でない）かつ違う項目を「更新する」初期値にする
  const targetId = choice && choice.kind !== "new" ? choice.cardId : null;
  useEffect(() => {
    if (!targetId) {
      setTargetCard(null);
      return;
    }
    api<CardDetail>(`/api/cards/${targetId}`).then((r) => {
      setTargetCard(r);
      setUpdateFields(new Set(CARD_FIELDS.map((f) => f.key).filter((k) => fields[k] && fields[k] !== r.card[k])));
    }, (e) => setError(errorMessage(e)));
  }, [targetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const diffKeys = targetCard ? CARD_FIELDS.map((f) => f.key).filter((k) => fields[k] && fields[k] !== targetCard.card[k]) : [];

  const onChange = (key: FieldKey, value: string) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    // 手で直した項目は確認済みとみなす。ただし形式チェックに引っかかったままなら、明示的なチェックが必要
    setConfirmed((s) => {
      const n = new Set(s);
      if (ruleWarnings(next)[key]) n.delete(key);
      else n.add(key);
      return n;
    });
  };
  const onToggleConfirm = (key: FieldKey, checked: boolean) =>
    setConfirmed((s) => {
      const n = new Set(s);
      if (checked) n.add(key);
      else n.delete(key);
      return n;
    });

  const focusField = (k: FieldKey) => {
    const el = document.getElementById(`field-${k}`);
    el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  };

  /** 次の名刺へ（なければ確認待ち一覧で結果を出す） */
  const goNext = (msg?: string) => {
    if (msg) toast(msg);
    refreshPending();
    if (queue.next_id) navigate(`/drafts/${queue.next_id}`);
    else navigate("/drafts", { state: { finished: true } });
  };

  const commit = async () => {
    if (!draft || busy) return;
    setBusy("commit");
    setError("");
    try {
      const mode = !duplicates.length || choice?.kind === "new" ? "new" : choice!.kind;
      const r = await api<{ card_id: string; already?: boolean }>(`/api/drafts/${draft.id}/commit`, {
        body: {
          mode,
          card_id: choice && choice.kind !== "new" ? choice.cardId : undefined,
          fields,
          update_fields: mode === "merge" ? [...updateFields].filter((k) => diffKeys.includes(k)) : undefined,
          exchange_place: place,
          exchanged_on: exchangedOn,
          tags,
          note,
        },
      });
      dirty.current = false;
      if (!r.already) bumpRegistered();
      goNext(r.already ? "この名刺はすでに登録されていました" : mode === "merge" ? "既存の名刺を更新しました" : mode === "affiliate" ? "同じ人の別の所属として登録しました" : "名刺を登録しました");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const defer = async () => {
    if (!draft || busy) return;
    setBusy("defer");
    try {
      await saveEdits();
      await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { deferred: true } });
      goNext("あとで確認に回しました（登録はしていません）");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const discard = async () => {
    if (!draft || busy) return;
    if (!confirm("今回の取り込み（この読み取り結果と画像）を破棄します。既存の名刺は消えません。よろしいですか？")) return;
    setBusy("discard");
    try {
      await api(`/api/drafts/${draft.id}/discard`, { body: {} });
      dirty.current = false;
      goNext("今回の取り込みを破棄しました");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const retry = async () => {
    if (!draft) return;
    setBusy("retry");
    setError("");
    setRetryValue(30);
    setRetryStarted(Date.now());
    try {
      const r = await api<{ error: string | null }>(`/api/drafts/${draft.id}/retry`, { body: {} });
      if (r.error) setError(r.error);
      else toast("読み取り直しました");
      await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { edited: null } });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRetryStarted(null);
      setBusy("");
    }
  };

  if (!draft)
    return error ? (
      <div className="page">
        <div className="notice notice-error" role="alert">
          <p>読み取り結果を開けませんでした（{error}）。</p>
          <button className="btn btn-small" onClick={() => (setError(""), load())}>
            再読み込み
          </button>
        </div>
      </div>
    ) : (
      <SkeletonDetail />
    );
  if (draft.status !== "pending") {
    return (
      <div className="page">
        <p className="notice">{draft.status === "done" ? "この名刺はすでに登録されています。" : "この取り込みは破棄されています。"}</p>
        <div className="row">
          {draft.card_id && (
            <Link className="btn btn-primary" to={`/cards/${draft.card_id}`}>
              登録した名刺を開く
            </Link>
          )}
          <Link className="btn" to="/drafts">
            確認待ち一覧へ
          </Link>
        </div>
      </div>
    );
  }

  const reading = !draft.ocr && !draft.error;
  // 読み取りに失敗しても手入力で登録できるようにする
  const canEdit = Boolean(draft.ocr || draft.error) && canWrite;
  const needChoice = duplicates.length > 0 && !choice;
  const commitLabel = !duplicates.length || choice?.kind === "new" ? "登録して次へ" : choice?.kind === "merge" ? "既存の名刺を更新して次へ" : choice?.kind === "affiliate" ? "別の所属として登録して次へ" : "登録して次へ";

  return (
    <div className="page review-page">
      <Stepper steps={REGISTER_STEPS} current={2} />
      <div className="page-head">
        <div>
          <h1>読み取り結果の確認</h1>
          <span className="muted small">
            {draft.created_by_name} ・ {fmtDateTime(draft.created_at)}
            {draft.deferred && " ・ あとで確認"}
          </span>
        </div>
        <span className="status status-todo" aria-live="polite">
          この後 残り {queue.remaining} 件
        </span>
      </div>

      <div className="review-layout">
        <div className="review-images sticky-images compact-images">
          <CardImage displayKey={draft.front_display_key} fullKey={draft.front_full_key} alt="表面（タップで拡大）" />
          {draft.back_display_key && <CardImage displayKey={draft.back_display_key} fullKey={draft.back_full_key ?? undefined} alt="裏面（タップで拡大）" />}
          <p className="muted small">画像をタップすると拡大します。</p>
        </div>

        <div className="review-form">
          {reading && retryStarted === null && <ProgressMeter value={readingProgress(Date.now() - Date.parse(draft.created_at))} label="読み取り中です（AI）" note="終わると自動で表示されます。先に別の名刺を確認していても大丈夫です。" />}
          {retryStarted !== null && <ProgressMeter value={retryValue} label="もう一度読み取っています（AI）" note="10〜30 秒ほどかかります（% は目安です）" />}
          {draft.error && retryStarted === null && (
            <div className="notice notice-error">
              <p>{draft.error}</p>
              <button className="btn btn-small" disabled={Boolean(busy)} onClick={retry}>
                もう一度読み取る
              </button>
              <p className="small">読み取れない場合は、下の欄に手で入力して登録することもできます。</p>
            </div>
          )}
          {draft.ocr && !draft.ocr.is_business_card && <p className="notice notice-warn">名刺ではない画像の可能性があります。画像を確認してください。</p>}
          {draft.ocr?.comment && <p className="notice">{draft.ocr.comment}</p>}

          {canEdit && (
            <>
              {remaining.length > 0 ? (
                <div className="notice notice-warn">
                  <div className="row between">
                    <span>
                      黄色の項目を確認してください（あと <strong>{remaining.length}</strong> 件）
                    </span>
                    <button className="btn btn-small" onClick={() => focusField(remaining[0])}>
                      次の要確認へ
                    </button>
                  </div>
                  <ul className="flag-jump">
                    {remaining.map((k) => (
                      <li key={k}>
                        <a
                          href={`#field-${k}`}
                          onClick={(e) => {
                            e.preventDefault();
                            focusField(k);
                          }}
                        >
                          {CARD_FIELDS.find((f) => f.key === k)?.label}
                        </a>
                        <span className="small">{flags[k]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="notice notice-ok">要確認の項目はありません。名刺の画像と見比べて、内容を確認してください。</p>
              )}
              {duplicates.length > 0 && <p className="notice notice-info">同じ人と思われる名刺が {duplicates.length} 件あります。下の「同じ人の名刺があります」で扱いを選んでください。</p>}

              <FieldForm fields={fields} onChange={onChange} flags={flags} confirmed={confirmed} onToggleConfirm={onToggleConfirm} companySuggestions={companies} />

              <div className="panel">
                <h2>交換の情報</h2>
                <div className="grid-2">
                  <label className="stack">
                    <span>交換日</span>
                    <input type="date" value={exchangedOn} onChange={(e) => setExchangedOn(e.target.value)} />
                  </label>
                  <label className="stack">
                    <span>交換場所・イベント名</span>
                    <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="例: ○○展示会 2026" />
                  </label>
                </div>
                <label className="stack">
                  <span>タグ</span>
                  <TagInput value={tags} onChange={setTags} />
                </label>
                <label className="stack">
                  <span>メモ（任意）</span>
                  <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="話した内容など" />
                </label>
              </div>

              {duplicates.length > 0 && (
                <div className="panel panel-info dup-panel" role="group" aria-labelledby="dup-title">
                  <h2 id="dup-title">同じ人の名刺があります — 扱いを選んでください</h2>
                  <p className="muted small">自動では統合・上書きしません。候補にした理由を見て選んでください。</p>
                  {duplicates.map((d) => (
                    <div key={d.id} className="dup-candidate">
                      <div>
                        <strong>{d.person_name}</strong> {d.company_name} {d.department} {d.title}
                        <div className="small">
                          <span className="status status-todo">{MATCH_LABEL[d.match] ?? d.match}</span>
                        </div>
                        <div className="muted small">
                          {d.created_by_name} が {fmtDate(d.created_at)} に登録 ・{" "}
                          <Link to={`/cards/${d.id}`} target="_blank">
                            開く
                          </Link>
                        </div>
                      </div>
                      <label className="radio-card">
                        <input type="radio" name="dup-choice" checked={choice?.kind === "merge" && choice.cardId === d.id} onChange={() => setChoice({ kind: "merge", cardId: d.id })} />
                        <span>
                          <strong>① この名刺の情報を更新する</strong>
                          <span className="muted small">（同じ人・同じ会社。異動・昇進など）</span>
                        </span>
                      </label>
                      <label className="radio-card">
                        <input type="radio" name="dup-choice" checked={choice?.kind === "affiliate" && choice.cardId === d.id} onChange={() => setChoice({ kind: "affiliate", cardId: d.id })} />
                        <span>
                          <strong>同じ人の別の所属として登録する</strong>
                          <span className="muted small">（転職・兼務など。会社ごとに名刺を分けたまま、同じ人としてまとめます）</span>
                        </span>
                      </label>
                    </div>
                  ))}
                  <label className="radio-card">
                    <input type="radio" name="dup-choice" checked={choice?.kind === "new"} onChange={() => setChoice({ kind: "new" })} />
                    <span>
                      <strong>② 別の人として新しく登録する</strong>
                      <span className="muted small">（同姓同名・代表電話が同じだけ など）</span>
                    </span>
                  </label>
                  <p className="small">
                    ③ 登録しない場合は下の「今回の取り込みを破棄」、④ 迷う場合は「あとで確認」を押してください。
                  </p>

                  {choice?.kind === "merge" && targetCard && (
                    <div className="diff">
                      <h3>既存の名刺と違う項目</h3>
                      {diffKeys.length === 0 ? (
                        <p className="muted small">内容の違いはありません。交換の記録と今回の画像が追加されます。</p>
                      ) : (
                        <>
                          <p className="muted small">チェックした項目だけ今回の値に更新します。今回読み取れなかった（空欄の）項目は、既存の値をそのまま残します。メモ・タグ・過去の画像と履歴も残ります。</p>
                          {diffKeys.map((k) => (
                            <label key={k} className="diff-row">
                              <input
                                type="checkbox"
                                checked={updateFields.has(k)}
                                onChange={(e) =>
                                  setUpdateFields((s) => {
                                    const n = new Set(s);
                                    if (e.target.checked) n.add(k);
                                    else n.delete(k);
                                    return n;
                                  })
                                }
                              />
                              <span className="diff-label">{CARD_FIELDS.find((f) => f.key === k)!.label}</span>
                              <span className="diff-old">{targetCard.card[k] || "（空）"}</span>
                              <span aria-hidden="true">→</span>
                              <span className="diff-new">{fields[k]}</span>
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {canWrite && (
            <div className="review-actions">
              <div className="review-actions-main">
                {canEdit && (
                  <button className="btn btn-primary" onClick={commit} disabled={Boolean(busy) || remaining.length > 0 || needChoice}>
                    {busy === "commit" ? "登録しています…" : commitLabel}
                  </button>
                )}
                {canEdit && (
                  <button className="btn" disabled={Boolean(busy)} onClick={() => saveEdits(false).catch((e) => setError(errorMessage(e)))}>
                    下書き保存
                  </button>
                )}
                <button className="btn" disabled={Boolean(busy)} onClick={defer}>
                  あとで確認
                </button>
              </div>
            </div>
          )}
          {canWrite && (
            <div className="review-actions-sub">
                {(remaining.length > 0 || needChoice) && canEdit && (
                  <span className="small muted">{remaining.length > 0 ? `要確認があと ${remaining.length} 件あります` : "同じ人の名刺の扱いを選んでください"}</span>
                )}
                {savedAt && <span className="small muted">自動保存 {fmtDateTime(savedAt)}</span>}
                <button className="btn btn-small btn-danger-ghost" disabled={Boolean(busy)} onClick={discard}>
                  今回の取り込みを破棄
                </button>
              </div>
          )}
        </div>
      </div>
    </div>
  );
}
