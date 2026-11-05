// 人物（名刺）の登録・統合・更新・メモ・検索。画面（REST）と MCP の両方から使う。
import {
  FIELD_KEYS,
  FIELD_LABEL,
  companyKey,
  emailKey,
  personKey,
  phoneKey,
  pickFields,
  type CardFields,
  type FieldKey,
} from "../shared/fields";

export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

/** 操作の経路: 画面 = "web"、AI = "ai:Claude" など、定期処理 = "cron" */
export type Via = string;

export interface FieldChange {
  field: FieldKey | "tags" | "exchange_place" | "exchanged_on";
  label: string;
  before: string;
  after: string;
}

// ---------- 操作ログ ----------

export async function audit(
  db: D1Database,
  e: { userId: string | null; via: Via; action: string; targetType?: string; targetId?: string; detail?: unknown },
) {
  try {
    await db
      .prepare("INSERT INTO audit_logs (id, user_id, via, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), e.userId, e.via, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.detail ?? {}), nowIso())
      .run();
  } catch (err) {
    console.error("audit log failed", err); // ログ失敗で本処理は止めない
  }
}

// ---------- 統合ルール ----------

/** 正規化したメール・電話番号を contact_points に入れ直す */
export function contactPointStatements(db: D1Database, cardId: string, f: CardFields): D1PreparedStatement[] {
  const stmts = [db.prepare("DELETE FROM contact_points WHERE card_id = ?").bind(cardId)];
  const add = (kind: string, key: string) =>
    stmts.push(db.prepare("INSERT OR IGNORE INTO contact_points (card_id, kind, value_key) VALUES (?, ?, ?)").bind(cardId, kind, key));
  const e = emailKey(f.email);
  if (e) add("email", e);
  for (const p of [f.phone, f.mobile]) {
    const k = phoneKey(p);
    if (k) add("phone", k);
  }
  return stmts;
}

/**
 * 重複候補の理由。mobile（携帯番号）と phone_name（電話番号＋氏名）は同一人物の可能性が高い。
 * phone（電話番号だけ）は会社の代表番号のことがあるので、候補として出すだけで同一人物とはみなさない
 */
export type MatchKind = "email" | "mobile" | "phone_name" | "name_company" | "phone" | "name" | "kana";
export const EXACT_MATCHES: MatchKind[] = ["email", "mobile", "phone_name"];

export interface MatchCandidate {
  id: string;
  company_name: string;
  department: string;
  title: string;
  person_name: string;
  email: string;
  phone: string;
  mobile: string;
  created_by_name: string;
  created_at: string;
  match: MatchKind;
}

/**
 * 同じ人の可能性がある名刺を探す。
 * email / phone 一致 = 同一人物として自動統合してよいもの。それ以外は人（または AI 判定）に確認するもの。
 */
export async function findMatches(db: D1Database, f: CardFields, excludeId?: string): Promise<MatchCandidate[]> {
  const e = emailKey(f.email);
  const phones = [f.phone, f.mobile].map(phoneKey).filter(Boolean);
  const pk = personKey(f.person_name);
  const ck = companyKey(f.company_name);
  const kana = f.person_name_kana.normalize("NFKC").replace(/\s/g, "");
  if (!e && !phones.length && !pk && !kana) return [];
  const { results } = await db
    .prepare(
      `SELECT c.id, c.company_name, c.company_key, c.department, c.title, c.person_name, c.person_key,
              c.person_name_kana, c.email, c.phone, c.mobile, c.created_at, u.name AS created_by_name,
              EXISTS (SELECT 1 FROM contact_points cp WHERE cp.card_id = c.id AND cp.kind = 'email' AND cp.value_key = ?1) AS m_email,
              EXISTS (SELECT 1 FROM contact_points cp WHERE cp.card_id = c.id AND cp.kind = 'phone' AND cp.value_key IN (?2, ?3)) AS m_phone
         FROM cards c JOIN users u ON u.id = c.created_by
        WHERE c.deleted_at IS NULL AND c.id != ?4
          AND (EXISTS (SELECT 1 FROM contact_points cp WHERE cp.card_id = c.id AND cp.kind = 'email' AND cp.value_key = ?1)
               OR EXISTS (SELECT 1 FROM contact_points cp WHERE cp.card_id = c.id AND cp.kind = 'phone' AND cp.value_key IN (?2, ?3))
               OR (?5 != '' AND c.person_key = ?5)
               OR (?6 != '' AND replace(replace(c.person_name_kana, ' ', ''), '　', '') = ?6))
        LIMIT 10`,
    )
    .bind(e || "\u0000", phones[0] ?? "\u0000", phones[1] ?? "\u0000", excludeId ?? "", pk, kana)
    .all<Record<string, string | number>>();
  const order: Record<MatchKind, number> = { email: 0, mobile: 1, phone_name: 2, name_company: 3, phone: 4, name: 5, kana: 6 };
  const mobileKey = phoneKey(f.mobile);
  return results
    .map((r) => {
      const samePerson = Boolean(pk) && r.person_key === pk;
      const match: MatchKind = r.m_email
        ? "email"
        : r.m_phone
          ? mobileKey && [phoneKey(String(r.mobile)), phoneKey(String(r.phone))].includes(mobileKey)
            ? "mobile"
            : samePerson
              ? "phone_name"
              : "phone"
          : r.person_key === pk && pk
            ? r.company_key === ck
              ? "name_company"
              : "name"
            : "kana";
      return {
        id: String(r.id),
        company_name: String(r.company_name),
        department: String(r.department),
        title: String(r.title),
        person_name: String(r.person_name),
        email: String(r.email),
        phone: String(r.phone),
        mobile: String(r.mobile),
        created_by_name: String(r.created_by_name),
        created_at: String(r.created_at),
        match,
      };
    })
    .sort((a, b) => order[a.match] - order[b.match]);
}

// ---------- 登録・統合・更新 ----------

/** 表記の違いだけ（大文字小文字・空白・ハイフン・「株式会社」の有無など）なら同じ値とみなす */
function sameValue(k: FieldKey, a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (k === "email") return emailKey(a) === emailKey(b);
  if (k === "phone" || k === "mobile" || k === "fax") return phoneKey(a) !== "" && phoneKey(a) === phoneKey(b);
  if (k === "company_name") return companyKey(a) === companyKey(b);
  const norm = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[\s\-‐－・.,、。]/g, "");
  return norm(a) === norm(b);
}

const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 30) : [];
const validDate = (d: string | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");

export interface RegisterInput {
  userId: string;
  via: Via;
  fields: Partial<CardFields>;
  exchangedOn?: string;
  exchangePlace?: string;
  tags?: string[];
  note?: string;
  /** 既存の人物に統合する（ID 指定） */
  mergeInto?: string;
  /** 似た人がいても新しい人物として登録する */
  forceNew?: boolean;
}

export type RegisterResult =
  | { action: "created" | "merged"; cardId: string; changes: FieldChange[] }
  | { action: "needs_confirmation"; candidates: MatchCandidate[] };

function noteStatement(db: D1Database, cardId: string, body: string, userId: string, via: Via, at: string) {
  return db
    .prepare("INSERT INTO card_notes (id, card_id, body, created_by, created_at, source) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(uuid(), cardId, body, userId, at, via);
}

/**
 * 人物を登録する。統合ルール:
 *  1. メールか電話番号が一致 → 既存の人物に統合（「別の人も名刺を登録」として履歴が残る）
 *  2. 氏名・ふりがなだけ一致 → 確認が必要として候補を返す（mergeInto / forceNew で再実行）
 *  3. どれでもない → 新規登録
 */
export async function registerPerson(db: D1Database, input: RegisterInput): Promise<RegisterResult> {
  const fields = pickFields(input.fields);
  // 既存の名刺への統合は、更新する項目だけを渡すことがある（氏名・メールは既存の名刺に残っている）
  if (input.mergeInto) return mergeIntoCard(db, input.mergeInto, fields, input);
  if (!fields.person_name && !fields.email) throw new Error("氏名かメールアドレスのどちらかは必要です");
  if (!input.forceNew) {
    const matches = await findMatches(db, fields);
    const exact = matches.find((m) => EXACT_MATCHES.includes(m.match));
    if (exact) return mergeIntoCard(db, exact.id, fields, input);
    if (matches.length) return { action: "needs_confirmation", candidates: matches };
  }
  return createCard(db, fields, input);
}

async function createCard(db: D1Database, fields: CardFields, input: RegisterInput): Promise<RegisterResult> {
  const id = uuid();
  const at = nowIso();
  const exchangedOn = validDate(input.exchangedOn);
  const place = (input.exchangePlace ?? "").trim();
  const stmts = [
    db.prepare(
      `INSERT INTO cards (id, ${FIELD_KEYS.join(", ")}, company_key, person_key, exchange_place, exchanged_on, tags, created_by, created_at)
       VALUES (?, ${FIELD_KEYS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      ...FIELD_KEYS.map((k) => fields[k]),
      companyKey(fields.company_name),
      personKey(fields.person_name),
      place,
      exchangedOn,
      JSON.stringify(cleanTags(input.tags)),
      input.userId,
      at,
    ),
    db.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'created', ?, ?, ?)")
      .bind(uuid(), id, input.userId, at, JSON.stringify({ exchanged_on: exchangedOn, exchange_place: place, via: input.via })),
    ...contactPointStatements(db, id, fields),
  ];
  const note = (input.note ?? "").trim();
  if (note) stmts.push(noteStatement(db, id, note, input.userId, input.via, at));
  await db.batch(stmts);
  return { action: "created", cardId: id, changes: [] };
}

async function mergeIntoCard(db: D1Database, cardId: string, fields: CardFields, input: RegisterInput): Promise<RegisterResult> {
  const card = await db.prepare("SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL").bind(cardId).first<Record<string, string>>();
  if (!card) throw new Error("統合先の名刺が見つかりません");
  const at = nowIso();
  const merged = pickFields(card);
  const changes: FieldChange[] = [];
  // 新しい名刺の内容を優先（空欄・表記の違いだけの項目は既存のまま）。変更前の値は履歴に残す
  for (const k of FIELD_KEYS) {
    if (fields[k] && !sameValue(k, fields[k], merged[k])) {
      changes.push({ field: k, label: FIELD_LABEL[k], before: merged[k], after: fields[k] });
      merged[k] = fields[k];
    }
  }
  const exchangedOn = validDate(input.exchangedOn);
  const place = (input.exchangePlace ?? "").trim();
  const newer = !card.exchanged_on || (exchangedOn && exchangedOn >= card.exchanged_on);
  const tags = cleanTags([...JSON.parse(card.tags || "[]"), ...(input.tags ?? [])]);
  const stmts = [
    db.prepare(
      `UPDATE cards SET ${FIELD_KEYS.map((k) => `${k} = ?`).join(", ")}, company_key = ?, person_key = ?,
         exchanged_on = ?, exchange_place = ?, tags = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      ...FIELD_KEYS.map((k) => merged[k]),
      companyKey(merged.company_name),
      personKey(merged.person_name),
      newer && exchangedOn ? exchangedOn : card.exchanged_on,
      newer && place ? place : card.exchange_place,
      JSON.stringify(tags),
      input.userId,
      at,
      cardId,
    ),
    db.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'exchanged', ?, ?, ?)").bind(
      uuid(),
      cardId,
      input.userId,
      at,
      JSON.stringify({
        exchanged_on: exchangedOn,
        exchange_place: place,
        updated_fields: changes.map((c) => c.label),
        changes,
        via: input.via,
      }),
    ),
    ...contactPointStatements(db, cardId, merged),
  ];
  const note = (input.note ?? "").trim();
  if (note) stmts.push(noteStatement(db, cardId, note, input.userId, input.via, at));
  await db.batch(stmts);
  return { action: "merged", cardId, changes };
}

export interface UpdateInput {
  userId: string;
  via: Via;
  fields?: Partial<CardFields>;
  tags?: string[];
  exchangePlace?: string;
  exchangedOn?: string;
}

/** 名刺の項目を更新する（指定した項目だけ）。変更前後を履歴に残す */
export async function updatePerson(db: D1Database, cardId: string, input: UpdateInput): Promise<FieldChange[] | null> {
  const card = await db.prepare("SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL").bind(cardId).first<Record<string, string>>();
  if (!card) return null;
  const next = pickFields(card);
  const changes: FieldChange[] = [];
  for (const k of FIELD_KEYS) {
    const v = input.fields?.[k];
    if (typeof v === "string" && v.trim() !== next[k]) {
      changes.push({ field: k, label: FIELD_LABEL[k], before: next[k], after: v.trim() });
      next[k] = v.trim();
    }
  }
  let tags = card.tags;
  if (input.tags) {
    const t = JSON.stringify(cleanTags(input.tags));
    const show = (json: string) => (JSON.parse(json || "[]") as string[]).join(" / ");
    if (t !== card.tags) changes.push({ field: "tags", label: "タグ", before: show(card.tags), after: show(t) });
    tags = t;
  }
  let place = card.exchange_place;
  if (typeof input.exchangePlace === "string" && input.exchangePlace.trim() !== place) {
    changes.push({ field: "exchange_place", label: "交換場所・イベント", before: place, after: input.exchangePlace.trim() });
    place = input.exchangePlace.trim();
  }
  let exchangedOn = card.exchanged_on;
  if (input.exchangedOn !== undefined && validDate(input.exchangedOn) && input.exchangedOn !== exchangedOn) {
    changes.push({ field: "exchanged_on", label: "交換日", before: exchangedOn, after: input.exchangedOn });
    exchangedOn = input.exchangedOn;
  }
  if (!changes.length) return [];
  const at = nowIso();
  await db.batch([
    db.prepare(
      `UPDATE cards SET ${FIELD_KEYS.map((k) => `${k} = ?`).join(", ")}, company_key = ?, person_key = ?,
         tags = ?, exchange_place = ?, exchanged_on = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      ...FIELD_KEYS.map((k) => next[k]),
      companyKey(next.company_name),
      personKey(next.person_name),
      tags,
      place,
      exchangedOn,
      input.userId,
      at,
      cardId,
    ),
    db.prepare("INSERT INTO card_events (id, card_id, type, user_id, created_at, detail) VALUES (?, ?, 'updated', ?, ?, ?)")
      .bind(uuid(), cardId, input.userId, at, JSON.stringify({ updated_fields: changes.map((c) => c.label), changes, via: input.via })),
    ...contactPointStatements(db, cardId, next),
  ]);
  return changes;
}

export async function addNote(db: D1Database, cardId: string, userId: string, via: Via, body: string) {
  const text = body.trim();
  if (!text) throw new Error("メモを入力してください");
  if (text.length > 4000) throw new Error("メモが長すぎます（4000文字まで）");
  const exists = await db.prepare("SELECT 1 FROM cards WHERE id = ?").bind(cardId).first();
  if (!exists) throw new Error("名刺が見つかりません");
  await noteStatement(db, cardId, text, userId, via, nowIso()).run();
}

// ---------- 検索・詳細 ----------

export const CARD_LIST_SELECT = `
  SELECT c.*, u.name AS created_by_name,
    (SELECT display_key FROM card_images i WHERE i.card_id = c.id AND i.side = 'front' ORDER BY i.uploaded_at DESC LIMIT 1) AS front_display_key,
    (SELECT COUNT(*) FROM card_events e WHERE e.card_id = c.id AND e.type IN ('created', 'exchanged')) AS exchange_count,
    (SELECT body FROM card_notes n WHERE n.card_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
    (SELECT COUNT(*) FROM cards x WHERE c.person_group IS NOT NULL AND x.person_group = c.person_group AND x.id != c.id AND x.deleted_at IS NULL) AS other_affiliations
  FROM cards c JOIN users u ON u.id = c.created_by`;

export const SORTS: Record<string, string> = {
  company: "c.company_key, c.person_name_kana, c.person_name",
  recent: "c.created_at DESC",
  name: "c.person_name_kana, c.person_name",
  exchanged: "c.exchanged_on DESC, c.created_at DESC",
};

export interface ListFilters {
  q?: string;
  company?: string;
  user?: string;
  tag?: string;
  sort?: string;
  trash?: boolean;
  limit?: number;
}

export async function listCards(db: D1Database, f: ListFilters) {
  // 統合されて消えた名刺はごみ箱にも出さない
  const where: string[] = [f.trash ? "c.deleted_at IS NOT NULL AND c.merged_into IS NULL" : "c.deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (f.company) {
    where.push("c.company_key = ?");
    binds.push(f.company);
  }
  if (f.user) {
    where.push("EXISTS (SELECT 1 FROM card_events e WHERE e.card_id = c.id AND e.user_id = ? AND e.type IN ('created', 'exchanged'))");
    binds.push(f.user);
  }
  if (f.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)");
    binds.push(f.tag);
  }
  if (f.q?.trim()) {
    const cols = [...FIELD_KEYS, "exchange_place", "tags"].map((k) => `c.${k} LIKE ?`);
    cols.push("EXISTS (SELECT 1 FROM card_notes n WHERE n.card_id = c.id AND n.body LIKE ?)");
    for (const word of f.q.trim().split(/\s+/).slice(0, 5)) {
      where.push(`(${cols.join(" OR ")})`);
      binds.push(...cols.map(() => `%${word}%`));
    }
  }
  const order = SORTS[f.sort ?? "company"] ?? SORTS.company;
  const limit = Math.min(Math.max(f.limit ?? 1000, 1), 1000);
  const { results } = await db
    .prepare(`${CARD_LIST_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return results;
}

export async function getCardDetail(db: D1Database, id: string) {
  const card = await db.prepare(`${CARD_LIST_SELECT} WHERE c.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!card) return null;
  const [images, events, notes, interactions, tasks] = await db.batch([
    db.prepare(
      `SELECT i.*, u.name AS uploaded_by_name FROM card_images i JOIN users u ON u.id = i.uploaded_by
        WHERE i.card_id = ? ORDER BY i.uploaded_at DESC`,
    ).bind(id),
    db.prepare(
      `SELECT e.*, u.name AS user_name FROM card_events e JOIN users u ON u.id = e.user_id
        WHERE e.card_id = ? ORDER BY e.created_at DESC`,
    ).bind(id),
    db.prepare(
      `SELECT n.*, u.name AS created_by_name FROM card_notes n JOIN users u ON u.id = n.created_by
        WHERE n.card_id = ? ORDER BY n.created_at DESC`,
    ).bind(id),
    db.prepare(
      `SELECT i.*, d.title AS document_title FROM interactions i LEFT JOIN documents d ON d.id = i.document_id
        WHERE i.card_id = ? ORDER BY COALESCE(i.happened_on, i.created_at) DESC LIMIT 50`,
    ).bind(id),
    db.prepare(
      `SELECT t.id, t.title, t.due_on, t.status, ua.name AS assignee, t.assignee_name FROM tasks t LEFT JOIN users ua ON ua.id = t.assignee_user_id
        WHERE t.card_id = ? ORDER BY t.status, t.due_on LIMIT 50`,
    ).bind(id),
  ]);
  type Row = Record<string, string>;
  // 同じ人の別の所属（会社ごとに分かれた名刺）
  const affiliations = card.person_group
    ? (
        await db
          .prepare(
            `SELECT id, company_name, company_key, department, title, person_name, email, exchanged_on FROM cards
              WHERE person_group = ? AND id != ? AND deleted_at IS NULL ORDER BY exchanged_on DESC, created_at DESC`,
          )
          .bind(card.person_group, id)
          .all<Row>()
      ).results
    : [];
  return {
    card,
    affiliations,
    images: images.results as Row[],
    events: events.results as Row[],
    notes: notes.results as Row[],
    interactions: interactions.results as Row[],
    tasks: tasks.results as Row[],
  };
}


/** 2枚の名刺を「同じ人（別の所属）」としてまとめる。どちらかが既にまとまっていれば、そのまとまりに加える */
export async function linkSamePerson(db: D1Database, userId: string, aId: string, bId: string) {
  if (aId === bId) throw new Error("同じ名刺です");
  const { results } = await db.prepare("SELECT id, person_group, person_name, company_name FROM cards WHERE id IN (?, ?) AND deleted_at IS NULL").bind(aId, bId).all<{ id: string; person_group: string | null; person_name: string; company_name: string }>();
  if (results.length !== 2) throw new Error("名刺が見つかりません");
  const groups = [...new Set(results.map((r) => r.person_group).filter((g): g is string => Boolean(g)))];
  const group = groups[0] ?? uuid();
  const at = nowIso();
  const stmts = [db.prepare("UPDATE cards SET person_group = ? WHERE id IN (?, ?)").bind(group, aId, bId)];
  // 別々のまとまり同士なら1つにする
  for (const g of groups.slice(1)) stmts.push(db.prepare("UPDATE cards SET person_group = ? WHERE person_group = ?").bind(group, g));
  for (const r of results) {
    const other = results.find((x) => x.id !== r.id)!;
    stmts.push(
      db.prepare("INSERT INTO card_events (id, card_id, type, user_id, detail, created_at) VALUES (?, ?, 'updated', ?, ?, ?)")
        .bind(uuid(), r.id, userId, JSON.stringify({ linked: `${other.company_name} の名刺と同じ人としてまとめた` }), at),
    );
  }
  await db.batch(stmts);
  return group;
}

/** まとまりから外す（名刺自体は消さない） */
export async function unlinkSamePerson(db: D1Database, userId: string, id: string) {
  const card = await db.prepare("SELECT person_group FROM cards WHERE id = ?").bind(id).first<{ person_group: string | null }>();
  if (!card?.person_group) return;
  await db.batch([
    db.prepare("UPDATE cards SET person_group = NULL WHERE id = ?").bind(id),
    db.prepare("INSERT INTO card_events (id, card_id, type, user_id, detail, created_at) VALUES (?, ?, 'updated', ?, ?, ?)")
      .bind(uuid(), id, userId, JSON.stringify({ linked: "同じ人のまとまりから外した" }), nowIso()),
  ]);
  // 残りが1枚ならまとまりを解く
  const left = await db.prepare("SELECT COUNT(*) AS n FROM cards WHERE person_group = ?").bind(card.person_group).first<{ n: number }>();
  if ((left?.n ?? 0) <= 1) await db.prepare("UPDATE cards SET person_group = NULL WHERE person_group = ?").bind(card.person_group).run();
}
