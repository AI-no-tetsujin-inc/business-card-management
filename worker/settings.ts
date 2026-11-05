// 画面から変更できる設定（会社情報・Drive の親フォルダ・通知の送信元など）
export type Settings = Record<string, string>;

const DEFAULTS: Settings = {
  billing_admin_email: "", // 顧客請求書の作成担当（15日の通知先）・サブスク更新の通知先
  claim_payer_email: "", // 社内請求を受け取って支払う人（代表）。全員の提出がそろったら Google Chat でメンションする
  app_url: "", // Google Chat の通知に載せるアプリの URL
};

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return { ...DEFAULTS, ...Object.fromEntries(results.map((r) => [r.key, r.value])) };
}

export async function setSettings(db: D1Database, patch: Settings) {
  const stmts = Object.entries(patch).map(([k, v]) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)),
  );
  if (stmts.length) await db.batch(stmts);
}

/** 議事録・タスクを有効にするか */
export const minutesEnabled = (s: Settings) => s.feature_minutes === "1";
/** つながり（関係性マップ）・確認依頼・重複判定・議事録からの新規人物の登録を有効にするか（今はスコープ外） */
export const graphEnabled = (s: Settings) => s.feature_graph === "1";
