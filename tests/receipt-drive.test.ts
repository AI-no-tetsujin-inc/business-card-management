// 提出した経費の領収書を Drive へ置く処理（saveClaimReceiptsToDrive）
// 1回の呼び出しで置くのは数件だけにして、Cloudflare の「1回の呼び出しで出せる通信の数」の上限にかからないことを確かめる
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveClaimReceiptsToDrive } from "../worker/internal";
import { fakeD1 } from "./helpers/fake-d1";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

function setup(receipts: number, files = receipts) {
  const d = fakeD1();
  const email = (d.sqlite.prepare("SELECT email FROM internal_members LIMIT 1").get() as { email: string }).email;
  d.sqlite
    .prepare("INSERT INTO internal_claims (id, member_email, period, kind, number, issue_date, due_date, submitted_at) VALUES ('c1', ?, '2026-10', 'expense', 'X', '2026-10-31', '2026-11-05', '2026-10-31')")
    .run(email);
  const r2 = new Map<string, ArrayBuffer>();
  for (let i = 1; i <= receipts; i++) {
    d.sqlite
      .prepare("INSERT INTO receipts (id, member_email, file_key, file_name, mime, amount, paid_on, created_at) VALUES (?, ?, ?, 'r.jpg', 'image/jpeg', 1000, '2026-10-01', 'x')")
      .run(`r${i}`, email, `receipts/r${i}.jpg`);
    d.sqlite
      .prepare("INSERT INTO expense_items (id, member_email, spent_on, purpose, amount, receipt_id, claim_id, created_at) VALUES (?, ?, '2026-10-01', ?, 1000, ?, 'c1', 'x')")
      .run(`e${i}`, email, `交通費${i}`, `r${i}`);
    if (i <= files) r2.set(`receipts/r${i}.jpg`, new Uint8Array([1, 2, 3]).buffer);
  }
  const env = {
    DB: d.db,
    IMAGES: { get: async (k: string) => (r2.has(k) ? { arrayBuffer: async () => r2.get(k)! } : null) },
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@example.iam.gserviceaccount.com", private_key: privateKey }),
  } as unknown as Env;
  return { d, env };
}

/** Google への通信を数える偽物。置いたファイルの名前を覚え、名前の検索に答える（作成は連番の ID） */
function mockGoogle(failUploads = false) {
  let n = 0;
  const names = new Map<string, string>(); // 名前 → ID
  const trashed: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (url.includes("/upload/") && failUploads) return new Response("rate limited", { status: 429 });
    if (method === "GET") {
      const q = new URL(url).searchParams.get("q") ?? "";
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1].replace(/\\(.)/g, "$1");
      const id = name ? names.get(name) : undefined;
      return Response.json({ files: id ? [{ id }] : [] });
    }
    if (method === "PATCH" && !url.includes("/upload/")) {
      trashed.push(decodeURIComponent(url.split("/files/")[1].split("?")[0]));
      return Response.json({});
    }
    const body = await new Response(init?.body).text();
    const id = `id${++n}`;
    const name = /"name":"([^"]+)"/.exec(body)?.[1];
    if (name) names.set(name, id);
    return Response.json({ id });
  });
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(fetchMock, { names, trashed });
}

afterEach(() => vi.unstubAllGlobals());

describe("領収書を Drive へ（少しずつ）", () => {
  it("1回に3件ずつ置き、残りの件数を返す。11件でも1回あたりの通信は上限（50）より十分少ない", async () => {
    const { d, env } = setup(11);
    const fetchMock = mockGoogle();
    const counts: number[] = [];
    let left = Infinity;
    let calls = 0;
    while (left > 0 && calls < 10) {
      fetchMock.mockClear();
      const r = await saveClaimReceiptsToDrive(env, "c1");
      counts.push(fetchMock.mock.calls.length);
      expect(r.warnings).toEqual([]);
      left = r.remaining;
      calls++;
    }
    expect(calls).toBe(4); // 3 + 3 + 3 + 2
    expect(Math.max(...counts)).toBeLessThanOrEqual(20);
    const saved = d.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE drive_file_id IS NOT NULL AND drive_file_id != ''").get() as { n: number };
    expect(saved.n).toBe(11);
  });

  it("定期処理の1回分（10件）でも、Google への通信は上限（50）に収まる", async () => {
    const { env } = setup(12);
    const fetchMock = mockGoogle();
    const r = await saveClaimReceiptsToDrive(env, undefined, 10);
    expect(r.saved).toBe(10);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(40);
  });

  it("Drive 側で失敗したら止めて、残りは次の呼び出し（毎時の定期処理）でやり直す", async () => {
    const { env } = setup(4);
    mockGoogle(true);
    const r = await saveClaimReceiptsToDrive(env, "c1");
    expect(r.saved).toBe(0);
    expect(r.remaining).toBe(4);
    expect(r.warnings[0]).toContain("Google Drive への保存に失敗しました");

    mockGoogle(false);
    const again = await saveClaimReceiptsToDrive(env); // 定期処理（請求を指定しない）
    expect(again.saved).toBe(3);
  });

  it("画像が見つからない領収書は飛ばして、何度もやり直さない", async () => {
    const { d, env } = setup(2, 1);
    mockGoogle();
    const r = await saveClaimReceiptsToDrive(env, "c1");
    expect(r.saved).toBe(1);
    expect(r.remaining).toBe(0);
    expect(r.warnings[0]).toContain("画像が見つからない");
    expect(d.sqlite.prepare("SELECT drive_file_id FROM receipts WHERE id = 'r2'").get()).toEqual({ drive_file_id: "" });
  });

  it("同じ日・同じ用途・同じ金額の領収書（往復の片道ずつ）も、上書きせずに2つとも残す", async () => {
    const { d, env } = setup(2);
    d.sqlite.exec("UPDATE expense_items SET purpose = '交通費'");
    d.sqlite.exec("UPDATE receipts SET file_name = CASE id WHEN 'r1' THEN 'R019_2026-10-20_2090.jpg' ELSE 'R021_2026-10-20_2090.jpg' END");
    const g = mockGoogle();
    await saveClaimReceiptsToDrive(env, "c1");
    const ids = d.sqlite.prepare("SELECT drive_file_id FROM receipts ORDER BY id").all() as { drive_file_id: string }[];
    expect(new Set(ids.map((r) => r.drive_file_id)).size).toBe(2);
    expect([...g.names.keys()].filter((k) => k.endsWith(".jpg")).sort()).toEqual(["R019_2026-10-01_交通費_1000円.jpg", "R021_2026-10-01_交通費_1000円.jpg"]);
  });

  it("番号のない写真で名前が同じになっても、「(2)」を付けて別のファイルにする", async () => {
    const { d, env } = setup(2);
    d.sqlite.exec("UPDATE expense_items SET purpose = '交通費'");
    const g = mockGoogle();
    await saveClaimReceiptsToDrive(env, "c1");
    expect([...g.names.keys()].filter((k) => k.endsWith(".jpg")).sort()).toEqual(["2026-10-01_交通費_1000円 (2).jpg", "2026-10-01_交通費_1000円.jpg"]);
  });

  it("以前の上書きで1つのファイルを2件が指しているものは、古いファイルをゴミ箱へ移して2件とも置き直す", async () => {
    const { d, env } = setup(3);
    d.sqlite.exec("UPDATE receipts SET drive_file_id = CASE id WHEN 'r3' THEN 'own' ELSE 'shared' END");
    const g = mockGoogle();
    const r = await saveClaimReceiptsToDrive(env, "c1");
    expect(r.saved).toBe(2);
    expect(g.trashed).toEqual(["shared"]);
    const rows = d.sqlite.prepare("SELECT id, drive_file_id FROM receipts ORDER BY id").all() as { id: string; drive_file_id: string }[];
    expect(rows.find((x) => x.id === "r3")?.drive_file_id).toBe("own");
    expect(new Set(rows.map((x) => x.drive_file_id)).size).toBe(3);
  });
});
