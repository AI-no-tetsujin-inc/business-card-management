// 議事録の取り込み（2026-10-31〜）: AI で抜き出すのはタスクだけ。要点・登場人物・決定事項は抜き出さず、
// 全文の保存・Drive・通知は AI なしで行う。Workflow を偽の D1・R2 で最後まで動かして確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinutesWorkflow, textKey } from "../worker/minutes";
import { fakeD1 } from "./helpers/fake-d1";

function fakeR2() {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (key: string, value: string) => void objects.set(key, String(value)),
    get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)!, size: objects.get(key)!.length } : null),
    delete: async (key: string) => void objects.delete(key),
  };
}

const TRANSCRIPT = ["2026-10-30", "参加: 架空 一郎 / サンプル自動車株式会社", "決定: 来月から週1で定例", "タスク: 見積書を送る / 甲野一郎 / 2026-11-05", "[0:01:00] よろしくお願いします"].join("\n");

describe("議事録の取り込み（タスクだけ AI）", () => {
  let d: ReturnType<typeof fakeD1>;
  let r2: ReturnType<typeof fakeR2>;
  let calls: string[];
  const run = (env: Env, documentId: string) =>
    new MinutesWorkflow({} as never, env).run({ payload: { documentId, origin: "https://meishi.example" } } as never, {
      // step.do(name, [options], fn)
      do: async (_name: string, a: unknown, b?: unknown) => (typeof a === "function" ? a() : (b as () => unknown)()),
    } as never);

  beforeEach(() => {
    d = fakeD1();
    r2 = fakeR2();
    calls = [];
    // 外への通信（Claude API・Google Chat・Drive）は記録だけして、送らない
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("{}", { status: 500 });
      }),
    );
    d.sqlite.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('feature_minutes', '1')");
    d.sqlite
      .prepare("INSERT INTO documents (id, drive_file_id, title, modified_time, created_at, source, title_auto, started_at) VALUES ('doc1', 'voiss:k1', '録音 10/30 14:05', '', '2026-10-30T05:05:00Z', 'voiss', 1, '2026-10-30T14:05:00+09:00')")
      .run();
    r2.objects.set(textKey("doc1"), TRANSCRIPT);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("タスクだけを保存し、要点・登場人物・決定事項は作らない。タイトルは録音のまま、外部へは何も送らない", async () => {
    // API キーなし＋開発用ログイン = ローカル用の簡易抽出（本番の Claude API の代わり）
    const env = { DB: d.db, IMAGES: r2, DEV_LOGIN: "1" } as unknown as Env;
    await run(env, "doc1");
    const doc = d.sqlite.prepare("SELECT status, summary, title, error FROM documents WHERE id = 'doc1'").get() as Record<string, string>;
    expect(doc.status).toBe("done");
    expect(doc.summary).toBe("");
    expect(doc.title).toBe("録音 10/30 14:05");
    const tasks = d.sqlite.prepare("SELECT title, due_on FROM tasks WHERE document_id = 'doc1'").all();
    expect(tasks).toEqual([{ title: "見積書を送る", due_on: "2026-11-05" }]);
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 0 });
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM interactions").get()).toEqual({ n: 0 });
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
    expect(calls.filter((u) => /anthropic|chat\.googleapis/.test(u))).toEqual([]);
  });

  it("AI の上限に達しているときは、タスクも抜き出さずに全文の保存と通知だけ行う", async () => {
    d.sqlite
      .prepare("INSERT INTO ai_usage (id, created_at, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES ('u1', ?, 'ocr', 'x', 0, 0, 0, 0, 999)")
      .run(new Date().toISOString());
    const env = { DB: d.db, IMAGES: r2, DEV_LOGIN: "1" } as unknown as Env;
    await run(env, "doc1");
    const doc = d.sqlite.prepare("SELECT status FROM documents WHERE id = 'doc1'").get() as Record<string, string>;
    expect(doc.status).toBe("done");
    expect(d.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });
});

describe("本番の Claude API への頼み方（タスクだけ）", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("返してもらう形はタスクだけで、要点・人物・決定事項は頼まない", async () => {
    const { extractTasks } = await import("../worker/extract");
    const d = fakeD1();
    let sent: { output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } }; max_tokens?: number } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        const text = JSON.stringify({ tasks: [{ title: "見積書を送る", assignee: "甲野一郎", due_on: "2026-11-05", related_company: "サンプル自動車", confidence: 0.9, evidence: "送ります" }] });
        return new Response(
          JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const env = { DB: d.db, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    const r = await extractTasks(env, "[0:00:01] 見積書は来週送ります", { title: "定例", part: 1, parts: 1, meetingDate: "2026-10-30", employees: ["甲野一郎"], knownPeople: [], knownCompanies: [] });
    expect(Object.keys(sent.output_config?.format?.schema?.properties ?? {})).toEqual(["tasks"]);
    expect(r.tasks).toHaveLength(1);
    expect(r.people).toEqual([]);
    expect(r.decisions).toEqual([]);
    expect(r.meeting.summary).toBe("");
  });
});
