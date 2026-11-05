// 段階5: 関係性マップ（人物・会社・案件・社員のつながり）
import type { Hono } from "hono";
import { companyKey } from "../shared/fields";
import { ORG_KIND_LABEL, type OrgKind } from "../shared/org";
import type { AppEnv } from "./session";

export type NodeType = "company" | "org" | "person" | "deal" | "user";
export interface GraphNode {
  id: string; // company:<key> / org:<org_unit_id> / person:<card_id> / deal:<id> / user:<id>
  type: NodeType;
  label: string;
  sub?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  source?: string; // 根拠（議事録名など）
}

const MAX_NODES = 80;

/** staff = 社内メンバーとの「名刺交換」の線も出すか（ふだんは出さず、取引先の組織のつながりを見せる） */
async function neighbors(db: D1Database, id: string, staff: boolean): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const [type, key] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] as [NodeType, string];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (type === "company") {
    // 会社の直下の部署・店舗と、まだ部署が決まっていない人
    const { results: units } = await db
      .prepare("SELECT id, name, kind FROM org_units WHERE company_key = ? AND parent_id IS NULL ORDER BY sort_order, name LIMIT 30")
      .bind(key)
      .all<{ id: string; name: string; kind: string }>();
    for (const u of units) {
      nodes.push({ id: `org:${u.id}`, type: "org", label: u.name, sub: ORG_KIND_LABEL[u.kind as OrgKind] });
      edges.push({ from: `org:${u.id}`, to: id, kind: "組織" });
    }
    const { results } = await db
      .prepare("SELECT id, person_name, title FROM cards WHERE company_key = ? AND deleted_at IS NULL AND org_unit_id IS NULL LIMIT 40")
      .bind(key)
      .all<{ id: string; person_name: string; title: string }>();
    for (const p of results) {
      nodes.push({ id: `person:${p.id}`, type: "person", label: p.person_name, sub: p.title });
      edges.push({ from: `person:${p.id}`, to: id, kind: "所属" });
    }
  }
  if (type === "org") {
    const unit = await db.prepare("SELECT company_key, parent_id FROM org_units WHERE id = ?").bind(key).first<{ company_key: string; parent_id: string | null }>();
    if (unit) {
      const up = unit.parent_id ? await describeNode(db, `org:${unit.parent_id}`) : await describeNode(db, `company:${unit.company_key}`);
      if (up) (nodes.push(up), edges.push({ from: id, to: up.id, kind: "組織" }));
      const { results: kids } = await db.prepare("SELECT id, name, kind FROM org_units WHERE parent_id = ? LIMIT 30").bind(key).all<{ id: string; name: string; kind: string }>();
      for (const k of kids) {
        nodes.push({ id: `org:${k.id}`, type: "org", label: k.name, sub: ORG_KIND_LABEL[k.kind as OrgKind] });
        edges.push({ from: `org:${k.id}`, to: id, kind: "組織" });
      }
      const { results: people } = await db
        .prepare("SELECT id, person_name, title FROM cards WHERE org_unit_id = ? AND deleted_at IS NULL LIMIT 40")
        .bind(key)
        .all<{ id: string; person_name: string; title: string }>();
      for (const p of people) {
        nodes.push({ id: `person:${p.id}`, type: "person", label: p.person_name, sub: p.title });
        edges.push({ from: `person:${p.id}`, to: id, kind: "所属" });
      }
    }
  }
  if (type === "person") {
    const card = await db
      .prepare("SELECT company_key, company_name, org_unit_id, reports_to FROM cards WHERE id = ?")
      .bind(key)
      .first<{ company_key: string; company_name: string; org_unit_id: string | null; reports_to: string | null }>();
    // 部署・店舗が決まっていればそこへ、なければ会社へ
    const up = card?.org_unit_id ? await describeNode(db, `org:${card.org_unit_id}`) : card?.company_key ? { id: `company:${card.company_key}`, type: "company" as const, label: card.company_name } : null;
    if (up) (nodes.push(up), edges.push({ from: id, to: up.id, kind: "所属" }));
    // 上司・部下
    if (card?.reports_to) {
      const boss = await describeNode(db, `person:${card.reports_to}`);
      if (boss) (nodes.push(boss), edges.push({ from: id, to: boss.id, kind: "上司" }));
    }
    const { results: reports } = await db.prepare("SELECT id FROM cards WHERE reports_to = ? AND deleted_at IS NULL LIMIT 20").bind(key).all<{ id: string }>();
    for (const r of reports) {
      const n = await describeNode(db, `person:${r.id}`);
      if (n) (nodes.push(n), edges.push({ from: n.id, to: id, kind: "上司" }));
    }
  }
  if (type === "person" && staff) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT u.id, u.name FROM card_events e JOIN users u ON u.id = e.user_id
          WHERE e.card_id = ? AND e.type IN ('created', 'exchanged') AND u.id != 'system'`,
      )
      .bind(key)
      .all<{ id: string; name: string }>();
    for (const u of results) {
      nodes.push({ id: `user:${u.id}`, type: "user", label: u.name, sub: "社内" });
      edges.push({ from: `user:${u.id}`, to: id, kind: "名刺交換" });
    }
  }
  if (type === "user" && staff) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT c.id, c.person_name, c.company_name FROM card_events e JOIN cards c ON c.id = e.card_id
          WHERE e.user_id = ? AND e.type IN ('created', 'exchanged') AND c.deleted_at IS NULL LIMIT 40`,
      )
      .bind(key)
      .all<{ id: string; person_name: string; company_name: string }>();
    for (const p of results) {
      nodes.push({ id: `person:${p.id}`, type: "person", label: p.person_name, sub: p.company_name });
      edges.push({ from: id, to: `person:${p.id}`, kind: "名刺交換" });
    }
  }

  // 議事録などから蓄積したつながり
  const { results: rels } = await db
    .prepare(
      `SELECT r.*, d.title AS doc FROM relations r LEFT JOIN documents d ON d.id = r.document_id
        WHERE r.from_node = ?1 OR r.to_node = ?1 LIMIT 60`,
    )
    .bind(id)
    .all<{ from_node: string; to_node: string; kind: string; doc: string | null }>();
  for (const r of rels) {
    edges.push({ from: r.from_node, to: r.to_node, kind: r.kind, source: r.doc ?? undefined });
    const other = r.from_node === id ? r.to_node : r.from_node;
    const node = await describeNode(db, other);
    if (node) nodes.push(node);
  }
  return { nodes, edges };
}

export async function describeNode(db: D1Database, id: string): Promise<GraphNode | null> {
  const i = id.indexOf(":");
  const type = id.slice(0, i) as NodeType;
  const key = id.slice(i + 1);
  if (type === "company") {
    const r = await db.prepare("SELECT company_name AS n FROM cards WHERE company_key = ? ORDER BY created_at DESC LIMIT 1").bind(key).first<{ n: string }>();
    const d = r ?? (await db.prepare("SELECT company_name AS n FROM deals WHERE company_key = ? LIMIT 1").bind(key).first<{ n: string }>());
    return { id, type, label: d?.n ?? key };
  }
  if (type === "person") {
    const r = await db
      .prepare("SELECT person_name, company_name, title, deleted_at FROM cards WHERE id = ?")
      .bind(key)
      .first<{ person_name: string; company_name: string; title: string; deleted_at: string | null }>();
    return r && !r.deleted_at ? { id, type, label: r.person_name, sub: r.title || r.company_name } : null;
  }
  if (type === "org") {
    const r = await db.prepare("SELECT name, kind FROM org_units WHERE id = ?").bind(key).first<{ name: string; kind: string }>();
    return r ? { id, type, label: r.name, sub: ORG_KIND_LABEL[r.kind as OrgKind] } : null;
  }
  if (type === "deal") {
    const r = await db.prepare("SELECT name, status FROM deals WHERE id = ?").bind(key).first<{ name: string; status: string }>();
    return r ? { id, type, label: r.name, sub: r.status } : null;
  }
  if (type === "user") {
    const r = await db.prepare("SELECT name FROM users WHERE id = ?").bind(key).first<{ name: string }>();
    return r ? { id, type, label: r.name, sub: "社内" } : null;
  }
  return null;
}

/** center から depth 段先までのつながりを集める */
export async function buildGraph(db: D1Database, center: string, depth = 2, staff = false) {
  const root = await describeNode(db, center);
  if (!root) return null;
  const nodes = new Map<string, GraphNode>([[root.id, root]]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [root.id];
  for (let d = 0; d < depth && frontier.length && nodes.size < MAX_NODES; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const n = await neighbors(db, id, staff);
      for (const node of n.nodes) {
        if (nodes.size >= MAX_NODES) break;
        if (!nodes.has(node.id)) {
          nodes.set(node.id, node);
          next.push(node.id);
        }
      }
      for (const e of n.edges) {
        if (nodes.has(e.from) && nodes.has(e.to)) edges.set(`${e.from}|${e.to}|${e.kind}`, e);
      }
    }
    frontier = next;
  }
  return { center: root.id, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** 名前から中心にするノードを探す（会社名 → 人物名 → 案件名 → 社員名の順） */
export async function findNode(db: D1Database, query: string): Promise<GraphNode[]> {
  const q = query.trim();
  if (!q) return [];
  const out: GraphNode[] = [];
  const key = companyKey(q);
  const { results: companies } = await db
    .prepare("SELECT company_key, MAX(company_name) AS n FROM cards WHERE deleted_at IS NULL AND (company_key LIKE ? OR company_name LIKE ?) GROUP BY company_key LIMIT 5")
    .bind(`%${key}%`, `%${q}%`)
    .all<{ company_key: string; n: string }>();
  out.push(...companies.map((c) => ({ id: `company:${c.company_key}`, type: "company" as const, label: c.n })));
  const { results: people } = await db
    .prepare("SELECT id, person_name, company_name FROM cards WHERE deleted_at IS NULL AND (person_name LIKE ?1 OR person_name_kana LIKE ?1 OR replace(person_name, ' ', '') LIKE ?1) LIMIT 5")
    .bind(`%${q.replace(/\s/g, "")}%`)
    .all<{ id: string; person_name: string; company_name: string }>();
  out.push(...people.map((p) => ({ id: `person:${p.id}`, type: "person" as const, label: p.person_name, sub: p.company_name })));
  const { results: deals } = await db.prepare("SELECT id, name, company_name FROM deals WHERE name LIKE ? LIMIT 3").bind(`%${q}%`).all<{ id: string; name: string; company_name: string }>();
  out.push(...deals.map((d) => ({ id: `deal:${d.id}`, type: "deal" as const, label: d.name, sub: d.company_name })));
  const { results: users } = await db.prepare("SELECT id, name FROM users WHERE registered = 1 AND name LIKE ? LIMIT 3").bind(`%${q}%`).all<{ id: string; name: string }>();
  out.push(...users.map((u) => ({ id: `user:${u.id}`, type: "user" as const, label: u.name, sub: "社内" })));
  return out;
}

export function registerGraphRoutes(api: Hono<AppEnv>) {
  api.get("/graph/search", async (c) => c.json({ nodes: await findNode(c.env.DB, c.req.query("q") ?? "") }));
  api.get("/graph", async (c) => {
    const center = c.req.query("center");
    if (!center) return c.json({ error: "中心を指定してください" }, 400);
    const depth = Math.min(Math.max(Number(c.req.query("depth") ?? 2), 1), 3);
    const g = await buildGraph(c.env.DB, center, depth, c.req.query("staff") === "1");
    return g ? c.json(g) : c.json({ error: "見つかりません" }, 404);
  });
}
