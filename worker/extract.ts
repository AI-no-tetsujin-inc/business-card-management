// A. 議事録の抽出（Claude API・構造化出力）
import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./anthropic";
import { ensureAiBudget } from "./ai-usage";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { recordUsage } from "./ai-usage";
import { companyKey, personKey } from "../shared/fields";

export const MINUTES_MODEL = "claude-sonnet-5-5";

const NodeType = z.enum(["person", "company", "deal"]);

export const ExtractionSchema = z.object({
  meeting: z.object({
    title: z.string().describe("会議名"),
    date: z.string().describe("会議の日付 YYYY-MM-DD。不明なら空文字"),
    summary: z.string().describe("この部分の要約（3文以内）"),
  }),
  people: z.array(
    z.object({
      name: z.string(),
      kana: z.string(),
      company: z.string(),
      department: z.string(),
      title: z.string(),
      email: z.string(),
      phone: z.string(),
      internal: z.boolean().describe("社内メンバーなら true"),
      role: z.string().describe("この会議での立場・発言の要点"),
      confidence: z.number().describe("名前と会社の読み取りの確信度 0〜1"),
      evidence: z.string().describe("根拠となる発言の短い引用"),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string(),
      from_type: NodeType,
      to: z.string(),
      to_type: NodeType,
      kind: z.string().describe("関係の種類（所属 / 先方担当 / 紹介 / 上司 / 取引 / 競合 / その他）"),
      confidence: z.number(),
      evidence: z.string(),
    }),
  ),
  decisions: z.array(z.object({ text: z.string(), company: z.string(), confidence: z.number() })),
  tasks: z.array(
    z.object({
      title: z.string().describe("やること（動詞で終える）"),
      assignee: z.string().describe("担当者名。不明なら空文字"),
      due_on: z.string().describe("期限 YYYY-MM-DD。相対表現は会議日から計算。不明なら空文字"),
      related_person: z.string(),
      related_company: z.string(),
      confidence: z.number(),
      evidence: z.string(),
    }),
  ),
  deals: z.array(
    z.object({
      company: z.string(),
      name: z.string(),
      status: z.string().describe("提案中 / 見積中 / 受注 / 失注 / 検討中 など"),
      amount: z.string(),
      confidence: z.number(),
      evidence: z.string(),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ExtractContext {
  title: string;
  part: number;
  parts: number;
  /** 会議の日付 YYYY-MM-DD（録音の開始日。わからなければ空文字） */
  meetingDate?: string;
  employees: string[];
  knownPeople: string[];
  knownCompanies: string[];
}

// ---------- タスクだけの抜き出し（2026-10-31〜。要点・登場人物・決定事項などは抜き出さない） ----------

const TaskSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().describe("やること（動詞で終える）"),
      assignee: z.string().describe("担当者名。不明なら空文字"),
      due_on: z.string().describe("期限 YYYY-MM-DD。相対表現は会議日から計算。不明なら空文字"),
      related_company: z.string().describe("関係する会社名。なければ空文字"),
      confidence: z.number().describe("0〜1"),
      evidence: z.string().describe("根拠となる発言の短い引用"),
    }),
  ),
});

const TASK_SYSTEM = `あなたは社内の会議の文字起こしから、ネクストアクション（タスク）だけを抜き出す担当です。
ルール:
- この会議から出た「誰が・何を・いつまでに」が読み取れるやることだけを返す。要約・参加者・決定事項は返さない。
- 書かれていないことは推測しない。evidence には元の発言を短く引用する。
- 担当が社員（下の「社員」）なら社員名で書く。担当が分からなければ空文字。
- 期限の「来週金曜」などは会議の日付から計算する。会議の日付が不明なら期限は空文字。
- 入力は録音の文字起こしのことが多い。各行の先頭の [h:mm:ss] は録音の経過時間で、話者の区別はない。
- 文章が途中から始まる・途中で終わる場合（長い文字起こしの一部）も、その範囲で読み取れるものだけ返す。`;

/** 文字起こしからタスクだけを抜き出す（Claude API）。返り値は保存処理と同じ形で、タスク以外は空 */
export async function extractTasks(env: Env, text: string, ctx: ExtractContext): Promise<Extraction> {
  const empty = { meeting: { title: "", date: "", summary: "" }, people: [], relations: [], decisions: [], deals: [] };
  if (!env.ANTHROPIC_API_KEY) {
    if (env.DEV_LOGIN === "1") return { ...empty, tasks: devMockExtraction(text, ctx).tasks }; // ローカル開発で API キーが無いときだけ
    throw new Error("Claude API キーが設定されていません");
  }
  await ensureAiBudget(env);
  const client = anthropicClient(env);
  const known = `社員: ${ctx.employees.join("、") || "（なし）"}
登録済みの会社: ${ctx.knownCompanies.join("、") || "（なし）"}`;
  const res = await client.beta.messages.parse({
    model: MINUTES_MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(TaskSchema) },
    system: [
      { type: "text", text: TASK_SYSTEM },
      { type: "text", text: known, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `会議「${ctx.title}」（全${ctx.parts}分割の${ctx.part}番目）${ctx.meetingDate ? `\n会議の日付: ${ctx.meetingDate}（期限の計算に使う）` : ""}:\n\n${text}`,
      },
    ],
  });
  await recordUsage(env.DB, { purpose: "minutes", model: MINUTES_MODEL, usage: res.usage });
  if (res.stop_reason === "refusal") throw new Error("タスクの抜き出しを断られました");
  if (!res.parsed_output) throw new Error("タスクの抜き出し結果を解釈できませんでした");
  return { ...empty, tasks: res.parsed_output.tasks.map((t) => ({ ...t, related_person: "" })) };
}

/** 議事録を約1.5万文字ずつ、行の切れ目で分ける（前後500文字は重ねて文脈を保つ） */
export function splitText(text: string, size = 15000, overlap = 500): [number, number][] {
  if (text.length <= size) return [[0, text.length]];
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start + size / 2) end = nl;
    }
    ranges.push([start, end]);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return ranges;
}

/** ローカル開発用の簡易抽出（「決定:」「タスク:」で始まる行だけ拾う）。本番では使わない */
function devMockExtraction(text: string, ctx: ExtractContext): Extraction {
  const lines = text.split("\n").map((l) => l.trim());
  const pick = (prefix: string) => lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
  return {
    meeting: { title: ctx.title, date: lines.find((l) => /^\d{4}-\d{2}-\d{2}$/.test(l)) ?? "", summary: "（ローカル開発用の簡易抽出）" },
    people: pick("参加:").map((p) => {
      const [name, company = ""] = p.split("/").map((s) => s.trim());
      return { name, kana: "", company, department: "", title: "", email: "", phone: "", internal: !company, role: "", confidence: 0.9, evidence: p };
    }),
    relations: [],
    decisions: pick("決定:").map((t) => ({ text: t, company: "", confidence: 0.9 })),
    tasks: pick("タスク:").map((t) => {
      const [title, assignee = "", due = ""] = t.split("/").map((s) => s.trim());
      return { title, assignee, due_on: due, related_person: "", related_company: "", confidence: 0.9, evidence: t };
    }),
    deals: [],
  };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s/g, "");

/** 分割して抽出した結果を1つにまとめる（同じ人・同じタスクは1つに） */
export function mergeExtractions(parts: Extraction[]): Extraction {
  const seen = new Set<string>();
  const uniq = <T>(items: T[], key: (t: T) => string) =>
    items.filter((t) => {
      const k = key(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const all = <K extends keyof Extraction>(k: K) => parts.flatMap((p) => p[k] as unknown[]) as Extraction[K];
  return {
    meeting: {
      title: parts[0]?.meeting.title ?? "",
      date: parts.map((p) => p.meeting.date).find(Boolean) ?? "",
      summary: parts.map((p) => p.meeting.summary).filter(Boolean).join(" "),
    },
    people: uniq(all("people"), (p) => `p:${personKey(p.name)}:${companyKey(p.company)}`),
    relations: uniq(all("relations"), (r) => `r:${norm(r.from)}:${norm(r.to)}:${r.kind}`),
    decisions: uniq(all("decisions"), (d) => `d:${norm(d.text)}`),
    tasks: uniq(all("tasks"), (t) => `t:${norm(t.title)}`),
    deals: uniq(all("deals"), (d) => `deal:${companyKey(d.company)}:${norm(d.name)}`),
  };
}
