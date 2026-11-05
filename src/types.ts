import type { CardFields, OcrResult } from "../shared/fields";

export interface User {
  id: string;
  email: string;
  name: string;
  registered: number;
  role: "admin" | "member" | "viewer";
}

/** 設定で出し入れする機能: minutes = 議事録・タスク、graph = つながり・確認依頼（スコープ外） */
export interface Features {
  minutes: boolean;
  graph: boolean;
}

export interface CardRow extends CardFields {
  id: string;
  company_key: string;
  exchange_place: string;
  exchanged_on: string;
  tags: string; // JSON 配列
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
  front_display_key: string | null;
  exchange_count: number;
  latest_note: string | null;
  other_affiliations?: number;
}

export interface CardImage {
  id: string;
  side: "front" | "back";
  full_key: string;
  display_key: string;
  uploaded_by_name: string;
  uploaded_at: string;
}

export interface CardEvent {
  id: string;
  type: "created" | "exchanged" | "updated" | "deleted" | "restored";
  user_name: string;
  created_at: string;
  detail: string; // JSON
}

export interface CardNote {
  id: string;
  body: string;
  source: string;
  created_by_name: string;
  created_at: string;
}

export interface CardDetail {
  card: CardRow;
  images: CardImage[];
  events: CardEvent[];
  notes: CardNote[];
  interactions: { id: string; happened_on: string | null; created_at: string; summary: string; document_id: string | null; document_title: string | null }[];
  tasks: { id: string; title: string; due_on: string | null; status: string; assignee: string | null; assignee_name: string }[];
  /** 同じ人の別の所属（会社ごとに分かれた名刺） */
  affiliations: { id: string; company_name: string; company_key: string; department: string; title: string; person_name: string; email: string; exchanged_on: string }[];
}

export interface DraftSummary {
  id: string;
  front_display_key: string;
  has_back: boolean;
  created_by_name: string;
  created_at: string;
  error: string | null;
  processed: boolean;
  person_name: string;
  company_name: string;
  flag_count: number | null;
  duplicate_count: number;
  state: "reading" | "ready" | "flagged" | "duplicate" | "failed";
  flags: { field: string; label: string; reason: string }[];
  duplicates: { id: string; person_name: string; company_name: string; match: string }[];
  deferred: boolean;
  has_edits: boolean;
}

export interface DraftDetail {
  id: string;
  status: "pending" | "done" | "discarded";
  front_display_key: string;
  front_full_key: string;
  back_display_key: string | null;
  back_full_key: string | null;
  exchanged_on: string;
  error: string | null;
  created_by_name: string;
  created_at: string;
  ocr: OcrResult | null;
  card_id?: string | null;
  edited: DraftEdits | null;
  edited_at: string | null;
  deferred: boolean;
}

/** 確認画面で直している途中の内容（サーバーに下書きとして保存する） */
export interface DraftEdits {
  fields: CardFields;
  confirmed: string[];
  exchangedOn: string;
  place: string;
  tags: string[];
  note: string;
}

export interface DuplicateCandidate {
  id: string;
  company_name: string;
  department: string;
  title: string;
  person_name: string;
  email: string;
  created_by_name: string;
  created_at: string;
  match: string;
  phone?: string;
  mobile?: string;
}

export interface Company {
  company_key: string;
  company_name: string;
  count: number;
  last_created_at: string;
}
