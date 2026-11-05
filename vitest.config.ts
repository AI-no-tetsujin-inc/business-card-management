import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 画面・サーバーの「純粋な」ロジックのテスト（D1 などを使う部分は scripts/mcp-smoke.mjs で確認）
// "cloudflare:workers" は Node で読めないので、テスト用の差し替えを使う
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)) } },
});
