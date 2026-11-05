// Voiss（Mac の録音アプリ）の配布用 zip。中に取引先・社員の名前の辞書が入るので、ログインした人だけが落とせる R2 に置く
//   GET /api/voiss/package         置いてある zip の情報
//   GET /api/voiss/download        zip を落とす
//   PUT /api/admin/voiss/package   zip を置き換える（管理者）
import type { Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso } from "./people";

const KEY = "downloads/voiss.zip";
const MAX_BYTES = 30 * 1024 * 1024;

export function registerVoissPackageRoutes(api: Hono<AppEnv>) {
  api.get("/voiss/package", async (c) => {
    const obj = await c.env.IMAGES.head(KEY);
    if (!obj) return c.json({ available: false });
    return c.json({
      available: true,
      file_name: obj.customMetadata?.file_name ?? "Voiss.zip",
      size: obj.size,
      uploaded_at: obj.customMetadata?.uploaded_at ?? obj.uploaded.toISOString(),
    });
  });

  api.get("/voiss/download", async (c) => {
    const obj = await c.env.IMAGES.get(KEY);
    if (!obj) return c.json({ error: "まだ置かれていません。管理者に頼んでください" }, 404);
    const name = obj.customMetadata?.file_name ?? "Voiss.zip";
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "voiss_download" });
    return new Response(obj.body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "private, no-store",
      },
    });
  });

  api.put("/admin/voiss/package", async (c) => {
    const user = c.get("user");
    const length = Number(c.req.header("content-length") ?? 0);
    if (!length) return c.json({ error: "zip が空です" }, 400);
    if (length > MAX_BYTES) return c.json({ error: "zip が大きすぎます（30MB まで）" }, 413);
    const name = decodeURIComponent(c.req.header("x-file-name") ?? "Voiss.zip").replace(/[\\/:*?"<>|]/g, "").slice(0, 100) || "Voiss.zip";
    if (!/\.zip$/i.test(name)) return c.json({ error: "zip を選んでください" }, 400);
    await c.env.IMAGES.put(KEY, c.req.raw.body!, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { file_name: name, uploaded_by: user.id, uploaded_at: nowIso() },
    });
    await audit(c.env.DB, { userId: user.id, via: "web", action: "voiss_package_upload", detail: { name, bytes: length } });
    return c.json({ ok: true });
  });
}
