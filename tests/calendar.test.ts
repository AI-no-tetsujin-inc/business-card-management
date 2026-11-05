// Google カレンダー連携: 入れる予定の組み立てと、Google への反映（変わったものだけ送る・要らなくなったら消す）
// D1 の代わりに Node の SQLite に全マイグレーションを流し、Google の API は偽物に差し替えて確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desiredEvents, saveCalendarLink, syncCalendar } from "../worker/calendar";
import { fakeD1 } from "./helpers/fake-d1";

/** 偽の Google（トークン発行とカレンダーの予定） */
function fakeGoogle() {
  const events = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
    const m = url.match(/\/events(?:\/([a-v0-9]+))?$/);
    if (!m) return new Response("not found", { status: 404 });
    calls.push(`${method} ${m[1] ? "id" : ""}`.trim());
    const id = m[1];
    if (method === "PUT") {
      if (!events.has(id!)) return new Response("{}", { status: 404 });
      events.set(id!, JSON.parse(String(init!.body)));
      return new Response("{}");
    }
    if (method === "POST") {
      const body = JSON.parse(String(init!.body));
      if (events.has(body.id)) return new Response("{}", { status: 409 });
      events.set(body.id, body);
      return new Response("{}");
    }
    if (method === "DELETE") return new Response(null, { status: events.delete(id!) ? 204 : 404 });
    return new Response("{}", { status: 400 });
  });
  return { events, calls, fetchMock };
}

const STAFF_B = "staff-b@example.com";
const STAFF_A = "staff-a@example.com";

describe("Google カレンダー連携", () => {
  let d: ReturnType<typeof fakeD1>;
  let env: Env;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T01:00:00Z")); // 日本時間 2026-10-20 10:00
    d = fakeD1();
    env = { DB: d.db, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" } as unknown as Env;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("担当・代表の乙野さん: 請求書の作成・入金期日・社内請求の支払い（今日より前の予定は入れない）", async () => {
    const ev = await desiredEvents(d.db, STAFF_B);
    const keys = ev.map((e) => `${e.date} ${e.key}`);
    expect(keys).toContain("2026-11-15 invoice-start:2026-11");
    expect(keys).toContain("2026-11-30 invoice-due:2026-10");
    expect(keys).toContain("2026-11-05 claim-payout:2026-10");
    expect(keys.some((k) => k.startsWith("2026-10-15"))).toBe(false); // 10/15 は過ぎている
    const start = ev.find((e) => e.key === "invoice-start:2026-11")!;
    expect(start.summary).toMatch(/^請求書の作成（11月分）: /);
    expect(start.summary).toContain("テスト顧客A");
    // 日付順
    expect([...keys].sort()).toEqual(keys);
  });

  it("社内請求の対象の甲野さん: 提出期限（翌月1日）と支払日（翌月5日）。顧客の担当でなければ請求書の予定は入らない", async () => {
    const ev = await desiredEvents(d.db, STAFF_A);
    const keys = ev.map((e) => `${e.date} ${e.key}`);
    expect(keys).toContain("2026-11-02 claim-deadline:2026-10");
    expect(keys).toContain("2026-11-05 claim-pay:2026-10");
    expect(keys.some((k) => k.includes("invoice-"))).toBe(false);
    // 提出したら【済】になる
    d.sqlite
      .prepare("INSERT INTO internal_claims (id, member_email, period, kind, number, issue_date, due_date, submitted_at) VALUES ('c1', ?, '2026-10', 'work', 'n', '2026-10-31', '2026-11-05', '2026-10-31')")
      .run(STAFF_A);
    const after = await desiredEvents(d.db, STAFF_A);
    expect(after.find((e) => e.key === "claim-deadline:2026-10")!.summary).toMatch(/^【済】/);
  });

  it("Google への反映: 初回は作成、変更がなければ何も送らない、内容が変わった予定だけ更新、担当が外れたら消す", async () => {
    const g = fakeGoogle();
    vi.stubGlobal("fetch", g.fetchMock);
    await saveCalendarLink(env, { email: STAFF_B, refreshToken: "1//rt", scopes: "calendar.events", appUrl: "https://meishi.example" });

    const first = await syncCalendar(env, STAFF_B);
    const desired = await desiredEvents(d.db, STAFF_B);
    expect(first).toEqual({ changed: desired.length, removed: 0 });
    expect(g.events.size).toBe(desired.length);
    const sample = [...g.events.values()][0] as { start: { date: string }; end: { date: string }; transparency: string; description: string };
    expect(sample.transparency).toBe("transparent");
    expect(sample.description).toContain("https://meishi.example");

    g.calls.length = 0;
    expect(await syncCalendar(env, STAFF_B)).toEqual({ changed: 0, removed: 0 });
    expect(g.calls).toEqual([]); // 変わっていなければ Google には何も送らない

    // テスト顧客Bの担当を丙野さんに変える → 乙野さんの請求書の予定の文面が変わる（更新）
    d.sqlite.prepare("UPDATE customers SET owner_email = 'staff-c@example.com' WHERE name LIKE '%テスト顧客B%'").run();
    g.calls.length = 0;
    const second = await syncCalendar(env, STAFF_B);
    expect(second.changed).toBeGreaterThan(0);
    expect(g.calls.every((c) => c === "PUT id")).toBe(true);

    // 顧客の担当を全部外す → 請求書の予定は消える（社内請求の支払いは残る）
    d.sqlite.prepare("UPDATE customers SET owner_email = 'staff-c@example.com'").run();
    const third = await syncCalendar(env, STAFF_B);
    expect(third.removed).toBeGreaterThan(0);
    const left = await desiredEvents(d.db, STAFF_B);
    expect(left.every((e) => !e.key.startsWith("invoice-"))).toBe(true);
    expect(g.events.size).toBe(left.length);
  });

  it("Google Calendar API が無効なときは、対応方法が分かる言葉で記録する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/token")
          ? new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }))
          : new Response(JSON.stringify({ error: { message: "Google Calendar API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }), { status: 403 }),
      ),
    );
    await saveCalendarLink(env, { email: STAFF_B, refreshToken: "1//rt", scopes: "calendar.events", appUrl: "" });
    await expect(syncCalendar(env, STAFF_B)).rejects.toThrow(/Google Calendar API/);
    const row = d.sqlite.prepare("SELECT last_error FROM calendar_links WHERE user_email = ?").get(STAFF_B) as { last_error: string };
    expect(row.last_error).toContain("有効になっていません");
  });
});
