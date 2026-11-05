// 画面とサーバーで共通の名刺項目・チェックルール

export const CARD_FIELDS = [
  { key: "company_name", label: "会社名" },
  { key: "department", label: "部署" },
  { key: "title", label: "役職" },
  { key: "person_name", label: "氏名" },
  { key: "person_name_kana", label: "ふりがな" },
  { key: "person_name_en", label: "氏名（英字）" },
  { key: "email", label: "メール" },
  { key: "phone", label: "電話" },
  { key: "mobile", label: "携帯" },
  { key: "fax", label: "FAX" },
  { key: "postal_code", label: "郵便番号" },
  { key: "address", label: "住所" },
  { key: "url", label: "URL" },
  { key: "other", label: "その他" },
] as const;

export type FieldKey = (typeof CARD_FIELDS)[number]["key"];
export type CardFields = Record<FieldKey, string>;
/** 項目ごとの「要確認」理由 */
export type FieldFlags = Partial<Record<FieldKey, string>>;

export const FIELD_KEYS: FieldKey[] = CARD_FIELDS.map((f) => f.key);
export const FIELD_LABEL: Record<FieldKey, string> = Object.fromEntries(
  CARD_FIELDS.map((f) => [f.key, f.label]),
) as Record<FieldKey, string>;

export function emptyFields(): CardFields {
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, ""])) as CardFields;
}

export function pickFields(src: object): CardFields {
  const out = emptyFields();
  for (const k of FIELD_KEYS) {
    const v = (src as Record<string, unknown>)[k];
    out[k] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}

export interface OcrResult {
  fields: CardFields;
  review: FieldFlags;
  comment: string;
  is_business_card: boolean;
}

const digits = (s: string) => s.normalize("NFKC").replace(/\D/g, "");

/** OCR とは別に機械的に確認する項目（形式・桁数など） */
export function ruleWarnings(f: CardFields): FieldFlags {
  const w: FieldFlags = {};
  if (!f.company_name.trim()) w.company_name = "会社名が空です";
  if (!f.person_name.trim()) w.person_name = "氏名が空です";

  const email = f.email.normalize("NFKC").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    w.email = "メールアドレスの形式を確認してください";
  }

  for (const key of ["phone", "mobile", "fax"] as const) {
    const raw = f[key].normalize("NFKC").trim();
    if (!raw) continue;
    const d = digits(raw);
    const intl = raw.startsWith("+");
    if (intl ? d.length < 8 || d.length > 15 : d.length < 10 || d.length > 11) {
      // 内線などが付いている場合も考えて、明らかに桁数がおかしい時だけ警告
      if (!/内線|ext/i.test(raw)) w[key] = "桁数を確認してください（市外局番から10〜11桁）";
    }
  }
  const mobile = digits(f.mobile);
  if (mobile && !f.mobile.trim().startsWith("+") && !w.mobile && !/^0[789]0/.test(mobile)) {
    w.mobile = "携帯番号（070/080/090）ではないようです";
  }

  const postal = f.postal_code.normalize("NFKC").replace(/^〒\s*/, "").trim();
  if (postal && !/^\d{3}-?\d{4}$/.test(postal)) w.postal_code = "郵便番号の形式（123-4567）を確認してください";

  const url = f.url.normalize("NFKC").trim();
  if (url && !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) w.url = "URL の形式を確認してください";

  return w;
}

const COMPANY_AFFIXES = [
  "株式会社", "有限会社", "合同会社", "合資会社", "合名会社",
  "一般社団法人", "一般財団法人", "公益社団法人", "公益財団法人", "特定非営利活動法人",
  "(株)", "(有)", "(同)", "(社)", "(財)",
];

/** 会社名の表記ゆれ（株式会社 / ㈱ / Inc. / 全角半角 / 空白）を吸収した比較用キー */
export function companyKey(name: string): string {
  let s = name.normalize("NFKC").toLowerCase().trim();
  for (const a of COMPANY_AFFIXES) s = s.split(a).join("");
  s = s.replace(/[,.\s]+(co\.?,?\s*ltd\.?|inc\.?|corp\.?|corporation|llc|ltd\.?|k\.?k\.?|g\.?k\.?|co\.?)$/i, "");
  s = s.replace(/[\s,.・'"’\-‐－—]/g, "");
  return s || name.normalize("NFKC").toLowerCase().trim();
}

/** 氏名の比較用キー（空白・全角半角の違いを吸収） */
export function personKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s/g, "");
}

export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 統合ルール用: メールアドレスの比較キー */
export function emailKey(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/** 統合ルール用: 電話番号の比較キー（数字のみ。+81 は 0 始まりに揃える） */
export function phoneKey(phone: string): string {
  let d = phone.normalize("NFKC").replace(/(内線|ext\.?).*$/i, "").replace(/\D/g, "");
  if (d.startsWith("81") && (d.length === 11 || d.length === 12)) d = "0" + d.slice(2);
  return d.length >= 9 ? d : "";
}

/** 重複候補にした理由（画面・AI で共通） */
export const MATCH_LABEL: Record<string, string> = {
  email: "メールアドレスが一致",
  mobile: "携帯番号が一致",
  phone_name: "電話番号と氏名が一致",
  name_company: "氏名と会社名が一致",
  phone: "電話番号だけが一致（会社の代表番号の可能性があります）",
  name: "氏名が一致（会社が違う。同姓同名の別人、または転職・兼務の可能性）",
  kana: "ふりがなが一致",
};
