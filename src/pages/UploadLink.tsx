import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { errorMessage } from "../api";
import { prepareImage, type PreparedImage } from "../lib/image";

/** AI 経由で登録した人物に名刺画像を付ける画面（使い捨てリンク・ログイン不要） */
export function UploadLinkPage() {
  const { token } = useParams();
  const [info, setInfo] = useState<{ person_name: string; company_name: string } | null>(null);
  const [front, setFront] = useState<PreparedImage | null>(null);
  const [back, setBack] = useState<PreparedImage | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/upload-api/${token}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        setInfo(data);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  const pick = (setter: (p: PreparedImage) => void) => async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setStatus("画像を準備しています…");
    try {
      setter(await prepareImage(file));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus("");
    }
  };

  const upload = async (blob: Blob) => {
    const r = await fetch(`/upload-api/${token}/image`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data.key as string;
  };

  const submit = async () => {
    if (!front) return;
    setStatus("アップロードしています…");
    setError("");
    try {
      const [ff, fd, bf, bd] = await Promise.all([
        upload(front.full),
        upload(front.display),
        back ? upload(back.full) : Promise.resolve(""),
        back ? upload(back.display) : Promise.resolve(""),
      ]);
      const r = await fetch(`/upload-api/${token}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ front: { full: ff, display: fd }, back: back ? { full: bf, display: bd } : undefined }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus("");
    }
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <h1>名刺の画像を追加</h1>
        {done ? (
          <p>保存しました。このページは閉じてかまいません。</p>
        ) : !info ? (
          <p className={error ? "error" : "muted"}>{error || "確認しています…"}</p>
        ) : (
          <>
            <p>
              <strong>{info.person_name}</strong>
              {info.company_name && <span className="muted">（{info.company_name}）</span>}
            </p>
            {[
              { label: "表面", img: front, set: setFront, required: true },
              { label: "裏面", img: back, set: setBack, required: false },
            ].map(({ label, img, set, required }) => (
              <div key={label} className="picker" style={{ marginBottom: 12 }}>
                <div className="picker-label">
                  {label}
                  {required ? <span className="req">必須</span> : <span className="muted small">任意</span>}
                </div>
                {img ? (
                  <div className="picker-preview">
                    <img src={img.previewUrl} alt={label} />
                  </div>
                ) : (
                  <label className="picker-drop">
                    <input type="file" accept="image/*,.heic,.heif" onChange={(e) => pick(set)(e.target.files?.[0])} />
                    <span>撮影する・写真を選ぶ</span>
                  </label>
                )}
              </div>
            ))}
            {status && <p className="progress">{status}</p>}
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={!front || Boolean(status)} onClick={submit}>
              保存する
            </button>
            <p className="muted small">このリンクは15分間・1回だけ使えます。写真の位置情報は保存されません。</p>
          </>
        )}
      </div>
    </div>
  );
}
