import { describe, expect, it } from "vitest";
import { monthsFrom, occurrence, periodLabel } from "../worker/billing";

describe("請求月の展開", () => {
  it("年をまたいで月を並べる", () => {
    expect(monthsFrom("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
  it("開始月が先なら空", () => {
    expect(monthsFrom("2026-12", "2026-10")).toEqual([]);
  });
});

describe("契約が何回目の請求か", () => {
  it("月額は開始月から終了月まで", () => {
    const c = { cycle: "monthly" as const, start_month: "2026-08", end_month: "2026-10", count_total: null };
    expect(occurrence(c, "2026-07")).toBe(0);
    expect(occurrence(c, "2026-08")).toBe(1);
    expect(occurrence(c, "2026-10")).toBe(3);
    expect(occurrence(c, "2026-11")).toBe(0);
  });
  it("回数契約は総回数まで", () => {
    const c = { cycle: "count" as const, start_month: "2026-09", end_month: null, count_total: 3 };
    expect(occurrence(c, "2026-11")).toBe(3);
    expect(occurrence(c, "2026-12")).toBe(0);
  });
  it("単発は開始月だけ", () => {
    const c = { cycle: "once" as const, start_month: "2026-09", end_month: null, count_total: null };
    expect(occurrence(c, "2026-09")).toBe(1);
    expect(occurrence(c, "2026-10")).toBe(0);
  });
});

describe("請求書の対象期間の書き方", () => {
  it("「9月分」「2/1〜2/28」、単発は空欄", () => {
    expect(periodLabel({ cycle: "monthly", period_style: "month" }, "2026-09")).toBe("9月分");
    expect(periodLabel({ cycle: "monthly", period_style: "range" }, "2026-02")).toBe("2/1〜2/28");
    expect(periodLabel({ cycle: "once", period_style: "month" }, "2026-09")).toBe("");
  });
});
