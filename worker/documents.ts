// 書類（PDF）の保存: HTML → PDF → R2（アプリ内の控え）＋ Google Drive（共有ドライブの所定フォルダ）
import { htmlToPdf } from "./pdf";
import { ensureFolder, googleReady, uploadToDrive } from "./google";
import { getSettings } from "./settings";

export const monthFolder = (period: string) => `${Number(period.slice(0, 4))}年${Number(period.slice(5, 7))}月分`;
/** ファイル名に使えない文字を除く */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "").trim();

export interface StoredDocument {
  pdf_key: string;
  drive_file_id: string | null;
  warnings: string[];
}

/** HTML を PDF にして保存する。ローカル開発（PDF 化できない環境）では HTML のまま控えを残す */
export async function storeDocument(env: Env, html: string, r2Key: string, driveFolders: string[], fileName: string): Promise<StoredDocument> {
  const warnings: string[] = [];
  let data: Uint8Array;
  let key = r2Key;
  let mime = "application/pdf";
  try {
    data = await htmlToPdf(env, html);
  } catch (e) {
    if (env.DEV_LOGIN !== "1") throw e;
    data = new TextEncoder().encode(html);
    key = r2Key.replace(/\.pdf$/, ".html");
    mime = "text/html; charset=utf-8";
    warnings.push("ローカル環境では PDF を作れないため、HTML で控えを保存しました（本番では PDF になります）");
  }
  await env.IMAGES.put(key, data, { httpMetadata: { contentType: mime } });
  const driveId = await saveToDrive(env, driveFolders, mime === "application/pdf" ? fileName : fileName.replace(/\.pdf$/, ".html"), mime, data, warnings);
  return { pdf_key: key, drive_file_id: driveId, warnings };
}

/** Drive に保存する。失敗しても処理は止めず、警告として返す */
export async function saveToDrive(env: Env, folders: string[], fileName: string, mime: string, data: Uint8Array | ArrayBuffer, warnings: string[]) {
  if (!(await googleReady(env))) {
    warnings.push("Google と連携していないため、Drive には保存していません（管理画面の「Google と連携」）");
    return null;
  }
  try {
    const settings = await getSettings(env.DB);
    const folderId = await ensureFolder(env, settings.drive_parent_id, folders);
    return await uploadToDrive(env, folderId, safeName(fileName), mime, data);
  } catch (e) {
    warnings.push(`Google Drive への保存に失敗しました: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** R2 に保存した書類を返す */
export async function documentResponse(env: Env, key: string | null, downloadName: string) {
  if (!key) return new Response("書類がありません", { status: 404 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("書類が見つかりません", { status: 404 });
  const type = obj.httpMetadata?.contentType ?? "application/pdf";
  const name = type.startsWith("text/html") ? downloadName.replace(/\.pdf$/, ".html") : downloadName;
  return new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
    },
  });
}
