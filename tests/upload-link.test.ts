import { putImage } from "../worker/api";
import { updateUserAccess } from "../worker/user-access";
import { describe, expect, it, vi } from "vitest";
import { createUploadLink, uploadApi } from "../worker/upload-link";
import { fakeD1 } from "./helpers/fake-d1";

vi.mock("../worker/api", () => ({ putImage: vi.fn() }));

async function fixture() {
  const { db, sqlite } = fakeD1();
  sqlite.prepare("INSERT INTO cards(id, created_by, created_at) VALUES (?, ?, ?)").run("dummy-card", "staff-a", "2026-01-01");
  sqlite.prepare("UPDATE users SET registered=1, active=1 WHERE id='staff-a'").run();
  const link = await createUploadLink(db, "dummy-card", "staff-a", "https://fixture.invalid");
  const token = link.url.split("/").at(-1)!;
  const env = { DB: db, IMAGES: { head: async () => ({ key: "img/dummy.jpg" }) } } as unknown as Env;
  const finish = () => uploadApi.request(`https://fixture.invalid/${token}/finish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ front: { full: "img/dummy.jpg", display: "img/dummy.jpg" } }),
  }, env);
  return { db, sqlite, env, finish, token };
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

// These regressions must run in the approved isolated test environment.
describe("issuer authority", () => {
  for (const change of ["active=0", "role='viewer'", "registered=0"]) {
    it(`rejects issued links when ${change}`, async () => {
      const f = await fixture();
      f.sqlite.exec(`UPDATE users SET ${change} WHERE id='staff-a'`);
      expect((await uploadApi.request(`https://fixture.invalid/${f.token}`, {}, f.env)).status).toBe(404);
      expect((await uploadApi.request(`https://fixture.invalid/${f.token}/image`, {method:"POST", headers:{"Content-Type":"image/jpeg","Content-Length":"3"},body:"jpg"}, f.env)).status).toBe(404);
      expect((await f.finish()).status).toBe(404);
      expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(0);
    });
  }
  it("rechecks authority after object validation", async () => {
    const f = await fixture();
    f.env.IMAGES.head = vi.fn(async () => {
      f.sqlite.exec("UPDATE users SET active=0 WHERE id='staff-a'");
      return { key: "img/dummy.jpg" };
    }) as unknown as R2Bucket["head"];
    expect((await f.finish()).status).toBe(404);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(0);
  });
});

describe("permanent link revocation", () => {
  for (const change of [{active:false}, {role:"viewer"}]) {
    it(`does not revive a link after ${JSON.stringify(change)} and reactivation`, async () => {
      const f = await fixture();
      await updateUserAccess(f.db, "staff-a", change);
      expect(f.sqlite.prepare("SELECT count(*) AS n FROM upload_links").get()?.n).toBe(0);
      await updateUserAccess(f.db, "staff-a", {active:true, role:"admin"});
      expect((await f.finish()).status).toBe(404);
    });
  }
  it("rejects revocation between claim and persistence", async () => {
    const f = await fixture();
    const batch = f.db.batch.bind(f.db);
    f.db.batch = (async (statements: D1PreparedStatement[]) => {
      f.sqlite.exec("UPDATE users SET active=0 WHERE id='staff-a'; DELETE FROM upload_links WHERE user_id='staff-a'");
      return batch(statements);
    }) as D1Database["batch"];
    expect((await f.finish()).status).toBe(404);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM card_images").get()?.n).toBe(0);
  });
});

it("cannot issue a new link for a revoked issuer", async () => {
  const f = await fixture();
  await updateUserAccess(f.db, "staff-a", {role:"viewer"});
  await expect(createUploadLink(f.db, "dummy-card", "staff-a", "https://fixture.invalid")).rejects.toThrow();
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM upload_links").get()?.n).toBe(0);
});

it("rejects non-boolean state values before changing authority", async () => {
  const f = await fixture();
  for (const active of [0, null, ""]) {
    await expect(updateUserAccess(f.db, "staff-a", {active} as unknown as {active:boolean})).rejects.toThrow();
  }
  expect(f.sqlite.prepare("SELECT active FROM users WHERE id='staff-a'").get()?.active).toBe(1);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM upload_links").get()?.n).toBe(1);
});

it("deletes a newly stored image if the issuer is revoked during upload", async () => {
  const f = await fixture();
  const remove = vi.fn(async () => {});
  f.env.IMAGES.delete = remove as unknown as R2Bucket["delete"];
  vi.mocked(putImage).mockImplementationOnce(async () => {
    await updateUserAccess(f.db, "staff-a", {active:false});
    return "img/revoked-upload.jpg";
  });
  const response = await uploadApi.request(`https://fixture.invalid/${f.token}/image`, {method:"POST", headers:{"Content-Type":"image/jpeg","Content-Length":"3"},body:"jpg"}, f.env);
  expect(response.status).toBe(404);
  expect(remove).toHaveBeenCalledWith("img/revoked-upload.jpg");
});
