const TZ = "Asia/Tokyo";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.replace(/-/g, "/");
  return new Date(iso).toLocaleDateString("ja-JP", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
}

export const parseTags = (json: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
