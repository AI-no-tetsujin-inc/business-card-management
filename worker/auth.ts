import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createSession, currentUser, destroySession, randomToken, type AppEnv } from "./session";
import { LINK_SCOPES, saveLink } from "./google-link";
import { audit } from "./people";
import { setSettings } from "./settings";
import { CALENDAR_SCOPE, saveCalendarLink, syncCalendar } from "./calendar";

const STATE_COOKIE = "meishi_oauth_state";
const LINK_STATE_COOKIE = "meishi_link_state";
const CAL_STATE_COOKIE = "meishi_cal_state";
const NEXT_COOKIE = "meishi_next";

/** ログイン後に戻る先。同じサイト内の相対パスだけ許可する */
export const safeNext = (next: string | null | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";

export const auth = new Hono<AppEnv>();

const callbackUrl = (reqUrl: string) => new URL("/auth/callback", reqUrl).toString();

const isLocalhost = (reqUrl: string) => ["localhost", "127.0.0.1"].includes(new URL(reqUrl).hostname);

function emailAllowed(env: Env, email: string) {
  return email.toLowerCase().endsWith("@" + env.ALLOWED_DOMAIN.toLowerCase());
}

/** Google アカウントでユーザーを作成または更新し、ログイン状態にする */
async function upsertUser(env: Env, p: { sub: string | null; email: string; name: string }) {
  const now = new Date().toISOString();
  const email = p.email.toLowerCase();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? OR (google_sub IS NOT NULL AND google_sub = ?)")
    .bind(email, p.sub)
    .first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE users SET google_sub = COALESCE(?, google_sub), email = ?, last_login_at = ? WHERE id = ?")
      .bind(p.sub, email, now, existing.id)
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, registered, created_at, last_login_at, role)
     VALUES (?, ?, ?, ?, 0, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN 'member' ELSE 'admin' END)`,
  )
    .bind(id, p.sub, email, p.name, now, now)
    .run();
  return id;
}

async function isActive(env: Env, userId: string) {
  const r = await env.DB.prepare("SELECT active FROM users WHERE id = ?").bind(userId).first<{ active: number }>();
  return Boolean(r?.active);
}

auth.get("/config", (c) =>
  c.json({
    google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    devLogin: c.env.DEV_LOGIN === "1" && isLocalhost(c.req.url),
    domain: c.env.ALLOWED_DOMAIN,
  }),
);

auth.get("/google", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google ログインが設定されていません", 500);
  const state = randomToken(16);
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  setCookie(c, NEXT_COOKIE, safeNext(c.req.query("next")), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: "openid email profile",
    state,
    hd: c.env.ALLOWED_DOMAIN, // 社内ドメインのアカウントを優先表示（最終判定はサーバー側で行う）
    prompt: "select_account",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google 連携（管理者のみ）: Drive への保存と Gmail 送信の許可をもらう。リダイレクト先はログインと同じ /auth/callback
auth.get("/google-link", async (c) => {
  const user = await currentUser(c);
  if (!user || user.role !== "admin") return c.redirect("/admin?google=" + encodeURIComponent("Google 連携は管理者だけが行えます"));
  const state = randomToken(16);
  setCookie(c, LINK_STATE_COOKIE, state, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/auth", maxAge: 600 });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: ["openid", "email", ...LINK_SCOPES].join(" "),
    access_type: "offline", // 自動処理で使い続けるため refresh_token をもらう
    prompt: "consent",
    login_hint: user.email,
    hd: c.env.ALLOWED_DOMAIN,
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

async function finishGoogleLink(c: Context<AppEnv>, code: string) {
  const back = (msg: string) => c.redirect(`/admin?google=${encodeURIComponent(msg)}`);
  const user = await currentUser(c);
  if (!user || user.role !== "admin") return back("Google 連携は管理者だけが行えます");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(c.req.url), grant_type: "authorization_code" }),
  });
  if (!tokenRes.ok) return back("Google との通信に失敗しました。もう一度お試しください");
  const t = await tokenRes.json<{ access_token: string; refresh_token?: string; scope: string }>();
  if (!t.refresh_token) return back("Google から継続利用の許可がもらえませんでした。もう一度お試しください");
  const missing = LINK_SCOPES.filter((sc) => !t.scope.split(" ").includes(sc));
  if (missing.length) return back("Drive とメール送信の両方を許可してください（許可の画面ですべてにチェックを入れてください）");
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json<{ email: string; email_verified: boolean }>());
  if (!info.email_verified || !emailAllowed(c.env, info.email)) return back(`@${c.env.ALLOWED_DOMAIN} のアカウントで連携してください`);
  await saveLink(c.env, { email: info.email.toLowerCase(), refreshToken: t.refresh_token, scopes: t.scope, userId: user.id });
  await setSettings(c.env.DB, { mail_from: info.email.toLowerCase() });
  await audit(c.env.DB, { userId: user.id, via: "web", action: "google_link", detail: { email: info.email } });
  return c.redirect("/admin?google=linked");
}

// Google カレンダー連携（各自）: 自分のカレンダーに期限を入れる許可をもらう。リダイレクト先はログインと同じ /auth/callback
auth.get("/calendar-link", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login?next=/profile");
  const state = randomToken(16);
  setCookie(c, CAL_STATE_COOKIE, state, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/auth", maxAge: 600 });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: ["openid", "email", CALENDAR_SCOPE].join(" "),
    access_type: "offline", // 1時間ごとの自動反映で使い続けるため refresh_token をもらう
    prompt: "consent",
    login_hint: user.email,
    hd: c.env.ALLOWED_DOMAIN,
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

async function finishCalendarLink(c: Context<AppEnv>, code: string) {
  const back = (msg: string) => c.redirect(`/profile?calendar=${encodeURIComponent(msg)}`);
  const user = await currentUser(c);
  if (!user) return c.redirect("/login?next=/profile");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(c.req.url), grant_type: "authorization_code" }),
  });
  if (!tokenRes.ok) return back("Google との通信に失敗しました。もう一度お試しください");
  const t = await tokenRes.json<{ access_token: string; refresh_token?: string; scope: string }>();
  if (!t.refresh_token) return back("Google から継続利用の許可がもらえませんでした。もう一度お試しください");
  if (!t.scope.split(" ").includes(CALENDAR_SCOPE)) return back("カレンダーへの予定の追加を許可してください（許可の画面でチェックを入れてください）");
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json<{ email: string; email_verified: boolean }>());
  // 他人のカレンダーをつながないよう、ログイン中の本人のアカウントだけ受け付ける
  if (!info.email_verified || info.email.toLowerCase() !== user.email.toLowerCase()) return back(`ログイン中のアカウント（${user.email}）のカレンダーで連携してください`);
  const email = user.email.toLowerCase();
  await saveCalendarLink(c.env, { email, refreshToken: t.refresh_token, scopes: t.scope, appUrl: new URL(c.req.url).origin });
  await audit(c.env.DB, { userId: user.id, via: "web", action: "calendar_link", detail: { email } });
  // すぐに予定を入れる（失敗しても連携は済んでいる。画面に失敗の理由を出す）
  try {
    const r = await syncCalendar(c.env, email);
    return back(`linked:${r.changed}`);
  } catch (e) {
    return back(`連携しましたが、予定を入れられませんでした: ${e instanceof Error ? e.message : e}`);
  }
}

auth.get("/callback", async (c) => {
  const fail = (reason: string) => c.redirect(`/login?error=${encodeURIComponent(reason)}`);
  const calState = getCookie(c, CAL_STATE_COOKIE);
  if (calState) {
    deleteCookie(c, CAL_STATE_COOKIE, { path: "/auth" });
    if (calState === c.req.query("state")) {
      const code = c.req.query("code");
      if (!code) return c.redirect(`/profile?calendar=${encodeURIComponent("許可がキャンセルされました")}`);
      return finishCalendarLink(c, code);
    }
  }
  const linkState = getCookie(c, LINK_STATE_COOKIE);
  if (linkState) {
    deleteCookie(c, LINK_STATE_COOKIE, { path: "/auth" });
    if (linkState === c.req.query("state")) {
      const code = c.req.query("code");
      if (!code) return c.redirect(`/admin?google=${encodeURIComponent("許可がキャンセルされました")}`);
      return finishGoogleLink(c, code);
    }
  }
  const state = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const code = c.req.query("code");
  if (!code || !state || state !== c.req.query("state")) return fail("ログインをやり直してください");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("Google との通信に失敗しました");
  const { access_token } = await tokenRes.json<{ access_token: string }>();

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) return fail("Google アカウント情報を取得できませんでした");
  const info = await infoRes.json<{ sub: string; email: string; email_verified: boolean; name?: string; hd?: string }>();

  if (!info.email_verified || info.hd !== c.env.ALLOWED_DOMAIN || !emailAllowed(c.env, info.email)) {
    return fail(`@${c.env.ALLOWED_DOMAIN} のアカウントでログインしてください`);
  }
  const userId = await upsertUser(c.env, { sub: info.sub, email: info.email, name: info.name ?? "" });
  if (!(await isActive(c.env, userId))) return fail("このアカウントは無効になっています。管理者に連絡してください");
  await createSession(c, userId);
  const next = safeNext(getCookie(c, NEXT_COOKIE));
  deleteCookie(c, NEXT_COOKIE, { path: "/auth" });
  return c.redirect(next);
});

// ローカル開発専用（Google の設定なしで画面を確認するため）
auth.post("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "1" || !isLocalhost(c.req.url)) return c.json({ error: "not_found" }, 404);
  const { email, name } = await c.req.json<{ email: string; name: string }>();
  if (!email || !emailAllowed(c.env, email)) {
    return c.json({ error: `@${c.env.ALLOWED_DOMAIN} のメールアドレスを入力してください` }, 400);
  }
  const userId = await upsertUser(c.env, { sub: null, email, name: name ?? "" });
  if (!(await isActive(c.env, userId))) return c.json({ error: "このアカウントは無効になっています" }, 403);
  await createSession(c, userId);
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
