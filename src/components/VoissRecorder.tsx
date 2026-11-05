// 議事録画面の「録音開始・停止」: この Mac の Voiss を操作する。止めると Voiss が文字起こしして、議事録に届く
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Stepper, useTouchDevice } from "./ui";
import { voissPost, voissStatus, type VoissStatus } from "../lib/voiss";

interface PackageInfo {
  available: boolean;
  file_name?: string;
  size?: number;
}

/** 録音中・仕上げ中は1秒ごと、それ以外は5秒ごとに Voiss の状態を見る */
const FAST_MS = 1000;
const SLOW_MS = 5000;
/** これより前の録音の結果は出さない */
const RECENT_MS = 6 * 3600_000;

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
};

const busyNow = (s: VoissStatus | null) =>
  Boolean(s && (s.state !== "idle" || ["recording", "transcribing", "sending"].includes(s.last_meeting?.result ?? "")));

export function VoissRecorder({ onArrived }: { onArrived: () => void }) {
  const { user } = useAuth();
  const touch = useTouchDevice();
  const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent) && !touch;
  const [status, setStatus] = useState<VoissStatus | null | undefined>(undefined);
  const [pkg, setPkg] = useState<PackageInfo | null>(null);
  const [error, setError] = useState("");
  /** いま押されている操作（ボタンの文字を「〜しています…」に変える） */
  const [working, setWorking] = useState<"" | "link" | "start" | "stop">("");
  /** 停止を押した時刻（仕上げにかかっている時間を出す） */
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  /** 届いた議事録を Claude がまとめ終えたか（"processing" の間は「まとめています」を出す） */
  const [minuteStatus, setMinuteStatus] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const arrived = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await voissStatus();
    setStatus(s);
    // 送り終わったら一覧を読み直す（同じ録音で何度も読み直さない）
    const m = s?.last_meeting;
    if (m?.result === "sent" && m.client_key !== arrived.current) {
      if (arrived.current !== null) onArrived();
      arrived.current = m.client_key;
    } else if (arrived.current === null) {
      arrived.current = m?.client_key ?? "";
    }
    return s;
  }, [onArrived]);

  useEffect(() => {
    if (!isMac) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const s = document.visibilityState === "visible" ? await refresh() : status ?? null;
      if (!stop) timer = setTimeout(loop, busyNow(s ?? null) ? FAST_MS : SLOW_MS);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // status は loop の中で読み直すので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, refresh]);

  useEffect(() => {
    if (status === null && !pkg) api<PackageInfo>("/api/voiss/package").then(setPkg, () => setPkg({ available: false }));
  }, [status, pkg]);

  const run = async (kind: "link" | "start" | "stop", fn: () => Promise<unknown>) => {
    setError("");
    setWorking(kind);
    try {
      await fn();
      if (kind === "stop") setStoppedAt(Date.now());
      if (kind === "start") (setStoppedAt(null), setMinuteStatus(null));
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  };

  /** ログイン中の人の連携キーを発行して、この Mac の Voiss に渡す（キーは画面に出さない） */
  const link = () =>
    run("link", async () => {
      const { id, token } = await api<{ id: string; token: string }>("/api/voiss/tokens", { body: { name: "Mac（議事録画面から連携）" } });
      try {
        await voissPost("/v1/link", { token });
      } catch (e) {
        await api(`/api/voiss/tokens/${id}`, { method: "DELETE" }).catch(() => {});
        throw e;
      }
    });
  const start = () => run("start", () => voissPost("/v1/recording/start"));
  const stopRecording = () => run("stop", () => voissPost("/v1/recording/stop"));

  // 届いた議事録は、Claude がまとめ終えるまで3秒ごとに状態を見る
  const lastMinuteId = status?.last_meeting?.result === "sent" ? status.last_meeting.minute_id ?? null : null;
  useEffect(() => {
    if (!lastMinuteId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const st = await api<{ document: { status: string } }>(`/api/minutes/${lastMinuteId}`).then((r) => r.document.status, () => null);
      if (stop) return;
      setMinuteStatus(st);
      if (st === "processing" || st === "pending") timer = setTimeout(check, 3000);
      else if (st === "done") onArrived();
    };
    check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [lastMinuteId, onArrived]);

  // 仕上げ中は経過時間を1秒ごとに進める
  const finishing = Boolean(stoppedAt) && (status?.state === "transcribing" || ["transcribing", "sending"].includes(status?.last_meeting?.result ?? "") || minuteStatus === "processing" || minuteStatus === "pending");
  useEffect(() => {
    if (!finishing) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [finishing]);

  if (!isMac) {
    return (
      <div className="panel voiss-recorder">
        <h2>会議の録音</h2>
        <p className="muted small">会議の録音は Mac で行います。Mac でこの画面を開き、「録音開始」を押すと、その Mac の Voiss が録音して文字起こしします。</p>
      </div>
    );
  }

  const s = status;
  const otherUser = s?.linked && s.user && s.user.email.toLowerCase() !== user.email.toLowerCase();
  const rec = s?.recording;
  const last = s?.last_meeting && Date.now() - Date.parse(s.last_meeting.started_at) < RECENT_MS ? s.last_meeting : null;

  let body: React.ReactNode;
  if (s === undefined) {
    body = <p className="muted small">この Mac の Voiss を確かめています…</p>;
  } else if (s === null) {
    body = (
      <>
        <p>この Mac で Voiss が見つかりません。入れてあれば、Voiss を起動してください。</p>
        {pkg?.available ? (
          <p>
            <a className="btn btn-primary btn-small" href="/api/voiss/download">
              Voiss をダウンロード
            </a>{" "}
            <span className="muted small">zip を開き、中の「会議録音の使い方」の手順で入れます（Apple Silicon の Mac）</span>
          </p>
        ) : (
          pkg && <p className="muted small">ダウンロード用の Voiss はまだ置かれていません。管理者に頼んでください。</p>
        )}
        <p className="muted small">
          Voiss が起動しているのに見つからないときは、ブラウザが「ローカルネットワーク」へのアクセスを止めています。Chrome で開き、アクセスの許可を求められたら「許可」を押してください。
        </p>
      </>
    );
  } else if (!s.linked || otherUser) {
    body = (
      <>
        <p>{otherUser ? `この Mac の Voiss は ${s.user!.name}さんと連携しています。あなたの録音として送るには、連携し直してください。` : "この Mac の Voiss はまだ連携していません。"}</p>
        <button className="btn btn-primary" onClick={link} disabled={Boolean(working)}>
          {working === "link" ? "連携しています…" : "Voiss と連携"}
        </button>
      </>
    );
  } else if (rec && rec.source === "site") {
    body = (
      <>
        <p className="voiss-live">
          <span className="voiss-dot" aria-hidden="true" />
          <strong>録音中 {clock(rec.elapsed_sec)}</strong>
          <span className="muted small"> ・ 文字起こし {rec.lines}行{rec.untranscribed_sec > 30 ? `（${Math.round(rec.untranscribed_sec)}秒ぶん待ち）` : ""}</span>
        </p>
        <button className="btn btn-primary" onClick={stopRecording} disabled={Boolean(working)}>
          {working === "stop" ? "停止しています…" : "停止"}
        </button>
        <p className="muted small">止めると、残りを文字起こしして、この画面に届きます。Mac のメニューバーの Voiss からも止められます。</p>
      </>
    );
  } else if (rec) {
    body = <p>Voiss はほかの録音か音声入力の最中です。終わってから録音を始めてください。</p>;
  } else if (s.state === "transcribing" || last?.result === "transcribing") {
    body = <FinishProgress step={1} stoppedAt={stoppedAt} text="Mac で残りの音声を文字起こししています。" />;
  } else if (last?.result === "sending") {
    body = <FinishProgress step={2} stoppedAt={stoppedAt} text="文字起こしを社内アプリに送っています。" />;
  } else if (last?.result === "sent" && (minuteStatus === "processing" || minuteStatus === "pending")) {
    body = <FinishProgress step={3} stoppedAt={stoppedAt} text="Claude がタスクを抜き出し、全文を Drive に保存しています。長い会議は数分かかります（この画面は閉じても大丈夫です）。" />;
  } else {
    body = (
      <>
        <button className="btn btn-primary" onClick={start} disabled={Boolean(working)}>
          {working === "start" ? "録音を始めています…" : "録音開始"}
        </button>
        <p className="muted small">押すと、この Mac の Voiss が録音を始めます（{s.user?.name}さんの録音として届きます）。止めると文字起こしして、この画面に届きます。</p>
      </>
    );
  }

  return (
    <div className="panel voiss-recorder">
      <h2>会議の録音</h2>
      {body}
      {last && !rec && last.result !== "recording" && last.result !== "transcribing" && last.result !== "sending" && !(last.result === "sent" && (minuteStatus === "processing" || minuteStatus === "pending")) && (
        <p className="small">
          {last.result === "sent" ? (
            <>
              {minuteStatus === "done" ? "前回の録音は議事録になりました" : "前回の録音は届きました"}
              {last.minute_id && (
                <>
                  {"（"}
                  <Link to={`/minutes/${last.minute_id}`}>開く</Link>
                  {"）"}
                </>
              )}
            </>
          ) : last.result === "no_speech" ? (
            <span className="muted">前回の録音は、話し声が入っていなかったため送りませんでした。</span>
          ) : last.result === "mic_failed" ? (
            <span className="notice-error">前回の録音は、マイクを開けませんでした。Mac のマイクの許可を確かめてください。</span>
          ) : (
            <span className="notice-error">前回の録音は送れませんでした{last.error ? `: ${last.error}` : ""}。Voiss が送り直します。</span>
          )}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const FINISH_STEPS = ["録音", "文字起こし", "送信", "タスクの抜き出し・保存", "完了"];

/** 停止したあとの仕上げ: いまどの段階か・停止から何秒たったかを出す（止まって見えないように） */
function FinishProgress({ step, stoppedAt, text }: { step: number; stoppedAt: number | null; text: string }) {
  const elapsed = stoppedAt ? Math.floor((Date.now() - stoppedAt) / 1000) : null;
  return (
    <div className="voiss-finish" role="status" aria-live="polite">
      <Stepper steps={FINISH_STEPS} current={step} />
      <p className="voiss-working">
        <span className="spinner" aria-hidden="true" />
        <span>
          {text}
          {elapsed !== null && <span className="muted small">（停止から {clock(elapsed)}）</span>}
        </span>
      </p>
    </div>
  );
}
