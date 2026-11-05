// 人物像（ステークホルダー情報）の分類。画面・サーバー・スキル・AI 連携で同じ分類を使う
export const INSIGHT_CATEGORIES = [
  { key: "role", label: "立場・役割", hint: "決裁者・推進者・窓口・影響者・利用者 など、社内での立場と権限" },
  { key: "attitude", label: "温度感", hint: "当社や提案に対して好意的・中立・慎重・反対 など" },
  { key: "status", label: "今の状況", hint: "案件の進み具合・社内の事情・最近の動き・異動など" },
  { key: "personality", label: "性格・人柄", hint: "話し方・考え方・意思決定のしかた" },
  { key: "interest", label: "関心・課題", hint: "困っていること・関心のあるテーマ・求めていること" },
  { key: "caution", label: "気をつけること", hint: "好み・NG・配慮が必要なこと" },
  { key: "relation", label: "人間関係", hint: "誰の上司・誰と近い・誰の紹介 など" },
  { key: "other", label: "その他", hint: "上のどれにも当てはまらない情報" },
] as const;

export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number]["key"];
export const INSIGHT_LABEL = Object.fromEntries(INSIGHT_CATEGORIES.map((c) => [c.key, c.label])) as Record<InsightCategory, string>;
export const isInsightCategory = (v: unknown): v is InsightCategory => INSIGHT_CATEGORIES.some((c) => c.key === v);
/** これ以上の確信度で、人がはっきり決まっていれば自動で反映する */
export const AUTO_APPLY_CONFIDENCE = 0.7;
