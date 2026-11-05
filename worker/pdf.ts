// HTML → PDF（Cloudflare Browser Run）。無料枠は1日10分なので、PDF 1枚あたり数秒で十分収まる
import puppeteer from "@cloudflare/puppeteer";

/** 1回目が失敗したら（ブラウザの起動の失敗・読み込みの詰まりなど）、もう1回だけ作り直す */
export async function htmlToPdf(env: Env, html: string): Promise<Uint8Array> {
  try {
    return await withTimeout(render(env, html), 45_000);
  } catch (e) {
    console.warn("PDF の作成に失敗したのでやり直します", e);
    return withTimeout(render(env, html), 45_000);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PDF の作成がタイムアウトしました")), ms))]);
}

async function render(env: Env, html: string): Promise<Uint8Array> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    // 通信が全部止まるまで（networkidle0）は待たない。Google Fonts の応答が遅いと 30 秒で失敗するため。
    // ページの読み込みが終わったら、日本語フォント（Noto Sans JP）は最大 8 秒だけ待ち、間に合わなければ端末のフォントで作る
    // フォントの CSS の取得が詰まって load まで届かなくても、本文は入っているのでそのまま PDF にする
    await page.setContent(html, { waitUntil: "load", timeout: 15_000 }).catch((e) => console.warn("ページの読み込み待ちを打ち切りました", e));
    await page.evaluate("Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))])");
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, timeout: 20_000 });
    return new Uint8Array(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
