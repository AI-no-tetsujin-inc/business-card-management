// 連続撮影の受付キュー。画面を移っても送信と読み取りの確認を続ける（画面には useCaptureQueue で出す）。
// 1人分の表・裏は必ず1つの項目として扱う。撮影ごとに client_key を振り、再送・連打で同じ名刺を二重に作らない
import { useSyncExternalStore } from "react";
import { api, errorMessage, uploadImage } from "../api";
import type { PreparedImage } from "./image";

export type ItemState =
  | "sending" // 送信中（まだ受け付けられていない）
  | "send_failed" // 送信できなかった（写真は端末に残っているので再送できる）
  | "lost" // 送信中に画面を閉じた・再読み込みした（写真が残っていない）
  | "reading" // 受付済み・読み取り中
  | "ready" // 確認待ち（問題なし）
  | "flagged" // 確認待ち（要確認）
  | "duplicate" // 確認待ち（重複候補）
  | "failed" // 読み取り失敗
  | "registered"
  | "discarded";

export interface CaptureItem {
  key: string;
  createdAt: number;
  acceptedAt?: number;
  state: ItemState;
  draftId?: string;
  error?: string;
  /** 一覧に出す小さな画像（その場限り。再読み込み後は出ない） */
  thumb?: string;
  hasBack: boolean;
  name?: string;
  company?: string;
}

interface Pending {
  front: PreparedImage;
  back: PreparedImage | null;
}

const STORE_KEY = "meishi:capture-session";
const blobs = new Map<string, Pending>();
let items: CaptureItem[] = load();
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function load(): CaptureItem[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as CaptureItem[];
    // 送信途中で閉じたものは写真が残っていないので「送信できなかった（撮り直し）」にする
    return saved.map((i) => (i.state === "sending" || i.state === "send_failed" ? { ...i, state: "lost", thumb: undefined } : { ...i, thumb: undefined }));
  } catch {
    return [];
  }
}

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(items.map(({ thumb: _t, ...rest }) => rest)));
  } catch {
    /* 保存できなくても動く */
  }
}

function set(next: CaptureItem[]) {
  items = next;
  save();
  listeners.forEach((l) => l());
}
const patch = (key: string, p: Partial<CaptureItem>) => set(items.map((i) => (i.key === key ? { ...i, ...p } : i)));

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function send(key: string) {
  const p = blobs.get(key);
  if (!p) return patch(key, { state: "lost", error: "写真が端末に残っていません。撮り直してください" });
  patch(key, { state: "sending", error: undefined });
  try {
    const uploads = [p.front.full, p.front.display, p.back?.full, p.back?.display];
    const keys = await Promise.all(uploads.map((b) => (b ? uploadImage(b) : Promise.resolve(undefined))));
    const [front_full, front_display, back_full, back_display] = keys;
    const r = await api<{ id: string; accepted: boolean }>("/api/drafts", {
      body: { front_full, front_display, back_full, back_display, exchanged_on: p.front.takenOn ?? p.back?.takenOn ?? "", client_key: key },
    });
    // 受け付けられたら端末の写真は手放す（読み取りはサーバーで続く）
    blobs.delete(key);
    patch(key, { state: "reading", draftId: r.id, acceptedAt: Date.now() });
    schedulePoll(1500);
  } catch (e) {
    patch(key, { state: "send_failed", error: errorMessage(e) });
  }
}

/** 1人分（表・裏）を受付に回す。送信は裏で進むので、すぐに次の人を撮れる */
export function enqueueCapture(front: PreparedImage, back: PreparedImage | null) {
  const key = newKey();
  blobs.set(key, { front, back });
  set([{ key, createdAt: Date.now(), state: "sending", hasBack: Boolean(back), thumb: front.previewUrl }, ...items]);
  void send(key);
  return key;
}

/** 失敗した分だけやり直す（同じ client_key で送るので、受付済みなら二重にならない） */
export async function retryCapture(key: string) {
  const it = items.find((i) => i.key === key);
  if (!it) return;
  if (it.state === "send_failed") return send(key);
  if (it.state === "failed" && it.draftId) {
    patch(key, { state: "reading", error: undefined, acceptedAt: Date.now() });
    try {
      await api(`/api/drafts/${it.draftId}/retry`, { body: {} });
    } finally {
      schedulePoll(500);
    }
  }
}

export function clearFinished() {
  set(items.filter((i) => ["sending", "send_failed", "reading"].includes(i.state)));
}

const ACTIVE: ItemState[] = ["reading"];

async function poll() {
  pollTimer = null;
  const targets = items.filter((i) => i.draftId && ACTIVE.includes(i.state));
  if (!targets.length) return;
  try {
    const r = await api<{ drafts: { id: string; state: ItemState; error?: string | null; person_name?: string; company_name?: string }[] }>(
      `/api/drafts/status?ids=${targets.map((t) => t.draftId).join(",")}`,
    );
    for (const d of r.drafts) {
      const it = items.find((i) => i.draftId === d.id);
      if (it && it.state !== d.state) patch(it.key, { state: d.state, error: d.error ?? undefined, name: d.person_name, company: d.company_name });
    }
  } catch {
    /* 通信が戻ったら次の確認で更新する */
  }
  if (items.some((i) => ACTIVE.includes(i.state))) schedulePoll(3000);
}

function schedulePoll(ms: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}
// 画面を開き直したときも、読み取り中のものの確認を再開する
if (items.some((i) => ACTIVE.includes(i.state))) schedulePoll(500);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCaptureQueue() {
  const list = useSyncExternalStore(subscribe, () => items);
  const count = (states: ItemState[]) => list.filter((i) => states.includes(i.state)).length;
  return {
    items: list,
    counts: {
      captured: list.length,
      sending: count(["sending"]),
      reading: count(["sending", "reading"]),
      waiting: count(["ready", "flagged", "duplicate"]),
      failed: count(["send_failed", "failed", "lost"]),
      registered: count(["registered"]),
    },
  };
}

export const STATE_LABEL: Record<ItemState, string> = {
  sending: "送信中",
  send_failed: "送信できませんでした",
  lost: "送信が中断されました",
  reading: "受付済み・読み取り中",
  ready: "確認待ち（問題なし）",
  flagged: "確認待ち（要確認）",
  duplicate: "確認待ち（重複候補）",
  failed: "読み取り失敗",
  registered: "登録済み",
  discarded: "破棄済み",
};
