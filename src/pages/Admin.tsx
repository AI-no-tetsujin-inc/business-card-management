import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/format";
import { viaLabel } from "../lib/next";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member" | "viewer";
  active: number;
  last_login_at: string | null;
}

interface AuditLog {
  id: string;
  user_name: string | null;
  via: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail: string;
  created_at: string;
}

interface UsageRow {
  purpose: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

const ROLE_LABEL = { admin: "管理者", member: "メンバー", viewer: "閲覧のみ" };
const ACTION_LABEL: Record<string, string> = {
  view: "閲覧",
  search: "検索",
  create: "登録",
  update: "更新",
  delete: "ごみ箱へ",
  restore: "復元",
  export: "CSV 出力",
  note: "メモ追加",
  connect: "AI 連携を許可",
  google_link: "Google 連携",
  member_update: "振込先・既定の品目の変更",
  invoice_edit: "請求書の文言の修正",
  google_unlink: "Google 連携を解除",
  disconnect: "AI 連携を解除",
  upload_image: "画像を追加",
  admin_user: "権限の変更",
  invoice: "請求のチェック",
  invoice_issue: "請求書の作成",
  invoice_check: "送付・連絡のチェック",
  quote_save: "見積書の保存",
  customer_create: "顧客の追加",
  customer_update: "顧客の変更",
  document_import: "過去の書類の取り込み",
  claim_submit: "社内請求の提出",
  claim_cancel: "社内請求の取り消し",
  claim_paid: "精算済みのチェック",
  receipt_original: "領収書原本のチェック",
  subscription_save: "サブスクの保存",
  settings_update: "設定の変更",
  contract_create: "契約の登録",
  contract_update: "契約の変更",
  task_create: "タスク登録",
  task_update: "タスク更新",
  task_done: "タスク完了",
  minutes_import: "議事録の取り込み",
  review_approve: "確認依頼を承認",
  review_reject: "確認依頼を却下",
  purge: "完全削除",
};
const PURPOSE_LABEL: Record<string, string> = { ocr: "名刺の読み取り（画面）", minutes: "A. 議事録の取り込み", dedupe: "B. 重複判定", verify: "C. データの検証" };

export function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<{ total_usd: number; since: string | null; budget_usd: number; by_purpose: UsageRow[] } | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [filter, setFilter] = useState({ user: "", via: "" });
  // 操作ログは最初の30件だけ出す（スマホで画面がとても長くならないように）
  const [logLimit, setLogLimit] = useState(30);
  const [error, setError] = useState("");

  const loadUsers = useCallback(() => {
    api<{ users: AdminUser[] }>("/api/admin/users").then((r) => setUsers(r.users), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    loadUsers();
    api<NonNullable<typeof usage>>("/api/admin/ai-usage").then(setUsage, () => {});
  }, [loadUsers]);
  useEffect(() => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    api<{ logs: AuditLog[] }>(`/api/admin/audit?${q}`).then((r) => setLogs(r.logs), () => {});
  }, [filter]);

  const updateUser = async (id: string, patch: { role?: string; active?: boolean }) => {
    if (patch.active === false && !confirm("このアカウントを無効にします。ログイン状態と ChatGPT / Claude との連携がすべて切れます。")) return;
    try {
      await api(`/api/admin/users/${id}`, { body: patch });
      loadUsers();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const pct = usage ? Math.min(100, (usage.total_usd / usage.budget_usd) * 100) : 0;

  return (
    <div className="page">
      <h1>管理</h1>
      {error && <p className="error">{error}</p>}

      <section className="panel">
        <h2>AI 利用状況（累計）</h2>
        {usage && (
          <>
            <p>
              <strong>${usage.total_usd.toFixed(2)}</strong> / ${usage.budget_usd}（{pct.toFixed(1)}%）
              {usage.since && <span className="muted small"> ・ {fmtDateTime(usage.since)} からの累計</span>}
            </p>
            <div className="meter">
              <div style={{ width: `${pct}%` }} />
            </div>
            {usage.total_usd >= usage.budget_usd ? (
              <p className="notice notice-error small">累計が上限（${usage.budget_usd}）に達したため、AI の処理（名刺の読み取りなど）をすべて止めています。名刺は手入力で登録できます。月が変わっても自動では再開しません。</p>
            ) : (
              <p className="muted small">月ごとではなく、これまでの累計です。累計が ${usage.budget_usd} に達すると、AI の処理を自動で止めます（名刺は手入力に切り替わります）。</p>
            )}
            {usage.by_purpose.length > 0 ? (
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>処理</th>
                    <th>モデル</th>
                    <th>回数</th>
                    <th>トークン（入力 / 出力）</th>
                    <th>概算費用</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_purpose.map((r) => (
                    <tr key={r.purpose + r.model}>
                      <td>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
                      <td>{r.model}</td>
                      <td>{r.calls}</td>
                      <td>
                        {r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}
                      </td>
                      <td>${r.cost_usd.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">まだ使っていません。</p>
            )}
          </>
        )}
      </section>

      <SetupStatus />

      <SettingsForm />

      <JobRunner />
      <VoissPackage />

      <section className="panel">
        <h2>メンバー</h2>
        <table className="simple-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>メール</th>
              <th>権限</th>
              <th>状態</th>
              <th>最終ログイン</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? "" : "inactive"}>
                <td>{u.name || "（未登録）"}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me.id} onChange={(e) => updateUser(u.id, { role: e.target.value })}>
                    {Object.entries(ROLE_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {u.id === me.id ? (
                    "有効"
                  ) : (
                    <button className="btn btn-small" onClick={() => updateUser(u.id, { active: !u.active })}>
                      {u.active ? "無効にする" : "有効に戻す"}
                    </button>
                  )}
                </td>
                <td className="small">{fmtDateTime(u.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          管理者: 全操作＋CSV 出力・メンバー管理 ／ メンバー: 閲覧・登録・編集 ／ 閲覧のみ: 見るだけ（新人向け）。無効にすると画面にも AI 連携にもアクセスできなくなります。
        </p>
      </section>

      <section className="panel">
        <h2>操作ログ</h2>
        <div className="toolbar">
          <select value={filter.user} onChange={(e) => setFilter({ ...filter, user: e.target.value })} aria-label="ユーザー">
            <option value="">全員</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
          <select value={filter.via} onChange={(e) => setFilter({ ...filter, via: e.target.value })} aria-label="経路">
            <option value="">すべての経路</option>
            <option value="web">画面</option>
            <option value="ai">AI（ChatGPT / Claude）</option>
          </select>
        </div>
        <table className="simple-table">
          <thead>
            <tr>
              <th>日時</th>
              <th>誰が</th>
              <th>どこから</th>
              <th>操作</th>
              <th>対象</th>
            </tr>
          </thead>
          <tbody>
            {logs.slice(0, logLimit).map((l) => {
              const detail = JSON.parse(l.detail || "{}");
              return (
                <tr key={l.id}>
                  <td className="small">{fmtDateTime(l.created_at)}</td>
                  <td>{l.user_name ?? "—"}</td>
                  <td>{viaLabel(l.via) || "画面"}</td>
                  <td>{ACTION_LABEL[l.action] ?? l.action}</td>
                  <td className="small">
                    {l.target_type === "card" && l.target_id ? (
                      <Link to={`/cards/${l.target_id}`}>{l.target_label ?? "名刺"}</Link>
                    ) : detail.q ? (
                      `「${detail.q}」${detail.hits ?? 0}件`
                    ) : detail.count ? (
                      `${detail.count}件`
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {logs.length > logLimit && (
          <p>
            <button className="btn btn-small" onClick={() => setLogLimit((n) => n + 50)}>
              もっと見る（残り {logs.length - logLimit} 件）
            </button>
          </p>
        )}
      </section>
    </div>
  );
}

function JobRunner() {
  const { features } = useAuth();
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [result, setResult] = useState("");
  useEffect(() => {
    api<{ jobs: Record<string, string> }>("/api/admin/jobs").then((r) => setJobs(r.jobs), () => {});
  }, []);
  const run = async (job: string) => {
    setResult("実行中…");
    try {
      const r = await api<{ result: string }>(`/api/admin/jobs/${job}`, { body: {} });
      setResult(r.result);
    } catch (e) {
      setResult(errorMessage(e));
    }
  };
  // 議事録・つながりまわりは有効なときだけ出す
  const hidden = [
    ...(features.minutes ? [] : ["minutes-digest", "task-reminder", "minutes-scan"]),
    ...(features.graph ? [] : ["quality-scan", "review-reminder"]),
  ];
  return (
    <section className="panel">
      <h2>定期処理（手動実行）</h2>
      <p className="muted small">
        通常は自動で動きます（毎月15日 9時: 顧客請求書の作成開始 ／ 9〜19時の毎時: 送付・連絡の未チェック ／ 月末・1日 9時: 社内請求の期限 ／ 月末10時・1日10〜18時: 領収書原本 ／ 毎日9時: サブスク更新日{features.minutes ? " ／ 議事録: 毎日20時に今日の AIの鉄人、9時に期限が近いタスク" : ""}）。手動実行は日付の条件を無視して今すぐ送ります。
      </p>
      <div className="row wrap">
        {Object.entries(jobs)
          .filter(([k]) => !hidden.includes(k))
          .map(([k, label]) => (
            <button key={k} className="btn btn-small" onClick={() => run(k)}>
              {label}
            </button>
          ))}
      </div>
      {result && <pre className="job-result">{result}</pre>}
    </section>
  );
}

const SETTING_FIELDS: { key: string; label: string; rows?: number; hint?: string }[] = [
  { key: "drive_parent_id", label: "Google Drive の保存先（親フォルダの ID）", hint: "共有ドライブ URL の folders/ のあと。ここに「顧客請求書」「見積書」「社内請求・経費」フォルダを自動で作ります" },
  { key: "mail_from", label: "メールの送信元（Gmail）", hint: "「Google と連携」したアカウントが自動で入ります" },
  { key: "billing_admin_email", label: "請求・サブスクのお知らせ先" },
  { key: "claim_payer_email", label: "社内請求を受け取る代表", hint: "支払いをする代表のメールアドレス。全員の請求書がそろったら、この人を Google Chat でメンションして「税理士に送ってください」と連絡します" },
  { key: "company_name", label: "会社名" },
  { key: "company_kana", label: "会社名（カナ）" },
  { key: "company_representative", label: "代表者" },
  { key: "company_postal", label: "郵便番号" },
  { key: "company_address1", label: "住所1" },
  { key: "company_address2", label: "住所2" },
  { key: "company_tel", label: "電話番号" },
  { key: "company_email", label: "メールアドレス（書類に記載）" },
  { key: "bank_lines", label: "振込先（請求書に記載）", rows: 3 },
  { key: "invoice_note", label: "請求書の備考（共通）", rows: 3 },
  { key: "subscription_notice_days", label: "サブスク更新の何日前に知らせるか" },
  { key: "chat_reminder_start_hour", label: "未チェック通知の開始時刻（時）" },
  { key: "chat_reminder_end_hour", label: "未チェック通知の終了時刻（時）" },
];

function SettingsForm() {
  const { refreshUser } = useAuth();
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api<{ settings: Record<string, string> }>("/api/settings").then((r) => setSettings(r.settings), () => {});
  }, []);
  if (!settings) return null;
  const save = async () => {
    setMessage("");
    try {
      await api("/api/admin/settings", { method: "PATCH", body: settings });
      setMessage("保存しました");
      refreshUser();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };
  return (
    <section className="panel">
      <h2>会社情報・保存先・通知</h2>
      <div className="grid-2">
        {SETTING_FIELDS.filter((f) => !f.rows).map((f) => (
          <label key={f.key} className="stack">
            <span>{f.label}</span>
            <input value={settings[f.key] ?? ""} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
            {f.hint && <span className="small muted">{f.hint}</span>}
          </label>
        ))}
      </div>
      {SETTING_FIELDS.filter((f) => f.rows).map((f) => (
        <label key={f.key} className="stack">
          <span>{f.label}</span>
          <textarea rows={f.rows} value={settings[f.key] ?? ""} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
        </label>
      ))}
      <label className="check-line">
        <input type="checkbox" checked={settings.feature_minutes === "1"} onChange={(e) => setSettings({ ...settings, feature_minutes: e.target.checked ? "1" : "0" })} />
        <span>議事録・タスクを使う（Voiss からの文字起こしの受け取り、Drive への保存、議事録スペースへの通知、毎日20時のまとめ）</span>
      </label>
      <label className="check-line">
        <input type="checkbox" checked={settings.feature_graph === "1"} onChange={(e) => setSettings({ ...settings, feature_graph: e.target.checked ? "1" : "0" })} />
        <span>つながり・確認依頼を使う（今はスコープ外。オンにすると、案件・重複判定も動きます。人物は名刺交換した人だけを登録し、議事録からは登録しません）</span>
      </label>
      <div className="actions">
        {message && <span className="small">{message}</span>}
        <button className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </section>
  );
}

interface StatusItem {
  key: string;
  label: string;
  ok: boolean;
  note: string;
}

function SetupStatus() {
  const [status, setStatus] = useState<{ items: StatusItem[]; mcp_url: string } | null>(null);
  useEffect(() => {
    api<{ items: StatusItem[]; mcp_url: string }>("/api/admin/status").then(setStatus, () => {});
  }, []);
  if (!status) return null;
  const done = status.items.filter((i) => i.ok).length;
  return (
    <section className="panel">
      <h2>
        設定状況（{done}/{status.items.length}）
      </h2>
      <ul className="plain-list">
        {status.items.map((i) => (
          <li key={i.key}>
            <span className={`pill ${i.ok ? "pill-ok" : "pill-warn"}`}>{i.ok ? "設定済み" : "未設定"}</span> <strong>{i.label}</strong>
            <span className="muted small"> {i.note}</span>
          </li>
        ))}
      </ul>
      <GoogleCheck />
      <p className="small">
        ChatGPT / Claude に登録する接続先: <code>{status.mcp_url}</code>
      </p>
    </section>
  );
}

function GoogleCheck() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<{ link: { email: string; linked_at: string; last_error: string | null } | null; login_ready: boolean } | null>(null);
  const [results, setResults] = useState<{ label: string; ok: boolean; note: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const flash = params.get("google");
  const load = useCallback(() => {
    api<NonNullable<typeof status>>("/api/admin/google-link").then(setStatus, () => {});
  }, []);
  useEffect(load, [load]);
  const run = async () => {
    setBusy(true);
    try {
      setResults((await api<{ results: { label: string; ok: boolean; note: string }[] }>("/api/admin/google-check", { body: {} })).results);
    } catch (e) {
      setResults([{ label: "接続テスト", ok: false, note: errorMessage(e) }]);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (!confirm("Google 連携を解除します。書類の Drive 保存とお知らせメールが止まります。よろしいですか？")) return;
    await api("/api/admin/google-link", { method: "DELETE" }).catch(() => {});
    setResults(null);
    load();
  };
  // 連携から戻ってきたら、そのまま接続テストを行う
  useEffect(() => {
    if (flash === "linked") run();
  }, [flash]);
  if (!status) return null;
  return (
    <div className="panel panel-info">
      <h3>Google 連携（書類の Drive 保存・お知らせメール）</h3>
      {flash && (
        <p className={`notice ${flash === "linked" ? "notice-ok" : "notice-error"}`}>
          {flash === "linked" ? "Google と連携しました" : flash}{" "}
          <button className="link-button" onClick={() => setParams({}, { replace: true })}>
            閉じる
          </button>
        </p>
      )}
      {status.link ? (
        <p className="small">
          <span className={`pill ${status.link.last_error ? "pill-error" : "pill-ok"}`}>{status.link.last_error ? "要再連携" : "連携中"}</span> <strong>{status.link.email}</strong> の権限で、共有ドライブへの保存とメール送信を行います（{fmtDateTime(status.link.linked_at)} に連携）
          {status.link.last_error && <span className="error"> {status.link.last_error}</span>}
        </p>
      ) : (
        <p className="small muted">まだ連携していません。メールの送信元にしたいアカウント（設定された担当者）でログインした状態で押してください。共有ドライブのメンバー（コンテンツ管理者以上）である必要があります。</p>
      )}
      <div className="row wrap">
        {status.login_ready ? (
          <a className={`btn btn-small ${status.link && !status.link.last_error ? "" : "btn-primary"}`} href="/auth/google-link">
            {status.link ? "連携し直す" : "Google と連携"}
          </a>
        ) : (
          <span className="small muted">先に Google ログイン（GOOGLE_CLIENT_ID / SECRET）を設定してください</span>
        )}
        {status.link && (
          <button className="btn btn-small" disabled={busy} onClick={run}>
            {busy ? "確認中…" : "接続テスト"}
          </button>
        )}
        {status.link && (
          <button className="btn btn-small btn-danger-ghost" onClick={unlink}>
            連携を解除
          </button>
        )}
      </div>
      {results && (
        <ul className="plain-list">
          {results.map((r) => (
            <li key={r.label}>
              <span className={`pill ${r.ok ? "pill-ok" : "pill-error"}`}>{r.ok ? "OK" : "NG"}</span> <strong>{r.label}</strong>
              <span className="muted small"> {r.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Voiss（Mac の録音アプリ）の配布用 zip を置く。取引先・社員の名前の辞書が入るので、ログインした人だけが落とせる */
function VoissPackage() {
  const { features } = useAuth();
  const [info, setInfo] = useState<{ available: boolean; file_name?: string; size?: number; uploaded_at?: string } | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(() => {
    api<typeof info>("/api/voiss/package").then(setInfo, (e) => setMessage(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  if (!features.minutes) return null;

  const upload = async (file: File) => {
    setMessage("");
    try {
      const res = await fetch("/api/admin/voiss/package", {
        method: "PUT",
        headers: { "content-type": "application/zip", "x-file-name": encodeURIComponent(file.name) },
        body: file,
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `置けませんでした（${res.status}）`);
      setMessage(`${file.name} を置きました`);
      load();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <section className="panel">
      <h2>Voiss の配布</h2>
      <p className="muted small">
        議事録画面とプロフィールの「Voiss をダウンロード」で落とせる zip です（ログインした人だけ）。作り直すときは Mac で <code>/Applications/Voiss/tools/make_dist.sh</code> を実行し、できた zip をここで置き換えます。
      </p>
      <p className="small">
        {info === null
          ? "読み込み中…"
          : info.available
            ? `いま置いてあるもの: ${info.file_name}（${Math.round((info.size ?? 0) / 1024)}KB・${fmtDateTime(info.uploaded_at)}）`
            : "まだ置いていません。"}
      </p>
      <label className="btn btn-small">
        zip を選んで置く
        <input type="file" accept=".zip,application/zip" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </label>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
