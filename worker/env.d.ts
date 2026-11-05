import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    /** workers-oauth-provider が差し込む OAuth のヘルパー */
    OAUTH_PROVIDER: OAuthHelpers;
    /** 議事録用の Google Chat スペースの Incoming Webhook（未設定なら GOOGLE_CHAT_WEBHOOK_URL に送る） */
    GOOGLE_CHAT_MINUTES_WEBHOOK_URL?: string;
  }
}
