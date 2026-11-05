import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/format";
import { useSearchParams } from "react-router";
import { CopyButton, Hint, useToast } from "../components/ui";

interface Connection {
  id: string;
  client_name: string;
  created_at: string;
}

const ROLE_LABEL = { admin: "管理者", member: "メンバー", viewer: "閲覧のみ" };

export function ProfilePage() {
  const { user, features, refreshUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [message, setMessage] = useState("");
  const [connections, setConnections] = useState<Connection[] | null>(null);

  const loadConnections = useCallback(() => {
    api<{ connections: Connection[] }>("/api/connections").then((r) => setConnections(r.connections), () => setConnections([]));
  }, []);
  useEffect(loadConnections, [loadConnections]);

  const revoke = async (c: Connection) => {
    if (!confirm(`${c.client_name} との連携を解除します。もう一度使うには AI アプリ側で接続し直します。`)) return;
    await api(`/api/connections/${c.id}/revoke`, { body: {} });
    loadConnections();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/profile", { body: { name } });
      await refreshUser();
      setMessage("保存しました");
    } catch (err) {
      setMessage(errorMessage(err));
    }
  };

  const logout = async () => {
    await api("/auth/logout", { body: {} });
    location.href = "/login";
  };

  return (
    <div className="page narrow">
      <h1>プロフィール</h1>
      <form className="panel" onSubmit={save}>
        <label className="stack">
          <span>メールアドレス</span>
          <input value={user.email} disabled />
        </label>
        <label className="stack">
          <span>表示名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <p className="muted small">権限: {ROLE_LABEL[user.role]}</p>
        <div className="row">
          <button className="btn btn-primary" type="submit">
            保存
          </button>
          {message && <span className="muted">{message}</span>}
        </div>
      </form>
      <CalendarPanel />
      {features.minutes && user.role !== "viewer" && <VoissPanel />}
      <div className="panel">
        <h2>ChatGPT / Claude との連携</h2>
        <p className="muted small">ChatGPT や Claude から「〇〇さんの連絡先を教えて」「10月分の請求書を作って」と頼めるようになります。連携は AI アプリ側の設定から始めます（このアプリにはボタンがありません）。</p>
        <div className="mcp-url">
          <span className="small muted">接続先 URL</span>
          <code>{`${location.origin}/mcp`}</code>
          <CopyButton value={`${location.origin}/mcp`} label="接続先 URL" />
        </div>
        <Hint summary="ChatGPT でつなぐ手順">
          <ol className="steps">
            <li>
              <strong>最初に管理者が1回だけ</strong>: ChatGPT のワークスペース設定で、名刺管理を「アプリ（プラグイン）」として追加します。メニューは「ワークスペース設定 → アプリ（またはプラグイン）→ 作成」です。見当たらなければ「権限とロール → 接続データ」で開発者モード（カスタム MCP の作成）をオンにします。
            </li>
            <li>名前は「名刺管理」、URL に上の接続先 URL を貼り、認証は「OAuth」を選んで作成し、ワークスペースに公開します。</li>
            <li>各自: ChatGPT の「設定 → アプリ」で「名刺管理」を選んで「接続」を押します。</li>
            <li>このアプリのログイン画面が開くので、社内の Google アカウントでログインし「許可する」を押します。</li>
            <li>チャットで「名刺管理で〇〇さんを探して」のように頼みます。</li>
          </ol>
          <p className="small muted">ChatGPT の Business / Enterprise プランで使えます。メニューの名前は ChatGPT の更新で変わることがあります。</p>
        </Hint>
        <Hint summary="Claude でつなぐ手順">
          <ol className="steps">
            <li>
              <strong>最初にオーナーが1回だけ</strong>: Claude の「組織の設定 → コネクタ」で「カスタムコネクタを追加」を押し、名前「名刺管理」と上の接続先 URL を入れて追加します。
            </li>
            <li>各自: Claude の「設定 → コネクタ」で「名刺管理」の「接続」を押します。</li>
            <li>このアプリのログイン画面が開くので、社内の Google アカウントでログインし「許可する」を押します。</li>
          </ol>
        </Hint>
        <h3>連携中の AI アプリ</h3>
        {connections === null ? (
          <p className="muted small">読み込み中…</p>
        ) : connections.length === 0 ? (
          <p className="muted small">連携中の AI アプリはありません。ChatGPT / Claude のコネクタから「名刺管理」を接続すると、ここに表示されます。</p>
        ) : (
          <ul className="connections">
            {connections.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.client_name}</strong>
                  <div className="muted small">{fmtDateTime(c.created_at)} に許可</div>
                </div>
                <button className="btn btn-small" onClick={() => revoke(c)}>
                  連携を解除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel">
        <p className="muted small">この端末ではログインしたままになっています。共用の端末を使った場合はログアウトしてください。</p>
        <button className="btn" onClick={logout}>
          ログアウト
        </button>
      </div>
    </div>
  );
}

interface CalendarState {
  linked: boolean;
  configured: boolean;
  link: { user_email: string; linked_at: string; last_sync_at: string | null; last_error: string | null } | null;
  upcoming: { date: string; summary: string }[];
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const dayLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;

/** Google カレンダー連携: 自分に関係する期限を、自分のカレンダーに終日の予定として入れる */
function CalendarPanel() {
  const [data, setData] = useState<CalendarState | null>(null);
  const [error, setError] = useState("");
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const load = useCallback(() => {
    api<CalendarState>("/api/calendar").then(setData, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  // 連携の画面から戻ってきたときの結果
  useEffect(() => {
    const r = params.get("calendar");
    if (!r) return;
    if (r.startsWith("linked:")) toast(`Google カレンダーと連携しました（予定を ${r.slice(7)} 件入れました）`);
    else setError(r);
    params.delete("calendar");
    setParams(params, { replace: true });
  }, [params, setParams, toast]);

  const sync = async () => {
    setError("");
    try {
      const r = await api<{ changed: number; removed: number }>("/api/calendar/sync", { body: {} });
      toast(r.changed + r.removed ? `カレンダーに反映しました（更新 ${r.changed} 件・削除 ${r.removed} 件）` : "カレンダーは最新です");
    } catch (e) {
      setError(errorMessage(e));
    }
    load();
  };
  const unlink = async () => {
    const remove = confirm("カレンダーの連携を解除します。\n\nこれから先の予定（このアプリが入れたもの）もカレンダーから消しますか？\n「OK」で消す／「キャンセル」で予定は残す");
    try {
      const r = await api<{ removed: number }>(`/api/calendar${remove ? "?remove_events=1" : ""}`, { method: "DELETE" });
      toast(remove ? `連携を解除し、予定を ${r.removed} 件消しました` : "連携を解除しました（入れた予定は残しています）");
    } catch (e) {
      setError(errorMessage(e));
    }
    load();
  };

  return (
    <div className="panel">
      <h2>Google カレンダー</h2>
      <p className="muted small">あなたに関係する期限（請求書の作成・入金期日・社内請求の提出期限と支払日・サブスクの更新日など）を、あなたの Google カレンダーに終日の予定として入れます。内容が変わると1時間以内に反映し、前日の9時に通知します。</p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {data === null ? (
        <p className="muted small">読み込み中…</p>
      ) : data.linked && data.link ? (
        <>
          <p>
            <strong>連携中</strong>
            <span className="muted small">
              {" "}
              ・ {data.link.last_sync_at ? `最後の反映 ${fmtDateTime(data.link.last_sync_at)}` : "まだ反映していません"}
            </span>
          </p>
          {data.link.last_error && <p className="notice notice-warn small">{data.link.last_error}</p>}
          <div className="row wrap">
            <button className="btn btn-primary btn-small" onClick={sync}>
              今すぐ反映
            </button>
            <button className="btn btn-small" onClick={unlink}>
              連携を解除
            </button>
          </div>
        </>
      ) : data.configured ? (
        <p>
          <a className="btn btn-primary" href="/auth/calendar-link">
            Google カレンダーと連携
          </a>
        </p>
      ) : (
        <p className="notice small">Google ログインが設定されていないため、連携できません。</p>
      )}
      {data && (
        <>
          <h3>{data.linked ? "カレンダーに入っている予定" : "連携すると入る予定"}（これから100日）</h3>
          {data.upcoming.length === 0 ? (
            <p className="muted small">あなたに関係する期限はありません。</p>
          ) : (
            <ul className="calendar-list">
              {data.upcoming.map((e) => (
                <li key={e.date + e.summary}>
                  <span className="calendar-date">{dayLabel(e.date)}</span>
                  <span>{e.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

interface DeviceToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Voiss（Mac の録音アプリ）の連携キー: 会議の録音を止めると、文字起こしと音声がこのアプリに届く */
function VoissPanel() {
  const [tokens, setTokens] = useState<DeviceToken[] | null>(null);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState("");
  const [error, setError] = useState("");
  const toast = useToast();
  const load = useCallback(() => {
    api<{ tokens: DeviceToken[] }>("/api/voiss/tokens").then((r) => setTokens(r.tokens), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const issue = async () => {
    setError("");
    try {
      const r = await api<{ token: string }>("/api/voiss/tokens", { body: { name: name.trim() || "Mac" } });
      setIssued(r.token);
      setName("");
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const revoke = async (t: DeviceToken) => {
    if (!confirm(`「${t.name}」のキーを使えなくします。その Mac の Voiss からは送れなくなります。`)) return;
    try {
      await api(`/api/voiss/tokens/${t.id}`, { method: "DELETE" });
      toast("キーを使えなくしました");
    } catch (e) {
      setError(errorMessage(e));
    }
    load();
  };

  return (
    <div className="panel">
      <h2>Voiss（会議の録音）</h2>
      <p className="muted small">議事録画面の「録音開始」を押すと、この Mac の Voiss が録音し、止めると文字起こしと音声がこのアプリに届きます。連携はふつう議事録画面の「Voiss と連携」で済みます。ここでは、キーを手で貼るときのために発行と取り消しができます。</p>
      <p className="small">
        <a href="/api/voiss/download">Voiss をダウンロード</a>
        <span className="muted">（Apple Silicon の Mac。zip の中の「会議録音の使い方」の手順で入れます）</span>
      </p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {issued ? (
        <div className="notice">
          <p className="small">
            <strong>連携キーを発行しました。</strong>この画面を閉じると二度と表示されません。Voiss のメニュー「社内アプリと連携…」に貼り付けてください。
          </p>
          <div className="mcp-url">
            <code>{issued}</code>
            <CopyButton value={issued} label="連携キー" />
          </div>
          <button className="btn btn-small" onClick={() => setIssued("")}>
            閉じる
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mac の名前（例: MacBook Air）" aria-label="Mac の名前" />
          <button className="btn btn-primary btn-small" onClick={issue}>
            連携キーを発行
          </button>
        </div>
      )}
      <h3>使える連携キー</h3>
      {tokens === null ? (
        <p className="muted small">読み込み中…</p>
      ) : tokens.length === 0 ? (
        <p className="muted small">まだありません。Mac ごとに1つ発行します。</p>
      ) : (
        <ul className="connections">
          {tokens.map((t) => (
            <li key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <div className="muted small">
                  {fmtDateTime(t.created_at)} に発行{t.last_used_at ? ` ・ 最後に使用 ${fmtDateTime(t.last_used_at)}` : " ・ まだ使っていません"}
                </div>
              </div>
              <button className="btn btn-small" onClick={() => revoke(t)}>
                使えなくする
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
