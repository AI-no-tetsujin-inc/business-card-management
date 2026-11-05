// 取引先の組織図: 会社 → 本部・部署・店舗・支社など → 人。上のまとまりから下へ線でつなぎ、まとまりの中は上司 → 部下・役職の高い順に並べる
// パソコンは上から下へ広がる図、スマホは左から右へ字下げした木で見せる
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { ORG_KINDS, ORG_KIND_LABEL, type OrgKind } from "../../shared/org";
import { useToast } from "./ui";

interface Unit {
  id: string;
  name: string;
  kind: OrgKind;
  parent_id: string | null;
  sort_order: number;
}
interface Person {
  id: string;
  person_name: string;
  department: string | null;
  title: string | null;
  org_unit_id: string | null;
  reports_to: string | null;
  role_note: string | null;
  attitude_note: string | null;
  rank: number;
}
interface Org {
  units: Unit[];
  people: Person[];
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const byRank = (a: Person, b: Person) => a.rank - b.rank || a.person_name.localeCompare(b.person_name, "ja");

export function OrgChart({ companyKey, companyName }: { companyKey: string; companyName: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const [org, setOrg] = useState<Org | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const canWrite = user.role !== "viewer";

  const load = useCallback(() => {
    api<Org>(`/api/org?company=${encodeURIComponent(companyKey)}`).then(setOrg, (e) => setError(errorMessage(e)));
  }, [companyKey]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError("");
    try {
      await fn();
      if (done) toast(done);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const auto = () =>
    run(async () => {
      const r = await api<{ created_units: number; placed: number }>("/api/org/auto", { body: { company: companyKey } });
      toast(`名刺の部署から ${r.created_units} 個のまとまりを作り、${r.placed} 人を入れました`);
    });

  const unplacedWithDept = org?.people.filter((p) => !p.org_unit_id && p.department?.trim()).length ?? 0;

  return (
    <div className="panel org-panel">
      <div className="between row">
        <h2>組織図</h2>
        {canWrite && org && (
          <div className="row">
            {unplacedWithDept > 0 && (
              <button className="btn btn-small btn-primary" onClick={auto}>
                名刺の部署から組み立てる（{unplacedWithDept}人）
              </button>
            )}
            <button className="btn btn-small" onClick={() => setEditing(!editing)}>
              {editing ? "図に戻る" : "組織を直す"}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="notice notice-error small" role="alert">
          {error}
        </p>
      )}
      {org === null ? (
        <p className="muted small">読み込み中…</p>
      ) : editing ? (
        <OrgEditor org={org} companyKey={companyKey} run={run} />
      ) : (
        <OrgTree org={org} companyName={companyName} />
      )}
    </div>
  );
}

// ---------- 図 ----------

function OrgTree({ org, companyName }: { org: Org; companyName: string }) {
  const children = useMemo(() => {
    const m = new Map<string | null, Unit[]>();
    for (const u of org.units) m.set(u.parent_id, [...(m.get(u.parent_id) ?? []), u]);
    for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ja"));
    return m;
  }, [org.units]);
  const peopleIn = (unitId: string | null) => org.people.filter((p) => p.org_unit_id === unitId);
  // 部署が決まっていない人のうち、役員以上（社長・取締役など）は会社のいちばん上に置く
  const EXEC_RANK = 25;
  const executives = peopleIn(null).filter((p) => p.rank <= EXEC_RANK);
  const unplaced = peopleIn(null).filter((p) => p.rank > EXEC_RANK);
  const nameOf = (id: string | null) => org.people.find((p) => p.id === id)?.person_name;

  if (!org.units.length) {
    return (
      <p className="muted small">
        まだ組織図がありません。{unplaced.some((p) => p.department) ? "「名刺の部署から組み立てる」を押すと、名刺の部署欄（例: 営業本部 第一営業部）から自動で作ります。" : "「組織を直す」から、部署や店舗を追加してください。"}
      </p>
    );
  }

  const renderUnit = (u: Unit): React.ReactNode => {
    const members = peopleIn(u.id);
    const kids = children.get(u.id) ?? [];
    return (
      <li key={u.id} className="org-item">
        <div className={`org-node org-${u.kind}`}>
          <div className="org-node-head">
            <span className="org-kind">{ORG_KIND_LABEL[u.kind]}</span>
            <strong>{u.name}</strong>
          </div>
          {members.length > 0 ? <PeopleTree people={members} nameOf={nameOf} /> : <p className="muted small org-empty">名刺の人はいません</p>}
        </div>
        {kids.length > 0 && <ul className="org-children">{kids.map(renderUnit)}</ul>}
      </li>
    );
  };

  return (
    <>
      <p className="muted small">上から下へ、会社 → 本部・部署・店舗 → 人の順につながっています。まとまりの中は、上司 → 部下（役職の高い順）に並べています。</p>
      <div className="org-scroll">
        <ul className="org-tree">
          <li className="org-item">
            <div className="org-node org-company">
              <div className="org-node-head">
                <strong>{companyName}</strong>
              </div>
              {executives.length > 0 && <PeopleTree people={executives} nameOf={nameOf} />}
            </div>
            <ul className="org-children">{(children.get(null) ?? []).map(renderUnit)}</ul>
          </li>
        </ul>
      </div>
      {unplaced.length > 0 && (
        <div className="org-unplaced">
          <h3>所属が決まっていない人（{unplaced.length}人）</h3>
          <p className="muted small">「組織を直す」で部署・店舗を選ぶと、図に入ります。</p>
          <PeopleTree people={unplaced} nameOf={nameOf} />
        </div>
      )}
      <p className="muted small org-legend">
        <span className="org-badge">立場</span>
        <span className="org-badge org-badge-attitude">温度感</span> は人物像の最新の内容です。
      </p>
    </>
  );
}

/** まとまりの中の人: 同じまとまりの上司の下に部下を字下げして並べる。上司がいない人は役職の高い順 */
function PeopleTree({ people, nameOf }: { people: Person[]; nameOf: (id: string | null) => string | undefined }) {
  const ids = new Set(people.map((p) => p.id));
  const roots = people.filter((p) => !p.reports_to || !ids.has(p.reports_to)).sort(byRank);
  const under = (id: string) => people.filter((p) => p.reports_to === id).sort(byRank);
  const row = (p: Person, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(p.id)) return null;
    const next = new Set(seen).add(p.id);
    return (
      <li key={p.id} className={depth ? "org-sub" : ""}>
        <Link to={`/cards/${p.id}`} className="org-person">
          <span className="org-person-name">{p.person_name}</span>
          {p.title && <span className="org-person-title">{p.title}</span>}
        </Link>
        {p.reports_to && !ids.has(p.reports_to) && nameOf(p.reports_to) && <span className="muted small"> ・ 上司: {nameOf(p.reports_to)}</span>}
        {(p.role_note || p.attitude_note) && (
          <div className="org-badges">
            {p.role_note && <span className="org-badge" title={p.role_note}>{short(p.role_note, 18)}</span>}
            {p.attitude_note && (
              <span className="org-badge org-badge-attitude" title={p.attitude_note}>
                {short(p.attitude_note, 14)}
              </span>
            )}
          </div>
        )}
        {under(p.id).length > 0 && <ul>{under(p.id).map((c) => row(c, depth + 1, next))}</ul>}
      </li>
    );
  };
  return <ul className="org-people">{roots.map((p) => row(p, 0, new Set()))}</ul>;
}

// ---------- 直す ----------

function OrgEditor({ org, companyKey, run }: { org: Org; companyKey: string; run: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  /** まとまりを「本部 > 部 > 課」の形で見せる（選びやすいように） */
  const path = (id: string | null): string => {
    const names: string[] = [];
    let cur = org.units.find((u) => u.id === id);
    for (let i = 0; cur && i < 10; i++) {
      names.unshift(cur.name);
      cur = org.units.find((u) => u.id === cur!.parent_id);
    }
    return names.join(" > ");
  };
  const sortedUnits = [...org.units].sort((a, b) => path(a.id).localeCompare(path(b.id), "ja"));
  const patchUnit = (u: Unit, body: Partial<Unit>) => run(() => api(`/api/org/units/${u.id}`, { method: "PATCH", body }));
  const placePerson = (p: Person, body: { org_unit_id?: string | null; reports_to?: string | null }) => run(() => api(`/api/cards/${p.id}/org`, { method: "PATCH", body }));

  return (
    <div className="org-editor">
      <h3>部署・店舗などのまとまり</h3>
      <p className="muted small">「上のまとまり」を変えると、図の枝分かれが変わります。消すと、中の人と下のまとまりはひとつ上に移ります（人は消えません）。</p>
      <div className="table-scroll">
        <table className="simple-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>種類</th>
              <th>上のまとまり</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedUnits.map((u) => (
              <tr key={u.id}>
                <td>
                  <input defaultValue={u.name} aria-label="まとまりの名前" onBlur={(e) => e.target.value.trim() && e.target.value !== u.name && patchUnit(u, { name: e.target.value })} />
                </td>
                <td>
                  <select value={u.kind} aria-label="種類" onChange={(e) => patchUnit(u, { kind: e.target.value as OrgKind })}>
                    {ORG_KINDS.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={u.parent_id ?? ""} aria-label="上のまとまり" onChange={(e) => patchUnit(u, { parent_id: e.target.value || null })}>
                    <option value="">（会社の直下）</option>
                    {sortedUnits
                      .filter((x) => x.id !== u.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {path(x.id)}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <button className="btn btn-small btn-danger-ghost" onClick={() => run(() => api(`/api/org/units/${u.id}`, { method: "DELETE" }), `「${u.name}」を消しました`)}>
                    消す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row wrap org-add">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例: 新宿店 / 経営企画部" aria-label="新しいまとまりの名前" />
        <select value={newParent} onChange={(e) => setNewParent(e.target.value)} aria-label="新しいまとまりの上" style={{ width: "auto" }}>
          <option value="">（会社の直下）</option>
          {sortedUnits.map((x) => (
            <option key={x.id} value={x.id}>
              {path(x.id)} の下
            </option>
          ))}
        </select>
        <button
          className="btn btn-small btn-primary"
          disabled={!newName.trim()}
          onClick={() =>
            run(async () => {
              await api("/api/org/units", { body: { company: companyKey, name: newName, parent_id: newParent || null } });
              setNewName("");
            }, "まとまりを追加しました")
          }
        >
          ＋ 追加
        </button>
      </div>

      <h3>人の置き場所と上司</h3>
      <p className="muted small">上司を選ぶと、図ではその人の下に並びます。役職（部長・課長など）からも上下を判断します。</p>
      <div className="table-scroll">
        <table className="simple-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>名刺の部署・役職</th>
              <th>まとまり</th>
              <th>上司</th>
            </tr>
          </thead>
          <tbody>
            {[...org.people].sort(byRank).map((p) => (
              <tr key={p.id}>
                <td>{p.person_name}</td>
                <td className="small">{[p.department, p.title].filter(Boolean).join(" ・ ") || "—"}</td>
                <td>
                  <select value={p.org_unit_id ?? ""} aria-label={`${p.person_name}のまとまり`} onChange={(e) => placePerson(p, { org_unit_id: e.target.value || null })}>
                    <option value="">（決まっていない）</option>
                    {sortedUnits.map((x) => (
                      <option key={x.id} value={x.id}>
                        {path(x.id)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={p.reports_to ?? ""} aria-label={`${p.person_name}の上司`} onChange={(e) => placePerson(p, { reports_to: e.target.value || null })}>
                    <option value="">（なし）</option>
                    {org.people
                      .filter((x) => x.id !== p.id)
                      .sort(byRank)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.person_name}
                          {x.title ? `（${x.title}）` : ""}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
