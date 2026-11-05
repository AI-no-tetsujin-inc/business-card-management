// スマホでは表を1行ずつのカードにする。各セルに見出し（data-label）がないと何の値か分からないので、
// thead の見出しから自動で付ける（画面ごとに data-label を書かなくても済むように）
function label(table: HTMLTableElement) {
  const heads = [...table.querySelectorAll<HTMLTableCellElement>("thead th")].map((th) => th.textContent?.trim() ?? "");
  if (!heads.length) return;
  for (const tr of table.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    [...tr.cells].forEach((td, i) => {
      if (!td.hasAttribute("data-label") && heads[i] !== undefined) td.setAttribute("data-label", heads[i]);
    });
  }
}

export function installTableLabels() {
  let queued = false;
  const run = () => {
    queued = false;
    document.querySelectorAll<HTMLTableElement>("table.simple-table").forEach(label);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
}
