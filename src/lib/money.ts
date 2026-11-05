// 経理まわりの画面で共通に使う小物
export const yen = (n: number | string | null | undefined) => `¥${Number(n ?? 0).toLocaleString("ja-JP")}`;

/** 日本時間の今月 YYYY-MM */
export const thisMonth = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
/** 日本時間の今日 YYYY-MM-DD */
export const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export const shiftMonth = (p: string, d: number) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
};

/** 2026-10 → 2026年10月 */
export const monthLabel = (p: string) => `${Number(p.slice(0, 4))}年${Number(p.slice(5, 7))}月`;

/** 2026-10-05 → 2026年10月5日 */
export const jpDate = (d: string | null | undefined) => (d ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : "");

/** 書類（HTML）を新しいタブで開く。POST が必要なプレビュー用 */
export async function openHtml(path: string, body?: unknown) {
  const w = window.open("", "_blank");
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  if (!res.ok) {
    w?.close();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* そのまま */
    }
    throw new Error(msg);
  }
  if (w) {
    w.document.open();
    w.document.write(text);
    w.document.close();
  }
}

/** multipart で送る（領収書・過去の書類） */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `エラーが発生しました（${res.status}）`);
  return data;
}
