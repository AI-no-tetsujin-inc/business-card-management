// ChatGPT / Claude から使う MCP サーバー（/mcp）。認証は workers-oauth-provider が済ませ、ctx.props に利用者が入る。
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { FIELD_LABEL, MATCH_LABEL, companyKey } from "../shared/fields";
import { addNote, audit, getCardDetail, listCards, registerPerson, updatePerson, type FieldChange } from "./people";
import { createUploadLink } from "./upload-link";
import { board, checkInvoice, issueInvoice, prepareInvoices, updateInvoice, yen } from "./billing";
import { FIRST_PERIOD, previewClaim, selfOrAdmin, submitClaim } from "./internal";
import { getSettings, graphEnabled, minutesEnabled } from "./settings";
import { driveLinkOf, loadMinutes, minutesTranscript, type DocRow } from "./minutes";
import { meetingDateOf, whenLabel } from "./minutes-text";
import { createTaskStatement, listTasks, resolveAssignee, setTaskDone } from "./tasks";
import { listReviewItems, resolveReviewItem } from "./quality";
import { buildGraph, findNode } from "./graph";
import { getCompany } from "./company";
import { cardInsights, countsOf, exportMarkdown, importInsights, MAX_AI_ITEMS } from "./insights";
import { INSIGHT_LABEL } from "../shared/insights";

export interface McpProps {
  userId: string;
  clientName?: string;
}

interface McpUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
}

const SEARCH_LIMIT = 20;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ ...text(message), isError: true });

const NOTATION_RULES = `表記ルール:
- 会社名は名刺のとおり正式名称で書く（「株式会社」「㈱」を省略・変換しない）
- 氏名は姓と名の間に半角スペース、ふりがなはひらがな
- 電話番号はハイフン付き（例: 03-1234-5678）、郵便番号は 123-4567
- 名刺に書かれていない項目は空のまま送る（推測で埋めない）`;

const personFields = {
  person_name: z.string().describe("氏名（例: 丙野 太郎）"),
  person_name_kana: z.string().optional().describe("ふりがな（ひらがな）"),
  person_name_en: z.string().optional().describe("氏名（英字）"),
  company_name: z.string().optional().describe("会社名（正式名称）"),
  department: z.string().optional().describe("部署"),
  title: z.string().optional().describe("役職"),
  email: z.string().optional().describe("メールアドレス"),
  phone: z.string().optional().describe("電話（直通があれば直通）"),
  mobile: z.string().optional().describe("携帯電話"),
  fax: z.string().optional().describe("FAX"),
  postal_code: z.string().optional().describe("郵便番号"),
  address: z.string().optional().describe("住所"),
  url: z.string().optional().describe("Web サイト"),
  other: z.string().optional().describe("その他（SNS・資格・別の電話番号など）"),
};

function summarize(c: Record<string, unknown>) {
  return {
    person_id: c.id,
    name: c.person_name,
    kana: c.person_name_kana || undefined,
    company: c.company_name,
    department: c.department || undefined,
    title: c.title || undefined,
    email: c.email || undefined,
    phone: c.phone || undefined,
    mobile: c.mobile || undefined,
    last_exchanged_on: c.exchanged_on || undefined,
    registered_by: c.created_by_name,
    times_exchanged: c.exchange_count,
    tags: JSON.parse(String(c.tags || "[]")),
  };
}

const changeLines = (changes: FieldChange[]) => changes.map((ch) => `- ${ch.label}: 「${ch.before || "（空）"}」→「${ch.after || "（空）"}」`);

function createServer(env: Env, user: McpUser, via: string, origin: string, features: { minutes: boolean; graph: boolean }) {
  const server = new McpServer({ name: "meishi", version: "1.0.0" });
  const canWrite = user.role !== "viewer";
  const db = env.DB;

  server.registerTool(
    "search_people",
    {
      title: "人物（名刺）を検索",
      description:
        "社内の名刺データベースから人物を検索します。氏名・ふりがな・会社名・部署・メール・電話・メモの部分一致。メールを送る前の宛先確認にも使います。同じ名前の人が複数いたら、どの人か利用者に確認してください。",
      inputSchema: z.object({
        query: z.string().describe("検索語（例: 丙野 サンプル商事）。空白区切りで AND 検索"),
        limit: z.number().int().min(1).max(SEARCH_LIMIT).optional().describe(`件数（最大 ${SEARCH_LIMIT}）`),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const rows = await listCards(db, { q: query, sort: "recent", limit: limit ?? 10 });
      await audit(db, { userId: user.id, via, action: "search", detail: { q: query, hits: rows.length } });
      if (!rows.length) return text(`「${query}」に一致する人物は見つかりませんでした。`);
      return text({ count: rows.length, people: rows.map(summarize) });
    },
  );

  server.registerTool(
    "export_people_profiles",
    {
      title: "人物像をまとめて出力",
      description: "アプリの「人物情報 → 1. まとめて出力」と同じ Markdown を返します。会社ごと・人ごとに、人物像（立場・温度感・今の状況・性格・関心・気をつけること・人間関係）・最近のやり取り（議事録）・メモをまとめ、各人の見出しに [id: …]（名刺の ID）が付きます。add_person_insights の card_id にはこの ID を使ってください。company を渡すとその会社の人だけに絞ります。",
      inputSchema: z.object({ company: z.string().optional().describe("会社名。渡すとその会社の人だけ（省略・空文字なら全員）") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ company }) => {
      const md = await exportMarkdown(db, { companyKey: company ? companyKey(company) : undefined });
      await audit(db, { userId: user.id, via, action: "insight_export", detail: { company } });
      return text(md);
    },
  );

  server.registerTool(
    "get_person",
    {
      title: "人物の詳細",
      description: "person_id を指定して、名刺の全項目・人物像（立場・温度感・今の状況・性格・関心・気をつけること・人間関係）・メモ・交換履歴（誰がいつ会ったか）を取得します。",
      inputSchema: z.object({ person_id: z.string().describe("search_people で得た person_id") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ person_id }) => {
      const d = await getCardDetail(db, person_id);
      if (!d || d.card.deleted_at) return fail("その人物は見つかりません。");
      await audit(db, { userId: user.id, via, action: "view", targetType: "card", targetId: person_id });
      const card = d.card;
      const fields = Object.fromEntries(
        Object.entries(FIELD_LABEL)
          .filter(([k]) => card[k])
          .map(([k, label]) => [label, card[k]]),
      );
      return text({
        person_id,
        ...fields,
        tags: JSON.parse(String(card.tags || "[]")),
        last_exchanged_on: card.exchanged_on || undefined,
        exchange_place: card.exchange_place || undefined,
        history: d.events.map((e) => {
          const detail = JSON.parse(String(e.detail || "{}"));
          return { type: e.type, by: e.user_name, at: e.created_at, via: detail.via, exchanged_on: detail.exchanged_on, updated: detail.updated_fields };
        }),
        profile: Object.fromEntries(
          Object.entries(
            (await cardInsights(db, person_id)).reduce<Record<string, { text: string; on: string; source?: string }[]>>((acc, r) => {
              (acc[INSIGHT_LABEL[r.category]] ??= []).push({ text: r.body, on: r.happened_on ?? r.created_at.slice(0, 10), source: r.source_title || undefined });
              return acc;
            }, {}),
          ),
        ),
        notes: d.notes.map((n) => ({ by: n.created_by_name, at: n.created_at, via: n.source, body: n.body })),
        past_interactions: d.interactions.map((i) => ({ on: i.happened_on ?? i.created_at.slice(0, 10), summary: i.summary, minutes: i.document_title ?? undefined })),
        tasks: d.tasks.map((t) => ({ task_id: t.id, title: t.title, due_on: t.due_on ?? undefined, status: t.status === "done" ? "完了" : "未完了", assignee: t.assignee || t.assignee_name })),
        has_card_image: d.images.length > 0,
        other_affiliations: d.affiliations.length
          ? d.affiliations.map((a) => ({ person_id: a.id, company: a.company_name, department: a.department || undefined, title: a.title || undefined, email: a.email || undefined }))
          : undefined,
      });
    },
  );

  if (canWrite) {
    server.registerTool(
      "register_person",
      {
        title: "人物（名刺）を登録",
        description: `名刺交換した人を登録します。議事録・会話・メールに名前が出てきただけの人は登録しないでください（このアプリには名刺交換した人だけを入れます）。メールアドレスか電話番号が既存の人物と一致した場合は、自動で同じ人物にまとめ（交換履歴が追加されます）、変わった項目（異動・昇進など）を更新します。
氏名だけが似た人がいる場合は登録せずに候補を返すので、利用者に同じ人か確認し、同じなら merge_into に person_id を、別人なら force_new=true を付けて再度呼んでください。
登録後に返る画像アップロード用リンクを利用者に案内すると、名刺の写真を保存できます。
${NOTATION_RULES}`,
        inputSchema: z.object({
          ...personFields,
          met_on: z.string().optional().describe("名刺を交換した日（YYYY-MM-DD）。不明なら空"),
          met_place: z.string().optional().describe("交換した場所・イベント名"),
          tags: z.array(z.string()).optional().describe("タグ"),
          note: z.string().optional().describe("メモ（話した内容など）"),
          merge_into: z.string().optional().describe("同じ人物だと確認できた既存の person_id"),
          force_new: z.boolean().optional().describe("似た人がいても別人として新規登録する場合 true"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) => {
        const { met_on, met_place, tags, note, merge_into, force_new, ...fields } = args;
        let result;
        try {
          result = await registerPerson(db, {
            userId: user.id,
            via,
            fields,
            exchangedOn: met_on,
            exchangePlace: met_place,
            tags,
            note,
            mergeInto: merge_into,
            forceNew: force_new,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        if (result.action === "needs_confirmation") {
          return text({
            status: "needs_confirmation",
            message: "似た人物が登録されています。同じ人か利用者に確認し、merge_into か force_new を付けて再実行してください。",
            candidates: result.candidates.map((m) => ({
              person_id: m.id,
              name: m.person_name,
              company: m.company_name,
              title: m.title,
              email: m.email,
              registered_by: m.created_by_name,
              reason: MATCH_LABEL[m.match],
            })),
          });
        }
        await audit(db, { userId: user.id, via, action: result.action === "created" ? "create" : "update", targetType: "card", targetId: result.cardId });
        const link = await createUploadLink(db, result.cardId, user.id, origin);
        return text({
          status: result.action,
          person_id: result.cardId,
          message:
            result.action === "created"
              ? "新しい人物として登録しました。"
              : `既存の人物にまとめました（交換履歴に追加）。${result.changes.length ? `\n更新した項目:\n${changeLines(result.changes).join("\n")}` : ""}`,
          card_image_upload_url: link.url,
          card_image_upload_expires_in: "15分",
        });
      },
    );

    server.registerTool(
      "update_person",
      {
        title: "人物の情報を更新",
        description: `登録済みの人物の項目を更新します（指定した項目だけ）。変更前の値は履歴に残ります。異動・昇進・連絡先の変更などに使います。
${NOTATION_RULES}`,
        inputSchema: z.object({
          person_id: z.string(),
          changes: z.object(personFields).partial().describe("変更する項目と新しい値"),
          tags: z.array(z.string()).optional().describe("タグを置き換える場合のみ"),
          met_place: z.string().optional().describe("交換場所・イベント名を変える場合のみ"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ person_id, changes, tags, met_place }) => {
        const result = await updatePerson(db, person_id, { userId: user.id, via, fields: changes, tags, exchangePlace: met_place });
        if (!result) return fail("その人物は見つかりません。");
        if (!result.length) return text("変更はありませんでした。");
        await audit(db, { userId: user.id, via, action: "update", targetType: "card", targetId: person_id });
        return text(`更新しました:\n${changeLines(result).join("\n")}`);
      },
    );

    server.registerTool(
      "add_person_insights",
      {
        title: "人物像を追加（文字起こしなどから振り分け）",
        description: [
          "会議の文字起こし・メモなどから読み取った、人ごとの情報（人物像）を名刺に追加します。アプリの「人物情報 → 2. 文字起こしなどから振り分けて入れる」と同じ処理です。",
          "入力: { source: どの会議・資料か, date: YYYY-MM-DD, items: [{ card_id, name, company, category, text, evidence, confidence }] }（1回100件まで）。",
          "card_id は名刺の ID（export_people_profiles の見出しの [id: …] か search_people の person_id）。分からなければ空文字にして name と company を入れてください。",
          "category は role（立場・役割）/ attitude（温度感）/ status（今の状況）/ personality（性格・人柄）/ interest（関心・課題）/ caution（気をつけること）/ relation（人間関係）/ other のどれか。",
          "人の特定は card_id を優先し、なければ氏名＋会社で探します。人がはっきりしていて confidence が 0.7 以上なら反映し、それ以外は確認待ちになります（アプリの「人物情報 → 3. 確認待ち」で人が選びます）。",
          "社内メンバー（@ainotetsujin.com）の名刺には入れず、確認待ちに回します。card_id・category・text・source がすべて同じものがすでにあれば飛ばします。category が上の8つ以外・text が空の件はエラーにして、残りは処理します。",
          "返り値: { applied: [{card_id, name, category}], pending: [{name, company, category, reason: 人が見つからない | 候補が複数 | 確信度が低い | 社内メンバー, candidate?}], skipped: [{name, category, reason: 重複}], errors: [{index, message}] }。",
          "書かれていないことは推測で足さないでください。",
        ].join("\n"),
        inputSchema: z.object({
          source: z.string().describe("どの会議・資料からか（例: 2026-10-27 ステークホルダーミーティング）"),
          date: z.string().describe("その会議・資料の日付 YYYY-MM-DD（不明なら空文字）"),
          items: z
            .array(
              z.object({
                card_id: z.string().describe("名刺の ID（[id: …] / person_id）。分からなければ空文字"),
                name: z.string().describe("氏名"),
                company: z.string().describe("会社名"),
                // 8つ以外はその件だけエラーにするため、ここでは文字列として受け取る
                category: z.string().describe("role / attitude / status / personality / interest / caution / relation / other"),
                text: z.string().describe("その人についての情報（1〜2文）"),
                evidence: z.string().describe("根拠となる発言・記述の短い引用"),
                confidence: z.number().describe("人の特定と内容の確信度 0〜1（0.7 以上で自動反映）"),
              }),
            )
            .min(1)
            .max(MAX_AI_ITEMS),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ source, date, items }) => {
        const r = await importInsights(db, user, { source, date, items }, "ai", { domain: env.ALLOWED_DOMAIN });
        await audit(db, { userId: user.id, via, action: "insight_import", detail: countsOf(r) });
        return text(r);
      },
    );

    server.registerTool(
      "add_note",
      {
        title: "メモを追加",
        description: "人物にメモを追加します（例: お礼メールを送った、次回の打ち合わせ予定、話した内容）。メールを送ったあとの記録にも使ってください。",
        inputSchema: z.object({
          person_id: z.string(),
          body: z.string().describe("メモの本文"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ person_id, body }) => {
        try {
          await addNote(db, person_id, user.id, via, body);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        await audit(db, { userId: user.id, via, action: "note", targetType: "card", targetId: person_id });
        return text("メモを追加しました。");
      },
    );

    server.registerTool(
      "create_card_image_link",
      {
        title: "名刺画像のアップロード用リンクを作る",
        description: "登録済みの人物に名刺の写真を追加するための、15分間有効なリンクを作ります。利用者にリンクを開いて写真を選んでもらってください。",
        inputSchema: z.object({ person_id: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ person_id }) => {
        const exists = await db.prepare("SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL").bind(person_id).first();
        if (!exists) return fail("その人物は見つかりません。");
        const link = await createUploadLink(db, person_id, user.id, origin);
        return text({ card_image_upload_url: link.url, expires_in: "15分" });
      },
    );
  }

  // ---------- 顧客請求・社内請求・サブスク ----------

  const STATUS_LABEL: Record<string, string> = { draft: "下書き", created: "作成済み（送付前）", sent: "送付済み（連絡前）", contacted: "送付・連絡済み" };

  server.registerTool(
    "list_customer_invoices",
    {
      title: "顧客請求書の状況",
      description: "指定した月（YYYY-MM、省略時は今月）の顧客ごとの請求書の状況（見積・契約・作成・送付・連絡）を返します。送付先・連絡手段・担当者も含みます。",
      inputSchema: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ period }) => {
      const p = period ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
      const rows = await board(db, p);
      return text({
        period: p,
        customers: rows.map((r) => ({
          customer: r.customer.name,
          owner: r.customer.owner_name ?? r.customer.owner_email,
          send_to: r.customer.delivery_to,
          contact_via: r.customer.contact_via,
          contract: r.contract ? "あり" : "なし",
          invoice: r.invoice
            ? { invoice_id: r.invoice.id, number: r.invoice.number ?? undefined, total: yen(Number(r.invoice.total)), status: STATUS_LABEL[String(r.invoice.status)] }
            : "未作成",
        })),
      });
    },
  );

  if (canWrite) {
    server.registerTool(
      "check_customer_invoice",
      {
        title: "請求書の送付・連絡をチェック",
        description: "顧客請求書に「送付済み」「連絡済み」の印を付けます（false で外す）。チェックできるのはその顧客の担当者と管理者だけです。invoice_id は list_customer_invoices で取得します。",
        inputSchema: z.object({ invoice_id: z.string(), sent: z.boolean().optional(), contacted: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ invoice_id, sent, contacted }) => {
        try {
          const status = await checkInvoice(db, invoice_id, { id: user.id, email: user.email, name: user.name, registered: 1, role: user.role }, { sent, contacted });
          return text(`更新しました（${STATUS_LABEL[status]}）。`);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  const sessionUser = { id: user.id, email: user.email, name: user.name, registered: 1, role: user.role };
  const MONTH_ARG = z.string().regex(/^\d{4}-\d{2}$/);
  const jstMonth = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  const lineText = (lines: { period_label?: string; name: string; amount: number }[]) =>
    lines.map((l) => `${l.period_label ? `${l.period_label} ` : ""}${l.name.replace(/\n/g, "")} ${yen(Number(l.amount))}`);

  if (canWrite) {
    server.registerTool(
      "prepare_customer_invoices",
      {
        title: "顧客請求書の下書きを作る（内容の確認）",
        description:
          "指定した月（YYYY-MM、省略時は今月）の顧客請求書の下書きを契約から作り、顧客ごとの明細・金額（税込）を返します。PDF はまだ作りません。「10月分の請求書を作って」と頼まれたら、まずこれで金額を見せて確認を取り、OK なら create_customer_invoices を呼びます。",
        inputSchema: z.object({ period: MONTH_ARG.optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ period }) => {
        const p = period ?? jstMonth();
        const created = await prepareInvoices(db, p, user.id);
        const rows = await board(db, p);
        const invoices = rows
          .filter((r) => r.invoice)
          .map((r) => {
            const inv = r.invoice as Record<string, unknown>;
            return {
              invoice_id: inv.id,
              customer: r.customer.name,
              status: STATUS_LABEL[String(inv.status)],
              number: inv.number ?? undefined,
              lines: lineText(JSON.parse(String(inv.lines || "[]"))),
              raw_lines: JSON.parse(String(inv.lines || "[]")),
              note: String(inv.note || r.customer.invoice_note || "") || undefined,
              issue_date: inv.issue_date ?? "作成日（今日）",
              total: yen(Number(inv.total)),
              owner: r.customer.owner_name ?? r.customer.owner_email,
              preview_url: inv.imported ? undefined : `${origin}/api/billing/invoices/${inv.id}/preview`,
            };
          });
        return text({
          period: p,
          new_drafts: created,
          invoices,
          no_invoice: rows.filter((r) => !r.invoice).map((r) => r.customer.name),
          next: invoices.some((i) => i.status === "下書き")
            ? "この内容（明細・備考・請求日・金額）を利用者に見せて確認を取る。直したい点があれば update_customer_invoice で直してから、OK をもらって create_customer_invoices で作成する"
            : "作成待ちの下書きはありません",
        });
      },
    );

    server.registerTool(
      "update_customer_invoice",
      {
        title: "請求書の文言を直す（作成前の確認）",
        description:
          "作成前（または作り直す前）の顧客請求書の文言を直します。lines は明細全体の置き換え（period_label=対象期間、name=内容（改行可）、qty=数量、unit_price=税込単価）。note は備考欄に載せる顧客向けの文（注文番号など。会社共通の振込・免税事業者の文は自動で付く）。issue_date は請求日。prepare_customer_invoices の raw_lines を元に直すと安全です。直したら内容を見せて、確認が取れてから create_customer_invoices を呼びます。",
        inputSchema: z.object({
          invoice_id: z.string(),
          lines: z.array(z.object({ period_label: z.string().default(""), name: z.string(), qty: z.number().default(1), unit_price: z.number().describe("税込の単価（円）") })).optional(),
          note: z.string().optional(),
          issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ invoice_id, lines, note, issue_date }) => {
        try {
          await updateInvoice(db, invoice_id, { lines: lines?.map((l) => ({ ...l, amount: 0 })), note, issue_date });
          await audit(db, { userId: user.id, via, action: "invoice_edit", targetType: "customer_invoice", targetId: invoice_id });
          const inv = await db
            .prepare("SELECT i.*, c.name AS customer_name, c.invoice_note AS customer_note FROM customer_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?")
            .bind(invoice_id)
            .first<Record<string, string | number | null>>();
          return text({
            updated: true,
            customer: inv?.customer_name,
            status: STATUS_LABEL[String(inv?.status)],
            lines: lineText(JSON.parse(String(inv?.lines || "[]"))),
            note: String(inv?.note || inv?.customer_note || "") || undefined,
            issue_date: inv?.issue_date ?? "作成日（今日）",
            total: yen(Number(inv?.total ?? 0)),
            preview_url: `${origin}/api/billing/invoices/${invoice_id}/preview`,
            next: inv?.status === "draft" ? "この内容で良いか確認を取ってから create_customer_invoices" : "作成済みの請求書です。反映するには create_customer_invoices に invoice_ids を指定して作り直す（同じ番号で上書き）",
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );

    server.registerTool(
      "create_customer_invoices",
      {
        title: "顧客請求書を作成（PDF・Google Drive に保存）",
        description:
          "必ず先に prepare_customer_invoices で内容（明細・備考・請求日・金額）を利用者に見せ、OK をもらってから呼んでください。指定した月の顧客請求書を PDF にして、番号を振り、Google Drive（顧客請求書/YYYY年M月分/顧客名）に保存します。invoice_ids を省略すると、その月の下書きをすべて作成します（作成済みのものは作り直しません）。作り直す場合は invoice_ids を指定します（同じ番号で上書き）。issue_date（YYYY-MM-DD）を省略すると今日の日付。1件あたり数秒かかります。",
        inputSchema: z.object({
          period: MONTH_ARG.optional(),
          invoice_ids: z.array(z.string()).optional().describe("作成・作り直しする請求書（省略でその月の下書きすべて）"),
          issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("請求日（省略で今日）"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ period, invoice_ids, issue_date }) => {
        const p = period ?? jstMonth();
        let ids = invoice_ids;
        if (!ids?.length) {
          await prepareInvoices(db, p, user.id);
          const { results } = await db.prepare("SELECT id FROM customer_invoices WHERE period = ? AND status = 'draft'").bind(p).all<{ id: string }>();
          ids = results.map((r) => r.id);
        }
        if (!ids.length) return text(`${p} に作成待ちの下書きはありません。list_customer_invoices で状況を確認してください。`);
        const done = [];
        for (const id of ids) {
          const inv = await db
            .prepare("SELECT i.imported, c.name FROM customer_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?")
            .bind(id)
            .first<{ imported: number; name: string }>();
          if (!inv) {
            done.push({ invoice_id: id, error: "請求書が見つかりません" });
            continue;
          }
          if (inv.imported) {
            done.push({ customer: inv.name, error: "取り込んだ過去の請求書は作り直せません" });
            continue;
          }
          try {
            const r = await issueInvoice(env, id, sessionUser, issue_date);
            const row = await db.prepare("SELECT total, drive_file_id FROM customer_invoices WHERE id = ?").bind(id).first<{ total: number; drive_file_id: string | null }>();
            done.push({
              customer: inv.name,
              number: r.number,
              total: yen(Number(row?.total ?? 0)),
              drive_url: row?.drive_file_id ? `https://drive.google.com/file/d/${row.drive_file_id}/view` : undefined,
              warnings: r.warnings.length ? r.warnings : undefined,
            });
          } catch (e) {
            done.push({ customer: inv.name, error: e instanceof Error ? e.message : String(e) });
          }
        }
        await audit(db, { userId: user.id, via, action: "invoice_issue", detail: { period: p, count: done.length } });
        return text({
          period: p,
          results: done,
          next: "担当者が顧客に送付・連絡したら check_customer_invoice でチェックしてください（未チェックの間は 9〜19時に1時間ごと Google Chat に通知されます）",
        });
      },
    );

    server.registerTool(
      "submit_internal_claim",
      {
        title: "社内請求（稼働分・立替経費）を作成・提出",
        description: `登録された社内請求対象者が会社に出す請求書（稼働分 work／立替経費 expense）を作って提出します（PDF を Google Drive の 社内請求・経費/YYYY年M月分/氏名 に保存）。period は稼働月 YYYY-MM（例: 10月分なら 2026-10。${FIRST_PERIOD} 以降）。member は "me"（自分）か氏名・メールアドレス。work の lines を省略すると、その人の既定の品目・単価を使います。立替経費はアプリに登録済みの未請求の明細をまとめます（領収書と金額が1円でも違うと提出できません）。dry_run: true なら作らずに中身だけ返すので、先に見せて確認を取ってください。`,
        inputSchema: z.object({
          period: MONTH_ARG,
          kind: z.enum(["work", "expense"]),
          member: z.string().optional().describe('"me"（省略時）、氏名、またはメールアドレス'),
          lines: z.array(z.object({ name: z.string(), qty: z.number().default(1), unit_price: z.number().describe("税抜の単価（円）") })).optional(),
          allow_missing_receipt: z.boolean().optional().describe("領収書のない経費明細も含めて提出する（領収書がもらえない支払いのときだけ）"),
          dry_run: z.boolean().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ period, kind, member, lines, allow_missing_receipt, dry_run }) => {
        const key = (member ?? "me").trim();
        const target =
          key === "me"
            ? await db.prepare("SELECT email, display_name FROM internal_members WHERE email = ? AND active = 1").bind(user.email).first<{ email: string; display_name: string }>()
            : await db
                .prepare("SELECT email, display_name FROM internal_members WHERE active = 1 AND (email = ? OR replace(display_name, ' ', '') LIKE ?)")
                .bind(key.toLowerCase(), `%${key.replace(/\s|さん/g, "")}%`)
                .first<{ email: string; display_name: string }>();
        if (!target) {
          const { results } = await db.prepare("SELECT display_name FROM internal_members WHERE active = 1").all<{ display_name: string }>();
          return fail(`社内請求の対象者が見つかりません（対象: ${results.map((r) => r.display_name).join("・")}）。${key === "me" ? "誰の分か member で指定してください。" : ""}`);
        }
        const body = { lines, allow_missing_receipt };
        if (!dry_run && !selfOrAdmin(user, target.email)) return fail(`${target.display_name}さんの社内請求を提出できるのは、本人と管理者だけです。内容の確認（dry_run）はできます。`);
        try {
          if (dry_run) {
            const c = await previewClaim(db, target.email, period, kind, body);
            return text({
              dry_run: true,
              member: c.member,
              kind: kind === "work" ? "稼働分" : "立替経費",
              number: c.number,
              lines: (c.lines as { name?: string; purpose?: string; date?: string; amount: number }[]).map((l) => `${l.date ? `${l.date} ` : ""}${l.name ?? l.purpose} ${yen(l.amount)}`),
              subtotal: yen(c.subtotal),
              tax: yen(c.tax),
              total: yen(c.total),
              pay_date: c.due_date,
              warning: c.bank_registered ? undefined : "振込先が未登録のため、このままでは提出できません",
            });
          }
          const r = await submitClaim(env, sessionUser, target.email, period, kind, body);
          const row = await db.prepare("SELECT number, total, drive_file_id FROM internal_claims WHERE id = ?").bind(r.id).first<{ number: string; total: number; drive_file_id: string | null }>();
          return text({
            submitted: true,
            member: target.display_name,
            kind: kind === "work" ? "稼働分" : "立替経費",
            number: row?.number,
            total: yen(Number(row?.total ?? 0)),
            drive_url: row?.drive_file_id ? `https://drive.google.com/file/d/${row.drive_file_id}/view` : undefined,
            warnings: r.warnings.length ? r.warnings : undefined,
            receipts_note: r.receipts_pending ? `領収書 ${r.receipts_pending} 件は、このあと1時間ごとに少しずつ Drive の「立替領収書」フォルダへ自動で保存します（枚数が多いと数時間かかります。アプリの画面から発行した場合は、画面を開いている間にその場で保存します）` : undefined,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  server.registerTool(
    "list_internal_claims",
    {
      title: "社内請求・経費の提出状況",
      description: "指定した月（稼働月 YYYY-MM、省略時は先月）の、登録された社内請求対象者の稼働分と立替経費の請求の提出状況、未請求の経費、原本未提出の領収書を返します。月末締め・翌月2日までに発行・翌月5日払い。",
      inputSchema: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ period }) => {
      const p = period ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const { results: members } = await db.prepare("SELECT * FROM internal_members WHERE active = 1").all<Record<string, string>>();
      const out = [];
      for (const m of members) {
        const { results: claims } = await db.prepare("SELECT kind, number, total, status FROM internal_claims WHERE member_email = ? AND period = ?").bind(m.email, p).all<Record<string, string | number>>();
        const pending = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM expense_items WHERE member_email = ? AND claim_id IS NULL").bind(m.email).first<{ n: number; total: number }>();
        const originals = await db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE member_email = ? AND original_submitted_at IS NULL").bind(m.email).first<{ n: number }>();
        const show = (k: string) => {
          const c = claims.find((x) => x.kind === k);
          return c ? `${c.status === "paid" ? "精算済み" : "提出済み"}（${yen(Number(c.total))}・No.${c.number}）` : "未提出";
        };
        out.push({ member: m.display_name, work: show("work"), expense: show("expense"), unclaimed_expenses: `${pending?.n ?? 0}件 ${yen(pending?.total ?? 0)}`, receipt_originals_missing: originals?.n ?? 0 });
      }
      return text({ period: p, members: out });
    },
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "契約・サブスクの一覧",
      description: "会社で契約しているサブスク・契約の一覧（名義・支払い方法・金額・更新日・管理者・名義移行の状況）。方針として会社名義・法人カードに統一中で、個人名義・個人立替のものは personal: true です。",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const { results } = await db.prepare("SELECT * FROM subscriptions WHERE active = 1 ORDER BY renewal_date").all<Record<string, string | number | null>>();
      return text(
        results.map((s) => ({
          service: s.service_name,
          holder: s.holder === "company" ? "会社" : "個人",
          payment: s.payment_method === "corporate_card" ? "法人カード" : "個人立替",
          personal: s.holder === "personal" || s.payment_method === "personal",
          amount: s.amount ? `${s.cycle === "yearly" ? "年額" : "月額"} ${yen(Number(s.amount))}` : undefined,
          renewal_date: s.renewal_date ?? undefined,
          admin: s.admin_email,
          migration: { none: undefined, planned: `移行予定（${s.migration_month ?? "未定"}）`, done: "移行済み" }[String(s.migration_status)],
          note: s.note || undefined,
        })),
      );
    },
  );

  // 議事録・タスク。設定で有効にしたときだけ出す
  if (features.minutes) {
    // ---------- タスク ----------

    server.registerTool(
      "list_tasks",
      {
        title: "タスクの一覧",
        description: "タスクを一覧します。assignee に \"me\" を指定すると自分の担当だけ、社員名を指定するとその人の担当だけ、省略で全員分。",
        inputSchema: z.object({
          assignee: z.string().optional().describe("\"me\" / 社員名 / 省略"),
          status: z.enum(["open", "done", "all"]).optional().describe("open（未完了・既定）/ done / all"),
          due_within_days: z.number().int().min(0).max(365).optional().describe("期限が今日から何日以内のものだけ"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ assignee, status, due_within_days }) => {
        const assigneeId = !assignee ? undefined : assignee === "me" ? user.id : await resolveAssignee(db, assignee);
        if (assignee && !assigneeId) return fail(`「${assignee}」という社員が見つかりません。`);
        const dueBefore =
          due_within_days === undefined ? undefined : new Date(Date.now() + 9 * 3600_000 + due_within_days * 86400_000).toISOString().slice(0, 10);
        const rows = await listTasks(db, { assignee: assigneeId ?? undefined, status: status ?? "open", dueBefore });
        return text(
          rows.map((t) => ({
            task_id: t.id,
            title: t.title,
            assignee: t.assignee || t.assignee_name || "未定",
            due_on: t.due_on ?? undefined,
            status: t.status === "done" ? "完了" : "未完了",
            person: t.person_name ? `${t.person_name}（${t.person_company}）` : undefined,
            from_minutes: t.document_title ?? undefined,
          })),
        );
      },
    );

    if (canWrite) {
      server.registerTool(
        "create_task",
        {
          title: "タスクを登録",
          description: "タスクを登録します。期限の2日前から毎朝9時に Google Chat の議事録スペースで知らせます。",
          inputSchema: z.object({
            title: z.string().describe("やること"),
            assignee: z.string().optional().describe("担当の社員名。\"me\" で自分。省略で自分"),
            due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("期限 YYYY-MM-DD"),
            person_id: z.string().optional().describe("関係する人物の person_id"),
            detail: z.string().optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async ({ title, assignee, due_on, person_id, detail }) => {
          const assigneeId = !assignee || assignee === "me" ? user.id : await resolveAssignee(db, assignee);
          if (!assigneeId) return fail(`「${assignee}」という社員が見つかりません。`);
          const { id, stmt } = createTaskStatement(db, { title, detail, assigneeUserId: assigneeId, dueOn: due_on, cardId: person_id ?? null, source: via, createdBy: user.id });
          await stmt.run();
          await audit(db, { userId: user.id, via, action: "task_create", targetType: "task", targetId: id });
          return text({ status: "created", task_id: id });
        },
      );

      server.registerTool(
        "complete_task",
        {
          title: "タスクを完了にする",
          description: "task_id のタスクを完了にします（done=false で未完了に戻す）。",
          inputSchema: z.object({ task_id: z.string(), done: z.boolean().optional() }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ task_id, done }) => {
          const ok = await setTaskDone(db, task_id, user.id, done ?? true);
          if (!ok) return fail("そのタスクは見つかりません。");
          await audit(db, { userId: user.id, via, action: "task_done", targetType: "task", targetId: task_id });
          return text(done === false ? "未完了に戻しました。" : "完了にしました。");
        },
      );
    }

    // ---------- 議事録 ----------

    server.registerTool(
      "list_minutes",
      {
        title: "議事録の一覧",
        description:
          "会議の議事録（Voiss で録音した文字起こし・貼り付けた議事録）を新しい順に返します。期間・キーワード（タイトル・要点・決まったこと・ネクストアクション）・会社名・録音した人で絞り込めます。中身は get_minutes で読みます。",
        inputSchema: z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日以降（YYYY-MM-DD）"),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日まで（YYYY-MM-DD）"),
          keyword: z.string().optional(),
          company: z.string().optional().describe("会社名（決まったこと・登場した人の会社・タイトルから探す）"),
          recorded_by: z.string().optional().describe("\"me\" / 社員名"),
          limit: z.number().int().min(1).max(50).optional().describe("件数（既定 20）"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ from, to, keyword, company, recorded_by, limit }) => {
        const where: string[] = ["d.status IN ('done', 'failed', 'processing')"];
        const binds: (string | number)[] = [];
        const dateExpr = "COALESCE(date(d.started_at, '+9 hours'), d.meeting_date, date(d.created_at, '+9 hours'))";
        if (from) {
          where.push(`${dateExpr} >= ?`);
          binds.push(from);
        }
        if (to) {
          where.push(`${dateExpr} <= ?`);
          binds.push(to);
        }
        if (keyword?.trim()) {
          const k = `%${keyword.trim()}%`;
          where.push(
            "(d.title LIKE ? OR d.summary LIKE ? OR EXISTS (SELECT 1 FROM decisions x WHERE x.document_id = d.id AND x.text LIKE ?) OR EXISTS (SELECT 1 FROM tasks t WHERE t.document_id = d.id AND t.title LIKE ?))",
          );
          binds.push(k, k, k, k);
        }
        if (company?.trim()) {
          const key = companyKey(company);
          where.push(
            "(d.title LIKE ? OR EXISTS (SELECT 1 FROM decisions x WHERE x.document_id = d.id AND x.company_key = ?) OR EXISTS (SELECT 1 FROM interactions i JOIN cards c ON c.id = i.card_id WHERE i.document_id = d.id AND c.company_key = ?))",
          );
          binds.push(`%${company.trim().replace(/^(株式会社|有限会社)|(株式会社|有限会社)$/g, "")}%`, key, key);
        }
        if (recorded_by) {
          const rid = recorded_by === "me" ? user.id : await resolveAssignee(db, recorded_by);
          if (!rid) return fail(`「${recorded_by}」という社員が見つかりません。`);
          where.push("d.recorded_by = ?");
          binds.push(rid);
        }
        const { results } = await db
          .prepare(
            `SELECT d.*, u.name AS recorder_name,
                    (SELECT COUNT(*) FROM decisions x WHERE x.document_id = d.id) AS decision_count,
                    (SELECT COUNT(*) FROM tasks t WHERE t.document_id = d.id) AS task_count
               FROM documents d LEFT JOIN users u ON u.id = d.recorded_by
              WHERE ${where.join(" AND ")}
              ORDER BY COALESCE(d.started_at, d.meeting_date, d.created_at) DESC LIMIT ?`,
          )
          .bind(...binds, limit ?? 20)
          .all<DocRow & { decision_count: number; task_count: number }>();
        await audit(db, { userId: user.id, via, action: "minutes_list", detail: { keyword, company, from, to } });
        return text(
          results.map((d) => ({
            minutes_id: d.id,
            title: d.title,
            date: meetingDateOf(d),
            when: whenLabel(d),
            recorded_by: d.recorder_name ?? undefined,
            summary: d.summary || undefined,
            decisions: d.decision_count,
            next_actions: d.task_count,
            status: { done: "完了", failed: "失敗", processing: "取り込み中" }[d.status] ?? d.status,
          })),
        );
      },
    );

    server.registerTool(
      "get_minutes",
      {
        title: "議事録を読む",
        description: `議事録のネクストアクション・Drive の場所を返します（以前の議事録には要点・決まったこと・登場した人も入っています）。
include_transcript=true で文字起こしの全文も返します（長い場合は transcript_offset で続きを読む）。
「ネクストアクションだけ」「〇〇さんへの報告文」「〇〇の件で何と言っていたか」など、目的に合わせた取り出しは、全文を読んで答えてください。
文字起こしには誤変換があり、話者の区別はありません。各行の [h:mm:ss] は録音の経過時間です。`,
        inputSchema: z.object({
          minutes_id: z.string(),
          include_transcript: z.boolean().optional(),
          transcript_offset: z.number().int().min(0).optional().describe("全文の何文字目から返すか（既定 0）"),
          transcript_max_chars: z.number().int().min(1000).max(120000).optional().describe("返す全文の最大文字数（既定 60000）"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ minutes_id, include_transcript, transcript_offset, transcript_max_chars }) => {
        const data = await loadMinutes(db, minutes_id);
        if (!data) return fail("その議事録は見つかりません。list_minutes で minutes_id を確かめてください。");
        const { doc } = data;
        await audit(db, { userId: user.id, via, action: "view", targetType: "document", targetId: minutes_id });
        let transcript: Record<string, unknown> | undefined;
        if (include_transcript) {
          const all = await minutesTranscript(env, minutes_id);
          const offset = transcript_offset ?? 0;
          const max = transcript_max_chars ?? 60000;
          const part = all.slice(offset, offset + max);
          transcript = { total_chars: all.length, offset, text: part, next_offset: offset + part.length < all.length ? offset + part.length : undefined };
        }
        return text({
          minutes_id,
          title: doc.title,
          when: whenLabel(doc),
          recorded_by: doc.recorder_name ?? undefined,
          status: doc.status,
          summary: doc.summary || undefined,
          decisions: data.decisions.map((d) => d.text),
          next_actions: data.tasks.map((t) => ({ task_id: t.id, title: t.title, assignee: t.assignee || t.assignee_name || "未定", due_on: t.due_on ?? undefined, status: t.status === "done" ? "完了" : "未完了" })),
          people: data.people.map((p) => ({ person_id: p.card_id, name: p.person_name, company: p.company_name })),
          drive_url: driveLinkOf(doc) ?? undefined,
          app_url: `${origin}/minutes/${minutes_id}`,
          transcript,
        });
      },
    );
  }

  // つながり・確認依頼はスコープ外。設定で有効にしたときだけ出す
  if (features.graph) {
    // ---------- 確認依頼 ----------

    server.registerTool(
      "list_review_items",
      {
        title: "確認依頼の一覧",
        description:
          "AI が人に確認してほしいと判断したもの（同じ人かもしれない名刺の統合候補、データの誤りの疑い）を返します。",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => {
        const rows = await listReviewItems(db);
        return text(
          rows.map((r) => ({
            item_id: r.id,
            kind: { merge: "統合候補", new_person: "新しい人物の候補", fix: "データの誤りの疑い" }[String(r.kind)],
            reason: r.reason,
            confidence: r.confidence,
            person: r.card_name ? `${r.card_name}（${r.card_company}）` : undefined,
            other_person: r.other_name ? `${r.other_name}（${r.other_company}）` : undefined,
            suggestion: JSON.parse(String(r.suggestion || "{}")),
            from_minutes: r.document_title ?? undefined,
          })),
        );
      },
    );

    if (canWrite) {
      server.registerTool(
        "resolve_review_item",
        {
          title: "確認依頼に対応する",
          description: `確認依頼を承認・却下します。
  - 統合候補: approve=true で2件を1つに統合、false で別人として記録
  - データの誤りの疑い: approve=true で修正案（または fields）を反映
  - 以前の議事録から出た「新しい人物の候補」: 名刺交換した人以外は登録しないので approve=false で閉じる（候補の既存人物と同じなら approve=true・mode="existing"）`,
          inputSchema: z.object({
            item_id: z.string(),
            approve: z.boolean(),
            mode: z.enum(["existing"]).optional(),
            fields: z.object(personFields).partial().optional().describe("修正後の値を自分で指定する場合"),
          }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async ({ item_id, approve, mode, fields }) => {
          try {
            return text(await resolveReviewItem(db, item_id, user.id, via, { approve, mode, fields }));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      );
    }

    // ---------- 関係性 ----------

    server.registerTool(
      "find_connections",
      {
        title: "つながりを調べる",
        description:
          "会社・人物・案件・社員の名前から、つながりを調べます。例: 「サンプル商事と繋がっている人は？」「担当者は誰と名刺交換している？」。社内の誰が名刺交換したか、議事録から読み取った関係（担当・紹介など）も含みます。",
        inputSchema: z.object({
          name: z.string().describe("会社名・人物名・案件名・社員名"),
          depth: z.number().int().min(1).max(2).optional().describe("何段先までたどるか（既定 2）"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ name, depth }) => {
        const found = await findNode(db, name);
        if (!found.length) return text(`「${name}」に当てはまる会社・人物・案件・社員は見つかりませんでした。`);
        const g = await buildGraph(db, found[0].id, depth ?? 2);
        if (!g) return fail("見つかりません。");
        await audit(db, { userId: user.id, via, action: "view", targetType: "graph", detail: { center: g.center } });
        const label = new Map(g.nodes.map((n) => [n.id, `${n.label}${n.sub ? `（${n.sub}）` : ""}`]));
        return text({
          center: label.get(g.center),
          other_candidates: found.slice(1).map((n) => `${n.label}${n.sub ? `（${n.sub}）` : ""}`),
          connections: g.edges.map((e) => `${label.get(e.from)} —${e.kind}→ ${label.get(e.to)}${e.source ? `［根拠: ${e.source}］` : ""}`),
          people: g.nodes.filter((n) => n.type === "person").map((n) => ({ person_id: n.id.slice(7), name: n.label, company: n.sub })),
        });
      },
    );

  }

  server.registerTool(
    "get_company",
    {
      title: "会社の詳細",
      description: "会社名から、その会社の人物・案件・決定事項（議事録より）・契約・未入金・未完了タスク・最近のやり取りをまとめて返します。打ち合わせ前の確認などに使います。",
      inputSchema: z.object({ name: z.string().describe("会社名（「株式会社」の有無は問わない）") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const node = (await findNode(db, name)).find((n) => n.type === "company");
      const data = await getCompany(db, node ? node.id.slice("company:".length) : companyKey(name));
      if (!data) return text(`「${name}」に当てはまる会社は見つかりませんでした。`);
      await audit(db, { userId: user.id, via, action: "view", targetType: "company", detail: { company: data.company_name } });
      return text({
        company: data.company_name,
        people: data.people.map((p) => ({ person_id: p.id, name: p.person_name, department: p.department || undefined, title: p.title || undefined, email: p.email || undefined })),
        deals: data.deals.map((d) => ({ name: d.name, status: d.status, amount: d.amount || undefined })),
        decisions: data.decisions.map((d) => ({ text: d.text, minutes: d.document_title, on: d.meeting_date ?? undefined })),
        contracts: data.contracts.map((c) => ({ contract: c.title, amount: yen(Number(c.amount)), status: c.status === "active" ? "有効" : "終了" })),
        invoices: data.recent_invoices.map((i) => ({ period: i.period, number: i.number ?? undefined, total: yen(Number(i.amount)), status: i.status })),
        open_tasks: data.open_tasks.map((t) => ({ task_id: t.id, title: t.title, due_on: t.due_on ?? undefined, assignee: t.assignee || t.assignee_name })),
        recent_interactions: data.recent_interactions.map((i) => ({ person: i.person_name, on: i.happened_on ?? String(i.created_at).slice(0, 10), summary: i.summary })),
      });
    },
  );

  return server;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: McpProps }).props;
    const user = props?.userId
      ? await env.DB.prepare("SELECT id, name, email, role, active FROM users WHERE id = ?").bind(props.userId).first<McpUser & { active: number }>()
      : null;
    if (!user?.active) {
      return new Response(JSON.stringify({ error: "このアカウントは無効です" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const via = `ai:${props?.clientName || "AI"}`;
    const origin = new URL(request.url).origin;
    const settings = await getSettings(env.DB);
    const features = { minutes: minutesEnabled(settings), graph: graphEnabled(settings) };
    const handler = createMcpHandler(() => createServer(env, user, via, origin, features), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
