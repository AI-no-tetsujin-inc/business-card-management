// Google Drive・Gmail。管理画面で「Google と連携」したアカウントの権限で動く（無ければサービスアカウント）
import { getLink, linkedAccessToken, LINK_SCOPES } from "./google-link";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const cached = new Map<string, { token: string; exp: number }>();

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function driveConfigured(env: Env) {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.DRIVE_FOLDER_ID);
}

/** Drive への保存・Gmail 送信ができる状態か（連携済み、またはサービスアカウントあり） */
export async function googleReady(env: Env) {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON) || Boolean(await getLink(env.DB));
}

const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_WRITE = "https://www.googleapis.com/auth/drive";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

/**
 * サービスアカウントのアクセストークン。
 * subject を指定すると、その社員になりかわる（Gmail 送信用。Workspace 管理者による「ドメイン全体の委任」が必要）
 */
async function accessToken(env: Env, scope = DRIVE_READ, subject?: string): Promise<string> {
  const link = await getLink(env.DB);
  if (link) return linkedAccessToken(env, link);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Google と連携していません。管理画面の「Google と連携」から許可してください");
  const cacheKey = `${scope}|${subject ?? ""}`;
  const hit = cached.get(cacheKey);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      ...(subject ? { sub: subject } : {}),
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google の認証に失敗しました（${res.status}）: ${await res.text()}`);
  const data = await res.json<{ access_token: string; expires_in: number }>();
  cached.set(cacheKey, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

const TEXT_TYPES = ["application/vnd.google-apps.document", "text/plain", "text/markdown"];

/** 取り込み用フォルダ内のテキスト（Google ドキュメント・テキストファイル）だけを返す。音声などは対象外 */
export async function listMinutesFiles(env: Env): Promise<DriveFile[]> {
  const token = await accessToken(env);
  const q = `'${env.DRIVE_FOLDER_ID}' in parents and trashed = false and (${TEXT_TYPES.map((t) => `mimeType = '${t}'`).join(" or ")})`;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.search = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "50",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  }).toString();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive の一覧取得に失敗しました（${res.status}）: ${await res.text()}`);
  return (await res.json<{ files: DriveFile[] }>()).files;
}

export async function fetchFileText(env: Env, fileId: string): Promise<{ name: string; text: string }> {
  const token = await accessToken(env);
  const headers = { authorization: `Bearer ${token}` };
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`, { headers });
  if (!meta.ok) throw new Error(`Drive のファイル情報の取得に失敗しました（${meta.status}）`);
  const { name, mimeType } = await meta.json<{ name: string; mimeType: string }>();
  const url =
    mimeType === "application/vnd.google-apps.document"
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Drive のファイルの取得に失敗しました（${res.status}）`);
  return { name, text: await res.text() };
}

// ---------- 書き込み（共有ドライブにフォルダを作り、ファイルを置く） ----------

const FOLDER = "application/vnd.google-apps.folder";
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function driveFetch(env: Env, url: string, init: RequestInit = {}) {
  const token = await accessToken(env, DRIVE_WRITE);
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Google Drive の操作に失敗しました（${res.status}）: ${(await res.text()).slice(0, 300)}`);
  return res;
}

/** parentId の下に names の順でフォルダをたどり、無ければ作る（ID は D1 に覚えておく） */
export async function ensureFolder(env: Env, parentId: string, names: string[]): Promise<string> {
  let current = parentId;
  for (let i = 0; i < names.length; i++) {
    const path = `${parentId}/${names.slice(0, i + 1).join("/")}`;
    const cachedId = await env.DB.prepare("SELECT folder_id FROM drive_folders WHERE path = ?").bind(path).first<{ folder_id: string }>();
    if (cachedId) {
      current = cachedId.folder_id;
      continue;
    }
    const q = `name = '${esc(names[i])}' and '${current}' in parents and mimeType = '${FOLDER}' and trashed = false`;
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.search = new URLSearchParams({ q, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" }).toString();
    const found = (await (await driveFetch(env, url.toString())).json<{ files: { id: string }[] }>()).files[0];
    const id =
      found?.id ??
      (
        await (
          await driveFetch(env, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: names[i], mimeType: FOLDER, parents: [current] }),
          })
        ).json<{ id: string }>()
      ).id;
    await env.DB.prepare("INSERT OR REPLACE INTO drive_folders (path, folder_id) VALUES (?, ?)").bind(path, id).run();
    current = id;
  }
  return current;
}

async function findByName(env: Env, folderId: string, name: string) {
  const q = `name = '${esc(name)}' and '${folderId}' in parents and trashed = false`;
  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.search = new URLSearchParams({ q, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" }).toString();
  return (await (await driveFetch(env, listUrl.toString())).json<{ files: { id: string }[] }>()).files[0];
}

/**
 * ファイルをアップロードする。同じ名前があれば上書き＝新しい版として更新（請求書の作り直しなど）。
 * keepExisting のときは上書きせず「名前 (2).jpg」のように別の名前で置く（領収書など、別のものが同じ名前になりうるとき）
 */
export async function uploadToDrive(env: Env, folderId: string, name: string, mime: string, data: Uint8Array | ArrayBuffer, opts: { keepExisting?: boolean } = {}): Promise<string> {
  let existing = await findByName(env, folderId, name);
  if (existing && opts.keepExisting) {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let i = 2; existing && i <= 9; i++) {
      name = `${stem} (${i})${ext}`;
      existing = await findByName(env, folderId, name);
    }
    if (existing) throw new Error(`同じ名前のファイルが多すぎます: ${name}`);
  }
  if (existing) {
    await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&supportsAllDrives=true`, {
      method: "PATCH",
      headers: { "content-type": mime },
      body: data,
    });
    return existing.id;
  }
  const boundary = `meishi${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Blob([head, data, tail]);
  const res = await driveFetch(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json<{ id: string }>()).id;
}

/**
 * 大きなファイル（5MB を超える音声など）を再開可能アップロードで置く（同じ名前があれば新しい版として更新）。
 * body は R2 などのストリーム。長さを固定して送る（Google は Content-Length が要る）
 */
export async function uploadLargeToDrive(env: Env, folderId: string, name: string, mime: string, body: ReadableStream, size: number): Promise<string> {
  const q = `name = '${esc(name)}' and '${folderId}' in parents and trashed = false`;
  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.search = new URLSearchParams({ q, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" }).toString();
  const existing = (await (await driveFetch(env, listUrl.toString())).json<{ files: { id: string }[] }>()).files[0];
  const headers = { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(size) };
  const init = existing
    ? await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=resumable&supportsAllDrives=true&fields=id`, {
        method: "PATCH",
        headers,
        body: "{}",
      })
    : await driveFetch(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id", {
        method: "POST",
        headers,
        body: JSON.stringify({ name, parents: [folderId] }),
      });
  const session = init.headers.get("location");
  if (!session) throw new Error("Google Drive のアップロードを始められませんでした");
  const fixed = new FixedLengthStream(size);
  const piping = body.pipeTo(fixed.writable);
  const res = await fetch(session, { method: "PUT", headers: { "content-type": mime }, body: fixed.readable });
  await piping.catch(() => {});
  if (!res.ok) throw new Error(`Google Drive への音声のアップロードに失敗しました（${res.status}）: ${(await res.text()).slice(0, 300)}`);
  return (await res.json<{ id: string }>()).id;
}

export const driveFolderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

// ---------- Gmail で送信（送信元の社員になりかわる） ----------

const b64utf8 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export async function sendGmail(env: Env, fromSetting: string, to: string[], subject: string, body: string) {
  // 連携している場合は、そのアカウントから送る（他人のアドレスでは送れない）
  const from = (await getLink(env.DB))?.email ?? fromSetting;
  const token = await accessToken(env, GMAIL_SEND, from);
  const mime = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64utf8(body).replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");
  const raw = b64utf8(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`メールの送信に失敗しました（${res.status}）: ${(await res.text()).slice(0, 300)}`);
}

/** 管理画面の「接続テスト」: Drive の保存先に書き込めるか、Gmail で送信できるかを確かめる（何も書き込まない・送らない） */
export async function checkGoogle(env: Env, parentId: string) {
  const results: { label: string; ok: boolean; note: string }[] = [];
  const link = await getLink(env.DB);
  if (!link && !env.GOOGLE_SERVICE_ACCOUNT_JSON) return [{ label: "Google 連携", ok: false, note: "まだ連携していません。「Google と連携」を押して許可してください" }];
  let token: string;
  try {
    token = await accessToken(env, DRIVE_WRITE);
    results.push({ label: "Google 連携", ok: true, note: link ? `${link.email} の権限で動きます` : "サービスアカウントで動きます" });
  } catch (e) {
    return [{ label: "Google 連携", ok: false, note: e instanceof Error ? e.message : String(e) }];
  }
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentId)}?supportsAllDrives=true&fields=id,name,capabilities(canAddChildren)`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(res.status === 404 ? "保存先が見つかりません。連携したアカウントが共有ドライブのメンバーか確認してください" : `${res.status} ${(await res.text()).slice(0, 200)}`);
    const f = await res.json<{ name: string; capabilities?: { canAddChildren?: boolean } }>();
    results.push({
      label: "Google Drive の保存先",
      ok: Boolean(f.capabilities?.canAddChildren),
      note: f.capabilities?.canAddChildren ? `「${f.name}」に保存できます` : `「${f.name}」は見えますが、書き込み権限がありません（共有ドライブで「コンテンツ管理者」以上にしてください）`,
    });
  } catch (e) {
    results.push({ label: "Google Drive の保存先", ok: false, note: e instanceof Error ? e.message : String(e) });
  }
  if (link) {
    // 許可の画面でチェックを外された権限がないか（実際には送らずに確かめる）
    const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`).then((r) => r.json<{ scope?: string }>(), () => ({ scope: "" }));
    const missing = LINK_SCOPES.filter((sc) => !(info.scope ?? link.scopes).split(" ").includes(sc));
    results.push(
      missing.includes(GMAIL_SEND)
        ? { label: "Gmail の送信", ok: false, note: "メール送信が許可されていません。もう一度「Google と連携」を押し、すべての項目にチェックを入れてください" }
        : { label: "Gmail の送信", ok: true, note: `${link.email} から送信できます` },
    );
  } else {
    try {
      const settingsFrom = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'mail_from'").first<{ value: string }>())?.value ?? "";
      await accessToken(env, GMAIL_SEND, settingsFrom);
      results.push({ label: "Gmail の送信", ok: true, note: `${settingsFrom} として送信できます` });
    } catch (e) {
      results.push({ label: "Gmail の送信", ok: false, note: `ドメイン全体の委任が未設定の可能性があります: ${e instanceof Error ? e.message : e}` });
    }
  }
  return results;
}


/** Drive のファイルをゴミ箱に移す（完全には消さない。30日以内なら Drive から戻せる） */
export async function trashDriveFile(env: Env, fileId: string) {
  await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}
