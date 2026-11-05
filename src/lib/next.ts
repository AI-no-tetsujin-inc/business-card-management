/** ログイン後に戻る先（?next=）。同じサイト内の相対パスだけ許可する */
export function getNext(): string {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** 経路の表示名（web / ai:Claude / cron） */
export function viaLabel(via: string | null | undefined): string {
  if (!via || via === "web") return "";
  if (via.startsWith("ai:")) return `${via.slice(3)} 経由`;
  if (via === "cron") return "自動処理";
  if (via === "minutes") return "議事録から";
  return via;
}
