import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import type { Company } from "../types";

type NodeType = "company" | "org" | "person" | "deal" | "user";
interface GNode {
  id: string;
  type: NodeType;
  label: string;
  sub?: string;
}
interface GEdge {
  from: string;
  to: string;
  kind: string;
  source?: string;
}
interface Graph {
  center: string;
  nodes: GNode[];
  edges: GEdge[];
}

const TYPE_LABEL: Record<NodeType, string> = { company: "会社", org: "部署・店舗", person: "人物", deal: "案件", user: "社内メンバー" };
const W = 900;
const H = 620;

/** 簡単な力学モデルで配置する（つながる点は近く、ほかは離す） */
function layout(g: Graph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  g.nodes.forEach((n, i) => {
    const a = (i / g.nodes.length) * Math.PI * 2;
    pos.set(n.id, n.id === g.center ? { x: W / 2, y: H / 2, vx: 0, vy: 0 } : { x: W / 2 + Math.cos(a) * 220, y: H / 2 + Math.sin(a) * 200, vx: 0, vy: 0 });
  });
  const list = [...pos.entries()];
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i][1];
        const b = list[j][1];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 100);
        const f = 22000 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    for (const e of g.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - 170) * 0.02;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const [id, p] of list) {
      if (id === g.center) continue;
      p.vx += (W / 2 - p.x) * 0.002;
      p.vy += (H / 2 - p.y) * 0.002;
      p.x = Math.min(W - 60, Math.max(60, p.x + p.vx * 0.5));
      p.y = Math.min(H - 30, Math.max(30, p.y + p.vy * 0.5));
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  return new Map(list.map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

/** 点が収まる範囲に表示枠を合わせる */
function fitBox(pos: Map<string, { x: number; y: number }>) {
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const pad = 70;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad / 2;
  const w = Math.max(Math.max(...xs) - x0 + pad, 400);
  const h = Math.max(Math.max(...ys) - y0 + pad, 300);
  return `${x0} ${y0} ${w} ${h}`;
}

export function MapPage() {
  const [params, setParams] = useSearchParams();
  const center = params.get("center");
  // 社内メンバーとの名刺交換の線は、ふだんは出さない（取引先の組織のつながりを見やすくする）
  const staff = params.get("staff") === "1";
  const [graph, setGraph] = useState<Graph | null>(null);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<GNode[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ companies: Company[] }>("/api/companies").then((r) => setCompanies(r.companies.sort((a, b) => b.count - a.count).slice(0, 12)), () => {});
  }, []);

  useEffect(() => {
    if (!center) return setGraph(null);
    setError("");
    api<Graph>(`/api/graph?center=${encodeURIComponent(center)}&depth=2${staff ? "&staff=1" : ""}`).then(setGraph, (e) => setError(errorMessage(e)));
  }, [center, staff]);

  const positions = useMemo(() => (graph ? layout(graph) : null), [graph]);
  const go = (id: string) => {
    setCandidates(null);
    setParams(staff ? { center: id, staff: "1" } : { center: id });
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api<{ nodes: GNode[] }>(`/api/graph/search?q=${encodeURIComponent(query)}`);
    if (r.nodes.length === 1) go(r.nodes[0].id);
    else setCandidates(r.nodes);
  };

  const centerNode = graph?.nodes.find((n) => n.id === graph.center);

  return (
    <div className="page">
      <h1>関係性マップ</h1>
      <form className="toolbar" onSubmit={search}>
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="会社名・人物名・案件名・社員名" />
        <button className="btn" type="submit">
          表示
        </button>
      </form>
      {candidates && (
        <div className="panel">
          {candidates.length === 0 ? (
            <p className="muted">見つかりませんでした。</p>
          ) : (
            <div className="row">
              {candidates.map((n) => (
                <button key={n.id} className={`btn btn-small node-chip node-${n.type}`} onClick={() => go(n.id)}>
                  {TYPE_LABEL[n.type]}: {n.label}
                  {n.sub && `（${n.sub}）`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!center && (
        <div className="panel">
          <p className="muted small">会社を選ぶと、その会社の部署・店舗と人、議事録から分かったつながりを表示します。部署や上下関係は、会社の画面の「組織図」で整えられます。</p>
          <div className="row">
            {companies.map((c) => (
              <button key={c.company_key} className="btn btn-small" onClick={() => go(`company:${c.company_key}`)}>
                {c.company_name}（{c.count}）
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {graph && positions && centerNode && (
        <div className="panel map-panel">
          <div className="row between">
            <strong>
              {TYPE_LABEL[centerNode.type]}: {centerNode.label}
            </strong>
            <span className="row">
              <label className="check-line small">
                <input type="checkbox" checked={staff} onChange={(e) => setParams(e.target.checked ? { center: centerNode.id, staff: "1" } : { center: centerNode.id })} />
                社内メンバーとの名刺交換も表示
              </label>
              {centerNode.type === "person" && <Link to={`/cards/${centerNode.id.slice(7)}`}>名刺を開く</Link>}
              {centerNode.type === "company" && <Link to={`/company?key=${encodeURIComponent(centerNode.id.slice(8))}`}>組織図で見る</Link>}
            </span>
          </div>
          <svg viewBox={fitBox(positions)} className="map-svg" role="img" aria-label={`${centerNode.label} のつながり`}>
            {graph.edges.map((e, i) => {
              const a = positions.get(e.from);
              const b = positions.get(e.to);
              if (!a || !b) return null;
              return (
                <g key={i}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`map-edge ${e.source ? "from-minutes" : ""}`}>
                    <title>{e.source ? `${e.kind}（根拠: ${e.source}）` : e.kind}</title>
                  </line>
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} className="map-edge-label">
                    {e.kind}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const p = positions.get(n.id)!;
              const isCenter = n.id === graph.center;
              return (
                <g key={n.id} className={`map-node node-${n.type}`} transform={`translate(${p.x},${p.y})`} onClick={() => go(n.id)}>
                  <circle r={isCenter ? 16 : n.type === "company" ? 12 : 9} className={isCenter ? "center" : ""} />
                  <text y={isCenter ? 32 : 24} className="map-label">
                    {n.label}
                  </text>
                  {n.sub && n.type !== "user" && (
                    <text y={isCenter ? 46 : 37} className="map-sub">
                      {n.sub.length > 14 ? `${n.sub.slice(0, 14)}…` : n.sub}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="map-legend">
            {(Object.keys(TYPE_LABEL) as NodeType[]).map((t) => (
              <span key={t} className={`node-${t}`}>
                <i /> {TYPE_LABEL[t]}
              </span>
            ))}
            <span className="muted">点線 = 議事録から読み取ったつながり ・ 点をクリックで中心を移動</span>
          </div>
        </div>
      )}
    </div>
  );
}
