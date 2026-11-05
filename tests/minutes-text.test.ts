// 議事録の文面: Drive に置くテキスト・議事録スペースへの投稿・毎日のまとめ
import { describe, expect, it } from "vitest";
import { digestText, driveText, durationLabel, meetingDateOf, minutesChatText, minutesFileStem, whenLabel, type MinutesDoc } from "../worker/minutes-text";

const doc: MinutesDoc = {
  id: "d1",
  title: "サンプル自動車 定例",
  source: "voiss",
  started_at: "2026-10-22T05:05:00.000Z", // 日本時間 14:05
  duration_sec: 3900,
  meeting_date: "2026-10-21", // AI が読み違えた日付より、録音の開始日を使う
  created_at: "2026-10-22T06:10:00.000Z",
  summary: "見積もりの範囲を確認した。来週までに見積書を出す。",
  recorder_name: "甲野一郎",
  model: "mlx-whisper large-v3-turbo",
};
const decisions = [{ text: "初期費用は15万円で進める" }];
const tasks = [
  { title: "見積書を送る", assignee: "乙野二郎", assignee_name: "", due_on: "2026-10-24" },
  { title: "議事録を先方に共有する", assignee: null, assignee_name: "", due_on: null },
];
const hasEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s);

describe("日時とファイル名", () => {
  it("録音の開始日時を日本時間で出す", () => {
    expect(meetingDateOf(doc)).toBe("2026-10-22");
    expect(whenLabel(doc)).toBe("10/22（木）14:05〜15:10（1時間5分）");
    expect(whenLabel({ ...doc, started_at: null })).toBe("10/21（水）");
  });
  it("長さ", () => {
    expect(durationLabel(40)).toBe("40秒");
    expect(durationLabel(25 * 60)).toBe("25分");
    expect(durationLabel(3600)).toBe("1時間");
    expect(durationLabel(3900)).toBe("1時間5分");
  });
  it("Drive のフォルダ名は 日付_タイトル（使えない文字と空白を除く）", () => {
    expect(minutesFileStem(doc)).toBe("20261022_サンプル自動車定例");
    expect(minutesFileStem({ ...doc, title: "A/B: 打ち合わせ?" })).toBe("20261022_AB打ち合わせ");
  });
});

describe("Drive に置くテキスト", () => {
  it("冒頭に会議の情報・要点・決まったこと・ネクストアクション、そのあとに全文", () => {
    const t = driveText(doc, decisions, tasks, "[0:00:00] はじめます\n[0:00:05] よろしくお願いします", "https://app/minutes/d1");
    expect(t).toContain("タイトル: サンプル自動車 定例");
    expect(t).toContain("録音: 甲野一郎");
    expect(t).toContain("アプリ: https://app/minutes/d1");
    expect(t).toContain("■ 決まったこと\n・初期費用は15万円で進める");
    expect(t).toContain("・乙野二郎: 見積書を送る（10/24まで）");
    expect(t).toContain("・担当未定: 議事録を先方に共有する");
    expect(t.indexOf("■ 要点")).toBeLessThan(t.indexOf("[0:00:00] はじめます"));
  });
});

describe("議事録スペースへの投稿", () => {
  it("要点・決まったこと・ネクストアクションとリンク。絵文字は使わない", () => {
    const t = minutesChatText(doc, decisions, tasks, { drive: "https://drive/x", app: "https://app/minutes/d1" });
    expect(t.split("\n")[0]).toBe("*議事録: サンプル自動車 定例*");
    expect(t).toContain("10/22（木）14:05〜15:10（1時間5分） ・ 録音 甲野一郎");
    expect(t).toContain("*ネクストアクション*\n・乙野二郎: 見積書を送る（10/24まで）");
    expect(t).toContain("全文（Drive）: https://drive/x");
    expect(hasEmoji(t)).toBe(false);
  });
  it("長すぎるときは切って、リンクは残す", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ text: `決まったこと${i}番目の長めの文章です` }));
    const t = minutesChatText(doc, many, [], { app: "https://app/minutes/d1" });
    expect(t.length).toBeLessThanOrEqual(3800);
    expect(t).toContain("…（続きはアプリで）");
    expect(t.endsWith("アプリ: https://app/minutes/d1")).toBe(true);
  });
});

describe("毎日のまとめ", () => {
  it("会議がない日は送らない", () => {
    expect(digestText({ date: "2026-10-22", meetings: [], actions: [], dueSoon: [] })).toBeNull();
  });
  it("会議の一覧（要点の1文目）、人別のネクストアクション、期限が近いタスク", () => {
    const t = digestText({
      date: "2026-10-22",
      meetings: [{ title: "サンプル自動車 定例", when: "10/22（木）14:05〜", recorder: "甲野一郎", summary: doc.summary }],
      actions: [tasks[0], { ...tasks[0], title: "契約書を確認する", due_on: null }, tasks[1]],
      dueSoon: [{ title: "請求書を出す", assignee: "丙野三郎", due_on: "2026-10-23" }],
      overview: "サンプル自動車の見積もりが進んだ。",
      appUrl: "https://app/minutes",
    })!;
    expect(t.split("\n")[0]).toBe("*今日の AIの鉄人（10/22・木）* 会議 1件");
    expect(t).toContain("サンプル自動車の見積もりが進んだ。");
    expect(t).toContain("・サンプル自動車 定例（10/22（木）14:05〜 ・ 甲野一郎）\n  見積もりの範囲を確認した。");
    expect(t).not.toContain("来週までに見積書を出す");
    expect(t).toContain("乙野二郎\n・見積書を送る（10/24まで）\n・契約書を確認する");
    expect(t).toContain("担当未定\n・議事録を先方に共有する");
    expect(t).toContain("*期限が近いタスク*\n・丙野三郎: 請求書を出す（10/23まで）");
    expect(t.endsWith("一覧: https://app/minutes")).toBe(true);
    expect(hasEmoji(t)).toBe(false);
  });
});
