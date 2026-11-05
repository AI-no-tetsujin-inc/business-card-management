// ChatGPT / Claude から MCP に接続するときの「許可」画面（OAuth の authorize エンドポイント）
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { currentUser, randomToken, type AppEnv } from "./session";
import { audit } from "./people";

export const oauth = new Hono<AppEnv>();

const CSRF_COOKIE = "meishi_consent";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * redirectOrigin: 許可・キャンセルのあとに戻る AI アプリ側の URL（の origin）。
 * ブラウザは送信後のリダイレクト先にも form-action を適用するため、ここに含めないと「許可する」が止まる
 */
function page(c: Context<AppEnv>, title: string, body: string, status: 200 | 400 | 403 = 200, redirectOrigin?: string) {
  const formAction = ["'self'", redirectOrigin].filter(Boolean).join(" ");
  c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`);
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:#1f3a5f;color:#1d2330}
.box{background:#fff;border-radius:14px;padding:28px 24px;max-width:420px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.2)}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.7;margin:0 0 12px}.muted{color:#667085;font-size:.9rem}
ul{padding-left:1.2em;margin:0 0 16px;line-height:1.8}.row{display:flex;gap:8px;margin-top:20px}
button{flex:1;font:inherit;padding:10px;border-radius:8px;border:1px solid #dde1e8;background:#fff;cursor:pointer}
button.primary{background:#1f3a5f;color:#fff;border-color:#1f3a5f}
</style></head><body><div class="box">${body}</div></body></html>`,
    status,
  );
}

async function clientLabel(env: Env, clientId: string) {
  const client = await env.OAUTH_PROVIDER.lookupClient(clientId).catch(() => null);
  if (client?.clientName) return client.clientName;
  try {
    return new URL(clientId).hostname; // CIMD の client_id は URL
  } catch {
    return "AI アプリ";
  }
}

oauth.get("/authorize", async (c) => {
  let authReq;
  try {
    authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    console.error("invalid authorize request", e);
    return page(c, "接続できません", "<h1>接続できません</h1><p>この接続リクエストは無効です。AI アプリ側でもう一度接続してください。</p>", 400);
  }
  const self = new URL(c.req.url);
  const user = await currentUser(c);
  if (!user || !user.registered) return c.redirect(`/login?next=${encodeURIComponent(self.pathname + self.search)}`);

  const name = await clientLabel(c.env, authReq.clientId);
  const csrf = randomToken(16);
  setCookie(c, CSRF_COOKIE, csrf, { httpOnly: true, secure: self.protocol === "https:", sameSite: "Strict", path: "/authorize", maxAge: 600 });
  const canWrite = user.role !== "viewer";
  // 戻り先は登録済みのリダイレクト URI（parseAuthRequest で検証済み）。http(s) のときだけ許可する
  let redirectOrigin: string | undefined;
  try {
    const u = new URL(authReq.redirectUri);
    if (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) redirectOrigin = u.origin;
  } catch {
    redirectOrigin = undefined;
  }
  return page(
    c,
    "AI アプリとの連携",
    `<h1>${esc(name)} に名刺管理への接続を許可しますか？</h1>
<p class="muted">${esc(user.name)}（${esc(user.email)}）として接続します。</p>
<ul>
<li>名刺・人物の検索と閲覧、顧客請求・社内請求・サブスクの状況の確認</li>
${canWrite ? "<li>名刺の登録・更新、メモの追加、請求書の送付・連絡のチェック（実行前に AI 側で確認されます）</li>" : "<li>閲覧のみの権限のため、登録・更新はできません</li>"}
</ul>
<p class="muted">操作は「${esc(name)} 経由」として履歴に残ります。連携はプロフィール画面からいつでも解除できます。</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="q" value="${esc(self.search)}">
<div class="row"><button type="submit" name="action" value="deny">キャンセル</button>
<button type="submit" name="action" value="allow" class="primary">許可する</button></div>
</form>`,
    200,
    redirectOrigin,
  );
});

oauth.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const csrf = getCookie(c, CSRF_COOKIE);
  if (!csrf || form.get("csrf") !== csrf) {
    return page(c, "接続できません", "<h1>接続できません</h1><p>時間が経ちすぎたため、AI アプリ側でもう一度接続してください。</p>", 403);
  }
  const user = await currentUser(c);
  if (!user || !user.registered) return page(c, "接続できません", "<h1>ログインが切れました</h1><p>もう一度接続してください。</p>", 403);

  const q = String(form.get("q") ?? "");
  const authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(new Request(new URL(`/authorize${q}`, c.req.url)));
  if (form.get("action") !== "allow") {
    const u = new URL(authReq.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (authReq.state) u.searchParams.set("state", authReq.state);
    if (authReq.issuer) u.searchParams.set("iss", authReq.issuer);
    return c.redirect(u.toString());
  }
  const clientName = await clientLabel(c.env, authReq.clientId);
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: user.id,
    metadata: { clientName },
    scope: authReq.scope,
    props: { userId: user.id, clientName },
  });
  await audit(c.env.DB, { userId: user.id, via: `ai:${clientName}`, action: "connect", detail: { clientId: authReq.clientId } });
  return c.redirect(redirectTo);
});
