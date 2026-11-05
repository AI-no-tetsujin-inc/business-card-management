// 「押せた」「読み込み中」「あとどれくらいか」を画面に出す（全画面共通）
// - 通信中は画面の一番上に細いバーを流す
// - ボタンを押してから始まった通信が終わるまで、そのボタンにくるくる（data-busy）を付ける
// - 1秒以上かかっている処理は、過去にかかった時間から「何%・あと約何秒」を出す（初めての処理は経過秒数）
// 個々の画面のコードを変えなくても、すべてのボタンで同じように分かるようにする

/** 裏で定期的に呼ぶもの（ユーザーの操作ではない）は数えない */
const BACKGROUND = [/^\/api\/drafts\/(status|count)/, /^\/api\/images\//, /^\/api\/me$/];
/** ボタンを押してからこの時間内に始まった通信を、そのボタンの処理とみなす（写真の準備などで少し間が空いても拾う） */
const CLICK_WINDOW_MS = 2500;
/** これより早く終わる通信ではバーを出さない（ちらつき防止） */
const BAR_DELAY_MS = 150;
/** これより長くかかったら「何%・あと何秒」を出す */
const STATUS_DELAY_MS = 1000;
const STORE_KEY = "meishi:durations";

interface Active {
  key: string;
  start: number;
  estimate: number | null;
  el: HTMLElement | null;
}

let lastClick: { el: HTMLElement; at: number } | null = null;
let barTimer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let bar: HTMLDivElement | null = null;
let status: HTMLDivElement | null = null;
const active = new Set<Active>();
const busyCount = new WeakMap<HTMLElement, number>();

// ---------- かかった時間の記録（端末ごと・処理の種類ごと） ----------

let durations: Record<string, number> = {};
try {
  durations = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
} catch {
  durations = {};
}
/** 同じ種類の処理をまとめる（ID や番号は :id にする） */
const keyOf = (method: string, path: string) => `${method} ${path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}|\/[0-9a-f]{16,}|\/\d+/gi, "/:id")}`;
function remember(key: string, ms: number) {
  const prev = durations[key];
  // 直近の結果を重く見た平均（毎回ばらつくので、1回の外れ値に引っぱられすぎないように）
  durations[key] = prev ? Math.round(prev * 0.6 + ms * 0.4) : Math.round(ms);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(durations));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

// ---------- 表示 ----------

function ensureElements() {
  if (bar) return;
  bar = document.createElement("div");
  bar.className = "net-bar";
  bar.setAttribute("aria-hidden", "true");
  status = document.createElement("div");
  status.className = "net-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  document.body.append(bar, status);
}

function setBar(on: boolean) {
  ensureElements();
  bar!.classList.toggle("on", on);
  document.documentElement.toggleAttribute("data-loading", on);
}

/** いちばん長くかかっている処理について「何%・あと何秒」を出す */
function tick() {
  const now = performance.now();
  let longest: Active | null = null;
  for (const a of active) if (!longest || a.start < longest.start) longest = a;
  if (!longest || now - longest.start < STATUS_DELAY_MS) {
    status?.classList.remove("on");
    return;
  }
  ensureElements();
  const elapsed = now - longest.start;
  const est = longest.estimate;
  let text: string;
  let pct: number | null = null;
  if (est && est >= STATUS_DELAY_MS) {
    // 予想を超えたら 95% から先はゆっくり進める（100% で止まって見えないように）
    pct = elapsed < est ? Math.round((elapsed / est) * 95) : Math.min(99, 95 + Math.round(((elapsed - est) / est) * 4));
    const left = Math.ceil((est - elapsed) / 1000);
    text = left > 0 ? `処理中 ${pct}% ・ あと約${left}秒` : `処理中 ${pct}% ・ もうすぐ終わります`;
  } else {
    text = `処理中 ・ ${Math.floor(elapsed / 1000)}秒経過`;
  }
  status!.textContent = text;
  status!.style.setProperty("--p", `${pct ?? 0}%`);
  status!.classList.toggle("indeterminate", pct === null);
  status!.classList.add("on");
}

// ---------- 通信の開始・終了 ----------

function begin(a: Active) {
  active.add(a);
  if (active.size === 1 && !barTimer) barTimer = setTimeout(() => ((barTimer = null), active.size > 0 && setBar(true)), BAR_DELAY_MS);
  if (!ticker) ticker = setInterval(tick, 250);
  if (a.el) {
    busyCount.set(a.el, (busyCount.get(a.el) ?? 0) + 1);
    a.el.setAttribute("data-busy", "");
    a.el.setAttribute("aria-busy", "true");
  }
}

function end(a: Active, ok: boolean) {
  active.delete(a);
  if (ok) remember(a.key, performance.now() - a.start);
  if (active.size === 0) {
    if (barTimer) clearTimeout(barTimer);
    barTimer = null;
    setBar(false);
    if (ticker) clearInterval(ticker);
    ticker = null;
    status?.classList.remove("on");
  }
  const el = a.el;
  if (!el) return;
  // 続けて始まる通信（保存 → 一覧の読み直し など）も同じボタンの処理として扱う
  if (el.isConnected) lastClick = { el, at: performance.now() };
  busyCount.set(el, (busyCount.get(el) ?? 1) - 1);
  // 次の通信がすぐ続く場合に印がちらつかないよう、少し待ってから外す
  setTimeout(() => {
    if ((busyCount.get(el) ?? 0) > 0) return;
    el.removeAttribute("data-busy");
    el.removeAttribute("aria-busy");
  }, 120);
}

/** この Mac の Voiss（録音アプリ）のローカル API。録音の開始・停止・連携もボタンの処理として数える（状態の確認は数えない） */
const VOISS_ORIGIN = "http://127.0.0.1:47913";

/** 数える通信なら、種類を分けるためのパスを返す（数えないなら null） */
const pathOf = (input: RequestInfo | URL) => {
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (u.origin === VOISS_ORIGIN) return u.pathname === "/v1/status" ? null : `/voiss${u.pathname}`;
    if (u.origin !== location.origin) return null;
    return (u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/")) && !BACKGROUND.some((r) => r.test(u.pathname)) ? u.pathname : null;
  } catch {
    return null;
  }
};

export function installActivityFeedback() {
  // 押したボタン・リンクを覚えておく（押した瞬間の見た目は CSS の :active で出す）
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("button, .btn, [role='button'], .quick-actions a, .tabbar a, .tabbar label");
      lastClick = el && !(el as HTMLButtonElement).disabled ? { el, at: performance.now() } : null;
    },
    true,
  );
  // 確認ダイアログ（「よろしいですか？」）に答えている間は時間を数えない
  for (const name of ["confirm", "alert", "prompt"] as const) {
    const original = window[name].bind(window) as (...args: unknown[]) => unknown;
    (window as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const r = original(...args);
      if (lastClick) lastClick.at = performance.now();
      return r;
    };
  }
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (!path) return original(input, init);
    const el = lastClick && performance.now() - lastClick.at < CLICK_WINDOW_MS && lastClick.el.isConnected ? lastClick.el : null;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const key = keyOf(method, path);
    const a: Active = { key, start: performance.now(), estimate: durations[key] ?? null, el };
    begin(a);
    return original(input, init).then(
      (res) => (end(a, res.ok), res),
      (err) => {
        end(a, false);
        throw err;
      },
    );
  };
}
