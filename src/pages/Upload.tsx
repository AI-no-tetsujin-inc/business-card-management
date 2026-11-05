// 名刺の登録（撮影）: 表 → 裏（または裏なし・撮り直し）→ 受付 → 次の人へ。読み取りの完了は待たない
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { errorMessage } from "../api";
import { useAuth } from "../auth";
import { REGISTER_STEPS, Stepper, useTouchDevice } from "../components/ui";
import { readingProgress, takeCapturedFront } from "../lib/capture";
import { clearFinished, enqueueCapture, retryCapture, STATE_LABEL, useCaptureQueue, type CaptureItem } from "../lib/captureQueue";
import { prepareImage, type PreparedImage } from "../lib/image";

const ACCEPT = "image/*,.heic,.heif";

export function UploadPage() {
  const location = useLocation();
  const captured = (location.state as { captured?: number } | null)?.captured;
  const [mode, setMode] = useState<"single" | "bulk">("single");
  // 下の「撮影」ボタンで撮ったときは、1人分の画面を開き直して表面として受け取る
  useEffect(() => {
    if (captured) setMode("single");
  }, [captured]);
  return (
    <div className="page narrow">
      <h1>名刺を登録する</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "single"} className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>
          撮影（1人ずつ続けて）
        </button>
        <button role="tab" aria-selected={mode === "bulk"} className={mode === "bulk" ? "active" : ""} onClick={() => setMode("bulk")}>
          まとめて取り込み
        </button>
      </div>
      {mode === "single" ? <ContinuousCapture key={captured ?? "single"} /> : <BulkUpload />}
      <SessionStatus />
    </div>
  );
}

/** スマホは capture でその場でカメラを起動する。写真の選択も補助として残す */
function PickButton({ label, onPick, primary = true, camera = true, disabled }: { label: string; onPick: (f: File) => void; primary?: boolean; camera?: boolean; disabled?: boolean }) {
  return (
    <label className={`btn ${primary ? "btn-primary" : ""} btn-block camera-btn ${disabled ? "disabled" : ""}`} aria-disabled={disabled}>
      <input
        type="file"
        accept={ACCEPT}
        capture={camera ? "environment" : undefined}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onPick(f);
        }}
      />
      {label}
    </label>
  );
}

function ContinuousCapture() {
  const touch = useTouchDevice();
  const { refreshPending } = useAuth();
  const { items } = useCaptureQueue();
  const [front, setFront] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState<"" | "front" | "back">("");
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const last = items.find((i) => i.key === lastKey) ?? null;

  const prepare = async (side: "front" | "back", file: File) => {
    setError("");
    setPreparing(side);
    try {
      const img = await prepareImage(file);
      if (side === "front") {
        setLastKey(null);
        setFront(img);
      } else submit(img);
    } catch (e) {
      setError(`${errorMessage(e)}（もう一度撮影するか、写真から選んでください）`);
    } finally {
      setPreparing("");
    }
  };

  // どの画面からでも押せる「撮影」ボタンで撮った表面を受け取る
  useEffect(() => {
    const f = takeCapturedFront();
    if (f) prepare("front", f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 確認待ちが増えたらナビの件数を更新する
  useEffect(() => {
    refreshPending();
  }, [items.filter((i) => i.state !== "reading" && i.state !== "sending").length, refreshPending]);

  const submit = (back: PreparedImage | null) => {
    if (!front) return;
    setLastKey(enqueueCapture(front, back));
    setFront(null);
  };

  const camHint = <p className="muted small">カメラが開かないときは、ブラウザの設定でカメラを許可するか「写真から選ぶ」を使ってください。</p>;

  // 1. 受付の結果（送信中 → 受付済み）
  if (last && !front) {
    const sending = last.state === "sending";
    const sendFailed = last.state === "send_failed" || last.state === "lost";
    return (
      <div className="panel">
        <Stepper steps={REGISTER_STEPS} current={1} />
        <div className="accepted" role="status" aria-live="polite">
          {last.thumb && <img src={last.thumb} alt="受け付けた名刺（表面）" />}
          {sending ? (
            <p className="capture-guide">送信しています…</p>
          ) : sendFailed ? (
            <>
              <p className="capture-guide error">送信できませんでした</p>
              <p className="small">{last.error}</p>
              {last.state === "send_failed" && (
                <button className="btn btn-primary btn-block" onClick={() => retryCapture(last.key)}>
                  もう一度送る
                </button>
              )}
            </>
          ) : (
            <p className="capture-guide">
              <strong>受け付けました</strong>
              <br />
              <span className="small muted">読み取りは裏で進みます。終わったら「確認待ち」に入ります。</span>
            </p>
          )}
        </div>
        {!sending && (
          <div className="capture-flow">
            {touch ? (
              <PickButton label="次の人を撮る" onPick={(f) => prepare("front", f)} />
            ) : (
              <PickButton label="次の人の表面を選ぶ" camera={false} onPick={(f) => prepare("front", f)} />
            )}
            <Link className="btn btn-block" to="/drafts">
              確認待ちを見る
            </Link>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    );
  }

  // 2. 表面を撮る
  if (!front) {
    return (
      <div className="panel">
        <Stepper steps={REGISTER_STEPS} current={0} />
        <div className="capture-flow">
          <p className="capture-guide">
            名刺の<strong>表面</strong>を{touch ? "撮影" : "選択"}してください
          </p>
          {touch ? (
            <>
              <PickButton label={preparing ? "準備しています…" : "表面を撮影"} disabled={Boolean(preparing)} onPick={(f) => prepare("front", f)} />
              <PickButton label="写真から選ぶ" primary={false} camera={false} disabled={Boolean(preparing)} onPick={(f) => prepare("front", f)} />
              {camHint}
            </>
          ) : (
            <label className="picker-drop wide">
              <input type="file" accept={ACCEPT} onChange={(e) => e.target.files?.[0] && prepare("front", e.target.files[0])} />
              <span>{preparing ? "準備しています…" : "表面の写真を選ぶ"}</span>
            </label>
          )}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted small">読み取りを待たずに、続けて次の人を撮れます。確認・修正は、あとで「確認待ち」でまとめて行えます。写真の位置情報は保存されません。</p>
      </div>
    );
  }

  // 3. 裏面（撮る・なし・撮り直す）。表面の小さなプレビューで同じ人か確かめられる
  return (
    <div className="panel">
      <Stepper steps={REGISTER_STEPS} current={0} />
      <div className="capture-flow">
        <div className="capture-preview">
          <figure>
            <img src={front.previewUrl} alt="撮影した表面" />
            <figcaption>表面 ✓</figcaption>
          </figure>
        </div>
        <p className="capture-guide">
          <strong>裏面</strong>はありますか？
        </p>
        {touch ? (
          <PickButton label={preparing === "back" ? "準備しています…" : "裏面を撮る"} disabled={Boolean(preparing)} onPick={(f) => prepare("back", f)} />
        ) : (
          <PickButton label={preparing === "back" ? "準備しています…" : "裏面の写真を選ぶ"} camera={false} disabled={Boolean(preparing)} onPick={(f) => prepare("back", f)} />
        )}
        <button className="btn btn-block" disabled={Boolean(preparing)} onClick={() => submit(null)}>
          裏面なしで送る
        </button>
        <button className="link-button" onClick={() => setFront(null)}>
          表面を撮り直す
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** まとめて取り込み: 選んだ写真を1人分ずつ受付に回す（表・裏の順に並んでいる場合は2枚で1人分） */
function BulkUpload() {
  const [pairMode, setPairMode] = useState(false);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const select = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const files = [...fileList];
    const groups: File[][] = pairMode ? Array.from({ length: Math.ceil(files.length / 2) }, (_, i) => files.slice(i * 2, i * 2 + 2)) : files.map((f) => [f]);
    setErrors([]);
    setPreparing({ done: 0, total: groups.length });
    for (let i = 0; i < groups.length; i++) {
      try {
        const [f, b] = await Promise.all(groups[i].map(prepareImage));
        enqueueCapture(f, b ?? null);
      } catch (e) {
        setErrors((x) => [...x, `${groups[i].map((g) => g.name).join(" + ")}: ${errorMessage(e)}`]);
      }
      setPreparing({ done: i + 1, total: groups.length });
    }
    setPreparing(null);
  };

  return (
    <div className="panel">
      <Stepper steps={REGISTER_STEPS} current={preparing ? 1 : 0} />
      <label className="check-line">
        <input type="checkbox" checked={pairMode} disabled={Boolean(preparing)} onChange={(e) => setPairMode(e.target.checked)} />
        表・裏の順に並んだ写真として取り込む（2枚で1人分）
      </label>
      {pairMode && <p className="muted small">枚数が奇数のときは、最後の1枚を表面だけの名刺として扱います。</p>}
      <label className="picker-drop wide">
        <input type="file" accept={ACCEPT} multiple disabled={Boolean(preparing)} onChange={(e) => select(e.target.files)} />
        <span>{preparing ? `写真を準備しています（${preparing.done}/${preparing.total} 人分）` : "写真をまとめて選ぶ（1枚の写真に名刺1枚）"}</span>
      </label>
      {errors.length > 0 && (
        <ul className="error small">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <p className="muted small">選んだ写真は1人分ずつ受け付けます。読み取った名刺は「確認待ち」に入り、問題のないものはまとめて登録できます。</p>
    </div>
  );
}

/** この端末で撮った分の状況（画面を移って戻っても続きから表示する） */
function SessionStatus() {
  const { items, counts } = useCaptureQueue();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!items.some((i) => i.state === "reading")) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [items]);
  if (!items.length) return null;
  return (
    <section className="panel session-status" aria-label="撮影した名刺の状況">
      <div className="session-counts" role="status" aria-live="polite">
        <span>
          撮影済み <strong>{counts.captured}</strong>人
        </span>
        <span>
          読み取り中 <strong>{counts.reading}</strong>人
        </span>
        <span>
          確認待ち <strong>{counts.waiting}</strong>人
        </span>
        <span className={counts.failed ? "error" : ""}>
          失敗 <strong>{counts.failed}</strong>人
        </span>
      </div>
      <ul className="session-list">
        {items.map((it) => (
          <SessionRow key={it.key} item={it} now={now} />
        ))}
      </ul>
      <div className="row between">
        <Link to="/drafts">確認待ちへ →</Link>
        {items.some((i) => !["sending", "send_failed", "reading"].includes(i.state)) && (
          <button className="link-button small" onClick={clearFinished}>
            終わったものを一覧から消す
          </button>
        )}
      </div>
    </section>
  );
}

function SessionRow({ item: it, now }: { item: CaptureItem; now: number }) {
  const waiting = ["ready", "flagged", "duplicate", "failed"].includes(it.state);
  const pct = it.state === "reading" && it.acceptedAt ? readingProgress(now - it.acceptedAt) : null;
  return (
    <li className={`session-row s-${it.state}`}>
      {it.thumb ? <img src={it.thumb} alt="" /> : <span className="session-thumb" aria-hidden="true" />}
      <div className="session-main">
        <div className="small">
          {it.name || it.company ? `${it.name ?? ""} ${it.company ?? ""}` : new Date(it.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
          {it.hasBack ? " ・ 表裏" : " ・ 表のみ"}
        </div>
        <div className={`small ${["send_failed", "failed", "lost"].includes(it.state) ? "error" : "muted"}`}>
          {STATE_LABEL[it.state]}
          {it.error && it.state !== "reading" ? `（${it.error}）` : ""}
        </div>
        {pct !== null && (
          <div className="progress-track small-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={`読み取り中 目安 ${Math.round(pct)}%`}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {(it.state === "send_failed" || it.state === "failed") && (
        <button className="btn btn-small" onClick={() => retryCapture(it.key)}>
          再試行
        </button>
      )}
      {waiting && it.draftId && it.state !== "failed" && (
        <Link className="btn btn-small" to={`/drafts/${it.draftId}`}>
          確認
        </Link>
      )}
    </li>
  );
}
