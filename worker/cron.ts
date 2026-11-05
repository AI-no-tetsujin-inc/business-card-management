// 定期実行（Cron Trigger は毎時0分）。時刻はすべて日本時間。お知らせはすべて Google Chat（メールは使わない）
//   毎時（9〜19時）      顧客請求書の送付・連絡が未チェック
//   毎月15日 9時         顧客請求書の作成開始 → 顧客ごとの担当者をメンション
//   月末 21時            社内請求: 経費登録と請求書の発行のお願い → まだの人をメンション
//   1日 10・14・19時      社内請求: まだの人だけをメンションしてリマインド
//   毎時（8〜21時）      社内請求: 全員の発行と領収書の Drive 保存がそろったら、代表をメンションして連絡（1か月に1回）
//   毎日9時              サブスクの更新日の7日前 → 甲野をメンション
//   毎日3時              データの整理
//   毎時                 提出した経費の領収書で、Drive に置けていないものを置く（少しずつ）
//   毎日20時             今日の AIの鉄人（議事録のまとめ）→ 議事録スペース（議事録を有効にしたとき）
//   毎日9時              期限が近いタスク → 議事録スペース（議事録を有効にしたとき）
import { invoiceStartText, uncheckedText } from "./billing";
import { claimChatText, FIRST_PERIOD, notifyClaimsComplete, saveClaimReceiptsToDrive } from "./internal";
import { subscriptionNotices } from "./subscriptions";
import { claimJob, jstNow, sendChat, shiftMonth } from "./notify";
import { getSettings, graphEnabled, minutesEnabled } from "./settings";
import { housekeeping } from "./housekeeping";
import { syncAllCalendars } from "./calendar";
import { taskReminderText } from "./tasks";
import { scanDrive } from "./minutes";
import { minutesDigest } from "./minutes-digest";
import { qualityScan, reviewReminderText } from "./quality";
import { BUDGET_USD, totalCost } from "./ai-usage";

export const JOBS = {
  "invoice-start": "顧客請求書の作成開始（担当者をメンション）",
  "invoice-unchecked": "送付・連絡の未チェック",
  "claim-request": "社内請求: 経費登録と請求書の発行のお願い（月末21時）",
  "claim-reminder": "社内請求: まだの人へのリマインド（1日の10・14・19時）",
  "claims-complete": "社内請求: 全員そろったら代表に連絡（税理士へ）",
  "subscriptions": "サブスクの更新日（甲野をメンション）",
  "calendar-sync": "Google カレンダーに期限を反映（連携した人）",
  "receipt-drive": "提出した経費の領収書を Drive に保存（残っている分）",
  housekeeping: "データの整理",
  // 議事録（設定で有効にしたときだけ動く）
  "minutes-digest": "今日の AIの鉄人（議事録のまとめ・Google Chat）",
  "task-reminder": "タスクのリマインド（Google Chat）",
  "minutes-scan": "Drive の議事録を確認",
  // 以下はスコープ外（つながり・確認依頼を有効にしたときだけ動く）
  "quality-scan": "重複判定・データ検証",
  "review-reminder": "確認依頼のリマインド",
} as const;
export type JobName = keyof typeof JOBS;

const sent = (env: Env, what: string) => (env.GOOGLE_CHAT_WEBHOOK_URL ? `${what}に送信しました` : `Google Chat が未設定のため送信しませんでした`);

/** 定期処理の本体。force = 管理画面からの手動実行（日付条件・二重実行チェックを無視） */
export async function runJob(env: Env, job: JobName, force = false): Promise<string> {
  const now = jstNow();
  const settings = await getSettings(env.DB);
  const once = async (key: string) => force || (await claimJob(env.DB, key));
  switch (job) {
    case "invoice-start": {
      if (!force && now.day !== 15) return "15日ではないため送信しません";
      if (!(await once(`invoice-start:${now.month}`))) return "今月は送信済みです";
      const text = await invoiceStartText(env.DB, now.month);
      if (!text) return "作成待ちの請求書はありません（今月請求する契約がないか、すべて作成済みです）";
      await sendChat(env, text);
      return sent(env, "Google Chat ");
    }
    case "invoice-unchecked": {
      const start = Number(settings.chat_reminder_start_hour || 9);
      const end = Number(settings.chat_reminder_end_hour || 19);
      if (!force && (now.hour < start || now.hour > end)) return `通知の時間帯（${start}〜${end}時）の外です`;
      const text = await uncheckedText(env.DB);
      if (!text) return "未チェックの請求書はありません";
      await sendChat(env, text);
      return env.GOOGLE_CHAT_WEBHOOK_URL ? sent(env, "Google Chat ") : `Google Chat が未設定のため送信しませんでした:\n${text}`;
    }
    case "claim-request": {
      if (!force && !(now.isLastDay && now.hour === 21)) return "月末21時ではありません";
      if (now.month < FIRST_PERIOD) return "受付開始前の月です";
      if (!(await once(`claim-request:${now.month}`))) return "今月は送信済みです";
      const text = await claimChatText(env, now.month, "request");
      if (!text) return "全員発行済みです";
      await sendChat(env, text);
      return sent(env, "Google Chat ");
    }
    case "claim-reminder": {
      if (!force && !(now.day === 1 && [10, 14, 19].includes(now.hour))) return "リマインドの時刻ではありません（1日の10・14・19時）";
      if (!(await once(`claim-reminder:${now.date}:${now.hour}`))) return "この時刻は送信済みです";
      const text = await claimChatText(env, shiftMonth(now.month, -1), "remind");
      if (!text) return "全員発行済みです";
      await sendChat(env, text);
      return sent(env, "Google Chat ");
    }
    case "claims-complete":
      if (!force && (now.hour < 8 || now.hour > 21)) return "連絡の時間帯（8〜21時）の外です";
      return notifyClaimsComplete(env, shiftMonth(now.month, -1));
    case "subscriptions":
      if (!(await once(`subscriptions:${now.date}`))) return "今日は送信済みです";
      return subscriptionNotices(env);
    case "housekeeping":
      return housekeeping(env);
    case "calendar-sync":
      return syncAllCalendars(env);
    case "receipt-drive": {
      // 定期処理は画面より多めに置く（1件あたり Google への通信は2回ほど。上限 50 回に収まる件数）
      const r = await saveClaimReceiptsToDrive(env, undefined, 10);
      return r.saved ? `領収書を ${r.saved} 件 Drive に保存しました` : r.warnings[0] ?? "Drive に保存していない領収書はありません";
    }
    case "task-reminder": {
      if (!(await once(`task-reminder:${now.date}`))) return "今日は送信済みです";
      const text = await taskReminderText(env.DB);
      if (!text) return "期限が近いタスクはありません";
      await sendChat(env, text, "minutes");
      return sent(env, "Google Chat ");
    }
    case "minutes-digest": {
      if (!force && now.hour !== 20) return "20時ではありません";
      if (!(await once(`minutes-digest:${now.date}`))) return "今日は送信済みです";
      return minutesDigest(env, now.date);
    }
    case "minutes-scan":
      return scanDrive(env);
    case "quality-scan":
      if ((await totalCost(env.DB)) >= BUDGET_USD) return `AI の利用額の累計が上限（$${BUDGET_USD}）に達したため止めています`;
      return qualityScan(env);
    case "review-reminder": {
      if (!(await once(`review-reminder:${now.date}`))) return "今日は送信済みです";
      const text = await reviewReminderText(env.DB);
      if (!text) return "確認依頼はありません";
      await sendChat(env, text);
      return sent(env, "Google Chat ");
    }
  }
}

export async function scheduled(controller: ScheduledController, env: Env, purgeOAuth: () => Promise<unknown>) {
  const now = jstNow(controller.scheduledTime);
  const settings = await getSettings(env.DB);
  // カレンダーは内容が変わった予定だけ送るので、毎時動かしても Google への通信はほとんど発生しない
  // 領収書を Drive に置いてから、そろったかを見る
  const jobs: JobName[] = ["invoice-unchecked", "calendar-sync", "receipt-drive", "claims-complete"];
  if (now.hour === 9) jobs.push("invoice-start", "subscriptions");
  if (now.isLastDay && now.hour === 21) jobs.push("claim-request");
  if (now.day === 1 && [10, 14, 19].includes(now.hour)) jobs.push("claim-reminder");
  if (now.hour === 3) jobs.push("housekeeping");
  const weekday = new Date(controller.scheduledTime + 9 * 3600_000).getUTCDay();
  const workHours = now.hour >= 8 && now.hour <= 20 && weekday >= 1 && weekday <= 5;
  if (minutesEnabled(settings)) {
    if (now.hour === 9) jobs.push("task-reminder");
    if (now.hour === 20) jobs.push("minutes-digest");
    if (workHours) jobs.push("minutes-scan");
  }
  if (graphEnabled(settings)) {
    if (now.hour === 9) jobs.push("review-reminder");
    if (workHours) jobs.push("quality-scan");
  }
  const results: Record<string, string> = {};
  for (const job of jobs) results[job] = await runJob(env, job).catch((e) => `失敗: ${e instanceof Error ? e.message : e}`);
  if (now.hour === 3) results.oauth = await purgeOAuth().then(() => "期限切れの連携情報を整理しました", (e) => `失敗: ${e}`);
  console.log("cron", now.date, now.hour, results);
}
