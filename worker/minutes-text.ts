// 議事録の文面（Drive に置くテキストの冒頭・Google Chat への投稿・毎日のまとめ）。D1 や Google に触れない純粋な関数だけ置く

/** ファイル名に使えない文字を除く（documents.ts の safeName と同じ。こちらは PDF 化の依存を持ち込まないため別に置く） */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "").trim();

export interface MinutesDoc {
  id: string;
  title: string;
  source: string;
  started_at: string | null;
  duration_sec: number | null;
  meeting_date: string | null;
  created_at: string;
  summary: string;
  recorder_name?: string | null;
  model?: string | null;
}

export interface MinutesTask {
  title: string;
  assignee?: string | null; // 社員名（users.name）
  assignee_name?: string | null; // 社員に当てはまらない担当者名
  due_on: string | null;
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
/** Chat の投稿の上限（4096字）より少し手前で切る */
const CHAT_LIMIT = 3800;

/** ISO 日時 → 日本時間の日付・時刻 */
export function jst(iso: string) {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  const date = d.toISOString().slice(0, 10);
  return { date, md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, hm: d.toISOString().slice(11, 16), wd: WEEK[d.getUTCDay()] };
}

const mdOf = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const wdOf = (date: string) => WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** 会議の日付（日本時間）。録音の開始日時を優先し、AI が読み取った日付より信用する */
export function meetingDateOf(doc: Pick<MinutesDoc, "started_at" | "meeting_date" | "created_at">) {
  if (doc.started_at) return jst(doc.started_at).date;
  return doc.meeting_date || jst(doc.created_at).date;
}

export function durationLabel(sec: number) {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}秒`;
  const min = Math.round(sec / 60);
  const h = Math.floor(min / 60);
  return h ? `${h}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`;
}

/** 例: 10/22（水）14:05〜15:10（1時間5分） */
export function whenLabel(doc: Pick<MinutesDoc, "started_at" | "duration_sec" | "meeting_date" | "created_at">) {
  if (!doc.started_at) {
    const date = meetingDateOf(doc);
    return `${mdOf(date)}（${wdOf(date)}）`;
  }
  const s = jst(doc.started_at);
  if (!doc.duration_sec) return `${s.md}（${s.wd}）${s.hm}〜`;
  const e = jst(new Date(Date.parse(doc.started_at) + doc.duration_sec * 1000).toISOString());
  return `${s.md}（${s.wd}）${s.hm}〜${e.hm}（${durationLabel(doc.duration_sec)}）`;
}

/** Drive のフォルダ名・ファイル名（例: 20261022_サンプル自動車定例） */
export function minutesFileStem(doc: Pick<MinutesDoc, "title" | "started_at" | "meeting_date" | "created_at">) {
  const ymd = meetingDateOf(doc).replace(/-/g, "");
  const title = safeName(doc.title).replace(/\s+/g, "") || "議事録";
  return `${ymd}_${title}`.slice(0, 80);
}

export const monthFolderOf = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月`;

export const assigneeLabel = (t: MinutesTask) => t.assignee || t.assignee_name || "担当未定";
const dueLabel = (t: MinutesTask) => (t.due_on ? `（${mdOf(t.due_on)}まで）` : "");
const actionLine = (t: MinutesTask) => `・${assigneeLabel(t)}: ${t.title}${dueLabel(t)}`;

/** Drive に置くテキスト: 冒頭に会議の情報・ネクストアクション（以前の議事録は要点・決まったことも）、そのあとに文字起こしの全文 */
export function driveText(doc: MinutesDoc, decisions: { text: string }[], tasks: MinutesTask[], transcript: string, appUrl?: string) {
  const head = [
    `タイトル: ${doc.title}`,
    `日時: ${whenLabel(doc)}`,
    doc.recorder_name ? `録音: ${doc.recorder_name}` : "",
    doc.model ? `文字起こし: ${doc.model}` : "",
    appUrl ? `アプリ: ${appUrl}` : "",
  ].filter(Boolean);
  // 要点・決まったことは 2026-10-31 から抜き出していない（以前の議事録に残っているときだけ載せる）
  const body = [
    ...(doc.summary ? ["■ 要点", doc.summary, ""] : []),
    ...(decisions.length ? ["■ 決まったこと", ...decisions.map((d) => `・${d.text}`), ""] : []),
    "■ ネクストアクション",
    ...(tasks.length ? tasks.map(actionLine) : ["（なし）"]),
  ];
  return `${head.join("\n")}\n\n${body.join("\n")}\n\n${"-".repeat(40)}\n${transcript.trim()}\n`;
}

/** 議事録スペースへの1件ごとの投稿 */
export function minutesChatText(
  doc: MinutesDoc,
  decisions: { text: string }[],
  tasks: MinutesTask[],
  links: { drive?: string | null; app?: string | null },
  note?: string,
) {
  const lines = [
    `*議事録: ${doc.title}*`,
    [whenLabel(doc), doc.recorder_name ? `録音 ${doc.recorder_name}` : ""].filter(Boolean).join(" ・ "),
  ];
  if (note) lines.push(note);
  if (doc.summary) lines.push("", doc.summary);
  if (decisions.length) lines.push("", "*決まったこと*", ...decisions.map((d) => `・${d.text}`));
  if (tasks.length) lines.push("", "*ネクストアクション*", ...tasks.map(actionLine));
  const tail = [links.drive ? `全文（Drive）: ${links.drive}` : "", links.app ? `アプリ: ${links.app}` : ""].filter(Boolean);
  return clip(lines.join("\n"), tail);
}

export interface DigestInput {
  date: string; // YYYY-MM-DD（日本時間）
  meetings: { title: string; when: string; recorder: string | null; summary: string }[];
  /** 今日の会議から出たネクストアクション */
  actions: MinutesTask[];
  /** 期限が今日〜2日後、または過ぎている未完了のタスク（今日の会議の分は除く） */
  dueSoon: MinutesTask[];
  overview?: string;
  appUrl?: string;
}

/** 毎日のまとめ（「今日の AIの鉄人」）。会議がない日は null（送らない） */
export function digestText(input: DigestInput): string | null {
  if (!input.meetings.length) return null;
  const lines = [`*今日の AIの鉄人（${mdOf(input.date)}・${wdOf(input.date)}）* 会議 ${input.meetings.length}件`];
  if (input.overview) lines.push("", input.overview.trim());
  lines.push("", "*会議*");
  for (const m of input.meetings) {
    const first = m.summary.split(/(?<=。)/)[0]?.trim() ?? "";
    lines.push(`・${m.title}（${[m.when, m.recorder].filter(Boolean).join(" ・ ")}）${first ? `\n  ${first}` : ""}`);
  }
  if (input.actions.length) {
    lines.push("", "*ネクストアクション*");
    const byPerson = new Map<string, MinutesTask[]>();
    for (const t of input.actions) byPerson.set(assigneeLabel(t), [...(byPerson.get(assigneeLabel(t)) ?? []), t]);
    for (const [person, list] of byPerson) lines.push(`${person}`, ...list.map((t) => `・${t.title}${dueLabel(t)}`));
  }
  if (input.dueSoon.length) lines.push("", "*期限が近いタスク*", ...input.dueSoon.map(actionLine));
  return clip(lines.join("\n"), input.appUrl ? [`一覧: ${input.appUrl}`] : []);
}

function clip(body: string, tail: string[]) {
  const end = tail.length ? `\n\n${tail.join("\n")}` : "";
  if (body.length + end.length <= CHAT_LIMIT) return body + end;
  return `${body.slice(0, CHAT_LIMIT - end.length - 20).trimEnd()}\n…（続きはアプリで）${end}`;
}
