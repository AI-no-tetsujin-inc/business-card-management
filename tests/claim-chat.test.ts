// 社内請求の Google Chat 連絡: 月末のお願い・1日のリマインド（まだの人だけメンション）・全員そろったら代表へ
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimChatText, notifyClaimsComplete } from "../worker/internal";
import { fakeD1 } from "./helpers/fake-d1";

const STAFF_A = "staff-a@example.com";
const STAFF_C = "staff-c@example.com";
const STAFF_B = "staff-b@example.com";

function setup() {
  const d = fakeD1();
  const user = d.sqlite.prepare(
    "INSERT INTO users (id, google_sub, email, name, registered, created_at) VALUES (?, ?, ?, ?, 1, 'x') ON CONFLICT(email) DO UPDATE SET google_sub = excluded.google_sub",
  );
  user.run("u-a", "111", STAFF_A, "甲野一郎");
  user.run("u-c", "222", STAFF_C, "丙野三郎");
  user.run("u-b", "333", STAFF_B, "乙野二郎");
  const env = { DB: d.db, GOOGLE_CHAT_WEBHOOK_URL: "https://chat.example/hook" } as unknown as Env;
  return { d, env };
}

/** 稼働分・立替経費の請求を入れる。receipt を渡すと、その領収書つきの明細も入れる */
function claim(d: ReturnType<typeof fakeD1>, email: string, period: string, kind: "work" | "expense", receipt?: { drive: string | null; original: string | null }) {
  const id = `${email}-${period}-${kind}`;
  d.sqlite
    .prepare("INSERT INTO internal_claims (id, member_email, period, kind, number, issue_date, due_date, submitted_at) VALUES (?, ?, ?, ?, 'X', '2026-12-01', '2026-12-05', 'x')")
    .run(id, email, period, kind);
  if (receipt) {
    d.sqlite
      .prepare("INSERT INTO receipts (id, member_email, file_key, file_name, mime, amount, paid_on, drive_file_id, original_submitted_at, created_at) VALUES (?, ?, 'k', 'r.jpg', 'image/jpeg', 500, '2026-11-10', ?, ?, 'x')")
      .run(`r-${id}`, email, receipt.drive, receipt.original);
    d.sqlite
      .prepare("INSERT INTO expense_items (id, member_email, spent_on, purpose, amount, receipt_id, claim_id, created_at) VALUES (?, ?, '2026-11-10', '交通費', 500, ?, ?, 'x')")
      .run(`e-${id}`, email, `r-${id}`, id);
  }
}

function mockChat(ok = true) {
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)).text);
      return new Response(ok ? "{}" : "error", { status: ok ? 200 : 500 });
    }),
  );
  return posts;
}

afterEach(() => vi.unstubAllGlobals());

describe("社内請求の Google Chat 連絡", () => {
  it("月末のお願いは、まだの人を Google のユーザー ID でメンションする", async () => {
    const { env } = setup();
    const text = await claimChatText(env, "2026-11", "request");
    expect(text).toContain("<users/111>");
    expect(text).toContain("<users/222>");
    expect(text).toContain("11月分の経費登録と請求書の発行をお願いします");
    expect(text).toContain("期限は 12月2日 まで");
  });

  it("1日のリマインドは、まだの人だけをメンションし、残っていることを書く", async () => {
    const { d, env } = setup();
    claim(d, STAFF_A, "2026-11", "work");
    claim(d, STAFF_A, "2026-11", "expense");
    claim(d, STAFF_C, "2026-11", "work");
    const text = (await claimChatText(env, "2026-11", "remind"))!;
    expect(text).not.toContain("<users/111>");
    expect(text).toContain("<users/222>");
    expect(text).toContain("・丙野: 立替経費の請求書");
  });

  it("「今月は立替経費なし」なら済みになり、全員済んでいればリマインドしない", async () => {
    const { d, env } = setup();
    claim(d, STAFF_A, "2026-11", "work");
    claim(d, STAFF_A, "2026-11", "expense");
    claim(d, STAFF_C, "2026-11", "work");
    d.sqlite.prepare("INSERT INTO internal_no_expense (member_email, period, declared_at) VALUES (?, '2026-11', 'x')").run(STAFF_C);
    expect(await claimChatText(env, "2026-11", "remind")).toBeNull();
  });

  it("全員の発行と領収書の写真の Drive 保存がそろったら、代表をメンションして1回だけ連絡する", async () => {
    const { d, env } = setup();
    const posts = mockChat();
    claim(d, STAFF_A, "2026-11", "work");
    claim(d, STAFF_A, "2026-11", "expense", { drive: null, original: null });
    claim(d, STAFF_C, "2026-11", "work");
    claim(d, STAFF_C, "2026-11", "expense", { drive: "f2", original: null });
    // 甲野の写真がまだ Drive にない
    expect(await notifyClaimsComplete(env, "2026-11")).toContain("領収書の写真 1 枚を Drive に保存中");
    expect(posts).toEqual([]);

    d.sqlite.exec("UPDATE receipts SET drive_file_id = 'f1' WHERE drive_file_id IS NULL");
    expect(await notifyClaimsComplete(env, "2026-11")).toBe("代表に Google Chat で連絡しました");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("<users/333>");
    expect(posts[0]).toContain("CC: <users/111> <users/222>");
    expect(posts[0]).toContain("中身を確認して、税理士に送ってください。12月5日までに支払いをお願いします。");
    expect(posts[0]).toContain("領収書の原本（2枚）は、次に会うときに渡します。");

    expect(await notifyClaimsComplete(env, "2026-11")).toBe("連絡済みです");
    expect(posts).toHaveLength(1);
  });

  it("送れなかったら、次の定期処理でやり直す", async () => {
    const { d, env } = setup();
    claim(d, STAFF_A, "2026-11", "work");
    claim(d, STAFF_C, "2026-11", "work");
    for (const e of [STAFF_A, STAFF_C]) d.sqlite.prepare("INSERT INTO internal_no_expense (member_email, period, declared_at) VALUES (?, '2026-11', 'x')").run(e);
    mockChat(false);
    expect(await notifyClaimsComplete(env, "2026-11")).toContain("失敗");
    const posts = mockChat(true);
    expect(await notifyClaimsComplete(env, "2026-11")).toBe("代表に Google Chat で連絡しました");
    expect(posts[0]).toContain("（甲野・丙野は今月の立替経費なし）");
  });

  it("10月分（手動で連絡済み）には自動で連絡しない", async () => {
    const { d, env } = setup();
    const posts = mockChat();
    for (const e of [STAFF_A, STAFF_C]) {
      claim(d, e, "2026-10", "work");
      claim(d, e, "2026-10", "expense");
    }
    expect(await notifyClaimsComplete(env, "2026-10")).toContain("2026年11月分から");
    expect(posts).toEqual([]);
  });
});
