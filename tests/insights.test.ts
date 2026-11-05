// 人物像の取り込み（取り込み画面と AI 連携の add_person_insights が共通で使う importInsights）
// 自動反映・確認待ち（理由つき）・重複の飛ばし・不正な category の4ケースと、社内メンバー・候補が複数を確かめる
import { describe, expect, it } from "vitest";
import { importInsights } from "../worker/insights";
import { registerPerson } from "../worker/people";
import { emptyFields } from "../shared/fields";
import { fakeD1 } from "./helpers/fake-d1";

const USER = { id: "system" };
const DOMAIN = "example.com";

async function setup() {
  const d = fakeD1();
  const card = async (person_name: string, company_name: string, email: string) => {
    const r = await registerPerson(d.db, { userId: "system", via: "web", fields: { ...emptyFields(), person_name, company_name, email }, forceNew: true });
    if (r.action === "needs_confirmation") throw new Error("登録できない");
    return r.cardId;
  };
  const ids = {
    samplePerson: await card("架空 一郎", "サンプル自動車株式会社", "samplePerson@customer-a.example"),
    tanaka: await card("田中 一郎", "株式会社テストモーターア", "tanaka@customer-b.example"),
    sato1: await card("佐藤 健", "甲商事株式会社", "sato@kou.example"),
    sato2: await card("佐藤 健", "乙物産株式会社", "sato@otsu.example"),
    staffC: await card("丙野 三郎", "株式会社AIの鉄人", "staff-c@example.com"),
  };
  return { d, ids };
}

const payload = (ids: Record<string, string>, source = "2026-10-27 ステークホルダーミーティング") => ({
  source,
  date: "2026-10-27",
  items: [
    { card_id: ids.samplePerson, name: "架空 一郎", company: "サンプル自動車株式会社", category: "status", text: "来期の予算は11月の役員会で決まる", evidence: "予算は11月の役員会次第", confidence: 0.9 },
    { card_id: "", name: "田中 一郎", company: "株式会社テストモーターア", category: "role", text: "現場の推進役。決裁は部長", evidence: "最終的には部長が", confidence: 0.85 },
    { card_id: "", name: "新顔 花子", company: "未登録商事", category: "interest", text: "生成AI研修に関心", evidence: "研修とかも？", confidence: 0.9 },
    { card_id: ids.samplePerson, name: "架空 一郎", company: "サンプル自動車株式会社", category: "attitude", text: "提案にはやや慎重", evidence: "持ち帰らせてください", confidence: 0.5 },
    { card_id: "", name: "佐藤 健", company: "", category: "personality", text: "結論から話すと早い", evidence: "で、結局？", confidence: 0.9 },
    { card_id: ids.staffC, name: "丙野 三郎", company: "株式会社AIの鉄人", category: "status", text: "社内の人の情報", evidence: "", confidence: 0.95 },
    { card_id: ids.tanaka, name: "田中 一郎", company: "株式会社テストモーターア", category: "mood", text: "分類が間違っている", evidence: "", confidence: 0.9 },
    { card_id: ids.tanaka, name: "田中 一郎", company: "株式会社テストモーターア", category: "other", text: "  ", evidence: "", confidence: 0.9 },
  ],
});

describe("人物像の取り込み", () => {
  it("自動反映・確認待ち（理由つき）・不正な category と空の text はその件だけエラー", async () => {
    const { d, ids } = await setup();
    const r = await importInsights(d.db, USER, payload(ids), "skill", { domain: DOMAIN });

    // 自動反映: card_id があり 0.7 以上 / 氏名＋会社が一致して 0.7 以上
    expect(r.applied).toEqual([
      { card_id: ids.samplePerson, name: "架空 一郎", category: "status" },
      { card_id: ids.tanaka, name: "田中 一郎", category: "role" },
    ]);
    // 確認待ち: 人が見つからない・確信度が低い・候補が複数・社内メンバー
    expect(r.pending.map((p) => [p.name, p.reason])).toEqual([
      ["新顔 花子", "人が見つからない"],
      ["架空 一郎", "確信度が低い"],
      ["佐藤 健", "候補が複数"],
      ["丙野 三郎", "社内メンバー"],
    ]);
    expect(r.pending[1].candidate?.card_id).toBe(ids.samplePerson);
    // その件だけエラーにして、残りは処理する
    expect(r.errors.map((e) => e.index)).toEqual([6, 7]);
    expect(r.errors[0].message).toContain("mood");
    expect(r.skipped).toEqual([]);

    // 反映したものは名刺に付き、確認待ちは名刺に付いていない（社内メンバーの名刺にも入らない）
    const onCard = d.sqlite.prepare("SELECT card_id, status FROM person_insights WHERE status = 'active'").all() as { card_id: string }[];
    expect(onCard.map((x) => x.card_id).sort()).toEqual([ids.samplePerson, ids.tanaka].sort());
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM person_insights WHERE card_id = ?").get(ids.staffC)).toEqual({ n: 0 });
  });

  it("card_id・category・text・source がすべて同じものは飛ばす（確認待ちのものも）。source が違えば別の情報として入れる", async () => {
    const { d, ids } = await setup();
    await importInsights(d.db, USER, payload(ids), "skill", { domain: DOMAIN });
    const again = await importInsights(d.db, USER, payload(ids), "ai", { domain: DOMAIN });
    expect(again.applied).toEqual([]);
    expect(again.pending).toEqual([]);
    expect(again.skipped).toHaveLength(6);
    expect(again.skipped.every((s) => s.reason === "重複")).toBe(true);
    expect(again.errors.map((e) => e.index)).toEqual([6, 7]);

    const other = await importInsights(d.db, USER, payload(ids, "2026-11-05 定例"), "ai", { domain: DOMAIN });
    expect(other.applied).toHaveLength(2);
    expect(other.skipped).toEqual([]);
  });

  it("同じ JSON の中で重なっている項目も1件にする", async () => {
    const { d, ids } = await setup();
    const p = payload(ids);
    const r = await importInsights(d.db, USER, { ...p, items: [p.items[0], p.items[0]] }, "skill", { domain: DOMAIN });
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toEqual([{ name: "架空 一郎", category: "status", reason: "重複" }]);
  });
});
