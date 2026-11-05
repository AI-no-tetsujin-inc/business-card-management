import { describe, expect, it, vi } from "vitest";
import { createUploadLink, uploadApi } from "../worker/upload-link";
import { fakeD1 } from "./helpers/fake-d1";

vi.mock("../worker/api", () => ({ putImage: vi.fn() }));

async function fixture() {
  const { db, sqlite } = fakeD1();
  sqlite.prepare("INSERT INTO cards(id, created_by, created_at) VALUES (?, ?, ?)").run("dummy-card", "staff-a", "2026-01-01");
  const link = await createUploadLink(db, "dummy-card", "staff-a", "https://fixture.invalid");
  const token = link.url.split("/").at(-1)!;
  const env = { DB: db, IMAGES: { head: async () => ({ key: "img/dummy.jpg" }) } } as unknown as Env;
  const finish = () => uploadApi.request(`https://fixture.invalid/${token}/finish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ front: { full: "img/dummy.jpg", display: "img/dummy.jpg" } }),
  }, env);
  return { db, sqlite, env, finish };
}

describe("upload capability single use", () => {
  it("only one overlapping finish writes images", async () => {
    const f = await fixture();
    let seen = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.env.IMAGES.head = vi.fn(async () => {
      if (++seen === 2) release();
      await barrier;
      return { key: "img/dummy.jpg" };
    }) as unknown as R2Bucket["head"];
    const responses = await Promise.all([f.finish(), f.finish()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(1);
    expect((await f.finish()).status).toBe(404);
  });

  it("rechecks expiry after asynchronous object validation", async () => {
    const f = await fixture();
    f.env.IMAGES.head = vi.fn(async () => {
      f.sqlite.prepare("UPDATE upload_links SET expires_at=0").run();
      return { key: "img/dummy.jpg" };
    }) as unknown as R2Bucket["head"];
    expect((await f.finish()).status).toBe(404);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(0);
  });

  it("does not reopen a claimed link if image persistence fails", async () => {
    const f = await fixture();
    f.db.batch = vi.fn(async () => { throw new Error("synthetic storage failure"); });
    expect((await f.finish()).status).toBe(500);
    expect((await f.finish()).status).toBe(404);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(0);
  });
});
