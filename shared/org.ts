// 組織図の共通ルール（部署名から種類を見分ける・役職から上下を決める）。画面とサーバーで同じものを使う

export const ORG_KINDS = [
  { key: "hq", label: "本部" },
  { key: "dept", label: "部署" },
  { key: "store", label: "店舗" },
  { key: "branch", label: "支社・支店" },
  { key: "team", label: "チーム" },
  { key: "other", label: "その他" },
] as const;
export type OrgKind = (typeof ORG_KINDS)[number]["key"];
export const ORG_KIND_LABEL = Object.fromEntries(ORG_KINDS.map((k) => [k.key, k.label])) as Record<OrgKind, string>;
export const isOrgKind = (v: unknown): v is OrgKind => ORG_KINDS.some((k) => k.key === v);

/** 部署名から種類を推測する（「新宿店」→ 店舗、「関西支社」→ 支社・支店、「営業本部」→ 本部） */
export function guessKind(name: string): OrgKind {
  if (/(店|ストア|ショップ|SHOP|STORE|ショールーム)$/i.test(name)) return "store";
  if (/(支社|支店|営業所|事業所|出張所|拠点|オフィス)$/.test(name)) return "branch";
  if (/(本部|事業本部|統括|カンパニー|事業部)$/.test(name)) return "hq";
  if (/(チーム|グループ|ユニット|班|G)$/i.test(name)) return "team";
  return "dept";
}

/** 名刺の部署欄を、上から順のまとまりに分ける（空白・／・> で区切る。「営業・企画部」の「・」では分けない） */
export function splitDepartment(department: string): string[] {
  return department
    .normalize("NFKC")
    .split(/[\s/／>＞|｜]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** 役職の高さ（小さいほど上）。決められないものは 90 */
const RANKS: [RegExp, number][] = [
  [/会長|社長|代表取締役|CEO|代表/i, 10],
  [/副社長|専務|常務|COO|CFO|CTO|CIO|CMO|CHRO/i, 20],
  [/取締役|執行役員|役員|監査役/, 25],
  [/本部長|事業部長|統括|支社長|支店長|所長|工場長|センター長|局長/, 30],
  [/副本部長|副事業部長|副支社長|副支店長/, 32],
  [/部長|ディレクター|Director|GM|ゼネラルマネージャー/i, 40],
  [/次長|副部長|室長/, 45],
  [/店長|課長|マネージャー|Manager|MGR/i, 50],
  [/副店長|課長代理|課長補佐|副課長/, 55],
  [/係長|主任|主査|リーダー|チーフ|Leader|Chief/i, 60],
];
export function rankOf(title: string): number {
  const t = title.normalize("NFKC");
  // 「副〜」「〜代理」「〜補佐」は先に見る（「副部長」を「部長」にしないため）
  for (const [re, r] of [...RANKS].sort((a, b) => (/副|代理|補佐/.test(a[0].source) ? -1 : 0) - (/副|代理|補佐/.test(b[0].source) ? -1 : 0))) {
    if (re.test(t)) return r;
  }
  return 90;
}
