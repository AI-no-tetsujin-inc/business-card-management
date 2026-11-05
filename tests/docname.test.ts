import { describe, expect, it } from "vitest";
import { parseDocName, similarity } from "../src/lib/docname";

describe("発行済み書類のファイル名", () => {
  it("請求書: 顧客・日付・金額・番号・対象月", () => {
    expect(parseDocName("請求書_株式会社AIの鉄人_サンプル自動車株式会社_20260920_12345円_No20260920-001.pdf")).toEqual({
      kind: "invoice",
      customerName: "サンプル自動車株式会社",
      issue_date: "2026-09-20",
      total: 12345,
      number: "20260920-001",
      period: "2026-09",
    });
  });
  it("拡張子が二重でも読める・月初の請求書は前月分", () => {
    const r = parseDocName("請求書_株式会社AIの鉄人_サンプル自動車株式会社_20260301_23456円_No20260301-001.pdf.pdf");
    expect(r.number).toBe("20260301-001");
    expect(r.period).toBe("2026-02");
  });
  it("見積書: 件名と番号", () => {
    const r = parseDocName("20260727_御見積書_架空・情報ンシステムサービス株式会社様_AI導入・定着支援プログラム.pdf");
    expect(r).toMatchObject({ kind: "quote", customerName: "架空・情報ンシステムサービス株式会社", issue_date: "2026-07-27", number: "20260727-1", subject: "AI導入・定着支援プログラム" });
  });
  it("社名の表記ゆれを吸収する", () => {
    expect(similarity("株式会社テストモーターア", "株式会社テストモーターァ")).toBe(1);
    expect(similarity("架空・情報システムサービス株式会社", "架空・情報ンシステムサービス株式会社")).toBeGreaterThan(0.8);
    expect(similarity("サンプル自動車株式会社", "株式会社テストモーターア")).toBeLessThan(0.3);
  });
});
