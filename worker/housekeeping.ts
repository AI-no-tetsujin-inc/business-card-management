// データの整理: ごみ箱の名刺を30日後に画像ごと完全削除、期限切れデータの掃除
import { audit } from "./people";

export const TRASH_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 365;
const DAY = 86400_000;

/** 名刺1件を、画像・履歴・メモなど関連データごと完全に削除する（元に戻せない） */
export async function purgeCard(env: Env, cardId: string) {
  const db = env.DB;
  const { results: images } = await db.prepare("SELECT full_key, display_key FROM card_images WHERE card_id = ?").bind(cardId).all<{ full_key: string; display_key: string }>();
  const { results: drafts } = await db
    .prepare("SELECT front_full_key, front_display_key, back_full_key, back_display_key FROM drafts WHERE card_id = ?")
    .bind(cardId)
    .all<Record<string, string | null>>();
  const keys = [...images.flatMap((i) => [i.full_key, i.display_key]), ...drafts.flatMap((d) => Object.values(d))].filter((k): k is string => Boolean(k));
  for (let i = 0; i < keys.length; i += 500) await env.IMAGES.delete(keys.slice(i, i + 500));
  const node = `person:${cardId}`;
  await db.batch([
    db.prepare("DELETE FROM card_images WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM card_events WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM card_notes WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM contact_points WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM interactions WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM upload_links WHERE card_id = ?").bind(cardId),
    db.prepare("DELETE FROM review_items WHERE card_id = ? OR other_card_id = ?").bind(cardId, cardId),
    db.prepare("DELETE FROM relations WHERE from_node = ? OR to_node = ?").bind(node, node),
    db.prepare("DELETE FROM drafts WHERE card_id = ?").bind(cardId),
    db.prepare("UPDATE tasks SET card_id = NULL WHERE card_id = ?").bind(cardId),
    db.prepare("UPDATE cards SET merged_into = NULL WHERE merged_into = ?").bind(cardId),
    db.prepare("DELETE FROM merge_judgements WHERE pair_key LIKE ? OR pair_key LIKE ?").bind(`${cardId}:%`, `%:${cardId}`),
    db.prepare("DELETE FROM cards WHERE id = ?").bind(cardId),
  ]);
}

/** 毎日の整理（深夜3時） */
export async function housekeeping(env: Env): Promise<string> {
  const db = env.DB;
  const now = Date.now();
  const trashBefore = new Date(now - TRASH_RETENTION_DAYS * DAY).toISOString();
  const { results: expired } = await db
    .prepare("SELECT id, person_name, company_name FROM cards WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50")
    .bind(trashBefore)
    .all<{ id: string; person_name: string; company_name: string }>();
  for (const c of expired) {
    await purgeCard(env, c.id);
    await audit(db, { userId: null, via: "cron", action: "purge", targetType: "card", detail: { name: `${c.person_name}（${c.company_name}）`, reason: `ごみ箱で${TRASH_RETENTION_DAYS}日経過` } });
  }
  // 破棄した確認待ちの記録（画像は破棄時に削除済み）
  await db.prepare("DELETE FROM drafts WHERE status = 'discarded' AND created_at < ?").bind(trashBefore).run();
  // 期限切れのログイン状態・画像リンク
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await db.prepare("DELETE FROM upload_links WHERE expires_at < ?").bind(now - DAY).run();
  // 1年より前の操作ログ・定期処理の記録（AI 利用ログは、利用額の累計を出すので消さない）
  const logBefore = new Date(now - AUDIT_RETENTION_DAYS * DAY).toISOString();
  await db.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(logBefore).run();
  await db.prepare("DELETE FROM job_runs WHERE ran_at < ?").bind(logBefore).run();
  return `ごみ箱の名刺 ${expired.length}件を完全削除し、期限切れのデータを整理しました`;
}
