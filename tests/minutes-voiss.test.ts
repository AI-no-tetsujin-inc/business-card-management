// Voiss からの受け取り（連携キー・二重送信の防止・音声）と、つながりがオフのときの抽出結果の保存
// D1 の代わりに Node の SQLite に全マイグレーションを流し、R2 と Workflow は偽物に差し替えて確かめる
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { minutesUpload } from "../worker/minutes-upload";
import { issueDeviceToken } from "../worker/device-token";
import { saveExtraction } from "../worker/minutes";
import type { Extraction } from "../worker/extract";

function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
  sqlite.exec(readFileSync("tests/fixtures/synthetic.sql", "utf8"));
  const norm = (a: unknown[]) => a.map((v) => (v === undefined ? null : v)) as never[];
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...norm(args)) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...norm(args)) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...norm(args)).changes) } }),
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => Promise.all(list.map((s) => (/^\s*SELECT/i.test(s.sql) ? s.all() : s.run()))),
  };
  return { db: db as unknown as D1Database, sqlite };
}

function fakeR2() {
  const objects = new Map<string, { data: Uint8Array; type?: string }>();
  return {
    objects,
    put: async (key: string, value: string | ReadableStream | ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
      const data = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { data, type: opts?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { text: async () => new TextDecoder().decode(o.data), size: o.data.length } : null;
    },
    delete: async (key: string) => void objects.delete(key),
  };
}

const ORIGIN = "https://meishi.example";
const body = (over: Record<string, unknown> = {}) => ({
  client_key: "20261022_140500-ab12cd34",
  started_at: "2026-10-22T14:05:00+09:00",
  duration_sec: 3900,
  text: "[0:00:00] はじめます\n[0:00:05] 見積もりの件です",
  model: "mlx-whisper large-v3-turbo",
  app_version: "1.0",
  ...over,
});

describe("Voiss からの受け取り", () => {
  let d: ReturnType<typeof fakeD1>;
  let r2: ReturnType<typeof fakeR2>;
  let workflows: { id: string; params: Record<string, unknown> }[];
  let env: Env;
  let staffA: string;
  let staffB: string;

  const call = (path: string, init: RequestInit & { token?: string } = {}) =>
    minutesUpload.request(
      `${ORIGIN}${path}`,
      { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) } },
      env,
    );
  const post = (token: string, b: Record<string, unknown>) =>
    call("/", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  beforeEach(async () => {
    d = fakeD1();
    r2 = fakeR2();
    workflows = [];
    env = {
      DB: d.db,
      IMAGES: r2,
      MINUTES_WORKFLOW: { create: async (o: { id: string; params: Record<string, unknown> }) => void workflows.push(o) },
    } as unknown as Env;
    d.sqlite.exec("UPDATE users SET registered = 1; INSERT OR REPLACE INTO settings (key, value) VALUES ('feature_minutes', '1')");
    staffA = (await issueDeviceToken(d.db, "staff-a", "MacBook Air")).token;
    staffB = (await issueDeviceToken(d.db, "staff-b", "Mac")).token;
  });

  it("キーがない・違うと 401。ping で本人を返す", async () => {
    expect((await call("/ping")).status).toBe(401);
    expect((await call("/ping", { token: "vk_wrong" })).status).toBe(401);
    const r = await call("/ping", { token: staffA });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, user: { name: "甲野一郎", email: "staff-a@example.com" } });
    // キーは SHA-256 だけを残す
    expect(JSON.stringify(d.sqlite.prepare("SELECT * FROM device_tokens").all())).not.toContain(staffA);
  });

  it("議事録が無効のとき・閲覧のみの人・失効したキーは送れない", async () => {
    d.sqlite.exec("UPDATE settings SET value = '0' WHERE key = 'feature_minutes'");
    expect((await call("/ping", { token: staffA })).status).toBe(403);
    d.sqlite.exec("UPDATE settings SET value = '1' WHERE key = 'feature_minutes'");
    d.sqlite.exec("UPDATE users SET role = 'viewer' WHERE id = 'staff-b'");
    expect((await call("/ping", { token: staffB })).status).toBe(401);
    d.sqlite.exec("UPDATE device_tokens SET revoked_at = '2026-10-22T00:00:00Z' WHERE user_id = 'staff-a'");
    expect((await call("/ping", { token: staffA })).status).toBe(401);
  });

  it("文字起こしを受け取って処理を始める。送り直しても二重にならない", async () => {
    const r = await post(staffA, body());
    expect(r.status).toBe(200);
    const { id, status } = (await r.json()) as { id: string; status: string };
    expect(status).toBe("processing");
    const doc = d.sqlite.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown>;
    expect(doc).toMatchObject({
      source: "voiss",
      recorded_by: "staff-a",
      title: "録音 10/22 14:05",
      title_auto: 1,
      started_at: "2026-10-22T05:05:00.000Z",
      duration_sec: 3900,
      drive_file_id: "voiss:20261022_140500-ab12cd34",
      status: "processing",
    });
    expect(new TextDecoder().decode(r2.objects.get(`minutes/${id}.txt`)!.data)).toContain("見積もりの件です");
    expect(workflows).toHaveLength(1);
    expect(workflows[0].params).toEqual({ documentId: id, origin: ORIGIN });
    expect(d.sqlite.prepare("SELECT value FROM settings WHERE key = 'app_url'").get()).toEqual({ value: ORIGIN });

    const again = await post(staffA, body());
    expect(((await again.json()) as { id: string }).id).toBe(id);
    expect(workflows).toHaveLength(1);
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 1 });

    // 別の人が同じ録音の ID で送ってきたら断る
    expect((await post(staffB, body())).status).toBe(409);
  });

  it("タイトルを付けて送ったら、そのタイトルを使う。中身が正しくなければ 400", async () => {
    const r = await post(staffA, body({ client_key: "20261022_160000-ab12cd34", title: "テスト定例" }));
    const { id } = (await r.json()) as { id: string };
    expect(d.sqlite.prepare("SELECT title, title_auto FROM documents WHERE id = ?").get(id)).toEqual({ title: "テスト定例", title_auto: 0 });
    expect((await post(staffA, body({ client_key: "x" }))).status).toBe(400);
    expect((await post(staffA, body({ client_key: "20261022_170000-ab12cd34", started_at: "きのう" }))).status).toBe(400);
    expect((await post(staffA, body({ client_key: "20261022_170000-ab12cd34", text: "  " }))).status).toBe(400);
  });

  it("音声: R2 に置き、文字起こしの保存が済んでいれば音声だけ Drive に置く処理を始める", async () => {
    const { id } = (await (await post(staffA, body())).json()) as { id: string };
    const put = (token: string, type = "audio/mp4") =>
      call(`/${id}/audio`, { method: "PUT", token, headers: { "content-type": type, "content-length": "4" }, body: new Uint8Array([1, 2, 3, 4]) });
    expect((await put(staffA, "text/plain")).status).toBe(415);
    expect((await put(staffB)).status).toBe(409);
    expect((await put(staffA)).status).toBe(200);
    expect(r2.objects.get(`minutes/${id}.audio`)!.data).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(d.sqlite.prepare("SELECT audio_key, audio_type FROM documents WHERE id = ?").get(id)).toEqual({ audio_key: `minutes/${id}.audio`, audio_type: "audio/mp4" });
    expect(workflows).toHaveLength(1); // まだ Drive のフォルダが無いので、本体の処理が最後に置く

    d.sqlite.prepare("UPDATE documents SET drive_folder_id = 'folder1' WHERE id = ?").run(id);
    expect((await put(staffA, "audio/wav")).status).toBe(200);
    expect(workflows.at(-1)!.params).toEqual({ documentId: id, only: "audio" });
  });
});

describe("抽出結果の保存（つながり・確認依頼がオフ）", () => {
  it("決定事項とタスクは残し、新しい人物の登録・確認依頼・案件・つながりは作らない。仮のタイトルは会議名に置き換える", async () => {
    const d = fakeD1();
    d.sqlite.exec("UPDATE users SET registered = 1");
    d.sqlite
      .prepare("INSERT INTO documents (id, drive_file_id, title, modified_time, created_at, source, title_auto) VALUES ('doc1', 'voiss:k', '録音 10/22 14:05', 'x', 'x', 'voiss', 1)")
      .run();
    const ex: Extraction = {
      meeting: { title: "テスト顧客A 定例", date: "2026-10-22", summary: "見積もりの範囲を確認した。" },
      people: [
        { name: "佐藤 一郎", kana: "", company: "株式会社サンプル", department: "", title: "", email: "", phone: "", internal: false, role: "先方担当", confidence: 0.95, evidence: "" },
      ],
      relations: [{ from: "佐藤 一郎", from_type: "person", to: "株式会社サンプル", to_type: "company", kind: "所属", confidence: 0.9, evidence: "" }],
      decisions: [{ text: "初期費用は15万円で進める", company: "株式会社サンプル", confidence: 0.9 }],
      tasks: [{ title: "見積書を送る", assignee: "乙野", due_on: "2026-10-24", related_person: "", related_company: "", confidence: 0.9, evidence: "" }],
      deals: [{ company: "株式会社サンプル", name: "AI 導入", status: "見積中", amount: "", confidence: 0.9, evidence: "" }],
    };
    const env = { DB: d.db } as unknown as Env;
    const stats = await saveExtraction(env, "doc1", ex, { graph: false });
    expect(stats).toMatchObject({ people: 0, new_people: 0, reviews: 0, deals: 0, relations: 0, decisions: 1, tasks: 1 });
    const count = (t: string) => (d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("cards")).toBe(0);
    expect(count("review_items")).toBe(0);
    expect(count("deals")).toBe(0);
    expect(count("relations")).toBe(0);
    expect(d.sqlite.prepare("SELECT title, assignee_user_id, due_on, source FROM tasks").get()).toEqual({ title: "見積書を送る", assignee_user_id: "staff-b", due_on: "2026-10-24", source: "minutes" });
    expect(d.sqlite.prepare("SELECT title, title_auto, status, summary FROM documents WHERE id = 'doc1'").get()).toEqual({
      title: "テスト顧客A 定例",
      title_auto: 0,
      status: "done",
      summary: "見積もりの範囲を確認した。",
    });
  });

  it("つながりがオンでも、議事録に出てきた人は登録も確認依頼もしない（名刺交換した人だけを登録する）", async () => {
    const d = fakeD1();
    d.sqlite.prepare("INSERT INTO documents (id, drive_file_id, title, modified_time, created_at, source) VALUES ('doc2', 'voiss:k2', '定例', 'x', 'x', 'voiss')").run();
    const person = (name: string, confidence: number) => ({ name, kana: "", company: "株式会社サンプル", department: "", title: "", email: "", phone: "", internal: false, role: "先方", confidence, evidence: "" });
    const ex: Extraction = {
      meeting: { title: "定例", date: "2026-10-22", summary: "" },
      people: [person("佐藤 一郎", 0.95), person("鈴木 次郎", 0.4)],
      relations: [],
      decisions: [],
      tasks: [],
      deals: [],
    };
    const stats = await saveExtraction({ DB: d.db } as unknown as Env, "doc2", ex, { graph: true });
    expect(stats).toMatchObject({ people: 0, new_people: 0, reviews: 0 });
    const count = (t: string) => (d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("cards")).toBe(0);
    expect(count("review_items")).toBe(0);
    expect(count("interactions")).toBe(0);
  });
});
