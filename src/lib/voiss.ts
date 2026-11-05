// この Mac の Voiss（録音アプリ）のローカル API。Voiss は 127.0.0.1:47913 で待ち受け、このアプリのオリジンからの呼び出しだけを受け付ける
export const VOISS_URL = "http://127.0.0.1:47913";

export interface VoissStatus {
  app: "voiss";
  version: string;
  state: "idle" | "recording" | "transcribing";
  linked: boolean;
  user: { name: string; email: string } | null;
  recording: {
    source: "site" | "menu" | "hotkey";
    mode: "long" | "dictation";
    client_key: string | null;
    started_at: string;
    elapsed_sec: number;
    untranscribed_sec: number;
    lines: number;
  } | null;
  last_meeting: {
    client_key: string;
    started_at: string;
    result: "recording" | "transcribing" | "sending" | "sent" | "failed" | "no_speech" | "mic_failed" | "error";
    minute_id?: string | null;
    duration_sec?: number | null;
    error?: string | null;
  } | null;
}

export class VoissError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}

/** 届かないとき（Voiss が起動していない・ブラウザが止めた）は null */
export async function voissStatus(): Promise<VoissStatus | null> {
  try {
    const res = await fetch(`${VOISS_URL}/v1/status`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    return res.ok ? ((await res.json()) as VoissStatus) : null;
  } catch {
    return null;
  }
}

const MESSAGES: Record<string, string> = {
  not_linked: "この Mac の Voiss はまだ連携していません。「Voiss と連携」を押してください",
  busy: "Voiss はほかの録音か音声入力の最中です。終わってからもう一度押してください",
  not_recording: "議事録画面から始めた録音はありません",
  invalid_token: "連携キーが受け付けられませんでした。もう一度「Voiss と連携」を押してください",
  unreachable: "Voiss から社内アプリにつながりませんでした。ネットにつながっているか確かめてください",
  rejected: "社内アプリが連携を断りました（議事録が無効か、閲覧のみの権限です）",
};

export async function voissPost<T = { ok: true }>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${VOISS_URL}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new VoissError("この Mac の Voiss に届きませんでした。Voiss が起動しているか確かめてください", "offline", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new VoissError(MESSAGES[data.error ?? ""] ?? `Voiss でエラーが起きました（${data.error ?? res.status}）`, data.error ?? "", res.status);
  return data as T;
}
