import { nowIso, uuid } from "./people";

/** 100 万トークンあたりの料金（USD、2026年10月時点の公式価格） */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** 予算（チームプランの API クレジット、全体で $200）。アプリが使った額の累計がこれに達したら、AI の処理をすべて止める */
export const BUDGET_USD = 200;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function estimateCost(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (
    (u.input_tokens * p.input + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25 + u.output_tokens * p.output) / 1_000_000
  );
}

export async function recordUsage(db: D1Database, e: { purpose: string; model: string; usage: Usage; userId?: string | null }) {
  try {
    await db
      .prepare(
        `INSERT INTO ai_usage (id, created_at, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uuid(),
        nowIso(),
        e.purpose,
        e.model,
        e.usage.input_tokens,
        e.usage.output_tokens,
        e.usage.cache_read_input_tokens ?? 0,
        e.usage.cache_creation_input_tokens ?? 0,
        estimateCost(e.model, e.usage),
        e.userId ?? null,
      )
      .run();
  } catch (err) {
    console.error("ai usage log failed", err);
  }
}

/** これまでの利用額の累計（AI 利用ログは消さずに残す） */
export async function totalCost(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage").first<{ total: number }>();
  return r?.total ?? 0;
}

export class AiBudgetError extends Error {}

/**
 * 利用額の累計が上限（$200）に達していたら、Claude API を呼ばずに止める（すべての AI 処理の前に呼ぶ）。
 * 達したときは Google Chat に1回だけ知らせる。月が変わっても自動では再開しない
 */
export async function ensureAiBudget(env: Env) {
  const cost = await totalCost(env.DB);
  if (cost < BUDGET_USD) return;
  const { claimJob, sendChat } = await import("./notify");
  if (await claimJob(env.DB, "ai-budget-stop")) {
    await sendChat(env, `⛔ AI（Claude API）の利用額の累計が $${cost.toFixed(2)} になり、上限 $${BUDGET_USD} に達したため、AI の処理をすべて止めました。名刺は手入力で登録できます。`);
  }
  throw new AiBudgetError(`AI の利用額の累計が上限（$${BUDGET_USD}）に達したため、AI の処理を止めています`);
}
