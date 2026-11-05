// Voiss（Mac の録音アプリ）の連携キー。プロフィールで各自が発行し、Voiss が文字起こしを送るときに使う
// キーは発行したときに一度だけ見せ、D1 には SHA-256 だけを残す（upload-link.ts と同じ流儀）
import type { Hono } from "hono";
import { randomToken, type AppEnv, type User } from "./session";
import { audit, nowIso, uuid } from "./people";

export const TOKEN_PREFIX = "vk_";
/** 最終使用日時の書き換えは1時間に1回まで（送るたびに DB を書き換えないため） */
const TOUCH_INTERVAL_MS = 3600_000;

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueDeviceToken(db: D1Database, userId: string, name: string) {
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const id = uuid();
  await db
    .prepare("INSERT INTO device_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, name.trim().slice(0, 60), await sha256(token), nowIso())
    .run();
  return { id, token };
}

/** Authorization: Bearer のキーから利用者を返す。無効・失効・閲覧のみの人は null */
export async function deviceTokenUser(db: D1Database, header: string | undefined): Promise<User | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token?.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, t.last_used_at, u.id, u.email, u.name, u.registered, u.role, u.active
         FROM device_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .bind(await sha256(token))
    .first<User & { token_id: string; last_used_at: string | null; active: number }>();
  if (!row || !row.active || !row.registered || row.role === "viewer") return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > TOUCH_INTERVAL_MS) {
    await db.prepare("UPDATE device_tokens SET last_used_at = ? WHERE id = ?").bind(nowIso(), row.token_id).run();
  }
  return { id: row.id, email: row.email, name: row.name, registered: row.registered, role: row.role };
}

export function registerDeviceTokenRoutes(api: Hono<AppEnv>) {
  api.get("/voiss/tokens", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name, created_at, last_used_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
    )
      .bind(c.get("user").id)
      .all();
    return c.json({ tokens: results });
  });

  api.post("/voiss/tokens", async (c) => {
    const user = c.get("user");
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: "" }));
    const { id, token } = await issueDeviceToken(c.env.DB, user.id, name?.trim() || "Mac");
    await audit(c.env.DB, { userId: user.id, via: "web", action: "voiss_token_issue", targetType: "device_token", targetId: id });
    return c.json({ id, token });
  });

  api.delete("/voiss/tokens/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(nowIso(), id, user.id)
      .run();
    if (!r.meta.changes) return c.json({ error: "見つかりません" }, 404);
    await audit(c.env.DB, { userId: user.id, via: "web", action: "voiss_token_revoke", targetType: "device_token", targetId: id });
    return c.json({ ok: true });
  });
}
