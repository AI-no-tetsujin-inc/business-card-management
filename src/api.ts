export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith("/login")) location.href = "/login";
    throw new ApiError(data.error ?? `エラーが発生しました（${res.status}）`, res.status);
  }
  return data as T;
}

export async function uploadImage(blob: Blob): Promise<string> {
  const res = await fetch("/api/images", {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: blob,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !data.key) throw new ApiError(data.error ?? "画像のアップロードに失敗しました", res.status);
  return data.key;
}

export const imageUrl = (key: string) => `/api/images/${key}`;

export async function downloadCsv(ids: string[]) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
    credentials: "same-origin",
  });
  if (!res.ok) throw new ApiError("CSV の出力に失敗しました", res.status);
  const blob = await res.blob();
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(/-/g, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `名刺_${date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
