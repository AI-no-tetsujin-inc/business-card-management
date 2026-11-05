#!/usr/bin/env node
// Cloudflare の準備をまとめて行う（何度実行しても大丈夫）
//   1. D1 / KV / R2 を作成（既にあれば再利用）
//   2. wrangler.jsonc の ID を書き換え
//   3. 本番 DB にテーブルを作成
//   4. 未設定のシークレットを一覧表示
// 使い方: npx wrangler login のあと `npm run setup:cloudflare`
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

if (!process.argv.includes('--confirm-remote-setup')) {
  console.error('この操作はCloudflare上の同名リソースを再利用し、リモートDBに適用します。対象アカウント・DBを確認後、--confirm-remote-setupを指定してください。');
  process.exit(1);
}
const run = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], ...opts });
const step = (msg) => console.log(`\n▶ ${msg}`);

const DB_NAME = "meishi";
const KV_TITLE = "meishi-OAUTH_KV";
const BUCKET = "meishi-images";
const SECRETS = [
  ["ANTHROPIC_API_KEY", "Claude API キー"],
  ["GOOGLE_CLIENT_ID", "Google ログイン（OAuth クライアント ID）"],
  ["GOOGLE_CLIENT_SECRET", "Google ログイン（クライアントシークレット）"],
  ["GOOGLE_CHAT_WEBHOOK_URL", "Google Chat の通知先 Webhook URL"],
  // Drive への書類保存・Gmail 送信は、公開後に管理画面の「Google と連携」で許可する（サービスアカウントの鍵は不要）
  // DRIVE_FOLDER_ID（議事録の取り込み元）はスコープ外のため不要。書類の保存先は管理画面で設定する
];

try {
  step("ログイン状態を確認");
  console.log(run("npx wrangler whoami").split("\n").filter((l) => /logged in|Account/i.test(l)).join("\n") || "OK");
} catch {
  console.error("Cloudflare にログインしていません。先に `npx wrangler login` を実行してください。");
  process.exit(1);
}

step(`D1 データベース「${DB_NAME}」`);
let db = JSON.parse(run("npx wrangler d1 list --json")).find((d) => d.name === DB_NAME);
if (!db) {
  run(`npx wrangler d1 create ${DB_NAME}`);
  db = JSON.parse(run("npx wrangler d1 list --json")).find((d) => d.name === DB_NAME);
  console.log("作成しました");
} else console.log("既にあります");

step(`KV「${KV_TITLE}」（AI 連携の許可・トークン）`);
const kvList = () => JSON.parse(run("npx wrangler kv namespace list"));
let kv = kvList().find((k) => k.title === KV_TITLE || k.title === "OAUTH_KV");
if (!kv) {
  run(`npx wrangler kv namespace create OAUTH_KV`);
  kv = kvList().find((k) => k.title === KV_TITLE || k.title === "OAUTH_KV");
  console.log("作成しました");
} else console.log("既にあります");

step(`R2 バケット「${BUCKET}」（名刺画像・議事録本文）`);
if (!run("npx wrangler r2 bucket list").includes(BUCKET)) {
  try {
    run(`npx wrangler r2 bucket create ${BUCKET}`);
    console.log("作成しました");
  } catch (e) {
    console.error("R2 を作成できませんでした。ダッシュボードで R2 を有効にしてから再実行してください。\n" + e.stderr);
    process.exit(1);
  }
} else console.log("既にあります");

step("wrangler.jsonc に ID を書き込み");
const path = new URL("../wrangler.jsonc", import.meta.url);
let conf = readFileSync(path, "utf8");
conf = conf.replace(/("database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`);
conf = conf.replace(/("binding":\s*"OAUTH_KV",\s*\n\s*"id":\s*")[^"]*(")/, `$1${kv.id}$2`);
writeFileSync(path, conf);
console.log(`database_id = ${db.uuid}\nOAUTH_KV id = ${kv.id}`);

step("本番データベースにテーブルを作成");
console.log(run(`npx wrangler d1 migrations apply ${DB_NAME} --remote`, { input: "y\n" }).split("\n").slice(-8).join("\n"));

step("シークレット（未設定のものは設定してください）");
let existing = [];
try {
  existing = JSON.parse(run("npx wrangler secret list")).map((s) => s.name);
} catch {
  // まだ一度もデプロイしていないと一覧が取れない
}
for (const [name, label] of SECRETS) {
  console.log(`${existing.includes(name) ? "  ✓" : "  ✗"} ${name}  … ${label}${existing.includes(name) ? "" : `\n      npx wrangler secret put ${name}`}`);
}
console.log("\n準備ができたら `npm run deploy` で公開します。");
