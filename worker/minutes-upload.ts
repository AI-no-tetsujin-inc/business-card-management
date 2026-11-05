// Voiss（Mac の録音アプリ）から文字起こし・音声を受け取る API（/upload-api/minutes）。認証は連携キー（Bearer）
//   GET  /ping              キーの確認（Voiss の「社内アプリと連携…」）
//   POST /                  文字起こし（JSON）。同じ client_key の送り直しは同じ記録を返す
//   PUT  /:id/audio         音声（m4a / wav のバイト列）。送り直してよい
import { Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso, uuid } from "./people";
import { deviceTokenUser } from "./device-token";
import { getSettings, minutesEnabled } from "./settings";
import { audioKey, rememberAppUrl, startAudioWorkflow, startWorkflow, textKey } from "./minutes";
import { jst } from "./minutes-text";

const MAX_TEXT_CHARS = 500_000;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
/** 長時間録音は最長4時間（少し余裕を見る） */
const MAX_DURATION_SEC = 5 * 3600;
const AUDIO_TYPES = ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav"];
const VIA = "voiss";

export const minutesUpload = new Hono<AppEnv>();

minutesUpload.use("*", async (c, next) => {
  const user = await deviceTokenUser(c.env.DB, c.req.header("authorization"));
  if (!user) return c.json({ error: "連携キーが無効です。社内アプリのプロフィールで発行し直してください" }, 401);
  if (!minutesEnabled(await getSettings(c.env.DB))) return c.json({ error: "社内アプリで議事録が有効になっていません（管理画面の設定）" }, 403);
  c.set("user", user);
  await next();
});

minutesUpload.get("/ping", (c) => {
  const user = c.get("user");
  return c.json({ ok: true, user: { name: user.name, email: user.email } });
});

interface UploadBody {
  client_key?: unknown;
  started_at?: unknown;
  duration_sec?: unknown;
  text?: unknown;
  model?: unknown;
  app_version?: unknown;
  title?: unknown;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

minutesUpload.post("/", async (c) => {
  const user = c.get("user");
  const b = await c.req.json<UploadBody>().catch(() => null);
  if (!b) return c.json({ error: "JSON で送ってください" }, 400);
  const clientKey = str(b.client_key, 120);
  if (!/^[\w.-]{6,120}$/.test(clientKey)) return c.json({ error: "client_key が正しくありません" }, 400);
  const startedMs = typeof b.started_at === "string" ? Date.parse(b.started_at) : NaN;
  if (!Number.isFinite(startedMs)) return c.json({ error: "started_at（録音を始めた日時）が正しくありません" }, 400);
  const duration = Number(b.duration_sec);
  if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_SEC) return c.json({ error: "duration_sec が正しくありません" }, 400);
  const text = typeof b.text === "string" ? b.text : "";
  if (!text.trim()) return c.json({ error: "文字起こしが空です" }, 400);
  if (text.length > MAX_TEXT_CHARS) return c.json({ error: "文字起こしが長すぎます" }, 413);

  const db = c.env.DB;
  const existing = await db
    .prepare("SELECT id, status, recorded_by, audio_key, drive_audio_id FROM documents WHERE client_key = ?")
    .bind(clientKey)
    .first<{ id: string; status: string; recorded_by: string | null; audio_key: string | null; drive_audio_id: string | null }>();
  if (existing) {
    if (existing.recorded_by !== user.id) return c.json({ error: "この録音は別の人が送っています" }, 409);
    return c.json({ id: existing.id, status: existing.status, audio_uploaded: Boolean(existing.audio_key || existing.drive_audio_id) });
  }

  const id = uuid();
  const startedAt = new Date(startedMs).toISOString();
  const given = str(b.title, 100);
  const s = jst(startedAt);
  const title = given || `録音 ${s.md} ${s.hm}`;
  await c.env.IMAGES.put(textKey(id), text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await db
    .prepare(
      `INSERT INTO documents (id, drive_file_id, title, modified_time, created_at, source, recorded_by, started_at, duration_sec, client_key, model, title_auto)
       VALUES (?, ?, ?, ?, ?, 'voiss', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, `voiss:${clientKey}`, title, nowIso(), nowIso(), user.id, startedAt, Math.round(duration), clientKey, str(b.model, 100), given ? 0 : 1)
    .run();
  await startWorkflow(c.env, id, new URL(c.req.url).origin);
  await rememberAppUrl(c.env, new URL(c.req.url).origin);
  await audit(db, { userId: user.id, via: VIA, action: "minutes_upload", targetType: "document", targetId: id, detail: { app_version: str(b.app_version, 40), chars: text.length } });
  return c.json({ id, status: "processing", audio_uploaded: false });
});

minutesUpload.put("/:id/audio", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!AUDIO_TYPES.includes(type)) return c.json({ error: "m4a か wav の音声を送ってください" }, 415);
  const length = Number(c.req.header("content-length") ?? 0);
  if (!length) return c.json({ error: "音声が空です" }, 400);
  if (length > MAX_AUDIO_BYTES) return c.json({ error: "音声が大きすぎます（100MB まで）" }, 413);
  const doc = await c.env.DB.prepare("SELECT recorded_by, drive_folder_id FROM documents WHERE id = ?")
    .bind(id)
    .first<{ recorded_by: string | null; drive_folder_id: string | null }>();
  if (!doc) return c.json({ error: "見つかりません" }, 404);
  if (doc.recorded_by !== user.id) return c.json({ error: "この録音は別の人が送っています" }, 409);
  const audioType = type.includes("wav") ? "audio/wav" : "audio/mp4";
  await c.env.IMAGES.put(audioKey(id), c.req.raw.body!, { httpMetadata: { contentType: audioType } });
  await c.env.DB.prepare("UPDATE documents SET audio_key = ?, audio_type = ? WHERE id = ?").bind(audioKey(id), audioType, id).run();
  // 文字起こしの保存が先に済んでいれば、音声だけ Drive に置く（まだなら本体の処理が最後に置く）
  if (doc.drive_folder_id) await startAudioWorkflow(c.env, id);
  await audit(c.env.DB, { userId: user.id, via: VIA, action: "minutes_audio", targetType: "document", targetId: id, detail: { bytes: length } });
  return c.json({ ok: true });
});
