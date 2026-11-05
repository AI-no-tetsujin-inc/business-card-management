// テスト用: Node では "cloudflare:workers" を読めないので、Workflow の土台だけ差し替える
export class WorkflowEntrypoint<E = unknown, P = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
  declare run: (event: { payload: P }, step: unknown) => Promise<unknown>;
}
