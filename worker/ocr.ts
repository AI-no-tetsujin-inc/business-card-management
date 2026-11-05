import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./anthropic";
import { AiBudgetError, ensureAiBudget } from "./ai-usage";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { CARD_FIELDS, FIELD_KEYS, emptyFields, type CardFields, type FieldFlags, type OcrResult } from "../shared/fields";
import { recordUsage } from "./ai-usage";

const OCR_MODEL = "claude-opus-5-5";

const FieldSchema = z.object({
  value: z.string(),
  status: z.enum(["ok", "review"]),
  reason: z.string(),
});

const OcrSchema = z.object({
  is_business_card: z.boolean(),
  fields: z.object(Object.fromEntries(FIELD_KEYS.map((k) => [k, FieldSchema])) as Record<string, typeof FieldSchema>),
  comment: z.string(),
});

const SYSTEM = `あなたは日本のビジネス名刺を読み取って、社内の名刺データベースに登録する担当です。
画像は1枚目が表面、2枚目があれば裏面です。両面で1人分の名刺です。

項目（キー: 意味）:
${CARD_FIELDS.map((f) => `- ${f.key}: ${f.label}`).join("\n")}

ルール:
- 名刺に書かれている文字をそのまま転記する。推測で補ったり言い換えたりしない。
- 名刺に存在しない項目は value を空文字、status を "ok"、reason を空文字にする。
- 日本語面と英語面がある場合、日本語の項目は日本語面から、person_name_en は英語面（ローマ字）から取る。
- phone は直通番号があれば直通、なければ代表番号。それ以外の電話番号・SNS・資格・拠点などは other に「ラベル: 値」の形でまとめる。
- postal_code は数字とハイフンのみ（〒は付けない）。
- person_name_kana は名刺にふりがなが書かれていればそれを使う。書かれていない場合は一般的な読みをひらがなで推定し、status を "review"、reason を「名刺に記載なし（推定）」にする。
- 次のような場合は status を "review" にし、reason に具体的な理由を日本語で短く書く:
  - 文字がかすれ・ぼやけ・小さい・影などで判別に自信がない
  - 似た文字（0/O、1/l/I、ー/－、カ/力、口/ロ など）の区別に自信がない
  - どの項目に入れるべきか曖昧（例: 部署か役職か判断がつかない）
  - 表と裏で内容が食い違う
- 名刺ではない画像の場合は is_business_card を false にする。
- comment には全体についての補足（画像が傾いている、一部が切れている等）があれば短く書く。なければ空文字。`;

async function imageBlock(bucket: R2Bucket, key: string) {
  const obj = await bucket.get(key);
  if (!obj) throw new Error("画像が見つかりません");
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg" as const,
      data: Buffer.from(await obj.arrayBuffer()).toString("base64"),
    },
  };
}

/** API キー未設定時（キー確認待ちの間など）は手入力用の空データを返す */
function manualEntryResult(stopped?: string): OcrResult {
  const reason = stopped ? "AI の利用上限のため手入力してください" : "API キー未設定のため手入力してください";
  return {
    fields: emptyFields(),
    review: { company_name: reason, person_name: reason },
    comment: stopped ? `${stopped}。名刺の内容を手で入力してください。` : "Claude API キーが設定されていないため、読み取りをスキップしました。",
    is_business_card: true,
  };
}

export async function runOcr(env: Env, displayKeys: string[], userId?: string): Promise<OcrResult> {
  if (!env.ANTHROPIC_API_KEY) return manualEntryResult();
  // 今月の利用額が上限に達していたら、API を呼ばずに手入力にする
  try {
    await ensureAiBudget(env);
  } catch (e) {
    if (e instanceof AiBudgetError) return manualEntryResult(e.message);
    throw e;
  }

  const client = anthropicClient(env);
  const images = await Promise.all(displayKeys.map((k) => imageBlock(env.IMAGES, k)));

  const res = await client.beta.messages.parse({
    model: OCR_MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(OcrSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [...images, { type: "text", text: "この名刺を読み取ってください。" }],
      },
    ],
  });

  await recordUsage(env.DB, { purpose: "ocr", model: OCR_MODEL, usage: res.usage, userId });
  if (res.stop_reason === "refusal") throw new Error("読み取りを断られました。画像を確認してください");
  if (res.stop_reason === "max_tokens") throw new Error("読み取り結果が長すぎて途中で切れました");
  const out = res.parsed_output;
  if (!out) throw new Error("読み取り結果を解釈できませんでした");

  const fields = emptyFields() as CardFields;
  const review: FieldFlags = {};
  for (const k of FIELD_KEYS) {
    const f = out.fields[k];
    if (!f) continue;
    fields[k] = f.value.trim();
    if (f.status === "review") review[k] = f.reason || "読み取りに自信がありません";
  }
  return { fields, review, comment: out.comment, is_business_card: out.is_business_card };
}
