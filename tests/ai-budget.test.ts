// AI の予算: 月ごとではなく累計で $200。達したら止め、月が変わっても再開しない
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiBudgetError, BUDGET_USD, ensureAiBudget, totalCost } from "../worker/ai-usage";
import { fakeD1 } from "./helpers/fake-d1";

function setup(rows: [string, number][]) {
  const d = fakeD1();
  rows.forEach(([at, cost], i) =>
    d.sqlite
      .prepare("INSERT INTO ai_usage (id, created_at, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, 'ocr', 'x', 0, 0, 0, 0, ?)")
      .run(`u${i}`, at, cost),
  );
  return { DB: d.db } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("AI の予算（累計）", () => {
  it("前の月の分も含めた累計で数える", async () => {
    const env = setup([["2026-09-15T00:00:00Z", 120], ["2026-10-20T00:00:00Z", 50.5], ["2026-11-01T00:00:00Z", 10]]);
    expect(await totalCost(env.DB)).toBeCloseTo(180.5);
    await expect(ensureAiBudget(env)).resolves.toBeUndefined();
  });

  it("月ごとには $200 未満でも、累計が $200 に達したら止める", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = setup([["2026-09-15T00:00:00Z", 150], ["2026-10-20T00:00:00Z", 30], ["2026-11-01T00:00:00Z", 20]]);
    expect(BUDGET_USD).toBe(200);
    await expect(ensureAiBudget(env)).rejects.toBeInstanceOf(AiBudgetError);
  });
});
