import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { getNext } from "../lib/next";

interface AuthConfig {
  google: boolean;
  devLogin: boolean;
  domain: string;
}

export function LoginPage() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [devEmail, setDevEmail] = useState("");
  const [devName, setDevName] = useState("");
  const [error, setError] = useState(() => new URLSearchParams(location.search).get("error") ?? "");

  useEffect(() => {
    fetch("/auth/config")
      .then((r) => r.json() as Promise<AuthConfig>)
      .then(setConfig, () => setError("サーバーに接続できません"));
  }, []);

  const devLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/auth/dev-login", { body: { email: devEmail, name: devName } });
      location.href = getNext();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <img className="login-mark" src="/logo-mark.png" alt="AIの鉄人" width="480" height="407" />
        <h1 className="login-title">名刺・請求管理</h1>
        <p className="muted">社内の Google アカウントでログインしてください。</p>
        {error && <p className="error">{error}</p>}
        {config && (
          <>
            {config.google ? (
              <a className="btn btn-google" href={`/auth/google?next=${encodeURIComponent(getNext())}`}>
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z" />
                  <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
                  <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
                </svg>
                Google でログイン
              </a>
            ) : (
              <p className="notice">Google ログインがまだ設定されていません（README の手順を参照）。</p>
            )}
            <p className="muted small">@{config.domain} のアカウントのみ利用できます。一度ログインすると、この端末では 90 日間ログインしたままになります。</p>
            {config.devLogin && (
              <form className="dev-login" onSubmit={devLogin}>
                <p className="small">開発用ログイン（localhost のみ）</p>
                <input type="email" placeholder={`you@${config.domain}`} value={devEmail} onChange={(e) => setDevEmail(e.target.value)} required />
                <input placeholder="名前" value={devName} onChange={(e) => setDevName(e.target.value)} />
                <button className="btn" type="submit">
                  開発用ログイン
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
