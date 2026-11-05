// Google 連携: 管理者が一度「Google と連携」で許可すると、そのアカウントの権限で
// 共有ドライブへの書類保存と Gmail 送信ができる（組織ポリシーで鍵が作れないため、サービスアカウントの代わりに使う）
import { nowIso } from "./people";

export const LINK_SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.send"];

export interface GoogleLink {
  email: string;
  refresh_token_enc: string;
  scopes: string;
  linked_at: string;
  linked_by: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function cryptoKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meishi-google-link:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** refresh_token を暗号化する（iv.暗号文 の base64） */
export async function sealToken(secret: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(secret), new TextEncoder().encode(token)));
  return `${b64(iv)}.${b64(enc)}`;
}

export async function openToken(secret: string, sealed: string) {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await cryptoKey(secret), unb64(data));
  return new TextDecoder().decode(plain);
}

export async function getLink(db: D1Database) {
  return db.prepare("SELECT * FROM google_link WHERE id = 'main'").first<GoogleLink>();
}

export async function saveLink(env: Env, p: { email: string; refreshToken: string; scopes: string; userId: string }) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO google_link (id, email, refresh_token_enc, scopes, linked_at, linked_by, last_error, last_error_at)
     VALUES ('main', ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(p.email, await sealToken(env.GOOGLE_CLIENT_SECRET, p.refreshToken), p.scopes, nowIso(), p.userId)
    .run();
  userCache = null;
}

export async function removeLink(env: Env) {
  const link = await getLink(env.DB);
  if (link) {
    // Google 側の許可も取り消す（失敗しても手元の情報は消す）
    try {
      const token = await openToken(env.GOOGLE_CLIENT_SECRET, link.refresh_token_enc);
      await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    } catch {
      /* 取り消せなくても続ける */
    }
  }
  await env.DB.prepare("DELETE FROM google_link WHERE id = 'main'").run();
  userCache = null;
}

let userCache: { token: string; exp: number; email: string } | null = null;

/** 連携したアカウントのアクセストークン（1時間有効。切れたら refresh_token で取り直す） */
export async function linkedAccessToken(env: Env, link: GoogleLink): Promise<string> {
  if (userCache && userCache.email === link.email && userCache.exp > Date.now() + 60_000) return userCache.token;
  const refreshToken = await openToken(env.GOOGLE_CLIENT_SECRET, link.refresh_token_enc);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) {
    const text = await res.text();
    const msg = text.includes("invalid_grant")
      ? `Google 連携が切れています（${link.email}）。管理画面の「Google と連携」からもう一度許可してください`
      : `Google の認証に失敗しました（${res.status}）: ${text.slice(0, 200)}`;
    await env.DB.prepare("UPDATE google_link SET last_error = ?, last_error_at = ? WHERE id = 'main'").bind(msg, nowIso()).run();
    throw new Error(msg);
  }
  const data = await res.json<{ access_token: string; expires_in: number }>();
  userCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000, email: link.email };
  if (link.last_error) await env.DB.prepare("UPDATE google_link SET last_error = NULL, last_error_at = NULL WHERE id = 'main'").run();
  return data.access_token;
}
