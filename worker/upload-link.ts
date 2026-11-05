// AI 経由で登録した人物に、あとから名刺画像を付けるための使い捨てリンク（ログイン不要・15分・1回限り）
import { Hono } from "hono";
import { randomToken, type AppEnv } from "./session";
import { audit, nowIso, uuid } from "./people";
import { putImage } from "./api";

const TTL_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createUploadLink(db: D1Database, cardId: string, userId: string, origin: string) {
  const token = randomToken(24);
  const expiresAt = Date.now() + TTL_MS;
  const created = await db
    .prepare("INSERT INTO upload_links (token_hash, card_id, user_id, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND registered = 1 AND role IN ('admin', 'member'))")
    .bind(await sha256(token), cardId, userId, expiresAt, userId)
    .run();
  if (created.meta.changes !== 1) throw new Error("アップロードリンクを発行する権限がありません");
  return { url: `${origin}/u/${token}`, expiresAt };
}

interface LinkRow {
  token_hash: string;
  card_id: string;
  user_id: string;
  expires_at: number;
  used_at: string | null;
}

async function validLink(db: D1Database, token: string): Promise<LinkRow | null> {
  const row = await db.prepare("SELECT l.* FROM upload_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ? AND u.active = 1 AND u.registered = 1 AND u.role IN ('admin', 'member')").bind(await sha256(token)).first<LinkRow>();
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return row;
}

export const uploadApi = new Hono<AppEnv>();

uploadApi.get("/:token", async (c) => {
  const link = await validLink(c.env.DB, c.req.param("token"));
  if (!link) return c.json({ error: "このリンクは期限切れか、すでに使われています" }, 404);
  const card = await c.env.DB.prepare("SELECT person_name, company_name FROM cards WHERE id = ?").bind(link.card_id).first<{
    person_name: string;
    company_name: string;
  }>();
  return c.json({ person_name: card?.person_name ?? "", company_name: card?.company_name ?? "", expires_at: link.expires_at });
});

uploadApi.post("/:token/image", async (c) => {
  if (!(await validLink(c.env.DB, c.req.param("token")))) return c.json({ error: "このリンクは期限切れです" }, 404);
  const length = Number(c.req.header("content-length") ?? 0);
  if (c.req.header("content-type") !== "image/jpeg") return c.json({ error: "JPEG 画像のみ対応しています" }, 400);
  if (!length || length > MAX_IMAGE_BYTES) return c.json({ error: "画像が大きすぎます" }, 400);
  const key = await putImage(c.env.IMAGES, c.req.raw.body!);
  if (!(await validLink(c.env.DB, c.req.param("token")))) {
    await c.env.IMAGES.delete(key);
    return c.json({ error: "このリンクは無効です" }, 404);
  }
  return c.json({ key });
});

uploadApi.post("/:token/finish", async (c) => {
  const token = c.req.param("token");
  const link = await validLink(c.env.DB, token);
  if (!link) return c.json({ error: "このリンクは期限切れです" }, 404);
  const b = await c.req.json<{ front: { full: string; display: string }; back?: { full: string; display: string } }>();
  const sides = [["front", b.front], ["back", b.back]] as const;
  const at = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const [side, img] of sides) {
    if (!img) continue;
    for (const k of [img.full, img.display]) {
      if (!k?.startsWith("img/") || !(await c.env.IMAGES.head(k))) return c.json({ error: "画像が見つかりません" }, 400);
    }
    stmts.push(
      c.env.DB.prepare("INSERT INTO card_images (id, card_id, side, full_key, display_key, uploaded_by, uploaded_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM upload_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ? AND u.active = 1 AND u.registered = 1 AND u.role IN ('admin', 'member'))")
        .bind(uuid(), link.card_id, side, img.full, img.display, link.user_id, at, link.token_hash),
    );
  }
  if (!stmts.length) return c.json({ error: "表面の画像がありません" }, 400);
  // Claim the capability atomically before any image write. A concurrent request
  // that passed validLink must not be able to complete a second time.
  // Fail closed: if the following batch fails, issue a new link instead of
  // restoring this token and reopening the replay window.
  const claimed = await c.env.DB
    .prepare("UPDATE upload_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM users WHERE users.id = upload_links.user_id AND active = 1 AND registered = 1 AND role IN ('admin', 'member'))")
    .bind(at, link.token_hash, Date.now())
    .run();
  if (claimed.meta.changes !== 1) return c.json({ error: "このリンクは期限切れか、すでに使われています" }, 404);
  const saved = await c.env.DB.batch(stmts);
  if (!saved.every((result) => result.meta.changes === 1)) return c.json({ error: "このリンクは無効です" }, 404);
  await audit(c.env.DB, { userId: link.user_id, via: "web", action: "upload_image", targetType: "card", targetId: link.card_id });
  return c.json({ ok: true });
});
