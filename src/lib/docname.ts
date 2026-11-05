// 発行済み書類のファイル名から顧客・日付・金額・番号を読み取る
import { shiftMonth } from "./money";

export interface ParsedDoc {
  kind: "invoice" | "quote";
  customerName?: string;
  issue_date?: string;
  total?: number;
  number?: string;
  period?: string;
  subject?: string;
}

/** 社名の近さ（2文字ずつの一致率）。表記ゆれ（ア/ァ、・の有無）を吸収する */
export function similarity(a: string, b: string) {
  const norm = (s: string) => s.replace(/株式会社|有限会社|[\s・･.,、（）()]/g, "").normalize("NFKC").replace(/[ァィゥェォ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 1));
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const x = grams(norm(a));
  const y = grams(norm(b));
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return (2 * hit) / (x.size + y.size);
}

const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** ファイル名から読み取る（請求書_株式会社AIの鉄人_{顧客}_{YYYYMMDD}_{金額}円_No{番号}.pdf ／ {YYYYMMDD}_御見積書_{顧客}様_{件名}.pdf） */
export function parseDocName(name: string): ParsedDoc {
  const base = name.replace(/(\.pdf)+$/i, "");
  const inv = base.match(/^請求書_[^_]+_(.+)_(\d{8})_([\d,]+)円_No([\w-]+)$/);
  if (inv) {
    const date = ymd(inv[2]);
    // 月初（5日まで）の請求書は前月分として扱う
    const period = Number(date.slice(8)) <= 5 ? shiftMonth(date.slice(0, 7), -1) : date.slice(0, 7);
    return { kind: "invoice", customerName: inv[1], issue_date: date, total: Number(inv[3].replace(/,/g, "")), number: inv[4], period };
  }
  const q = base.match(/^(\d{8})_御?見積書_(.+?)様?_(.+)$/);
  if (q) return { kind: "quote", customerName: q[2], issue_date: ymd(q[1]), number: `${q[1]}-1`, subject: q[3], period: "" };
  return { kind: "invoice" };
}

