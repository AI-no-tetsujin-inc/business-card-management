// 契約・サブスク管理: 会社で使っているサービスの一覧。個人名義・個人立替のものを目立たせ、会社名義・法人カードへの移行を追う
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { jpDate, monthLabel, today, yen } from "../lib/money";
import { FieldError, SkeletonList, useEditingGuard, useToast } from "../components/ui";

/** 次回更新日までの日数（日本時間の今日から） */
const daysToRenewal = (d: string | null) => (d ? Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400_000) : null);

interface Subscription {
  id?: string;
  service_name: string;
  holder: "company" | "personal";
  payment_method: "corporate_card" | "personal";
  amount: number | null;
  cycle: "monthly" | "yearly";
  renewal_date: string | null;
  accounts: string;
  admin_email: string;
  admin_name?: string | null;
  migration_status: "none" | "planned" | "done";
  migration_month: string | null;
  note: string;
  active?: number;
}

const HOLDER = { company: "会社名義", personal: "個人名義" };
const PAYMENT = { corporate_card: "法人カード", personal: "個人立替" };
const CYCLE = { monthly: "月額", yearly: "年額" };
const MIGRATION = { none: "—", planned: "移行予定", done: "移行済み" };

const isPersonal = (s: Subscription) => s.holder === "personal" || s.payment_method === "personal";

const empty = (email: string): Subscription => ({
  service_name: "",
  holder: "company",
  payment_method: "corporate_card",
  amount: null,
  cycle: "monthly",
  renewal_date: null,
  accounts: "",
  admin_email: email,
  migration_status: "none",
  migration_month: null,
  note: "",
});

export function SubscriptionsPage() {
  const { user } = useAuth();
  const readOnly = user.role === "viewer";
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [users, setUsers] = useState<{ email: string; name: string }[]>([]);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ subscriptions: Subscription[] }>("/api/subscriptions").then((r) => setSubs(r.subscriptions), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    api<{ users: { email: string; name: string }[] }>("/api/users").then((r) => setUsers(r.users), () => {});
  }, [load]);

  const toast = useToast();
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEditingGuard(editing);
  const save = async () => {
    if (!editing) return;
    setError("");
    const e: Record<string, string> = {};
    if (!editing.service_name.trim()) e.service_name = "サービス名を入力してください";
    if (editing.amount !== null && (!Number.isInteger(editing.amount) || editing.amount < 0)) e.amount = "金額は整数（円）で入力してください";
    if (editing.migration_status === "planned" && !editing.migration_month) e.migration_month = "移行予定月を選んでください";
    setErrs(e);
    if (Object.keys(e).length) return;
    try {
      if (editing.id) await api(`/api/subscriptions/${editing.id}`, { method: "PATCH", body: { ...editing, active: editing.active !== 0 } });
      else await api("/api/subscriptions", { body: editing });
      setEditing(null);
      toast("保存しました");
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const set = (patch: Partial<Subscription>) => setEditing((s) => (s ? { ...s, ...patch } : s));

  const active = subs?.filter((s) => s.active !== 0) ?? [];
  const personal = active.filter(isPersonal);
  // 金額が未登録のものは 0 円と同じにしない（判明分だけ合計し、未登録の件数を別に出す）
  const known = active.filter((s) => s.amount !== null);
  const unknownCount = active.length - known.length;
  const monthly = known.reduce((sum, s) => sum + (s.cycle === "yearly" ? Math.round(s.amount! / 12) : s.amount!), 0);
  const noRenewal = active.filter((s) => !s.renewal_date).length;

  return (
    <div className="page">
      <h1>契約・サブスク</h1>
      <p className="muted small">会社名義・法人カードに統一中です。更新日の7日前に Google Chat で設定された担当者にお知らせします。</p>
      {(() => {
        const soon = (subs ?? []).filter((s) => s.active !== 0 && (daysToRenewal(s.renewal_date) ?? 99) <= 30 && (daysToRenewal(s.renewal_date) ?? -1) >= 0);
        return soon.length ? (
          <p className="notice notice-info">
            30日以内に更新: {soon.map((s) => `${s.service_name}（${jpDate(s.renewal_date)}・あと${daysToRenewal(s.renewal_date)}日）`).join("、")}。解約・名義変更が必要なら更新日までに。
          </p>
        ) : null;
      })()}
      {personal.length > 0 && (
        <p className="notice notice-warn">
          個人名義・個人立替のサービスが {personal.length} 件あります（{personal.map((s) => s.service_name).join("、")}）。会社名義・法人カードへの移行を進めてください。
        </p>
      )}
      <div className="toolbar">
        <span className="small">
          有効 {active.length} 件 ・ 月あたりの目安（判明分） <strong>{known.length ? yen(monthly) : "—"}</strong>
          {unknownCount > 0 && <span className="status status-warn">金額未登録 {unknownCount} 件</span>}
          {noRenewal > 0 && <span className="status">更新日未登録 {noRenewal} 件（お知らせの対象外）</span>}
          <span className="muted">（年額は12で割って計算）</span>
        </span>
        {!readOnly && !editing && (
          <button className="btn btn-primary btn-small" onClick={() => setEditing(empty(user.email))}>
            ＋ サービスを追加
          </button>
        )}
      </div>
      {editing && (
        <div className="panel">
          <h2>{editing.id ? "サービスを編集" : "サービスを追加"}</h2>
          <div className="grid-2">
            <label className="stack">
              <span>サービス名</span>
              <input aria-invalid={Boolean(errs.service_name)} value={editing.service_name} onChange={(e) => set({ service_name: e.target.value })} placeholder="例: Microsoft 365" />
              <FieldError message={errs.service_name} />
            </label>
            <label className="stack">
              <span>利用アカウント・利用者</span>
              <input value={editing.accounts} onChange={(e) => set({ accounts: e.target.value })} placeholder="例: 登録された社内請求対象者（2ライセンス）" />
            </label>
            <label className="stack">
              <span>契約名義</span>
              <select value={editing.holder} onChange={(e) => set({ holder: e.target.value as Subscription["holder"] })}>
                {Object.entries(HOLDER).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>支払い方法</span>
              <select value={editing.payment_method} onChange={(e) => set({ payment_method: e.target.value as Subscription["payment_method"] })}>
                {Object.entries(PAYMENT).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>金額（円・税込）</span>
              <input aria-invalid={Boolean(errs.amount)} type="number" min={0} value={editing.amount ?? ""} onChange={(e) => set({ amount: e.target.value === "" ? null : Number(e.target.value) })} />
              <FieldError message={errs.amount} />
            </label>
            <label className="stack">
              <span>支払いサイクル</span>
              <select value={editing.cycle} onChange={(e) => set({ cycle: e.target.value as Subscription["cycle"] })}>
                {Object.entries(CYCLE).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>次回更新日</span>
              <input type="date" value={editing.renewal_date ?? ""} onChange={(e) => set({ renewal_date: e.target.value || null })} />
              <span className="small muted">空欄のままだと、更新日のお知らせ（7日前の Google Chat）は届きません</span>
            </label>
            <label className="stack">
              <span>管理者（管理アカウントを持つ人）</span>
              <select value={editing.admin_email} onChange={(e) => set({ admin_email: e.target.value })}>
                {!users.some((u) => u.email === editing.admin_email) && <option value={editing.admin_email}>{editing.admin_email || "（未設定）"}</option>}
                {users.map((u) => (
                  <option key={u.email} value={u.email}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>名義・支払いの移行</span>
              <select value={editing.migration_status} onChange={(e) => set({ migration_status: e.target.value as Subscription["migration_status"] })}>
                {Object.entries(MIGRATION).map(([k, l]) => (
                  <option key={k} value={k}>
                    {k === "none" ? "予定なし" : l}
                  </option>
                ))}
              </select>
            </label>
            {editing.migration_status === "planned" && (
              <label className="stack">
                <span>移行予定月</span>
                <input type="month" value={editing.migration_month ?? ""} onChange={(e) => set({ migration_month: e.target.value || null })} />
                <FieldError message={errs.migration_month} />
              </label>
            )}
          </div>
          <label className="stack">
            <span>メモ</span>
            <textarea rows={2} value={editing.note} onChange={(e) => set({ note: e.target.value })} />
          </label>
          {editing.id && (
            <label className="check-line">
              <input type="checkbox" checked={editing.active !== 0} onChange={(e) => set({ active: e.target.checked ? 1 : 0 })} />
              <span>利用中（解約したら外す）</span>
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>
              キャンセル
            </button>
            <button className="btn btn-primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        {subs === null ? (
          <SkeletonList rows={3} />
        ) : subs.length === 0 ? (
          <p className="muted">まだ登録されていません。</p>
        ) : (
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>サービス</th>
                  <th className="nowrap">名義・支払い</th>
                  <th className="nowrap">金額</th>
                  <th className="nowrap">次回更新日</th>
                  <th className="nowrap">管理者</th>
                  <th className="nowrap">移行</th>
                  {!readOnly && <th />}
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id} className={`${s.active === 0 ? "inactive" : ""} ${isPersonal(s) && s.active !== 0 ? "row-warn" : ""}`}>
                    <td>
                      <strong>{s.service_name}</strong>
                      {s.accounts && <div className="small muted">{s.accounts}</div>}
                      {s.note && <div className="small muted">{s.note}</div>}
                    </td>
                    <td className="nowrap">
                      <span className={`pill ${s.holder === "personal" ? "pill-error" : "pill-ok"}`}>{HOLDER[s.holder]}</span>{" "}
                      <span className={`pill ${s.payment_method === "personal" ? "pill-error" : "pill-ok"}`}>{PAYMENT[s.payment_method]}</span>
                    </td>
                    <td className="nowrap">
                      {s.amount !== null ? yen(s.amount) : <span className="muted">未登録</span>}
                      <div className="small muted">{CYCLE[s.cycle]}</div>
                    </td>
                    <td className="small nowrap">
                      {s.renewal_date ? jpDate(s.renewal_date) : <span className="muted">未登録（お知らせなし）</span>}
                      {(() => {
                        const d = daysToRenewal(s.renewal_date);
                        if (d === null || s.active === 0 || d < 0 || d > 30) return null;
                        return <div className={`status ${d <= 7 ? "status-warn" : "status-todo"}`}>あと{d}日</div>;
                      })()}
                    </td>
                    <td className="small nowrap">{s.admin_name ?? s.admin_email}</td>
                    <td className="small nowrap">
                      {MIGRATION[s.migration_status]}
                      {s.migration_status === "planned" && s.migration_month && <div>{monthLabel(s.migration_month)}</div>}
                    </td>
                    {!readOnly && (
                      <td>
                        <button className="btn btn-small" onClick={() => setEditing({ ...s })}>
                          編集
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
