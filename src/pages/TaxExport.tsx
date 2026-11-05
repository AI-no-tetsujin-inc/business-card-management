// 税理士提出用のファイル: その月の請求書 PDF（売上・社内）と立替経費の領収書の写真を、フォルダに分けて1つの ZIP にする。
// ZIP はブラウザの中で作る（写真をまとめてサーバーのメモリに載せない）
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Zip, ZipPassThrough } from "fflate";
import { api, errorMessage } from "../api";
import { Hint, ProgressMeter } from "../components/ui";
import { downloadBlob, toCsv } from "../lib/csv";
import { jpDate, monthLabel, shiftMonth, thisMonth, yen } from "../lib/money";

interface Doc {
  id: string;
  number: string;
  issue_date: string;
  total: number;
  url: string;
  file_name: string;
}
interface Manifest {
  period: string;
  invoices: (Doc & { customer: string; imported: number })[];
  claims: (Doc & { kind: "work" | "expense"; status: string; display_name: string })[];
  expenses: {
    spent_on: string;
    purpose: string;
    amount: number;
    note: string;
    display_name: string;
    claim_number: string;
    receipt_id: string | null;
    vendor: string | null;
    file_name: string | null;
    mime: string | null;
    original_submitted_at: string | null;
    url: string | null;
  }[];
  pending: { display_name: string; n: number }[];
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "application/pdf": "pdf" };
const safe = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, "").trim();
const pad = (n: number) => String(n).padStart(2, "0");

export function TaxExportPage() {
  // 税理士に出すのはふつう締めた前の月
  const [period, setPeriod] = useState(shiftMonth(thisMonth(), -1));
  const [data, setData] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const [pick, setPick] = useState({ invoices: true, claims: true, receipts: true });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  useEffect(() => {
    setData(null);
    setResult(null);
    // 月を続けて切り替えたとき、前の月の結果があとから届いても上書きしない
    let current = true;
    api<Manifest>(`/api/internal/export?period=${period}`).then(
      (r) => current && (setData(r), setError("")),
      (e) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [period]);

  const receipts = data?.expenses.filter((e) => e.url) ?? [];
  const label = monthLabel(period);
  const root = `税理士提出_${label}分`;

  const build = async () => {
    if (!data) return;
    type Job = { path: string; url: string };
    const jobs: Job[] = [];
    if (pick.invoices) data.invoices.forEach((i) => jobs.push({ path: `01_顧客への請求書（売上）/${safe(i.file_name)}`, url: i.url }));
    if (pick.claims) data.claims.forEach((c) => jobs.push({ path: `02_社内請求書（稼働分・立替経費）/${safe(c.file_name)}`, url: c.url }));
    // 領収書は人ごとのフォルダに「連番_日付_支払先_金額.拡張子」で入れる（一覧の CSV と同じ番号）
    const receiptName = new Map<number, string>();
    const counter = new Map<string, number>();
    data.expenses.forEach((e, i) => {
      if (!e.url) return;
      const n = (counter.get(e.display_name) ?? 0) + 1;
      counter.set(e.display_name, n);
      const ext = EXT[e.mime ?? ""] ?? e.file_name?.split(".").pop() ?? "jpg";
      const name = `${pad(n)}_${e.spent_on}_${safe(e.vendor || e.purpose).slice(0, 40)}_${e.amount}円.${ext}`;
      receiptName.set(i, `${safe(e.display_name)}/${name}`);
      if (pick.receipts) jobs.push({ path: `03_立替経費の領収書/${safe(e.display_name)}/${name}`, url: e.url });
    });

    setResult(null);
    setProgress({ done: 0, total: jobs.length });
    const chunks: Uint8Array[] = [];
    const done = new Promise<Blob>((resolve, reject) => {
      const zip = new Zip((err, chunk, final) => {
        if (err) return reject(err);
        chunks.push(chunk);
        if (final) resolve(new Blob(chunks as BlobPart[], { type: "application/zip" }));
      });
      const add = (path: string, bytes: Uint8Array) => {
        const f = new ZipPassThrough(`${root}/${path}`);
        zip.add(f);
        f.push(bytes, true);
      };
      (async () => {
        const failed: string[] = [];
        for (const j of jobs) {
          try {
            const res = await fetch(j.url, { credentials: "same-origin" });
            if (!res.ok) throw new Error(String(res.status));
            // PDF にできずに HTML で保存されている書類は、拡張子を .html にする
            const path = (res.headers.get("content-type") ?? "").startsWith("text/html") ? j.path.replace(/\.pdf$/, ".html") : j.path;
            add(path, new Uint8Array(await res.arrayBuffer()));
          } catch {
            failed.push(j.path);
          }
          setProgress((p) => p && { ...p, done: p.done + 1 });
        }
        const rows = [
          ["No", "立替者", "日付", "支払先", "用途", "金額（税込）", "領収書ファイル", "原本提出", "社内請求書No", "メモ"],
          ...data.expenses.map((e, i) => [
            i + 1,
            e.display_name,
            e.spent_on,
            e.vendor ?? "",
            e.purpose,
            e.amount,
            receiptName.get(i) ?? "（領収書なし）",
            e.original_submitted_at ? "済み" : "未提出",
            e.claim_number,
            e.note,
          ]),
          [],
          ["", "", "", "", "合計", data.expenses.reduce((s, e) => s + Number(e.amount), 0)],
        ];
        add("立替経費一覧.csv", new TextEncoder().encode(toCsv(rows)));
        if (failed.length) add("取得できなかったファイル.txt", new TextEncoder().encode(failed.join("\r\n")));
        zip.end();
        setResult(
          failed.length
            ? { kind: "warn", text: `ZIP を作りましたが、${failed.length} 件のファイルを取得できませんでした（ZIP 内の「取得できなかったファイル.txt」に一覧があります）` }
            : { kind: "ok", text: `ZIP を作りました（${jobs.length} ファイル＋立替経費一覧.csv）。ダウンロードしたファイルを税理士に渡してください。` },
        );
      })().catch(reject);
    });
    try {
      downloadBlob(await done, `${root}.zip`);
    } catch (e) {
      setResult({ kind: "warn", text: `ZIP を作れませんでした（${errorMessage(e)}）` });
    } finally {
      setProgress(null);
    }
  };

  const count = (pick.invoices ? data?.invoices.length ?? 0 : 0) + (pick.claims ? data?.claims.length ?? 0 : 0) + (pick.receipts ? receipts.length : 0);
  const noOriginal = data?.expenses.filter((e) => e.url && !e.original_submitted_at).length ?? 0;
  const noReceipt = data?.expenses.filter((e) => !e.url).length ?? 0;

  return (
    <div className="page">
      <p className="back-line">
        <Link className="back-link" to="/internal">‹ 社内請求・経費に戻る</Link>
      </p>
      <h1>税理士提出用のファイル</h1>
      <div className="toolbar">
        <button className="btn btn-small" onClick={() => setPeriod(shiftMonth(period, -1))} aria-label="前の月">
          ◀
        </button>
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="対象月" />
        <button className="btn btn-small" onClick={() => setPeriod(shiftMonth(period, 1))} aria-label="次の月">
          ▶
        </button>
      </div>
      <Hint summary="ZIP の中身">
        「{root}」フォルダの中に、01 顧客への請求書（売上）、02 社内請求書（稼働分・立替経費）、03 立替経費の領収書（人ごと）を入れます。立替経費一覧.csv は Excel で開けます（領収書のファイル名と番号つき）。立替経費は、その月の分として提出済みのものだけが入ります。
      </Hint>
      {error && <p className="notice notice-error">{error}</p>}
      {!data && !error && <p className="muted">読み込み中…</p>}
      {data && (
        <div className="panel">
          <h2>{label}分</h2>
          <label className="check-line">
            <input type="checkbox" checked={pick.invoices} onChange={(e) => setPick({ ...pick, invoices: e.target.checked })} />
            顧客への請求書（売上） {data.invoices.length} 件 ・ {yen(data.invoices.reduce((s, i) => s + Number(i.total), 0))}
          </label>
          <ul className="small muted export-list">
            {data.invoices.map((i) => (
              <li key={i.id}>
                {i.customer} No.{i.number}（{jpDate(i.issue_date)}・{yen(i.total)}）{i.imported ? " ・ 取り込み分" : ""}
              </li>
            ))}
          </ul>
          <label className="check-line">
            <input type="checkbox" checked={pick.claims} onChange={(e) => setPick({ ...pick, claims: e.target.checked })} />
            社内請求書（稼働分・立替経費） {data.claims.length} 件
          </label>
          <ul className="small muted export-list">
            {data.claims.map((c) => (
              <li key={c.id}>
                {c.display_name} {c.kind === "work" ? "稼働分" : "立替経費"} No.{c.number}（{yen(c.total)}・{c.status === "paid" ? "精算済み" : "未精算"}）
              </li>
            ))}
          </ul>
          <label className="check-line">
            <input type="checkbox" checked={pick.receipts} onChange={(e) => setPick({ ...pick, receipts: e.target.checked })} />
            立替経費の領収書の写真 {receipts.length} 枚（明細 {data.expenses.length} 件・{yen(data.expenses.reduce((s, e) => s + Number(e.amount), 0))}）
          </label>
          {(data.pending.length > 0 || noOriginal > 0 || noReceipt > 0) && (
            <div className="notice notice-warn small">
              {data.pending.map((p) => (
                <p key={p.display_name}>
                  {p.display_name}さんの未提出の立替経費が {p.n} 件あります（提出されるまで ZIP には入りません）。
                </p>
              ))}
              {noReceipt > 0 && <p>領収書の写真がない明細が {noReceipt} 件あります（一覧の CSV には載ります）。</p>}
              {noOriginal > 0 && <p>原本がまだ提出されていない領収書が {noOriginal} 枚あります。</p>}
            </div>
          )}
          {progress && <ProgressMeter value={progress.total ? (progress.done / progress.total) * 100 : 100} label={`ファイルを集めています（${progress.done} / ${progress.total}）`} />}
          {result && <p className={`notice notice-${result.kind}`}>{result.text}</p>}
          <div className="actions">
            <button className="btn btn-primary" disabled={Boolean(progress) || (count === 0 && data.expenses.length === 0)} onClick={build}>
              {progress ? "ZIP を作っています…" : `ZIP をダウンロード（${count} ファイル）`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
