#!/usr/bin/env node
// MCP の通し確認（ローカル開発サーバーに対して、AI クライアントと同じ手順で接続する）
// 使い方: npm run dev を起動した状態で `npm run test:mcp`（.dev.vars の DEV_LOGIN=1 が必要）
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
if (!['localhost','127.0.0.1'].includes(new URL(BASE).hostname)) throw new Error('MCP smoke test requires a local disposable environment');
const EMAIL = process.env.TEST_EMAIL ?? "smoke-test@ainotetsujin.com";
const REDIRECT = "http://localhost:9999/callback";
const b64url = (b) => Buffer.from(b).toString("base64url");
const ok = (msg) => console.log(`  ✓ ${msg}`);

async function connect() {
  const r0 = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r0.status, 401);
  assert.match(r0.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  ok("トークンなしは 401 と接続先の案内を返す");

  const reg = await (
    await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "SmokeTest", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  ).json();
  assert.ok(reg.client_id);
  ok("動的クライアント登録");

  const login = await fetch(`${BASE}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, name: "スモークテスト" }),
  });
  assert.equal(login.status, 200, "開発用ログインに失敗（DEV_LOGIN=1 で起動していますか？）");
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await fetch(`${BASE}/api/register`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ name: "スモークテスト" }) });

  const verifier = b64url(crypto.randomBytes(32));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    state: "s",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const page = await fetch(`${BASE}/authorize?${q}`, { headers: { cookie } });
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "許可画面が表示されない");
  const consent = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const allow = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { cookie: `${cookie}; ${consent}`, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ csrf, q: `?${q}`, action: "allow" }),
    redirect: "manual",
  });
  const code = new URL(allow.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  ok("許可画面 → 認可コード");

  const tok = await (
    await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
    })
  ).json();
  assert.ok(tok.access_token);
  ok("アクセストークン取得（リフレッシュトークンあり: " + Boolean(tok.refresh_token) + "）");
  // 取り込み画面の API も同じ人のログインで呼ぶ（AI 連携と結果を比べるため）
  return { token: tok.access_token, cookie };
}

async function main() {
  console.log(`MCP スモークテスト: ${BASE}`);
  const { token, cookie } = await connect();
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await res.text();
    const json = body.startsWith("{") ? JSON.parse(body) : JSON.parse(body.split("\n").find((l) => l.startsWith("data:")).slice(5));
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try {
      return { ...r, data: JSON.parse(text), text };
    } catch {
      return { ...r, data: null, text };
    }
  };

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
  for (const t of ["search_people", "get_person", "register_person", "update_person", "add_note", "get_company", "list_customer_invoices", "check_customer_invoice", "list_internal_claims", "list_subscriptions", "prepare_customer_invoices", "update_customer_invoice", "create_customer_invoices", "submit_internal_claim", "add_person_insights", "export_people_profiles"]) {
    assert.ok(tools.includes(t), `ツール ${t} がない`);
  }
  // 議事録・タスク、つながり・確認依頼は、それぞれ設定で有効にしたときだけ出る
  const minutesOn = tools.includes("list_tasks");
  const graphOn = tools.includes("find_connections");
  ok(`ツール ${tools.length}個`);

  const stamp = Date.now();
  const email = `smoke${stamp}@smoke-test.example`;
  const created = await call("register_person", { person_name: `検証 ${stamp}`, company_name: "スモークテスト株式会社", email, phone: `03-${String(stamp).slice(-8, -4)}-${String(stamp).slice(-4)}` });
  assert.equal(created.data.status, "created");
  const pid = created.data.person_id;
  assert.match(created.data.card_image_upload_url, /\/u\//);
  ok("人物を登録（画像用リンクつき）");

  const merged = await call("register_person", { person_name: `検証 ${stamp}`, company_name: "スモークテスト", email: email.toUpperCase(), title: "部長" });
  assert.equal(merged.data.status, "merged");
  assert.equal(merged.data.person_id, pid);
  assert.ok(merged.data.message.includes("役職"));
  assert.ok(!merged.data.message.includes("メール"), "表記の違いだけのメールを更新してしまった");
  ok("同じメールの人は自動で統合し、表記の違いは上書きしない");

  const search = await call("search_people", { query: `検証 ${stamp}` });
  assert.equal(search.data.count, 1);
  ok("検索");

  await call("add_note", { person_id: pid, body: "スモークテストのメモ" });
  const detail = await call("get_person", { person_id: pid });
  assert.equal(detail.data.notes[0].body, "スモークテストのメモ");
  assert.equal(detail.data.notes[0].via, "ai:SmokeTest");
  ok("メモ追加（AI 経由として記録）");

  // 人物像: 取り込み画面（/api/insights/import）と AI 連携（add_person_insights）に同じ JSON を入れて、同じ結果になるか
  const reg = async (person_name, company_name, mail) => (await call("register_person", { person_name, company_name, email: mail })).data.person_id;
  const twinA = await reg(`同名 ${stamp}`, `甲商事${stamp}`, `twin-a${stamp}@smoke-test.example`);
  await call("register_person", { person_name: `同名 ${stamp}`, company_name: `乙物産${stamp}`, email: `twin-b${stamp}@smoke-test.example`, force_new: true });
  const staff = await reg(`社員 ${stamp}`, "株式会社AIの鉄人", `staff${stamp}@ainotetsujin.com`);
  assert.ok(twinA && staff);
  const insightJson = {
    source: `スモークテスト ${stamp}`,
    date: "2026-10-27",
    items: [
      { card_id: pid, name: `検証 ${stamp}`, company: "スモークテスト株式会社", category: "status", text: "来期の予算待ち", evidence: "予算次第", confidence: 0.9 },
      { card_id: "", name: `不明 ${stamp}`, company: "どこか", category: "interest", text: "研修に関心", evidence: "研修は？", confidence: 0.9 },
      { card_id: pid, name: `検証 ${stamp}`, company: "スモークテスト株式会社", category: "attitude", text: "やや慎重", evidence: "持ち帰ります", confidence: 0.5 },
      { card_id: "", name: `同名 ${stamp}`, company: "", category: "personality", text: "結論から話す", evidence: "で、結局？", confidence: 0.9 },
      { card_id: staff, name: `社員 ${stamp}`, company: "株式会社AIの鉄人", category: "status", text: "社内の人", evidence: "", confidence: 0.95 },
      { card_id: pid, name: `検証 ${stamp}`, company: "スモークテスト株式会社", category: "mood", text: "分類が違う", evidence: "", confidence: 0.9 },
    ],
  };
  const viaScreen = async () => {
    const res = await fetch(`${BASE}/api/insights/import`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify(insightJson) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const viaMcp = async () => (await call("add_person_insights", insightJson)).data;
  const fresh = () =>
    execSync(`npx wrangler d1 execute meishi --local --command "DELETE FROM person_insights WHERE source_title = 'スモークテスト ${stamp}'"`, { stdio: "ignore" });

  const screen1 = await viaScreen();
  assert.deepEqual(screen1.applied.map((a) => a.category), ["status"]);
  assert.deepEqual(screen1.pending.map((p) => p.reason), ["人が見つからない", "確信度が低い", "候補が複数", "社内メンバー"]);
  assert.deepEqual(screen1.errors.map((e) => e.index), [5]);
  fresh(); // 同じ状態から AI 連携で入れる
  const mcp1 = await viaMcp();
  assert.deepEqual(mcp1, screen1);
  ok("人物像: 取り込み画面と AI 連携に同じ JSON → 同じ結果（自動反映・確認待ちの理由・不正な category のエラー）");

  const screen2 = await viaScreen();
  const mcp2 = await viaMcp();
  assert.deepEqual(screen2, mcp2);
  assert.equal(mcp2.applied.length + mcp2.pending.length, 0);
  assert.equal(mcp2.skipped.length, 5);
  assert.ok(mcp2.skipped.every((x) => x.reason === "重複"));
  ok("人物像: 2回目は画面でも AI 連携でも、同じものを重複として飛ばす");

  const withProfile = await call("get_person", { person_id: pid });
  assert.ok(withProfile.data.profile["今の状況"][0].text.includes("来期の予算待ち"));
  const md = await call("export_people_profiles", { company: "スモークテスト株式会社" });
  const all = await call("export_people_profiles", {});
  assert.ok(md.text.includes(`[id: ${pid}]`) && md.text.includes("来期の予算待ち"));
  assert.ok(all.text.includes("範囲: 全員") && !md.text.includes("範囲: 全員"));
  ok("人物像のまとめての出力（会社で絞る・全員）と、get_person の人物像");

  const company = await call("get_company", { name: "スモークテスト" });
  assert.ok(company.data.people.some((p) => p.person_id === pid));
  ok("会社の詳細");

  if (minutesOn) {
    const task = await call("create_task", { title: `スモークテストのタスク ${stamp}`, due_on: "2030-01-01" });
    assert.equal(task.data.status, "created");
    const tasks = await call("list_tasks", { assignee: "me" });
    assert.ok(tasks.data.some((t) => t.task_id === task.data.task_id));
    await call("complete_task", { task_id: task.data.task_id });
    ok("タスクの登録・一覧・完了");

    const minutes = await call("list_minutes", { limit: 5 });
    assert.ok(Array.isArray(minutes.data), "議事録の一覧が取れない");
    if (minutes.data.length) {
      const m = await call("get_minutes", { minutes_id: minutes.data[0].minutes_id, include_transcript: true, transcript_max_chars: 1000 });
      assert.equal(m.data.minutes_id, minutes.data[0].minutes_id);
      assert.ok(m.data.transcript && m.data.transcript.text.length <= 1000);
      ok(`議事録の一覧・読み取り（${minutes.data.length}件、全文 ${m.data.transcript.total_chars}字）`);
    } else {
      ok("議事録の一覧（まだ0件）");
    }
  } else {
    assert.ok(!tools.includes("list_tasks") && !tools.includes("list_minutes"), "無効な議事録・タスクのツールが出ている");
    ok("議事録・タスクのツールは出ていない（設定でオフ）");
  }
  if (graphOn) {
    const conn = await call("find_connections", { name: "スモークテスト" });
    assert.ok(conn.data.connections.length > 0);
    ok("つながりの問い合わせ");
  } else {
    assert.ok(!tools.includes("find_connections") && !tools.includes("list_review_items"), "スコープ外のツールが出ている");
    ok("スコープ外のツール（つながり・確認依頼）は出ていない");
  }

  const invoices = await call("list_customer_invoices", { period: "2026-10" });
  assert.ok(Array.isArray(invoices.data.customers), "顧客請求の一覧が取れない");
  await call("list_internal_claims", {});
  await call("list_subscriptions", {});
  ok("顧客請求・社内請求・サブスクの一覧（実契約の初期データに依存しない）");
  // Contract/claim generation is covered by unit fixtures; no production seed assumptions here.

  console.log("\nすべて成功しました");
}

main().catch((e) => {
  console.error(`\n✗ 失敗: ${e.message}`);
  process.exit(1);
});
