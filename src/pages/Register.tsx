import { useState } from "react";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { getNext } from "../lib/next";

/** 初回ログイン時のアカウント登録（表示名の確認） */
export function RegisterPage() {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/register", { body: { name } });
      // AI アプリとの連携の途中でログインした場合は、許可画面に戻る
      if (getNext() !== "/") location.href = getNext();
      else await refreshUser();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-box" onSubmit={submit}>
        <h1>アカウント登録</h1>
        <p className="muted">名刺の登録者・メモの記入者として表示される名前です。あとから変更できます。</p>
        <label className="stack">
          <span>メールアドレス</span>
          <input value={user.email} disabled />
        </label>
        <label className="stack">
          <span>表示名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          登録してはじめる
        </button>
      </form>
    </div>
  );
}
