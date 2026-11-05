import { CARD_FIELDS } from "../shared/fields";

export interface ExportRow extends Record<string, unknown> {
  exchanged_on: string;
  exchange_place: string;
  tags: string;
  created_by_name: string;
  created_at: string;
  latest_note: string | null;
}

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const jstDate = (iso: string) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : "");

/** Excel でそのまま開けるよう BOM 付き UTF-8・CRLF で出力する */
export function toCsv(rows: ExportRow[]): string {
  const header = [...CARD_FIELDS.map((f) => f.label), "交換日", "交換場所・イベント", "タグ", "登録者", "登録日", "最新メモ"];
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        ...CARD_FIELDS.map((f) => r[f.key]),
        r.exchanged_on,
        r.exchange_place,
        (JSON.parse(r.tags || "[]") as string[]).join(" / "),
        r.created_by_name,
        jstDate(r.created_at),
        r.latest_note ?? "",
      ]
        .map(cell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
