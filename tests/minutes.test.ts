import { describe, expect, it } from "vitest";
import { mergeExtractions, splitText, type Extraction } from "../worker/extract";

const empty = (): Extraction => ({ meeting: { title: "定例", date: "", summary: "" }, people: [], relations: [], decisions: [], tasks: [], deals: [] });

describe("長い議事録の分割", () => {
  it("短ければ分割しない", () => {
    expect(splitText("あいう")).toEqual([[0, 3]]);
  });
  it("行の切れ目で分け、前後を少し重ねる", () => {
    const line = "あ".repeat(99) + "\n";
    const text = line.repeat(400); // 40,000文字
    const ranges = splitText(text, 15000, 500);
    expect(ranges.length).toBe(3);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(text.length);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeLessThan(ranges[i - 1][1]); // 重なりがある
      expect(text[ranges[i - 1][1]]).toBe("\n"); // 行の切れ目で切る
    }
  });
});

describe("分割して抽出した結果のまとめ", () => {
  it("同じ人・同じタスク・同じ決定事項は1つにする", () => {
    const a = empty();
    a.meeting.date = "2026-10-15";
    a.people.push({ name: "丙野 太郎", kana: "", company: "株式会社サンプル商事", department: "", title: "", email: "", phone: "", internal: false, role: "", confidence: 0.9, evidence: "" });
    a.tasks.push({ title: "見積書を送る", assignee: "甲野", due_on: "", related_person: "", related_company: "", confidence: 0.9, evidence: "" });
    a.decisions.push({ text: "11月から試験導入", company: "", confidence: 0.9 });
    const b = empty();
    b.people.push({ ...a.people[0], name: "丙野太郎", company: "㈱サンプル商事" });
    b.tasks.push({ ...a.tasks[0], title: "見積書を 送る" });
    b.decisions.push({ text: "11月から試験導入", company: "", confidence: 0.8 });
    b.decisions.push({ text: "次回は11/1", company: "", confidence: 0.9 });
    const m = mergeExtractions([a, b]);
    expect(m.meeting.date).toBe("2026-10-15");
    expect(m.people).toHaveLength(1);
    expect(m.tasks).toHaveLength(1);
    expect(m.decisions.map((d) => d.text)).toEqual(["11月から試験導入", "次回は11/1"]);
  });
});
