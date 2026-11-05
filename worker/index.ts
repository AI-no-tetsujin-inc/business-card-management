import { Hono } from "hono";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { api } from "./api";
import { auth } from "./auth";
import { oauth } from "./oauth";
import { mcpApiHandler } from "./mcp";
import { uploadApi } from "./upload-link";
import { minutesUpload } from "./minutes-upload";
import type { AppEnv } from "./session";
import { scheduled } from "./cron";

export { MinutesWorkflow } from "./minutes";

const app = new Hono<AppEnv>();

// 他サイトからの書き込みリクエストを拒否する（Cookie は SameSite=Lax だが念のため）
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  await next();
});

app.route("/auth", auth);
app.route("/api", api);
// Voiss からの文字起こし・音声（/upload-api/:token より先に登録する）
app.route("/upload-api/minutes", minutesUpload);
app.route("/upload-api", uploadApi);
app.route("/", oauth);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "サーバーでエラーが発生しました" }, 500);
});

// MCP のリソース URL は「利用者が AI アプリに入力した URL」と一致する必要があるため、
// 公開ドメイン（workers.dev / 独自ドメイン / localhost）ごとに OAuth プロバイダーを用意する
const providers = new Map<string, OAuthProvider>();
function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler,
      defaultHandler: { fetch: app.fetch } as ExportedHandler<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["meishi"],
      accessTokenTTL: 3600,
      refreshTokenTTL: 90 * 24 * 3600,
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "名刺管理" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    // 期限切れの MCP 連携情報（KV）の整理はどのプロバイダーからでもよい
    const purgeOAuth = () => providerFor("https://meishi.internal").purgeExpiredData(env);
    ctx.waitUntil(scheduled(controller, env, purgeOAuth));
  },
} satisfies ExportedHandler<Env>;
