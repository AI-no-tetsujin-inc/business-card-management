// 画面共通の部品: トースト・ボトムシート・スケルトン・進捗メーター・手順表示・コピー・未保存の保護
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// ---------- トースト（保存・コピー・ごみ箱などの結果をその場で知らせる） ----------

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error" | "info";
  action?: { label: string; onClick: () => void | Promise<void> };
}
type ShowToast = (text: string, opts?: { kind?: Toast["kind"]; action?: Toast["action"]; duration?: number }) => void;

const ToastContext = createContext<ShowToast>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const close = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback<ShowToast>(
    (text, opts = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, text, kind: opts.kind ?? "ok", action: opts.action }]);
      // 「元に戻す」付きは長めに出す
      setTimeout(() => close(id), opts.duration ?? (opts.action ? 8000 : 3500));
    },
    [close],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={async () => {
                  close(t.id);
                  await t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="閉じる" onClick={() => close(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- ボトムシート（スマホの絞り込み・メニュー） ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // フォーカスをシートの中に閉じ込める
      if (e.key === "Tab") {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const [first, last] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sheet-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      opener?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn btn-small" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- スケルトン（読み込み中に実際の形を先に出す） ----------

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="list" aria-busy="true" aria-label="読み込み中">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="list-row">
          <div className="list-item skeleton-row">
            <div className="thumb skeleton" />
            <div className="list-main">
              <div className="skeleton skeleton-line" style={{ width: "40%" }} />
              <div className="skeleton skeleton-line" style={{ width: "65%" }} />
              <div className="skeleton skeleton-line short" style={{ width: "50%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SkeletonDetail() {
  return (
    <div className="page" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton skeleton-line" style={{ width: 120 }} />
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" style={{ width: "45%" }} />
      <div className="review-layout" style={{ marginTop: 16 }}>
        <div className="review-images">
          <div className="skeleton skeleton-card" />
        </div>
        <div className="review-form">
          <div className="panel">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="skeleton skeleton-line" style={{ width: `${50 + ((i * 13) % 40)}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 進捗メーター ----------

export function ProgressMeter({ value, label, note }: { value: number; label: string; note?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress-meter">
      <div className="between row small">
        <span>{label}</span>
        <strong aria-hidden="true">{v}%</strong>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={`${label} ${v}%`}>
        <div className="progress-fill" style={{ width: `${v}%` }} />
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}

// ---------- 手順表示（写真選択 → 読み取り → 確認・修正 → 登録） ----------

export const REGISTER_STEPS = ["写真を選ぶ", "読み取り", "確認・修正", "登録"];

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="登録の手順">
      {steps.map((s, i) => (
        <li key={s} className={i < current ? "done" : i === current ? "current" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="stepper-num">{i < current ? "✓" : i + 1}</span>
          <span className="stepper-label">{s}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------- コピー ----------

/** クリップボードにコピーする。失敗したら成功表示は出さず、文字の選択でコピーする方法を案内する */
export async function copyText(value: string, label: string, toast: ShowToast) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("unsupported");
    await navigator.clipboard.writeText(value);
    toast(`${label}をコピーしました`);
    return true;
  } catch {
    toast(`${label}をコピーできませんでした。もう一度押すか、文字を長押し（PC はドラッグ）して選択してコピーしてください`, { kind: "error", duration: 6000 });
    return false;
  }
}

export function CopyButton({ value, label, text = "コピー" }: { value: string; label: string; text?: string }) {
  const toast = useToast();
  if (!value) return null;
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={`${label}をコピー`}
      onClick={(e) => {
        // 電話・メールのリンクを開かないように、コピーだけを行う
        e.preventDefault();
        e.stopPropagation();
        void copyText(value, label, toast);
      }}
    >
      {text}
    </button>
  );
}

// ---------- 未保存の入力の保護 ----------

const dirtyForms = new Set<string>();
/** 画面内に未保存の入力があるか（メニューで別の画面に移るときに確認する） */
export const hasUnsaved = () => dirtyForms.size > 0;
export const confirmLeave = () => !hasUnsaved() || confirm("保存していない入力があります。このまま移動しますか？");

export function useUnsavedGuard(dirty: boolean) {
  const id = useRef(Math.random().toString(36).slice(2));
  useEffect(() => {
    const key = id.current;
    if (!dirty) {
      dirtyForms.delete(key);
      return;
    }
    dirtyForms.add(key);
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      dirtyForms.delete(key);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);
}

// ---------- 画面の種類 ----------

/** 指で操作する端末（スマホ・タブレット） */
export function useTouchDevice() {
  const detect = () => typeof matchMedia !== "undefined" && (matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints > 0 && matchMedia("(max-width: 1024px)").matches));
  const [touch, setTouch] = useState(detect);
  useEffect(() => {
    const mq = matchMedia("(pointer: coarse)");
    const on = () => setTouch(detect());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return touch;
}

/** 開閉できる説明（要点を先に出し、詳しくは開いて読む） */
export function Hint({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="hint">
      <summary>{summary}</summary>
      <div className="small muted">{children}</div>
    </details>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? (
    <span className="field-error" role="alert">
      {message}
    </span>
  ) : null;
}

/** 編集フォーム（開いたときの内容から変わったら未保存とみなす）。閉じたら解除 */
export function useEditingGuard(value: unknown) {
  const initial = useRef<string | null>(null);
  const json = value == null ? null : JSON.stringify(value);
  if (json === null) initial.current = null;
  else if (initial.current === null) initial.current = json;
  useUnsavedGuard(json !== null && json !== initial.current);
}
