import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, downloadCsv, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Thumb } from "../components/CardImage";
import { BottomSheet, SkeletonList, useToast } from "../components/ui";
import { fmtDate, parseTags } from "../lib/format";
import type { CardRow } from "../types";

interface Props {
  trash?: boolean;
}

const SORTS = { company: "会社名順", recent: "登録が新しい順", exchanged: "交換日が新しい順", name: "氏名順" } as const;
/** 一覧の検索条件（詳細から戻るときに使う） */
export const LAST_LIST_KEY = "meishi:last-list";
const scrollKey = (search: string) => `meishi:scroll:${search}`;

const session = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* 保存できなくても動く */
    }
  },
};

export function CardsPage({ trash = false }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user.role === "admin";
  const canWrite = user.role !== "viewer";
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [companies, setCompanies] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qInput, setQInput] = useState(params.get("q") ?? "");
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [sheet, setSheet] = useState(false);
  // スマホではふだんチェックボックスを隠し、「選択」を押したときだけ出す（一覧を広く使う）
  const [selecting, setSelecting] = useState(false);
  const restored = useRef(false);

  const sort = params.get("sort") ?? "company";
  const view = params.get("view") ?? "group";
  const company = params.get("company") ?? "";
  const filterCount = [params.get("user"), params.get("tag"), sort !== "company" ? sort : "", view !== "group" ? view : ""].filter(Boolean).length;
  const hasCondition = Boolean(params.get("q") || params.get("user") || params.get("tag") || company);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clearConditions = () => {
    setQInput("");
    const next = new URLSearchParams();
    if (params.get("view")) next.set("view", params.get("view")!);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api<{ users: { id: string; name: string }[] }>("/api/users").then((r) => setUsers(r.users), () => {});
    api<{ tags: string[] }>("/api/tags").then((r) => setTags(r.tags), () => {});
    api<{ companies: { company_name: string }[] }>("/api/companies").then((r) => setCompanies(r.companies.map((c) => c.company_name).filter(Boolean)), () => {});
  }, []);

  // 検索語は入力が止まってから反映（日本語の変換中は反映しない）
  useEffect(() => {
    if (composing) return;
    const t = setTimeout(() => qInput !== (params.get("q") ?? "") && setParam("q", qInput), 300);
    return () => clearTimeout(t);
  }, [qInput, composing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = new URLSearchParams(params);
    q.delete("view");
    if (trash) q.set("trash", "1");
    setLoading(true);
    setError("");
    api<{ cards: CardRow[] }>(`/api/cards?${q}`).then(
      (r) => {
        setCards(r.cards);
        setLoading(false);
      },
      (e) => {
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    if (!trash) session.set(LAST_LIST_KEY, params.toString() ? `?${params}` : "");
  }, [params, trash, reloadKey]);

  // 詳細から戻ったときにスクロール位置を戻す
  useLayoutEffect(() => {
    if (!cards || restored.current) return;
    restored.current = true;
    const y = Number(session.get(scrollKey(params.toString())) ?? 0);
    if (y > 0) window.scrollTo(0, y);
  }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  // 画面を離れる瞬間（一覧が消える前）に位置を保存して聞くのをやめる。
  // useEffect の後片付けは遅れて走るため、詳細画面に切り替わって縮んだときのスクロールで上書きされてしまう
  useLayoutEffect(() => {
    const key = scrollKey(params.toString());
    // 一覧を表示し終える前（読み込み中）の位置では上書きしない
    const save = () => restored.current && session.set(key, String(window.scrollY));
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      save();
    };
  }, [params]);

  const groups = useMemo(() => {
    if (!cards) return [];
    const map = new Map<string, CardRow[]>();
    for (const c of cards) {
      const list = map.get(c.company_key) ?? [];
      list.push(c);
      map.set(c.company_key, list);
    }
    // 見出しには表記ゆれの中で一番長い（略さない）会社名を使う
    const label = (list: CardRow[]) => list.map((c) => c.company_name).reduce((a, b) => (b.length > a.length ? b : a), "");
    return [...map.entries()].map(([key, list]) => ({ key, name: label(list) || "（会社名なし）", cards: list }));
  }, [cards]);

  // 検索候補: 会社名と、表示中の人の氏名
  const suggestions = useMemo(() => [...new Set([...companies, ...(cards ?? []).map((c) => c.person_name).filter(Boolean)])].slice(0, 200), [companies, cards]);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  const allIds = cards?.map((c) => c.id) ?? [];
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const exportCsv = async () => {
    try {
      await downloadCsv([...selected]);
      toast(`${selected.size} 件を CSV に出力しました`);
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  const restore = async (id: string) => {
    try {
      await api(`/api/cards/${id}/restore`, { body: {} });
      toast("ごみ箱から復元しました");
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  const moveToTrash = async (c: CardRow) => {
    try {
      await api(`/api/cards/${c.id}/delete`, { body: {} });
      setReloadKey((k) => k + 1);
      toast(`${c.person_name || "名刺"} をごみ箱に移動しました`, { action: { label: "元に戻す", onClick: () => restore(c.id) } });
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  const purge = async (id: string) => {
    if (!confirm("画像・履歴・メモごと完全に削除します。元に戻せません。よろしいですか？")) return;
    try {
      await api(`/api/admin/cards/${id}/purge`, { body: {} });
      toast("完全に削除しました");
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  };

  const companyName = company && cards?.[0]?.company_name;

  const filters = (
    <>
      <label className="stack">
        <span>並び順</span>
        <select value={sort} onChange={(e) => setParam("sort", e.target.value)}>
          {Object.entries(SORTS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="stack">
        <span>登録者</span>
        <select value={params.get("user") ?? ""} onChange={(e) => setParam("user", e.target.value)}>
          <option value="">すべて</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      {tags.length > 0 && (
        <label className="stack">
          <span>タグ</span>
          <select value={params.get("tag") ?? ""} onChange={(e) => setParam("tag", e.target.value)}>
            <option value="">すべて</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {!trash && (
        <div className="stack">
          <span>表示</span>
          <div className="segmented" role="group" aria-label="表示">
            <button aria-pressed={view === "group"} className={view === "group" ? "active" : ""} onClick={() => setParam("view", "group")}>
              会社ごと
            </button>
            <button aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setParam("view", "list")}>
              一覧
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={`page ${selecting || selected.size > 0 ? "selecting" : ""}`}>
      <div className="page-head">
        <h1>{trash ? "ごみ箱" : companyName ? companyName : "名刺"}</h1>
        {!trash && (
          <div className="row">
            <Link className="btn" to="/trash">
              ごみ箱
            </Link>
            {canWrite && (
              <Link className="btn btn-primary desktop-only" to="/upload">
                ＋ 名刺を登録
              </Link>
            )}
          </div>
        )}
      </div>
      {trash && <p className="muted small">ごみ箱の名刺は30日後に画像ごと自動で完全に削除されます。それまでは復元できます。</p>}
      {company && (
        <p>
          <button className="link-button" onClick={() => setParam("company", "")}>
            ‹ すべての会社を表示
          </button>
        </p>
      )}

      <div className="list-toolbar">
        <input
          className="search"
          type="search"
          list="card-suggestions"
          placeholder="氏名・会社名・メール・メモなどで検索"
          aria-label="名刺を検索"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            setQInput(e.currentTarget.value);
          }}
        />
        <datalist id="card-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="list-filters desktop-only">{filters}</div>
        <button className="btn mobile-only" aria-haspopup="dialog" onClick={() => setSheet(true)}>
          絞り込み・表示{filterCount > 0 && <span className="badge">{filterCount}</span>}
        </button>
      </div>
      <BottomSheet open={sheet} title="絞り込み・表示" onClose={() => setSheet(false)}>
        {filters}
        <div className="actions">
          <button className="btn" onClick={clearConditions}>
            条件をクリア
          </button>
          <button className="btn btn-primary" onClick={() => setSheet(false)}>
            {cards ? `${cards.length} 件を表示` : "表示"}
          </button>
        </div>
      </BottomSheet>

      <div className="list-status" aria-live="polite">
        {cards && !error && (
          <span className="muted small">
            {cards.length} 件{loading && " ・ 更新中…"}
          </span>
        )}
        {cards && cards.length > 0 && isAdmin && !trash && (
          <button
            className="link-button small mobile-only"
            onClick={() => {
              if (selecting || selected.size) setSelected(new Set());
              setSelecting(!(selecting || selected.size > 0));
            }}
          >
            {selecting || selected.size > 0 ? "選択をやめる" : "選択して CSV 出力"}
          </button>
        )}
      </div>

      {error ? (
        <div className="notice notice-error" role="alert">
          <p>名刺を読み込めませんでした（{error}）。通信状態を確認してください。</p>
          <button className="btn btn-small" onClick={() => setReloadKey((k) => k + 1)}>
            再読み込み
          </button>
        </div>
      ) : cards === null ? (
        <SkeletonList />
      ) : cards.length === 0 ? (
        <div className="empty">
          {trash ? (
            "ごみ箱は空です。"
          ) : hasCondition ? (
            <>
              <p>条件に合う名刺がありません。</p>
              <button className="btn btn-small" onClick={clearConditions}>
                条件をクリア
              </button>
            </>
          ) : (
            <>
              <p>まだ名刺がありません。</p>
              {canWrite && (
                <Link className="btn btn-primary btn-small" to="/upload">
                  最初の名刺を登録する
                </Link>
              )}
            </>
          )}
        </div>
      ) : view === "group" && !trash && sort === "company" ? (
        groups.map((g) => {
          const ids = g.cards.map((c) => c.id);
          return (
            <section key={g.key} className="group">
              <div className="group-head">
                <label className="check-line">
                  {isAdmin && <input type="checkbox" aria-label={`${g.name} の名刺をすべて選択`} checked={ids.every((id) => selected.has(id))} onChange={(e) => toggle(ids, e.target.checked)} />}
                  <span className="group-name">{g.name}</span>
                </label>
                <span className="muted small">{g.cards.length}名</span>
              </div>
              <CardList cards={g.cards} selected={selected} toggle={toggle} selectable={isAdmin} onTrash={canWrite ? moveToTrash : undefined} />
            </section>
          );
        })
      ) : (
        <CardList cards={cards} selected={selected} toggle={toggle} trash={trash} onRestore={restore} onPurge={isAdmin ? purge : undefined} selectable={isAdmin} onTrash={canWrite && !trash ? moveToTrash : undefined} />
      )}
      {view === "group" && sort !== "company" && !trash && <p className="muted small">※「会社ごと」表示は会社名順のときに使えます。</p>}

      {/* CSV 出力の操作は、名刺を選んだときだけ出す */}
      {isAdmin && selected.size > 0 && (
        <div className="selection-bar floating" role="region" aria-label="選択した名刺の操作">
          <span>{selected.size} 件を選択中</span>
          <label className="check-line small">
            <input type="checkbox" checked={allSelected} onChange={(e) => toggle(allIds, e.target.checked)} />
            すべて選択（{allIds.length}件）
          </label>
          <button className="btn btn-primary btn-small" onClick={exportCsv}>
            CSV 出力
          </button>
          <button className="link-button" onClick={() => setSelected(new Set())}>
            選択を解除
          </button>
        </div>
      )}
    </div>
  );
}

function CardList({ cards, selected, toggle, trash, onRestore, onPurge, onTrash, selectable }: {
  onPurge?: (id: string) => void;
  onTrash?: (c: CardRow) => void;
  selectable: boolean;
  cards: CardRow[];
  selected: Set<string>;
  toggle: (ids: string[], on: boolean) => void;
  trash?: boolean;
  onRestore?: (id: string) => void;
}) {
  return (
    <ul className="list">
      {cards.map((c) => (
        <SwipeRow key={c.id} card={c} onTrash={trash ? undefined : onTrash}>
          {!trash && selectable && (
            <input type="checkbox" className="row-check" aria-label={`${c.person_name} を選択`} checked={selected.has(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} />
          )}
          <Link to={`/cards/${c.id}`} className="list-item">
            <Thumb imageKey={c.front_display_key} alt={`${c.person_name} の名刺`} />
            <div className="list-main">
              <div className="list-title">
                {c.person_name || "（氏名なし）"}
                {c.person_name_kana && <span className="kana">{c.person_name_kana}</span>}
              </div>
              <div className="list-sub">{[c.company_name, c.department, c.title].filter(Boolean).join(" ・ ")}</div>
              <div className="list-meta">{[c.email, c.phone || c.mobile].filter(Boolean).join(" ・ ")}</div>
              <div className="list-meta">
                登録: {c.created_by_name}（{fmtDate(c.created_at)}）
                {c.exchanged_on && ` ・ 交換日 ${fmtDate(c.exchanged_on)}`}
                {trash && c.deleted_at && ` ・ 削除 ${fmtDate(c.deleted_at)}`}
              </div>
            </div>
            <div className="list-badges">
              {c.exchange_count > 1 && <span className="pill pill-info">{c.exchange_count}人が交換</span>}
              {(c.other_affiliations ?? 0) > 0 && <span className="pill">別の所属 {c.other_affiliations}</span>}
              {parseTags(c.tags).map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          </Link>
          {trash && onRestore && (
            <div className="row">
              <button className="btn btn-small" onClick={() => onRestore(c.id)}>
                復元
              </button>
              {onPurge && (
                <button className="btn btn-small btn-danger-ghost" onClick={() => onPurge(c.id)}>
                  完全に削除
                </button>
              )}
            </div>
          )}
        </SwipeRow>
      ))}
    </ul>
  );
}

const ACTION_WIDTH = 216;

/**
 * スマホでは左にスワイプすると操作ボタン（電話・メール・ごみ箱）が出る。即削除はしない（ごみ箱は「元に戻す」付き）。
 * 同じ操作は「…」ボタンや詳細画面からもできる。縦スクロールと区別するため、横の動きがはっきりしたときだけ反応する
 */
function SwipeRow({ card, onTrash, children }: { card: CardRow; onTrash?: (c: CardRow) => void; children: React.ReactNode }) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(null);
  const tel = card.mobile || card.phone;
  const hasActions = Boolean(tel || card.email || onTrash);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, base: open ? -ACTION_WIDTH : 0, horizontal: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (s.horizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) s.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
    if (!s.horizontal) return;
    setOffset(Math.max(-ACTION_WIDTH, Math.min(0, s.base + dx)));
  };
  const onTouchEnd = () => {
    const s = start.current;
    start.current = null;
    if (!s?.horizontal) return;
    const willOpen = offset < -ACTION_WIDTH / 2;
    setOpen(willOpen);
    setOffset(willOpen ? -ACTION_WIDTH : 0);
  };
  const toggle = () => {
    setOpen(!open);
    setOffset(open ? 0 : -ACTION_WIDTH);
  };

  if (!hasActions) return <li className="list-row">{children}</li>;
  return (
    <li className={`list-row swipe-row ${open ? "open" : ""} ${offset ? "swiping" : ""}`}>
      <div className="swipe-actions" aria-hidden={!open}>
        {tel && (
          <a className="swipe-btn" href={`tel:${tel.replace(/[^\d+]/g, "")}`} tabIndex={open ? 0 : -1}>
            電話
          </a>
        )}
        {card.email && (
          <a className="swipe-btn" href={`mailto:${card.email}`} tabIndex={open ? 0 : -1}>
            メール
          </a>
        )}
        {onTrash && (
          <button className="swipe-btn swipe-danger" tabIndex={open ? 0 : -1} onClick={() => onTrash(card)}>
            ごみ箱
          </button>
        )}
      </div>
      <div
        className="swipe-content"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClickCapture={(e) => {
          // 開いている状態で本体をタップしたら閉じるだけにする
          if (open && !(e.target as HTMLElement).closest(".row-more")) {
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }
        }}
      >
        {children}
        <button className="row-more" aria-label={`${card.person_name || "名刺"} の操作`} aria-expanded={open} onClick={toggle}>
          …
        </button>
      </div>
    </li>
  );
}
