// 立替経費のまとめて登録: Claude のスキルで領収書の写真から作った CSV と、同じ写真をまとめて入れる。
// 写真は CSV の「ファイル名」で自動的に結びつける（アプリ側では OCR も Claude API も使わない）
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { unzipSync } from "fflate";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Hint, ProgressMeter, useUnsavedGuard } from "../components/ui";
import { downloadBlob, parseCsv, readTextFile, toCsv } from "../lib/csv";
import { postForm, yen } from "../lib/money";

interface Member {
  email: string;
  display_name: string;
}
interface Receipt {
  member_email: string;
  amount: number;
  paid_on: string;
  vendor: string;
  file_name: string;
}

/** CSV の列（見出しはこの名前。英語の見出しでも読める） */
export const CSV_HEADER = ["ファイル名", "日付", "金額", "支払先", "用途", "メモ"];
const ALIASES: Record<string, string[]> = {
  no: ["番号", "no"],
  file: ["ファイル名", "写真", "画像", "file", "filename", "file_name"],
  date: ["日付", "利用日", "支払日", "date"],
  amount: ["金額", "合計", "金額（税込）", "amount", "total"],
  vendor: ["支払先", "店名", "店舗", "vendor", "store"],
  purpose: ["用途", "内容", "但し書き", "purpose"],
  note: ["メモ", "備考", "note", "memo"],
};
const EARLIEST = "2026-09-01";
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heic", pdf: "application/pdf" };

interface Row {
  key: number;
  /** スキルが振った番号（R001 など。写真のファイル名の先頭と同じ） */
  no: string;
  file_name: string;
  date: string;
  amount: string;
  vendor: string;
  purpose: string;
  note: string;
  photo: string | null; // 写真のキー（photos の名前）
  include: boolean;
  status: "pending" | "done" | "error";
  error?: string;
}

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const baseOf = (name: string) => name.split("/").pop()!.replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase();
/** 写真として受け付けるファイルか */
const isPhoto = (name: string) => Boolean(TYPES[extOf(name)]);
/** HEIC などで種類が空のことがあるので、拡張子から補う */
const withType = (f: File) => (f.type && Object.values(TYPES).includes(f.type) ? f : new File([f], f.name, { type: TYPES[extOf(f.name)] ?? f.type }));

/** 日付をそろえる（2026/10/5・2026年10月5日・R8.10.5 は不可） */
function normDate(s: string) {
  const m = s.trim().match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : s.trim();
}
const normAmount = (s: string) => s.replace(/[¥￥,，円\s]/g, "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

function issuesOf(r: Row, dupKeys: Set<string>) {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) out.push("日付");
  else if (r.date < EARLIEST) out.push("2026年9月より前");
  if (!/^\d+$/.test(r.amount) || Number(r.amount) <= 0) out.push("金額");
  if (!r.purpose.trim()) out.push("用途");
  return { errors: out, dup: dupKeys.has(`${r.date}|${Number(r.amount)}`) };
}

export function ExpenseImportPage() {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [memberEmail, setMemberEmail] = useState(user.email);
  const [rows, setRows] = useState<Row[]>([]);
  const [photos, setPhotos] = useState<Map<string, File>>(new Map());
  const [existing, setExisting] = useState<Receipt[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const isAdmin = user.role === "admin";
  useUnsavedGuard(rows.some((r) => r.status !== "done"));

  useEffect(() => {
    api<{ members: Member[] }>("/api/internal/members").then((r) => {
      setMembers(r.members);
      if (!r.members.some((m) => m.email === user.email) && r.members[0]) setMemberEmail(r.members[0].email);
    });
  }, [user.email]);
  useEffect(() => {
    api<{ receipts: Receipt[] }>(`/api/internal/receipts?member=${encodeURIComponent(memberEmail)}`).then((r) => setExisting(r.receipts), () => setExisting([]));
  }, [memberEmail]);

  // 写真のプレビュー（ブラウザで表示できる JPG・PNG だけ）
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    photos.forEach((f, k) => {
      if (f.type === "image/jpeg" || f.type === "image/png") m.set(k, URL.createObjectURL(f));
    });
    return m;
  }, [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const dupKeys = useMemo(() => new Set(existing.map((r) => `${r.paid_on}|${Number(r.amount)}`)), [existing]);
  const usedPhotos = new Set(rows.map((r) => r.photo).filter(Boolean) as string[]);
  const unusedPhotos = [...photos.keys()].filter((k) => !usedPhotos.has(k));
  const canSelectMember = isAdmin;
  const memberName = members.find((m) => m.email === memberEmail)?.display_name ?? memberEmail;

  /** ファイル名で写真を探す（完全一致 → 大文字小文字・拡張子違い） */
  const findPhoto = (name: string, pool: Map<string, File>) => {
    if (!name.trim()) return null;
    const n = name.trim().split("/").pop()!.normalize("NFC");
    if (pool.has(n)) return n;
    const lower = [...pool.keys()].find((k) => k.toLowerCase() === n.toLowerCase());
    if (lower) return lower;
    return [...pool.keys()].find((k) => baseOf(k) === baseOf(n)) ?? null;
  };

  const addFiles = async (list: FileList | File[]) => {
    setMessage(null);
    const files: File[] = [];
    for (const f of Array.from(list)) {
      if (extOf(f.name) === "zip") {
        try {
          const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
          for (const [path, data] of Object.entries(entries)) {
            const name = path.split("/").pop()!;
            if (!name || name.startsWith(".") || path.startsWith("__MACOSX")) continue;
            files.push(new File([data as BlobPart], name.normalize("NFC")));
          }
        } catch {
          setMessage({ kind: "error", text: `${f.name} を開けませんでした（ZIP が壊れているかもしれません）` });
        }
      } else files.push(new File([f], f.name.normalize("NFC"), { type: f.type }));
    }
    const nextPhotos = new Map(photos);
    const skipped: string[] = [];
    const sameName = new Set<string>();
    for (const f of files.filter((f) => isPhoto(f.name))) {
      if (f.size > MAX_BYTES) skipped.push(`${f.name}（15MB を超えています）`);
      else {
        // 名前が同じ写真（スマホの image.jpg など）は区別できないので、あとから入れたもので上書きせずに知らせる
        if (nextPhotos.has(f.name) && nextPhotos.get(f.name)!.size !== f.size) sameName.add(f.name);
        else nextPhotos.set(f.name, withType(f));
      }
    }
    if (sameName.size)
      skipped.push(
        `同じ名前の別の写真があります: ${[...sameName].join("、")}（最初の1枚だけ使います。Claude のスキルで作った番号つきの ZIP を入れると確実です）`,
      );
    let nextRows = rows;
    const csvs = files.filter((f) => extOf(f.name) === "csv");
    for (const csv of csvs) {
      const table = parseCsv(await readTextFile(csv));
      if (table.length < 2) {
        skipped.push(`${csv.name}（明細がありません）`);
        continue;
      }
      const head = table[0].map((h) => h.trim().toLowerCase());
      const col = (k: string) => head.findIndex((h) => ALIASES[k].some((a) => a.toLowerCase() === h));
      const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)]));
      if (idx.date < 0 || idx.amount < 0) {
        skipped.push(`${csv.name}（「日付」と「金額」の列が見つかりません。1行目の見出しを確認してください）`);
        continue;
      }
      const get = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");
      const base = Date.now();
      nextRows = [
        ...nextRows,
        ...table.slice(1).map((r, i) => {
          const date = normDate(get(r, "date"));
          const amount = normAmount(get(r, "amount"));
          return {
            key: base + i,
            no: get(r, "no"),
            file_name: get(r, "file"),
            date,
            amount,
            vendor: get(r, "vendor"),
            purpose: get(r, "purpose"),
            note: get(r, "note"),
            photo: null,
            // 同じ日付・金額の領収書がすでにあるものは、二重登録しないよう最初はチェックを外しておく
            include: !dupKeys.has(`${date}|${Number(amount)}`),
            status: "pending" as const,
          };
        }),
      ];
    }
    // まだ写真が決まっていない行に、ファイル名で写真を結びつける（1枚に複数の領収書が写っていれば、同じ写真を複数の行で使う）
    nextRows = nextRows.map((r) => {
      if (r.photo || r.status === "done") return r;
      const hit = findPhoto(r.file_name, nextPhotos);
      return hit ? { ...r, photo: hit } : r;
    });
    setPhotos(nextPhotos);
    setRows(nextRows);
    if (skipped.length) setMessage({ kind: "warn", text: `取り込めなかったファイル:\n・${skipped.join("\n・")}` });
  };

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, status: r.status === "error" ? "pending" : r.status } : r)));
  const targets = rows.filter((r) => r.include && r.status !== "done");
  const blocked = targets.filter((r) => issuesOf(r, dupKeys).errors.length > 0);
  const total = targets.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const withoutPhoto = targets.filter((r) => !r.photo).length;

  const register = async () => {
    if (!targets.length || blocked.length) return;
    setBusy(true);
    setMessage(null);
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    for (const r of targets) {
      try {
        if (r.photo) {
          const f = new FormData();
          f.set("file", photos.get(r.photo)!);
          f.set("member_email", memberEmail);
          f.set("amount", r.amount);
          f.set("paid_on", r.date);
          f.set("vendor", r.vendor);
          f.set("purpose", r.purpose);
          f.set("note", r.note);
          await postForm("/api/internal/receipts", f);
        } else {
          await api("/api/internal/expenses", { body: { member_email: memberEmail, spent_on: r.date, purpose: r.purpose, amount: Number(r.amount), note: r.note } });
        }
        ok++;
        setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, status: "done", error: undefined } : x)));
      } catch (e) {
        setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, status: "error", error: errorMessage(e) } : x)));
      }
      setProgress((p) => p && { ...p, done: p.done + 1 });
    }
    setBusy(false);
    const failed = targets.length - ok;
    setMessage(
      failed
        ? { kind: "warn", text: `${ok} 件を登録しました。${failed} 件は登録できませんでした（行の赤字を確認して、もう一度「登録」を押すと残りだけ登録します）` }
        : { kind: "ok", text: `${ok} 件を登録しました。「社内請求・経費」で明細を確認して、月末に立替経費を提出してください。` },
    );
    api<{ receipts: Receipt[] }>(`/api/internal/receipts?member=${encodeURIComponent(memberEmail)}`).then((r) => setExisting(r.receipts));
  };

  const template = () =>
    downloadBlob(new Blob([toCsv([CSV_HEADER, ["IMG_0001.jpg", "2026-10-05", "1200", "日本交通", "交通費（タクシー）サンプル自動車様訪問", ""]])], { type: "text/csv" }), "立替経費_ひな形.csv");

  const pending = rows.filter((r) => r.status !== "done");
  return (
    <div className="page">
      <p className="back-line">
        <Link className="back-link" to="/internal">‹ 社内請求・経費に戻る</Link>
      </p>
      <h1>立替経費をまとめて登録</h1>
      <ol className="import-steps">
        <li>
          Claude に「<strong>receipt-csv</strong>」スキルを入れて、領収書の写真をまとめて渡します（「経費のCSVにして」と頼むだけ）。Claude が写真に R001・R002…の番号を振り、写真と CSV を1つの ZIP にして返します。
          <a href="/skills/receipt-csv.zip" download>
            スキルをダウンロード
          </a>
        </li>
        <li>その ZIP を、展開せずにそのまま下の枠に入れます。</li>
        <li>写真は番号つきのファイル名で自動的に結びつきます。内容を確認して「登録」を押すと、領収書つきの経費になります。</li>
      </ol>
      <Hint summary="CSV の形式・アプリでの読み取りについて">
        CSV だけ作った場合は、CSV と写真をまとめて入れてもファイル名で結びつきます（名前が同じ写真が複数あると区別できないので、番号つきの ZIP がおすすめです）。1行目の見出しは「{CSV_HEADER.join("・")}」です（
        <button className="link-button" onClick={template}>
          ひな形をダウンロード
        </button>
        ）。金額は領収書のとおり税込・1円単位で入れます。日付は 2026-10-05 か 2026/10/05 の形です。写真の読み取りは Claude（各自の Claude のプラン）で行い、このアプリでは OCR や Claude API は使いません。
      </Hint>

      <div className="panel">
        <div className="grid-2">
          <label className="stack">
            <span>誰の立替経費か</span>
            <select value={memberEmail} disabled={!canSelectMember || rows.some((r) => r.status === "done")} onChange={(e) => setMemberEmail(e.target.value)}>
              {members.map((m) => (
                <option key={m.email} value={m.email}>
                  {m.display_name}
                </option>
              ))}
            </select>
            {!canSelectMember && members.length > 0 && !members.some((m) => m.email === user.email) ? (
              <span className="small error">立替経費を登録できるのは、社内請求の対象の人（本人）と管理者だけです</span>
            ) : (
              !canSelectMember && <span className="small muted">自分の分だけ登録できます（他の人の分は本人か管理者が登録します）</span>
            )}
          </label>
        </div>
        <label
          className="drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
        >
          <input type="file" multiple accept=".csv,.zip,image/jpeg,image/png,.heic,.heif,application/pdf" hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
          <strong>Claude が作った ZIP をここにドロップ</strong>
          <span className="small muted">またはクリックして選ぶ（CSV と写真をばらばらに選んでも構いません）</span>
        </label>
        <label className="small link-like folder-pick">
          <input
            type="file"
            hidden
            // フォルダごと選ぶ（Chrome・Edge・Safari）
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))}
          />
          写真のフォルダごと選ぶ
        </label>
        <p className="small muted">
          読み込んだもの: CSV の明細 {rows.length} 件 ・ 写真 {photos.size} 枚
          {rows.length > 0 && (
            <>
              {" "}
              ・{" "}
              <button className="link-button" disabled={busy} onClick={() => (setRows([]), setPhotos(new Map()), setMessage(null), setProgress(null))}>
                最初からやり直す
              </button>
            </>
          )}
        </p>
      </div>

      {message && <pre className={`notice notice-${message.kind}`}>{message.text}</pre>}
      {progress && busy && <ProgressMeter value={(progress.done / progress.total) * 100} label={`登録しています（${progress.done} / ${progress.total} 件）`} />}

      {rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="simple-table import-table">
              <thead>
                <tr>
                  <th>登録</th>
                  <th>番号</th>
                  <th>領収書の写真</th>
                  <th>日付</th>
                  <th>金額（税込）</th>
                  <th>支払先</th>
                  <th>用途</th>
                  <th>メモ</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const { errors, dup } = issuesOf(r, dupKeys);
                  const done = r.status === "done";
                  return (
                    <tr key={r.key} className={done ? "row-done" : !r.include ? "row-off" : ""}>
                      <td data-label="登録">
                        <input type="checkbox" aria-label="この行を登録する" disabled={done || busy} checked={r.include} onChange={(e) => set(r.key, { include: e.target.checked })} />
                      </td>
                      <td data-label="番号" className="small nowrap">
                        {r.no || "—"}
                      </td>
                      <td data-label="領収書の写真">
                        <div className="import-photo">
                          {r.photo && previews.get(r.photo) ? (
                            <a href={previews.get(r.photo)} target="_blank" rel="noreferrer">
                              <img src={previews.get(r.photo)} alt={`${r.photo} の写真`} />
                            </a>
                          ) : (
                            <span className="import-photo-icon" aria-hidden="true">
                              {r.photo ? (extOf(r.photo) === "pdf" ? "PDF" : "写真") : "なし"}
                            </span>
                          )}
                          <select value={r.photo ?? ""} disabled={done || busy} onChange={(e) => set(r.key, { photo: e.target.value || null })} aria-label="結びつける写真">
                            <option value="">（写真なし）</option>
                            {r.photo && <option value={r.photo}>{r.photo}</option>}
                            {unusedPhotos.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                          {!r.photo && r.file_name && <span className="small error">「{r.file_name}」が見つかりません</span>}
                        </div>
                      </td>
                      <td data-label="日付">
                        <input type="date" aria-invalid={errors.includes("日付") || errors.includes("2026年9月より前")} disabled={done || busy} value={r.date} onChange={(e) => set(r.key, { date: e.target.value })} />
                      </td>
                      <td data-label="金額（税込）">
                        <input inputMode="numeric" aria-invalid={errors.includes("金額")} disabled={done || busy} value={r.amount} onChange={(e) => set(r.key, { amount: normAmount(e.target.value) })} style={{ width: 100 }} />
                      </td>
                      <td data-label="支払先">
                        <input disabled={done || busy} value={r.vendor} onChange={(e) => set(r.key, { vendor: e.target.value })} />
                      </td>
                      <td data-label="用途">
                        <input aria-invalid={errors.includes("用途")} disabled={done || busy} value={r.purpose} onChange={(e) => set(r.key, { purpose: e.target.value })} placeholder="例: 交通費（タクシー）" />
                      </td>
                      <td data-label="メモ">
                        <input disabled={done || busy} value={r.note} onChange={(e) => set(r.key, { note: e.target.value })} />
                      </td>
                      <td data-label="状態" className="small">
                        {done ? (
                          <span className="pill pill-ok">登録済み</span>
                        ) : r.status === "error" ? (
                          <span className="error">{r.error}</span>
                        ) : errors.length ? (
                          <span className="error">要修正: {errors.join("・")}</span>
                        ) : dup ? (
                          <span className="pill pill-warn">同じ日付・金額の領収書が登録済み（往復の片道ずつなど別の領収書なら、チェックを入れて登録）</span>
                        ) : !r.photo ? (
                          <span className="pill pill-warn">写真なし</span>
                        ) : (
                          <span className="pill pill-ok">OK</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unusedPhotos.length > 0 && (
            <p className="small muted">
              CSV のどの行にも結びついていない写真が {unusedPhotos.length} 枚あります: {unusedPhotos.slice(0, 8).join("、")}
              {unusedPhotos.length > 8 && " ほか"}（行の「写真」から選んで結びつけられます）
            </p>
          )}
          {pending.length > 0 && (
            <div className="actions sticky-actions">
              <span className="small">
                登録する件数 <strong>{targets.length}</strong> 件 ・ 合計 <strong>{yen(total)}</strong>
                {withoutPhoto > 0 && ` ・ 写真なし ${withoutPhoto} 件`}
                {blocked.length > 0 && <span className="error"> ・ 要修正 {blocked.length} 件（直すか、チェックを外してください）</span>}
              </span>
              <button className="btn btn-primary" disabled={busy || !targets.length || blocked.length > 0} onClick={register}>
                {busy ? "登録しています…" : `${memberName}さんの経費として ${targets.length} 件を登録`}
              </button>
            </div>
          )}
          {pending.length === 0 && (
            <p>
              <Link className="btn btn-primary" to="/internal">
                社内請求・経費で確認する
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
