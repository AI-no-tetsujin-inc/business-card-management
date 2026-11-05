> 共有用ソース: 実運用の初期データは除去済みです。本番で適用済みの0005〜0007と内容が異なるため、既存DBへ再適用しないでください。通知先・URL・会社・契約は環境ごとに設定が必要です。

# 名刺管理（AIネイティブ版）

名刺を起点に、連絡・議事録・顧客請求・社内請求/経費精算・サブスク管理を1つのアプリに集める社内ツール。
アプリ本体は「データの置き場所＋MCP の窓口」に徹し、人が頼む操作は各自の ChatGPT / Claude から、裏で動く処理だけアプリが Claude API で行う。

- 画面・API・MCP・定期処理: Cloudflare Workers（Hono ＋ React）
- データ: D1 ／ 名刺画像・書類の控え・領収書: R2（非公開）／ MCP 連携の許可: KV ／ PDF 化: Browser Run
- 書類の保存: Google Drive（共有ドライブ）／ お知らせ: Gmail（設定された担当者のアカウントから送信）・Google Chat
- ログイン: Google Workspace（@ainotetsujin.com のみ・90日間ログインしたまま）
- AI 連携: リモート MCP（OAuth 2.1・動的クライアント登録と CIMD 両対応）

## 機能

| 機能 | 画面 | ChatGPT / Claude（MCP） | 裏の仕組み |
|---|---|---|---|
| 名刺登録 | 撮影 → アプリ内 OCR → 確認 | `register_person`（統合ルール込み）＋ 画像用リンク | メール・電話一致で自動統合、氏名だけ一致は確認 |
| 人物検索・連絡 | 一覧・検索・会社ごと | `search_people` `get_person` `add_note` `update_person` | Gmail は各 AI の連携で下書き |
| 顧客請求 | 顧客請求（月の状況・見積書・契約・顧客・過去の書類） | `prepare_customer_invoices` `update_customer_invoice` `create_customer_invoices` `list_customer_invoices` `check_customer_invoice` | 見積書→契約→請求書（PDF を Drive「顧客請求書/YYYY年M月分/顧客名」へ）→送付→連絡。毎月15日に下書きを作って担当者へメール、未チェックは 9〜19時に毎時 Google Chat |
| 社内請求・経費 | 社内請求・経費 | `submit_internal_claim` `list_internal_claims` | 月末締め・翌月1日提出・翌月5日払い。稼働分と立替経費（明細と領収書を1円単位で照合）を PDF にして Drive「社内請求・経費/YYYY年M月分/氏名/請求書|立替領収書」へ。期限の前日・当日・超過をメール、領収書原本は月末10時・翌日10時にメール、翌日12〜18時の2時間おきにアラート |
| 契約・サブスク | 契約・サブスク | `list_subscriptions` | 個人名義・個人立替を強調。更新日の7日前に設定された担当者へメール |
| 議事録 | 議事録（一覧・詳細・目的別の抜き出し・全文）、プロフィールで Voiss の連携キー | `list_minutes` `get_minutes`（目的に合わせた取り出しは全文を読んで AI が行う） | Mac の Voiss で録音を止めると文字起こし・音声が届く → Claude で要点・決まったこと・ネクストアクションを抜き出し → Drive「議事録/YYYY年M月/YYYYMMDD_タイトル」に全文と音声 → Google Chat の議事録スペースに投稿。毎日20時に「今日の AIの鉄人」 |
| 会社の詳細 | 会社 → 会社名 | `get_company` | 人物・契約・最近の請求書を1か所に |
| データの削除 | ごみ箱 | （AI からは削除不可） | 30日後に画像ごと自動で完全削除。管理者は即時削除も可 |
| ガバナンス | 管理（メンバー・設定・操作ログ） | すべての操作をログに記録 | 権限 3段階、無効化で画面も AI 連携も即遮断 |

全員が全員の分（顧客請求・社内請求・経費）を見られる。送付済み・連絡済みのチェックは顧客の担当者と管理者だけ。
権限: 管理者（CSV 出力・契約の登録変更・過去書類の取り込み・設定・メンバー管理）／メンバー（閲覧・登録・編集）／閲覧のみ。
社員の初期登録データは含みません。最初の組織ログインを管理者が行い、必要なメンバー・運用設定を登録してください。

議事録・タスクは管理画面の「議事録・タスクを使う」でオンにする。関係性マップ・確認依頼（議事録からの新しい人物の登録・案件・重複判定を含む）はスコープ外で、「つながり・確認依頼を使う」をオンにしたときだけ画面・AI ツール・自動処理が出る。

## ChatGPT / Claude に渡す「段取り」

- Claude: `ai-instructions/claude-skill/meishi-skill.zip` を組織の Skills にアップロード（中身は `meishi/SKILL.md`）
- ChatGPT: `ai-instructions/chatgpt-project-instructions.md` の枠内をプロジェクトの指示に貼り付け

どちらも同じ段取り（名刺登録・メール連絡・打ち合わせ準備・顧客請求・社内請求・サブスク）。片方を変えたらもう片方も合わせる。

## iPhone のホーム画面に置く

Safari で開き「共有 → ホーム画面に追加」。アプリのように全画面で開ける。

## テスト

```bash
npm test            # 正規化・統合ルール・形式チェック・議事録の分割/まとめ・議事録の文面・Voiss からの受け取り・請求月・書類ファイル名の読み取り
npm run test:mcp    # npm run dev 起動中に、AI クライアントと同じ手順で MCP を通しで確認
```

## ローカルで動かす

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

- `DEV_LOGIN=1` で localhost だけ「開発用ログイン」が使える
- `ANTHROPIC_API_KEY` が空だと、名刺の OCR は手入力、議事録はローカル専用の簡易抽出（「参加:」「決定:」「タスク:」で始まる行だけ）になる
- MCP の確認: `claude mcp add --transport http meishi http://localhost:5173/mcp`、または `npx @modelcontextprotocol/inspector`

## 本番公開の手順

### 1. Cloudflare

```bash
npx wrangler login
npm run setup:cloudflare   # D1・KV・R2 の作成、wrangler.jsonc の ID 書き換え、本番 DB の作成、シークレットの確認までまとめて行う
```

無料プランで足りる（Browser Run の PDF 化は無料枠 1 日 10 分。請求書 1 枚 数秒）。R2 はダッシュボードで一度有効化が必要（無料枠内なら請求なし）。議事録の処理（Workflows）は段ごとに分けて無料プランの上限（1段の CPU 10ms・外部への通信50回）に収めている。本番で CPU の上限を超えて止まるようなら、Workers の有料プラン（月5ドル）にする。

### 2. Google（Google Cloud Console）

1. **API**: 「Google Drive API」と「Gmail API」を有効化（課金の設定は不要）
2. **ログイン**: Google Auth Platform（OAuth 同意画面）で対象を「内部」にし、OAuth クライアント（ウェブ アプリケーション）を作る。承認済みのリダイレクト URI に `https://<公開した URL>/auth/callback`
3. **Google Chat**: 通知用スペースで「Webhook を追加」し URL を控える

書類の Drive 保存とお知らせメールは、公開後に管理画面の「**Google と連携**」を設定された担当者が一度押して許可するだけ（設定された担当者の権限で共有ドライブに保存し、設定された担当者のアドレスから送る）。サービスアカウントの鍵・ドメイン全体の委任・組織ポリシーの変更は不要。
連携が切れた場合（アカウント停止・パスワード変更など）は、管理画面に「要再連携」と出て、Google Chat にも知らせる。「連携し直す」を押せば戻る。

### 3. シークレット

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# 組織全体用のキー（Console で「スコープ: 組織」）のときだけ: ワークスペースの ID（wrkspc_…）
npx wrangler secret put ANTHROPIC_WORKSPACE_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
# 議事録用の Google Chat スペースの Webhook（未設定なら上のスペースに送る）
npx wrangler secret put GOOGLE_CHAT_MINUTES_WEBHOOK_URL
```

本番では `DEV_LOGIN` を設定しない。Drive の保存先・送信元・会社情報・振込先は管理画面の「会社情報・保存先・通知」で変えられる。

### 4. デプロイと独自ドメイン

```bash
npm run deploy
```

まずは `https://meishi.<アカウントのサブドメイン>.workers.dev` で使い始める（DNS の変更なし）。

独自ドメインにするときは、ainotetsujin.com の DNS（現在は Squarespace）を Cloudflare に移し、`wrangler.jsonc` の `routes` のコメントを外して再デプロイ。移す前に Google Workspace のメール用レコード（MX・SPF・DKIM・google-site-verification）が Cloudflare 側に取り込まれているか必ず確認する（漏れるとメールが止まる）。Google のログイン設定（リダイレクト URI）と ChatGPT / Claude の接続先 URL も新しいドメインに追加する。

### 5. ChatGPT / Claude に接続

| どこで | 誰が | やること |
|---|---|---|
| Claude（Team / Enterprise） | 組織のオーナー | 組織設定 → コネクタ に `https://meishi.ainotetsujin.com/mcp` を追加 |
| ChatGPT（Business / Enterprise） | ワークスペース管理者 | カスタム MCP（自社アプリ）を有効にして同じ URL を追加 |
| 両方 | 各メンバー | 「名刺管理」を接続 → 社内 Google で許可。Gmail・Google カレンダーの連携も接続しておく |

連携はアプリのプロフィール画面からいつでも解除できる。

## 定期処理（Cron: 毎時0分）

| 時刻（日本時間） | 処理 | 送り先 |
|---|---|---|
| 9〜19時の毎時 | 顧客請求書の送付・連絡が未チェック | Google Chat |
| 毎月15日 9時 | 顧客請求書の下書きを作り、作成開始のお知らせ | 顧客ごとに設定された担当者＋請求管理者に一覧（メール） |
| 月末 9時 / 1日 9時 | 社内請求・経費の提出期限（前日・当日） | 未提出の人（メール） |
| 2日以降 毎日9時 | 社内請求の未提出 | 該当者（メール） |
| 月末 10時、1日 10時 | 領収書原本の未提出 | 該当者（メール） |
| 1日 12・14・16・18時 | 領収書原本の未提出アラート | 該当者（メール） |
| 毎日 9時 | サブスクの更新日の7日前 | 設定された担当者（メール） |
| 毎日 9時 | 期限が近いタスク（2日以内・期限切れ）※議事録がオンのとき | Google Chat（議事録スペース） |
| 毎日 20時 | 今日の AIの鉄人（その日の会議・ネクストアクション・期限が近いタスク。会議がない日は送らない）※議事録がオンのとき | Google Chat（議事録スペース） |
| 毎日 3時 | ごみ箱で30日経った名刺を完全削除、期限切れのログイン・連携情報・1年より前のログを整理 | — |

管理画面から手動でも実行できる（日付の条件を無視して今すぐ送る）。議事録まわりの自動処理は、設定でオンにしたときだけ動く。

## 構成

```
worker/
  index.ts       入口（OAuth プロバイダーで包む・Cron・Workflow の書き出し）
  auth.ts        Google ログイン / 開発用ログイン     session.ts  ログイン状態
  oauth.ts       AI アプリ連携の許可画面              mcp.ts      MCP ツール
  people.ts      人物の登録・統合ルール・検索・操作ログ  api.ts      画面用 API
  ocr.ts         名刺の読み取り（Opus）               extract.ts  議事録の抽出（Sonnet）
  minutes.ts     議事録の取り込み（Workflows: 抽出→保存→Drive→通知→音声） google.ts  Drive・Gmail（google-link.ts の連携）
  minutes-upload.ts Voiss からの受け取り（/upload-api/minutes） device-token.ts Voiss の連携キー
  minutes-views.ts 目的別の抜き出し                    minutes-digest.ts 毎日20時のまとめ
  minutes-text.ts  議事録の文面（Drive・Chat・まとめ）
  quality.ts     B 重複判定・C 検証（Haiku）・確認依頼   graph.ts    関係性マップ
  billing.ts     顧客請求（顧客・見積書・契約・請求書）  internal.ts 社内請求・経費・領収書
  subscriptions.ts 契約・サブスク                     settings.ts 設定（会社情報・保存先など）
  templates.ts   請求書・見積書の HTML                 documents.ts / pdf.ts  PDF 化と R2・Drive への保存
  tasks.ts       タスク（スコープ外）                  cron.ts     定期処理
  notify.ts      Google Chat・メール
  ai-usage.ts    AI 利用ログと予算                    upload-link.ts 画像の使い捨てリンク
  company.ts     会社の詳細                           housekeeping.ts 完全削除・期限切れデータの整理
shared/          画面とサーバー共通（項目定義・形式チェック・正規化）
src/             画面（React）
migrations/      D1 のテーブル定義
ai-instructions/ ChatGPT / Claude に渡す段取り（Skill・プロジェクト指示）
scripts/         Cloudflare のセットアップ、MCP の通し確認
tests/           自動テスト
public/          ホーム画面用のアイコン・マニフェスト
```

## 一時アップロードリンクの再試行

画像の確定処理はリンクを原子的に取得し、同時リクエストでも1回だけ実行します。確定後の保存処理が失敗した場合もリンクを再利用可能には戻しません。新しいリンクを発行して再試行してください。

2026-11-05 セキュリティ修正案: この変更の回帰テストは追加済みですが、指定監査スキルの隔離実行条件を満たす環境での実行は未完了です。draft PRの検証が終わるまで本番反映しないでください。
