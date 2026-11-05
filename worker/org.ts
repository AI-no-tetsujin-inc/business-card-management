// 取引先の組織図: 会社 → 本部・部・課・店舗・支社などのまとまり → 人。上下は「まとまりの親子」と「役職の高さ」「上司」で表す
// - 自動で作る: 名刺の部署欄（例「営業本部 第一営業部」）を上から順のまとまりに分けて作り、まだ置き場所が決まっていない人を入れる
// - 手で直す: まとまりの名前・種類・親を変える／まとめる、人の置き場所と上司を選ぶ（自動で作り直しても手で決めた人は動かさない）
import type { Hono } from "hono";
import type { AppEnv } from "./session";
import { audit, nowIso, uuid } from "./people";
import { guessKind, isOrgKind, rankOf, splitDepartment } from "../shared/org";

export interface OrgPerson {
  id: string;
  person_name: string;
  department: string | null;
  title: string | null;
  org_unit_id: string | null;
  reports_to: string | null;
  exchanged_on: string | null;
  role_note: string | null;
  attitude_note: string | null;
  rank: number;
}

interface UnitRow {
  id: string;
  company_key: string;
  name: string;
  kind: string;
  parent_id: string | null;
  sort_order: number;
}

/** 会社の組織図（まとまりと人）。人には役職の高さと、人物像の「立場・役割」「温度感」の最新を付ける */
export async function getOrg(db: D1Database, companyKey: string) {
  const [units, people] = await db.batch([
    db.prepare("SELECT id, company_key, name, kind, parent_id, sort_order FROM org_units WHERE company_key = ? ORDER BY sort_order, name").bind(companyKey),
    db
      .prepare(
        `SELECT c.id, c.person_name, c.department, c.title, c.org_unit_id, c.reports_to, c.exchanged_on,
                (SELECT body FROM person_insights p WHERE p.card_id = c.id AND p.status = 'active' AND p.category = 'role'
                  ORDER BY COALESCE(p.happened_on, substr(p.created_at, 1, 10)) DESC, p.created_at DESC LIMIT 1) AS role_note,
                (SELECT body FROM person_insights p WHERE p.card_id = c.id AND p.status = 'active' AND p.category = 'attitude'
                  ORDER BY COALESCE(p.happened_on, substr(p.created_at, 1, 10)) DESC, p.created_at DESC LIMIT 1) AS attitude_note
           FROM cards c WHERE c.company_key = ? AND c.deleted_at IS NULL ORDER BY c.person_name_kana, c.person_name`,
      )
      .bind(companyKey),
  ]);
  return {
    company_key: companyKey,
    units: units.results as unknown as UnitRow[],
    people: (people.results as unknown as Omit<OrgPerson, "rank">[]).map((p): OrgPerson => ({ ...p, rank: rankOf(String(p.title ?? "")) })),
  };
}

/** 名刺の部署欄から、まとまりを作って人を入れる。手で置き場所を決めた人（org_unit_id がある人）は動かさない */
export async function autoBuildOrg(db: D1Database, companyKey: string, userId: string) {
  const { units, people } = await getOrg(db, companyKey);
  const byKey = new Map(units.map((u) => [`${u.parent_id ?? ""}|${u.name}`, u.id]));
  const at = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let createdUnits = 0;
  let placed = 0;
  for (const p of people) {
    if (p.org_unit_id) continue;
    const parts = splitDepartment(String(p.department ?? ""));
    if (!parts.length) continue;
    let parent: string | null = null;
    for (const name of parts) {
      const key = `${parent ?? ""}|${name}`;
      let id = byKey.get(key);
      if (!id) {
        id = uuid();
        byKey.set(key, id);
        createdUnits++;
        stmts.push(
          db.prepare("INSERT INTO org_units (id, company_key, name, kind, parent_id, sort_order, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
            .bind(id, companyKey, name, guessKind(name), parent, userId, at),
        );
      }
      parent = id;
    }
    stmts.push(db.prepare("UPDATE cards SET org_unit_id = ? WHERE id = ? AND org_unit_id IS NULL").bind(parent, p.id));
    placed++;
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { created_units: createdUnits, placed };
}

/** unitId の下（自分も含む）にあるまとまりの ID（親を変えるときに輪にならないか見る） */
function descendants(units: UnitRow[], unitId: string) {
  const out = new Set([unitId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) if (u.parent_id && out.has(u.parent_id) && !out.has(u.id)) (out.add(u.id), (grew = true));
  }
  return out;
}

export function registerOrgRoutes(api: Hono<AppEnv>) {
  api.get("/org", async (c) => {
    const key = c.req.query("company");
    if (!key) return c.json({ error: "会社を指定してください" }, 400);
    return c.json(await getOrg(c.env.DB, key));
  });

  api.post("/org/auto", async (c) => {
    const { company } = await c.req.json<{ company: string }>();
    if (!company) return c.json({ error: "会社を指定してください" }, 400);
    const r = await autoBuildOrg(c.env.DB, company, c.get("user").id);
    await audit(c.env.DB, { userId: c.get("user").id, via: "web", action: "org_auto", detail: { company, ...r } });
    return c.json(r);
  });

  api.post("/org/units", async (c) => {
    const b = await c.req.json<{ company: string; name: string; kind?: string; parent_id?: string | null }>();
    const name = String(b.name ?? "").trim().slice(0, 100);
    if (!b.company || !name) return c.json({ error: "名前を入れてください" }, 400);
    if (b.parent_id) {
      const parent = await c.env.DB.prepare("SELECT company_key FROM org_units WHERE id = ?").bind(b.parent_id).first<{ company_key: string }>();
      if (parent?.company_key !== b.company) return c.json({ error: "上のまとまりが見つかりません" }, 400);
    }
    const id = uuid();
    await c.env.DB.prepare("INSERT INTO org_units (id, company_key, name, kind, parent_id, sort_order, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .bind(id, b.company, name, isOrgKind(b.kind) ? b.kind : guessKind(name), b.parent_id || null, c.get("user").id, nowIso())
      .run();
    return c.json({ id });
  });

  api.patch("/org/units/:id", async (c) => {
    const db = c.env.DB;
    const unit = await db.prepare("SELECT * FROM org_units WHERE id = ?").bind(c.req.param("id")).first<UnitRow>();
    if (!unit) return c.json({ error: "見つかりません" }, 404);
    const b = await c.req.json<{ name?: string; kind?: string; parent_id?: string | null; sort_order?: number }>();
    if (b.parent_id !== undefined && b.parent_id !== null) {
      const { units } = await getOrg(db, unit.company_key);
      if (!units.some((u) => u.id === b.parent_id)) return c.json({ error: "上のまとまりが見つかりません" }, 400);
      if (descendants(units, unit.id).has(b.parent_id)) return c.json({ error: "自分の下にあるまとまりを、上にはできません" }, 400);
    }
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) : unit.name;
    if (!name) return c.json({ error: "名前を入れてください" }, 400);
    await db
      .prepare("UPDATE org_units SET name = ?, kind = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .bind(
        name,
        isOrgKind(b.kind) ? b.kind : unit.kind,
        b.parent_id !== undefined ? b.parent_id || null : unit.parent_id,
        Number.isFinite(b.sort_order) ? Number(b.sort_order) : unit.sort_order,
        nowIso(),
        unit.id,
      )
      .run();
    return c.json({ ok: true });
  });

  // まとまりを消す: 中の人と下のまとまりは、ひとつ上に移す（人は消えない）
  api.delete("/org/units/:id", async (c) => {
    const db = c.env.DB;
    const unit = await db.prepare("SELECT * FROM org_units WHERE id = ?").bind(c.req.param("id")).first<UnitRow>();
    if (!unit) return c.json({ error: "見つかりません" }, 404);
    await db.batch([
      db.prepare("UPDATE cards SET org_unit_id = ? WHERE org_unit_id = ?").bind(unit.parent_id, unit.id),
      db.prepare("UPDATE org_units SET parent_id = ? WHERE parent_id = ?").bind(unit.parent_id, unit.id),
      db.prepare("DELETE FROM org_units WHERE id = ?").bind(unit.id),
    ]);
    return c.json({ ok: true });
  });

  // 人の置き場所と上司（同じ会社の中だけ。上司は自分の部下にはできない）
  api.patch("/cards/:id/org", async (c) => {
    const db = c.env.DB;
    const card = await db.prepare("SELECT id, company_key FROM cards WHERE id = ? AND deleted_at IS NULL").bind(c.req.param("id")).first<{ id: string; company_key: string }>();
    if (!card) return c.json({ error: "見つかりません" }, 404);
    const b = await c.req.json<{ org_unit_id?: string | null; reports_to?: string | null }>();
    if (b.org_unit_id) {
      const u = await db.prepare("SELECT company_key FROM org_units WHERE id = ?").bind(b.org_unit_id).first<{ company_key: string }>();
      if (u?.company_key !== card.company_key) return c.json({ error: "その会社のまとまりではありません" }, 400);
    }
    if (b.reports_to) {
      if (b.reports_to === card.id) return c.json({ error: "自分を上司にはできません" }, 400);
      const boss = await db.prepare("SELECT company_key FROM cards WHERE id = ? AND deleted_at IS NULL").bind(b.reports_to).first<{ company_key: string }>();
      if (boss?.company_key !== card.company_key) return c.json({ error: "同じ会社の人を選んでください" }, 400);
      // 上司をたどって自分に戻るなら輪になる
      let cur: string | null = b.reports_to;
      for (let i = 0; cur && i < 50; i++) {
        if (cur === card.id) return c.json({ error: "自分の部下を上司にはできません" }, 400);
        cur = (await db.prepare("SELECT reports_to FROM cards WHERE id = ?").bind(cur).first<{ reports_to: string | null }>())?.reports_to ?? null;
      }
    }
    await db
      .prepare("UPDATE cards SET org_unit_id = CASE WHEN ?1 THEN ?2 ELSE org_unit_id END, reports_to = CASE WHEN ?3 THEN ?4 ELSE reports_to END WHERE id = ?5")
      .bind(b.org_unit_id !== undefined ? 1 : 0, b.org_unit_id || null, b.reports_to !== undefined ? 1 : 0, b.reports_to || null, card.id)
      .run();
    await audit(db, { userId: c.get("user").id, via: "web", action: "org_place", targetType: "card", targetId: card.id });
    return c.json({ ok: true });
  });
}
