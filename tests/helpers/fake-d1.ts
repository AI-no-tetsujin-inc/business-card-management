// D1 の代わりに Node の SQLite に全マイグレーションを流したもの（D1 を使う処理のテスト用）
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function fakeD1() {
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
  // batch は読み取り（SELECT）なら結果の行を、書き込みなら件数を返す（D1 と同じ）
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => Promise.all(list.map((s) => (/^\s*SELECT/i.test(s.sql) ? s.all() : s.run()))),
  };
  return { db: db as unknown as D1Database, sqlite };
}
