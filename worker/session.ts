import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export const SESSION_COOKIE = "meishi_session";
const DAY = 24 * 3600_000;
/** ログイン状態を保つ期間。使うたびに延長されるので、普段使っていれば再ログイン不要 */
export const SESSION_TTL = 90 * DAY;
/** 残りがこの日数を切ったら期限を延長する（毎回 DB を書き換えないため） */
const RENEW_WHEN_LEFT = 80 * DAY;

export interface User {
  id: string;
  email: string;
  name: string;
  registered: number;
  role: "admin" | "member" | "viewer";
}

export type AppEnv = { Bindings: Env; Variables: { user: User } };

const isSecure = (c: Context) => new URL(c.req.url).protocol === "https:";

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function writeCookie(c: Context, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function createSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL;
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, expiresAt, now)
    .run();
  writeCookie(c, token, expiresAt);
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.name, u.registered, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<User & { expires_at: number; active: number }>();
  const now = Date.now();
  if (!row || row.expires_at < now || !row.active) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return null;
  }
  if (row.expires_at - now < RENEW_WHEN_LEFT) {
    const expiresAt = now + SESSION_TTL;
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(expiresAt, id).run();
    writeCookie(c, token, expiresAt);
  }
  return { id: row.id, email: row.email, name: row.name, registered: row.registered, role: row.role };
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
