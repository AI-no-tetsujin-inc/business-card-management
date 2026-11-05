// Claude API のクライアント。組織全体用のキー（ワークスペース未指定）のときは
// ANTHROPIC_WORKSPACE_ID（wrkspc_…）を毎回ヘッダーで送る必要がある
import Anthropic from "@anthropic-ai/sdk";

export function anthropicClient(env: Env) {
  const workspaceId = (env as Env & { ANTHROPIC_WORKSPACE_ID?: string }).ANTHROPIC_WORKSPACE_ID?.trim();
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
  });
}
